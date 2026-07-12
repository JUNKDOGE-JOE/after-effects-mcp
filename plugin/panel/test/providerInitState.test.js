import { test } from 'node:test';
import assert from 'node:assert/strict';

async function classify(code) {
  const { providerInitFailure } = await import('../src/app/providerInitState.js');
  const error = new Error(`sensitive implementation detail for ${code}`);
  error.code = code;
  return providerInitFailure(error);
}

test('provider init distinguishes automatic Helper startup failures from repair-required failures', async () => {
  for (const code of ['HELPER_UNAVAILABLE', 'HELPER_START_FAILED']) {
    assert.deepEqual(await classify(code), {
      state: 'unavailable',
      error: 'PLATFORM_HELPER_START_FAILED',
    });
  }
  for (const code of [
    'HELPER_UNAUTHORIZED',
    'PROTOCOL_VERSION_UNSUPPORTED',
    'PLATFORM_HELPER_REPAIR_REQUIRED',
  ]) {
    assert.deepEqual(await classify(code), {
      state: 'unavailable',
      error: 'PLATFORM_HELPER_REPAIR_REQUIRED',
    });
  }
});

test('provider init distinguishes corrupt stores, migration conflicts, and secret mismatches', async () => {
  for (const code of ['PROVIDER_STORE_INVALID']) {
    assert.deepEqual(await classify(code), { state: 'unavailable', error: 'PROVIDER_STORE_CORRUPT' });
  }
  for (const code of ['PROVIDER_STORE_CONFLICT', 'INVALID_PROVIDER_MIGRATION', 'INVALID_MIGRATION_JOURNAL']) {
    assert.deepEqual(await classify(code), { state: 'unavailable', error: 'PROVIDER_MIGRATION_CONFLICT' });
  }
  for (const code of ['SECRET_CONFLICT', 'SECRET_NOT_FOUND', 'INVALID_REFERENCE']) {
    assert.deepEqual(await classify(code), { state: 'unavailable', error: 'PROVIDER_SECRET_MISMATCH' });
  }
  assert.deepEqual(await classify('PROVIDER_STORE_UNAVAILABLE'), {
    state: 'unavailable', error: 'PROVIDER_STORE_UNAVAILABLE',
  });
  assert.deepEqual(await classify('UNEXPECTED_FAILURE'), {
    state: 'unavailable', error: 'PROVIDER_INITIALIZATION_FAILED',
  });
});

test('provider init failure state never exposes the original message', async () => {
  const result = await classify('PROVIDER_STORE_INVALID');
  assert.equal(JSON.stringify(result).includes('sensitive implementation detail'), false);
});
