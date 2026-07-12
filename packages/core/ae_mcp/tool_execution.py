"""Hash-bound planning, authorization, and execution for Tool Library artifacts."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import Any, Callable, Literal, Mapping, Sequence, cast

from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.approval_gate import PlanAuthorizationDenied, authorize_plan, plan_decision
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.tool_artifact import (
    ArtifactKind,
    ArtifactOperation,
    ArtifactRisk,
    JsonValue,
    ToolArtifact,
    canonical_json_bytes,
    max_risk,
    validate_args_schema,
)
from ae_mcp.tool_audit import AuditRecord, ToolAuditLog, redact_audit_value
from ae_mcp.tool_secrets import RegexSecretScanner, SecretScanner


PLAN_TTL_MS = 300_000
GRANT_TTL_MS = 60_000
DIAGNOSTIC_CAPABILITIES = frozenset(
    {
        "ae.overview",
        "ae.layers",
        "ae.ping",
        "ae.getTime",
        "ae.getProperties",
        "ae.scanPropertyTree",
        "ae.inspectPropertyCapabilities",
        "ae.getExpressions",
        "ae.validateExpressions",
        "ae.getKeyframes",
        "ae.searchProject",
    }
)

_EXTERNAL_JSX = re.compile(
    r"\b(File|Folder|Socket|system\.callSystem|app\.open|importFile)\b"
)
_DESTRUCTIVE_JSX = re.compile(
    r"(\.remove\s*\(|\bpurge\s*\(|app\.project\.close\s*\(|"
    r"\beval\s*\(|\bFunction\s*\()"
)
_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_BLOCKED_STATUSES = frozenset({"candidate", "archived", "deprecated"})
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_TEMPLATES_DIR = Path(__file__).resolve().parent / "jsx_templates"


def _now_ms() -> int:
    return int(time.time() * 1000)


class ToolExecutionError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code

    def public_dict(self) -> dict[str, object]:
        return {"ok": False, "error": self.code, "message": str(self)}


class _BackendExecutionError(ToolExecutionError):
    def __init__(self, code: str, message: str, backend_name: str) -> None:
        super().__init__(code, message)
        self.backend_name = backend_name


def _canonical_value(value: Any, *, label: str) -> JsonValue:
    try:
        encoded = canonical_json_bytes(cast(JsonValue, value))
        return cast(JsonValue, json.loads(encoded.decode("utf-8")))
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise ToolExecutionError(
            "tool_invalid_input", f"{label} must contain finite JSON values."
        ) from exc


def _canonical_map(value: Any, *, label: str) -> dict[str, JsonValue]:
    normalized = _canonical_value(value, label=label)
    if not isinstance(normalized, dict):
        raise ToolExecutionError("tool_invalid_input", f"{label} must be an object.")
    return normalized


def _schema_parts(
    schema: Mapping[str, JsonValue],
) -> tuple[Mapping[str, Any], set[str], bool]:
    validated = validate_args_schema(schema)
    canonical_shape = (
        "properties" in validated
        or "required" in validated
        or "additionalProperties" in validated
        or validated.get("type") == "object"
    )
    if canonical_shape:
        properties = cast(Mapping[str, Any], validated.get("properties", {}))
        required = set(cast(list[str], validated.get("required", [])))
        additional = cast(bool, validated.get("additionalProperties", True))
        return properties, required, additional
    return cast(Mapping[str, Any], validated), set(), True


def _matches_type(value: JsonValue, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "boolean":
        return type(value) is bool
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return False


def _validate_arg(name: str, value: JsonValue, rule: Mapping[str, Any]) -> JsonValue:
    expected = rule.get("type")
    if expected is not None and not _matches_type(value, str(expected)):
        raise ToolExecutionError(
            "tool_invalid_args", f"Argument {name} has the wrong type."
        )
    if "enum" in rule:
        encoded = canonical_json_bytes(value)
        if all(encoded != canonical_json_bytes(item) for item in rule["enum"]):
            raise ToolExecutionError(
                "tool_invalid_args", f"Argument {name} is outside its enum."
            )
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in rule and value < rule["minimum"]:
            raise ToolExecutionError(
                "tool_invalid_args", f"Argument {name} is below its minimum."
            )
        if "maximum" in rule and value > rule["maximum"]:
            raise ToolExecutionError(
                "tool_invalid_args", f"Argument {name} exceeds its maximum."
            )
    if isinstance(value, str):
        if "minLength" in rule and len(value) < rule["minLength"]:
            raise ToolExecutionError(
                "tool_invalid_args", f"Argument {name} is too short."
            )
        if "maxLength" in rule and len(value) > rule["maxLength"]:
            raise ToolExecutionError(
                "tool_invalid_args", f"Argument {name} is too long."
            )
    return value


def normalize_args(
    schema: Mapping[str, JsonValue], args: Mapping[str, JsonValue]
) -> dict[str, JsonValue]:
    supplied = _canonical_map(args, label="args")
    try:
        properties, required, additional = _schema_parts(schema)
    except ValueError as exc:
        raise ToolExecutionError(
            "tool_invalid_schema", "The artifact argument schema is unsupported."
        ) from exc
    unknown = sorted(set(supplied) - set(properties))
    if unknown and not additional:
        raise ToolExecutionError(
            "tool_invalid_args", "Unknown arguments: " + ", ".join(unknown)
        )
    normalized = dict(supplied)
    for name, raw_rule in properties.items():
        rule = cast(Mapping[str, Any], raw_rule)
        if name not in normalized and "default" in rule:
            normalized[name] = cast(JsonValue, _canonical_value(rule["default"], label=name))
        if name in normalized:
            normalized[name] = _validate_arg(name, normalized[name], rule)
    missing = sorted(required - set(normalized))
    if missing:
        raise ToolExecutionError(
            "tool_invalid_args", "Missing required arguments: " + ", ".join(missing)
        )
    return cast(dict[str, JsonValue], _canonical_value(normalized, label="args"))


def normalize_target(
    kind: ArtifactKind,
    operation: ArtifactOperation,
    target: Mapping[str, JsonValue],
) -> dict[str, JsonValue]:
    normalized = _canonical_map(target, label="target")
    if kind == "jsx":
        if operation not in {"render", "execute"}:
            raise ToolExecutionError("tool_invalid_operation", "JSX cannot be applied.")
        return normalized
    if kind == "expression":
        if operation == "render":
            if normalized:
                raise ToolExecutionError(
                    "tool_invalid_target", "Expression render requires an empty target."
                )
            return normalized
        if operation != "apply" or set(normalized) != {"compId", "layerId", "path"}:
            raise ToolExecutionError(
                "tool_invalid_target",
                "Expression apply requires compId, layerId, and path.",
            )
        comp_id = normalized["compId"]
        layer_id = normalized["layerId"]
        path = normalized["path"]
        if comp_id is not None and not isinstance(comp_id, str):
            raise ToolExecutionError(
                "tool_invalid_target", "Expression compId must be a string or null."
            )
        if isinstance(layer_id, bool) or not isinstance(layer_id, int) or layer_id < 1:
            raise ToolExecutionError(
                "tool_invalid_target", "Expression layerId must be a positive integer."
            )
        if not isinstance(path, str) or not path:
            raise ToolExecutionError(
                "tool_invalid_target", "Expression path must be a non-empty string."
            )
        return normalized
    if kind == "prompt-skill":
        if operation != "render" or normalized:
            raise ToolExecutionError(
                "tool_invalid_target", "Prompt render requires an empty target."
            )
        return normalized
    if kind == "diagnostic":
        if operation not in {"render", "execute"} or normalized:
            raise ToolExecutionError(
                "tool_invalid_target", "Diagnostic target must be empty."
            )
        return normalized
    if kind == "recipe":
        return normalized
    raise ToolExecutionError("tool_invalid_target", "Unsupported artifact kind.")


def analyze_jsx(rendered: str) -> ArtifactRisk:
    if not isinstance(rendered, str):
        raise ToolExecutionError("tool_invalid_content", "Rendered JSX must be text.")
    if _EXTERNAL_JSX.search(rendered):
        return "external"
    if _DESTRUCTIVE_JSX.search(rendered):
        return "destructive"
    return "write"


def analyze_artifact_risk(
    artifact: ToolArtifact,
    operation: ArtifactOperation,
    *,
    rendered: str | None = None,
    dependency_risks: Sequence[ArtifactRisk] = (),
) -> ArtifactRisk:
    if artifact.kind == "jsx":
        calculated = analyze_jsx(rendered if rendered is not None else cast(str, artifact.content))
    elif artifact.kind == "expression":
        calculated = "read" if operation == "render" else "write"
    elif artifact.kind == "prompt-skill":
        calculated = "read"
    elif artifact.kind == "diagnostic":
        content = cast(Mapping[str, JsonValue], artifact.content)
        if content.get("capability") not in DIAGNOSTIC_CAPABILITIES:
            raise ToolExecutionError(
                "tool_diagnostic_forbidden", "Diagnostic capability is not allowed."
            )
        calculated = "read"
    else:
        calculated = max_risk(*dependency_risks) if dependency_risks else "read"
    if dependency_risks and artifact.kind != "recipe":
        calculated = max_risk(calculated, *dependency_risks)
    return max_risk(calculated, artifact.declared_risk)


def compute_plan_hash(
    artifact_id: str,
    content_hash: str,
    operation: ArtifactOperation,
    normalized_args: Mapping[str, JsonValue],
    target: Mapping[str, JsonValue],
    dependency_hashes: Sequence[tuple[str, str]],
    risk: ArtifactRisk,
) -> str:
    payload: JsonValue = {
        "artifactId": artifact_id,
        "contentHash": content_hash,
        "operation": operation,
        "normalizedArgs": dict(normalized_args),
        "normalizedTarget": dict(target),
        "dependencyHashes": [list(item) for item in dependency_hashes],
        "risk": risk,
    }
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


@dataclass(frozen=True)
class ExecutionPlan:
    artifact_id: str
    content_hash: str
    operation: ArtifactOperation
    normalized_args: Mapping[str, JsonValue]
    target: Mapping[str, JsonValue]
    dependency_hashes: tuple[tuple[str, str], ...]
    plan_hash: str
    risk: ArtifactRisk
    expires_at: int

    def public_dict(self) -> dict[str, JsonValue]:
        return {
            "artifactId": self.artifact_id,
            "contentHash": self.content_hash,
            "operation": self.operation,
            "normalizedArgs": dict(self.normalized_args),
            "target": dict(self.target),
            "dependencyHashes": [list(item) for item in self.dependency_hashes],
            "planHash": self.plan_hash,
            "risk": self.risk,
            "expiresAt": self.expires_at,
        }


@dataclass(frozen=True)
class ExecutionGrant:
    grant_id: str
    plan_hash: str
    scope: Literal["once", "session"]
    expires_at: int

    def public_dict(self) -> dict[str, JsonValue]:
        return {
            "grantId": self.grant_id,
            "planHash": self.plan_hash,
            "scope": self.scope,
            "expiresAt": self.expires_at,
        }


class PreparedPlanStore:
    def __init__(self, *, now: Callable[[], int] | None = None) -> None:
        self._now = now or _now_ms
        self._plans: dict[str, ExecutionPlan] = {}
        self._lock = threading.RLock()

    def put(self, plan: ExecutionPlan) -> None:
        with self._lock:
            self._plans[plan.plan_hash] = plan

    def get(self, plan_hash: str) -> ExecutionPlan:
        with self._lock:
            plan = self._plans.get(plan_hash)
            if plan is None:
                raise ToolExecutionError("tool_plan_not_found", "Tool plan was not found.")
            if plan.expires_at <= self._now():
                self._plans.pop(plan_hash, None)
                raise ToolExecutionError("tool_plan_expired", "Tool plan has expired.")
            return plan

    def revoke_artifact(self, artifact_id: str) -> int:
        with self._lock:
            doomed = [
                plan_hash
                for plan_hash, plan in self._plans.items()
                if plan.artifact_id == artifact_id
                or any(ref == artifact_id for ref, _digest in plan.dependency_hashes)
            ]
            for plan_hash in doomed:
                self._plans.pop(plan_hash, None)
            return len(doomed)


def _session_key(plan: ExecutionPlan) -> str:
    payload: JsonValue = {
        "artifactId": plan.artifact_id,
        "contentHash": plan.content_hash,
        "operation": plan.operation,
        "normalizedTarget": dict(plan.target),
    }
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


@dataclass(frozen=True)
class _GrantState:
    grant: ExecutionGrant
    artifact_ids: frozenset[str]


class GrantStore:
    def __init__(
        self,
        *,
        now: Callable[[], int] | None = None,
        random_bytes: Callable[[int], bytes] | None = None,
    ) -> None:
        self._now = now or _now_ms
        self._random_bytes = random_bytes or os.urandom
        self._grants: dict[str, _GrantState] = {}
        self._allowances: dict[str, frozenset[str]] = {}
        self._lock = threading.RLock()

    def _issue(
        self, plan: ExecutionPlan, scope: Literal["once", "session"]
    ) -> ExecutionGrant:
        grant_id = base64.urlsafe_b64encode(self._random_bytes(32)).rstrip(b"=").decode("ascii")
        grant = ExecutionGrant(
            grant_id=grant_id,
            plan_hash=plan.plan_hash,
            scope=scope,
            expires_at=self._now() + GRANT_TTL_MS,
        )
        ids = frozenset(
            {plan.artifact_id, *(ref for ref, _digest in plan.dependency_hashes)}
        )
        self._grants[grant_id] = _GrantState(grant=grant, artifact_ids=ids)
        return grant

    def issue_once(self, plan: ExecutionPlan) -> ExecutionGrant:
        with self._lock:
            return self._issue(plan, "once")

    def allow_session(self, plan: ExecutionPlan) -> ExecutionGrant:
        if plan.risk != "write":
            raise ToolExecutionError(
                "tool_session_forbidden",
                "Session approval is available only for write-risk plans.",
            )
        with self._lock:
            ids = frozenset(
                {plan.artifact_id, *(ref for ref, _digest in plan.dependency_hashes)}
            )
            self._allowances[_session_key(plan)] = ids
            return self._issue(plan, "session")

    def issue_from_session(self, plan: ExecutionPlan) -> ExecutionGrant | None:
        if plan.risk != "write":
            return None
        with self._lock:
            if _session_key(plan) not in self._allowances:
                return None
            return self._issue(plan, "session")

    def consume(
        self, grant_id: str, plan: ExecutionPlan | str
    ) -> ExecutionGrant:
        expected_hash = plan.plan_hash if isinstance(plan, ExecutionPlan) else plan
        with self._lock:
            state = self._grants.pop(grant_id, None)
            if state is None:
                raise ToolExecutionError(
                    "tool_grant_invalid", "Execution grant is missing or already consumed."
                )
            grant = state.grant
            if grant.expires_at <= self._now():
                raise ToolExecutionError("tool_grant_expired", "Execution grant has expired.")
            if grant.plan_hash != expected_hash:
                raise ToolExecutionError(
                    "tool_grant_mismatch", "Execution grant does not match this plan."
                )
            return grant

    def revoke_artifact(self, artifact_id: str) -> int:
        with self._lock:
            grants = [
                grant_id
                for grant_id, state in self._grants.items()
                if artifact_id in state.artifact_ids
            ]
            for grant_id in grants:
                self._grants.pop(grant_id, None)
            allowances = [
                key for key, ids in self._allowances.items() if artifact_id in ids
            ]
            for key in allowances:
                self._allowances.pop(key, None)
            return len(grants) + len(allowances)


@dataclass(frozen=True)
class _Analysis:
    normalized_args: Mapping[str, JsonValue]
    target: Mapping[str, JsonValue]
    dependency_hashes: tuple[tuple[str, str], ...]
    risk: ArtifactRisk
    rendered: str | None


def _substitute_json(value: JsonValue, context: Mapping[str, JsonValue]) -> JsonValue:
    if isinstance(value, dict):
        return {key: _substitute_json(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [_substitute_json(item, context) for item in value]
    if not isinstance(value, str):
        return value
    match = _PLACEHOLDER.fullmatch(value)
    if match and match.group(1) in context:
        return context[match.group(1)]
    substitutions = {
        key: json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if not isinstance(item, str)
        else item
        for key, item in context.items()
    }
    try:
        return Template(value).safe_substitute(substitutions)
    except ValueError as exc:
        raise ToolExecutionError(
            "tool_render_failed", "Artifact substitution syntax is invalid."
        ) from exc


def _render_text(artifact: ToolArtifact, args: Mapping[str, JsonValue]) -> str:
    content = cast(str, artifact.content)
    placeholders = set(_PLACEHOLDER.findall(content))
    missing = sorted(placeholders - set(args))
    if missing:
        raise ToolExecutionError(
            "tool_invalid_args", "Missing template arguments: " + ", ".join(missing)
        )
    if artifact.kind == "prompt-skill":
        values = {key: str(value) for key, value in args.items()}
    else:
        values = {
            key: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            for key, value in args.items()
        }
    try:
        return Template(content).safe_substitute(values)
    except ValueError as exc:
        raise ToolExecutionError(
            "tool_render_failed", "Artifact substitution syntax is invalid."
        ) from exc


def _annotation_risk(name: str) -> ArtifactRisk:
    annotations = VERB_ANNOTATIONS.get(name)
    if annotations is None:
        raise ToolExecutionError("tool_handler_missing", "Recipe handler is unavailable.")
    if bool(getattr(annotations, "destructiveHint", False)):
        return "destructive"
    if bool(getattr(annotations, "readOnlyHint", False)):
        return "read"
    return "write"


def _handler_contract(
    name: str, args: Mapping[str, JsonValue]
) -> tuple[Any, Any, dict[str, JsonValue], ArtifactRisk, str]:
    from ae_mcp.handlers import HANDLERS, load_all

    load_all()
    entry = HANDLERS.get(name)
    if entry is None:
        raise ToolExecutionError("tool_handler_missing", "Recipe handler is unavailable.")
    schema, run = entry
    try:
        model = schema.model_validate(dict(args))
        normalized = model.model_dump(mode="json", by_alias=True)
        model_schema = schema.model_json_schema()
    except Exception as exc:
        raise ToolExecutionError(
            "tool_handler_args_invalid", "Recipe handler arguments are invalid."
        ) from exc
    normalized_map = _canonical_map(normalized, label="handler args")
    annotations = VERB_ANNOTATIONS.get(name)
    annotation_wire: JsonValue = {
        "readOnlyHint": bool(getattr(annotations, "readOnlyHint", False)),
        "destructiveHint": bool(getattr(annotations, "destructiveHint", False)),
        "idempotentHint": bool(getattr(annotations, "idempotentHint", False)),
    }
    contract: JsonValue = {
        "name": name,
        "schema": cast(JsonValue, model_schema),
        "annotations": annotation_wire,
    }
    digest = hashlib.sha256(canonical_json_bytes(contract)).hexdigest()
    return schema, run, normalized_map, _annotation_risk(name), digest


class ToolExecutionEngine:
    def __init__(
        self,
        store: Any,
        backend_factory: Any,
        *,
        scanner: SecretScanner | None = None,
        audit_log: ToolAuditLog | None = None,
        prepared_plans: PreparedPlanStore | None = None,
        grants: GrantStore | None = None,
        now: Callable[[], int] | None = None,
    ) -> None:
        self.store = store
        self.backend_factory = backend_factory
        self.scanner = scanner or RegexSecretScanner()
        self.audit_log = audit_log
        self._now = now or _now_ms
        self.prepared_plans = prepared_plans or PreparedPlanStore(now=self._now)
        self.grants = grants or GrantStore(now=self._now)
        self._unsubscribe: Callable[[], None] | None = None
        subscribe = getattr(store, "subscribe", None)
        if callable(subscribe):
            self._unsubscribe = subscribe(self._on_store_mutation)

    def close(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None

    def _on_store_mutation(self, mutation: Any) -> None:
        if isinstance(mutation, Mapping):
            artifact_ids = (
                mutation.get("artifact_ids")
                or mutation.get("artifactIds")
                or mutation.get("artifact_id")
                or mutation.get("artifactId")
            )
        else:
            artifact_ids = getattr(mutation, "artifact_ids", None)
            if artifact_ids is None:
                artifact_ids = getattr(mutation, "artifact_id", None)
        if isinstance(artifact_ids, str):
            artifact_ids = (artifact_ids,)
        if not isinstance(artifact_ids, (list, tuple, set, frozenset)):
            return
        for artifact_id in artifact_ids:
            if not isinstance(artifact_id, str) or not artifact_id:
                continue
            self.prepared_plans.revoke_artifact(artifact_id)
            self.grants.revoke_artifact(artifact_id)

    def _get_artifact(self, artifact_id: str) -> ToolArtifact:
        try:
            artifact = self.store.get(artifact_id, include_content=True)
        except TypeError:
            artifact = self.store.get(artifact_id)
        if not isinstance(artifact, ToolArtifact):
            raise ToolExecutionError("tool_not_found", "Tool artifact was not found.")
        if artifact.status in _BLOCKED_STATUSES:
            raise ToolExecutionError(
                "tool_status_blocked", "This artifact status cannot be executed."
            )
        return artifact

    def _analyze(
        self,
        artifact: ToolArtifact,
        operation: ArtifactOperation,
        args: Mapping[str, JsonValue],
        target: Mapping[str, JsonValue],
        *,
        stack: tuple[str, ...],
        depth: int,
        step_count: list[int],
    ) -> _Analysis:
        if depth > 8:
            raise ToolExecutionError(
                "tool_recipe_depth", "Recipe nesting exceeds eight levels."
            )
        if artifact.id in stack:
            raise ToolExecutionError("tool_recipe_cycle", "Recipe cycle detected.")
        normalized_args = normalize_args(artifact.args_schema, args)
        normalized_target = normalize_target(artifact.kind, operation, target)
        rendered: str | None = None
        dependencies: list[tuple[str, str]] = []
        risks: list[ArtifactRisk] = []
        next_stack = stack + (artifact.id,)

        if artifact.kind in {"jsx", "expression", "prompt-skill"}:
            rendered = _render_text(artifact, normalized_args)
        elif artifact.kind == "diagnostic":
            content = cast(Mapping[str, JsonValue], artifact.content)
            capability = cast(str, content["capability"])
            if capability not in DIAGNOSTIC_CAPABILITIES:
                raise ToolExecutionError(
                    "tool_diagnostic_forbidden", "Diagnostic capability is not allowed."
                )
            context = {**normalized_args, **normalized_target}
            raw_handler_args = _substitute_json(
                cast(JsonValue, content["args"]), context
            )
            handler_args = _canonical_map(raw_handler_args, label="diagnostic args")
            _schema, _run, _normalized, handler_risk, digest = _handler_contract(
                capability, handler_args
            )
            dependencies.append((capability, digest))
            risks.append(handler_risk)
        else:
            content = cast(Mapping[str, Any], artifact.content)
            context = {**normalized_args, **normalized_target}
            for step in content["steps"]:
                step_count[0] += 1
                if step_count[0] > 64:
                    raise ToolExecutionError(
                        "tool_recipe_steps", "Recipe graph exceeds 64 steps."
                    )
                raw_args = _substitute_json(cast(JsonValue, step["args"]), context)
                raw_target = _substitute_json(cast(JsonValue, step["target"]), context)
                step_args = _canonical_map(raw_args, label="recipe step args")
                step_target = _canonical_map(raw_target, label="recipe step target")
                if step["refType"] == "artifact":
                    child = self._get_artifact(step["ref"])
                    child_analysis = self._analyze(
                        child,
                        cast(ArtifactOperation, step["operation"]),
                        step_args,
                        step_target,
                        stack=next_stack,
                        depth=depth + 1,
                        step_count=step_count,
                    )
                    dependencies.append((child.id, child.content_hash))
                    dependencies.extend(child_analysis.dependency_hashes)
                    risks.append(child_analysis.risk)
                else:
                    name = cast(str, step["ref"])
                    if name in {"ae.exec", "ae.skillUse"} or name.startswith("ae.tool"):
                        raise ToolExecutionError(
                            "tool_recipe_recursive", "Recursive recipe tool is forbidden."
                        )
                    _schema, _run, _normalized, handler_risk, digest = _handler_contract(
                        name, step_args
                    )
                    dependencies.append((name, digest))
                    risks.append(handler_risk)

        risk = analyze_artifact_risk(
            artifact,
            operation,
            rendered=rendered,
            dependency_risks=risks,
        )
        return _Analysis(
            normalized_args=normalized_args,
            target=normalized_target,
            dependency_hashes=tuple(dependencies),
            risk=risk,
            rendered=rendered,
        )

    def _build_plan(
        self,
        artifact_id: str,
        operation: ArtifactOperation,
        args: Mapping[str, JsonValue],
        target: Mapping[str, JsonValue],
        *,
        expires_at: int,
    ) -> tuple[ToolArtifact, ExecutionPlan, _Analysis]:
        if operation not in {"render", "execute", "apply"}:
            raise ToolExecutionError(
                "tool_invalid_operation", "Tool operation is unsupported."
            )
        artifact = self._get_artifact(artifact_id)
        analysis = self._analyze(
            artifact,
            operation,
            args,
            target,
            stack=(),
            depth=1,
            step_count=[0],
        )
        plan_hash = compute_plan_hash(
            artifact.id,
            artifact.content_hash,
            operation,
            analysis.normalized_args,
            analysis.target,
            analysis.dependency_hashes,
            analysis.risk,
        )
        plan = ExecutionPlan(
            artifact_id=artifact.id,
            content_hash=artifact.content_hash,
            operation=operation,
            normalized_args=analysis.normalized_args,
            target=analysis.target,
            dependency_hashes=analysis.dependency_hashes,
            plan_hash=plan_hash,
            risk=analysis.risk,
            expires_at=expires_at,
        )
        return artifact, plan, analysis

    def render(
        self, artifact_id: str, args: Mapping[str, JsonValue]
    ) -> Mapping[str, JsonValue]:
        artifact, _plan, analysis = self._build_plan(
            artifact_id,
            "render",
            args,
            {},
            expires_at=self._now() + PLAN_TTL_MS,
        )
        if artifact.kind == "prompt-skill":
            return {
                "ok": True,
                "artifactId": artifact.id,
                "contentHash": artifact.content_hash,
                "trust": "user-untrusted",
                "untrustedContext": {
                    "kind": artifact.kind,
                    "content": cast(str, analysis.rendered),
                },
            }
        if analysis.rendered is not None:
            return {
                "ok": True,
                "artifactId": artifact.id,
                "contentHash": artifact.content_hash,
                "trust": "user-untrusted",
                "rendered": analysis.rendered,
            }
        return {
            "ok": True,
            "artifactId": artifact.id,
            "contentHash": artifact.content_hash,
            "trust": "user-untrusted",
            "untrustedContext": {
                "kind": artifact.kind,
                "content": cast(JsonValue, artifact.content),
            },
        }

    def prepare(
        self,
        artifact_id: str,
        *,
        operation: ArtifactOperation,
        args: Mapping[str, JsonValue],
        target: Mapping[str, JsonValue],
    ) -> ExecutionPlan:
        _artifact, plan, _analysis = self._build_plan(
            artifact_id,
            operation,
            args,
            target,
            expires_at=self._now() + PLAN_TTL_MS,
        )
        self.prepared_plans.put(plan)
        return plan

    async def request_grant(
        self,
        plan_hash: str,
        *,
        requested_scope: Literal["once", "session"],
        ctx: Any,
    ) -> ExecutionGrant:
        if requested_scope not in {"once", "session"}:
            raise ToolExecutionError("tool_grant_scope", "Grant scope is invalid.")
        plan = self.prepared_plans.get(plan_hash)
        from ae_mcp.approval_gate import current_tool_tier

        decision = plan_decision(current_tool_tier(), plan.risk)
        if decision == "elicit":
            existing = self.grants.issue_from_session(plan)
            if existing is not None:
                return existing
        started_at = self._now()
        try:
            scope = await authorize_plan(plan, ctx)
            if scope == "session":
                if requested_scope != "session":
                    raise ToolExecutionError(
                        "tool_grant_scope", "Session approval was not requested."
                    )
                return self.grants.allow_session(plan)
            return self.grants.issue_once(plan)
        except (PlanAuthorizationDenied, ToolExecutionError) as exc:
            self._audit(
                plan,
                grant=None,
                backend=None,
                outcome="denied",
                started_at=started_at,
                error_code=exc.code,
                redact_all_strings=True,
            )
            if isinstance(exc, ToolExecutionError):
                raise
            raise ToolExecutionError(exc.code, str(exc)) from exc

    def _scan_json(self, name: str, value: Mapping[str, JsonValue]) -> None:
        try:
            findings = self.scanner.scan_json(name, cast(JsonValue, dict(value)))
        except Exception as exc:
            raise ToolExecutionError(
                "tool_secret_scan_failed", "Secret scanning failed closed."
            ) from exc
        if findings:
            raise ToolExecutionError(
                "tool_secret_detected", "Secret-shaped values are not executable."
            )

    def _scan_text(self, name: str, value: str) -> None:
        try:
            findings = self.scanner.scan_bytes(name, value.encode("utf-8"))
        except Exception as exc:
            raise ToolExecutionError(
                "tool_secret_scan_failed", "Secret scanning failed closed."
            ) from exc
        if findings:
            raise ToolExecutionError(
                "tool_secret_detected", "Secret-shaped values are not executable."
            )

    def _audit(
        self,
        plan: ExecutionPlan,
        *,
        grant: ExecutionGrant | None,
        backend: str | None,
        outcome: str,
        started_at: int,
        error_code: str | None = None,
        redact_all_strings: bool = False,
    ) -> None:
        if self.audit_log is None:
            return
        args_hash = hashlib.sha256(
            canonical_json_bytes(cast(JsonValue, dict(plan.normalized_args)))
        ).hexdigest()
        target_hash = hashlib.sha256(
            canonical_json_bytes(cast(JsonValue, dict(plan.target)))
        ).hexdigest()
        record = AuditRecord(
            artifact_id=plan.artifact_id,
            content_hash=plan.content_hash,
            plan_hash=plan.plan_hash,
            args_hash=args_hash,
            target_hash=target_hash,
            redacted_args=cast(
                Mapping[str, JsonValue],
                redact_audit_value(
                    cast(JsonValue, dict(plan.normalized_args)),
                    all_strings=redact_all_strings,
                ),
            ),
            redacted_target=cast(
                Mapping[str, JsonValue],
                redact_audit_value(
                    cast(JsonValue, dict(plan.target)),
                    all_strings=redact_all_strings,
                ),
            ),
            grant_id=grant.grant_id if grant else None,
            grant_scope=grant.scope if grant else None,
            backend=backend,
            outcome=outcome,
            started_at=started_at,
            finished_at=self._now(),
            error_code=error_code,
        )
        self.audit_log.append(record)

    def _assert_current(self, original: ExecutionPlan) -> tuple[ToolArtifact, _Analysis]:
        artifact, current, analysis = self._build_plan(
            original.artifact_id,
            original.operation,
            original.normalized_args,
            original.target,
            expires_at=original.expires_at,
        )
        if (
            current.plan_hash != original.plan_hash
            or current.content_hash != original.content_hash
            or current.dependency_hashes != original.dependency_hashes
        ):
            self.prepared_plans.revoke_artifact(original.artifact_id)
            self.grants.revoke_artifact(original.artifact_id)
            raise ToolExecutionError(
                "tool_plan_stale", "Artifact or dependency changed after planning."
            )
        return artifact, analysis

    def _backend(self) -> Any:
        candidate = self.backend_factory
        if callable(candidate) and not hasattr(candidate, "exec"):
            candidate = candidate()
        if candidate is None or not hasattr(candidate, "exec"):
            raise ToolExecutionError("tool_backend_unavailable", "Backend is unavailable.")
        return candidate

    @staticmethod
    def _parse_backend_result(raw: Any) -> Mapping[str, JsonValue]:
        if isinstance(raw, Mapping):
            return cast(Mapping[str, JsonValue], _canonical_map(raw, label="backend result"))
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return {"ok": True, "result": raw}
            if isinstance(parsed, Mapping):
                return cast(Mapping[str, JsonValue], _canonical_map(parsed, label="backend result"))
            return {"ok": True, "result": cast(JsonValue, parsed)}
        return {"ok": True, "result": cast(JsonValue, _canonical_value(raw, label="backend result"))}

    async def _execute_backend_jsx(
        self,
        plan: ExecutionPlan,
        rendered: str,
        *,
        undo_group: str,
    ) -> tuple[Mapping[str, JsonValue], str]:
        self._assert_current(plan)
        backend = self._backend()
        backend_name = str(getattr(backend, "name", backend.__class__.__name__))
        self._assert_current(plan)
        try:
            raw = await backend.exec(
                code=with_prelude(rendered),
                undo_group=undo_group,
                timeout_sec=60.0,
            )
        except asyncio.TimeoutError as exc:
            raise _BackendExecutionError(
                "tool_backend_timeout", "Tool execution timed out.", backend_name
            ) from exc
        except Exception as exc:
            raise _BackendExecutionError(
                "tool_backend_failed", "Tool backend execution failed.", backend_name
            ) from exc
        return self._parse_backend_result(raw), backend_name

    def _expression_jsx(self, expression: str, target: Mapping[str, JsonValue]) -> str:
        template = Template(
            (_TEMPLATES_DIR / "apply_expression.jsx").read_text(encoding="utf-8")
        )
        comp_id = target["compId"]
        comp_expr = (
            f"AEMCP.compById({int(cast(str, comp_id))})"
            if comp_id is not None
            else "AEMCP.activeComp()"
        )
        return template.substitute(
            comp_expr=comp_expr,
            layer_id=int(cast(int, target["layerId"])),
            path=json.dumps(target["path"], ensure_ascii=False),
            expression=json.dumps(expression, ensure_ascii=False),
        )

    async def _execute_node(
        self,
        artifact: ToolArtifact,
        operation: ArtifactOperation,
        args: Mapping[str, JsonValue],
        target: Mapping[str, JsonValue],
        *,
        ctx: Any,
        root_plan: ExecutionPlan,
    ) -> tuple[Mapping[str, JsonValue], str | None]:
        normalized_args = normalize_args(artifact.args_schema, args)
        normalized_target = normalize_target(artifact.kind, operation, target)
        self._scan_json("tool-args.json", normalized_args)
        self._scan_json("tool-target.json", normalized_target)

        if operation == "render":
            if artifact.kind in {"jsx", "expression", "prompt-skill"}:
                rendered = _render_text(artifact, normalized_args)
                if artifact.kind == "prompt-skill":
                    return {
                        "ok": True,
                        "artifactId": artifact.id,
                        "contentHash": artifact.content_hash,
                        "trust": "user-untrusted",
                        "untrustedContext": {
                            "kind": artifact.kind,
                            "content": rendered,
                        },
                    }, None
                return {
                    "ok": True,
                    "artifactId": artifact.id,
                    "contentHash": artifact.content_hash,
                    "trust": "user-untrusted",
                    "rendered": rendered,
                }, None
            return {
                "ok": True,
                "artifactId": artifact.id,
                "contentHash": artifact.content_hash,
                "trust": "user-untrusted",
                "untrustedContext": {
                    "kind": artifact.kind,
                    "content": cast(JsonValue, artifact.content),
                },
            }, None
        if artifact.kind in {"jsx", "expression"}:
            rendered = _render_text(artifact, normalized_args)
            self._scan_text("tool-rendered.txt", rendered)
            jsx = (
                rendered
                if artifact.kind == "jsx"
                else self._expression_jsx(rendered, normalized_target)
            )
            return await self._execute_backend_jsx(
                root_plan,
                jsx,
                undo_group=f"Tool Library: {artifact.name}",
            )
        if artifact.kind == "diagnostic":
            content = cast(Mapping[str, JsonValue], artifact.content)
            capability = cast(str, content["capability"])
            if capability not in DIAGNOSTIC_CAPABILITIES:
                raise ToolExecutionError(
                    "tool_diagnostic_forbidden", "Diagnostic capability is not allowed."
                )
            context = {**normalized_args, **normalized_target}
            handler_args = _canonical_map(
                _substitute_json(cast(JsonValue, content["args"]), context),
                label="diagnostic args",
            )
            schema, run, _normalized, _risk, _digest = _handler_contract(
                capability, handler_args
            )
            self._assert_current(root_plan)
            result = await run(schema.model_validate(handler_args), ctx)
            return cast(Mapping[str, JsonValue], _canonical_map(result, label="diagnostic result")), None

        context = {**normalized_args, **normalized_target}
        results: list[JsonValue] = []
        backend_name: str | None = None
        content = cast(Mapping[str, Any], artifact.content)
        for step in content["steps"]:
            step_args = _canonical_map(
                _substitute_json(cast(JsonValue, step["args"]), context),
                label="recipe step args",
            )
            step_target = _canonical_map(
                _substitute_json(cast(JsonValue, step["target"]), context),
                label="recipe step target",
            )
            if step["refType"] == "artifact":
                child = self._get_artifact(step["ref"])
                child_result, child_backend = await self._execute_node(
                    child,
                    cast(ArtifactOperation, step["operation"]),
                    step_args,
                    step_target,
                    ctx=ctx,
                    root_plan=root_plan,
                )
                results.append(cast(JsonValue, dict(child_result)))
                backend_name = child_backend or backend_name
            else:
                name = cast(str, step["ref"])
                schema, run, normalized, _risk, _digest = _handler_contract(name, step_args)
                self._scan_json("tool-step-args.json", normalized)
                self._assert_current(root_plan)
                result = await run(schema.model_validate(normalized), ctx)
                results.append(cast(JsonValue, _canonical_value(result, label="recipe result")))
        return {"ok": True, "results": results}, backend_name

    async def execute(
        self, plan_hash: str, grant_id: str, *, ctx: Any
    ) -> Mapping[str, JsonValue]:
        plan = self.prepared_plans.get(plan_hash)
        started_at = self._now()
        grant: ExecutionGrant | None = None
        backend_name: str | None = None
        try:
            artifact, _analysis = self._assert_current(plan)
            grant = self.grants.consume(grant_id, plan)
            result, backend_name = await self._execute_node(
                artifact,
                plan.operation,
                plan.normalized_args,
                plan.target,
                ctx=ctx,
                root_plan=plan,
            )
        except asyncio.TimeoutError as exc:
            self._audit(
                plan,
                grant=grant,
                backend=backend_name,
                outcome="timeout",
                started_at=started_at,
                error_code="tool_backend_timeout",
            )
            raise ToolExecutionError(
                "tool_backend_timeout", "Tool execution timed out."
            ) from exc
        except ToolExecutionError as exc:
            backend_name = cast(
                str | None, getattr(exc, "backend_name", backend_name)
            )
            if exc.code == "tool_backend_timeout":
                outcome = "timeout"
            elif exc.code == "tool_backend_failed":
                outcome = "backend-error"
            elif exc.code.startswith("tool_secret"):
                outcome = "denied"
            else:
                outcome = "failed"
            self._audit(
                plan,
                grant=grant,
                backend=backend_name,
                outcome=outcome,
                started_at=started_at,
                error_code=exc.code,
                redact_all_strings=exc.code.startswith("tool_secret"),
            )
            raise
        except Exception as exc:
            self._audit(
                plan,
                grant=grant,
                backend=backend_name,
                outcome="backend-error",
                started_at=started_at,
                error_code="tool_backend_failed",
            )
            raise ToolExecutionError(
                "tool_backend_failed", "Tool backend execution failed."
            ) from exc
        self._audit(
            plan,
            grant=grant,
            backend=backend_name,
            outcome="success",
            started_at=started_at,
        )
        return result

    async def execute_legacy_skill(
        self,
        record: Any,
        *,
        args: Mapping[str, JsonValue],
        ctx: Any,
    ) -> Mapping[str, JsonValue]:
        from ae_mcp.skill_store import (
            Skill,
            SkillRecord,
            render_skill,
            skill_content_hash,
        )
        from ae_mcp.tool_artifact import (
            builtin_artifact_id,
            legacy_artifact_id,
        )

        if not isinstance(record, SkillRecord) or record.skill.template_type != "jsx":
            raise ToolExecutionError(
                "tool_legacy_invalid", "Only legacy JSX skills can execute."
            )
        artifact_id = (
            builtin_artifact_id(record.skill.name)
            if record.source == "bundled"
            else legacy_artifact_id(record.path)
        )
        artifact = self._get_artifact(artifact_id)
        record_content_hash = skill_content_hash(record.skill)
        if artifact.kind != "jsx" or artifact.content_hash != record_content_hash:
            raise ToolExecutionError(
                "tool_plan_stale", "Legacy skill changed before planning."
            )
        normalized_args = normalize_args(artifact.args_schema, args)
        rendered = render_skill(record.skill, normalized_args)
        content_hash = artifact.content_hash
        risk = analyze_artifact_risk(
            artifact,
            "execute",
            rendered=rendered,
        )
        plan_hash = compute_plan_hash(
            artifact_id,
            content_hash,
            "execute",
            normalized_args,
            {},
            (),
            risk,
        )
        plan = ExecutionPlan(
            artifact_id=artifact_id,
            content_hash=content_hash,
            operation="execute",
            normalized_args=normalized_args,
            target={},
            dependency_hashes=(),
            plan_hash=plan_hash,
            risk=risk,
            expires_at=self._now() + PLAN_TTL_MS,
        )
        self.prepared_plans.put(plan)
        grant = await self.request_grant(
            plan.plan_hash, requested_scope="once", ctx=ctx
        )
        started_at = self._now()
        backend_name: str | None = None

        def current_legacy_skill() -> tuple[Skill, str]:
            fresh_data = json.loads(record.path.read_text(encoding="utf-8"))
            fresh = Skill.from_dict(fresh_data)
            fresh_rendered = render_skill(fresh, normalized_args)
            current_artifact = self._get_artifact(artifact_id)
            current_risk = analyze_artifact_risk(
                current_artifact,
                "execute",
                rendered=fresh_rendered,
            )
            if (
                fresh.name != record.skill.name
                or current_artifact.kind != "jsx"
                or skill_content_hash(fresh) != content_hash
                or current_artifact.content_hash != content_hash
                or current_risk != risk
            ):
                raise ToolExecutionError(
                    "tool_plan_stale", "Legacy skill changed after planning."
                )
            return fresh, fresh_rendered

        try:
            fresh, fresh_rendered = current_legacy_skill()
            self._scan_json("legacy-tool-args.json", normalized_args)
            self._scan_text("legacy-tool-rendered.txt", fresh_rendered)
            consumed = self.grants.consume(grant.grant_id, plan)
            backend = self._backend()
            backend_name = str(getattr(backend, "name", backend.__class__.__name__))
            fresh, fresh_rendered = current_legacy_skill()
            raw = await backend.exec(
                code=with_prelude(fresh_rendered),
                undo_group=f"Tool Library: {fresh.name}",
                timeout_sec=60.0,
            )
            parsed = self._parse_backend_result(raw)
        except asyncio.TimeoutError as exc:
            self._audit(
                plan,
                grant=grant,
                backend=backend_name,
                outcome="timeout",
                started_at=started_at,
                error_code="tool_backend_timeout",
            )
            raise ToolExecutionError(
                "tool_backend_timeout", "Legacy tool execution timed out."
            ) from exc
        except ToolExecutionError as exc:
            self._audit(
                plan,
                grant=grant,
                backend=backend_name,
                outcome="denied" if exc.code.startswith("tool_secret") else "failed",
                started_at=started_at,
                error_code=exc.code,
                redact_all_strings=exc.code.startswith("tool_secret"),
            )
            raise
        except Exception as exc:
            self._audit(
                plan,
                grant=grant,
                backend=backend_name,
                outcome="backend-error",
                started_at=started_at,
                error_code="tool_backend_failed",
            )
            raise ToolExecutionError(
                "tool_backend_failed", "Legacy tool backend execution failed."
            ) from exc
        self._audit(
            plan,
            grant=consumed,
            backend=backend_name,
            outcome="success",
            started_at=started_at,
        )
        return {
            "ok": True,
            "name": record.skill.name,
            "template_type": record.skill.template_type,
            "result": cast(JsonValue, dict(parsed)),
        }


__all__ = [
    "DIAGNOSTIC_CAPABILITIES",
    "ExecutionGrant",
    "ExecutionPlan",
    "GRANT_TTL_MS",
    "GrantStore",
    "PLAN_TTL_MS",
    "PreparedPlanStore",
    "ToolExecutionError",
    "ToolExecutionEngine",
    "analyze_artifact_risk",
    "analyze_jsx",
    "compute_plan_hash",
    "normalize_args",
    "normalize_target",
]
