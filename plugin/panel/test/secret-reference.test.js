import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderSecretReference,
  parseProviderSecretReference,
} from '../src/cep/platform/secret-reference.js';

const PROVIDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REFERENCE = `aemcp-secret://provider/${PROVIDER_ID}/api-key/v1`;

function assertInvalidReference(operation) {
  assert.throws(
    operation,
    (error) => error instanceof Error && error.code === 'INVALID_REFERENCE',
  );
}

test('reference accepts only lowercase RFC 4122 UUID provider namespace and bounded slot', () => {
  assert.equal(
    createProviderSecretReference({
      providerId: PROVIDER_ID,
      slot: 'api-key',
    }),
    REFERENCE,
  );
  assert.deepEqual(parseProviderSecretReference(REFERENCE), {
    namespace: 'provider',
    providerId: PROVIDER_ID,
    slot: 'api-key',
    version: 1,
  });
});

test('creator rejects non-canonical UUIDs and values outside RFC 4122 version and variant bits', () => {
  for (const providerId of [
    '../keychain',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa',
    'aaaaaaaa%2daaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ` ${PROVIDER_ID}`,
    `${PROVIDER_ID} `,
    '',
    null,
  ]) {
    assertInvalidReference(() => createProviderSecretReference({ providerId, slot: 'api' }));
  }
});

test('creator enforces the exact bounded slot grammar', () => {
  assert.equal(
    createProviderSecretReference({ providerId: PROVIDER_ID, slot: 'a'.repeat(32) }),
    `aemcp-secret://provider/${PROVIDER_ID}/${'a'.repeat(32)}/v1`,
  );

  for (const slot of [
    '',
    'Bad Slot',
    'Api',
    '1api',
    '-api',
    '_api',
    'api.key',
    'api/key',
    'api%2fkey',
    'a'.repeat(33),
    null,
  ]) {
    assertInvalidReference(() => createProviderSecretReference({ providerId: PROVIDER_ID, slot }));
  }
});

test('parser accepts only the exact canonical URI and rejects alternate spellings', () => {
  for (const reference of [
    `AEMCP-SECRET://provider/${PROVIDER_ID}/api-key/v1`,
    `aemcp-secret://providers/${PROVIDER_ID}/api-key/v1`,
    `aemcp-secret://provider/${PROVIDER_ID.toUpperCase()}/api-key/v1`,
    `aemcp-secret://provider/${PROVIDER_ID}/Api-key/v1`,
    `aemcp-secret://provider/${PROVIDER_ID}/api%2dkey/v1`,
    `aemcp-secret://provider/${PROVIDER_ID}/api-key/v01`,
    `aemcp-secret://provider/${PROVIDER_ID}/api-key/v1/`,
    `${REFERENCE}?revision=1`,
    `${REFERENCE}#fragment`,
    '',
    null,
    {},
  ]) {
    assertInvalidReference(() => parseProviderSecretReference(reference));
  }
});
