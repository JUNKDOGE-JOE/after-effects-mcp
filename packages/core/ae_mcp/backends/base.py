"""Abstract Backend interface. Concrete implementations live in separate packages."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal, Optional, Set


ExecutionEngine = Literal["native-aegp", "maintained-jsx", "ephemeral-jsx"]
EXECUTION_ENGINES: tuple[ExecutionEngine, ...] = (
    "native-aegp",
    "maintained-jsx",
    "ephemeral-jsx",
)


ALL_VERBS: Set[str] = {
    "ae.init", "ae.overview", "ae.layers", "ae.readProps", "ae.exec",
    "ae.listProjectItems", "ae.listCompositionLayers", "ae.listSelectedLayers",
    "ae.getCompositionTime",
    "ae.listLayerProperties",
    "ae.setLayerPropertyValue",
    "ae.checkpoint", "ae.revert", "ae.snapshot", "ae.applyEffect",
    "ae.previewFrame",
    "ae.createLayer", "ae.setProperty", "ae.moveLayer", "ae.selectLayers",
    "ae.setTime", "ae.getTime",
    "ae.ping",
    "ae.getProperties", "ae.scanPropertyTree",
    "ae.inspectPropertyCapabilities", "ae.getExpressions",
    "ae.validateExpressions",
    "ae.getKeyframes", "ae.searchProject",
    "ae.skillList", "ae.skillCreate", "ae.skillEdit",
    "ae.skillDelete", "ae.skillUse",
    "ae.toolIndex", "ae.toolSearch", "ae.toolInspect", "ae.toolUse",
    "ae.toolCreate", "ae.toolEdit", "ae.toolDelete", "ae.toolArchive",
    "ae.toolDuplicate", "ae.toolPromoteFromHistory",
    "ae.toolImport", "ae.toolExport",
    "ae.createRig",
}


class BackendError(RuntimeError):
    """Raised by backend implementations on protocol / connectivity failures."""


class LegacyExtendScriptBackend(ABC):
    """Explicit adapter for backends whose execution primitive is JSX.

    A backend is a separate pip package that registers itself via entry
    point group `ae_mcp.backends`. Core never imports any concrete
    backend module. This contract intentionally remains JSX-specific; native
    AEGP capabilities use :class:`ae_mcp.backends.native.NativeInvokeBackend`
    and never receive source text.
    """

    name: str  # value matched against AE_MCP_BACKEND env var

    # Capability hints. Override in subclasses if backend handles these natively
    # (e.g. some plugins auto-wrap undo groups and auto-checkpoint; in that
    # case core should skip its own wrapping/checkpointing).
    manages_undo: bool = False
    manages_checkpoints: bool = False

    @staticmethod
    def execution_engine_for(*, ephemeral: bool) -> ExecutionEngine:
        """Label one JSX invocation without selecting or rerouting it.

        The transport alone cannot determine provenance: repository-managed
        JSX and one-off JSX may use the same backend. Callers therefore
        classify each invocation explicitly for audit purposes.
        """
        return "ephemeral-jsx" if ephemeral else "maintained-jsx"

    @abstractmethod
    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        """Run JSX inside AE, return raw stdout text. Foundation primitive."""

    @abstractmethod
    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        """Quick handshake: is this backend reachable right now?
        Probed once in the background at server startup; failure is logged and
        never aborts startup."""

    def supported_verbs(self) -> Set[str]:
        """Default = all known verbs. Subset return -> unsupported verbs hidden from tools/list."""
        return ALL_VERBS

    @classmethod
    @abstractmethod
    def from_env(cls) -> "LegacyExtendScriptBackend":
        """Construct from this backend's own env vars. Raise EnvironmentError
        with a clear message when required vars are missing."""

    async def shutdown(self) -> None:
        """Optional cleanup hook. Default no-op."""
        return None


class Backend(LegacyExtendScriptBackend):
    """Backward-compatible name for the legacy ExtendScript adapter.

    Third-party backend packages currently subclass ``Backend``. Keeping this
    abstract compatibility class avoids a flag-day migration while making the
    JSX boundary explicit to new Core code.
    """
