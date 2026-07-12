import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createMessagesSseCollector,
  createResponsesSseCollector,
} from '../plugin/panel/src/lib/providerSseCodec.js';
import {
  codexAppServerArgs,
  codexSpawnEnv,
} from '../plugin/panel/src/lib/providerProfile.js';

export const DEFAULT_EXCLUDED_MODELS = Object.freeze([
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gpt-image-2',
]);

const ALL_LAYERS = Object.freeze(['probe', 'l2', 'codex', 'claude']);
const GRACE_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CDP_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const BRIDGE_GLOBAL = '__AE_MCP_PROVIDER_ACCEPTANCE__';
const LOCAL_HEADER = 'x-ae-mcp-route-token';
const LOCAL_HEADER_ENV = 'AE_MCP_PROVIDER_HEADER_00';
const CODEX_PROVIDER_ID = 'ae-mcp-live';
const PROMPT = 'Reply exactly OK.';
const COLLECTOR_ERROR_CODES = new Set([
  'upstream_sse_malformed',
  'upstream_sse_terminal_missing',
  'upstream_sse_truncated',
  'upstream_stream_error',
]);
const MATRIX_ERROR_CODES = new Set([
  'acceptance_bridge_unavailable',
  'bridge_call_failed',
  'cdp_call_failed',
  'cdp_close_failed',
  'cdp_closed',
  'cdp_invalid',
  'cdp_protocol',
  'cdp_timeout',
  'cdp_unavailable',
  'content_type_invalid',
  'internal_error',
  'invalid_options',
  'invalid_output_path',
  'late_event',
  'local_route_invalid',
  'model_not_found',
  'model_selection_empty',
  'network_error',
  'process_closed',
  'process_exit',
  'process_protocol',
  'process_spawn_failed',
  'provider_not_found',
  'provider_selection_required',
  'ready_timeout',
  'route_cleanup_failed',
  'rpc_failed',
  'stream_too_large',
  'stream_truncated',
  'timeout',
]);
const RESULT_ERROR_CODES = new Set([
  ...MATRIX_ERROR_CODES,
  ...COLLECTOR_ERROR_CODES,
  'claude_error',
  'codex_error',
  'probe_authentication',
  'probe_capability_incompatible',
  'probe_configuration',
  'probe_failed',
  'probe_network',
  'probe_path_unsupported',
  'response_failed',
  'sdk_stream_eof_before_result',
  'terminal_missing',
]);
const TERMINALS = Object.freeze({
  probe: new Set(['probe_complete']),
  responses: new Set(['response.completed', 'response.incomplete', 'response.failed']),
  messages: new Set(['message_stop', 'bounded_eof']),
  codex: new Set(['turn/completed']),
  claude: new Set(['turn-end', 'error']),
});

function matrixError(code) {
  const error = new Error('Provider matrix operation failed.');
  error.code = `matrix_${code}`;
  return error;
}

function safeErrorCode(error, fallback = 'internal_error') {
  if (typeof error?.code === 'string' && /^matrix_[a-z0-9_]+$/.test(error.code)) {
    const code = error.code.slice('matrix_'.length);
    if (MATRIX_ERROR_CODES.has(code) || /^http_[0-9]{3}$/.test(code)) return code;
  }
  if (COLLECTOR_ERROR_CODES.has(error?.code)) return error.code;
  return fallback;
}

function safeResultErrorCode(value) {
  return RESULT_ERROR_CODES.has(value) || /^http_[0-9]{3}$/.test(value)
    ? value
    : 'internal_error';
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function nextValue(argv, index, inline, name) {
  if (inline !== undefined) return { value: inline, next: index };
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw matrixError('invalid_options');
  }
  return { value: argv[index + 1], next: index + 1 };
}

