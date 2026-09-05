import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelUpdateChecker, PANEL_RELEASE_API, PANEL_UPDATE_CACHE, showPanelUpdate } from '../src/lib/panelUpdates.js';
import { compareVersions, UPDATE_CACHE_MS } from '../src/lib/versionUpdates.js';

function fixture(options = {}) {
  const prefs = new Map();
  let calls = 0, time = 100, response = { ok: true, json: { tag_name: 'v0.11.0', draft: false, prerelease: false } };
  const make = () => createPanelUpdateChecker({ now: () => time, timeoutMs: 10,
    readPref: (key, fallback) => prefs.get(key) || fallback, writePref: (key, value) => prefs.set(key, value),
    requestJson: async (request) => {
      calls += 1;
      assert.equal(request.url, PANEL_RELEASE_API);
      assert.equal(request.headers['User-Agent'], 'ae-mcp-panel');
      if (response instanceof Error) throw response;
      return response;
    }, ...options });
  return { make, prefs, get calls() { return calls; }, set response(value) { response = value; }, advance: (ms) => { time += ms; } };
}

test('running panel versions compare numerically, never offer downgrades, reject ambiguous tags', async () => {
  const check = fixture().make();
  for (const [version, status] of [['0.9.9', 'update'], ['v0.11.0', 'current'], ['0.12.0', 'current'],
    ['0.11.0+dev.1', 'current'], ['', 'unknown'], ['development', 'unknown'], ['0.11.0-beta.1', 'unknown']]) {
    assert.equal((await check(version)).status, status, version);
  }
  for (const version of ['01.2.3', '1.2', '1.2.3-', '9007199254740992.0.0']) assert.equal(compareVersions(version, '1.2.3'), null);
});

test('drafts, prereleases and malformed release data are ignored and never cached', async () => {
  for (const json of [{ tag_name: 'v0.11.0', draft: true, prerelease: false },
    { tag_name: 'v0.11.0', draft: false, prerelease: true },
    { tag_name: 'v0.11.0-beta.1', draft: false, prerelease: false },
    { tag_name: 'latest', draft: false, prerelease: false }, {}, null]) {
    const f = fixture(); f.response = { ok: true, json };
    assert.equal((await f.make()('0.10.6')).reason, 'release');
    assert.equal(f.prefs.size, 0);
  }
});

test('successful checks persist for 24 hours, manual refresh bypasses cache, dismissal follows version', async () => {
  const f = fixture(); const check = f.make();
  const first = await check('0.10.6');
  assert.equal(first.url, 'https://github.com/JUNKDOGE-JOE/after-effects-mcp/releases/tag/v0.11.0');
  assert.equal(showPanelUpdate(first, ''), true);
  assert.equal(showPanelUpdate(await f.make()('0.10.6'), '0.11.0'), false);
  assert.equal(f.calls, 1);
  f.response = { ok: true, json: { tag_name: 'v0.12.0', draft: false, prerelease: false } };
  assert.equal(showPanelUpdate(await check('0.10.6', { force: true }), 'v0.11.0'), true);
  assert.equal(f.calls, 2);
  f.advance(UPDATE_CACHE_MS - 1); await f.make()('0.10.6'); assert.equal(f.calls, 2);
  f.advance(1); await f.make()('0.10.6'); assert.equal(f.calls, 3);
});

test('offline, rate limited and timed-out checks are unknown, retryable, and cannot claim current', async () => {
  for (const [response, reason] of [[new Error('offline'), 'network'], [{ ok: false, status: 429 }, 'limited'],
    [{ ok: false, status: 403 }, 'limited'], [{ ok: false, status: 500 }, 'network'],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'timeout']]) {
    const f = fixture(); f.response = response; const check = f.make();
    const result = await check('0.10.6');
    assert.equal(result.status, 'unknown'); assert.equal(result.reason, reason);
    assert.equal(showPanelUpdate(result, ''), false); assert.equal(f.prefs.size, 0);
    await check('0.10.6'); assert.equal(f.calls, 2);
  }
  const check = fixture({ requestJson: () => new Promise(() => {}) }).make();
  assert.equal((await check('0.10.6')).reason, 'timeout');
});

test('failed forced refresh does not report the cached version as a successful check', async () => {
  const f = fixture(), check = f.make(); await check('0.11.0');
  f.response = new Error('offline');
  assert.equal((await check('0.11.0', { force: true })).status, 'unknown');
});

test('invalid/future cache and unavailable storage do not prevent checking', async () => {
  for (const cached of ['broken', JSON.stringify({ latest: 'v0.11.0', checkedAt: 9999999999999 }),
    JSON.stringify({ latest: 'v0.11.0', checkedAt: 100, url: 'https://example.com/' })]) {
    const f = fixture(); f.prefs.set(PANEL_UPDATE_CACHE, cached);
    assert.equal((await f.make()('0.10.6')).status, 'update'); assert.equal(f.calls, 1);
  }
  const f = fixture({ readPref: () => { throw new Error('storage'); }, writePref: () => { throw new Error('storage'); } });
  assert.equal((await f.make()('0.10.6')).status, 'update');
});

test('overlapping checks share one request and compare each caller version', async () => {
  const f = fixture(), check = f.make();
  const results = await Promise.all([check('0.10.6'), check('0.11.0', { force: true })]);
  assert.deepEqual(results.map((r) => r.status), ['update', 'current']); assert.equal(f.calls, 1);
});
