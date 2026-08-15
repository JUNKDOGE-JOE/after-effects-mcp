# ae-mcp ↔ Atom 对标：现状与去向

> **本文件只回答一件事：竞品有什么、我们对应怎么处置。**
> 架构方向、阶段划分与退出条件在 [ARCHITECTURE_DIRECTION.md](ARCHITECTURE_DIRECTION.md)，本文件不重复。
>
> 上一版停在 v0.7.0（写着 31 个 `ae_` 工具、Python stdio 链路、三条 backend），与现状和已批方向都不符，已整体替换。

**对标基准**：`atom-ae 3.5.4 windows-x64`（2026-08-12 构建），ZXP 静态拆解，未运行该扩展。

---

## 1. 现状（2026-08-15）

```text
外部 MCP 客户端 ─┐
                 ├→ packages/core（Python stdio MCP server，16 个公开工具）
面板 spawn agent ─┘      → packages/bridge（httpx）
                         → CEP 面板 Node host（Express，127.0.0.1:11488）  ← 环在这里闭合
                         → CSInterface.evalScript
                         → ExtendScript（plugin/jsx/runtime.jsx + jsx_templates/*.jsx）
                         → 或 /native/invoke → AeMcpNative.aex（23 个 primitive）
```

5 进程、3 条执行平面。面板产品层（内置聊天、审批、向导、诊断、activity、kill switch）已交付。

**公开工具 16 个**（`packages/core/ae_mcp/handlers/__init__.py:16-35`）：
`ae.checkpoint` `ae.diagnose` `ae.exec` `ae.nativeExec` `ae.ping` `ae.previewFrame` `ae.revert` `ae.skillList` `ae.skillUse` `ae.snapshot` `ae.status` `ae.toolIndex` `ae.toolInspect` `ae.toolSearch` `ae.toolUse` `ae.validateExpressions`

---

## 2. 逐项对标

### 2.1 我们已经做到或做得更好

| 项 | 我们 | Atom | 说明 |
|---|---|---|---|
| 整份 `.aep` checkpoint | `ae.checkpoint` / `ae.revert`，`checkpoint_store.py` 按**解析后工程路径**做 key 存 `%TEMP%`，prune 50 | 存在用户工程目录旁的 `_atom_checkpoints/` | 我们的路径 key 修过同名工程碰撞（#10）；不落工程目录也不会进用户的 git 和交付包 |
| revert 安全性 | 关闭不存盘 → Python 侧原子替换（临时文件 + `os.replace`）→ 重开；每步都有失败分支，替换失败会尝试重开原件并报 `recoveredOriginal` | 关闭不存盘 → `File.copy` 覆盖 → 重开；可选 branch 备份 | 我们的原子性更强 |
| revert 前备份 | `_branch_snapshot()` | `branchBeforeRevert` 选项 | 等价 |
| 渲染真帧而非截屏 | `ae.previewFrame` 已调 `comp.saveFrameToPng()` | 同 | **已达成**，不是待办 |
| 单一写动词 | `ae.exec`（任意 JSX） | `run_extendscript` | 等价 |
| 共享 ExtendScript prelude | `plugin/jsx/runtime.jsx`（371 行，CSXS ScriptPath 载入） | `Main.jsx` 运行时 `eval` 加载各模块 | 等价；Atom 的运行时加载在改 JSX 后无需重启 AE，值得借鉴 |
| 外部 MCP 客户端 | 一等支持：Claude Desktop / Claude Code / Cursor / OpenCode / OpenClaw / AstrBot 等 | 有 Connector 模式，但 server 仍在面板内 | 我们的形态更开放 |
| Tool Library | 可持久、可版本、扫密钥、带风险分级、可 ZIP 导入导出 | 无等价物（skill 系统更轻） | 我们独有 |
| kill switch / 客户端阻断 / `/exec` 共享密钥 | 有 | 无 | Atom 没有外部客户端，不需要 |
| 精确有理数时间 | native 平面 `{value, scale}` | 无，纯 JSX 浮点 | **差异化**，见 2.4 |
| 世代绑定 locator / `STALE_LOCATOR` | native 平面 | 无 | **差异化**，见 2.4 |
| 32bpc / EXR 正确性 | 位深 primitive + `grade-stack` / `render-order` skill | 取帧时临时降 8bpc 并给色彩警告 | **差异化** |

### 2.2 我们缺、且确实该补

