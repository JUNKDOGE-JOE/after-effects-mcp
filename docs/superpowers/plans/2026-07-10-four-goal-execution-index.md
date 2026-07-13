# 四目标交付总索引 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以七个顺序可审阅 PR 完成 macOS 适配、请求头路由闭环、Tool Library 和同一 commit 的 Mac/Windows v0.9.1 原子发布。

**Architecture:** 综合设计拆为四份可独立执行的子计划：平台基础先提供 OS/runtime/helper/secret/capture 契约；请求头与 Tool Library 在该契约上分别开发；最后由发布计划构建一次不可变候选产物并完成双平台 attestation。每个 PR 合并后 `main` 保持可运行，最终 RC 只从 protected `main` 构建。

**Tech Stack:** CEP/React 18、CEP Node、Node.js ESM + `node:test`、Python 3.10+ + pytest、Swift/Apple frameworks（macOS helper）、C++/Win32（Windows helper）、GitHub Actions、ZXPSignCmd、Apple codesign/notary、Windows Authenticode。

## Global Constraints

- 生产宿主只使用 CEP；不创建 UXP 分支、UXP runtime 或迁移兼容层。
- 支持 macOS 14+ Apple Silicon arm64（原生、无 Rosetta）与 Windows 11 24H2+ x64。
- After Effects 25.x 与 26.x 必须在 Mac arm64、Windows x64 四格矩阵全部完成实机 smoke。
- 目标版本固定为 v0.9.1；Mac/Windows 包来自同一 protected `main` candidate SHA。
- 核心运行离线自包含；系统 Python、系统 Node 与 `uv` 只属于开发环境，不是用户运行前置。
- Provider 配置和凭据不可导出；secret 只进入 macOS Keychain / Windows Credential Manager，JSON 只保存 opaque reference。
- Tool Library 导入包视为敌对输入；candidate 不可执行，执行 grant 必须绑定内容 hash、参数与目标。
- ZCode desktop OAuth/captcha runtime header bridge 明确不在本版本范围。
- 正式发布只提升已经在 Mac/Windows 实机验证过的相同 artifact bytes，禁止验证后重建。
- 保留用户现有未提交文件：`packages/core/ae_mcp/schemas.py`、`scripts/create_timer_display.jsx`、`scripts/run_timer_display.py`、`scripts/smoke-test-macos.sh`；实施必须在隔离 worktree 进行。

---

## 子计划与依赖

| 顺序 | 子计划 | 主要产物 | 可开始条件 |
|---:|---|---|---|
| 1 | [跨平台基础计划](./2026-07-10-cross-platform-foundation.md) | platform contract、helper、secret migration、macOS capture、离线 runtime、unsigned bundles | 本索引批准 |
| 2 | [请求头路由计划](./2026-07-10-provider-route-closure.md) | provider request profiles、authenticated facade、Responses→Chat 合约 | platform secret interface 合并 |
| 3 | [Tool Library 计划](./2026-07-10-tool-library.md) | ToolArtifact store、legacy compatibility、Tools UI、敌对导入、hash-bound grant | platform path/atomic-store contract 合并 |
| 4 | [双平台 RC/发布计划](./2026-07-10-dual-platform-release.md) | signed immutable artifacts、Mac/Windows attestation、原子 release | 前三份计划全部合并 |

请求头和 Tool Library 在各自基线满足后可并行开发；它们不得修改同一 provider migration/helper 文件。发布计划只消费前三份计划的稳定接口，不在 RC 阶段重写业务逻辑。

## PR 边界

| PR | 分支 | 范围 | 合并门禁 |
|---:|---|---|---|
| 1 | `codex/platform-contracts` | support/runtime manifests、JS platform API、helper JSON protocol、CI platform fixtures | Mac + Windows 自动化 contract tests |
| 2 | `codex/platform-native-helper` | Mac/Windows helper、Keychain/Credential Manager、两阶段迁移、统一 path/process/channel adapter | Mac helper/Keychain + Windows credential/authorization smoke |
| 3 | `codex/platform-packaging` | runtime lifecycle、ScreenCaptureKit/Windows capture、snapshot-host、unsigned bundle、Phase 0 signing、native CI、文档 | Mac capture/TCC + 两平台 bundle inventory + Windows Codex 基础 `PASS` |
| 4 | `codex/provider-route-closure` | PR #51 有效逻辑、provider headers、facade security/compact boundary | route/security/integration tests + Mac live provider smoke |
| 5 | `codex/tool-library-store` | ToolArtifact store、legacy skill、candidate/history、敌对 archive、12 个 MCP handlers | Python store/handler/migration/archive tests |
| 6 | `codex/tool-library-ui-approval` | Tools tab、CRUD/archive/duplicate、敌对导入、grant/三后端审批 | Panel + Python + 三后端 approval regression |
| 7 | `codex/v0.9.1-release` | trusted signed build、attestation checks、docs/version、final RC | 四格 AE、Mac/Windows checks、artifact digest 一致 |

