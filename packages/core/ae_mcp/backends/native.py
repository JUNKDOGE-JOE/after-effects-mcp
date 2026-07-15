"""Typed Core contract for native After Effects capabilities.

This module deliberately contains no backend discovery and no AEGP/JSX
resolver.  A caller chooses one explicit native implementation, negotiates its
contract, and invokes it.  Legacy ExtendScript remains behind
``LegacyExtendScriptBackend`` in ``base.py``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from abc import ABC, abstractmethod
from typing import Annotated, Any, Callable, Literal, Mapping, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    ValidationError,
    model_validator,
)

from ae_mcp.backends.base import BackendError, ExecutionEngine


NativeSideEffect: TypeAlias = Literal[
    "not-started", "may-have-occurred", "completed"
]
NativeRecoveryAction: TypeAlias = Literal[
    "retry",
    "refresh-capabilities",
    "refresh-locator",
    "reconnect",
    "open-project",
    "change-arguments",
    "inspect-state",
    "approve-pairing",
    "retry-pairing",
    "refresh-auth",
    "review-client-access",
    "resume-actions",
    "none",
]
NativeWireErrorCode: TypeAlias = Literal[
    "NATIVE_UNAVAILABLE",
    "NATIVE_UNSUPPORTED",
    "WIRE_VERSION_MISMATCH",
    "INVALID_REQUEST",
    "INVALID_ARGUMENT",
    "DUPLICATE_REQUEST",
    "PRECONDITION_FAILED",
    "STALE_LOCATOR",
    "DEADLINE_EXCEEDED",
    "CANCELLED",
    "QUEUE_FULL",
    "AE_SHUTTING_DOWN",
    "SESSION_STALE",
    "CAPABILITY_FAILED",
    "POSSIBLY_SIDE_EFFECTING_FAILURE",
]
NativeBrokerErrorCode: TypeAlias = Literal[
    "NATIVE_PAIRING_REQUIRED",
    "NATIVE_PAIRING_REJECTED",
    "NATIVE_BROKER_UNAUTHORIZED",
    "NATIVE_CLIENT_BLOCKED",
    "NATIVE_ACTIONS_PAUSED",
]
NativeErrorCode: TypeAlias = NativeWireErrorCode | NativeBrokerErrorCode | Literal[
    "NATIVE_CONTRACT_MISMATCH",
]
NativePlatform: TypeAlias = Literal["macos-arm64", "windows-x64"]
CapabilityDetail: TypeAlias = Literal["full"]

_CAPABILITY_ID = r"^ae(?:\.[a-z][a-z0-9_-]*)+$"
_CONTRACT_ID = r"^aemcp\.contract(?:\.[a-z][a-z0-9_-]*)+\.v[1-9][0-9]*$"
_REQUIREMENT_ID = r"^aemcp\.requirement(?:\.[a-z][a-z0-9_-]*)+$"
_REQUEST_ID = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
_SHA256 = r"^[0-9a-f]{64}$"
_SOURCE_COMMIT = r"^[0-9a-f]{40}$"
_SAFE_MAX = 9_007_199_254_740_991

CapabilityId = Annotated[
    StrictStr, Field(min_length=3, max_length=96, pattern=_CAPABILITY_ID)
]
ContractId = Annotated[
    StrictStr, Field(min_length=8, max_length=128, pattern=_CONTRACT_ID)
]
RequirementId = Annotated[
    StrictStr, Field(min_length=8, max_length=128, pattern=_REQUIREMENT_ID)
]
RequestId = Annotated[
    StrictStr, Field(min_length=1, max_length=64, pattern=_REQUEST_ID)
]
Uuid = Annotated[StrictStr, Field(pattern=_UUID)]
Sha256 = Annotated[StrictStr, Field(pattern=_SHA256)]
SourceCommit = Annotated[StrictStr, Field(pattern=_SOURCE_COMMIT)]
PositiveInt = Annotated[StrictInt, Field(ge=1, le=_SAFE_MAX)]
NonNegativeInt = Annotated[StrictInt, Field(ge=0, le=_SAFE_MAX)]


def _camel(name: str) -> str:
    first, *rest = name.split("_")
    return first + "".join(part.capitalize() for part in rest)


def _validate_json(value: Any, *, depth: int = 0) -> None:
    if depth > 16:
        raise ValueError("native JSON exceeds the maximum nesting depth")
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) <= _SAFE_MAX:
            return
        raise ValueError("native JSON integer exceeds the safe range")
    if isinstance(value, float):
        raise ValueError("native Core contracts do not accept floating-point JSON")
    if isinstance(value, list):
        for item in value:
            _validate_json(item, depth=depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("native JSON object keys must be strings")
            _validate_json(item, depth=depth + 1)
        return
    raise ValueError(f"native value is not JSON: {type(value).__name__}")


class _NativeModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class NativeCompatibility(_NativeModel):
    status: Literal["unverified", "verified"]
    intended_platforms: tuple[NativePlatform, ...] = Field(
        min_length=1, max_length=2
    )
    minimum_host_major: StrictInt | None = Field(default=None, ge=1)
    maximum_host_major: StrictInt | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _valid_range(self) -> "NativeCompatibility":
        if len(set(self.intended_platforms)) != len(self.intended_platforms):
            raise ValueError("native compatibility platforms must be unique")
        if self.status == "unverified":
            if self.minimum_host_major is not None or self.maximum_host_major is not None:
                raise ValueError("unverified compatibility cannot claim a host range")
            return self
        if self.minimum_host_major is None or self.maximum_host_major is None:
            raise ValueError("verified compatibility requires a complete host range")
        if self.minimum_host_major > self.maximum_host_major:
            raise ValueError("native compatibility host range is reversed")
        return self


class NativeRequirement(_NativeModel):
    id: RequirementId
    contract_version: Annotated[StrictInt, Field(ge=1, le=65_535)]


class NativeCapabilityDescriptor(_NativeModel):
    """A full negotiated capability descriptor plus its Core engine label."""

    detail: Literal["full"]
    capability_id: CapabilityId = Field(alias="id")
    capability_version: PositiveInt = Field(alias="version")
    schema_version: PositiveInt
    summary: Annotated[StrictStr, Field(min_length=1, max_length=160)]
    risk: Literal["read", "write"]
    mutability: Literal["read-only", "mutating"]
    idempotency: Literal["idempotent", "idempotency-key", "non-idempotent"]
    cancellation: Literal["before-dispatch", "cooperative", "none"]
    undo: Literal[
        "not-applicable", "ae-undo-group", "checkpoint-required", "none"
    ]
    side_effect_summary: Annotated[
        StrictStr, Field(min_length=1, max_length=160)
    ]
    preconditions: tuple[
        Annotated[StrictStr, Field(min_length=1, max_length=96)], ...
    ] = Field(max_length=16)
    compatibility: NativeCompatibility
    input_contract_id: ContractId
    result_contract_id: ContractId
    contract_digest: Sha256
    input_schema: dict[str, Any]
    result_schema: dict[str, Any]
    requirements: tuple[NativeRequirement, ...] = Field(min_length=1, max_length=32)
    examples: tuple[dict[str, Any], ...] = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def _closed_json_contracts(self) -> "NativeCapabilityDescriptor":
        _validate_json(self.input_schema)
        _validate_json(self.result_schema)
        for example in self.examples:
            _validate_json(example)
        return self

    @property
    def engine(self) -> Literal["native-aegp"]:
        """Core provenance; this is not a field accepted from the wire."""
        return "native-aegp"


class NativeNegotiation(_NativeModel):
    selected_wire_version: Literal[1]
    plugin_version: Annotated[StrictStr, Field(min_length=1, max_length=64)]
    compiled_sdk_version: Annotated[StrictStr, Field(min_length=1, max_length=64)]
    source_commit: SourceCommit
    host_instance_id: Uuid
    host_platform: NativePlatform
    session_id: Uuid
    session_generation: PositiveInt
    capabilities_digest: Sha256


class NativeCapabilities(_NativeModel):
    session_id: Uuid
    detail: Literal["full"]
    items: tuple[NativeCapabilityDescriptor, ...] = Field(max_length=100)
    next_cursor: None
    query_digest: Sha256
    capabilities_digest: Sha256

    @model_validator(mode="after")
    def _unique_capabilities(self) -> "NativeCapabilities":
        identities = [
            (item.capability_id, item.capability_version) for item in self.items
        ]
        if len(set(identities)) != len(identities):
            raise ValueError("native capabilities must have unique identities")
        return self


class NativeInvokeRequest(_NativeModel):
    request_id: RequestId
    capability_id: CapabilityId
    capability_version: PositiveInt
    arguments: dict[str, Any]
    deadline_unix_ms: PositiveInt

    @model_validator(mode="after")
    def _closed_arguments(self) -> "NativeInvokeRequest":
        _validate_json(self.arguments)
        return self


class NativePostconditionEvidence(_NativeModel):
    verified: Literal[True]
    kind: Annotated[
        StrictStr,
        Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_-]*$"),
    ]
    algorithm: Literal["sha256-rfc8785-jcs-v1"]
    digest: Sha256


class NativeUndoEvidence(_NativeModel):
    available: StrictBool
    verified: StrictBool
    group_id: Annotated[StrictStr, Field(min_length=1, max_length=128)] | None = None


class NativeExecutionEvidence(_NativeModel):
    engine: Literal["native-aegp"]
    host_instance_id: Uuid
    session_id: Uuid
    request_id: RequestId
    capability_id: CapabilityId
    capability_version: PositiveInt
    started_at_unix_ms: PositiveInt
    completed_at_unix_ms: PositiveInt
    effect: Literal["none", "committed"]
    request_digest: Sha256
    postcondition: NativePostconditionEvidence
    undo: NativeUndoEvidence | None = None

    @model_validator(mode="after")
    def _ordered_times(self) -> "NativeExecutionEvidence":
        if self.completed_at_unix_ms < self.started_at_unix_ms:
            raise ValueError("native completion time precedes its start")
        return self


class NativeInvokeResult(_NativeModel):
    capability_id: CapabilityId
    capability_version: PositiveInt
    engine: Literal["native-aegp"]
    outcome: Literal["succeeded"]
    replayed: StrictBool
    value: dict[str, Any]
    evidence: NativeExecutionEvidence

    @model_validator(mode="after")
    def _matching_evidence(self) -> "NativeInvokeResult":
        _validate_json(self.value)
        if (
            self.evidence.engine != self.engine
            or self.evidence.capability_id != self.capability_id
            or self.evidence.capability_version != self.capability_version
        ):
            raise ValueError("native result evidence does not match its result")
        return self


class NativeCancelResult(_NativeModel):
    target_request_id: RequestId
    state: Literal[
        "queued-cancelled",
        "running-cancel-requested",
        "running-not-cancellable",
        "already-terminal",
        "not-found",
    ]
    terminal_response_expected: StrictBool

    @model_validator(mode="after")
    def _terminal_expectation_matches_state(self) -> "NativeCancelResult":
        expected = self.state in {
            "queued-cancelled",
            "running-cancel-requested",
            "running-not-cancellable",
        }
        if self.terminal_response_expected is not expected:
            raise ValueError("native cancel terminal expectation is invalid")
        return self


class NativeRecovery(_NativeModel):
    action: NativeRecoveryAction
    hint: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    retry_after_ms: Annotated[StrictInt, Field(ge=1, le=30_000)] | None = None


class NativeWireRange(_NativeModel):
    minimum: Annotated[StrictInt, Field(ge=1, le=65_535)]
    maximum: Annotated[StrictInt, Field(ge=1, le=65_535)]

    @model_validator(mode="after")
    def _ordered(self) -> "NativeWireRange":
        if self.minimum > self.maximum:
            raise ValueError("native wire range is reversed")
        return self


class NativeErrorDetails(_NativeModel):
    field: Annotated[StrictStr, Field(min_length=1, max_length=128)] | None = None
    capability_id: CapabilityId | None = None
    supported_wire_versions: NativeWireRange | None = None
    current_generation: PositiveInt | None = None
    pairing_fingerprint: Annotated[
        StrictStr,
        Field(pattern=r"^[0-9A-F]{4}(?:-[0-9A-F]{4})+$"),
    ] | None = None
    pairing_expires_in_ms: PositiveInt | None = None
    host_instance_id: Uuid | None = None
    source_commit: SourceCommit | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_explicit_nulls(cls, value: Any) -> Any:
        if isinstance(value, Mapping) and any(item is None for item in value.values()):
            raise ValueError("native error detail fields cannot be null")
        return value


_ERROR_POLICY: dict[
    NativeErrorCode,
    tuple[bool, NativeSideEffect, NativeRecoveryAction],
] = {
    "NATIVE_UNAVAILABLE": (True, "not-started", "reconnect"),
    "NATIVE_UNSUPPORTED": (False, "not-started", "refresh-capabilities"),
    "NATIVE_CONTRACT_MISMATCH": (False, "not-started", "refresh-capabilities"),
    "NATIVE_PAIRING_REQUIRED": (True, "not-started", "approve-pairing"),
    "NATIVE_PAIRING_REJECTED": (True, "not-started", "retry-pairing"),
    "NATIVE_BROKER_UNAUTHORIZED": (False, "not-started", "refresh-auth"),
    "NATIVE_CLIENT_BLOCKED": (False, "not-started", "review-client-access"),
    "NATIVE_ACTIONS_PAUSED": (True, "not-started", "resume-actions"),
    "WIRE_VERSION_MISMATCH": (False, "not-started", "reconnect"),
    "INVALID_REQUEST": (False, "not-started", "none"),
    "INVALID_ARGUMENT": (False, "not-started", "change-arguments"),
    "DUPLICATE_REQUEST": (False, "not-started", "inspect-state"),
    "PRECONDITION_FAILED": (False, "not-started", "open-project"),
    "STALE_LOCATOR": (True, "not-started", "refresh-locator"),
    "DEADLINE_EXCEEDED": (True, "not-started", "retry"),
    "CANCELLED": (False, "not-started", "none"),
    "QUEUE_FULL": (True, "not-started", "retry"),
    "AE_SHUTTING_DOWN": (True, "not-started", "reconnect"),
    "SESSION_STALE": (True, "not-started", "reconnect"),
    "CAPABILITY_FAILED": (False, "not-started", "inspect-state"),
    "POSSIBLY_SIDE_EFFECTING_FAILURE": (
        False,
        "may-have-occurred",
        "inspect-state",
    ),
}
_CAPABILITY_DETAIL_ERROR_CODES = {
    "NATIVE_UNSUPPORTED",
    "PRECONDITION_FAILED",
    "STALE_LOCATOR",
    "CAPABILITY_FAILED",
    "POSSIBLY_SIDE_EFFECTING_FAILURE",
}


class NativeErrorPayload(_NativeModel):
    code: NativeErrorCode
    message: Annotated[StrictStr, Field(min_length=1, max_length=512)]
    retryable: StrictBool
    side_effect: NativeSideEffect
    recovery: NativeRecovery
    details: NativeErrorDetails | None = None

    @model_validator(mode="after")
    def _policy_matches_code(self) -> "NativeErrorPayload":
        expected = _ERROR_POLICY[self.code]
        actual = (self.retryable, self.side_effect, self.recovery.action)
        if actual != expected:
            raise ValueError("native error policy does not match its code")
        if self.code == "QUEUE_FULL":
            if self.recovery.retry_after_ms is None:
                raise ValueError("QUEUE_FULL requires retryAfterMs")
        elif self.recovery.retry_after_ms is not None:
            raise ValueError("retryAfterMs is only valid for QUEUE_FULL")
        pairing_values = (
            self.details.pairing_fingerprint,
            self.details.pairing_expires_in_ms,
            self.details.host_instance_id,
            self.details.source_commit,
        ) if self.details is not None else (None, None, None, None)
        if self.code == "NATIVE_PAIRING_REQUIRED":
            if any(value is None for value in pairing_values):
                raise ValueError(
                    "NATIVE_PAIRING_REQUIRED requires complete pairing details"
                )
        elif any(value is not None for value in pairing_values):
            raise ValueError("pairing details require NATIVE_PAIRING_REQUIRED")
        if self.details is not None:
            _validate_json(
                self.details.model_dump(
                    mode="json",
                    by_alias=True,
                    exclude_none=True,
                )
            )
        return self


class NativeBackendError(BackendError):
    """Structured native failure; fields are safe to propagate without guessing."""

    def __init__(
        self,
        payload_or_code: NativeErrorPayload | NativeErrorCode,
        message: str | None = None,
        *,
        retryable: bool | None = None,
        side_effect: NativeSideEffect | None = None,
        recovery: NativeRecovery | Mapping[str, Any] | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        if isinstance(payload_or_code, NativeErrorPayload):
            payload = payload_or_code
        else:
            if message is None or retryable is None or side_effect is None or recovery is None:
                raise TypeError("structured native errors require every policy field")
            payload = NativeErrorPayload(
                code=payload_or_code,
                message=message,
                retryable=retryable,
                side_effect=side_effect,
                recovery=recovery,
                details=dict(details) if details is not None else None,
            )
        self.payload = payload
        self.code = payload.code
        self.retryable = payload.retryable
        self.side_effect = payload.side_effect
        self.recovery = payload.recovery
        self.details = (
            payload.details.model_dump(
                mode="json",
                by_alias=True,
                exclude_none=True,
            )
            if payload.details is not None
            else None
        )
        super().__init__(payload.message)

    @classmethod
    def from_payload(cls, value: Mapping[str, Any]) -> "NativeBackendError":
        try:
            raw = dict(value)
            if raw.get("code") in {
                "NATIVE_CONTRACT_MISMATCH",
                "NATIVE_PAIRING_REQUIRED",
                "NATIVE_PAIRING_REJECTED",
                "NATIVE_BROKER_UNAUTHORIZED",
                "NATIVE_CLIENT_BLOCKED",
                "NATIVE_ACTIONS_PAUSED",
            }:
                raise ValueError("Core-only error code appeared on the native wire")
            if "details" in raw and raw["details"] is None:
                raise ValueError("native wire error details cannot be null")
            payload = NativeErrorPayload.model_validate(raw)
            if payload.code == "WIRE_VERSION_MISMATCH":
                if (
                    payload.details is None
                    or payload.details.supported_wire_versions is None
                ):
                    raise ValueError(
                        "WIRE_VERSION_MISMATCH requires supportedWireVersions"
                    )
            elif payload.code in _CAPABILITY_DETAIL_ERROR_CODES:
                if payload.details is None or payload.details.capability_id is None:
                    raise ValueError(
                        f"{payload.code} requires a capabilityId detail"
                    )
            elif payload.code == "NATIVE_PAIRING_REQUIRED":
                if payload.details is None:
                    raise ValueError(
                        "NATIVE_PAIRING_REQUIRED requires pairing details"
                    )
        except (TypeError, ValueError, ValidationError) as exc:
            raise cls(
                "NATIVE_CONTRACT_MISMATCH",
                "Native error payload did not match the negotiated wire contract.",
                retryable=False,
                side_effect="not-started",
                recovery=NativeRecovery(
                    action="refresh-capabilities",
                    hint="Refresh negotiated native capabilities before retrying.",
                ),
            ) from exc
        return cls(payload)

    def public_dict(self) -> dict[str, Any]:
        return self.payload.model_dump(mode="json", by_alias=True, exclude_none=True)


class NativeCancellationToken:
    """In-process cancellation signal forwarded to a native transport."""

    def __init__(self) -> None:
        self._event = asyncio.Event()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()

    async def wait(self) -> None:
        await self._event.wait()


class NativeInvokeBackend(ABC):
    """Validated native transport contract, intentionally unrelated to JSX.

    Implementations own framing, authentication, outer-envelope validation,
    and conversion of malformed wire data into ``NativeBackendError``.  Models
    returned here are the validated Core projection, never unchecked JSON.
    """

    name: str

    @abstractmethod
    async def negotiate(
        self,
        *,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeNegotiation:
        """Negotiate one authenticated native session."""

    @abstractmethod
    async def capabilities(
        self,
        *,
        ids: tuple[str, ...] | None,
        detail: CapabilityDetail,
        limit: int,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeCapabilities:
        """Return session-bound descriptors; ``ids=None`` requests the registry."""

    @abstractmethod
    async def invoke(
        self,
        request: NativeInvokeRequest,
        *,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeInvokeResult:
        """Invoke one typed native capability; raw source text is impossible."""

    async def cancel(
        self,
        target_request_id: str,
        *,
        deadline_unix_ms: int,
    ) -> NativeCancelResult:
        """Cancel when supported; the default fails explicitly before dispatch."""
        del target_request_id, deadline_unix_ms
        raise NativeBackendError(
            "NATIVE_UNSUPPORTED",
            "This native transport does not expose cancellation.",
            retryable=False,
            side_effect="not-started",
            recovery=NativeRecovery(
                action="refresh-capabilities",
                hint="Inspect the negotiated cancellation contract before retrying.",
            ),
        )


PROJECT_SUMMARY_CAPABILITY_ID = "ae.project.summary"
PROJECT_SUMMARY_CAPABILITY_VERSION = 1
PROJECT_SUMMARY_INPUT_CONTRACT_ID = "aemcp.contract.ae.project.summary.input.v1"
PROJECT_SUMMARY_RESULT_CONTRACT_ID = "aemcp.contract.ae.project.summary.result.v1"
PROJECT_SUMMARY_CONTRACT_DIGEST = (
    "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a"
)
_PROJECT_SUMMARY_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [],
    "properties": {},
}
_PROJECT_SUMMARY_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["projectOpen", "projectName", "itemCount"],
    "properties": {
        "projectOpen": {"type": "boolean"},
        "projectName": {"type": "string", "maxLength": 1024},
        "itemCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": _SAFE_MAX,
        },
    },
}


class ProjectSummaryValue(_NativeModel):
    project_open: StrictBool
    project_name: Annotated[StrictStr, Field(max_length=1024)]
    item_count: NonNegativeInt


class ProjectSummaryExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: ProjectSummaryValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    @property
    def project_open(self) -> bool:
        return self.value.project_open

    @property
    def project_name(self) -> str:
        return self.value.project_name

    @property
    def item_count(self) -> int:
        return self.value.item_count

    def audit_fields(self) -> dict[str, Any]:
        """Bounded native fields for a future broker audit record."""
        return {
            "engine": self.engine,
            "capabilityId": self.evidence.capability_id,
            "capabilityVersion": self.evidence.capability_version,
            "contractDigest": self.implementation.contract_digest,
            "selectedWireVersion": self.negotiation.selected_wire_version,
            "pluginVersion": self.negotiation.plugin_version,
            "compiledSdkVersion": self.negotiation.compiled_sdk_version,
            "sourceCommit": self.negotiation.source_commit,
            "hostInstanceId": self.evidence.host_instance_id,
            "sessionId": self.evidence.session_id,
            "sessionGeneration": self.negotiation.session_generation,
            "capabilitiesDigest": self.negotiation.capabilities_digest,
            "requestId": self.evidence.request_id,
            "effect": self.evidence.effect,
            "requestDigest": self.evidence.request_digest,
            "postconditionAlgorithm": self.evidence.postcondition.algorithm,
            "postconditionDigest": self.evidence.postcondition.digest,
            "startedAtUnixMs": self.evidence.started_at_unix_ms,
            "completedAtUnixMs": self.evidence.completed_at_unix_ms,
        }


class NativeLocator(_NativeModel):
    """Opaque, session-bound locator issued by the native AEGP host."""

    kind: Literal["project", "item", "composition", "layer", "stream"]
    host_instance_id: Uuid
    session_id: Uuid
    project_id: Uuid
    generation: PositiveInt
    object_id: Uuid

    def context(self) -> tuple[str, str, str, int]:
        return (
            self.host_instance_id,
            self.session_id,
            self.project_id,
            self.generation,
        )


class ProjectItemsListArguments(_NativeModel):
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]
    project_locator: NativeLocator | None = None

    @model_validator(mode="after")
    def _continuation_is_bound(self) -> "ProjectItemsListArguments":
        if self.project_locator is not None and self.project_locator.kind != "project":
            raise ValueError("projectLocator must have kind project")
        if self.offset > 0 and self.project_locator is None:
            raise ValueError("continuation pages require projectLocator")
        return self


class ProjectItem(_NativeModel):
    locator: NativeLocator
    name: Annotated[StrictStr, Field(max_length=1024)]
    type: Literal["folder", "composition", "footage", "unknown"]
    parent_locator: NativeLocator

    @model_validator(mode="after")
    def _locator_kinds_match_type(self) -> "ProjectItem":
        expected_kind = "composition" if self.type == "composition" else "item"
        if self.locator.kind != expected_kind:
            raise ValueError("project item locator kind does not match its type")
        if self.parent_locator.kind not in {"project", "item"}:
            raise ValueError("project item parent must be a project or folder item")
        return self


class ProjectItemsListValue(_NativeModel):
    project_locator: NativeLocator
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]
    returned: Annotated[StrictInt, Field(ge=0, le=50)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    items: tuple[ProjectItem, ...] = Field(max_length=50)

    @model_validator(mode="after")
    def _verified_page(self) -> "ProjectItemsListValue":
        if self.project_locator.kind != "project":
            raise ValueError("projectLocator must have kind project")
        if self.returned != len(self.items) or self.returned > self.limit:
            raise ValueError("project item page count does not match returned")
        consumed = self.offset + self.returned
        if consumed > self.total:
            raise ValueError("project item page exceeds total")
        expected_more = consumed < self.total
        expected_next = consumed if expected_more else None
        if expected_more and self.returned == 0:
            raise ValueError("project item continuation page made no progress")
        if self.has_more is not expected_more or self.next_offset != expected_next:
            raise ValueError("project item continuation metadata is inconsistent")
        context = self.project_locator.context()
        object_ids: set[str] = set()
        for item in self.items:
            if item.locator.context() != context or item.parent_locator.context() != context:
                raise ValueError("project item locator escaped the project context")
            if item.locator.object_id in object_ids:
                raise ValueError("project item page contains duplicate locators")
            if (
                item.parent_locator.kind == "project"
                and item.parent_locator != self.project_locator
            ):
                raise ValueError("root project parent must equal projectLocator")
            object_ids.add(item.locator.object_id)
        return self


class CompositionLayersListArguments(_NativeModel):
    composition_locator: NativeLocator
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]

    @model_validator(mode="after")
    def _composition_kind(self) -> "CompositionLayersListArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        return self


class CompositionLayer(_NativeModel):
    locator: NativeLocator
    stack_index: PositiveInt
    name: Annotated[StrictStr, Field(max_length=1024)]
    type: Literal[
        "av",
        "camera",
        "light",
        "text",
        "shape",
        "model3d",
        "null",
        "adjustment",
        "unknown",
    ]
    video_enabled: StrictBool
    is_three_d: StrictBool
    locked: StrictBool
    parent_locator: NativeLocator | None
    source_item_locator: NativeLocator | None

    @model_validator(mode="after")
    def _locator_kinds(self) -> "CompositionLayer":
        if self.locator.kind != "layer":
            raise ValueError("composition layer locator must have kind layer")
        if self.parent_locator is not None and self.parent_locator.kind != "layer":
            raise ValueError("layer parentLocator must have kind layer")
        if (
            self.source_item_locator is not None
            and self.source_item_locator.kind not in {"item", "composition"}
        ):
            raise ValueError("layer sourceItemLocator must identify a project item")
        return self


class CompositionLayersListValue(_NativeModel):
    composition_locator: NativeLocator
    composition_name: Annotated[StrictStr, Field(max_length=1024)]
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]
    returned: Annotated[StrictInt, Field(ge=0, le=50)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    layers: tuple[CompositionLayer, ...] = Field(max_length=50)

    @model_validator(mode="after")
    def _verified_page(self) -> "CompositionLayersListValue":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        if self.returned != len(self.layers) or self.returned > self.limit:
            raise ValueError("composition layer page count does not match returned")
        consumed = self.offset + self.returned
        if consumed > self.total:
            raise ValueError("composition layer page exceeds total")
        expected_more = consumed < self.total
        expected_next = consumed if expected_more else None
        if expected_more and self.returned == 0:
            raise ValueError("composition layer continuation page made no progress")
        if self.has_more is not expected_more or self.next_offset != expected_next:
            raise ValueError("composition layer continuation metadata is inconsistent")
        context = self.composition_locator.context()
        object_ids: set[str] = set()
        stack_indices: set[int] = set()
        for index, layer in enumerate(self.layers):
            related = (layer.locator, layer.parent_locator, layer.source_item_locator)
            if any(item is not None and item.context() != context for item in related):
                raise ValueError("composition layer locator escaped the project context")
            if layer.locator.object_id in object_ids:
                raise ValueError("composition layer page contains duplicate locators")
            if layer.stack_index in stack_indices:
                raise ValueError("composition layer page contains duplicate stack indices")
            if layer.stack_index != self.offset + index + 1:
                raise ValueError("composition layer stackIndex does not match page order")
            object_ids.add(layer.locator.object_id)
            stack_indices.add(layer.stack_index)
        return self


def _native_read_audit_fields(
    implementation: NativeCapabilityDescriptor,
    negotiation: NativeNegotiation,
    evidence: NativeExecutionEvidence,
) -> dict[str, Any]:
    return {
        "engine": "native-aegp",
        "capabilityId": evidence.capability_id,
        "capabilityVersion": evidence.capability_version,
        "contractDigest": implementation.contract_digest,
        "selectedWireVersion": negotiation.selected_wire_version,
        "pluginVersion": negotiation.plugin_version,
        "compiledSdkVersion": negotiation.compiled_sdk_version,
        "sourceCommit": negotiation.source_commit,
        "hostInstanceId": evidence.host_instance_id,
        "sessionId": evidence.session_id,
        "sessionGeneration": negotiation.session_generation,
        "capabilitiesDigest": negotiation.capabilities_digest,
        "requestId": evidence.request_id,
        "effect": evidence.effect,
        "requestDigest": evidence.request_digest,
        "postconditionAlgorithm": evidence.postcondition.algorithm,
        "postconditionDigest": evidence.postcondition.digest,
        "startedAtUnixMs": evidence.started_at_unix_ms,
        "completedAtUnixMs": evidence.completed_at_unix_ms,
    }


class ProjectItemsListExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: ProjectItemsListValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return _native_read_audit_fields(
            self.implementation, self.negotiation, self.evidence
        )


class CompositionLayersListExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: CompositionLayersListValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return _native_read_audit_fields(
            self.implementation, self.negotiation, self.evidence
        )


PROJECT_ITEMS_LIST_CAPABILITY_ID = "ae.project.items.list"
PROJECT_ITEMS_LIST_CAPABILITY_VERSION = 1
PROJECT_ITEMS_LIST_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.project.items.list.input.v1"
)
PROJECT_ITEMS_LIST_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.project.items.list.result.v1"
)

COMPOSITION_LAYERS_LIST_CAPABILITY_ID = "ae.composition.layers.list"
COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION = 1
COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.layers.list.input.v1"
)
COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.layers.list.result.v1"
)

_PROJECT_ITEMS_LIST_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["offset", "limit"],
    "properties": {
        "projectLocator": {"$ref": "#/$defs/projectLocator"},
        "offset": {
            "type": "integer",
            "minimum": 0,
            "maximum": _SAFE_MAX,
            "default": 0,
            "x-omissionBehavior": 0,
        },
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "default": 25,
            "x-omissionBehavior": 25,
        },
    },
    "allOf": [
        {
            "if": {"properties": {"offset": {"minimum": 1}}},
            "then": {"required": ["projectLocator"]},
        }
    ],
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "projectLocator": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "kind",
                "hostInstanceId",
                "sessionId",
                "projectId",
                "generation",
                "objectId",
            ],
            "properties": {
                "kind": {"const": "project"},
                "hostInstanceId": {"$ref": "#/$defs/uuid"},
                "sessionId": {"$ref": "#/$defs/uuid"},
                "projectId": {"$ref": "#/$defs/uuid"},
                "generation": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _SAFE_MAX,
                },
                "objectId": {"$ref": "#/$defs/uuid"},
            },
        },
    },
    "x-invariant": (
        "offset-greater-than-zero-requires-the-project-locator-from-the-previous-page"
    ),
}
_PROJECT_ITEMS_LIST_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "projectLocator",
        "total",
        "offset",
        "limit",
        "returned",
        "hasMore",
        "nextOffset",
        "items",
    ],
    "properties": {
        "projectLocator": {"$ref": "#/$defs/projectLocator"},
        "total": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "offset": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        "returned": {"type": "integer", "minimum": 0, "maximum": 50},
        "hasMore": {"type": "boolean"},
        "nextOffset": {
            "oneOf": [
                {"type": "null"},
                {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
            ]
        },
        "items": {
            "type": "array",
            "maxItems": 50,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["locator", "name", "type", "parentLocator"],
                "properties": {
                    "locator": {"$ref": "#/$defs/projectItemLocator"},
                    "name": {"type": "string", "maxLength": 1024},
                    "type": {
                        "enum": ["folder", "composition", "footage", "unknown"]
                    },
                    "parentLocator": {"$ref": "#/$defs/projectParentLocator"},
                },
            },
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "locatorBase": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "kind",
                "hostInstanceId",
                "sessionId",
                "projectId",
                "generation",
                "objectId",
            ],
            "properties": {
                "kind": {
                    "enum": ["project", "item", "composition", "layer", "stream"]
                },
                "hostInstanceId": {"$ref": "#/$defs/uuid"},
                "sessionId": {"$ref": "#/$defs/uuid"},
                "projectId": {"$ref": "#/$defs/uuid"},
                "generation": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _SAFE_MAX,
                },
                "objectId": {"$ref": "#/$defs/uuid"},
            },
        },
        "projectLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"const": "project"}}},
            ]
        },
        "projectItemLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"enum": ["item", "composition"]}}},
            ]
        },
        "projectParentLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"enum": ["project", "item"]}}},
            ]
        },
    },
    "x-invariant": "returned-equals-items-length-and-page-metadata-is-self-consistent",
}
_COMPOSITION_LAYERS_LIST_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["compositionLocator", "offset", "limit"],
    "properties": {
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "offset": {
            "type": "integer",
            "minimum": 0,
            "maximum": _SAFE_MAX,
            "default": 0,
            "x-omissionBehavior": 0,
        },
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "default": 25,
            "x-omissionBehavior": 25,
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "compositionLocator": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "kind",
                "hostInstanceId",
                "sessionId",
                "projectId",
                "generation",
                "objectId",
            ],
            "properties": {
                "kind": {"const": "composition"},
                "hostInstanceId": {"$ref": "#/$defs/uuid"},
                "sessionId": {"$ref": "#/$defs/uuid"},
                "projectId": {"$ref": "#/$defs/uuid"},
                "generation": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _SAFE_MAX,
                },
                "objectId": {"$ref": "#/$defs/uuid"},
            },
        },
    },
}
_COMPOSITION_LAYERS_LIST_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "compositionLocator",
        "compositionName",
        "total",
        "offset",
        "limit",
        "returned",
        "hasMore",
        "nextOffset",
        "layers",
    ],
    "properties": {
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "compositionName": {"type": "string", "maxLength": 1024},
        "total": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "offset": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        "returned": {"type": "integer", "minimum": 0, "maximum": 50},
        "hasMore": {"type": "boolean"},
        "nextOffset": {
            "oneOf": [
                {"type": "null"},
                {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
            ]
        },
        "layers": {
            "type": "array",
            "maxItems": 50,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "locator",
                    "stackIndex",
                    "name",
                    "type",
                    "videoEnabled",
                    "isThreeD",
                    "locked",
                    "parentLocator",
                    "sourceItemLocator",
                ],
                "properties": {
                    "locator": {"$ref": "#/$defs/layerLocator"},
                    "stackIndex": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": _SAFE_MAX,
                    },
                    "name": {"type": "string", "maxLength": 1024},
                    "type": {
                        "enum": [
                            "av",
                            "camera",
                            "light",
                            "text",
                            "shape",
                            "model3d",
                            "null",
                            "adjustment",
                            "unknown",
                        ]
                    },
                    "videoEnabled": {"type": "boolean"},
                    "isThreeD": {"type": "boolean"},
                    "locked": {"type": "boolean"},
                    "parentLocator": {
                        "oneOf": [
                            {"type": "null"},
                            {"$ref": "#/$defs/layerLocator"},
                        ]
                    },
                    "sourceItemLocator": {
                        "oneOf": [
                            {"type": "null"},
                            {"$ref": "#/$defs/sourceItemLocator"},
                        ]
                    },
                },
            },
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "locatorBase": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "kind",
                "hostInstanceId",
                "sessionId",
                "projectId",
                "generation",
                "objectId",
            ],
            "properties": {
                "kind": {
                    "enum": ["project", "item", "composition", "layer", "stream"]
                },
                "hostInstanceId": {"$ref": "#/$defs/uuid"},
                "sessionId": {"$ref": "#/$defs/uuid"},
                "projectId": {"$ref": "#/$defs/uuid"},
                "generation": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _SAFE_MAX,
                },
                "objectId": {"$ref": "#/$defs/uuid"},
            },
        },
        "compositionLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"const": "composition"}}},
            ]
        },
        "layerLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"const": "layer"}}},
            ]
        },
        "sourceItemLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"enum": ["item", "composition"]}}},
            ]
        },
    },
    "x-invariant": "returned-equals-layers-length-and-page-metadata-is-self-consistent",
}

PROJECT_ITEMS_LIST_CONTRACT_DIGEST = (
    "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e"
)
COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST = (
    "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75"
)


PROJECT_BIT_DEPTH_READ_CAPABILITY_ID = "ae.project.bit-depth.read"
PROJECT_BIT_DEPTH_READ_CAPABILITY_VERSION = 1
PROJECT_BIT_DEPTH_READ_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.project.bit-depth.read.input.v1"
)
PROJECT_BIT_DEPTH_READ_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.project.bit-depth.read.result.v1"
)
PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST = (
    "936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e"
)

PROJECT_BIT_DEPTH_SET_CAPABILITY_ID = "ae.project.bit-depth.set"
PROJECT_BIT_DEPTH_SET_CAPABILITY_VERSION = 1
PROJECT_BIT_DEPTH_SET_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.project.bit-depth.set.input.v1"
)
PROJECT_BIT_DEPTH_SET_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.project.bit-depth.set.result.v1"
)
PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST = (
    "d5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a"
)

_IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
_PROJECT_BIT_DEPTH_READ_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [],
    "properties": {},
}
_PROJECT_BIT_DEPTH_READ_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["bitsPerChannel"],
    "properties": {
        "bitsPerChannel": {"enum": [8, 16, 32]},
    },
}
_PROJECT_BIT_DEPTH_SET_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["targetDepth", "idempotencyKey"],
    "properties": {
        "targetDepth": {"enum": [8, 16, 32]},
        "idempotencyKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 64,
            "pattern": _IDEMPOTENCY_KEY_PATTERN,
        },
    },
}
_PROJECT_BIT_DEPTH_SET_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "changed",
        "beforeBitsPerChannel",
        "afterBitsPerChannel",
    ],
    "properties": {
        "changed": {"const": True},
        "beforeBitsPerChannel": {"enum": [8, 16, 32]},
        "afterBitsPerChannel": {"enum": [8, 16, 32]},
    },
    "x-invariant": "beforeBitsPerChannel-must-differ-from-afterBitsPerChannel",
}


ProjectBitDepth: TypeAlias = Literal[8, 16, 32]


class ProjectBitDepthReadArguments(_NativeModel):
    pass


class ProjectBitDepthReadValue(_NativeModel):
    bits_per_channel: ProjectBitDepth


class ProjectBitDepthReadExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: ProjectBitDepthReadValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return {
            "engine": self.engine,
            "capabilityId": self.evidence.capability_id,
            "capabilityVersion": self.evidence.capability_version,
            "contractDigest": self.implementation.contract_digest,
            "selectedWireVersion": self.negotiation.selected_wire_version,
            "pluginVersion": self.negotiation.plugin_version,
            "compiledSdkVersion": self.negotiation.compiled_sdk_version,
            "sourceCommit": self.negotiation.source_commit,
            "hostInstanceId": self.evidence.host_instance_id,
            "sessionId": self.evidence.session_id,
            "sessionGeneration": self.negotiation.session_generation,
            "capabilitiesDigest": self.negotiation.capabilities_digest,
            "requestId": self.evidence.request_id,
            "effect": self.evidence.effect,
            "requestDigest": self.evidence.request_digest,
            "postconditionAlgorithm": self.evidence.postcondition.algorithm,
            "postconditionDigest": self.evidence.postcondition.digest,
            "startedAtUnixMs": self.evidence.started_at_unix_ms,
            "completedAtUnixMs": self.evidence.completed_at_unix_ms,
        }


class ProjectBitDepthSetArguments(_NativeModel):
    target_depth: ProjectBitDepth
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]


class ProjectBitDepthSetValue(_NativeModel):
    changed: Literal[True]
    before_bits_per_channel: ProjectBitDepth
    after_bits_per_channel: ProjectBitDepth

    @model_validator(mode="after")
    def _verified_transition(self) -> "ProjectBitDepthSetValue":
        if self.before_bits_per_channel == self.after_bits_per_channel:
            raise ValueError("project bit depth did not change")
        return self


class ProjectBitDepthSetExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]
    replayed: StrictBool
    value: ProjectBitDepthSetValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        undo = self.evidence.undo
        return {
            "engine": self.engine,
            "capabilityId": self.evidence.capability_id,
            "capabilityVersion": self.evidence.capability_version,
            "contractDigest": self.implementation.contract_digest,
            "selectedWireVersion": self.negotiation.selected_wire_version,
            "pluginVersion": self.negotiation.plugin_version,
            "compiledSdkVersion": self.negotiation.compiled_sdk_version,
            "sourceCommit": self.negotiation.source_commit,
            "hostInstanceId": self.evidence.host_instance_id,
            "sessionId": self.evidence.session_id,
            "sessionGeneration": self.negotiation.session_generation,
            "capabilitiesDigest": self.negotiation.capabilities_digest,
            "requestId": self.transport_request_id,
            "evidenceRequestId": self.evidence.request_id,
            "idempotencyKey": self.idempotency_key,
            "replayed": self.replayed,
            "effect": self.evidence.effect,
            "requestDigest": self.evidence.request_digest,
            "postconditionAlgorithm": self.evidence.postcondition.algorithm,
            "postconditionDigest": self.evidence.postcondition.digest,
            "undoAvailable": undo.available if undo is not None else False,
            "undoVerified": undo.verified if undo is not None else False,
            "startedAtUnixMs": self.evidence.started_at_unix_ms,
            "completedAtUnixMs": self.evidence.completed_at_unix_ms,
        }


def _structured_error(
    code: NativeErrorCode,
    message: str,
    *,
    details: Mapping[str, Any] | None = None,
) -> NativeBackendError:
    retryable, side_effect, action = _ERROR_POLICY[code]
    hints = {
        "refresh-capabilities": "Refresh negotiated native capabilities before retrying.",
        "refresh-locator": (
            "Discard the stale locator and call ae_listProjectItems again before retrying."
        ),
        "open-project": "Open the intended After Effects project, then retry.",
        "change-arguments": "Correct the rejected arguments before retrying.",
        "none": "Issue a new request only if the result is still needed.",
    }
    return NativeBackendError(
        code,
        message,
        retryable=retryable,
        side_effect=side_effect,
        recovery=NativeRecovery(
            action=action,
            hint=hints.get(
                action, "Retry only after the caller re-evaluates this failure."
            ),
        ),
        details=details,
    )


def _ensure_active(
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> None:
    if cancellation is not None and cancellation.is_cancelled:
        raise _structured_error("CANCELLED", "Native request was cancelled before dispatch.")
    if deadline_unix_ms <= int(time.time() * 1000):
        raise _structured_error(
            "DEADLINE_EXCEEDED",
            "Native request deadline elapsed before dispatch.",
        )


def _validate_project_summary_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    schemas_digest = _sha256_closed_json(
        {
            "inputSchema": descriptor.input_schema,
            "resultSchema": descriptor.result_schema,
        }
    )
    expected = (
        descriptor.capability_id == PROJECT_SUMMARY_CAPABILITY_ID
        and descriptor.capability_version == PROJECT_SUMMARY_CAPABILITY_VERSION
        and descriptor.engine == "native-aegp"
        and descriptor.risk == "read"
        and descriptor.mutability == "read-only"
        and descriptor.idempotency == "idempotent"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "not-applicable"
        and descriptor.input_contract_id == PROJECT_SUMMARY_INPUT_CONTRACT_ID
        and descriptor.result_contract_id == PROJECT_SUMMARY_RESULT_CONTRACT_ID
        and descriptor.contract_digest == PROJECT_SUMMARY_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _PROJECT_SUMMARY_INPUT_SCHEMA
        and descriptor.result_schema == _PROJECT_SUMMARY_RESULT_SCHEMA
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.project.summary contract does not match Core.",
        )


def _validate_project_bit_depth_read_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    schemas_digest = _sha256_closed_json(
        {
            "inputSchema": descriptor.input_schema,
            "resultSchema": descriptor.result_schema,
        }
    )
    expected_requirement = ("aemcp.requirement.native.project-bit-depth-read", 1)
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == PROJECT_BIT_DEPTH_READ_CAPABILITY_ID
        and descriptor.capability_version == PROJECT_BIT_DEPTH_READ_CAPABILITY_VERSION
        and descriptor.engine == "native-aegp"
        and descriptor.summary
        == "Read the open After Effects project's bit depth."
        and descriptor.risk == "read"
        and descriptor.mutability == "read-only"
        and descriptor.idempotency == "idempotent"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "not-applicable"
        and descriptor.side_effect_summary
        == "Reads project bit depth without changing After Effects state."
        and descriptor.preconditions
        == ("An After Effects project must be open.",)
        and descriptor.input_contract_id
        == PROJECT_BIT_DEPTH_READ_INPUT_CONTRACT_ID
        and descriptor.result_contract_id
        == PROJECT_BIT_DEPTH_READ_RESULT_CONTRACT_ID
        and descriptor.contract_digest == PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _PROJECT_BIT_DEPTH_READ_INPUT_SCHEMA
        and descriptor.result_schema == _PROJECT_BIT_DEPTH_READ_RESULT_SCHEMA
        and requirements == (expected_requirement,)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.project.bit-depth.read contract does not match Core.",
        )


def _validate_project_bit_depth_set_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    schemas_digest = _sha256_closed_json(
        {
            "inputSchema": descriptor.input_schema,
            "resultSchema": descriptor.result_schema,
        }
    )
    expected_requirement = ("aemcp.requirement.native.project-bit-depth-set", 1)
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == PROJECT_BIT_DEPTH_SET_CAPABILITY_ID
        and descriptor.capability_version == PROJECT_BIT_DEPTH_SET_CAPABILITY_VERSION
        and descriptor.engine == "native-aegp"
        and descriptor.summary
        == "Set the open After Effects project's bit depth."
        and descriptor.risk == "write"
        and descriptor.mutability == "mutating"
        and descriptor.idempotency == "idempotency-key"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "ae-undo-group"
        and descriptor.side_effect_summary
        == "Changes project bit depth and creates one After Effects Undo step."
        and descriptor.preconditions
        == (
            "An After Effects project must be open.",
            "targetDepth must differ from the current project bit depth.",
        )
        and descriptor.input_contract_id
        == PROJECT_BIT_DEPTH_SET_INPUT_CONTRACT_ID
        and descriptor.result_contract_id
        == PROJECT_BIT_DEPTH_SET_RESULT_CONTRACT_ID
        and descriptor.contract_digest == PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _PROJECT_BIT_DEPTH_SET_INPUT_SCHEMA
        and descriptor.result_schema == _PROJECT_BIT_DEPTH_SET_RESULT_SCHEMA
        and requirements == (expected_requirement,)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.project.bit-depth.set contract does not match Core.",
        )


def _validate_navigation_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
    capability_id: str,
    capability_version: int,
    summary: str,
    side_effect_summary: str,
    preconditions: tuple[str, ...],
    input_contract_id: str,
    result_contract_id: str,
    contract_digest: str,
    input_schema: dict[str, Any],
    result_schema: dict[str, Any],
    requirement_id: str,
) -> None:
    schemas_digest = _sha256_closed_json(
        {
            "inputSchema": descriptor.input_schema,
            "resultSchema": descriptor.result_schema,
        }
    )
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == capability_id
        and descriptor.capability_version == capability_version
        and descriptor.schema_version == 1
        and descriptor.engine == "native-aegp"
        and descriptor.summary == summary
        and descriptor.risk == "read"
        and descriptor.mutability == "read-only"
        and descriptor.idempotency == "idempotent"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "not-applicable"
        and descriptor.side_effect_summary == side_effect_summary
        and descriptor.preconditions == preconditions
        and descriptor.input_contract_id == input_contract_id
        and descriptor.result_contract_id == result_contract_id
        and descriptor.contract_digest == contract_digest
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == input_schema
        and descriptor.result_schema == result_schema
        and requirements == ((requirement_id, 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            f"Negotiated {capability_id} contract does not match Core.",
        )


def _validate_project_items_list_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    _validate_navigation_descriptor(
        descriptor,
        host_platform=host_platform,
        capability_id=PROJECT_ITEMS_LIST_CAPABILITY_ID,
        capability_version=PROJECT_ITEMS_LIST_CAPABILITY_VERSION,
        summary="List a bounded page of items in the open After Effects project.",
        side_effect_summary=(
            "Reads project items without changing After Effects state."
        ),
        preconditions=("An After Effects project must be open.",),
        input_contract_id=PROJECT_ITEMS_LIST_INPUT_CONTRACT_ID,
        result_contract_id=PROJECT_ITEMS_LIST_RESULT_CONTRACT_ID,
        contract_digest=PROJECT_ITEMS_LIST_CONTRACT_DIGEST,
        input_schema=_PROJECT_ITEMS_LIST_INPUT_SCHEMA,
        result_schema=_PROJECT_ITEMS_LIST_RESULT_SCHEMA,
        requirement_id="aemcp.requirement.native.project-items-list",
    )


def _validate_composition_layers_list_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    _validate_navigation_descriptor(
        descriptor,
        host_platform=host_platform,
        capability_id=COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
        capability_version=COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION,
        summary="List a bounded page of layers in one After Effects composition.",
        side_effect_summary=(
            "Reads composition layers without changing After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
        ),
        input_contract_id=COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID,
        result_contract_id=COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID,
        contract_digest=COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST,
        input_schema=_COMPOSITION_LAYERS_LIST_INPUT_SCHEMA,
        result_schema=_COMPOSITION_LAYERS_LIST_RESULT_SCHEMA,
        requirement_id="aemcp.requirement.native.composition-layers-list",
    )


def _sha256_closed_json(value: Any) -> str:
    # All object member names in this closed contract are ASCII, so Python's
    # lexical key order is identical to RFC 8785's UTF-16 order here.
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _project_summary_digest(value: ProjectSummaryValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": PROJECT_SUMMARY_CAPABILITY_ID,
            "capabilityVersion": PROJECT_SUMMARY_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _project_bit_depth_read_digest(value: ProjectBitDepthReadValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": PROJECT_BIT_DEPTH_READ_CAPABILITY_ID,
            "capabilityVersion": PROJECT_BIT_DEPTH_READ_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _project_bit_depth_set_digest(value: ProjectBitDepthSetValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": PROJECT_BIT_DEPTH_SET_CAPABILITY_ID,
            "capabilityVersion": PROJECT_BIT_DEPTH_SET_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _project_items_list_digest(value: ProjectItemsListValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": PROJECT_ITEMS_LIST_CAPABILITY_ID,
            "capabilityVersion": PROJECT_ITEMS_LIST_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _composition_layers_list_digest(value: CompositionLayersListValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
            "capabilityVersion": COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _capabilities_query_digest(
    *,
    session_id: str,
    ids: tuple[str, ...] | None,
    detail: CapabilityDetail,
    limit: int,
) -> str:
    return _sha256_closed_json(
        {
            "sessionId": session_id,
            "ids": list(ids) if ids is not None else None,
            "detail": detail,
            "limit": limit,
        }
    )


def _capabilities_registry_digest(
    items: tuple[NativeCapabilityDescriptor, ...],
) -> str:
    return _sha256_closed_json(
        [
            item.model_dump(
                mode="json",
                by_alias=True,
                exclude_none=True,
            )
            for item in items
        ]
    )


def _invoke_request_digest(
    request: NativeInvokeRequest,
    negotiation: NativeNegotiation,
) -> str:
    return _sha256_closed_json(
        {
            "wireVersion": negotiation.selected_wire_version,
            "kind": "request",
            "sessionId": negotiation.session_id,
            "requestId": request.request_id,
            "method": "invoke",
            "deadlineUnixMs": request.deadline_unix_ms,
            "params": {
                "capabilityId": request.capability_id,
                "capabilityVersion": request.capability_version,
                "arguments": request.arguments,
            },
        }
    )


def _validate_invoke_error_binding(
    error: NativeBackendError,
    request: NativeInvokeRequest,
) -> None:
    if error.code not in _CAPABILITY_DETAIL_ERROR_CODES:
        return
    capability_id = (error.details or {}).get("capabilityId")
    if capability_id == request.capability_id:
        return
    if error.side_effect == "may-have-occurred":
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native failure was not bound to the requested capability; "
            "side-effect uncertainty is preserved.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint="Inspect project state before deciding whether to retry.",
            ),
            details={"capabilityId": request.capability_id},
        ) from error
    raise _structured_error(
        "NATIVE_CONTRACT_MISMATCH",
        "Native failure was not bound to the requested capability.",
    ) from error


async def _invoke_native_read_request(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    capability_id: str,
    capability_version: int,
    arguments: dict[str, Any],
    locator: NativeLocator | None,
    locator_field: str,
    descriptor_validator: Callable[..., None],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> tuple[
    NativeNegotiation,
    NativeCapabilityDescriptor,
    NativeInvokeRequest,
    NativeInvokeResult,
]:
    """Negotiate and invoke one strict read-only native capability."""

    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    _ensure_active(deadline_unix_ms, cancellation)
    capability_ids: tuple[str, ...] | None = None
    capability_detail: CapabilityDetail = "full"
    capability_limit = 100
    capabilities = await backend.capabilities(
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    expected_query_digest = _capabilities_query_digest(
        session_id=negotiation.session_id,
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
    )
    try:
        registry_digest = _capabilities_registry_digest(capabilities.items)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capability registry could not be verified.",
        ) from exc
    if (
        capabilities.session_id != negotiation.session_id
        or capabilities.detail != capability_detail
        or capabilities.next_cursor is not None
        or capabilities.query_digest != expected_query_digest
        or capabilities.capabilities_digest != registry_digest
        or capabilities.capabilities_digest != negotiation.capabilities_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capabilities were not bound to the negotiated session.",
        )
    matches = [
        item
        for item in capabilities.items
        if item.capability_id == capability_id
        and item.capability_version == capability_version
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            f"Native host did not advertise {capability_id}@{capability_version}.",
        )
    descriptor_validator(descriptor, host_platform=negotiation.host_platform)
    if locator is not None and (
        locator.host_instance_id != negotiation.host_instance_id
        or locator.session_id != negotiation.session_id
    ):
        raise _structured_error(
            "STALE_LOCATOR",
            "Native locator does not belong to the negotiated host session.",
            details={
                "field": locator_field,
                "capabilityId": capability_id,
            },
        )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=capability_id,
        capability_version=capability_version,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
    )
    try:
        result = await backend.invoke(request, cancellation=cancellation)
    except NativeBackendError as exc:
        _validate_invoke_error_binding(exc, request)
        raise
    _ensure_active(deadline_unix_ms, cancellation)
    expected_request_digest = _invoke_request_digest(request, negotiation)
    if (
        result.capability_id != request.capability_id
        or result.capability_version != request.capability_version
        or result.engine != "native-aegp"
        or result.replayed is not False
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "none"
        or result.evidence.undo is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            f"Native {capability_id} result did not match its negotiated request.",
        )
    return negotiation, descriptor, request, result


async def invoke_project_summary(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> ProjectSummaryExecution:
    """Run the single #75 native binding; there is intentionally no fallback."""

    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    _ensure_active(deadline_unix_ms, cancellation)
    capability_ids: tuple[str, ...] | None = None
    capability_detail: CapabilityDetail = "full"
    capability_limit = 100
    capabilities = await backend.capabilities(
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    expected_query_digest = _capabilities_query_digest(
        session_id=negotiation.session_id,
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
    )
    try:
        registry_digest = _capabilities_registry_digest(capabilities.items)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capability registry could not be verified.",
        ) from exc
    if (
        capabilities.session_id != negotiation.session_id
        or capabilities.detail != capability_detail
        or capabilities.next_cursor is not None
        or capabilities.query_digest != expected_query_digest
        or capabilities.capabilities_digest != registry_digest
        or capabilities.capabilities_digest != negotiation.capabilities_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capabilities were not bound to the negotiated session.",
        )
    matching_descriptors = [
        item
        for item in capabilities.items
        if item.capability_id == PROJECT_SUMMARY_CAPABILITY_ID
        and item.capability_version == PROJECT_SUMMARY_CAPABILITY_VERSION
    ]
    descriptor = matching_descriptors[0] if len(matching_descriptors) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.project.summary@1.",
        )
    _validate_project_summary_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=PROJECT_SUMMARY_CAPABILITY_ID,
        capability_version=PROJECT_SUMMARY_CAPABILITY_VERSION,
        arguments={},
        deadline_unix_ms=deadline_unix_ms,
    )
    try:
        result = await backend.invoke(request, cancellation=cancellation)
    except NativeBackendError as exc:
        _validate_invoke_error_binding(exc, request)
        raise
    _ensure_active(deadline_unix_ms, cancellation)
    expected_request_digest = _invoke_request_digest(request, negotiation)
    if (
        result.capability_id != request.capability_id
        or result.capability_version != request.capability_version
        or result.engine != "native-aegp"
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "none"
        or result.evidence.undo is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project summary result did not match its negotiated request.",
        )
    try:
        value = ProjectSummaryValue.model_validate(result.value)
        postcondition_digest = _project_summary_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project summary value did not match its typed contract.",
        ) from exc
    if (
        result.evidence.postcondition.kind != "project-summary"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project summary postcondition evidence did not verify.",
        )
    return ProjectSummaryExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


