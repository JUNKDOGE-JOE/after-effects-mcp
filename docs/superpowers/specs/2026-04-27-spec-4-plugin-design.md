# spec 4 — ae-mcp 插件设计（CEP + ExtendScript 混合栈，HTTP 协议，Atom 功能对等）

**Date**: 2026-04-27
**Status**: Draft — pending user review
**Goal**: 设计并实现 ae-mcp 产品的 AE 插件半边，让 ae-mcp + 这个插件一起达成 Atom 在 AE 上的全部能力。

---

## 1. 北极星

end-user 装一样东西（一个 .zxp 包），打开 AE，他的 Codex / Cursor / Claude Code 就能驱动 AE 完成 Atom 能完成的所有任务。

具体：
- 单一装包：`ae-mcp.zxp` 含 CEP 面板 + 内嵌 Node.js 后端
- 面板加载即起 HTTP 服务（默认 `127.0.0.1:11488`）
- ae-mcp Python MCP server 作为 stdio MCP 端点；MCP 客户端调它，它走 HTTP 调插件，插件走 ExtendScript 调 AE
- 验收标准：所有能在 Atom 里做的 AE 操作（13 个核心工具），在 ae-mcp 里都能做到

---

## 2. Atom 功能对照（MVP scope）

Atom 18 个 tool。按"对 AE 的操作"切：

| Atom tool | 类别 | MVP 收 / 砍 | 对应 ae-mcp verb |
|---|---|---|---|
| `initialize_session` | AE 状态 | 收 | `ae.init` ✓（已实现） |
| `project_overview` | AE 状态 | 收 | `ae.overview` ✓ |
| `list_layers` | AE 状态 | 收 | `ae.layers` ✓ |
| `get_properties` | AE 读 | 收 | `ae.getProperties` ✓ |
| `scan_property_tree` | AE 读 | 收 | `ae.scanPropertyTree` ✓ |
| `inspect_property_capabilities` | AE 读 | 收 | `ae.inspectPropertyCapabilities` ✓ |
| `get_expressions` | AE 读 | 收 | `ae.getExpressions` ✓ |
| `get_keyframes` | AE 读 | 收 | `ae.getKeyframes` ✓ |
| `search_project` | AE 读 | 收 | `ae.searchProject` ✓ |
| `run_extendscript` | AE 写 | 收 | `ae.exec` ✓ |
| `list_checkpoints` | AE 状态 | 收 | `ae.checkpoint(action="list")` ✓ |
| `revert_checkpoint` | AE 写 | 收 | `ae.revert` ✓ |
| `preview_frames` | AE 读 | 收（升级 `ae.snapshot`） | `ae.snapshot` ⚠ 需重做 |
| `create_skill` / `edit_skill` / `use_skill` | 本地存储 + LLM prompt 模板 | **收**（用户要求"所有"） | 新增 `ae.skillCreate / skillList / skillEdit / skillUse` |
| `generate_image` | OpenRouter API 调用 + 项目导入 | **收** | 新增 `ae.generateImage` |
| `create_rig` | FFX preset 生成 + 应用 | **收** | 新增 `ae.createRig` |

### 2.1 已实现（22 verb）

ae-mcp 当前的 22 verb 覆盖了 Atom 的前 12 个核心 + 多了一些 typed mutation 便利（createLayer / setProperty / moveLayer / selectLayers / setTime / getTime / applyEffect）+ ping。

### 2.2 需要新增（5 verb）

1. **`ae.previewFrame`** — 渲染单帧/多帧 PNG，**通过插件内 AE 渲染管线**（不是 Win32 BitBlt 截屏）。Atom 的 `preview_frames` 用 `RQItem` API 走真实合成，能拿到 alpha、对的 colorspace、能离屏渲。`ae.snapshot`（mss 桌面截屏）保留作为 diagnostic，但 `ae.previewFrame` 是产品级渲染。
2. **`ae.skillCreate / skillList / skillEdit / skillDelete / skillUse`** — Atom 的 skill 是"可复用 prompt + JSX 片段包"，本地 JSON 存储，无云。我们做一样：本地 `~/.ae-mcp/skills/<name>.json`。`skillUse(name, args)` = 渲染 skill 的 prompt 模板把 args 填进去 → 返回给调用方（agent 拿到字符串后自己决定怎么用）。**这 5 个动词不直接操作 AE**，只是产品的元能力，但用户要"完整对标 Atom"所以收。
3. **`ae.generateImage`** — POST 到 OpenRouter（或可配置的 provider）image-gen 接口，下载 PNG，导入到 AE 项目面板的 "ae-mcp" 文件夹。需要插件配合（导入是 ExtendScript 操作）。**用户要自己提供 API key**（环境变量 `AE_MCP_OPENROUTER_KEY`）。
4. **`ae.createRig`** — 接 FFX 配方（rig 类型 + 目标 layer），在插件内生成 FFX 文件 + 应用到 layer。Atom 这块比较取巧用了"伪 effect 控件"+ expression 链，复刻不算特别难但要懂 FFX 二进制格式。**这个我打 question mark：MVP 真的要吗？**

