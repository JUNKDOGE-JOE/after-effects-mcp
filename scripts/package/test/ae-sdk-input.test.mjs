import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AE_SDK_POLICY_CANONICAL_SHA256,
  combineAeSdkEvidence,
  loadAeSdkPolicy,
  parseAeSdkInputArgs,
  scanTrackedRepositoryForSdkMaterial,
  validateAeSdkPolicy,
  verifyAeSdkInput,
  verifyArchiveAgainstRecord,
  verifyRepositoryHasNoVendoredAeSdk,
  verifyRootAgainstRecord,
} from '../ae-sdk-input.mjs';
import { canonicalJson, sha256Bytes } from '../lib/manifest.mjs';

const CLI = path.resolve('scripts/package/ae-sdk-input.mjs');

async function makeTempBase(t) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-sdk-input-'));
  t.after(() => fs.promises.rm(base, { force: true, recursive: true }));
  const repo = path.join(base, 'repo');
  const inputs = path.join(base, 'inputs');
  await fs.promises.mkdir(repo);
  await fs.promises.mkdir(inputs);
  return { base, repo, inputs };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeFile(filePath, bytes) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, bytes);
}

function pendingContentLock() {
  return {
    status: 'pending-windows-extraction-evidence',
    fileCount: null,
    fileBytes: null,
    sha256: null,
  };
}

