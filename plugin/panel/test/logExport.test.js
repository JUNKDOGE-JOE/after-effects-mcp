import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLogExport, exportFileName, keepLogLine, redactSecrets } from '../src/lib/logExport.js';
import { revealLogExport, writeLogExport } from '../src/cep/logExportFs.js';

test('buildLogExport aggregates panel logs, host info, and sidecar tail', () => {
  const text = buildLogExport({
    panelLogs: ['[10:00:00] Host ready on 127.0.0.1:11488', '[10:00:05] Error: boom'],
    hostInfo: { hostVersion: '0.9.0', pythonVersion: '0.9.0' },
    sidecarTail: 'sidecar stderr line',
    version: '0.9.0',
    now: new Date('2026-07-03T10:00:00Z'),
  });
  assert.match(text, /# ae-mcp panel log export/);
  assert.match(text, /exported-at: 2026-07-03T10:00:00/);
  assert.match(text, /panel-version: 0\.9\.0/);
  assert.match(text, /host-version: 0\.9\.0/);
  assert.match(text, /## panel logs \(2\)/);
  assert.match(text, /Error: boom/);
  assert.match(text, /## sidecar stderr tail/);
  assert.match(text, /sidecar stderr line/);
});

test('exportFileName is timestamped and filesystem-safe', () => {
  const name = exportFileName(new Date('2026-07-03T10:00:00.123Z'));
  assert.equal(name, 'export-2026-07-03T10-00-00-123Z.txt');
  assert.ok(!/[:.]/.test(name.replace(/\.txt$/, '')));
});

test('keepLogLine filters by level: error keeps only error lines, info/debug keep all', () => {
  assert.equal(keepLogLine('error', '[t] Error: boom'), true);
  assert.equal(keepLogLine('error', '[t] Host ready'), false);
  assert.equal(keepLogLine('info', '[t] Host ready'), true);
  assert.equal(keepLogLine('debug', '[t] anything'), true);
});

test('redactSecrets masks generic sk- keys keeping the first 6 chars', () => {
  const out = redactSecrets('spawn env had sk-abcdef1234567890XYZ in it');
  assert.equal(out, 'spawn env had sk-abc...[redacted] in it');
  assert.match(out, /sk-abc\.\.\.\[redacted\]/);
  assert.ok(!out.includes('sk-abcdef1234567890XYZ'));
});

test('redactSecrets masks env-var values keeping var name and first 6 chars', () => {
  assert.equal(
    redactSecrets('ANTHROPIC_API_KEY=sk-abcdef1234567890'),
    'ANTHROPIC_API_KEY=sk-abc...[redacted]'
  );
  assert.equal(
    redactSecrets('ANTHROPIC_AUTH_TOKEN: tok_secret_value_9'),
    'ANTHROPIC_AUTH_TOKEN: tok_se...[redacted]'
  );
  assert.equal(
    redactSecrets('ZCODE_API_KEY=zc_super_secret_1'),
    'ZCODE_API_KEY=zc_sup...[redacted]'
  );
});

test('redactSecrets masks auth headers keeping name, Bearer, and first 6 chars', () => {
  assert.equal(
    redactSecrets('Authorization: Bearer sk-tok_abcdef12345'),
    'Authorization: Bearer sk-tok...[redacted]'
  );
  assert.equal(
    redactSecrets('x-api-key: mylongsecretkey'),
    'x-api-key: mylong...[redacted]'
  );
});

test('redactSecrets redacts overlapping patterns exactly once', () => {
  const out = redactSecrets('X_API_KEY=sk-abcdefgh12345678');
  assert.equal(out, 'X_API_KEY=sk-abc...[redacted]');
  assert.equal((out.match(/\[redacted\]/g) || []).length, 1);
});

test('redactSecrets leaves non-sensitive text unchanged', () => {
  const plain = '[10:00:00] Host ready on 127.0.0.1:11488 (task: export)';
  assert.equal(redactSecrets(plain), plain);
});

test('buildLogExport applies redaction to panel logs and sidecar tail', () => {
  const text = buildLogExport({
    panelLogs: ['[t] using key sk-abcdef1234567890'],
    sidecarTail: 'env ANTHROPIC_API_KEY=sk-zyxwvu9876543210',
    version: '0.9.0',
  });
  assert.ok(!text.includes('sk-abcdef1234567890'));
  assert.ok(!text.includes('sk-zyxwvu9876543210'));
  assert.match(text, /sk-abc\.\.\.\[redacted\]/);
  assert.match(text, /ANTHROPIC_API_KEY=sk-zyx\.\.\.\[redacted\]/);
});

test('writeLogExport uses the platform log catalog and reveal delegates to the adapter', async () => {
  const writes = [];
  const reveals = [];
  const fsImpl = {
    existsSync: () => false,
    mkdirSync: (dir, options) => writes.push({ dir, options }),
    writeFileSync: (file, text, encoding) => writes.push({ file, text, encoding }),
  };
  const platform = {
    paths: { logsRoot: '/Users/a/.ae-mcp/logs', join: (parts) => parts.join('/'), basename: (value) => String(value).split(/[\\/]/).pop() },
    fs: fsImpl,
    revealFile: async (file) => { reveals.push(file); return { exitCode: 0 }; },
  };
  const file = writeLogExport({ text: 'safe', fileName: 'export.txt', platform, fsImpl });
  assert.equal(file, '/Users/a/.ae-mcp/logs/export.txt');
  assert.equal(writes[1].file, file);
  assert.deepEqual(await revealLogExport(file, platform), { exitCode: 0 });
  assert.deepEqual(reveals, [file]);
  assert.throws(
    () => writeLogExport({ text: 'unsafe', fileName: '../outside.txt', platform, fsImpl }),
    /file name/i,
  );
});