export function parseArgs(argv, { cwd = process.cwd(), execPath = process.execPath } = {}) {
  const options = {
    help: false,
    provider: '',
    exclude: [...DEFAULT_EXCLUDED_MODELS],
    models: [],
    layers: [...ALL_LAYERS],
    codexCli: 'codex',
    node: execPath,
    sidecar: path.resolve(cwd, 'plugin/sidecar/agent-sidecar.mjs'),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    out: path.resolve(cwd, 'build/provider-matrix/provider-matrix-live.json'),
    cwd,
  };
  let excludeOverridden = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') {
      options.help = true;
      continue;
    }
    if (!raw.startsWith('--')) throw matrixError('invalid_options');
    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const consumed = nextValue(argv, index, inline, name);
    index = consumed.next;
    const value = consumed.value;
    if (name === '--provider') options.provider = value.trim();
    else if (name === '--exclude') {
      if (!excludeOverridden) {
        options.exclude = [];
        excludeOverridden = true;
      }
      options.exclude.push(...csv(value));
    } else if (name === '--models') options.models.push(...csv(value));
    else if (name === '--layers') options.layers = csv(value);
    else if (name === '--codex-cli') options.codexCli = value;
    else if (name === '--node') options.node = value;
    else if (name === '--sidecar') options.sidecar = path.resolve(cwd, value);
    else if (name === '--timeout-ms') options.timeoutMs = Number(value);
    else if (name === '--out') options.out = path.resolve(cwd, value);
    else throw matrixError('invalid_options');
  }
  options.exclude = [...new Set(options.exclude)];
  options.models = [...new Set(options.models)];
  options.layers = [...new Set(options.layers)];
  if (
    options.layers.length === 0
    || options.layers.some((layer) => !ALL_LAYERS.includes(layer))
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1_000
    || options.timeoutMs > 600_000
    || !options.codexCli
    || !options.node
    || !options.sidecar
  ) {
    throw matrixError('invalid_options');
  }
  const artifactRoot = path.resolve(cwd, 'build/provider-matrix');
  if (
    path.extname(options.out).toLowerCase() !== '.json'
    || (options.out !== artifactRoot && !options.out.startsWith(`${artifactRoot}${path.sep}`))
  ) {
    throw matrixError('invalid_output_path');
  }
  return options;
}

export function helpText() {
  return [
    'Usage: node scripts/provider-matrix-live.mjs [options]',
    '',
    'Options:',
    '  --provider <id>       Select a Provider; optional only when exactly one exists',
    '  --exclude <ids>       Comma-separated exclusions; first use replaces media defaults',
    '  --models <ids>        Comma-separated model subset; default is Provider inventory',
    '  --layers <names>      probe,l2,codex,claude (default: all)',
    '  --codex-cli <path>    Codex CLI executable (default: codex)',
    '  --node <path>         Node executable for the Claude sidecar',
    '  --sidecar <path>      Claude sidecar entry module',
    '  --timeout-ms <ms>     Per operation timeout, 1000..600000',
    '  --out <path>          JSON below build/provider-matrix',
    '  --help                Show this help without connecting to AE',
  ].join('\n');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeTerminal(client, value) {
  return TERMINALS[client]?.has(value) ? value : null;
}

function resultRecord({ model, client, ok, terminal, duration, errorCode }) {
  const safe = {
    model: String(model),
    client,
    ok: ok === true,
    terminal: safeTerminal(client, terminal),
    duration: Math.max(0, Math.trunc(Number(duration) || 0)),
    errorCode: ok === true ? null : safeResultErrorCode(errorCode),
  };
  if (safe.ok && !safe.terminal) {
    safe.ok = false;
    safe.errorCode = 'terminal_missing';
  }
  if (!safe.ok && !safe.errorCode) safe.errorCode = 'internal_error';
  return safe;
}

async function measuredResult({ model, client, now, operation }) {
  const started = now();
  try {
    const outcome = await operation();
    const ok = outcome?.ok === true;
    return resultRecord({
      model,
      client,
      ok,
      terminal: outcome?.terminal,
      duration: now() - started,
      errorCode: ok ? null : safeResultErrorCode(outcome?.errorCode),
    });
  } catch (error) {
    return resultRecord({
      model,
      client,
      ok: false,
      terminal: null,
      duration: now() - started,
      errorCode: safeErrorCode(error),
    });
  }
}

function chunks(value) {
  return Array.isArray(value) ? value : [value];
}

export function validateResponsesSse(value) {
  const collector = createResponsesSseCollector();
  for (const chunk of chunks(value)) collector.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const response = collector.end();
  const terminal = `response.${response.status}`;
  return { ok: response.status !== 'failed', terminal, errorCode: response.status === 'failed' ? 'response_failed' : null };
}

export function validateMessagesSse(value) {
  const collector = createMessagesSseCollector();
  for (const chunk of chunks(value)) collector.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const output = collector.end();
  return { ok: true, terminal: output.terminalMode, errorCode: null };
}

function loopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw matrixError('local_route_invalid'); }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    || url.username
    || url.password
  ) {
    throw matrixError('local_route_invalid');
  }
  return url;
}

