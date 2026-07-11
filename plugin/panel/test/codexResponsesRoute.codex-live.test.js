import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import { createCodexResponsesRoute } from '../src/cep/codexResponsesRoute.js';
import { codexAppServerArgs, codexSpawnEnv } from '../src/lib/providerProfile.js';
import {
  closeServer,
  listen,
  providerFixture,
  resolvedModelProfile,
} from './helpers/providerRouteFixtures.js';

const LIVE_ENABLED = process.env.AE_MCP_CODEX_ROUTE_LIVE === '1';
const LIVE_SKIP = LIVE_ENABLED ? false : 'AE_MCP_CODEX_ROUTE_LIVE is not 1';
const EXPECTED_VERSION = 'codex-cli 0.144.0-alpha.4';
const EXPECTED_SHA256 = 'ea2164f4728fea4049e3bf1eb882dc15c34597ac75544b47976a529feab3c7b4';
const LIVE_MODEL = 'ae-mcp-route-live-model';
const APPROVAL_POLICY = { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false } };
const SANDBOX_POLICY = { type: 'readOnly' };
const COMPACT_BODY = {
  error: {
    type: 'provider_compaction_unsupported',
    code: 'provider_compaction_unsupported',
    message: 'This chat-only provider cannot compact Responses context.',
  },
};

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(new Error('Codex version command failed'));
      else resolve(stdout);
    });
  });
}

async function verifyCodexBinary() {
  const codexPath = String(process.env.AE_MCP_CODEX_CLI || '');
  assert.equal(Boolean(codexPath), true, 'AE_MCP_CODEX_CLI is required for the live route gate');
  assert.equal((await execFileText(codexPath, ['--version'])).trim(), EXPECTED_VERSION);
  assert.equal(createHash('sha256').update(readFileSync(codexPath)).digest('hex'), EXPECTED_SHA256);
  return codexPath;
}

function streamChatCompletion(res, text) {
  const first = {
    id: 'chatcmpl_route_live',
    object: 'chat.completion.chunk',
    created: 1,
    model: LIVE_MODEL,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const done = {
    id: 'chatcmpl_route_live',
    object: 'chat.completion.chunk',
    created: 1,
    model: LIVE_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function createMockProvider({ requireMetadata = false } = {}) {
  const state = {
    records: [],
    metadataAccepted: false,
    sawContinuation: false,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    let requestBytes = 0;
    req.on('data', (chunk) => {
      const value = Buffer.from(chunk);
      requestBytes += value.length;
      chunks.push(value);
    });
    req.on('end', () => {
      const path = new URL(req.url || '/', 'http://provider.invalid').pathname;
      const headerNames = Object.keys(req.headers).map((name) => name.toLowerCase()).sort();
      const record = { method: req.method, path, headerNames, requestBytes, status: 0 };
      state.records.push(record);

      if (req.method === 'GET' && path === '/v1/models') {
        record.status = 200;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: LIVE_MODEL, object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        record.status = 404;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"unsupported mock path"}}');
        return;
      }

      const metadataAccepted = /codex/i.test(String(req.headers['user-agent'] || ''))
        && typeof req.headers['x-client-request-id'] === 'string'
        && req.headers['x-provider-feature'] === 'required'
        && req.headers.authorization === 'Bearer upstream-secret'
        && !Object.hasOwn(req.headers, 'x-ae-mcp-route-token');
      state.metadataAccepted ||= metadataAccepted;
      if (requireMetadata && !metadataAccepted) {
        record.status = 400;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"required request metadata missing"}}');
        return;
      }

      const bodyText = Buffer.concat(chunks).toString('utf8');
      state.sawContinuation ||= bodyText.includes('AFTER_COMPACT_CONTINUATION_MARKER');
      record.status = 200;
      streamChatCompletion(
        res,
        state.sawContinuation ? 'AFTER_COMPACT_OK' : requireMetadata ? 'CODEX_ROUTE_METADATA_OK' : 'LONG_CONTEXT_OK',
      );
    });
  });
  return { server, state };
}

