import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { canonicalJson } from '../lib/manifest.mjs';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import {
  parseFinalNativeSignatureArgs,
  verifyFinalNativeSignatures,
  writeFinalNativeSignatureEvidence,
} from '../verify-final-native-signatures.mjs';
import {
  machoArm64Bytes,
  machoX64Bytes,
  makeStageHarness,
  peX64Bytes,
  rewriteStageManifests,
  sha256Bytes,
  writeFixtureFile,
} from './helpers/platform-bundle-fixture.mjs';

const execFileAsync = promisify(execFile);

async function makeFinalSignatureHarness(t, platform) {
  const h = await makeStageHarness(t, platform);
  await stagePlatformBundle(h.input);
  const addonRelative = 'lib/ae-mcp-platform-helper-transport.node';
  const addonBytes = platform === 'macos-arm64' ? machoArm64Bytes() : peX64Bytes();
  await writeFixtureFile(
    join(h.outDir, 'platform', platform),
    addonRelative,
    addonBytes,
    platform === 'macos-arm64' ? 0o755 : 0o644,
  );
  const helperManifestPath = join(
    h.outDir,
    'platform',
    platform,
    'helper-manifest.json',
  );
  const helperManifest = JSON.parse(await readFile(helperManifestPath, 'utf8'));
  helperManifest.files.push({
    path: addonRelative,
    architecture: platform === 'macos-arm64' ? 'macho-arm64' : 'pe-x64',
    sha256: sha256Bytes(addonBytes),
  });
  await writeFile(helperManifestPath, `${JSON.stringify(helperManifest, null, 2)}\n`);
  await rewriteStageManifests(h, { helper: true });

  const zxpPath = join(h.root, `${platform}.zxp`);
  const dmgPath = platform === 'macos-arm64' ? join(h.root, `${platform}.dmg`) : undefined;
  await writeFile(zxpPath, `${platform} zxp\n`);
  if (dmgPath) await writeFile(dmgPath, `${platform} dmg\n`);
  return { ...h, zxpPath, dmgPath };
}

function fingerprints(platform) {
  return platform === 'macos-arm64'
    ? { product: 'a'.repeat(64), thirdParty: 'b'.repeat(64) }
    : { product: 'A'.repeat(40), thirdParty: 'B'.repeat(40) };
}

