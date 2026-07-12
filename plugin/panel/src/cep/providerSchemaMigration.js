import {
  normalizeProviderEntryV2,
  normalizeProviderEntryV3,
} from '../lib/providerProfile.js';
import { buildProviderApiBaseUrl } from '../lib/providerUrl.js';
import { parseProviderSecretReference } from './platform/secret-reference.js';

const STATE_KEYS = ['migratedLegacy', 'pendingSecretDeletes', 'providers', 'revision', 'version'];
const VALUE_REF_KEYS = ['kind', 'reference', 'revision'];
const MODEL_LIST_TTL_MS = 3_600_000;

function migrationError() {
  const error = new Error('Provider schema migration is invalid');
  error.code = 'INVALID_PROVIDER_MIGRATION';
  return error;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeValueRef(value) {
  if (
    !hasExactKeys(value, VALUE_REF_KEYS)
    || value.kind !== 'secret'
    || !Number.isSafeInteger(value.revision)
    || value.revision <= 0
  ) {
    throw migrationError();
  }
  try { parseProviderSecretReference(value.reference); } catch { throw migrationError(); }
  return { kind: 'secret', reference: value.reference, revision: value.revision };
}

function providerReferences(provider) {
  const refs = [];
  const add = (valueRef) => {
    if (valueRef?.kind === 'secret') refs.push(valueRef);
  };
  add(provider.auth.model.valueRef);
  add(provider.auth.probe.valueRef);
  provider.headers.forEach((header) => add(header.valueRef));
  return refs;
}

function normalizeStateV2(value) {
  if (
    !hasExactKeys(value, STATE_KEYS)
    || value.version !== 2
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || value.migratedLegacy !== true
    || !Array.isArray(value.pendingSecretDeletes)
    || !Array.isArray(value.providers)
  ) {
    throw migrationError();
  }
  let providers;
  try { providers = value.providers.map(normalizeProviderEntryV2); } catch { throw migrationError(); }
  const providerIds = new Set();
  const activeReferences = new Map();
  for (const provider of providers) {
    if (providerIds.has(provider.id)) throw migrationError();
    providerIds.add(provider.id);
    for (const ref of providerReferences(provider)) {
      const existingRevision = activeReferences.get(ref.reference);
      if (existingRevision !== undefined && existingRevision !== ref.revision) throw migrationError();
      activeReferences.set(ref.reference, ref.revision);
    }
  }
  const pendingReferences = new Set();
  const pendingSecretDeletes = value.pendingSecretDeletes.map((entry) => {
    const ref = normalizeValueRef(entry);
    if (pendingReferences.has(ref.reference) || activeReferences.has(ref.reference)) {
      throw migrationError();
    }
    pendingReferences.add(ref.reference);
    return ref;
  });
  return {
    version: 2,
    revision: value.revision,
    migratedLegacy: true,
    pendingSecretDeletes,
    providers,
  };
}

function preferredAuth(policy) {
  if (policy.kind === 'none') return { scheme: 'none', headerName: null };
  return {
    scheme: policy.kind,
    headerName: policy.kind === 'custom' ? policy.headerName : null,
  };
}

function credentialFromV2(provider) {
  const modelAuth = provider.auth.model;
  return {
    valueRef: modelAuth.kind === 'none' ? null : clone(modelAuth.valueRef),
    preferredAuth: preferredAuth(modelAuth),
  };
}

function probeOverrideFromV2(provider) {
  return provider.auth.probe.kind === 'inherit-model' ? null : clone(provider.auth.probe);
}

function safeExpiry(checkedAt) {
  return Math.min(Number.MAX_SAFE_INTEGER, checkedAt + MODEL_LIST_TTL_MS);
}

function modelListFromV2(provider) {
  if (!provider.probedModels.length || provider.probedAt <= 0) {
    return {
      revision: 0,
      status: 'unknown',
      apiRoot: null,
      auth: null,
      models: [],
      checkedAt: 0,
      validUntil: 0,
      requestProfileRevision: provider.authProfileRevision,
    };
  }
  const probePolicy = provider.auth.probe.kind === 'inherit-model'
    ? provider.auth.model
    : provider.auth.probe;
  return {
    revision: 1,
    status: 'supported',
    apiRoot: buildProviderApiBaseUrl({
      baseUrl: provider.baseUrl,
      allowInsecureHttp: provider.allowInsecureHttp,
    }).toString(),
    auth: preferredAuth(probePolicy),
    models: provider.probedModels.map((model) => ({
      ...clone(model),
      metadata: {
        task: null,
        inputModalities: [],
        outputModalities: [],
        capabilities: [],
      },
    })),
    checkedAt: provider.probedAt,
    validUntil: safeExpiry(provider.probedAt),
    requestProfileRevision: provider.authProfileRevision,
  };
}

function providerV3FromV2(rawProvider) {
  const provider = normalizeProviderEntryV2(rawProvider);
  const probePreference = provider.dialect.override?.wireApi
    || (provider.protocol === 'anthropic' ? 'messages' : null);
  return normalizeProviderEntryV3({
    id: provider.id,
    credentialId: provider.credentialId,
    name: provider.name,
    baseUrl: provider.baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp,
    requestProfileRevision: provider.authProfileRevision,
    credential: credentialFromV2(provider),
    probeAuthOverride: probeOverrideFromV2(provider),
    headers: clone(provider.headers),
    probePreference,
    modelList: modelListFromV2(provider),
    // Only the full three-protocol probe can publish role and token-field capabilities.
    modelCapabilities: [],
    routeOverrides: [],
  });
}

export function buildProviderStateV3FromV2(value) {
  const state = normalizeStateV2(value);
  return {
    version: 3,
    revision: state.revision + 1,
    migratedLegacy: true,
    pendingSecretDeletes: clone(state.pendingSecretDeletes),
    providers: state.providers.map(providerV3FromV2),
  };
}

export async function migrateProviderStoreV2ToV3({ store } = {}) {
  if (
    !store
    || typeof store.readSchemaMigrationInput !== 'function'
    || typeof store.writeRedactedBackup !== 'function'
    || typeof store.replaceState !== 'function'
  ) {
    throw migrationError();
  }
  const input = store.readSchemaMigrationInput();
  if (input === null) {
    return { status: 'already-committed', migrated: 0, fromVersion: 3, toVersion: 3 };
  }
  if (
    !input
    || typeof input.sourceRevision !== 'string'
    || !input.sourceRevision
  ) {
    throw migrationError();
  }
  const source = normalizeStateV2(input.state);
  const next = buildProviderStateV3FromV2(source);
  // This migration never resolves or rewrites a secret; every active and
  // pending opaque reference is copied with its exact revision.
  await store.writeRedactedBackup(source, { keep: 3, maxAgeDays: 30 });
  const result = store.replaceState(next, {
    expectedSourceRevision: input.sourceRevision,
    expectedSourceVersion: 2,
  });
  if (!result || result.stateRevision !== next.revision) throw migrationError();
  return {
    status: 'committed',
    migrated: next.providers.length,
    fromVersion: 2,
    toVersion: 3,
  };
}
