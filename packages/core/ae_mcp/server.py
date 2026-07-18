"""MCP server entry (stdio transport).

Uses the low-level mcp.server.Server API so we can:
  - expose each verb's pydantic JSON schema as the tool's inputSchema,
  - fan-out to the HANDLERS registry by name,
  - surface structured {ok, error, ...} payloads uniformly.

Handlers receive (validated_model, ctx). `ctx` is the mcp.server.Context
object surfaced via the request_context; it owns report_progress.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import time
from typing import Any, List

from jsonschema import ValidationError as JsonSchemaValidationError
from jsonschema import validate as validate_json_schema
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool
from pydantic import ValidationError as PydanticValidationError

from ae_mcp import approval_gate, client_identity, schemas
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.backends.native import NativeBackendError, NativeInvokeBackend
from ae_mcp.error_hints import append_hint
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.instructions import SERVER_INSTRUCTIONS, build_server_instructions
from ae_mcp.tool_history import (
    HistoryContext,
    capture_history_candidate,
    extract_history_draft,
)
from ae_mcp.tool_secrets import RegexSecretScanner, SecretScanError
from ae_mcp.tool_store import ToolStoreError

log = logging.getLogger("ae_mcp.server")
_history_scanner = RegexSecretScanner()
_PANEL_CAPABILITY_ARGUMENT = "_ae_panel_capability"
_PANEL_DEVELOPER_TOOLS = frozenset(
    {"ae.toolIndex", "ae.toolSearch", "ae.toolInspect"}
)
_PANEL_DEVELOPER_SCHEMAS = {
    "ae.toolIndex": schemas.AePanelToolIndexArgs,
    "ae.toolSearch": schemas.AePanelToolSearchArgs,
    "ae.toolInspect": schemas.AeToolInspectArgs,
}

# Matches a leading dotted verb token at the very start of a docstring, e.g.
# "ae.init — bootstrap …". Only the leading token is rewritten so the rest of
# the description (which may legitimately mention dotted names) is untouched.
_LEADING_VERB = re.compile(r"^(ae\.[A-Za-z][A-Za-z0-9]*)")


def default_tool_service():
    from ae_mcp.tool_service import default_tool_service as resolve

    return resolve()


def _panel_request(
    canonical: str,
    arguments: dict | None,
) -> tuple[dict[str, Any], bool]:
    """Consume the per-process panel capability without advertising it to models."""

    values = dict(arguments or {})
    supplied = values.pop(_PANEL_CAPABILITY_ARGUMENT, None)
    expected = os.environ.get("AE_MCP_PANEL_CAPABILITY", "")
    trusted = (
        canonical in _PANEL_DEVELOPER_TOOLS
        and isinstance(supplied, str)
        and len(expected) >= 64
        and hmac.compare_digest(supplied, expected)
    )
    return values, trusted


def _filtered_tool_names() -> set:
    """Return verb names this server should expose.

    Always includes ae.status (install diagnostics) and ae.diagnose (live
    connection self-check) so clients have diagnostic entry points even when
    backend selection fails. Other verbs depend on backend capabilities and
    whether a snapshotter is available.
    """
    from ae_mcp.backends import discovery as _discovery
    from ae_mcp.snapshot import discovery as _snap_discovery
    try:
        backend = _discovery.select_backend()
        supported = backend.supported_verbs()
    except Exception as e:  # noqa: BLE001
        log.warning(
            "backend selection failed; exposing only ae.status + ae.diagnose "
            "(ae_status, ae_diagnose) for diagnostics: %s",
            e,
        )
        return {"ae.status", "ae.diagnose"}
    try:
        snapshotter = _snap_discovery.select_snapshotter()
    except Exception as e:  # noqa: BLE001
        log.warning("snapshotter selection failed; hiding ae.snapshot: %s", e)
        snapshotter = None
    if snapshotter is None:
        supported = supported - {"ae.snapshot"}
    if isinstance(backend, NativeInvokeBackend):
        supported = supported | {
            "ae.getProjectContext",
            "ae.getProjectItemMetadata",
            "ae.getCompositionSettings",
            "ae.setCompositionWorkArea",
            "ae.renameProjectItem",
            "ae.setProjectItemComment",
            "ae.setProjectItemLabel",
            "ae.duplicateComposition",
            "ae.projectSummary",
            "ae.getProjectBitDepth",
            "ae.setProjectBitDepth",
            "ae.listProjectItems",
            "ae.listCompositionLayers",
            "ae.listSelectedLayers",
            "ae.getLayerDetails",
            "ae.renameLayer",
            "ae.setLayerRange",
            "ae.setLayerStartTime",
            "ae.setLayerStretch",
            "ae.reorderLayer",
            "ae.setLayerParent",
            "ae.duplicateLayer",
            "ae.getCompositionTime",
            "ae.setCompositionTime",
            "ae.createComposition",
            "ae.createCompositionLayer",
            "ae.applyLayerEffect",
            "ae.listLayerProperties",
            "ae.listLayerPropertyKeyframes",
            "ae.setLayerPropertyValue",
        }
    else:
        supported = supported - {
            "ae.getProjectContext",
            "ae.getProjectItemMetadata",
            "ae.getCompositionSettings",
            "ae.setCompositionWorkArea",
            "ae.renameProjectItem",
            "ae.setProjectItemComment",
            "ae.setProjectItemLabel",
            "ae.duplicateComposition",
            "ae.projectSummary",
            "ae.getProjectBitDepth",
            "ae.setProjectBitDepth",
            "ae.listProjectItems",
            "ae.listCompositionLayers",
            "ae.listSelectedLayers",
            "ae.getLayerDetails",
            "ae.renameLayer",
            "ae.setLayerRange",
            "ae.setLayerStartTime",
            "ae.setLayerStretch",
            "ae.reorderLayer",
            "ae.setLayerParent",
            "ae.duplicateLayer",
            "ae.getCompositionTime",
            "ae.setCompositionTime",
            "ae.createComposition",
            "ae.createCompositionLayer",
            "ae.applyLayerEffect",
            "ae.listLayerProperties",
            "ae.listLayerPropertyKeyframes",
            "ae.setLayerPropertyValue",
        }
    return supported | {"ae.status", "ae.diagnose"}


def _format_result(result: Any) -> str:
    """Coerce handler return value into MCP text content.

    Handlers return either a dict/list (preferred, serialised as JSON) or a
    str. Anything else is repr()'d as a last resort.
    """
    if isinstance(result, str):
        return result
    if isinstance(result, (dict, list)):
        try:
            return json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            return repr(result)
    return repr(result)


def expose_tool_name(verb: str) -> str:
    """Map a canonical verb to its MCP-exposed tool name.

    Verbs are dotted internally ("ae.ping"), but the MCP spec requires tool
    names to match ``^[a-zA-Z0-9_-]{1,64}$``. Dots are illegal, and strict
    clients (e.g. Claude Desktop extensions) reject them at handshake time, so
    we expose dot-free names ("ae.ping" -> "ae_ping").
    """
    return verb.replace(".", "_")


def build_reverse_map(handlers) -> "dict[str, str]":
    """Build an ``exposed name -> canonical verb`` map for O(1) resolution.

    ``resolve_tool_name`` otherwise falls back to a linear scan for the common
    (underscore-name) call path. Precomputing this map once — after
    ``load_all()`` has populated HANDLERS — keeps the hot path O(1) while
    preserving identical fallback semantics.
    """
    return {expose_tool_name(verb): verb for verb in handlers}


def tool_description(schema_cls, verb: str) -> str:
    """Build a Tool description that LEADS with the exposed underscore name.

    The description is sourced from the pydantic schema docstring, which opens
    with the dotted verb ("ae.init — …"). Strict clients can only call the
    advertised (underscore) name, so we rewrite *only* the leading dotted-verb
    token to its exposed form; the remainder of the docstring is untouched.
    """
    doc = (schema_cls.__doc__ or "").strip()
    exposed = expose_tool_name(verb)
    if not doc:
        return f"ae-mcp verb {exposed}"
    m = _LEADING_VERB.match(doc)
    if m and m.group(1) == verb:
        return exposed + doc[m.end():]
    # Docstring doesn't open with this verb token (defensive): prepend the
    # exposed name so the description still leads with the callable name.
    return f"{exposed} — {doc}"


def resolve_tool_name(name: str, handlers, reverse_map=None) -> "str | None":
    """Map an exposed tool name back to its canonical verb.

    Accepts both the exposed dot-free name ("ae_ping") and, for backward
    compatibility, the original dotted verb ("ae.ping"). Returns ``None`` if
    the name matches no registered verb.

    ``reverse_map`` (from :func:`build_reverse_map`) makes the underscore-name
    path O(1); when omitted, a linear scan is used so direct/programmatic
    callers still resolve correctly.
    """
    # Dotted-name fast path (back-compat for direct callers).
    if name in handlers:
        return name
    if reverse_map is not None:
        return reverse_map.get(name)
    for verb in handlers:
        if expose_tool_name(verb) == name:
            return verb
    return None


def _layer_properties_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Map either validation layer to the public native error contract."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value
                if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.listLayerProperties arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Use a layer locator from ae_listCompositionLayers, an optional "
                "property locator from this tool, offset >= 0, and limit 1..25."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.layer.properties.list",
        },
    )
    return structured.public_dict()


def _layer_property_keyframes_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native keyframe read."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        (
            "ae.listLayerPropertyKeyframes arguments did not match the "
            "published schema."
        ),
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Use a leaf property locator from ae_listLayerProperties, "
                "offset >= 0, and limit 1..25."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.layer.property.keyframes.list",
        },
    )
    return structured.public_dict()


def _layer_property_set_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native layer-property write."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])
        elif (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
        ):
            properties = error.schema.get("properties")
            if isinstance(properties, dict):
                unexpected = sorted(set(error.instance) - set(properties))
                if len(unexpected) == 1:
                    path.append(unexpected[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.setLayerPropertyValue arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Copy both locators from ae_listLayerProperties, match the typed "
                "property value shape, and use a 16 to 64 character idempotency key."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.layer.property.set",
        },
    )
    return structured.public_dict()


def _composition_time_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native composition-time surface."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value
                if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])
        elif (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
        ):
            properties = error.schema.get("properties")
            if isinstance(properties, dict):
                unexpected = sorted(set(error.instance) - set(properties))
                if len(unexpected) == 1:
                    path.append(unexpected[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.getCompositionTime arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Copy an unmodified composition_locator from "
                "ae_listProjectItems and retry."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.composition.time.read",
        },
    )
    return structured.public_dict()


def _composition_time_set_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native composition-time write."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])
        elif (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
        ):
            properties = error.schema.get("properties")
            if isinstance(properties, dict):
                unexpected = sorted(set(error.instance) - set(properties))
                if len(unexpected) == 1:
                    path.append(unexpected[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.setCompositionTime arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Copy an unmodified composition_locator from ae_listProjectItems, "
                "provide int32 value and positive uint32 scale, and use a stable "
                "16 to 64 character idempotency key."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.composition.time.set",
        },
    )
    return structured.public_dict()


def _composition_create_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native composition-create surface."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if error.validator == "required" and isinstance(error.instance, dict):
            missing = [key for key in error.validator_value if key not in error.instance]
            if len(missing) == 1:
                path.append(missing[0])
        elif error.validator == "additionalProperties" and isinstance(error.instance, dict):
            properties = error.schema.get("properties", {}) if isinstance(error.schema, dict) else {}
            unexpected = sorted(set(error.instance) - set(properties))
            if len(unexpected) == 1:
                path.append(unexpected[0])
    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    return NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.createComposition arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Provide a name, positive exact duration and ratios, bounded "
                "dimensions, and a stable 16 to 64 character idempotency key."
            ),
        },
        details={"field": field[:128], "capabilityId": "ae.composition.create"},
    ).public_dict()


def _composition_layer_create_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native layer-create surface."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])
        elif (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
        ):
            properties = error.schema.get("properties")
            if isinstance(properties, dict):
                unexpected = sorted(set(error.instance) - set(properties))
                if len(unexpected) == 1:
                    path.append(unexpected[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.createCompositionLayer arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Copy a fresh composition locator from ae_listProjectItems, "
                "choose kind null or solid, provide a bounded name, use solid-only "
                "options only for solid, and supply a stable 16 to 64 character "
                "idempotency key."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.composition.layer.create",
        },
    )
    return structured.public_dict()


def _layer_effect_apply_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for the native effect-apply surface."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if error.validator == "required" and isinstance(error.instance, dict):
            missing = [
                key for key in error.validator_value if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])
        elif error.validator == "additionalProperties" and isinstance(
            error.instance, dict
        ):
            properties = (
                error.schema.get("properties", {})
                if isinstance(error.schema, dict)
                else {}
            )
            unexpected = sorted(set(error.instance) - set(properties))
            if len(unexpected) == 1:
                path.append(unexpected[0])
    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    return NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.applyLayerEffect arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Copy a fresh layer locator from ae_listCompositionLayers, "
                "provide an exact installed effect match name of at most 47 "
                "characters, and supply a stable 16 to 64 character "
                "idempotency key."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.layer.effect.apply",
        },
    ).public_dict()


def _selected_layers_validation_error(
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Preserve structured recovery for selected native layer reads."""
    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [
                key for key in error.validator_value
                if key not in error.instance
            ]
            if len(missing) == 1:
                path.append(missing[0])
        elif (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
        ):
            properties = error.schema.get("properties")
            if isinstance(properties, dict):
                unexpected = sorted(set(error.instance) - set(properties))
                if len(unexpected) == 1:
                    path.append(unexpected[0])

    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    structured = NativeBackendError(
        "INVALID_ARGUMENT",
        "ae.listSelectedLayers arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={
            "action": "change-arguments",
            "hint": (
                "Copy an unmodified composition_locator from "
                "ae_listProjectItems, use offset >= 0 and limit 1..50, then retry."
            ),
        },
        details={
            "field": field[:128],
            "capabilityId": "ae.composition.selected-layers.list",
        },
    )
    return structured.public_dict()