### 2.3 提议：MVP 收紧

**强烈建议 MVP 砍掉 generateImage 和 createRig**——这两个是 Atom 自己的特色而非"AE 操作"：

- `generateImage` 本质是"调外部 LLM API 然后用 AE 导入"。导入部分（ExtendScript）我们已经能通过 `ae.exec` 实现；调 LLM 是 agent 自己的事，agent 直接调 OpenRouter / Anthropic 然后用 `ae.exec` 导入即可，不需要我们封装。
- `createRig` 是 Atom 特定的 rig 工程经验，复杂度高、维护负担大、用户面窄。

**MVP 真的要"完整对标 Atom 在 AE 的操作"**——`generateImage` 和 `createRig` 算不算"AE 操作"？我个人判定**不算**：generateImage 主要是 API 调用，AE 端只是 import；createRig 是 Atom 独家的 rig 设计经验，跟"AE 能力对等"无关。

Skill 系统也类似——它是 Atom 的产品 UX 而非 AE 操作。但收它技术上不重，且能凑齐"对标"叙事，可以做。

**建议 MVP scope（14 verb 增量）**：
- ✅ 已实现 22 verb 全保留
- ✅ 新增 `ae.previewFrame`（核心新增）
- ✅ 新增 5 个 skill 动词（轻量，纯本地 JSON）
- ❌ 砍 `ae.generateImage`（agent 自己调 LLM API + 我们的 `ae.exec` 导入）
- ❌ 砍 `ae.createRig`（FFX 复刻投入产出比低）

**最终 verb 数：22 → 28**。如果你确定"所有"必收，告诉我，我把砍掉的也加回来。

---

## 3. 技术栈：CEP + ExtendScript 混合

### 3.1 CEP 面板组成

```
ae-mcp.zxp (CEP extension package)
├── CSXS/manifest.xml              CEP extension manifest
├── client/                        前端（用户能看到的面板 UI）
│   ├── index.html                 面板 HTML（极简：状态指示灯 + 端口号 + 启停按钮）
│   ├── client.js                  HTML 端 JS（CSInterface bridge to host）
│   └── styles.css                 dark theme，匹配 AE
├── host/                          Node.js 后端（CEP runtime 内）
│   ├── server.js                  起 HTTP server、路由请求
│   ├── jsx-bridge.js              通过 CSInterface.evalScript 把 JSX 投到 AE
│   ├── skills.js                  本地 skill 存储/读取
│   └── package.json               (mcp 协议库 / express / ws)
├── jsx/                           ExtendScript 资源（被 host 加载到 AE）
│   ├── runtime.jsx                运行时辅助函数（JSON polyfill for old engines, 错误捕获包装等）
│   ├── checkpoint.jsx             checkpoint 创建/恢复
│   └── preview-frame.jsx          通过 RQItem 渲染单帧
└── icons/                         面板图标（SVG）
```

**CEP 面板自动加载**：用户在 AE 菜单 `Window → Extensions → ae-mcp` 打开。面板加载时 `index.html` 启动 `client.js`，它 spawn `host/server.js`（Node.js 进程，CEP runtime 内）。HTTP server 起在 `127.0.0.1:11488`（可配）。面板 UI 显示绿灯 = healthy。

**为什么混合栈**：
- HTTP server / 路由 / JSON 协议处理 → Node.js 写起来比 ExtendScript 强 100 倍
- Skill 系统 / 文件 IO / 配置存储 → Node.js
- 直接调 AE API（layer / property / project ops）→ ExtendScript，必要、无替代
- 面板 UI（小，仅状态显示）→ HTML+CSS

### 3.2 协议：HTTP，模仿 Atom

ae-mcp 这边的 Python `Backend.exec(code)` 实现要写一个新的 `ae-mcp-bridge-http`（不叫 backend-aebm 了，跟 AEBMethod 一刀两断）：

