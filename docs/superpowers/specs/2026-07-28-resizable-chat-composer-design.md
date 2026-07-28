# Resizable Chat Composer Design

**Date:** 2026-07-28

**Issue:** #113 (resizable Composer slice only)

**Status:** Implemented and verified in the real CEP host

## Outcome

Let a user change the vertical height of the chat Composer inside the After
Effects CEP panel without changing the size of the panel itself. The Composer
must remain usable in compact and tall panels, retain its height for the current
mounted chat session, and return to its default height after a remount, panel
reload, or After Effects restart.

This is an isolated panel-UI change. It does not change the public MCP surface,
the turn/backend contract, After Effects project state, or any native behavior.

## Current behavior

`ChatScreen` owns the draft text and renders a fixed-height Composer below the
scrolling transcript. `Composer` renders an optional notice, a single-row
textarea, option chips, and the send/stop button. The textarea has
`maxHeight: 72` and `resize: none`; neither component owns a Composer height or
offers a resize interaction.

Existing keyboard behavior is part of the compatibility boundary:

- Enter sends a non-empty draft when sending is available.
- Shift+Enter inserts a newline.
- Composer chips and their drop-up menus remain reachable.
- The send or stop button remains anchored beside the option row.

## Scope

### Included

- A horizontal resize handle on the top edge of the Composer.
- Pointer drag: upward grows the Composer; downward shrinks it.
- Pointer capture so a drag continues when the pointer leaves the handle.
- Double-click on the handle resets the default height.
- With the handle focused, Shift+ArrowUp grows by 24 px and
  Shift+ArrowDown shrinks by 24 px.
- Session-only height retention while the current `ChatScreen` remains mounted.
- Dynamic clamping when the host panel becomes shorter or taller.
- Focus, hover, and active visuals plus an accessible handle label.

### Explicit non-goals

- Resizing the CEP panel or the whole application window.
- Persisting height in local storage, preferences, files, or backend state.
- Plain ArrowUp/ArrowDown, Home/End, Enter, or other general keyboard resize
  shortcuts.
- Attachments, multimodal file input, drag-and-drop uploads, or clipboard media.
- Changes to message submission, provider selection, approval flow, streaming,
  public MCP tools, native code, AEGP behavior, or Undo.
- A general layout-system or design-system refactor.

## Component responsibilities

### `ChatScreen`

`ChatScreen` owns the session-scoped `composerHeight` state because it already
owns the transcript/composer split and can measure the vertical space available
to both.

It will:

1. Hold the requested Composer height in React state.
2. Observe the height of the transcript-plus-composer container.
3. Compute the current legal maximum.
4. Clamp the requested height whenever the container changes.
5. Pass the controlled height and update/reset callbacks to `Composer`.

No persistence side effect is added. A new `ChatScreen` mount initializes the
default again.

### `Composer`

`Composer` remains responsible for its visual shell and input interactions. It
will accept the controlled height, minimum and maximum, and callbacks from
`ChatScreen`.

It will:

1. Render the resize handle immediately above the existing input well.
2. Translate pointer movement and approved keyboard input into requested
   heights.
3. Apply the controlled height to the whole input well, not just the textarea.
4. Keep the notice outside the resizable well at its intrinsic height.
5. Keep the chip/action row at the bottom while the textarea consumes the
   remaining space and scrolls internally when needed.

The handle is a dedicated component or private helper local to `Composer.jsx`;
it is not promoted into the shared design system for this slice.

## Sizing model

The implementation uses these named constants:

| Constant | Value | Purpose |
| --- | ---: | --- |
| `COMPOSER_MIN_HEIGHT` | 72 px | Fits the one-line editor and bottom controls |
| `COMPOSER_DEFAULT_HEIGHT` | 96 px | Compact default with useful editing room |
| `COMPOSER_KEYBOARD_STEP` | 24 px | Shift+ArrowUp/Down increment |
| `MIN_TRANSCRIPT_HEIGHT` | 120 px | Preserves a useful message viewport |
| `MAX_COMPOSER_RATIO` | 0.6 | Prevents the Composer dominating a tall panel |
| `FALLBACK_MAX_HEIGHT` | 320 px | Safe cap before a container measurement exists |

For a measured available height `H`, the legal maximum is:

`H` is the height shared by the transcript and resizable input well after
subtracting fixed wrapper padding, borders, and the optional notice's measured
outer height. This keeps a visible notice from silently consuming the transcript
reservation.

```text
maxHeight = max(
  COMPOSER_MIN_HEIGHT,
  min(H - MIN_TRANSCRIPT_HEIGHT, floor(H * MAX_COMPOSER_RATIO))
)
```

Before a trustworthy measurement exists, the legal maximum is
`FALLBACK_MAX_HEIGHT`. Every incoming or computed height passes through one
shared clamp helper:

```text
clamp(height) = min(max(finite(height) ? height : defaultHeight, minHeight), maxHeight)
```

When a panel shrinks, `ChatScreen` reclamps the current height immediately. A
later expansion does not restore an older oversized value; the last visible,
legal height remains the session value. Double-click explicitly restores the
default, clamped to the space currently available.

