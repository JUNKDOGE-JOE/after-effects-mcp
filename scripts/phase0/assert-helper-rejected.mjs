#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGE_BYTES = 65536;
const METHODS = new Set([
  'capabilities',
  'secret.get',
  'secret.set',
  'secret.delete',
  'window.find',
  'window.describe',
  'window.capture',
]);
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);

function phase0Error(message, cause) {
  const error = new Error(message);
  error.code = 'PHASE0_HELPER_REJECTION_INVALID';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function paramsFor(method) {
  if (method === 'capabilities') return {};
  if (method === 'secret.get' || method === 'secret.delete') return { reference: 'forged' };
  if (method === 'secret.set') {
    return { reference: 'forged', value: 'phase0-probe', expectedRevision: null };
  }
  if (method === 'window.find') return { target: 'after-effects-main' };
  if (method === 'window.describe') return { reference: 'forged' };
  return { reference: 'forged', captureId: 'phase0-adversarial' };
}

export function validateRejectedResponse(response, expectedId) {
  if (!exactKeys(response, ['protocolVersion', 'id', 'ok', 'error'])
      || response.protocolVersion !== 1
      || response.id !== expectedId
      || response.ok !== false
      || !exactKeys(response.error, ['code', 'message', 'retryable'])
      || response.error.code !== 'HELPER_UNAUTHORIZED'
      || typeof response.error.message !== 'string'
      || response.error.retryable !== false) {
    throw phase0Error('helper did not return the required unauthorized envelope');
  }
  const counters = [...response.error.message.matchAll(/\bbackendAccessCount=(\d+)\b/g)];
  if (counters.length !== 1 || counters[0][1] !== '0') {
    throw phase0Error('helper rejection did not prove backendAccessCount=0');
  }
  return { code: 'HELPER_UNAUTHORIZED', backendAccessCount: 0 };
}

export async function assertHelperRejected({
  platform,
  root,
  method,
  loadAddon = createRequire(import.meta.url),
}) {
  if (!PLATFORMS.has(platform)) throw phase0Error('unsupported helper platform');
  if (typeof root !== 'string' || root.length === 0) throw phase0Error('helper root is required');
  if (!METHODS.has(method)) throw phase0Error('unsupported helper method');

  const addonPath = path.join(
    path.resolve(root),
    'lib',
    'ae-mcp-platform-helper-transport.node',
  );
  let addon;
  try {
    addon = loadAddon(addonPath);
  } catch (cause) {
    throw phase0Error('could not load the helper transport addon', cause);
  }
  if (!addon || typeof addon.createTransport !== 'function') {
    throw phase0Error('helper transport addon is malformed');
  }

  let transport;
  try {
    transport = addon.createTransport();
  } catch (cause) {
    throw phase0Error('could not create the helper transport', cause);
  }
  if (!transport
      || typeof transport.request !== 'function'
      || typeof transport.close !== 'function') {
    throw phase0Error('helper transport is malformed');
  }

  const request = { protocolVersion: 1, id: 1, method, params: paramsFor(method) };
  const jsonUtf8 = JSON.stringify(request);
  if (Buffer.byteLength(jsonUtf8, 'utf8') > MAX_MESSAGE_BYTES) {
    throw phase0Error('adversarial helper request is oversized');
  }

  let raw;
  try {
    raw = await transport.request(jsonUtf8);
  } finally {
    await transport.close();
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
    throw phase0Error('helper rejection response is not a bounded UTF-8 string');
  }
  let response;
  try {
    response = JSON.parse(raw);
  } catch (cause) {
    throw phase0Error('helper rejection response is not JSON', cause);
  }
  return validateRejectedResponse(response, request.id);
}

function parseArgs(argv) {
  if (argv.length !== 6
      || argv[0] !== '--platform'
      || argv[2] !== '--root'
      || argv[4] !== '--method') {
    throw phase0Error('expected --platform <id> --root <helper-root> --method <helper-method>');
  }
  return { platform: argv[1], root: argv[3], method: argv[5] };
}

async function main(argv) {
  const result = await assertHelperRejected(parseArgs(argv));
  process.stdout.write(`${result.code} backendAccessCount=${result.backendAccessCount}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string'
      ? error.code
      : 'PHASE0_HELPER_REJECTION_INVALID';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