| # | 项 | Atom 的做法 | 我们的去向 | 优先级 |
|---|---|---|---|---|
| 1 | **结构化读工具** | 9 个：`list_layers` `get_properties` `get_expressions` `get_keyframes` `scan_property_tree` `inspect_property_capabilities` `project_overview` `list_effects` `search_project`，全部带分页、排序、查询过滤 | 新增 `ae.read`，合并这些语义。**读路径绝不 checkpoint、绝不开 undo group** | **P0**，Phase 1 |
| 2 | **写失败的恢复信封** | 落盘可编辑 `.jsx` + 元数据（attempt 历史、脚本哈希、前后 checkpoint id、`project.revision`），只回 5 字符 `recoveryId`；模型用自己的 Edit 工具改文件后凭 id 重跑，默认先还原到失败前状态 | `ae.exec` 加恢复信封，恢复脚本放 `checkpoint_store` 的同一个 keyed 目录（**不放工程目录**） | **P0**，Phase 4 |
| 3 | **失败归因** | 执行前给 `Property.prototype.setValue` / `PropertyGroup.prototype.addProperty` 打临时补丁，记录碰过哪些 layer/property、哪些 mutation 失败；出错时回**被碰过图层的属性树快照** + 劫持到的 `$.writeln` | 同样的产出，**不同机制**——用 `wrapForEvalScriptTransport`（`plugin/host/server.js:365`）装显式 per-call recorder，`finally` 拆除。持久引擎共享全局，猴子补丁会跨调用污染 | P1，Phase 4 |
| 4 | **previewFrame 对比表 / 区间采样 / 差分** | 缩放代理合成 + `saveFrameToPng` + canvas 拼图；支持归一化坐标网格、ROI 裁剪、diff 模式 | 同路子，合成与缩放放**面板的 Chromium canvas**（顺带消掉 Pillow 依赖） | P1，Phase 4 |
| 5 | **紧凑读输出** | 所有读工具默认分页 + 排序 + 上限，效果搜索支持空格 AND、`\|` OR | 并入 `ae.read` 的输出格式 | P1，Phase 1 |
| 6 | **JSX 领域规则进模型上下文** | 系统提示词十几段硬规则：禁用语法、禁用模式（空值守卫/空 catch/自己开 undo group/`layer.locked`）、图层顺序（add* 都是 prepend）、引用失效（`addProperty` 作废同组已有引用，必须三趟走）、matchName 寻址、表达式引擎限制、验证策略、任务分解 | 非协商项进 MCP `instructions`（`build_server_instructions()` 已在用）；配方进 skill。面板自家聊天额外前置完整规则集 | P1 |
| 7 | **JSX 改动后免重启** | 面板在初始化时 `eval` 加载 JSX 模块 | 现在走 CSXS `ScriptPath`，改 `runtime.jsx` 要重开面板 | P2 |

### 2.3 Atom 有、但我们**不抄**

| 项 | 不抄的理由 |
|---|---|
| checkpoint / 恢复脚本落在 `<projectDir>/` | 污染用户工作树，会进他们的 git、素材备份和客户交付包 |
| 原型猴子补丁记录 touched props | 持久引擎共享全局作用域，跨调用污染。要产出不要机制 |
| 烘焙静态效果参数库 | 用户装了 Trapcode / Element 3D / Deep Glow 或升级 AE 就过期。`inspect_property_capabilities.jsx` 反射实时属性树，慢一点但永远正确，且对第三方效果有效 |
| 取帧时临时降 8bpc | 我们的核心场景就是 32bpc EXR |
| `--dangerously-skip-permissions` 取消全部审批 | 与我们的用户画像和信任边界不符 |
| 把三个 agent CLI 打进包里（280 MB） | 见 [ARCHITECTURE_DIRECTION.md §9](ARCHITECTURE_DIRECTION.md) |
| 发布版带 `.debug`（DevTools 端口 9193 常开） | 我们的打包脚本会删掉它，保持 |
| 25 个工具 | 其中 24 个不写的工具仍然占每次请求的描述预算。目标约 10 个 |

### 2.4 只有我们有的（要守住）

1. **精确有理数时间**与**世代绑定 locator**。JSX 浮点漂移导致的差一帧、图层重排后写错目标——**这两种失效在预览图上都看不出来**，模型的自我验证抓不到。这是 native 平面唯一的存在理由，也是它被**冻结而非退役**的原因。
2. **32bpc / EXR / ACES 正确性**。
3. **外部 MCP 客户端**。用户已在为 Claude Code / Cursor 付费。
4. **Tool Library**。Atom 的 JSX 是一次性的，每次会话重新推导同一个"32bpc 辉光"脚本。

---

## 3. 仍然适用的注意事项

- `runtime.jsx` / 共享 prelude 改动的爆炸半径很大。保持 ES3 兼容，配 render-token 测试和 live smoke。
- 现有工具返回形状是 MCP 契约的一部分。加字段、加可选格式；**不要删现有 JSON 默认字段**。工具面裁剪（16→10）是有意的破坏性变更，必须同步 `test_tool_names.py` 与四份文档。
- checkpoint / revert 必须 fail-safe。checkpoint 失败应表现为 note 或 skipped，不能中止用户的编辑。
- preview 是快速反馈，不是最终渲染管线。不要在文档里把它写成 render pipeline。
- 远端客户端要考虑 `127.0.0.1:11488` 在它们自己主机上解析。Docker 化或远程 IM bot 需要同机执行、端口转发，或在 AE 旁边跑一个 wrapper。

---

## 4. 验证入口

```powershell
uv run pytest
```

AE 打开且面板运行时：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

面板 / 模型 smoke：

```powershell
node scripts/live-model-matrix.mjs
```

发布相关改动还要重建 `plugin/client/dist/app.js` 并跑 [docs/RELEASE.md](RELEASE.md) 里的 ZXP smoke。

> Phase 1 起，`packages/core/tests/live` 的用例要转写成打 `/mcp` 的版本，作为面板内 MCP server 的验收套件。**移植测试先于移植代码。**
