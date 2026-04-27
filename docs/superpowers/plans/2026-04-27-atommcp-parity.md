# AtomMCP 后端能力对标 — 实施计划 (v0.7.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v0.6.2 的 17-verb MCP server 升级到 24-verb，覆盖 Atom MCP 关键路径全部能力（6 个新 typed 读 verb + checkpoint/revert 真实现 + 1 ping 诊断 + 三层测试）。

**Architecture:** 6 个新读 verb 全部走"Python typed handler 渲染 JSX 模板 → bridge.invoke_ae_exec"，与现有 6 个 typed verb 同构；AEBMethod 插件仓库零改动。checkpoint 用 `app.project.save()` + `File.copy()` 落盘整 .aep 到 `%TEMP%/aebm_checkpoints/<basename>/`；untitled 项目静默跳过。新增 `tests/live/` opt-in 层验证端到端真接通 AE。

**Tech Stack:** Python 3.10+ / asyncio / pydantic v2 / pytest / pytest-asyncio / ExtendScript / pwsh / `mcp` SDK。

**Spec reference:** [`docs/superpowers/specs/2026-04-27-atommcp-parity-design.md`](../specs/2026-04-27-atommcp-parity-design.md)

---

## 文件结构总览

新建：
- `after_effects_mcp/checkpoint_store.py` — 纯文件系统 checkpoint 索引/裁剪
- `after_effects_mcp/jsx_templates/ping.jsx`
- `after_effects_mcp/jsx_templates/checkpoint_create.jsx`
- `after_effects_mcp/jsx_templates/revert.jsx`
- `after_effects_mcp/jsx_templates/get_properties.jsx`
- `after_effects_mcp/jsx_templates/scan_property_tree.jsx`
- `after_effects_mcp/jsx_templates/inspect_property_capabilities.jsx`
- `after_effects_mcp/jsx_templates/get_expressions.jsx`
- `after_effects_mcp/jsx_templates/get_keyframes.jsx`
- `after_effects_mcp/jsx_templates/search_project.jsx`
- `tests/test_checkpoint_store.py`
- `tests/live/__init__.py`
- `tests/live/conftest.py`
- `tests/live/test_smoke.py` — ping + exec + snapshot
- `tests/live/test_read_verbs.py` — 6 个读 verb 端到端
- `tests/live/test_checkpoint_cycle.py` — create→write→revert 闭环

修改：
- `after_effects_mcp/schemas.py` — +7 schema，升级 `AeCheckpointArgs`
- `after_effects_mcp/handlers/core.py` — 升级 checkpoint/revert/exec；新增 ping
- `after_effects_mcp/handlers/typed.py` — 新增 6 个读 verb handler + render 函数
- `tests/test_schemas.py` — +7 组 schema 测试 + checkpoint 升级测试
- `tests/test_handlers_core.py` — ping/checkpoint/revert/exec 升级测试
- `tests/test_handlers_typed.py` — 6 组 handler/render 测试
- `pyproject.toml` — pytest markers + addopts
- `docs/REFERENCE.md` — verb 表 17→24，删 deferred 5 行，新增 §Checkpoint store / §Live test layer
- `README.md` — verb 表 + Live tests 段
- `.github/workflows/ci.yml` — 显式 `-m "not live"`（其实 pyproject 的 addopts 已隐式过滤；仍写出以便看 CI 不会误跑）

不动：
- `after_effects_mcp/bridge.py` / `progress.py` / `snapshot.py` / `server.py`（仅注册新 verb，不改逻辑）
- `tests/conftest.py` / `tests/test_bridge.py` / `tests/test_progress.py` / `tests/test_snapshot.py`
- AEBMethod 仓库的任何文件

---

## Phase 0 — 准备

### Task 0.1: pytest live marker 注册

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: 编辑 pyproject.toml 的 pytest 配置块**

把 `[tool.pytest.ini_options]` 块替换成：

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
pythonpath = ["."]
markers = [
    "live: requires real AE + aebm panel loaded; opt-in via AEBM_LIVE_TESTS=1",
    "live_smoke: 3-verb handshake subset of live tests",
]
addopts = "-m 'not live and not live_smoke'"
```

- [ ] **Step 2: 验证 marker 注册生效**

Run: `python -m uv run pytest --collect-only -q 2>&1 | tail -5`
Expected: 73 tests collected, no warnings about unknown markers.

- [ ] **Step 3: 验证 -m live 默认被排除**

Run: `python -m uv run pytest -m live --collect-only 2>&1 | tail -3`
Expected: 收集 0 个 test（live 目录还没建，但即便后续有也会被默认 addopts 排除——`-m live` 会覆盖默认）。注：`-m live` 显式覆盖时会跑，默认 `pytest` 不跑。这是预期。

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "test: register live / live_smoke pytest markers, exclude by default"
```

---

## Phase 1 — ae.ping (最小新 verb，warmup live 层)

### Task 1.1: AePingArgs schema + 测试

**Files:**
- Modify: `after_effects_mcp/schemas.py`
- Modify: `tests/test_schemas.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_schemas.py` 末尾追加：

```python
from after_effects_mcp.schemas import AePingArgs, SCHEMAS


def test_ae_ping_default():
    a = AePingArgs()
    assert a.expect == "pong"


def test_ae_ping_custom_expect():
    a = AePingArgs(expect="hello")
    assert a.expect == "hello"


def test_ae_ping_extra_forbidden():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        AePingArgs(expect="x", junk=1)


def test_ae_ping_in_registry():
    assert "ae.ping" in SCHEMAS
    assert SCHEMAS["ae.ping"] is AePingArgs
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_schemas.py::test_ae_ping_default -v`
Expected: FAIL — `ImportError: cannot import name 'AePingArgs'`.

- [ ] **Step 3: 实现 schema**

在 `after_effects_mcp/schemas.py` 的"Core 9"块尾、"Typed 6"块前插入：

```python
class AePingArgs(_StrictModel):
    """ae.ping — handshake smoke test for live diagnostics."""
    expect: str = Field("pong", description="String to echo back.")
```

并把文件最末的 SCHEMAS 字典加一行 `"ae.ping": AePingArgs,`，把 assert 行改为 `assert len(SCHEMAS) == 18`。

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m uv run pytest tests/test_schemas.py -v -k ping`
Expected: 4 passed.

- [ ] **Step 5: 跑全 schema 测试无回归**

Run: `python -m uv run pytest tests/test_schemas.py -v`
Expected: 现有 schema 测试 + 4 个新测试全 pass。

- [ ] **Step 6: Commit**

```bash
git add after_effects_mcp/schemas.py tests/test_schemas.py
git commit -m "feat(schemas): add AePingArgs (ae.ping diagnostic verb)"
```

---

### Task 1.2: ping JSX 模板 + handler

**Files:**
- Create: `after_effects_mcp/jsx_templates/ping.jsx`
- Modify: `after_effects_mcp/handlers/core.py`
- Modify: `tests/test_handlers_core.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_handlers_core.py` 末尾追加：

```python
import json
import pytest
from after_effects_mcp import schemas
from after_effects_mcp.handlers.core import _run_ping  # noqa: F401 — added in this task


@pytest.mark.asyncio
async def test_ae_ping_default(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "pong": "pong", "aeVersion": "26.0", "latencyMs": 5}),
    )
    args = schemas.AePingArgs()
    result = await _run_ping(args, ctx=None)
    assert result["ok"] is True
    assert result["pong"] == "pong"


@pytest.mark.asyncio
async def test_ae_ping_custom(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "pong": "hello", "aeVersion": "26.0", "latencyMs": 4}),
    )
    args = schemas.AePingArgs(expect="hello")
    result = await _run_ping(args, ctx=None)
    assert result["pong"] == "hello"
    # Verify the JSX sent included the expected token
    sent_kwargs = mock_bridge.calls[-1][2]
    assert "hello" in sent_kwargs["code"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k ping`
Expected: ImportError on `_run_ping`.

- [ ] **Step 3: 写 JSX 模板**

Create `after_effects_mcp/jsx_templates/ping.jsx`:

```javascript
// ae.ping — return immediately so live tests can verify the bridge is up.
// Placeholders: expect.
(function() {
    var t0 = Date.now ? Date.now() : 0;
    var ver = "unknown";
    try { ver = String(app.version); } catch (e) { }
    return JSON.stringify({
        ok: true,
        pong: ${expect},
        aeVersion: ver,
        latencyMs: (Date.now ? (Date.now() - t0) : 0)
    });
})()
```

- [ ] **Step 4: 实现 handler**

在 `after_effects_mcp/handlers/core.py` 末尾追加：

```python
# ---------------------------------------------------------------------------
# ae.ping — handshake smoke test for live diagnostics
# ---------------------------------------------------------------------------

from functools import lru_cache as _lru_cache
from pathlib import Path as _Path
from string import Template as _Template

_PING_TEMPLATE_PATH = _Path(__file__).resolve().parent.parent / "jsx_templates" / "ping.jsx"


@_lru_cache(maxsize=1)
def _ping_template() -> _Template:
    return _Template(_PING_TEMPLATE_PATH.read_text(encoding="utf-8"))


async def _run_ping(args: schemas.AePingArgs, ctx: Any) -> Any:
    jsx = _ping_template().substitute(expect=json.dumps(args.expect, ensure_ascii=False))

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=10.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=15.0, start_msg="ae.ping..."
    )


register("ae.ping", schemas.AePingArgs, _run_ping)
```

- [ ] **Step 5: 运行 handler 测试确认通过**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k ping`
Expected: 2 passed.

- [ ] **Step 6: 验证全部 unit 测试无回归**

Run: `python -m uv run pytest -m "not live and not live_smoke"`
Expected: 全绿，相比 baseline +6 个 test。

- [ ] **Step 7: Commit**

```bash
git add after_effects_mcp/jsx_templates/ping.jsx after_effects_mcp/handlers/core.py tests/test_handlers_core.py
git commit -m "feat(verbs): ae.ping diagnostic handshake"
```

---

## Phase 2 — Live test 层

### Task 2.1: live conftest + ping smoke

**Files:**
- Create: `tests/live/__init__.py` (empty)
- Create: `tests/live/conftest.py`
- Create: `tests/live/test_smoke.py`

- [ ] **Step 1: 创建空包标识**

Create `tests/live/__init__.py` with content: `# package marker for live tests`

- [ ] **Step 2: 创建 conftest**

Create `tests/live/conftest.py`:

```python
"""Live test fixtures — opt-in only, requires real AE + aebm plugin.

Set AEBM_LIVE_TESTS=1 to run. Without that env var every test in this
directory skips. Live tests do real pwsh subprocess + AE roundtrips, and
are NOT run in CI (hosted runners cannot drive a GUI Adobe app).
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from after_effects_mcp import bridge


def _live_enabled() -> bool:
    return os.environ.get("AEBM_LIVE_TESTS") == "1"


@pytest.fixture(scope="session", autouse=True)
def _live_gate():
    if not _live_enabled():
        pytest.skip("live tests are opt-in: export AEBM_LIVE_TESTS=1")


@pytest.fixture(scope="session")
def live_bridge():
    """Verify AE is reachable; if not, fail the whole session early."""
    async def _ping() -> str:
        return await bridge.invoke_ae_exec(
            code='JSON.stringify({ok:true,pong:"pong"})',
            timeout_sec=15.0,
        )

    try:
        out = asyncio.run(_ping())
    except Exception as e:  # noqa: BLE001
        pytest.fail(
            f"live handshake failed: {e}. "
            f"Verify AE is running, the aebm panel is loaded, and "
            f"AE_BRIDGE_ROOT is set."
        )

    if "pong" not in out:
        pytest.fail(f"live handshake returned unexpected output: {out!r}")

    return bridge


@pytest.fixture
def clean_project(live_bridge):
    """New project before each test, close after. Used by mutation tests."""
    setup = (
        "(function(){"
        "try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}"
        "app.newProject();"
        "return JSON.stringify({ok:true});"
        "})()"
    )
    asyncio.run(live_bridge.invoke_ae_exec(code=setup, timeout_sec=15.0))
    yield live_bridge
    teardown = (
        "(function(){"
        "try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}"
        "return JSON.stringify({ok:true});"
        "})()"
    )
    try:
        asyncio.run(live_bridge.invoke_ae_exec(code=teardown, timeout_sec=10.0))
    except Exception:
        pass  # best-effort teardown


@pytest.fixture
def artifact_dir(request, tmp_path_factory):
    """Per-test artifact directory under tests/live/_artifacts/<test_name>/."""
    name = request.node.name.replace("/", "_").replace("[", "_").replace("]", "_")
    d = Path(__file__).parent / "_artifacts" / name
    d.mkdir(parents=True, exist_ok=True)
    return d
```

