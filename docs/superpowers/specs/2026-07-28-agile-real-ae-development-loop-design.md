# 敏捷开发与真实 AE 双轨验证设计

日期：2026-07-28
状态：已获用户批准，仓库自审与用户复核通过
范围：macOS 单用户开发路径、真实 AE 开发 smoke、能力包与发布验证策略
实现分支：`codex/dev-runtime-path`
前置提交：`0add90c feat(panel): add an opt-in development runtime path`

## 1. 背景

当前仓库把两个不同目标绑在了同一套流程里：

1. 开发者需要尽快确认正在编辑的 Core、CEP 或 native 代码能通过 public MCP 在真实 After Effects 中运行。
2. 发布者需要证明最终 packaged artifact 可从干净状态安装、升级、回滚并满足完整的身份与能力验收。

两者都需要真实 AE，但成本和证据强度不同。现行能力包流程要求每个包在合并前执行 T5，并在合并后从 clean `main` 重建、重装再执行 T6。这已经减少了全树 hash，却仍把 runtime 打包、组件部署、候选冻结、完整矩阵和 clean-main 复验放进每个日常开发闭环。

已完成的 `0add90c` 只解决 Core runtime 的一部分：开发 CEP 在显式设置
`AE_MCP_DEV_RUNTIME` 时可直接启动 checkout 的 `.venv/bin/python3 -B -I -m ae_mcp`，
不验证 packaged runtime manifest、不创建 RuntimeManager generation、不修改
`current`/`previous`，也不获取 RuntimeManager lock。packaged release 会拒绝该变量，
因此开发捷径不会进入发布运行时。

本设计把“快速确认真实产品行为”和“证明发布候选完整性”拆为两个明确 profile，
同时保留 public MCP、真实 AE、真实 Undo、协议兼容和加载真实性。

## 2. 目标

### 2.1 日常开发目标

- 依赖只在首次配置或锁文件/工具链要求变化时 bootstrap。
- 普通 edit → run 循环不得自动执行 `uv sync`、`npm ci`、portable runtime 打包、
  ZXP 构建或 release installer。
- 只构建、同步或重启实际发生变化的组件；未变化组件继续复用。
- AE 相关产品行为改变后，用一条小型 public-MCP 真实 AE smoke 证明代码确实运行，
  而不是只依赖 mock、bridge、codec 或 unit test。
- 开发 smoke 必须明确标记为开发证据，不能被误用为发布验收。

### 2.2 发布目标

- 完整 T5/T6 移到 release-candidate / packaged-artifact 边界。
- release 路径继续使用不可变构建、严格 artifact/receipt/file-set 身份验证、
  clean install/upgrade/rollback 和完整能力矩阵。
- 开发捷径不得改变 packaged release 的行为。

## 3. 非目标

- 不重写 ZXP、签名、公证或 release installer。
- 不改变任何 public MCP tool 的输入、输出、Undo 模型或渲染结果。
- 不增加新能力族或新 AEGP suite。
- 不为 native 引入增量对象缓存、热加载或 dirty-worktree 身份协议。
- 不在 Adobe CEP 或 native plug-in scan root 中放置指向 checkout 的 symlink。
- 不在本 PR 增加 Windows 开发路径。
- 不自动安装、升级或删除 Python、Node、npm、uv、Adobe SDK 或系统权限。
- 不删除现有能力包 driver，也不改写历史 T5/T6 证据。

## 4. 双轨模型

### 4.1 Development profile

Development profile 面向维护者本机的单用户、同 UID、受控 checkout。它包含三个阶段：

| 阶段 | 目的 | 是否允许安装依赖 |
|---|---|---|
| `bootstrap` | 首次建立 Python/Node/SDK/CEP 基线 | 是，但必须显式调用 |
| `sync` | 更新本轮变化的组件 | 否 |
| `smoke` / `HDEV` | 通过 public MCP 验证真实 AE 行为 | 否 |

`bootstrap` 与日常命令必须是不同入口。`sync` 或 `smoke` 发现依赖缺失、版本不兼容或
锁文件已变化时，必须 fail closed，输出精确 bootstrap 指令；不得为了“方便”自行执行
包管理器或联网安装。

### 4.2 Release profile

Release profile 只消费冻结的、可复现的 packaged candidate：

- T5：验证最终 packaged candidate 的完整 public-MCP 能力矩阵。
- T6：对最终候选执行 clean install、upgrade/rollback 或 clean-main/package 重放，
  证明安装和发布边界没有改变候选行为。
- `release-audit` 保持 exact source、全 payload hash、receipt 深度比对和 exact file set。
- 发布失败不得回退到 development profile。