function canonicalContentLock(files) {
  const records = Object.entries(files).map(([relative, bytes]) => {
    const data = Buffer.from(bytes);
    return {
      path: relative,
      type: 'file',
      size: data.length,
      sha256: digest(data),
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
  return {
    status: 'canonical-file-tree-verified',
    fileCount: records.length,
    fileBytes: records.reduce((total, record) => total + record.size, 0),
    sha256: sha256Bytes(Buffer.from(canonicalJson(records), 'utf8')),
  };
}

async function makeSyntheticRoot(parent, files = {
  'Examples/Headers/AE_GeneralPlug.h': 'header',
}) {
  const root = path.join(parent, 'ae-test-sdk');
  await fs.promises.mkdir(path.join(root, 'Examples/Buildall.xcodeproj'), { recursive: true });
  for (const [relative, bytes] of Object.entries(files)) {
    await writeFile(path.join(root, ...relative.split('/')), bytes);
  }
  return root;
}

const SYNTHETIC_SENTINELS = [
  { path: 'Examples/Headers/AE_GeneralPlug.h', type: 'file' },
  { path: 'Examples/Buildall.xcodeproj', type: 'directory' },
];

function initGitRepository(repo) {
  execFileSync('git', ['init', '--quiet', repo], { stdio: 'ignore' });
}

function stage(repo, relative) {
  execFileSync('git', ['-C', repo, 'add', '--', relative], { stdio: 'ignore' });
}

test('production policy records the operator attestation and keeps unrelated scopes fail-closed', async () => {
  const policy = await loadAeSdkPolicy();
  assert.equal(validateAeSdkPolicy(policy), policy);
  assert.equal(AE_SDK_POLICY_CANONICAL_SHA256, sha256Bytes(
    Buffer.from(canonicalJson(policy), 'utf8'),
  ));
  assert.equal(policy.sdk.acquisition, 'developer-supplied-unverified-origin');
  assert.equal(policy.sdk.compatibility.afterEffects25, 'unknown');
  assert.equal(policy.sdk.compatibility.afterEffects26, 'unknown');
  assert.equal(policy.sdk.licenseReview.termsEvidence.approvalId, null);
  assert.equal(policy.sdk.licenseReview.operatorAttestation.status, 'recorded');
  assert.equal(policy.sdk.licenseReview.operatorAttestation.actualLocationStored, false);
  assert.equal(
    policy.sdk.licenseReview.regionalEligibility.status,
    'operator-attested-authorized-at-actual-location',
  );
  assert.equal(
    policy.sdk.licenseReview.purposeEligibility.interactiveMcpExecutionPlaneDevelopment,
    'operator-attested-in-scope',
  );
  assert.equal(
    policy.sdk.licenseReview.purposeEligibility.modelTrainingAndEvaluation,
    'deferred-to-issue-83-separate-review',
  );
  assert.equal(
    policy.sdk.licenseReview.embeddedNotices.status,
    'restrictive-notices-present-applicability-pending',
  );
  assert.equal(
    policy.sdk.licenseReview.scopes.rawSdkMaterialInPublicRepository,
    'forbidden',
  );
  assert.equal(
    policy.sdk.licenseReview.scopes.publicNonContentIntegrityMetadata,
    'allowed-aggregate-locks-and-minimal-layout-sentinels',
  );
  assert.equal(policy.sdk.licenseReview.scopes.privateSelfHostedCi, 'blocked-pending-scope-approval');
  assert.deepEqual(policy.sdk.platforms['macos-arm64'].archive, {
    fileNameHint: 'AfterEffectsSDK_25.6_61_mac.zip',
    bytes: 2039255,
    sha256: 'c6abccd52ae25936b819b78c4fea2858bd161f216f72f75184fe9ec55a49756e',
  });
  assert.equal(
    policy.sdk.platforms['macos-arm64'].rootContentLock.sha256,
    '3bec810920dd6ad2d9180c6456d4af421fef20e751dca7446800de80a2751cca',
  );

  const weakened = structuredClone(policy);
  weakened.sdk.licenseReview.scopes.rawSdkMaterialInPublicRepository = 'allowed';
  assert.throws(() => validateAeSdkPolicy(weakened), { code: 'AE_SDK_POLICY_INVALID' });
});

test('archive verification uses size and SHA-256 while treating the filename as a hint', async (t) => {
  const { repo, inputs } = await makeTempBase(t);
  const bytes = Buffer.from('synthetic SDK archive');
  const archivePath = path.join(inputs, 'renamed-input.bin');
  await fs.promises.writeFile(archivePath, bytes);
  const record = {
    fileNameHint: 'expected.zip',
    bytes: bytes.length,
    sha256: digest(bytes),
  };

  assert.deepEqual(
    await verifyArchiveAgainstRecord({ archivePath, record, repoRoot: repo }),
    { archiveVerification: 'sha256-verified', fileNameHintMatched: false },
  );

  await assert.rejects(
    verifyArchiveAgainstRecord({
      archivePath,
      record: { ...record, bytes: bytes.length + 1 },
      repoRoot: repo,
    }),
    { code: 'AE_SDK_ARCHIVE_INVALID' },
  );
  await assert.rejects(
    verifyArchiveAgainstRecord({
      archivePath,
      record: { ...record, sha256: '0'.repeat(64) },
      repoRoot: repo,
    }),
    { code: 'AE_SDK_ARCHIVE_INVALID' },
  );
});

test('archive and SDK root inputs are rejected from inside the repository', async (t) => {
  const { repo } = await makeTempBase(t);
  const bytes = Buffer.from('archive');
  const archivePath = path.join(repo, 'archive.bin');
  await fs.promises.writeFile(archivePath, bytes);
  await assert.rejects(
    verifyArchiveAgainstRecord({
      archivePath,
      record: { fileNameHint: 'archive.bin', bytes: bytes.length, sha256: digest(bytes) },
      repoRoot: repo,
    }),
    { code: 'AE_SDK_INPUT_INSIDE_REPOSITORY' },
  );

  const root = await makeSyntheticRoot(repo);
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_INPUT_INSIDE_REPOSITORY' },
  );
});

test('root verification accepts only the exact root or direct parent and distinguishes evidence levels', async (t) => {
  const { repo, inputs } = await makeTempBase(t);
  const files = { 'Examples/Headers/AE_GeneralPlug.h': 'header' };
  const root = await makeSyntheticRoot(inputs, files);
  const locked = canonicalContentLock(files);

  for (const rootInput of [inputs, root]) {
    const result = await verifyRootAgainstRecord({
      rootInput,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: locked,
      repoRoot: repo,
    });
    assert.equal(result.rootVerification, 'layout-and-content-verified');
    assert.equal(result.contentVerified, true);
    assert.equal(result.provenanceVerified, false);
  }

  const layoutOnly = await verifyRootAgainstRecord({
    rootInput: root,
    extractedRoot: 'ae-test-sdk',
    sentinels: SYNTHETIC_SENTINELS,
    contentLock: pendingContentLock(),
    repoRoot: repo,
  });
  assert.equal(layoutOnly.rootVerification, 'layout-verified');
  assert.equal(layoutOnly.contentVerified, false);

  const grandparent = path.dirname(inputs);
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: grandparent,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );
});

test('root verification rejects missing, wrong-type, and content-drifted sentinels', async (t) => {
  const { repo, inputs } = await makeTempBase(t);
  const files = { 'Examples/Headers/AE_GeneralPlug.h': 'header' };
  const root = await makeSyntheticRoot(inputs, files);
  const locked = canonicalContentLock(files);

  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: [{ path: 'missing.h', type: 'file' }],
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: [{ path: 'Examples/Buildall.xcodeproj', type: 'file' }],
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );

  await writeFile(path.join(root, 'unexpected.txt'), 'drift');
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: locked,
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );
});

