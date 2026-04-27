# spec 3a — Backend 抽象 + 多后端 + OS-agnostic snapshot — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v0.7 的 single-package, AEBM-coupled MCP server 重构为 monorepo（`ae-mcp` core + 3 个 reference 实现包）；core 完全不知任何具体 backend / OS；通过 Python entry points 发现并选择 backend 与 snapshotter；版本号重置为 0.1.0、包名重置为 `ae-mcp`。

**Architecture:** uv workspace 管理 4 个独立 pyproject 子包：`packages/core/`（Backend/Snapshotter ABC + 24 verb handlers + JSX 模板 + checkpoint store）、`packages/backend-aebm/`（搬迁现有 bridge.py）、`packages/backend-atom/`（新 httpx HTTP client）、`packages/snapshot-mss/`（mss 替代 ctypes BitBlt）。Core 启动时通过 `importlib.metadata.entry_points(group="ae_mcp.backends" / "ae_mcp.snapshotters")` 发现已装实现，按 `AE_MCP_BACKEND` env var 选择。

**Tech Stack:** Python 3.10+ / uv workspace / pydantic v2 / httpx / mss / pytest / pytest-asyncio / Python entry points / ExtendScript / ctypes (Win32) / Quartz (macOS).

**Spec reference:** [`docs/superpowers/specs/2026-04-27-spec-3a-backend-abstraction-design.md`](../specs/2026-04-27-spec-3a-backend-abstraction-design.md)

**Branch:** continues from `feat/v0.7-atommcp-parity` (which contains both v0.7.0 work and now 3a). Recommend renaming branch to `feat/0.1-rebrand-decouple` after Task 0.1.

---

## 文件结构总览（最终态）

```
after-effects-mcp/                 (git repo dir, name unchanged)
├── pyproject.toml                  uv workspace root
├── packages/
│   ├── core/
│   │   ├── pyproject.toml          name="ae-mcp" version="0.1.0"
│   │   ├── ae_mcp/
│   │   │   ├── __init__.py
│   │   │   ├── __main__.py         python -m ae_mcp
│   │   │   ├── server.py
│   │   │   ├── schemas.py          (24 pydantic models, unchanged)
│   │   │   ├── progress.py         (unchanged)
│   │   │   ├── checkpoint_store.py (unchanged)
│   │   │   ├── handlers/
│   │   │   │   ├── __init__.py     (registry)
│   │   │   │   ├── core.py         refactored to use Backend
│   │   │   │   └── typed.py        refactored to use Backend
│   │   │   ├── jsx_templates/      (existing 9 templates + 3 new)
│   │   │   │   └── (init.jsx, overview.jsx, get_layers.jsx new)
│   │   │   ├── backends/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── base.py         abstract Backend
│   │   │   │   ├── discovery.py    entry-point loader
│   │   │   │   └── mock.py         MockBackend for tests
│   │   │   └── snapshot/
│   │   │       ├── __init__.py
│   │   │       ├── base.py         abstract Snapshotter
│   │   │       └── discovery.py
│   │   └── tests/
│   │       ├── conftest.py         mock_backend fixture (replaces mock_bridge)
│   │       ├── test_schemas.py
│   │       ├── test_handlers_core.py
│   │       ├── test_handlers_typed.py
│   │       ├── test_progress.py
│   │       ├── test_checkpoint_store.py
│   │       ├── test_discovery.py   NEW
│   │       └── live/               (kept; opt-in)
│   ├── backend-aebm/
│   │   ├── pyproject.toml          name="ae-mcp-backend-aebm"
│   │   ├── ae_mcp_backend_aebm/
│   │   │   └── __init__.py         AEBMBackend (port of bridge.py)
│   │   └── tests/
│   │       └── test_aebm_backend.py
│   ├── backend-atom/
│   │   ├── pyproject.toml          name="ae-mcp-backend-atom" deps=httpx
│   │   ├── ae_mcp_backend_atom/
│   │   │   ├── __init__.py         AtomBackend
│   │   │   └── protocol.py         handshake / session-id / stale recovery
│   │   └── tests/
│   │       └── test_atom_backend.py
│   └── snapshot-mss/
│       ├── pyproject.toml          name="ae-mcp-snapshot-mss" deps=mss
│       ├── ae_mcp_snapshot_mss/
│       │   ├── __init__.py         MssSnapshotter
│       │   └── _hwnd_rect.py       OS-specific HWND → screen rect
│       └── tests/
│           └── test_mss_snapshot.py
├── docs/
│   ├── REFERENCE.md                 rewritten: protocol-first, no AEBM/Atom mentions in core
│   └── superpowers/specs/plans/
├── MIGRATION.md                     NEW: after-effects-mcp v0.7 -> ae-mcp 0.1
├── README.md                        rewritten
└── .mcp.json.template               rewritten (no AE_BRIDGE_ROOT, server name "ae")
```

**Removed at end of plan**: top-level `after_effects_mcp/` directory (everything moved to `packages/core/ae_mcp/`), top-level `tests/` directory (moved to `packages/core/tests/`).

---

## Phase 0 — Monorepo conversion

### Task 0.1: Convert to uv workspace + move existing code into packages/core/

**Files:**
- Create: `pyproject.toml` (workspace root, replaces existing)
- Create: `packages/core/pyproject.toml`
- Move: `after_effects_mcp/**/*.py` → `packages/core/ae_mcp/**/*.py`
- Move: `after_effects_mcp/jsx_templates/**` → `packages/core/ae_mcp/jsx_templates/**`
- Move: `tests/**` → `packages/core/tests/**`
- Delete: top-level `after_effects_mcp/` dir, top-level `tests/` dir
- Delete: top-level `pyproject.toml` (replaced)

This is a single mechanical task. Splitting it would leave the repo in a non-buildable intermediate state.

- [ ] **Step 1: Rename git branch for clarity**

```bash
git branch -m feat/v0.7-atommcp-parity feat/0.1-rebrand-decouple
```

- [ ] **Step 2: Create new workspace root `pyproject.toml`**

Replace the entire existing top-level `pyproject.toml` with:

```toml
[tool.uv.workspace]
members = ["packages/core", "packages/backend-aebm", "packages/backend-atom", "packages/snapshot-mss"]

[tool.uv.sources]
ae-mcp                = { workspace = true }
ae-mcp-backend-aebm   = { workspace = true }
ae-mcp-backend-atom   = { workspace = true }
ae-mcp-snapshot-mss   = { workspace = true }

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["packages/core/tests", "packages/backend-aebm/tests", "packages/backend-atom/tests", "packages/snapshot-mss/tests"]
markers = [
    "live: requires real AE + a backend reachable; opt-in via AEBM_LIVE_TESTS=1",
    "live_smoke: 3-verb handshake subset of live tests",
]
addopts = "-m 'not live and not live_smoke'"
```

- [ ] **Step 3: Move existing source code into packages/core/**

```bash
mkdir -p packages/core/ae_mcp
git mv after_effects_mcp/* packages/core/ae_mcp/
git mv tests packages/core/tests
rmdir after_effects_mcp
```

If `git mv` complains because directory becomes empty too early, do file-by-file. The end state must be: `after_effects_mcp/` dir gone, all its contents under `packages/core/ae_mcp/`; same for `tests/` → `packages/core/tests/`.

- [ ] **Step 4: Create `packages/core/pyproject.toml`**

```toml
[project]
name = "ae-mcp"
version = "0.1.0"
description = "Backend-agnostic MCP server for Adobe After Effects automation"
readme = "../../README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
authors = [{ name = "ae-mcp contributors" }]
dependencies = [
    "mcp>=1.0.0",
    "pydantic>=2.5.0",
    "pillow>=10.0.0",
]

[project.optional-dependencies]
dev = ["pytest>=7.4", "pytest-asyncio>=0.23"]

[project.scripts]
ae-mcp = "ae_mcp.__main__:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["ae_mcp"]

[tool.hatch.build]
include = [
    "ae_mcp/**/*.py",
    "ae_mcp/jsx_templates/*.jsx",
]
```

- [ ] **Step 5: Update all imports inside ae_mcp from `after_effects_mcp` to `ae_mcp`**

Run a repo-wide find-and-replace:

```bash
grep -rl "after_effects_mcp" packages/core/ | xargs sed -i 's/after_effects_mcp/ae_mcp/g'
```

(On Windows bash: this works; if `sed -i` complains, use `sed -i ''`.)

- [ ] **Step 6: Verify uv workspace syncs**

Run: `python -m uv sync`
Expected: succeeds, installs `ae-mcp` in editable mode. No errors about missing modules.

- [ ] **Step 7: Verify existing unit tests still pass**

Run: `AE_BRIDGE_ROOT=E:/Code/AEBMethod python -m uv run pytest -m "not live and not live_smoke"`
Expected: 119 passed (same as before move).

If any test fails because of import path issues, find-and-replace any leftover `after_effects_mcp` references; rerun.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: convert to uv workspace; move code under packages/core/ae_mcp"
```

---

## Phase 1 — Backend ABC + discovery + MockBackend

### Task 1.1: Create Backend ABC

**Files:**
- Create: `packages/core/ae_mcp/backends/__init__.py`
- Create: `packages/core/ae_mcp/backends/base.py`

- [ ] **Step 1: Create empty package marker**

`packages/core/ae_mcp/backends/__init__.py`:

```python
"""Backend abstraction layer.

Concrete backend implementations live in separate pip packages and
register themselves via the entry point group `ae_mcp.backends`.
Core never imports any concrete backend module directly."""
from ae_mcp.backends.base import Backend, ALL_VERBS, BackendError

__all__ = ["Backend", "ALL_VERBS", "BackendError"]
```

- [ ] **Step 2: Write failing test for Backend ABC contract**

Create `packages/core/tests/test_backend_base.py`:

```python
"""Unit tests for the Backend abstract base class."""
import pytest
from ae_mcp.backends.base import Backend, ALL_VERBS


def test_all_verbs_constant_has_24_entries():
    assert len(ALL_VERBS) == 24
    assert "ae.exec" in ALL_VERBS
    assert "ae.ping" in ALL_VERBS
    assert "ae.searchProject" in ALL_VERBS


def test_cannot_instantiate_backend_directly():
    with pytest.raises(TypeError):
        Backend()


def test_backend_subclass_must_define_exec_health_from_env():
    class Incomplete(Backend):
        name = "incomplete"
    with pytest.raises(TypeError):
        Incomplete()


def test_default_supported_verbs_returns_all_24():
    class Minimal(Backend):
        name = "min"
        async def exec(self, code, **kw): return ""
        async def health_check(self, timeout_sec=5.0): return True
        @classmethod
        def from_env(cls): return cls()
    b = Minimal()
    assert b.supported_verbs() == ALL_VERBS


def test_default_capability_flags_are_false():
    class Minimal(Backend):
        name = "min"
        async def exec(self, code, **kw): return ""
        async def health_check(self, timeout_sec=5.0): return True
        @classmethod
        def from_env(cls): return cls()
    b = Minimal()
    assert b.manages_undo is False
    assert b.manages_checkpoints is False
```

