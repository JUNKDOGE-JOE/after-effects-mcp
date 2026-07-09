# 双平台不可变 RC 与发布闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 protected `main` 的同一 v0.9.1 candidate SHA 一次构建、签名并验证 Mac arm64 与 Windows x64 产物，以 Mac/Windows attestation Checks 放行并原样提升到最终 GitHub Release。

**Architecture:** 平台计划提供 deterministic unsigned staging CLI；本计划新增稳定 manifest/attestation 数据契约、平台签名编排和 trusted GitHub workflows。实机验证者只下载指定 workflow artifact，报告绑定 run ID、artifact ID 与 SHA-256；最终 release workflow 不运行 build，只下载并复核已验证 bytes、创建 tag、上传资产。

**Tech Stack:** Node.js 24 ESM + `node:test`、GitHub Actions、GitHub Checks API、ZXPSignCmd、Apple `codesign`/`notarytool`/`stapler`、Windows SignTool/Authenticode、Bash、PowerShell 7.6。

## Global Constraints

- Candidate 必须是 protected `main` 当前可达 SHA；fork/未保护 branch 不能取得 signing secrets。
- 每个 candidate SHA 只能取得一次签名构建锁；失败、取消或部分产物均永久拒绝该 SHA，修复后必须产生新 SHA。
- macOS build runner 固定 `macos-15`（arm64），并硬校验 `uname -m == arm64`；`MACOSX_DEPLOYMENT_TARGET=14.0`。
- Windows build runner 固定 `windows-2025` x64，并硬校验 `$env:PROCESSOR_ARCHITECTURE -eq 'AMD64'`。
- GitHub 当前 `macos-15` 是 arm64；不使用会漂移的 `macos-latest`。兼容 smoke 在 runner 可用期间额外跑 `macos-14`。
- 版本固定 v0.9.1；artifact 名固定，不允许手工改名后复用旧 manifest。
- 核心包离线自包含，签名 job 不运行 `npm install`/`pip install` 从开放版本范围解析依赖；只消费平台计划锁定的 runtime/bundle。
- Mac/Windows 实机均验证 AE 25.x 与 26.x；Windows Codex 只测试/评论，不改代码。
- `PASS`、candidate SHA、workflow run/artifact ID、artifact SHA-256 必须同时匹配；后续有效 `FAIL`、评论编辑/删除使旧 Check 失效。
- Release 只提升 RC bytes，禁止 tag 后 rebuild。
- Workflow actions 固定到审核过的 commit：checkout `de0fac2e4500dabe0009e67214ff5f5447ce83dd`（v6.0.2）、upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`（v7.0.1）、download-artifact `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`（v8.0.1）、github-script `3a2844b7e9c422d3c10d287c895573f7108da1b3`（v9.0.0）。

---

## File Structure

### Create

- `scripts/release/artifact-manifest.mjs` — canonical manifest、SHA-256、artifact inventory。
- `scripts/release/attestation.mjs` — attestation schema builder/validator。
- `scripts/release/comment-marker.mjs` — PR comment marker encode/decode。
- `scripts/release/run-signing-plan.mjs` — 仅调用平台计划已审阅 signing entry points 的 release adapter。
- `scripts/release/signing-report.mjs` — canonical、脱敏的签名与验签结果。
- `scripts/release/write-attestation.mjs` — CLI 生成 canonical Mac/Windows report。
- `scripts/release/smoke-installed-runtime.mjs` — 仅通过已安装 stable launcher 验证 bundled runtime 与 AE。
- `scripts/release/verify-release-inputs.mjs` — candidate/main、manifest、artifact、attestation consistency gate。
- `scripts/release/test/artifact-manifest.test.mjs`
- `scripts/release/test/attestation.test.mjs`
- `scripts/release/test/comment-marker.test.mjs`
- `scripts/release/test/signing-plan.test.mjs`
- `scripts/release/test/smoke-installed-runtime.test.mjs`
- `scripts/release/test/verify-release-inputs.test.mjs`
- `scripts/release/verify-rc-macos.sh` — Mac artifact/install/AE checklist wrapper。
- `scripts/release/verify-rc-windows.ps1` — Windows artifact/install/AE checklist wrapper。
- `.github/workflows/build-rc.yml` — protected candidate signed build。
- `.github/workflows/attestation.yml` — comment validation + platform Check。
- `.github/workflows/release.yml` — no-rebuild promotion/tag/release。
- `docs/WINDOWS_CODEX_RC_PROMPT.md` — 固定 Windows Codex handoff prompt。

### Modify

- `.github/workflows/ci.yml` — fast release module contract tests；native matrix/unsigned bundle verification 继续由平台计划的 `platform-foundation-ci.yml` 负责。
- `docs/RELEASE.md` — v0.9.1 immutable RC 流程。
- `README.md` — 双平台支持/安装资产与外部可选 CLI。
- `CHANGELOG.md` — v0.9.1 release entry。
- Task 7 列出的所有 package、lock、Panel 常量、manifest 与用户文档版本源。

### Consumed Interfaces

平台计划必须先提供：

```text
node scripts/package/stage-platform-bundle.mjs \
  --platform <macos-arm64|windows-x64> \
  --version <semver> \
  --out <absolute-dir>

node scripts/package/verify-platform-bundle.mjs \
  --root <absolute-dir> \
  --platform <macos-arm64|windows-x64> \
  --version <semver>
