import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_IDS, defaultSectionState, loadSectionState, saveSectionState, toggleSection } from '../src/lib/settingsSections.js';

function storage(init = {}) {
  const map = new Map(Object.entries(init));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test('default state expands only the AI section', () => {
  const state = defaultSectionState();
  assert.equal(state.ai, true);
  for (const id of SECTION_IDS.filter((x) => x !== 'ai')) assert.equal(state[id], false);
});

test('load/save round-trips and ignores junk values', () => {
  const s = storage();
  const next = toggleSection(defaultSectionState(), 'conn');
  assert.equal(next.conn, true);
  assert.equal(next.ai, true);
  saveSectionState(s, next);
  assert.deepEqual(loadSectionState(s), next);
  assert.deepEqual(loadSectionState(storage({ ae_mcp_settings_sections: '{bad json' })), defaultSectionState());
  assert.deepEqual(loadSectionState(storage({ ae_mcp_settings_sections: JSON.stringify({ ai: 'yes', bogus: true }) })), defaultSectionState());
});
