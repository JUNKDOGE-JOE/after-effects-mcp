# Resizable Chat Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session-scoped, vertically resizable chat Composer to the After Effects CEP panel while preserving message submission, controls, and compact-panel usability.

**Architecture:** Put all numeric sizing, reducer, keyboard, and pointer-session policy in a dependency-free Panel library so Node tests can exercise the behavior without adding a DOM test framework. `ChatScreen` owns the controlled session height and observes the transcript/footer allocation; `Composer` renders the accessible top-edge handle and applies the controlled height to its input well.

**Tech Stack:** React 18.3, CEP Panel JSX and inline styles, Node.js ESM and `node:test`, existing esbuild Panel bundle, macOS After Effects 2026 UI smoke.

**Real-CEP adaptation:** The implementation separates a structural
`role="separator"` boundary from a transparent, read-only text focus carrier
that exposes the current pixel height, and uses bounded window-level
`mousemove`/`mouseup` listeners for an active drag. AE's CEP host did not
preserve Shift+Arrow keyboard events on a generic focusable element, range
input, or button, and did not retain Pointer Capture outside the handle. The
executable tests and the design spec record this verified deviation from the
initial snippets below.

## Global Constraints

- Work only in `.worktrees/issue-113-resizable-composer` on `codex/issue-113-resizable-composer`; do not touch the dirty root checkout or its existing #67/#69 changes.
- The resizable target is the bottom Composer input well, not the CEP panel or After Effects window.
- Use `COMPOSER_MIN_HEIGHT=72`, `COMPOSER_DEFAULT_HEIGHT=96`, `COMPOSER_KEYBOARD_STEP=24`, `MIN_TRANSCRIPT_HEIGHT=120`, `MAX_COMPOSER_RATIO=0.6`, and `FALLBACK_MAX_HEIGHT=320`.
- Persist height only in the mounted `ChatScreen`; do not use local storage, preferences, files, Core state, or backend state.
- Dragging upward grows and dragging downward shrinks; double-click resets the currently legal default.
- Only focused Shift+ArrowUp and Shift+ArrowDown resize by 24 px. Plain arrows, Home/End, Enter, and unrelated keys do not resize.
- Preserve textarea Enter-to-send, Shift+Enter-newline, disabled/streaming behavior, chips, drop-up overflow, and send/stop behavior.
- Do not add a package, change a lockfile, or reinstall dependencies. Reuse the already installed Panel dependencies for local work; CI continues to install from the existing lockfile.
- Do not change public MCP, Core, bridge, native, protocol, runtime identity, release gates, AE project state, or Undo behavior.
- This isolated non-AE UI fix uses focused tests, the full Panel test/build boundary, governance, review, and one real CEP UI smoke. It produces no HDEV, T5, T6, candidate, or release evidence.
- The observable smoke has `public MCP calls=0`, `.aep created=0`, AE mutations=0, and Undo operations=0.
- Mutation-prove each new cross-file contract guard: break the guarded behavior, observe the focused test fail, restore it, and observe it pass.

## File Map

### Resize policy

- Create `plugin/panel/src/lib/composerResize.js` — constants, height clamping, dynamic maximum, reducer, measurement normalization, keyboard request, and pointer-session lifecycle.
- Create `plugin/panel/test/composerResize.test.js` — behavioral unit tests for compact/tall bounds, session reducer, keyboard policy, and pointer capture/cleanup.

### React integration

- Modify `plugin/panel/src/components/chat/Composer.jsx` — controlled sizing props, top-edge handle, pointer/keyboard/reset handlers, textarea flex scrolling, and bottom-anchored controls.
- Modify `plugin/panel/src/screens/ChatScreen.jsx` — session reducer owner, root/footer observation, measurement dispatch, and controlled Composer props.
- Create `plugin/panel/test/composerResizeWiring.test.js` — repository-style source contract proving that both React layers consume the tested policy and retain required accessibility/layout/submission wiring.

### Generated output and evidence

- Modify generated `plugin/client/dist/app.js` — rebuild from the reviewed Panel source.
- Use an untracked local dependency link at `plugin/panel/node_modules` only when the isolated worktree lacks dependencies.
- Record the real AE UI smoke in the PR summary; do not commit private paths, screenshots containing private content, or a fabricated hardware evidence bundle.

---

### Task 1: Add the tested Composer resize policy