```

`stage-platform-bundle.mjs` writes `<out>/bundle-manifest.json`:

```json
{
  "schemaVersion": 1,
  "version": "0.9.1",
  "platform": "macos-arm64",
  "sourceCommitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "files": [
    {"path":"runtime/bin/node","sha256":"64-hex","mode":"0755","role":"runtime","signing":"apple-developer-id"}
  ]
}
```

`signing` 只允许 `none`、`apple-developer-id`、`authenticode`。

## Spec Coverage

| Spec section | Tasks |
|---|---|
| §3.3 offline/self-contained artifacts | 1, 4, 6 |
| §5.3 nested signing/ZXP/DMG | 3, 4 |
| §10 final RC order | 5–8 |
| §11 immutable build/attest/promotion | 1–6, 8 |
| §12.4 four-cell AE/release tests | 4, 5, 8 |
| §13 dual-platform DONE | 8 |

---

### Task 1: Canonical artifact manifest

**Files:**
- Create: `scripts/release/artifact-manifest.mjs`
- Create: `scripts/release/test/artifact-manifest.test.mjs`

**Interfaces:**
- Consumes: `{version, candidateSha, workflowRunId, artifacts: [{name,path,platform,artifactId,role}], evidence: [{platform,bundleManifestPath,runtimeInventoryPath,sbomPath,licensesPath,signingReportPath}]}` where role is `install` or `payload`
- Produces: `canonicalStringify(value): string`, `sha256File(path): Promise<string>`, `buildArtifactManifest(input): Promise<ArtifactManifest>`, `verifyArtifactManifest(manifest, root): Promise<string[]>`
- `ArtifactManifest.evidence` embeds each platform's verified bundle manifest, runtime inventory, SBOM, license inventory, and redacted signing report so audit data remains available after Actions artifact expiry.

- [ ] **Step 1: Write the failing manifest tests**

  Create `scripts/release/test/artifact-manifest.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { mkdtemp, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';
  import {
    buildArtifactManifest,
    canonicalStringify,
    verifyArtifactManifest,
  } from '../artifact-manifest.mjs';

  test('manifest is canonical and binds exact artifact bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ae-mcp-release-'));
    await writeFile(join(root, 'mac.zxp'), 'mac-bytes');
    const candidateSha = 'a'.repeat(40);
    const evidence = [];
    for (const platform of ['macos-arm64', 'windows-x64']) {
      const files = Object.fromEntries(['bundleManifest', 'runtimeInventory', 'sbom', 'licenses', 'signingReport'].map((kind) => [kind, join(root, `${platform}-${kind}.json`)]));
      await writeFile(files.bundleManifest, JSON.stringify({ schemaVersion: 1, platform, sourceCommitSha: candidateSha }));
      await writeFile(files.runtimeInventory, JSON.stringify({ schemaVersion: 1, platform, components: [] }));
      await writeFile(files.sbom, JSON.stringify({ spdxVersion: 'SPDX-2.3', name: platform }));
      await writeFile(files.licenses, JSON.stringify({ schemaVersion: 1, platform, licenses: [] }));
      await writeFile(files.signingReport, JSON.stringify({ schemaVersion: 1, platform, candidateSha, result: 'PASS' }));
      evidence.push({ platform, bundleManifestPath: files.bundleManifest, runtimeInventoryPath: files.runtimeInventory, sbomPath: files.sbom, licensesPath: files.licenses, signingReportPath: files.signingReport });
    }
    const manifest = await buildArtifactManifest({
      version: '0.9.1',
      candidateSha,
      workflowRunId: '42',
      artifacts: [{ name: 'mac.zxp', path: join(root, 'mac.zxp'), platform: 'macos-arm64', artifactId: '100', role: 'install' }],
      evidence,
    });
    assert.equal(manifest.schemaVersion, 1);
    assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(canonicalStringify({ z: 1, a: { d: 2, b: 1 } }), '{"a":{"b":1,"d":2},"z":1}\n');
    assert.deepEqual(await verifyArtifactManifest(manifest, root), []);
    await writeFile(join(root, 'mac.zxp'), 'tampered');
    assert.deepEqual(await verifyArtifactManifest(manifest, root), ['sha256 mismatch: mac.zxp']);
  });

  test('manifest rejects mutable or malformed identity fields', async () => {
    await assert.rejects(
      buildArtifactManifest({ version: 'v0.9.1', candidateSha: 'short', workflowRunId: '', artifacts: [] }),
      /invalid version|invalid candidate|at least one artifact/,
    );
  });
  ```

- [ ] **Step 2: Run the test and verify module-not-found failure**

  Run:

  ```bash
  node --test scripts/release/test/artifact-manifest.test.mjs
  ```

  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `artifact-manifest.mjs`.

- [ ] **Step 3: Implement canonical manifest functions**

  Create `scripts/release/artifact-manifest.mjs` with these exact exports and validation rules:

  ```js
  import { createHash } from 'node:crypto';
  import { createReadStream } from 'node:fs';
  import { readFile } from 'node:fs/promises';
  import { basename, join } from 'node:path';

  const VERSION = /^\d+\.\d+\.\d+$/;
  const SHA = /^[a-f0-9]{40}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);

  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
    }
    return value;
  }

  export function canonicalStringify(value) {
    return JSON.stringify(sortValue(value)) + '\n';
  }

  export async function sha256File(path) {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return hash.digest('hex');
  }

  export async function buildArtifactManifest(input) {
    const version = String(input.version || '');
    const candidateSha = String(input.candidateSha || '').toLowerCase();
    const workflowRunId = String(input.workflowRunId || '');
    if (!VERSION.test(version)) throw new Error('invalid version');
    if (!SHA.test(candidateSha)) throw new Error('invalid candidate SHA');
    if (!/^\d+$/.test(workflowRunId)) throw new Error('invalid workflow run id');
    if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) throw new Error('at least one artifact is required');
    const artifacts = [];
    for (const item of input.artifacts) {
      const name = basename(String(item.name || ''));
      if (!name || name !== item.name) throw new Error('artifact name must be a basename');
      if (!PLATFORMS.has(item.platform)) throw new Error('invalid artifact platform');
      if (!/^\d+$/.test(String(item.artifactId || ''))) throw new Error('invalid artifact id');
      if (!['install', 'payload'].includes(item.role)) throw new Error('invalid artifact role');
      artifacts.push({
        artifactId: String(item.artifactId),
        name,
        platform: item.platform,
        role: item.role,
        sha256: await sha256File(item.path),
      });
    }
    artifacts.sort((a, b) => a.name.localeCompare(b.name));
    const evidence = [];
    for (const item of input.evidence || []) {
      if (!PLATFORMS.has(item.platform)) throw new Error('invalid evidence platform');
      const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
      const record = {
        platform: item.platform,
        bundleManifest: await readJson(item.bundleManifestPath),
        runtimeInventory: await readJson(item.runtimeInventoryPath),
        sbom: await readJson(item.sbomPath),
        licenses: await readJson(item.licensesPath),
        signingReport: await readJson(item.signingReportPath),
      };
      if (record.bundleManifest.platform !== item.platform || record.bundleManifest.sourceCommitSha !== candidateSha || record.signingReport.platform !== item.platform || record.signingReport.candidateSha !== candidateSha) {
        throw new Error('evidence identity mismatch');
      }
      evidence.push(record);
    }
    evidence.sort((a, b) => a.platform.localeCompare(b.platform));
    return { schemaVersion: 1, version, candidateSha, workflowRunId, artifacts, evidence };
  }

  export async function verifyArtifactManifest(manifest, root) {
    const errors = [];
    if (manifest?.schemaVersion !== 1 || !VERSION.test(String(manifest?.version || '')) || !SHA.test(String(manifest?.candidateSha || ''))) {
      return ['invalid manifest identity'];
    }
    for (const item of manifest.artifacts || []) {
      if (!DIGEST.test(String(item.sha256 || ''))) errors.push(`invalid digest: ${item.name}`);
      else if (await sha256File(join(root, item.name)) !== item.sha256) errors.push(`sha256 mismatch: ${item.name}`);
    }
    const evidencePlatforms = (manifest.evidence || []).map((item) => item.platform).sort();
    if (JSON.stringify(evidencePlatforms) !== JSON.stringify(['macos-arm64', 'windows-x64'])) errors.push('missing dual-platform build evidence');
    for (const item of manifest.evidence || []) {
      if (item?.bundleManifest?.platform !== item.platform || item?.bundleManifest?.sourceCommitSha !== manifest.candidateSha || item?.signingReport?.platform !== item.platform || item?.signingReport?.candidateSha !== manifest.candidateSha) errors.push(`evidence identity mismatch: ${item.platform}`);
    }
    return errors;
  }
  ```

- [ ] **Step 4: Run manifest tests**

  Run:

  ```bash
  node --test scripts/release/test/artifact-manifest.test.mjs
  ```

  Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/release/artifact-manifest.mjs scripts/release/test/artifact-manifest.test.mjs
  git commit -m "feat(release): add canonical artifact manifest"
  ```

### Task 2: Canonical Mac/Windows attestation and PR marker

**Files:**
- Create: `scripts/release/attestation.mjs`
- Create: `scripts/release/comment-marker.mjs`
- Create: `scripts/release/test/attestation.test.mjs`
- Create: `scripts/release/test/comment-marker.test.mjs`

**Interfaces:**
- Produces: `validateAttestation(value, expected): string[]`, `encodeAttestationComment(report): string`, `decodeAttestationComment(body): Attestation`
- Attestation identity: `{schemaVersion:1, platform, result, candidateSha, workflowRunId, artifactId, artifactName, artifactSha256, osVersion, codexVersion, ae:[{major,version,result}], commands, failures}`

