"""HTTP bridge between ae-mcp MCP server and the ae-mcp CEP plugin."""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Mapping, Optional

import httpx

from ae_mcp import client_identity
from ae_mcp.backends.base import Backend, BackendError
from ae_mcp.backends.native import (
    CapabilityDetail,
    COMPOSITION_CREATE_CAPABILITY_ID,
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilities,
    NativeInvokeBackend,
    NativeInvokeRequest,
    NativeInvokeResult,
    NativeNegotiation,
    NativeRecovery,
    COMPOSITION_LAYER_CREATE_CAPABILITY_ID,
    COMPOSITION_TIME_SET_CAPABILITY_ID,
    LAYER_EFFECT_APPLY_CAPABILITY_ID,
    LAYER_PROPERTY_SET_CAPABILITY_ID,
    PROJECT_BIT_DEPTH_SET_CAPABILITY_ID,
)
from ae_mcp.backends.native_project_composition import (
    COMPOSITION_DUPLICATE_CAPABILITY_ID,
    COMPOSITION_WORK_AREA_SET_CAPABILITY_ID,
    PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID,
    PROJECT_ITEM_LABEL_SET_CAPABILITY_ID,
    PROJECT_ITEM_NAME_SET_CAPABILITY_ID,
)

# Header carrying the shared-secret token on /exec requests. Must match the
# header the Node host (plugin/host/server.js) checks.
_TOKEN_HEADER = "X-AE-MCP-Token"
_PY_VERSION_HEADER = "x-ae-mcp-python"
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_ERROR_FIELDS = {"code", "message", "retryable", "sideEffect", "recovery"}

try:
    from importlib.metadata import version as _pkg_version

    _PY_VERSION = _pkg_version("ae-mcp")
except Exception:  # noqa: BLE001
    _PY_VERSION = "unknown"


def _token_path() -> Path:
    """Per-user token file shared with the Node host. Must match the path the
    panel writes (~/.ae-mcp/auth-token)."""
    return Path.home() / ".ae-mcp" / "auth-token"