**Files:**
- Create: `plugin/panel/src/lib/composerResize.js`
- Create: `plugin/panel/test/composerResize.test.js`

**Interfaces:**
- Produces constants `COMPOSER_MIN_HEIGHT`, `COMPOSER_DEFAULT_HEIGHT`, `COMPOSER_KEYBOARD_STEP`, `MIN_TRANSCRIPT_HEIGHT`, `MAX_COMPOSER_RATIO`, and `FALLBACK_MAX_HEIGHT`.
- Produces `composerMaxHeight(availableHeight: number | null): number`.
- Produces `clampComposerHeight(height: number, maxHeight: number): number`.
- Produces `composerAvailableHeight({containerHeight, footerHeight, composerHeight}): number | null`.
- Produces `createComposerHeightState(availableHeight?: number): {height: number, maxHeight: number}`.
- Produces `reduceComposerHeight(state, action): {height: number, maxHeight: number}` for `measure`, `request`, and `reset`.
- Produces `composerKeyboardRequest(eventLike, currentHeight): number | null`.
- Produces `createComposerPointerSession({target, pointerId, startY, startHeight, onRequest})` with `move(eventLike)`, `finish(eventLike, releaseCapture?)`, and `cancel()`.

- [ ] **Step 1: Write the failing sizing and reducer tests**

Create `plugin/panel/test/composerResize.test.js` with the sizing cases:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSER_DEFAULT_HEIGHT,
  COMPOSER_KEYBOARD_STEP,
  FALLBACK_MAX_HEIGHT,
  clampComposerHeight,
  composerAvailableHeight,
  composerKeyboardRequest,
  composerMaxHeight,
  createComposerHeightState,
  createComposerPointerSession,
  reduceComposerHeight,
} from '../src/lib/composerResize.js';

test('composer bounds preserve the transcript in compact and tall panels', () => {
  assert.equal(composerMaxHeight(null), FALLBACK_MAX_HEIGHT);
  assert.equal(composerMaxHeight(160), 72);
  assert.equal(composerMaxHeight(200), 80);
  assert.equal(composerMaxHeight(800), 480);
  assert.equal(clampComposerHeight(Number.NaN, 480), COMPOSER_DEFAULT_HEIGHT);
  assert.equal(clampComposerHeight(20, 480), 72);
  assert.equal(clampComposerHeight(900, 480), 480);
});

test('footer chrome is removed from the shared transcript and input allocation', () => {
  assert.equal(composerAvailableHeight({
    containerHeight: 400,
    footerHeight: 160,
    composerHeight: 96,
  }), 336);
  assert.equal(composerAvailableHeight({
    containerHeight: 0,
    footerHeight: 160,
    composerHeight: 96,
  }), null);
});

test('session reducer clamps on shrink and does not resurrect an old height', () => {
  let state = createComposerHeightState();
  assert.deepEqual(state, { height: 96, maxHeight: 320 });
  state = reduceComposerHeight(state, { type: 'request', height: 300 });
  assert.equal(state.height, 300);
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 200 });
  assert.deepEqual(state, { height: 80, maxHeight: 80 });
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 800 });
  assert.deepEqual(state, { height: 80, maxHeight: 480 });
  state = reduceComposerHeight(state, { type: 'reset' });
  assert.equal(state.height, COMPOSER_DEFAULT_HEIGHT);
  assert.equal(createComposerHeightState().height, COMPOSER_DEFAULT_HEIGHT);
});
```

- [ ] **Step 2: Write the failing keyboard and pointer-session tests**

Append:

```js
test('only shifted vertical arrows request one keyboard step', () => {
  assert.equal(
    composerKeyboardRequest({ key: 'ArrowUp', shiftKey: true }, 96),
    96 + COMPOSER_KEYBOARD_STEP,
  );
  assert.equal(
    composerKeyboardRequest({ key: 'ArrowDown', shiftKey: true }, 96),
    96 - COMPOSER_KEYBOARD_STEP,
  );
  assert.equal(composerKeyboardRequest({ key: 'ArrowUp', shiftKey: false }, 96), null);
  assert.equal(composerKeyboardRequest({ key: 'Enter', shiftKey: true }, 96), null);
});