- [ ] **Step 1: Write failing schema and marker tests**

  Create `scripts/release/test/attestation.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { validateAttestation } from '../attestation.mjs';

  const valid = {
    schemaVersion: 1,
    platform: 'windows-x64',
    result: 'PASS',
    candidateSha: 'b'.repeat(40),
    workflowRunId: '42',
    artifactId: '101',
    artifactName: 'ae-mcp-panel-v0.9.1-windows-x64.zxp',
    artifactSha256: 'c'.repeat(64),
    osVersion: 'Windows 11 24H2',
    codexVersion: '0.144.0-alpha.4',
    ae: [{ major: 25, version: '25.6.0', result: 'PASS' }, { major: 26, version: '26.3.0', result: 'PASS' }],
    commands: [{ command: 'node --test', exitCode: 0 }],
    failures: [],
  };

  test('PASS requires both AE majors and exact artifact identity', () => {
    assert.deepEqual(validateAttestation(valid, { platform: 'windows-x64', candidateSha: valid.candidateSha, artifactId: '101', artifactSha256: valid.artifactSha256 }), []);
    assert.match(validateAttestation({ ...valid, ae: valid.ae.slice(0, 1) }, {})[0], /AE 25 and 26/);
    assert.match(validateAttestation({ ...valid, artifactSha256: 'd'.repeat(64) }, { artifactSha256: valid.artifactSha256 })[0], /digest/);
  });

  test('FAIL report remains structurally valid and carries evidence', () => {
    const report = { ...valid, result: 'FAIL', ae: [{ major: 25, version: '25.6.0', result: 'FAIL' }], failures: ['panel did not load'] };
    assert.deepEqual(validateAttestation(report, {}), []);
  });
  ```

  Create `scripts/release/test/comment-marker.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { encodeAttestationComment, decodeAttestationComment } from '../comment-marker.mjs';

  test('comment round-trips one canonical report and rejects extra markers', () => {
    const report = { schemaVersion: 1, platform: 'macos-arm64', result: 'PASS' };
    const body = encodeAttestationComment(report);
    assert.deepEqual(decodeAttestationComment(body), report);
    assert.throws(() => decodeAttestationComment(body + '\n' + body), /exactly one attestation marker/);
  });
  ```

- [ ] **Step 2: Run tests and verify missing modules**

  ```bash
  node --test scripts/release/test/attestation.test.mjs scripts/release/test/comment-marker.test.mjs
  ```

  Expected: FAIL with two `ERR_MODULE_NOT_FOUND` errors.

- [ ] **Step 3: Implement strict validation and marker parsing**

  `scripts/release/attestation.mjs` must implement this exact decision core:

  ```js
  const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
  const RESULTS = new Set(['PASS', 'FAIL']);
  const SHA = /^[a-f0-9]{40}$/;
  const DIGEST = /^[a-f0-9]{64}$/;

  export function validateAttestation(value, expected = {}) {
    const errors = [];
    if (value?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
    if (!PLATFORMS.has(value?.platform)) errors.push('invalid platform');
    if (!RESULTS.has(value?.result)) errors.push('invalid result');
    if (!SHA.test(String(value?.candidateSha || ''))) errors.push('invalid candidate SHA');
    if (!DIGEST.test(String(value?.artifactSha256 || ''))) errors.push('invalid artifact digest');
    if (!/^\d+$/.test(String(value?.workflowRunId || '')) || !/^\d+$/.test(String(value?.artifactId || ''))) errors.push('invalid workflow/artifact id');
    if (!String(value?.artifactName || '') || !String(value?.osVersion || '') || !String(value?.codexVersion || '')) errors.push('artifactName, osVersion, and codexVersion are required');
    if (!Array.isArray(value?.commands) || !value.commands.every((x) => String(x?.command || '') && Number.isInteger(x?.exitCode))) errors.push('invalid commands');
    if (!Array.isArray(value?.failures) || !value.failures.every((x) => typeof x === 'string' && x.length > 0)) errors.push('invalid failures');
    if (!Array.isArray(value?.ae) || !value.ae.every((x) => [25, 26].includes(Number(x?.major)) && /^\d+\.\d+/.test(String(x?.version || '')) && RESULTS.has(x?.result))) errors.push('invalid AE results');
    if (value?.result === 'PASS') {
      const passed = new Set((value.ae || []).filter((x) => x.result === 'PASS').map((x) => Number(x.major)));
      if (!passed.has(25) || !passed.has(26)) errors.push('PASS requires AE 25 and 26');
      if ((value.failures || []).length) errors.push('PASS cannot contain failures');
      if ((value.commands || []).some((x) => x.exitCode !== 0)) errors.push('PASS requires zero exit codes');
    } else if (!(value?.failures || []).length) errors.push('FAIL requires failure evidence');
    if (expected.platform && value?.platform !== expected.platform) errors.push('platform mismatch');
    if (expected.candidateSha && value?.candidateSha !== expected.candidateSha) errors.push('candidate mismatch');
    if (expected.artifactId && String(value?.artifactId) !== String(expected.artifactId)) errors.push('artifact id mismatch');
    if (expected.artifactSha256 && value?.artifactSha256 !== expected.artifactSha256) errors.push('artifact digest mismatch');
    return errors;
  }
  ```

  `scripts/release/comment-marker.mjs` must use one non-nestable marker and one JSON fence:

  ```js
  const MARKER = '<!-- ae-mcp-rc-attestation:v1 -->';
  const BLOCK = /<!-- ae-mcp-rc-attestation:v1 -->\s*```json\s*([\s\S]*?)\s*```/g;

  export function encodeAttestationComment(report) {
    return `${MARKER}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  }

  export function decodeAttestationComment(body) {
    const matches = [...String(body || '').matchAll(BLOCK)];
    if (matches.length !== 1) throw new Error('expected exactly one attestation marker');
    return JSON.parse(matches[0][1]);
  }
  ```

- [ ] **Step 4: Run tests**

  ```bash
  node --test scripts/release/test/attestation.test.mjs scripts/release/test/comment-marker.test.mjs
  ```

  Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/release/attestation.mjs scripts/release/comment-marker.mjs scripts/release/test/attestation.test.mjs scripts/release/test/comment-marker.test.mjs
  git commit -m "feat(release): define RC attestation contract"
  ```

### Task 3: Bind release signing to the foundation scripts and emit canonical reports

**Files:**
- Create: `scripts/release/run-signing-plan.mjs`
- Create: `scripts/release/signing-report.mjs`
- Create: `scripts/release/test/signing-plan.test.mjs`
- Read: `scripts/package/signing-plan.mjs`
- Read: `scripts/package/sign-macos-nested.sh`
- Read: `scripts/package/sign-windows-nested.ps1`
- Read: `scripts/package/build-zxp.mjs`
- Read: `scripts/package/package-macos-dmg.sh`

**Interfaces:**
- Consumes the foundation export `buildSigningPlan(platform): SigningPlan` and its exact `SigningStepId` order; this task must not define a second signing order.
- Produces `buildReleaseSigningCommands(input): ReadonlyArray<ReleaseSigningCommand>`, `redactReleaseSigningCommand(command): ReleaseSigningCommand`, and `runReleaseSigning(input,{execFileImpl,readEvidence}): Promise<SigningReportV1>`.
- Produces `buildSigningReport({platform,candidateSha,sourceStageSha256,plan,stepEvidence,outputs,identity}): Promise<SigningReportV1>`.
- `SigningReportV1` contains only candidate/platform identity, foundation step IDs, exit codes, input/output digests, certificate/team fingerprints, notary submission ID, and final output SHA-256 values. It never contains certificate bytes, passwords, environment values, raw stdout/stderr, or absolute secret paths.

