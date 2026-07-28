import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('Composer exposes the tested accessible resize interaction', () => {
  const composer = source('../src/components/chat/Composer.jsx');
  const handleStart = composer.indexOf('function ComposerResizeHandle');
  const handleEnd = composer.indexOf('export function Composer');
  const handle = composer.slice(handleStart, handleEnd);
  assert.ok(handleStart >= 0 && handleEnd > handleStart);
  assert.match(composer, /createComposerPointerSession/);
  assert.match(composer, /composerKeyboardRequest/);
  assert.match(composer, /role="separator"/);
  assert.match(composer, /aria-orientation="horizontal"/);
  assert.match(composer, /aria-keyshortcuts="Shift\+ArrowUp Shift\+ArrowDown"/);
  assert.match(composer, /aria-valuemin=\{minHeight\}/);
  assert.match(composer, /aria-valuemax=\{maxHeight\}/);
  assert.match(composer, /aria-valuenow=\{height\}/);
  assert.match(composer, /className="ds-focusable"/);
  assert.match(composer, /onDoubleClick=\{onHeightReset\}/);
  assert.match(composer, /cursor:\s*'row-resize'/);
  assert.match(handle, /hover/);
  assert.match(handle, /dragging/);
  assert.doesNotMatch(handle, /onSend|onStop|options|onChange/);
});

test('Composer keeps submission and bottom controls independent from resizing', () => {
  const composer = source('../src/components/chat/Composer.jsx');
  assert.match(composer, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(composer, /if \(canSend && onSend\) onSend\(\)/);
  assert.match(composer, /overflowY:\s*'auto'/);
  assert.match(composer, /minHeight:\s*0/);
  assert.match(composer, /flex:\s*'none'/);
  assert.match(composer, /overflow must stay visible/);
});