async function withProtectedFingerprint(platform, callback) {
  const name = platform === 'macos-arm64'
    ? 'AE_MCP_APPLE_CERT_FINGERPRINT_SHA256'
    : 'AE_MCP_WINDOWS_SIGNING_CERT_SHA1';
  const previous = process.env[name];
  process.env[name] = fingerprints(platform).product;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function validInspector(platform) {
  const { product, thirdParty } = fingerprints(platform);
  return async ({ requireProductIdentity }) => ({
    verified: true,
    signerFingerprint: requireProductIdentity ? product : thirdParty,
  });
}

for (const platform of ['macos-arm64', 'windows-x64']) {
  test(`${platform} verifies every manifest-declared native and preserves signer ownership`, async (t) => {
    const h = await makeFinalSignatureHarness(t, platform);
    const {
      product: expectedProductFingerprint,
      thirdParty: thirdPartyFingerprint,
    } = fingerprints(platform);
    const inspections = [];
    const inspectSignature = async (input) => {
      inspections.push(input);
      return {
        verified: true,
        signerFingerprint: input.requireProductIdentity
          ? expectedProductFingerprint
          : thirdPartyFingerprint,
      };
    };

    const result = await withProtectedFingerprint(platform, () => (
      verifyFinalNativeSignatures({
        platform,
        candidateSha: h.input.sourceCommitSha,
        signedRoot: h.outDir,
        zxpPath: h.zxpPath,
        dmgPath: h.dmgPath,
      }, { inspectSignature })
    ));

    assert.deepEqual(Object.keys(result).sort(), [
      'artifacts',
      'candidateSha',
      'discoveredNativeCount',
      'files',
      'finalRootSha256',
      'platform',
      'result',
      'schemaVersion',
      'signedBundleManifestSha256',
    ]);
    assert.deepEqual(
      result.files.map(({ path }) => path),
      result.files.map(({ path }) => path)
        .toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );
    const expectedNativePaths = platform === 'macos-arm64'
      ? [
        'platform/macos-arm64/bin/ae-mcp-platform-helper',
        'platform/macos-arm64/lib/ae-mcp-platform-helper-transport.node',
        'runtime/macos-arm64/node/bin/node',
        'runtime/macos-arm64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
        'runtime/macos-arm64/python/bin/python3.13',
      ]
      : [
        'platform/windows-x64/bin/ae-mcp-platform-helper.exe',
        'platform/windows-x64/bin/ae-mcp.exe',
        'platform/windows-x64/lib/ae-mcp-platform-helper-transport.node',
        'runtime/windows-x64/node/node.exe',
        'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
        'runtime/windows-x64/python/python.exe',
      ];
    expectedNativePaths.sort((left, right) => (
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    ));
    assert.deepEqual(result.files.map(({ path }) => path), expectedNativePaths);
    assert.equal(result.discoveredNativeCount, inspections.length);
    assert.equal(result.files.length, inspections.length);
    assert.ok(inspections.every(({ filePath }) => (
      result.files.some(({ path }) => filePath === join(h.outDir, ...path.split('/')))
    )));
    for (const [index, inspection] of inspections.entries()) {
      assert.equal(
        result.files.find(({ path }) => (
          join(h.outDir, ...path.split('/')) === inspection.filePath
        )).signerFingerprint,
        inspection.requireProductIdentity
          ? expectedProductFingerprint
          : thirdPartyFingerprint,
        `signer ownership mismatch at inspection ${index}`,
      );
      assert.equal(
        inspection.expectedFingerprint,
        inspection.requireProductIdentity ? expectedProductFingerprint : undefined,
      );
    }
    assert.ok(inspections.some(({ requireProductIdentity }) => requireProductIdentity));
    assert.ok(inspections.some(({ requireProductIdentity }) => !requireProductIdentity));
    assert.deepEqual(result.artifacts, [
      { name: `${platform}.zxp`, sha256: sha256Bytes(Buffer.from(`${platform} zxp\n`)) },
      ...(platform === 'macos-arm64'
        ? [{ name: `${platform}.dmg`, sha256: sha256Bytes(Buffer.from(`${platform} dmg\n`)) }]
        : []),
    ]);

    if (platform === 'macos-arm64') {
      assert.doesNotMatch(
        JSON.stringify(result.files),
        /platform\/macos-arm64\/bin\/ae-mcp"/,
      );
      assert.ok(result.files.some(
        (item) => item.path.endsWith('/bin/ae-mcp-platform-helper'),
      ));
      assert.ok(result.files.some(
        (item) => item.path.endsWith('/lib/ae-mcp-platform-helper-transport.node'),
      ));
    } else {
      for (const suffix of [
        '/bin/ae-mcp-platform-helper.exe',
        '/lib/ae-mcp-platform-helper-transport.node',
        '/bin/ae-mcp.exe',
      ]) {
        assert.ok(result.files.some((item) => item.path.endsWith(suffix)), suffix);
      }
    }
  });
}

test('argument parser enforces the exact platform artifact cardinality', () => {
  const common = [
    '--candidate-sha', 'a'.repeat(40),
    '--signed-root', '/tmp/signed',
    '--zxp', '/tmp/panel.zxp',
    '--out', '/tmp/native-signatures.json',
  ];
  assert.deepEqual(
    parseFinalNativeSignatureArgs([
      '--platform', 'macos-arm64',
      ...common,
      '--dmg', '/tmp/panel.dmg',
    ]),
    {
      platform: 'macos-arm64',
      candidateSha: 'a'.repeat(40),
      signedRoot: '/tmp/signed',
      zxpPath: '/tmp/panel.zxp',
      dmgPath: '/tmp/panel.dmg',
      outPath: '/tmp/native-signatures.json',
    },
  );
  assert.deepEqual(
    parseFinalNativeSignatureArgs(['--platform', 'windows-x64', ...common]),
    {
      platform: 'windows-x64',
      candidateSha: 'a'.repeat(40),
      signedRoot: '/tmp/signed',
      zxpPath: '/tmp/panel.zxp',
      outPath: '/tmp/native-signatures.json',
    },
  );
  assert.throws(
    () => parseFinalNativeSignatureArgs(['--platform', 'macos-arm64', ...common]),
    /--dmg is required/u,
  );
  assert.throws(
    () => parseFinalNativeSignatureArgs([
      '--platform', 'windows-x64',
      ...common,
      '--dmg', '/tmp/panel.dmg',
    ]),
    /--dmg is forbidden/u,
  );
  assert.throws(
    () => parseFinalNativeSignatureArgs([
      '--platform', 'windows-x64',
      ...common,
      '--zxp', '/tmp/extra.zxp',
    ]),
    /invalid argument/u,
  );
});

test('missing launcher, helper, or manifest-declared native file is rejected', async (t) => {
  for (const relative of [
    'platform/macos-arm64/bin/ae-mcp',
    'platform/macos-arm64/bin/ae-mcp-platform-helper',
    'runtime/macos-arm64/node/bin/node',
  ]) {
    await t.test(relative, async (child) => {
      const h = await makeFinalSignatureHarness(child, 'macos-arm64');
      await rm(join(h.outDir, ...relative.split('/')));
      await assert.rejects(
        withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures({
          platform: 'macos-arm64',
          candidateSha: h.input.sourceCommitSha,
          signedRoot: h.outDir,
          zxpPath: h.zxpPath,
          dmgPath: h.dmgPath,
        }, { inspectSignature: validInspector('macos-arm64') })),
        /bundle file set|declared helper payload|missing|mismatch/iu,
      );
    });
  }
});