function normalizedRoute(value) {
  const originUrl = loopbackUrl(value?.origin);
  const origin = originUrl.origin;
  const openai = loopbackUrl(value?.openaiBaseUrl);
  const anthropic = loopbackUrl(value?.anthropicBaseUrl);
  if (
    originUrl.pathname !== '/'
    || originUrl.search
    || originUrl.hash
    || value.origin !== origin
    || openai.origin !== origin
    || openai.pathname !== '/v1'
    || openai.search
    || openai.hash
    || value.openaiBaseUrl !== `${origin}/v1`
    || anthropic.origin !== origin
    || anthropic.pathname !== '/'
    || anthropic.search
    || anthropic.hash
    || value.anthropicBaseUrl !== origin
    || typeof value.routeToken !== 'string'
    || !/^\S{16,512}$/.test(value.routeToken)
  ) {
    throw matrixError('local_route_invalid');
  }
  return {
    origin,
    openaiBaseUrl: `${origin}/v1`,
    anthropicBaseUrl: origin,
    routeToken: value.routeToken,
  };
}

function requestLocalSse({ url, routeToken, body, headers = {}, timeoutMs, collector, httpRequest = http.request }) {
  const target = loopbackUrl(url);
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let received = 0;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = httpRequest({
      protocol: 'http:',
      hostname: target.hostname === 'localhost'
        ? '127.0.0.1'
        : target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'content-length': String(encoded.length),
        [LOCAL_HEADER]: routeToken,
        ...headers,
      },
    }, (incoming) => {
      response = incoming;
      if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
        incoming.resume();
        finish(matrixError(`http_${incoming.statusCode || 0}`));
        return;
      }
      if (!String(incoming.headers['content-type'] || '').toLowerCase().includes('text/event-stream')) {
        incoming.resume();
        finish(matrixError('content_type_invalid'));
        return;
      }
      incoming.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > MAX_STREAM_BYTES) {
          incoming.destroy();
          finish(matrixError('stream_too_large'));
          return;
        }
        try { collector.feed(chunk); } catch (error) {
          incoming.destroy();
          finish(error);
        }
      });
      incoming.once('end', () => {
        if (settled) return;
        try { finish(null, collector.end()); } catch (error) { finish(error); }
      });
      incoming.once('error', () => finish(matrixError('network_error')));
      incoming.once('aborted', () => finish(matrixError('stream_truncated')));
    });
    timer = setTimeout(() => {
      request.destroy();
      response?.destroy();
      finish(matrixError('timeout'));
    }, timeoutMs);
    request.once('error', () => finish(matrixError('network_error')));
    request.end(encoded);
  });
}

export async function runResponsesL2({ model, route, timeoutMs, sleep = delay, httpRequest = http.request }) {
  const collector = createResponsesSseCollector();
  const response = await requestLocalSse({
    url: `${route.openaiBaseUrl}/responses`,
    routeToken: route.routeToken,
    timeoutMs,
    httpRequest,
    collector,
    body: {
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
      max_output_tokens: 16,
      stream: true,
    },
  });
  await sleep(GRACE_MS);
  const terminal = `response.${response.status}`;
  return {
    ok: response.status !== 'failed',
    terminal,
    errorCode: response.status === 'failed' ? 'response_failed' : null,
  };
}

export async function runMessagesL2({ model, route, timeoutMs, sleep = delay, httpRequest = http.request }) {
  const collector = createMessagesSseCollector();
  const output = await requestLocalSse({
    url: `${route.anthropicBaseUrl}/v1/messages`,
    routeToken: route.routeToken,
    timeoutMs,
    httpRequest,
    collector,
    headers: { 'anthropic-version': '2023-06-01' },
    body: {
      model,
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    },
  });
  await sleep(GRACE_MS);
  return { ok: true, terminal: output.terminalMode, errorCode: null };
}

