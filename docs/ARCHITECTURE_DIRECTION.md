# 架构方向（当前有效）

> **状态**：2026-08-15 批准。本文件是新会话的入口，读完它就能接上工作，不需要重读拆解过程。
> 与 `AGENTS.md` 冲突时，以本文件的**方向**为准，`AGENTS.md` 的**交付纪律**（证据、验收、停止条件）仍然有效。

---

## 1. 一句话

从 **5 进程 / 3 条执行平面 / 16 个公开工具（无结构化读动词）** 收敛到
**2 进程 / 1 条主执行平面 / 约 10 个工具**，把省下的产能投进三项竞品结构上做不到的差异化。

---

## 2. 为什么

竞品 Atom 3.5.4 的 ZXP 拆解（Windows x64，静态分析）显示它用一个 CEP 扩展覆盖了我们大部分能力：

| | Atom | ae-mcp 现状 |
|---|---|---|
| 进程 | 2（CEP 面板 + agent CLI 子进程） | 5（面板+host、sidecar、Python、.aex、platform-helper） |
| 执行平面 | 1（`evalScript`） | 3（native-aegp / maintained-jsx / ephemeral-jsx） |
| MCP server 位置 | 面板进程内，Node `http`，`listen(0)`，Streamable HTTP `/mcp` | 独立 Python 进程，HTTP 回打面板 `:11488`（环形） |
| 工具 | 25，其中 **1 个能写**，**9 个结构化读** | 16，其中 1 个能写，**0 个结构化读** |
| 写失败恢复 | 落盘可编辑脚本 + `recoveryId`，模型用自己的 Edit 工具改后重跑 | 无 |
| 视觉验证 | 代理合成 + `saveFrameToPng` + canvas 拼对比表 | `ae.previewFrame` 已用 `saveFrameToPng`，但无对比表/采样/差分 |
| 原生代码 | 无 | `native/` 42,457 行 + 需要受限 Adobe SDK 才能构建 |

同时暴露了我们自己的三个事实，这三条是方向调整的直接依据：

1. **约 100 个 verb 实现函数里只有 16 个被注册。** `handlers/native.py`（2,697 行）定义约 70 个 `_run_*` 只注册 1 个（`ae.nativeExec`）；`handlers/typed.py`（516 行）注册 1/12。Python 侧 typed-native 投影层共约 **21,743 行**，绝大部分不可达。
2. **我们没有任何结构化读工具。** 模型想看工程只能自己写 JSX 走 `ae.exec`。这是我们**弱于**竞品的地方。
3. **platform-helper 的 3 个截屏方法在生产代码里零调用点。** 它唯一活着的用途是用系统钥匙串存 provider API key——而这个用途正被 provider 方向调整消灭。

另有一个**现存正确性 bug**（见 §6.1）。

---

## 3. 三个已定决策

| 决策 | 内容 |
|---|---|
| **Python 服务端** | **全力迁移，本季度退役。** MCP server 手写进 CEP Node 上下文 |
| **native AEGP 平面** | **冻结。** 保留 `.aex` 与 23 个 primitive，不再新增；删掉 Python 投影层 |
| **platform-helper** | **删除。** provider 凭据由 claude/codex/opencode 各自的登录态持有 |

配套（前序会话已定）：**provider 三通道**——codex CLI 与 claude CLI 各管自家模型及用户已配置环境，自定义 provider 全部经 opencode。

---

## 4. 目标形态

```
进程 1  AE 宿主进程
        CEP 面板页面上下文（React）
        + CEP Node 上下文 = plugin/host/
            /mcp      ← 手写 Streamable HTTP MCP server（新建）
            /exec     ← ExtendScript 平面（已有）
            /native/* ← AEGP 平面，冻结（已有）
        + AeMcpNative.aex 载入 AE 内（非独立进程）

进程 2  agent CLI 子进程：claude / codex / opencode
        不打包，检测 + 引导安装

进程 3  任意外部 MCP 客户端（Claude Desktop / Cursor / Claude Code / IM bot）
        直连 http://127.0.0.1:11488/mcp，一等公民
```

