import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelFileDropGuard } from '../src/lib/panelFileDrop.js';

// #208: file-only full-panel drops. Files attach exactly once and never
// navigate the WebView; text/URL drags keep native browser/editor behavior.

function makeTarget() {
  const listeners = { dragover: [], drop: [] };
  return {
    listeners,
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== handler);
    },
    dispatch(type, event) {
      for (const handler of [...(listeners[type] || [])]) handler(event);
    },
  };
}

function fileEvent(files = [{ name: 'clip.mov' }]) {
  let prevented = 0;
  return {
    dataTransfer: { types: ['Files'], files, dropEffect: undefined },
    preventDefault() { prevented += 1; },
    get prevented() { return prevented; },
  };
}

function textEvent(types = ['text/plain']) {
  let prevented = 0;
  return {
    dataTransfer: { types, files: [] },
    preventDefault() { prevented += 1; },
    get prevented() { return prevented; },
  };
}

test('file drops anywhere attach exactly once and never navigate', () => {
  const target = makeTarget();
  const attached = [];
  createPanelFileDropGuard({
    target,
    canAttach: () => true,
    addFiles: (files) => attached.push(files),
  });

  const over = fileEvent();
  target.dispatch('dragover', over);
  assert.equal(over.prevented, 1, 'dragover must preventDefault to allow the drop');
  assert.equal(over.dataTransfer.dropEffect, 'copy');

  const drop = fileEvent([{ name: 'a.png' }, { name: 'b.png' }]);
  target.dispatch('drop', drop);
  assert.equal(drop.prevented, 1, 'file drop must never navigate the WebView');
  assert.equal(attached.length, 1, 'attached exactly once');
  assert.deepEqual(attached[0].map((f) => f.name), ['a.png', 'b.png']);
});

test('text and URL drags keep native behavior untouched', () => {
  const target = makeTarget();
  const attached = [];
  createPanelFileDropGuard({ target, canAttach: () => true, addFiles: (f) => attached.push(f) });

  for (const types of [['text/plain'], ['text/uri-list', 'text/plain']]) {
    const over = textEvent(types);
    target.dispatch('dragover', over);
    assert.equal(over.prevented, 0, `dragover untouched for ${types}`);
    const drop = textEvent(types);
    target.dispatch('drop', drop);
    assert.equal(drop.prevented, 0, `drop untouched for ${types}`);
  }
  assert.equal(attached.length, 0);
});

test('a busy composer still blocks navigation without attaching', () => {
  const target = makeTarget();
  const attached = [];
  createPanelFileDropGuard({ target, canAttach: () => false, addFiles: (f) => attached.push(f) });

  const over = fileEvent();
  target.dispatch('dragover', over);
  assert.equal(over.prevented, 1);
  assert.equal(over.dataTransfer.dropEffect, 'none');

  const drop = fileEvent();
  target.dispatch('drop', drop);
  assert.equal(drop.prevented, 1, 'navigation still blocked while busy');
  assert.equal(attached.length, 0, 'nothing attaches while busy');
});

test('the navigation-only guard and the attaching guard coexist without double-attach', () => {
  const target = makeTarget();
  const attached = [];
  // App-level guard: navigation only (no addFiles).
  createPanelFileDropGuard({ target });
  // Composer-level guard: attaches.
  createPanelFileDropGuard({ target, canAttach: () => true, addFiles: (f) => attached.push(f) });

  const drop = fileEvent();
  target.dispatch('drop', drop);
  assert.ok(drop.prevented >= 1);
  assert.equal(attached.length, 1, 'only the composer guard attaches');
});

test('dispose removes both listeners', () => {
  const target = makeTarget();
  const attached = [];
  const guard = createPanelFileDropGuard({ target, canAttach: () => true, addFiles: (f) => attached.push(f) });
  guard.dispose();
  const drop = fileEvent();
  target.dispatch('drop', drop);
  assert.equal(drop.prevented, 0);
  assert.equal(attached.length, 0);
  assert.equal(target.listeners.dragover.length, 0);
  assert.equal(target.listeners.drop.length, 0);
});

// Wiring: composer-box drops stop propagating BEFORE the window guard (so the
// pond area cannot double-attach), the Composer installs the attaching guard,
// and App keeps a panel-lifetime navigation guard for non-chat tabs.
test('drop guards are wired into Composer and App', () => {
  const composer = readFileSync(new URL('../src/components/chat/Composer.jsx', import.meta.url), 'utf8');
  assert.match(composer, /createPanelFileDropGuard\(\{\s*target: window/);
  assert.match(composer, /addFiles: \(files\) => attachmentPondRef\.current\?\.addFiles\(files\)/);
  const box = composer.match(/const handleFileDrop = \(event\) => \{[\s\S]*?\};/)[0];
  assert.match(box, /event\.stopPropagation\(\)/);

  const app = readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /createPanelFileDropGuard\(\{ target: window \}\)/);
});