function fetchJson(url, { timeoutMs, httpRequest = http.request }) {
  const target = loopbackUrl(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    const parts = [];
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = httpRequest({
      protocol: 'http:',
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(matrixError('cdp_unavailable'));
        return;
      }
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_CDP_BYTES) {
          response.destroy();
          finish(matrixError('cdp_invalid'));
          return;
        }
        parts.push(chunk);
      });
      response.once('end', () => {
        if (settled) return;
        try { finish(null, JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch {
          finish(matrixError('cdp_invalid'));
        }
      });
      response.once('error', () => finish(matrixError('cdp_unavailable')));
    });
    timer = setTimeout(() => {
      request.destroy();
      finish(matrixError('cdp_timeout'));
    }, timeoutMs);
    request.once('error', () => finish(matrixError('cdp_unavailable')));
    request.end();
  });
}

function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) masked[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function createWebSocketPeer(socket, head = Buffer.alloc(0)) {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = null;
  let fragmentParts = [];
  let closed = false;
  let fatal = null;
  const messages = [];
  const messageListeners = new Set();
  const errorListeners = new Set();

  const emitMessage = (text) => {
    if (messageListeners.size === 0) messages.push(text);
    else for (const listener of messageListeners) listener(text);
  };
  const fail = (code) => {
    if (fatal) return;
    fatal = matrixError(code);
    socket.destroy();
    for (const listener of errorListeners) listener(fatal);
  };
  const completeMessage = (opcode, parts) => {
    if (opcode !== 1) {
      fail('cdp_protocol');
      return;
    }
    emitMessage(Buffer.concat(parts).toString('utf8'));
  };
  const drain = () => {
    while (!fatal && buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0 || masked) return fail('cdp_protocol');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wide = buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_CDP_BYTES)) return fail('cdp_protocol');
        length = Number(wide);
        offset = 10;
      }
      if (length > MAX_CDP_BYTES) return fail('cdp_protocol');
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode >= 8) {
        if (!fin || length > 125) return fail('cdp_protocol');
        if (opcode === 8) {
          if (!closed) socket.write(clientFrame(8, payload));
          closed = true;
          socket.end();
        } else if (opcode === 9) socket.write(clientFrame(10, payload));
        else if (opcode !== 10) return fail('cdp_protocol');
        continue;
      }
      if (opcode === 0) {
        if (fragmentOpcode === null) return fail('cdp_protocol');
        fragmentParts.push(payload);
        if (fin) {
          completeMessage(fragmentOpcode, fragmentParts);
          fragmentOpcode = null;
          fragmentParts = [];
        }
        continue;
      }
      if (fragmentOpcode !== null || ![1, 2].includes(opcode)) return fail('cdp_protocol');
      if (fin) completeMessage(opcode, [payload]);
      else {
        fragmentOpcode = opcode;
        fragmentParts = [payload];
      }
    }
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_CDP_BYTES * 2) fail('cdp_protocol');
    else drain();
  });
  socket.once('error', () => fail('cdp_unavailable'));
  socket.once('close', () => {
    closed = true;
    if (!fatal) {
      fatal = matrixError('cdp_closed');
      for (const listener of errorListeners) listener(fatal);
    }
  });
  if (head.length) queueMicrotask(() => socket.emit('data', head));
  return {
    send(text) {
      if (fatal || closed) throw fatal || matrixError('cdp_closed');
      socket.write(clientFrame(1, Buffer.from(text)));
    },
    onMessage(listener) {
      messageListeners.add(listener);
      while (messages.length) listener(messages.shift());
      return () => messageListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      if (fatal) queueMicrotask(() => listener(fatal));
      return () => errorListeners.delete(listener);
    },
    close() {
      if (!closed) {
        closed = true;
        try { socket.write(clientFrame(8)); } catch {}
        socket.end();
      }
    },
  };
}

export function connectWebSocket(value, { timeoutMs = 5_000, httpRequest = http.request } = {}) {
  let target;
  try { target = new URL(value); } catch { return Promise.reject(matrixError('cdp_invalid')); }
  if (
    target.protocol !== 'ws:'
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)
    || target.username
    || target.password
  ) {
    return Promise.reject(matrixError('cdp_invalid'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const key = randomBytes(16).toString('base64');
    let timer = null;
    const finish = (error, peer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(peer);
    };
    const request = httpRequest({
      protocol: 'http:',
      hostname: target.hostname === 'localhost'
        ? '127.0.0.1'
        : target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });
    request.once('upgrade', (response, socket, head) => {
      const expected = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        finish(matrixError('cdp_protocol'));
        return;
      }
      socket.setNoDelay(true);
      finish(null, createWebSocketPeer(socket, head));
    });
    request.once('response', (response) => {
      response.resume();
      finish(matrixError('cdp_unavailable'));
    });
    request.once('error', () => finish(matrixError('cdp_unavailable')));
    timer = setTimeout(() => {
      request.destroy();
      finish(matrixError('cdp_timeout'));
    }, timeoutMs);
    request.end();
  });
}

