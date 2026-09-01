import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  classifyErrorCode,
  errorHint,
} from '../src/lib/errorCodes.js';

test('error code table is frozen and contains the complete panel vocabulary', () => {
  const expected = [
    'AE_MCP_REBUILD_FAILED',
    'AE_MCP_TRANSPORT_REBUILT',
    'AUTH_REQUIRED',
    'BACKEND_ERROR',
    'BACKEND_UNAVAILABLE',
    'CANCELLED',
    'CLI_ARCH_MISMATCH',
    'CLI_MISSING',
    'CLI_PROBE_FAILED',
    'CLI_TOO_OLD',
    'EVENT_STREAM_FAILED',
    'MCP_UNREACHABLE',
    'PROCESS_EXITED',
    'PROVIDER_STREAM_STALLED',
    'RPC_TIMEOUT',
    'SESSION_START_FAILED',
    'SPAWN_FAILED',
    'TRANSPORT_UNCERTAIN',
    'TURN_ABORTED',
    'TURN_INPUT_INVALID',
    'TURN_START_FAILED',
    'UPSTREAM_CONNECTION_CLOSED',
    'UPSTREAM_ERROR',
    'UPSTREAM_HTTP_<status>',
  ];
  assert.equal(Object.isFrozen(ERROR_CODES), true);
  assert.deepEqual(Object.values(ERROR_CODES).map((item) => item.code).sort(), expected);
  for (const item of Object.values(ERROR_CODES)) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.hint), true);
    assert.ok(item.hint.zh);
    assert.ok(item.hint.en);
  }
});

test('classifyErrorCode distinguishes spawn, auth exit, HTTP, JSON-RPC, and resolution failures', () => {
  const enoent = new Error('spawn failed');
  enoent.code = 'ENOENT';
  assert.deepEqual(classifyErrorCode({ error: enoent }), {
    code: 'SPAWN_FAILED',
    kind: 'backend',
  });
  assert.deepEqual(classifyErrorCode({
    exitCode: 1,
    stderrTail: 'Please run /login before continuing',
  }), {
    code: 'AUTH_REQUIRED',
    kind: 'auth',
  });
  assert.deepEqual(classifyErrorCode({ httpStatus: 403 }), {
    code: 'UPSTREAM_HTTP_403',
    kind: 'auth',
  });
  assert.deepEqual(classifyErrorCode({ httpStatus: 500 }), {
    code: 'UPSTREAM_HTTP_500',
    kind: 'network',
  });
  assert.deepEqual(classifyErrorCode({
    upstream: true,
    upstreamText: 'cause: The socket connection was closed unexpectedly',
  }), {
    code: 'UPSTREAM_CONNECTION_CLOSED',
    kind: 'network',
  });
  assert.deepEqual(classifyErrorCode({ jsonRpcCode: -32000, fallbackCode: 'BACKEND_ERROR' }), {
    code: 'BACKEND_ERROR',
    kind: 'backend',
  });
  assert.deepEqual(classifyErrorCode({ resolutionCode: 'ARCH_MISMATCH' }), {
    code: 'CLI_ARCH_MISMATCH',
    kind: 'backend',
  });
});

test('every error hint is available in Chinese and English', () => {
  assert.match(errorHint('CLI_MISSING', 'zh'), /设置.*诊断/);
  assert.match(errorHint('CLI_MISSING', 'en'), /Settings.*Diagnostics/);
  assert.match(errorHint('UPSTREAM_HTTP_429', 'zh'), /状态码/);
  assert.match(errorHint('UPSTREAM_HTTP_429', 'en'), /status code/i);
  assert.match(errorHint('AUTH_REQUIRED', 'zh'), /设置 → AI/);
  assert.match(errorHint('AUTH_REQUIRED', 'en'), /Settings → AI/);
  assert.match(errorHint('AE_MCP_TRANSPORT_REBUILT', 'zh'), /本轮已停止/);
  assert.match(errorHint('AE_MCP_TRANSPORT_REBUILT', 'en'), /turn was stopped/i);
});

test('free-form process output requires HTTP context and authentication failure context', () => {
  assert.deepEqual(classifyErrorCode({
    exitCode: 1,
    stderrTail: 'npm ERR! version 1.5.432\nexit',
  }), {
    code: 'PROCESS_EXITED',
    kind: 'backend',
  });
  assert.deepEqual(classifyErrorCode({
    exitCode: 1,
    stderrTail: 'request failed: unexpected status 502',
  }), {
    code: 'UPSTREAM_HTTP_502',
    kind: 'network',
  });
  assert.deepEqual(classifyErrorCode({ upstreamText: '429 Too Many Requests' }), {
    code: 'UPSTREAM_HTTP_429',
    kind: 'network',
  });
  assert.deepEqual(classifyErrorCode({
    exitCode: 1,
    stderrTail: 'authentication: chatgpt',
  }), {
    code: 'PROCESS_EXITED',
    kind: 'backend',
  });
  assert.deepEqual(classifyErrorCode({
    exitCode: 1,
    stderrTail: 'Authentication failed. Run codex login',
  }), {
    code: 'AUTH_REQUIRED',
    kind: 'auth',
  });
});
