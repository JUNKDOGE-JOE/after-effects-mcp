"""Abstract Backend interface. Concrete implementations live in separate packages."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional, Set


ALL_VERBS: Set[str] = {
    "ae.init", "ae.overview", "ae.layers", "ae.readProps", "ae.exec",
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
    "ae.createRig",
}


class BackendError(RuntimeError):
    """Raised by backend implementations on protocol / connectivity failures."""


class Backend(ABC):
    """Abstract bridge between core MCP layer and a concrete AE plugin protocol.

    A backend is a separate pip package that registers itself via entry
    point group `ae_mcp.backends`. Core never imports any concrete
    backend module.
    """

    name: str  # value matched against AE_MCP_BACKEND env var

    # Capability hints. Override in subclasses if backend handles these natively
    # (e.g. some plugins auto-wrap undo groups and auto-checkpoint; in that
    # case core should skip its own wrapping/checkpointing).
    manages_undo: bool = False
    manages_checkpoints: bool = False

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
        Called once at server startup; failure does NOT abort startup."""

    def supported_verbs(self) -> Set[str]:
        """Default = all known verbs. Subset return -> unsupported verbs hidden from tools/list."""
        return ALL_VERBS

    @classmethod
    @abstractmethod
    def from_env(cls) -> "Backend":
        """Construct from this backend's own env vars. Raise EnvironmentError
        with a clear message when required vars are missing."""

    async def shutdown(self) -> None:
        """Optional cleanup hook. Default no-op."""
        return None