test('pointer session captures, reports direction, ignores other pointers, and cleans up', () => {
  const captured = new Set();
  const released = [];
  const target = {
    setPointerCapture(pointerId) { captured.add(pointerId); },
    hasPointerCapture(pointerId) { return captured.has(pointerId); },
    releasePointerCapture(pointerId) {
      captured.delete(pointerId);
      released.push(pointerId);
    },
  };
  const requests = [];
  const session = createComposerPointerSession({
    target,
    pointerId: 7,
    startY: 300,
    startHeight: 96,
    onRequest: (height) => requests.push(height),
  });
  assert.equal(captured.has(7), true);
  assert.equal(session.move({ pointerId: 8, clientY: 200 }), false);
  assert.equal(session.move({ pointerId: 7, clientY: 250 }), true);
  assert.equal(session.move({ pointerId: 7, clientY: 340 }), true);
  assert.deepEqual(requests, [146, 56]);
  assert.equal(session.finish({ pointerId: 7 }, true), true);
  assert.deepEqual(released, [7]);
  assert.equal(session.move({ pointerId: 7, clientY: 200 }), false);
  session.cancel();
  assert.deepEqual(released, [7]);
});

test('lost capture ends a drag without attempting a second release', () => {
  const target = {
    setPointerCapture() {},
    hasPointerCapture() { return true; },
    releasePointerCapture() { throw new Error('must not release after lost capture'); },
  };
  const session = createComposerPointerSession({
    target,
    pointerId: 4,
    startY: 100,
    startHeight: 96,
    onRequest() {},
  });
  assert.equal(session.finish({ pointerId: 4 }, false), true);
  assert.equal(session.move({ pointerId: 4, clientY: 90 }), false);
});

test('unmount cleanup tolerates capture disappearing during release', () => {
  const target = {
    setPointerCapture() {},
    hasPointerCapture() { return true; },
    releasePointerCapture() { throw new Error('capture already gone'); },
  };
  const session = createComposerPointerSession({
    target,
    pointerId: 9,
    startY: 100,
    startHeight: 96,
    onRequest() {},
  });
  assert.doesNotThrow(() => session.cancel());
});
```

- [ ] **Step 3: Run the new test and verify the red state**

Run:

```bash
node --test plugin/panel/test/composerResize.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/composerResize.js`.

- [ ] **Step 4: Implement the constants, sizing helpers, and reducer**

Create `plugin/panel/src/lib/composerResize.js` with:

```js
export const COMPOSER_MIN_HEIGHT = 72;
export const COMPOSER_DEFAULT_HEIGHT = 96;
export const COMPOSER_KEYBOARD_STEP = 24;
export const MIN_TRANSCRIPT_HEIGHT = 120;
export const MAX_COMPOSER_RATIO = 0.6;
export const FALLBACK_MAX_HEIGHT = 320;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

export function composerMaxHeight(availableHeight) {
  if (!finitePositive(availableHeight)) return FALLBACK_MAX_HEIGHT;
  return Math.max(
    COMPOSER_MIN_HEIGHT,
    Math.min(
      availableHeight - MIN_TRANSCRIPT_HEIGHT,
      Math.floor(availableHeight * MAX_COMPOSER_RATIO),
    ),
  );
}

export function clampComposerHeight(height, maxHeight) {
  const legalMax = Math.max(
    COMPOSER_MIN_HEIGHT,
    finitePositive(maxHeight) ? maxHeight : FALLBACK_MAX_HEIGHT,
  );
  const requested = Number.isFinite(height) ? height : COMPOSER_DEFAULT_HEIGHT;
  return Math.min(Math.max(requested, COMPOSER_MIN_HEIGHT), legalMax);
}

export function composerAvailableHeight({
  containerHeight,
  footerHeight,
  composerHeight,
}) {
  if (![containerHeight, footerHeight, composerHeight].every(Number.isFinite)) return null;
  if (containerHeight <= 0 || footerHeight < 0 || composerHeight <= 0) return null;
  const fixedFooterHeight = Math.max(0, footerHeight - composerHeight);
  const availableHeight = containerHeight - fixedFooterHeight;
  return availableHeight > 0 ? availableHeight : null;
}

export function createComposerHeightState(availableHeight) {
  const maxHeight = composerMaxHeight(availableHeight);
  return {
    height: clampComposerHeight(COMPOSER_DEFAULT_HEIGHT, maxHeight),
    maxHeight,
  };
}

