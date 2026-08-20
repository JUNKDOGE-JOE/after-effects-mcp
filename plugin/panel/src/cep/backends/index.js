// Registry of embedded chat backends. App.jsx selects descriptors and the
// reset-on-switch set by table lookup instead of per-backend if/else, so a
// new backend (e.g. OpenCode) is a registry row plus its own factory module,
// not another branch threaded through App.
import {
  claudeSubDescriptor,
  codexStaticDescriptor,
  openCodeStaticDescriptor,
} from '../../lib/backendCapabilities.js';

export const BACKENDS = {
  subscription: {
    id: 'subscription',
    baseDescriptor: claudeSubDescriptor,
    attachmentTransport: 'manifest+read-rule',
  },
  codex: {
    id: 'codex',
    baseDescriptor: codexStaticDescriptor,
    attachmentTransport: 'native+manifest',
  },
  opencode: {
    id: 'opencode',
    baseDescriptor: openCodeStaticDescriptor,
    attachmentTransport: 'native',
  },
};

const ATTACHMENT_TRANSPORTS = new Set([
  'manifest+read-rule',
  'native',
  'native+manifest',
]);

export function assertAttachmentBackendRegistry(registry) {
  for (const [id, entry] of Object.entries(registry)) {
    if (!ATTACHMENT_TRANSPORTS.has(entry?.attachmentTransport)) {
      throw new TypeError(id + ' is missing a valid attachment transport');
    }
  }
  return true;
}

assertAttachmentBackendRegistry(BACKENDS);

// Real (conversation-bearing) backend ids — drives shouldResetOnBackendChange.
export const REAL_BACKENDS = Object.keys(BACKENDS);

export function baseDescriptorFor(backendId) {
  const entry = BACKENDS[backendId];
  if (entry) return entry.baseDescriptor();
  throw new Error(
    `Unknown backend id "${backendId}". Known backend ids: ${Object.keys(BACKENDS).join(', ')}`,
  );
}