test('manifest digest mismatch and wrong native architecture are rejected', async (t) => {
  await t.test('digest mismatch', async (child) => {
    const h = await makeFinalSignatureHarness(child, 'macos-arm64');
    await h.flipByte('platform/macos-arm64/bin/ae-mcp-platform-helper');
    await assert.rejects(
      withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures({
        platform: 'macos-arm64',
        candidateSha: h.input.sourceCommitSha,
        signedRoot: h.outDir,
        zxpPath: h.zxpPath,
        dmgPath: h.dmgPath,
      }, { inspectSignature: validInspector('macos-arm64') })),
      /mismatch/iu,
    );
  });
  await t.test('wrong architecture', async (child) => {
    const h = await makeFinalSignatureHarness(child, 'macos-arm64');
    await writeFile(
      join(h.outDir, 'platform/macos-arm64/bin/ae-mcp-platform-helper'),
      machoX64Bytes(),
    );
    await rewriteStageManifests(h, { helper: true });
    await assert.rejects(
      withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures({
        platform: 'macos-arm64',
        candidateSha: h.input.sourceCommitSha,
        signedRoot: h.outDir,
        zxpPath: h.zxpPath,
        dmgPath: h.dmgPath,
      }, { inspectSignature: validInspector('macos-arm64') })),
      { code: 'BUNDLE_ARCH_MISMATCH' },
    );
  });
});

test('invalid signatures and wrong product fingerprint are rejected', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'windows-x64');
  const input = {
    platform: 'windows-x64',
    candidateSha: h.input.sourceCommitSha,
    signedRoot: h.outDir,
    zxpPath: h.zxpPath,
  };
  await assert.rejects(
    withProtectedFingerprint('windows-x64', () => verifyFinalNativeSignatures(
      input,
      {
        inspectSignature: async () => ({
          verified: false,
          signerFingerprint: fingerprints('windows-x64').thirdParty,
        }),
      },
    )),
    /adapter rejected/u,
  );
  await assert.rejects(
    withProtectedFingerprint('windows-x64', () => verifyFinalNativeSignatures(
      input,
      {
        inspectSignature: async ({ requireProductIdentity }) => ({
          verified: true,
          signerFingerprint: requireProductIdentity
            ? fingerprints('windows-x64').thirdParty
            : fingerprints('windows-x64').product,
        }),
      },
    )),
    /product signer fingerprint mismatch/u,
  );
});