export function reduceComposerHeight(state, action) {
  if (action?.type === 'measure') {
    const maxHeight = composerMaxHeight(action.availableHeight);
    return { height: clampComposerHeight(state.height, maxHeight), maxHeight };
  }
  if (action?.type === 'request') {
    return {
      height: clampComposerHeight(action.height, state.maxHeight),
      maxHeight: state.maxHeight,
    };
  }
  if (action?.type === 'reset') {
    return {
      height: clampComposerHeight(COMPOSER_DEFAULT_HEIGHT, state.maxHeight),
      maxHeight: state.maxHeight,
    };
  }
  return state;
}

export function composerKeyboardRequest(eventLike, currentHeight) {
  if (eventLike?.shiftKey !== true) return null;
  if (eventLike.key === 'ArrowUp') return currentHeight + COMPOSER_KEYBOARD_STEP;
  if (eventLike.key === 'ArrowDown') return currentHeight - COMPOSER_KEYBOARD_STEP;
  return null;
}
```

- [ ] **Step 5: Implement the pointer-session lifecycle**

Append:

```js
export function createComposerPointerSession({
  target,
  pointerId,
  startY,
  startHeight,
  onRequest,
}) {
  let active = true;
  target.setPointerCapture(pointerId);

  function releaseIfCaptured() {
    try {
      if (
        typeof target.hasPointerCapture === 'function'
        && target.hasPointerCapture(pointerId)
      ) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Capture may already have been released by the host.
    }
  }

  function move(eventLike) {
    if (!active || eventLike?.pointerId !== pointerId) return false;
    onRequest(startHeight + (startY - eventLike.clientY));
    return true;
  }

  function finish(eventLike, releaseCapture = true) {
    if (!active || eventLike?.pointerId !== pointerId) return false;
    active = false;
    if (releaseCapture) releaseIfCaptured();
    return true;
  }

  function cancel() {
    if (!active) return;
    active = false;
    releaseIfCaptured();
  }

  return Object.freeze({ move, finish, cancel });
}
```

- [ ] **Step 6: Run the focused test and verify green**

Run:

```bash
node --test plugin/panel/test/composerResize.test.js
```

Expected: 7 tests pass, 0 fail.

- [ ] **Step 7: Mutation-prove the dynamic maximum guard**

Using `apply_patch`, temporarily change `MAX_COMPOSER_RATIO` from `0.6` to
`0.7`. Run:

```bash
node --test plugin/panel/test/composerResize.test.js \
  --test-name-pattern='compact and tall'
```

Expected: FAIL because the tall-panel result becomes 560 instead of 480.
Restore `0.6` with `apply_patch`, rerun the same command, and expect PASS.

- [ ] **Step 8: Commit the tested resize policy**

Run:

```bash
git add plugin/panel/src/lib/composerResize.js plugin/panel/test/composerResize.test.js
git commit -m "feat: add composer resize policy"
```

---

### Task 2: Add the accessible controlled resize handle

**Files:**
- Modify: `plugin/panel/src/components/chat/Composer.jsx:1-83`
- Create: `plugin/panel/test/composerResizeWiring.test.js`

**Interfaces:**
- Consumes Task 1 constants, `composerKeyboardRequest`, and `createComposerPointerSession`.
- Extends `Composer` props with `height`, `minHeight`, `maxHeight`, `onHeightChange`, and `onHeightReset`.
- Produces a focusable top-edge handle with pointer, double-click, and Shift+ArrowUp/Down behavior.

- [ ] **Step 1: Write the failing Composer wiring contract**

Create `plugin/panel/test/composerResizeWiring.test.js`:

```js
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
```

- [ ] **Step 2: Run the wiring test and verify the red state**

Run:

```bash
node --test plugin/panel/test/composerResizeWiring.test.js
```

Expected: both tests FAIL because `Composer` has no resize imports, ARIA handle,
or flexible textarea layout.

- [ ] **Step 3: Add controlled sizing props and handle state**

Import:

```js
import {
  COMPOSER_DEFAULT_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  FALLBACK_MAX_HEIGHT,
  composerKeyboardRequest,
  createComposerPointerSession,
} from '../../lib/composerResize';
```

Add props with safe defaults:

```js
height = COMPOSER_DEFAULT_HEIGHT,
minHeight = COMPOSER_MIN_HEIGHT,
maxHeight = FALLBACK_MAX_HEIGHT,
onHeightChange,
onHeightReset,
```

Add a private `ComposerResizeHandle` in the same file. It owns `hover` and
`dragging` visual state plus `dragRef`. Its cleanup effect is:

```js
React.useEffect(() => () => {
  dragRef.current?.cancel();
  dragRef.current = null;
}, []);
```

- [ ] **Step 4: Implement pointer start, movement, and every stop path**

Use these handlers inside `ComposerResizeHandle`:

```js
const finishDrag = (event, releaseCapture) => {
  const finished = dragRef.current?.finish(event, releaseCapture) === true;
  if (finished) {
    dragRef.current = null;
    setDragging(false);
  }
};

