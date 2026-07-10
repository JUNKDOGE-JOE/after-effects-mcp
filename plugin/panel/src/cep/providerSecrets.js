import {
  createProviderSecretReference,
  parseProviderSecretReference,
} from './platform/secret-reference.js';
import { normalizeProviderEntryV2 } from '../lib/providerProfile.js';

const SLOT_PREFIXES = new Set(['auth-model', 'auth-probe', 'header']);
const PUBLIC_ERROR_CODES = new Set([
  'INVALID_REFERENCE',
  'SECRET_CONFLICT',
  'SECRET_NOT_FOUND',
  'SECRET_STORE_UNAVAILABLE',
]);

function providerSecretError(code) {
  const messages = {
    INVALID_REFERENCE: 'Secret reference is invalid',
    SECRET_CONFLICT: 'Provider secret revision conflict',
    SECRET_NOT_FOUND: 'Provider secret was not found',
    SECRET_STORE_UNAVAILABLE: 'Provider secret store is unavailable',
    SECRET_OPERATION_FAILED: 'Provider secret operation failed',
  };
  const error = new Error(messages[code] || messages.SECRET_OPERATION_FAILED);
  error.code = messages[code] ? code : 'SECRET_OPERATION_FAILED';
  return error;
}

function sanitizeHostError(error, fallback = 'SECRET_OPERATION_FAILED') {
  const code = PUBLIC_ERROR_CODES.has(error?.code) ? error.code : fallback;
  return providerSecretError(code);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function normalizeValueRef(valueRef) {
  if (!hasExactKeys(valueRef, ['kind', 'reference', 'revision']) || valueRef.kind !== 'secret') {
    throw providerSecretError('INVALID_REFERENCE');
  }
  try {
    parseProviderSecretReference(valueRef.reference);
  } catch {
    throw providerSecretError('INVALID_REFERENCE');
  }
  if (!Number.isSafeInteger(valueRef.revision) || valueRef.revision <= 0) {
    throw providerSecretError('INVALID_REFERENCE');
  }
  return {
    kind: 'secret',
    reference: valueRef.reference,
    revision: valueRef.revision,
  };
}

function defaultRandomBytes(size) {
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(size);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  throw providerSecretError('SECRET_STORE_UNAVAILABLE');
}

function randomSuffix(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(8);
  } catch (error) {
    throw sanitizeHostError(error, 'SECRET_STORE_UNAVAILABLE');
  }
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 4 || bytes.length > 10) {
    throw providerSecretError('SECRET_STORE_UNAVAILABLE');
  }
  return Array.from(bytes, (byte) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw providerSecretError('SECRET_STORE_UNAVAILABLE');
    }
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function createProviderSecretService({
  getHost,
  createReference = createProviderSecretReference,
  randomBytes = defaultRandomBytes,
} = {}) {
  if (typeof getHost !== 'function') throw new TypeError('getHost must be a function');
  if (typeof createReference !== 'function') throw new TypeError('createReference must be a function');
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');

  function requireHost() {
    let host;
    try {
      host = getHost();
    } catch (error) {
      throw sanitizeHostError(error, 'SECRET_STORE_UNAVAILABLE');
    }
    if (
      !host
      || typeof host.secretGet !== 'function'
      || typeof host.secretSet !== 'function'
      || typeof host.secretDelete !== 'function'
    ) {
      throw providerSecretError('SECRET_STORE_UNAVAILABLE');
    }
    return host;
  }

  async function resolve(valueRef) {
    const normalized = normalizeValueRef(valueRef);
    let result;
    try {
      result = await requireHost().secretGet(normalized.reference);
    } catch (error) {
      throw sanitizeHostError(error);
    }
    if (
      !hasExactKeys(result, ['reference', 'revision', 'value'])
      || result.reference !== normalized.reference
      || result.revision !== normalized.revision
      || typeof result.value !== 'string'
    ) {
      throw providerSecretError('SECRET_CONFLICT');
    }
    return result.value;
  }

  async function create(input) {
    if (
      !input
      || typeof input !== 'object'
      || typeof input.credentialId !== 'string'
      || !SLOT_PREFIXES.has(input.slotPrefix)
      || typeof input.value !== 'string'
      || input.value.length === 0
    ) {
      throw providerSecretError('INVALID_REFERENCE');
    }

    let reference;
    try {
      reference = createReference({
        providerId: input.credentialId,
        slot: `${input.slotPrefix}-${randomSuffix(randomBytes)}`,
      });
      parseProviderSecretReference(reference);
    } catch (error) {
      throw sanitizeHostError(error, 'INVALID_REFERENCE');
    }

    const host = requireHost();
    let created;
    try {
      created = await host.secretSet({ reference, value: input.value, expectedRevision: null });
    } catch (error) {
      throw sanitizeHostError(error);
    }
    if (!created || created.reference !== reference || !validRevision(created.revision)) {
      throw providerSecretError('SECRET_CONFLICT');
    }

    let readback;
    try {
      readback = await host.secretGet(reference);
    } catch (error) {
      throw sanitizeHostError(error);
    }
    if (
      !readback
      || !hasExactKeys(readback, ['reference', 'revision', 'value'])
      || readback.reference !== reference
      || readback.revision !== created.revision
      || readback.value !== input.value
    ) {
      throw providerSecretError('SECRET_CONFLICT');
    }
    return Object.freeze({ kind: 'secret', reference, revision: created.revision });
  }

  async function deleteSecret(valueRef) {
    const normalized = normalizeValueRef(valueRef);
    let result;
    try {
      result = await requireHost().secretDelete({
        reference: normalized.reference,
        expectedRevision: normalized.revision,
      });
    } catch (error) {
      throw sanitizeHostError(error);
    }
    if (
      !result
      || typeof result.deleted !== 'boolean'
      || result.reference !== undefined && result.reference !== normalized.reference
      || result.revision !== null && !validRevision(result.revision)
    ) {
      throw providerSecretError('SECRET_CONFLICT');
    }
    return { deleted: result.deleted, revision: result.revision };
  }

  return Object.freeze({ resolve, create, delete: deleteSecret });
}