async def invoke_project_bit_depth_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> ProjectBitDepthReadExecution:
    """Read the open project's bits per channel through the native plane only."""

    arguments = ProjectBitDepthReadArguments()
    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    _ensure_active(deadline_unix_ms, cancellation)
    capability_ids: tuple[str, ...] | None = None
    capability_detail: CapabilityDetail = "full"
    capability_limit = 100
    capabilities = await backend.capabilities(
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    expected_query_digest = _capabilities_query_digest(
        session_id=negotiation.session_id,
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
    )
    try:
        registry_digest = _capabilities_registry_digest(capabilities.items)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capability registry could not be verified.",
        ) from exc
    if (
        capabilities.session_id != negotiation.session_id
        or capabilities.detail != capability_detail
        or capabilities.next_cursor is not None
        or capabilities.query_digest != expected_query_digest
        or capabilities.capabilities_digest != registry_digest
        or capabilities.capabilities_digest != negotiation.capabilities_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capabilities were not bound to the negotiated session.",
        )
    matches = [
        item
        for item in capabilities.items
        if item.capability_id == PROJECT_BIT_DEPTH_READ_CAPABILITY_ID
        and item.capability_version == PROJECT_BIT_DEPTH_READ_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.project.bit-depth.read@1.",
        )
    _validate_project_bit_depth_read_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=PROJECT_BIT_DEPTH_READ_CAPABILITY_ID,
        capability_version=PROJECT_BIT_DEPTH_READ_CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        deadline_unix_ms=deadline_unix_ms,
    )
    try:
        result = await backend.invoke(request, cancellation=cancellation)
    except NativeBackendError as exc:
        _validate_invoke_error_binding(exc, request)
        raise
    _ensure_active(deadline_unix_ms, cancellation)
    expected_request_digest = _invoke_request_digest(request, negotiation)
    if (
        result.capability_id != request.capability_id
        or result.capability_version != request.capability_version
        or result.engine != "native-aegp"
        or result.replayed is not False
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "none"
        or result.evidence.undo is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project bit-depth read did not match its negotiated request.",
        )
    try:
        value = ProjectBitDepthReadValue.model_validate(result.value)
        postcondition_digest = _project_bit_depth_read_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project bit-depth value did not match its typed contract.",
        ) from exc
    if (
        result.evidence.postcondition.kind != "project-bit-depth-read"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project bit-depth read postcondition did not verify.",
        )
    return ProjectBitDepthReadExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


