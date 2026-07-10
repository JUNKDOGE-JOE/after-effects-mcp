# v0.9.1 不可变双平台 RC / Immutable Dual-Platform RC

## 中文

### 1. 状态与原则

v0.9.1 当前是**未发布候选**。版本源同步、workflow 文件存在或单个平台测试通过，都不等于发布完成。正式 tag 只能指向 protected `main` 上已验证的 candidate SHA，并且必须原样提升已经通过实机验证的字节：**禁止重建**。

固定发布资产：

```text
ae-mcp-panel-v0.9.1-macos-arm64.zxp
ae-mcp-panel-v0.9.1-macos-arm64.dmg
ae-mcp-panel-v0.9.1-windows-x64.zxp
artifact-manifest-v0.9.1.json
```

两个平台资产来自同一个 candidate SHA。任一平台失败、候选代码变化、依赖/签名变化或 artifact 不一致时，当前候选永久拒绝；修复必须产生新 SHA、新 build run、新 artifact 和两份新 attestation。

### 2. 外部前置条件

触发签名 RC 前必须逐项确认：

- revised “条件式 A→B” signed-helper architecture 已取得明确批准，并完成其 Phase 0 安全/可行性证据；未批准时不得实现或声称 helper、Tool Library、provider route 已闭环。
- `packaging/native-coverage-approvals.json` 当前保持 `blocked`。未来即使 helper build 单独落地，也必须另行提供并批准逐文件 Mac/Windows 原生签名复验、AE 25/26 双平台实机矩阵，以及 `provider-header-routing`、Tool Library、持久化、升级回滚和权限恢复的完整验收覆盖；缺少任一项时 build guard 在不可逆 candidate lock 之前失败。
- 所有 helper-gated provider route 与 Tool Library 实现、测试和安全评审已经在 candidate 中完成；版本文档不能替代实现证据。
- protected `main`、required checks、allowlisted attestation 身份、protected Environment reviewer 和一次性 candidate build lock 已配置并验证。
- GitHub 标签规则集（tag ruleset）必须阻止除晋级身份外创建、更新或删除 `v*` tag；从 mutation-adjacent 复核开始到公开后审计结束，maintainer 必须对 `main` 执行外部合并冻结。workflow 的 API 重读只能检测竞态，不能原子化替代标签规则集或合并冻结。
- 仓库已启用 GitHub Immutable Releases；protected `release-promotion` Environment 提供仅具 repository administration-read 的 `AE_MCP_RELEASE_ADMIN_TOKEN`，用于在 tag/publish 前读取该设置，不能用普通 contents token 或布尔占位替代。
- attestation Check 的 `details_url` 必须指向处理 active comment 的精确 `actions/runs/<run-id>/attempts/<attempt>`。promotion 会复核 run ID、attempt、`.github/workflows/attestation.yml` path、candidate head SHA 与 workflow blob；在 attestation writer 尚未提供这份 provenance 前必须 fail closed。
- Adobe ZXP 证书、Apple Developer ID/notary 凭据、Windows Authenticode 证书只存在 protected CI environment；本地文档或日志中不得出现 secret。
- repository variable `AE_MCP_ZXP_CERT_FINGERPRINT_SHA256` 已设为实际 Adobe ZXP 签名证书 DER 编码的 64 位小写 SHA-256 指纹；它不是占位值，且必须与两个平台 ZXP 内嵌证书一致。
- 便携 Node、CPython、原生 helper、npm/Python 依赖及 Windows runtime 的许可证与再分发依据已经审计并获准；缺失或受限证据必须 fail closed。
- Mac arm64 上可用 AE 25.x、26.x；Windows 11 24H2 x64 验证机上可用 AE 25.x、26.x。
- `ZXPSignCmd`、Apple 公证工具、Windows SignTool/PowerShell 以及签名 runner 架构满足锁定版本与平台要求。
- Windows Codex 可读取候选与指定 build artifact，并以 allowlisted GitHub 身份在 release coordination PR 下评论。
- Claude Code CLI、Codex CLI、ZCode CLI/app-server 只用于各自的可选通道 smoke；缺少某个可选 CLI 不改变核心离线包的定义，但若 release scope 承诺该通道就必须提供对应测试环境。

