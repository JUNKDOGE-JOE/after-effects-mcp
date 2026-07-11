import { probeProviderModels } from '../cep/modelProbe.js';
import { detectProviderDialect, effectiveProviderDialect } from '../cep/providerDetect.js';
import { normalizeProviderEntryV2 } from '../lib/providerProfile.js';

function probeFailureReason(result) {
  if (result?.status === 401 || result?.status === 403) return 'authentication';
  if (!result?.status) return 'network';
  return 'path-unsupported';
}

function persistEntry(entry, store, expectedRevision) {
  if (!store) return { entry, stateRevision: null };
  return store.upsert(entry, { expectedRevision });
}

function storeConflict() {
  const error = new Error('Provider store revision conflict');
  error.code = 'PROVIDER_STORE_CONFLICT';
  return error;
}

export async function runProviderManagerProbe(provider, {
  store = null,
  resolveRequestProfile,
  probeProviderModelsImpl = probeProviderModels,
  detectProviderDialectImpl = detectProviderDialect,
  now = Date.now,
  forceDetect = false,
  maxAgeMs,
} = {}) {
  const normalized = normalizeProviderEntryV2(provider);
  if (typeof resolveRequestProfile !== 'function') {
    return {
      ok: false,
      reason: 'configuration',
      detail: 'Provider request profile resolver is unavailable',
    };
  }
  if (store && (
    typeof store.readState !== 'function'
    || typeof store.get !== 'function'
    || typeof store.upsert !== 'function'
  )) {
    return {
      ok: false,
      reason: 'configuration',
      detail: 'Provider store is unavailable',
    };
  }
  const expectedRevision = store ? store.readState().revision : undefined;
  if (store) {
    const rawCurrent = store.get(normalized.id);
    const current = rawCurrent ? normalizeProviderEntryV2(rawCurrent) : null;
    if (!current || JSON.stringify(current) !== JSON.stringify(normalized)) throw storeConflict();
  }
  const effectiveDialect = effectiveProviderDialect(normalized, { now, maxAgeMs });

  if (normalized.protocol === 'openai-compatible' && (forceDetect || !effectiveDialect)) {
    const detectResult = await detectProviderDialectImpl({
      provider: normalized,
      resolveRequestProfile,
      now,
    });
    if (!detectResult?.ok) {
      return {
        ok: false,
        reason: detectResult?.reason || 'configuration',
        detail: detectResult?.detail || 'Provider dialect detection failed',
        detectResult,
      };
    }
    const detectedAt = typeof now === 'function' ? now() : Date.now();
    const entry = normalizeProviderEntryV2({
      ...normalized,
      dialect: {
        override: normalized.dialect.override,
        detected: detectResult.dialect,
      },
      probedModels: detectResult.models || [],
      probedAt: detectedAt,
    });
    const persisted = persistEntry(entry, store, expectedRevision);
    return {
      ok: true,
      entry: persisted.entry,
      stateRevision: persisted.stateRevision,
      result: detectResult,
    };
  }

  let requestProfile = null;
  try {
    try {
      requestProfile = await resolveRequestProfile(normalized, { scope: 'probe' });
    } catch {
      return {
        ok: false,
        reason: 'configuration',
        detail: 'Provider probe profile could not be resolved',
      };
    }
    const result = await probeProviderModelsImpl({
      requestProfile,
      protocol: normalized.protocol,
    });
    if (!result?.ok) {
      return {
        ok: false,
        reason: probeFailureReason(result),
        detail: result?.detail || 'Provider model probe failed',
        result,
      };
    }
    const probedAt = typeof now === 'function' ? now() : Date.now();
    const entry = normalizeProviderEntryV2({
      ...normalized,
      probedModels: result.models || [],
      probedAt,
    });
    const persisted = persistEntry(entry, store, expectedRevision);
    return {
      ok: true,
      entry: persisted.entry,
      stateRevision: persisted.stateRevision,
      result,
    };
  } finally {
    requestProfile = null;
  }
}