## 5. 开发命令与组件计划

新增一个 macOS 开发编排入口，命令形状如下；最终文件名可在实现计划中确定，但语义必须固定：

```text
dev bootstrap --component core|cep|native|all
dev doctor
dev launch-ae --app /absolute/Adobe After Effects 2026.app
dev sync --component core|cep|native|all
dev smoke --scenario <checked-in-scenario>
```

`bootstrap` 是唯一允许调用依赖管理器的入口，而且必须由用户显式执行；它不得被
`doctor`、`launch-ae`、`sync` 或 `smoke` 间接调用。

### 5.1 `doctor`

`doctor` 只读检查：

- checkout 为本地、绝对、非 dataless 路径；
- `.venv/bin/python3` 存在、可执行，并能 import 当前 checkout 的 `ae_mcp`；
- CEP 开发安装存在 `.debug`，且 packaged `bundle-manifest.json` 不存在；
- 所需 `node_modules`、已构建 panel asset、native SDK 输入和已安装组件状态；
- formal AE app 的 bundle、版本、build、executable；
- canonical CEP/native 目标路径和开发 install receipt；
- wire version、RPC schema digest、capability digest、productVersion、平台和架构兼容性。

它只报告缺失项及对应 bootstrap/sync 动作，不修改文件、不启动 AE、不 hash 完整 runtime
树，也不要求跨组件 full repository SHA 相等。

### 5.2 `launch-ae`

开发启动器：

1. 要求传入 formal AE app 的绝对路径并解析其真实 `CFBundleExecutable`；
2. 若 AE 已运行但没有可证明的 development checkout 选择，fail closed；
3. 直接以 formal app 的真实 executable 启动进程，只给该进程树注入
   `AE_MCP_DEV_RUNTIME=<canonical checkout>`；
4. 不调用持久化的 `launchctl setenv`，不污染后续 Finder/GUI 启动的 AE；
5. 等待 native load 与 panel readiness 的有界信号，然后把控制权交给 smoke。

packaged CEP 继续拒绝 `AE_MCP_DEV_RUNTIME`。开发启动器不能修改这一门禁，也不能在拒绝后
回退到 packaged RuntimeManager。

### 5.3 Core

Core 复用 `0add90c`：

- 从 checkout 的 `.venv` 直接启动；
- Python 源码修改不创建 RuntimeManager generation；
- 不复制 portable runtime；
- 不获取 RuntimeManager install lock；
- diagnostics 明确显示 `DEVELOPMENT CHECKOUT`、canonical checkout 和 interpreter；
- Core 变化只需重启 MCP child/session，不要求重装 CEP 或 native，也不要求重启 AE，
  除非真实 host/session 状态已经无法安全复用。

### 5.4 CEP / host / JSX

CEP 首次安装仍使用现有受保护的开发 installer。日常 `sync --component cep`：

- 复用现有 `node_modules`；
- 只运行必要的本地 build，例如 panel bundle；
- 绝不运行 `npm ci`；
- 继续使用 off-scan staging、完整 shape 检查、原子替换和 rollback；
- 不在 Adobe scan root 中创建 backup、staging 或 checkout symlink；
- 需要 AE 关闭时明确停止并报告，不尝试在运行中的 CEP 上做不安全覆盖。

首版允许 CEP component 自身做一次完整原子部署；优化目标是避免依赖重装和无关组件部署，
不是绕过 scan-root 与 rollback 保护。若后续测量证明完整 CEP tree copy 仍是主要成本，
再单独设计 manifest-bounded changed-file sync。

### 5.5 Native AEGP plug-in

`sync --component native`：

- 复用已验证的 Adobe SDK archive/root、Xcode/clang/Rez 和现有开发 installer；
- 不重新下载或安装任何依赖；
- 继续要求 AE/aerender 全部关闭；
- 使用 clean commit 构建受身份约束的 native artifact；
- 使用 development identity profile 原子安装并保留 rollback；
- 安装后必须重启 formal AE，并验证新 native load record。

首版不允许 dirty-worktree native build。Core 和 CEP 可快速迭代；native 改动通过小型、
可审查的临时提交获得明确 build identity。以后若 clean-commit 要求被实测为主要瓶颈，
可另行设计 `HEAD + workspace digest + dirty=true` 的原生开发身份协议。

### 5.6 组件选择

用户或 agent 必须显式选择 component。首版不根据任意 Git diff 自动猜测最小组件集合。
`--component all` 只构建/部署三个产品组件，仍不得运行 dependency bootstrap 或 release
packaging。

