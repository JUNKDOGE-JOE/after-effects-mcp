# spec 3a: Backend 抽象 + 多后端 + OS-agnostic snapshot — 设计

**Date**: 2026-04-27
**Status**: Draft — pending user review
**Predecessor**: `after-effects-mcp` v0.7.0（24 verbs，但跟 AEBM 文件队列协议硬耦合，包名/版本号都从 AEBMethod 时代继承）
**Target**: `ae-mcp` 0.1.0（独立产品 fresh start——重命名 + 版本号重置 + 后端解耦 + OS 无关）

> **Post-implementation amendment (2026-04-27)**: spec originally proposed shipping
> two reference backends (`backend-aebm` + `backend-atom`). After implementation,
> the user decided `backend-atom` does not belong in this repo — `ae-mcp` is an
> independent product, and shipping a free integration for the closed-source
> Atom plugin would (a) effectively endorse a competitor, (b) impose protocol-
> drift maintenance on us, and (c) blur the "independent" positioning. `backend-
> atom/` was deleted. Only `backend-aebm` (which targets AEBMethod, the user's
> own plugin) remains as a reference impl in this monorepo. Anyone who wants
> Atom support can write/publish their own backend package.
**Related future specs**: spec 3b（多 client install 文档），spec 3c（PyPI 发布 + Backend Author Guide）

**Naming reset**: spec 3a 同时完成 PyPI 包名、Python 模块名、MCP server 名的"去 AEBM 化"工作（原计划 spec 3b 内容前移）。理由：版本号 0.7→0.1 在数字层面是降级，不重命名 PyPI 会让 pip 拒绝升级路径；既然要重命名，spec 3b 缩窄为"多 client install 文档"。

| 维度 | v0.7.0（旧） | 0.1.0（新） |
|---|---|---|
| PyPI 包名 | `after-effects-mcp` | `ae-mcp` |
| Python 模块名 | `after_effects_mcp` | `ae_mcp` |
| MCP server 名（`.mcp.json` 里） | `aebm` | `ae` |
| 仓库 git remote | `after-effects-mcp` | 不变（git 仓库名跟产品名解耦无所谓） |

---

## 1. 目标与非目标

### 1.1 目标

把 v0.7.0 的 MCP server 从"AEBM 文件队列协议绑定"重构为"插件无关、OS 无关的协议层"，让 Codex / Cursor / Claude Code / Continue 等任意 MCP 客户端通过任意 AE 桥接插件操作 AE。

具体交付：

- **核心包 `ae-mcp`** 不再 import 任何具体 backend 代码，不再读 `AE_BRIDGE_ROOT`，不再 spawn pwsh，不再触碰 `%TEMP%/aebm_bridge/`。
- **抽象 `Backend` ABC**（`packages/core/.../backends/base.py`）定义 6 个核心方法。
- **Entry-point 发现机制**：core 启动时通过 Python `importlib.metadata.entry_points()` 扫描 group `ae_mcp.backends`，列出已安装 backend，按 `AE_MCP_BACKEND` env var 选择。
- **两个 reference backend 包**（同仓库 monorepo，独立 pyproject）：
  - `ae-mcp-backend-aebm` — 适配 AEBMethod 文件队列（搬现有 bridge.py 重写为 Backend 实现）
  - `ae-mcp-backend-atom` — 适配 Atom MCP HTTP（直接 Python httpx，不再走 pwsh）
- **OS-agnostic snapshot 子系统**：抽象 `Snapshotter` ABC + 同样 entry-point 发现机制 + reference 实现 `ae-mcp-snapshot-mss`（基于 `mss`，Win/macOS/Linux 通用，取代 1995 风格 ctypes BitBlt）。
- **能力声明**：每个 backend 声明它支持哪些 verb；`tools/list` 自动按 active backend 过滤。
- **无 backend / 无 snapshot 子系统装载场景的友好降级**：core 单装可启动但每个 verb 调用返回 `{ok:false, error:"no backend installed"}`；`ae.snapshot` verb 在 snapshot 模块未装时从 `tools/list` 隐藏。
- **测试策略升级**：`mock_bridge` fixture 替换为 `MockBackend`；live test 双 backend 跑通（aebm-live + atom-live）。

### 1.2 非目标（明确不做）