async def invoke_project_bit_depth_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    target_depth: int,
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> ProjectBitDepthSetExecution:
    """Set the open project's bits per channel through the native plane only."""

    arguments = ProjectBitDepthSetArguments(
        target_depth=target_depth,
        idempotency_key=idempotency_key,
    )
    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    _ensure_active(deadline_unix_ms, cancellation)
    capability_ids: tuple[str, ...] | None = None
    capability_detail: CapabilityDetail = "full"
    capability_limit = 100
    capabilities = await backend.capabilities(
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    expected_query_digest = _capabilities_query_digest(
        session_id=negotiation.session_id,
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
    )
    try:
        registry_digest = _capabilities_registry_digest(capabilities.items)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capability registry could not be verified.",
        ) from exc
    if (
        capabilities.session_id != negotiation.session_id
        or capabilities.detail != capability_detail
        or capabilities.next_cursor is not None
        or capabilities.query_digest != expected_query_digest
        or capabilities.capabilities_digest != registry_digest
        or capabilities.capabilities_digest != negotiation.capabilities_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capabilities were not bound to the negotiated session.",
        )
    matches = [
        item
        for item in capabilities.items
        if item.capability_id == PROJECT_BIT_DEPTH_SET_CAPABILITY_ID
        and item.capability_version == PROJECT_BIT_DEPTH_SET_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.project.bit-depth.set@1.",
        )
    _validate_project_bit_depth_set_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=PROJECT_BIT_DEPTH_SET_CAPABILITY_ID,
        capability_version=PROJECT_BIT_DEPTH_SET_CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        deadline_unix_ms=deadline_unix_ms,
    )
    try:
        result = await backend.invoke(request, cancellation=cancellation)
    except NativeBackendError as exc:
        _validate_invoke_error_binding(exc, request)
        raise
    expected_request_digest = _invoke_request_digest(request, negotiation)
    undo = result.evidence.undo
    if (
        result.capability_id != request.capability_id
        or result.capability_version != request.capability_version
        or result.engine != "native-aegp"
        or result.replayed is not False
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "committed"
        or undo is None
        # Availability is based on the SDK's explicit UNDOABLE contract plus a
        # successfully closed AE undo group. This invocation does not consume
        # the global Undo stack to verify the reverse transition.
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native project bit-depth result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint="Inspect project bit depth and the Undo stack before retrying.",
            ),
            details={"capabilityId": PROJECT_BIT_DEPTH_SET_CAPABILITY_ID},
        )
    try:
        value = ProjectBitDepthSetValue.model_validate(result.value)
        postcondition_digest = _project_bit_depth_set_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native project bit-depth value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint="Inspect project bit depth and the Undo stack before retrying.",
            ),
            details={"capabilityId": PROJECT_BIT_DEPTH_SET_CAPABILITY_ID},
        ) from exc
    if (
        value.after_bits_per_channel != arguments.target_depth
        or result.evidence.postcondition.kind != "project-bit-depth-set"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native project bit-depth postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint="Inspect project bit depth and the Undo stack before retrying.",
            ),
            details={"capabilityId": PROJECT_BIT_DEPTH_SET_CAPABILITY_ID},
        )
    return ProjectBitDepthSetExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=value,
        evidence=result.evidence,
    )


