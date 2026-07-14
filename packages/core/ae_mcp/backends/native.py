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
from typing import Annotated, Any, Literal, Mapping, TypeAlias

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


def _structured_error(code: NativeErrorCode, message: str) -> NativeBackendError:
    retryable, side_effect, action = _ERROR_POLICY[code]
    return NativeBackendError(
        code,
        message,
        retryable=retryable,
        side_effect=side_effect,
        recovery=NativeRecovery(
            action=action,
            hint=(
                "Refresh negotiated native capabilities before retrying."
                if action == "refresh-capabilities"
                else "Issue a new request only if the result is still needed."
                if action == "none"
                else "Retry only after the caller re-evaluates this failure."
            ),
        ),
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


__all__ = [
    "CapabilityDetail",
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
    "ProjectSummaryExecution",
    "ProjectSummaryValue",
    "PROJECT_SUMMARY_CAPABILITY_ID",
    "PROJECT_SUMMARY_CAPABILITY_VERSION",
    "PROJECT_SUMMARY_CONTRACT_DIGEST",
    "invoke_project_summary",
]
