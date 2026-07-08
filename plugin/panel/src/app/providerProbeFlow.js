import { probeProviderModels } from '../cep/modelProbe.js';
import { detectProviderDialect } from '../cep/providerDetect.js';

function isAuthFailure(result) {
  return result && (result.status === 401 || result.status === 403);
}

function detectionDetail(result) {
  if (!result) return '';
  const reason = result.reason ? String(result.reason) : 'failed';
  const detail = result.detail ? ': ' + String(result.detail) : '';
  return 'dialect detection ' + reason + detail;
}

function probeFailureDetail(result, detectResult) {
  const primary = result && result.detail ? String(result.detail) : ('HTTP ' + (result && result.status ? result.status : 0));
  const detected = detectionDetail(detectResult);
  return detected ? primary + ' (' + detected + ')' : primary;
}

function probedEntry(provider, result, now) {
  return {
    ...provider,
    probedModels: result.models || [],
    probedAt: now(),
  };
}

function detectedEntry(provider, result, now) {
  return {
    ...provider,
    dialect: result.dialect,
    probedModels: result.models || [],
    probedAt: now(),
  };
}

export async function runProviderManagerProbe(provider, {
  probeProviderModelsImpl = probeProviderModels,
  detectProviderDialectImpl = detectProviderDialect,
  now = Date.now,
  forceDetect = false,
} = {}) {
  const p = provider || {};
  const canDetect = p.protocol === 'openai-compatible';

  if (forceDetect && canDetect) {
    const detectResult = await detectProviderDialectImpl({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol, now });
    if (detectResult.ok) return { ok: true, entry: detectedEntry(p, detectResult, now), result: detectResult };
    const result = await probeProviderModelsImpl({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol, dialect: p.dialect });
    if (result.ok) return { ok: true, entry: probedEntry(p, result, now), result, detectResult };
    return { ok: false, detail: probeFailureDetail(result, detectResult), result, detectResult };
  }

  if (p.dialect) {
    const result = await probeProviderModelsImpl({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol, dialect: p.dialect });
    if (result.ok) return { ok: true, entry: probedEntry(p, result, now), result };
    if (canDetect && isAuthFailure(result)) {
      const detected = await detectProviderDialectImpl({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol, now });
      if (detected.ok) return { ok: true, entry: detectedEntry(p, detected, now), result: detected };
      return { ok: false, detail: probeFailureDetail(result, detected), result, detectResult: detected };
    }
    return { ok: false, detail: probeFailureDetail(result), result };
  }

  let detectResult = null;
  if (canDetect) {
    detectResult = await detectProviderDialectImpl({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol, now });
    if (detectResult.ok) return { ok: true, entry: detectedEntry(p, detectResult, now), result: detectResult };
  }

  const result = await probeProviderModelsImpl({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol });
  if (result.ok) return { ok: true, entry: probedEntry(p, result, now), result };
  return { ok: false, detail: probeFailureDetail(result, detectResult), result, detectResult };
}
