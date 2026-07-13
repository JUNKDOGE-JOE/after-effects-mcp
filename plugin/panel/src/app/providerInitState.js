const HELPER_FAILURE_CODES = new Set([
  'HELPER_UNAUTHORIZED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SECRET_STORE_UNAVAILABLE',
  'PLATFORM_HELPER_REPAIR_REQUIRED',
  'INVALID_REQUEST',
  'MESSAGE_TOO_LARGE',
]);

const MIGRATION_FAILURE_CODES = new Set([
  'PROVIDER_STORE_CONFLICT',
  'INVALID_PROVIDER_MIGRATION',
  'INVALID_MIGRATION_JOURNAL',
]);

const SECRET_MISMATCH_CODES = new Set([
  'SECRET_CONFLICT',
  'SECRET_NOT_FOUND',
  'INVALID_REFERENCE',
]);

export function providerInitFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  let failure = 'PROVIDER_INITIALIZATION_FAILED';
  if (code === 'HELPER_UNAVAILABLE' || code === 'HELPER_START_FAILED') {
    failure = 'PLATFORM_HELPER_START_FAILED';
  } else if (HELPER_FAILURE_CODES.has(code)) failure = 'PLATFORM_HELPER_REPAIR_REQUIRED';
  else if (code === 'PROVIDER_STORE_INVALID' || code === 'PROVIDER_STORE_CREDENTIAL_CONTAMINATION') failure = 'PROVIDER_STORE_CORRUPT';
  else if (code === 'PROVIDER_STORE_UNAVAILABLE') failure = 'PROVIDER_STORE_UNAVAILABLE';
  else if (MIGRATION_FAILURE_CODES.has(code)) failure = 'PROVIDER_MIGRATION_CONFLICT';
  else if (SECRET_MISMATCH_CODES.has(code)) failure = 'PROVIDER_SECRET_MISMATCH';
  return { state: 'unavailable', error: failure };
}

export function assertProviderStateCredentialFree(providerState, exactSecrets = []) {
  if (!containsExactSecret(providerState?.providers, exactSecrets)) return providerState;
  const error = new Error('Stored Provider data contains protected credential material.');
  error.code = 'PROVIDER_STORE_CREDENTIAL_CONTAMINATION';
  throw error;
}
import { containsExactSecret } from '../lib/exactSecretRedaction.js';
