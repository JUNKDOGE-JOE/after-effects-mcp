import {
  isLoopbackProviderHostname,
  normalizeProviderEntryV3,
  validateProviderBaseUrl,
} from '../lib/providerProfile.js';

function flowError(code) {
  const messages = {
    provider_draft_invalid: 'Provider draft is invalid',
    provider_secret_required: 'Provider secret is required',
    provider_insecure_http_forbidden: 'Insecure provider HTTP is forbidden',
    provider_insecure_http_confirmation_required: 'Insecure provider HTTP confirmation is required',
  };
  const error = new Error(messages[code] || messages.provider_draft_invalid);
  error.code = messages[code] ? code : 'provider_draft_invalid';
  return error;
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizedBaseUrl(value) {
  try { return validateProviderBaseUrl(value); } catch { throw flowError('provider_draft_invalid'); }
}

async function enforceInsecureHttp({ baseUrl, providerId, current, allowInsecureHttp, confirmInsecureHttp }) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || isLoopbackProviderHostname(url.hostname)) return false;
  if (!allowInsecureHttp) throw flowError('provider_insecure_http_forbidden');
  const changed = !current
    || current.allowInsecureHttp !== true
    || normalizedBaseUrl(current.baseUrl) !== baseUrl;
  if (changed) {
    if (typeof confirmInsecureHttp !== 'function') {
      throw flowError('provider_insecure_http_confirmation_required');
    }
    const confirmed = await confirmInsecureHttp({ baseUrl, providerId });
    if (confirmed !== true) throw flowError('provider_insecure_http_confirmation_required');
  }
  return true;
}

function currentPrimaryRef(provider) {
  return provider?.credential?.valueRef?.kind === 'secret'
    ? provider.credential.valueRef
    : null;
}

function preferredAuthFromDraft(draft, current) {
  let scheme = String(draft.modelAuthKind || '').trim();
  if (draft.modelAuthAutomatic === true || !scheme) {
    scheme = current?.credential?.preferredAuth?.scheme || 'auto';
  }
  if (!['auto', 'none', 'bearer', 'x-api-key', 'custom'].includes(scheme)) {
    throw flowError('provider_draft_invalid');
  }
  const headerName = scheme === 'custom' ? String(draft.modelAuthHeaderName || '').trim() : null;
  if (scheme === 'custom' && !headerName) throw flowError('provider_draft_invalid');
  return { scheme, headerName };
}

async function buildCredential({ draft, current, credentialId, secretService, created }) {
  const preferredAuth = preferredAuthFromDraft(draft, current);
  if (preferredAuth.scheme === 'none') return { valueRef: null, preferredAuth };
  const rawSecret = typeof draft.modelAuthSecret === 'string' ? draft.modelAuthSecret : '';
  let valueRef = null;
  if (rawSecret) {
    valueRef = await secretService.create({
      credentialId,
      slotPrefix: 'auth-model',
      value: rawSecret,
    });
    created.push(valueRef);
  } else {
    valueRef = currentPrimaryRef(current);
  }
  if (!valueRef && preferredAuth.scheme !== 'auto') {
    throw flowError('provider_secret_required');
  }
  return { valueRef, preferredAuth };
}

async function buildHeaders({ draftHeaders, currentHeaders, credentialId, secretService, created }) {
  if (!Array.isArray(draftHeaders)) throw flowError('provider_draft_invalid');
  const currentById = new Map((currentHeaders || []).map((header) => [header.id, header]));
  const output = [];
  for (const raw of draftHeaders) {
    if (!raw || typeof raw !== 'object') throw flowError('provider_draft_invalid');
    const id = String(raw.id || '').trim();
    const name = String(raw.name || '').trim();
    const scopes = Array.isArray(raw.scopes) ? raw.scopes.slice() : [];
    if (!id || !name || !scopes.length) throw flowError('provider_draft_invalid');
    const current = currentById.get(id);
    const valueKind = raw.valueKind || raw.valueRef?.kind || 'literal';
    if (valueKind === 'literal') {
      const value = raw.valueRef?.kind === 'literal' ? raw.valueRef.value : raw.value;
      if (typeof value !== 'string') throw flowError('provider_draft_invalid');
      output.push({ id, name, scopes, valueRef: { kind: 'literal', value } });
      continue;
    }
    if (valueKind !== 'secret') throw flowError('provider_draft_invalid');
    const secret = typeof raw.secret === 'string' ? raw.secret : (typeof raw.value === 'string' ? raw.value : '');
    let valueRef;
    if (secret) {
      valueRef = await secretService.create({ credentialId, slotPrefix: 'header', value: secret });
      created.push(valueRef);
    } else if (current?.valueRef?.kind === 'secret') {
      valueRef = current.valueRef;
    } else {
      throw flowError('provider_secret_required');
    }
    output.push({ id, name, scopes, valueRef });
  }
  return output;
}

