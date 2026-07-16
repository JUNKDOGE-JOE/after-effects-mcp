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
import math
import time
from abc import ABC, abstractmethod
from decimal import Decimal, InvalidOperation
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
_IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"

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
SignedInt = Annotated[StrictInt, Field(ge=-_SAFE_MAX, le=_SAFE_MAX)]
SignedInt32 = Annotated[StrictInt, Field(ge=-2_147_483_648, le=2_147_483_647)]
UnsignedInt32 = Annotated[StrictInt, Field(ge=1, le=4_294_967_295)]

_DECIMAL_STRING = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"
DecimalString = Annotated[
    StrictStr, Field(min_length=1, max_length=32, pattern=_DECIMAL_STRING)
]


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
        property_precondition = (
            self.code == "PRECONDITION_FAILED"
            and self.details is not None
            and self.details.capability_id == LAYER_PROPERTY_SET_CAPABILITY_ID
            and self.details.field == "params.arguments.propertyLocator"
            and actual == (False, "not-started", "change-arguments")
        )
        if actual != expected and not property_precondition:
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


class SelectedCompositionLayersListArguments(_NativeModel):
    composition_locator: NativeLocator
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]

    @model_validator(mode="after")
    def _composition_kind(self) -> "SelectedCompositionLayersListArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        return self


class CompositionTimeReadArguments(_NativeModel):
    composition_locator: NativeLocator

    @model_validator(mode="after")
    def _composition_kind(self) -> "CompositionTimeReadArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        return self


class CompositionCurrentTime(_NativeModel):
    value: SignedInt32
    scale: UnsignedInt32
    seconds_rational: Annotated[
        StrictStr,
        Field(
            min_length=1,
            max_length=28,
            pattern=r"^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$",
        ),
    ]

    @model_validator(mode="after")
    def _exact_reduced_rational(self) -> "CompositionCurrentTime":
        divisor = math.gcd(abs(self.value), self.scale)
        numerator = self.value // divisor
        denominator = self.scale // divisor
        expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
        if self.seconds_rational != expected:
            raise ValueError(
                "secondsRational must be the exact reduced form of value/scale"
            )
        return self


class CompositionTimeReadValue(_NativeModel):
    composition_locator: NativeLocator
    current_time: CompositionCurrentTime

    @model_validator(mode="after")
    def _composition_kind(self) -> "CompositionTimeReadValue":
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


class SelectedCompositionLayersListValue(_NativeModel):
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
    def _verified_page(self) -> "SelectedCompositionLayersListValue":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        if self.returned != len(self.layers) or self.returned > self.limit:
            raise ValueError("selected layer page count does not match returned")
        consumed = self.offset + self.returned
        if consumed > self.total:
            raise ValueError("selected layer page exceeds total")
        expected_more = consumed < self.total
        expected_next = consumed if expected_more else None
        if expected_more and self.returned == 0:
            raise ValueError("selected layer continuation page made no progress")
        if self.has_more is not expected_more or self.next_offset != expected_next:
            raise ValueError("selected layer continuation metadata is inconsistent")
        context = self.composition_locator.context()
        object_ids: set[str] = set()
        previous_stack_index = 0
        for layer in self.layers:
            related = (layer.locator, layer.parent_locator, layer.source_item_locator)
            if any(item is not None and item.context() != context for item in related):
                raise ValueError("selected layer locator escaped the project context")
            if layer.locator.object_id in object_ids:
                raise ValueError("selected layer page contains duplicate locators")
            if layer.stack_index <= previous_stack_index:
                raise ValueError("selected layers must be in strict stack order")
            object_ids.add(layer.locator.object_id)
            previous_stack_index = layer.stack_index
        return self


class LayerPropertiesListArguments(_NativeModel):
    layer_locator: NativeLocator
    parent_property_locator: NativeLocator | None = None
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=25)]

    @model_validator(mode="after")
    def _locator_kinds(self) -> "LayerPropertiesListArguments":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        if (
            self.parent_property_locator is not None
            and self.parent_property_locator.kind != "stream"
        ):
            raise ValueError("parentPropertyLocator must have kind stream")
        return self


class LayerPropertySampleTime(_NativeModel):
    value: SignedInt
    scale: PositiveInt
    mode: Literal["comp-time"]


def _validate_decimal_string(value: str) -> None:
    try:
        decimal_value = Decimal(value)
        binary_value = float(value)
    except (InvalidOperation, OverflowError, ValueError) as exc:
        raise ValueError("property decimal string is not finite") from exc
    if not decimal_value.is_finite() or not math.isfinite(binary_value):
        raise ValueError("property decimal string is not finite binary64")
    if binary_value == 0 and not decimal_value.is_zero():
        raise ValueError("property decimal string underflows binary64")
    if binary_value == 0 and value.startswith("-"):
        raise ValueError("property decimal string must normalize negative zero to 0")


class LayerPropertyScalarValue(_NativeModel):
    kind: Literal["scalar"]
    value: DecimalString

    @model_validator(mode="after")
    def _canonical_decimal(self) -> "LayerPropertyScalarValue":
        _validate_decimal_string(self.value)
        return self


class LayerPropertyVectorValue(_NativeModel):
    kind: Literal["vector"]
    components: tuple[DecimalString, ...] = Field(min_length=2, max_length=3)

    @model_validator(mode="after")
    def _canonical_decimals(self) -> "LayerPropertyVectorValue":
        for component in self.components:
            _validate_decimal_string(component)
        return self


class LayerPropertyColorValue(_NativeModel):
    kind: Literal["color"]
    alpha: DecimalString
    red: DecimalString
    green: DecimalString
    blue: DecimalString

    @model_validator(mode="after")
    def _canonical_decimals(self) -> "LayerPropertyColorValue":
        for component in (self.alpha, self.red, self.green, self.blue):
            _validate_decimal_string(component)
        return self


LayerPropertyPrimitiveValue: TypeAlias = (
    LayerPropertyScalarValue | LayerPropertyVectorValue | LayerPropertyColorValue
)


def _layer_property_values_binary_equal(
    left: LayerPropertyPrimitiveValue,
    right: LayerPropertyPrimitiveValue,
) -> bool:
    """Compare the binary64 values AE receives, independent of wire spelling."""
    if type(left) is not type(right):
        return False
    if isinstance(left, LayerPropertyScalarValue) and isinstance(
        right, LayerPropertyScalarValue
    ):
        return float(left.value) == float(right.value)
    if isinstance(left, LayerPropertyVectorValue) and isinstance(
        right, LayerPropertyVectorValue
    ):
        return len(left.components) == len(right.components) and all(
            float(left_value) == float(right_value)
            for left_value, right_value in zip(left.components, right.components)
        )
    if isinstance(left, LayerPropertyColorValue) and isinstance(
        right, LayerPropertyColorValue
    ):
        return all(
            float(left_value) == float(right_value)
            for left_value, right_value in zip(
                (left.alpha, left.red, left.green, left.blue),
                (right.alpha, right.red, right.green, right.blue),
            )
        )
    return False


LayerPropertyGroupingType: TypeAlias = Literal[
    "named-group", "indexed-group", "leaf"
]
LayerPropertyValueType: TypeAlias = Literal[
    "none",
    "one-d",
    "two-d",
    "two-d-spatial",
    "three-d",
    "three-d-spatial",
    "color",
    "arb",
    "marker",
    "layer-id",
    "mask-id",
    "mask",
    "text-document",
    "unknown",
]
LayerPropertyValueStatus: TypeAlias = Literal[
    "group", "sampled", "no-data", "unsupported"
]


class LayerProperty(_NativeModel):
    property_locator: NativeLocator
    property_index: PositiveInt
    name: Annotated[StrictStr, Field(max_length=1024)]
    match_name: Annotated[StrictStr, Field(max_length=40)]
    grouping_type: LayerPropertyGroupingType
    child_count: NonNegativeInt
    hidden: StrictBool
    disabled: StrictBool
    modified: StrictBool
    can_vary_over_time: StrictBool | None
    time_varying: StrictBool | None
    value_type: LayerPropertyValueType
    value_status: LayerPropertyValueStatus
    value: LayerPropertyPrimitiveValue | None

    @model_validator(mode="after")
    def _verified_shape(self) -> "LayerProperty":
        if self.property_locator.kind != "stream":
            raise ValueError("propertyLocator must have kind stream")
        if self.grouping_type != "leaf":
            if (
                self.value_type != "none"
                or self.value_status != "group"
                or self.value is not None
                or self.can_vary_over_time is not None
                or self.time_varying is not None
            ):
                raise ValueError("property group value metadata is inconsistent")
            return self
        if self.child_count != 0:
            raise ValueError("leaf property cannot report child properties")
        if self.value_status == "group":
            raise ValueError("leaf property cannot use group value metadata")
        if self.value_status == "no-data":
            if self.value_type != "none" or self.value is not None:
                raise ValueError("no-data property value metadata is inconsistent")
            return self
        if self.value_status == "unsupported":
            if self.value is not None or self.value_type not in {
                "arb",
                "marker",
                "layer-id",
                "mask-id",
                "mask",
                "text-document",
                "unknown",
            }:
                raise ValueError("unsupported property value metadata is inconsistent")
            return self
        if self.can_vary_over_time is None or self.time_varying is None:
            raise ValueError("sampled property requires time-variance metadata")
        if self.value_type == "one-d":
            valid_value = isinstance(self.value, LayerPropertyScalarValue)
        elif self.value_type in {"two-d", "two-d-spatial"}:
            valid_value = (
                isinstance(self.value, LayerPropertyVectorValue)
                and len(self.value.components) == 2
            )
        elif self.value_type in {"three-d", "three-d-spatial"}:
            valid_value = (
                isinstance(self.value, LayerPropertyVectorValue)
                and len(self.value.components) == 3
            )
        elif self.value_type == "color":
            valid_value = isinstance(self.value, LayerPropertyColorValue)
        else:
            valid_value = False
        if not valid_value:
            raise ValueError("sampled property value does not match valueType")
        return self