## Task 0: 验证外部前置条件

**Files:**
- Read: `docs/superpowers/specs/2026-07-10-macos-header-tool-library-dual-release-design.md`
- Create during execution: PR 描述中的 `External prerequisites` 检查表；不把 secret 值写入仓库

**Interfaces:**
- Consumes: GitHub repository administration、Mac/Windows 实机、Adobe/Apple/Windows 签名身份
- Produces: 可以开始 Phase 0 的无秘密证据，或一个明确的外部 blocker

- [ ] **Step 1: 验证 GitHub 保护与发布环境名称**

  Run with an authenticated `gh` session:

  ```bash
  gh api repos/JUNKDOGE-JOE/after-effects-mcp/branches/main/protection
  gh api repos/JUNKDOGE-JOE/after-effects-mcp/environments
  gh variable list --repo JUNKDOGE-JOE/after-effects-mcp
  gh secret list --env release-signing --repo JUNKDOGE-JOE/after-effects-mcp
  ```

  Expected: `main` requires PR review/checks; environments `release-signing`, `macos-rc`, `windows-rc`, and `release-promotion` exist with required reviewers; repo variable `AE_MCP_RC_ATTESTORS` exists; secret listing confirms names only and never prints values.

- [ ] **Step 2: 验证签名身份与供应链权限**

  Required names in `release-signing`:

  ```text
  AE_MCP_APPLE_CERT_P12_BASE64
  AE_MCP_APPLE_CERT_PASSWORD
  AE_MCP_APPLE_SIGNING_IDENTITY
  AE_MCP_NOTARY_KEY_P8_BASE64
  AE_MCP_NOTARY_KEY_ID
  AE_MCP_NOTARY_ISSUER_ID
  AE_MCP_WINDOWS_CERT_PFX_BASE64
  AE_MCP_WINDOWS_CERT_PASSWORD
  AE_MCP_WINDOWS_CERT_SHA1
  AE_MCP_ZXP_CERT_P12_BASE64
  AE_MCP_ZXP_CERT_PASSWORD
  ```

  Repo/environment variables additionally define `AE_MCP_NOTARY_KEYCHAIN_PROFILE=ae-mcp-notary-ci` and the reviewed ZXPSignCmd path/digest. Expected: Developer ID Application、Apple notary、Windows Authenticode timestamping 和 ZXP signing 均能在受保护环境做一次无发布的 Phase 0 签名/验签；Node 与 python-build-standalone 的再分发许可证已记录。缺少任一身份时可以继续纯单元任务，但不得宣称平台 Phase 0 或发布链完成。

- [ ] **Step 3: 验证四格实机可用性**

  Required inventory:

  ```text
  Mac arm64: AE 25.x + AE 26.x，允许执行 CEP/helper/TCC smoke
  Windows 11 24H2+ x64: AE 25.x + AE 26.x，允许 Windows Codex 拉取精确 SHA、下载 artifact 并评论 PR
  ```

  Expected: 记录两台机器的 OS、CPU 架构、AE patch 版本和负责 GitHub 评论的 allowlisted 账号。当前 Mac 上仅有的 AE 版本不阻塞早期编码，但 AE 25/26 未齐全时最终 RC 必须保持阻塞。

- [ ] **Step 4: 验证 runner 最低系统门禁**

  Expected: `macos-15` arm64 与 `windows-2025` x64 可用；`macos-14` arm64 compatibility job 可用。若 GitHub 移除 `macos-14`，按平台计划切到 `[self-hosted, macOS, ARM64, ae-mcp-macos-14]`，不得静默删除 macOS 14 gate。

## Task 1: 建立隔离执行工作区

**Files:**
- Read: `docs/superpowers/specs/2026-07-10-macos-header-tool-library-dual-release-design.md`
- Read: 本索引与四份子计划
- Do not modify: 当前工作区的四个用户本地文件

