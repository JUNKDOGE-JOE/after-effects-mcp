import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPreviewEscape, registerComposerClipboard } from '../src/cep/platform/previewKeyboard.js';
function fixture(platform = 'win32') {
  const page = new EventTarget();
  const calls = [];
  page.cep_node = { process: { platform } };
  page.__adobe_cep__ = { registerKeyEventsInterest: value => calls.push(value) };
  return { page, calls };
}
test('preview requests only bare Windows Escape and releases on close once', () => {
  const { page, calls } = fixture();
  const release = registerPreviewEscape(page);
  assert.deepEqual(JSON.parse(calls[0]), [{ keyCode: 27, ctrlKey: false, altKey: false, shiftKey: false }]);
  release(); release(); page.dispatchEvent(new Event('beforeunload'));
  assert.deepEqual(calls.slice(1), ['']);
  const reopened = registerPreviewEscape(page);
  reopened();
  assert.deepEqual(calls.slice(2), [calls[0], '']);
});
test('panel unload releases key interest and later component cleanup is harmless', () => {
  const { page, calls } = fixture();
  const release = registerPreviewEscape(page);
  page.dispatchEvent(new Event('beforeunload'));
  release();
  assert.deepEqual(calls.slice(1), ['']);
});
test('macOS and pages without CEP keep their existing key handling', () => {
  const { page, calls } = fixture('darwin');
  assert.equal(registerPreviewEscape(page), undefined);
  assert.deepEqual(calls, []);
  assert.equal(registerPreviewEscape({}), undefined);
});
test('an unavailable host key registration does not prevent the preview opening', () => {
  const { page } = fixture();
  page.__adobe_cep__.registerKeyEventsInterest = () => { throw new Error('unavailable'); };
  assert.equal(registerPreviewEscape(page), undefined);
});

test('composer reserves native clipboard chords without reserving bare V or AE commands', () => {
  const { page, calls } = fixture();
  const release = registerComposerClipboard(page);
  assert.deepEqual(JSON.parse(calls[0]), [
    { keyCode: 67, ctrlKey: true, altKey: false, shiftKey: false },
    { keyCode: 86, ctrlKey: true, altKey: false, shiftKey: false },
    { keyCode: 45, ctrlKey: false, altKey: false, shiftKey: true },
  ]);
  release();
  assert.equal(calls.at(-1), '');
});

test('closing a preview retains paste ownership and composer cleanup retains preview Escape', () => {
  for (const previewFirst of [false, true]) {
    const { page, calls } = fixture();
    const clipboard = registerComposerClipboard(page);
    const preview = registerPreviewEscape(page);
    assert.equal(JSON.parse(calls.at(-1)).length, 4);
    (previewFirst ? preview : clipboard)();
    assert.deepEqual(JSON.parse(calls.at(-1)).map(k => k.keyCode), previewFirst ? [67, 86, 45] : [27]);
    (previewFirst ? clipboard : preview)();
    assert.equal(calls.at(-1), '');
  }
});

test('two clipboard owners deduplicate keys and one unmount does not release the other', () => {
  const { page, calls } = fixture();
  const first = registerComposerClipboard(page);
  const second = registerComposerClipboard(page);
  assert.equal(JSON.parse(calls.at(-1)).length, 3);
  first(); first();
  assert.equal(JSON.parse(calls.at(-1)).length, 3);
  second();
  assert.equal(calls.at(-1), '');
});

test('unload releases the combined registration once; a later mount starts clean', () => {
  const { page, calls } = fixture();
  const clipboard = registerComposerClipboard(page);
  const preview = registerPreviewEscape(page);
  page.dispatchEvent(new Event('beforeunload'));
  const count = calls.length;
  clipboard(); preview();
  assert.equal(calls.length, count);
  assert.equal(calls.at(-1), '');
  const next = registerComposerClipboard(page);
  assert.deepEqual(JSON.parse(calls.at(-1)).map(k => k.keyCode), [67, 86, 45]);
  next();
});

test('failed clipboard registration does not drop another owner or poison a retry', () => {
  const { page, calls } = fixture();
  const preview = registerPreviewEscape(page);
  const register = page.__adobe_cep__.registerKeyEventsInterest;
  page.__adobe_cep__.registerKeyEventsInterest = () => { throw new Error('unavailable'); };
  assert.equal(registerComposerClipboard(page), undefined);
  page.__adobe_cep__.registerKeyEventsInterest = register;
  const clipboard = registerComposerClipboard(page);
  clipboard();
  assert.deepEqual(JSON.parse(calls.at(-1)).map(k => k.keyCode), [27]);
  preview();
});

test('clipboard registration is Windows CEP only', () => {
  const { page, calls } = fixture('darwin');
  assert.equal(registerComposerClipboard(page), undefined);
  assert.equal(registerComposerClipboard({}), undefined);
  assert.deepEqual(calls, []);
});

