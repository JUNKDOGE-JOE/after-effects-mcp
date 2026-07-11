"""Canonical Tool Library artifact models and deterministic identities.

This module deliberately owns only validation and serialization. Persistence,
trust decisions, grants, and execution live in later Tool Library layers.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence, TypeAlias, TypedDict, cast
from uuid import UUID


JsonValue: TypeAlias = (
    None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
)
ArtifactKind: TypeAlias = Literal[
    "jsx", "expression", "prompt-skill", "recipe", "diagnostic"
]
ArtifactStatus: TypeAlias = Literal[
    "candidate", "saved", "pinned", "archived", "deprecated"
]
ArtifactRisk: TypeAlias = Literal["read", "write", "destructive", "external"]
ArtifactOperation: TypeAlias = Literal["render", "execute", "apply"]
SourceType: TypeAlias = Literal[
    "user", "legacy", "bundled", "chat-tool-call", "imported"
]
VerificationMethod: TypeAlias = Literal[
    "signed-manifest", "content-hash", "user-reviewed"
]


class RecipeStep(TypedDict):
    refType: Literal["artifact", "tool"]
    ref: str
    operation: Literal["render", "execute", "apply", "call"]
    args: Mapping[str, JsonValue]
    target: Mapping[str, JsonValue]


class RecipeContent(TypedDict):
    steps: Sequence[RecipeStep]


class DiagnosticContent(TypedDict):
    capability: str
    args: Mapping[str, JsonValue]


ArtifactContent: TypeAlias = str | RecipeContent | DiagnosticContent


_KINDS = frozenset({"jsx", "expression", "prompt-skill", "recipe", "diagnostic"})
_STATUSES = frozenset({"candidate", "saved", "pinned", "archived", "deprecated"})
_RISKS = ("read", "write", "destructive", "external")
_SOURCE_TYPES = frozenset({"user", "legacy", "bundled", "chat-tool-call", "imported"})
_VERIFICATION_METHODS = frozenset(
    {"signed-manifest", "content-hash", "user-reviewed"}
)
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_BUILTIN_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
_RECURSIVE_TOOL = re.compile(r"^ae\.tool", re.IGNORECASE)
_ARTIFACT_KEYS = frozenset(
    {
        "schemaVersion",
        "id",
        "name",
        "description",
        "kind",
        "category",
        "tags",
        "compatibility",
        "declaredRisk",
        "source",
        "status",
        "verified",
        "verification",
        "content",
        "argsSchema",
        "contentHash",
        "revision",
        "createdAt",
        "updatedAt",
        "lastUsedAt",
    }
)
_SOURCE_KEYS = frozenset({"type", "ref", "client", "productVersion", "provenance"})
_VERIFICATION_KEYS = frozenset({"method", "verifiedAt", "evidenceHash"})
_RECIPE_STEP_KEYS = frozenset(
    {"refType", "ref", "operation", "args", "target"}
)
_ARGS_SCHEMA_ROOT_KEYS = frozenset(
    {"type", "properties", "required", "additionalProperties"}
)
_ARGS_SCHEMA_VALUE_KEYS = frozenset(
    {"type", "enum", "default", "minimum", "maximum", "minLength", "maxLength"}
)
_ARGS_SCHEMA_TYPES = frozenset(
    {"string", "number", "integer", "boolean", "object", "array", "null"}
)


def _exact_keys(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    actual = set(value)
    unknown = sorted(actual - expected)
    missing = sorted(expected - actual)
    if unknown:
        raise ValueError(f"{label} contains unknown keys: {', '.join(unknown)}")
    if missing:
        raise ValueError(f"{label} is missing keys: {', '.join(missing)}")


def _json_value(value: Any, *, label: str) -> JsonValue:
    if value is None or isinstance(value, (bool, str)):
        return cast(JsonValue, value)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{label} JSON numbers must be finite")
        return value
    if isinstance(value, Mapping):
        result: dict[str, JsonValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{label} JSON object keys must be strings")
            result[key] = _json_value(item, label=label)
        return result
    if isinstance(value, (list, tuple)):
        return [_json_value(item, label=label) for item in value]
    raise ValueError(f"{label} is not a JSON value")


def _mapping(value: Any, *, label: str) -> dict[str, JsonValue]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    normalized = _json_value(value, label=label)
    if not isinstance(normalized, dict):  # defensive for type checkers
        raise ValueError(f"{label} must be an object")
    return normalized


def _string(value: Any, *, label: str, max_length: int, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    normalized = unicodedata.normalize("NFC", value)
    if not allow_empty and not normalized:
        raise ValueError(f"{label} must not be empty")
    if len(normalized) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return normalized


def _integer(value: Any, *, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def canonical_json_bytes(value: JsonValue) -> bytes:
    """Return canonical UTF-8 JSON bytes or reject non-JSON/non-finite input."""

    normalized = _json_value(value, label="value")
    try:
        return json.dumps(
            normalized,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:  # defensive: validation above is strict
        raise ValueError("value must contain finite JSON values") from exc


def compute_content_hash(
    kind: ArtifactKind,
    content: ArtifactContent,
    args_schema: Mapping[str, JsonValue],
) -> str:
    if kind not in _KINDS:
        raise ValueError(f"unsupported artifact kind: {kind!r}")
    body = {
        "kind": kind,
        "content": _json_value(content, label="content"),
        "argsSchema": _mapping(args_schema, label="argsSchema"),
    }
    return hashlib.sha256(canonical_json_bytes(body)).hexdigest()


def validate_args_schema(
    value: Mapping[str, JsonValue],
) -> dict[str, JsonValue]:
    schema = _mapping(value, label="argsSchema")
    canonical_shape = (
        "properties" in schema
        or "required" in schema
        or "additionalProperties" in schema
        or schema.get("type") == "object"
    )
    if canonical_shape:
        unknown = sorted(set(schema) - _ARGS_SCHEMA_ROOT_KEYS)
        if unknown:
            raise ValueError(
                "argsSchema contains unsupported keywords: " + ", ".join(unknown)
            )
        if schema.get("type", "object") != "object":
            raise ValueError("argsSchema root type must be object")
        raw_properties = schema.get("properties", {})
        if not isinstance(raw_properties, Mapping):
            raise ValueError("argsSchema properties must be an object")
        raw_required = schema.get("required", [])
        if not isinstance(raw_required, list) or not all(
            isinstance(item, str) for item in raw_required
        ):
            raise ValueError("argsSchema required must be an array of strings")
        if len(set(raw_required)) != len(raw_required):
            raise ValueError("argsSchema required entries must be unique")
        missing = sorted(set(raw_required) - set(raw_properties))
        if missing:
            raise ValueError(
                "argsSchema required references unknown properties: "
                + ", ".join(missing)
            )
        additional = schema.get("additionalProperties", True)
        if type(additional) is not bool:
            raise ValueError("argsSchema additionalProperties must be a boolean")
        properties = raw_properties
    else:
        properties = schema

    for name, raw_rule in properties.items():
        if not isinstance(name, str) or not name:
            raise ValueError("argsSchema property names must be non-empty strings")
        if not isinstance(raw_rule, Mapping):
            raise ValueError(f"argsSchema property {name} must be an object")
        unknown = sorted(set(raw_rule) - _ARGS_SCHEMA_VALUE_KEYS)
        if unknown:
            raise ValueError(
                f"argsSchema property {name} contains unsupported keywords: "
                + ", ".join(unknown)
            )
        rule_type = raw_rule.get("type")
        if rule_type is not None and rule_type not in _ARGS_SCHEMA_TYPES:
            raise ValueError(f"argsSchema property {name} has unsupported type")
        if "enum" in raw_rule:
            enum = raw_rule["enum"]
            if not isinstance(enum, list) or not enum:
                raise ValueError(f"argsSchema property {name} enum must be non-empty")
            _json_value(enum, label=f"argsSchema property {name} enum")
        if "default" in raw_rule:
            _json_value(raw_rule["default"], label=f"argsSchema property {name} default")
        for bound in ("minimum", "maximum"):
            item = raw_rule.get(bound)
            if item is not None and (
                isinstance(item, bool) or not isinstance(item, (int, float))
            ):
                raise ValueError(
                    f"argsSchema property {name} {bound} must be a number"
                )
        for bound in ("minLength", "maxLength"):
            item = raw_rule.get(bound)
            if item is not None and (
                isinstance(item, bool) or not isinstance(item, int) or item < 0
            ):
                raise ValueError(
                    f"argsSchema property {name} {bound} must be a non-negative integer"
                )
        minimum = raw_rule.get("minimum")
        maximum = raw_rule.get("maximum")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ValueError(f"argsSchema property {name} has inverted numeric bounds")
        min_length = raw_rule.get("minLength")
        max_length = raw_rule.get("maxLength")
        if min_length is not None and max_length is not None and min_length > max_length:
            raise ValueError(f"argsSchema property {name} has inverted length bounds")
    return schema


def new_user_artifact_id(uuid_value: UUID) -> str:
    if not isinstance(uuid_value, UUID):
        raise ValueError("user artifact identity must be a UUID")
    return f"user:{str(uuid_value).lower()}"


def legacy_artifact_id(source_path: Path) -> str:
    if not isinstance(source_path, Path):
        source_path = Path(source_path)
    canonical = unicodedata.normalize("NFC", str(source_path.expanduser().resolve(strict=False)))
    return "legacy:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def builtin_artifact_id(skill_name: str) -> str:
    if not isinstance(skill_name, str) or not _BUILTIN_NAME.fullmatch(skill_name):
        raise ValueError("builtin skill name must be a lowercase bounded identifier")
    return f"builtin:skill:{skill_name}"


def max_risk(*risks: ArtifactRisk) -> ArtifactRisk:
    if not risks:
        raise ValueError("at least one risk is required")
    try:
        return cast(ArtifactRisk, max(risks, key=_RISKS.index))
    except ValueError as exc:
        raise ValueError("unsupported artifact risk") from exc


def _source_from_dict(value: Any) -> "ToolSource":
    if not isinstance(value, Mapping):
        raise ValueError("source must be an object")
    _exact_keys(value, _SOURCE_KEYS, "source")
    source_type = value["type"]
    if source_type not in _SOURCE_TYPES:
        raise ValueError("source type is unsupported")
    ref = _string(value["ref"], label="source.ref", max_length=4096, allow_empty=False)
    client = value["client"]
    if client is not None:
        client = _string(client, label="source.client", max_length=256)
    product_version = value["productVersion"]
    if product_version is not None:
        product_version = _string(
            product_version, label="source.productVersion", max_length=128
        )
    return ToolSource(
        type=cast(SourceType, source_type),
        ref=ref,
        client=cast(str | None, client),
        product_version=cast(str | None, product_version),
        provenance=_mapping(value["provenance"], label="source.provenance"),
    )


def _verification_from_dict(value: Any) -> "ToolVerification | None":
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("verification must be an object or null")
    _exact_keys(value, _VERIFICATION_KEYS, "verification")
    method = value["method"]
    if method not in _VERIFICATION_METHODS:
        raise ValueError("verification method is unsupported")
    evidence = value["evidenceHash"]
    if evidence is not None and (
        not isinstance(evidence, str) or not _HEX_64.fullmatch(evidence)
    ):
        raise ValueError("verification evidenceHash must be a SHA-256 hex digest or null")
    return ToolVerification(
        method=cast(VerificationMethod, method),
        verified_at=_integer(value["verifiedAt"], label="verification.verifiedAt"),
        evidence_hash=cast(str | None, evidence),
    )


def _validate_recipe_tool(ref: str, args: Mapping[str, JsonValue]) -> None:
    if ref in {"ae.exec", "ae.skillUse"} or _RECURSIVE_TOOL.match(ref):
        raise ValueError(f"recipe recursive tool reference is forbidden: {ref}")
    from ae_mcp.handlers import HANDLERS, load_all

    load_all()
    handler = HANDLERS.get(ref)
    if handler is None:
        raise ValueError(f"recipe references unknown handler: {ref}")
    schema, _run = handler
    invalid = False
    try:
        schema.model_validate(dict(args))
    except Exception:  # Pydantic error objects can retain the original argument values.
        invalid = True
    if invalid:
        raise ValueError(f"recipe tool args are invalid for {ref}")


def _validate_content(kind: ArtifactKind, value: Any) -> ArtifactContent:
    if kind in {"jsx", "expression", "prompt-skill"}:
        if not isinstance(value, str):
            raise ValueError(f"{kind} content must be a string")
        return value
    if kind == "diagnostic":
        if not isinstance(value, Mapping):
            raise ValueError("diagnostic content must be an object")
        _exact_keys(value, frozenset({"capability", "args"}), "diagnostic content")
        capability = _string(
            value["capability"],
            label="diagnostic capability",
            max_length=256,
            allow_empty=False,
        )
        return cast(DiagnosticContent, {
            "capability": capability,
            "args": _mapping(value["args"], label="diagnostic args"),
        })
    if kind != "recipe":
        raise ValueError(f"unsupported artifact kind: {kind!r}")
    if not isinstance(value, Mapping):
        raise ValueError("recipe content must be an object")
    _exact_keys(value, frozenset({"steps"}), "recipe content")
    raw_steps = value["steps"]
    if not isinstance(raw_steps, Sequence) or isinstance(raw_steps, (str, bytes)):
        raise ValueError("recipe steps must be an array")
    if not 1 <= len(raw_steps) <= 64:
        raise ValueError("recipe steps must contain between 1 and 64 entries")
    steps: list[RecipeStep] = []
    for index, raw_step in enumerate(raw_steps):
        if not isinstance(raw_step, Mapping):
            raise ValueError(f"recipe step {index} must be an object")
        _exact_keys(raw_step, _RECIPE_STEP_KEYS, f"recipe step {index}")
        ref_type = raw_step["refType"]
        operation = raw_step["operation"]
        ref = _string(
            raw_step["ref"], label=f"recipe step {index} ref", max_length=512, allow_empty=False
        )
        args = _mapping(raw_step["args"], label=f"recipe step {index} args")
        target = _mapping(raw_step["target"], label=f"recipe step {index} target")
        if ref_type == "tool":
            if operation != "call":
                raise ValueError("recipe tool step operation must be call")
            _validate_recipe_tool(ref, args)
        elif ref_type == "artifact":
            if operation not in {"render", "execute", "apply"}:
                raise ValueError(
                    "recipe artifact step operation must be render, execute, or apply"
                )
        else:
            raise ValueError("recipe refType must be artifact or tool")
        steps.append(
            {
                "refType": cast(Literal["artifact", "tool"], ref_type),
                "ref": ref,
                "operation": cast(
                    Literal["render", "execute", "apply", "call"], operation
                ),
                "args": args,
                "target": target,
            }
        )
    return RecipeContent(steps=steps)


@dataclass(frozen=True)
class ToolSource:
    type: SourceType
    ref: str
    client: str | None
    product_version: str | None
    provenance: Mapping[str, JsonValue]

    def __post_init__(self) -> None:
        if self.type not in _SOURCE_TYPES:
            raise ValueError("source type is unsupported")
        _string(self.ref, label="source.ref", max_length=4096, allow_empty=False)
        if self.client is not None:
            _string(self.client, label="source.client", max_length=256)
        if self.product_version is not None:
            _string(self.product_version, label="source.productVersion", max_length=128)
        object.__setattr__(
            self, "provenance", _mapping(self.provenance, label="source.provenance")
        )


@dataclass(frozen=True)
class ToolVerification:
    method: VerificationMethod
    verified_at: int
    evidence_hash: str | None

    def __post_init__(self) -> None:
        if self.method not in _VERIFICATION_METHODS:
            raise ValueError("verification method is unsupported")
        _integer(self.verified_at, label="verification.verifiedAt")
        if self.evidence_hash is not None and not _HEX_64.fullmatch(self.evidence_hash):
            raise ValueError("verification evidenceHash must be a SHA-256 hex digest")


@dataclass(frozen=True)
class ToolArtifact:
    id: str
    name: str
    description: str
    kind: ArtifactKind
    category: str
    tags: tuple[str, ...]
    compatibility: Mapping[str, JsonValue]
    declared_risk: ArtifactRisk
    source: ToolSource
    status: ArtifactStatus
    verified: bool
    verification: ToolVerification | None
    content: ArtifactContent
    args_schema: Mapping[str, JsonValue]
    content_hash: str
    schema_version: int
    revision: int
    created_at: int
    updated_at: int
    last_used_at: int | None

    @classmethod
    def from_dict(
        cls, data: Mapping[str, JsonValue], *, imported: bool = False
    ) -> "ToolArtifact":
        if not isinstance(data, Mapping):
            raise ValueError("artifact must be an object")
        _exact_keys(data, _ARTIFACT_KEYS, "artifact")
        if data["schemaVersion"] != 1:
            raise ValueError("unsupported artifact schemaVersion")
        kind = data["kind"]
        if kind not in _KINDS:
            raise ValueError("artifact kind is unsupported")
        status = data["status"]
        if status not in _STATUSES:
            raise ValueError("artifact status is unsupported")
        risk = data["declaredRisk"]
        if risk not in _RISKS:
            raise ValueError("artifact declaredRisk is unsupported")
        artifact_id = _string(
            data["id"], label="artifact id", max_length=256, allow_empty=False
        )
        name = _string(data["name"], label="artifact name", max_length=128, allow_empty=False)
        description = _string(
            data["description"], label="artifact description", max_length=4096
        )
        category = _string(
            data["category"], label="artifact category", max_length=128, allow_empty=False
        )
        raw_tags = data["tags"]
        if not isinstance(raw_tags, (list, tuple)):
            raise ValueError("artifact tags must be an array")
        if len(raw_tags) > 32:
            raise ValueError("artifact tags exceed 32 entries")
        tags = tuple(
            _string(item, label="artifact tag", max_length=64, allow_empty=False)
            for item in raw_tags
        )
        if len(set(tags)) != len(tags):
            raise ValueError("artifact tags must be unique")
        compatibility = _mapping(data["compatibility"], label="compatibility")
        source = _source_from_dict(data["source"])
        if type(data["verified"]) is not bool:
            raise ValueError("artifact verified must be a boolean")
        verified = cast(bool, data["verified"])
        verification = _verification_from_dict(data["verification"])
        if verified and verification is None:
            raise ValueError("verified artifact requires a verification record")
        if not verified and verification is not None:
            raise ValueError("unverified artifact cannot carry verification")
        content = _validate_content(cast(ArtifactKind, kind), data["content"])
        args_schema = validate_args_schema(
            _mapping(data["argsSchema"], label="argsSchema")
        )
        content_hash = data["contentHash"]
        if not isinstance(content_hash, str) or not _HEX_64.fullmatch(content_hash):
            raise ValueError("artifact contentHash must be a lowercase SHA-256 digest")
        expected_hash = compute_content_hash(cast(ArtifactKind, kind), content, args_schema)
        if content_hash != expected_hash:
            raise ValueError("artifact contentHash does not match content and argsSchema")
        revision = _integer(data["revision"], label="artifact revision", minimum=1)
        created_at = _integer(data["createdAt"], label="artifact createdAt")
        updated_at = _integer(data["updatedAt"], label="artifact updatedAt")
        last_used = data["lastUsedAt"]
        if last_used is not None:
            last_used = _integer(last_used, label="artifact lastUsedAt")
        if imported:
            status = "candidate"
            verified = False
            verification = None
        return cls(
            id=artifact_id,
            name=name,
            description=description,
            kind=cast(ArtifactKind, kind),
            category=category,
            tags=tags,
            compatibility=compatibility,
            declared_risk=cast(ArtifactRisk, risk),
            source=source,
            status=cast(ArtifactStatus, status),
            verified=verified,
            verification=verification,
            content=content,
            args_schema=args_schema,
            content_hash=content_hash,
            schema_version=1,
            revision=revision,
            created_at=created_at,
            updated_at=updated_at,
            last_used_at=cast(int | None, last_used),
        )

    def to_dict(
        self, *, include_content: bool = True, export_safe: bool = False
    ) -> dict[str, JsonValue]:
        if export_safe:
            source: dict[str, JsonValue] = {
                "type": self.source.type,
                "ref": self.id,
                "client": None,
                "productVersion": self.source.product_version,
                "provenance": {"contentHash": self.content_hash},
            }
        else:
            source = {
                "type": self.source.type,
                "ref": self.source.ref,
                "client": self.source.client,
                "productVersion": self.source.product_version,
                "provenance": _mapping(
                    self.source.provenance, label="source.provenance"
                ),
            }
        verification: JsonValue
        if self.verification is None:
            verification = None
        else:
            verification = {
                "method": self.verification.method,
                "verifiedAt": self.verification.verified_at,
                "evidenceHash": self.verification.evidence_hash,
            }
        result: dict[str, JsonValue] = {
            "schemaVersion": self.schema_version,
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "kind": self.kind,
            "category": self.category,
            "tags": list(self.tags),
            "compatibility": _mapping(self.compatibility, label="compatibility"),
            "declaredRisk": self.declared_risk,
            "source": source,
            "status": self.status,
            "verified": self.verified,
            "verification": verification,
            "argsSchema": _mapping(self.args_schema, label="argsSchema"),
            "contentHash": self.content_hash,
            "revision": self.revision,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "lastUsedAt": self.last_used_at,
        }
        if include_content:
            result["content"] = _json_value(self.content, label="content")
        return result


@dataclass(frozen=True)
class ToolArtifactDraft:
    name: str
    description: str
    kind: ArtifactKind
    category: str
    tags: tuple[str, ...]
    compatibility: Mapping[str, JsonValue]
    declared_risk: ArtifactRisk
    source: ToolSource
    status: Literal["candidate", "saved"]
    content: ArtifactContent
    args_schema: Mapping[str, JsonValue]

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "name", _string(self.name, label="artifact name", max_length=128, allow_empty=False)
        )
        object.__setattr__(
            self,
            "description",
            _string(self.description, label="artifact description", max_length=4096),
        )
        if self.kind not in _KINDS:
            raise ValueError("artifact kind is unsupported")
        object.__setattr__(
            self,
            "category",
            _string(self.category, label="artifact category", max_length=128, allow_empty=False),
        )
        if len(self.tags) > 32:
            raise ValueError("artifact tags exceed 32 entries")
        normalized_tags = tuple(
            _string(item, label="artifact tag", max_length=64, allow_empty=False)
            for item in self.tags
        )
        if len(set(normalized_tags)) != len(normalized_tags):
            raise ValueError("artifact tags must be unique")
        object.__setattr__(self, "tags", normalized_tags)
        object.__setattr__(
            self, "compatibility", _mapping(self.compatibility, label="compatibility")
        )
        if self.declared_risk not in _RISKS:
            raise ValueError("artifact declaredRisk is unsupported")
        if not isinstance(self.source, ToolSource):
            raise ValueError("artifact source must be a ToolSource")
        if self.status not in {"candidate", "saved"}:
            raise ValueError("draft status must be candidate or saved")
        object.__setattr__(self, "content", _validate_content(self.kind, self.content))
        object.__setattr__(
            self,
            "args_schema",
            validate_args_schema(_mapping(self.args_schema, label="argsSchema")),
        )


@dataclass(frozen=True)
class ToolSummary:
    id: str
    name: str
    description: str
    kind: ArtifactKind
    category: str
    tags: tuple[str, ...]
    status: ArtifactStatus
    verified: bool
    declared_risk: ArtifactRisk
    content_hash: str
    revision: int
    updated_at: int
    last_used_at: int | None
    source_type: str


__all__ = [
    "ArtifactContent",
    "ArtifactKind",
    "ArtifactOperation",
    "ArtifactRisk",
    "ArtifactStatus",
    "DiagnosticContent",
    "JsonValue",
    "RecipeContent",
    "RecipeStep",
    "ToolArtifact",
    "ToolArtifactDraft",
    "ToolSource",
    "ToolSummary",
    "ToolVerification",
    "builtin_artifact_id",
    "canonical_json_bytes",
    "compute_content_hash",
    "legacy_artifact_id",
    "max_risk",
    "new_user_artifact_id",
    "validate_args_schema",
]