- [ ] **Step 3: 创建 smoke 测试**

Create `tests/live/test_smoke.py`:

```python
"""Live smoke tests — 3-verb handshake. Run with:
    AEBM_LIVE_TESTS=1 python -m uv run pytest -m live_smoke

Acts as a "is the bridge wired up at all" canary.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from after_effects_mcp import bridge, schemas
from after_effects_mcp.handlers.core import _run_ping


pytestmark = [pytest.mark.live, pytest.mark.live_smoke]


@pytest.mark.asyncio
async def test_ping_returns_pong(live_bridge):
    args = schemas.AePingArgs()
    result = await _run_ping(args, ctx=None)
    assert result["ok"] is True
    assert result["pong"] == "pong"
    assert "aeVersion" in result


@pytest.mark.asyncio
async def test_exec_arithmetic(live_bridge):
    out = await bridge.invoke_ae_exec(
        code='JSON.stringify({ok:true,answer:1+1})', timeout_sec=10.0
    )
    parsed = json.loads(out)
    assert parsed == {"ok": True, "answer": 2}


@pytest.mark.asyncio
async def test_snapshot_writes_png(live_bridge, artifact_dir, tmp_path):
    from after_effects_mcp import snapshot
    out_path = tmp_path / "ae_smoke.png"
    result = snapshot.capture_ae_viewer(out_path=str(out_path))
    assert result["ok"] is True
    assert out_path.exists() and out_path.stat().st_size > 1000
    # Save a copy to artifacts for inspection
    import shutil
    shutil.copy(out_path, artifact_dir / "ae_smoke.png")
```

- [ ] **Step 4: 验证默认 pytest 不会跑 live**

Run: `python -m uv run pytest --collect-only 2>&1 | grep -c live`
Expected: 0 lines (live 目录下的 test 都被 addopts `-m 'not live and not live_smoke'` 过滤掉)。

- [ ] **Step 5: 验证 opt-in 不带 env var 时 skip**

Run: `python -m uv run pytest -m live_smoke 2>&1 | tail -5`
Expected: `3 skipped` (因为 `AEBM_LIVE_TESTS` 未设置，autouse 的 `_live_gate` 触发 `pytest.skip`)。

- [ ] **Step 6: Commit**

```bash
git add tests/live/__init__.py tests/live/conftest.py tests/live/test_smoke.py
git commit -m "test(live): opt-in live test layer with ping/exec/snapshot smoke"
```

---

## Phase 3 — checkpoint_store

### Task 3.1: 纯文件系统 checkpoint_store 模块

**Files:**
- Create: `after_effects_mcp/checkpoint_store.py`
- Create: `tests/test_checkpoint_store.py`

- [ ] **Step 1: 写失败测试**

Create `tests/test_checkpoint_store.py`:

```python
"""Unit tests for checkpoint_store — pure filesystem, no AE dependency."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from after_effects_mcp.checkpoint_store import CheckpointStore


def _touch_aep(path: Path, size: int = 1024) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)


def _write_meta(path: Path, **fields) -> None:
    meta = {
        "id": fields["id"],
        "label": fields.get("label", ""),
        "ts": fields["ts"],
        "sourceProjectPath": fields.get("sourceProjectPath", "C:/p.aep"),
        "activeCompId": fields.get("activeCompId"),
        "currentTime": fields.get("currentTime", 0.0),
        "sizeBytes": fields.get("sizeBytes", 1024),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta), encoding="utf-8")


def test_store_root_per_basename(tmp_path):
    store = CheckpointStore(root=tmp_path)
    p = store._dir_for("C:/projects/MyProject.aep")
    assert p == tmp_path / "MyProject"
    p2 = store._dir_for(None)
    assert p2 == tmp_path / "_untitled"


def test_make_id_unique_and_sortable(tmp_path):
    store = CheckpointStore(root=tmp_path)
    ids = [store.make_id() for _ in range(5)]
    assert len(set(ids)) == 5
    assert all("_" in i for i in ids)
    # First segment is unix-ms timestamp; sortable lexicographically.
    assert sorted(ids) == sorted(ids, key=lambda s: int(s.split("_")[0]))


def test_list_returns_descending_by_ts(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    for ts, ident in [
        ("2026-04-27T10:00:00Z", "1714209600000_a"),
        ("2026-04-27T11:00:00Z", "1714213200000_b"),
        ("2026-04-27T09:00:00Z", "1714206000000_c"),
    ]:
        _touch_aep(d / f"{ident}.aep")
        _write_meta(d / f"{ident}.json", id=ident, ts=ts)

    listed = store.list_checkpoints(base, limit=10)
    assert [c["id"] for c in listed] == [
        "1714213200000_b", "1714209600000_a", "1714206000000_c"
    ]


def test_list_clamps_limit(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    for i in range(15):
        ident = f"171420960{i:04d}_x"
        _touch_aep(d / f"{ident}.aep")
        _write_meta(d / f"{ident}.json", id=ident, ts=f"2026-04-27T10:00:{i:02d}Z")

    assert len(store.list_checkpoints(base, limit=5)) == 5


def test_list_skips_orphan_meta(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    # Orphan: meta but no .aep
    _write_meta(d / "orphan.json", id="orphan", ts="2026-04-27T10:00:00Z")
    listed = store.list_checkpoints(base, limit=10)
    assert listed == []
    # Orphan meta should also be cleaned up
    assert not (d / "orphan.json").exists()


def test_lookup_returns_path(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    _touch_aep(d / "abc_x.aep")
    _write_meta(d / "abc_x.json", id="abc_x", ts="2026-04-27T10:00:00Z")

    p = store.lookup_aep(base, "abc_x")
    assert p == d / "abc_x.aep"

    assert store.lookup_aep(base, "missing") is None


def test_prune_keeps_n_newest(tmp_path):
    store = CheckpointStore(root=tmp_path, keep=3)
    base = "C:/p.aep"
    d = store._dir_for(base)
    for i in range(7):
        ident = f"17142096{i:05d}_x"
        _touch_aep(d / f"{ident}.aep")
        _write_meta(d / f"{ident}.json", id=ident, ts=f"2026-04-27T10:00:{i:02d}Z")

    removed = store.prune(base)
    assert len(removed) == 4
    remaining = sorted(p.stem for p in d.glob("*.aep"))
    assert len(remaining) == 3


def test_keep_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("AEBM_CHECKPOINT_KEEP", "2")
    store = CheckpointStore(root=tmp_path)
    assert store.keep == 2


def test_write_meta_roundtrip(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "id_x.aep"
    _touch_aep(aep, size=2048)

    store.write_meta(
        source_project_path=base,
        cid="id_x",
        label="hello",
        active_comp_id="12",
        current_time=1.5,
        size_bytes=2048,
    )
    meta = json.loads((d / "id_x.json").read_text(encoding="utf-8"))
    assert meta["label"] == "hello"
    assert meta["sizeBytes"] == 2048
    assert meta["activeCompId"] == "12"
    assert "ts" in meta and meta["ts"].endswith("Z")
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_checkpoint_store.py -v`
Expected: ImportError on `CheckpointStore`.

- [ ] **Step 3: 实现 checkpoint_store**

Create `after_effects_mcp/checkpoint_store.py`:

```python
"""Filesystem-backed checkpoint index.

Layout:
    %TEMP%/aebm_checkpoints/
        <project_basename_or__untitled>/
            <id>.aep       # full project copy
            <id>.json      # metadata sidecar

ID format: <unix_ms>_<8-hex-chars>. The ms prefix sorts lexicographically.

Pruning: retain at most `keep` newest checkpoints per project basename.
Override default (50) via AEBM_CHECKPOINT_KEEP env var.

This module does NOT touch AE — it only manages the directory. Handlers
elsewhere call `make_id()`, write the .aep via JSX, then call
`write_meta()` and `prune()`.
"""
from __future__ import annotations

import json
import os
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _project_basename(source_path: Optional[str]) -> str:
    if not source_path:
        return "_untitled"
    stem = Path(source_path).stem
    # Make the basename safe for a directory: strip path separators just in case.
    safe = "".join(c if c.isalnum() or c in "._- " else "_" for c in stem)
    return safe or "_untitled"


class CheckpointStore:
    def __init__(self, root: Optional[Path] = None, keep: Optional[int] = None) -> None:
        if root is None:
            root = Path(tempfile.gettempdir()) / "aebm_checkpoints"
        self.root: Path = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

        if keep is None:
            env = os.environ.get("AEBM_CHECKPOINT_KEEP")
            try:
                keep = int(env) if env else 50
            except ValueError:
                keep = 50
        self.keep: int = max(1, int(keep))

    # ------------------------------------------------------------------ paths

    def _dir_for(self, source_path: Optional[str]) -> Path:
        return self.root / _project_basename(source_path)

    def aep_path(self, source_path: Optional[str], cid: str) -> Path:
        return self._dir_for(source_path) / f"{cid}.aep"

    def meta_path(self, source_path: Optional[str], cid: str) -> Path:
        return self._dir_for(source_path) / f"{cid}.json"

    # ----------------------------------------------------------------- id gen

    def make_id(self) -> str:
        ms = int(time.time() * 1000)
        return f"{ms}_{secrets.token_hex(4)}"

    # ------------------------------------------------------------------ write

    def write_meta(
        self,
        *,
        source_project_path: Optional[str],
        cid: str,
        label: str,
        active_comp_id: Optional[str],
        current_time: float,
        size_bytes: int,
    ) -> Path:
        d = self._dir_for(source_project_path)
        d.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        meta = {
            "id": cid,
            "label": label,
            "ts": ts,
            "sourceProjectPath": source_project_path,
            "activeCompId": active_comp_id,
            "currentTime": current_time,
            "sizeBytes": size_bytes,
        }
        path = d / f"{cid}.json"
        path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return path

    # ------------------------------------------------------------------- read

    def list_checkpoints(self, source_path: Optional[str], *, limit: int = 20) -> List[Dict[str, Any]]:
        d = self._dir_for(source_path)
        if not d.exists():
            return []
        entries: List[Dict[str, Any]] = []
        for meta_file in d.glob("*.json"):
            cid = meta_file.stem
            aep = d / f"{cid}.aep"
            if not aep.exists():
                # orphan meta — clean up
                try:
                    meta_file.unlink()
                except OSError:
                    pass
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            entries.append(meta)
        entries.sort(key=lambda m: m.get("ts", ""), reverse=True)
        return entries[:limit]

    def lookup_aep(self, source_path: Optional[str], cid: str) -> Optional[Path]:
        p = self.aep_path(source_path, cid)
        return p if p.exists() else None

    # ------------------------------------------------------------------ prune

    def prune(self, source_path: Optional[str]) -> List[str]:
        """Delete checkpoints beyond `self.keep` newest. Return removed ids."""
        d = self._dir_for(source_path)
        if not d.exists():
            return []
        entries = self.list_checkpoints(source_path, limit=10_000)
        keep_ids = {e["id"] for e in entries[: self.keep]}
        removed: List[str] = []
        for e in entries[self.keep:]:
            cid = e["id"]
            for ext in (".aep", ".json"):
                f = d / f"{cid}{ext}"
                try:
                    f.unlink()
                except OSError:
                    pass
            removed.append(cid)
        return removed
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m uv run pytest tests/test_checkpoint_store.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add after_effects_mcp/checkpoint_store.py tests/test_checkpoint_store.py
git commit -m "feat: add CheckpointStore module (FS index, prune, lookup)"
```

---

### Task 3.2: 升级 AeCheckpointArgs schema

