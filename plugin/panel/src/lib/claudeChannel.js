// Spec A/B3: Claude backend credential channels.
// 'subscription' -> Agent SDK self-discovery; remove ANTHROPIC_API_KEY and
//   any inherited base URL/token so a stray env can't hijack the session.
// 'api' -> inject ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN from the chosen
//   provider entry (Agent SDK natively supports third-party endpoints, so
//   the panel keeps full agentic capabilities on relays).
function deleteEnvironmentKey(environment, name) {
  const normalized = name.toUpperCase();
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === normalized) delete environment[key];
  }
}

function unsupportedProvider() {
  const error = new Error('Claude Agent provider is unsupported');
  error.code = 'CLAUDE_AGENT_PROVIDER_UNSUPPORTED';
  return error;
}

export function claudeChannelEnv(baseEnv = {}, { channel = 'subscription', requestProfile = null } = {}) {
  const env = { ...baseEnv };
  deleteEnvironmentKey(env, 'ANTHROPIC_API_KEY');
  deleteEnvironmentKey(env, 'ANTHROPIC_BASE_URL');
  deleteEnvironmentKey(env, 'ANTHROPIC_AUTH_TOKEN');
  if (channel === 'api' && requestProfile && requestProfile.baseUrl) {
    if (Array.isArray(requestProfile.extraHeaders) && requestProfile.extraHeaders.length) throw unsupportedProvider();
    if (requestProfile.auth?.kind !== 'header') throw unsupportedProvider();
    const name = String(requestProfile.auth.name || '').toLowerCase();
    if (name !== 'x-api-key' && name !== 'authorization') throw unsupportedProvider();
    let token = String(requestProfile.auth.value || '');
    if (name === 'authorization') {
      if (!/^Bearer\s+\S+/i.test(token)) throw unsupportedProvider();
      token = token.replace(/^Bearer\s+/i, '');
    }
    if (!token) throw unsupportedProvider();
    env.ANTHROPIC_BASE_URL = String(requestProfile.baseUrl);
    env.ANTHROPIC_AUTH_TOKEN = token;
    return env;
  }
  return env;
}