_PROJECT_COMPOSITION_VALIDATION = {
    "ae.getProjectContext": (
        "ae.project.context.read",
        "Use selection_offset >= 0 and selection_limit from 1 to 50.",
    ),
    "ae.getProjectItemMetadata": (
        "ae.project.item.metadata.read",
        "Copy item_locator unchanged from ae_getProjectContext or ae_listProjectItems.",
    ),
    "ae.getCompositionSettings": (
        "ae.composition.settings.read",
        "Copy composition_locator unchanged from a native project read.",
    ),
    "ae.setCompositionWorkArea": (
        "ae.composition.work-area.set",
        "Use a fresh composition_locator, non-negative start, positive duration, and a stable idempotency_key.",
    ),
    "ae.renameProjectItem": (
        "ae.project.item.name.set",
        "Use a fresh item_locator, a 1 to 255 scalar name, and a stable idempotency_key.",
    ),
    "ae.setProjectItemComment": (
        "ae.project.item.comment.set",
        "Use a fresh item_locator, a comment of at most 1024 scalars, and a stable idempotency_key.",
    ),
    "ae.setProjectItemLabel": (
        "ae.project.item.label.set",
        "Use a fresh item_locator, label_id from 0 to 16, and a stable idempotency_key.",
    ),
    "ae.duplicateComposition": (
        "ae.composition.duplicate",
        "Use a fresh composition_locator, a 1 to 255 scalar new_name, and a stable idempotency_key.",
    ),
    "ae.getLayerDetails": (
        "ae.layer.details.read",
        "Copy layer_locator unchanged from ae_listCompositionLayers.",
    ),
    "ae.renameLayer": (
        "ae.layer.name.set",
        "Use a fresh layer_locator, a 1 to 255 scalar name, and a stable idempotency_key.",
    ),
    "ae.setLayerRange": (
        "ae.layer.range.set",
        "Use a fresh layer_locator, exact in_point, positive duration, and a stable idempotency_key.",
    ),
    "ae.setLayerStartTime": (
        "ae.layer.start-time.set",
        "Use a fresh layer_locator, exact start_time, and a stable idempotency_key.",
    ),
    "ae.setLayerStretch": (
        "ae.layer.stretch.set",
        "Use a fresh layer_locator, a non-zero stretch_percent within [-9900, 9900], and a stable idempotency_key.",
    ),
    "ae.reorderLayer": (
        "ae.layer.order.set",
        "Use a fresh layer_locator, a valid one-based target_stack_index, and a stable idempotency_key.",
    ),
    "ae.setLayerParent": (
        "ae.layer.parent.set",
        "Use a fresh layer_locator and a fresh same-composition parent_layer_locator or null.",
    ),
    "ae.duplicateLayer": (
        "ae.layer.duplicate",
        "Use a fresh layer_locator, a required 1 to 255 scalar new_name, and a stable idempotency_key.",
    ),
}