**Files:**
- Modify: `after_effects_mcp/schemas.py`
- Modify: `tests/test_schemas.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_schemas.py` 末尾追加：

```python
def test_ae_checkpoint_default_action_is_list():
    a = schemas.AeCheckpointArgs()
    assert a.action == "list"
    assert a.label == ""
    assert a.limit == 20


def test_ae_checkpoint_create_with_label():
    a = schemas.AeCheckpointArgs(action="create", label="before risky write")
    assert a.action == "create"
    assert a.label == "before risky write"


def test_ae_checkpoint_invalid_action():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        schemas.AeCheckpointArgs(action="delete")
```

(假设 `tests/test_schemas.py` 文件顶部已经 `from after_effects_mcp import schemas`；若没有就加。)

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k checkpoint`
Expected: FAIL — `action` 字段不存在。

- [ ] **Step 3: 升级 schema**

在 `after_effects_mcp/schemas.py` 把现有 `AeCheckpointArgs` 替换为：

```python
CheckpointAction = Literal["create", "list"]


class AeCheckpointArgs(_StrictModel):
    """ae.checkpoint — create or list .aep snapshots."""
    action: CheckpointAction = Field(
        "list",
        description="'create' = save .aep snapshot; 'list' = enumerate existing.",
    )
    label: str = Field(
        "",
        description="Human-readable tag (used when action='create').",
    )
    limit: int = Field(
        20, ge=1, le=200,
        description="Max entries returned when action='list'.",
    )
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m uv run pytest tests/test_schemas.py -v -k checkpoint`
Expected: 3 passed (新) + 之前现有的 checkpoint 测试也仍 pass。

- [ ] **Step 5: Commit**

```bash
git add after_effects_mcp/schemas.py tests/test_schemas.py
git commit -m "feat(schemas): AeCheckpointArgs add action/label, default action=list"
```

---

### Task 3.3: checkpoint_create.jsx + revert.jsx 模板

**Files:**
- Create: `after_effects_mcp/jsx_templates/checkpoint_create.jsx`
- Create: `after_effects_mcp/jsx_templates/revert.jsx`

- [ ] **Step 1: 创建 checkpoint_create.jsx**

```javascript
// ae.checkpoint create — copy current saved .aep to checkpoint path.
// Placeholders: dst_path (JSON-quoted absolute path).
//
// Strategy: app.project.save() to the project's existing fsName (no
// side-effects), then File.copy() to the checkpoint location. Calling
// app.project.save(File(...)) would change the project's fsName — DON'T.
//
// Untitled projects (app.project.file === null) are SKIPPED silently:
//   {ok:true, skipped:true, reason:"untitled-project", id:null}
(function() {
    if (app.project.file === null) {
        return JSON.stringify({
            ok: true, skipped: true, reason: "untitled-project", id: null
        });
    }
    try {
        app.project.save();
    } catch (e) {
        return JSON.stringify({ok: false, error: "save() failed: " + String(e)});
    }
    var src = app.project.file;
    var dstPath = ${dst_path};
    var dst = new File(dstPath);
    var ok = src.copy(dst.fsName);
    if (!ok) {
        return JSON.stringify({ok: false, error: "File.copy() returned false"});
    }
    var size = -1;
    try { size = dst.length; } catch (e) { }

    var activeCompId = null;
    var currentTime = 0;
    var ai = app.project.activeItem;
    if (ai && ai instanceof CompItem) {
        activeCompId = String(ai.id);
        currentTime = ai.time;
    }

    return JSON.stringify({
        ok: true,
        sourceProjectPath: src.fsName,
        savedTo: dst.fsName,
        sizeBytes: size,
        activeCompId: activeCompId,
        currentTime: currentTime
    });
})()
```

- [ ] **Step 2: 创建 revert.jsx**

```javascript
// ae.revert — close current project (no save), open <checkpoint>.aep.
// Placeholders: aep_path (JSON-quoted absolute path).
(function() {
    var aepPath = ${aep_path};
    var f = new File(aepPath);
    if (!f.exists) {
        return JSON.stringify({ok: false, error: "checkpoint .aep missing: " + aepPath});
    }
    try {
        app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    } catch (e) {
        return JSON.stringify({ok: false, error: "close() failed: " + String(e)});
    }
    try {
        app.open(f);
    } catch (e) {
        return JSON.stringify({ok: false, error: "open() failed: " + String(e)});
    }
    var openedPath = (app.project.file ? app.project.file.fsName : null);
    return JSON.stringify({ok: true, reverted: true, openedPath: openedPath});
})()
```

- [ ] **Step 3: Commit (no logic — just templates, tested via handler tasks)**

```bash
git add after_effects_mcp/jsx_templates/checkpoint_create.jsx after_effects_mcp/jsx_templates/revert.jsx
git commit -m "feat(jsx): checkpoint_create + revert templates"
```

---

### Task 3.4: ae.checkpoint handler 升级 (stub → real)

**Files:**
- Modify: `after_effects_mcp/handlers/core.py`
- Modify: `tests/test_handlers_core.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_handlers_core.py` 末尾追加：

```python
import json
from pathlib import Path
import pytest
from after_effects_mcp import schemas


@pytest.mark.asyncio
async def test_checkpoint_list_default_returns_disk_entries(mock_bridge, tmp_path, monkeypatch):
    # Force checkpoint_store root to tmp_path
    from after_effects_mcp import checkpoint_store, handlers
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    # Pre-populate one fake checkpoint for "MyProject"
    d = store._dir_for("C:/MyProject.aep")
    d.mkdir(parents=True, exist_ok=True)
    (d / "abc_x.aep").write_bytes(b"\x00" * 1024)
    store.write_meta(
        source_project_path="C:/MyProject.aep",
        cid="abc_x", label="seed", active_comp_id="12",
        current_time=0.0, size_bytes=1024,
    )

    # Mock the bridge call that fetches current project path
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "path": "C:/MyProject.aep"}),
    )

    from after_effects_mcp.handlers.core import _run_checkpoint
    args = schemas.AeCheckpointArgs(action="list", limit=10)
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert len(result["checkpoints"]) == 1
    assert result["checkpoints"][0]["id"] == "abc_x"
    assert result["checkpoints"][0]["label"] == "seed"