- [ ] **Step 1: Write failing adapter/order/redaction tests**

  Create `scripts/release/test/signing-plan.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { buildSigningPlan } from '../../package/signing-plan.mjs';
  import {
    buildReleaseSigningCommands,
    redactReleaseSigningCommand,
    validateReleaseStepEvidence,
  } from '../run-signing-plan.mjs';

  test('Mac release invokes only the reviewed foundation signing entry points', () => {
    assert.deepEqual(buildSigningPlan('macos-arm64').steps.map((step) => step.id), [
      'sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher',
      'verify-nested', 'sign-zxp', 'verify-zxp', 'build-dmg',
      'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-gatekeeper',
    ]);
    const commands = buildReleaseSigningCommands({
      platform: 'macos-arm64',
      candidateSha: 'a'.repeat(40),
      version: '0.9.1',
      stageRoot: '/work/unsigned',
      signingRoot: '/work/signed',
      outRoot: '/work/out',
    });
    assert.deepEqual(commands.map((command) => command.label), [
      'sign-macos-nested', 'sign-zxp', 'package-macos-dmg',
    ]);
    assert.deepEqual(commands.map((command) => command.file), [
      'bash', process.execPath, 'bash',
    ]);
  });

  test('Windows release invokes only the reviewed foundation signing entry points', () => {
    assert.deepEqual(buildSigningPlan('windows-x64').steps.map((step) => step.id), [
      'sign-helper', 'sign-addon', 'sign-launcher',
      'verify-authenticode', 'sign-zxp', 'verify-zxp',
    ]);
    const commands = buildReleaseSigningCommands({
      platform: 'windows-x64',
      candidateSha: 'b'.repeat(40),
      version: '0.9.1',
      stageRoot: 'C:\\work\\unsigned',
      signingRoot: 'C:\\work\\signed',
      outRoot: 'C:\\work\\out',
    });
    assert.deepEqual(commands.map((command) => command.label), [
      'sign-windows-nested', 'sign-zxp',
    ]);
  });

  test('reports reject reordered or secret-bearing step evidence', () => {
    const plan = buildSigningPlan('windows-x64');
    const evidence = plan.steps.map((step) => ({
      id: step.id,
      inputSha256: 'c'.repeat(64),
      outputSha256: 'd'.repeat(64),
      exitCode: 0,
    }));
    assert.doesNotThrow(() => validateReleaseStepEvidence(plan, evidence));
    assert.throws(() => validateReleaseStepEvidence(plan, evidence.toReversed()), /step order/);
    const command = {
      file: process.execPath,
      args: ['scripts/package/build-zxp.mjs', '--password', 'zxp-secret'],
      label: 'sign-zxp',
      secretArgIndexes: [2],
    };
    assert.equal(JSON.stringify(redactReleaseSigningCommand(command)).includes('zxp-secret'), false);
  });
  ```

- [ ] **Step 2: Run the test and verify RED**

  ```bash
  node --test scripts/release/test/signing-plan.test.mjs
  ```

  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `run-signing-plan.mjs`.

- [ ] **Step 3: Implement the thin release adapter**

  `buildReleaseSigningCommands()` validates version `0.9.1`, a 40-lowercase-hex candidate, absolute non-overlapping stage/signing/output roots, and an empty signing root. It never mutates the unsigned stage: it first copies the verified stage to the signing root and records `sourceStageSha256`.

  It returns these exact commands:

  ```text
  macos-arm64:
    bash scripts/package/sign-macos-nested.sh --root <signing-root> --evidence <nested-evidence.json>
    node scripts/package/build-zxp.mjs --root <signing-root> --platform macos-arm64 --out <ae-mcp-panel-v0.9.1-macos-arm64.zxp> --evidence <zxp-evidence.json>
    bash scripts/package/package-macos-dmg.sh --zxp <ae-mcp-panel-v0.9.1-macos-arm64.zxp> --out <ae-mcp-panel-v0.9.1-macos-arm64.dmg> --evidence <dmg-evidence.json>

  windows-x64:
    pwsh -NoProfile -File scripts/package/sign-windows-nested.ps1 -Root <signing-root> -Evidence <nested-evidence.json>
    node scripts/package/build-zxp.mjs --root <signing-root> --platform windows-x64 --out <ae-mcp-panel-v0.9.1-windows-x64.zxp> --evidence <zxp-evidence.json>
  ```

  Angle-bracketed terms above are typed command fields populated from validated absolute inputs; they are not literal arguments. `runReleaseSigning()` imports `buildSigningPlan()`, executes only these reviewed foundation entry points with `shell:false`, reads their canonical evidence files, and calls `validateReleaseStepEvidence()`. The concatenated evidence IDs must equal the foundation plan IDs exactly and in order. Missing, duplicate, reordered, non-zero, identity-mismatched, or post-signing-mutated evidence fails the candidate.

  The scripts read signing values only from the protected process environment:

  ```text
  AE_MCP_APPLE_SIGNING_IDENTITY
  AE_MCP_NOTARY_KEYCHAIN_PROFILE
  AE_MCP_WINDOWS_SIGNING_CERT_SHA1
  AE_MCP_WINDOWS_TIMESTAMP_URL
  AE_MCP_ZXP_SIGN_CMD
  AE_MCP_ZXP_CERT_PATH
  AE_MCP_ZXP_CERT_PASSWORD
  ```

  `redactReleaseSigningCommand()` replaces every declared secret argument with `<redacted>`; workflow logs and reports serialize only that result. Errors contain the step label and exit code, never the child-process error object or raw output.

- [ ] **Step 4: Implement and test the canonical signing report**

  `signing-report.mjs` validates exact candidate/platform identity, requires every foundation step exactly once with exit code 0, hashes final ZXP/DMG outputs using streaming SHA-256, and writes through `canonicalStringify()`. Tests inject sentinel values for all signing secrets and assert none appears in the report, thrown errors, command audit, or fixture snapshots.

  Mac reports additionally require a notary submission ID, stapled-ticket result, Gatekeeper result, Developer ID Team ID, and ZXP verification. Windows reports require Authenticode signer thumbprint/timestamp verification and ZXP verification.