test('root verification rejects links instead of following them', {
  skip: process.platform === 'win32' ? 'Windows CI does not guarantee symlink privilege' : false,
}, async (t) => {
  const { repo, inputs } = await makeTempBase(t);
  const root = await makeSyntheticRoot(inputs);
  await fs.promises.symlink(
    path.join(root, 'Examples/Headers/AE_GeneralPlug.h'),
    path.join(root, 'linked-header.h'),
  );
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );
});

test('root verification rejects hard-linked files', async (t) => {
  const { repo, inputs } = await makeTempBase(t);
  const root = await makeSyntheticRoot(inputs);
  await fs.promises.link(
    path.join(root, 'Examples/Headers/AE_GeneralPlug.h'),
    path.join(root, 'hard-linked-header.h'),
  );
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );
});

test('root verification rejects oversized sparse files before hashing them', async (t) => {
  const { repo, inputs } = await makeTempBase(t);
  const root = await makeSyntheticRoot(inputs);
  await fs.promises.truncate(
    path.join(root, 'Examples/Headers/AE_GeneralPlug.h'),
    (64 * 1024 * 1024) + 1,
  );
  await assert.rejects(
    verifyRootAgainstRecord({
      rootInput: root,
      extractedRoot: 'ae-test-sdk',
      sentinels: SYNTHETIC_SENTINELS,
      contentLock: pendingContentLock(),
      repoRoot: repo,
    }),
    { code: 'AE_SDK_LAYOUT_INVALID' },
  );
});

test('anti-vendoring detects SDK-only paths and renamed locked bytes in tracked Git content', async (t) => {
  const first = await makeTempBase(t);
  initGitRepository(first.repo);
  await writeFile(path.join(first.repo, 'vendor/AE_GeneralPlug.h'), 'header');
  stage(first.repo, 'vendor/AE_GeneralPlug.h');
  await assert.rejects(
    scanTrackedRepositoryForSdkMaterial({
      repoRoot: first.repo,
      forbiddenRecords: [{ bytes: 1, sha256: digest('x') }],
    }),
    { code: 'AE_SDK_VENDORED' },
  );

  const second = await makeTempBase(t);
  initGitRepository(second.repo);
  const sdkBytes = Buffer.from('renamed locked SDK bytes');
  await writeFile(path.join(second.repo, 'assets/blob.bin'), sdkBytes);
  stage(second.repo, 'assets/blob.bin');
  await fs.promises.writeFile(path.join(second.repo, 'assets/blob.bin'), 'clean worktree replacement');
  await assert.rejects(
    scanTrackedRepositoryForSdkMaterial({
      repoRoot: second.repo,
      forbiddenRecords: [{ bytes: sdkBytes.length, sha256: digest(sdkBytes) }],
    }),
    { code: 'AE_SDK_VENDORED' },
  );

  const third = await makeTempBase(t);
  initGitRepository(third.repo);
  const repacked = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('renamed/ae25.6_61.64bit.AfterEffectsSDK/payload'),
  ]);
  await writeFile(path.join(third.repo, 'assets/opaque.bin'), repacked);
  stage(third.repo, 'assets/opaque.bin');
  await assert.rejects(
    scanTrackedRepositoryForSdkMaterial({
      repoRoot: third.repo,
      forbiddenRecords: [{ bytes: 1, sha256: digest('x') }],
    }),
    { code: 'AE_SDK_VENDORED' },
  );

  const lfs = await makeTempBase(t);
  initGitRepository(lfs.repo);
  const lfsPointer = [
    'version https://git-lfs.github.com/spec/v1',
    `oid sha256:${'a'.repeat(64)}`,
    'size 2039255',
    '',
  ].join('\n');
  await writeFile(path.join(lfs.repo, 'assets/sdk.zip'), lfsPointer);
  stage(lfs.repo, 'assets/sdk.zip');
  await assert.rejects(
    scanTrackedRepositoryForSdkMaterial({
      repoRoot: lfs.repo,
      forbiddenRecords: [{ bytes: 1, sha256: digest('x') }],
    }),
    { code: 'AE_SDK_REPOSITORY_INVALID' },
  );
});

