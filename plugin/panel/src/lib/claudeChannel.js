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

export function claudeChannelEnv(baseEnv = {}, { channel = 'subscription', provider = null } = {}) {
  const env = { ...baseEnv };
  deleteEnvironmentKey(env, 'ANTHROPIC_API_KEY');
  deleteEnvironmentKey(env, 'ANTHROPIC_BASE_URL');
  deleteEnvironmentKey(env, 'ANTHROPIC_AUTH_TOKEN');
  if (channel === 'api' && provider && provider.baseUrl) {
    env.ANTHROPIC_BASE_URL = String(provider.baseUrl);
    if (provider.apiKey) env.ANTHROPIC_AUTH_TOKEN = String(provider.apiKey);
    return env;
  }
  return env;
}