@pytest.mark.asyncio
async def test_checkpoint_create_writes_meta(mock_bridge, tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    # Mock the bridge: first call resolves current project path; second
    # call runs the checkpoint_create JSX and returns saved metadata.
    responses = iter([
        json.dumps({"ok": True, "path": "C:/Foo.aep"}),
        json.dumps({
            "ok": True, "sourceProjectPath": "C:/Foo.aep",
            "savedTo": str(tmp_path / "Foo" / "<id>.aep"),
            "sizeBytes": 4096, "activeCompId": "1",
            "currentTime": 0.0
        }),
    ])
    async def _resp(*a, **kw):
        return next(responses)
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    # Prepare the .aep that the JSX claims to have written. We have to write
    # the file ourselves — the mocked bridge didn't actually run AE.
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    # The handler will deterministically produce the id; we patch make_id.
    monkeypatch.setattr(store, "make_id", lambda: "fixed_id")
    (d / "fixed_id.aep").write_bytes(b"\x00" * 4096)

    from after_effects_mcp.handlers.core import _run_checkpoint
    args = schemas.AeCheckpointArgs(action="create", label="label-A")
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert result["id"] == "fixed_id"
    assert result["label"] == "label-A"
    # Meta sidecar exists
    assert (d / "fixed_id.json").exists()


@pytest.mark.asyncio
async def test_checkpoint_create_untitled_skipped(mock_bridge, tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    responses = iter([
        json.dumps({"ok": True, "path": None}),  # untitled
    ])
    async def _resp(*a, **kw):
        return next(responses)
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    from after_effects_mcp.handlers.core import _run_checkpoint
    args = schemas.AeCheckpointArgs(action="create", label="x")
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert result.get("skipped") is True
    assert result.get("reason") == "untitled-project"
    assert result.get("id") is None
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k checkpoint`
Expected: 旧 stub 测试 (返回 `checkpoints: []`) 仍通过；3 个新测试 fail（handler 未升级）。

- [ ] **Step 3: 实现升级后的 handler**

在 `after_effects_mcp/handlers/core.py` 顶部 (现有 imports 后) 加：

```python
from pathlib import Path
from string import Template

from after_effects_mcp import checkpoint_store

_store = checkpoint_store.CheckpointStore()
_TEMPLATES = Path(__file__).resolve().parent.parent / "jsx_templates"


def _load_jsx(name: str) -> Template:
    return Template((_TEMPLATES / name).read_text(encoding="utf-8"))


async def _resolve_project_path(ctx: Any) -> Optional[str]:
    out = await bridge.invoke_ae_exec(
        code=(
            'JSON.stringify({ok:true,'
            'path: app.project.file ? app.project.file.fsName : null})'
        ),
        timeout_sec=10.0,
    )
    parsed = _try_json(out)
    if isinstance(parsed, dict) and parsed.get("ok"):
        return parsed.get("path")
    return None
```

(若 `Optional` 没 import，保持现有 typing import；`Any` 已在用。)

把现有 `_run_checkpoint` 替换为：

```python
async def _run_checkpoint(args: schemas.AeCheckpointArgs, ctx: Any) -> Any:
    if args.action == "list":
        async def _call_list() -> Any:
            project_path = await _resolve_project_path(ctx)
            entries = _store.list_checkpoints(project_path, limit=args.limit)
            return {"ok": True, "checkpoints": entries, "total": len(entries)}
        return await progress.run_with_timeout(
            ctx, _call_list(), timeout_sec=15.0, start_msg="ae.checkpoint list..."
        )

    # action == "create"
    async def _call_create() -> Any:
        project_path = await _resolve_project_path(ctx)
        if not project_path:
            return {
                "ok": True, "skipped": True,
                "reason": "untitled-project", "id": None,
            }
        cid = _store.make_id()
        dst = _store.aep_path(project_path, cid)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmpl = _load_jsx("checkpoint_create.jsx")
        jsx = tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
        out = await bridge.invoke_ae_exec(
            code=jsx,
            undo_group_name=f"MCP checkpoint: {args.label or cid}",
            timeout_sec=60.0,
        )
        parsed = _try_json(out)
        if not (isinstance(parsed, dict) and parsed.get("ok")):
            return parsed
        if parsed.get("skipped"):
            return parsed  # untitled bubbled up from JSX
        size_bytes = int(parsed.get("sizeBytes") or dst.stat().st_size)
        _store.write_meta(
            source_project_path=project_path,
            cid=cid, label=args.label,
            active_comp_id=parsed.get("activeCompId"),
            current_time=float(parsed.get("currentTime") or 0.0),
            size_bytes=size_bytes,
        )
        _store.prune(project_path)
        return {
            "ok": True, "id": cid, "label": args.label,
            "path": str(dst), "sizeBytes": size_bytes,
        }

    return await progress.run_with_timeout(
        ctx, _call_create(), timeout_sec=70.0, start_msg="ae.checkpoint create..."
    )
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k checkpoint`
Expected: 3 new tests pass. 现有 stub 测试可能挂——若现有测试断言"returns []"，应已在前面 schema 升级时被替换；如还存在，检查并删除被取代的旧 stub 断言。

- [ ] **Step 5: 全 unit 套件无回归**

Run: `python -m uv run pytest -m "not live and not live_smoke"`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add after_effects_mcp/handlers/core.py tests/test_handlers_core.py
git commit -m "feat(verbs): ae.checkpoint stub -> real (action=create|list)"
```

---

### Task 3.5: ae.revert handler 升级

**Files:**
- Modify: `after_effects_mcp/handlers/core.py`
- Modify: `tests/test_handlers_core.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_handlers_core.py` 末尾追加：

```python
@pytest.mark.asyncio
async def test_revert_unknown_id_returns_error(tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    async def _resp(*a, **kw):
        return json.dumps({"ok": True, "path": "C:/Foo.aep"})
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    from after_effects_mcp.handlers.core import _run_revert
    args = schemas.AeRevertArgs(checkpoint_id="missing", branch_before_revert=False)
    result = await _run_revert(args, ctx=None)
    assert result["ok"] is False
    assert "not found" in result["error"].lower()


@pytest.mark.asyncio
async def test_revert_known_id_calls_jsx(tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    # Seed
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "abc_x.aep"
    aep.write_bytes(b"\x00" * 1024)
    store.write_meta(source_project_path="C:/Foo.aep", cid="abc_x",
                     label="seed", active_comp_id=None, current_time=0.0,
                     size_bytes=1024)

    calls = []
    async def _resp(*a, **kw):
        calls.append(kw.get("code", ""))
        # First: project-path probe; second: revert.jsx
        if "app.project.file" in kw.get("code", "") and len(calls) == 1:
            return json.dumps({"ok": True, "path": "C:/Foo.aep"})
        return json.dumps({"ok": True, "reverted": True,
                           "openedPath": str(aep)})
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    from after_effects_mcp.handlers.core import _run_revert
    args = schemas.AeRevertArgs(checkpoint_id="abc_x", branch_before_revert=False)
    result = await _run_revert(args, ctx=None)
    assert result["ok"] is True
    assert result.get("reverted") is True
    # The second call to invoke_ae_exec should have rendered revert.jsx
    assert any(str(aep) in c for c in calls)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k revert`

- [ ] **Step 3: 实现升级后的 handler**

把 `after_effects_mcp/handlers/core.py` 里的 `_run_revert` 替换为：

```python
async def _run_revert(args: schemas.AeRevertArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        project_path = await _resolve_project_path(ctx)
        aep = _store.lookup_aep(project_path, args.checkpoint_id)
        if aep is None:
            return {
                "ok": False,
                "reverted": False,
                "error": f"checkpoint not found: {args.checkpoint_id}",
            }
        branched_from = None
        if args.branch_before_revert and project_path:
            # best-effort branch; never block revert on its failure
            try:
                cid = _store.make_id()
                dst = _store.aep_path(project_path, cid)
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmpl = _load_jsx("checkpoint_create.jsx")
                jsx = tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
                out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=60.0)
                parsed = _try_json(out)
                if isinstance(parsed, dict) and parsed.get("ok") and not parsed.get("skipped"):
                    _store.write_meta(
                        source_project_path=project_path, cid=cid,
                        label=f"before-revert-{args.checkpoint_id[:8]}",
                        active_comp_id=parsed.get("activeCompId"),
                        current_time=float(parsed.get("currentTime") or 0.0),
                        size_bytes=int(parsed.get("sizeBytes") or dst.stat().st_size),
                    )
                    branched_from = cid
            except Exception as e:  # noqa: BLE001
                log.warning("branch_before_revert failed: %s", e)
        tmpl = _load_jsx("revert.jsx")
        jsx = tmpl.substitute(aep_path=json.dumps(str(aep), ensure_ascii=False))
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=60.0)
        parsed = _try_json(out)
        if isinstance(parsed, dict) and parsed.get("ok"):
            parsed["branchedFromId"] = branched_from
        return parsed

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=80.0, start_msg="ae.revert..."
    )
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k revert`
Expected: 2 passed.

- [ ] **Step 5: 全 unit 套件无回归**

Run: `python -m uv run pytest -m "not live and not live_smoke"`

- [ ] **Step 6: Commit**

```bash
git add after_effects_mcp/handlers/core.py tests/test_handlers_core.py
git commit -m "feat(verbs): ae.revert NotImplemented -> real (lookup + open)"
```

---

### Task 3.6: ae.exec checkpoint_label 自动激活

**Files:**
- Modify: `after_effects_mcp/handlers/core.py`
- Modify: `tests/test_handlers_core.py`

- [ ] **Step 1: 写失败测试**

```python
@pytest.mark.asyncio
async def test_exec_with_label_creates_checkpoint(tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    # Seed a saved project file response
    monkeypatch.setattr(store, "make_id", lambda: "exec_id")
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    (d / "exec_id.aep").write_bytes(b"\x00" * 1024)

    call_log = []
    async def _resp(*a, **kw):
        call_log.append(kw.get("code", ""))
        if call_log[-1].startswith("JSON.stringify({ok:true,") and "path:" in call_log[-1]:
            return json.dumps({"ok": True, "path": "C:/Foo.aep"})
        if "checkpoint_create" in call_log[-1] or "File.copy" in call_log[-1]:
            return json.dumps({
                "ok": True, "sourceProjectPath": "C:/Foo.aep",
                "sizeBytes": 1024, "activeCompId": None, "currentTime": 0.0,
                "savedTo": str(d / "exec_id.aep"),
            })
        return json.dumps({"ok": True, "result": 42})
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    from after_effects_mcp.handlers.core import _run_exec
    args = schemas.AeExecArgs(code="42", checkpoint_label="risky")
    result = await _run_exec(args, ctx=None)
    assert result["ok"] is True
    # Meta sidecar should have been written
    assert (d / "exec_id.json").exists()


@pytest.mark.asyncio
async def test_exec_no_label_skips_checkpoint(tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    async def _resp(*a, **kw):
        return json.dumps({"ok": True, "result": 1})
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    from after_effects_mcp.handlers.core import _run_exec
    args = schemas.AeExecArgs(code="1", checkpoint_label=None)
    result = await _run_exec(args, ctx=None)
    assert result["ok"] is True
    # Store should be empty
    d = store._dir_for("C:/Foo.aep")
    assert not d.exists() or list(d.glob("*.aep")) == []
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k exec_with_label`

- [ ] **Step 3: 升级 _run_exec**

把 `after_effects_mcp/handlers/core.py` 的 `_run_exec` 替换为：

```python
async def _run_exec(args: schemas.AeExecArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        checkpoint_skipped: Optional[str] = None
        if args.checkpoint_label:
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
                    cp_out = await bridge.invoke_ae_exec(code=jsx_cp, timeout_sec=60.0)
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
                                size_bytes=int(
                                    cp_parsed.get("sizeBytes") or dst.stat().st_size
                                ),
                            )
                            _store.prune(project_path)
                except Exception as e:  # noqa: BLE001
                    log.warning("auto-checkpoint failed: %s", e)
                    checkpoint_skipped = f"checkpoint-failed: {e}"

        out = await bridge.invoke_ae_exec(
            code=args.code,
            undo_group_name=args.undo_group_name,
            checkpoint_label=args.checkpoint_label,
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

(Note `Optional` may need import — already in stdlib `typing`; add to top of file if not present.)

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m uv run pytest tests/test_handlers_core.py -v -k exec`

- [ ] **Step 5: 全 unit 套件无回归**

Run: `python -m uv run pytest -m "not live and not live_smoke"`

- [ ] **Step 6: Commit**

```bash
git add after_effects_mcp/handlers/core.py tests/test_handlers_core.py
git commit -m "feat(verbs): ae.exec checkpoint_label triggers auto-checkpoint"
```

---

## Phase 4 — 6 个新 typed 读 verb

每个 verb 一个 task。结构高度雷同：schema → 测试 → JSX 模板 → handler+render → 测试通过 → commit。

### Task 4.1: ae.getProperties

**Files:**
- Modify: `after_effects_mcp/schemas.py`
- Create: `after_effects_mcp/jsx_templates/get_properties.jsx`
- Modify: `after_effects_mcp/handlers/typed.py`
- Modify: `tests/test_schemas.py`
- Modify: `tests/test_handlers_typed.py`

- [ ] **Step 1: 写 schema 测试**

追加到 `tests/test_schemas.py`：

```python
def test_get_properties_required_fields():
    a = schemas.AeGetPropertiesArgs(layer_ids=[1, 2], query="position")
    assert a.layer_ids == [1, 2]
    assert a.query == "position"
    assert a.offset == 0
    assert a.limit == 50

def test_get_properties_layer_ids_must_be_list():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        schemas.AeGetPropertiesArgs(layer_ids="all", query="x")
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k get_properties`
Expected: ImportError on `AeGetPropertiesArgs`.

- [ ] **Step 3: 实现 schema**

在 `schemas.py` "Typed 6" 块尾部、最末 SCHEMAS 前面插入：

```python
class AeGetPropertiesArgs(_StrictModel):
    """ae.getProperties — search properties by name across selected layers."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active.")
    layer_ids: List[int] = Field(..., description="1-based layer indices to scan.")
    query: str = Field(..., description="Multi-word AND; '|' separates OR groups.")
    offset: int = Field(0, ge=0, description="Pagination offset.")
    limit: int = Field(50, ge=1, le=500, description="Pagination size.")
```

并把 SCHEMAS 字典加 `"ae.getProperties": AeGetPropertiesArgs,` + 把 assert 数字 += 1。

- [ ] **Step 4: 写 JSX 模板**

Create `after_effects_mcp/jsx_templates/get_properties.jsx`:

```javascript
// ae.getProperties — search property names across selected layers.
// Placeholders: comp_expr, layer_ids_js, query_js, offset, limit.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layerIds = ${layer_ids_js};
    var query = ${query_js};
    var offset = ${offset};
    var limit = ${limit};

    var orGroups = query.toLowerCase().split("|");
    for (var oi = 0; oi < orGroups.length; oi++) {
        orGroups[oi] = orGroups[oi].split(/\s+/);
        var arr = orGroups[oi];
        var trimmed = [];
        for (var ai = 0; ai < arr.length; ai++) {
            if (arr[ai] && arr[ai].length > 0) trimmed.push(arr[ai]);
        }
        orGroups[oi] = trimmed;
    }

    function matches(name, matchName) {
        var hay = (name + " " + matchName).toLowerCase();
        for (var gi = 0; gi < orGroups.length; gi++) {
            var grp = orGroups[gi];
            if (grp.length === 0) continue;
            var ok = true;
            for (var ti = 0; ti < grp.length; ti++) {
                if (hay.indexOf(grp[ti]) === -1) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    var hits = [];

    function visit(prop, layerId, pathSegs, depth) {
        if (depth > 6) return;
        if (prop.propertyType === PropertyType.PROPERTY) {
            if (matches(prop.name, prop.matchName)) {
                var val = null;
                try { val = prop.value; } catch (e) { }
                var score = 0;
                if (pathSegs[0] === "Transform") score += 10;
                if (prop.name.toLowerCase().indexOf(orGroups[0][0] || "") !== -1) score += 5;
                hits.push({
                    layerId: layerId,
                    propPath: pathSegs.join("/"),
                    propType: String(prop.propertyValueType),
                    value: val,
                    hasExpression: prop.canSetExpression && (prop.expression !== ""),
                    hasKeyframes: prop.numKeyframes > 0,
                    _score: score
                });
            }
        } else {
            for (var i = 1; i <= prop.numProperties; i++) {
                var child = prop.property(i);
                if (!child) continue;
                visit(child, layerId, pathSegs.concat([child.name]), depth + 1);
            }
        }
    }

    for (var li = 0; li < layerIds.length; li++) {
        var layer = comp.layer(layerIds[li]);
        if (!layer) continue;
        for (var pi = 1; pi <= layer.numProperties; pi++) {
            var top = layer.property(pi);
            if (!top) continue;
            visit(top, layerIds[li], [top.name], 0);
        }
    }

    hits.sort(function(a, b) { return b._score - a._score; });
    var total = hits.length;
    var paged = hits.slice(offset, offset + limit);
    for (var pi2 = 0; pi2 < paged.length; pi2++) delete paged[pi2]._score;

    return JSON.stringify({ok:true, total: total, results: paged});
})()
```

- [ ] **Step 5: 写 handler 测试**

追加到 `tests/test_handlers_typed.py`：

```python
import json
import pytest
from after_effects_mcp import schemas


def test_render_get_properties_substitutes_query():
    from after_effects_mcp.handlers.typed import render_get_properties
    args = schemas.AeGetPropertiesArgs(layer_ids=[1, 2], query="pos rot|opacity")
    jsx = render_get_properties(args)
    assert '"pos rot|opacity"' in jsx
    assert '[1, 2]' in jsx or '[1,2]' in jsx


@pytest.mark.asyncio
async def test_run_get_properties(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "total": 1, "results": [
            {"layerId": 1, "propPath": "Transform/Position",
             "propType": "ThreeD_SPATIAL", "value": [0,0,0],
             "hasExpression": False, "hasKeyframes": False}
        ]}),
    )
    from after_effects_mcp.handlers.typed import _run_get_properties
    args = schemas.AeGetPropertiesArgs(layer_ids=[1], query="position")
    result = await _run_get_properties(args, ctx=None)
    assert result["ok"] is True
    assert result["total"] == 1
```

- [ ] **Step 6: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_typed.py -v -k get_properties`

- [ ] **Step 7: 实现 handler + render**

在 `after_effects_mcp/handlers/typed.py` 末尾追加：

```python
# ---------------------------------------------------------------------------
# ae.getProperties
# ---------------------------------------------------------------------------


def render_get_properties(args: schemas.AeGetPropertiesArgs) -> str:
    tmpl = _load_template("get_properties.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_ids_js=_json_literal([int(i) for i in args.layer_ids]),
        query_js=_json_literal(args.query),
        offset=int(args.offset),
        limit=int(args.limit),
    )


async def _run_get_properties(args: schemas.AeGetPropertiesArgs, ctx: Any) -> Any:
    jsx = render_get_properties(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=20.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.getProperties..."
    )


register("ae.getProperties", schemas.AeGetPropertiesArgs, _run_get_properties)
```

- [ ] **Step 8: 运行测试确认通过**

Run: `python -m uv run pytest -m "not live and not live_smoke"`
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add after_effects_mcp/schemas.py after_effects_mcp/jsx_templates/get_properties.jsx after_effects_mcp/handlers/typed.py tests/test_schemas.py tests/test_handlers_typed.py
git commit -m "feat(verbs): ae.getProperties typed read verb"
```

---

### Task 4.2: ae.scanPropertyTree

**Files:**
- Modify: `after_effects_mcp/schemas.py`
- Create: `after_effects_mcp/jsx_templates/scan_property_tree.jsx`
- Modify: `after_effects_mcp/handlers/typed.py`
- Modify: `tests/test_schemas.py`
- Modify: `tests/test_handlers_typed.py`

- [ ] **Step 1: 写 schema 测试**

```python
def test_scan_property_tree_defaults():
    a = schemas.AeScanPropertyTreeArgs(layer_id=1)
    assert a.max_depth == 4
    assert a.include_values is True

def test_scan_property_tree_max_depth_clamped():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        schemas.AeScanPropertyTreeArgs(layer_id=1, max_depth=99)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k scan_property_tree`

- [ ] **Step 3: 实现 schema**

在 `schemas.py` 紧接 `AeGetPropertiesArgs` 之后追加：

```python
class AeScanPropertyTreeArgs(_StrictModel):
    """ae.scanPropertyTree — deep DFS dump of one layer's property tree."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active.")
    layer_id: int = Field(..., ge=1, description="1-based layer index.")
    max_depth: int = Field(4, ge=1, le=10, description="DFS depth cap.")
    include_values: bool = Field(True, description="Set false to skip .value reads.")
```

加 SCHEMAS `"ae.scanPropertyTree": AeScanPropertyTreeArgs,` + bump assert.

- [ ] **Step 4: 写 JSX 模板**

Create `after_effects_mcp/jsx_templates/scan_property_tree.jsx`:

```javascript
// ae.scanPropertyTree — DFS dump of a single layer's property tree.
// Placeholders: comp_expr, layer_id, max_depth, include_values (true/false).
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = comp.layer(${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});
    var maxDepth = ${max_depth};
    var includeValues = ${include_values};
    var truncated = null;

    function nodeFor(prop, depth) {
        var n = {
            name: prop.name,
            matchName: prop.matchName,
            kind: (prop.propertyType === PropertyType.PROPERTY) ? "Property" : "PropertyGroup",
            propType: null,
            value: null,
            hasExpression: false,
            numKeyframes: 0,
            children: []
        };
        if (prop.propertyType === PropertyType.PROPERTY) {
            n.propType = String(prop.propertyValueType);
            n.numKeyframes = prop.numKeyframes;
            n.hasExpression = prop.canSetExpression && (prop.expression !== "");
            if (includeValues) {
                try { n.value = prop.value; } catch (e) { }
            }
        } else {
            if (depth >= maxDepth) {
                truncated = depth;
                return n;
            }
            for (var i = 1; i <= prop.numProperties; i++) {
                var child = prop.property(i);
                if (!child) continue;
                n.children.push(nodeFor(child, depth + 1));
            }
        }
        return n;
    }

    var rootChildren = [];
    for (var pi = 1; pi <= layer.numProperties; pi++) {
        var top = layer.property(pi);
        if (!top) continue;
        rootChildren.push(nodeFor(top, 1));
    }

    return JSON.stringify({
        ok: true,
        layerId: ${layer_id},
        layerName: layer.name,
        tree: { name: "(root)", matchName: "", kind: "PropertyGroup",
                propType: null, value: null, hasExpression: false,
                numKeyframes: 0, children: rootChildren },
        truncatedAt: truncated
    });
})()
```

- [ ] **Step 5: 写 handler 测试**

```python
def test_render_scan_property_tree():
    from after_effects_mcp.handlers.typed import render_scan_property_tree
    args = schemas.AeScanPropertyTreeArgs(layer_id=3, max_depth=2, include_values=False)
    jsx = render_scan_property_tree(args)
    assert "comp.layer(3)" in jsx
    assert "var maxDepth = 2;" in jsx
    assert "var includeValues = false;" in jsx


@pytest.mark.asyncio
async def test_run_scan_property_tree(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "layerId": 1, "layerName": "L",
                    "tree": {"children": []}, "truncatedAt": None}),
    )
    from after_effects_mcp.handlers.typed import _run_scan_property_tree
    args = schemas.AeScanPropertyTreeArgs(layer_id=1)
    result = await _run_scan_property_tree(args, ctx=None)
    assert result["ok"] is True
```

- [ ] **Step 6: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_typed.py -v -k scan_property_tree`

- [ ] **Step 7: 实现 handler + render**

```python
# ---------------------------------------------------------------------------
# ae.scanPropertyTree
# ---------------------------------------------------------------------------


def render_scan_property_tree(args: schemas.AeScanPropertyTreeArgs) -> str:
    tmpl = _load_template("scan_property_tree.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        max_depth=int(args.max_depth),
        include_values="true" if args.include_values else "false",
    )


async def _run_scan_property_tree(args: schemas.AeScanPropertyTreeArgs, ctx: Any) -> Any:
    jsx = render_scan_property_tree(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.scanPropertyTree..."
    )


register("ae.scanPropertyTree", schemas.AeScanPropertyTreeArgs, _run_scan_property_tree)
```

- [ ] **Step 8: 全测试通过**

Run: `python -m uv run pytest -m "not live and not live_smoke"`

- [ ] **Step 9: Commit**

```bash
git add after_effects_mcp/schemas.py after_effects_mcp/jsx_templates/scan_property_tree.jsx after_effects_mcp/handlers/typed.py tests/test_schemas.py tests/test_handlers_typed.py
git commit -m "feat(verbs): ae.scanPropertyTree typed read verb"
```

---

### Task 4.3: ae.inspectPropertyCapabilities

**Files:**
- Modify: `after_effects_mcp/schemas.py`
- Create: `after_effects_mcp/jsx_templates/inspect_property_capabilities.jsx`
- Modify: `after_effects_mcp/handlers/typed.py`
- Modify: `tests/test_schemas.py`
- Modify: `tests/test_handlers_typed.py`

- [ ] **Step 1: 写 schema 测试**

```python
def test_inspect_property_capabilities_required():
    a = schemas.AeInspectPropertyCapabilitiesArgs(layer_id=1, path="Transform/Position")
    assert a.layer_id == 1
    assert a.path == "Transform/Position"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k inspect_property_capabilities`

- [ ] **Step 3: 实现 schema**

```python
class AeInspectPropertyCapabilitiesArgs(_StrictModel):
    """ae.inspectPropertyCapabilities — what can be mutated on a property path."""
    comp_id: Optional[str] = Field(None)
    layer_id: int = Field(..., ge=1)
    path: str = Field(..., description="'Transform/Position' style path.")
```

`"ae.inspectPropertyCapabilities": AeInspectPropertyCapabilitiesArgs,` + bump.

- [ ] **Step 4: 写 JSX 模板**

```javascript
// ae.inspectPropertyCapabilities — describe what can be done with a property.
// Placeholders: comp_expr, layer_id, path.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = comp.layer(${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});

    var segs = (${path}).split("/");
    var prop = layer;
    for (var i = 0; i < segs.length; i++) {
        try {
            prop = prop.property(segs[i]);
            if (!prop) return JSON.stringify({
                ok: true, exists: false,
                error: "path segment not found: " + segs[i]
            });
        } catch (e) {
            return JSON.stringify({ok:false, exists: false,
                error: "property() threw: " + String(e)});
        }
    }

    if (prop.propertyType !== PropertyType.PROPERTY) {
        return JSON.stringify({
            ok: true, exists: true, isGroup: true,
            canSetValue: false, canSetExpression: false,
            canAddKeyframe: false, propType: null,
            valueDimension: 0, hasMin: false, hasMax: false,
            minValue: null, maxValue: null, unitsText: null,
            numKeyframes: 0, hasExpression: false
        });
    }

    var dim = 1;
    try {
        var v = prop.value;
        if (v && v.length !== undefined) dim = v.length;
    } catch (e) { }

    return JSON.stringify({
        ok: true, exists: true, isGroup: false,
        canSetValue: true,
        canSetExpression: prop.canSetExpression,
        canAddKeyframe: prop.canVaryOverTime,
        propType: String(prop.propertyValueType),
        valueDimension: dim,
        hasMin: !!prop.hasMin,
        hasMax: !!prop.hasMax,
        minValue: prop.hasMin ? prop.minValue : null,
        maxValue: prop.hasMax ? prop.maxValue : null,
        unitsText: prop.unitsText || null,
        numKeyframes: prop.numKeyframes,
        hasExpression: (prop.canSetExpression && prop.expression !== "")
    });
})()
```

- [ ] **Step 5: 写 handler 测试**

```python
def test_render_inspect_property_capabilities():
    from after_effects_mcp.handlers.typed import render_inspect_property_capabilities
    args = schemas.AeInspectPropertyCapabilitiesArgs(layer_id=1, path="Transform/Position")
    jsx = render_inspect_property_capabilities(args)
    assert '"Transform/Position"' in jsx
    assert "comp.layer(1)" in jsx


