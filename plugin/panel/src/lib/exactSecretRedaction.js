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
  const variants = [];
  for (const value of values || []) {
    if (typeof value !== 'string' || !value) continue;
    variants.push(value);
    try {
      const encoded = JSON.stringify(value);
      if (encoded?.startsWith('"') && encoded.endsWith('"')) variants.push(encoded.slice(1, -1));
    } catch {}
  }
  return Array.from(new Set(variants.filter(Boolean)))
    .sort((a, b) => b.length - a.length);
}

const MAX_DECODE_CHARS = 1024 * 1024;
const MAX_DECODE_LAYERS = 3;
const MAX_STRUCTURE_CHARS = 16 * 1024 * 1024;

function decodePercentRuns(value) {
  return String(value).replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

function decodeUnicodeEscapes(value) {
  return String(value).replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => (
    String.fromCharCode(Number.parseInt(hex, 16))
  ));
}

function decodedTextLayers(value) {
  let current = String(value);
  const layers = [current];
  for (let layer = 0; layer < MAX_DECODE_LAYERS; layer += 1) {
    if (!current.includes('%') && !/\\u[0-9a-f]{4}/i.test(current)) break;
    if (current.length > MAX_DECODE_CHARS) return null;
    const decoded = decodeUnicodeEscapes(decodePercentRuns(current));
    if (decoded === current) break;
    layers.push(decoded);
    current = decoded;
  }
  return layers;
}

function textContainsSecret(value, secrets) {
  const layers = decodedTextLayers(value);
  if (layers === null) return true;
  return layers.some((layer) => secrets.some((secret) => layer.includes(secret)));
}

export function containsExactSecret(value, values = []) {
  const secrets = normalizedSecrets(values);
  if (!secrets.length) return false;
  const visiting = new WeakSet();
  const valueParts = [];
  const keyParts = [];
  const keyValueParts = [];
  const leafKeyValueParts = [];
  let structureChars = 0;
  const containsText = (candidate) => textContainsSecret(candidate, secrets);
  const appendPart = (parts, candidate) => {
    const text = String(candidate);
    structureChars += text.length;
    if (structureChars > MAX_STRUCTURE_CHARS) return true;
    parts.push(text);
    return false;
  };
  const visit = (candidate) => {
    if (typeof candidate === 'function') return true;
    if (typeof candidate !== 'object' || candidate === null) {
      try {
        if (appendPart(valueParts, candidate)) return true;
        if (appendPart(keyValueParts, candidate)) return true;
        return containsText(candidate);
      } catch { return true; }
    }
    if (visiting.has(candidate)) return true;
    let keys;
    try { keys = Reflect.ownKeys(candidate); } catch { return true; }
    visiting.add(candidate);
    try {
      for (const key of keys) {
        try {
          const item = Reflect.get(candidate, key);
          if (appendPart(keyParts, key)) return true;
          if (appendPart(keyValueParts, key)) return true;
          if (containsText(key)) return true;
          if (typeof item !== 'function' && (typeof item !== 'object' || item === null)) {
            if (appendPart(leafKeyValueParts, key)) return true;
            if (appendPart(leafKeyValueParts, item)) return true;
          }
          if (visit(item)) return true;
        } catch {
          return true;
        }
      }
      return false;
    } finally {
      visiting.delete(candidate);
    }
  };
  if (visit(value)) return true;
  return [valueParts, keyParts, keyValueParts, leafKeyValueParts]
    .some((parts) => containsText(parts.join('')));
}