async function resolveAuth(policy, secretService) {
  if (policy.kind === 'none') return { kind: 'none' };
  const value = await secretService.resolve(policy.valueRef);
  if (policy.kind === 'bearer') {
    return { kind: 'header', name: 'Authorization', value: `Bearer ${value}` };
  }
  if (policy.kind === 'x-api-key') {
    return { kind: 'header', name: 'x-api-key', value };
  }
  return { kind: 'header', name: policy.headerName, value };
}

export async function resolveProviderRequestProfile(provider, { scope, secretService } = {}) {
  if (scope !== 'probe' && scope !== 'model') throw new TypeError('scope must be probe or model');
  if (!secretService || typeof secretService.resolve !== 'function') {
    throw new TypeError('secretService.resolve is required');
  }
  const normalized = normalizeProviderEntryV2(provider);
  const selected = scope === 'probe' && normalized.auth.probe.kind === 'inherit-model'
    ? normalized.auth.model
    : normalized.auth[scope];
  const extraHeaders = [];
  for (const header of normalized.headers) {
    if (!header.scopes.includes(scope)) continue;
    if (header.valueRef.kind === 'literal') {
      extraHeaders.push({ name: header.name, value: header.valueRef.value, source: 'literal' });
    } else {
      extraHeaders.push({
        name: header.name,
        value: await secretService.resolve(header.valueRef),
        source: 'secret',
      });
    }
  }
  return {
    providerId: normalized.id,
    baseUrl: normalized.baseUrl,
    allowInsecureHttp: normalized.allowInsecureHttp,
    auth: await resolveAuth(selected, secretService),
    extraHeaders,
    authProfileRevision: normalized.authProfileRevision,
  };
}