- [ ] **Step 5: Run focused tests**

  ```bash
  node --test scripts/package/test/signing-plan.test.mjs scripts/release/test/signing-plan.test.mjs
  ```

  Expected: both foundation and release suites PASS; no signing executable is invoked by unit tests.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/release/run-signing-plan.mjs scripts/release/signing-report.mjs scripts/release/test/signing-plan.test.mjs
  git commit -m "build: bind RC signing to reviewed platform scripts"
  ```

### Task 4: Platform RC verification wrappers and fixed Windows Codex prompt

**Files:**
- Create: `scripts/release/write-attestation.mjs`
- Create: `scripts/release/smoke-installed-runtime.mjs`
- Create: `scripts/release/verify-rc-macos.sh`
- Create: `scripts/release/verify-rc-windows.ps1`
- Create: `docs/WINDOWS_CODEX_RC_PROMPT.md`
- Test: `scripts/release/test/attestation.test.mjs`
- Test: `scripts/release/test/smoke-installed-runtime.test.mjs`

**Interfaces:**
- `write-attestation.mjs --platform --candidate-sha --run-id --artifact-id --artifact --manifest --os-version --codex-version --ae25-version --ae25-result --ae26-version --ae26-result --commands-json --failures-json --out`
- `smoke-installed-runtime.mjs --launcher --runtime-manifest --expected-platform --expected-version --expected-ae-major --out`
- Produces canonical JSON and prints the exact PR comment body to stdout.

- [ ] **Step 1: Add failing CLI fixture test**

  Append to `scripts/release/test/attestation.test.mjs` a subprocess test that invokes `write-attestation.mjs` against a temp artifact/manifest and asserts: missing AE 26 exits non-zero; both PASS writes JSON whose candidate/artifact digest match the manifest; `FAIL` requires non-empty failures.

  Run:

  ```bash
  node --test scripts/release/test/attestation.test.mjs
  ```

  Expected: FAIL because `write-attestation.mjs` does not exist.

- [ ] **Step 2: Implement write-attestation CLI**

  Create `scripts/release/write-attestation.mjs`:

  ```js
  import { chmod, readFile, writeFile } from 'node:fs/promises';
  import { basename } from 'node:path';
  import { parseArgs } from 'node:util';
  import { canonicalStringify, sha256File } from './artifact-manifest.mjs';
  import { validateAttestation } from './attestation.mjs';
  import { encodeAttestationComment } from './comment-marker.mjs';

  const { values } = parseArgs({
    strict: true,
    options: Object.fromEntries([
      'platform', 'candidate-sha', 'run-id', 'artifact-id', 'artifact', 'manifest',
      'os-version', 'codex-version', 'ae25-version', 'ae25-result',
      'ae26-version', 'ae26-result', 'commands-json', 'failures-json', 'out',
    ].map((name) => [name, { type: 'string' }])),
  });

  function required(name) {
    const value = String(values[name] || '');
    if (!value) throw new Error(`missing --${name}`);
    return value;
  }

  const manifest = JSON.parse(await readFile(required('manifest'), 'utf8'));
  const artifactPath = required('artifact');
  const artifactName = basename(artifactPath);
  const artifactId = required('artifact-id');
  const entry = (manifest.artifacts || []).find((item) => item.name === artifactName && String(item.artifactId) === artifactId);
  if (!entry) throw new Error('artifact is not present in manifest');
  const digest = await sha256File(artifactPath);
  if (digest !== entry.sha256) throw new Error('local artifact digest does not match manifest');
  const commands = JSON.parse(required('commands-json'));
  const failures = JSON.parse(required('failures-json'));
  const ae = [
    { major: 25, version: required('ae25-version'), result: required('ae25-result') },
    { major: 26, version: required('ae26-version'), result: required('ae26-result') },
  ];
  const result = ae.every((item) => item.result === 'PASS') && failures.length === 0 ? 'PASS' : 'FAIL';
  const report = {
    schemaVersion: 1,
    platform: required('platform'),
    result,
    candidateSha: required('candidate-sha'),
    workflowRunId: required('run-id'),
    artifactId,
    artifactName,
    artifactSha256: digest,
    osVersion: required('os-version'),
    codexVersion: required('codex-version'),
    ae,
    commands,
    failures,
  };
  const errors = validateAttestation(report, {
    platform: entry.platform,
    candidateSha: manifest.candidateSha,
    artifactId: entry.artifactId,
    artifactSha256: entry.sha256,
  });
  if (errors.length) throw new Error(errors.join('; '));
  const out = required('out');
  await writeFile(out, canonicalStringify(report), 'utf8');
  try { await chmod(out, 0o600); } catch { /* Windows ACL is enforced by the wrapper. */ }
  process.stdout.write(encodeAttestationComment(report));
  ```

  Never accept a caller-supplied digest without recomputing it.

- [ ] **Step 3: Add a failing installed-runtime smoke harness test**

  Create `scripts/release/test/smoke-installed-runtime.test.mjs` with a fake stable launcher and fixture host. Assert that the harness:

  - rejects a launcher outside the runtime selected by the atomic `current` pointer;
  - rejects platform, version, runtime-manifest digest, or AE-major mismatches;
  - starts the exact stable launcher with a sanitized environment that contains no development virtualenv, `UV_*`, `PYTHONPATH`, or repository package path;
  - performs MCP `initialize` and `tools/list`, then calls `ae.status`, `ae.diagnose`, `ae.previewFrame`, and `ae.snapshot`;
  - records structured results without provider values, environment values, or local auth tokens.

  Run:

  ```bash
  node --test scripts/release/test/smoke-installed-runtime.test.mjs
  ```

  Expected: FAIL because `scripts/release/smoke-installed-runtime.mjs` does not exist.

- [ ] **Step 4: Implement the installed-runtime smoke harness**

  `smoke-installed-runtime.mjs` must parse the installed `runtime-manifest.json`, resolve the stable launcher through the atomic `current` pointer, verify every runtime file digest before spawn, and use the launcher's stdio MCP transport. It must fail unless all six checks succeed and `ae.status` reports the requested product version and AE major. The harness may run under the verifier's Node, but the MCP process under test must be the installed stable launcher and bundled Python; it must never invoke `uv`, `python`, `pip`, or repository source.

  A successful output file has this exact top-level shape:

  ```json
  {
    "schemaVersion": 1,
    "platform": "macos-arm64",
    "version": "0.9.1",
    "aeMajor": 25,
    "launcher": "/Users/example/.ae-mcp/bin/ae-mcp",
    "runtimeManifestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "checks": [
      {"name": "initialize", "result": "PASS"},
      {"name": "tools/list", "result": "PASS"},
      {"name": "ae.status", "result": "PASS"},
      {"name": "ae.diagnose", "result": "PASS"},
      {"name": "ae.previewFrame", "result": "PASS"},
      {"name": "ae.snapshot", "result": "PASS"}
    ]
  }
  ```

  The implementation writes the actual absolute launcher path; `example` is test-fixture data, not a release value.

- [ ] **Step 5: Implement platform wrappers**

  `verify-rc-macos.sh` must use `set -euo pipefail`, run `shasum -a 256`, `codesign --verify --deep --strict`, `spctl --assess`, `xcrun stapler validate`, install the exact DMG/ZXP, launch each installed AE version once so Panel finishes the offline runtime install, and invoke:

  ```bash
  node scripts/release/smoke-installed-runtime.mjs \
    --launcher "$HOME/.ae-mcp/bin/ae-mcp" \
    --runtime-manifest "$HOME/.ae-mcp/runtime/0.9.1/macos-arm64/runtime-manifest.json" \
    --expected-platform macos-arm64 \
    --expected-version 0.9.1 \
    --expected-ae-major 25 \
    --out "$TMPDIR/ae-mcp-ae25-smoke.json"
  ```

  It repeats the exact command with AE 26 and a separate output path. It writes commands/results to a temp JSON array and calls `write-attestation.mjs`. Missing stable launcher, missing bundled runtime, any repository-Python fallback, or either smoke failure makes the attestation `FAIL`.

  `verify-rc-windows.ps1` must use `$ErrorActionPreference='Stop'`, `Get-FileHash -Algorithm SHA256`, `Get-AuthenticodeSignature`, install the exact ZXP, launch each installed AE version once, and run `smoke-installed-runtime.mjs` twice with:

  ```powershell
  --launcher "$env:USERPROFILE\.ae-mcp\bin\ae-mcp.exe"
  --runtime-manifest "$env:USERPROFILE\.ae-mcp\runtime\0.9.1\windows-x64\runtime-manifest.json"
  --expected-platform windows-x64
  --expected-version 0.9.1
  --expected-ae-major 25
  ```

  It repeats with AE 26, then calls the same Node attestation CLI. It must never invoke `uv`, system Python, `git add`, `git commit`, source edits, or package rebuild. Repository tests may be run separately for diagnosis, but their result cannot turn a failed installed-runtime smoke into `PASS`.

- [ ] **Step 6: Write the fixed Windows Codex handoff prompt**

  `docs/WINDOWS_CODEX_RC_PROMPT.md` must contain this exact instruction block:

  ```text
  You are the Windows x64 release verifier for ae-mcp. Test and report only; do not modify files, commit, push, or rebuild artifacts.

  1. Fetch the repository and checkout the exact candidate SHA supplied below.
  2. Confirm `git status --short` is empty and `git rev-parse HEAD` equals the candidate SHA.
  3. Download only the specified GitHub Actions run/artifact ID.
  4. Run `scripts/release/verify-rc-windows.ps1` with the supplied artifact and manifest.
  5. Exercise AE 25.x and AE 26.x using the script checklist; capture failure evidence without changing source.
  6. Post the exact comment emitted by `write-attestation.mjs` to the supplied merged RC PR.
  7. If any step fails, report FAIL. Never convert a partial run into PASS.

  Required inputs: repository, merged RC PR number, candidate SHA, workflow run ID, artifact ID, artifact filename, manifest filename.
  ```

- [ ] **Step 7: Run tests and shell syntax checks**

  ```bash
  node --test scripts/release/test/attestation.test.mjs scripts/release/test/smoke-installed-runtime.test.mjs
  bash -n scripts/release/verify-rc-macos.sh
  pwsh -NoProfile -Command '$null = [scriptblock]::Create((Get-Content -Raw scripts/release/verify-rc-windows.ps1))'
  ```

  Expected: tests PASS; Bash and PowerShell parsing exit 0.

- [ ] **Step 8: Commit**

  ```bash
  git add scripts/release/write-attestation.mjs scripts/release/smoke-installed-runtime.mjs scripts/release/verify-rc-macos.sh scripts/release/verify-rc-windows.ps1 scripts/release/test/attestation.test.mjs scripts/release/test/smoke-installed-runtime.test.mjs docs/WINDOWS_CODEX_RC_PROMPT.md
  git commit -m "feat(release): add dual-platform RC verification handoff"
  ```

### Task 5: Attestation comment lifecycle and Checks API gate

**Files:**
- Create: `.github/workflows/attestation.yml`
- Create: `scripts/release/verify-release-inputs.mjs`
- Create: `scripts/release/test/verify-release-inputs.test.mjs`

**Interfaces:**
- `verifyReleaseInputs({candidateSha, mainSha, manifest, attestations}): string[]`
- `reconcileAttestationState(previous, event): AttestationState`
- Check names: `macos-rc-attestation`, `windows-rc-attestation`
- Check external IDs: `ae-mcp-rc:<candidate-sha>:macos-arm64` and `ae-mcp-rc:<candidate-sha>:windows-x64`
- Repo variable: `AE_MCP_RC_ATTESTORS` (comma-separated GitHub logins)
- Environments: `macos-rc`, `windows-rc`

- [ ] **Step 1: Write failing pure gate tests**

  Create `scripts/release/test/verify-release-inputs.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { verifyReleaseInputs } from '../verify-release-inputs.mjs';

  const candidateSha = 'd'.repeat(40);
  const manifest = {
    schemaVersion: 1, version: '0.9.1', candidateSha, workflowRunId: '42',
    artifacts: [
      { platform: 'macos-arm64', role: 'install', artifactId: '100', name: 'mac.dmg', sha256: 'a'.repeat(64) },
      { platform: 'windows-x64', role: 'install', artifactId: '101', name: 'win.zxp', sha256: 'b'.repeat(64) },
    ],
  };
  function report(platform, result, updatedAt) {
    const artifact = manifest.artifacts.find((x) => x.platform === platform);
    return {
      deleted: false, updatedAt,
      report: {
        schemaVersion: 1, platform, result, candidateSha, workflowRunId: '42',
        artifactId: artifact.artifactId, artifactName: artifact.name, artifactSha256: artifact.sha256,
        osVersion: 'supported', codexVersion: '0.144.0-alpha.4',
        ae: [{ major: 25, version: '25.6', result }, { major: 26, version: '26.3', result }],
        commands: [{ command: 'smoke', exitCode: result === 'PASS' ? 0 : 1 }],
        failures: result === 'PASS' ? [] : ['smoke failed'],
      },
    };
  }

  test('both current platform PASS reports release the candidate', () => {
    assert.deepEqual(verifyReleaseInputs({ candidateSha, mainSha: candidateSha, manifest, attestations: [report('macos-arm64', 'PASS', 1), report('windows-x64', 'PASS', 1)] }), []);
  });

  test('missing, stale, deleted, mismatched, or later FAIL blocks release', () => {
    assert.match(verifyReleaseInputs({ candidateSha, mainSha: candidateSha, manifest, attestations: [report('windows-x64', 'PASS', 1)] })[0], /macos-arm64/);
    assert.match(verifyReleaseInputs({ candidateSha, mainSha: 'e'.repeat(40), manifest, attestations: [] })[0], /protected main/);
    const bad = report('windows-x64', 'PASS', 1); bad.report.artifactSha256 = 'f'.repeat(64);
    assert.match(verifyReleaseInputs({ candidateSha, mainSha: candidateSha, manifest, attestations: [report('macos-arm64', 'PASS', 1), bad] }).join(' '), /digest/);
    const deleted = { ...report('macos-arm64', 'PASS', 2), deleted: true };
    assert.match(verifyReleaseInputs({ candidateSha, mainSha: candidateSha, manifest, attestations: [report('macos-arm64', 'PASS', 1), deleted, report('windows-x64', 'PASS', 1)] }).join(' '), /macos-arm64/);
    assert.match(verifyReleaseInputs({ candidateSha, mainSha: candidateSha, manifest, attestations: [report('macos-arm64', 'PASS', 1), report('windows-x64', 'PASS', 1), report('windows-x64', 'FAIL', 2)] }).join(' '), /windows-x64 attestation is not PASS/);
    assert.match(verifyReleaseInputs({ candidateSha, mainSha: candidateSha, manifest, attestations: [report('macos-arm64', 'PASS', 1), report('windows-x64', 'FAIL', 2), report('windows-x64', 'PASS', 3)] }).join(' '), /windows-x64 candidate was rejected by FAIL/);
  });

  test('editing or deleting active evidence cannot revive an older PASS', () => {
    const active = report('windows-x64', 'PASS', 2);
    const tombstone = {
      deleted: true,
      updatedAt: 3,
      platform: 'windows-x64',
      candidateSha,
      artifactId: '101',
      report: null,
    };
    const errors = verifyReleaseInputs({
      candidateSha,
      mainSha: candidateSha,
      manifest,
      attestations: [report('macos-arm64', 'PASS', 1), report('windows-x64', 'PASS', 1), active, tombstone],
    });
    assert.match(errors.join(' '), /windows-x64 current attestation is missing/);
  });
  ```

  Run:

  ```bash
  node --test scripts/release/test/verify-release-inputs.test.mjs
  ```

  Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 2: Implement pure release gate**

  Create `scripts/release/verify-release-inputs.mjs`:

  ```js
  import { validateAttestation } from './attestation.mjs';

  const PLATFORMS = ['macos-arm64', 'windows-x64'];

  export function verifyReleaseInputs({ candidateSha, mainSha, manifest, attestations }) {
    const errors = [];
    if (candidateSha !== mainSha) errors.push('candidate is not protected main HEAD');
    if (manifest?.candidateSha !== candidateSha) errors.push('manifest candidate mismatch');
    if (manifest?.version !== '0.9.1') errors.push('manifest version mismatch');
    for (const platform of PLATFORMS) {
      const artifacts = (manifest?.artifacts || []).filter((x) => x.platform === platform && x.role === 'install');
      if (artifacts.length !== 1) {
        errors.push(`${platform} requires exactly one install artifact`);
        continue;
      }
      const artifact = artifacts[0];
      const candidates = (attestations || [])
        .filter((x) => (x?.platform || x?.report?.platform) === platform && (x?.candidateSha || x?.report?.candidateSha) === candidateSha && String(x?.artifactId || x?.report?.artifactId) === String(artifact.artifactId))
        .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
      if (candidates.some((x) => x?.report?.result === 'FAIL')) {
        errors.push(`${platform} candidate was rejected by FAIL`);
      }
      const latest = candidates.at(-1);
      if (!latest || latest.deleted || !latest.report) {
        errors.push(`${platform} current attestation is missing`);
        continue;
      }
      errors.push(...validateAttestation(latest.report, {
        platform,
        candidateSha,
        artifactId: artifact.artifactId,
        artifactSha256: artifact.sha256,
      }).map((error) => `${platform}: ${error}`));
      if (latest.report.result !== 'PASS') errors.push(`${platform} attestation is not PASS`);
    }
    return [...new Set(errors)].sort();
  }
  ```

  In the same module, implement `reconcileAttestationState()` with this persisted state:

  ```js
  {
    schemaVersion: 1,
    candidateSha,
    platform,
    artifactId,
    activeCommentId: null,
    activeUpdatedAt: 0,
    freshEvidenceAfter: 0,
    candidateRejected: false,
    conclusion: 'failure'
  }
  ```

  A valid `FAIL` for the same candidate/artifact sets `candidateRejected=true` permanently. Editing or deleting the active evidence sets `activeCommentId=null`, advances `freshEvidenceAfter`, and keeps failure; an older PASS can never become active again. A later valid PASS may restore success after a deletion/edit only when `updatedAt > freshEvidenceAfter` and `candidateRejected` is false. Reject state never carries across a different candidate SHA or artifact digest.

- [ ] **Step 3: Create attestation workflow**

  `.github/workflows/attestation.yml` must:

  ```yaml
  name: RC Attestation
  on:
    issue_comment:
      types: [created, edited, deleted]
  permissions:
    actions: read
    checks: write
    contents: read
    issues: read
    pull-requests: read
  concurrency:
    group: rc-attestation-${{ github.event.issue.number }}-${{ github.event.comment.id }}
    cancel-in-progress: true
  ```

  Job layout is fixed so Environment approval is selected before execution:

  1. `parse` (no secrets/environment) checks out the workflow from trusted default branch, requires `github.event.issue.pull_request`, fetches the PR, and requires `merged == true`, `base.ref == 'main'`, `merge_commit_sha == candidate_sha`, and `origin/main == candidate_sha`. It validates the author against `vars.AE_MCP_RC_ATTESTORS`. A create/edit body may contain exactly one marker and at most 48 KiB decoded canonical JSON. For edit/delete with a removed marker, it emits a tombstone keyed by comment ID instead of exiting early.
  2. `validate-macos` runs only when the event or prior Check state targets `macos-arm64`, declares `environment: macos-rc`, and calls the common reconciler.
  3. `validate-windows` runs only when the event or prior Check state targets `windows-x64`, declares `environment: windows-rc`, and calls the same reconciler.

  Each validation job fetches `origin/main`, downloads the named manifest/artifact using GitHub API, recomputes SHA-256, and loads the prior state from the deterministic platform Check output marker `<!-- ae-mcp-attestation-state:v1:<base64url-json> -->`. It applies `reconcileAttestationState()` and uses `actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3` to create/update exactly one Check on `candidateSha`, using external ID `ae-mcp-rc:<candidate-sha>:<platform>`.

  A valid `FAIL` permanently rejects that candidate/platform. Editing or deleting the active PASS changes the Check to `failure` and requires a newer valid PASS; it may not fall back to an older favorable comment. Invalid edits to unrelated comments do not alter the active Check. The Check summary stores no comment body, command output, secret, or provider reference—only the canonical state above and artifact digest.

- [ ] **Step 4: Run tests and validate workflow syntax**

  ```bash
  node --test scripts/release/test/verify-release-inputs.test.mjs
  ruby -e 'require "yaml"; YAML.load_file(".github/workflows/attestation.yml"); puts "ok"'
  ```

  Expected: tests PASS; YAML prints `ok`.

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/attestation.yml scripts/release/verify-release-inputs.mjs scripts/release/test/verify-release-inputs.test.mjs
  git commit -m "ci: gate releases on RC attestations"
  ```