```python
class HttpBridge(Backend):
    name = "ae-mcp"  # 我们自己的 name；不再叫 aebm
    
    @classmethod
    def from_env(cls):
        url = os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488")
        return cls(url=url)
    
    async def exec(self, code, *, undo_group=None, checkpoint_label=None, timeout_sec=30.0):
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{self.url}/exec",
                json={
                    "code": code,
                    "undoGroup": undo_group,
                    "checkpointLabel": checkpoint_label,
                    "timeoutMs": int(timeout_sec * 1000),
                },
                timeout=timeout_sec + 5.0,
            )
            r.raise_for_status()
            data = r.json()
            return data.get("result", "")
```

**HTTP API 表面**（插件这边实现的）：

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/health` | 返回 `{ok: true, aeVersion, pluginVersion, hasActiveProject}` |
| `POST` | `/exec` | 执行 JSX，返回结果 |
| `POST` | `/preview-frame` | 渲染指定 comp 的指定时刻为 PNG，返回 base64 或文件路径 |
| `GET` | `/skills` | 列 skill |
| `POST` | `/skills` | 创建/更新 skill |
| `DELETE` | `/skills/<name>` | 删 skill |

**为什么不用 MCP-over-HTTP（Atom 那种）**：
- ae-mcp 已经有完整的 Python MCP server（22 verb 的 schema/handler/JSX 模板都写好了）
- 重复套一层 MCP 协议没意义；HTTP 简单 RPC 即可
- 长期如果要做"插件直连 MCP 客户端、不经 Python 中转"，可以再加一层 MCP HTTP transport，但那是后话

### 3.3 协议安全

- 仅绑 127.0.0.1，不监听公网
- 无 auth header（同 Atom），靠 loopback 隔离
- 端口冲突：默认 11488，可被环境变量 `AE_MCP_PLUGIN_PORT` / 面板 UI 改写

---

## 4. ae-mcp Python 端的对应改动

### 4.1 新增 packages/bridge-http/

监听这个 spec 决议后产生：

```
packages/bridge-http/
├── pyproject.toml      name = "ae-mcp-bridge-http"
│                        entry-points: ae_mcp.backends.ae_mcp = "ae_mcp_bridge_http:HttpBridge"
├── ae_mcp_bridge_http/
│   └── __init__.py     HttpBridge(Backend) 实现，~100 行
└── tests/
    └── test_http_bridge.py   用 respx mock HTTP 验证