const handlePointerDown = (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragRef.current?.cancel();
  dragRef.current = createComposerPointerSession({
    target: event.currentTarget,
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: height,
    onRequest: (nextHeight) => onHeightChange?.(nextHeight),
  });
  setDragging(true);
};
```

Wire `onPointerMove` to `move`, `onPointerUp` and `onPointerCancel` to
`finishDrag(event, true)`, and `onLostPointerCapture` to
`finishDrag(event, false)`.

- [ ] **Step 5: Implement the approved keyboard/reset/accessibility contract**

The handle's keyboard callback is:

```js
const handleResizeKey = (event) => {
  const nextHeight = composerKeyboardRequest(event, height);
  if (nextHeight === null) return;
  event.preventDefault();
  onHeightChange?.(nextHeight);
};
```

Render a focusable separator with:

```jsx
<div
  className="ds-focusable"
  tabIndex={0}
  role="separator"
  aria-label="调整输入区高度 Resize composer"
  aria-orientation="horizontal"
  aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown"
  aria-valuemin={minHeight}
  aria-valuemax={maxHeight}
  aria-valuenow={height}
  onDoubleClick={onHeightReset}
  onKeyDown={handleResizeKey}
  onPointerDown={handlePointerDown}
  onPointerMove={(event) => dragRef.current?.move(event)}
  onPointerUp={(event) => finishDrag(event, true)}
  onPointerCancel={(event) => finishDrag(event, true)}
  onLostPointerCapture={(event) => finishDrag(event, false)}
  onMouseEnter={() => setHover(true)}
  onMouseLeave={() => setHover(false)}
  style={{ height: 10, cursor: 'row-resize', touchAction: 'none' }}
>
  <span aria-hidden="true" />
</div>
```

The inner rule uses the existing border/focus tokens and distinguishes normal,
hover/focus, and active drag states without changing the 10 px hit target.

- [ ] **Step 6: Make the input well fill the controlled height**

Group the handle and existing input well together below `{notice}`. Apply
`height` to the existing well. Keep the row and controls at the bottom:

```js
height,
minHeight: 0,
display: 'flex',
flexDirection: options ? 'column' : 'row',
```

Replace textarea `maxHeight: 72` with:

```js
minHeight: 0,
overflowY: 'auto',
resize: 'none',
```

Add `flex: 'none'` to the option/action row and retain the existing visible
overflow comment and behavior for chip drop-ups.

- [ ] **Step 7: Run the policy and wiring tests**

Run:

```bash
node --test \
  plugin/panel/test/composerResize.test.js \
  plugin/panel/test/composerResizeWiring.test.js
```

Expected: 9 tests pass, 0 fail.

- [ ] **Step 8: Mutation-prove the accessibility wiring guard**

Using `apply_patch`, temporarily remove the handle's `aria-keyshortcuts`
attribute. Run:

```bash
node --test plugin/panel/test/composerResizeWiring.test.js \
  --test-name-pattern='accessible resize'
```

Expected: FAIL on the `aria-keyshortcuts` assertion. Restore the attribute with
`apply_patch`, rerun, and expect PASS.

- [ ] **Step 9: Commit the handle**

Run:

```bash
git add \
  plugin/panel/src/components/chat/Composer.jsx \
  plugin/panel/test/composerResizeWiring.test.js
git commit -m "feat: add composer resize handle"
```

---

### Task 3: Own and re-clamp the Composer height in `ChatScreen`

**Files:**
- Modify: `plugin/panel/src/screens/ChatScreen.jsx:1-13,153-176,218-221,230-289`
- Modify: `plugin/panel/test/composerResizeWiring.test.js`

**Interfaces:**
- Consumes Task 1 `createComposerHeightState`, `reduceComposerHeight`,
  `composerAvailableHeight`, and `COMPOSER_MIN_HEIGHT`.
- Consumes Task 2 controlled `Composer` props.
- Produces a mounted-session height that reclamps from root/footer measurements
  and resets naturally when `ChatScreen` remounts.

- [ ] **Step 1: Extend the wiring test with the failing owner contract**

Append:

```js
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
```

- [ ] **Step 2: Run the owner test and verify the red state**

Run:

```bash
node --test plugin/panel/test/composerResizeWiring.test.js \
  --test-name-pattern='ChatScreen owns'