class HttpBridge(Backend, NativeInvokeBackend):
    name = "ae-mcp"
    manages_undo = False
    manages_checkpoints = False

    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        # Cache the token after the first successful read so we don't hit the
        # filesystem on every exec.
        self._token: Optional[str] = None

    @classmethod
    def from_env(cls) -> "HttpBridge":
        url = os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488")
        return cls(url=url)

    def _read_token(self) -> str:
        """Read (and cache) the shared-secret token. Fail closed with a clear
        message if the file is missing — the panel generates it on startup, so a
        missing file means the panel hasn't been started/installed."""
        if self._token is not None:
            return self._token
        path = _token_path()
        try:
            token = path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            raise BackendError(
                "HttpBridge: auth token not found at "
                f"{path}. Start (or reinstall) the ae-mcp panel in After "
                "Effects so it can generate the token, then retry."
            ) from None
        except OSError as e:
            raise BackendError(
                f"HttpBridge: could not read auth token at {path}: {e}"
            ) from e
        if not token:
            raise BackendError(
                f"HttpBridge: auth token at {path} is empty. Restart the "
                "ae-mcp panel to regenerate it."
            )
        self._token = token
        return token

    def _headers(self, token: str) -> dict[str, str]:
        return {
            _TOKEN_HEADER: token,
            client_identity.HEADER: client_identity.get_client(),
            _PY_VERSION_HEADER: _PY_VERSION,
        }

    @staticmethod
    def _contract_error(message: str) -> NativeBackendError:
        return NativeBackendError(
            "NATIVE_CONTRACT_MISMATCH",
            message,
            retryable=False,
            side_effect="not-started",
            recovery=NativeRecovery(
                action="refresh-capabilities",
                hint="Refresh the authenticated native contract before retrying.",
            ),
        )

    @staticmethod
    def _unavailable_error(message: str, hint: str) -> NativeBackendError:
        return NativeBackendError(
            "NATIVE_UNAVAILABLE",
            message,
            retryable=True,
            side_effect="not-started",
            recovery=NativeRecovery(action="reconnect", hint=hint),
        )

    @staticmethod
    def _deadline_error(message: str) -> NativeBackendError:
        return NativeBackendError(
            "DEADLINE_EXCEEDED",
            message,
            retryable=True,
            side_effect="not-started",
            recovery=NativeRecovery(
                action="retry",
                hint="Issue a new request only if the native result is still needed.",
            ),
        )

    @staticmethod
    def _possibly_side_effecting_error(
        message: str,
        capability_id: str,
    ) -> NativeBackendError:
        if capability_id == LAYER_PROPERTY_SET_CAPABILITY_ID:
            recovery_hint = (
                "Read the property with fresh locators and inspect the Undo stack "
                "before retrying."
            )
        elif capability_id == COMPOSITION_TIME_SET_CAPABILITY_ID:
            recovery_hint = (
                "Read the composition time with a fresh locator and inspect the "
                "Undo stack before retrying."
            )
        elif capability_id == COMPOSITION_CREATE_CAPABILITY_ID:
            recovery_hint = (
                "List project items with fresh locators and inspect the Undo stack "
                "before retrying."
            )
        elif capability_id == COMPOSITION_WORK_AREA_SET_CAPABILITY_ID:
            recovery_hint = (
                "Read the composition settings with a fresh locator and inspect "
                "the Undo stack before retrying."
            )
        elif capability_id in {
            PROJECT_ITEM_NAME_SET_CAPABILITY_ID,
            PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID,
            PROJECT_ITEM_LABEL_SET_CAPABILITY_ID,
        }:
            recovery_hint = (
                "Read the project item metadata with a fresh locator and inspect "
                "the Undo stack before retrying."
            )
        elif capability_id == COMPOSITION_DUPLICATE_CAPABILITY_ID:
            recovery_hint = (
                "Refresh project context and list project items before inspecting "
                "the Undo stack; do not duplicate again until the prior outcome is known."
            )
        elif capability_id == COMPOSITION_LAYER_CREATE_CAPABILITY_ID:
            recovery_hint = (
                "List project items and composition layers with fresh locators, "
                "then inspect the Undo stack before retrying."
            )
        elif capability_id == LAYER_EFFECT_APPLY_CAPABILITY_ID:
            recovery_hint = (
                "List project items, composition layers, and layer properties "
                "with fresh locators, then inspect the Effects group and Undo "
                "stack before retrying."
            )
        else:
            recovery_hint = "Inspect the project bit depth and Undo stack before retrying."
        return NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            message,
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(
                action="inspect-state",
                hint=recovery_hint,
            ),
            details={"capabilityId": capability_id},
        )

    @staticmethod
    def _cancelled_error() -> NativeBackendError:
        return NativeBackendError(
            "CANCELLED",
            "Native request was cancelled before HTTP dispatch.",
            retryable=False,
            side_effect="not-started",
            recovery=NativeRecovery(
                action="none",
                hint="Issue a new request only if the native result is still needed.",
            ),
        )

    @staticmethod
    def _closed_error_payload(error: Any) -> dict[str, Any]:
        if not isinstance(error, Mapping):
            raise ValueError("native failure error is not an object")
        raw = dict(error)
        keys = set(raw)
        if keys != _ERROR_FIELDS and keys != _ERROR_FIELDS | {"details"}:
            raise ValueError("native failure error fields are not closed")
        code = raw.get("code")
        message = raw.get("message")
        retryable = raw.get("retryable")
        side_effect = raw.get("sideEffect")
        recovery = raw.get("recovery")
        if not isinstance(code, str) or _ERROR_CODE.fullmatch(code) is None:
            raise ValueError("native failure code is invalid")
        if not isinstance(message, str) or not 1 <= len(message) <= 512:
            raise ValueError("native failure message is invalid")
        if not isinstance(retryable, bool):
            raise ValueError("native failure retryable is invalid")
        if side_effect not in {"not-started", "may-have-occurred", "completed"}:
            raise ValueError("native failure sideEffect is invalid")
        if not isinstance(recovery, Mapping) or set(recovery) not in (
            {"action", "hint"},
            {"action", "hint", "retryAfterMs"},
        ):
            raise ValueError("native failure recovery fields are not closed")
        action = recovery.get("action")
        hint = recovery.get("hint")
        if not isinstance(action, str) or not 1 <= len(action) <= 64:
            raise ValueError("native failure recovery action is invalid")
        if not isinstance(hint, str) or not 1 <= len(hint) <= 256:
            raise ValueError("native failure recovery hint is invalid")
        if "retryAfterMs" in recovery and (
            not isinstance(recovery["retryAfterMs"], int)
            or isinstance(recovery["retryAfterMs"], bool)
            or not 1 <= recovery["retryAfterMs"] <= 30_000
        ):
            raise ValueError("native failure recovery retryAfterMs is invalid")
        if "details" in raw and not isinstance(raw["details"], Mapping):
            raise ValueError("native failure details are invalid")
        return raw

    @staticmethod
    def _matches_broker_policy(
        raw: Mapping[str, Any],
        *,
        retryable: bool,
        action: str,
        status_code: int,
        expected_status: int,
    ) -> bool:
        return (
            status_code == expected_status
            and set(raw) == _ERROR_FIELDS
            and raw.get("retryable") is retryable
            and raw.get("sideEffect") == "not-started"
            and set(raw.get("recovery", {})) == {"action", "hint"}
            and raw.get("recovery", {}).get("action") == action
        )

    def _native_failure(
        self,
        body: Mapping[str, Any],
        *,
        status_code: int,
    ) -> NativeBackendError:
        try:
            raw_error = self._closed_error_payload(body.get("error"))
        except ValueError:
            return self._contract_error(
                "CEP returned a malformed native failure error."
            )
        code = raw_error["code"]
        expected_envelope = (
            {"ok", "error", "pairing"}
            if code == "NATIVE_PAIRING_REQUIRED"
            else {"ok", "error"}
        )
        if body.get("ok") is not False or set(body) != expected_envelope:
            return self._contract_error(
                "CEP returned a native failure envelope with unexpected fields."
            )
        if not 400 <= status_code <= 599:
            return self._contract_error(
                "CEP returned a native failure envelope with a non-failing HTTP status."
            )

        # These failures are generated by the authenticated CEP broker rather
        # than the AEGP wire. Map its access controls into the strict Core
        # policy without leaking tokens or weakening the fail-closed boundary.
        if code == "UNAUTHORIZED":
            if not self._matches_broker_policy(
                raw_error,
                retryable=False,
                action="reconnect",
                status_code=status_code,
                expected_status=401,
            ):
                return self._contract_error(
                    "CEP returned an invalid broker authentication policy."
                )
            return NativeBackendError(
                "NATIVE_BROKER_UNAUTHORIZED",
                "The authenticated CEP native bridge rejected this session.",
                retryable=False,
                side_effect="not-started",
                recovery=NativeRecovery(
                    action="refresh-auth",
                    hint="Restart the panel to refresh its local token and native session.",
                ),
            )
        if code == "CLIENT_BLOCKED":
            if not self._matches_broker_policy(
                raw_error,
                retryable=False,
                action="none",
                status_code=status_code,
                expected_status=403,
            ):
                return self._contract_error(
                    "CEP returned an invalid client-block policy."
                )
            return NativeBackendError(
                "NATIVE_CLIENT_BLOCKED",
                "This MCP client is blocked by the After Effects panel.",
                retryable=False,
                side_effect="not-started",
                recovery=NativeRecovery(
                    action="review-client-access",
                    hint="Review this client's access in the panel before retrying.",
                ),
            )
        if code == "ACTIONS_PAUSED":
            if not self._matches_broker_policy(
                raw_error,
                retryable=True,
                action="retry",
                status_code=status_code,
                expected_status=503,
            ):
                return self._contract_error(
                    "CEP returned an invalid actions-paused policy."
                )
            return NativeBackendError(
                "NATIVE_ACTIONS_PAUSED",
                "Native actions are paused in the After Effects panel.",
                retryable=True,
                side_effect="not-started",
                recovery=NativeRecovery(
                    action="resume-actions",
                    hint="Resume AI actions in the panel, then retry.",
                ),
            )
        if code == "AUTH_REQUIRED":
            if not (
                status_code == 401
                and set(raw_error) == _ERROR_FIELDS
                and raw_error["sideEffect"] == "not-started"
                and set(raw_error["recovery"]) == {"action", "hint"}
                and raw_error["recovery"]["action"] == "approve-pairing"
            ):
                return self._contract_error(
                    "CEP returned an invalid native pairing outcome policy."
                )
            return NativeBackendError(
                "NATIVE_PAIRING_REJECTED",
                raw_error["message"],
                retryable=True,
                side_effect="not-started",
                recovery=NativeRecovery(
                    action="retry-pairing",
                    hint="Start a fresh native pairing request and approve it in After Effects.",
                ),
            )
        if code == "NATIVE_CONTRACT_MISMATCH":
            if not (
                status_code == 503
                and set(raw_error) == _ERROR_FIELDS
                and raw_error["retryable"] is False
                and raw_error["sideEffect"] == "not-started"
                and set(raw_error["recovery"]) == {"action", "hint"}
                and raw_error["recovery"]["action"] == "refresh-capabilities"
            ):
                return self._contract_error(
                    "CEP returned a malformed internal contract-mismatch policy."
                )
            return self._contract_error(raw_error["message"])

        if code == "NATIVE_PAIRING_REQUIRED":
            if not (
                status_code == 409
                and set(raw_error) == _ERROR_FIELDS | {"details"}
                and raw_error["retryable"] is True
                and raw_error["sideEffect"] == "not-started"
                and set(raw_error["recovery"]) == {"action", "hint"}
                and raw_error["recovery"]["action"] == "approve-pairing"
            ):
                return self._contract_error(
                    "CEP returned an invalid native pairing-required policy."
                )
            pairing = body.get("pairing")
            if not isinstance(pairing, Mapping):
                return self._contract_error(
                    "CEP omitted the native pairing fingerprint and provenance."
                )
            projected = {
                "pairingFingerprint": pairing.get("fingerprint"),
                "pairingExpiresInMs": pairing.get("expiresInMs"),
                "hostInstanceId": pairing.get("hostInstanceId"),
                "sourceCommit": pairing.get("sourceCommit"),
            }
            if set(pairing) != {
                "fingerprint", "expiresInMs", "hostInstanceId", "sourceCommit"
            } or dict(raw_error["details"]) != projected:
                return self._contract_error(
                    "CEP returned inconsistent native pairing details."
                )
            message = raw_error.get("message")
            return NativeBackendError(
                "NATIVE_PAIRING_REQUIRED",
                message,
                retryable=True,
                side_effect="not-started",
                recovery=NativeRecovery(
                    action="approve-pairing",
                    hint="Approve the matching fingerprint in After Effects, then retry.",
                ),
                details=projected,
            )

        try:
            return NativeBackendError.from_payload(raw_error)
        except NativeBackendError as native_error:
            return native_error

    async def _native_post(
        self,
        path: str,
        payload: Mapping[str, Any],
        *,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None,
        uncertain_capability_id: str | None = None,
    ) -> Mapping[str, Any]:
        if cancellation is not None and cancellation.is_cancelled:
            raise self._cancelled_error()
        remaining = (deadline_unix_ms - int(time.time() * 1000)) / 1000.0
        if remaining <= 0:
            raise self._deadline_error(
                "Native request deadline elapsed before HTTP dispatch."
            )
        try:
            token = self._read_token()
        except BackendError as error:
            raise self._unavailable_error(
                "The CEP authentication token is unavailable.",
                "Start or restart the ae-mcp panel so it can refresh the local token.",
            ) from error

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(remaining),
                trust_env=False,
            ) as http:
                response = await http.post(
                    f"{self.url}{path}",
                    json=dict(payload),
                    headers=self._headers(token),
                )
        except httpx.TimeoutException as error:
            if uncertain_capability_id is not None:
                raise self._possibly_side_effecting_error(
                    "The broker response was lost after native mutation dispatch.",
                    uncertain_capability_id,
                ) from error
            raise self._deadline_error(
                "Authenticated CEP native request exceeded its deadline."
            ) from error
        except httpx.HTTPError as error:
            if uncertain_capability_id is not None:
                raise self._possibly_side_effecting_error(
                    "The native transport failed after mutation dispatch may have begun.",
                    uncertain_capability_id,
                ) from error
            raise self._unavailable_error(
                "Authenticated CEP native transport is unavailable.",
                "Confirm the panel is running, then reconnect and retry.",
            ) from error

        try:
            body = response.json()
        except ValueError as error:
            raise self._contract_error(
                "CEP returned non-JSON data for a native request."
            ) from error
        if not isinstance(body, Mapping):
            raise self._contract_error(
                "CEP returned a non-object native response envelope."
            )
        if body.get("ok") is False:
            raise self._native_failure(body, status_code=response.status_code)
        if response.status_code != 200:
            raise self._contract_error(
                "CEP returned a successful native envelope with a failing HTTP status."
            )
        if set(body) != {"ok", "result"} or body.get("ok") is not True:
            raise self._contract_error(
                "CEP returned an invalid native success envelope."
            )
        result = body.get("result")
        if not isinstance(result, Mapping):
            raise self._contract_error(
                "CEP returned a native success envelope without an object result."
            )
        return result

    async def negotiate(
        self,
        *,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeNegotiation:
        raw = await self._native_post(
            "/native/negotiate",
            {"deadlineUnixMs": deadline_unix_ms},
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        try:
            return NativeNegotiation.model_validate(raw)
        except (TypeError, ValueError) as error:
            raise self._contract_error(
                "CEP native negotiation result failed Core validation."
            ) from error

    async def capabilities(
        self,
        *,
        ids: tuple[str, ...] | None,
        detail: CapabilityDetail,
        limit: int,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeCapabilities:
        payload: dict[str, Any] = {
            "detail": detail,
            "limit": limit,
            "deadlineUnixMs": deadline_unix_ms,
        }
        if ids is not None:
            payload["ids"] = list(ids)
        raw = await self._native_post(
            "/native/capabilities",
            payload,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        try:
            return NativeCapabilities.model_validate(raw)
        except (TypeError, ValueError) as error:
            raise self._contract_error(
                "CEP native capabilities result failed Core validation."
            ) from error

    async def invoke(
        self,
        request: NativeInvokeRequest,
        *,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeInvokeResult:
        mutating = request.capability_id in {
            PROJECT_BIT_DEPTH_SET_CAPABILITY_ID,
            COMPOSITION_TIME_SET_CAPABILITY_ID,
            COMPOSITION_CREATE_CAPABILITY_ID,
            COMPOSITION_LAYER_CREATE_CAPABILITY_ID,
            LAYER_EFFECT_APPLY_CAPABILITY_ID,
            LAYER_PROPERTY_SET_CAPABILITY_ID,
            COMPOSITION_WORK_AREA_SET_CAPABILITY_ID,
            PROJECT_ITEM_NAME_SET_CAPABILITY_ID,
            PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID,
            PROJECT_ITEM_LABEL_SET_CAPABILITY_ID,
            COMPOSITION_DUPLICATE_CAPABILITY_ID,
        }
        try:
            raw = await self._native_post(
                "/native/invoke",
                request.model_dump(mode="json", by_alias=True),
                deadline_unix_ms=request.deadline_unix_ms,
                cancellation=cancellation,
                uncertain_capability_id=(request.capability_id if mutating else None),
            )
        except NativeBackendError as error:
            if mutating and error.code == "NATIVE_CONTRACT_MISMATCH":
                raise self._possibly_side_effecting_error(
                    "The broker returned an unverifiable native mutation response.",
                    request.capability_id,
                ) from error
            raise
        try:
            if mutating and not isinstance(raw.get("replayed"), bool):
                raise ValueError("native mutation result omitted replay status")
            return NativeInvokeResult.model_validate(raw)
        except (TypeError, ValueError) as error:
            if mutating:
                raise self._possibly_side_effecting_error(
                    "The native mutation result failed Core validation.",
                    request.capability_id,
                ) from error
            raise self._contract_error(
                "CEP native invocation result failed Core validation."
            ) from error

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        # /health is unauthenticated (it executes no code), so no token needed.
        try:
            async with httpx.AsyncClient(timeout=timeout_sec, trust_env=False) as http:
                r = await http.get(
                    f"{self.url}/health",
                    headers={_PY_VERSION_HEADER: _PY_VERSION},
                )
            return r.status_code == 200 and r.json().get("ok") is True
        except Exception:  # noqa: BLE001
            return False

    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        # Fail closed: if the token can't be read, raise before making the call.
        token = self._read_token()
        payload = {
            "code": code,
            "undoGroup": undo_group,
            "checkpointLabel": checkpoint_label,
            "timeoutMs": int(timeout_sec * 1000),
        }
        headers = self._headers(token)
        try:
            async with httpx.AsyncClient(
                timeout=timeout_sec + 5.0,
                trust_env=False,
            ) as http:
                r = await http.post(
                    f"{self.url}/exec", json=payload, headers=headers
                )
        except httpx.HTTPError as e:
            raise BackendError(f"HttpBridge: HTTP error: {e}") from e

        if r.status_code != 200:
            raise BackendError(
                f"HttpBridge: /exec HTTP {r.status_code}: {r.text[:300]}"
            )
        body = r.json()
        if not body.get("ok"):
            raise BackendError(f"HttpBridge: plugin error: {body.get('error')}")
        return body.get("result", "")

    async def shutdown(self) -> None:
        return None