- [ ] **Step 3: Run, expect ImportError**

Run: `python -m uv run pytest packages/core/tests/test_backend_base.py -v`
Expected: ImportError on `Backend`.

- [ ] **Step 4: Implement `packages/core/ae_mcp/backends/base.py`**

```python
"""Abstract Backend interface. Concrete implementations live in separate packages."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional, Set


ALL_VERBS: Set[str] = {
    "ae.init", "ae.overview", "ae.layers", "ae.readProps", "ae.exec",
    "ae.checkpoint", "ae.revert", "ae.snapshot", "ae.applyEffect",
    "ae.createLayer", "ae.setProperty", "ae.moveLayer", "ae.selectLayers",
    "ae.setTime", "ae.getTime",
    "ae.isolateToggle", "ae.toastQuery",
    "ae.ping",
    "ae.getProperties", "ae.scanPropertyTree",
    "ae.inspectPropertyCapabilities", "ae.getExpressions",
    "ae.getKeyframes", "ae.searchProject",
}


class BackendError(RuntimeError):
    """Raised by backend implementations on protocol / connectivity failures."""


class Backend(ABC):
    """Abstract bridge between core MCP layer and a concrete AE plugin protocol.

    A backend is a separate pip package that registers itself via entry
    point group `ae_mcp.backends`. Core never imports any concrete
    backend module.
    """

    name: str  # e.g. "aebm", "atom" — value matched against AE_MCP_BACKEND env var

    # Capability hints. Override in subclasses if backend handles these natively
    # (e.g. Atom auto-wraps undo groups and auto-checkpoints; in that case core
    # should skip its own wrapping/checkpointing).
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
        """Default = all 24. Subset return → unsupported verbs hidden from tools/list."""
        return ALL_VERBS

    @classmethod
    @abstractmethod
    def from_env(cls) -> "Backend":
        """Construct from this backend's own env vars. Raise EnvironmentError
        with a clear message when required vars are missing."""

    async def shutdown(self) -> None:
        """Optional cleanup hook. Default no-op."""
        return None
```

- [ ] **Step 5: Run tests, expect green**

Run: `python -m uv run pytest packages/core/tests/test_backend_base.py -v`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/core/ae_mcp/backends/ packages/core/tests/test_backend_base.py
git commit -m "feat(core): add Backend abstract base class"
```

---

### Task 1.2: MockBackend for tests

**Files:**
- Create: `packages/core/ae_mcp/backends/mock.py`

- [ ] **Step 1: Write failing test**

Append to `packages/core/tests/test_backend_base.py`:

```python
import pytest
from ae_mcp.backends.mock import MockBackend


@pytest.mark.asyncio
async def test_mock_backend_records_calls():
    mb = MockBackend()
    mb.set_response('JSON.stringify({ok:true})')
    out = await mb.exec("foo")
    assert out == 'JSON.stringify({ok:true})'
    assert len(mb.calls) == 1
    assert mb.calls[0]["code"] == "foo"


@pytest.mark.asyncio
async def test_mock_backend_health_check_default_true():
    mb = MockBackend()
    assert await mb.health_check() is True


@pytest.mark.asyncio
async def test_mock_backend_can_simulate_failure():
    mb = MockBackend()
    mb.set_health(False)
    assert await mb.health_check() is False
```

- [ ] **Step 2: Run, expect failure**

Run: `python -m uv run pytest packages/core/tests/test_backend_base.py::test_mock_backend_records_calls -v`
Expected: ImportError.

- [ ] **Step 3: Implement `packages/core/ae_mcp/backends/mock.py`**

```python
"""MockBackend — for use in core unit tests only."""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Union

from ae_mcp.backends.base import Backend


class MockBackend(Backend):
    """Records every call; returns canned response strings.

    Tests inject this via the `mock_backend` pytest fixture.
    Setting a callable response lets a test return different bytes per call.
    """

    name = "mock"

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self._response: Union[str, Callable[..., str]] = '{"ok":true}'
        self._health: bool = True

    def set_response(self, value: Union[str, Callable[..., str]]) -> None:
        self._response = value

    def set_health(self, ok: bool) -> None:
        self._health = ok

    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        self.calls.append({
            "code": code,
            "undo_group": undo_group,
            "checkpoint_label": checkpoint_label,
            "timeout_sec": timeout_sec,
        })
        if callable(self._response):
            return self._response(code=code, undo_group=undo_group,
                                  checkpoint_label=checkpoint_label,
                                  timeout_sec=timeout_sec)
        return self._response

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        return self._health

    @classmethod
    def from_env(cls) -> "MockBackend":
        return cls()
```

- [ ] **Step 4: Run, expect green**

Run: `python -m uv run pytest packages/core/tests/test_backend_base.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/ae_mcp/backends/mock.py packages/core/tests/test_backend_base.py
git commit -m "feat(core): add MockBackend for unit tests"
```

---

### Task 1.3: Backend discovery + selection

**Files:**
- Create: `packages/core/ae_mcp/backends/discovery.py`
- Create: `packages/core/tests/test_discovery.py`

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/test_discovery.py`:

```python
"""Tests for backend discovery and selection."""
import pytest
from unittest.mock import patch

from ae_mcp.backends.base import Backend
from ae_mcp.backends.discovery import (
    select_backend, list_installed_backends, BackendSelectionError,
)


class FakeBackendA(Backend):
    name = "a"
    async def exec(self, code, **kw): return "{}"
    async def health_check(self, timeout_sec=5.0): return True
    @classmethod
    def from_env(cls): return cls()


class FakeBackendB(Backend):
    name = "b"
    async def exec(self, code, **kw): return "{}"
    async def health_check(self, timeout_sec=5.0): return True
    @classmethod
    def from_env(cls): return cls()


def _patch_installed(installed):
    return patch("ae_mcp.backends.discovery._scan_entry_points",
                 return_value=installed)


def test_zero_installed_raises_helpful_error(monkeypatch):
    monkeypatch.delenv("AE_MCP_BACKEND", raising=False)
    with _patch_installed({}):
        with pytest.raises(BackendSelectionError) as ei:
            select_backend()
        assert "no AE backend installed" in str(ei.value)
        assert "pip install" in str(ei.value)


def test_one_installed_no_env_var_uses_it(monkeypatch):
    monkeypatch.delenv("AE_MCP_BACKEND", raising=False)
    with _patch_installed({"a": FakeBackendA}):
        b = select_backend()
        assert isinstance(b, FakeBackendA)


def test_multiple_installed_no_env_var_raises(monkeypatch):
    monkeypatch.delenv("AE_MCP_BACKEND", raising=False)
    with _patch_installed({"a": FakeBackendA, "b": FakeBackendB}):
        with pytest.raises(BackendSelectionError) as ei:
            select_backend()
        assert "set AE_MCP_BACKEND" in str(ei.value).lower() or \
               "AE_MCP_BACKEND" in str(ei.value)


def test_env_var_selects_named_backend(monkeypatch):
    monkeypatch.setenv("AE_MCP_BACKEND", "b")
    with _patch_installed({"a": FakeBackendA, "b": FakeBackendB}):
        sel = select_backend()
        assert isinstance(sel, FakeBackendB)


def test_env_var_unknown_raises_with_install_hint(monkeypatch):
    monkeypatch.setenv("AE_MCP_BACKEND", "ghost")
    with _patch_installed({"a": FakeBackendA}):
        with pytest.raises(BackendSelectionError) as ei:
            select_backend()
        msg = str(ei.value)
        assert "ghost" in msg
        assert "pip install" in msg


def test_list_installed_backends_returns_dict():
    # Real call against installed entry points; safe to call even if empty
    installed = list_installed_backends()
    assert isinstance(installed, dict)
```

- [ ] **Step 2: Run, expect failure**

Run: `python -m uv run pytest packages/core/tests/test_discovery.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement `packages/core/ae_mcp/backends/discovery.py`**

```python
"""Backend discovery via Python entry points."""
from __future__ import annotations

import importlib.metadata
import os
from typing import Dict, Optional, Type

from ae_mcp.backends.base import Backend


ENTRY_POINT_GROUP = "ae_mcp.backends"


class BackendSelectionError(RuntimeError):
    """Raised when no usable backend can be chosen."""


def _scan_entry_points() -> Dict[str, Type[Backend]]:
    """Indirection so tests can monkey-patch this without touching real EP."""
    eps = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    return {ep.name: ep.load() for ep in eps}


def list_installed_backends() -> Dict[str, Type[Backend]]:
    """Return {backend_name: backend_class} for every installed backend."""
    return _scan_entry_points()


def select_backend() -> Backend:
    """Choose and instantiate the active backend per AE_MCP_BACKEND env var."""
    installed = _scan_entry_points()
    requested: Optional[str] = os.environ.get("AE_MCP_BACKEND") or None

    if requested:
        if requested not in installed:
            installed_names = sorted(installed) or ["(none)"]
            raise BackendSelectionError(
                f"AE_MCP_BACKEND={requested!r} but no such backend installed.\n"
                f"  Installed backends: {installed_names}\n"
                f"  Try: pip install ae-mcp-backend-{requested}\n"
                f"  Or fix AE_MCP_BACKEND to one of the installed names."
            )
        return installed[requested].from_env()

    if not installed:
        raise BackendSelectionError(
            "no AE backend installed.\n"
            "  Install one of:\n"
            "    pip install ae-mcp-backend-aebm    (for AEBMethod plugin)\n"
            "    pip install ae-mcp-backend-atom    (for Atom plugin)\n"
            "  Or write your own backend (see Backend Author Guide — "
            "deferred to spec 3c)."
        )

    if len(installed) == 1:
        only_cls = next(iter(installed.values()))
        return only_cls.from_env()

    raise BackendSelectionError(
        f"multiple backends installed: {sorted(installed)}.\n"
        f"  Set AE_MCP_BACKEND=<name> to choose one."
    )
```

- [ ] **Step 4: Run, expect green**

Run: `python -m uv run pytest packages/core/tests/test_discovery.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/ae_mcp/backends/discovery.py packages/core/tests/test_discovery.py
git commit -m "feat(core): add backend discovery + AE_MCP_BACKEND selection"
```

---

## Phase 2 — Refactor handlers to use Backend

### Task 2.1: Replace mock_bridge fixture with mock_backend

**Files:**
- Modify: `packages/core/tests/conftest.py`

- [ ] **Step 1: Replace conftest.py contents**

Open `packages/core/tests/conftest.py`. Replace the entire file with:

```python
"""Shared pytest fixtures for core unit tests."""
from __future__ import annotations