@pytest.mark.asyncio
async def test_run_inspect_property_capabilities(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "exists": True, "canSetValue": True,
                    "canSetExpression": True, "valueDimension": 3}),
    )
    from after_effects_mcp.handlers.typed import _run_inspect_property_capabilities
    args = schemas.AeInspectPropertyCapabilitiesArgs(layer_id=1, path="Transform/Position")
    result = await _run_inspect_property_capabilities(args, ctx=None)
    assert result["canSetExpression"] is True
```

- [ ] **Step 6: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_typed.py -v -k inspect_property_capabilities`

- [ ] **Step 7: 实现 handler + render**

```python
def render_inspect_property_capabilities(args: schemas.AeInspectPropertyCapabilitiesArgs) -> str:
    tmpl = _load_template("inspect_property_capabilities.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        path=_json_literal(args.path),
    )


async def _run_inspect_property_capabilities(
    args: schemas.AeInspectPropertyCapabilitiesArgs, ctx: Any
) -> Any:
    jsx = render_inspect_property_capabilities(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=15.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.inspectPropertyCapabilities..."
    )


register("ae.inspectPropertyCapabilities",
         schemas.AeInspectPropertyCapabilitiesArgs,
         _run_inspect_property_capabilities)
```

- [ ] **Step 8: 全测试通过**

Run: `python -m uv run pytest -m "not live and not live_smoke"`

- [ ] **Step 9: Commit**

```bash
git add after_effects_mcp/schemas.py after_effects_mcp/jsx_templates/inspect_property_capabilities.jsx after_effects_mcp/handlers/typed.py tests/test_schemas.py tests/test_handlers_typed.py
git commit -m "feat(verbs): ae.inspectPropertyCapabilities typed read verb"
```

---

### Task 4.4: ae.getExpressions