**Interfaces:**
- Consumes: `main@ef1e4da` 之后已合并的最新 protected `main`
- Produces: 由 `superpowers:using-git-worktrees` 创建的 PR 专用 worktree；每个 PR 使用上表精确分支名

- [ ] **Step 1: 确认当前工作区脏文件只属于用户**

  Run:

  ```bash
  git status --short
  ```

  Expected: 只看到用户已有四个本地文件；若出现其他文件，先停止并定位来源。

- [ ] **Step 2: 使用 worktree skill 创建 PR 1 工作区**

  Invoke `superpowers:using-git-worktrees` with branch `codex/platform-contracts` based on latest `origin/main`.

  Expected: 新 worktree 干净，`git status --short` 无输出。

- [ ] **Step 3: 记录可复现基线**

  Run inside the new worktree:

  ```bash
  git rev-parse HEAD
  git branch --show-current
  node --version
  uv --version
  ```

  Expected: branch 为 `codex/platform-contracts`；Node 与 uv 可执行；SHA 写入 PR 描述的 `Baseline` 字段。

## Task 2: 顺序执行 PR 1–3（平台基础）

**Files:**
- Plan: `docs/superpowers/plans/2026-07-10-cross-platform-foundation.md`

**Interfaces:**
- Consumes: 干净 platform worktree
- Produces: `createPlatformAdapter`、platform-helper protocol、`SecretReference`、capture bridge、runtime manifest、unsigned platform bundle

- [ ] **Step 1: 按平台子计划 Tasks 1–3 执行 PR 1**

  使用 `superpowers:subagent-driven-development`，每个 Task 完成测试、spec review、quality review 和 commit。

- [ ] **Step 2: PR 1 合并后重新基于 `origin/main` 创建 PR 2 worktree**

  Run:

  ```bash
  git fetch origin
  git rev-parse origin/main
  ```

  Expected: PR 1 merge SHA 可达 `origin/main`；不要把旧 worktree 未合并 commit 直接搬入 PR 2。

- [ ] **Step 3: 用 Tasks 4–9 完成 PR 2，再用 Tasks 10–17 完成 PR 3**

  PR 2 branch 固定 `codex/platform-native-helper`；PR 3 branch 固定 `codex/platform-packaging`。Expected: PR 3 结束时 Mac/Windows unsigned bundle inventory tests 通过，并生成 Windows Codex 基础验证提示词。

- [ ] **Step 4: 执行第一次 Windows 实机门禁**

  Windows Codex 拉取 PR 3 的精确 commit，只测试不改代码，执行平台子计划规定的安装/启动/AE smoke，并在 PR 3 留下结构化 `PASS`。

  Expected: comment 中的 commit SHA 与 PR 3 head 相同；`FAIL` 时开修复 PR 并对新 SHA 重跑。

## Task 3: 并行执行 PR 4 与 PR 5

**Files:**
- Plan: `docs/superpowers/plans/2026-07-10-provider-route-closure.md`
- Plan: `docs/superpowers/plans/2026-07-10-tool-library.md`

**Interfaces:**
- Consumes: PR 3 已合并的 platform/secret/atomic-store contracts
- Produces: 已闭环 provider route；Tool Library core store 与 MCP surface

- [ ] **Step 1: 从同一 `origin/main` SHA 创建两个隔离 worktree**

  Branches:

  ```text
  codex/provider-route-closure
  codex/tool-library-store
  ```

  Expected: 两个 worktree 起点 SHA 相同且均干净。

- [ ] **Step 2: 并行执行 Route Tasks 1–10 与 Tool Library Tasks 1–7**

  Route agent 只能修改 provider/route 相关文件；Tool agent 只能修改 core tool store/handlers 与对应测试。发现共享文件需求时，暂停其中一侧并先合并更底层接口 PR。

- [ ] **Step 3: 分别完成 PR 4、PR 5 的全量相关测试**

  Run:

  ```bash
  cd plugin/panel && npm test
  uv run pytest packages/core/tests packages/bridge/tests packages/snapshot-host/tests -q
  ```

  Expected: route PR 的 Panel suite 全绿；Tool store PR 的 Python suite 全绿。

## Task 4: 执行 PR 6（Tool Library UI 与审批）

**Files:**
- Plan: `docs/superpowers/plans/2026-07-10-tool-library.md`