from typing import Optional
import pytest

from ae_mcp.backends.mock import MockBackend


@pytest.fixture
def mock_backend(monkeypatch):
    """Yield a MockBackend that's also installed as the "active" backend.

    Replaces the v0.7 `mock_bridge` fixture. Tests that previously called
    `mock_bridge.set_response(...)` now call `mock_backend.set_response(...)`.
    """
    mb = MockBackend()

    def _select() -> MockBackend:
        return mb

    # Patch every place core might lookup the active backend
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", _select)
    return mb
```

- [ ] **Step 2: Run a single existing test to confirm conftest loads**

Run: `python -m uv run pytest packages/core/tests/test_schemas.py -v --collect-only 2>&1 | tail -5`
Expected: collect-only succeeds (~50 tests collected).

- [ ] **Step 3: Commit (interim — handlers still reference old fixture; will fail until 2.2)**

```bash
git add packages/core/tests/conftest.py
git commit -m "test(core): replace mock_bridge fixture with mock_backend"
```

---

### Task 2.2: Add init.jsx, overview.jsx, get_layers.jsx templates

**Files:**
- Create: `packages/core/ae_mcp/jsx_templates/init.jsx`
- Create: `packages/core/ae_mcp/jsx_templates/overview.jsx`
- Create: `packages/core/ae_mcp/jsx_templates/get_layers.jsx`

These templates take over what `bridge.invoke_ae_init / overview / layers` did at the pwsh layer. They run inside AE via `backend.exec(jsx)`.

- [ ] **Step 1: Create init.jsx**

```javascript
// ae.init — refresh project snapshot
// Placeholders: refresh_only ("true" | "false")
(function() {
    var refreshOnly = ${refresh_only};
    var summary = {
        ok: true,
        projectFile: app.project.file ? app.project.file.fsName : null,
        numItems: app.project.numItems,
        activeItemId: (app.project.activeItem && app.project.activeItem instanceof CompItem)
            ? String(app.project.activeItem.id) : null,
        appVersion: String(app.version),
        refreshOnly: refreshOnly
    };
    return JSON.stringify(summary);
})()
```

- [ ] **Step 2: Create overview.jsx**

```javascript
// ae.overview — high-level project summary
(function() {
    var comps = [];
    var n = app.project.numItems;
    for (var i = 1; i <= n; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem) {
            comps.push({
                id: String(it.id), name: it.name,
                width: it.width, height: it.height,
                duration: it.duration, frameRate: it.frameRate,
                numLayers: it.numLayers
            });
        }
    }
    return JSON.stringify({
        ok: true,
        projectFile: app.project.file ? app.project.file.fsName : null,
        numItems: n,
        comps: comps,
        activeItemId: (app.project.activeItem && app.project.activeItem instanceof CompItem)
            ? String(app.project.activeItem.id) : null
    });
})()
```

- [ ] **Step 3: Create get_layers.jsx**

```javascript
// ae.layers — list layers in a comp
// Placeholders: comp_expr (resolves to CompItem or null)
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok: false, error: "no comp"});
    var layers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        layers.push({
            id: i,
            name: l.name,
            enabled: l.enabled,
            inPoint: l.inPoint,
            outPoint: l.outPoint,
            isThreeD: !!l.threeDLayer,
            hasParent: !!l.parent
        });
    }
    return JSON.stringify({ok: true, compId: String(comp.id), layers: layers});
})()
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/ae_mcp/jsx_templates/init.jsx packages/core/ae_mcp/jsx_templates/overview.jsx packages/core/ae_mcp/jsx_templates/get_layers.jsx
git commit -m "feat(core): add init/overview/get_layers JSX templates"
```

---

### Task 2.3: Refactor handlers/core.py to use Backend (drop bridge.* calls)

**Files:**
- Modify: `packages/core/ae_mcp/handlers/core.py`
- Modify: `packages/core/tests/test_handlers_core.py`

This is the biggest task in Phase 2. Every handler that called `bridge.invoke_ae_*` now calls `backend.exec(jsx)`.

- [ ] **Step 1: Modify core.py imports and helpers**

Open `packages/core/ae_mcp/handlers/core.py`. At the top, REPLACE:
```python
from ae_mcp import bridge, progress, schemas
```
with:
```python
from ae_mcp import progress, schemas
from ae_mcp.backends.discovery import select_backend
```

(The `bridge` module will be deleted at end of Phase 3 once aebm backend is stood up. For now, leave the file in place but stop importing it.)

- [ ] **Step 2: Add _backend() helper at the top of handlers/core.py (right after imports)**

```python
def _backend():
    """Lazy lookup. Cached after first call."""
    global _cached_backend
    try:
        return _cached_backend  # type: ignore
    except NameError:
        pass
    _cached_backend = select_backend()
    return _cached_backend
```

- [ ] **Step 3: Rewrite _run_init**

REPLACE the existing `_run_init` body with:

```python
async def _run_init(args: schemas.AeInitArgs, ctx: Any) -> Any:
    tmpl = _load_jsx("init.jsx")
    jsx = tmpl.substitute(refresh_only="true" if args.refresh_only else "false")

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=20.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.init..."
    )
```

(The `_load_jsx` helper was added in Task 3.4 of v0.7 — already in this file. Reuse it.)

- [ ] **Step 4: Rewrite _run_overview**

```python
async def _run_overview(args: schemas.AeOverviewArgs, ctx: Any) -> Any:
    tmpl = _load_jsx("overview.jsx")
    jsx = tmpl.substitute()

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=15.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.overview..."
    )
```

- [ ] **Step 5: Rewrite _run_layers**

```python
async def _run_layers(args: schemas.AeLayersArgs, ctx: Any) -> Any:
    from ae_mcp.handlers.typed import _comp_expr  # type: ignore
    tmpl = _load_jsx("get_layers.jsx")
    jsx = tmpl.substitute(comp_expr=_comp_expr(args.comp_id))

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=15.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.layers..."
    )
```

- [ ] **Step 6: Rewrite _run_read_props**

```python
async def _run_read_props(args: schemas.AeReadPropsArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        out = await _backend().exec(args.code, timeout_sec=20.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.readProps..."
    )
```

- [ ] **Step 7: Rewrite _run_exec (preserving v0.7 checkpoint_label auto-create)**

Find the existing `_run_exec`. REPLACE the inner `await bridge.invoke_ae_exec(...)` with `await _backend().exec(...)`. Also: skip the auto-checkpoint dance when `_backend().manages_checkpoints` is True.

The new body should look like:

```python
async def _run_exec(args: schemas.AeExecArgs, ctx: Any) -> Any:
    backend = _backend()

    async def _call() -> Any:
        checkpoint_skipped: Optional[str] = None
        if args.checkpoint_label and not backend.manages_checkpoints:
            project_path = await _resolve_project_path(ctx)
            if not project_path:
                checkpoint_skipped = "untitled-project"
            else:
                cid = _store.make_id()
                dst = _store.aep_path(project_path, cid)
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmpl = _load_jsx("checkpoint_create.jsx")
                jsx_cp = tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
                try:
                    cp_out = await backend.exec(code=jsx_cp, timeout_sec=60.0)
                    cp_parsed = _try_json(cp_out)
                    if isinstance(cp_parsed, dict) and cp_parsed.get("ok"):
                        if cp_parsed.get("skipped"):
                            checkpoint_skipped = cp_parsed.get("reason") or "skipped"
                        else:
                            _store.write_meta(
                                source_project_path=project_path, cid=cid,
                                label=args.checkpoint_label,
                                active_comp_id=cp_parsed.get("activeCompId"),
                                current_time=float(cp_parsed.get("currentTime") or 0.0),
                                size_bytes=int(cp_parsed.get("sizeBytes") or dst.stat().st_size),
                            )
                            _store.prune(project_path)
                except Exception as e:  # noqa: BLE001
                    log.warning("auto-checkpoint failed: %s", e)
                    checkpoint_skipped = f"checkpoint-failed: {e}"
        elif args.checkpoint_label and backend.manages_checkpoints:
            checkpoint_skipped = "delegated-to-backend"

        # Skip undo wrap if backend already does it
        undo = None if backend.manages_undo else args.undo_group_name

        out = await backend.exec(
            code=args.code,
            undo_group=undo,
            checkpoint_label=args.checkpoint_label if backend.manages_checkpoints else None,
            timeout_sec=float(args.timeout_sec),
        )
        parsed = _try_json(out)
        if isinstance(parsed, dict) and checkpoint_skipped:
            parsed.setdefault("checkpointSkipped", checkpoint_skipped)
        return parsed

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=float(args.timeout_sec) + 70.0, start_msg="ae.exec...",
    )
```

- [ ] **Step 8: Rewrite _run_checkpoint, _run_revert, _run_apply_effect, _run_isolate_toggle, _run_toast_query, _run_ping**

For each, find the line that calls `bridge.invoke_ae_*` or `bridge.run_ps` and replace with `await _backend().exec(...)` (passing the same `code=`, `timeout_sec=`).

For `_run_isolate_toggle` and `_run_toast_query` — these used `bridge.run_ps("Invoke-AebmTool", {"Tool": "..."})` which was AEBM-plugin-specific. Since we're decoupling from AEBM:
- These two verbs should be REMOVED from `supported_verbs()` in the **default** Backend.
- AEBMBackend will explicitly support them by checking the `Tool=...` JSX wrapper. For now, leave the handler functions in place but make them call `_backend().exec(jsx_for_isolate)` where the JSX is a stub that says "not supported on this backend". Better: remove from `ALL_VERBS` for now.

**Decision (per spec § "supported_verbs"): keep `ae.isolateToggle` and `ae.toastQuery` in `ALL_VERBS` but expect AEBMBackend to override `supported_verbs()` to include them and other backends to exclude. Default core implementation calls `_backend().exec(...)` with a JSX that the backend can recognize.**

For simplicity in this task: leave the handler bodies similar to other handlers — they call `_backend().exec(jsx)`. The JSX they pass is plugin-specific magic; if the backend doesn't recognize it, exec returns an error JSON which the handler bubbles up. Concretely:

`_run_isolate_toggle`:
```python
async def _run_isolate_toggle(args: schemas.AeIsolateToggleArgs, ctx: Any) -> Any:
    # JSX is a marker the AEBM backend recognizes and routes to its
    # plugin-specific Invoke-AebmTool. Other backends just see normal JSX
    # and either fall back or report unsupported.
    jsx = (
        '(function(){'
        'if (typeof __aebm_isolate_toggle__ === "function") {'
        '  return JSON.stringify(__aebm_isolate_toggle__());'
        '}'
        'return JSON.stringify({ok:false,error:"isolateToggle requires AEBM backend"});'
        '})()'
    )
    async def _call(): return _try_json(await _backend().exec(jsx, timeout_sec=10.0))
    return await progress.run_with_timeout(ctx, _call(), timeout_sec=15.0, start_msg="ae.isolateToggle...")