**Files:**
- Modify: `after_effects_mcp/schemas.py`
- Create: `after_effects_mcp/jsx_templates/get_expressions.jsx`
- Modify: `after_effects_mcp/handlers/typed.py`
- Modify: `tests/test_schemas.py`
- Modify: `tests/test_handlers_typed.py`

- [ ] **Step 1: 写 schema 测试**

```python
def test_get_expressions_required_comp_id():
    a = schemas.AeGetExpressionsArgs(comp_id="12")
    assert a.layer_ids is None
    assert a.prop is None
    assert a.max_results == 200

def test_get_expressions_layer_ids_optional():
    a = schemas.AeGetExpressionsArgs(comp_id="12", layer_ids=[1, 2], prop="ADBE Position")
    assert a.layer_ids == [1, 2]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k get_expressions`

- [ ] **Step 3: 实现 schema**

```python
class AeGetExpressionsArgs(_StrictModel):
    """ae.getExpressions — read all expressions in a comp."""
    comp_id: str = Field(..., description="AE comp id (required).")
    layer_ids: Optional[List[int]] = Field(None, description="Restrict to these layers.")
    prop: Optional[str] = Field(None, description="matchName substring filter.")
    max_results: int = Field(200, ge=1, le=1000)
```

`"ae.getExpressions": AeGetExpressionsArgs,` + bump.

- [ ] **Step 4: 写 JSX 模板**

```javascript
// ae.getExpressions — collect all non-empty expressions.
// Placeholders: comp_expr (resolves a comp), layer_ids_js (array | null),
// prop_filter_js (string | null), max_results.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layerIds = ${layer_ids_js};
    var propFilter = ${prop_filter_js};
    var maxResults = ${max_results};

    function shortHash(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return ("00000000" + (h >>> 0).toString(16)).slice(-8);
    }

    var hits = [];
    var truncated = false;

    function visit(prop, layerId, pathSegs, depth) {
        if (truncated) return;
        if (depth > 6) return;
        if (prop.propertyType === PropertyType.PROPERTY) {
            if (prop.canSetExpression && prop.expression !== "") {
                if (propFilter && (prop.matchName.indexOf(propFilter) === -1)) return;
                if (hits.length >= maxResults) { truncated = true; return; }
                var src = String(prop.expression);
                hits.push({
                    layerId: layerId,
                    propPath: pathSegs.join("/"),
                    expression: src,
                    enabled: !prop.expressionEnabled ? false : true,
                    hash: shortHash(src)
                });
            }
        } else {
            for (var i = 1; i <= prop.numProperties; i++) {
                var child = prop.property(i);
                if (!child) continue;
                visit(child, layerId, pathSegs.concat([child.name]), depth + 1);
            }
        }
    }

    var n = comp.numLayers;
    for (var li = 1; li <= n; li++) {
        if (layerIds) {
            var keep = false;
            for (var ki = 0; ki < layerIds.length; ki++) {
                if (layerIds[ki] === li) { keep = true; break; }
            }
            if (!keep) continue;
        }
        var layer = comp.layer(li);
        for (var pi = 1; pi <= layer.numProperties; pi++) {
            var top = layer.property(pi);
            if (!top) continue;
            visit(top, li, [top.name], 0);
        }
    }

    var grouped = {};
    for (var hi = 0; hi < hits.length; hi++) {
        var h = hits[hi];
        if (!grouped[h.hash]) grouped[h.hash] = [];
        grouped[h.hash].push({layerId: h.layerId, propPath: h.propPath});
    }

    return JSON.stringify({
        ok: true,
        expressions: hits,
        grouped: grouped,
        truncated: truncated
    });
})()
```

- [ ] **Step 5: 写 handler 测试**

```python
def test_render_get_expressions():
    from after_effects_mcp.handlers.typed import render_get_expressions
    args = schemas.AeGetExpressionsArgs(comp_id="12", layer_ids=[1], prop="Position")
    jsx = render_get_expressions(args)
    assert '"Position"' in jsx
    assert '[1]' in jsx


@pytest.mark.asyncio
async def test_run_get_expressions(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "expressions": [], "grouped": {}, "truncated": False}),
    )
    from after_effects_mcp.handlers.typed import _run_get_expressions
    args = schemas.AeGetExpressionsArgs(comp_id="12")
    result = await _run_get_expressions(args, ctx=None)
    assert result["ok"] is True
```

- [ ] **Step 6: 运行测试确认失败**

Run: `python -m uv run pytest tests/test_handlers_typed.py -v -k get_expressions`

- [ ] **Step 7: 实现 handler + render**

```python
def render_get_expressions(args: schemas.AeGetExpressionsArgs) -> str:
    tmpl = _load_template("get_expressions.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_ids_js=_json_literal(list(args.layer_ids)) if args.layer_ids else "null",
        prop_filter_js=_json_literal(args.prop) if args.prop else "null",
        max_results=int(args.max_results),
    )


async def _run_get_expressions(args: schemas.AeGetExpressionsArgs, ctx: Any) -> Any:
    jsx = render_get_expressions(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.getExpressions..."
    )


register("ae.getExpressions", schemas.AeGetExpressionsArgs, _run_get_expressions)
```

- [ ] **Step 8: 全测试通过**

Run: `python -m uv run pytest -m "not live and not live_smoke"`

- [ ] **Step 9: Commit**

```bash
git add after_effects_mcp/schemas.py after_effects_mcp/jsx_templates/get_expressions.jsx after_effects_mcp/handlers/typed.py tests/test_schemas.py tests/test_handlers_typed.py
git commit -m "feat(verbs): ae.getExpressions typed read verb"
```

---

### Task 4.5: ae.getKeyframes

**Files:** same five files as 4.1.

- [ ] **Step 1: 写 schema 测试**

```python
def test_get_keyframes_required():
    a = schemas.AeGetKeyframesArgs(layer_id=1, path="Transform/Position")
    assert a.layer_id == 1
```

- [ ] **Step 2: 运行测试失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k get_keyframes`

- [ ] **Step 3: 实现 schema**

```python
class AeGetKeyframesArgs(_StrictModel):
    """ae.getKeyframes — keyframe data for a property path."""
    comp_id: Optional[str] = Field(None)
    layer_id: int = Field(..., ge=1)
    path: str = Field(...)
```

`"ae.getKeyframes": AeGetKeyframesArgs,` + bump.

- [ ] **Step 4: 写 JSX 模板**

Create `after_effects_mcp/jsx_templates/get_keyframes.jsx`:

```javascript
// ae.getKeyframes — list keyframes for one property.
// Placeholders: comp_expr, layer_id, path.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = comp.layer(${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});
    var segs = (${path}).split("/");
    var prop = layer;
    for (var i = 0; i < segs.length; i++) {
        try {
            prop = prop.property(segs[i]);
            if (!prop) return JSON.stringify({ok:false,
                error:"path segment not found: " + segs[i]});
        } catch (e) {
            return JSON.stringify({ok:false, error:"property() threw: " + String(e)});
        }
    }
    if (prop.propertyType !== PropertyType.PROPERTY) {
        return JSON.stringify({ok:false, error:"path resolves to a group, not a property"});
    }
    function interpName(t) {
        if (t === KeyframeInterpolationType.LINEAR) return "LINEAR";
        if (t === KeyframeInterpolationType.BEZIER) return "BEZIER";
        if (t === KeyframeInterpolationType.HOLD) return "HOLD";
        return "UNKNOWN";
    }
    var n = prop.numKeyframes;
    var keyframes = [];
    for (var k = 1; k <= n; k++) {
        var entry = {
            index: k,
            time: prop.keyTime(k),
            value: prop.keyValue(k),
            interpIn: interpName(prop.keyInInterpolationType(k)),
            interpOut: interpName(prop.keyOutInterpolationType(k))
        };
        try { entry.easeIn = prop.keyInTemporalEase(k); } catch (e) { entry.easeIn = null; }
        try { entry.easeOut = prop.keyOutTemporalEase(k); } catch (e) { entry.easeOut = null; }
        try { entry.spatialIn = prop.keyInSpatialTangent(k); } catch (e) { entry.spatialIn = null; }
        try { entry.spatialOut = prop.keyOutSpatialTangent(k); } catch (e) { entry.spatialOut = null; }
        keyframes.push(entry);
    }
    return JSON.stringify({ok:true, numKeyframes:n, keyframes:keyframes});
})()
```

- [ ] **Step 5: 写 handler 测试**

```python
def test_render_get_keyframes():
    from after_effects_mcp.handlers.typed import render_get_keyframes
    args = schemas.AeGetKeyframesArgs(layer_id=1, path="Transform/Position")
    jsx = render_get_keyframes(args)
    assert '"Transform/Position"' in jsx
    assert "comp.layer(1)" in jsx


@pytest.mark.asyncio
async def test_run_get_keyframes(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "numKeyframes": 0, "keyframes": []}),
    )
    from after_effects_mcp.handlers.typed import _run_get_keyframes
    args = schemas.AeGetKeyframesArgs(layer_id=1, path="Transform/Position")
    result = await _run_get_keyframes(args, ctx=None)
    assert result["numKeyframes"] == 0
```

- [ ] **Step 6: 运行失败**

Run: `python -m uv run pytest tests/test_handlers_typed.py -v -k get_keyframes`

- [ ] **Step 7: 实现 handler + render**

```python
def render_get_keyframes(args: schemas.AeGetKeyframesArgs) -> str:
    tmpl = _load_template("get_keyframes.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        path=_json_literal(args.path),
    )


async def _run_get_keyframes(args: schemas.AeGetKeyframesArgs, ctx: Any) -> Any:
    jsx = render_get_keyframes(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=20.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.getKeyframes..."
    )


register("ae.getKeyframes", schemas.AeGetKeyframesArgs, _run_get_keyframes)
```

- [ ] **Step 8: 全测试通过**

Run: `python -m uv run pytest -m "not live and not live_smoke"`

- [ ] **Step 9: Commit**

```bash
git add after_effects_mcp/schemas.py after_effects_mcp/jsx_templates/get_keyframes.jsx after_effects_mcp/handlers/typed.py tests/test_schemas.py tests/test_handlers_typed.py
git commit -m "feat(verbs): ae.getKeyframes typed read verb"
```

---

### Task 4.6: ae.searchProject

**Files:** same five.

- [ ] **Step 1: 写 schema 测试**

```python
def test_search_project_defaults():
    a = schemas.AeSearchProjectArgs(query="hero")
    assert a.scope == ["layers", "expressions", "effects", "comps", "items"]
    assert a.limit == 100

def test_search_project_scope_subset():
    a = schemas.AeSearchProjectArgs(query="x", scope=["layers"])
    assert a.scope == ["layers"]

def test_search_project_invalid_scope():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        schemas.AeSearchProjectArgs(query="x", scope=["bogus"])
```

- [ ] **Step 2: 运行失败**

Run: `python -m uv run pytest tests/test_schemas.py -v -k search_project`

- [ ] **Step 3: 实现 schema**

```python
SearchScope = Literal["layers", "expressions", "effects", "comps", "items"]


class AeSearchProjectArgs(_StrictModel):
    """ae.searchProject — fuzzy search across the whole project."""
    query: str = Field(..., description="Multi-word AND; '|' OR groups.")
    scope: List[SearchScope] = Field(
        default_factory=lambda: ["layers", "expressions", "effects", "comps", "items"],
        description="Which kinds of objects to scan.",
    )
    limit: int = Field(100, ge=1, le=500)