function allSecretRefs(provider) {
  if (!provider) return [];
  const refs = [];
  const add = (ref) => {
    if (ref?.kind !== 'secret') return;
    if (!refs.some((item) => item.reference === ref.reference && item.revision === ref.revision)) refs.push(ref);
  };
  add(provider.credential?.valueRef);
  add(provider.probeAuthOverride?.valueRef);
  for (const header of provider.headers || []) add(header.valueRef);
  return refs;
}

function refsRemoved(previous, next) {
  const retained = new Set(allSecretRefs(next).map((ref) => `${ref.reference}\u0000${ref.revision}`));
  return allSecretRefs(previous).filter((ref) => !retained.has(`${ref.reference}\u0000${ref.revision}`));
}

function requestFingerprint(provider) {
  return JSON.stringify({
    baseUrl: provider.baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp,
    credential: provider.credential,
    probeAuthOverride: provider.probeAuthOverride,
    headers: provider.headers,
  });
}

function unknownModelList(requestProfileRevision, revision = 0) {
  return {
    revision,
    status: 'unknown',
    apiRoot: null,
    auth: null,
    models: [],
    checkedAt: 0,
    validUntil: 0,
    requestProfileRevision,
  };
}

async function rollbackCreated(created, secretService) {
  for (const ref of created.slice().reverse()) {
    try { await secretService.delete(ref); } catch { /* migration/drain will not own uncommitted refs */ }
  }
}

async function bestEffortDeleteCommitted(refs, initialRevision, store, secretService) {
  let revision = initialRevision;
  for (const ref of refs) {
    try {
      const result = await secretService.delete(ref);
      if (!result || (result.deleted !== true && result.revision !== null)) continue;
      if (typeof store.acknowledgeSecretDelete === 'function') {
        const result = store.acknowledgeSecretDelete(ref.reference, { expectedRevision: revision });
        revision = result.stateRevision;
      }
    } catch {
      // The reference remains in pendingSecretDeletes for the startup drain.
    }
  }
}