test('anti-vendoring passes ordinary tracked content and the production checkout', async (t) => {
  const { repo } = await makeTempBase(t);
  initGitRepository(repo);
  await writeFile(path.join(repo, 'README.md'), 'ordinary source');
  stage(repo, 'README.md');
  assert.deepEqual(
    await scanTrackedRepositoryForSdkMaterial({
      repoRoot: repo,
      forbiddenRecords: [{ bytes: 3, sha256: digest('sdk') }],
    }),
    {
      schemaVersion: 1,
      repositoryVerification: 'no-tracked-sdk-material',
      trackedFileCount: 1,
    },
  );

  const policy = await loadAeSdkPolicy();
  const production = await verifyRepositoryHasNoVendoredAeSdk({ repoRoot: '.', policy });
  assert.equal(production.repositoryVerification, 'no-tracked-sdk-material');
});

test('anti-vendoring binds the reviewed policy to the tracked Git snapshot', async (t) => {
  const { repo } = await makeTempBase(t);
  initGitRepository(repo);
  const policy = await loadAeSdkPolicy();
  const weakened = structuredClone(policy);
  weakened.sdk.licenseReview.scopes.rawSdkMaterialInPublicRepository = 'allowed';
  const relative = 'packaging/ae-sdk-inputs.json';
  await writeFile(path.join(repo, relative), `${JSON.stringify(weakened, null, 2)}\n`);
  stage(repo, relative);
  await writeFile(path.join(repo, relative), `${JSON.stringify(policy, null, 2)}\n`);

  await assert.rejects(
    scanTrackedRepositoryForSdkMaterial({
      repoRoot: repo,
      forbiddenRecords: [{ bytes: 1, sha256: digest('x') }],
      expectedPolicy: policy,
      policyPath: relative,
    }),
    { code: 'AE_SDK_REPOSITORY_INVALID' },
  );
});

test('CLI argument parsing uses explicit options before environment and fails closed', () => {
  assert.deepEqual(
    parseAeSdkInputArgs([
      'verify-input',
      '--platform', 'macos-arm64',
      '--archive', '/explicit/archive',
      '--root', '/explicit/root',
      '--repo-root', '/repo',
    ], { AE_SDK_ARCHIVE: '/environment/archive', AE_SDK_ROOT: '/environment/root' }),
    {
      command: 'verify-input',
      platform: 'macos-arm64',
      archivePath: '/explicit/archive',
      rootInput: '/explicit/root',
      repoRoot: '/repo',
    },
  );
  assert.throws(
    () => parseAeSdkInputArgs(['verify-input', '--platform', 'macos-arm64', '--wat', 'x']),
    { code: 'AE_SDK_ARGUMENT_INVALID' },
  );
  assert.throws(
    () => parseAeSdkInputArgs(['verify-archive', '--platform', 'macos-arm64', '--root', '/ignored']),
    { code: 'AE_SDK_ARGUMENT_INVALID' },
  );
  assert.throws(
    () => parseAeSdkInputArgs(['extract-sdk']),
    { code: 'AE_SDK_ARGUMENT_INVALID' },
  );
});

test('combined verification reports missing inputs in actionable order', async () => {
  const policy = await loadAeSdkPolicy();
  await assert.rejects(
    verifyAeSdkInput({ platform: 'macos-arm64', policy, repoRoot: '.' }),
    { code: 'AE_SDK_ROOT_REQUIRED' },
  );
  await assert.rejects(
    verifyAeSdkInput({
      platform: 'macos-arm64',
      rootInput: '/provided/root',
      policy,
      repoRoot: '.',
    }),
    { code: 'AE_SDK_ARCHIVE_REQUIRED' },
  );
});

