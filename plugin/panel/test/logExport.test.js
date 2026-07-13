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

test('redactSecrets fully masks generic sk- keys', () => {
  const out = redactSecrets('spawn env had sk-abcdef1234567890XYZ in it');
  assert.equal(out, 'spawn env had [redacted] in it');
  assert.ok(!out.includes('sk-abcdef1234567890XYZ'));
});

test('redactSecrets fully masks credential environment values', () => {
  assert.equal(
    redactSecrets('ANTHROPIC_API_KEY=sk-abcdef1234567890'),
    'ANTHROPIC_API_KEY=[redacted]'
  );
  assert.equal(
    redactSecrets('ANTHROPIC_AUTH_TOKEN: tok_secret_value_9'),
    'ANTHROPIC_AUTH_TOKEN: [redacted]'
  );
  assert.equal(
    redactSecrets('ZCODE_API_KEY=zc_super_secret_1'),
    'ZCODE_API_KEY=[redacted]'
  );
});

test('redactSecrets fully masks credential headers', () => {
  assert.equal(
    redactSecrets('Authorization: Bearer sk-tok_abcdef12345'),
    'Authorization: [redacted]'
  );
  assert.equal(
    redactSecrets('x-api-key: mylongsecretkey'),
    'x-api-key: [redacted]'
  );
});

test('redactSecrets redacts overlapping patterns exactly once', () => {
  const out = redactSecrets('X_API_KEY=sk-abcdefgh12345678');
  assert.equal(out, 'X_API_KEY=[redacted]');
  assert.equal((out.match(/\[redacted\]/g) || []).length, 1);
});

test('redactSecrets leaves non-sensitive text unchanged', () => {
  const plain = '[10:00:00] Host ready on 127.0.0.1:11488 (task: export)';
  assert.equal(redactSecrets(plain), plain);
});

test('redactSecrets hides opaque provider references completely', () => {
  assert.equal(
    redactSecrets('ref=aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1'),
    'ref=[secret-reference-redacted]',
  );
});

test('buildLogExport applies redaction to panel logs and sidecar tail', () => {
  const text = buildLogExport({
    panelLogs: ['[t] using key sk-abcdef1234567890'],
    sidecarTail: 'env ANTHROPIC_API_KEY=sk-zyxwvu9876543210',
    version: '0.9.0',
  });
  assert.ok(!text.includes('sk-abcdef1234567890'));
  assert.ok(!text.includes('sk-zyxwvu9876543210'));
  assert.match(text, /using key \[redacted\]/);
  assert.match(text, /ANTHROPIC_API_KEY=\[redacted\]/);
});

test('redactSecrets covers Basic, cookies, custom headers, assignments, and nested JSON', () => {
  const secret = 'opaque-value-without-known-prefix';
  const input = [
    `Authorization: Basic ${secret}`,
    `Cookie: sid=${secret}`,
    `X-Custom-Token: ${secret}`,
    `client_secret=${secret}`,
    JSON.stringify({ nested: { session_credential: secret } }),
  ].join('\n');
  const output = redactSecrets(input);
  assert.equal(output.includes(secret), false);
  assert.equal((output.match(/\[redacted\]/g) || []).length, 1);
});

test('buildLogExport applies exact active-secret redaction without retaining a prefix', () => {
  const secret = 'opaque-active-provider-value';
  const text = buildLogExport({
    panelLogs: [`upstream echoed ${secret}`],
    sidecarTail: `failure body ${secret}`,
    exactSecrets: [secret],
  });
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('opaque'), false);
});

test('buildLogExport removes JSON-escaped exact secrets from values and object keys', () => {
  for (const secret of ['opaque"provider-secret', 'opaque\\provider-secret']) {
    const payload = JSON.stringify({ message: secret, keyed: { [secret]: 'safe' } });
    const escaped = JSON.stringify(secret).slice(1, -1);
    const text = buildLogExport({
      panelLogs: [`[t] ${payload}`],
      sidecarTail: payload,
      exactSecrets: [secret],
    });
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(escaped), false);
    assert.match(text, /\[redacted\]/);
  }
});

test('buildLogExport removes percent and Unicode encoded exact secrets', () => {
  const secret = 'opaque-provider-secret';
  for (const reflected of [
    'opaque%2dprovider%2dsecret',
    '%6f%70%61%71%75%65%2dprovider%2dsecret',
    'opaque\\u002dprovider%2dsecret',
  ]) {
    const text = buildLogExport({ panelLogs: [`[t] upstream echoed ${reflected}`], exactSecrets: [secret] });
    assert.equal(text.includes(reflected), false);
    assert.equal(text.includes(secret), false);
  }
});

test('redactSecrets recursively covers compound credential fields without an exact inventory', () => {
  const secret = 'opaque-value-without-prefix';
  const payloads = [
    { session_credential: { value: secret } },
    { clientSecret: secret },
    { accessToken: secret },
    { 'auth.token': secret },
  ];
  for (const payload of payloads) {
    const output = redactSecrets(JSON.stringify(payload));
    assert.equal(output.includes(secret), false, JSON.stringify(payload));
    assert.match(output, /\[redacted\]/);
  }
  const exported = buildLogExport({ panelLogs: payloads.map((payload) => JSON.stringify(payload)) });
  assert.equal(exported.includes(secret), false);
});

test('buildLogExport fails closed on prefixed inspect-style credential assignments', () => {
  const secret = 'opaque-value-without-prefix';
  const lines = [
    `[t] payload client_secret: { value: ${secret} }`,
    `[t] err { clientSecret: { value: ${secret} } }`,
    `[t] payload auth.token: [${secret}]`,
    `[t] Authorization=Basic ${secret}`,
    `[t] client_secret="opaque value with spaces"`,
  ];
  const output = buildLogExport({ panelLogs: lines });
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('opaque value with spaces'), false);
  assert.equal((output.match(/\[redacted\]/g) || []).length, lines.length);
});

test('buildLogExport consumes multiline sensitive containers as one protected value', () => {
  const secret = 'opaque-multiline-value';
  const text = buildLogExport({
    panelLogs: [
      `[t] payload client_secret: {\n  value: ${secret}\n}`,
      `[t] payload token: [\n  ${secret}\n]`,
    ],
  });
  assert.equal(text.includes(secret), false);
  assert.equal((text.match(/\[redacted\]/g) || []).length, 2);
});

test('buildLogExport truncates inspect string containers before quoted braces can escape', () => {
  for (const input of [
    "[t] client_secret: { value: 'opaque} tail-secret' } safe-suffix",
    '[t] client_secret: { value: `opaque\'"} tail-secret` } safe-suffix',
  ]) {
    const text = buildLogExport({ panelLogs: [input] });
    assert.equal(text.includes('tail-secret'), false);
    assert.match(text, /client_secret:\s*\[redacted\]/);
    assert.equal(text.includes('safe-suffix'), false);
  }
});

test('buildLogExport truncates generic multiline credential syntax at the entry boundary', () => {
  const secret = 'opaque-yaml-secret';
  const text = buildLogExport({
    panelLogs: [
      `client_secret: |\n  ${secret}`,
      `accessToken: >-\n  ${secret}`,
      `password=\\\n  ${secret}`,
    ],
  });
  assert.equal(text.includes(secret), false);
  assert.equal((text.match(/\[redacted\]/g) || []).length, 3);
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
