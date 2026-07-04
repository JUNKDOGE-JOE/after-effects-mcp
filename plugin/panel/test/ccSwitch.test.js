import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCcSwitch, ccSwitchProviderEntries } from '../src/cep/ccSwitch.js';

const ENV = {
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
};

function fakeFs(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT: ' + p);
      return files[p];
    },
  };
}

test('ccSwitchProviderEntries maps tolerant fields into normalized entries', () => {
  const entries = ccSwitchProviderEntries([
    { name: 'My Provider', baseUrl: 'https://example.com', apiKey: 'sk-abc' },
    { title: 'Anthropic Direct', url: 'https://api.anthropic.com', token: 'sk-ant', type: 'anthropic' },
    { name: '', baseUrl: 'https://missing-name.example.com' },
    { name: 'No Base URL' },
    null,
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'ccswitch-my-provider');
  assert.equal(entries[0].name, 'My Provider');
  assert.equal(entries[0].protocol, 'openai-compatible');
  assert.equal(entries[0].baseUrl, 'https://example.com');
  assert.equal(entries[0].apiKey, 'sk-abc');
  assert.equal(entries[1].id, 'ccswitch-anthropic-direct');
  assert.equal(entries[1].protocol, 'anthropic');
  assert.equal(entries[1].apiKey, 'sk-ant');
});

test('detectCcSwitch finds config.json in the primary ~/.cc-switch directory', () => {
  const dir = 'C:\\Users\\me\\.cc-switch';
  const file = dir + '\\config.json';
  const fs = fakeFs({
    [file]: JSON.stringify({ providers: [{ name: 'Found', baseUrl: 'https://found.example.com', apiKey: 'k' }] }),
  });
  const found = detectCcSwitch({ env: ENV, fsImpl: fs });
  assert.ok(found);
  assert.equal(found.dir, dir);
  assert.equal(found.file, file);
  assert.equal(found.providers.length, 1);
  assert.equal(found.providers[0].name, 'Found');
});

test('detectCcSwitch falls back through candidate dirs and config names', () => {
  const dir = 'C:\\Users\\me\\.config\\cc-switch';
  const file = dir + '\\providers.json';
  const fs = fakeFs({
    [file]: JSON.stringify({ profiles: [{ name: 'Fallback', baseUrl: 'https://fallback.example.com', apiKey: 'k2' }] }),
  });
  const found = detectCcSwitch({ env: ENV, fsImpl: fs });
  assert.ok(found);
  assert.equal(found.dir, dir);
  assert.equal(found.file, file);
  assert.equal(found.providers[0].name, 'Fallback');
});

test('detectCcSwitch returns null when nothing is present', () => {
  const fs = fakeFs({});
  assert.equal(detectCcSwitch({ env: ENV, fsImpl: fs }), null);
});

test('detectCcSwitch tolerates unreadable/corrupt candidate files by continuing to scan', () => {
  const badFile = 'C:\\Users\\me\\.cc-switch\\config.json';
  const goodDir = 'C:\\Users\\me\\.config\\cc-switch';
  const goodFile = goodDir + '\\config.json';
  const fs = fakeFs({
    [badFile]: '{not valid json',
    [goodFile]: JSON.stringify({ providers: [{ name: 'Good', baseUrl: 'https://good.example.com', apiKey: 'k3' }] }),
  });
  const found = detectCcSwitch({ env: ENV, fsImpl: fs });
  assert.ok(found);
  assert.equal(found.dir, goodDir);
});

test('detectCcSwitch returns null when require is unavailable and no fsImpl given', () => {
  assert.equal(detectCcSwitch({ env: ENV }), null);
});