| 项 | 不做的原因 |
|---|---|
| 改动 AEBMethod 插件仓库 | 这是 spec 3a 的硬约束——core 跟具体插件零代码耦合，AEBMethod 端无变化 |
| 实现第三方 plugin "WGC 高速截图" / "macOS CGWindowListCreateImage" / "Atom CEP 面板" | 留给 spec 3c+ 或第三方 |
| 从 PyPI 发布 | 留给 spec 3c |
| 重命名包 / 工具命名空间（去 AEBM 化） | 留给 spec 3b |
| 第三方 backend author guide 文档 | 留给 spec 3c |
| 删除 `bridge.py` 的兼容垫片 | 包名整体重命名（`after-effects-mcp`→`ae-mcp`），旧包 PyPI 冻结即历史记录，无需在新包内留 shim |

---

## 2. 仓库结构（monorepo）

```
after-effects-mcp/                  ← 当前仓库根，转 monorepo
├── pyproject.toml                  workspace 根（uv workspace 配置）
├── packages/
│   ├── core/
│   │   ├── pyproject.toml          name = "ae-mcp"
│   │   ├── ae_mcp/
│   │   │   ├── __init__.py
│   │   │   ├── __main__.py         entry: python -m ae_mcp
│   │   │   ├── server.py           tools/list / tools/call dispatcher
│   │   │   ├── schemas.py          24 个 pydantic 模型（不变）
│   │   │   ├── progress.py         heartbeat / timeout（不变）
│   │   │   ├── checkpoint_store.py FS 索引（不变；backend-agnostic）
│   │   │   ├── handlers/           24 个 handler（改用 Backend 接口调用）
│   │   │   ├── jsx_templates/      所有 JSX 模板（不变）
│   │   │   ├── backends/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── base.py         abstract Backend
│   │   │   │   ├── discovery.py    entry-point 扫描 + 选择
│   │   │   │   └── mock.py         单测专用 MockBackend
│   │   │   └── snapshot/
│   │   │       ├── __init__.py
│   │   │       ├── base.py         abstract Snapshotter
│   │   │       └── discovery.py    entry-point 扫描
│   │   └── tests/                  仅 core unit (mock backend + 文件系统测试)
│   ├── backend-aebm/
│   │   ├── pyproject.toml          name = "ae-mcp-backend-aebm"
│   │   │                            entry-points: ae_mcp.backends.aebm
│   │   ├── ae_mcp_backend_aebm/
│   │   │   └── __init__.py         AEBMBackend(Backend) — 搬 bridge.py 内容重写
│   │   └── tests/                  pwsh 编码 + 文件队列协议单测（mock subprocess）
│   ├── backend-atom/
│   │   ├── pyproject.toml          name = "ae-mcp-backend-atom"
│   │   │                            dependencies = ["httpx>=0.27"]
│   │   │                            entry-points: ae_mcp.backends.atom
│   │   ├── ae_mcp_backend_atom/
│   │   │   └── __init__.py         AtomBackend(Backend) — 新写 HTTP client
│   │   └── tests/                  HTTP handshake + session-id + stale-recovery 单测
│   └── snapshot-mss/
│       ├── pyproject.toml          name = "ae-mcp-snapshot-mss"
│       │                            dependencies = ["mss>=10.0"]
│       │                            entry-points: ae_mcp.snapshot.mss
│       ├── ae_mcp_snapshot_mss/
│       │   └── __init__.py         MssSnapshotter(Snapshotter) — mss + OS HWND→rect
│       └── tests/
└── docs/
    ├── REFERENCE.md                 改：协议 + Backend interface 描述（不再写"aebm-file"）
    └── superpowers/
        ├── specs/
        │   ├── 2026-04-27-atommcp-parity-design.md          (v0.7)
        │   └── 2026-04-27-spec-3a-backend-abstraction-design.md  (本文件)
        └── plans/
```

**Workspace 工具选择**：使用 `uv workspace`（`uv` 已在用），在根 `pyproject.toml` 写 `[tool.uv.workspace] members = ["packages/*"]`。开发期 `uv sync` 自动 link 4 个本地包到 venv，互相 import 直通。

---

## 3. Backend 抽象（base.py）

