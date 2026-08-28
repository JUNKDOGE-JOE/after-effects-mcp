import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SECTION_IDS, defaultSectionState, loadSectionState, saveSectionState, toggleSection } from '../src/lib/settingsSections.js';

function storage(init = {}) {
  const map = new Map(Object.entries(init));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test('default state expands only the AI section', () => {
  const state = defaultSectionState();
  assert.equal(state.ai, true);
  assert.equal(SECTION_IDS.includes('toolLibrary'), false);
  assert.equal(Object.hasOwn(state, 'toolLibrary'), false);
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

test('settings no longer renders or owns a tool library section', () => {
  const settingsSource = readFileSync(new URL('../src/screens/SettingsScreen.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(settingsSource, /ToolLibrarySection|id=["']toolLibrary["']/);
  assert.equal(existsSync(new URL('../src/components/settings/ToolLibrarySection.jsx', import.meta.url)), false);
});
