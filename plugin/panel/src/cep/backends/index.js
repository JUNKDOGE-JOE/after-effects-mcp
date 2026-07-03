// Registry of embedded chat backends. App.jsx selects descriptors and the
// reset-on-switch set by table lookup instead of per-backend if/else, so a
// new backend (e.g. OpenCode) is a registry row plus its own factory module,
// not another branch threaded through App.
import {
  claudeSubDescriptor,
  byokStaticDescriptor,
  codexStaticDescriptor,
  openCodeStaticDescriptor,
  zcodeStaticDescriptor,
  zcodeDynamicDescriptor,
} from '../../lib/backendCapabilities.js';

export const BACKENDS = {
  subscription: { id: 'subscription', baseDescriptor: claudeSubDescriptor },
  byok: { id: 'byok', baseDescriptor: byokStaticDescriptor },
  'claude-api': { id: 'claude-api', baseDescriptor: byokStaticDescriptor },
  codex: { id: 'codex', baseDescriptor: codexStaticDescriptor },
  opencode: { id: 'opencode', baseDescriptor: openCodeStaticDescriptor },
  // zcode's baseDescriptor is intentionally NOT zcodeStaticDescriptor here:
  // baseDescriptorFor() special-cases 'zcode' below to build a live,
  // CLI-config-aware descriptor. zcodeStaticDescriptor remains the ultimate
  // fallback (used by zcodeDynamicDescriptor itself, and by
  // zcodeDescriptorFromModels once a session exists) when no CLI config is
  // readable at all.
  zcode: { id: 'zcode', baseDescriptor: zcodeStaticDescriptor },
};

// Real (conversation-bearing) backend ids — drives shouldResetOnBackendChange.
export const REAL_BACKENDS = Object.keys(BACKENDS);

// env: forwarded to zcodeDynamicDescriptor so the zcode descriptor (used for
// display and for reconcileModelPref's reset target) is built from the
// CLI-configured model (~/.zcode/cli/config.json) rather than a hardcoded
// builtin, until a real session/create response supplies its own model list
// (see zcodeDescriptorFromModels in backendCapabilities.js / selectDescriptor
// in descriptorSelect.js, which take over after that point).
export function baseDescriptorFor(backendId, env) {
  if (backendId === 'zcode') return zcodeDynamicDescriptor({ env });
  const entry = BACKENDS[backendId];
  return entry ? entry.baseDescriptor() : claudeSubDescriptor();
}
