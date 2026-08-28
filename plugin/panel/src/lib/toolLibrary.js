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
    artifacts: artifacts.filter((item) => ['saved', 'pinned', 'archived', 'deprecated'].includes(item?.status)),
  };
}

const TOOL_LIBRARY_GROUPS = ['pinned', 'saved', 'candidate', 'archived'];

export function mergeToolLibraryItems(indexedItems, payload) {
  const managed = splitToolLibraryItems(payload);
  const byId = new Map();
  for (const item of [...(Array.isArray(indexedItems) ? indexedItems : []), ...managed.candidates, ...managed.artifacts]) {
    if (item && item.id) byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function groupToolLibraryItems(items) {
  const grouped = new Map(TOOL_LIBRARY_GROUPS.map((status) => [status, []]));
  for (const item of Array.isArray(items) ? items : []) {
    const group = item?.status === 'deprecated' ? 'archived' : item?.status;
    if (grouped.has(group)) grouped.get(group).push(item);
  }
  return TOOL_LIBRARY_GROUPS
    .map((status) => ({ status, items: grouped.get(status) }))
    .filter((group) => group.items.length > 0);
}

export function filterToolLibraryItems(items, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => (
    [item?.id, item?.name, item?.description, item?.kind, item?.status]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle)
  ));
}

export function toolLibraryActions(status) {
  if (status === 'candidate') return ['promote', 'delete'];
  if (status === 'saved') return ['pin', 'archive', 'export'];
  if (status === 'pinned') return ['restore', 'archive', 'export'];
  if (status === 'archived') return ['restore', 'delete'];
  return [];
}

export function executeToolLibraryAction(api, action, id) {
  const methods = {
    promote: 'promote',
    pin: 'pin',
    archive: 'archive',
    restore: 'restore',
    delete: 'remove',
    export: 'exportArtifact',
  };
  const method = methods[action];
  if (!method || !api || typeof api[method] !== 'function') {
    throw new Error('Unsupported tool library action.');
  }
  return api[method](id);
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