```python
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


class Backend(ABC):
    """Abstract bridge between MCP layer and a concrete AE plugin protocol.

    A backend is a separate pip package that registers itself via entry
    point group `ae_mcp.backends`. Core never imports any
    concrete backend module.
    """

    name: str  # e.g. "aebm", "atom" — used in AE_MCP_BACKEND env var

    # --- Capability hints (override in subclasses if backend handles these natively) ---
    manages_undo: bool = False         # if True, core skips its own beginUndoGroup wrapping
    manages_checkpoints: bool = False  # if True, core skips its checkpoint_create dance

    @abstractmethod
    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        """Run JSX code inside AE, return raw stdout text.

        This is the universal foundation. All other verbs are JSX templates
        rendered by core handlers and routed through this method.
        """

    @abstractmethod
    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        """Quick handshake: is this backend reachable right now?
        Called once at server startup; failure does NOT abort startup
        (server boots, individual tool calls return ok:false instead)."""

    def supported_verbs(self) -> Set[str]:
        """Default = all 24. Backends override to declare a subset.
        Verbs not in this set are filtered out of tools/list."""
        return ALL_VERBS

    @classmethod
    @abstractmethod
    def from_env(cls) -> "Backend":
        """Construct from this backend's own env vars.
        Examples (these env vars belong to backends, NOT to core):
          AEBMBackend.from_env reads AE_BRIDGE_ROOT
          AtomBackend.from_env reads ATOM_MCP_URL (default http://127.0.0.1:11487/mcp)
        Raises EnvironmentError with a clear message if required vars missing."""

    async def shutdown(self) -> None:
        """Best-effort cleanup on server shutdown. Default: no-op."""
        return None
```

**关键决策**：

- **接口最小化**——只有 `exec` 是必填，加 `health_check` + `from_env` 共 3 个抽象方法。`init / overview / layers` 这些当前在 `bridge.py` 暴露的"动词级"方法**不进 Backend 接口**——它们都退化为 core 渲染对应 JSX 模板 + `backend.exec()`。
- **不传 verb 名**——backend 不知道它在执行哪个 verb，只看见一坨 JSX。这保证 backend 实现简洁、易于 mock。
- **`exec` 仍接受 `undo_group` / `checkpoint_label` / `timeout_sec`**——这些是 ExtendScript 执行语义的一部分，跟 verb 无关。具体 backend 可以忽略不支持的字段（如 atom 内部已经自己处理 undo wrapping，可以无视 `undo_group`）。
- **`supported_verbs()` 默认返回全集**——绝大多数 backend 通过 JSX 实现所有 verb。极简 backend 可以缩到 `{"ae.exec"}` 一个。
- **`shutdown()` 是 hook 而非强制**——atom backend 需要它来 close httpx client；aebm 不需要。

---

## 4. Snapshot 抽象（snapshot/base.py）

```python
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional, Literal

CaptureMethod = Literal["auto"]  # 当前只暴露 "auto"；具体 backend 内部可有更多模式


class Snapshotter(ABC):
    """Capture AE viewer / main window pixels to a PNG file.

    Like Backend, snapshot implementations are separate pip packages
    discovered via entry point group `ae_mcp.snapshot`.
    Core's `ae.snapshot` verb is hidden from tools/list if no
    snapshotter is installed.
    """

    name: str  # e.g. "mss", "wgc", "macos-cg"

    @abstractmethod
    async def capture(
        self,
        out_path: Optional[Path],
        *,
        hwnd: Optional[str] = None,
        main_window: bool = False,
        method: CaptureMethod = "auto",
    ) -> dict:
        """Capture a PNG. Returns {ok, path, bytes, width, height, hwnd, method}.

        hwnd: explicit window handle (decimal or 0x-hex string). If None,
            the snapshotter auto-picks AE's viewer panel.
        main_window: if true, capture the whole AE main window instead.
        """

    @abstractmethod
    def supports_platform(self) -> bool:
        """Quick check: can this snapshotter run on the current OS?
        Called by discovery.py; if false, snapshotter is disqualified
        even if installed."""
```

`ae.snapshot` 在 core 的处理：

```python
# handlers/core.py 简化
async def _run_snapshot(args, ctx):
    snapshotter = snapshot.discovery.get_active_snapshotter()
    if snapshotter is None:
        return {"ok": False, "error": "no snapshotter installed (try `pip install ae-mcp-snapshot-mss`)"}
    return await snapshotter.capture(...)
```

`tools/list` 同时检查：active backend 的 `supported_verbs()` + 是否装了 snapshotter。两者中任一缺失，`ae.snapshot` 不暴露。