任何前置条件缺失都可以继续做无关单元工作，但不得创建最终 tag 或公开任一平台资产。

### 3. 候选前检查

1. release coordination PR 按正常评审合入 protected `main`；合入后的 40 位小写 SHA 才是 candidate。
2. 确认所有 active package、lock、Panel 与 CEP manifest 版本为 `0.9.1`，Host range 精确为 `[25.0,26.9]`。
3. 在干净 checkout 运行：

   ```bash
   node --test scripts/release/test/version-consistency.test.mjs
   uv run pytest -q
   (cd plugin/host && npm test)
   (cd plugin/panel && npm test)
   (cd plugin/sidecar && npm test)
   ```

4. 确认 runtime lock、SBOM、license inventory、bundle manifest、signing plan 与 Phase 0 evidence 都绑定该 SHA；restricted/unknown license 不得用占位批准绕过。
5. 合入后不再 squash、rebase 或修改 candidate；任何修复走新 PR。

### 4. 一次构建两个签名平台包

从 protected 默认分支手动触发 `.github/workflows/build-rc.yml`，输入精确 `candidate_sha` 与 `version=0.9.1`。workflow 必须：

- 验证 candidate 可达 protected `main`、trusted workflow revision 和 runner 架构；
- 为 candidate 获取一次性 build lock；失败或取消也不得重用该 SHA；
- 在原生 Mac arm64 与 Windows x64 job 中验证 deterministic stage，完成 nested signing、ZXP 签名和平台验证；
- 在 Mac job 生成、签名、公证并 staple DMG；
- 生成 `artifact-manifest-v0.9.1.json`，同时内嵌未签名 source bundle manifest 与签名后的 final bundle manifest，以及 runtime/SBOM/license/signing evidence，并记录 run ID、artifact ID 与 SHA-256；
- 上传上方四个固定名字的 RC 资产；另有两个固定名字、保留 30 天的内部 signer preflight artifact，用于覆盖 protected Environment 审批延迟；它们不属于 Release 资产，即使过期、清理或缺失也不影响四个晋级资产的有效性与下载。

签名 job 不从开放版本范围执行在线 `npm install`/`pip install`，也不接受 fork、未保护 branch 或本地重建的 payload。

### 5. 下载精确 artifact 并完成四格验收

所有验证者记录 build workflow run ID 与 artifact ID，从该 run 下载资产，先按 `artifact-manifest-v0.9.1.json` 校验 digest。禁止在验证机重建被测包。

Mac 验证者向 `scripts/release/verify-rc-macos.sh` 提供另行安装的受支持 ZXP installer；wrapper 校验 DMG/ZXP hash、nested codesign、Gatekeeper、公证/staple、精确安装载荷与稳定 launcher。Mac 和 Windows wrapper 随后分别在 AE 25.x、26.x 中运行六项 installed-runtime 检查：`initialize`、`tools/list`、`ae.status`、`ae.diagnose`、`ae.previewFrame`、`ae.snapshot`，并生成各自 canonical attestation。

这组 wrapper 检查不是完整产品验收。独立的 product-acceptance policy 当前仍为 `blocked`；`packaging/product-acceptance-coverage.json` 必须另行、逐项提供全新安装/升级回滚、权限拒绝/恢复、持久化、provider header routing 与 Tool Library 证据。build guard 会在不可逆 candidate lock 前拒绝缺失覆盖。只有 wrapper 两个 AE major 的精确载荷 smoke、独立产品覆盖和相应 GUI/实机证据全部满足，才算四格验收完成。

