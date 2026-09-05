import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPreviewEscape } from '../src/cep/platform/previewKeyboard.js';
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