function createObservingFacade(routeBaseUrl) {
  const targetOrigin = new URL(routeBaseUrl).origin;
  const state = { records: [], compact: null };
  const server = http.createServer((req, res) => {
    const target = new URL(req.url || '/', targetOrigin);
    const forwardedHeaders = { ...req.headers };
    delete forwardedHeaders.host;
    delete forwardedHeaders.connection;
    let requestBytes = 0;
    const record = {
      method: req.method,
      path: target.pathname,
      headerNames: Object.keys(req.headers).map((name) => name.toLowerCase()).sort(),
      requestBytes: 0,
      status: 0,
    };
    state.records.push(record);
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: forwardedHeaders,
    }, (upstreamRes) => {
      record.status = upstreamRes.statusCode || 0;
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      if (target.pathname !== '/v1/responses/compact') {
        upstreamRes.pipe(res);
        return;
      }
      const responseChunks = [];
      upstreamRes.on('data', (chunk) => {
        responseChunks.push(Buffer.from(chunk));
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        let exact = false;
        try {
          exact = JSON.stringify(JSON.parse(Buffer.concat(responseChunks).toString('utf8')))
            === JSON.stringify(COMPACT_BODY);
        } catch { exact = false; }
        state.compact = { status: upstreamRes.statusCode || 0, exact };
        res.end();
      });
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"facade proxy failed"}}');
    });
    req.on('data', (chunk) => {
      requestBytes += Buffer.byteLength(chunk);
      upstream.write(chunk);
    });
    req.on('end', () => {
      record.requestBytes = requestBytes;
      upstream.end();
    });
    req.on('aborted', () => upstream.destroy());
  });
  return { server, state };
}

function createRpc(child) {
  let nextId = 1;
  let buffer = '';
  let fatalError = null;
  const pending = new Map();
  const notifications = new Set();
  const fatals = new Set();

  const fail = (message) => {
    if (fatalError) return;
    fatalError = new Error(message);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(fatalError);
    }
    pending.clear();
    for (const listener of fatals) listener(fatalError);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        fail('Codex app-server emitted invalid JSON');
        child.kill();
        return;
      }
      if (message.id !== undefined && !message.method) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error('Codex JSON-RPC request failed'));
        else item.resolve(message.result);
        continue;
      }
      if (message.method && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unsupported live-test client request' },
        })}\n`);
        continue;
      }
      if (message.method) {
        for (const listener of notifications) listener(message);
      }
    }
  });
  child.stderr.resume();
  child.once('error', () => fail('Codex app-server failed to start'));
  child.once('exit', (code) => fail(`Codex app-server exited with code ${code}`));

  return {
    request(method, params, timeoutMs = 30_000) {
      if (fatalError) return Promise.reject(fatalError);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex JSON-RPC ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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

function waitForTurn(rpc, timeoutMs) {
  let text = '';
  let settled = false;
  let timer;
  let removeNotification;
  let removeFatal;
  let resolvePromise;
  let rejectPromise;
  const cleanup = () => {
    clearTimeout(timer);
    removeNotification?.();
    removeFatal?.();
  };
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    removeNotification = rpc.onNotification((message) => {
      if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
        text += message.params.delta;
      }
      if (message.method === 'turn/completed' || message.method === 'error') {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ completed: message.method === 'turn/completed', text });
      }
    });
    removeFatal = rpc.onFatal((error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Codex turn timed out'));
    }, timeoutMs);
  });
  return {
    promise,
    cancel(error) {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    },
  };
}

async function startAppServer(codexPath, runtime, extraArgs = []) {
  const child = spawn(codexPath, [...codexAppServerArgs(runtime), ...extraArgs], {
    cwd: process.cwd(),
    env: codexSpawnEnv(runtime, process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exit = new Promise((resolve) => child.once('exit', resolve));
  const rpc = createRpc(child);
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'ae-mcp-provider-route-live', version: '1' },
      capabilities: { experimentalApi: true },
    }, 30_000);
    return { rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function startThread(rpc) {
  const result = await rpc.request('thread/start', {
    ephemeral: true,
    cwd: process.cwd(),
    model: LIVE_MODEL,
    approvalPolicy: APPROVAL_POLICY,
    approvalsReviewer: 'user',
    sandboxPolicy: SANDBOX_POLICY,
    config: { mcp_servers: {} },
  }, 30_000);
  const threadId = result?.threadId || result?.thread?.id;
  assert.equal(typeof threadId, 'string', 'Codex thread/start returned no thread id');
  return threadId;
}

async function runTurn(rpc, threadId, text, timeoutMs) {
  const watcher = waitForTurn(rpc, timeoutMs);
  try {
    await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      model: LIVE_MODEL,
      approvalPolicy: APPROVAL_POLICY,
      sandboxPolicy: SANDBOX_POLICY,
    }, timeoutMs);
    return await watcher.promise;
  } catch (error) {
    watcher.cancel(error);
    await watcher.promise.catch(() => {});
    throw error;
  }
}

async function startLiveStack({ codexPath, requireMetadata, observeFacade, extraArgs = [] }) {
  const mock = createMockProvider({ requireMetadata });
  let mockListening = false;
  let route = null;
  let observer = null;
  let observerListening = false;
  let appServer = null;
  try {
    const mockPort = await listen(mock.server);
    mockListening = true;
    const providerBaseUrl = `http://127.0.0.1:${mockPort}`;
    const secretRef = {
      kind: 'secret',
      reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model-live/v1',
      revision: 1,
    };
    route = createCodexResponsesRoute({
      provider: providerFixture({
        baseUrl: providerBaseUrl,
        auth: { model: { kind: 'bearer', valueRef: secretRef }, probe: { kind: 'inherit-model' } },
        headers: [{
          id: 'live-feature',
          name: 'x-provider-feature',
          scopes: ['probe', 'model'],
          valueRef: { kind: 'literal', value: 'required' },
        }],
      }),
      resolveRequestProfile: async () => resolvedModelProfile({
        baseUrl: providerBaseUrl,
        auth: { kind: 'header', name: 'authorization', value: 'Bearer upstream-secret' },
        extraHeaders: [{ name: 'x-provider-feature', value: 'required', source: 'literal' }],
      }),
      requireImpl: (name) => ({ http, crypto })[name],
    });
    const local = await route.start();
    let runtimeBaseUrl = local.baseUrl;
    if (observeFacade) {
      observer = createObservingFacade(local.baseUrl);
      const observerPort = await listen(observer.server);
      observerListening = true;
      runtimeBaseUrl = `http://127.0.0.1:${observerPort}/v1`;
    }
    const runtime = {
      providerId: 'ae_mcp_route_live',
      baseUrl: runtimeBaseUrl,
      envHeaders: [{
        name: 'Authorization',
        envName: 'AE_MCP_PROVIDER_HEADER_00',
        value: `Bearer ${local.routeToken}`,
      }],
    };
    appServer = await startAppServer(codexPath, runtime, extraArgs);
    return {
      rpc: appServer.rpc,
      mockState: mock.state,
      observerState: observer?.state || null,
      async close() {
        await appServer?.close();
        if (observerListening) await closeServer(observer.server);
        await route?.close();
        if (mockListening) await closeServer(mock.server);
      },
    };
  } catch (error) {
    await appServer?.close();
    if (observerListening) await closeServer(observer.server);
    await route?.close();
    if (mockListening) await closeServer(mock.server);
    throw error;
  }
}

