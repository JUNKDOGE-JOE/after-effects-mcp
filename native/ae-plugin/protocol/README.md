# Native AEGP RPC v1

This directory defines the transport-independent contract between the ae-mcp
Core/broker and the in-process After Effects AEGP plug-in. It is intentionally
small enough to implement in C++ without a general JSON-RPC framework.

The contract does **not** choose between AEGP and JSX. It only describes native
capability discovery and invocation when the native execution plane is used.
Every invocation still passes through approval, audit, compatibility, deadline,
and side-effect policy in Core.

## Provenance and evidence status

The schema, fixtures, conformance code, and tests in this directory are
independently designed, product-owned ae-mcp material. They do not contain or
derive Adobe sample source, headers, PiPL/resource text, SDK documentation, or
SDK binaries. Public descriptors use product-owned requirement IDs; concrete
Adobe suite names and versions remain private native-implementation details.

Every checked-in fixture is labelled `synthetic-contract-vector`. Fixtures only
prove schema, codec, and state-machine behavior. They are **not** evidence of a
successful SDK build, plug-in installation, AE loading, AEGP execution, runtime
provenance, or compatibility with any AE/SDK/OS combination. Compatibility stays
`unverified` until separate real-host evidence is attached.

## Framing

Each message is UTF-8 JSON preceded by one unsigned, four-byte, big-endian
length. The length covers only the JSON bytes. Version 1 rejects zero-length,
invalid UTF-8, trailing bytes inside a frame, and frames over 131,072 bytes.
Transport implementations may apply a lower authenticated-session limit.

Parsers also reject duplicate object keys, unsafe integers, more than 16 JSON
levels, more than 2,048 JSON nodes, and strings or object keys over 8,192
Unicode scalar values. Lone UTF-16 surrogates are invalid. C++ implementations
must count decoded Unicode scalar values—not UTF-8 bytes or UTF-16 code units—so
astral characters have the same length in Node and native code. These rules
prevent parser disagreement and bound work before dispatch.
The same limits apply before canonicalizing or encoding locally constructed
output; depth 16 is accepted and depth 17 is rejected. Streaming decoders reject
an unfinished prefix or body from `finalize()` at EOF, and transport adapters
must split reads into chunks no larger than one maximum frame plus its prefix.

Malformed input closes the connection after a bounded structured error whenever
the request ID can be recovered safely. Parsing workers may validate and queue a
message, but they must never call AE suites. Suite calls run only through the
project-defined host-main-thread/IdleHook dispatcher; that rule is not a claim of
Adobe approval or completed host validation.

## Lifecycle

1. The broker sends `hello` with its supported wire-version range. The v1
   length-prefix framing and v1 `hello` envelope are the permanent bootstrap:
   future clients and plug-ins must parse them before negotiating a later wire
   version. A version mismatch is therefore still returned in a v1 envelope.
2. The plug-in selects the highest overlapping version and returns its compiled
   SDK identity, actual AE host identity, instance/session IDs, limits, and a
   capability digest. No overlap returns `WIRE_VERSION_MISMATCH`.
3. The broker requests compact capability summaries by default. It can request
   full, bounded contracts for selected IDs. Version 1 has nine compile-time
   capabilities. Capability discovery deliberately does not support pagination:
   `cursor` is rejected and `nextCursor` must be null. If the effective limit is smaller than the
   number of matching descriptors, the plug-in fails closed instead of returning
   an incomplete page. Unknown requested IDs produce an empty, digest-bound page.
   Responses bind the normalized ids/detail/limit query and session with
   `queryDigest` and can never be replayed.
4. `invoke` is a closed `oneOf` over compile-time registered capability-specific
   input schemas. Version 1 permits `ae.project.summary` and
   `ae.project.bit-depth.read` with empty argument objects, plus
   `ae.project.bit-depth.set` with exactly `targetDepth` (`8`, `16`, or `32`)
   and `idempotencyKey`. It also permits `ae.project.items.list` with rendered
   `offset`/`limit` and an optional first-page `projectLocator`, and
   `ae.composition.layers.list` with a composition locator plus rendered
   `offset`/`limit`. Those reads use bounded capability-owned pagination with a
   default public page size of 25 and a maximum of 50. Future capabilities extend that allowlist with closed,
   bounded schemas; a generic argument bag or field-name blacklist is never a
   security boundary. Arbitrary C++, JSX, shell text, command lines, pointers,
   native handles, and unknown nested data are rejected before dispatch.
