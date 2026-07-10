export function sensitiveValues(profile) {
  const values = [];
  if (typeof profile?.auth?.value === 'string' && profile.auth.value) {
    values.push(profile.auth.value);
    const scheme = profile.auth.value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (scheme?.[1]) values.push(scheme[1]);
  }
  for (const header of profile?.extraHeaders || []) {
    if (typeof header?.value === 'string' && header.value) values.push(header.value);
  }
  return Array.from(new Set(values)).sort((a, b) => b.length - a.length);
}

function normalizedSecrets(values) {
  return Array.from(new Set((values || [])
    .filter((value) => typeof value === 'string' && value)))
    .sort((a, b) => b.length - a.length);
}

export function redactText(value, values = []) {
  let text = String(value == null ? '' : value);
  const secrets = normalizedSecrets(values);
  const marker = secrets.some((secret) => '[redacted]'.includes(secret)) ? '' : '[redacted]';
  const maximumPasses = Math.max(1, secrets.length * 4 + 8);
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let changed = false;
    for (const secret of secrets) {
      if (!text.includes(secret)) continue;
      text = text.split(secret).join(marker);
      changed = true;
    }
    if (!changed) return text;
  }
  return secrets.some((secret) => text.includes(secret)) ? '' : text;
}

export function redactValue(value, values = []) {
  if (typeof value === 'string') return redactText(value, values);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, values));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, values)]));
}

export function createDeltaRedactor(values, emitText) {
  const secrets = normalizedSecrets(values);
  let buffer = '';
  const keep = secrets.reduce((maximum, value) => Math.max(maximum, value.length - 1), 0);
  return {
    feed(delta) {
      if (!secrets.length) {
        emitText(String(delta || ''));
        return;
      }
      buffer = redactText(buffer + String(delta || ''), secrets);
      if (buffer.length > keep) {
        emitText(buffer.slice(0, buffer.length - keep));
        buffer = buffer.slice(buffer.length - keep);
      }
    },
    flush() {
      if (buffer) emitText(redactText(buffer, secrets));
      buffer = '';
    },
    discard() { buffer = ''; },
  };
}

export function safeErrorMessage(error, values = []) {
  return redactText(error && error.message ? error.message : 'Agent loop failed.', values);
}