```

Apply analogously to `_run_toast_query`. Truth is: AEBMBackend will override these via different mechanism in Task 3.2; for now, the JSX-based fallback works for any backend (just returns "unsupported" outside AEBM).

- [ ] **Step 9: Update test_handlers_core.py for the new fixture**

Open `packages/core/tests/test_handlers_core.py`. Find every test using `mock_bridge` and rewrite as `mock_backend`:

```python
# Before:
async def test_ae_ping_default(mock_bridge):
    mock_bridge.set_response("invoke_ae_exec", json.dumps({...}))
    ...

# After:
async def test_ae_ping_default(mock_backend):
    mock_backend.set_response(json.dumps({...}))
    ...
    assert len(mock_backend.calls) >= 1
```

Note: previous tests asserted `mock_bridge.calls[-1][2]["code"]` — now it's `mock_backend.calls[-1]["code"]`. Adjust accordingly.

For tests that needed to return DIFFERENT responses for sequential calls (e.g. `test_checkpoint_create_writes_meta` which had `responses = iter([...])`), use `mock_backend.set_response(callable)` where callable is a closure over the iterator.

- [ ] **Step 10: Run full test suite**

Run: `python -m uv run pytest packages/core/tests/ -m "not live and not live_smoke" -v 2>&1 | tail -30`
Expected: All ~120 tests pass. Some may need additional fixture tweaks; iterate until green.

- [ ] **Step 11: Commit**

```bash
git add packages/core/ae_mcp/handlers/core.py packages/core/tests/test_handlers_core.py
git commit -m "refactor(core): handlers/core.py uses Backend instead of bridge"
```

---

### Task 2.4: Refactor handlers/typed.py to use Backend

**Files:**
- Modify: `packages/core/ae_mcp/handlers/typed.py`
- Modify: `packages/core/tests/test_handlers_typed.py`

The typed handlers (createLayer / setProperty / moveLayer / etc + 6 new read verbs from v0.7) all call `bridge.invoke_ae_exec`. Same pattern as 2.3 — replace with `_backend().exec`.

- [ ] **Step 1: Update imports**

Open `packages/core/ae_mcp/handlers/typed.py`. REPLACE:
```python
from ae_mcp import bridge, progress, schemas
```
with:
```python
from ae_mcp import progress, schemas
from ae_mcp.backends.discovery import select_backend
```

Add the same `_backend()` helper used in `core.py`:
```python
def _backend():
    global _cached_backend
    try: return _cached_backend  # type: ignore
    except NameError: pass
    _cached_backend = select_backend()
    return _cached_backend
```

- [ ] **Step 2: Replace every `bridge.invoke_ae_exec(...)` call with `_backend().exec(...)`**

Concrete replacements (find every `await bridge.invoke_ae_exec` and rewrite):

```python
# Before:
out = await bridge.invoke_ae_exec(
    code=jsx,
    undo_group_name=f"MCP createLayer: {args.name}",
    timeout_sec=30.0,
)

# After:
out = await _backend().exec(
    code=jsx,
    undo_group=f"MCP createLayer: {args.name}",
    timeout_sec=30.0,
)
```

(The keyword changed from `undo_group_name=` to `undo_group=` to match the Backend ABC.)

For read-only verbs that didn't pass `undo_group_name`:
```python
out = await _backend().exec(code=jsx, timeout_sec=20.0)
```

- [ ] **Step 3: Update test_handlers_typed.py for mock_backend**

Same pattern as 2.3 step 9: every `mock_bridge` → `mock_backend`; `mock_bridge.calls[-1][2]["code"]` → `mock_backend.calls[-1]["code"]`.

- [ ] **Step 4: Run full test suite**

Run: `python -m uv run pytest packages/core/tests/ -m "not live and not live_smoke" -v 2>&1 | tail -10`
Expected: All ~120 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/ae_mcp/handlers/typed.py packages/core/tests/test_handlers_typed.py
git commit -m "refactor(core): handlers/typed.py uses Backend instead of bridge"
```

---

### Task 2.5: Delete bridge.py from core (it's no longer needed; aebm backend will reincarnate it)

**Files:**
- Delete: `packages/core/ae_mcp/bridge.py`

- [ ] **Step 1: Delete the file**

```bash
git rm packages/core/ae_mcp/bridge.py
```

- [ ] **Step 2: Verify nothing in core imports bridge anymore**

```bash
grep -rE "from ae_mcp import.*bridge|from ae_mcp.bridge|import ae_mcp.bridge" packages/core/ae_mcp/ packages/core/tests/
```
Expected: empty output.

- [ ] **Step 3: Delete test_bridge.py from core (will be reincarnated in backend-aebm)**

```bash
git rm packages/core/tests/test_bridge.py
```

- [ ] **Step 4: Run unit suite**