class LayerPropertiesListValue(_NativeModel):
    layer_locator: NativeLocator
    parent_property_locator: NativeLocator | None
    layer_name: Annotated[StrictStr, Field(max_length=1024)]
    sample_time: LayerPropertySampleTime
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=25)]
    returned: Annotated[StrictInt, Field(ge=0, le=25)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    properties: tuple[LayerProperty, ...] = Field(max_length=25)

    @model_validator(mode="after")
    def _verified_page(self) -> "LayerPropertiesListValue":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        if (
            self.parent_property_locator is not None
            and self.parent_property_locator.kind != "stream"
        ):
            raise ValueError("parentPropertyLocator must have kind stream")
        if self.returned != len(self.properties) or self.returned > self.limit:
            raise ValueError("layer property page count does not match returned")
        consumed = self.offset + self.returned
        if consumed > self.total:
            raise ValueError("layer property page exceeds total")
        expected_more = consumed < self.total
        expected_next = consumed if expected_more else None
        if expected_more and self.returned == 0:
            raise ValueError("layer property continuation page made no progress")
        if self.has_more is not expected_more or self.next_offset != expected_next:
            raise ValueError("layer property continuation metadata is inconsistent")
        context = self.layer_locator.context()
        if (
            self.parent_property_locator is not None
            and self.parent_property_locator.context() != context
        ):
            raise ValueError("parent property locator escaped the layer context")
        object_ids: set[str] = set()
        property_indices: set[int] = set()
        for index, prop in enumerate(self.properties):
            if prop.property_locator.context() != context:
                raise ValueError("property locator escaped the layer context")
            if (
                self.parent_property_locator is not None
                and prop.property_locator == self.parent_property_locator
            ):
                raise ValueError("child property locator cannot equal its parent")
            if prop.property_locator.object_id in object_ids:
                raise ValueError("layer property page contains duplicate locators")
            if prop.property_index in property_indices:
                raise ValueError("layer property page contains duplicate property indices")
            if prop.property_index != self.offset + index + 1:
                raise ValueError("propertyIndex does not match page order")
            object_ids.add(prop.property_locator.object_id)
            property_indices.add(prop.property_index)
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


class SelectedCompositionLayersListExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: SelectedCompositionLayersListValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return _native_read_audit_fields(
            self.implementation, self.negotiation, self.evidence
        )


class CompositionTimeReadExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: CompositionTimeReadValue
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return _native_read_audit_fields(
            self.implementation, self.negotiation, self.evidence
        )


class CompositionTimeTarget(_NativeModel):
    value: SignedInt32
    scale: UnsignedInt32


class CompositionTimeSetArguments(_NativeModel):
    composition_locator: NativeLocator
    target_time: CompositionTimeTarget
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]

    @model_validator(mode="after")
    def _composition_kind(self) -> "CompositionTimeSetArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        return self


def _composition_times_equal(
    left: CompositionCurrentTime | CompositionTimeTarget,
    right: CompositionCurrentTime | CompositionTimeTarget,
) -> bool:
    return left.value * right.scale == right.value * left.scale


class CompositionTimeSetValue(_NativeModel):
    changed: Literal[True]
    composition_locator: NativeLocator
    before_time: CompositionCurrentTime
    after_time: CompositionCurrentTime

    @model_validator(mode="after")
    def _verified_transition(self) -> "CompositionTimeSetValue":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        if _composition_times_equal(self.before_time, self.after_time):
            raise ValueError("composition current time did not change")
        return self


class CompositionTimeSetExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]
    replayed: StrictBool
    value: CompositionTimeSetValue
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


class LayerPropertiesListExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    value: LayerPropertiesListValue
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

SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID = (
    "ae.composition.selected-layers.list"
)
SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION = 1
SELECTED_COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.selected-layers.list.input.v1"
)
SELECTED_COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.selected-layers.list.result.v1"
)

COMPOSITION_TIME_READ_CAPABILITY_ID = "ae.composition.time.read"
COMPOSITION_TIME_READ_CAPABILITY_VERSION = 1
COMPOSITION_TIME_READ_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.time.read.input.v1"
)
COMPOSITION_TIME_READ_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.time.read.result.v1"
)
COMPOSITION_TIME_READ_CONTRACT_DIGEST = (
    "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd"
)

COMPOSITION_TIME_SET_CAPABILITY_ID = "ae.composition.time.set"
COMPOSITION_TIME_SET_CAPABILITY_VERSION = 1
COMPOSITION_TIME_SET_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.time.set.input.v1"
)
COMPOSITION_TIME_SET_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.time.set.result.v1"
)
COMPOSITION_TIME_SET_CONTRACT_DIGEST = (
    "724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308"
)

COMPOSITION_CREATE_CAPABILITY_ID = "ae.composition.create"
COMPOSITION_CREATE_CAPABILITY_VERSION = 1
COMPOSITION_CREATE_INPUT_CONTRACT_ID = "aemcp.contract.ae.composition.create.input.v1"
COMPOSITION_CREATE_RESULT_CONTRACT_ID = "aemcp.contract.ae.composition.create.result.v1"
COMPOSITION_CREATE_CONTRACT_DIGEST = (
    "a5e0ccfc15086d1b10987246048e539cf6332a4e24114ac81783f4a9758ab6f6"
)

COMPOSITION_LAYER_CREATE_CAPABILITY_ID = "ae.composition.layer.create"
COMPOSITION_LAYER_CREATE_CAPABILITY_VERSION = 1
COMPOSITION_LAYER_CREATE_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.layer.create.input.v1"
)
COMPOSITION_LAYER_CREATE_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.composition.layer.create.result.v1"
)
COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST = (
    "d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee"
)

LAYER_EFFECT_APPLY_CAPABILITY_ID = "ae.layer.effect.apply"
LAYER_EFFECT_APPLY_CAPABILITY_VERSION = 1
LAYER_EFFECT_APPLY_INPUT_CONTRACT_ID = "aemcp.contract.ae.layer.effect.apply.input.v1"
LAYER_EFFECT_APPLY_RESULT_CONTRACT_ID = "aemcp.contract.ae.layer.effect.apply.result.v1"
LAYER_EFFECT_APPLY_CONTRACT_DIGEST = (
    "5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77"
)

LAYER_PROPERTIES_LIST_CAPABILITY_ID = "ae.layer.properties.list"
LAYER_PROPERTIES_LIST_CAPABILITY_VERSION = 1
LAYER_PROPERTIES_LIST_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.layer.properties.list.input.v1"
)
LAYER_PROPERTIES_LIST_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.layer.properties.list.result.v1"
)

LAYER_PROPERTY_SET_CAPABILITY_ID = "ae.layer.property.set"
LAYER_PROPERTY_SET_CAPABILITY_VERSION = 1
LAYER_PROPERTY_SET_INPUT_CONTRACT_ID = (
    "aemcp.contract.ae.layer.property.set.input.v1"
)
LAYER_PROPERTY_SET_RESULT_CONTRACT_ID = (
    "aemcp.contract.ae.layer.property.set.result.v1"
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

# Selected-layer listing intentionally reuses the same closed wire shapes as
# composition-layer listing. Its result is the same complete CompositionLayer
# tuple, while the typed value validator below applies the different semantic
# invariant: selected stack indices are strictly increasing, not contiguous.
_SELECTED_COMPOSITION_LAYERS_LIST_INPUT_SCHEMA = (
    _COMPOSITION_LAYERS_LIST_INPUT_SCHEMA
)
_SELECTED_COMPOSITION_LAYERS_LIST_RESULT_SCHEMA = (
    _COMPOSITION_LAYERS_LIST_RESULT_SCHEMA
)

_COMPOSITION_TIME_READ_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["compositionLocator"],
    "properties": {
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
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
_COMPOSITION_TIME_READ_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["compositionLocator", "currentTime"],
    "properties": {
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "currentTime": {
            "type": "object",
            "additionalProperties": False,
            "required": ["value", "scale", "secondsRational"],
            "properties": {
                "value": {
                    "type": "integer",
                    "minimum": -2_147_483_648,
                    "maximum": 2_147_483_647,
                },
                "scale": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 4_294_967_295,
                },
                "secondsRational": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 28,
                    "pattern": r"^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$",
                },
            },
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
    "x-invariant": (
        "secondsRational-is-the-reduced-canonical-form-of-value-over-scale"
    ),
}

_COMPOSITION_TIME_SET_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["compositionLocator", "targetTime", "idempotencyKey"],
    "properties": {
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "targetTime": {"$ref": "#/$defs/timeInput"},
        "idempotencyKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 64,
            "pattern": _IDEMPOTENCY_KEY_PATTERN,
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "compositionLocator": _COMPOSITION_TIME_READ_INPUT_SCHEMA["$defs"][
            "compositionLocator"
        ],
        "timeInput": {
            "type": "object",
            "additionalProperties": False,
            "required": ["value", "scale"],
            "properties": {
                "value": {
                    "type": "integer",
                    "minimum": -2_147_483_648,
                    "maximum": 2_147_483_647,
                },
                "scale": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 4_294_967_295,
                },
            },
        },
    },
}

_COMPOSITION_TIME_SET_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["changed", "compositionLocator", "beforeTime", "afterTime"],
    "properties": {
        "changed": {"const": True},
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "beforeTime": {"$ref": "#/$defs/currentTime"},
        "afterTime": {"$ref": "#/$defs/currentTime"},
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "compositionLocator": _COMPOSITION_TIME_READ_INPUT_SCHEMA["$defs"][
            "compositionLocator"
        ],
        "currentTime": _COMPOSITION_TIME_READ_RESULT_SCHEMA["properties"][
            "currentTime"
        ],
    },
    "x-invariant": (
        "beforeTime-must-differ-from-afterTime-and-afterTime-must-equal-targetTime"
    ),
}