function createCdpRpc(peer, timeoutMs) {
  let nextId = 1;
  let fatal = null;
  const pending = new Map();
  const fail = (error) => {
    if (fatal) return;
    fatal = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  peer.onMessage((text) => {
    let message;
    try { message = JSON.parse(text); } catch { return fail(matrixError('cdp_invalid')); }
    if (!Number.isSafeInteger(message?.id)) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(matrixError('cdp_call_failed'));
    else item.resolve(message.result);
  });
  peer.onError((error) => fail(error));
  return {
    request(method, params) {
      if (fatal) return Promise.reject(fatal);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(matrixError('cdp_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { peer.send(JSON.stringify({ id, method, params })); } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      fail(matrixError('cdp_closed'));
      peer.close();
    },
  };
}

function bridgeExpression(method, args = []) {
  const encoded = args.map((value) => JSON.stringify(value)).join(',');
  return `(async()=>{const b=globalThis[${JSON.stringify(BRIDGE_GLOBAL)}];if(!b)throw new Error();return await b.${method}(${encoded});})()`;
}

async function evaluate(rpc, expression) {
  const result = await rpc.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails || !result?.result || result.result.type === 'object' && result.result.subtype === 'error') {
    throw matrixError('bridge_call_failed');
  }
  return result.result.value;
}

export async function connectAcceptanceBridge({
  port = 9080,
  timeoutMs = 10_000,
  fetchJsonImpl = fetchJson,
  connectWebSocketImpl = connectWebSocket,
} = {}) {
  let targets;
  try { targets = await fetchJsonImpl(`http://127.0.0.1:${port}/json/list`, { timeoutMs }); } catch {
    targets = await fetchJsonImpl(`http://127.0.0.1:${port}/json`, { timeoutMs });
  }
  if (!Array.isArray(targets)) throw matrixError('cdp_invalid');
  for (const target of targets) {
    if (typeof target?.webSocketDebuggerUrl !== 'string') continue;
    let peer;
    let rpc;
    try {
      peer = await connectWebSocketImpl(target.webSocketDebuggerUrl, { timeoutMs });
      rpc = createCdpRpc(peer, timeoutMs);
      const present = await evaluate(rpc, `Boolean(globalThis[${JSON.stringify(BRIDGE_GLOBAL)}])`);
      if (!present) {
        rpc.close();
        continue;
      }
      return {
        snapshot: () => evaluate(rpc, bridgeExpression('snapshot')),
        probeAll: (providerId, modelIds) => evaluate(
          rpc,
          bridgeExpression('probeAll', [providerId, modelIds]),
        ),
        routes: (providerId, modelIds) => evaluate(
          rpc,
          bridgeExpression('routes', [providerId, modelIds]),
        ),
        startRoute: (providerId) => evaluate(rpc, bridgeExpression('startRoute', [providerId])),
        stopRoute: () => evaluate(rpc, bridgeExpression('stopRoute')),
        close: () => rpc.close(),
      };
    } catch {
      try { rpc?.close(); } catch {}
      try { peer?.close(); } catch {}
    }
  }
  throw matrixError('acceptance_bridge_unavailable');
}

function scrubEnvironment(baseEnv, names) {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  const output = {};
  for (const [name, value] of Object.entries(baseEnv || {})) {
    if (!blocked.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}

export function claudeRouteEnv(baseEnv, route) {
  const output = scrubEnvironment(baseEnv, [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ]);
  output.ANTHROPIC_BASE_URL = route.anthropicBaseUrl;
  output.ANTHROPIC_AUTH_TOKEN = route.routeToken;
  output.ANTHROPIC_API_KEY = '';
  return output;
}

function codexRouteRuntime(route, chatCompatibility = false) {
  return {
    providerId: CODEX_PROVIDER_ID,
    baseUrl: route.openaiBaseUrl,
    envHeaders: [{ name: LOCAL_HEADER, envName: LOCAL_HEADER_ENV, value: route.routeToken }],
    chatCompatibility: chatCompatibility === true,
  };
}

function createLineTransport(child) {
  let buffer = '';
  let fatal = null;
  let closing = false;
  const messageListeners = new Set();
  const fatalListeners = new Set();
  const queuedMessages = [];
  const fail = (code) => {
    if (fatal || closing) return;
    fatal = matrixError(code);
    for (const listener of fatalListeners) listener(fatal);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      fail('process_protocol');
      child.kill();
      return;
    }
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        fail('process_protocol');
        child.kill();
        return;
      }
      if (messageListeners.size === 0) queuedMessages.push(message);
      else for (const listener of messageListeners) listener(message);
    }
  });
  child.stderr?.resume();
  child.once('error', () => fail('process_spawn_failed'));
  child.once('exit', () => fail('process_exit'));
  return {
    write(message) {
      if (fatal || closing || !child.stdin.writable) throw fatal || matrixError('process_closed');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      while (queuedMessages.length) listener(queuedMessages.shift());
      return () => messageListeners.delete(listener);
    },
    onFatal(listener) {
      fatalListeners.add(listener);
      if (fatal) queueMicrotask(() => listener(fatal));
      return () => fatalListeners.delete(listener);
    },
    beginClose() { closing = true; },
  };
}