### Task 6: Trusted one-time signed RC build

**Files:**
- Create: `.github/workflows/build-rc.yml`
- Modify: `.github/workflows/ci.yml`
- Read: `.github/workflows/platform-foundation-ci.yml`
- Test: `scripts/release/test/signing-plan.test.mjs`

**Interfaces:**
- Inputs: `candidate_sha` (40 lowercase hex), `version` (`0.9.1` only)
- Environment: `release-signing`
- Outputs: three named packages plus `artifact-manifest-v0.9.1.json`

- [ ] **Step 1: Add workflow contract assertions to signing-plan tests**

  Read `.github/workflows/build-rc.yml` as text and assert it contains `runs-on: macos-15`, `runs-on: windows-2025`, `environment: release-signing`, exact candidate/main equality guard, `checks: write`, `cancel-in-progress: false`, `ae-mcp-build-lock:`, architecture guards, staging CLI, verify CLI, and `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`; assert it does not contain `npm install`, `pip install`, `uv tool install`, `pull_request_target`, or `macos-latest`.

- [ ] **Step 2: Create `build-rc.yml`**

  Workflow requirements:

  ```yaml
  name: Build signed RC
  on:
    workflow_dispatch:
      inputs:
        candidate_sha:
          required: true
          type: string
        version:
          required: true
          type: string
  permissions:
    contents: read
    checks: write
  concurrency:
    group: build-rc-${{ inputs.candidate_sha }}
    cancel-in-progress: false
  ```

  Jobs:

  1. `guard` on `ubuntu-24.04`: validate exact input regex/value, fetch protected `main`, require `git rev-parse origin/main` to equal `candidate_sha`, and require the running workflow file hash to equal the file at `origin/main`. Query Checks on the candidate for external ID `ae-mcp-build-lock:<candidate-sha>`; if any prior lock exists in any status/conclusion, fail before reading signing secrets. Otherwise create one `signed-rc-build` Check with that external ID and `in_progress` before dispatching platform jobs.
  2. `macos` on `macos-15`, environment `release-signing`: checkout candidate, assert `uname -m` is `arm64`, set `MACOSX_DEPLOYMENT_TARGET=14.0`, import the temporary Developer ID keychain, create the ephemeral `ae-mcp-notary-ci` profile from protected API-key secrets, stage/verify unsigned bytes, run the sign plan once, write the redacted signing report, and upload ZXP + DMG + bundle manifest + runtime inventory + SPDX SBOM + licenses + signing report with retention 30 days.
  3. `windows` on `windows-2025`, environment `release-signing`: assert AMD64, import the temporary Authenticode certificate, stage/verify unsigned bytes, run the sign plan once, write the redacted signing report, and upload Windows ZXP plus the same four foundation evidence files and signing report.
  4. `manifest` on `ubuntu-24.04`: download both artifacts, call `buildArtifactManifest()`, and require artifact roles `macOS DMG=install`, `macOS ZXP=payload`, `Windows ZXP=install`. Require exactly one valid evidence set per platform and embed those JSON objects into the canonical manifest. Upload the manifest and expose run/artifact IDs in job summary.
  5. `finalize-lock` runs with `if: always()`, updates the existing deterministic build-lock Check to `success` only when all three jobs succeeded and manifest digests reverify; every other outcome becomes `failure`. An abandoned `in_progress` lock still blocks rerun and therefore rejects the candidate.

  All checkouts use full 40-hex candidate SHA；所有 action 使用 Global Constraints 列出的完整 commit SHA，不使用 mutable tags。