export function containsExactSecretAcrossBoundary(seedValues, payload, values = []) {
  const secrets = normalizedSecrets(values);
  if (!secrets.length) return false;
  const valueParts = [];
  const keyParts = [];
  const keyValueParts = [];
  const leafKeyValueParts = [];
  const visiting = new WeakSet();
  let chars = 0;
  const append = (parts, value) => {
    const text = String(value);
    chars += text.length;
    if (chars > MAX_STRUCTURE_CHARS) return false;
    parts.push(text);
    return true;
  };
  const visit = (value) => {
    if (typeof value === 'function') return false;
    if (typeof value !== 'object' || value === null) {
      return append(valueParts, value) && append(keyValueParts, value);
    }
    if (visiting.has(value)) return false;
    let keys;
    try { keys = Reflect.ownKeys(value); } catch { return false; }
    visiting.add(value);
    try {
      for (const key of keys) {
        let item;
        try { item = Reflect.get(value, key); } catch { return false; }
        if (!append(keyParts, key) || !append(keyValueParts, key)) return false;
        if (typeof item !== 'function' && (typeof item !== 'object' || item === null)) {
          if (!append(valueParts, item)
              || !append(keyValueParts, item)
              || !append(leafKeyValueParts, key)
              || !append(leafKeyValueParts, item)) return false;
        } else if (!visit(item)) {
          return false;
        }
      }
      return true;
    } finally {
      visiting.delete(value);
    }
  };
  if (!visit(payload)) return true;
  const candidates = [
    ...leafKeyValueParts,
    valueParts.join(''),
    keyParts.join(''),
    keyValueParts.join(''),
    leafKeyValueParts.join(''),
  ];
  let seeds;
  try { seeds = Array.from(seedValues || [], (value) => String(value)); } catch { return true; }
  for (const seed of seeds) {
    for (const candidate of candidates) {
      if (textContainsSecret(seed + candidate, secrets)
          || textContainsSecret(candidate + seed, secrets)) {
        return true;
      }
    }
  }
  return false;
}

export function redactText(value, values = []) {
  let text = String(value == null ? '' : value);
  const secrets = normalizedSecrets(values);
  if (!secrets.length) return text;
  const marker = secrets.some((secret) => '[redacted]'.includes(secret)) ? '' : '[redacted]';
  const decodedLayers = decodedTextLayers(text);
  if (decodedLayers === null) return marker;
  if (decodedLayers.slice(1).some((layer) => secrets.some((secret) => layer.includes(secret)))) {
    return marker;
  }
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

function redactValueParts(value, values) {
  if (typeof value === 'string') return redactText(value, values);
  if (value === null || ['number', 'boolean', 'bigint'].includes(typeof value)) {
    const text = String(value);
    const redacted = redactText(text, values);
    return redacted === text ? value : redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactValueParts(item, values));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactText(key, values),
    redactValueParts(item, values),
  ]));
}

export function redactValue(value, values = []) {
  const redacted = redactValueParts(value, values);
  if (!containsExactSecret(redacted, values)) return redacted;
  const secrets = normalizedSecrets(values);
  return secrets.some((secret) => '[redacted]'.includes(secret)) ? '' : '[redacted]';
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

export function createByteRedactor(values, emitBytes) {
  const secrets = normalizedSecrets(values)
    .map((value) => Buffer.from(value, 'utf8'))
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  const displayMarker = Buffer.from('[redacted]', 'utf8');
  const marker = secrets.some((secret) => displayMarker.includes(secret))
    ? Buffer.alloc(0)
    : displayMarker;
  const maximum = secrets.reduce((length, secret) => Math.max(length, secret.length), 0);
  let pending = Buffer.alloc(0);

  function emit(value) {
    if (value.length > 0) emitBytes(value);
  }

  function drain(flush) {
    if (!secrets.length) {
      emit(pending);
      pending = Buffer.alloc(0);
      return;
    }
    while (pending.length > 0) {
      const boundary = flush ? pending.length : Math.max(0, pending.length - maximum + 1);
      if (!flush && boundary === 0) return;
      let matchIndex = -1;
      let matchSecret = null;
      for (const secret of secrets) {
        const index = pending.indexOf(secret);
        if (index < 0 || (!flush && index >= boundary)) continue;
        if (matchIndex < 0 || index < matchIndex || (index === matchIndex && secret.length > matchSecret.length)) {
          matchIndex = index;
          matchSecret = secret;
        }
      }
      if (matchIndex < 0) {
        emit(pending.subarray(0, boundary));
        pending = pending.subarray(boundary);
        if (!flush) return;
        continue;
      }
      emit(pending.subarray(0, matchIndex));
      emit(marker);
      pending = pending.subarray(matchIndex + matchSecret.length);
    }
  }

  return {
    feed(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
      if (!value.length) return;
      pending = pending.length ? Buffer.concat([pending, value]) : Buffer.from(value);
      drain(false);
    },
    flush() { drain(true); },
    discard() { pending = Buffer.alloc(0); },
  };
}

export function safeErrorMessage(error, values = []) {
  return redactText(error && error.message ? error.message : 'Agent loop failed.', values);
}