test('real Codex forwards required metadata through the secured chat-only facade', { skip: LIVE_SKIP }, async () => {
  const codexPath = await verifyCodexBinary();
  const stack = await startLiveStack({ codexPath, requireMetadata: true, observeFacade: false });
  try {
    const threadId = await startThread(stack.rpc);
    const turn = await runTurn(stack.rpc, threadId, 'Reply exactly CODEX_ROUTE_METADATA_OK.', 60_000);
    assert.equal(turn.completed, true, 'metadata live turn did not complete');
    assert.equal(turn.text.includes('CODEX_ROUTE_METADATA_OK'), true, 'metadata response marker missing');
    assert.equal(stack.mockState.metadataAccepted, true, 'required Codex/provider metadata was not accepted');
  } finally {
    await stack.close();
  }
});

test('real Codex continues the same thread after chat-only compact returns 501', { skip: LIVE_SKIP }, async () => {
  const codexPath = await verifyCodexBinary();
  const stack = await startLiveStack({
    codexPath,
    requireMetadata: false,
    observeFacade: true,
    extraArgs: [
      '-c', 'model_context_window=8192',
      '-c', 'model_auto_compact_token_limit=4096',
      '-c', 'model_auto_compact_token_limit_scope="total"',
    ],
  });
  try {
    const threadId = await startThread(stack.rpc);
    const deadline = Date.now() + 180_000;
    for (let turnIndex = 0; turnIndex < 32 && !stack.observerState.compact; turnIndex += 1) {
      const remaining = deadline - Date.now();
      assert.equal(remaining > 0, true, 'compact was not observed within 180 seconds');
      const marker = `LONG_CONTEXT_TURN_${turnIndex}_${'A'.repeat(8192)}`;
      try {
        const turn = await runTurn(stack.rpc, threadId, marker, remaining);
        if (!stack.observerState.compact) {
          assert.equal(turn.completed, true, 'long-context turn failed before compact was observed');
        }
      } catch (error) {
        if (!stack.observerState.compact) throw error;
      }
    }
    assert.equal(Boolean(stack.observerState.compact), true, 'compact was not observed within 32 turns');
    assert.equal(stack.observerState.compact.status, 501, 'compact did not return HTTP 501');
    assert.equal(stack.observerState.compact.exact, true, 'compact did not return the exact fail-closed contract');

    let continuationCompleted = false;
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const continuation = await runTurn(
        stack.rpc,
        threadId,
        'AFTER_COMPACT_CONTINUATION_MARKER',
        remaining,
      );
      continuationCompleted = continuation.completed
        && continuation.text.includes('AFTER_COMPACT_OK')
        && stack.mockState.sawContinuation;
    } catch { continuationCompleted = false; }
    assert.equal(
      continuationCompleted,
      true,
      'chat-only provider cannot continue after provider_compaction_unsupported',
    );
  } finally {
    await stack.close();
  }
});
