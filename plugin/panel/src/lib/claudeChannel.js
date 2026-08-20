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

// The embedded Claude CLI uses its subscription login and its generated strict
// MCP config. Custom Anthropic-compatible endpoints belong to OpenCode.
export function claudeChannelEnv(baseEnv = {}) {
  const env = { ...baseEnv };
  for (const key of UPSTREAM_ENV_KEYS) deleteEnvironmentKey(env, key);
  return env;
}
