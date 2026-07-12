import {
  createProviderSecretReference,
  parseProviderSecretReference,
} from './platform/secret-reference.js';
import {
  normalizeProviderEntryV2,
  normalizeProviderEntryV3,
  validateProviderBaseUrl,
} from '../lib/providerProfile.js';

const SLOT_PREFIXES = new Set(['auth-model', 'auth-probe', 'header']);
const PUBLIC_ERROR_CODES = new Set([
  'INVALID_REFERENCE',
  'SECRET_CONFLICT',
  'SECRET_NOT_FOUND',
  'SECRET_STORE_UNAVAILABLE',
]);
const HELPER_AVAILABILITY_CODES = new Set([
  'HELPER_UNAVAILABLE',
  'HELPER_UNAUTHORIZED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'INVALID_REQUEST',
  'MESSAGE_TOO_LARGE',
]);
const PROVIDER_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
  const code = HELPER_AVAILABILITY_CODES.has(error?.code)
    ? 'SECRET_STORE_UNAVAILABLE'
    : PUBLIC_ERROR_CODES.has(error?.code) ? error.code : fallback;
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

function ambiguousCreateFailure(error) {
  return !error?.code
    || HELPER_AVAILABILITY_CODES.has(error.code)
    || error.code === 'SECRET_STORE_UNAVAILABLE'
    || error.code === 'SECRET_OPERATION_FAILED';
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
      if (ambiguousCreateFailure(error)) {
        let recoveryCompleted = false;
        let recovered;
        try {
          recovered = await host.secretGet(reference);
          recoveryCompleted = true;
        } catch { /* retain the original sanitized set failure */ }
        if (recoveryCompleted) {
          if (!hasExactKeys(recovered, ['reference', 'revision', 'value'])
              || recovered.reference !== reference
              || !validRevision(recovered.revision)
              || recovered.value !== input.value) {
            throw providerSecretError('SECRET_CONFLICT');
          }
          return Object.freeze({ kind: 'secret', reference, revision: recovered.revision });
        }
        // The set may have committed, but without a returned/read-back
        // revision there is no safe CAS delete. Never blind-delete here. Full
        // crash recovery needs a durable create intent plus a helper-side
        // idempotency/operation id so startup can reconcile the exact write.
      }
      throw sanitizeHostError(error);
    }
    if (!created || created.reference !== reference || !validRevision(created.revision)) {
      throw providerSecretError('SECRET_CONFLICT');
    }

    let readback;
    let readbackError = null;
    try {
      readback = await host.secretGet(reference);
    } catch (error) {
      readbackError = sanitizeHostError(error);
    }
    const readbackMatches = !readbackError
      && hasExactKeys(readback, ['reference', 'revision', 'value'])
      && readback.reference === reference
      && readback.revision === created.revision
      && readback.value === input.value;
    if (!readbackMatches) {
      try {
        await host.secretDelete({ reference, expectedRevision: created.revision });
      } catch { /* exact-revision rollback is best effort; never broaden it */ }
      if (readbackError) throw readbackError;
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

function normalizeAuthChoice(value) {
  if (!hasExactKeys(value, ['headerName', 'scheme'])) {
    throw providerSecretError('INVALID_REFERENCE');
  }
  if (!['none', 'bearer', 'x-api-key', 'custom'].includes(value.scheme)) {
    throw providerSecretError('INVALID_REFERENCE');
  }
  const headerName = value.headerName === null ? null : String(value.headerName || '').trim();
  if ((value.scheme === 'custom') !== Boolean(headerName)
      || (headerName !== null && !PROVIDER_HEADER_NAME.test(headerName))) {
    throw providerSecretError('INVALID_REFERENCE');
  }
  return { scheme: value.scheme, headerName };
}

async function resolveCredentialAuth(choice, valueRef, secretService) {
  if (choice.scheme === 'none') return { kind: 'none' };
  if (!valueRef) throw providerSecretError('INVALID_REFERENCE');
  const value = await secretService.resolve(valueRef);
  if (choice.scheme === 'bearer') {
    return { kind: 'header', name: 'Authorization', value: `Bearer ${value}` };
  }
  if (choice.scheme === 'x-api-key') {
    return { kind: 'header', name: 'x-api-key', value };
  }
  return { kind: 'header', name: choice.headerName, value };
}

function capabilityTarget(provider, { modelId, protocol }) {
  const selectedModelId = String(modelId || '').trim();
  if (!selectedModelId || !['responses', 'chat', 'messages'].includes(protocol)) return null;
  const model = provider.modelCapabilities.find((entry) => entry.modelId === selectedModelId);
  const capability = model?.[protocol];
  return capability && capability.status !== 'unknown' ? capability : null;
}

function validatedApiRoot(value, provider) {
  if (!value) return provider.baseUrl;
  let apiRoot;
  try {
    apiRoot = validateProviderBaseUrl(value, {
      allowInsecureHttp: provider.allowInsecureHttp,
      requireTransportApproval: true,
    });
  } catch {
    throw providerSecretError('INVALID_REFERENCE');
  }
  if (new URL(apiRoot).origin !== new URL(provider.baseUrl).origin) {
    throw providerSecretError('INVALID_REFERENCE');
  }
  return apiRoot;
}

async function resolveProviderRequestProfileV3(provider, {
  scope,
  secretService,
  modelId,
  protocol,
  authChoice,
  apiRoot,
}) {
  const target = scope === 'model' ? capabilityTarget(provider, { modelId, protocol }) : null;
  let auth;
  if (scope === 'probe' && provider.probeAuthOverride !== null) {
    auth = await resolveAuth(provider.probeAuthOverride, secretService);
  } else {
    let selectedChoice = authChoice === undefined || authChoice === null
      ? target?.auth || (scope === 'probe' && provider.modelList.status === 'supported'
        ? provider.modelList.auth
        : provider.credential.preferredAuth)
      : normalizeAuthChoice(authChoice);
    if (selectedChoice.scheme === 'auto') {
      selectedChoice = provider.credential.valueRef
        ? { scheme: 'bearer', headerName: null }
        : { scheme: 'none', headerName: null };
    }
    auth = await resolveCredentialAuth(
      normalizeAuthChoice(selectedChoice),
      provider.credential.valueRef,
      secretService,
    );
  }
  const extraHeaders = [];
  for (const header of provider.headers) {
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
    providerId: provider.id,
    baseUrl: validatedApiRoot(apiRoot || target?.apiRoot || (
      scope === 'probe' && provider.modelList.status === 'supported'
        ? provider.modelList.apiRoot
        : provider.baseUrl
    ), provider),
    allowInsecureHttp: provider.allowInsecureHttp,
    auth,
    extraHeaders,
    requestProfileRevision: provider.requestProfileRevision,
  };
}

export async function resolveProviderRequestProfile(provider, {
  scope,
  secretService,
  modelId,
  protocol,
  authChoice,
  apiRoot,
} = {}) {
  if (scope !== 'probe' && scope !== 'model') throw new TypeError('scope must be probe or model');
  if (!secretService || typeof secretService.resolve !== 'function') {
    throw new TypeError('secretService.resolve is required');
  }
  if (provider && Object.hasOwn(provider, 'credential')) {
    const normalizedV3 = normalizeProviderEntryV3(provider);
    return resolveProviderRequestProfileV3(normalizedV3, {
      scope,
      secretService,
      modelId,
      protocol,
      authChoice,
      apiRoot,
    });
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