消失的：Python 进程、Node sidecar 进程、platform-helper 进程。

**执行平面**：ExtendScript 为主。native AEGP 冻结保留，只为两个 JSX 给不了的保证——精确有理数时间、世代绑定 locator。`ae.nativeExec` 不再作为独立工具暴露，折叠进 `ae.exec({ code, locators, timeMode:'exact' })`：**模型只要保证，不该知道有几条平面。**

---

## 5. 我们要保住的差异化（Atom 结构上做不到）

1. **32bpc / EXR / ACES 正确性。** Atom 取帧时临时把工程降到 8bpc 再还原，并给色彩一致性警告。位深 primitive 已有，`grade-stack` / `render-order` skill 已有。
2. **精确时间与 locator 保证。** JSX 浮点漂移导致的差一帧、以及图层重排后写错目标——**这两种失效在预览图上都看不出来**，模型自我验证抓不到。这是 native 平面唯一的存在理由。
3. **外部 MCP 客户端支持。** 用户已经在为 Claude Code / Cursor 付费，零额外花费就能控制 AE。Atom 的 server 只服务它自己 spawn 的 CLI。
4. **Tool Library。** 可持久、可版本、扫密钥、带风险分级的用户工具。Atom 的 JSX 是一次性的。
5. **kill switch / 客户端阻断 / `/exec` 共享密钥。** Atom 没有等价物，因为它没有外部客户端。

---

## 6. 分阶段执行

### Phase 0 — 止血与取证（1–2 周）

**6.1 修 jsx-bridge 超时（现存 P0 正确性 bug）**

`plugin/host/jsx-bridge.js`（68 行）：`setTimeout` 只 reject JS Promise，**不取消 AE 里的 ExtendScript**；`queue.then(onFulfilled, onRejected)` 在 reject 路径上照样放行下一个调用。于是超时路径打开了一个重叠写入窗口——正好是串行化本身要防的那件事。模型看到超时无法区分"没跑"和"跑了"，重试即**双重写入**；checkpoint 只能还原状态，无法告诉你写了两次。

不能简单地"超时不放行"——`evalScript` 无法取消，直接卡住队列会让面板静默死掉。做法：把**面向调用方的 Promise**（`timeoutMs` 到点即 reject，行为不变）与**队列尾部**拆开，队列只在以下之一发生时前进：

- AE 回调真的到达（哪怕在超时之后）；或
- 一次廉价哨兵往返（`1+1`）返回——返回即证明引擎已排空。

哨兵未返回期间 `ae.status` 必须报 `degraded`，并在恢复路径关闭可能悬空的 undo group。

> `plugin/host/jsx-bridge.test.js:59-83` 名为 `'timeout rejects and releases the lock for the next call'`，故意不触发第一个回调来断言锁被释放——**这个测试把 bug 固化成了预期行为，必须改写**。PR 描述里要写明，否则 review 会读成回归。

**6.2 手写 MCP server spike（阻塞性）**

`plugin/host/cep-runtime-compat.js:3-5` 已写明：CEP 11（AE 2023/2024）是 **Node 15.x / V8 8.8，`require('node:x')` 解析失败**。官方 `@modelcontextprotocol/sdk` 要 Node 18 + `node:` 前缀，跑不了。Atom 用裸 `require("http")` 手写，印证了唯一解。

先只做 `ae.status` 一个工具，在 **AE 2023 Windows** 上打通 `initialize` / `tools/list` / `tools/call`。

> **红灯预案**：若手写 server 在 CEP 11 上跑不通，两条退路——把宿主下限抬到 AE 2025（`plugin/CSXS/manifest.xml:11` 现为 `[23.0,26.9]`），或改为只支持 stdio shim。**必须在第 1 周知道，不是第 3 个月。**

**6.3 给 previewFrame 打点**