**Interfaces:**
- Consumes: PR 5 Tool store/MCP surface 与 PR 4 最新 `main`
- Produces: 完整 Tools tab、敌对导入、hash-bound execution grant、三后端审批一致性

- [ ] **Step 1: PR 4、PR 5 都合并后创建 `codex/tool-library-ui-approval` worktree**

  Expected: base SHA 同时包含两个 merge commit。

- [ ] **Step 2: 执行 Tool Library 子计划 Tasks 8–11**

  每个审批相关 Task 必须同时更新 Claude/Codex/ZCode adapter tests，不允许把跨后端回归全部推迟到 RC。

- [ ] **Step 3: 构建并验证 tracked Panel bundle**

  Run:

  ```bash
  cd plugin/panel
  npm ci
  npm test
  npm run build
  git add ../../plugin/client/dist
  npm run build
  git -C ../.. diff --exit-code -- plugin/client/dist
  ```

  Expected: tests 通过；第二次构建不再改变已暂存的 tracked dist，diff check 退出 0。

## Task 5: 执行 PR 7 与最终不可变 RC

**Files:**
- Plan: `docs/superpowers/plans/2026-07-10-dual-platform-release.md`

**Interfaces:**
- Consumes: 前六个 PR 已合并的 protected `main`
- Produces: v0.9.1 candidate SHA、Mac/Windows signed artifacts、两个 attestation Checks、final tag/release

- [ ] **Step 1: 完成 release coordination PR 并合并到 protected `main`**

  Branch: `codex/v0.9.1-release`.

  Expected: merge 后的 `main` SHA 成为唯一 candidate；PR 即使已合并仍保留为 Windows Codex 评论位置。

- [ ] **Step 2: 从 candidate SHA 构建一次签名 RC artifacts**

  Trigger trusted `build-rc.yml` from protected default branch.

  Expected artifact names:

  ```text
  ae-mcp-panel-v0.9.1-macos-arm64.zxp
  ae-mcp-panel-v0.9.1-macos-arm64.dmg
  ae-mcp-panel-v0.9.1-windows-x64.zxp
  artifact-manifest-v0.9.1.json
  ```

- [ ] **Step 3: 执行 Mac/Windows 四格实机矩阵**

  Mac：AE 25.x、26.x；Windows：AE 25.x、26.x。两端都必须验证下载 artifact 的 SHA-256，而不是本地重建。

- [ ] **Step 4: 验证两个 attestation Checks**

  Required checks:

  ```text
  macos-rc-attestation
  windows-rc-attestation
  ```

  Expected: 两个 Check 都绑定 candidate SHA 与 manifest 中对应 artifact digest；Windows PR comment 为 allowlisted 身份发布的 `PASS`。

- [ ] **Step 5: 原样提升 artifacts 并创建最终 tag**

  Run gate through `release.yml`.

  Expected: tag `v0.9.1` 指向 candidate SHA；release 下载后的 SHA-256 与 RC manifest 完全相同，没有 rebuild job。

## Task 6: 最终关闭四目标

**Files:**
- Read: `docs/RELEASE.md`
- Read: `README.md`
- Read: `CHANGELOG.md`

**Interfaces:**
- Consumes: v0.9.1 release URL、artifact manifest、Mac/Windows attestations
- Produces: 可审计的关闭证据

- [ ] **Step 1: 在 release coordination PR 的最终评论与 GitHub Release body 中逐项链接证据**

  Required evidence:

  ```text
  macOS install/upgrade/helper/capture attestation
  provider route security + live provider test run
  Tool Library store/import/approval regression run
  Windows PR PASS comment + macos/windows Checks + artifact manifest
  ```

- [ ] **Step 2: 确认明确非目标未被误报为支持**

  Search:

  ```bash
  rg -n "UXP|Intel Mac|Windows ARM|ZCode.*OAuth|captcha" README.md docs
  ```

  Expected: 文档明确这些能力不属于 v0.9.1 支持范围；不存在相反承诺。

- [ ] **Step 3: 关闭 Issue/PR 时附最终证据**

  Issue #49 附 route test/live evidence；Issue #50 附 Tool Library test/UI evidence；release coordination PR 附两个 attestation Check 与 manifest digest。最终 tag 之后不再修改仓库文件；任何文档修订必须进入后续版本，而不是改写已验证 candidate。

  Expected: 所有 scope 内 blocker 关闭，非阻塞已知限制进入 release notes，不以口头结论替代链接证据。