- [ ] **Step 3: Add release contract tests without duplicating foundation CI**

  Keep the platform plan's required `macos-15`, `macos-14-compat`, and `windows-2025` jobs in `.github/workflows/platform-foundation-ci.yml`. Add the release module tests to the existing fast `.github/workflows/ci.yml` job; do not create a second native matrix:

  ```bash
  node --test scripts/release/test/*.test.mjs
  ```

  The workflow contract test must fail if `macos-14-compat` is absent or optional. If GitHub removes the hosted `macos-14` label, the platform workflow moves that unchanged job to `[self-hosted, macOS, ARM64, ae-mcp-macos-14]`; deleting the minimum-OS job requires a separately approved support-matrix change.

- [ ] **Step 4: Run release tests and local bundle dry run**

  ```bash
  node --test scripts/release/test/*.test.mjs
  node scripts/package/stage-platform-bundle.mjs --platform macos-arm64 --version 0.9.1 --out /tmp/ae-mcp-macos-stage
  node scripts/package/verify-platform-bundle.mjs --root /tmp/ae-mcp-macos-stage --platform macos-arm64 --version 0.9.1
  ```

  Expected: tests PASS; local unsigned bundle verifies. Do not invoke signing locally in this step.

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/build-rc.yml .github/workflows/ci.yml scripts/release/test/signing-plan.test.mjs
  git commit -m "ci: build immutable signed platform RCs"
  ```

### Task 7: Synchronize v0.9.1 and release documentation

**Files:**
- Modify: `packages/core/pyproject.toml`
- Modify: `packages/bridge/pyproject.toml`
- Modify: `packages/snapshot-host/pyproject.toml`
- Modify: `plugin/host/package.json`
- Modify: `plugin/host/package-lock.json`
- Modify: `plugin/panel/package.json`
- Modify: `plugin/panel/package-lock.json`
- Modify: `plugin/sidecar/package.json`
- Modify: `plugin/sidecar/package-lock.json`
- Modify: `plugin/CSXS/manifest.xml`
- Modify: `plugin/panel/src/cep/mcpClient.js`
- Modify: `uv.lock`
- Modify: `plugin/client/dist/app.js` (generated only)
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/INSTALL.md`
- Modify: `docs/REFERENCE.md`
- Modify: `docs/RELEASE.md`
- Modify: `docs/WORKFLOW.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: every active version source = `0.9.1`; `plugin/CSXS/manifest.xml` host range = `[25.0,26.9]`.

- [ ] **Step 1: Write a version consistency check**

  Add `scripts/release/test/version-consistency.test.mjs` that parses the exact package manifests, lockfiles, `PANEL_VERSION`, CEP manifest, and user-facing docs above. It expects `0.9.1`, asserts the manifest host range is exactly `[25.0,26.9]`, asserts all three workspace package entries in `uv.lock` are `0.9.1`, and asserts README/install/release examples no longer use online `uv tool install` as the primary user path.

- [ ] **Step 2: Run and verify failure against v0.9.0**

  ```bash
  node --test scripts/release/test/version-consistency.test.mjs
  ```

  Expected: FAIL listing every remaining active `0.9.0` source. The platform foundation has already changed the host range to `[25.0,26.9]`, so that assertion is expected to pass at this point.

- [ ] **Step 3: Update source versions and documentation**

  Set every package/lock/Panel/manifest version source to `0.9.1`; retain `<Host Name="AEFT" Version="[25.0,26.9]" />`. Rewrite `docs/RELEASE.md` around build run → download exact artifacts → dual attestations → no-rebuild promotion. Both READMEs and install/workflow/reference docs name the Mac arm64 and Windows x64 assets and list Claude/Codex/ZCode CLIs as optional channel dependencies.

- [ ] **Step 4: Rebuild tracked Panel dist**

  ```bash
  uv lock
  cd plugin/panel
  npm ci
  npm run build
  cd ../..
  ```

  Expected: `uv.lock` records the three v0.9.1 workspace packages; only intended `plugin/client/dist/app.js`/CSS generated changes appear.

- [ ] **Step 5: Run version test and repository suites**

  ```bash
  node --test scripts/release/test/version-consistency.test.mjs
  uv run pytest -q
  cd plugin/host && npm test
  cd ../panel && npm test
  cd ../sidecar && npm test
  ```

  Expected: all commands PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add packages plugin uv.lock README.md README.zh-CN.md docs/INSTALL.md docs/REFERENCE.md docs/RELEASE.md docs/WORKFLOW.md CHANGELOG.md scripts/release/test/version-consistency.test.mjs
  git commit -m "release: prepare v0.9.1 cross-platform RC"
  ```