`handlers/core.py:_run_preview_frame`（L706-869）先走 JSX `comp.saveFrameToPng()`，失败才回落 mss 截屏。记录走了哪条分支、JSX 路径为何失败。**删 mss 之前必须先有这个数**——没人知道回落触发率，盲删是这份规划里唯一可能造成用户可见退化的动作。

**退出条件**：不存在任何"上一次 ExtendScript 仍在执行时派发下一次"的代码路径；spike 在 AE 2023 Windows 真机绿；previewFrame 分支遥测已上线。

---

### Phase 1 — MCP server 进面板（6–8 周）

新建 `plugin/host/mcp/`，挂到现有 express app 上。约束：**ES2020、零新依赖、不使用 `node:` 前缀**。

**复用既有件，不要重造：**

| 复用 | 位置 | 用途 |
|---|---|---|
| express app / activity log / kill switch | `plugin/host/server.js`（810 行） | `/mcp` 挂在这里 |
| 共享密钥 + `timingSafeEqual` | `plugin/host/auth-token.js`（85 行） | 直接复用；**另加 Origin/Host 白名单**补 DNS-rebinding 防护 |
| native 线协议客户端 | `plugin/host/native-aegp-client.js`（1,585 行） | native 平面不经 Python 也能活 |
| primitive 表（JS 版） | `native/ae-plugin/protocol/native_exec.generated.mjs` | `timeMode:'exact'` 直接基于它组装 native program |
| elicitation 对端 | `plugin/panel/src/lib/elicitationCoordinator.js` | `elicitation/create` |

**移植顺序**（每步独立可验证）：
`ae.status` → `ae.exec`（含自动 checkpoint + approval gate）→ `ae.previewFrame` → `ae.read`（新）→ `ae.checkpoint`/`ae.revert` → `ae.validateExpressions` → exact-time/locator 走 `/native/invoke`

整个阶段两套 server 并行，面板里一个开关切换。

**退出条件**：`packages/core/tests/live` 的等价用例在无 Python 进程下打到 `/mcp` 全绿；一个原装 Claude Code 会话指向 `http://127.0.0.1:11488/mcp`，**在没装 Python 也没装 Node 的干净 Windows 机器上**完成一次 20 步合成搭建。**这条不过，Phase 2 不启动。**

---

### Phase 2 — 删 Python、删 sidecar、删 helper（3–4 周）

**2.1 移植 Tool Library**

- 忠实移植：`tool_store.py`(1,175) + `tool_artifact.py`(753) + `tool_secrets.py`(410)——原子写、内容寻址、密钥扫描，机械工作。
- **重新定标** `tool_execution.py`(2,233)：prepare→grant→execute→status 四步握手 + job store 是为"上百个细粒度动词"设计的，在 10 个工具的世界里过度。目标形态是「渲染模板 → approval gate → `ae.exec`」，约 300 行。**但 `plan_hash` 授权绑定必须保留**——它防的是"授权后改内容再重放"，是唯一有安全语义的部分。
- **先移植测试再移植代码。**

**2.2 claude 后端换 CLI 二进制**

`claudeAgentBackend.js`(780) + `plugin/sidecar/`(989) + `plugin/shared/`(340) 的存在理由只有一个：Agent SDK 是 Node 库。换成 `claude --print --output-format stream-json --input-format stream-json --mcp-config <tmp>` 后进程 2 直接消失。`codexBackend.js` / `openCodeBackend.js` 已经是这个形状，**claude 是唯一的异类**。

连带删除：`runtimeManager.js`(1,699) + 测试(937)、`build-portable-runtime.mjs`(1,080)、node/python BOM 与 runtime-lock、`stage-sidecar-payload.mjs`、以及 247 MB 的 `@anthropic-ai/` 依赖岛。

> **既有暴露面**：我们**今天就在转发 `claude.exe`**——Agent SDK 的 npm 包内含它，随 `npm ci --omit=dev` 进了 ZXP。`@anthropic-ai/claude-code` 的 LICENSE 是 "All rights reserved"，不是开源许可（对照：codex 是 Apache-2.0、opencode 是 MIT）。换成"检测 + 引导安装"顺带消掉这个暴露面。