async def invoke_project_items_list(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    project_locator: NativeLocator | Mapping[str, Any] | None,
    offset: int,
    limit: int,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> ProjectItemsListExecution:
    """List a bounded native project-item page; JSX is never consulted."""

    arguments = ProjectItemsListArguments(
        project_locator=project_locator,
        offset=offset,
        limit=limit,
    )
    wire_arguments = arguments.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=PROJECT_ITEMS_LIST_CAPABILITY_ID,
        capability_version=PROJECT_ITEMS_LIST_CAPABILITY_VERSION,
        arguments=wire_arguments,
        locator=arguments.project_locator,
        locator_field="params.arguments.projectLocator",
        descriptor_validator=_validate_project_items_list_descriptor,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = ProjectItemsListValue.model_validate(result.value)
        postcondition_digest = _project_items_list_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project-item page did not match its typed contract.",
        ) from exc
    if (
        value.offset != arguments.offset
        or value.limit != arguments.limit
        or (
            arguments.project_locator is not None
            and value.project_locator != arguments.project_locator
        )
        or value.project_locator.host_instance_id != negotiation.host_instance_id
        or value.project_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind != "project-items-list"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native project-item page was not bound to its request and evidence.",
        )
    return ProjectItemsListExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


async def invoke_composition_layers_list(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    offset: int,
    limit: int,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionLayersListExecution:
    """List a bounded native layer page for one exact composition locator."""

    arguments = CompositionLayersListArguments(
        composition_locator=composition_locator,
        offset=offset,
        limit=limit,
    )
    wire_arguments = arguments.model_dump(mode="json", by_alias=True)
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
        capability_version=COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION,
        arguments=wire_arguments,
        locator=arguments.composition_locator,
        locator_field="params.arguments.compositionLocator",
        descriptor_validator=_validate_composition_layers_list_descriptor,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = CompositionLayersListValue.model_validate(result.value)
        postcondition_digest = _composition_layers_list_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native composition-layer page did not match its typed contract.",
        ) from exc
    if (
        value.composition_locator != arguments.composition_locator
        or value.offset != arguments.offset
        or value.limit != arguments.limit
        or value.composition_locator.host_instance_id != negotiation.host_instance_id
        or value.composition_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind != "composition-layers-list"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native composition-layer page was not bound to its request and evidence.",
        )
    return CompositionLayersListExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


