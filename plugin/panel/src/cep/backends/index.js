// Registry of embedded chat backends. App.jsx selects descriptors and the
// reset-on-switch set by table lookup instead of per-backend if/else, so a
// new backend (e.g. OpenCode) is a registry row plus its own factory module,
// not another branch threaded through App.
import {
  claudeSubDescriptor,
  byokStaticDescriptor,
  codexStaticDescriptor,
  openCodeStaticDescriptor,
} from '../../lib/backendCapabilities.js';

export const BACKENDS = {
  subscription: { id: 'subscription', baseDescriptor: claudeSubDescriptor },
  byok: { id: 'byok', baseDescriptor: byokStaticDescriptor },
  codex: { id: 'codex', baseDescriptor: codexStaticDescriptor },
  opencode: { id: 'opencode', baseDescriptor: openCodeStaticDescriptor },
};

// Real (conversation-bearing) backend ids — drives shouldResetOnBackendChange.
export const REAL_BACKENDS = Object.keys(BACKENDS);

export function baseDescriptorFor(backendId) {
  const entry = BACKENDS[backendId];
  return entry ? entry.baseDescriptor() : claudeSubDescriptor();
}