```

`"ae.searchProject": AeSearchProjectArgs,` + bump assert (final value should equal current_count + 6).

- [ ] **Step 4: 写 JSX 模板**

Create `after_effects_mcp/jsx_templates/search_project.jsx`:

```javascript
// ae.searchProject — fuzzy search across project items / comps / layers / effects / expressions.
// Placeholders: query_js, scope_js (array), limit.
(function() {
    var query = ${query_js};
    var scope = ${scope_js};
    var limit = ${limit};

    var orGroups = query.toLowerCase().split("|");
    for (var oi = 0; oi < orGroups.length; oi++) {
        var raw = orGroups[oi].split(/\s+/);
        var trimmed = [];
        for (var ai = 0; ai < raw.length; ai++) if (raw[ai].length > 0) trimmed.push(raw[ai]);
        orGroups[oi] = trimmed;
    }

    function matches(text) {
        var hay = String(text).toLowerCase();
        for (var gi = 0; gi < orGroups.length; gi++) {
            var grp = orGroups[gi];
            if (grp.length === 0) continue;
            var ok = true;
            for (var ti = 0; ti < grp.length; ti++) {
                if (hay.indexOf(grp[ti]) === -1) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    function inScope(s) {
        for (var i = 0; i < scope.length; i++) if (scope[i] === s) return true;
        return false;
    }

    var hits = [];
    var truncated = false;
    function add(h) {
        if (truncated) return;
        if (hits.length >= limit) { truncated = true; return; }
        hits.push(h);
    }

    var n = app.project.numItems;
    for (var i = 1; i <= n; i++) {
        if (truncated) break;
        var it = app.project.item(i);
        if (!it) continue;

        if (it instanceof CompItem) {
            if (inScope("comps") && matches(it.name)) {
                add({kind:"comp", compId:String(it.id), name:it.name,
                     snippet:it.name, score:0.95});
            }
            if (inScope("layers") || inScope("expressions") || inScope("effects")) {
                for (var li = 1; li <= it.numLayers; li++) {
                    if (truncated) break;
                    var layer = it.layer(li);
                    if (inScope("layers") && matches(layer.name)) {
                        add({kind:"layer", compId:String(it.id), layerId:li,
                             name:layer.name, snippet:layer.name, score:0.85});
                    }
                    if (inScope("effects")) {
                        var fx = layer.property("ADBE Effect Parade");
                        if (fx) {
                            for (var ei = 1; ei <= fx.numProperties; ei++) {
                                var e = fx.property(ei);
                                if (e && (matches(e.name) || matches(e.matchName))) {
                                    add({kind:"effect", compId:String(it.id), layerId:li,
                                         name:e.name, matchName:e.matchName,
                                         snippet:e.name, score:0.7});
                                }
                            }
                        }
                    }
                    if (inScope("expressions")) {
                        // shallow scan: only Transform group expressions to keep cost bounded
                        var xf = layer.property("ADBE Transform Group");
                        if (xf) {
                            for (var xi = 1; xi <= xf.numProperties; xi++) {
                                var xp = xf.property(xi);
                                if (xp && xp.canSetExpression && xp.expression !== "") {
                                    if (matches(xp.expression)) {
                                        var snip = xp.expression.length > 80 ?
                                            xp.expression.slice(0, 80) + "..." :
                                            xp.expression;
                                        add({kind:"expression",
                                             compId:String(it.id), layerId:li,
                                             propPath:"Transform/" + xp.name,
                                             snippet:snip, score:0.5});
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if (inScope("items") && matches(it.name)) {
            add({kind:"item", itemId:String(it.id), name:it.name,
                 snippet:it.name, score:0.6});
        }
    }

    hits.sort(function(a,b){return b.score - a.score;});
    return JSON.stringify({ok:true, hits:hits, truncated:truncated});
})()
```

- [ ] **Step 5: 写 handler 测试**

```python
def test_render_search_project():
    from after_effects_mcp.handlers.typed import render_search_project
    args = schemas.AeSearchProjectArgs(query="hero", scope=["layers"], limit=10)
    jsx = render_search_project(args)
    assert '"hero"' in jsx
    assert '"layers"' in jsx
    assert "var limit = 10;" in jsx


@pytest.mark.asyncio
async def test_run_search_project(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "hits": [], "truncated": False}),
    )
    from after_effects_mcp.handlers.typed import _run_search_project
    args = schemas.AeSearchProjectArgs(query="x")
    result = await _run_search_project(args, ctx=None)
    assert result["ok"] is True
```

- [ ] **Step 6: 运行失败**

Run: `python -m uv run pytest tests/test_handlers_typed.py -v -k search_project`

- [ ] **Step 7: 实现 handler + render**

```python
def render_search_project(args: schemas.AeSearchProjectArgs) -> str:
    tmpl = _load_template("search_project.jsx")
    return tmpl.substitute(
        query_js=_json_literal(args.query),
        scope_js=_json_literal(list(args.scope)),
        limit=int(args.limit),
    )


async def _run_search_project(args: schemas.AeSearchProjectArgs, ctx: Any) -> Any:
    jsx = render_search_project(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.searchProject..."
    )


register("ae.searchProject", schemas.AeSearchProjectArgs, _run_search_project)
```

- [ ] **Step 8: 全测试通过 + 验证 SCHEMAS 计数**

Run: `python -m uv run pytest -m "not live and not live_smoke"`
Run: `python -m uv run python -c "from after_effects_mcp.schemas import SCHEMAS; print(len(SCHEMAS))"`
Expected: prints `24`.

- [ ] **Step 9: Commit**

```bash
git add after_effects_mcp/schemas.py after_effects_mcp/jsx_templates/search_project.jsx after_effects_mcp/handlers/typed.py tests/test_schemas.py tests/test_handlers_typed.py
git commit -m "feat(verbs): ae.searchProject typed read verb"
```

---

## Phase 5 — Live tests for new verbs

### Task 5.1: live test for read verbs

**Files:**
- Create: `tests/live/test_read_verbs.py`

- [ ] **Step 1: 创建 live 读 verb 测试**

```python
"""Live tests for the 6 typed read verbs.

Strategy: build a fixture comp with known structure (1 solid layer at
position [960,540,0], 1 keyframe on Position, 1 expression on Rotation),
then call each read verb and assert the expected fields.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from after_effects_mcp import bridge, schemas
from after_effects_mcp.handlers.typed import (
    _run_get_properties, _run_scan_property_tree,
    _run_inspect_property_capabilities, _run_get_expressions,
    _run_get_keyframes, _run_search_project,
)


pytestmark = pytest.mark.live


SETUP_JSX = """
(function(){
    var comp = app.project.items.addComp("Probe", 320, 240, 1, 2.0, 24);
    var solid = comp.layers.addSolid([1,0,0], "RedBox", 100, 100, 1, 2.0);
    var pos = solid.property("ADBE Transform Group").property("ADBE Position");
    pos.setValueAtTime(0, [50, 50, 0]);
    pos.setValueAtTime(1.0, [200, 200, 0]);
    var rot = solid.property("ADBE Transform Group").property("ADBE Rotate Z");
    rot.expression = "wiggle(2,30)";
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: solid.index});
})()
"""


@pytest.fixture
def probe_scene(clean_project):
    out = asyncio.run(bridge.invoke_ae_exec(code=SETUP_JSX, timeout_sec=20.0))
    return json.loads(out)


@pytest.mark.asyncio
async def test_get_properties_finds_position(probe_scene):
    args = schemas.AeGetPropertiesArgs(
        comp_id=probe_scene["compId"],
        layer_ids=[probe_scene["layerId"]],
        query="position",
    )
    result = await _run_get_properties(args, ctx=None)
    assert result["ok"] is True
    assert result["total"] >= 1
    paths = [r["propPath"] for r in result["results"]]
    assert any("Position" in p for p in paths)


@pytest.mark.asyncio
async def test_scan_property_tree_returns_transform(probe_scene):
    args = schemas.AeScanPropertyTreeArgs(
        comp_id=probe_scene["compId"],
        layer_id=probe_scene["layerId"],
        max_depth=3,
    )
    result = await _run_scan_property_tree(args, ctx=None)
    assert result["ok"] is True
    names = [c["name"] for c in result["tree"]["children"]]
    assert any(n in ("Transform", "变换") for n in names)


@pytest.mark.asyncio
async def test_inspect_property_capabilities_position(probe_scene):
    args = schemas.AeInspectPropertyCapabilitiesArgs(
        comp_id=probe_scene["compId"],
        layer_id=probe_scene["layerId"],
        path="Transform/Position",
    )
    result = await _run_inspect_property_capabilities(args, ctx=None)
    assert result["ok"] is True
    assert result["exists"] is True
    assert result["canSetValue"] is True
    assert result["valueDimension"] in (2, 3)


@pytest.mark.asyncio
async def test_get_expressions_finds_wiggle(probe_scene):
    args = schemas.AeGetExpressionsArgs(comp_id=probe_scene["compId"])
    result = await _run_get_expressions(args, ctx=None)
    assert result["ok"] is True
    sources = [e["expression"] for e in result["expressions"]]
    assert any("wiggle" in s for s in sources)


@pytest.mark.asyncio
async def test_get_keyframes_position(probe_scene):
    args = schemas.AeGetKeyframesArgs(
        comp_id=probe_scene["compId"],
        layer_id=probe_scene["layerId"],
        path="Transform/Position",
    )
    result = await _run_get_keyframes(args, ctx=None)
    assert result["ok"] is True
    assert result["numKeyframes"] == 2


@pytest.mark.asyncio
async def test_search_project_finds_redbox(probe_scene):
    args = schemas.AeSearchProjectArgs(query="redbox")
    result = await _run_search_project(args, ctx=None)
    assert result["ok"] is True
    assert any(h.get("name", "").lower() == "redbox" for h in result["hits"])
```

- [ ] **Step 2: 验证默认不跑**

Run: `python -m uv run pytest 2>&1 | tail -3`
Expected: live 目录下 6 个 test 不被收集（`-m "not live"` 默认过滤）。

- [ ] **Step 3: 验证 -m live 时 skip 而不是 collect 失败**

Run: `python -m uv run pytest -m live 2>&1 | tail -5`
Expected: 全部 skip（`AEBM_LIVE_TESTS` 未设置）。

- [ ] **Step 4: Commit**

```bash
git add tests/live/test_read_verbs.py
git commit -m "test(live): end-to-end for 6 typed read verbs against probe scene"
```

---

### Task 5.2: live test for checkpoint cycle

**Files:**
- Create: `tests/live/test_checkpoint_cycle.py`

- [ ] **Step 1: 创建测试**

```python
"""Live test for the full create→write→revert cycle.

Requires a saved .aep on disk (we save to %TEMP% before the test).
Verifies: checkpoint create writes a real .aep + meta sidecar, revert
opens it, and the property change made between create and revert is
rolled back.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import pytest

from after_effects_mcp import bridge, schemas
from after_effects_mcp.handlers.core import _run_checkpoint, _run_revert


pytestmark = pytest.mark.live


@pytest.mark.asyncio
async def test_checkpoint_create_revert_roundtrip(clean_project, tmp_path):
    # 1. Save the (empty) project to %TEMP% so it is no longer untitled.
    saved = tmp_path / "probe.aep"
    save_jsx = (
        f'(function(){{ app.project.save(new File({json.dumps(str(saved))})); '
        f'return JSON.stringify({{ok:true,path:app.project.file.fsName}}); }})()'
    )
    out = await bridge.invoke_ae_exec(code=save_jsx, timeout_sec=20.0)
    assert json.loads(out)["ok"] is True

    # 2. Add a comp + layer; save again so the saved state contains them.
    seed_jsx = (
        '(function(){'
        'var c = app.project.items.addComp("CycleProbe", 320, 240, 1, 1.0, 24);'
        'var s = c.layers.addSolid([1,0,0], "Box", 100, 100, 1, 1.0);'
        's.property("ADBE Transform Group").property("ADBE Position").setValue([100,100,0]);'
        'app.project.save();'
        'return JSON.stringify({ok:true, compId:String(c.id), layerId:s.index});'
        '})()'
    )
    seed = json.loads(await bridge.invoke_ae_exec(code=seed_jsx, timeout_sec=20.0))

    # 3. ae.checkpoint create
    cp = await _run_checkpoint(
        schemas.AeCheckpointArgs(action="create", label="seeded"),
        ctx=None,
    )
    assert cp["ok"] is True and cp.get("id"), cp
    cp_id = cp["id"]
    assert Path(cp["path"]).exists()

    # 4. Mutate position to a different value
    mut_jsx = (
        f'(function(){{'
        f'var c = app.project.itemByID({int(seed["compId"])});'
        f'var s = c.layer({int(seed["layerId"])});'
        f's.property("ADBE Transform Group").property("ADBE Position").setValue([777,777,0]);'
        f'return JSON.stringify({{ok:true}});'
        f'}})()'
    )
    await bridge.invoke_ae_exec(code=mut_jsx, timeout_sec=10.0)

    # 5. ae.revert
    rv = await _run_revert(
        schemas.AeRevertArgs(checkpoint_id=cp_id, branch_before_revert=False),
        ctx=None,
    )
    assert rv["ok"] is True and rv.get("reverted") is True, rv

    # 6. Verify position back to [100,100,0]
    check_jsx = (
        '(function(){'
        'var c = app.project.itemByName("CycleProbe");'
        'if (!c) return JSON.stringify({ok:false,error:"comp gone"});'
        'var pos = c.layer(1).property("ADBE Transform Group").property("ADBE Position").value;'
        'return JSON.stringify({ok:true, x:pos[0], y:pos[1]});'
        '})()'
    )
    val = json.loads(await bridge.invoke_ae_exec(code=check_jsx, timeout_sec=10.0))
    assert val["ok"] is True
    assert abs(val["x"] - 100.0) < 0.5
    assert abs(val["y"] - 100.0) < 0.5

    # 7. ae.checkpoint list contains our id
    listed = await _run_checkpoint(
        schemas.AeCheckpointArgs(action="list", limit=10), ctx=None
    )
    assert listed["ok"] is True
    assert any(c["id"] == cp_id for c in listed["checkpoints"])
```

- [ ] **Step 2: Commit**

```bash
git add tests/live/test_checkpoint_cycle.py
git commit -m "test(live): full checkpoint create -> mutate -> revert cycle"
```

---

## Phase 6 — Documentation sync

### Task 6.1: docs/REFERENCE.md 更新

**Files:**
- Modify: `docs/REFERENCE.md`

- [ ] **Step 1: 改 Quick facts 表**

把 `| Handler count | 15 (9 core + 6 typed sugar) |` 替换为 `| Handler count | 21 (10 core + 11 typed) |`。
把 `| Default per-call timeout | 30 s ... |` 行后插入 `| Checkpoint store | %TEMP%/aebm_checkpoints/<basename>/<id>.aep + .json (keep N=AEBM_CHECKPOINT_KEEP, default 50) |`。

- [ ] **Step 2: Verb reference 章节追加 7 个新 verb**

在 §"Verb reference" 现有 §15 (`ae.getTime`) 之后、`ae.isolateToggle` 之前，按 spec §4 的入参表格式追加 7 节：`16. ae.ping`、`17. ae.getProperties`、`18. ae.scanPropertyTree`、`19. ae.inspectPropertyCapabilities`、`20. ae.getExpressions`、`21. ae.getKeyframes`、`22. ae.searchProject`。重新编号 isolateToggle/toastQuery 为 23/24。

(每节内容与 spec §4 对应小节一致——直接 copy-paste 入参表 + 出参样例。)

- [ ] **Step 3: 更新 §"6. ae.checkpoint" 和 §"7. ae.revert"**

把 §6 顶部的 **(stub)** 标签改为 **(v0.7 升级)**；入参表加 `action` 行；出参描述改为 spec §4.8 的两种 shape。
把 §7 顶部的 **(stub)** 标签去掉；返回 shape 改为 spec §4.9 的真实现版。

- [ ] **Step 4: 更新 §"5. ae.exec"**

`checkpoint_label` 这行的 Notes 列从 "Ignored for `aebm-file`; plumbed through for forward-compat." 改为 "Non-empty: auto-create a checkpoint before running JSX. Untitled project → `checkpointSkipped: 'untitled-project'` in result."

- [ ] **Step 5: 新增章节 §"Checkpoint store"**

在 §"Async + progress contract" 之前插入完整的 Checkpoint store 章节，覆盖：路径布局、id 格式、保留策略、`AEBM_CHECKPOINT_KEEP`、untitled 行为、revert 后 fsName 变化注意事项。原文从 spec §4.8 + §6 + §7 抽取。

- [ ] **Step 6: 新增章节 §"Live test layer"**

在 §"Test coverage" 章节末尾插入：

```markdown
### Live test layer

Opt-in end-to-end tests that drive a real AE instance through the bridge.

**Activate**: `AEBM_LIVE_TESTS=1`. Without it, every `tests/live/*.py`
test skips (autouse fixture in `tests/live/conftest.py`).

**Markers**:
- `live` — full live suite (~24 cases, ~2-3 min on warm AE)
- `live_smoke` — 3-case ping/exec/snapshot canary (<30 s)

**CI policy**: live tests are excluded from `.github/workflows/ci.yml`
via `pyproject.toml`'s `addopts = "-m 'not live and not live_smoke'"`.
hosted runners cannot drive a GUI Adobe app. Run locally before each
release.

**Failure artifacts**: `tests/live/_artifacts/<test_name>/` collects
recent bridge stderr, last `out/<id>.json`, and a snapshot PNG when the
test failed.

**Run examples**:

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_BRIDGE_ROOT  = "E:/Code/AEBMethod"
python -m uv run pytest -m live_smoke      # quick canary
python -m uv run pytest -m live            # full
```
```

- [ ] **Step 7: §"Not doing" 表删除已实现行**

删掉 "Atom's non-critical 9 verbs" 那行里的 `inspect_property_capabilities, get_expressions, get_keyframes, search_project, scan_property_tree`（保留 `create_skill, generate_image, create_rig, edit_skill, use_skill`），把数字 9 改为 5；理由列改为 "依赖 Atom 云端 / skill marketplace；本地 AE-only 无意义"。

- [ ] **Step 8: 跑 markdownlint / 视觉确认**

Run: `python -m uv run python -c "import pathlib; t=pathlib.Path('docs/REFERENCE.md').read_text(encoding='utf-8'); print(len(t), 'chars,', t.count('### '), 'subsections')"`
Sanity: subsection count should match new total verbs.

- [ ] **Step 9: Commit**

```bash
git add docs/REFERENCE.md
git commit -m "docs(reference): v0.7 - 24 verbs, checkpoint store, live tests"
```

---

### Task 6.2: README.md 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 verb 表**

把现有 "Verb reference" 表（17 行）扩展到 24 行：原表保留前 15 行，在第 15 行（`ae.getTime`）之后追加：

```markdown
| 16 | `ae.ping` | bridge handshake (live test smoke) |
| 17 | `ae.getProperties` | property name search across layers |
| 18 | `ae.scanPropertyTree` | DFS dump of one layer's prop tree |
| 19 | `ae.inspectPropertyCapabilities` | what can be set on a property path |
| 20 | `ae.getExpressions` | read all expressions in a comp |
| 21 | `ae.getKeyframes` | keyframes for a property path |
| 22 | `ae.searchProject` | fuzzy search project items/layers/effects/expressions |
```

把后面诊断表的编号从 16/17 改为 23/24。

- [ ] **Step 2: 把 "Restart Claude Code. /mcp should list 15 verbs" 一行改为 24**

- [ ] **Step 3: 在 "Tests" 章节后插入 "Live tests" 小节**

```markdown
## Live tests

Opt-in end-to-end tests that drive a real AE instance.

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_BRIDGE_ROOT  = "E:/Code/AEBMethod"
python -m uv run pytest -m live_smoke      # 3-case canary, ~30s
python -m uv run pytest -m live            # full ~24 cases, ~2-3min
```

CI does not run live tests (hosted runners cannot drive a GUI Adobe app).
See `docs/REFERENCE.md#live-test-layer`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): v0.7 - 24 verbs + Live tests section"
```

---

### Task 6.3: 版本号 + 服务器端注册校验

**Files:**
- Modify: `pyproject.toml`
- Modify: `after_effects_mcp/server.py` (only if assert exists)

- [ ] **Step 1: bump version**

把 `pyproject.toml` 的 `version = "0.6.2"` 改为 `version = "0.7.0"`。

- [ ] **Step 2: 验证 server.py 注册了所有 24 个 verb**

Run: `python -m uv run python -c "from after_effects_mcp.handlers import load_all, HANDLERS; load_all(); print(len(HANDLERS), sorted(HANDLERS.keys()))"`
Expected: prints `24` and verb list shows all expected names. If <24, an `register()` call is missing in handlers/typed.py — investigate which one and add.

- [ ] **Step 3: 启动 server 一次烟测**

Run: `python -m uv run python -c "from after_effects_mcp import server; print('imports ok')"`
Expected: prints `imports ok`. No ImportError / circular import surprises.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "chore: bump version to 0.7.0"
```

---

### Task 6.4: 最终烟测

- [ ] **Step 1: 完整 unit 跑过**

Run: `python -m uv run pytest -m "not live and not live_smoke" -v`
Expected: 全绿，case 数从 baseline 73 升到约 100+（具体数视各 task 实际加了多少而定，但不应有 fail）。

- [ ] **Step 2: 验证 live smoke 在没有 AE 时正确 skip**

Run: `python -m uv run pytest -m live_smoke -v`
Expected: 全部 skipped，输出包含 "live tests are opt-in"。

- [ ] **Step 3: live 全套件本地真机跑（仅当 AE+插件已就绪）**

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_BRIDGE_ROOT  = "E:/Code/AEBMethod"
python -m uv run pytest -m live -v
```
Expected: 全绿。失败时检查 `tests/live/_artifacts/` 调查。

- [ ] **Step 4: Final commit (release-tag)**

```bash
git tag -a v0.7.0 -m "v0.7.0 — AtomMCP parity (B route): 24 verbs, real checkpoint/revert, live test layer"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Implemented in task |
|---|---|
| §4.1 ae.ping | 1.1, 1.2 |
| §4.2 ae.getProperties | 4.1 |
| §4.3 ae.scanPropertyTree | 4.2 |
| §4.4 ae.inspectPropertyCapabilities | 4.3 |
| §4.5 ae.getExpressions | 4.4 |
| §4.6 ae.getKeyframes | 4.5 |
| §4.7 ae.searchProject | 4.6 |
| §4.8 ae.checkpoint create/list (incl. untitled skip) | 3.2, 3.3, 3.4 |
| §4.9 ae.revert real (incl. branch_before_revert) | 3.5 |
| §4.10 ae.exec checkpoint_label activation | 3.6 |
| §5 file改动清单 | 全 task 覆盖 |
| §6 测试金字塔 (unit / store / live / live_smoke) | 0.1, 1.1-1.2, 3.1, 3.4-3.6, 4.x, 5.1, 5.2 |
| §7 风险 (untitled、scan 深度、size 上限、live flaky) | schema 默认值 + JSX max_results / max_depth + tests/live/_artifacts/ |
| §8 文档同步 | 6.1, 6.2 |
| §10 验收标准 #1 unit pass | 6.4 |
| §10 验收标准 #2 live pass | 6.4 |
| §10 验收标准 #3 /mcp 24 工具 | 6.3 |
| §10 验收标准 #5 checkpoint 真 cycle | 5.2 |

无 gap。

### 2. Placeholder scan

无 "TODO / TBD / 类似 Task N / fill in details"。每个 step 都有完整 code/command + expected output。

### 3. Type consistency

- 所有新 schema 类名 `AeXxxArgs` 与 `SCHEMAS` 字典 key 一对一。
- handler 命名 `_run_xxx` + `register("ae.xxx", ...)` 全数对齐。
- render 函数 `render_xxx` 与 `_run_xxx` 同名 stem。
- JSX 模板文件名 `xxx.jsx` 与 handler 通过 `_load_template("xxx.jsx")` 直接对应。
- `CheckpointStore` 公开方法 `make_id / aep_path / meta_path / write_meta / list_checkpoints / lookup_aep / prune` 在 task 3.4-3.6 调用方一致使用。
- spec §4.8 的元数据字段 (`id/label/ts/sourceProjectPath/activeCompId/currentTime/sizeBytes`) 与 `write_meta()` 的 kwargs (`source_project_path/cid/label/active_comp_id/current_time/size_bytes`) 通过 task 3.1 中 `write_meta` 内部构造统一映射。

无类型不一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-atommcp-parity.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 18-task plan like this where each task is well-bounded and the next subagent can re-read the file.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review. Saves subagent overhead but consumes this conversation's context across all 18 tasks.

Which approach?