__all__ = [
    "CapabilityDetail",
    "CompositionLayer",
    "CompositionLayersListArguments",
    "CompositionLayersListExecution",
    "CompositionLayersListValue",
    "ExecutionEngine",
    "NativeBackendError",
    "NativeBrokerErrorCode",
    "NativeCancellationToken",
    "NativeCancelResult",
    "NativeCapabilities",
    "NativeCapabilityDescriptor",
    "NativeCompatibility",
    "NativeErrorCode",
    "NativeErrorDetails",
    "NativeErrorPayload",
    "NativeExecutionEvidence",
    "NativeInvokeBackend",
    "NativeInvokeRequest",
    "NativeInvokeResult",
    "NativeLocator",
    "NativeNegotiation",
    "NativePostconditionEvidence",
    "NativePlatform",
    "NativeRecovery",
    "NativeRecoveryAction",
    "NativeRequirement",
    "NativeSideEffect",
    "NativeUndoEvidence",
    "NativeWireErrorCode",
    "NativeWireRange",
    "ProjectBitDepth",
    "ProjectBitDepthReadArguments",
    "ProjectBitDepthReadExecution",
    "ProjectBitDepthReadValue",
    "ProjectBitDepthSetArguments",
    "ProjectBitDepthSetExecution",
    "ProjectBitDepthSetValue",
    "ProjectItem",
    "ProjectItemsListArguments",
    "ProjectItemsListExecution",
    "ProjectItemsListValue",
    "ProjectSummaryExecution",
    "ProjectSummaryValue",
    "PROJECT_BIT_DEPTH_READ_CAPABILITY_ID",
    "PROJECT_BIT_DEPTH_READ_CAPABILITY_VERSION",
    "PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST",
    "PROJECT_BIT_DEPTH_SET_CAPABILITY_ID",
    "PROJECT_BIT_DEPTH_SET_CAPABILITY_VERSION",
    "PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST",
    "COMPOSITION_LAYERS_LIST_CAPABILITY_ID",
    "COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION",
    "COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST",
    "COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID",
    "COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID",
    "PROJECT_ITEMS_LIST_CAPABILITY_ID",
    "PROJECT_ITEMS_LIST_CAPABILITY_VERSION",
    "PROJECT_ITEMS_LIST_CONTRACT_DIGEST",
    "PROJECT_ITEMS_LIST_INPUT_CONTRACT_ID",
    "PROJECT_ITEMS_LIST_RESULT_CONTRACT_ID",
    "PROJECT_SUMMARY_CAPABILITY_ID",
    "PROJECT_SUMMARY_CAPABILITY_VERSION",
    "PROJECT_SUMMARY_CONTRACT_DIGEST",
    "invoke_project_bit_depth_read",
    "invoke_project_bit_depth_set",
    "invoke_composition_layers_list",
    "invoke_project_items_list",
    "invoke_project_summary",
]