def _project_composition_validation_error(
    name: str,
    error: JsonSchemaValidationError | PydanticValidationError,
) -> dict[str, Any]:
    """Structured argument recovery for the frozen #150 public surface."""

    path: list[Any] = []
    if isinstance(error, PydanticValidationError):
        errors = error.errors(include_url=False, include_input=False)
        if errors:
            path = list(errors[0].get("loc") or ())
    else:
        path = list(error.absolute_path)
        if (
            error.validator == "required"
            and isinstance(error.instance, dict)
            and isinstance(error.validator_value, list)
        ):
            missing = [key for key in error.validator_value if key not in error.instance]
            if len(missing) == 1:
                path.append(missing[0])
        elif (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
        ):
            properties = error.schema.get("properties")
            if isinstance(properties, dict):
                unexpected = sorted(set(error.instance) - set(properties))
                if len(unexpected) == 1:
                    path.append(unexpected[0])
    field = "arguments"
    if path:
        field += "." + ".".join(str(part) for part in path)
    capability_id, hint = _PROJECT_COMPOSITION_VALIDATION[name]
    return NativeBackendError(
        "INVALID_ARGUMENT",
        f"{name} arguments did not match the published schema.",
        retryable=False,
        side_effect="not-started",
        recovery={"action": "change-arguments", "hint": hint},
        details={"field": field[:128], "capabilityId": capability_id},
    ).public_dict()


