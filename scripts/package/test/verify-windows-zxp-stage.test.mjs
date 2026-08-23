import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWindowsZxpStage } from '../verify-windows-zxp-stage.mjs';

const VERSION = '0.10.2';

async function write(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-zxp-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [
    'client/dist/app.js',
    'CSXS/manifest.xml',
    'host/server.js',
    'host/package.json',
    'host/package-lock.json',
    'host/node_modules/express/package.json',
    'host/stdio-shim.js',
    'host/mcp/generated/native_exec.generated.json',
    'host/mcp/generated/aegp-rpc.schema.json',
    'host/mcp/skills_bundled/manifest.json',
    'jsx/runtime.jsx',
    'shared/chat-attachments.mjs',
    'shared/tool-approval.mjs',
  ];
  for (const file of files) {
    let value = '{}\n';
    if (file === 'client/dist/app.js') {
      value = [
        `const PANEL_VERSION = "${VERSION}";`,
        'const shim = "/host/stdio-shim.js";',
        'const command = "claude mcp add --transport http ae";',
      ].join('\n');
    }
    if (file === 'host/package.json') value = '{"dependencies":{"express":"4.22.2"}}\n';
    await write(root, file, value);
  }
  return root;
}

test('accepts the direct host and panel ZXP payload', async (t) => {
  const root = await fixture(t);
  const result = verifyWindowsZxpStage({ stageRoot: root, version: VERSION });
  assert.equal(result.platform, 'windows-x64');
  assert.equal(result.version, VERSION);
  assert.equal(result.fileCount, 13);
});

test('rejects retired roots and nested native binaries', async (t) => {
  const root = await fixture(t);
  await write(root, 'runtime/windows-x64/node/node.exe', 'node');
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: root, version: VERSION }),
    /retired ZXP payload root/,
  );

  const nativeRoot = await fixture(t);
  await write(nativeRoot, 'host/node_modules/example/native.node', 'native');
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: nativeRoot, version: VERSION }),
    /nested native binary/,
  );
});

test('rejects an unpinned host Express dependency', async (t) => {
  const root = await fixture(t);
  await write(root, 'host/package.json', '{"dependencies":{"express":"^4.22.2"}}\n');
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: root, version: VERSION }),
    /Express dependency is not pinned/,
  );
});

test('rejects a compiled Panel without the new client markers', async (t) => {
  const root = await fixture(t);
  await write(root, 'client/dist/app.js', `const PANEL_VERSION = "${VERSION}";\n`);
  assert.throws(
    () => verifyWindowsZxpStage({ stageRoot: root, version: VERSION }),
    /compiled Panel contract is missing/,
  );
});