**2.3 删 platform-helper**

`native/platform-helper/**`、`plugin/host/platform-helper-*.js`、`.github/workflows/platform-foundation-ci.yml`、`sign-macos-nested.sh` / `sign-windows-nested.ps1`、`build-platform-helper.mjs`、`macos-helper-entitlements.mjs`、`helper-identity-policy.json`。

> **顺序陷阱**：`plugin/panel/src/cep/platform/process.js`(587) 是**通用可执行文件解析**，不是 helper 专属。它**必须保留**且变得更重要——它是我们找 `claude`/`codex`/`opencode` 的方式。
>
> **连带**：`native/platform-helper/windows/src/launcher.cpp` 就是那个 `ae-mcp.exe` 启动器（要求 `%USERPROFILE%\.ae-mcp\runtime\<current>\python\python.exe`，否则返回 78）。Python 死了它自然一起死。

**2.4 外部客户端路径**

HTTP 为一等支持路径（Claude Code / Cursor 原生支持）。另附约 150 行 stdio→HTTP shim 给只会 stdio 的客户端，**文档写明 shim 需要 Node**。

**退出条件**：`rg -c python .github/workflows/` 为 0；ZXP 单次签名、无嵌套原生二进制（`.aex` 除外）；ZXP 体积 < 20 MB；Claude Desktop 经 shim 跑通 `ae.exec`；macOS 与 Windows 各一次全新安装。

---

### Phase 3 — provider 收敛（4 周）

保留三个适配器：CLI 驱动的 claude、`codexBackend.js`、`openCodeBackend.js`。自定义 provider 全部经 opencode。

删除约 8,500 行 + 对应测试：`lib/agentLoop.js`(313, byokLoop)、`lib/anthropic.js`(212)、`zcodeBackend.js`(1,443)、`universalProviderRoute.js`(1,245)、`providerCapabilityProbe.js`(1,265)、`codexResponsesRoute.js`(1,089)、`providerProfile.js`(1,039)、`modelProbe.js`(303) 等。

**两个静默失败必须一起处理：**

- `plugin/panel/src/cep/backends/index.js:66-71` 的 `assertAttachmentBackendRegistry` 硬断言"只有 byok 可以 `attachmentTransport:'reject'`"，删 byok 会在模块加载期直接抛。
- `plugin/panel/src/app/App.jsx:1091-1092` 的 `backendInstances[effective.backend] || byokLoop` **不会抛**，删不干净会静默路由到拒收附件的 byokLoop——用户只看到"附件不工作"，日志里什么都没有。**改成未知 id 直接抛。**

> **可逆性**：Phase 3 是唯一造成**用户可见能力收缩**的阶段——支持的方言边界从我们自己定变成 opencode 定。opencode 通道与现有 `universalProviderRoute` **并存一个版本周期**收覆盖率数据，确认后再删那 3,600 行。
>
> **待验证风险**：opencode 的自定义 provider 依赖 `opencode.json` 里声明的 npm provider 包。若需联网拉包，内网/受限网络机器会失败——落地前必须真机验证。

**退出条件**：backend map 恰好 3 个条目且未知 id 抛错；provider 层 < 2,500 行；一个既有 GLM/DeepSeek/中转 Anthropic 端点用户（即 #257 的场景）经 opencode 仍可用。

---

### Phase 4 — 把回收的产能投进差异化

1. **`ae.exec` 恢复信封**（抄 Atom，修它两个错）：失败时落盘可编辑脚本 + 元数据，返回 `recoveryId`，模型用自己的 Edit 工具改那个文件后凭 `recoveryId` 重跑，默认先还原到失败前 checkpoint。
   **不要放 `<projectDir>/`**——`checkpoint_store` 已按解析后工程路径做 key 存在 `%TEMP%` 并 prune 到 50 份，那个设计是对的（#10 修过碰撞）。恢复脚本放同一个 keyed 目录，返回绝对路径。
