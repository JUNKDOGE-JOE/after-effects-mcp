import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skipUnlessMacOS } from '../../package/test/helpers/symlink-support.mjs';

const installer = fileURLToPath(new URL('../../install-plugin-dev-macos.sh', import.meta.url));
const source = fs.readFileSync(installer, 'utf8');
// Execute the actual installer prefix, stopping before source validation or writes.
const boundary = source.indexOf('[[ -d "$plugin_src"');
assert.ok(boundary > 0);
const preflight = source.slice(0, boundary) + '\nprintf "PROCESS_CHECK_PASSED\\n"\n';

const cases = [
  ['Adobe helpers survive AE exit', [
    '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/crashpad_handler',
    '/Library/Application Support/Adobe/Adobe Desktop Common/IPCBox/AdobeIPCBroker.app/Contents/MacOS/AdobeIPCBroker',
  ].join('\n'), 0, true],
  ['unrelated processes', '/sbin/launchd\n/usr/bin/node', 0, true],
  ['formal AE', '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects', 0, false],
  ['Beta AE', '/Applications/Adobe After Effects (Beta)/Adobe After Effects (Beta).app/Contents/MacOS/After Effects', 0, false],
  ['renamed bundle', '/custom/renamed.app/Contents/MacOS/After Effects', 0, false],
  ['legacy executable', '/custom/AfterFX', 0, false],
  ['process inspection failure', '/sbin/launchd', 1, false],
  ['empty process listing', '', 0, false],
];
for (const [name, commands, status, allowed] of cases) {
  test(`CEP installer process preflight: ${name}`, (t) => {
    if (skipUnlessMacOS(t)) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cep-process-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const listing = path.join(root, 'commands');
    fs.writeFileSync(listing, commands + '\n');
    fs.writeFileSync(path.join(root, 'ps'), '#!/bin/sh\n[ "$*" = "-axo comm=" ] || exit 97\ncat "$TEST_PS_LIST"\nexit "$TEST_PS_STATUS"\n', { mode: 0o755 });
    const script = path.join(root, 'preflight.sh');
    fs.writeFileSync(script, preflight);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: {
      ...process.env, PATH: root + path.delimiter + process.env.PATH,
      TEST_PS_LIST: listing, TEST_PS_STATUS: String(status),
    } });
    assert.equal(result.status, allowed ? 0 : 1, result.stderr);
    assert.equal(result.stdout.includes('PROCESS_CHECK_PASSED'), allowed);
    if (!allowed) assert.match(result.stderr, /Dev install failed:/);
  });
}