```

Expected: FAIL because no reducer, observers, refs, or controlled props exist.

- [ ] **Step 3: Add session state and stable measurement refs**

Import:

```js
import {
  COMPOSER_MIN_HEIGHT,
  composerAvailableHeight,
  createComposerHeightState,
  reduceComposerHeight,
} from '../lib/composerResize';
```

Inside `ChatScreen`, add:

```js
const layoutRef = React.useRef(null);
const footerRef = React.useRef(null);
const [composerSize, dispatchComposerSize] = React.useReducer(
  reduceComposerHeight,
  undefined,
  () => createComposerHeightState(),
);
const composerHeightRef = React.useRef(composerSize.height);
composerHeightRef.current = composerSize.height;
```

No storage read/write or App-level state is added.

- [ ] **Step 4: Observe root/footer size and dispatch normalized measurements**

Add an effect:

```js
React.useEffect(() => {
  if (typeof ResizeObserver !== 'function') return undefined;

  const measureComposerBounds = () => {
    const layout = layoutRef.current;
    const footer = footerRef.current;
    if (!layout || !footer) return;
    const availableHeight = composerAvailableHeight({
      containerHeight: layout.getBoundingClientRect().height,
      footerHeight: footer.getBoundingClientRect().height,
      composerHeight: composerHeightRef.current,
    });
    dispatchComposerSize({ type: 'measure', availableHeight });
  };

  measureComposerBounds();
  const observer = new ResizeObserver(measureComposerBounds);
  observer.observe(layoutRef.current);
  observer.observe(footerRef.current);
  return () => observer.disconnect();
}, []);
```

Attach `layoutRef` to the root flex container and `footerRef` to the existing
bordered Composer footer.

- [ ] **Step 5: Pass the controlled state and callbacks**

Add to `<Composer>`:

```jsx
height={composerSize.height}
minHeight={COMPOSER_MIN_HEIGHT}
maxHeight={composerSize.maxHeight}
onHeightChange={(height) => dispatchComposerSize({ type: 'request', height })}
onHeightReset={() => dispatchComposerSize({ type: 'reset' })}
```

Do not change draft, send, stop, disabled, streaming, notice, or chip props.

- [ ] **Step 6: Run focused resize and existing submission tests**

Run:

```bash
node --test \
  plugin/panel/test/composerResize.test.js \
  plugin/panel/test/composerResizeWiring.test.js \
  plugin/panel/test/chatEntries.test.js \
  plugin/panel/test/composerOptions.test.js \
  plugin/panel/test/providerUiClosure.test.js
```

Expected: all focused tests pass with 0 failures.

- [ ] **Step 7: Commit the controlled owner**

Run:

```bash
git add \
  plugin/panel/src/screens/ChatScreen.jsx \
  plugin/panel/test/composerResizeWiring.test.js
git commit -m "feat: retain composer height for the chat session"
```

---

### Task 4: Build, review, and verify the observable Panel behavior

**Files:**
- Modify generated: `plugin/client/dist/app.js`
- Verify only: all Task 1-3 source/tests and the approved design

**Interfaces:**
- Consumes the complete source implementation.
- Produces the rebuilt CEP asset plus a sanitized observable-acceptance summary.

- [ ] **Step 1: Reuse the existing Panel dependencies without installing**

From the isolated worktree root, check:

```bash
test -d plugin/panel/node_modules
```

If absent, verify the main checkout's existing dependency tree:

```bash
test -d ../../plugin/panel/node_modules/esbuild
```

Then create only the ignored local link:

```bash
ln -s ../../../../plugin/panel/node_modules plugin/panel/node_modules
```

Do not run `npm install`, `npm ci`, or change `package-lock.json`.

- [ ] **Step 2: Build the generated Panel asset**

Run:

```bash
npm run build --prefix plugin/panel
```

Expected: esbuild succeeds and only `plugin/client/dist/app.js` is generated.

- [ ] **Step 3: Run the complete Panel suite**

Run:

```bash
npm test --prefix plugin/panel
```

Expected: every Panel test passes with 0 failures. If the known intermittent
runtime-receipt test from #193 fails once, report the exact subtest and rerun
that subtest only; do not hide a repeated failure or call the suite green.

- [ ] **Step 4: Run repository and diff checks**

Run:

```bash
node scripts/check-repository-governance.mjs
git diff --check
git diff --check origin/main...HEAD
git status --short
```

Expected:

- governance passes;
- no whitespace errors;
- changed tracked files are limited to the approved Panel source, focused
  tests, generated asset, design, and plan;
- the ignored `plugin/panel/node_modules` link does not appear.

- [ ] **Step 5: Commit the generated Panel asset**

Run:

```bash
git add plugin/client/dist/app.js
git commit -m "build: update panel bundle for composer resizing"
```

- [ ] **Step 6: Perform one concentrated diff review**

Review:

```bash
git diff origin/main...HEAD -- \
  plugin/panel/src/lib/composerResize.js \
  plugin/panel/src/components/chat/Composer.jsx \
  plugin/panel/src/screens/ChatScreen.jsx \
  plugin/panel/test/composerResize.test.js \
  plugin/panel/test/composerResizeWiring.test.js