_POSITIVE_RATIO_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["numerator", "denominator"],
    "properties": {
        "numerator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
        "denominator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
    },
}
_POSITIVE_RATIO_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["numerator", "denominator", "rational"],
    "properties": {
        "numerator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
        "denominator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
        "rational": {
            "type": "string",
            "minLength": 1,
            "maxLength": 28,
            "pattern": r"^[1-9][0-9]*(?:/[1-9][0-9]*)?$",
        },
    },
    "x-invariant": "rational-is-the-reduced-canonical-form-of-numerator-over-denominator",
}
_COMPOSITION_CREATE_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "name", "width", "height", "duration", "frameRate",
        "pixelAspectRatio", "idempotencyKey",
    ],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 255},
        "width": {"type": "integer", "minimum": 1, "maximum": 30_000},
        "height": {"type": "integer", "minimum": 1, "maximum": 30_000},
        "duration": {"$ref": "#/$defs/positiveTime"},
        "frameRate": {"$ref": "#/$defs/positiveRatio"},
        "pixelAspectRatio": {"$ref": "#/$defs/positiveRatio"},
        "idempotencyKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 64,
            "pattern": _IDEMPOTENCY_KEY_PATTERN,
        },
    },
    "$defs": {
        "positiveTime": {
            "type": "object",
            "additionalProperties": False,
            "required": ["value", "scale"],
            "properties": {
                "value": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
                "scale": {"type": "integer", "minimum": 1, "maximum": 4_294_967_295},
            },
        },
        "positiveRatio": _POSITIVE_RATIO_INPUT_SCHEMA,
    },
}
_COMPOSITION_CREATE_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "changed", "name", "compositionLocator", "projectItemCountBefore",
        "projectItemCountAfter", "layerCount", "width", "height", "duration",
        "frameRate", "pixelAspectRatio",
    ],
    "properties": {
        "changed": {"const": True},
        "name": {"type": "string", "minLength": 1, "maxLength": 255},
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "projectItemCountBefore": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "projectItemCountAfter": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "layerCount": {"const": 0},
        "width": {"type": "integer", "minimum": 1, "maximum": 30_000},
        "height": {"type": "integer", "minimum": 1, "maximum": 30_000},
        "duration": {"$ref": "#/$defs/currentTime"},
        "frameRate": {"$ref": "#/$defs/positiveRatio"},
        "pixelAspectRatio": {"$ref": "#/$defs/positiveRatio"},
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "compositionLocator": _COMPOSITION_TIME_READ_INPUT_SCHEMA["$defs"]["compositionLocator"],
        "currentTime": _COMPOSITION_TIME_READ_RESULT_SCHEMA["properties"]["currentTime"],
        "positiveRatio": _POSITIVE_RATIO_RESULT_SCHEMA,
    },
    "x-invariant": "projectItemCountAfter-equals-projectItemCountBefore-plus-one;layerCount-is-zero;all-settings-match-the-request",
}

_COMPOSITION_LAYER_CREATE_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["compositionLocator", "kind", "name", "idempotencyKey"],
    "properties": {
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "kind": {"enum": ["null", "solid"]},
        "name": {"type": "string", "minLength": 1, "maxLength": 255},
        "color": {
            "$ref": "#/$defs/color",
            "default": {"red": 255, "green": 255, "blue": 255, "alpha": 255},
            "x-omissionBehavior": "opaque-white",
        },
        "width": {
            "type": "integer",
            "minimum": 1,
            "maximum": 30_000,
            "x-omissionBehavior": "composition-width",
        },
        "height": {
            "type": "integer",
            "minimum": 1,
            "maximum": 30_000,
            "x-omissionBehavior": "composition-height",
        },
        "duration": {
            "$ref": "#/$defs/timeInput",
            "x-omissionBehavior": "composition-duration",
        },
        "idempotencyKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 64,
            "pattern": _IDEMPOTENCY_KEY_PATTERN,
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "compositionLocator": _COMPOSITION_TIME_READ_INPUT_SCHEMA["$defs"][
            "compositionLocator"
        ],
        "timeInput": _COMPOSITION_TIME_SET_INPUT_SCHEMA["$defs"]["timeInput"],
        "color": {
            "type": "object",
            "additionalProperties": False,
            "required": ["red", "green", "blue", "alpha"],
            "properties": {
                channel: {"type": "integer", "minimum": 0, "maximum": 255}
                for channel in ("red", "green", "blue", "alpha")
            },
        },
    },
    "x-invariant": "solid-options-are-forbidden-when-kind-is-null",
}

_COMPOSITION_LAYER_CREATE_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "changed",
        "kind",
        "name",
        "stackIndex",
        "compositionLocator",
        "layerLocator",
        "sourceItemLocator",
        "layerCountBefore",
        "layerCountAfter",
        "projectItemCountBefore",
        "projectItemCountAfter",
        "solid",
    ],
    "properties": {
        "changed": {"const": True},
        "kind": {"enum": ["null", "solid"]},
        "name": {"type": "string", "minLength": 1, "maxLength": 255},
        "stackIndex": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "compositionLocator": {"$ref": "#/$defs/compositionLocator"},
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "sourceItemLocator": {
            "oneOf": [
                {"type": "null"},
                {"$ref": "#/$defs/itemLocator"},
            ]
        },
        "layerCountBefore": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "layerCountAfter": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "projectItemCountBefore": {
            "type": "integer",
            "minimum": 0,
            "maximum": _SAFE_MAX,
        },
        "projectItemCountAfter": {
            "type": "integer",
            "minimum": 0,
            "maximum": _SAFE_MAX,
        },
        "solid": {
            "oneOf": [
                {"type": "null"},
                {"$ref": "#/$defs/solidSpec"},
            ]
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
                "kind": {"enum": ["composition", "layer", "item"]},
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
        "itemLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"enum": ["item", "composition"]}}},
            ]
        },
        "currentTime": _COMPOSITION_TIME_READ_RESULT_SCHEMA["properties"][
            "currentTime"
        ],
        "color": _COMPOSITION_LAYER_CREATE_INPUT_SCHEMA["$defs"]["color"],
        "solidSpec": {
            "type": "object",
            "additionalProperties": False,
            "required": ["color", "width", "height", "duration"],
            "properties": {
                "color": {"$ref": "#/$defs/color"},
                "width": {"type": "integer", "minimum": 1, "maximum": 30_000},
                "height": {"type": "integer", "minimum": 1, "maximum": 30_000},
                "duration": {"$ref": "#/$defs/currentTime"},
            },
        },
    },
    "x-invariant": (
        "new-locators-share-one-post-mutation-generation;"
        "layerCountAfter-equals-layerCountBefore-plus-one;"
        "solid-requires-source-item-and-solid-metadata"
    ),
}

_LAYER_EFFECT_APPLY_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["layerLocator", "effectMatchName", "idempotencyKey"],
    "properties": {
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "effectMatchName": {"type": "string", "minLength": 1, "maxLength": 47},
        "idempotencyKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 64,
            "pattern": _IDEMPOTENCY_KEY_PATTERN,
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "layerLocator": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "kind", "hostInstanceId", "sessionId", "projectId",
                "generation", "objectId",
            ],
            "properties": {
                "kind": {"const": "layer"},
                "hostInstanceId": {"$ref": "#/$defs/uuid"},
                "sessionId": {"$ref": "#/$defs/uuid"},
                "projectId": {"$ref": "#/$defs/uuid"},
                "generation": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
                "objectId": {"$ref": "#/$defs/uuid"},
            },
        },
    },
}

_LAYER_EFFECT_APPLY_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "changed", "layerLocator", "name", "matchName", "effectIndex",
        "effectCountBefore", "effectCountAfter", "matchingEffectCountBefore",
        "matchingEffectCountAfter",
    ],
    "properties": {
        "changed": {"const": True},
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "name": {"type": "string", "minLength": 1, "maxLength": 47},
        "matchName": {"type": "string", "minLength": 1, "maxLength": 47},
        "effectIndex": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "effectCountBefore": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "effectCountAfter": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "matchingEffectCountBefore": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "matchingEffectCountAfter": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
    },
    "$defs": _LAYER_EFFECT_APPLY_INPUT_SCHEMA["$defs"],
    "x-invariant": (
        "effectCountAfter-equals-effectCountBefore-plus-one;"
        "matchingEffectCountAfter-equals-matchingEffectCountBefore-plus-one;"
        "effectIndex-is-in-the-post-mutation-stack;matchName-equals-the-request"
    ),
}

_LAYER_PROPERTIES_LIST_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["layerLocator", "offset", "limit"],
    "properties": {
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "parentPropertyLocator": {
            "oneOf": [
                {"type": "null"},
                {"$ref": "#/$defs/streamLocator"},
            ]
        },
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
            "maximum": 25,
            "default": 25,
            "x-omissionBehavior": 25,
        },
    },
    "$defs": {
        "uuid": {"type": "string", "pattern": _UUID},
        "layerLocator": {
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
                "kind": {"const": "layer"},
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
        "streamLocator": {
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
                "kind": {"const": "stream"},
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

_LAYER_PROPERTY_DECIMAL_SCHEMA = {
    "type": "string",
    "minLength": 1,
    "maxLength": 32,
    "pattern": _DECIMAL_STRING,
}
_LAYER_PROPERTIES_LIST_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "layerLocator",
        "parentPropertyLocator",
        "layerName",
        "sampleTime",
        "total",
        "offset",
        "limit",
        "returned",
        "hasMore",
        "nextOffset",
        "properties",
    ],
    "properties": {
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "parentPropertyLocator": {
            "oneOf": [
                {"type": "null"},
                {"$ref": "#/$defs/streamLocator"},
            ]
        },
        "layerName": {"type": "string", "maxLength": 1024},
        "sampleTime": {
            "type": "object",
            "additionalProperties": False,
            "required": ["value", "scale", "mode"],
            "properties": {
                "value": {
                    "type": "integer",
                    "minimum": -_SAFE_MAX,
                    "maximum": _SAFE_MAX,
                },
                "scale": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _SAFE_MAX,
                },
                "mode": {"const": "comp-time"},
            },
        },
        "total": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "offset": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "limit": {"type": "integer", "minimum": 1, "maximum": 25},
        "returned": {"type": "integer", "minimum": 0, "maximum": 25},
        "hasMore": {"type": "boolean"},
        "nextOffset": {
            "oneOf": [
                {"type": "null"},
                {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
            ]
        },
        "properties": {
            "type": "array",
            "maxItems": 25,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "propertyLocator",
                    "propertyIndex",
                    "name",
                    "matchName",
                    "groupingType",
                    "childCount",
                    "hidden",
                    "disabled",
                    "modified",
                    "canVaryOverTime",
                    "timeVarying",
                    "valueType",
                    "valueStatus",
                    "value",
                ],
                "properties": {
                    "propertyLocator": {"$ref": "#/$defs/streamLocator"},
                    "propertyIndex": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": _SAFE_MAX,
                    },
                    "name": {"type": "string", "maxLength": 1024},
                    "matchName": {"type": "string", "maxLength": 40},
                    "groupingType": {
                        "enum": ["leaf", "named-group", "indexed-group"]
                    },
                    "childCount": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": _SAFE_MAX,
                    },
                    "hidden": {"type": "boolean"},
                    "disabled": {"type": "boolean"},
                    "modified": {"type": "boolean"},
                    "canVaryOverTime": {
                        "oneOf": [{"type": "null"}, {"type": "boolean"}]
                    },
                    "timeVarying": {
                        "oneOf": [{"type": "null"}, {"type": "boolean"}]
                    },
                    "valueType": {
                        "enum": [
                            "none",
                            "one-d",
                            "two-d",
                            "two-d-spatial",
                            "three-d",
                            "three-d-spatial",
                            "color",
                            "arb",
                            "marker",
                            "layer-id",
                            "mask-id",
                            "mask",
                            "text-document",
                            "unknown",
                        ]
                    },
                    "valueStatus": {
                        "enum": ["group", "sampled", "no-data", "unsupported"]
                    },
                    "value": {
                        "oneOf": [
                            {"type": "null"},
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["kind", "value"],
                                "properties": {
                                    "kind": {"const": "scalar"},
                                    "value": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["kind", "components"],
                                "properties": {
                                    "kind": {"const": "vector"},
                                    "components": {
                                        "type": "array",
                                        "minItems": 2,
                                        "maxItems": 3,
                                        "items": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                                    },
                                },
                            },
                            {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["kind", "alpha", "red", "green", "blue"],
                                "properties": {
                                    "kind": {"const": "color"},
                                    "alpha": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                                    "red": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                                    "green": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                                    "blue": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                                },
                            },
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
        "layerLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"const": "layer"}}},
            ]
        },
        "streamLocator": {
            "allOf": [
                {"$ref": "#/$defs/locatorBase"},
                {"properties": {"kind": {"const": "stream"}}},
            ]
        },
    },
    "x-invariant": (
        "returned-equals-properties-length-and-page-metadata-and-value-types-"
        "are-self-consistent"
    ),
}

