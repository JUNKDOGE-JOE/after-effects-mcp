import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardFiles, handleComposerPaste, containClipboardKey } from '../src/lib/composerPaste.js';

test('files and items describing the same paste are consumed once', () => {
  const file = { name: 'local.png', path: 'C:/media/local.png' };
  const data = { files: [file], items: [{ kind: 'file', getAsFile: () => file }] };
  const calls = [];
  const event = {
    clipboardData: data,
    preventDefault: () => calls.push('prevent'),
    stopPropagation: () => calls.push('stop'),
  };
  assert.equal(handleComposerPaste(event, {
    canAttach: true, addFiles: (files) => calls.push(files),
  }), true);
  assert.deepEqual(calls, ['prevent', 'stop', [file]]);
});

test('pathless screenshot items and multiple files keep their original blobs', () => {
  const image = new Blob(['screenshot'], { type: 'image/png' });
  const second = new Blob(['file']);
  assert.deepEqual(clipboardFiles({ items: [
    { kind: 'string', getAsFile: () => { throw new Error('text must be ignored'); } },
    { kind: 'file', getAsFile: () => image },
    { kind: 'file', getAsFile: () => null },
    { kind: 'file', getAsFile: () => second },
  ] }), [image, second]);
});

test('text, URLs and copied path strings retain native paste behavior', () => {
  for (const text of ['hello', 'https://example.com/picture.png', 'C:/media/local.png']) {
    assert.equal(handleComposerPaste({
      clipboardData: { types: ['text/plain'], getData: () => text },
      preventDefault: () => assert.fail('text paste cancelled'),
      stopPropagation: () => assert.fail('text paste stopped'),
    }, { canAttach: true, addFiles: () => assert.fail('unexpected attachment') }), false);
  }
  assert.deepEqual(clipboardFiles(null), []);
});

test('busy composer consumes file paste without attaching or leaking to another listener', () => {
  let cancelled = 0;
  handleComposerPaste({
    clipboardData: { files: [new Blob(['image'])] },
    preventDefault: () => cancelled++, stopPropagation: () => cancelled++,
  }, { canAttach: false, addFiles: () => assert.fail('busy draft changed') });
  assert.equal(cancelled, 2);
});

test('clipboard keys stay in the composer without cancelling native copy or paste', () => {
  for (const chord of [{ key: 'v', ctrlKey: true }, { key: 'C', ctrlKey: true }, { key: 'Insert', shiftKey: true }]) {
    let stopped = 0;
    containClipboardKey({ ...chord, stopPropagation: () => stopped++, preventDefault: () => assert.fail('native clipboard action cancelled') });
    assert.equal(stopped, 1);
  }
  for (const chord of [{ key: 'v' }, { key: 'Enter' }, { key: 'Escape' }, { key: 'v', altKey: true }, { key: 'v', ctrlKey: true, altKey: true }, { key: 'v', ctrlKey: true, shiftKey: true }]) {
    containClipboardKey({ ...chord, stopPropagation: () => assert.fail('unrelated key intercepted') });
  }
});

test('Alt+Shift+V invokes ordinary paste once and accepts a handled file paste', () => {
  const doc = new EventTarget();
  let commands = 0;
  doc.execCommand = (command) => { assert.equal(command, 'paste'); commands++; doc.dispatchEvent(new Event('paste')); return false; };
  const event = { key: 'V', altKey: true, shiftKey: true, type: 'keydown', target: { ownerDocument: doc }, stopPropagation() {}, preventDefault() {} };
  assert.equal(containClipboardKey(event), true);
  containClipboardKey({ ...event, type: 'keyup' });
  containClipboardKey({ ...event, repeat: true });
  assert.equal(commands, 1);
  doc.execCommand = () => false;
  assert.equal(containClipboardKey(event), false);
  doc.execCommand = () => { throw new Error('paste denied'); };
  assert.equal(containClipboardKey(event), false);
});