If the host is physically too short to satisfy both minimums,
`COMPOSER_MIN_HEIGHT` wins so the editor controls remain operable; the
transcript keeps `minHeight: 0` and becomes the constrained region.

## Pointer interaction

On primary-button `mousedown`, the handle records:

- the pointer's starting client Y;
- the controlled Composer height at drag start.

It then installs bounded `window` `mousemove` and `mouseup` listeners for the
active drag:

```text
requestedHeight = startHeight + (startY - currentY)
```

Moving upward therefore increases the height. Each request is clamped by the
owner before rendering.

The drag ends on `mouseup`. Cleanup removes both listeners, clears the drag
snapshot, and removes the active visual state. Starting a replacement drag and
component unmount perform the same idempotent cleanup. Secondary buttons do not
start a drag.

This is a real-CEP adaptation. Pointer Capture did not retain the drag once the
pointer left the handle in the AE host, while the bounded window listeners did.

## Keyboard and accessibility behavior

The visual boundary exposes structural `role="separator"` semantics. A
transparent, read-only `input type="text"` focus carrier exposes the current
pixel height in its value and describes the Shift+Arrow shortcuts in its
accessible label. Keeping the roles separate is a real-CEP adaptation: AE
retains Shift+Arrow events for the text control but not for a generic focusable
separator, range input, or button. Together they expose:

- `role="separator"`;
- `aria-orientation="horizontal"`;
- an accessible label describing Composer resizing;
- `aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown"`;
- the current, minimum, and maximum heights in the focus carrier's label.

Only these focused-handle shortcuts resize:

- Shift+ArrowUp: request current height + 24 px.
- Shift+ArrowDown: request current height - 24 px.

Those two combinations call `preventDefault`. Plain arrow keys and all other
keys are left untouched. Textarea keyboard handling remains separate, so Enter
still sends and Shift+Enter still inserts a newline.

The handle has a sufficiently forgiving pointer hit target even though its
visible rule remains subtle. Hover, keyboard focus, and active drag states make
the affordance clear; the cursor is `row-resize`.

## Layout behavior

The resizable input well becomes a vertical flex container with an explicit
controlled height and `minHeight: 0` on the flexible editor region.

- The textarea grows to consume unused space and uses vertical scrolling after
  its content exceeds the available area.
- The option-chip/action row is `flex: none` and remains at the bottom.
- Send and stop buttons keep their current size and behavior.
- Chip drop-up menus retain visible overflow and are not clipped by the new
  height container.
- The transcript remains the other flexible child and scrolls independently.
- Notice content remains above the resizable well and does not distort the
  handle's height semantics.

## Failure handling and invariants

- Non-finite or missing requested heights resolve to the current clamped
  default.
- Missing or temporarily zero container measurements use the fallback maximum
  rather than collapsing the Composer.
- Resize observer callbacks are disconnected on unmount.
- Pointer capture loss is treated as a normal end-of-drag path.
- Disabled and streaming states do not disable resizing; they only retain their
  existing effects on text submission and send/stop controls.
- No resize operation changes draft content or fires `onSend`, `onStop`, or
  option callbacks.

## Test strategy

### Focused component tests

Add tests that prove:

1. Upward and downward drags request the correct direction and use pointer
   capture.
2. Minimum and dynamic maximum clamps hold.
3. Pointer up, cancellation, lost capture, and unmount clear drag state.
4. Container shrink reclamps the height; later expansion does not resurrect the
   previous oversized height.
5. Height survives ordinary rerenders in the same mounted session and resets on
   remount.
6. Double-click resets to the currently legal default.
7. Focused Shift+ArrowUp/Down changes height by 24 px and clamps.
8. Plain arrows and unrelated keys do not resize.
9. Existing textarea Enter-to-send and Shift+Enter-newline behavior remains
   unchanged.
10. Resizing never invokes send, stop, or option callbacks.

### Layout regression tests

Exercise compact, narrow, and tall container dimensions. Assert that:

- transcript and textarea remain scrollable;
- chip controls and send/stop remain visible and operable;
- chip drop-up overflow is not clipped;
- the handle stays reachable at minimum and maximum height.

### Build and observable acceptance

Run the affected Panel tests and build the CEP Panel. Then perform one focused
check in real After Effects:

1. Drag to both clamp boundaries.
2. Resize the host panel and observe reclamping.
3. Double-click to reset.
4. Use Shift+ArrowUp/Down while the handle is focused.
5. Type multiline text and send a normal message.
6. Confirm chips/drop-ups and send/stop controls remain usable.

This smoke has zero public MCP calls, creates no `.aep`, performs no AE state
mutation, and has no Undo requirement. It is panel-UI observable acceptance,
not HDEV, T5, T6, candidate, or release evidence.

## Expected file boundary

Implementation should remain within the Panel UI and its focused tests:

- `plugin/panel/src/screens/ChatScreen.jsx`
- `plugin/panel/src/components/chat/Composer.jsx`
- focused Panel test files or a new Composer resize test beside them
- this design and the later implementation plan

Any need to modify Core, bridge, native, protocol, runtime identity, release
gates, or public tool behavior is a scope break and requires a new decision.