```

注意**包名 = `ae-mcp-bridge-http`**，**backend 注册名 = `ae-mcp`**（不再叫 `aebm`）。`AE_MCP_BACKEND=ae-mcp` 选择它。

### 4.2 ae.previewFrame 新增

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `comp_id` | str | 否 | 默认 active comp |
| `time` | float | 否 | 默认当前时间 |
| `width` | int | 否 | 默认 comp 宽 |
| `height` | int | 否 | 默认 comp 高 |
| `out_path` | str | 否 | 默认 `%TEMP%/ae_mcp_previews/<ts>.png` |

handler 不通过 `Backend.exec(jsx)` 走，直接调 `bridge.preview_frame(...)` 经 HTTP `/preview-frame` endpoint。需要扩展 Backend ABC 加一个可选 `preview_frame()` 方法，子类不实现就 raise NotImplementedError。

或者简化：保持 `Backend.exec(jsx)` 单一入口，让 plugin 端的 `preview-frame.jsx` 通过 RenderQueue API 渲染并返回 base64。这样 Backend 接口不动。**推荐这个**。

### 4.3 ae.skill* 新增

5 个 verb：`skillCreate / skillList / skillGet / skillUpdate / skillDelete / skillUse`。

存储：`~/.ae-mcp/skills/<name>.json`。每个 skill 内容：

```json
{
  "name": "wiggle-position",
  "description": "Add wiggle expression to selected layer's Position",
  "jsx_template": "(function(){var l=app.project.activeItem.selectedLayers[0]; l.property('Position').expression='wiggle($freq, $amp)'; return JSON.stringify({ok:true});})()",
  "args_schema": {"freq": {"type":"number","default":2}, "amp": {"type":"number","default":30}}
}
```

`ae.skillUse(name, args)` 渲染 jsx_template 把 args 填进去，调 `Backend.exec(rendered_jsx)` 执行。本质是 server-side 模板缓存。

实现位置：core 层（不依赖 plugin 实现，纯 Python + 文件 IO）。

---

## 5. 工程量估算

| 块 | 工作量 |
|---|---|
| CEP 面板脚手架（manifest, html, css, csinterface 接线） | 1d |
| Node.js host server（HTTP, routing, jsx-bridge via CSInterface, error wrapping） | 2d |
| `runtime.jsx` + `checkpoint.jsx` + `preview-frame.jsx` ExtendScript 资源 | 1.5d |
| Skill 存储 / CRUD（host 端 Node.js + core 端 Python verb） | 1d |
| `packages/bridge-http/` Python 包（HttpBridge + entry point + 测试） | 0.75d |
| `ae.previewFrame` verb（schema + handler + JSX template） | 0.5d |
| `ae.skill*` verb 5 个（schema + handler，不依赖 plugin） | 1d |
| 打包：`ZXP` 签名 + 安装脚本 + dev 模式（CEP debug enable）| 1d |
| 端到端 live test 重写（用新 plugin 而非旧 AEBMethod 假设） | 1.5d |
| 文档：README + REFERENCE 重写 + 用户安装指南 | 1d |
| **合计** | **~11.25 工作日** |

---

## 6. 阶段拆分建议

如果不想一口气吃 11 天，可以拆成 4 个 sub-spec：

- **spec 4a**：CEP 面板 hello-world + Node.js HTTP server + 单一 `/exec` endpoint + Python `HttpBridge` + 跑通 `ae.ping` live → ~3 工作日
- **spec 4b**：剩余 12 个 AE-driving verb 全部经新 plugin 跑通（live verification）→ ~2 工作日
- **spec 4c**：`ae.previewFrame` + checkpoint/revert 的 plugin-side 实现 → ~2 工作日
- **spec 4d**：Skill 系统 + ZXP 打包 + 安装文档 → ~2 工作日

每个 sub-spec 独立可发布。spec 4a 完成时**已经是个"自建插件 + ae-mcp 真能驱动 AE"的可见 milestone**，可以 demo。

---

## 7. 现状清算 + 兼容

### 7.1 整体路径

```
当前：ae-mcp 22 verb（unit pass，无 backend，无插件）
   │
   ▼
spec 4a：+ CEP 面板 + Node.js host + Python HttpBridge + ae.ping live 通
   │  → 此时 ae-mcp 第一次真正能驱动 AE，但只有 ping 在端到端意义上验证过
   ▼
spec 4b：剩 12 个 AE-driving verb 在新 plugin 上 live 跑通
   │  → ae-mcp v0.2 release：Atom 核心 13 工具对等
   ▼
spec 4c：previewFrame + checkpoint 真插件实现
   │  → ae-mcp v0.3
   ▼
spec 4d：Skill + ZXP + 安装包
   │  → ae-mcp v0.4 / 1.0：可分发的完整产品
```

### 7.2 v0.1.0 tag 处理

当前的 `v0.1.0` 标记的是"协议层 + 单测 完成"，没插件。建议改名 `v0.1.0-protocol-only`，把"v0.1.0"的语义留给"第一次端到端能用"——也就是 spec 4a 完成时。

### 7.3 旧的 backend-aebm 和 AEBMethod

**完全不复用任何东西**。新插件从零写。AEBMethod 跟 ae-mcp 永远独立。归档目录里的 backend-aebm 代码扔着不动（万一你后面想看 pwsh+file-queue 的实现细节作参考还能看）。

---

## 8. 决策点（请确认 / 修改）

| # | 议题 | 我的提议 | 你定 |
|---|---|---|---|
| 1 | MVP 是否含 `generateImage` / `createRig` | 砍掉（不算 AE 操作） | ? |
| 2 | MVP 是否含 skill 系统 | 收（轻量） | ? |
| 3 | `ae.previewFrame` vs 升级 `ae.snapshot` | 新增 `previewFrame`（保留 snapshot 作 diagnostic） | ? |
| 4 | HTTP 协议是 MCP-over-HTTP 还是简单 RPC | 简单 RPC | ? |
| 5 | 端口默认值 | 11488（避开 Atom 11487） | ? |
| 6 | 阶段拆分 | 4a/4b/4c/4d，每段独立发布 | ? |
| 7 | v0.1.0 tag 处理 | 重命名为 `v0.1.0-protocol-only` | ? |
| 8 | bridge 包名 | `ae-mcp-bridge-http`（backend 注册名 `ae-mcp`） | ? |

---

**spec 结束**。请你逐一回应决策点 1-8，或者直接说"按你的提议跑"。我等确认后写 spec 4a 的实施计划。