def build_server() -> Server:
    """Construct the low-level MCP Server with all registered verbs."""
    load_all()

    # Reverse map (exposed name -> canonical verb) for O(1) resolution on the
    # common underscore-name call path. Built once, after load_all() has
    # populated HANDLERS.
    reverse_map = build_reverse_map(HANDLERS)

    # Collision guard: expose_tool_name() is lossy (dots -> underscores), so a
    # future verb could collapse onto another's exposed name and make
    # _list_tools emit duplicate Tool names. Fail loudly if that ever happens.
    if len(reverse_map) != len(HANDLERS):
        seen: dict[str, str] = {}
        collisions: list[str] = []
        for verb in HANDLERS:
            exposed = expose_tool_name(verb)
            if exposed in seen:
                collisions.append(f"{seen[exposed]!r} and {verb!r} -> {exposed!r}")
            else:
                seen[exposed] = verb
        raise RuntimeError(
            "exposed tool-name collision(s): " + "; ".join(collisions)
        )

    server: Server = Server("ae", instructions=build_server_instructions())

    # Runtime JSON Schema validation must use the exact schema advertised by
    # tools/list. The MCP SDK still populates its tool cache before invoking
    # our call handler even when its own pre-validation is disabled; this map
    # lets the handler apply the same schema without reaching into SDK internals.
    advertised_input_schemas: dict[str, dict[str, Any]] = {}

    @server.list_tools()
    async def _list_tools() -> List[Tool]:
        nonlocal advertised_input_schemas
        allowed = _filtered_tool_names()
        tools: List[Tool] = []
        next_input_schemas: dict[str, dict[str, Any]] = {}
        for verb_name, (schema_cls, _run_fn) in HANDLERS.items():
            if verb_name not in allowed:
                continue
            # pydantic v2: .model_json_schema() returns the full JSON schema.
            try:
                input_schema = schema_cls.model_json_schema()
            except Exception as e:  # noqa: BLE001
                log.warning("schema for %s failed: %s", verb_name, e)
                input_schema = {"type": "object", "properties": {}}
            # Description leads with the EXPOSED (underscore) name so strict
            # clients see the name they can actually call.
            tools.append(
                Tool(
                    name=expose_tool_name(verb_name),
                    description=tool_description(schema_cls, verb_name),
                    inputSchema=input_schema,
                    annotations=VERB_ANNOTATIONS.get(verb_name),
                )
            )
            next_input_schemas[expose_tool_name(verb_name)] = input_schema
        advertised_input_schemas = next_input_schemas
        return tools

    # Keep JSON Schema on the advertised Tool definition and enforce that same
    # schema locally before Pydantic model validation. The SDK's default
    # pre-validation returns before this handler, which prevents native tools
    # from preserving ae-mcp's structured error and recovery contract.
    @server.call_tool(validate_input=False)
    async def _call_tool(name: str, arguments: dict | None) -> CallToolResult:
        try:
            params = server.request_context.session.client_params  # type: ignore[union-attr]
            ci = getattr(params, "clientInfo", None) or getattr(params, "client_info", None)
            client_identity.set_client(ci.name, ci.version)
        except Exception:  # noqa: BLE001
            client_identity.set_client(None, None)

        # Return CallToolResult explicitly so MCP clients can branch on the
        # protocol-level isError flag. The JSON payload still carries ok:false
        # for human/model-readable details and remains byte-for-byte stable.
        # Tools are exposed with dots replaced by underscores; map the exposed
        # name back to the canonical verb (the dotted name is accepted too).
        canonical = resolve_tool_name(name, HANDLERS, reverse_map)
        if canonical is None:
            payload = _format_result({"ok": False, "error": f"unknown tool: {name}"})
            return CallToolResult(
                content=[TextContent(type="text", text=payload)],
                isError=True,
            )
        name = canonical

        arguments, panel_developer = _panel_request(canonical, arguments)
        public_schema_cls, run_fn = HANDLERS[name]
        schema_cls = (
            _PANEL_DEVELOPER_SCHEMAS[canonical]
            if panel_developer
            else public_schema_cls
        )

        # The SDK's default validation happens before this handler and reduces
        # every schema failure to unstructured text. Reapply the same
        # jsonschema validation here using the exact tools/list schema: the
        # native layer-property tool can then expose its structured recovery
        # contract, while established tools keep the SDK's original text error.
        input_schema = (
            schema_cls.model_json_schema()
            if panel_developer
            else advertised_input_schemas.get(expose_tool_name(name))
        )
        if input_schema is not None:
            try:
                validate_json_schema(
                    instance=arguments or {},
                    schema=input_schema,
                )
            except JsonSchemaValidationError as error:
                if name in _PROJECT_COMPOSITION_VALIDATION:
                    public_error: Any = _project_composition_validation_error(
                        name, error
                    )
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.listLayerProperties":
                    public_error = _layer_properties_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.listLayerPropertyKeyframes":
                    public_error = _layer_property_keyframes_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.setLayerPropertyValue":
                    public_error = _layer_property_set_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.getCompositionTime":
                    public_error = _composition_time_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.setCompositionTime":
                    public_error = _composition_time_set_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.createComposition":
                    public_error = _composition_create_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.createCompositionLayer":
                    public_error = _composition_layer_create_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.applyLayerEffect":
                    public_error = _layer_effect_apply_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                elif name == "ae.listSelectedLayers":
                    public_error = _selected_layers_validation_error(error)
                    payload = _format_result({"ok": False, "error": public_error})
                else:
                    payload = f"Input validation error: {error.message}"
                return CallToolResult(
                    content=[TextContent(type="text", text=payload)],
                    isError=True,
                )

        try:
            validated = schema_cls(**(arguments or {}))
        except Exception as e:  # noqa: BLE001
            if name in _PROJECT_COMPOSITION_VALIDATION and isinstance(
                e, PydanticValidationError
            ):
                error: Any = _project_composition_validation_error(name, e)
            elif name == "ae.listLayerProperties" and isinstance(
                e, PydanticValidationError
            ):
                error = _layer_properties_validation_error(e)
            elif name == "ae.listLayerPropertyKeyframes" and isinstance(
                e, PydanticValidationError
            ):
                error = _layer_property_keyframes_validation_error(e)
            elif name == "ae.setLayerPropertyValue" and isinstance(
                e, PydanticValidationError
            ):
                error = _layer_property_set_validation_error(e)
            elif name == "ae.getCompositionTime" and isinstance(
                e, PydanticValidationError
            ):
                error = _composition_time_validation_error(e)
            elif name == "ae.setCompositionTime" and isinstance(
                e, PydanticValidationError
            ):
                error = _composition_time_set_validation_error(e)
            elif name == "ae.createComposition" and isinstance(
                e, PydanticValidationError
            ):
                error = _composition_create_validation_error(e)
            elif name == "ae.createCompositionLayer" and isinstance(
                e, PydanticValidationError
            ):
                error = _composition_layer_create_validation_error(e)
            elif name == "ae.applyLayerEffect" and isinstance(
                e, PydanticValidationError
            ):
                error = _layer_effect_apply_validation_error(e)
            elif name == "ae.listSelectedLayers" and isinstance(
                e, PydanticValidationError
            ):
                error = _selected_layers_validation_error(e)
            else:
                error = f"schema: {e}"
            payload = _format_result({"ok": False, "error": error})
            return CallToolResult(
                content=[TextContent(type="text", text=payload)],
                isError=True,
            )

        # Pull ctx from request context so handlers can emit progress.
        ctx = None
        try:
            ctx = server.request_context  # type: ignore[attr-defined]
        except LookupError:
            ctx = None

        if canonical not in {"ae.toolUse", "ae.skillUse"}:
            gated = await approval_gate.enforce(canonical, ctx)
            if gated is not None:
                payload = _format_result(gated)
                return CallToolResult(
                    content=[TextContent(type="text", text=payload)],
                    isError=True,
                )

        developer_token = client_identity.set_panel_developer(panel_developer)
        try:
            try:
                result = await run_fn(validated, ctx)
            except NativeBackendError as e:
                log.info("native handler %s failed with %s", name, e.code)
                result = {"ok": False, "error": e.public_dict()}
            except Exception as e:  # noqa: BLE001
                log.exception("handler %s raised", name)
                payload = _format_result({"ok": False, "error": append_hint(str(e))})
                return CallToolResult(
                    content=[TextContent(type="text", text=payload)],
                    isError=True,
                )
        finally:
            client_identity.reset_panel_developer(developer_token)

        if isinstance(result, dict) and result.get("ok") is False and "error" in result:
            error = result["error"]
            if isinstance(error, str):
                result = {**result, "error": append_hint(error)}

        if isinstance(result, dict) and result.get("ok") is True:
            request_id = None
            try:
                if ctx is not None and getattr(ctx, "request_id", None) is not None:
                    request_id = str(ctx.request_id)
                history_arguments = validated.model_dump(mode="json")
                history_context = HistoryContext(
                    client=client_identity.get_client(),
                    request_id=request_id,
                    created_at=int(time.time() * 1000),
                )
                if extract_history_draft(
                    canonical,
                    history_arguments,
                    result,
                    history_context,
                ) is not None:
                    capture_history_candidate(
                        store=default_tool_service().store,
                        scanner=_history_scanner,
                        verb_name=canonical,
                        arguments=history_arguments,
                        result=result,
                        context=history_context,
                    )
            except (ToolStoreError, SecretScanError) as error:
                log.warning(
                    "history capture failed: %s request_id=%s",
                    type(error).__name__,
                    request_id or "-",
                )
            except Exception as error:  # noqa: BLE001
                log.warning(
                    "history capture failed: %s request_id=%s",
                    type(error).__name__,
                    request_id or "-",
                )

        return CallToolResult(
            content=[TextContent(type="text", text=_format_result(result))],
            isError=isinstance(result, dict) and result.get("ok") is False,
        )

    # Expose the dispatch closures + reverse map for testing. The decorators
    # above already registered them via the MCP request_handlers registry;
    # these handles let tests drive dispatch directly without changing any
    # runtime behaviour.
    server._ae_list_tools = _list_tools  # type: ignore[attr-defined]
    server._ae_call_tool = _call_tool  # type: ignore[attr-defined]
    server._ae_reverse_map = reverse_map  # type: ignore[attr-defined]

    return server


async def _run_async() -> None:
    """Async entry: stdio transport loop."""
    server = build_server()
    asyncio.create_task(_startup_probe())
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


async def _startup_probe(get_backend=None) -> None:
    """Best-effort startup backend health probe; never blocks server startup."""
    if get_backend is None:
        from ae_mcp.handlers.core import _backend as get_backend
    try:
        backend = get_backend()
        ok = await backend.health_check(timeout_sec=5.0)
        if not ok:
            log.info("startup backend health_check returned false")
    except Exception as e:  # noqa: BLE001
        log.debug("startup backend health_check failed: %s", e)


def run() -> None:
    """Blocking entry: initialise logging, start asyncio loop on stdio."""
    import asyncio

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    asyncio.run(_run_async())


if __name__ == "__main__":
    run()
