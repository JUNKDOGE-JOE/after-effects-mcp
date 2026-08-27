import { createPlatformAdapter } from '../cep/platform/index.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenFromPlatform(platform) {
  const tokenPath = platform.paths.join([platform.paths.configRoot, 'auth-token']);
  return String(platform.fs.readFileSync(tokenPath, 'utf8')).trim();
}

async function responseJson(response) {
  if (!response || typeof response.json !== 'function') return {};
  try { return await response.json(); } catch { return {}; }
}

export function parseToolLibraryImport(text) {
  let value;
  try {
    value = JSON.parse(String(text || ''));
  } catch {
    throw new Error('Import JSON is invalid.');
  }
  if (!isObject(value)) throw new Error('Import JSON must be an object.');
  return value;
}

export function splitToolLibraryItems(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  return {
    candidates: candidates.filter((item) => item?.status === 'candidate'),
    artifacts: artifacts.filter((item) => ['saved', 'pinned', 'archived'].includes(item?.status)),
  };
}

export function toolLibraryActions(status) {
  if (status === 'candidate') return ['promote', 'delete'];
  if (status === 'saved') return ['pin', 'archive', 'export'];
  if (status === 'pinned') return ['restore', 'archive', 'export'];
  if (status === 'archived') return ['restore', 'delete'];
  return [];
}

export function createToolLibraryApi({ port = 11488, platform, fetchImpl } = {}) {
  const adapter = platform || createPlatformAdapter();
  const fetcher = fetchImpl || globalThis.fetch;
  const hostPort = Number(port) || 11488;
  if (typeof fetcher !== 'function') throw new Error('Fetch is unavailable.');

  const request = async (pathname, method = 'GET', body) => {
    const token = tokenFromPlatform(adapter);
    if (!token) throw new Error('Host access token is unavailable.');
    const response = await fetcher('http://127.0.0.1:' + hostPort + pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-ae-mcp-token': token,
        'x-ae-mcp-client': 'panel-tool-library/internal',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await responseJson(response);
    if (!response || response.ok === false || payload.ok === false) {
      const error = new Error(payload.error || 'Tool library request failed.');
      error.existingId = payload.existingId || null;
      throw error;
    }
    return payload;
  };

  return {
    list: () => request('/tool-library'),
    promote: (id) => request('/tool-library/promote', 'POST', { id }),
    pin: (id) => request('/tool-library/pin', 'POST', { id }),
    archive: (id) => request('/tool-library/archive', 'POST', { id }),
    restore: (id) => request('/tool-library/restore', 'POST', { id }),
    remove: (id) => request('/tool-library/' + encodeURIComponent(id), 'DELETE'),
    clearCandidates: () => request('/tool-library/clear-candidates', 'POST', {}),
    exportArtifact: (id) => request('/tool-library/export', 'POST', { id }),
    importArtifact: (wire) => request('/tool-library/import', 'POST', { wire }),
  };
}