Run: `python -m uv run pytest packages/core/tests/ -m "not live and not live_smoke" 2>&1 | tail -3`
Expected: ~105 tests pass (was 120; we removed 15 test_bridge tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(core): remove bridge.py (moves to backend-aebm package)"
```

---

## Phase 3 — backend-aebm package

### Task 3.1: Scaffold backend-aebm package

**Files:**
- Create: `packages/backend-aebm/pyproject.toml`
- Create: `packages/backend-aebm/ae_mcp_backend_aebm/__init__.py` (skeleton)
- Create: `packages/backend-aebm/tests/__init__.py` (empty)
- Create: `packages/backend-aebm/tests/test_aebm_skeleton.py`

- [ ] **Step 1: Create pyproject.toml**

```toml
[project]
name = "ae-mcp-backend-aebm"
version = "0.1.0"
description = "AEBMethod file-bridge backend for ae-mcp"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
dependencies = ["ae-mcp>=0.1.0"]

[project.optional-dependencies]
dev = ["pytest>=7.4", "pytest-asyncio>=0.23"]

[project.entry-points."ae_mcp.backends"]
aebm = "ae_mcp_backend_aebm:AEBMBackend"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["ae_mcp_backend_aebm"]
```

- [ ] **Step 2: Create skeleton README**

`packages/backend-aebm/README.md`:
```markdown
# ae-mcp-backend-aebm

AEBMethod file-bridge backend for [ae-mcp](https://github.com/...).

## Install
    pip install ae-mcp-backend-aebm

## Configure
Set env var `AE_BRIDGE_ROOT` to your AEBMethod plugin checkout, then
`AE_MCP_BACKEND=aebm`.
```

- [ ] **Step 3: Create skeleton AEBMBackend**

`packages/backend-aebm/ae_mcp_backend_aebm/__init__.py`:
```python
"""AEBMethod file-bridge backend implementation."""
from ae_mcp.backends.base import Backend


class AEBMBackend(Backend):
    name = "aebm"
    manages_undo = False
    manages_checkpoints = False

    async def exec(self, code, *, undo_group=None, checkpoint_label=None, timeout_sec=30.0):
        raise NotImplementedError("populated in Task 3.2")

    async def health_check(self, timeout_sec=5.0):
        raise NotImplementedError("populated in Task 3.2")

    @classmethod
    def from_env(cls):
        raise NotImplementedError("populated in Task 3.2")
```

- [ ] **Step 4: Smoke test**

`packages/backend-aebm/tests/test_aebm_skeleton.py`:
```python
def test_aebm_backend_imports():
    from ae_mcp_backend_aebm import AEBMBackend
    assert AEBMBackend.name == "aebm"
    assert hasattr(AEBMBackend, "exec")
```

- [ ] **Step 5: uv sync to register the new package**

Run: `python -m uv sync`
Expected: succeeds; new package installed editable.

- [ ] **Step 6: Run smoke test**

Run: `python -m uv run pytest packages/backend-aebm/tests/test_aebm_skeleton.py -v`
Expected: 1 passed.

- [ ] **Step 7: Verify entry point is registered**

Run:
```bash
python -m uv run python -c "import importlib.metadata as m; eps = m.entry_points(group='ae_mcp.backends'); print([(ep.name, ep.value) for ep in eps])"
```
Expected: `[('aebm', 'ae_mcp_backend_aebm:AEBMBackend')]`.

- [ ] **Step 8: Commit**

```bash
git add packages/backend-aebm/
git commit -m "feat(backend-aebm): scaffold package + entry point registration"
```

---

### Task 3.2: Port bridge.py logic into AEBMBackend

**Files:**
- Modify: `packages/backend-aebm/ae_mcp_backend_aebm/__init__.py`
- Create: `packages/backend-aebm/tests/test_aebm_backend.py`

- [ ] **Step 1: Recover the v0.7 bridge.py code**

```bash
git show feat/0.1-rebrand-decouple~7:packages/core/ae_mcp/bridge.py > /tmp/old_bridge.py
```

(Adjust the commit ref `~7` to whichever was the last commit before bridge.py was deleted.)

- [ ] **Step 2: Write `packages/backend-aebm/ae_mcp_backend_aebm/__init__.py`**

```python
"""AEBMethod file-bridge backend.

Wraps the existing pwsh subprocess + file-queue protocol used by
the AEBMethod After Effects plugin. Reads AE_BRIDGE_ROOT env var
to locate scripts/backend_interface.ps1.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from ae_mcp.backends.base import Backend, BackendError

log = logging.getLogger("ae_mcp_backend_aebm")


class AEBMBackend(Backend):
    name = "aebm"
    manages_undo = False
    manages_checkpoints = False

    def __init__(self, bridge_root: Path) -> None:
        self.bridge_root = bridge_root
        self._interface_ps1 = bridge_root / "scripts" / "backend_interface.ps1"
        if not self._interface_ps1.is_file():
            raise EnvironmentError(
                f"AEBMBackend: scripts/backend_interface.ps1 not found under {bridge_root}"
            )

    @classmethod
    def from_env(cls) -> "AEBMBackend":
        env = os.environ.get("AE_BRIDGE_ROOT")
        if not env:
            raise EnvironmentError(
                "AEBMBackend requires AE_BRIDGE_ROOT env var pointing at "
                "the AEBMethod plugin checkout (which contains "
                "scripts/backend_interface.ps1)."
            )
        p = Path(env).resolve()
        return cls(bridge_root=p)

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        try:
            out = await self.exec(
                code='JSON.stringify({ok:true,ping:"pong"})',
                timeout_sec=timeout_sec,
            )
            return "pong" in out
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
        """Run JSX via pwsh -> AEBMethod backend_interface.ps1 -> file queue."""
        named_args: Dict[str, Any] = {"TimeoutSec": int(timeout_sec)}
        if undo_group:
            named_args["UndoGroupName"] = undo_group
        if checkpoint_label:
            named_args["CheckpointLabel"] = checkpoint_label

        return await self._run_ps(
            "Invoke-AeExec",
            named_args,
            code=code,
            code_param="Code",
            timeout_sec=timeout_sec + 5.0,
        )

    # ---- internals (lifted from old bridge.py, unchanged in spirit) ----

    async def _run_ps(
        self,
        function: str,
        named_args: Dict[str, Any],
        *,
        code: Optional[str] = None,
        code_param: str = "Code",
        timeout_sec: float = 30.0,
    ) -> str:
        tmp_path: Optional[str] = None
        env = os.environ.copy()

        if code is not None:
            tmp = tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", suffix=".jsx", delete=False, newline="\n"
            )
            try:
                tmp.write(code)
                tmp.flush()
                tmp_path = tmp.name
            finally:
                tmp.close()
            env["AEBM_CODE_FILE"] = tmp_path

        invocation_parts = [function]
        for k, v in named_args.items():
            if v is None:
                continue
            if isinstance(v, bool):
                if v: invocation_parts.append(f"-{k}")
                continue
            invocation_parts.append(f"-{k}")
            invocation_parts.append(self._render_ps_value(v))
        if code is not None:
            invocation_parts.append(f"-{code_param}")
            invocation_parts.append("$AEBM_Code")

        invocation = " ".join(invocation_parts)
        script_parts = [
            "$ErrorActionPreference = 'Stop'",
            "$env:AE_BACKEND = 'aebm-file'",
            f". '{str(self._interface_ps1).replace(chr(39), chr(39)*2)}'",
            "Initialize-Backend | Out-Null",
        ]
        if code is not None:
            script_parts.append(
                "$AEBM_Code = [System.IO.File]::ReadAllText("
                "$env:AEBM_CODE_FILE, [System.Text.Encoding]::UTF8)"
            )
        script_parts.append(invocation)
        script = "\n".join(script_parts)

        try:
            proc = await asyncio.create_subprocess_exec(
                "powershell", "-NoProfile", "-NonInteractive", "-Command", script,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout_sec
                )
            except asyncio.TimeoutError:
                try: proc.kill()
                except ProcessLookupError: pass
                raise BackendError(f"AEBMBackend: pwsh {function} timed out after {timeout_sec}s")
        finally:
            if tmp_path:
                try: os.unlink(tmp_path)
                except OSError: pass

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            raise BackendError(
                f"AEBMBackend: pwsh {function} failed (exit {proc.returncode}): "
                f"{stderr.strip() or stdout.strip()}"
            )
        return stdout.strip()

    @staticmethod
    def _render_ps_value(v: Any) -> str:
        if v is None: return "$null"
        if isinstance(v, bool): return "$true" if v else "$false"
        if isinstance(v, (int, float)): return str(v)
        if isinstance(v, str):
            return "'" + v.replace("'", "''") + "'"
        if isinstance(v, (list, tuple)):
            inner = ", ".join(AEBMBackend._render_ps_value(x) for x in v)
            return f"@({inner})"
        raise TypeError(f"unsupported PS value type: {type(v).__name__}")
```

- [ ] **Step 3: Write tests**

`packages/backend-aebm/tests/test_aebm_backend.py`:
```python
"""Unit tests for AEBMBackend (subprocess mocked)."""
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from ae_mcp_backend_aebm import AEBMBackend


def test_render_ps_value_none():
    assert AEBMBackend._render_ps_value(None) == "$null"


def test_render_ps_value_bool():
    assert AEBMBackend._render_ps_value(True) == "$true"
    assert AEBMBackend._render_ps_value(False) == "$false"


def test_render_ps_value_int_float_str():
    assert AEBMBackend._render_ps_value(42) == "42"
    assert AEBMBackend._render_ps_value(3.14) == "3.14"
    assert AEBMBackend._render_ps_value("hi") == "'hi'"
    assert AEBMBackend._render_ps_value("it's") == "'it''s'"


def test_render_ps_value_list():
    assert AEBMBackend._render_ps_value([1, 2, 3]) == "@(1, 2, 3)"


def test_from_env_missing_raises(monkeypatch):
    monkeypatch.delenv("AE_BRIDGE_ROOT", raising=False)
    with pytest.raises(EnvironmentError) as ei:
        AEBMBackend.from_env()
    assert "AE_BRIDGE_ROOT" in str(ei.value)


def test_from_env_invalid_path_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_BRIDGE_ROOT", str(tmp_path))
    with pytest.raises(EnvironmentError):
        AEBMBackend.from_env()


def test_from_env_valid_path(monkeypatch, tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "backend_interface.ps1").write_text("# stub")
    monkeypatch.setenv("AE_BRIDGE_ROOT", str(tmp_path))
    b = AEBMBackend.from_env()
    assert b.bridge_root == tmp_path.resolve()


@pytest.mark.asyncio
async def test_exec_calls_subprocess(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "backend_interface.ps1").write_text("# stub")

    backend = AEBMBackend(bridge_root=tmp_path)

    async def fake_create(*a, **kw):
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b'{"ok":true}', b''))
        return proc

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_create)

    out = await backend.exec(code="42", timeout_sec=5.0)
    assert out == '{"ok":true}'
```

- [ ] **Step 4: Run tests**

Run: `python -m uv run pytest packages/backend-aebm/tests/ -v`
Expected: 8 passed.

- [ ] **Step 5: Wire backend into core handler tests via fixture**

Verify the `mock_backend` fixture in core still works (it patches `select_backend`, so the entry-point-registered AEBMBackend doesn't interfere).

Run: `python -m uv run pytest packages/core/tests/ -m "not live and not live_smoke" 2>&1 | tail -3`
Expected: All core unit tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/backend-aebm/
git commit -m "feat(backend-aebm): port bridge.py logic into AEBMBackend"
```

---

## Phase 4 — backend-atom package

### Task 4.1: Scaffold backend-atom + handshake protocol

**Files:**
- Create: `packages/backend-atom/pyproject.toml`
- Create: `packages/backend-atom/README.md`
- Create: `packages/backend-atom/ae_mcp_backend_atom/__init__.py`
- Create: `packages/backend-atom/ae_mcp_backend_atom/protocol.py`
- Create: `packages/backend-atom/tests/__init__.py`
- Create: `packages/backend-atom/tests/test_atom_protocol.py`

- [ ] **Step 1: pyproject.toml**

```toml
[project]
name = "ae-mcp-backend-atom"
version = "0.1.0"
description = "Atom MCP HTTP backend for ae-mcp"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
dependencies = [
    "ae-mcp>=0.1.0",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=7.4", "pytest-asyncio>=0.23", "respx>=0.21"]

[project.entry-points."ae_mcp.backends"]
atom = "ae_mcp_backend_atom:AtomBackend"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["ae_mcp_backend_atom"]
```

- [ ] **Step 2: README**

`packages/backend-atom/README.md`:
```markdown
# ae-mcp-backend-atom

Atom MCP HTTP backend for [ae-mcp](https://github.com/...).
Talks directly to the Atom plugin's local HTTP server (no pwsh).

## Install
    pip install ae-mcp-backend-atom

## Configure
Open the Atom panel in After Effects, enable MCP Mode. Then:

    AE_MCP_BACKEND=atom
    ATOM_MCP_URL=http://127.0.0.1:11487/mcp   # default
```

- [ ] **Step 3: Write the protocol layer in protocol.py**

```python
"""Atom MCP Streamable HTTP protocol — client side.

Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
Atom-specific quirks documented in (originally)
E:/Code/AEBMethod/docs/development/ATOM_INTEGRATION.md.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Dict, Optional

import httpx


REQUIRED_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


class AtomProtocolError(RuntimeError):
    pass


class AtomSessionGoneError(AtomProtocolError):
    """Server returned 'Session ID required' or similar; caller should reconnect."""


class AtomClient:
    """Single-connection async client for Atom's HTTP MCP endpoint."""

    def __init__(self, url: str, *, timeout_sec: float = 30.0) -> None:
        self.url = url
        self._timeout = timeout_sec
        self._http = httpx.AsyncClient(timeout=timeout_sec)
        self._session_id: Optional[str] = None
        self._init_lock = asyncio.Lock()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def initialize(self) -> None:
        """Three-step handshake: initialize, notifications/initialized, capture session id."""
        async with self._init_lock:
            req_id = str(uuid.uuid4())
            init_payload = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "ae-mcp-backend-atom", "version": "0.1.0"},
                },
            }
            r = await self._http.post(self.url, headers=REQUIRED_HEADERS,
                                       content=json.dumps(init_payload))
            if r.status_code != 200:
                raise AtomProtocolError(
                    f"initialize failed: HTTP {r.status_code}: {r.text[:300]}"
                )
            # session id can be in any of three header casings
            sid = (r.headers.get("Mcp-Session-Id")
                   or r.headers.get("mcp-session-id")
                   or r.headers.get("MCP-Session-Id"))
            if not sid:
                raise AtomProtocolError("initialize: no Mcp-Session-Id in response headers")
            self._session_id = sid

            notif = {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            }
            r2 = await self._http.post(
                self.url,
                headers={**REQUIRED_HEADERS, "Mcp-Session-Id": sid},
                content=json.dumps(notif),
            )
            if r2.status_code not in (200, 202):
                raise AtomProtocolError(
                    f"notifications/initialized failed: HTTP {r2.status_code}"
                )

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        if self._session_id is None:
            await self.initialize()

        req_id = str(uuid.uuid4())
        payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }
        try:
            return await self._post(payload)
        except AtomSessionGoneError:
            # one-shot reinit then retry
            self._session_id = None
            await self.initialize()
            return await self._post(payload)

    async def _post(self, payload: Dict[str, Any]) -> Any:
        headers = {**REQUIRED_HEADERS, "Mcp-Session-Id": self._session_id or ""}
        r = await self._http.post(self.url, headers=headers,
                                   content=json.dumps(payload))
        if r.status_code in (400, 404) and "Session ID" in r.text:
            raise AtomSessionGoneError(r.text)
        if r.status_code != 200:
            raise AtomProtocolError(
                f"tools/call HTTP {r.status_code}: {r.text[:300]}"
            )
        body = r.json()
        if "error" in body:
            raise AtomProtocolError(
                f"tools/call returned JSON-RPC error: {body['error']}"
            )
        return body.get("result")