Windows 验证者使用 [固定 Codex 提示词](WINDOWS_CODEX_RC_PROMPT.md) 与 `scripts/release/verify-rc-windows.ps1`，生成 canonical `windows-attestation.json`，并在当前 PR 留下人类可读结果和机器 marker。Windows Codex 只测试与评论，不修改代码；它不得把六项 wrapper smoke 描述成 provider/Tool Library/升级回滚已经验收。

### 6. 双 attestation Check

`.github/workflows/attestation.yml` 只接受与 candidate、build run、artifact ID/name/digest 完全一致的 canonical report，并在 protected Environment 审批后维护两个 Check：

```text
macos-rc-attestation
windows-rc-attestation
```

Check 必须绑定 candidate SHA。Windows 评论作者必须在 allowlist 中；评论编辑/删除或同一身份后续有效 `FAIL` 会立即使旧 PASS 失效。任一 Check 缺失、非 success、绑定错误或 evidence 不完整，都不得进入 promotion。

### 7. No-rebuild 原样提升

只有两个 attestation Check 都有效时，才触发 `.github/workflows/release.yml`，输入 `candidate_sha`、`build_run_id` 与 `version=0.9.1`。promotion job 必须：

1. 从指定 build run 下载原始 RC artifacts，不运行 build 或签名步骤。
2. 重新校验 manifest 的 version、candidate SHA、workflow run/artifact ID、平台、文件名与 SHA-256。
3. 验证两个 attestation Check 仍为 success 且绑定相同 SHA/digest。
4. 创建指向 candidate 的 annotated `v0.9.1` tag；若 tag 已指向其他 SHA则失败。
5. 先创建 draft GitHub Release，上传精确三个安装/载荷资产及 manifest，再从 release 下载并复算 SHA-256。
6. 所有复核通过后才公开 Release；失败时保持 draft/失败状态，不发布部分平台。

晋级 workflow 固定使用 Node `24.17.0` 与完整 commit SHA 的 Actions，并在 protected `release-promotion` Environment 中运行。两个内部 preflight artifact 可已过期或被 GitHub 清理而缺失；四个固定 RC artifact 必须唯一、未过期、ID/大小有效，且晋级只下载这四个精确 artifact ID。若 preflight artifact 仍在 inventory 中，只允许两个锁定名称各出现一次；任何未知或重复 artifact 都 fail closed。仅凭 artifact 名、Check 名或绿色状态不足以放行。

创建 tag 前，workflow 会解析两个 deterministic Check 的 external ID、GitHub Actions App ID、canonical state、`candidateRejected=false`、active artifact ID/digest 与 active comment ID。GitHub Actions App ID 是共享身份，不能单独证明来源，因此还必须复核 Check 绑定的 workflow run ID、attempt、path 与 SHA。随后按该 comment ID 重新读取当前 PR 评论，并重新验证 `updated_at`、作者 allowlist、正文 marker、canonical PASS report、PR 归属和完整 candidate/run/artifact 身份；它会分页读取该 PR 的全部 canonical attestation 评论，并用与 attestation workflow 相同的 reconciliation 规则独立重算两个平台状态。对 candidate SHA 的每个 attestation workflow run，latest attempt 必须是 `completed+success`；queued/running/cancelled/failure/timed-out/action-required/stale 都会阻断，直至成功重跑同一 run。任何匹配当前 candidate/artifact 的有效 `FAIL` 也会阻断。评论不存在、被编辑、作者变化或正文不再匹配时立即失败。创建 tag reference 与公开 draft 紧前会再次读取 main/tag、同一评论、完整评论历史、Check/provenance、build lock、release/asset inventory 与 immutable-releases gate；tag 已创建不构成发布授权。