async function terminateChild(child, transport, sleep = delay) {
  if (!child) return;
  transport?.beginClose();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function createJsonRpc(child, transport, timeoutMs) {
  let nextId = 1;
  const pending = new Map();
  const notifications = new Set();
  const fatals = new Set();
  transport.onMessage((message) => {
    if (message?.id !== undefined && message.method) {
      transport.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Unsupported live matrix request' },
      });
      return;
    }
    if (message?.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(matrixError('rpc_failed'));
      else item.resolve(message.result);
      return;
    }
    if (message?.method) for (const listener of notifications) listener(message);
  });
  transport.onFatal((error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    for (const listener of fatals) listener(error);
  });
  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(matrixError('timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { transport.write({ jsonrpc: '2.0', id, method, params }); } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onFatal(listener) {
      fatals.add(listener);
      return () => fatals.delete(listener);
    },
  };
}

function terminalWatcher({ onMessage, onFatal, classify, timeoutMs, sleep }) {
  let terminal = null;
  let late = false;
  let settled = false;
  let resolveTerminal;
  let rejectTerminal;
  const promise = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const removeMessage = onMessage((message) => {
    const classification = classify(message);
    if (!classification) return;
    if (terminal) {
      late = true;
      return;
    }
    if (classification.terminal) {
      terminal = classification;
      settled = true;
      clearTimeout(timer);
      resolveTerminal(classification);
    }
  });
  const removeFatal = onFatal((error) => {
    if (terminal) late = true;
    else if (!settled) {
      settled = true;
      clearTimeout(timer);
      rejectTerminal(error);
    }
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectTerminal(matrixError('timeout'));
  }, timeoutMs);
  return {
    async wait() {
      try {
        const outcome = await promise;
        await sleep(GRACE_MS);
        if (late) throw matrixError('late_event');
        return outcome;
      } finally {
        clearTimeout(timer);
        removeMessage();
        removeFatal();
      }
    },
  };
}

export async function runCodexModel({
  model,
  route,
  options,
  chatCompatibility = false,
  spawnImpl = nodeSpawn,
  sleep = delay,
  baseEnv = process.env,
}) {
  let child = null;
  let transport = null;
  try {
    const runtime = codexRouteRuntime(route, chatCompatibility);
    const cleanBase = scrubEnvironment(baseEnv, [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    child = spawnImpl(options.codexCli, codexAppServerArgs(runtime), {
      cwd: options.cwd,
      env: codexSpawnEnv(runtime, cleanBase),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    transport = createLineTransport(child);
    const rpc = createJsonRpc(child, transport, options.timeoutMs);
    await rpc.request('initialize', {
      clientInfo: { name: 'ae-mcp-provider-matrix', version: '1' },
      capabilities: { experimentalApi: true },
    });
    const thread = await rpc.request('thread/start', {
      ephemeral: true,
      cwd: options.cwd,
      model,
      approvalPolicy: { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false } },
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' },
      config: { mcp_servers: {} },
    });
    const threadId = thread?.threadId || thread?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw matrixError('rpc_failed');
    const watcher = terminalWatcher({
      onMessage: rpc.onNotification,
      onFatal: rpc.onFatal,
      timeoutMs: options.timeoutMs,
      sleep,
      classify(message) {
        if (message.method === 'turn/completed') {
          const params = message.params || {};
          const turn = params.turn && typeof params.turn === 'object' ? params.turn : params;
          const failed = Boolean(turn.error || params.error || ['failed', 'error'].includes(turn.status));
          return {
            terminal: 'turn/completed',
            ok: !failed,
            errorCode: failed ? 'codex_error' : null,
          };
        }
        if (message.method === 'error') return { terminal: null };
        if (message.method === 'item/agentMessage/delta') return { terminal: null };
        return null;
      },
    });
    await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT }],
      model,
      effort: 'low',
      approvalPolicy: { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false } },
      sandboxPolicy: { type: 'readOnly' },
    });
    return await watcher.wait();
  } finally {
    await terminateChild(child, transport, sleep);
  }
}

