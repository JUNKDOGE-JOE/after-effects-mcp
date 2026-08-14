import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyWindowsZxpStage } from '../verify-windows-zxp-stage.mjs';

const VERSION = '0.9.5';
const HELPER_FILES = [
  'bin/ae-mcp-platform-helper.exe',
  'bin/ae-mcp.exe',
  'lib/ae-mcp-platform-helper-transport.node',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function write(root, relativePath, value) {
  const destination = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, value);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-zxp-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = [];
  for (const [index, relativePath] of HELPER_FILES.entries()) {
    const bytes = Buffer.from(`helper-${index}`);
    await write(root, `platform/windows-x64/${relativePath}`, bytes);
    records.push({ path: relativePath, architecture: 'pe-x64', sha256: sha256(bytes) });
  }
  await write(root, 'platform/windows-x64/helper-manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    platform: 'windows-x64',
    helperId: 'com.junkdoge.ae-mcp.platform-helper',
    entrypoints: {
      helper: HELPER_FILES[0],
      launcher: HELPER_FILES[1],
    },
    files: records,
  })}\n`);
  await write(root, 'runtime/windows-x64/node/host/package.json', '{}\n');
  await write(root, 'runtime/windows-x64/node/host/node_modules/express/package.json', '{}\n');
  await write(root, 'runtime/windows-x64/node/sidecar/agent-sidecar.mjs', '// sidecar entry\n');
  await write(root, 'runtime/windows-x64/node/sidecar/lib.mjs', '// sidecar lib\n');
  await write(root, 'runtime/windows-x64/node/sidecar/package.json', '{}\n');
  await write(root, 'runtime/windows-x64/node/shared/tool-approval.mjs', '// shared\n');
  await write(root, 'runtime/windows-x64/node/shared/chat-attachments.mjs', '// shared\n');
  await write(
    root,
    'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    '{}\n',
  );
  await write(
    root,
    'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json',
    '{}\n',
  );
  await write(
    root,
    'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    'MZ',
  );
  await write(root, 'host/platform-helper-transport.js', HELPER_FILES.join('\n'));
  await write(root, 'client/dist/app.js', [
    `var PANEL_VERSION = "${VERSION}";`,
    'astral.sh/uv/install.ps1',
    '"tool", "install", "--force", "--from"',
    '#subdirectory=packages/${sub}',
    'src("core")',
    'src("bridge")',
    'src("snapshot-mss")',
  ].join('\n'));
  return { root, records };
}

test('accepts the minimal Windows ZXP contract with Helper and online runtime wizard', async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(verifyWindowsZxpStage({ stageRoot: root, version: VERSION }), {
    platform: 'windows-x64',
    version: VERSION,
    helperFiles: HELPER_FILES,
  });
});

test('rejects a missing or modified Helper payload', async (t) => {
  const missing = await fixture(t);
  await fs.rm(path.join(missing.root, 'platform/windows-x64/bin/ae-mcp.exe'));
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: missing.root, version: VERSION }),
    { code: 'WINDOWS_ZXP_CONTRACT_INVALID' },
  );

  const modified = await fixture(t);
  await fs.writeFile(
    path.join(modified.root, 'platform/windows-x64/bin/ae-mcp-platform-helper.exe'),
    'modified',
  );
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: modified.root, version: VERSION }),
    /hash mismatch/,
  );
});

test('rejects bundled runtime executables and nested AEX files', async (t) => {
  const runtime = await fixture(t);
  await write(runtime.root, 'runtime/windows-x64/node/node.exe', 'node');
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: runtime.root, version: VERSION }),
    /forbidden bundled runtime path/,
  );

  const aex = await fixture(t);
  await write(aex.root, 'native/AeMcpNative.aex', 'aex');
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: aex.root, version: VERSION }),
    /separate release asset/,
  );
});

test('rejects a stage missing any single sidecar-closure file (#239)', async (t) => {
  const closureFiles = [
    'runtime/windows-x64/node/sidecar/agent-sidecar.mjs',
    'runtime/windows-x64/node/sidecar/lib.mjs',
    'runtime/windows-x64/node/shared/tool-approval.mjs',
    'runtime/windows-x64/node/shared/chat-attachments.mjs',
    'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json',
    'runtime/windows-x64/node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  ];
  for (const missing of closureFiles) {
    const broken = await fixture(t);
    await fs.rm(path.join(broken.root, ...missing.split('/')));
    assert.throws(
      () => verifyWindowsZxpStage({ stageRoot: broken.root, version: VERSION }),
      /required ZXP file is missing/,
      `expected a rejection when ${missing} is absent`,
    );
  }

  const missingDeps = await fixture(t);
  await fs.rm(
    path.join(missingDeps.root, 'runtime/windows-x64/node/sidecar/node_modules'),
    { recursive: true },
  );
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: missingDeps.root, version: VERSION }),
    /required ZXP file is missing/,
  );

  for (const stray of ['sidecar/agent-sidecar.mjs', 'shared/tool-approval.mjs']) {
    const strayRootCopy = await fixture(t);
    await write(strayRootCopy.root, stray, '// stray build input\n');
    assert.throws(
      () => verifyWindowsZxpStage({ stageRoot: strayRootCopy.root, version: VERSION }),
      /not at the stage root/,
    );
  }
});

test('rejects a compiled Panel without the matching online runtime wizard', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'client/dist/app.js'), 'PANEL_VERSION="0.9.3"\n');
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: root, version: VERSION }),
    /compiled Panel contract is missing/,
  );
});
