import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardFiles, handleComposerPaste } from '../src/lib/composerPaste.js';

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