function waitForSidecarReady(transport, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeMessage();
      removeFatal();
      if (error) reject(error);
      else resolve();
    };
    const removeMessage = transport.onMessage((message) => {
      if (message?.t === 'ready') finish(null);
    });
    const removeFatal = transport.onFatal((error) => finish(error));
    const timer = setTimeout(() => finish(matrixError('ready_timeout')), timeoutMs);
  });
}

export async function runClaudeModel({
  model,
  route,
  options,
  spawnImpl = nodeSpawn,
  sleep = delay,
  baseEnv = process.env,
}) {
  let child = null;
  let transport = null;
  try {
    child = spawnImpl(options.node, [options.sidecar, '--lang', 'zh', '--channel', 'api'], {
      cwd: options.cwd,
      env: claudeRouteEnv(baseEnv, route),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    transport = createLineTransport(child);
    await waitForSidecarReady(transport, options.timeoutMs);
    const watcher = terminalWatcher({
      onMessage: transport.onMessage,
      onFatal: transport.onFatal,
      timeoutMs: options.timeoutMs,
      sleep,
      classify(message) {
        const event = message?.t === 'event' ? message.event : null;
        if (!event) return null;
        if (event.type === 'turn-end') return { terminal: 'turn-end', ok: true, errorCode: null };
        if (event.type === 'error') {
          return {
            terminal: 'error',
            ok: false,
            errorCode: event.code === 'SDK_STREAM_EOF_BEFORE_RESULT'
              ? 'sdk_stream_eof_before_result'
              : 'claude_error',
          };
        }
        if (['text-delta', 'thinking', 'tool-start', 'tool-result'].includes(event.type)) {
          return { terminal: null };
        }
        return null;
      },
    });
    transport.write({
      t: 'user',
      text: PROMPT,
      permissionMode: 'none',
      model,
      effort: 'low',
    });
    return await watcher.wait();
  } finally {
    await terminateChild(child, transport, sleep);
  }
}

function selectProvider(snapshot, requestedProvider) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  if (requestedProvider) {
    const provider = providers.find((entry) => entry?.id === requestedProvider);
    if (!provider) throw matrixError('provider_not_found');
    return provider;
  }
  if (providers.length !== 1) throw matrixError('provider_selection_required');
  return providers[0];
}

function selectModels(provider, options) {
  const inventory = Array.isArray(provider?.modelIds)
    ? provider.modelIds.filter((model) => typeof model === 'string' && model)
    : [];
  const inventorySet = new Set(inventory);
  if (options.models.some((model) => !inventorySet.has(model))) throw matrixError('model_not_found');
  const selected = options.models.length ? options.models : inventory;
  const excluded = new Set(options.exclude);
  const models = selected.filter((model) => !excluded.has(model));
  if (models.length === 0) throw matrixError('model_selection_empty');
  return models;
}

function sanitizedProbeCode(reason) {
  const values = new Set([
    'authentication',
    'capability-incompatible',
    'configuration',
    'network',
    'path-unsupported',
    'probe-failed',
  ]);
  return values.has(reason) ? `probe_${reason.replace(/-/g, '_')}` : 'probe_failed';
}

function probeRecords(models, value, duration) {
  const byModel = new Map((Array.isArray(value?.results) ? value.results : [])
    .filter((entry) => typeof entry?.modelId === 'string')
    .map((entry) => [entry.modelId, entry]));
  return models.map((model) => {
    const item = byModel.get(model);
    const ok = item?.ok === true;
    return resultRecord({
      model,
      client: 'probe',
      ok,
      terminal: ok ? 'probe_complete' : null,
      duration,
      errorCode: ok ? null : sanitizedProbeCode(item?.reason),
    });
  });
}

function reportObject(options, results, now) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    layers: ALL_LAYERS.filter((layer) => options.layers.includes(layer)),
    excludedModels: [...options.exclude],
    results: results.map((entry) => ({
      model: entry.model,
      client: entry.client,
      ok: entry.ok,
      terminal: entry.terminal,
      duration: entry.duration,
      errorCode: entry.errorCode,
    })),
  };
}