---

## 5. Discovery 机制（backends/discovery.py）

```python
import importlib.metadata
import os
from typing import Dict, Optional

from ae_mcp.backends.base import Backend

ENTRY_POINT_GROUP = "ae_mcp.backends"


def list_installed_backends() -> Dict[str, type[Backend]]:
    """Scan entry points, return {backend_name: backend_class}."""
    eps = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    return {ep.name: ep.load() for ep in eps}


def select_backend() -> Backend:
    """Choose and instantiate the active backend.

    Selection rules:
      1. AE_MCP_BACKEND env set → must match an installed backend; else error.
      2. AE_MCP_BACKEND unset, exactly one backend installed → use it.
      3. AE_MCP_BACKEND unset, multiple installed → error: "set AE_MCP_BACKEND".
      4. None installed → error with install hint.

    Errors raise BackendSelectionError; server.py catches it and starts
    in degraded mode where tools/call always returns ok:false.
    """
    installed = list_installed_backends()
    requested = os.environ.get("AE_MCP_BACKEND")

    if requested:
        if requested not in installed:
            raise BackendSelectionError(
                f"AE_MCP_BACKEND={requested!r} but no such backend installed. "
                f"Installed: {sorted(installed) or 'none'}. "
                f"Try `pip install ae-mcp-backend-{requested}` or check name."
            )
        return installed[requested].from_env()

    if not installed:
        raise BackendSelectionError(
            "no AE backend installed. Install one of:\n"
            "  pip install ae-mcp-backend-aebm    # for AEBMethod plugin\n"
            "  pip install ae-mcp-backend-atom    # for Atom plugin\n"
            "or write your own (see Backend Author Guide — TBD spec 3c)."
        )

    if len(installed) == 1:
        only = next(iter(installed.values()))
        return only.from_env()

    raise BackendSelectionError(
        f"multiple backends installed: {sorted(installed)}. "
        f"Set AE_MCP_BACKEND to choose."
    )


class BackendSelectionError(RuntimeError):
    pass
```

**Snapshot discovery 同结构**，entry-point group `ae_mcp.snapshot`，附加 `supports_platform()` 过滤。

---

## 6. Backend 实现要点

### 6.1 backend-aebm（搬迁现有 bridge.py）

- 把 `ae_mcp/bridge.py` 的全部内容（subprocess pwsh + AE_BRIDGE_ROOT 解析 + 文件队列等待）移到 `packages/backend-aebm/ae_mcp_backend_aebm/__init__.py`，包装成 `class AEBMBackend(Backend)`。
- 现有 `bridge.invoke_ae_init`、`invoke_ae_layers` 等动词级方法**删掉**——AEBM backend 只暴露 `exec(code, ...)`。所有动词通过 core 渲染 JSX 模板调过来。
  - 注：AEBMethod 插件原生支持的 `Invoke-AeInit / Invoke-AeOverview / Invoke-AeLayers` 这些动词，AEBMBackend 内部仍可路由到对应 pwsh 调用以利用插件已有优化路径——但这是**实现细节**，不暴露给 core。具体做法：在 backend 内部根据 JSX 模板的"模板名"标记决定走哪条路径。**或者**简化为全部走 `Invoke-AeExec`，放弃微优化。本 spec 推荐后者：YAGNI，等实测有性能差距再优化。
- `from_env()` 读 `AE_BRIDGE_ROOT`，找不到/路径无效时 raise `EnvironmentError`，明确指引"set AE_BRIDGE_ROOT to your AEBMethod plugin checkout"。
- `name = "aebm"`。
- 入口注册（pyproject.toml）：

  ```toml
  [project.entry-points."ae_mcp.backends"]
  aebm = "ae_mcp_backend_aebm:AEBMBackend"
  ```

### 6.2 backend-atom（新写 HTTP client）

