import { redactCredentialText } from '../lib/credentialTextRedaction.js';
import { containsExactSecret } from '../lib/exactSecretRedaction.js';
import { openCodeCatalogId } from '../lib/openCodeCatalogId.js';
import { canonicalOpenCodeBaseUrl } from './openCodeProviderStore.js';

const MAX_PROBED_MODELS = 200;

function failure(detail, apiKey) {
  return { ok: false, detail: redactCredentialText(detail, [apiKey]) };
}

function modelIds(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : null;
  if (!rows) return null;
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = openCodeCatalogId(typeof row === 'string' ? row : row?.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      if (models.length < MAX_PROBED_MODELS) models.push(id);
    }
  }
  return { models, total: seen.size };
}

export async function probeOpenCodeProviderModels({
  draft, apiKey = '', adapter, timeoutMs = 8000,
}) {
  const key = String(apiKey || '');
  let url;
  try {
    url = new URL(canonicalOpenCodeBaseUrl(String(draft?.baseUrl || '').trim()) + '/models');
  } catch {
    return failure('Provider models URL is invalid', key);
  }
  if (url.protocol === 'http:' && draft?.allowInsecureHttp !== true) {
    return failure('Insecure HTTP requires confirmation', key);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failure('Provider models URL must use HTTP or HTTPS', key);
  }

  const headers = { accept: 'application/json' };
  if (draft?.protocol === 'openai') {
    if (key) headers.Authorization = `Bearer ${key}`;
  } else {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    url.searchParams.set('limit', '1000');
  }

  let response;
  try {
    response = await adapter.requestJson({ url: url.toString(), headers, timeoutMs });
  } catch (error) {
    return failure(error?.message || 'Provider models request failed', key);
  }
  if (!response?.ok) {
    const snippet = String(response?.text || '').slice(0, 120).trim();
    return failure(`HTTP ${response?.status || 0}${snippet ? `: ${snippet}` : ''}`, key);
  }
  if (response.json === null) return failure('Provider returned a non-JSON response', key);
  if (containsExactSecret(response.json, ['aemcp-secret://', key])) {
    return failure('Provider models response was rejected', key);
  }
  const catalog = modelIds(response.json);
  if (!catalog) return failure('Provider models response has an unsupported shape', key);
  return { ok: true, models: catalog.models, total: catalog.total };
}