```

Check every approved behavior against
`docs/superpowers/specs/2026-07-28-resizable-chat-composer-design.md`:

- drag direction and all pointer stop paths;
- shared clamp logic and session/remount semantics;
- only Shift+ArrowUp/Down keyboard resizing;
- default reset and ARIA values;
- textarea scrolling and bottom controls;
- notice/short-panel accounting;
- no persistence, backend, MCP, native, or release-boundary changes.

If review finds a blocker, add the smallest failing focused test, fix the whole
review batch, rerun Steps 2-4, and commit one review-fix commit.

- [ ] **Step 7: Sync only the CEP development component**

First run the read-only doctor:

```bash
node scripts/dev/ae-mcp-dev.mjs doctor \
  --component cep \
  --repo-root "$PWD"
```

Stop formal After Effects if it is running, then reuse the existing
dependencies and run:

```bash
node scripts/dev/ae-mcp-dev.mjs sync \
  --component cep \
  --repo-root "$PWD"
```

Expected receipt:

- selected component is `cep`;
- one Panel build and one CEP development install run;
- `dependencyBootstrapInvocations=0`;
- `releasePackagingInvocations=0`;
- Core and native remain reused.

- [ ] **Step 8: Launch formal AE and run the zero-MCP UI smoke**

Launch:

```bash
node scripts/dev/ae-mcp-dev.mjs launch-ae \
  --component cep \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

In the real CEP panel, without opening or creating an `.aep`:

1. Drag the handle upward and downward; confirm direction.
2. Drag beyond both bounds; confirm the Composer clamps and controls remain
   usable.
3. Resize the AE panel shorter and taller; confirm shrink reclamps and later
   growth does not restore an older oversized height.
4. Double-click the handle; confirm it resets to the currently legal default.
5. Focus the handle and press Shift+ArrowUp/Down; confirm 24 px steps. Press
   plain arrows and confirm no resize.
6. Type two lines using Shift+Enter; confirm no send occurs.
7. Send ordinary text with Enter; confirm the existing send path works.
8. Open available chip drop-ups and, while streaming if practical without an AE
   tool call, confirm send/stop placement remains usable.

Record only a sanitized result table with `PASS`/`FAIL` for the eight checks.
Do not record private message text or local paths.

- [ ] **Step 9: Verify the evidence boundary**

The final summary must state exactly:

```text
public MCP calls: 0
.aep created: 0
AE project mutations: 0
Undo operations: 0
validation class: observable CEP UI smoke
HDEV/T5/T6/candidate/release evidence: none
```

Any AE crash, invisible handle, clipped controls, broken send/newline behavior,
or repeated lower-tier failure is a blocker. Fix it with a focused red test and
repeat only the affected lower tiers plus the single UI smoke. Do not widen the
work into multimodal input or backend changes.

- [ ] **Step 10: Prepare the PR without merging**

Push `codex/issue-113-resizable-composer` and open a Draft PR linked to Issue
#113. The PR summary includes:

- resizable-Composer scope and explicit multimodal non-goal;
- test/build/governance results;
- dependency reuse and zero bootstrap count;
- sanitized eight-row UI smoke result;
- zero MCP/AEP/mutation/Undo evidence boundary;
- the statement that this is development-verified Panel UI, not
  release-accepted evidence.

Stop for review before marking ready or merging.