5. `invalidateGraph` is an authenticated, internal lifecycle method used when the
   trusted CEP host already has a connected native session and is about to start
   accepted `/exec` JSX. The acknowledgment is a main-thread fence: in that
   connected state, JSX is not evaluated unless the complete old locator namespace
   has already been invalidated. This deliberately invalidates locators even when
   the JSX later makes no project change or fails. With no native client, or after
   that client disconnects, `/exec` keeps its legacy behavior; no native namespace
   exists yet in the former case, while reconnecting establishes a new session that
   makes locators from the disconnected session stale in the latter.
   Its request params are exactly
   `{ "reason": "cep-jsx" }`. The plug-in atomically invalidates the complete
   project/item/composition/layer/stream locator namespace and returns exactly
   `{ "generation": <safe nonnegative integer>, "invalidated": <boolean> }`.
   When `invalidated` is true, `generation` is the resulting positive monotonic
   graph generation. When no locator namespace was active, `invalidated` is
   false and `generation` is the zero sentinel. The response is
   bound to the authenticated session and request ID and is never replayed.
   This method is not a capability descriptor, is never returned by
   `capabilities`, and is not a model-facing or public MCP tool. No other reason
   value or additional field is accepted.
6. Zero or more ordered `progress` events may precede exactly one terminal
   response. Results include `engine=native-aegp` and machine-verifiable evidence.
7. `cancel` is explicit. A timeout never implies that a dispatched mutation
   stopped, and an ambiguous mutation failure is never retried through JSX.

Request IDs are unique per session. An in-flight or content-mismatched duplicate
is rejected with `DUPLICATE_REQUEST`. A bounded terminal-response cache may
replay only the same RFC 8785-canonical request for an idempotent capability and
marks the response `replayed=true`. Cache admission requires the active request
digest to match and a trusted terminal validator to verify the complete exchange;
callers cannot mint replay authority with a boolean. Replay validation requires
the ledger-issued receipt, reuses the receipt's original effective deadline when
the request omitted one, and an expired request is never replayed. Active entries
that pass their deadline become bounded duplicate-detection tombstones so they do
not permanently consume capacity. Terminal evidence must complete no later than
the broker's terminal-observation time, which itself must not exceed the effective
deadline; no clock tolerance is implicit. Different sessions may reuse an ID.
Capabilities declared `idempotency-key` must use a capability-specific invoke
schema that requires the key; non-idempotent mutations are never replayed.
The bit-depth mutation rejects a target that already matches the project before
opening an Undo group and reports `INVALID_ARGUMENT` with `change-arguments`;
that safe no-op does not consume the idempotency key. A successful mutation
reports the verified before/after bits per channel, `effect=committed`, and
`undo={available:true,verified:false}`. Availability is based on an SDK
operation documented as undoable plus a balanced AE Undo group; the invocation
does not consume the global Undo stack to claim the reverse transition was
verified.
Failure responses are retained only as duplicate-detection tombstones and are
never replayed. The reference ledger has hard active/terminal capacities,
deterministic FIFO terminal eviction, a negotiated TTL, and explicit session
purge. Clients remain responsible for never reusing request IDs in a live
session after bounded tombstones expire or are evicted.

## Defaults and bounds

- omitted request deadline: 5,000 ms from broker send time;
- maximum accepted deadline: 30,000 ms;
- maximum frame size: 131,072 bytes;
- omitted capability detail: `summary`;
- omitted capability page size: 50, maximum 100;
- public project-item and composition-layer page size: 25 by default, maximum
  50; Core renders both `offset` and `limit` into every native invoke;
- maximum in-flight requests: negotiated by `hello`, initially 8;
- maximum plug-in queue depth: negotiated by `hello`, initially 32;
- request rate and burst limits: negotiated by `hello`;
- control-plane request rate and burst limits: independently negotiated by
  `hello`, initially 20 requests/second with a burst of 4;
- terminal-response cache entries and TTL: negotiated by `hello`, initially
  128 entries and 60,000 ms;
- progress messages are advisory and bounded; terminal evidence is authoritative.

The executable admission reference keys request identities as
`sessionId:requestId` and uses a deterministic token bucket, then an in-flight
limit and bounded FIFO queue. Rate or capacity
saturation returns `QUEUE_FULL` with a bounded `retryAfterMs`; completion either
releases a slot or promotes exactly one named, unexpired queued request; expired
entries are terminated with `DEADLINE_EXCEEDED` and skipped. `cancel` uses a
separately bounded control-plane slot and token bucket so a saturated work queue
cannot prevent targeted cancellation or allow cancellation floods. Constructor
limits enforce the same maxima declared by the hello schema. Cancellation state
is decided atomically by the controller for the target in the cancel request's
session. It removes an exact queued target or observes running/terminal/unknown
state and issues a one-use decision receipt; exchange validation rejects copied,
replayed, or cross-session decisions. Cooperative descriptors map a running
target to `running-cancel-requested`; the v1 capabilities' `before-dispatch` descriptors
maps it to `running-not-cancellable`. This is contract behavior, not a claim that
the native dispatcher has already been deployed.

All omission behavior is reflected in `aegp-rpc.schema.json` through `default`
or `x-omissionBehavior` metadata so Core, tests, and generated documentation use
the same rules.