export async function runProviderMatrix(options, {
  connectBridge = connectAcceptanceBridge,
  runResponses = runResponsesL2,
  runMessages = runMessagesL2,
  runCodex = runCodexModel,
  runClaude = runClaudeModel,
  now = Date.now,
} = {}) {
  const bridge = await connectBridge({ timeoutMs: options.timeoutMs });
  const results = [];
  let primaryError = null;
  try {
    const snapshot = await bridge.snapshot();
    const provider = selectProvider(snapshot, options.provider);
    const models = selectModels(provider, options);
    if (options.layers.includes('probe')) {
      for (const model of models) {
        const started = now();
        try {
          const probed = await bridge.probeAll(provider.id, [model]);
          results.push(...probeRecords([model], probed, now() - started));
        } catch (error) {
          results.push(resultRecord({
            model,
            client: 'probe',
            ok: false,
            terminal: null,
            duration: now() - started,
            errorCode: safeErrorCode(error, 'probe_failed'),
          }));
        }
      }
    }
    if (options.layers.some((layer) => ['l2', 'codex', 'claude'].includes(layer))) {
      const route = normalizedRoute(await bridge.startRoute(provider.id));
      let routeSummaries = null;
      if (options.layers.includes('codex') && typeof bridge.routes === 'function') {
        routeSummaries = await bridge.routes(provider.id, models);
      }
      const codexRoutes = new Map((Array.isArray(routeSummaries?.results)
        ? routeSummaries.results
        : []).flatMap((entry) => (
        typeof entry?.modelId === 'string' ? [[entry.modelId, entry.routes?.codex]] : []
      )));
      if (options.layers.includes('l2')) {
        for (const model of models) {
          results.push(await measuredResult({
            model,
            client: 'responses',
            now,
            operation: () => runResponses({ model, route, timeoutMs: options.timeoutMs }),
          }));
          results.push(await measuredResult({
            model,
            client: 'messages',
            now,
            operation: () => runMessages({ model, route, timeoutMs: options.timeoutMs }),
          }));
        }
      }
      if (options.layers.includes('codex')) {
        for (const model of models) {
          results.push(await measuredResult({
            model,
            client: 'codex',
            now,
            operation: () => runCodex({
              model,
              route,
              options,
              chatCompatibility: codexRoutes.get(model)?.upstreamProtocol !== 'responses',
            }),
          }));
        }
      }
      if (options.layers.includes('claude')) {
        for (const model of models) {
          results.push(await measuredResult({
            model,
            client: 'claude',
            now,
            operation: () => runClaude({ model, route, options }),
          }));
        }
      }
    }
    return reportObject(options, results, now);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    try { await bridge.stopRoute(); } catch { cleanupError = matrixError('route_cleanup_failed'); }
    try { bridge.close(); } catch { cleanupError ||= matrixError('cdp_close_failed'); }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}

export function writeReport(report, outputPath, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(outputPath), { recursive: true });
  fsImpl.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try { fsImpl.chmodSync(outputPath, 0o600); } catch {}
}

export async function runCli(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  exitCode = (value) => { process.exitCode = value; },
  ...deps
} = {}) {
  let options;
  try { options = parseArgs(argv, deps); } catch (error) {
    stderr.write(`${safeErrorCode(error, 'invalid_options')}\n`);
    exitCode(2);
    return null;
  }
  if (options.help) {
    stdout.write(`${helpText()}\n`);
    exitCode(0);
    return null;
  }
  try {
    const report = await runProviderMatrix(options, deps);
    writeReport(report, options.out, deps);
    for (const result of report.results) stdout.write(`${JSON.stringify(result)}\n`);
    exitCode(report.results.every((result) => result.ok) ? 0 : 1);
    return report;
  } catch (error) {
    stderr.write(`${safeErrorCode(error)}\n`);
    exitCode(2);
    return null;
  }
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) await runCli(process.argv.slice(2));
