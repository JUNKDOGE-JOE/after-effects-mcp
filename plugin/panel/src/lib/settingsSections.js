// Spec C: collapsible Settings sections; only AI expanded by default,
// expansion state persisted per machine.
const KEY = 'ae_mcp_settings_sections';

export const SECTION_IDS = ['ai', 'conn', 'externalClients', 'sec', 'gen', 'about'];

export function defaultSectionState() {
  return { ai: true, conn: false, externalClients: false, sec: false, gen: false, about: false };
}

export function loadSectionState(storage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return defaultSectionState();
    const parsed = JSON.parse(raw);
    const state = defaultSectionState();
    for (const id of SECTION_IDS) {
      if (typeof parsed[id] === 'boolean') state[id] = parsed[id];
    }
    return state;
  } catch (e) {
    return defaultSectionState();
  }
}

export function saveSectionState(storage, state) {
  try { storage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* best effort */ }
}

export function toggleSection(state, id) {
  return { ...state, [id]: !state[id] };
}