## Stable locators

Project objects use server-issued UUID locators bound to host instance, native
session, project, and generation. A locator never contains or encodes an AEGP
handle, pointer, address, or process-local object. Any host/session/project or
generation mismatch returns `STALE_LOCATOR` before suite dispatch.
An accepted `invalidateGraph` lifecycle boundary makes every previously issued
locator stale as one atomic namespace transition; callers must rediscover fresh
locators before the next graph operation.

The lifecycle coverage is deliberately conservative because the fixed-SDK audit
found neither an immutable project-instance identifier nor a documented project
open/close notification:

- Before After Effects handles a menu command, the registered
  `AEGP_HP_BeforeAE` / `AEGP_Command_ALL` hook invalidates the active namespace.
  This covers manual close, open, reopen, Undo, and Redo commands, while accepting
  harmless false-positive invalidation for commands that do not replace a project.
- When the trusted CEP `/exec` bridge has a connected native session, it waits for
  an authenticated `invalidateGraph` main-thread acknowledgment before evaluating
  JSX. If that connected-session fence fails, the JSX is not started. This covers
  an atomic close-and-same-path-reopen carried by one bridge call, even if no graph
  request observes the empty interval. An absent client has issued no native
  namespace, and locators from a disconnected client are fenced by the new session
  established on reconnect.
- A native host/session restart continues to invalidate all locators through the
  existing host and session binding.

Scripts or plug-ins that mutate project lifecycle outside both the registered AE
command path and the authenticated CEP `/exec` path are not claimed as covered.
They must integrate an equivalent invalidation boundary before exposing native
graph reads. Handle, root-item ID, and path equality alone are explicitly not
treated as project-instance proof.

## Error and recovery contract

Every error states whether it is retryable and whether a side effect is known not
to have started, may have occurred, or completed. Recovery is one small enum plus
a short hint; models do not need SDK knowledge to choose the next action.

Error code, retryability, side-effect state, and recovery action are a bound
schema tuple. In particular, `POSSIBLY_SIDE_EFFECTING_FAILURE` is never retryable
and always requires state inspection. Queue saturation includes a bounded retry
delay; no other error may include `retryAfterMs`. Capability-specific failures
carry the matching product capability ID, while wire-version mismatch carries
the supported range. Deadline expiry is reported as safe-to-retry only before dispatch; an
expiry after mutation acceptance uses the possibly-side-effecting error.

Capability, request, and postcondition digests use SHA-256 over RFC 8785 JSON
Canonicalization Scheme bytes. Object property names are sorted by UTF-16 code
units as RFC 8785 requires; this is distinct from the Unicode-scalar counting
used for string length limits. The digest scopes are machine-declared in the
schema. A transcript is valid only when outer envelopes, hello nonce/session,
host instance, descriptor, request/method, capability ID/version, effective
deadline, read/write effect and undo semantics, evidence, monotonic progress,
and terminal count agree; shape validation alone is insufficient. For a fresh
success, broker-send time must be no later than native start, completion must be
no earlier than start, and completion must not exceed the effective deadline.
A replayed success has no progress events and must carry the trusted ledger
receipt for the originally validated response. Cancel
validation likewise binds the requested target ID and, when promised, its one
later terminal response; a queued cancellation must end in typed `CANCELLED`.

Full capability descriptors use product-owned requirement references shaped as
`{id, contractVersion}`. They disclose neither Adobe suite names nor SDK text,
but the versioned requirement is machine-readable by the private native
implementation. Full descriptors embed normalized, self-contained input and
result JSON Schemas so Core or a direct-run UI can validate a call without an
agent or an unverifiable lookup. The empty input explicitly has `required: []`,
`additionalProperties: false`, and no defaults. Full descriptors also carry
bounded positive and negative examples with actual arguments and expected
result/error shapes.

The product-owned Draft 2020-12 subset validator covers every keyword used by
this schema, including deep JSON equality for `const`/`uniqueItems`, Unicode
scalar string bounds, conditionals, combinators, and closed object shapes.
Response and event frames use decode-plus-root-shape entry points before any
exchange semantics or ledger terminal validation. Cross-field rules represented by
`x-invariant` (for example `minimum <= maximum`), session/nonce/digest bindings,
deadline materialization, and transcript state are enforced by the composite
validators after decoding. Transport adapters must use the composite
decode/shape/semantic entry point and return its typed error; accepting a message
because a schema-only validator passed is not sufficient.

The synthetic vectors and negative corpus are executable protocol-conformance
tests for schema binding, defaults, bidirectional version mismatch, duplicate IDs, malformed
messages, fixed-seed property fuzz, exact codec bounds, wrong enums, stale
locators, cancellation, admission saturation/recovery, and digest verification.
They deliberately make no claim about a real After Effects process.