2. **touched-path / failed-mutation 归因**：**不要抄 Atom 的原型猴子补丁**——持久引擎共享全局，会跨调用污染。用我们自己拥有的 `wrapForEvalScriptTransport`（`plugin/host/server.js:365`）装一个显式的 per-call recorder，`finally` 拆除。
3. **previewFrame 对比表 / 区间采样 / A-B 差分**：合成与缩放在**面板的 Chromium canvas** 里做，不要引入 Node 图像库（Atom 正是这么做的，也顺带消掉 Pillow 依赖）。
4. **32bpc / EXR / ACES 正确性面**。

---

## 7. 移植 vs 删除

### 必须移植（语义已打磨过，不要重新发明）

| 来源 | 行数 | 说明 |
|---|---|---|
| `checkpoint_store.py` | 234 | 按解析后路径做 key、prune 50、`AE_MCP_CHECKPOINT_KEEP`。逐条移植 |
| `approval_gate.py` | 278 | 两个 gate、默认方向相反，**是已定决策（254a24f）**。连 docstring 一起移植——那是这个决定唯一写下来的地方 |
| `jsx_result.py` + `jsx_prelude.py` | 105 | `"EvalScript error."` 哨兵必须与 `plugin/client/CSInterface.js:33` 和 `jsx-bridge.js` 逐字节一致 |
| `jsx_templates/`（33 个） | 2,323 | 移到 `plugin/jsx/` 旁边。`_aemcp_prelude.jsx` 与 `plugin/jsx/runtime.jsx` 是手工同步的两份副本，靠 `test_jsx_prelude.py` 逐字节断言防漂移——**迁移后合并成一份** |
| `handlers/core.py` 活逻辑 | ~370 | `ae.exec` 自动 checkpoint、`ae.revert` 原子替换与恢复分支、`ae.previewFrame` 的 PNG 完成轮询 |
| `instructions.py` + `skills_bundled/` | 63 + 9 JSON | 作为数据原样发。**注意** `instructions.py:21` 和 `ae-execution-guide.json` 里嵌了 23-primitive 的模型可见说明，工具面变了要同步改 |
| `annotations.py` | 43 | `VERB_ANNOTATIONS` 变成工具注册表元数据 |

### 直接删除

| 对象 | 量级 |
|---|---|
| `packages/`（core + bridge + snapshot-mss） | 40,296 源码 + 25,130 测试 |
| └ 其中 typed-native 投影层 | 21,743（`backends/native*.py` 17,097 + `handlers/native.py` 2,697 + 生成物 4,373） |
| `plugin/sidecar/` + `claudeAgentBackend.js` + `plugin/shared/` | ~2,100 + 247 MB 依赖岛 |
| `runtimeManager.js` + 测试 + portable runtime 构建 + BOM | ~3,500 |
| platform-helper 全套 + 专属 CI + 嵌套签名脚本 | ~5,163 + 工作流 |
| provider 层 + zcode 适配器 | ~10,000 + 测试 |
| `ae.snapshot` + `packages/snapshot-mss` + helper `window.*` | ~1,500 |

### 保留冻结

`native/ae-plugin/`（约 18,500 行 + protocol）。**不再新增 primitive**，停掉 capability package 流水线（`scripts/native_capability_codegen.py`、`packaging/native-coverage-approvals.json`）。

**退役条件写在这里**：若 AE 27 破 ABI 且修复不是一天的工作量，就退役——exact-time 改为 JSX 整数帧运算（对 `comp.frameDuration` 量化），locator 改为 `(index, name, sourceId)` 三元组写前复核。严格更弱，但一周能出。

---

## 8. 工具面重设计：16 → ~10

现存 `FINAL_PUBLIC_TOOLS`（`packages/core/ae_mcp/handlers/__init__.py:16-35`）：
`ae.checkpoint` `ae.diagnose` `ae.exec` `ae.nativeExec` `ae.ping` `ae.previewFrame` `ae.revert` `ae.skillList` `ae.skillUse` `ae.snapshot` `ae.status` `ae.toolIndex` `ae.toolInspect` `ae.toolSearch` `ae.toolUse` `ae.validateExpressions`