### Task 8: No-rebuild release promotion workflow and rehearsal

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `scripts/release/test/verify-release-inputs.test.mjs`
- Modify: `docs/RELEASE.md`

**Interfaces:**
- Inputs: `candidate_sha`, `build_run_id`, `version=0.9.1`
- Requires: successful `macos-rc-attestation` and `windows-rc-attestation` Checks on candidate with external IDs `ae-mcp-rc:<candidate-sha>:macos-arm64` and `ae-mcp-rc:<candidate-sha>:windows-x64`; matching manifest/artifact digests
- Produces: immutable tag `v0.9.1` and GitHub Release assets copied from build run

- [ ] **Step 1: Add failing workflow contract test**

  Assert `release.yml` contains no stage/build/sign commands; requires both Check names; verifies `origin/main == candidate_sha`; downloads the exact build run; calls manifest verification; creates tag only after all gates; uploads the existing files.

- [ ] **Step 2: Create release workflow**

  `.github/workflows/release.yml` uses `workflow_dispatch`, `contents: write`, `checks: read`, environment `release-promotion`, concurrency group `release-v0.9.1`, and one Ubuntu job:

  ```text
  validate inputs and protected-main SHA
  query candidate check-runs; require exactly one current success for each deterministic external ID and reject any sticky candidateRejected state
  download artifacts from build_run_id and require the manifest workflowRunId to match
  verify canonical manifest and all SHA-256 values
  verify manifest candidate/version/run IDs
  create annotated v0.9.1 tag at candidate SHA (fail if tag exists elsewhere)
  push the annotated tag, then create a draft release with the already-verified files
  gh release create v0.9.1 --draft --verify-tag \
    ae-mcp-panel-v0.9.1-macos-arm64.zxp \
    ae-mcp-panel-v0.9.1-macos-arm64.dmg \
    ae-mcp-panel-v0.9.1-windows-x64.zxp \
    artifact-manifest-v0.9.1.json
  download draft release assets again and compare SHA-256 to manifest
  publish the existing draft without replacing any asset
  ```

  Any pre-upload mismatch exits before tag creation. If upload/post-upload verification fails after tag creation, leave the release as draft, fail the workflow, and resume only with the same build run and bytes after diagnosis; never rebuild, replace an asset, or publish a partial release.

- [ ] **Step 3: Run all release tests**

  ```bash
  node --test scripts/release/test/*.test.mjs
  ```

  Expected: all release contract tests PASS.

- [ ] **Step 4: Rehearse with unsigned fixture artifacts**

  Run pure validation against locally generated Mac/Windows fixture ZIP/ZXP names and synthetic PASS attestations. Do not create a real tag or GitHub Release.

  Expected: matching fixtures return no errors; changing one byte returns `artifact digest mismatch`; replacing later Windows PASS with FAIL returns `windows-x64 attestation is not PASS`.

- [ ] **Step 5: Run real RC after coordination PR merges**

  Trigger build on the protected-main candidate, download exact artifacts, execute Mac script locally, give the fixed prompt to Windows Codex, wait for both Checks, then trigger release workflow.

  Expected: release assets have the same SHA-256 as `artifact-manifest-v0.9.1.json`; tag points to candidate; both checks remain success.

- [ ] **Step 6: Commit**

  ```bash
  git add .github/workflows/release.yml scripts/release/test/verify-release-inputs.test.mjs docs/RELEASE.md
  git commit -m "ci: promote verified RC artifacts without rebuild"
  ```
