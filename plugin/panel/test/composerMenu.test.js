import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerMenuLayout } from '../src/lib/composerMenu.js';

test('menu caps tall panels and shrinks inside short and narrow panels', () => {
  for (const height of [160, 240, 600, 1200]) {
    for (const width of [140, 240, 600]) {
      for (const top of [10, height / 2, height - 40]) {
        const layout = composerMenuLayout({ left: width - 70, right: width - 10, top, bottom: top + 24 }, { width, height });
        const menuTop = layout.top ?? height - layout.bottom - layout.maxHeight;
        assert.ok(menuTop >= 8);
        assert.ok(menuTop + layout.maxHeight <= height - 8);
        assert.ok(layout.maxHeight <= 320);
        assert.ok(layout.left >= 8);
        assert.ok(layout.left + layout.maxWidth <= width - 8);
        assert.ok(layout.minWidth <= layout.maxWidth);
      }
    }
  }
});

test('menu opens towards the available space and honors right alignment', () => {
  const viewport = { width: 600, height: 500 };
  const down = composerMenuLayout({ left: 200, right: 280, top: 30, bottom: 54 }, viewport, 'right');
  assert.equal(down.top, 58);
  assert.equal(down.left + down.minWidth, 280);
  assert.equal(down.maxHeight, 320);
  const up = composerMenuLayout({ left: 20, right: 100, top: 450, bottom: 474 }, viewport);
  assert.equal(up.bottom, 54);
  assert.equal(up.maxHeight, 320);
});
