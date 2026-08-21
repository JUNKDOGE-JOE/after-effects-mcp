import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatErrorDetail } from '../src/lib/errorDetail.js';

test('formatErrorDetail renders process, RPC, HTTP, resolution attempts, and stderr', () => {
  const text = formatErrorDetail({
    exitCode: 1,
    signal: 'SIGTERM',
    method: 'turn/start',
    httpStatus: 403,
    endpoint: '/session',
    jsonRpcCode: -32001,
    resolution: {
      code: 'ARCH_MISMATCH',
      attempts: [{ path: 'C:\\Tools\\claude.exe', source: 'path', detail: 'architecture arm64' }],
    },
    stderrTail: 'first line\nlast line',
  });

  assert.match(text, /^exit 1 \(SIGTERM\)$/m);
  assert.match(text, /^method: turn\/start$/m);
  assert.match(text, /^HTTP 403 \/session$/m);
  assert.match(text, /^JSON-RPC code: -32001$/m);
  assert.match(text, /^attempts:$/m);
  assert.match(text, /C:\\Tools\\claude\.exe \[path\]: architecture arm64/);
  assert.match(text, /stderr:\nfirst line\nlast line/);
});

test('formatErrorDetail redacts credentials and URLs in free-text fields line by line', () => {
  const text = formatErrorDetail({
    stderrTail: [
      'safe stderr line',
      'Authorization: Bearer abc',
      'https://relay.example/v1',
      'later stderr line',
    ].join('\n'),
    upstreamMessage: 'upstream context\nhttps://relay.example/v1/models',
    responseExcerpt: 'response context\nAuthorization: Bearer abc',
    lastError: 'last context\nhttps://relay.example/v1/status',
  });

  assert.equal(text.includes('abc'), false);
  assert.equal(text.includes('http'), false);
  assert.match(text, /safe stderr line/);
  assert.match(text, /later stderr line/);
  assert.match(text, /upstream context/);
  assert.match(text, /response context/);
  assert.match(text, /last context/);
});