- 依赖：`httpx>=0.27`、`aiohttp` 不用（避免双 HTTP lib）。
- 完整实现 Atom MCP Streamable HTTP 协议三步握手 + `Mcp-Session-Id` header 三种大小写处理 + stale session 自动重连。**所有协议细节文档在 `E:/Code/AEBMethod/docs/development/ATOM_INTEGRATION.md`，照着写**。
- `from_env()` 读 `ATOM_MCP_URL`（默认 `http://127.0.0.1:11487/mcp`）和可选 `ATOM_MCP_TIMEOUT`。
- `health_check()` 发一个 `tools/list` 请求验证。
- `name = "atom"`。
- **关键**：Atom 内部已经自动 wrap undo group + 自动创建 checkpoint。Backend 接到 `exec(code, undo_group=...)` 时**忽略** `undo_group`（Atom 自己 wrap）；接到 `checkpoint_label` 时也忽略（Atom 自己 checkpoint）。core 的 `ae.exec` 在 atom backend 下不应再走"先 checkpoint create → 再 exec"路径，直接 exec 即可。这是 backend-specific 行为差异——**用 Backend 的 capability hint** 表达：

  ```python
  class Backend(ABC):
      manages_undo: bool = False         # default
      manages_checkpoints: bool = False  # default

  class AtomBackend(Backend):
      manages_undo = True
      manages_checkpoints = True
  ```

  core 的 handler 在调 `backend.exec` 前检查这两个标志，决定是否自己再加 undo wrap / checkpoint create。

### 6.3 snapshot-mss

- 依赖 `mss>=10.0`。
- `MssSnapshotter`：
  - `supports_platform()` 永远 True（mss 自身跨平台）
  - `capture(out_path, hwnd, main_window, method)`：
    - 把 hwnd → rect 翻译封装成内部小函数（Win 用 `ctypes` GetWindowRect，macOS 用 `Quartz.CGWindowListCopyWindowInfo`，Linux 用 `subprocess xdotool`）
    - mss 抓 rect → PNG → 写文件
- `name = "mss"`。

---

## 7. Core handler 改造

每个 handler 当前都是：

```python
async def _run_layers(args, ctx):
    out = await bridge.invoke_ae_layers(comp_id=args.comp_id)
    return _try_json(out)
```

改造后：

```python
async def _run_layers(args, ctx):
    backend = backends.discovery.get_active_backend()
    jsx = _load_template("get_layers.jsx").substitute(
        comp_expr=_comp_expr(args.comp_id)
    )
    out = await backend.exec(jsx, timeout_sec=20.0)
    return _try_json(out)
```

需要做的事：

1. 把 `bridge.invoke_ae_init`、`invoke_ae_overview`、`invoke_ae_layers` 三个原本是 pwsh 动词的调用，改为 core 这边的 JSX 模板（创建 `jsx_templates/init.jsx`、`overview.jsx`、`get_layers.jsx`）。模板内容直接照抄 AEBMethod 的 `backend_aebm_file.ps1` 里那段 ExtendScript 文本即可。
2. 6 个 typed read verb（getProperties 等）已经走 JSX → exec 路径，只需把 `bridge.invoke_ae_exec` 改成 `backend.exec` 就行。
3. checkpoint / revert 已经 JSX 化；同样替换。
4. snapshot 走自己的 snapshot 子系统，不走 backend。

---

## 8. server.py / `tools/list` 过滤

```python
def list_tools() -> list[Tool]:
    backend = get_active_backend()
    snap = get_active_snapshotter()
    tools = []
    for verb_name in ALL_VERBS:
        if verb_name not in backend.supported_verbs():
            continue
        if verb_name == "ae.snapshot" and snap is None:
            continue
        tools.append(_build_tool(verb_name))
    return tools
```

启动时一次缓存（active backend 不会运行时切换）。

---

## 9. 测试策略

```
packages/
├── core/tests/
│   ├── conftest.py            mock_backend fixture (替代旧 mock_bridge)
│   ├── test_handlers_*.py     用 mock_backend
│   ├── test_schemas.py        不变
│   ├── test_checkpoint_store.py 不变（FS）
│   ├── test_discovery.py      新增：entry-point 加载、env var 解析、错误路径
│   └── live/
│       └── test_*.py          opt-in：在 AE_MCP_BACKEND=<active> 下跑
├── backend-aebm/tests/
│   └── test_aebm_protocol.py  pwsh 编码 + 文件队列协议（mock subprocess）
├── backend-atom/tests/
│   └── test_atom_http.py      HTTP handshake / session-id / stale-recovery（用 httpx MockTransport）
└── snapshot-mss/tests/
    └── test_mss_snapshot.py   mss API 调用 + HWND→rect 翻译
```