编排器可以提供只读建议，但遇到 shared protocol/schema/build input 时应建议扩大到相关组件，
不能悄悄缩小范围。未知路径默认建议 `all`，而不是假定无需实机验证。

## 6. HDEV：轻量真实 AE smoke

HDEV 是开发 smoke，不是新的候选验收 tier。它必须：

1. 通过 public MCP surface 发起调用；
2. 证明响应来自当前 formal AE host/native load，而不是 mock、缓存或内部 handler；
3. 验证 typed response、AE state、provenance、audit 和 postcondition 一致；
4. 对写操作使用一个 `ephemeral-validation` fixture；
5. 对每种受影响的 Undo 模型至少执行一次真实 Undo 并读回恢复状态；
6. 遇到 `POSSIBLY_SIDE_EFFECTING_FAILURE` 时先 reconcile AE state 与 audit，禁止盲重试；
7. 记录使用了 development profile、checkout、组件 receipts/versions 和 scenario；
8. 复用现有 runner 语义输出 `candidateEvidence=false`，并增加
   `validationProfile=development`；不得生成 T5/T6 completion disposition。

HDEV 不要求：

- candidate freeze；
- 完整能力包工具矩阵；
- clean-main rebuild/reinstall；
- 每个薄 wrapper 的重复调用；
- exact source SHA、全树 hash 或 deep receipt equality；
- release completion report 或 Issue closure。

### 6.1 Scenario 粒度

每次 HDEV 运行一个 checked-in、可读的小型 scenario：

- Core-only read/adapter 变化：readiness + 受影响 public tool +独立 readback。
- CEP/transport 变化：readiness + 一个 native read；若修改 dispatch/uncertain-write
  分类，再加一个 disposable write + Undo。
- Native read primitive：一个真实 read 和来源验证。
- Native write/Undo primitive：before → write → after → audit → real Undo → restored readback。
- 新 suite、对象生命周期或 main-thread mechanism：允许额外的 narrow novelty smoke，
  但仍不是完整 T5。

一个包含多工具的能力包 HDEV 必须覆盖每个新增 native primitive，并在共享同一 primitive、
adapter、locator 和 Undo 模型的工具族中至少选择一个代表工具。没有共享路径依据的工具不能
仅凭“相似”被跳过。

Scenario 必须有固定调用预算和明确 stop conditions。失败后可批量收集仍可信的独立案例，
但不能把失败运行升级为通过证据。

## 7. 门禁与安全不变量

Development 与 release 都必须阻塞：

- wire version 不兼容；
- capability contract digest 不兼容；
- native RPC schema digest 不兼容；
- productVersion 不相等，直到存在明确的兼容区间协商；
- platform/architecture/entrypoint 不匹配；
- formal AE、CEP 或 native 实际加载失败；
- Adobe scan-root 中出现意外文件或不安全路径；
- 未 reconcile 的可能写入；
- fixture baseline 无法恢复。

Development 只记录、不因其单独阻塞：

- exact source commit 漂移；
- 全 runtime tree / 全 payload hash 漂移；
- receipt 的 exact source/artifact 深度比对；
- exact file set 差异，但 scan-root 意外文件保护仍保留。

Release-audit 对上述 identity 项继续严格。

## 8. 仓库策略变化

`AGENTS.md` 与 `docs/CAPABILITY_PACKAGE_WORKFLOW.md` 调整为：

- T0-T3 继续是普通 PR 的自动化测试与 review 层级。
- AE 产品行为发生变化时，PR 合并前要求一次与风险相称的 HDEV；纯文档、纯静态测试或
  不触及运行路径的变化可记录不适用理由。
- 新 native primitive 仍需尽早做 narrow real-AE smoke，但复用现有开发环境。
- 普通 capability PR 不再要求 candidate T5 + clean-main T6。
- 完整 T5/T6 只在 release candidate / packaged artifact 冻结后运行。
- “没有真实 AE 证据就不能声称 AE 行为已验证”保持不变；变化的是证据强度与运行时机，
  不是把 hardware validation 删除。
- standalone PR 完成后仍执行产品方向 checkpoint，但不再以每 PR clean-main T6 作为前置。

能力 PR 在 T0-T3、review 和对应 HDEV 通过后可以合并并关闭实现 Issue，但其完成说明必须写
`development-verified`，不能写 `release-accepted`。目标版本的 release milestone 单独追踪
自上一个发布版本以来所有新增/变更 capability 的 packaged T5/T6；只有该 milestone 通过后
才能声称这些能力已通过发布候选验收。

现有 capability driver 的 `t5`/`t6` 模式保留，供 release candidate 聚合运行和历史重放。
本 PR 不批量改写每个冻结 brief；新 brief 引用更新后的全局双轨策略。

