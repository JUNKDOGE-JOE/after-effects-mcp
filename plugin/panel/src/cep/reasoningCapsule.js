const PREFIX = 'aemcp-r1';
const AAD = Buffer.from('ae-mcp/provider-reasoning-capsule/v1', 'utf8');
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const SOURCE_PROTOCOLS = new Set(['chat', 'messages', 'responses']);

function capsuleError(code) {
  const error = new Error('Provider reasoning capsule is invalid.');
  error.code = code;
  return error;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value, maximum, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw capsuleError(code);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > maximum || base64url(decoded) !== value) {
    throw capsuleError(code);
  }
  return decoded;
}

function exactPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw capsuleError('reasoning_capsule_payload_invalid');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'item,sourceProtocol,version' || value.version !== 1) {
    throw capsuleError('reasoning_capsule_payload_invalid');
  }
  if (!SOURCE_PROTOCOLS.has(value.sourceProtocol)) throw capsuleError('reasoning_capsule_payload_invalid');
  return value;
}

export function createReasoningCapsule({ crypto, key } = {}) {
  if (!crypto || typeof crypto.randomBytes !== 'function' || typeof crypto.createCipheriv !== 'function'
    || typeof crypto.createDecipheriv !== 'function') {
    throw new TypeError('crypto implementation is required');
  }
  const secret = key ? Buffer.from(key) : Buffer.from(crypto.randomBytes(32));
  if (secret.length !== 32) throw new TypeError('reasoning capsule key must be 32 bytes');

  function seal({ sourceProtocol, item } = {}) {
    if (!SOURCE_PROTOCOLS.has(sourceProtocol)) throw capsuleError('reasoning_capsule_payload_invalid');
    const payload = Buffer.from(JSON.stringify({ version: 1, sourceProtocol, item }), 'utf8');
    if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
      throw capsuleError('reasoning_capsule_payload_too_large');
    }
    const iv = Buffer.from(crypto.randomBytes(12));
    if (iv.length !== 12) throw new TypeError('crypto.randomBytes must return 12 bytes');
    const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    payload.fill(0);
    return [PREFIX, base64url(iv), base64url(ciphertext), base64url(tag)].join('.');
  }

  function open(token, { sourceProtocol } = {}) {
    if (typeof token !== 'string' || token.length > (MAX_PAYLOAD_BYTES * 2)) {
      throw capsuleError('reasoning_capsule_invalid');
    }
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) throw capsuleError('reasoning_capsule_invalid');
    const iv = decode(parts[1], 12, 'reasoning_capsule_invalid');
    const ciphertext = decode(parts[2], MAX_PAYLOAD_BYTES + 256, 'reasoning_capsule_invalid');
    const tag = decode(parts[3], 16, 'reasoning_capsule_invalid');
    if (iv.length !== 12 || tag.length !== 16) throw capsuleError('reasoning_capsule_invalid');
    let plaintext;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw capsuleError('reasoning_capsule_auth_failed');
    }
    try {
      const payload = exactPayload(JSON.parse(plaintext.toString('utf8')));
      if (sourceProtocol && payload.sourceProtocol !== sourceProtocol) {
        throw capsuleError('reasoning_capsule_protocol_mismatch');
      }
      return payload;
    } catch (error) {
      if (error?.code) throw error;
      throw capsuleError('reasoning_capsule_payload_invalid');
    } finally {
      plaintext.fill(0);
    }
  }

  function destroy() {
    secret.fill(0);
  }

  return { seal, open, destroy };
}