CI 矩阵：
- core unit + 3 个 backend/snapshot 单测：always
- live (aebm + atom)：opt-in，需对应插件运行的实机

`AE_MCP_BACKEND` 在 live 测试里是必填——没有"默认 backend"概念，每次 live 跑必须显式选。

---

## 10. 配置 UX

### 10.1 用户安装

```bash
# 必装
pip install ae-mcp

# 选一个或多个 backend
pip install ae-mcp-backend-aebm     # 用 AEBMethod 插件
pip install ae-mcp-backend-atom     # 用 Atom 插件

# 选一个 snapshot 实现（可选，不装则 ae.snapshot 不可用）
pip install ae-mcp-snapshot-mss     # 跨平台
```

### 10.2 MCP 客户端配置（`.mcp.json` 模板，新版）

```json
{
  "mcpServers": {
    "ae": {
      "command": "python",
      "args": ["-m", "ae_mcp"],
      "env": {
        "AE_MCP_BACKEND": "atom",
        "ATOM_MCP_URL": "http://127.0.0.1:11487/mcp"
      }
    }
  }
}
```

模板里**不出现** `AE_BRIDGE_ROOT`、不出现 `aebm`、不出现 `AEBMethod`。

### 10.3 `after-effects-mcp` v0.7 → `ae-mcp` 0.1 迁移指引

README 顶部加 BREAKING CHANGE banner：

> **Renamed and rebooted**: This project was previously published as
> `after-effects-mcp` (v0.7 and earlier). It has been renamed to `ae-mcp`
> and reset to **0.1.0** as part of becoming a standalone, plugin-agnostic
> product. The old `after-effects-mcp` package is frozen on PyPI; please
> migrate. See MIGRATION.md.

短迁移文档 `MIGRATION.md`（~1 page）：

```powershell
# 1) Uninstall the old package
pip uninstall after-effects-mcp

# 2) Install the new core + at least one backend
pip install ae-mcp ae-mcp-backend-aebm   # or ae-mcp-backend-atom
pip install ae-mcp-snapshot-mss          # optional: enables ae.snapshot

# 3) Update your .mcp.json:
#    - server key:    "aebm" -> "ae"
#    - command/args:  python -m after_effects_mcp -> python -m ae_mcp
#    - env:           AE_BRIDGE_ROOT=...  -> AE_MCP_BACKEND=aebm + AE_BRIDGE_ROOT=...
```

---

## 11. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Atom HTTP 协议比文档复杂（如 SSE 流式响应在 tools/call 时启用） | 中 | atom backend 实现卡壳 | ATOM_INTEGRATION.md 已踩过坑；spec 期不补足时 fallback 到 atom 仅支持 `ae.exec`（缩窄 supported_verbs），后续迭代 |
| `mss` 在 macOS 上抓特定 HWND（其实是 `windowID`）API 不直接 | 中 | macOS snapshot 不能精确抓 viewer 子面板 | macOS 先实现"main_window=true"模式抓整窗，子面板留 spec 3c+ |
| uv workspace 在 Windows + 中文路径 + 嵌套 venv 下罕见 bug | 低 | 开发期 sync 失败 | 用 `python -m uv` 调用避免 PATH 问题（同 v0.7） |
| 现有 `after-effects-mcp` v0.7 用户错过 rename 通知 | 中 | 升级阻力 / 用户停在旧版 | (a) MIGRATION.md + README banner；(b) 旧 PyPI `after-effects-mcp` 上架最后一个版本 v0.7.99，README 改成"已迁移至 `ae-mcp`，停止更新"；(c) 旧仓库 git README 同步指向新包 |
| Backend 可以乱写、不遵守 ABC 契约 | 中 | 第三方 backend 行为不一致 | 提供 `BackendComplianceTestSuite` 让 backend 作者自测；spec 3c 配合发布 |

---

## 12. 工程量（修订）

| 块 | 工作量 |
|---|---|
| Monorepo 转换（uv workspace 配置 + 现有代码 split 到 packages/core/） | 0.5d |
| Backend ABC + discovery + MockBackend + 错误路径 | 0.5d |
| Snapshot ABC + discovery + 隐藏机制 | 0.25d |
| Core handlers 全部改用 backend.exec + 新增 init/overview/layers JSX 模板 | 1d |
| backend-aebm 包（搬迁 bridge.py 重写） | 0.75d |
| backend-atom 包（新写 HTTP client + 测试） | 1.5d |
| snapshot-mss 包（mss + 跨平台 HWND→rect） | 1d |
| `manages_undo` / `manages_checkpoints` 在 handler 里的分支处理 | 0.25d |
| Live test 双 backend 跑通 | 0.5d |
| 文档（REFERENCE.md 改、MIGRATION.md 新建、.mcp.json.template 改） | 0.5d |
| **合计** | **~6.75 工作日** |