_LAYER_PROPERTY_PRIMITIVE_VALUE_SCHEMA = {
    "oneOf": [
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "value"],
            "properties": {
                "kind": {"const": "scalar"},
                "value": _LAYER_PROPERTY_DECIMAL_SCHEMA,
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "components"],
            "properties": {
                "kind": {"const": "vector"},
                "components": {
                    "type": "array",
                    "minItems": 2,
                    "maxItems": 3,
                    "items": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                },
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "alpha", "red", "green", "blue"],
            "properties": {
                "kind": {"const": "color"},
                "alpha": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                "red": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                "green": _LAYER_PROPERTY_DECIMAL_SCHEMA,
                "blue": _LAYER_PROPERTY_DECIMAL_SCHEMA,
            },
        },
    ]
}

_LAYER_PROPERTY_SET_LOCATOR_DEFS = {
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
            "kind": {"enum": ["layer", "stream"]},
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
    "layerLocator": {
        "allOf": [
            {"$ref": "#/$defs/locatorBase"},
            {"properties": {"kind": {"const": "layer"}}},
        ]
    },
    "streamLocator": {
        "allOf": [
            {"$ref": "#/$defs/locatorBase"},
            {"properties": {"kind": {"const": "stream"}}},
        ]
    },
    "primitiveValue": _LAYER_PROPERTY_PRIMITIVE_VALUE_SCHEMA,
}

_LAYER_PROPERTY_SET_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "layerLocator",
        "propertyLocator",
        "value",
        "idempotencyKey",
    ],
    "properties": {
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "propertyLocator": {"$ref": "#/$defs/streamLocator"},
        "value": {"$ref": "#/$defs/primitiveValue"},
        "idempotencyKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 64,
            "pattern": _IDEMPOTENCY_KEY_PATTERN,
        },
    },
    "$defs": _LAYER_PROPERTY_SET_LOCATOR_DEFS,
    "x-invariant": "both-locators-must-share-one-host-session-project-generation",
}

_LAYER_PROPERTY_SET_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "changed",
        "layerLocator",
        "propertyLocator",
        "valueType",
        "beforeValue",
        "afterValue",
    ],
    "properties": {
        "changed": {"const": True},
        "layerLocator": {"$ref": "#/$defs/layerLocator"},
        "propertyLocator": {"$ref": "#/$defs/streamLocator"},
        "valueType": {
            "enum": [
                "one-d",
                "two-d",
                "two-d-spatial",
                "three-d",
                "three-d-spatial",
                "color",
            ]
        },
        "beforeValue": {"$ref": "#/$defs/primitiveValue"},
        "afterValue": {"$ref": "#/$defs/primitiveValue"},
    },
    "$defs": _LAYER_PROPERTY_SET_LOCATOR_DEFS,
    "x-invariant": (
        "beforeValue-must-differ-from-afterValue-and-values-must-match-valueType"
    ),
}

PROJECT_ITEMS_LIST_CONTRACT_DIGEST = (
    "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e"
)
COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST = (
    "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75"
)
SELECTED_COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST = (
    COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST
)
LAYER_PROPERTIES_LIST_CONTRACT_DIGEST = (
    "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba"
)
LAYER_PROPERTY_SET_CONTRACT_DIGEST = (
    "5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c"
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


class PositiveRatioTarget(_NativeModel):
    numerator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]
    denominator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]


class PositiveRatioValue(PositiveRatioTarget):
    rational: Annotated[
        StrictStr,
        Field(min_length=1, max_length=28, pattern=r"^[1-9][0-9]*(?:/[1-9][0-9]*)?$"),
    ]

    @model_validator(mode="after")
    def _exact_reduced_rational(self) -> "PositiveRatioValue":
        divisor = math.gcd(self.numerator, self.denominator)
        numerator = self.numerator // divisor
        denominator = self.denominator // divisor
        expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
        if self.rational != expected:
            raise ValueError("rational must be the exact reduced ratio")
        return self


class CompositionCreateArguments(_NativeModel):
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    width: Annotated[StrictInt, Field(ge=1, le=30_000)]
    height: Annotated[StrictInt, Field(ge=1, le=30_000)]
    duration: CompositionTimeTarget
    frame_rate: PositiveRatioTarget
    pixel_aspect_ratio: PositiveRatioTarget
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]

    @model_validator(mode="after")
    def _valid_create_shape(self) -> "CompositionCreateArguments":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        if self.duration.value <= 0:
            raise ValueError("duration must be positive")
        return self


class CompositionCreateValue(_NativeModel):
    changed: Literal[True]
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    composition_locator: NativeLocator
    project_item_count_before: NonNegativeInt
    project_item_count_after: PositiveInt
    layer_count: Literal[0]
    width: Annotated[StrictInt, Field(ge=1, le=30_000)]
    height: Annotated[StrictInt, Field(ge=1, le=30_000)]
    duration: CompositionCurrentTime
    frame_rate: PositiveRatioValue
    pixel_aspect_ratio: PositiveRatioValue

    @model_validator(mode="after")
    def _verified_create(self) -> "CompositionCreateValue":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        if self.project_item_count_after != self.project_item_count_before + 1:
            raise ValueError("native composition create must add exactly one project item")
        if self.duration.value <= 0:
            raise ValueError("created composition duration must be positive")
        return self


class CompositionCreateExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]
    replayed: StrictBool
    value: CompositionCreateValue
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


class CompositionLayerCreateColor(_NativeModel):
    red: Annotated[StrictInt, Field(ge=0, le=255)]
    green: Annotated[StrictInt, Field(ge=0, le=255)]
    blue: Annotated[StrictInt, Field(ge=0, le=255)]
    alpha: Annotated[StrictInt, Field(ge=0, le=255)]


class CompositionLayerCreateArguments(_NativeModel):
    composition_locator: NativeLocator
    kind: Literal["null", "solid"]
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    color: CompositionLayerCreateColor | None = None
    width: Annotated[StrictInt, Field(ge=1, le=30_000)] | None = None
    height: Annotated[StrictInt, Field(ge=1, le=30_000)] | None = None
    duration: CompositionTimeTarget | None = None
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]

    @model_validator(mode="after")
    def _closed_create_shape(self) -> "CompositionLayerCreateArguments":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        if self.kind == "null" and any(
            value is not None
            for value in (self.color, self.width, self.height, self.duration)
        ):
            raise ValueError("solid-only fields require kind solid")
        return self


class CompositionLayerSolidSpec(_NativeModel):
    color: CompositionLayerCreateColor
    width: Annotated[StrictInt, Field(ge=1, le=30_000)]
    height: Annotated[StrictInt, Field(ge=1, le=30_000)]
    duration: CompositionCurrentTime


class CompositionLayerCreateValue(_NativeModel):
    changed: Literal[True]
    kind: Literal["null", "solid"]
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    stack_index: PositiveInt
    composition_locator: NativeLocator
    layer_locator: NativeLocator
    source_item_locator: NativeLocator | None
    layer_count_before: NonNegativeInt
    layer_count_after: PositiveInt
    project_item_count_before: NonNegativeInt
    project_item_count_after: NonNegativeInt
    solid: CompositionLayerSolidSpec | None

    @model_validator(mode="after")
    def _verified_create(self) -> "CompositionLayerCreateValue":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must have kind composition")
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        context = self.composition_locator.context()
        if self.layer_locator.context() != context:
            raise ValueError("created layer locator escaped the composition context")
        if self.source_item_locator is not None:
            if self.source_item_locator.kind not in {"item", "composition"}:
                raise ValueError("sourceItemLocator must identify a project item")
            if self.source_item_locator.context() != context:
                raise ValueError("source item locator escaped the composition context")
        if self.layer_count_after != self.layer_count_before + 1:
            raise ValueError("native create must add exactly one composition layer")
        if self.stack_index > self.layer_count_after:
            raise ValueError("created layer stackIndex exceeds the new layer count")
        if self.project_item_count_after < self.project_item_count_before:
            raise ValueError("native create unexpectedly reduced the project item count")
        if self.kind == "solid":
            if self.solid is None or self.source_item_locator is None:
                raise ValueError("solid creation requires verified source and solid metadata")
            if self.project_item_count_after <= self.project_item_count_before:
                raise ValueError("solid creation did not add a project item")
        elif self.solid is not None:
            raise ValueError("null creation cannot return solid metadata")
        return self


class CompositionLayerCreateExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]
    replayed: StrictBool
    value: CompositionLayerCreateValue
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


class LayerEffectApplyArguments(_NativeModel):
    layer_locator: NativeLocator
    effect_match_name: Annotated[StrictStr, Field(min_length=1, max_length=47)]
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]

    @model_validator(mode="after")
    def _closed_apply_shape(self) -> "LayerEffectApplyArguments":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        if any(
            0xD800 <= ord(character) <= 0xDFFF
            for character in self.effect_match_name
        ):
            raise ValueError("effectMatchName must contain only Unicode scalar values")
        return self


class LayerEffectApplyValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    name: Annotated[StrictStr, Field(min_length=1, max_length=47)]
    match_name: Annotated[StrictStr, Field(min_length=1, max_length=47)]
    effect_index: PositiveInt
    effect_count_before: NonNegativeInt
    effect_count_after: PositiveInt
    matching_effect_count_before: NonNegativeInt
    matching_effect_count_after: PositiveInt

    @model_validator(mode="after")
    def _verified_apply(self) -> "LayerEffectApplyValue":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        if self.effect_count_after != self.effect_count_before + 1:
            raise ValueError("native apply must add exactly one layer effect")
        if self.matching_effect_count_after != self.matching_effect_count_before + 1:
            raise ValueError("native apply must add exactly one matching effect")
        if self.effect_index > self.effect_count_after:
            raise ValueError("effectIndex exceeds the post-mutation effect count")
        if self.matching_effect_count_after > self.effect_count_after:
            raise ValueError("matching effect count exceeds total effects")
        return self


class LayerEffectApplyExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]
    replayed: StrictBool
    value: LayerEffectApplyValue
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


class LayerPropertySetArguments(_NativeModel):
    layer_locator: NativeLocator
    property_locator: NativeLocator
    value: LayerPropertyPrimitiveValue
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]

    @model_validator(mode="after")
    def _verified_locators(self) -> "LayerPropertySetArguments":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        if self.property_locator.kind != "stream":
            raise ValueError("propertyLocator must have kind stream")
        if self.layer_locator.context() != self.property_locator.context():
            raise ValueError("propertyLocator must belong to the layer context")
        return self


class LayerPropertySetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    property_locator: NativeLocator
    value_type: Literal[
        "one-d",
        "two-d",
        "two-d-spatial",
        "three-d",
        "three-d-spatial",
        "color",
    ]
    before_value: LayerPropertyPrimitiveValue
    after_value: LayerPropertyPrimitiveValue

    @model_validator(mode="after")
    def _verified_transition(self) -> "LayerPropertySetValue":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must have kind layer")
        if self.property_locator.kind != "stream":
            raise ValueError("propertyLocator must have kind stream")
        if self.layer_locator.context() != self.property_locator.context():
            raise ValueError("propertyLocator must belong to the layer context")
        expected_kind = (
            "scalar"
            if self.value_type == "one-d"
            else "color"
            if self.value_type == "color"
            else "vector"
        )
        for label, value in (
            ("beforeValue", self.before_value),
            ("afterValue", self.after_value),
        ):
            if value.kind != expected_kind:
                raise ValueError(f"{label} does not match valueType")
            if isinstance(value, LayerPropertyVectorValue):
                expected_components = (
                    2
                    if self.value_type in {"two-d", "two-d-spatial"}
                    else 3
                )
                if len(value.components) != expected_components:
                    raise ValueError(f"{label} does not match valueType")
        if _layer_property_values_binary_equal(
            self.before_value, self.after_value
        ):
            raise ValueError("layer property value did not change")
        return self


class LayerPropertySetExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: Annotated[
        StrictStr,
        Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
    ]
    replayed: StrictBool
    value: LayerPropertySetValue
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
    recovery_hint: str | None = None,
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
            hint=recovery_hint or hints.get(
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


def _validate_selected_composition_layers_list_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    _validate_navigation_descriptor(
        descriptor,
        host_platform=host_platform,
        capability_id=SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
        capability_version=SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION,
        summary=(
            "List a bounded page of selected layers in one After Effects "
            "composition."
        ),
        side_effect_summary=(
            "Reads selected composition layers without changing After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
        ),
        input_contract_id=SELECTED_COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID,
        result_contract_id=SELECTED_COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID,
        contract_digest=SELECTED_COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST,
        input_schema=_SELECTED_COMPOSITION_LAYERS_LIST_INPUT_SCHEMA,
        result_schema=_SELECTED_COMPOSITION_LAYERS_LIST_RESULT_SCHEMA,
        requirement_id=(
            "aemcp.requirement.native.composition-selected-layers-list"
        ),
    )


def _validate_composition_time_read_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    _validate_navigation_descriptor(
        descriptor,
        host_platform=host_platform,
        capability_id=COMPOSITION_TIME_READ_CAPABILITY_ID,
        capability_version=COMPOSITION_TIME_READ_CAPABILITY_VERSION,
        summary="Read the current time of one After Effects composition.",
        side_effect_summary=(
            "Reads composition time without changing After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
        ),
        input_contract_id=COMPOSITION_TIME_READ_INPUT_CONTRACT_ID,
        result_contract_id=COMPOSITION_TIME_READ_RESULT_CONTRACT_ID,
        contract_digest=COMPOSITION_TIME_READ_CONTRACT_DIGEST,
        input_schema=_COMPOSITION_TIME_READ_INPUT_SCHEMA,
        result_schema=_COMPOSITION_TIME_READ_RESULT_SCHEMA,
        requirement_id="aemcp.requirement.native.composition-time-read",
    )


def _validate_composition_time_set_descriptor(
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
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == COMPOSITION_TIME_SET_CAPABILITY_ID
        and descriptor.capability_version == COMPOSITION_TIME_SET_CAPABILITY_VERSION
        and descriptor.engine == "native-aegp"
        and descriptor.summary
        == "Set the current time of one After Effects composition."
        and descriptor.risk == "write"
        and descriptor.mutability == "mutating"
        and descriptor.idempotency == "idempotency-key"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "ae-undo-group"
        and descriptor.side_effect_summary
        == "Changes composition current time and creates one After Effects Undo step."
        and descriptor.preconditions
        == (
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
            "targetTime must differ from the composition's current time.",
        )
        and descriptor.input_contract_id == COMPOSITION_TIME_SET_INPUT_CONTRACT_ID
        and descriptor.result_contract_id == COMPOSITION_TIME_SET_RESULT_CONTRACT_ID
        and descriptor.contract_digest == COMPOSITION_TIME_SET_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _COMPOSITION_TIME_SET_INPUT_SCHEMA
        and descriptor.result_schema == _COMPOSITION_TIME_SET_RESULT_SCHEMA
        and requirements
        == (("aemcp.requirement.native.composition-time-set", 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.composition.time.set contract does not match Core.",
        )


def _validate_composition_create_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    schemas_digest = _sha256_closed_json(
        {"inputSchema": descriptor.input_schema, "resultSchema": descriptor.result_schema}
    )
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == COMPOSITION_CREATE_CAPABILITY_ID
        and descriptor.capability_version == COMPOSITION_CREATE_CAPABILITY_VERSION
        and descriptor.schema_version == 1
        and descriptor.engine == "native-aegp"
        and descriptor.summary == "Create one root composition in After Effects."
        and descriptor.risk == "write"
        and descriptor.mutability == "mutating"
        and descriptor.idempotency == "idempotency-key"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "ae-undo-group"
        and descriptor.side_effect_summary
        == "Creates one root composition and one After Effects Undo step."
        and descriptor.preconditions == ("An After Effects project must be open.",)
        and descriptor.input_contract_id == COMPOSITION_CREATE_INPUT_CONTRACT_ID
        and descriptor.result_contract_id == COMPOSITION_CREATE_RESULT_CONTRACT_ID
        and descriptor.contract_digest == COMPOSITION_CREATE_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _COMPOSITION_CREATE_INPUT_SCHEMA
        and descriptor.result_schema == _COMPOSITION_CREATE_RESULT_SCHEMA
        and requirements == (("aemcp.requirement.native.composition-create", 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.composition.create contract does not match Core.",
        )


def _validate_composition_layer_create_descriptor(
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
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == COMPOSITION_LAYER_CREATE_CAPABILITY_ID
        and descriptor.capability_version == COMPOSITION_LAYER_CREATE_CAPABILITY_VERSION
        and descriptor.schema_version == 1
        and descriptor.engine == "native-aegp"
        and descriptor.summary
        == "Create one null or solid layer in an After Effects composition."
        and descriptor.risk == "write"
        and descriptor.mutability == "mutating"
        and descriptor.idempotency == "idempotency-key"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "ae-undo-group"
        and descriptor.side_effect_summary
        == "Creates one composition layer, may create one solid project item, and creates one After Effects Undo step."
        and descriptor.preconditions
        == (
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
            "kind must be null or solid and solid-only options require kind solid.",
        )
        and descriptor.input_contract_id == COMPOSITION_LAYER_CREATE_INPUT_CONTRACT_ID
        and descriptor.result_contract_id == COMPOSITION_LAYER_CREATE_RESULT_CONTRACT_ID
        and descriptor.contract_digest == COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _COMPOSITION_LAYER_CREATE_INPUT_SCHEMA
        and descriptor.result_schema == _COMPOSITION_LAYER_CREATE_RESULT_SCHEMA
        and requirements
        == (("aemcp.requirement.native.composition-layer-create", 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.composition.layer.create contract does not match Core.",
        )


def _validate_layer_effect_apply_descriptor(
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
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == LAYER_EFFECT_APPLY_CAPABILITY_ID
        and descriptor.capability_version == LAYER_EFFECT_APPLY_CAPABILITY_VERSION
        and descriptor.schema_version == 1
        and descriptor.engine == "native-aegp"
        and descriptor.summary
        == "Apply one installed After Effects effect to a layer by exact match name."
        and descriptor.risk == "write"
        and descriptor.mutability == "mutating"
        and descriptor.idempotency == "idempotency-key"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "ae-undo-group"
        and descriptor.side_effect_summary
        == "Adds one installed effect to one layer and creates one After Effects Undo step."
        and descriptor.preconditions
        == (
            "An After Effects project must be open.",
            "layerLocator must come from ae.composition.layers.list@1.",
            "effectMatchName must exactly identify one installed effect.",
        )
        and descriptor.input_contract_id == LAYER_EFFECT_APPLY_INPUT_CONTRACT_ID
        and descriptor.result_contract_id == LAYER_EFFECT_APPLY_RESULT_CONTRACT_ID
        and descriptor.contract_digest == LAYER_EFFECT_APPLY_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _LAYER_EFFECT_APPLY_INPUT_SCHEMA
        and descriptor.result_schema == _LAYER_EFFECT_APPLY_RESULT_SCHEMA
        and requirements == (("aemcp.requirement.native.layer-effect-apply", 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.layer.effect.apply contract does not match Core.",
        )


def _validate_layer_properties_list_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
) -> None:
    _validate_navigation_descriptor(
        descriptor,
        host_platform=host_platform,
        capability_id=LAYER_PROPERTIES_LIST_CAPABILITY_ID,
        capability_version=LAYER_PROPERTIES_LIST_CAPABILITY_VERSION,
        summary=(
            "List a bounded page of direct properties on an After Effects layer "
            "or property group."
        ),
        side_effect_summary=(
            "Reads layer properties and safe primitive values without changing "
            "After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "layerLocator must come from ae.composition.layers.list@1.",
            "parentPropertyLocator must come from ae.layer.properties.list@1 "
            "for the same layer.",
        ),
        input_contract_id=LAYER_PROPERTIES_LIST_INPUT_CONTRACT_ID,
        result_contract_id=LAYER_PROPERTIES_LIST_RESULT_CONTRACT_ID,
        contract_digest=LAYER_PROPERTIES_LIST_CONTRACT_DIGEST,
        input_schema=_LAYER_PROPERTIES_LIST_INPUT_SCHEMA,
        result_schema=_LAYER_PROPERTIES_LIST_RESULT_SCHEMA,
        requirement_id="aemcp.requirement.native.layer-properties-list",
    )


def _validate_layer_property_set_descriptor(
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
    requirements = tuple(
        (requirement.id, requirement.contract_version)
        for requirement in descriptor.requirements
    )
    expected = (
        descriptor.capability_id == LAYER_PROPERTY_SET_CAPABILITY_ID
        and descriptor.capability_version == LAYER_PROPERTY_SET_CAPABILITY_VERSION
        and descriptor.schema_version == 1
        and descriptor.engine == "native-aegp"
        and descriptor.summary
        == "Set one non-keyframed primitive After Effects layer property value."
        and descriptor.risk == "write"
        and descriptor.mutability == "mutating"
        and descriptor.idempotency == "idempotency-key"
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == "ae-undo-group"
        and descriptor.side_effect_summary
        == "Changes one primitive layer property and creates one After Effects Undo step."
        and descriptor.preconditions
        == (
            "An After Effects project must be open.",
            "Both locators must come from ae.layer.properties.list@1 for the same layer.",
            "The property must be a non-keyframed scalar, vector, or color leaf stream.",
            "value must differ from the property's current sampled value.",
        )
        and descriptor.input_contract_id == LAYER_PROPERTY_SET_INPUT_CONTRACT_ID
        and descriptor.result_contract_id == LAYER_PROPERTY_SET_RESULT_CONTRACT_ID
        and descriptor.contract_digest == LAYER_PROPERTY_SET_CONTRACT_DIGEST
        and schemas_digest == descriptor.contract_digest
        and descriptor.input_schema == _LAYER_PROPERTY_SET_INPUT_SCHEMA
        and descriptor.result_schema == _LAYER_PROPERTY_SET_RESULT_SCHEMA
        and requirements
        == (("aemcp.requirement.native.layer-property-set", 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Negotiated ae.layer.property.set contract does not match Core.",
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


def _selected_composition_layers_list_digest(
    value: SelectedCompositionLayersListValue,
) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
            "capabilityVersion": (
                SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION
            ),
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _composition_time_read_digest(value: CompositionTimeReadValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": COMPOSITION_TIME_READ_CAPABILITY_ID,
            "capabilityVersion": COMPOSITION_TIME_READ_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _composition_time_set_digest(value: CompositionTimeSetValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": COMPOSITION_TIME_SET_CAPABILITY_ID,
            "capabilityVersion": COMPOSITION_TIME_SET_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _composition_create_digest(value: CompositionCreateValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": COMPOSITION_CREATE_CAPABILITY_ID,
            "capabilityVersion": COMPOSITION_CREATE_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _composition_layer_create_digest(value: CompositionLayerCreateValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": COMPOSITION_LAYER_CREATE_CAPABILITY_ID,
            "capabilityVersion": COMPOSITION_LAYER_CREATE_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _layer_effect_apply_digest(value: LayerEffectApplyValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": LAYER_EFFECT_APPLY_CAPABILITY_ID,
            "capabilityVersion": LAYER_EFFECT_APPLY_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _layer_properties_list_digest(value: LayerPropertiesListValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": LAYER_PROPERTIES_LIST_CAPABILITY_ID,
            "capabilityVersion": LAYER_PROPERTIES_LIST_CAPABILITY_VERSION,
            "value": value.model_dump(mode="json", by_alias=True),
        }
    )


def _layer_property_set_digest(value: LayerPropertySetValue) -> str:
    return _sha256_closed_json(
        {
            "capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID,
            "capabilityVersion": LAYER_PROPERTY_SET_CAPABILITY_VERSION,
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
    additional_locators: tuple[tuple[NativeLocator, str], ...] = (),
    stale_locator_hint: str | None = None,
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
    bound_locators = additional_locators
    if locator is not None:
        bound_locators = ((locator, locator_field), *bound_locators)
    for bound_locator, bound_field in bound_locators:
        if (
            bound_locator.host_instance_id != negotiation.host_instance_id
            or bound_locator.session_id != negotiation.session_id
        ):
            raise _structured_error(
                "STALE_LOCATOR",
                "Native locator does not belong to the negotiated host session.",
                details={
                    "field": bound_field,
                    "capabilityId": capability_id,
                },
                recovery_hint=stale_locator_hint,
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


async def invoke_layer_property_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    value: LayerPropertyPrimitiveValue | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerPropertySetExecution:
    """Set one non-keyframed primitive stream through the native plane only."""

    stale_hint = (
        "Discard both locators, then call ae_listProjectItems, "
        "ae_listCompositionLayers, and ae_listLayerProperties again."
    )
    try:
        parsed_layer_locator = NativeLocator.model_validate(layer_locator)
        parsed_property_locator = NativeLocator.model_validate(property_locator)
    except ValidationError as exc:
        raise _structured_error(
            "INVALID_ARGUMENT",
            "Layer-property locators did not match the published contract.",
            details={"capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID},
            recovery_hint="Copy both locators from ae_listLayerProperties.",
        ) from exc
    if parsed_layer_locator.context() != parsed_property_locator.context():
        raise _structured_error(
            "STALE_LOCATOR",
            "propertyLocator does not belong to the layer locator context.",
            details={
                "field": "params.arguments.propertyLocator",
                "capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID,
            },
            recovery_hint=stale_hint,
        )
    try:
        arguments = LayerPropertySetArguments(
            layer_locator=parsed_layer_locator,
            property_locator=parsed_property_locator,
            value=value,
            idempotency_key=idempotency_key,
        )
    except ValidationError as exc:
        raise _structured_error(
            "INVALID_ARGUMENT",
            "Layer-property write arguments did not match the published contract.",
            details={"capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID},
            recovery_hint=(
                "Use fresh locators, a matching scalar/vector/color value, and a "
                "stable idempotency key of 16 to 64 characters."
            ),
        ) from exc
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
        if item.capability_id == LAYER_PROPERTY_SET_CAPABILITY_ID
        and item.capability_version == LAYER_PROPERTY_SET_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.layer.property.set@1.",
        )
    _validate_layer_property_set_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    for locator, field in (
        (arguments.layer_locator, "params.arguments.layerLocator"),
        (arguments.property_locator, "params.arguments.propertyLocator"),
    ):
        if (
            locator.host_instance_id != negotiation.host_instance_id
            or locator.session_id != negotiation.session_id
        ):
            raise _structured_error(
                "STALE_LOCATOR",
                "Native locator does not belong to the negotiated host session.",
                details={
                    "field": field,
                    "capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID,
                },
                recovery_hint=stale_hint,
            )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=LAYER_PROPERTY_SET_CAPABILITY_ID,
        capability_version=LAYER_PROPERTY_SET_CAPABILITY_VERSION,
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
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native layer-property result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=(
                    "Read the property with fresh locators and inspect the Undo "
                    "stack before issuing any new write."
                ),
            ),
            details={"capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID},
        )
    try:
        changed_value = LayerPropertySetValue.model_validate(result.value)
        postcondition_digest = _layer_property_set_digest(changed_value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native layer-property value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=(
                    "Read the property with fresh locators and inspect the Undo "
                    "stack before issuing any new write."
                ),
            ),
            details={"capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID},
        ) from exc
    if (
        changed_value.layer_locator != arguments.layer_locator
        or changed_value.property_locator != arguments.property_locator
        or not _layer_property_values_binary_equal(
            changed_value.after_value, arguments.value
        )
        or result.evidence.postcondition.kind != "layer-property-set"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native layer-property postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=(
                    "Read the property with fresh locators and inspect the Undo "
                    "stack before issuing any new write."
                ),
            ),
            details={"capabilityId": LAYER_PROPERTY_SET_CAPABILITY_ID},
        )
    return LayerPropertySetExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=changed_value,
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


async def invoke_selected_composition_layers_list(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    offset: int,
    limit: int,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> SelectedCompositionLayersListExecution:
    """List selected layers for one exact composition locator without JSX."""

    arguments = SelectedCompositionLayersListArguments(
        composition_locator=composition_locator,
        offset=offset,
        limit=limit,
    )
    wire_arguments = arguments.model_dump(mode="json", by_alias=True)
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
        capability_version=SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION,
        arguments=wire_arguments,
        locator=arguments.composition_locator,
        locator_field="params.arguments.compositionLocator",
        stale_locator_hint=(
            "Discard the stale composition locator, then call "
            "ae_listProjectItems and copy a fresh composition locator."
        ),
        descriptor_validator=_validate_selected_composition_layers_list_descriptor,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = SelectedCompositionLayersListValue.model_validate(result.value)
        postcondition_digest = _selected_composition_layers_list_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native selected-layer page did not match its typed contract.",
        ) from exc
    if (
        value.composition_locator != arguments.composition_locator
        or value.offset != arguments.offset
        or value.limit != arguments.limit
        or value.composition_locator.host_instance_id
        != negotiation.host_instance_id
        or value.composition_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind
        != "composition-selected-layers-list"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native selected-layer page was not bound to its request and evidence.",
        )
    return SelectedCompositionLayersListExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


async def invoke_composition_time_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionTimeReadExecution:
    """Read one composition's exact current time without consulting JSX."""

    arguments = CompositionTimeReadArguments(
        composition_locator=composition_locator,
    )
    wire_arguments = arguments.model_dump(mode="json", by_alias=True)
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=COMPOSITION_TIME_READ_CAPABILITY_ID,
        capability_version=COMPOSITION_TIME_READ_CAPABILITY_VERSION,
        arguments=wire_arguments,
        locator=arguments.composition_locator,
        locator_field="params.arguments.compositionLocator",
        stale_locator_hint=(
            "Discard the stale composition locator, then call "
            "ae_listProjectItems and copy a fresh composition locator."
        ),
        descriptor_validator=_validate_composition_time_read_descriptor,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = CompositionTimeReadValue.model_validate(result.value)
        postcondition_digest = _composition_time_read_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native composition time did not match its typed contract.",
        ) from exc
    if (
        value.composition_locator != arguments.composition_locator
        or value.composition_locator.host_instance_id
        != negotiation.host_instance_id
        or value.composition_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind != "composition-time-read"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native composition time was not bound to its request and evidence.",
        )
    return CompositionTimeReadExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


async def invoke_composition_time_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    target_time: CompositionTimeTarget | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionTimeSetExecution:
    """Set one composition's exact current time without consulting JSX."""

    stale_hint = (
        "Discard the stale composition locator, then call "
        "ae_listProjectItems and copy a fresh composition locator."
    )
    try:
        arguments = CompositionTimeSetArguments(
            composition_locator=composition_locator,
            target_time=target_time,
            idempotency_key=idempotency_key,
        )
    except ValidationError as exc:
        raise _structured_error(
            "INVALID_ARGUMENT",
            "Composition-time write arguments did not match the published contract.",
            details={"capabilityId": COMPOSITION_TIME_SET_CAPABILITY_ID},
            recovery_hint=(
                "Use a fresh composition locator, an int32 value, a positive "
                "uint32 scale, and a stable 16 to 64 character idempotency key."
            ),
        ) from exc
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
        if item.capability_id == COMPOSITION_TIME_SET_CAPABILITY_ID
        and item.capability_version == COMPOSITION_TIME_SET_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.composition.time.set@1.",
        )
    _validate_composition_time_set_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    locator = arguments.composition_locator
    if (
        locator.host_instance_id != negotiation.host_instance_id
        or locator.session_id != negotiation.session_id
    ):
        raise _structured_error(
            "STALE_LOCATOR",
            "Native locator does not belong to the negotiated host session.",
            details={
                "field": "params.arguments.compositionLocator",
                "capabilityId": COMPOSITION_TIME_SET_CAPABILITY_ID,
            },
            recovery_hint=stale_hint,
        )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=COMPOSITION_TIME_SET_CAPABILITY_ID,
        capability_version=COMPOSITION_TIME_SET_CAPABILITY_VERSION,
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
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-time result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=(
                    "Read the composition time with a fresh locator and inspect "
                    "the Undo stack before issuing another write."
                ),
            ),
            details={"capabilityId": COMPOSITION_TIME_SET_CAPABILITY_ID},
        )
    try:
        changed_value = CompositionTimeSetValue.model_validate(result.value)
        postcondition_digest = _composition_time_set_digest(changed_value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-time value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=(
                    "Read the composition time with a fresh locator and inspect "
                    "the Undo stack before issuing another write."
                ),
            ),
            details={"capabilityId": COMPOSITION_TIME_SET_CAPABILITY_ID},
        ) from exc
    if (
        changed_value.composition_locator != arguments.composition_locator
        or not _composition_times_equal(
            changed_value.after_time, arguments.target_time
        )
        or result.evidence.postcondition.kind != "composition-time-set"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-time postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=(
                    "Read the composition time with a fresh locator and inspect "
                    "the Undo stack before issuing another write."
                ),
            ),
            details={"capabilityId": COMPOSITION_TIME_SET_CAPABILITY_ID},
        )
    return CompositionTimeSetExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=changed_value,
        evidence=result.evidence,
    )


async def invoke_composition_create(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    name: str,
    width: int,
    height: int,
    duration: CompositionTimeTarget | Mapping[str, Any],
    frame_rate: PositiveRatioTarget | Mapping[str, Any],
    pixel_aspect_ratio: PositiveRatioTarget | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionCreateExecution:
    """Create one root composition through the negotiated native AEGP plane."""

    inspect_hint = (
        "Call ae_listProjectItems and inspect the After Effects Undo stack before "
        "issuing another composition create."
    )
    try:
        arguments = CompositionCreateArguments(
            name=name,
            width=width,
            height=height,
            duration=duration,
            frame_rate=frame_rate,
            pixel_aspect_ratio=pixel_aspect_ratio,
            idempotency_key=idempotency_key,
        )
    except ValidationError as exc:
        raise _structured_error(
            "INVALID_ARGUMENT",
            "Composition create arguments did not match the published contract.",
            details={"capabilityId": COMPOSITION_CREATE_CAPABILITY_ID},
            recovery_hint=(
                "Provide a bounded Unicode name, 1 to 30000 dimensions, positive "
                "exact duration and ratios, and a stable 16 to 64 character key."
            ),
        ) from exc

    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(
        deadline_unix_ms=deadline_unix_ms, cancellation=cancellation
    )
    _ensure_active(deadline_unix_ms, cancellation)
    capabilities = await backend.capabilities(
        ids=None,
        detail="full",
        limit=100,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    expected_query_digest = _capabilities_query_digest(
        session_id=negotiation.session_id, ids=None, detail="full", limit=100
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
        or capabilities.detail != "full"
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
        if item.capability_id == COMPOSITION_CREATE_CAPABILITY_ID
        and item.capability_version == COMPOSITION_CREATE_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.composition.create@1.",
        )
    _validate_composition_create_descriptor(
        descriptor, host_platform=negotiation.host_platform
    )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=COMPOSITION_CREATE_CAPABILITY_ID,
        capability_version=COMPOSITION_CREATE_CAPABILITY_VERSION,
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
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "committed"
        or undo is None
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-create result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": COMPOSITION_CREATE_CAPABILITY_ID},
        )
    try:
        created = CompositionCreateValue.model_validate(result.value)
        postcondition_digest = _composition_create_digest(created)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-create value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": COMPOSITION_CREATE_CAPABILITY_ID},
        ) from exc

    def _ratio_matches(value: PositiveRatioValue, target: PositiveRatioTarget) -> bool:
        return value.numerator * target.denominator == target.numerator * value.denominator

    if (
        created.name != arguments.name
        or created.width != arguments.width
        or created.height != arguments.height
        or not _composition_times_equal(created.duration, arguments.duration)
        or not _ratio_matches(created.frame_rate, arguments.frame_rate)
        or not _ratio_matches(created.pixel_aspect_ratio, arguments.pixel_aspect_ratio)
        or created.composition_locator.host_instance_id != negotiation.host_instance_id
        or created.composition_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind != "composition-create"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-create postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": COMPOSITION_CREATE_CAPABILITY_ID},
        )
    if result.replayed:
        try:
            replay_check = await invoke_composition_layers_list(
                backend,
                request_id=(
                    "replay-check-"
                    + hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:32]
                ),
                composition_locator=created.composition_locator,
                offset=0,
                limit=1,
                deadline_unix_ms=deadline_unix_ms,
                cancellation=cancellation,
            )
        except NativeBackendError as exc:
            raise _structured_error(
                "DUPLICATE_REQUEST",
                "The committed composition-create key no longer identifies "
                "a verifiable composition in the current After Effects state.",
                details={
                    "field": "params.arguments.idempotencyKey",
                    "capabilityId": COMPOSITION_CREATE_CAPABILITY_ID,
                },
                recovery_hint=inspect_hint,
            ) from exc
        if (
            replay_check.value.composition_locator
            != created.composition_locator
            or replay_check.value.composition_name != created.name
        ):
            raise _structured_error(
                "DUPLICATE_REQUEST",
                "The committed composition-create key no longer matches the "
                "current After Effects composition identity.",
                details={
                    "field": "params.arguments.idempotencyKey",
                    "capabilityId": COMPOSITION_CREATE_CAPABILITY_ID,
                },
                recovery_hint=inspect_hint,
            )
    return CompositionCreateExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=created,
        evidence=result.evidence,
    )


async def invoke_composition_layer_create(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    kind: Literal["null", "solid"],
    name: str,
    color: CompositionLayerCreateColor | Mapping[str, Any] | None,
    width: int | None,
    height: int | None,
    duration: CompositionTimeTarget | Mapping[str, Any] | None,
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionLayerCreateExecution:
    """Create one null/solid layer through the negotiated native AEGP plane."""

    stale_hint = (
        "Discard the stale composition locator, call ae_listProjectItems, "
        "and copy a fresh composition locator."
    )
    inspect_hint = (
        "Call ae_listProjectItems and ae_listCompositionLayers with fresh "
        "locators, then inspect the Undo stack before issuing another create."
    )
    try:
        arguments = CompositionLayerCreateArguments(
            composition_locator=composition_locator,
            kind=kind,
            name=name,
            color=color,
            width=width,
            height=height,
            duration=duration,
            idempotency_key=idempotency_key,
        )
    except ValidationError as exc:
        raise _structured_error(
            "INVALID_ARGUMENT",
            "Composition-layer create arguments did not match the published contract.",
            details={"capabilityId": COMPOSITION_LAYER_CREATE_CAPABILITY_ID},
            recovery_hint=(
                "Use a fresh composition locator, kind null or solid, a bounded "
                "name, solid-only options when needed, and a stable 16 to 64 "
                "character idempotency key."
            ),
        ) from exc

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
        if item.capability_id == COMPOSITION_LAYER_CREATE_CAPABILITY_ID
        and item.capability_version == COMPOSITION_LAYER_CREATE_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.composition.layer.create@1.",
        )
    _validate_composition_layer_create_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    locator = arguments.composition_locator
    if (
        locator.host_instance_id != negotiation.host_instance_id
        or locator.session_id != negotiation.session_id
    ):
        raise _structured_error(
            "STALE_LOCATOR",
            "Native locator does not belong to the negotiated host session.",
            details={
                "field": "params.arguments.compositionLocator",
                "capabilityId": COMPOSITION_LAYER_CREATE_CAPABILITY_ID,
            },
            recovery_hint=stale_hint,
        )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=COMPOSITION_LAYER_CREATE_CAPABILITY_ID,
        capability_version=COMPOSITION_LAYER_CREATE_CAPABILITY_VERSION,
        arguments=arguments.model_dump(
            mode="json", by_alias=True, exclude_none=True
        ),
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
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "committed"
        or undo is None
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-layer result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": COMPOSITION_LAYER_CREATE_CAPABILITY_ID},
        )
    try:
        created = CompositionLayerCreateValue.model_validate(result.value)
        postcondition_digest = _composition_layer_create_digest(created)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-layer value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": COMPOSITION_LAYER_CREATE_CAPABILITY_ID},
        ) from exc

    solid_matches = True
    if arguments.kind == "solid":
        solid_matches = created.solid is not None
        if solid_matches and arguments.color is not None:
            solid_matches = created.solid.color == arguments.color
        if solid_matches and arguments.width is not None:
            solid_matches = created.solid.width == arguments.width
        if solid_matches and arguments.height is not None:
            solid_matches = created.solid.height == arguments.height
        if solid_matches and arguments.duration is not None:
            solid_matches = _composition_times_equal(
                created.solid.duration, arguments.duration
            )
    if (
        created.kind != arguments.kind
        or created.name != arguments.name
        or created.composition_locator.host_instance_id
        != negotiation.host_instance_id
        or created.composition_locator.session_id != negotiation.session_id
        or created.composition_locator.generation <= locator.generation
        or created.composition_locator.project_id == locator.project_id
        or not solid_matches
        or result.evidence.postcondition.kind != "composition-layer-create"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native composition-layer postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": COMPOSITION_LAYER_CREATE_CAPABILITY_ID},
        )
    return CompositionLayerCreateExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=created,
        evidence=result.evidence,
    )


async def invoke_layer_effect_apply(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    effect_match_name: str,
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerEffectApplyExecution:
    """Apply one installed effect through the negotiated native AEGP plane."""

    stale_hint = (
        "Discard the stale layer locator, call ae_listProjectItems and "
        "ae_listCompositionLayers, then copy a fresh layer locator."
    )
    inspect_hint = (
        "Call ae_listProjectItems, ae_listCompositionLayers, and "
        "ae_listLayerProperties with fresh locators, then inspect the layer's "
        "Effects group and Undo stack before issuing another apply."
    )
    try:
        arguments = LayerEffectApplyArguments(
            layer_locator=layer_locator,
            effect_match_name=effect_match_name,
            idempotency_key=idempotency_key,
        )
    except ValidationError as exc:
        raise _structured_error(
            "INVALID_ARGUMENT",
            "Layer-effect apply arguments did not match the published contract.",
            details={"capabilityId": LAYER_EFFECT_APPLY_CAPABILITY_ID},
            recovery_hint=(
                "Use a fresh layer locator, an exact installed effect match name "
                "of at most 47 characters, and a stable 16 to 64 character "
                "idempotency key."
            ),
        ) from exc

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
        if item.capability_id == LAYER_EFFECT_APPLY_CAPABILITY_ID
        and item.capability_version == LAYER_EFFECT_APPLY_CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            "Native host did not advertise ae.layer.effect.apply@1.",
        )
    _validate_layer_effect_apply_descriptor(
        descriptor,
        host_platform=negotiation.host_platform,
    )
    locator = arguments.layer_locator
    if (
        locator.host_instance_id != negotiation.host_instance_id
        or locator.session_id != negotiation.session_id
    ):
        raise _structured_error(
            "STALE_LOCATOR",
            "Native locator does not belong to the negotiated host session.",
            details={
                "field": "params.arguments.layerLocator",
                "capabilityId": LAYER_EFFECT_APPLY_CAPABILITY_ID,
            },
            recovery_hint=stale_hint,
        )
    _ensure_active(deadline_unix_ms, cancellation)

    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=LAYER_EFFECT_APPLY_CAPABILITY_ID,
        capability_version=LAYER_EFFECT_APPLY_CAPABILITY_VERSION,
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
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "committed"
        or undo is None
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native layer-effect result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": LAYER_EFFECT_APPLY_CAPABILITY_ID},
        )
    try:
        applied = LayerEffectApplyValue.model_validate(result.value)
        postcondition_digest = _layer_effect_apply_digest(applied)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native layer-effect value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": LAYER_EFFECT_APPLY_CAPABILITY_ID},
        ) from exc
    if (
        applied.match_name != arguments.effect_match_name
        or applied.layer_locator.host_instance_id != negotiation.host_instance_id
        or applied.layer_locator.session_id != negotiation.session_id
        or applied.layer_locator.object_id != locator.object_id
        or applied.layer_locator.generation <= locator.generation
        or applied.layer_locator.project_id == locator.project_id
        or result.evidence.postcondition.kind != "layer-effect-apply"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native layer-effect postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": LAYER_EFFECT_APPLY_CAPABILITY_ID},
        )
    return LayerEffectApplyExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=applied,
        evidence=result.evidence,
    )


async def invoke_layer_properties_list(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    parent_property_locator: NativeLocator | Mapping[str, Any] | None,
    offset: int,
    limit: int,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerPropertiesListExecution:
    """List one bounded page of direct layer/group properties without JSX."""

    arguments = LayerPropertiesListArguments(
        layer_locator=layer_locator,
        parent_property_locator=parent_property_locator,
        offset=offset,
        limit=limit,
    )
    stale_hint = (
        "Discard stale property locators, then call ae_listProjectItems, "
        "ae_listCompositionLayers, and ae_listLayerProperties again."
    )
    if (
        arguments.parent_property_locator is not None
        and arguments.parent_property_locator.context()
        != arguments.layer_locator.context()
    ):
        raise _structured_error(
            "STALE_LOCATOR",
            "parentPropertyLocator does not belong to the layer locator context.",
            details={
                "field": "params.arguments.parentPropertyLocator",
                "capabilityId": LAYER_PROPERTIES_LIST_CAPABILITY_ID,
            },
            recovery_hint=stale_hint,
        )
    wire_arguments = arguments.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )
    additional_locators: tuple[tuple[NativeLocator, str], ...] = ()
    if arguments.parent_property_locator is not None:
        additional_locators = ((
            arguments.parent_property_locator,
            "params.arguments.parentPropertyLocator",
        ),)
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=LAYER_PROPERTIES_LIST_CAPABILITY_ID,
        capability_version=LAYER_PROPERTIES_LIST_CAPABILITY_VERSION,
        arguments=wire_arguments,
        locator=arguments.layer_locator,
        locator_field="params.arguments.layerLocator",
        additional_locators=additional_locators,
        stale_locator_hint=stale_hint,
        descriptor_validator=_validate_layer_properties_list_descriptor,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = LayerPropertiesListValue.model_validate(result.value)
        postcondition_digest = _layer_properties_list_digest(value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native layer-property page did not match its typed contract.",
        ) from exc
    if (
        value.layer_locator != arguments.layer_locator
        or value.parent_property_locator != arguments.parent_property_locator
        or value.offset != arguments.offset
        or value.limit != arguments.limit
        or value.layer_locator.host_instance_id != negotiation.host_instance_id
        or value.layer_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind != "layer-properties-list"
        or result.evidence.postcondition.digest != postcondition_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native layer-property page was not bound to its request and evidence.",
        )
    return LayerPropertiesListExecution(
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
    "SelectedCompositionLayersListArguments",
    "SelectedCompositionLayersListExecution",
    "SelectedCompositionLayersListValue",
    "CompositionCurrentTime",
    "CompositionTimeReadArguments",
    "CompositionTimeReadExecution",
    "CompositionTimeReadValue",
    "CompositionTimeSetArguments",
    "CompositionTimeSetExecution",
    "CompositionTimeSetValue",
    "CompositionTimeTarget",
    "CompositionLayerCreateArguments",
    "CompositionLayerCreateColor",
    "CompositionLayerCreateExecution",
    "CompositionLayerCreateValue",
    "CompositionLayerSolidSpec",
    "LayerEffectApplyArguments",
    "LayerEffectApplyExecution",
    "LayerEffectApplyValue",
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
    "LayerPropertiesListArguments",
    "LayerPropertiesListExecution",
    "LayerPropertiesListValue",
    "LayerProperty",
    "LayerPropertyColorValue",
    "LayerPropertySampleTime",
    "LayerPropertyScalarValue",
    "LayerPropertyVectorValue",
    "LayerPropertySetArguments",
    "LayerPropertySetExecution",
    "LayerPropertySetValue",
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
    "SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID",
    "SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION",
    "SELECTED_COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST",
    "SELECTED_COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID",
    "SELECTED_COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID",
    "COMPOSITION_TIME_READ_CAPABILITY_ID",
    "COMPOSITION_TIME_READ_CAPABILITY_VERSION",
    "COMPOSITION_TIME_READ_CONTRACT_DIGEST",
    "COMPOSITION_TIME_READ_INPUT_CONTRACT_ID",
    "COMPOSITION_TIME_READ_RESULT_CONTRACT_ID",
    "COMPOSITION_TIME_SET_CAPABILITY_ID",
    "COMPOSITION_TIME_SET_CAPABILITY_VERSION",
    "COMPOSITION_TIME_SET_CONTRACT_DIGEST",
    "COMPOSITION_TIME_SET_INPUT_CONTRACT_ID",
    "COMPOSITION_TIME_SET_RESULT_CONTRACT_ID",
    "COMPOSITION_CREATE_CAPABILITY_ID",
    "COMPOSITION_CREATE_CAPABILITY_VERSION",
    "COMPOSITION_CREATE_CONTRACT_DIGEST",
    "COMPOSITION_CREATE_INPUT_CONTRACT_ID",
    "COMPOSITION_CREATE_RESULT_CONTRACT_ID",
    "COMPOSITION_LAYER_CREATE_CAPABILITY_ID",
    "COMPOSITION_LAYER_CREATE_CAPABILITY_VERSION",
    "COMPOSITION_LAYER_CREATE_CONTRACT_DIGEST",
    "COMPOSITION_LAYER_CREATE_INPUT_CONTRACT_ID",
    "COMPOSITION_LAYER_CREATE_RESULT_CONTRACT_ID",
    "LAYER_EFFECT_APPLY_CAPABILITY_ID",
    "LAYER_EFFECT_APPLY_CAPABILITY_VERSION",
    "LAYER_EFFECT_APPLY_CONTRACT_DIGEST",
    "LAYER_EFFECT_APPLY_INPUT_CONTRACT_ID",
    "LAYER_EFFECT_APPLY_RESULT_CONTRACT_ID",
    "LAYER_PROPERTIES_LIST_CAPABILITY_ID",
    "LAYER_PROPERTIES_LIST_CAPABILITY_VERSION",
    "LAYER_PROPERTIES_LIST_CONTRACT_DIGEST",
    "LAYER_PROPERTIES_LIST_INPUT_CONTRACT_ID",
    "LAYER_PROPERTIES_LIST_RESULT_CONTRACT_ID",
    "LAYER_PROPERTY_SET_CAPABILITY_ID",
    "LAYER_PROPERTY_SET_CAPABILITY_VERSION",
    "LAYER_PROPERTY_SET_CONTRACT_DIGEST",
    "LAYER_PROPERTY_SET_INPUT_CONTRACT_ID",
    "LAYER_PROPERTY_SET_RESULT_CONTRACT_ID",
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
    "invoke_selected_composition_layers_list",
    "invoke_composition_time_read",
    "invoke_composition_time_set",
    "invoke_composition_create",
    "invoke_composition_layer_create",
    "invoke_layer_effect_apply",
    "invoke_layer_properties_list",
    "invoke_layer_property_set",
    "invoke_project_items_list",
    "invoke_project_summary",
]
