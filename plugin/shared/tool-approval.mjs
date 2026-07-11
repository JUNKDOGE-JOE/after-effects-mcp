export const PLAN_SCHEMA_KEY = 'x-ae-mcp-plan';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPERATIONS = new Set(['render', 'execute', 'apply']);
const RISKS = new Set(['read', 'write', 'destructive', 'external']);
const TOOL_USE_ACTIONS = new Set(['render', 'prepare', 'grant', 'execute']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Plan values must be finite JSON');
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Plan values must be acyclic JSON');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => cloneJson(item, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError('Plan values must be plain JSON objects');
    result = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: cloneJson(item, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

function sha256Text(text) {
  const source = String(text);
  const bytes = typeof TextEncoder === 'function'
    ? new TextEncoder().encode(source)
    : Uint8Array.from(unescape(encodeURIComponent(source)), (character) => character.charCodeAt(0));
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + s1 + choose + constants[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function normalizeMcpToolName(name) {
  let normalized = typeof name === 'string' ? name : '';
  if (normalized.startsWith('mcp__ae__')) normalized = normalized.slice('mcp__ae__'.length);
  if (normalized.startsWith('ae_')) normalized = 'ae.' + normalized.slice(3);
  return normalized;
}

export function isCoreAuthorizedDynamicCall(name, args) {
  if (!isPlainObject(args)) return false;
  const normalized = normalizeMcpToolName(name);
  try {
    if (normalized === 'ae.toolUse') return TOOL_USE_ACTIONS.has(args.action);
    if (normalized === 'ae.skillUse') return typeof args.execute === 'boolean';
  } catch {
    return false;
  }
  return false;
}

export function extractToolPlan(requestedSchema, now = Date.now()) {
  if (!isPlainObject(requestedSchema)) return null;
  let raw;
  try {
    raw = requestedSchema[PLAN_SCHEMA_KEY];
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  try {
    const current = typeof now === 'function' ? now() : now;
    if (typeof raw.artifactId !== 'string' || !raw.artifactId.trim()) return null;
    if (!HASH_PATTERN.test(raw.contentHash) || !HASH_PATTERN.test(raw.planHash)) return null;
    if (!OPERATIONS.has(raw.operation) || !RISKS.has(raw.risk)) return null;
    if (!isPlainObject(raw.normalizedArgs) || !isPlainObject(raw.target)) return null;
    if (!Number.isSafeInteger(raw.expiresAt) || !Number.isFinite(current) || raw.expiresAt <= current) return null;
    return deepFreeze(cloneJson(raw));
  } catch {
    return null;
  }
}

export function planSessionKey(plan) {
  const payload = {
    artifactId: plan.artifactId,
    contentHash: plan.contentHash,
    operation: plan.operation,
    normalizedTarget: cloneJson(plan.target),
  };
  return sha256Text(JSON.stringify(canonicalize(payload)));
}

export function decideToolPlan({ tier, plan, sessionAllowed = false }) {
  const risk = plan && plan.risk;
  if (!RISKS.has(risk)) {
    return { decision: 'deny', risk: 'unknown', allowSession: false, sessionKey: null };
  }
  if (!['readonly', 'manual', 'auto', 'none'].includes(tier)) {
    return { decision: 'deny', risk, allowSession: false, sessionKey: null };
  }
  const high = risk === 'destructive' || risk === 'external';
  if (risk === 'read') {
    return { decision: 'allow', risk, allowSession: false, sessionKey: null };
  }
  if (tier === 'readonly') {
    return { decision: 'deny', risk, allowSession: false, sessionKey: null };
  }
  if (sessionAllowed && risk === 'write') {
    return {
      decision: 'allow',
      risk,
      allowSession: true,
      sessionKey: planSessionKey(plan),
    };
  }
  if (high) {
    return { decision: 'ask', risk, allowSession: false, sessionKey: null };
  }
  if (tier === 'manual') {
    return {
      decision: 'ask',
      risk,
      allowSession: true,
      sessionKey: planSessionKey(plan),
    };
  }
  return { decision: 'allow', risk, allowSession: false, sessionKey: null };
}

export function approvalResult(decision, policy = {}) {
  if (decision === 'once' || decision === 'allow') {
    return { action: 'accept', content: { decision: 'once' } };
  }
  if (decision === 'session' && policy.allowSession === true) {
    return { action: 'accept', content: { decision: 'session' } };
  }
  return { action: 'decline', content: {} };
}