test('combined verification refuses layout-only platform evidence', () => {
  const archive = {
    schemaVersion: 1,
    platform: 'macos-arm64',
    archiveVerification: 'sha256-verified',
    claimedVersion: '25.6.61',
  };
  assert.throws(
    () => combineAeSdkEvidence({
      archive,
      root: {
        schemaVersion: 1,
        platform: 'windows-x64',
        rootVerification: 'layout-verified',
        contentVerified: false,
      },
      platform: 'windows-x64',
    }),
    { code: 'AE_SDK_CONTENT_EVIDENCE_PENDING' },
  );
  assert.equal(
    combineAeSdkEvidence({
      archive,
      root: {
        schemaVersion: 1,
        platform: 'macos-arm64',
        rootVerification: 'layout-and-content-verified',
        contentVerified: true,
      },
      platform: 'macos-arm64',
    }).sdkRootReady,
    true,
  );

  assert.throws(
    () => combineAeSdkEvidence({
      archive,
      root: {
        schemaVersion: 1,
        platform: 'macos-arm64',
        rootVerification: 'layout-and-content-verified',
        contentVerified: true,
      },
      platform: 'windows-x64',
    }),
    { code: 'AE_SDK_POLICY_INVALID' },
  );
  assert.throws(
    () => combineAeSdkEvidence({
      archive: { ...archive, claimedVersion: '26.0.0' },
      root: {
        schemaVersion: 1,
        platform: 'macos-arm64',
        rootVerification: 'layout-and-content-verified',
        contentVerified: true,
      },
      platform: 'macos-arm64',
    }),
    { code: 'AE_SDK_POLICY_INVALID' },
  );
});

test('policy schema and CI workflows preserve the reviewed SDK gate', async () => {
  const schema = JSON.parse(await fs.promises.readFile(
    'packaging/schemas/ae-sdk-inputs.schema.json',
    'utf8',
  ));
  assert.equal(schema.properties.schemaVersion.const, 1);
  const sdk = schema.properties.sdk;
  assert.ok(sdk.required.includes('licenseReview'));
  assert.equal(
    sdk.properties.licenseReview.properties.operatorAttestation
      .properties.actualLocationStored.const,
    false,
  );
  assert.equal(
    sdk.properties.licenseReview.properties.scopes.properties
      .rawSdkMaterialInPublicRepository.const,
    'forbidden',
  );

  const exactCommand = 'node scripts/package/ae-sdk-input.mjs verify-repository --repo-root .';
  const activeRun = new RegExp(
    `^\\s+run:\\s+${exactCommand.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`,
    'gm',
  );
  const ciWorkflow = await fs.promises.readFile('.github/workflows/ci.yml', 'utf8');
  const rcWorkflow = await fs.promises.readFile('.github/workflows/build-rc.yml', 'utf8');
  assert.equal([...ciWorkflow.matchAll(activeRun)].length, 2);
  assert.equal([...rcWorkflow.matchAll(activeRun)].length, 1);
});

test('English and Chinese READMEs preserve the developer-supplied SDK contract', async () => {
  const documents = [
    {
      path: 'README.md',
      phrases: [
        'not distributed with this repository',
        'never downloaded automatically',
        'https://developer.adobe.com/after-effects/',
        'After Effects SDK **25.6, build 61, 64-bit**',
        'AE_SDK_ROOT',
        'AE_SDK_ARCHIVE',
        'verify-input --platform macos-arm64',
        'AE_SDK_CONTENT_EVIDENCE_PENDING',
        'Git LFS',
        'docs/native-sdk/SDK_INPUTS.md',
      ],
    },
    {
      path: 'README.zh-CN.md',
      phrases: [
        '不随本仓库分发',
        '项目也不会自动下载它',
        'https://developer.adobe.com/after-effects/',
        'After Effects SDK **25.6、build 61、64 位**',
        'AE_SDK_ROOT',
        'AE_SDK_ARCHIVE',
        'verify-input --platform macos-arm64',
        'AE_SDK_CONTENT_EVIDENCE_PENDING',
        'Git LFS',
        'docs/native-sdk/SDK_INPUTS.md',
      ],
    },
  ];
  const sharedLocks = [
    'c6abccd52ae25936b819b78c4fea2858bd161f216f72f75184fe9ec55a49756e',
    '3d3a39175a09d07f6f9734284636f9eadce968b05161650e3cba097a95905330',
  ];
  for (const document of documents) {
    const content = await fs.promises.readFile(document.path, 'utf8');
    for (const phrase of [...document.phrases, ...sharedLocks]) {
      assert.ok(content.includes(phrase), `${document.path} must preserve ${phrase}`);
    }
  }
});

test('CLI errors are structured and never echo sensitive input paths', () => {
  const secretPath = path.join(os.tmpdir(), 'secret-user-sdk-path');
  const result = spawnSync(process.execPath, [
    CLI,
    'verify-archive',
    '--platform', 'macos-arm64',
    '--archive', secretPath,
    '--repo-root', '.',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /secret-user-sdk-path/);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'AE_SDK_ARCHIVE_INVALID');
  assert.equal(result.stdout, '');
});
