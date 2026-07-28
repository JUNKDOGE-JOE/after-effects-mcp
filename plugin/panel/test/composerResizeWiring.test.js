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
  const focusCarrierStart = handle.indexOf('<input');
  const focusCarrierEnd = handle.indexOf('/>', focusCarrierStart);
  const focusCarrier = handle.slice(focusCarrierStart, focusCarrierEnd);
  assert.ok(handleStart >= 0 && handleEnd > handleStart);
  assert.ok(focusCarrierStart >= 0 && focusCarrierEnd > focusCarrierStart);
  assert.match(composer, /createComposerDragSession/);
  assert.match(composer, /composerKeyboardRequest/);
  assert.match(handle, /<div\s+role="separator"\s+aria-orientation="horizontal"/);
  assert.match(focusCarrier, /type="text"/);
  assert.match(focusCarrier, /readOnly/);
  assert.match(focusCarrier, /value=\{`\$\{height\} px`\}/);
  assert.match(focusCarrier, /aria-keyshortcuts="Shift\+ArrowUp Shift\+ArrowDown"/);
  assert.doesNotMatch(focusCarrier, /role="separator"/);
  assert.doesNotMatch(focusCarrier, /aria-value(?:min|max|now)/);
  assert.match(composer, /className="ds-focusable"/);
  assert.match(composer, /onDoubleClick=\{onHeightReset\}/);
  assert.match(composer, /cursor:\s*'row-resize'/);
  assert.match(handle, /event\.currentTarget\.focus\(\)/);
  assert.match(handle, /onMouseDown=\{handleMouseDown\}/);
  assert.match(handle, /window\.addEventListener\('mousemove'/);
  assert.match(handle, /window\.addEventListener\('mouseup'/);
  assert.match(handle, /window\.removeEventListener\('mousemove'/);
  assert.match(handle, /window\.removeEventListener\('mouseup'/);
  assert.match(handle, /if \(nextHeight === null\) return/);
  assert.doesNotMatch(handle, /event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'/);
  assert.match(handle, /event\.preventDefault\(\)/);
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

test('ChatScreen owns one session height and observes the shared allocation', () => {
  const chat = source('../src/screens/ChatScreen.jsx');
  assert.match(chat, /React\.useReducer\(\s*reduceComposerHeight/);
  assert.match(chat, /createComposerHeightState/);
  assert.match(chat, /new ResizeObserver\(measureComposerBounds\)/);
  assert.match(chat, /observer\.observe\(layoutRef\.current\)/);
  assert.match(chat, /observer\.observe\(footerRef\.current\)/);
  assert.match(chat, /observer\.disconnect\(\)/);
  assert.match(chat, /composerAvailableHeight/);
  assert.match(chat, /height=\{composerSize\.height\}/);
  assert.match(chat, /maxHeight=\{composerSize\.maxHeight\}/);
  assert.match(chat, /type:\s*'request'/);
  assert.match(chat, /type:\s*'reset'/);
  assert.doesNotMatch(chat, /localStorage|sessionStorage/);
});