失败后的重复晋级只允许使用完全相同的 candidate、build run 和 bytes，且 candidate 仍须是 current protected `main`：正确的 annotated tag 可复用；workflow 通过 `listReleases` 找到唯一 draft/published 并持久绑定 release ID，之后只按 release/asset ID 操作。已存在 draft 中每个资产必须先下载并匹配摘要，workflow 只追加缺失资产，绝不删除、替换或 `--clobber`。上传后记录 asset ID/name/size/更新时间，重新下载四个资产（包括 manifest）并逐一复算摘要，且在公开前再次确认该 inventory 未变化。公开动作紧前会再次复核 main、tag、Check/comment/run、build lock、release identity、asset inventory 与 immutable-releases 设置；公开后会重新读取并证明 tag 仍指向 candidate、main 未移动、同一证据仍有效、资产 inventory 未变化且 Release 为 `immutable=true`。若 Release 已公开，重复触发仅执行同一套只读一致性审计。任何缺失或差异都 fail closed。

tag 后不得修改 candidate 文件。文档修订进入后续版本，不能改写已经 attested 的 v0.9.1 字节。

### 8. 失败、撤销与证据

- build、签名、公证、license、四格 AE、provider/Tool Library、attestation 或 promotion 任一步失败，candidate 都不能发布。
- 保存 canonical manifest、Mac/Windows reports、Check URL、workflow run/artifact ID、签名/许可证证据和最终 release digest。
- provider 配置和凭据不可导出；诊断/attestation 只记录脱敏元数据。
- issue/PR 关闭评论必须链接实际测试与 artifact 证据，不能用“自动化已过”代替 AE 实机结果。

## English

### 1. Status and Invariant

v0.9.1 is an **unreleased candidate**. Synchronized versions, workflow files, or one passing platform do not constitute a release. The final tag may point only to a verified protected-`main` candidate SHA, and promotion must reuse the exact hardware-tested bytes: **no rebuild**.

Fixed assets:

```text
ae-mcp-panel-v0.9.1-macos-arm64.zxp
ae-mcp-panel-v0.9.1-macos-arm64.dmg
ae-mcp-panel-v0.9.1-windows-x64.zxp
artifact-manifest-v0.9.1.json
```

Both platforms come from one candidate SHA. Any platform failure, source change, dependency/signing change, or artifact mismatch permanently rejects that candidate. A fix requires a new SHA, build run, artifact set, and dual attestations.

### 2. External Prerequisites

Before a signed RC is triggered, verify all of the following:

- The revised conditional A→B signed-helper architecture has explicit approval and Phase 0 security/feasibility evidence. Until then, no helper, Tool Library, or provider-route closure may be implemented or claimed through release documentation.
- `packaging/native-coverage-approvals.json` intentionally remains `blocked`. Landing the helper build alone never unlocks an RC: separately approved per-file Mac/Windows native-signature verification, the AE 25/26 hardware matrix, and complete provider-header-routing, Tool Library, persistence, upgrade/rollback, and permission-recovery acceptance coverage are all required before the irreversible candidate lock.
- All approved helper-gated provider route and Tool Library implementation, tests, and security review are present in the candidate; version metadata is not implementation evidence.
- Protected `main`, required checks, allowlisted attestation identities, protected Environment reviewers, and the one-build-per-candidate lock are configured and tested.
- A GitHub tag ruleset blocks every identity except promotion from creating, updating, or deleting `v*` tags, and maintainers enforce an external `main` merge freeze from mutation-adjacent revalidation through the post-publication audit. API rereads detect races but cannot atomically replace the tag ruleset or merge freeze.
- GitHub Immutable Releases is enabled. The protected `release-promotion` Environment supplies `AE_MCP_RELEASE_ADMIN_TOKEN` with repository administration-read only so the workflow can read that setting before tag and publish; a contents token or boolean placeholder is not sufficient.
- Each attestation Check `details_url` points to the exact `actions/runs/<run-id>/attempts/<attempt>` that processed its active comment. Promotion revalidates the run ID, attempt, `.github/workflows/attestation.yml` path, candidate head SHA, and workflow blob; until the attestation writer emits that provenance, promotion fails closed.
- Adobe ZXP, Apple Developer ID/notary, and Windows Authenticode credentials exist only in protected CI environments.
- Repository variable `AE_MCP_ZXP_CERT_FINGERPRINT_SHA256` is the 64-character lowercase SHA-256 fingerprint of the real Adobe ZXP signing certificate's DER encoding. It is not a placeholder and must match the embedded certificate in both platform ZXP files.
- Redistribution evidence for portable Node, CPython, the native helper, npm/Python dependencies, and Windows runtimes is audited and approved; missing or restricted evidence fails closed.
- AE 25.x and 26.x are available on both a Mac arm64 verifier and a Windows 11 24H2 x64 verifier.
- Locked `ZXPSignCmd`, Apple notarization tools, Windows SignTool/PowerShell, and native signing runner architectures are available.
- Windows Codex can read the exact candidate/artifact and comment through an allowlisted GitHub identity on the release coordination PR.
- Claude Code CLI, Codex CLI, and the ZCode CLI/app-server are optional channel dependencies. A promised channel still needs its corresponding smoke environment, but the core offline package must not depend on these CLIs.

