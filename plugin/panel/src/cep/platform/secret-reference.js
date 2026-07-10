const PROVIDER_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROVIDER_UUID = new RegExp(`^${PROVIDER_UUID_SOURCE}$`);
const SLOT = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDER_REFERENCE = new RegExp(
  `^aemcp-secret://provider/(${PROVIDER_UUID_SOURCE})/([a-z][a-z0-9_-]{0,31})/v1$`,
);

function invalidReference() {
  const error = new Error('Secret reference is invalid');
  error.code = 'INVALID_REFERENCE';
  return error;
}

export function createProviderSecretReference(input) {
  const providerId = input?.providerId;
  const slot = input?.slot;
  if (typeof providerId !== 'string' || !PROVIDER_UUID.test(providerId)) {
    throw invalidReference();
  }
  if (typeof slot !== 'string' || !SLOT.test(slot)) throw invalidReference();
  return `aemcp-secret://provider/${providerId}/${slot}/v1`;
}

export function parseProviderSecretReference(reference) {
  if (typeof reference !== 'string') throw invalidReference();
  const match = PROVIDER_REFERENCE.exec(reference);
  if (!match) throw invalidReference();
  return {
    namespace: 'provider',
    providerId: match[1],
    slot: match[2],
    version: 1,
  };
}