## 9. 错误处理与恢复

- `doctor` 失败：零 public call、零候选证据、零自动安装；输出一个最小修复动作。
- Core child 启动失败：保留 AE/CEP/native，不触发整套 reinstall。
- CEP sync 失败：使用现有原子 rollback，保留上一份可运行 panel。
- Native build 失败：不触碰已安装 native。
- Native install 失败：使用现有 installer transaction/rollback；若恢复不完整立即停止。
- AE 启动或 load 超时：报告 formal app、进程、load record 和最后 checkpoint，不循环重装。
- 协议不兼容：立即停止，不允许 development drift profile 绕过。
- HDEV 写入不确定：执行 state/audit reconciliation；无法 reconcile 则保留 fixture/evidence
  并停止。

## 10. 测试与验证

### 10.1 自动化

新增或扩展测试：

- development CEP + `AE_MCP_DEV_RUNTIME` 选择 live checkout；
- packaged CEP 拒绝变量且无 production fallback；
- invalid checkout fail closed；
- `doctor` 为只读，不创建 runtime generation、pointer、lock、安装目录或依赖；
- `sync` 的命令计划从不包含 `uv sync`、`pip install`、`npm install`、`npm ci`、
  portable runtime、ZXP 或 release installer；
- component 选择只触发对应构建/部署；
- native sync 仍要求 clean commit、AE stopped、development installer 和 load verification；
- HDEV 输出 `candidateEvidence=false` 和 `validationProfile=development`；
- protocol/productVersion/architecture/load 等保留门禁在真实不兼容时仍阻塞。

所有新增 guard 必须做 mutation proof：

- 删除 packaged-release refusal 后测试失败，恢复后通过；
- 让 sync 偷跑一个 dependency bootstrap 命令后测试失败，恢复后通过；
- 放松一个保留的协议门禁后跨层测试失败，恢复后通过；
- 把 HDEV 错标为 candidate evidence 后测试失败，恢复后通过。

### 10.2 本机真实 AE

实现候选必须在现有依赖与已安装组件上完成一次 HDEV：

1. 不运行 bootstrap、portable runtime 或 ZXP；
2. 用 formal AE executable 启动并选择 live Core checkout；
3. diagnostics 显示 `DEVELOPMENT CHECKOUT`；
4. public readiness/read 成功并绑定当前 host/native load；
5. 执行一个 disposable write、独立 readback、audit、真实 Undo 和恢复 readback；
6. 关闭并归档唯一的 `ephemeral-validation` fixture；
7. 报告本轮只更新了哪些组件、哪些组件被复用；
8. 明确 `candidateEvidence=false` 和 `validationProfile=development`，不声称
   T5/T6 或发布完成。

## 11. 实施与 PR 边界

本设计在 `codex/dev-runtime-path` / #194 内完成，因为所有改动服务同一个用户结果：
“使用现有开发环境快速运行当前 checkout，并通过真实 AE 证明代表性产品行为”。

实现必须在隔离 worktree 中进行，不触碰根 checkout 当前 #67/#69 的未提交改动。

建议实施顺序：

1. 补齐 `0add90c` 的 live-Core 启动、诊断和 release refusal 文档/测试。
2. 写只读 doctor 与 formal-AE development launcher。
3. 写显式 component sync 编排，复用现有 CEP/native 安装器。
4. 增加最小 HDEV scenario 与 `candidateEvidence=false` /
   `validationProfile=development` 证据格式。
5. 修改 AGENTS/workflow 文档，把 HDEV 与 release T5/T6 分开。
6. 完成自动化、mutation proof 和一次真实 AE HDEV。

若实施发现必须改变 tool 行为、放松协议/productVersion/load/scan-root 门禁、允许 dirty native
身份或修改 release artifact，立即停止并请求新的范围决策。

## 12. 成功标准

完成后，维护者应能：

1. 在依赖已存在时修改 Core，重启开发 MCP 并在真实 AE 上验证，无 runtime generation copy；
2. 修改 CEP 时只 build/deploy CEP，不运行 npm dependency install，不动 native；
3. 修改 native 时复用 SDK/toolchain，只 build/install native，并在重启后验证新 load；
4. 对真实 AE 行为运行一个 bounded HDEV，而不是每 PR 执行完整 T5/T6；
5. 在 release candidate 时仍能运行严格 packaged T5/T6，且开发捷径无法进入 release。

成功不能只用“测试通过”描述；必须同时有一次 public-MCP 真实 AE HDEV 结果，以及证明
该运行没有重新安装依赖、没有创建 packaged runtime generation、没有执行 release packaging
的命令/文件系统证据。