A missing prerequisite may leave unrelated unit work in progress, but it forbids a final tag or public platform asset.

### 3. Candidate Preflight

1. Merge the reviewed release coordination PR into protected `main`; the resulting 40-lowercase-hex commit is the candidate.
2. Confirm all active package, lock, Panel, and CEP manifest versions are `0.9.1`, with exact host range `[25.0,26.9]`.
3. Run the version, Python, host, Panel, and sidecar suites from a clean checkout.
4. Confirm runtime locks, SBOM, license inventory, bundle manifest, signing plan, and Phase 0 evidence are bound to that SHA. Never replace restricted/unknown license approval with a placeholder.
5. Do not squash, rebase, or mutate the candidate after merge; fixes use a new PR.

### 4. Build Both Signed Platforms Once

Dispatch `.github/workflows/build-rc.yml` from the protected default branch with exact `candidate_sha` and `version=0.9.1`. It verifies candidate/trusted-workflow identity and native runner architecture, acquires the one-time build lock, signs native Mac/Windows payloads, creates the notarized/stapled DMG, embeds both the unsigned source and frozen final bundle manifests with the remaining supply-chain/signing evidence, and uploads the four fixed RC artifact names above. Two separately named, 30-day signer-preflight artifacts cover protected Environment approval delays and are not Release assets; their expiry or absence does not affect the four promotion assets or their download.

Signing jobs consume locked offline inputs. They do not resolve open npm/Python ranges, accept fork/unprotected payloads, or substitute locally rebuilt files.

### 5. Download Exact Artifacts and Run the Four Cells

Each verifier downloads the named artifact from the recorded workflow run/artifact ID and verifies it against `artifact-manifest-v0.9.1.json`; the verification machine never rebuilds the package under test.

The Mac verifier supplies a separately installed supported ZXP installer to `scripts/release/verify-rc-macos.sh`. The wrapper verifies the DMG/ZXP digest, nested signatures, Gatekeeper/notarization/staple, exact installed payload, and stable launcher. Both platform wrappers then run exactly six installed-runtime checks in AE 25.x and AE 26.x: `initialize`, `tools/list`, `ae.status`, `ae.diagnose`, `ae.previewFrame`, and `ae.snapshot`, and emit their canonical attestations.

Those wrapper checks are not full product acceptance. The separate product-acceptance policy remains `blocked`; `packaging/product-acceptance-coverage.json` must independently supply clean-install/upgrade/rollback, permission denial/recovery, persistence, provider-header routing, and Tool Library evidence. The build guard rejects missing coverage before the irreversible candidate lock. A four-cell result requires the exact-payload wrapper smoke for both AE majors plus that independent product and GUI/hardware evidence.

The Windows verifier uses [the fixed Codex prompt](WINDOWS_CODEX_RC_PROMPT.md) and `scripts/release/verify-rc-windows.ps1` on Windows 11 24H2 x64. It emits canonical `windows-attestation.json` and posts the human plus machine-readable result to the current PR. Windows Codex tests and comments only; it must not describe the six-check wrapper as provider/Tool Library/upgrade acceptance.