**里面没有任何结构化读动词。这是要补的最大缺口。**

| 工具 | 变化 |
|---|---|
| `ae.exec` | 保留。吸收 `ae.nativeExec`：`{ code, locators, timeMode:'exact' }`。新增恢复信封 |
| `ae.read` | **新增**。分页 + 排序 + 过滤的图层/属性/关键帧读取。读路径**绝不 checkpoint、绝不开 undo group** |
| `ae.previewFrame` | 保留并扩展：对比表、区间采样、差分 |
| `ae.checkpoint` / `ae.revert` | 保留 |
| `ae.status` | 吸收 `ae.ping` 和 `ae.diagnose`，用 `depth` 参数区分 |
| `ae.toolUse` / `ae.toolSearch` | 保留；`toolIndex` + `toolInspect` 折叠成 `toolSearch` 的模式 |
| `ae.skillUse` | 保留；`skillList` 折叠成无参调用 |
| `ae.validateExpressions` | 保留。表达式错误在 AE 里是静默的，不可约 |

删除：`ae.snapshot`、`ae.ping`、`ae.nativeExec`、`ae.toolIndex`、`ae.toolInspect`、`ae.skillList`、`ae.diagnose`。

守门测试：`FINAL_PUBLIC_TOOLS` + `packages/core/tests/test_tool_names.py`。
同步更新：`README.md`、`README.zh-CN.md`、`docs/REFERENCE.md`、`docs/INSTALL.md`。

---

## 9. 明确不做

- **不打包 agent CLI。** 247 MB 里绝大部分是用户很可能已经装了的二进制；打包等于把别人的发版节奏、安全修复、认证变更变成我们的发版，且结构性偏向单一厂商，与多 provider 定位矛盾。改为检测（`platform/process.js`）+ 一键安装（`WizardScreen.jsx` 已有命令预览），**并且顺手补上 Node 安装**——目前向导只检测不安装 Node，这正是 Windows 干净机上内置 Claude 聊天起不来的原因。
  （更正一个流传的说法：Windows 干净机上 **Python 服务端本身经 uv 是能装的**，真正起不来的是内置 Claude 聊天。）
- **不动两个 approval gate 的相反默认。** `AE_MCP_APPROVAL_TIER_FILE`（动词面，未设置即 no-op）vs `AE_MCP_TOOL_APPROVAL_TIER_FILE`（Tool Library 面，缺失即 fail closed 到 manual）。理由已在 254a24f 写下，**是已定决策，不要重新讨论**。
- **不抄 Atom 的这些**：原型猴子补丁记录 touched props（持久引擎共享全局会污染）；checkpoint/恢复脚本落在用户工程目录旁（污染工作树、进用户的 git 和交付包）；烘焙静态效果参数库（用户装了 Trapcode/Element 3D 就过期，`inspect_property_capabilities.jsx` 反射实时属性树永远正确）；取帧时降 8bpc；`--dangerously-skip-permissions` 取消全部审批。
- **不删 Tool Library 的存储与密钥扫描。** 只重新定标执行层，不动持久化与 `plan_hash` 授权绑定。
- **不追求"2 进程"这个数字本身。** 进程数是症状。真正要消掉的是环形依赖、双运行时、打包闭合三件事。

---

## 10. 相关文档

| 文件 | 关系 |
|---|---|
| `AGENTS.md` | 交付纪律（证据、验收、停止条件）仍全部有效。但其 §3 的 native-first 验收链路在本方向下**仅适用于冻结的 native 平面**，新能力走 ExtendScript 平面 |
| `docs/ATOM_PARITY_ROADMAP.md` | 竞品对标项的去向，逐条并入本文件的 Phase |
| `docs/THREAT_MODEL.md` | 产品信任边界不变；platform-helper 删除后需同步"provider 密钥由各 CLI 持有" |
| `docs/RUNTIME_MANAGER.md` | Phase 2 后作废 |
| `docs/CAPABILITY_PACKAGE_WORKFLOW.md` | native 冻结后暂停使用 |