test('third-party valid signer does not need the product fingerprint', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'windows-x64');
  const inspections = [];
  const result = await withProtectedFingerprint('windows-x64', () => (
    verifyFinalNativeSignatures({
      platform: 'windows-x64',
      candidateSha: h.input.sourceCommitSha,
      signedRoot: h.outDir,
      zxpPath: h.zxpPath,
    }, {
      inspectSignature: async (input) => {
        inspections.push(input);
        return {
          verified: true,
          signerFingerprint: input.requireProductIdentity
            ? fingerprints('windows-x64').product
            : fingerprints('windows-x64').thirdParty,
        };
      },
    })
  ));
  assert.ok(inspections.some(({ requireProductIdentity }) => !requireProductIdentity));
  assert.ok(result.files.some(({ signerFingerprint }) => (
    signerFingerprint === fingerprints('windows-x64').thirdParty
  )));
});

test('missing artifacts and wrong signed identity are rejected', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'macos-arm64');
  const base = {
    platform: 'macos-arm64',
    candidateSha: h.input.sourceCommitSha,
    signedRoot: h.outDir,
    zxpPath: h.zxpPath,
    dmgPath: h.dmgPath,
  };
  await rm(h.zxpPath);
  await assert.rejects(
    withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures(
      base,
      { inspectSignature: validInspector('macos-arm64') },
    )),
    /ENOENT|no such file/iu,
  );
  await assert.rejects(
    withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures(
      { ...base, platform: 'windows-x64', dmgPath: undefined },
      { inspectSignature: validInspector('windows-x64') },
    )),
    /platform|identity|mismatch/iu,
  );
  await assert.rejects(
    withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures(
      { ...base, candidateSha: 'f'.repeat(40) },
      { inspectSignature: validInspector('macos-arm64') },
    )),
    /candidate|source commit|identity|mismatch/iu,
  );
});

test('canonical evidence writer refuses a pre-existing output', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'windows-x64');
  const outPath = join(h.root, 'native-signatures.json');
  await writeFile(outPath, 'existing\n');
  await assert.rejects(
    withProtectedFingerprint('windows-x64', () => writeFinalNativeSignatureEvidence({
      platform: 'windows-x64',
      candidateSha: h.input.sourceCommitSha,
      signedRoot: h.outDir,
      zxpPath: h.zxpPath,
      outPath,
    }, { inspectSignature: validInspector('windows-x64') })),
    /already exists/u,
  );
  assert.equal(await readFile(outPath, 'utf8'), 'existing\n');
});

test('canonical evidence writer creates the final artifact once', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'windows-x64');
  const outPath = join(h.root, 'native-signatures.json');
  const result = await withProtectedFingerprint('windows-x64', () => (
    writeFinalNativeSignatureEvidence({
      platform: 'windows-x64',
      candidateSha: h.input.sourceCommitSha,
      signedRoot: h.outDir,
      zxpPath: h.zxpPath,
      outPath,
    }, { inspectSignature: validInspector('windows-x64') })
  ));
  assert.equal(await readFile(outPath, 'utf8'), canonicalJson(result));
});

test('CLI reports the bounded final-signature failure prefix', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      join(import.meta.dirname, '..', 'verify-final-native-signatures.mjs'),
    ]),
    (error) => {
      assert.match(error.stderr, /^FINAL_NATIVE_SIGNATURES_FAILED: /u);
      assert.equal(error.code, 1);
      return true;
    },
  );
});