```

- [ ] **Step 4: Write AtomBackend wrapper**

`packages/backend-atom/ae_mcp_backend_atom/__init__.py`:
```python
"""AtomBackend — wraps AtomClient for the ae-mcp Backend interface."""
from __future__ import annotations

import json
import os
from typing import Optional

from ae_mcp.backends.base import Backend, BackendError
from ae_mcp_backend_atom.protocol import AtomClient, AtomProtocolError


class AtomBackend(Backend):
    name = "atom"
    manages_undo = True            # Atom auto-wraps undo group around tools/call
    manages_checkpoints = True     # Atom auto-creates checkpoints

    def __init__(self, url: str) -> None:
        self.url = url
        self._client = AtomClient(url)

    @classmethod
    def from_env(cls) -> "AtomBackend":
        url = os.environ.get("ATOM_MCP_URL", "http://127.0.0.1:11487/mcp")
        return cls(url=url)

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        try:
            out = await self.exec(
                code='JSON.stringify({ok:true,ping:"pong"})',
                timeout_sec=timeout_sec,
            )
            return "pong" in out
        except Exception:  # noqa: BLE001
            return False

    async def exec(self, code, *, undo_group=None, checkpoint_label=None, timeout_sec=30.0):
        try:
            result = await self._client.call_tool(
                "run_extendscript",
                {"code": code},
            )
        except AtomProtocolError as e:
            raise BackendError(f"AtomBackend: {e}") from e

        # Atom returns {"content": [{"type": "text", "text": "..."}], "isError": ...}
        if isinstance(result, dict):
            content = result.get("content", [])
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    return item.get("text", "")
        return json.dumps(result) if result is not None else ""

    async def shutdown(self):
        await self._client.aclose()
```

- [ ] **Step 5: Tests for protocol layer**

`packages/backend-atom/tests/test_atom_protocol.py`:
```python
"""Unit tests for AtomClient using respx mock transport."""
import json
import pytest
import respx
from httpx import Response

from ae_mcp_backend_atom.protocol import AtomClient, AtomProtocolError, AtomSessionGoneError


@pytest.mark.asyncio
async def test_initialize_captures_session_id():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        # initialize call
        mock.post("/mcp").mock(side_effect=[
            Response(200,
                     headers={"Mcp-Session-Id": "abc123"},
                     json={"jsonrpc": "2.0", "id": "x", "result": {"capabilities": {}}}),
            Response(202),  # notifications/initialized
        ])
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            await c.initialize()
            assert c._session_id == "abc123"
        finally:
            await c.aclose()


@pytest.mark.asyncio
async def test_call_tool_returns_result():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(side_effect=[
            Response(200,
                     headers={"Mcp-Session-Id": "sid"},
                     json={"jsonrpc": "2.0", "id": "x", "result": {}}),
            Response(202),
            Response(200,
                     json={"jsonrpc": "2.0", "id": "y",
                           "result": {"content": [{"type": "text", "text": "hello"}]}}),
        ])
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            r = await c.call_tool("run_extendscript", {"code": "1+1"})
            assert r == {"content": [{"type": "text", "text": "hello"}]}
        finally:
            await c.aclose()


@pytest.mark.asyncio
async def test_stale_session_triggers_reinit():
    """First call returns 400 'Session ID required'; client reinits and retries."""
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(side_effect=[
            # first init
            Response(200, headers={"Mcp-Session-Id": "old"}, json={"result": {}}),
            Response(202),
            # call_tool: stale
            Response(400, text='{"error":{"message":"Session ID required"}}'),
            # reinit
            Response(200, headers={"Mcp-Session-Id": "new"}, json={"result": {}}),
            Response(202),
            # retry succeeds
            Response(200, json={"result": {"content": [{"type": "text", "text": "ok"}]}}),
        ])
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            r = await c.call_tool("run_extendscript", {"code": "1"})
            assert r["content"][0]["text"] == "ok"
            assert c._session_id == "new"
        finally:
            await c.aclose()


@pytest.mark.asyncio
async def test_non_200_raises_protocol_error():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(return_value=Response(500, text="boom"))
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            with pytest.raises(AtomProtocolError):
                await c.initialize()
        finally:
            await c.aclose()
```

- [ ] **Step 6: uv sync**

Run: `python -m uv sync`
Expected: succeeds; `httpx` and `respx` (dev) installed.

- [ ] **Step 7: Run tests**

Run: `python -m uv run pytest packages/backend-atom/tests/ -v`
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add packages/backend-atom/
git commit -m "feat(backend-atom): scaffold + AtomClient HTTP protocol"
```

---

### Task 4.2: Verify AtomBackend integrates with core (selection + smoke)

**Files:**
- Modify: `packages/backend-atom/tests/test_atom_protocol.py` (add backend-level tests)

- [ ] **Step 1: Write backend-level test**

Append to `packages/backend-atom/tests/test_atom_protocol.py`:

```python
import respx
from httpx import Response
from ae_mcp_backend_atom import AtomBackend


@pytest.mark.asyncio
async def test_atom_backend_exec_returns_text():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(side_effect=[
            Response(200, headers={"Mcp-Session-Id": "sid"}, json={"result": {}}),
            Response(202),
            Response(200, json={"result": {"content": [{"type": "text", "text": "42"}]}}),
        ])
        b = AtomBackend("http://127.0.0.1:11487/mcp")
        try:
            out = await b.exec(code="40+2")
            assert out == "42"
        finally:
            await b.shutdown()


def test_atom_backend_capability_flags():
    assert AtomBackend.manages_undo is True
    assert AtomBackend.manages_checkpoints is True


def test_atom_backend_from_env_default_url(monkeypatch):
    monkeypatch.delenv("ATOM_MCP_URL", raising=False)
    b = AtomBackend.from_env()
    assert b.url == "http://127.0.0.1:11487/mcp"


def test_atom_backend_from_env_custom_url(monkeypatch):
    monkeypatch.setenv("ATOM_MCP_URL", "http://localhost:9999/mcp")
    b = AtomBackend.from_env()
    assert b.url == "http://localhost:9999/mcp"
```

- [ ] **Step 2: Run**

Run: `python -m uv run pytest packages/backend-atom/tests/ -v`
Expected: 8 passed.

- [ ] **Step 3: Verify entry point registered**

```bash
python -m uv run python -c "import importlib.metadata as m; eps = m.entry_points(group='ae_mcp.backends'); print(sorted([ep.name for ep in eps]))"
```
Expected: `['aebm', 'atom']`.

- [ ] **Step 4: Verify multi-backend selection error path**

```bash
python -m uv run python -c "from ae_mcp.backends.discovery import select_backend; select_backend()"
```
Expected: `BackendSelectionError: multiple backends installed: ['aebm', 'atom']. Set AE_MCP_BACKEND=<name> to choose one.`

- [ ] **Step 5: Commit**

```bash
git add packages/backend-atom/tests/test_atom_protocol.py
git commit -m "test(backend-atom): AtomBackend integration tests"
```

---

## Phase 5 — Snapshot abstraction + snapshot-mss package

### Task 5.1: Snapshotter ABC + discovery + hide ae.snapshot when missing

**Files:**
- Create: `packages/core/ae_mcp/snapshot/__init__.py`
- Create: `packages/core/ae_mcp/snapshot/base.py`
- Create: `packages/core/ae_mcp/snapshot/discovery.py`
- Create: `packages/core/tests/test_snapshot_discovery.py`
- Modify: `packages/core/ae_mcp/handlers/core.py` (the `_run_snapshot` handler)
- Modify: `packages/core/ae_mcp/server.py` (filter tools/list)
- Delete: `packages/core/ae_mcp/snapshot.py` (the old single-file module)

- [ ] **Step 1: Write failing tests**

`packages/core/tests/test_snapshot_discovery.py`:
```python
"""Tests for snapshotter discovery."""
import pytest
from unittest.mock import patch

from ae_mcp.snapshot.base import Snapshotter
from ae_mcp.snapshot.discovery import (
    select_snapshotter, list_installed_snapshotters, SnapshotSelectionError,
)


class FakeSnap(Snapshotter):
    name = "fake"
    async def capture(self, out_path, *, hwnd=None, main_window=False, method="auto"):
        return {"ok": True, "path": str(out_path), "bytes": 100, "width": 10, "height": 10}
    def supports_platform(self): return True


class FakeSnapBadOS(Snapshotter):
    name = "bados"
    async def capture(self, out_path, **kw): return {"ok": True}
    def supports_platform(self): return False


def _patch_installed(installed):
    return patch("ae_mcp.snapshot.discovery._scan_entry_points",
                 return_value=installed)


def test_no_snapshotter_returns_none():
    with _patch_installed({}):
        assert select_snapshotter() is None


def test_one_supported_returns_it():
    with _patch_installed({"fake": FakeSnap}):
        s = select_snapshotter()
        assert isinstance(s, FakeSnap)


def test_unsupported_platform_filtered_out():
    with _patch_installed({"bados": FakeSnapBadOS}):
        assert select_snapshotter() is None


def test_multiple_installed_picks_first_supported():
    with _patch_installed({"bados": FakeSnapBadOS, "fake": FakeSnap}):
        s = select_snapshotter()
        assert isinstance(s, FakeSnap)
```

- [ ] **Step 2: Run, expect ImportError**