### 6. Dual Attestation Checks

`.github/workflows/attestation.yml` accepts only canonical reports that exactly match candidate, build run, artifact ID/name, and digest. Protected approval maintains:

```text
macos-rc-attestation
windows-rc-attestation
```

Checks bind to the candidate SHA. The Windows author must be allowlisted, and comment edit/delete or a later valid FAIL invalidates the old PASS. A missing, stale, non-success, or mismatched Check blocks promotion.

### 7. No-Rebuild Promotion

Only after both Checks succeed, dispatch `.github/workflows/release.yml` with `candidate_sha`, `build_run_id`, and `version=0.9.1`. It downloads the original RC artifacts, revalidates manifest identity and hashes, confirms both Checks, creates `v0.9.1` at the candidate, uploads a draft Release, downloads the published assets for another digest comparison, and publishes only after all comparisons pass. It contains no build or signing step.

Promotion runs behind the protected `release-promotion` Environment with Node `24.17.0` and commit-pinned Actions. The two internal preflight artifacts may be expired or already purged; all four fixed RC artifacts must remain unique, unexpired, and valid, and only their four exact IDs are downloaded. If preflight artifacts remain in the run inventory, only the two locked names are allowed once each; any duplicate or unknown artifact fails closed. A matching name, Check name, or green conclusion alone is never sufficient.

Before creating the tag, the workflow validates each deterministic Check's external ID, GitHub Actions App ID, canonical state, `candidateRejected=false`, active artifact ID/digest, and active comment ID. The GitHub Actions App ID is shared and is not sufficient provenance by itself, so the bound workflow run ID, attempt, path, and SHA are also revalidated. It then fetches the current PR comment by ID and revalidates its `updated_at`, allowlisted author, body marker, canonical PASS report, PR ownership, and full candidate/run/artifact identity. It paginates every current canonical attestation comment and independently recomputes both platform states with the attestation workflow's reconciliation rule. For every attestation workflow run at the candidate SHA, the latest attempt must be `completed+success`; queued, running, cancelled, failed, timed-out, action-required, or stale attempts block until that run is rerun successfully. Any valid `FAIL` for the candidate/artifact also blocks promotion. A missing, edited, re-authored, or mismatched comment fails closed. Immediately before the tag reference and draft publication calls, it rechecks protected main/tag, the active and complete comment history, Check/run provenance, build lock, release/asset inventory, and immutable-releases gate; an already-created tag is not release authorization.

A failed promotion may resume only with the identical candidate, build run, and bytes while that candidate remains current protected `main`. A correct annotated tag is reusable. The workflow discovers exactly one draft/published release with `listReleases`, persists its release ID, and thereafter operates only by release/asset ID. Every asset already present in a draft is downloaded and digest-checked first; the workflow may append missing assets but never deletes, replaces, or uses `--clobber`. After upload it snapshots every asset ID/name/size/update time, downloads all four assets including the manifest, and recalculates every digest. Immediately before publication it revalidates main, tag, Check/comment/run evidence, the build lock, release identity, asset inventory, and immutable-releases setting. After publication it rereads the same evidence and proves that the tag still targets the candidate, main has not moved, assets are unchanged, and the Release is `immutable=true`. Re-dispatching an already-published release performs the same read-only audit; any missing or changed state fails closed.

Files at the attested tag are immutable. Later documentation corrections belong to a later version.

### 8. Failure and Evidence

- Any build, signing, notarization, license, four-cell AE, provider/Tool Library, attestation, or promotion failure blocks both platforms.
- Retain the canonical manifest, Mac/Windows reports, Check URLs, workflow run/artifact IDs, signing/license evidence, and final release digests.
- Provider configuration and credentials are not exportable; diagnostics and attestations contain redacted metadata only.
- Issue/PR closure links concrete tests and artifact evidence. Automated green status never substitutes for AE hardware acceptance.