---

## 13. 验收标准

1. ✅ `pip install ae-mcp` 单装，启动 server，调任意 verb 返回 `{ok:false, error:"no AE backend installed..."}`，进程不死。
2. ✅ `pip install ae-mcp ae-mcp-backend-aebm`，设 `AE_BRIDGE_ROOT` + `AE_MCP_BACKEND=aebm`，对接 AEBMethod 实机，全 24 verb live 测试通过。
3. ✅ 切到 `AE_MCP_BACKEND=atom` + Atom 插件，**同一套 24 verb live 测试通过**（`ae.checkpoint`/`ae.revert` 因 Atom 内置可能跳过本地 store——这是预期行为）。
4. ✅ `tools/list` 在仅装 atom backend、不装 snapshot-mss 时返回 23 个 verb（`ae.snapshot` 隐藏）。
5. ✅ macOS 上 `pip install` core + atom + snapshot-mss 能装、能跑 atom backend、能抓 main window 截图。
6. ✅ core/tests 117 个 unit 全绿；3 个 sub-package 各自 unit 全绿。
7. ✅ core 包 grep 找不到任何 `aebm`/`atom`/`AE_BRIDGE_ROOT`/`mss`/`BitBlt` 字符串（除非在跨引用文档注释里）。

---

## 14. 决策记录

| 议题 | 选项 | 选择 | 理由 |
|---|---|---|---|
| spec 3 范围 | 大 spec / 拆 3a/3b/3c | 拆 3a | 单 PR 可发布；3b/3c 不阻塞 |
| Backend 实现位置 | core 内置 / 独立包 | 独立包，core 完全不知 | 用户 hard 约束："零耦合，独立产品" |
| 仓库结构 | monorepo / multi-repo | monorepo (A) | 接口期同步改方便；后续可拆 |
| 抽象层 backend 接口大小 | 多动词级方法 / 单 exec | 单 exec + capability hints | YAGNI；JSX 模板已统一所有 verb |
| Backend 选择策略 | autodetect / 显式 env | 显式 env (单装时退化为 auto) | 避免隐式错配 |
| Snapshot 是否抽象 | 留 core / 也抽象 | 也抽象 | OS-agnostic 要求；mss 替代 ctypes BitBlt |
| 现代截图库 | ctypes BitBlt / mss / WGC | mss | 跨平台 + 现代 API + 0 配置；WGC 留待性能瓶颈再上 |
| `init/overview/layers` | backend 直接动词 / core 渲染 JSX | core 渲染 JSX | backend 接口最小化；JSX 模板照抄 AEBMethod ps1 即可 |
| AEBMBackend 是否复用 pwsh `Invoke-AeInit` 等优化路径 | 是 / 否 | 否（YAGNI） | 全走 Invoke-AeExec 简单；性能不够再优化 |
| Atom 的 undo / checkpoint 双计 | 全交给 backend / 加 capability flags | capability flags (`manages_undo` / `manages_checkpoints`) | 显式契约 > 隐式假定 |
| 向后兼容 | 留 bridge.py shim / 干净切割 | 干净切割（rename + reset） | 保 shim 长期负担；MIGRATION.md 解决迁移 |
| 版本号 | 跟 AEBM sprint 继续 0.7→0.8 / 重置 1.0 / 重置 0.1 / CalVer | 重置 0.1.0 | 用户决策："独立产品 fresh start，pre-1.0 阶段"；承认 backend ABC 还可能再 breaking 再到 1.0 |
| 包名 | 保留 `after-effects-mcp` / 改 `ae-mcp` / 其他 | `ae-mcp` | 0.1<0.7 在 pip 视角是降级，必须改名；同时 PyPI/Python 模块/server 名一起重置，避免半半拉拉 |

---

**文档结束**。本文档应在动手实现前由用户 review；review 通过后调用 writing-plans 技能产出实施计划。