test('Windows adapter binds the requested file through an explicit PowerShell parameter', async () => {
  const module = await import('../verify-final-native-signatures.mjs');
  assert.equal(typeof module.inspectWindowsSignature, 'function');
  const requestedFile = 'C:\\RC files\\ae-mcp-platform-helper.exe';
  let temporaryScriptPath;

  const result = await module.inspectWindowsSignature({
    filePath: requestedFile,
    requireProductIdentity: true,
    expectedFingerprint: 'A'.repeat(40),
  }, {
    executeFile: async (command, args, options) => {
      assert.equal(command, 'powershell.exe');
      assert.equal(options.timeout, 30_000);
      const fileSwitch = args.indexOf('-File');
      const pathParameter = args.indexOf('-FilePath');
      assert.ok(fileSwitch >= 0);
      assert.ok(pathParameter > fileSwitch);
      assert.equal(args[pathParameter + 1], requestedFile);
      assert.equal(args.filter((item) => item === requestedFile).length, 1);
      temporaryScriptPath = args[fileSwitch + 1];
      const script = await readFile(temporaryScriptPath, 'utf8');
      assert.match(script, /^param\(/u);
      assert.match(
        script,
        /Get-AuthenticodeSignature -LiteralPath \$FilePath/u,
      );
      return {
        stdout: JSON.stringify({
          Status: 'Valid',
          SignerCertificate: { Thumbprint: 'A'.repeat(40) },
        }),
      };
    },
  });

  assert.deepEqual(result, {
    verified: true,
    signerFingerprint: 'A'.repeat(40),
  });
  await assert.rejects(readFile(temporaryScriptPath), { code: 'ENOENT' });
});

test('third-party native with a required suffix cannot replace missing product coverage', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'macos-arm64');
  const helperRoot = join(h.outDir, 'platform', 'macos-arm64');
  const helperManifestPath = join(helperRoot, 'helper-manifest.json');
  const helperManifest = JSON.parse(await readFile(helperManifestPath, 'utf8'));
  helperManifest.files = helperManifest.files.filter(
    ({ path }) => path !== 'lib/ae-mcp-platform-helper-transport.node',
  );
  await writeFile(helperManifestPath, `${JSON.stringify(helperManifest, null, 2)}\n`);
  await rm(join(helperRoot, 'lib', 'ae-mcp-platform-helper-transport.node'));
  await writeFixtureFile(
    join(h.outDir, 'runtime', 'macos-arm64'),
    'third-party/lib/ae-mcp-platform-helper-transport.node',
    machoArm64Bytes(),
    0o755,
  );
  await rewriteStageManifests(h, { helper: true });

  await assert.rejects(
    withProtectedFingerprint('macos-arm64', () => verifyFinalNativeSignatures({
      platform: 'macos-arm64',
      candidateSha: h.input.sourceCommitSha,
      signedRoot: h.outDir,
      zxpPath: h.zxpPath,
      dmgPath: h.dmgPath,
    }, { inspectSignature: validInspector('macos-arm64') })),
    /product native signature coverage is missing/u,
  );
});

test('writer rejects the signed root and its descendants before hashing', async (t) => {
  const h = await makeFinalSignatureHarness(t, 'windows-x64');
  let inspections = 0;

  for (const outPath of [
    h.outDir,
    join(h.outDir, 'evidence', 'native-signatures.json'),
  ]) {
    await assert.rejects(
      withProtectedFingerprint('windows-x64', () => writeFinalNativeSignatureEvidence({
        platform: 'windows-x64',
        candidateSha: h.input.sourceCommitSha,
        signedRoot: h.outDir,
        zxpPath: h.zxpPath,
        outPath,
      }, {
        inspectSignature: async (input) => {
          inspections += 1;
          return validInspector('windows-x64')(input);
        },
      })),
      /output path must be outside the signed root/u,
    );
  }
  assert.equal(inspections, 0);
  await assert.rejects(
    readFile(join(h.outDir, 'evidence', 'native-signatures.json')),
    { code: 'ENOENT' },
  );
});
