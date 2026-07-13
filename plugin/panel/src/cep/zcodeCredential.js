import { parseProviderSecretReference } from './platform/secret-reference.js';

const STORAGE_KEY = 'ae_mcp_zcode_credential_v1';
const CREDENTIAL_ID = '6c1d936a-3f93-5b2c-9e15-1a513cdd8a89';
const VALUE_REF_KEYS = ['kind', 'reference', 'revision'];

function credentialError() {
  const error = new Error('ZCode protected credential is unavailable');
  error.code = 'ZCODE_CREDENTIAL_UNAVAILABLE';
  return error;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function normalizeValueRef(value) {
  if (!exactKeys(value, VALUE_REF_KEYS) || value.kind !== 'secret') throw credentialError();
  let parsed;
  try { parsed = parseProviderSecretReference(value.reference); } catch { throw credentialError(); }
  if (
    parsed.providerId !== CREDENTIAL_ID
    || !parsed.slot.startsWith('auth-model-')
    || !Number.isSafeInteger(value.revision)
    || value.revision <= 0
  ) {
    throw credentialError();
  }
  return Object.freeze({ kind: 'secret', reference: value.reference, revision: value.revision });
}

export function createZcodeCredentialManager({ storage, secretService, legacyKeyStore } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('storage must implement getItem and setItem');
  }
  if (
    !secretService
    || typeof secretService.create !== 'function'
    || typeof secretService.resolve !== 'function'
    || typeof secretService.delete !== 'function'
  ) {
    throw new TypeError('secretService must implement create, resolve, and delete');
  }

  function readValueRef() {
    let raw;
    try { raw = storage.getItem(STORAGE_KEY); } catch { throw credentialError(); }
    if (!raw) return null;
    try { return normalizeValueRef(JSON.parse(raw)); } catch { throw credentialError(); }
  }

  function persistValueRef(valueRef) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(normalizeValueRef(valueRef))); } catch { throw credentialError(); }
  }

  function clearLegacy() {
    if (!legacyKeyStore) return;
    try {
      legacyKeyStore.clearKey('zcode');
      if (legacyKeyStore.readKey('zcode')) throw credentialError();
    } catch {
      throw credentialError();
    }
  }

  async function resolve(valueRef = readValueRef()) {
    if (!valueRef) return '';
    try {
      const value = await secretService.resolve(valueRef);
      if (typeof value !== 'string') throw credentialError();
      return value;
    } catch {
      throw credentialError();
    }
  }

  async function save(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) throw credentialError();
    const previous = readValueRef();
    let created;
    try {
      created = await secretService.create({
        credentialId: CREDENTIAL_ID,
        slotPrefix: 'auth-model',
        value,
      });
      persistValueRef(created);
    } catch {
      if (created) {
        try { await secretService.delete(created); } catch {}
      }
      throw credentialError();
    }
    if (previous) {
      try { await secretService.delete(previous); } catch {}
    }
    clearLegacy();
    return value;
  }

  async function loadOrMigrate() {
    const current = readValueRef();
    if (current) {
      const value = await resolve(current);
      clearLegacy();
      return value;
    }
    let legacy = '';
    if (legacyKeyStore) {
      try { legacy = String(legacyKeyStore.readKey('zcode') || '').trim(); } catch { throw credentialError(); }
    }
    if (!legacy) return '';
    return save(legacy);
  }

  return Object.freeze({ loadOrMigrate, readValueRef, resolve, save });
}

export { CREDENTIAL_ID as ZCODE_CREDENTIAL_ID, STORAGE_KEY as ZCODE_CREDENTIAL_STORAGE_KEY };