export async function saveProviderDraft({
  draft,
  current,
  store,
  secretService,
  confirmInsecureHttp,
  randomUUID,
} = {}) {
  if (!draft || typeof draft !== 'object' || !store || !secretService) throw flowError('provider_draft_invalid');
  const id = String(draft.id || '').trim() || slug(draft.name);
  const name = String(draft.name || '').trim() || id;
  if (!id || !name) throw flowError('provider_draft_invalid');
  const protocolHint = draft.protocol || 'openai-compatible';
  if (protocolHint !== 'openai-compatible' && protocolHint !== 'anthropic') {
    throw flowError('provider_draft_invalid');
  }
  const currentProvider = current ? normalizeProviderEntryV3(current) : null;
  const baseUrl = normalizedBaseUrl(draft.baseUrl);
  const credentialId = currentProvider?.credentialId || (typeof randomUUID === 'function' ? randomUUID() : '');
  if (!credentialId) throw flowError('provider_draft_invalid');
  // Bind copy-on-write to the state observed before any confirmation/helper
  // await. A concurrent save must fail CAS and roll back this save's new refs.
  const expectedRevision = store.readState().revision;
  const allowInsecureHttp = await enforceInsecureHttp({
    baseUrl,
    providerId: id,
    current: currentProvider,
    allowInsecureHttp: draft.allowInsecureHttp === true,
    confirmInsecureHttp,
  });

  const created = [];
  let entry;
  try {
    const credential = await buildCredential({
      draft,
      current: currentProvider,
      credentialId,
      secretService,
      created,
    });
    const headers = await buildHeaders({
      draftHeaders: draft.headers || [],
      currentHeaders: currentProvider?.headers || [],
      credentialId,
      secretService,
      created,
    });
    const hasProbePreference = Object.hasOwn(draft, 'probePreference')
      || Object.hasOwn(draft, 'dialectOverride');
    const rawProbePreference = Object.hasOwn(draft, 'probePreference')
      ? draft.probePreference
      : draft.dialectOverride;
    const selectedProbePreference = hasProbePreference
      ? String(rawProbePreference || '').trim()
        || (currentProvider ? null : protocolHint === 'anthropic' ? 'messages' : null)
      : currentProvider?.probePreference || (protocolHint === 'anthropic' ? 'messages' : null);
    if (selectedProbePreference !== null
        && !['responses', 'chat', 'messages'].includes(selectedProbePreference)) {
      throw flowError('provider_draft_invalid');
    }
    const candidate = {
      id,
      credentialId,
      name,
      baseUrl,
      allowInsecureHttp,
      requestProfileRevision: currentProvider?.requestProfileRevision || 1,
      credential,
      probeAuthOverride: null,
      headers,
      probePreference: selectedProbePreference,
      modelList: currentProvider?.modelList || unknownModelList(1),
      modelCapabilities: currentProvider?.modelCapabilities || [],
      routeOverrides: currentProvider?.routeOverrides || [],
    };
    if (currentProvider && requestFingerprint(candidate) !== requestFingerprint(currentProvider)) {
      candidate.requestProfileRevision = currentProvider.requestProfileRevision + 1;
      candidate.modelList = unknownModelList(
        candidate.requestProfileRevision,
        currentProvider.modelList.revision + 1,
      );
      candidate.modelCapabilities = [];
    }
    entry = normalizeProviderEntryV3(candidate);
    const pendingSecretDeletes = refsRemoved(currentProvider, entry);
    const committed = store.upsert(entry, {
      expectedRevision,
      pendingSecretDeletes,
    });
    await bestEffortDeleteCommitted(
      pendingSecretDeletes,
      committed.stateRevision,
      store,
      secretService,
    );
    return committed.entry;
  } catch (error) {
    await rollbackCreated(created, secretService);
    throw error;
  }
}

export async function deleteProviderProfile({ provider, store, secretService } = {}) {
  if (!provider || !store || !secretService) throw flowError('provider_draft_invalid');
  const normalized = normalizeProviderEntryV3(provider);
  const pendingSecretDeletes = allSecretRefs(normalized);
  const state = store.readState();
  const committed = store.remove(normalized.id, {
    expectedRevision: state.revision,
    pendingSecretDeletes,
  });
  if (committed.removed) {
    await bestEffortDeleteCommitted(
      pendingSecretDeletes,
      committed.stateRevision,
      store,
      secretService,
    );
  }
  return { removed: committed.removed };
}

export async function importProviderDraft({ candidate, store, secretService, randomUUID } = {}) {
  if (!candidate || typeof candidate !== 'object') throw flowError('provider_draft_invalid');
  let draft = {
    id: candidate.candidateId || '',
    name: candidate.name,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    allowInsecureHttp: false,
    modelAuthKind: candidate.modelAuthKind || 'auto',
    modelAuthAutomatic: candidate.modelAuthKind === undefined,
    modelAuthHeaderName: '',
    modelAuthSecret: candidate.modelAuthSecret,
    probeAuthMode: 'inherit-model',
    probeAuthKind: 'none',
    probeAuthHeaderName: '',
    probeAuthSecret: '',
    headers: [],
    dialectOverride: '',
    dialectSource: '',
  };
  try {
    const candidateId = String(draft.id || '').trim() || slug(draft.name);
    const current = typeof store?.get === 'function' ? store.get(candidateId) : null;
    return await saveProviderDraft({
      draft,
      current,
      store,
      secretService,
      confirmInsecureHttp: async () => false,
      randomUUID,
    });
  } finally {
    draft = null;
  }
}

export async function drainPendingProviderSecretDeletes({ store, secretService } = {}) {
  if (!store || !secretService) throw flowError('provider_draft_invalid');
  let deleted = 0;
  const snapshot = store.readState();
  for (const ref of snapshot.pendingSecretDeletes) {
    try {
      const result = await secretService.delete(ref);
      if (!result || (result.deleted !== true && result.revision !== null)) continue;
      const current = store.readState();
      store.acknowledgeSecretDelete(ref.reference, { expectedRevision: current.revision });
      deleted += 1;
    } catch {
      // Leave the exact reference/revision queued for a later idempotent drain.
    }
  }
  return { deleted, pending: store.readState().pendingSecretDeletes.length };
}
