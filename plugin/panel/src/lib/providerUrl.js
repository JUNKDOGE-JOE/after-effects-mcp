const RESOURCES = Object.freeze({
  models: 'models',
  responses: 'responses',
  'chat-completions': 'chat/completions',
  messages: 'messages',
});

function providerUrlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodedPathHasTraversal(raw) {
  let current = String(raw || '');
  for (let layer = 0; layer < 4; layer += 1) {
    if (current.split('/').some((segment) => segment === '.' || segment === '..')) return true;
    let decoded;
    try { decoded = decodeURIComponent(current); } catch { return true; }
    if (decoded === current) return false;
    current = decoded;
  }
  return current.split('/').some((segment) => segment === '.' || segment === '..');
}

function rawPathFromAbsoluteUrl(raw) {
  const scheme = raw.indexOf('://');
  if (scheme < 0) return '';
  const pathStart = raw.indexOf('/', scheme + 3);
  if (pathStart < 0) return '/';
  const endCandidates = [raw.indexOf('?', pathStart), raw.indexOf('#', pathStart)].filter((value) => value >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : raw.length;
  return raw.slice(pathStart, end);
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped ? mapped[1] : host;
  if (/^127(?:\.\d{1,3}){3}$/.test(ipv4)) return true;
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(host);
}

function parseBaseUrl(baseUrl, allowInsecureHttp) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw || raw.startsWith('//') || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    throw providerUrlError('provider_url_invalid', 'Provider URL must be absolute.');
  }
  if (decodedPathHasTraversal(rawPathFromAbsoluteUrl(raw))) {
    throw providerUrlError('provider_url_traversal_forbidden', 'Provider URL path traversal is forbidden.');
  }

  let url;
  try { url = new URL(raw); } catch {
    throw providerUrlError('provider_url_invalid', 'Provider URL is invalid.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw providerUrlError('provider_url_invalid', 'Provider URL protocol is unsupported.');
  }
  if (url.username || url.password) {
    throw providerUrlError('provider_url_userinfo_forbidden', 'Provider URL userinfo is forbidden.');
  }
  if (url.hash || raw.includes('#')) {
    throw providerUrlError('provider_url_fragment_forbidden', 'Provider URL fragments are forbidden.');
  }
  if (url.search || raw.includes('?')) {
    throw providerUrlError('provider_url_query_forbidden', 'Provider base URL queries are forbidden.');
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname) && allowInsecureHttp !== true) {
    throw providerUrlError('provider_insecure_http_forbidden', 'Insecure provider HTTP requires explicit approval.');
  }
  return url;
}

function normalizeSearch(inboundSearch) {
  const value = inboundSearch === undefined || inboundSearch === null ? '' : String(inboundSearch);
  if (!value) return '';
  if (!value.startsWith('?') || value.includes('#') || value.includes('\r') || value.includes('\n')) {
    throw providerUrlError('provider_url_invalid_search', 'Provider request query is invalid.');
  }
  return value;
}

export function buildProviderEndpoint({
  baseUrl,
  resource,
  inboundSearch = '',
  allowInsecureHttp = false,
} = {}) {
  if (!Object.hasOwn(RESOURCES, resource)) {
    throw providerUrlError('provider_url_invalid_resource', 'Provider resource is invalid.');
  }
  const endpoint = buildProviderApiBaseUrl({ baseUrl, allowInsecureHttp });
  const configuredOrigin = endpoint.origin;
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${RESOURCES[resource]}`;
  endpoint.search = normalizeSearch(inboundSearch);
  endpoint.hash = '';
  if (endpoint.origin !== configuredOrigin) {
    throw providerUrlError('provider_url_origin_mismatch', 'Provider endpoint origin changed unexpectedly.');
  }
  return endpoint;
}

export function buildProviderApiBaseCandidates({
  baseUrl,
  allowInsecureHttp = false,
} = {}) {
  const configured = parseBaseUrl(baseUrl, allowInsecureHttp);
  const configuredRoot = new URL(configured.toString());
  configuredRoot.pathname = configuredRoot.pathname.replace(/\/+$/, '') || '/';
  configuredRoot.search = '';
  configuredRoot.hash = '';

  const plusV1 = new URL(configuredRoot.toString());
  const configuredPath = plusV1.pathname.replace(/\/+$/, '');
  plusV1.pathname = /\/v1$/i.test(configuredPath)
    ? configuredPath
    : `${configuredPath === '/' ? '' : configuredPath}/v1`;

  const candidates = [{ id: 'configured-root', url: configuredRoot }];
  if (plusV1.toString() !== configuredRoot.toString()) {
    candidates.push({ id: 'plus-v1', url: plusV1 });
  }
  return candidates;
}

export function buildProviderEndpointCandidates({
  baseUrl,
  resource,
  inboundSearch = '',
  allowInsecureHttp = false,
} = {}) {
  if (!Object.hasOwn(RESOURCES, resource)) {
    throw providerUrlError('provider_url_invalid_resource', 'Provider resource is invalid.');
  }
  const search = normalizeSearch(inboundSearch);
  return buildProviderApiBaseCandidates({ baseUrl, allowInsecureHttp }).map((candidate) => {
    const endpoint = new URL(candidate.url.toString());
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${RESOURCES[resource]}`;
    endpoint.search = search;
    endpoint.hash = '';
    if (endpoint.origin !== candidate.url.origin) {
      throw providerUrlError('provider_url_origin_mismatch', 'Provider endpoint origin changed unexpectedly.');
    }
    return { id: candidate.id, apiRoot: new URL(candidate.url.toString()), url: endpoint };
  });
}

export function buildProviderApiBaseUrl({ baseUrl, allowInsecureHttp = false } = {}) {
  const candidates = buildProviderApiBaseCandidates({ baseUrl, allowInsecureHttp });
  if (/\/v\d+(?:beta)?\/openai\/?$/i.test(candidates[0].url.pathname)) {
    return new URL(candidates[0].url.toString());
  }
  return new URL((candidates.find((candidate) => candidate.id === 'plus-v1') || candidates[0]).url.toString());
}
