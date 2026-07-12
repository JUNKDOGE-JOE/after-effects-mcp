const UPSTREAM_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
];

function deleteEnvironmentKey(environment, name) {
  const normalized = name.toUpperCase();
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === normalized) delete environment[key];
  }
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return /^127(?:\.\d{1,3}){3}$/.test(mapped ? mapped[1] : host);
}

function normalizeLocalRoute(localRoute) {
  if (!localRoute || typeof localRoute !== 'object' || Array.isArray(localRoute)) {
    throw routeError('CLAUDE_AGENT_LOCAL_ROUTE_REQUIRED', 'Claude Agent API channel requires a local route profile.');
  }
  const keys = Object.keys(localRoute).sort();
  if (keys.length !== 2 || keys[0] !== 'origin' || keys[1] !== 'routeToken') {
    throw routeError('CLAUDE_AGENT_LOCAL_ROUTE_INVALID', 'Claude Agent local route profile is invalid.');
  }
  if (typeof localRoute.origin !== 'string' || typeof localRoute.routeToken !== 'string') {
    throw routeError('CLAUDE_AGENT_LOCAL_ROUTE_INVALID', 'Claude Agent local route profile is invalid.');
  }

  const origin = localRoute.origin.trim();
  const routeToken = localRoute.routeToken.trim();
  let url;
  try { url = new URL(origin); } catch { throw routeError('CLAUDE_AGENT_LOCAL_ROUTE_INVALID', 'Claude Agent local route profile is invalid.'); }
  if (
    url.protocol !== 'http:'
    || !isLoopbackHostname(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '' && url.pathname !== '/')
    || !routeToken
    || routeToken !== localRoute.routeToken
  ) {
    throw routeError('CLAUDE_AGENT_LOCAL_ROUTE_INVALID', 'Claude Agent local route profile is invalid.');
  }
  return { origin: url.origin, routeToken };
}

export function claudeChannelEnv(baseEnv = {}, {
  channel = 'subscription',
  localRoute = null,
  requestProfile = null,
} = {}) {
  const env = { ...baseEnv };
  for (const key of UPSTREAM_ENV_KEYS) deleteEnvironmentKey(env, key);
  if (channel !== 'api') return env;
  if (requestProfile !== null && requestProfile !== undefined) {
    throw routeError(
      'CLAUDE_AGENT_UPSTREAM_PROFILE_FORBIDDEN',
      'Claude Agent API channel cannot receive an upstream provider request profile.',
    );
  }
  const route = normalizeLocalRoute(localRoute);
  env.ANTHROPIC_BASE_URL = route.origin;
  env.ANTHROPIC_AUTH_TOKEN = route.routeToken;
  return env;
}