Run: `python -m uv run pytest packages/core/tests/test_snapshot_discovery.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement base.py**

`packages/core/ae_mcp/snapshot/base.py`:
```python
"""Abstract Snapshotter — capture AE viewer/main window pixels."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


class Snapshotter(ABC):
    name: str

    @abstractmethod
    async def capture(
        self,
        out_path: Optional[Path],
        *,
        hwnd: Optional[str] = None,
        main_window: bool = False,
        method: str = "auto",
    ) -> dict:
        """Capture a PNG. Returns {ok, path, bytes, width, height, hwnd?, method}."""

    @abstractmethod
    def supports_platform(self) -> bool:
        """Return True if this snapshotter can run on the current OS."""
```

`packages/core/ae_mcp/snapshot/__init__.py`:
```python
"""Snapshot subsystem — pluggable PNG capture for AE viewer/main window."""
from ae_mcp.snapshot.base import Snapshotter
from ae_mcp.snapshot.discovery import select_snapshotter, SnapshotSelectionError

__all__ = ["Snapshotter", "select_snapshotter", "SnapshotSelectionError"]
```

- [ ] **Step 4: Implement discovery.py**

`packages/core/ae_mcp/snapshot/discovery.py`:
```python
"""Snapshotter discovery via Python entry points."""
from __future__ import annotations

import importlib.metadata
from typing import Dict, Optional, Type

from ae_mcp.snapshot.base import Snapshotter


ENTRY_POINT_GROUP = "ae_mcp.snapshotters"


class SnapshotSelectionError(RuntimeError):
    pass


def _scan_entry_points() -> Dict[str, Type[Snapshotter]]:
    eps = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    return {ep.name: ep.load() for ep in eps}


def list_installed_snapshotters() -> Dict[str, Type[Snapshotter]]:
    return _scan_entry_points()


def select_snapshotter() -> Optional[Snapshotter]:
    """Return the first snapshotter whose supports_platform() is True.

    Returns None if no usable snapshotter is installed; core uses this
    to hide ae.snapshot from tools/list.
    """
    installed = _scan_entry_points()
    for name, cls in sorted(installed.items()):
        inst = cls()
        if inst.supports_platform():
            return inst
    return None
```

- [ ] **Step 5: Run discovery tests, expect green**

Run: `python -m uv run pytest packages/core/tests/test_snapshot_discovery.py -v`
Expected: 4 passed.

- [ ] **Step 6: Update _run_snapshot in handlers/core.py**

Find the existing `_run_snapshot` (which imports `from ae_mcp import snapshot as snap`). Replace its body:

```python
async def _run_snapshot(args: schemas.AeSnapshotArgs, ctx: Any) -> Any:
    from ae_mcp.snapshot.discovery import select_snapshotter
    snapper = select_snapshotter()
    if snapper is None:
        return {"ok": False, "error":
                "no snapshotter installed (try `pip install ae-mcp-snapshot-mss`)"}
    try:
        from pathlib import Path
        out_path = Path(args.out_path) if args.out_path else None
        return await snapper.capture(
            out_path,
            hwnd=args.hwnd,
            main_window=args.main_window,
            method=args.method,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("ae.snapshot failed")
        return {"ok": False, "error": str(e)}
```

- [ ] **Step 7: Update server.py to filter ae.snapshot from tools/list**

Open `packages/core/ae_mcp/server.py`, find where `tools/list` is built. Add filtering logic:

```python
# Inside the list_tools() handler:
from ae_mcp.snapshot.discovery import select_snapshotter
backend = get_active_backend()
snap = select_snapshotter()
filtered = []
for tool in all_tools:
    if tool.name not in backend.supported_verbs():
        continue
    if tool.name == "ae.snapshot" and snap is None:
        continue
    filtered.append(tool)
return filtered
```

(Adapt to whatever the actual server.py structure is; the principle is: filter by `backend.supported_verbs()` and hide `ae.snapshot` when no snapshotter.)

- [ ] **Step 8: Delete old single-file snapshot.py**

```bash
git rm packages/core/ae_mcp/snapshot.py
```

(If `snapshot.py` exists as a file alongside the new `snapshot/` directory, delete the file. The directory takes its place.)

- [ ] **Step 9: Update old snapshot test if any**

Find `packages/core/tests/test_snapshot.py`. The Win32 ctypes tests are no longer applicable to core (moved to snapshot-mss in next task). Delete:

```bash
git rm packages/core/tests/test_snapshot.py
```

- [ ] **Step 10: Run core tests**

Run: `python -m uv run pytest packages/core/tests/ -m "not live and not live_smoke" 2>&1 | tail -3`
Expected: green; total ~100-105 tests (we removed test_snapshot.py's 4 tests, added test_snapshot_discovery's 4).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(core): Snapshotter ABC + discovery; hide ae.snapshot when missing"
```

---

### Task 5.2: snapshot-mss package

**Files:**
- Create: `packages/snapshot-mss/pyproject.toml`
- Create: `packages/snapshot-mss/README.md`
- Create: `packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`
- Create: `packages/snapshot-mss/ae_mcp_snapshot_mss/_hwnd_rect.py`
- Create: `packages/snapshot-mss/tests/__init__.py`
- Create: `packages/snapshot-mss/tests/test_mss_snapshot.py`

- [ ] **Step 1: pyproject.toml**

```toml
[project]
name = "ae-mcp-snapshot-mss"
version = "0.1.0"
description = "Cross-platform mss-based screen capture for ae-mcp"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
dependencies = [
    "ae-mcp>=0.1.0",
    "mss>=10.0",
    "pillow>=10.0.0",
]

[project.optional-dependencies]
dev = ["pytest>=7.4", "pytest-asyncio>=0.23"]

[project.entry-points."ae_mcp.snapshotters"]
mss = "ae_mcp_snapshot_mss:MssSnapshotter"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["ae_mcp_snapshot_mss"]
```

- [ ] **Step 2: README**

`packages/snapshot-mss/README.md`:
```markdown
# ae-mcp-snapshot-mss

Cross-platform `ae.snapshot` implementation for ae-mcp, using
[mss](https://python-mss.readthedocs.io/).

Supports Windows, macOS, and Linux. Captures by screen rect; HWND →
rect translation is OS-specific.

## Install
    pip install ae-mcp-snapshot-mss
```

- [ ] **Step 3: Write _hwnd_rect.py (OS-specific HWND → rect)**

```python
"""Translate a window handle to a screen rect across OSes."""
from __future__ import annotations

import sys
from typing import Optional, Tuple


def hwnd_to_rect(hwnd: Optional[int]) -> Optional[Tuple[int, int, int, int]]:
    """Return (left, top, right, bottom) screen coords for `hwnd`, or None.

    On Windows: uses ctypes user32.GetWindowRect.
    On macOS:   not yet implemented for arbitrary windowID; returns None.
                (Most common case — main_window=True — handled by caller via
                 mss's full-monitor grab fallback.)
    On Linux:   not yet implemented; returns None.

    Caller falls back to monitor-0 capture when this returns None.
    """
    if hwnd is None:
        return None
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        rect = wintypes.RECT()
        if user32.GetWindowRect(int(hwnd), ctypes.byref(rect)):
            return (rect.left, rect.top, rect.right, rect.bottom)
        return None
    return None


def find_ae_main_hwnd() -> Optional[int]:
    """Best-effort find AE main window. Windows-only; returns None elsewhere."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    found = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HWND, wintypes.LPARAM,
    )

    def callback(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if "After Effects" in title:
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(EnumWindowsProc(callback), 0)
    return found[0] if found else None
```

- [ ] **Step 4: Write MssSnapshotter**

`packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`:
```python
"""mss-backed cross-platform ae.snapshot implementation."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import mss
from PIL import Image

from ae_mcp.snapshot.base import Snapshotter
from ae_mcp_snapshot_mss._hwnd_rect import hwnd_to_rect, find_ae_main_hwnd


class MssSnapshotter(Snapshotter):
    name = "mss"

    def supports_platform(self) -> bool:
        # mss runs on Windows, macOS, Linux
        return True

    async def capture(
        self,
        out_path: Optional[Path],
        *,
        hwnd: Optional[str] = None,
        main_window: bool = False,
        method: str = "auto",
    ) -> dict:
        if out_path is None:
            ts = int(time.time() * 1000)
            out_path = Path(f"ae_viewer_{ts}.png")
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        # Resolve target rect
        target_hwnd: Optional[int] = None
        if hwnd:
            target_hwnd = int(hwnd, 16) if hwnd.lower().startswith("0x") else int(hwnd)
        elif main_window:
            target_hwnd = find_ae_main_hwnd()

        rect = hwnd_to_rect(target_hwnd) if target_hwnd else None

        with mss.mss() as sct:
            if rect is None:
                # fallback: capture primary monitor
                monitor = sct.monitors[1]
            else:
                left, top, right, bottom = rect
                width, height = right - left, bottom - top
                if width <= 0 or height <= 0:
                    return {"ok": False, "error":
                            f"target hwnd {target_hwnd:#x} has zero size ({width}x{height})"}
                monitor = {"left": left, "top": top, "width": width, "height": height}
            shot = sct.grab(monitor)
            img = Image.frombytes("RGB", shot.size, shot.rgb)
            img.save(out_path, "PNG")

        return {
            "ok": True,
            "path": str(out_path),
            "bytes": out_path.stat().st_size,
            "width": img.width,
            "height": img.height,
            "hwnd": f"0x{target_hwnd:X}" if target_hwnd else None,
            "method": method,
        }
```

- [ ] **Step 5: Tests**

`packages/snapshot-mss/tests/test_mss_snapshot.py`:
```python
"""Unit tests for MssSnapshotter (mss + PIL mocked where needed)."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from ae_mcp_snapshot_mss import MssSnapshotter


def test_supports_platform_always_true():
    assert MssSnapshotter().supports_platform() is True


def test_name_is_mss():
    assert MssSnapshotter.name == "mss"


@pytest.mark.asyncio
async def test_capture_writes_png(tmp_path):
    out = tmp_path / "smoke.png"
    s = MssSnapshotter()

    fake_shot = MagicMock()
    fake_shot.size = (10, 10)
    fake_shot.rgb = b"\xff" * (10 * 10 * 3)

    with patch("mss.mss") as mss_factory:
        mss_inst = MagicMock()
        mss_inst.__enter__ = MagicMock(return_value=mss_inst)
        mss_inst.__exit__ = MagicMock(return_value=False)
        mss_inst.monitors = [None, {"left": 0, "top": 0, "width": 10, "height": 10}]
        mss_inst.grab = MagicMock(return_value=fake_shot)
        mss_factory.return_value = mss_inst

        result = await s.capture(out)

    assert result["ok"] is True
    assert out.exists()
    assert result["path"] == str(out)
    assert result["width"] == 10
    assert result["height"] == 10


@pytest.mark.asyncio
async def test_capture_zero_size_returns_error():
    s = MssSnapshotter()
    with patch("ae_mcp_snapshot_mss.hwnd_to_rect", return_value=(0, 0, 0, 0)):
        r = await s.capture(Path("/tmp/x.png"), hwnd="0x1234")
    assert r["ok"] is False
    assert "zero size" in r["error"]
```

- [ ] **Step 6: uv sync + run**

Run: `python -m uv sync && python -m uv run pytest packages/snapshot-mss/tests/ -v`
Expected: 4 passed.

- [ ] **Step 7: Verify entry point**

Run: `python -m uv run python -c "import importlib.metadata as m; print(sorted([ep.name for ep in m.entry_points(group='ae_mcp.snapshotters')]))"`
Expected: `['mss']`.

- [ ] **Step 8: Commit**

```bash
git add packages/snapshot-mss/
git commit -m "feat(snapshot-mss): cross-platform mss-based ae.snapshot impl"
```

---

## Phase 6 — Live tests + final smoke

### Task 6.1: Move live tests under packages/core/tests/live/, parametrize backend

**Files:**
- Modify: `packages/core/tests/live/conftest.py`

The v0.7 live conftest hard-coded `bridge.invoke_ae_exec`. Replace with backend-aware fixture:

- [ ] **Step 1: Rewrite live/conftest.py**

```python
"""Live test fixtures — opt-in only, requires real AE + a backend reachable."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from ae_mcp.backends.discovery import select_backend


def _live_enabled() -> bool:
    return os.environ.get("AEBM_LIVE_TESTS") == "1"


@pytest.fixture(scope="session", autouse=True)
def _live_gate():
    if not _live_enabled():
        pytest.skip("live tests are opt-in: export AEBM_LIVE_TESTS=1")


@pytest.fixture(scope="session")
def live_backend():
    """Backend selected by AE_MCP_BACKEND; verify reachable, fail session early if not."""
    try:
        backend = select_backend()
    except Exception as e:  # noqa: BLE001
        pytest.fail(f"live: backend selection failed: {e}")

    healthy = asyncio.run(backend.health_check(timeout_sec=10.0))
    if not healthy:
        pytest.fail(
            f"live: backend {backend.name!r} health_check failed. "
            f"Is AE running with the matching plugin loaded?"
        )
    yield backend
    asyncio.run(backend.shutdown())


@pytest.fixture
def clean_project(live_backend):
    setup = (
        '(function(){'
        'try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}'
        'app.newProject();'
        'return JSON.stringify({ok:true});'
        '})()'
    )
    asyncio.run(live_backend.exec(code=setup, timeout_sec=15.0))
    yield live_backend
    teardown = (
        '(function(){'
        'try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}'
        'return JSON.stringify({ok:true});'
        '})()'
    )
    try:
        asyncio.run(live_backend.exec(code=teardown, timeout_sec=10.0))
    except Exception:
        pass


@pytest.fixture
def artifact_dir(request):
    name = request.node.name.replace("/", "_").replace("[", "_").replace("]", "_")
    d = Path(__file__).parent / "_artifacts" / name
    d.mkdir(parents=True, exist_ok=True)
    return d
```

- [ ] **Step 2: Update live tests to use `live_backend` instead of `live_bridge`**

In `tests/live/test_smoke.py`, `test_read_verbs.py`, `test_checkpoint_cycle.py` — find every `live_bridge` reference and rename to `live_backend`. Find every `bridge.invoke_ae_exec(...)` and rewrite as `live_backend.exec(...)`.

- [ ] **Step 3: Verify default pytest still skips live**

Run: `python -m uv run pytest 2>&1 | tail -3`
Expected: ~108 passed, 10 deselected (live count unchanged).

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/live/
git commit -m "test(live): backend-parametrized live test fixtures"
```

---

### Task 6.2: Update README, .mcp.json.template, MIGRATION.md, REFERENCE.md

**Files:**
- Rewrite: `README.md`
- Rewrite: `.mcp.json.template`
- Create: `MIGRATION.md`
- Rewrite: `docs/REFERENCE.md`

- [ ] **Step 1: Rewrite .mcp.json.template (top-level repo file)**

```json
{
  "mcpServers": {
    "ae": {
      "command": "python",
      "args": [
        "-m", "uv", "run",
        "--directory", "<PATH_TO_THIS_REPO_OR_PIP_INSTALL_LOCATION>",
        "python", "-m", "ae_mcp"
      ],
      "env": {
        "AE_MCP_BACKEND": "<aebm | atom | other-installed-backend>",
        "AE_BRIDGE_ROOT": "<only if AE_MCP_BACKEND=aebm — path to AEBMethod plugin checkout>",
        "ATOM_MCP_URL": "<only if AE_MCP_BACKEND=atom — default http://127.0.0.1:11487/mcp>"
      }
    }
  }
}
```

- [ ] **Step 2: Create MIGRATION.md**

```markdown
# Migration: `after-effects-mcp` v0.7 → `ae-mcp` 0.1

This project was renamed from `after-effects-mcp` to `ae-mcp` and reset
to **0.1.0** as part of becoming a standalone, plugin-agnostic product.

## Migration steps

```powershell
# 1) Uninstall the old package
pip uninstall after-effects-mcp

# 2) Install the new core + at least one backend
pip install ae-mcp ae-mcp-backend-aebm   # or ae-mcp-backend-atom
pip install ae-mcp-snapshot-mss          # optional: enables ae.snapshot

# 3) Update your .mcp.json — see .mcp.json.template
#    - Server key:   "aebm" → "ae"
#    - Module:       "after_effects_mcp" → "ae_mcp"
#    - Env var:      AE_BRIDGE_ROOT alone → AE_MCP_BACKEND=aebm + AE_BRIDGE_ROOT
```

## What changed?

- **PyPI name:** `after-effects-mcp` → `ae-mcp`
- **Python module:** `after_effects_mcp` → `ae_mcp`
- **MCP server name:** `aebm` → `ae`
- **Backend selection:** add `AE_MCP_BACKEND` env var
- **Architecture:** core + reference backend impls in separate pip packages
- **Snapshot:** cross-platform via `ae-mcp-snapshot-mss` (optional)

## Tool surface
The same 24 verbs (`ae.init`, `ae.exec`, ..., `ae.searchProject`) work
exactly as before. `tools/list` may hide `ae.snapshot` if you didn't
install a snapshotter.

## What got better
- Pluggable: any AE plugin author can publish their own backend
- Cross-platform: macOS/Linux can now use `ae.snapshot`
- Decoupled: core has zero AEBM/Atom-specific code
```

- [ ] **Step 3: Rewrite README.md to remove AEBM-as-default framing**

Replace the README with a backend-agnostic version (not pasted in full here for brevity — the engineer should keep the existing structure but: drop "wraps the aebm bridge" framing, add an "Install" section with `pip install ae-mcp ae-mcp-backend-{aebm|atom}` matrix, add a "Backends" section with one paragraph per shipped reference impl, link MIGRATION.md, drop AE_BRIDGE_ROOT references except in the AEBM backend's specific section).

- [ ] **Step 4: Update docs/REFERENCE.md**

Find all references to `aebm-file`, `AE_BRIDGE_ROOT`, `aebm` (in MCP tool name context), `after_effects_mcp` (module path), and rewrite to backend-agnostic language. Move backend-specific notes (e.g., "AEBM-file backend doesn't implement Atom-style path walker") to per-backend READMEs in `packages/backend-*/README.md`.

- [ ] **Step 5: Verify nothing in core mentions aebm/atom literally**

Run:
```bash
grep -rEi "aebm|atom" packages/core/ae_mcp/ | grep -v "\.pyc" | head
```
Expected: empty (or only matches in inline comments that explicitly explain "core doesn't depend on aebm/atom — those are separate packages").

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: backend-agnostic README + MIGRATION.md + .mcp.json.template"
```

---

### Task 6.3: Final smoke + tag

- [ ] **Step 1: Full unit suite**

Run:
```bash
AE_BRIDGE_ROOT=E:/Code/AEBMethod python -m uv run pytest -m "not live and not live_smoke" -v 2>&1 | tail -5
```
Expected: All packages green; total ~140 tests across 4 sub-packages.

- [ ] **Step 2: Verify tools/list filters correctly**

```bash
AE_MCP_BACKEND=aebm AE_BRIDGE_ROOT=E:/Code/AEBMethod python -m uv run python -c "
import asyncio
from ae_mcp.backends.discovery import select_backend
from ae_mcp.snapshot.discovery import select_snapshotter
b = select_backend()
s = select_snapshotter()
print('backend:', b.name, '| supported:', len(b.supported_verbs()))
print('snapshotter:', s.name if s else 'none')
"
```
Expected: `backend: aebm | supported: 24` and `snapshotter: mss`.

- [ ] **Step 3: Verify zero AE/atom string in core**

```bash
grep -rEi "AE_BRIDGE_ROOT|aebm-file|atom_http|BitBlt" packages/core/ae_mcp/ | head
```
Expected: empty.

- [ ] **Step 4: live_smoke against AEBM backend (optional, requires AE running)**

```bash
AEBM_LIVE_TESTS=1 AE_MCP_BACKEND=aebm AE_BRIDGE_ROOT=E:/Code/AEBMethod python -m uv run pytest -m live_smoke -v
```
Expected (if AE running): 3 passed.

- [ ] **Step 5: Tag**

```bash
git tag -a v0.1.0 -m "v0.1.0 — ae-mcp standalone product (renamed from after-effects-mcp v0.7)"
```

- [ ] **Step 6: Final commit verification**

```bash
git log --oneline ^main HEAD | head -30
```
Expected: ~25-30 commits across the 17 tasks of this plan.

---

## Self-Review

### 1. Spec coverage

| Spec section | Implemented in task |
|---|---|
| §2 monorepo structure | 0.1 |
| §3 Backend ABC | 1.1 |
| §3 manages_undo / manages_checkpoints flags | 1.1 + 2.3 step 7 |
| §4 Snapshotter ABC | 5.1 |
| §5 Discovery (entry-points + AE_MCP_BACKEND) | 1.3 + 5.1 |
| §6.1 backend-aebm | 3.1 + 3.2 |
| §6.2 backend-atom (HTTP, session-id, stale recovery) | 4.1 + 4.2 |
| §6.3 snapshot-mss | 5.2 |
| §7 handler refactor (use Backend not bridge) | 2.3 + 2.4 |
| §7 init/overview/get_layers JSX templates | 2.2 |
| §8 server.py tools/list filtering | 5.1 step 7 |
| §9 testing (mock_backend fixture, live params) | 2.1 + 6.1 |
| §10 config UX (.mcp.json.template, README, MIGRATION) | 6.2 |
| §13 acceptance criteria | 6.3 |

No gap.

### 2. Placeholder scan

Found no "TODO/TBD" in actual implementation steps. The "deferred to spec 3c" mention in `discovery.py` error text is acceptable forward reference.

### 3. Type consistency

- `Backend.exec(code, *, undo_group=, checkpoint_label=, timeout_sec=)` — used consistently across 1.1, 2.3, 2.4, 3.2, 4.1.
- `Snapshotter.capture(out_path, *, hwnd, main_window, method)` — consistent across 5.1, 5.2.
- Entry-point group names: `"ae_mcp.backends"` and `"ae_mcp.snapshotters"` — consistent across discovery.py, all backend pyprojects, all snapshot pyprojects.
- `manages_undo` / `manages_checkpoints` — defined in base.py (1.1), set on AtomBackend (4.1), checked in `_run_exec` (2.3 step 7). Consistent.
- `select_backend()` / `select_snapshotter()` — discovery layer's public entrypoints; consistent.

No type drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-spec-3a-backend-abstraction.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. ~17 tasks, well-bounded.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
