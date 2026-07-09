# Cross-Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the macOS arm64 and Windows x64 platform foundation: authenticated native helper, centralized path/process adapters, offline self-contained runtimes, host-mediated snapshots, and reproducible dual-platform package staging and verification.

**Architecture:** CEP remains the sole production host. Panel business code consumes one JavaScript platform adapter, while the in-process CEP host alone opens an authenticated native-helper session for secrets and After Effects window capture; Python reaches capture only through the existing authenticated host bridge. This plan builds locked portable Node and CPython payloads, creates deterministic unsigned platform staging trees, verifies every file and native architecture, and proves the nested signing chains with disposable Phase 0 outputs. The dual-platform release plan alone turns those interfaces into signed candidates and releases.

**Tech Stack:** React 18 and CEP Node, Node.js `node:test`, Python 3.13 with pytest/httpx, Swift/XPC/Security.framework/ScreenCaptureKit on macOS, C++20/Win32 Credential Manager/Windows Graphics Capture on Windows, CMake/CTest, GitHub Actions, ZXPSignCmd, Apple codesign/notarytool, and Windows signtool.

## Global Constraints

- Production remains CEP + ExtendScript + Node host/sidecar + Python MCP; no UXP runtime or UXP abstraction is introduced.
- Supported macOS is macOS 14 Sonoma or newer on native Apple Silicon arm64; Rosetta and Intel Mac are rejected.
- Supported Windows is Windows 11 24H2 or newer on x64; Windows ARM is rejected.
- Supported After Effects versions are exactly 25.x and 26.x; `plugin/CSXS/manifest.xml` must use `[25.0,26.9]`.
- Platform branching is allowed only in `plugin/panel/src/cep/platform/`, native helper implementations, and package/build entry points.
- Core runtime behavior must not depend on system Python, system Node, `uv`, npm resolution, PyPI, or an online download after installation.
- Portable Node is locked to `24.17.0`; portable CPython is locked to python-build-standalone `3.13.14+20260610`.
- The stable launcher is `~/.ae-mcp/bin/ae-mcp` on macOS and `~/.ae-mcp/bin/ae-mcp.exe` on Windows; it selects a verified runtime only through an atomic `~/.ae-mcp/runtime/current` pointer.
- The helper bundle ID is `com.junkdoge.ae-mcp.platform-helper`; Keychain service is `com.junkdoge.ae-mcp`.
- Production helper methods are limited to `capabilities`, `secret.get`, `secret.set`, `secret.delete`, `window.find`, `window.describe`, and `window.capture`; enumeration and generic CLI modes are forbidden.
- Every helper request authenticates the caller before parsing a secret reference, resolving a window, or touching a backend.
- The host exposes an authenticated capture route but never exposes secret read/write/delete over HTTP or RPC.
- `ae.previewFrame` continues to prefer `CompItem.saveFrameToPng`; window capture is fallback-only.
- Provider schema and provider-specific migration remain owned by the request-header plan. This plan supplies `SecretReference`, host secret methods, and the generic two-phase migration runner only.
- Formal signed-candidate workflows, candidate/build locks, final artifact-set or release manifests, RC attestation, tag creation, and release promotion are outside this plan.
- Preserve unrelated working-tree changes, including `packages/core/ae_mcp/schemas.py`, `scripts/create_timer_display.jsx`, `scripts/run_timer_display.py`, and `scripts/smoke-test-macos.sh`.

---

### Task 1: Lock the supported platform and host matrix

**Files:**
- Create: `packaging/support-matrix.json`
- Create: `packaging/schemas/support-matrix.schema.json`
- Create: `scripts/package/test/support-matrix.test.mjs`
- Modify: `plugin/CSXS/manifest.xml:9-18`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Produces: `SupportMatrixV1`, consumed by package verification and CI.
- Produces: exact CEP host range `[25.0,26.9]`.

```ts
type SupportMatrixV1 = {
  schemaVersion: 1;
  platforms: {
    "macos-arm64": { minOsVersion: "14.0"; arch: "arm64"; rosetta: false };
    "windows-x64": { minOsVersion: "11.0.26100"; arch: "x64" };
  };
  afterEffects: { majors: [25, 26]; manifestRange: "[25.0,26.9]" };
};
```

- [ ] **Step 1: Write the failing support-matrix test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('support matrix and CEP manifest promise only the verified matrix', () => {
  const matrix = JSON.parse(fs.readFileSync('packaging/support-matrix.json', 'utf8'));
  const manifest = fs.readFileSync('plugin/CSXS/manifest.xml', 'utf8');
  assert.deepEqual(matrix.platforms['macos-arm64'], {
    minOsVersion: '14.0', arch: 'arm64', rosetta: false,
  });
  assert.deepEqual(matrix.platforms['windows-x64'], {
    minOsVersion: '11.0.26100', arch: 'x64',
  });
  assert.deepEqual(matrix.afterEffects.majors, [25, 26]);
  assert.equal(matrix.afterEffects.manifestRange, '[25.0,26.9]');
  assert.match(manifest, /<Host Name="AEFT" Version="\[25\.0,26\.9\]" \/>/);
  assert.doesNotMatch(manifest, /99\.9/);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test scripts/package/test/support-matrix.test.mjs`

Expected: FAIL with `ENOENT: no such file or directory, open 'packaging/support-matrix.json'`.

- [ ] **Step 3: Add the exact matrix and narrow the manifest**

```json
{
  "schemaVersion": 1,
  "platforms": {
    "macos-arm64": { "minOsVersion": "14.0", "arch": "arm64", "rosetta": false },
    "windows-x64": { "minOsVersion": "11.0.26100", "arch": "x64" }
  },
  "afterEffects": {
    "majors": [25, 26],
    "manifestRange": "[25.0,26.9]"
  }
}
```

Replace the manifest host entry with:

```xml
<Host Name="AEFT" Version="[25.0,26.9]" />
```

Update both READMEs to state only the matrix above and remove the current macOS-unverified wording.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node --test scripts/package/test/support-matrix.test.mjs`

Expected: PASS with one passing test and zero failures.

- [ ] **Step 5: Commit**

```bash
git add packaging/support-matrix.json packaging/schemas/support-matrix.schema.json scripts/package/test/support-matrix.test.mjs plugin/CSXS/manifest.xml README.md README.zh-CN.md
git commit -m "chore(platform): lock supported platform matrix"
```

### Task 2: Lock and build the offline portable runtimes

**Files:**
- Create: `packaging/runtime-lock.json`
- Create: `packaging/license-policy.json`
- Create: `packaging/schemas/runtime-manifest.schema.json`
- Create: `scripts/package/lib/args.mjs`
- Create: `scripts/package/lib/files.mjs`
- Create: `scripts/package/lib/locked-download.mjs`
- Create: `scripts/package/build-portable-runtime.mjs`
- Create: `scripts/package/generate-runtime-inventory.mjs`
- Create: `scripts/package/test/runtime-lock.test.mjs`
- Create: `scripts/package/test/runtime-inventory.test.mjs`
- Modify: `plugin/host/package.json:9-11`
- Modify: `plugin/host/package-lock.json`
- Modify: `plugin/sidecar/package.json:6-8`
- Modify: `plugin/sidecar/package-lock.json`

**Interfaces:**
- Consumes: `SupportMatrixV1` from Task 1.
- Produces: `RuntimeLockV1` and a directory accepted by the runtime installer and stage CLI.

```ts
type RuntimeLockV1 = {
  schemaVersion: 1;
  node: {
    version: "24.17.0";
    headers: { url: string; sha256: string };
    assets: Record<"macos-arm64" | "windows-x64", { url: string; sha256: string }>;
  };
  python: {
    version: "3.13.14";
    distributionRelease: "20260610";
    assets: Record<"macos-arm64" | "windows-x64", { url: string; sha256: string }>;
  };
};

async function downloadLockedAsset(input: {
  url: string;
  sha256: string;
  destination: string;
}): Promise<void>;

async function buildPortableRuntime(input: {
  platform: "macos-arm64" | "windows-x64";
  outDir: string;
  repoRoot: string;
}): Promise<{ root: string; manifestPath: string }>;
```

- [ ] **Step 1: Write the failing runtime-lock tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('runtime lock pins exact redistributable bytes', () => {
  const lock = JSON.parse(fs.readFileSync('packaging/runtime-lock.json', 'utf8'));
  assert.equal(lock.node.version, '24.17.0');
  assert.equal(lock.node.assets['macos-arm64'].sha256, '4fc3266a3702eebc39cc37661cf4eeceeade307e242ab64e4d7ce7949197e11f');
  assert.equal(lock.node.assets['windows-x64'].sha256, 'f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab');
  assert.equal(lock.node.headers.sha256, 'ac60c4ba92204658efaac112efea5d3597348b011be679af0eec324d8c08915e');
  assert.equal(lock.python.version, '3.13.14');
  assert.equal(lock.python.distributionRelease, '20260610');
  assert.equal(lock.python.assets['macos-arm64'].sha256, '79daa8e9dea1e64ad50aebb05a807289023a474c2020b72361eb44d67fa2401e');
  assert.equal(lock.python.assets['windows-x64'].sha256, '2933d50847057b9131ff89578a220b9206c40fd6bc34d0c12afb716bd9bf8fc9');
});
```

Add inventory assertions that every component has `name`, `version`, `license`, `source`, and `sha256`, and that no license is `UNKNOWN`.

- [ ] **Step 2: Run the tests to verify RED**

Run: `node --test scripts/package/test/runtime-lock.test.mjs scripts/package/test/runtime-inventory.test.mjs`

Expected: FAIL because `packaging/runtime-lock.json` and the inventory module do not exist.

- [ ] **Step 3: Add the locked assets and deterministic builder**

The lock must contain these URLs and hashes exactly:

```json
{
  "schemaVersion": 1,
  "node": {
    "version": "24.17.0",
    "headers": {
      "url": "https://nodejs.org/dist/v24.17.0/node-v24.17.0-headers.tar.gz",
      "sha256": "ac60c4ba92204658efaac112efea5d3597348b011be679af0eec324d8c08915e"
    },
    "assets": {
      "macos-arm64": {
        "url": "https://nodejs.org/dist/v24.17.0/node-v24.17.0-darwin-arm64.tar.gz",
        "sha256": "4fc3266a3702eebc39cc37661cf4eeceeade307e242ab64e4d7ce7949197e11f"
      },
      "windows-x64": {
        "url": "https://nodejs.org/dist/v24.17.0/node-v24.17.0-win-x64.zip",
        "sha256": "f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab"
      }
    }
  },
  "python": {
    "version": "3.13.14",
    "distributionRelease": "20260610",
    "assets": {
      "macos-arm64": {
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "sha256": "79daa8e9dea1e64ad50aebb05a807289023a474c2020b72361eb44d67fa2401e"
      },
      "windows-x64": {
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "sha256": "2933d50847057b9131ff89578a220b9206c40fd6bc34d0c12afb716bd9bf8fc9"
      }
    }
  }
}
```

The builder must download into a temporary directory, verify SHA-256 before extraction, build the three workspace wheels, install from the frozen `uv.lock` into the portable interpreter, run Python import and Node module smoke checks, generate `runtime-manifest.json`, then atomically rename the output. It must fail if any dependency needs an unpinned network resolution.

Pin `express` to `4.22.1` and `@anthropic-ai/claude-agent-sdk` to `0.3.174` in both package manifests and lockfiles.

- [ ] **Step 4: Run unit tests and native runtime smoke checks to verify GREEN**

Run: `node --test scripts/package/test/runtime-lock.test.mjs scripts/package/test/runtime-inventory.test.mjs`

Expected: PASS with zero unknown licenses and zero floating runtime inputs.

Run on macOS arm64:

```bash
node scripts/package/build-portable-runtime.mjs --platform macos-arm64 --out build/runtime/macos-arm64
build/runtime/macos-arm64/node/bin/node --version
build/runtime/macos-arm64/python/bin/python3 -I -c "import ae_mcp, ae_mcp_bridge"
```

Expected: builder prints `runtime ready: macos-arm64 node=24.17.0 python=3.13.14`; Node prints `v24.17.0`; Python exits 0 without output.

Run on Windows x64:

```powershell
node scripts/package/build-portable-runtime.mjs --platform windows-x64 --out build/runtime/windows-x64
build\runtime\windows-x64\node\node.exe --version
build\runtime\windows-x64\python\python.exe -I -c "import ae_mcp, ae_mcp_bridge"
```

Expected: builder prints `runtime ready: windows-x64 node=24.17.0 python=3.13.14`; Node prints `v24.17.0`; Python exits 0 without output.

- [ ] **Step 5: Commit**

```bash
git add packaging/runtime-lock.json packaging/license-policy.json packaging/schemas/runtime-manifest.schema.json scripts/package/lib/args.mjs scripts/package/lib/files.mjs scripts/package/lib/locked-download.mjs scripts/package/build-portable-runtime.mjs scripts/package/generate-runtime-inventory.mjs scripts/package/test/runtime-lock.test.mjs scripts/package/test/runtime-inventory.test.mjs plugin/host/package.json plugin/host/package-lock.json plugin/sidecar/package.json plugin/sidecar/package-lock.json
git commit -m "build(runtime): lock offline node and python payloads"
```

### Task 3: Define the helper protocol and CEP-host client

**Files:**
- Create: `native/platform-helper/protocol/platform-helper.schema.json`
- Create: `native/platform-helper/protocol/fixtures/capabilities.json`
- Create: `native/platform-helper/protocol/fixtures/secret-get.json`
- Create: `native/platform-helper/protocol/fixtures/window-capture.json`
- Create: `native/platform-helper/protocol/fixtures/invalid-unknown-method.json`
- Create: `native/platform-helper/protocol/protocol.test.mjs`
- Create: `plugin/host/platform-helper-client.js`
- Create: `plugin/host/platform-helper-transport.js`
- Create: `plugin/host/platform-helper-client.test.js`
- Create: `plugin/host/platform-helper-transport.test.js`
- Create: `native/platform-helper/client-addon/CMakeLists.txt`
- Create: `native/platform-helper/client-addon/src/common.hpp`
- Create: `native/platform-helper/client-addon/src/common.cpp`
- Create: `native/platform-helper/client-addon/src/addon_macos.mm`
- Create: `native/platform-helper/client-addon/src/addon_windows.cpp`
- Create: `packaging/schemas/phase0-evidence.schema.json`
- Create: `scripts/phase0/assert-helper-rejected.mjs`
- Create: `scripts/phase0/collect-phase0-evidence.mjs`
- Create: `scripts/phase0/test/phase0-evidence.test.mjs`

**Interfaces:**
- Consumes: Node headers locked by Task 2.
- Produces: the only host-facing helper client and versioned JSON-RPC schema.

```ts
type HelperMethod =
  | "capabilities"
  | "secret.get"
  | "secret.set"
  | "secret.delete"
  | "window.find"
  | "window.describe"
  | "window.capture";

type HelperErrorCode =
  | "HELPER_UNAUTHORIZED"
  | "HELPER_UNAVAILABLE"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "INVALID_REQUEST"
  | "INVALID_REFERENCE"
  | "MESSAGE_TOO_LARGE"
  | "SECRET_NOT_FOUND"
  | "SECRET_CONFLICT"
  | "SECRET_STORE_UNAVAILABLE"
  | "SCREEN_RECORDING_PERMISSION_REQUIRED"
  | "AE_WINDOW_NOT_FOUND"
  | "AE_WINDOW_NOT_CAPTURABLE"
  | "CAPTURE_FAILED";

type HelperRequest = {
  protocolVersion: 1;
  id: number;
  method: HelperMethod;
  params: Record<string, unknown>;
};

type HelperSuccess<T> = {
  protocolVersion: 1;
  id: number;
  ok: true;
  result: T;
};

type HelperFailure = {
  protocolVersion: 1;
  id: number;
  ok: false;
  error: { code: HelperErrorCode; message: string; retryable: boolean };
};

type HelperResponse<T> = HelperSuccess<T> | HelperFailure;

type SecretReference = `aemcp-secret://provider/${string}/${string}/v1`;

type PlatformCapabilities = {
  protocolVersion: 1;
  platform: "macos-arm64" | "windows-x64";
  helperVersion: string;
  secretBackend: "keychain" | "credential-manager";
  captureBackend: "screen-capture-kit" | "windows-graphics-capture";
  authenticatedCaller: true;
  maxMessageBytes: 65536;
  methods: HelperMethod[];
};

type SecretReadResult = {
  reference: SecretReference;
  value: string;
  revision: number;
};

type WindowDescription = {
  reference: string;
  application: "after-effects";
  ownerBundleId: "com.adobe.AfterEffects.application";
  ownerTeamId: "JQ525L2MZD";
  processId: number;
  title: string;
  frame: { x: number; y: number; width: number; height: number };
  scale: number;
  capturable: boolean;
};

type CaptureResult = {
  captureId: string;
  reference: string;
  spoolPath: string;
  width: number;
  height: number;
  scale: number;
  method: "ScreenCaptureKit" | "WindowsGraphicsCapture";
  sha256: string;
};

type PlatformHelperClient = {
  capabilities(): Promise<PlatformCapabilities>;
  secretGet(reference: SecretReference): Promise<SecretReadResult>;
  secretSet(input: { reference: SecretReference; value: string; expectedRevision: number | null }): Promise<{ reference: SecretReference; revision: number }>;
  secretDelete(input: { reference: SecretReference; expectedRevision?: number }): Promise<{ reference: SecretReference; deleted: boolean; revision: number | null }>;
  windowFind(input?: { target?: "after-effects-main" }): Promise<WindowDescription[]>;
  windowDescribe(reference: string): Promise<WindowDescription>;
  windowCapture(input: { reference?: string; target?: "after-effects-main"; captureId: string; method?: "auto" | "DesktopCopy" | "PrintWindow" }): Promise<CaptureResult>;
  close(): Promise<void>;
};

function createPlatformHelperClient(input: {
  transport: { request(jsonUtf8: string): Promise<string>; close(): Promise<void> };
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}): PlatformHelperClient;
```

The public `PlatformHelperClient` methods are exactly:

```ts
capabilities(): Promise<PlatformCapabilities>;
secretGet(reference: SecretReference): Promise<SecretReadResult>;
secretSet(input: { reference: SecretReference; value: string; expectedRevision: number | null }): Promise<{ reference: SecretReference; revision: number }>;
secretDelete(input: { reference: SecretReference; expectedRevision?: number }): Promise<{ reference: SecretReference; deleted: boolean; revision: number | null }>;
windowFind(input?: { target?: "after-effects-main" }): Promise<WindowDescription[]>;
windowDescribe(reference: string): Promise<WindowDescription>;
windowCapture(input: { reference?: string; target?: "after-effects-main"; captureId: string; method?: "auto" | "DesktopCopy" | "PrintWindow" }): Promise<CaptureResult>;
close(): Promise<void>;
```

- [ ] **Step 1: Write failing schema/client tests**

```js
test('client rejects unknown operations and oversized messages before transport', async () => {
  let calls = 0;
  const client = createPlatformHelperClient({
    maxMessageBytes: 64,
    transport: {
      request: async () => { calls += 1; return '{}'; },
      close: async () => {},
    },
  });
  await assert.rejects(
    client.secretSet({
      reference: 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1',
      value: 'x'.repeat(128),
      expectedRevision: null,
    }),
    { code: 'MESSAGE_TOO_LARGE' },
  );
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(client, 'secretList'), false);
});
```

Add fixture tests that accept the seven allowed methods and reject `secret.list`, missing protocol versions, duplicate IDs, and malformed error envelopes.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test native/platform-helper/protocol/protocol.test.mjs plugin/host/platform-helper-client.test.js plugin/host/platform-helper-transport.test.js scripts/phase0/test/phase0-evidence.test.mjs`

Expected: FAIL because the schema, client, transport, and evidence validator do not exist.

- [ ] **Step 3: Implement the bounded client and native transport contract**

The client request path must enforce protocol version `1`, positive integer IDs, the seven-method enum, a default 65,536-byte request/response limit, and a default 10,000 ms timeout. `platform-helper-transport.js` may inspect `process.platform` and `process.arch`; no other host file may do so.

The N-API addon contract is:

```cpp
napi_value CreateTransport(napi_env env, napi_callback_info info);
// JavaScript result: { request(jsonUtf8): Promise<string>, close(): Promise<void> }
```

The phase-zero evidence schema must require platform ID, helper identity, AE 25 and AE 26 results, secret backend access counters, capture backend access counters, signing output, and adversarial-case results.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test native/platform-helper/protocol/protocol.test.mjs plugin/host/platform-helper-client.test.js plugin/host/platform-helper-transport.test.js scripts/phase0/test/phase0-evidence.test.mjs`

Expected: PASS; the unknown-method fixture returns `INVALID_REQUEST`, the oversize test records zero transport calls, and the public client has no enumeration method.

- [ ] **Step 5: Commit**

```bash
git add native/platform-helper/protocol plugin/host/platform-helper-client.js plugin/host/platform-helper-transport.js plugin/host/platform-helper-client.test.js plugin/host/platform-helper-transport.test.js native/platform-helper/client-addon packaging/schemas/phase0-evidence.schema.json scripts/phase0
git commit -m "feat(helper): define authenticated platform protocol"
```

### Task 4: Build the macOS XPC helper and prove the Keychain boundary

**Files:**
- Create: `native/platform-helper/macos/Package.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/main.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/ProtocolDispatcher.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/Authorization.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/KeychainSecretStore.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/ScreenCaptureBackend.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/ServiceRegistration.swift`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/Resources/Info.plist`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/Resources/PlatformHelper.entitlements`
- Create: `native/platform-helper/macos/Sources/PlatformHelperService/Resources/com.junkdoge.ae-mcp.platform-helper.plist`
- Create: `native/platform-helper/macos/Tests/PlatformHelperTests/ProtocolDispatcherTests.swift`
- Create: `native/platform-helper/macos/Tests/PlatformHelperTests/AuthorizationTests.swift`
- Create: `native/platform-helper/macos/Tests/PlatformHelperTests/KeychainSecretStoreTests.swift`
- Create: `native/platform-helper/macos/Tests/PlatformHelperTests/ScreenCaptureBackendTests.swift`
- Create: `packaging/helper-identity-policy.json`
- Create: `scripts/package/build-platform-helper.mjs`
- Create: `docs/platform/PHASE0.md`

**Interfaces:**
- Consumes: protocol and N-API transport from Task 3.
- Produces: signed `com.junkdoge.ae-mcp.platform-helper` XPC service and arm64 transport addon.

```swift
protocol CallerAuthorizing {
    func authorize(auditToken: audit_token_t) throws -> AuthorizedCaller
}

protocol SecretStoring {
    func get(reference: SecretReference) throws -> SecretRecord?
    func set(reference: SecretReference, value: Data, expectedRevision: Int?) throws -> SecretRecord
    func delete(reference: SecretReference, expectedRevision: Int?) throws -> SecretDeleteResult
}

struct SecretRecord: Equatable {
    let reference: SecretReference
    let value: Data
    let revision: Int
}
```

- [ ] **Step 1: Write failing authorization and Keychain tests**

```swift
func testUnauthorizedCallerIsRejectedBeforeReferenceParsingAndBackendAccess() async throws {
    let authorizer = RejectingAuthorizer()
    let secrets = CountingSecretStore()
    let captures = CountingCaptureBackend()
    let dispatcher = ProtocolDispatcher(authorizer: authorizer, secrets: secrets, captures: captures)

    let response = await dispatcher.handle(
        auditToken: FakeAuditTokens.terminal,
        bytes: Data(#"{"protocolVersion":1,"id":1,"method":"secret.get","params":{"reference":"forged"}}"#.utf8)
    )

    XCTAssertEqual(response.error?.code, "HELPER_UNAUTHORIZED")
    XCTAssertEqual(secrets.accessCount, 0)
    XCTAssertEqual(captures.accessCount, 0)
}

func testSetUsesCreateThenExactRevisionCAS() throws {
    let store = KeychainSecretStore(backend: InMemoryKeychainBackend())
    let ref = try SecretReference("aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1")
    let first = try store.set(reference: ref, value: Data("one".utf8), expectedRevision: nil)
    XCTAssertEqual(first.revision, 1)
    let second = try store.set(reference: ref, value: Data("two".utf8), expectedRevision: 1)
    XCTAssertEqual(second.revision, 2)
    XCTAssertThrowsError(try store.set(reference: ref, value: Data("three".utf8), expectedRevision: 1))
}
```

- [ ] **Step 2: Run Swift tests to verify RED**

Run: `swift test --package-path native/platform-helper/macos`

Expected: FAIL because `ProtocolDispatcher`, `CallerAuthorizing`, and `KeychainSecretStore` are undefined.

- [ ] **Step 3: Implement authorization-first dispatch and Keychain storage**

The dispatcher order is fixed:

```swift
func handle(connection: NSXPCConnection, bytes: Data) async -> ProtocolResponse {
    do {
        let caller = try authorizer.authorize(auditToken: connection.auditToken)
        let request = try validator.decodeAuthorizedRequest(bytes)
        return try await dispatch(request: request, caller: caller)
    } catch {
        return ProtocolResponse(error: ProtocolError.from(error))
    }
}
```

Authorization must validate the XPC audit token, bundle ID `com.adobe.AfterEffects.application`, Adobe Team ID `JQ525L2MZD`, signed AE 25/26 ancestry, current user session, and native arm64 execution. The Keychain service is `com.junkdoge.ae-mcp`; helper-local account derivation is `provider:<uuid>:<slot>:v1`. Store `{schemaVersion:1,revision,value}` as one credential blob, serialize mutations on one helper queue, verify every set by immediate readback, and make delete idempotent.

`ScreenCaptureBackend.swift` contains only a protocol and an injected unavailable fake in this task; Task 12 supplies production ScreenCaptureKit.

- [ ] **Step 4: Run unit and Phase 0 macOS checks to verify GREEN**

Run: `swift test --package-path native/platform-helper/macos`

Expected: PASS; unauthorized test shows zero backend accesses, CAS conflict returns `SECRET_CONFLICT`, and delete-twice succeeds.

Run:

```bash
node scripts/package/build-platform-helper.mjs --platform macos-arm64 --out build/helper/macos-arm64
node scripts/phase0/assert-helper-rejected.mjs --platform macos-arm64 --root build/helper/macos-arm64 --method secret.get
```

Expected: build output contains an arm64 helper and arm64 `.node` addon; adversarial command prints `HELPER_UNAUTHORIZED backendAccessCount=0` and exits 0 because rejection is the expected result.

With `AE_MCP_AE25_APP` and `AE_MCP_AE26_APP` set to signed AE application bundles, run:

```bash
node scripts/phase0/collect-phase0-evidence.mjs --platform macos-arm64 --helper-root build/helper/macos-arm64 --out build/phase0/macos-helper.json
node --test scripts/phase0/test/phase0-evidence.test.mjs
```

Expected: evidence validates AE 25 and 26 caller identity, Keychain create/read/CAS/delete, readback across a helper rebuild with the same identity, TCC attribution to the helper, Terminal/Python direct-launch rejection, forged reference rejection, wrong signer rejection, stale capability rejection, and zero listening TCP/UDP sockets.

- [ ] **Step 5: Commit**

```bash
git add native/platform-helper/macos packaging/helper-identity-policy.json scripts/package/build-platform-helper.mjs docs/platform/PHASE0.md
git commit -m "feat(helper): add authorized macos keychain broker"
```

### Task 5: Build the Windows helper and enforce the Phase 0 stop gate

**Files:**
- Create: `native/platform-helper/windows/CMakeLists.txt`
- Create: `native/platform-helper/windows/include/platform_helper/protocol.hpp`
- Create: `native/platform-helper/windows/include/platform_helper/authorization.hpp`
- Create: `native/platform-helper/windows/include/platform_helper/credential_store.hpp`
- Create: `native/platform-helper/windows/include/platform_helper/window_capture.hpp`
- Create: `native/platform-helper/windows/src/main.cpp`
- Create: `native/platform-helper/windows/src/protocol.cpp`
- Create: `native/platform-helper/windows/src/authorization.cpp`
- Create: `native/platform-helper/windows/src/credential_store.cpp`
- Create: `native/platform-helper/windows/src/pipe_server.cpp`
- Create: `native/platform-helper/windows/src/window_capture.cpp`
- Create: `native/platform-helper/windows/src/ae_mcp_launcher.cpp`
- Create: `native/platform-helper/windows/tests/protocol_test.cpp`
- Create: `native/platform-helper/windows/tests/authorization_test.cpp`
- Create: `native/platform-helper/windows/tests/credential_store_test.cpp`
- Create: `native/platform-helper/windows/tests/window_capture_test.cpp`
- Modify: `packaging/helper-identity-policy.json`
- Modify: `scripts/package/build-platform-helper.mjs`
- Modify: `docs/platform/PHASE0.md`

**Interfaces:**
- Consumes: protocol, transport, runtime headers, and identity policy from Tasks 2-4.
- Produces: x64 helper, one-time named-pipe transport, Credential Manager store, and signed x64 stable launcher.

```cpp
class CallerAuthorizer {
public:
    virtual AuthorizedCaller Authorize(const PipePeer& peer) const = 0;
};

class CredentialStore {
public:
    virtual std::optional<SecretRecord> Get(const SecretReference& reference) = 0;
    virtual SecretRecord Set(const SecretReference& reference,
                             std::span<const std::byte> value,
                             std::optional<std::uint64_t> expected_revision) = 0;
    virtual SecretDeleteResult Delete(const SecretReference& reference,
                                      std::optional<std::uint64_t> expected_revision) = 0;
};
```

- [ ] **Step 1: Write failing CTest executables**

```cpp
TEST_CASE(UnauthorizedPeerStopsBeforeBackends) {
    RejectingAuthorizer authorizer;
    CountingCredentialStore secrets;
    CountingCaptureBackend captures;
    ProtocolServer server(authorizer, secrets, captures);
    const auto response = server.Handle(FakePeers::Terminal(), ForgedSecretGet());
    REQUIRE(response.error.code == "HELPER_UNAUTHORIZED");
    REQUIRE(secrets.access_count() == 0);
    REQUIRE(captures.access_count() == 0);
}

TEST_CASE(StalePipeCapabilityCannotBeReused) {
    OneTimePipeCapability capability;
    REQUIRE(capability.Consume("nonce-1"));
    REQUIRE_FALSE(capability.Consume("nonce-1"));
}
```

- [ ] **Step 2: Configure, build, and run to verify RED**

Run on Windows x64:

```powershell
cmake -S native/platform-helper/windows -B build/helper-win -A x64 -DBUILD_TESTING=ON
cmake --build build/helper-win --config Release
ctest --test-dir build/helper-win -C Release --output-on-failure
```

Expected: build or tests fail because the protocol server, caller authorization, Credential Manager backend, and one-time capability are missing.

- [ ] **Step 3: Implement Win32 authorization and Credential Manager CAS**

Validate the named-pipe client PID/session, current user SID, `AfterFX.exe` image, trusted Authenticode chain with Adobe publisher identity, AE file major 25 or 26, non-inheritable capability handle, and one-time nonce. Map references only inside the helper to `ae-mcp/provider/<uuid>/<slot>/v1`; never accept a raw Credential Manager target.

Use `CredWriteW`, `CredReadW`, and `CredDeleteW` with current-user generic credentials. Store the same `{schemaVersion,revision,value}` envelope as macOS, serialize operations, verify writes by readback, and return `SECRET_CONFLICT` for stale CAS.

The launcher reads only a validated relative `runtime/current` pointer, starts the selected portable `python.exe -I -m ae_mcp`, inherits stdin/stdout/stderr, and returns the child exit code.

- [ ] **Step 4: Run Windows unit and Phase 0 checks to verify GREEN**

Run:

```powershell
cmake --build build/helper-win --config Release
ctest --test-dir build/helper-win -C Release --output-on-failure
node scripts/package/build-platform-helper.mjs --platform windows-x64 --out build/helper/windows-x64
node scripts/phase0/assert-helper-rejected.mjs --platform windows-x64 --root build/helper/windows-x64 --method secret.get
node scripts/phase0/collect-phase0-evidence.mjs --platform windows-x64 --helper-root build/helper/windows-x64 --out build/phase0/windows-helper.json
node --test scripts/phase0/test/phase0-evidence.test.mjs
```

Expected: all CTests pass; direct launch prints `HELPER_UNAUTHORIZED backendAccessCount=0`; evidence validates AE 25/26 positive calls, Credential Manager readback across the same publisher identity, wrong parent/signer/user rejection, forged reference rejection, old pipe capability rejection, and no network listener.

- [ ] **Step 5: Enforce the Phase 0 stop gate**

Run on a coordination machine after collecting both evidence files:

```bash
node scripts/phase0/collect-phase0-evidence.mjs --merge build/phase0/macos-helper.json build/phase0/windows-helper.json --out build/phase0/platform-helper.json
node --test scripts/phase0/test/phase0-evidence.test.mjs
```

Expected: PASS only when both platform evidence documents contain successful authorized calls and all adversarial cases failed before secret/capture backend access. If this command fails, stop this plan after committing the reproducible spike and return to design review; do not begin Task 6.

- [ ] **Step 6: Commit**

```bash
git add native/platform-helper/windows packaging/helper-identity-policy.json scripts/package/build-platform-helper.mjs docs/platform/PHASE0.md
git commit -m "feat(helper): add authorized windows credential broker"
```

### Task 6: Add strict secret references and a resumable migration runner

**Files:**
- Create: `plugin/panel/src/cep/platform/secret-reference.js`
- Create: `plugin/panel/src/cep/platform/secret-migration.js`
- Create: `plugin/panel/test/secret-reference.test.js`
- Create: `plugin/panel/test/secret-migration.test.js`

**Interfaces:**
- Consumes: `PlatformHelperClient.secretGet/secretSet/secretDelete` from Task 3.
- Produces: provider-plan integration boundary without modifying `providerStore.js`.

```ts
type SecretReference = `aemcp-secret://provider/${string}/${string}/v1`;

type SecretMigrationPhase =
  | "pending"
  | "secrets-written"
  | "state-committed"
  | "committed";

type SecretMigrationJournal = {
  schemaVersion: 1;
  migrationId: string;
  sourceRevision: string;
  phase: SecretMigrationPhase;
  entries: Array<{ id: string; reference: SecretReference; revision: number }>;
  updatedAt: number;
};

type AtomicJournalStore = {
  read(migrationId: string): Promise<SecretMigrationJournal | null>;
  writeAtomic(journal: SecretMigrationJournal): Promise<void>;
};

type SecretStore = {
  get(reference: SecretReference): Promise<{ value: string; revision: number }>;
  set(input: { reference: SecretReference; value: string; expectedRevision: number | null }): Promise<{ reference: SecretReference; revision: number }>;
  delete(input: { reference: SecretReference; expectedRevision?: number }): Promise<{ deleted: boolean; revision: number | null }>;
};

type SecretMigrationPlan = {
  migrationId: string;
  sourceRevision: string;
  entries: Array<{ id: string; reference: SecretReference; legacyValue: string }>;
  writeRedactedBackup(): Promise<void>;
  commitRedactedState(entries: ReadonlyArray<{ id: string; reference: SecretReference; revision: number }>): Promise<void>;
  cleanupLegacyState(): Promise<void>;
};

type SecretMigrationResult = {
  migrationId: string;
  status: "committed";
  entries: ReadonlyArray<{ id: string; reference: SecretReference; revision: number }>;
};

function createProviderSecretReference(input: {
  providerId: string;
  slot: string;
}): SecretReference;

function parseProviderSecretReference(reference: string): {
  namespace: "provider";
  providerId: string;
  slot: string;
  version: 1;
};

function createSecretMigrationRunner(input: {
  journalStore: AtomicJournalStore;
  secretStore: SecretStore;
  now?: () => number;
}): { run(plan: SecretMigrationPlan): Promise<SecretMigrationResult> };
```

- [ ] **Step 1: Write failing reference and crash-resume tests**

```js
test('reference accepts only lowercase UUID provider namespace and bounded slot', () => {
  assert.equal(
    createProviderSecretReference({
      providerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slot: 'api-key',
    }),
    'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api-key/v1',
  );
  assert.throws(() => createProviderSecretReference({ providerId: '../keychain', slot: 'api' }), { code: 'INVALID_REFERENCE' });
  assert.throws(() => createProviderSecretReference({ providerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slot: 'Bad Slot' }), { code: 'INVALID_REFERENCE' });
});

test('migration resumes every persisted phase without serializing a secret', async () => {
  for (const phase of ['pending', 'secrets-written', 'state-committed', 'committed']) {
    const harness = makeMigrationHarness({ failAfterPhase: phase, secret: 'never-write-this' });
    await assert.rejects(harness.firstRun());
    const resumed = await harness.secondRun();
    assert.equal(resumed.status, 'committed');
    assert.doesNotMatch(harness.allPersistedText(), /never-write-this/);
  }
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test plugin/panel/test/secret-reference.test.js plugin/panel/test/secret-migration.test.js`

Expected: FAIL because both platform secret modules are missing.

- [ ] **Step 3: Implement reference validation and phase transitions**

Use the slot regex `/^[a-z][a-z0-9_-]{0,31}$/` and a lowercase RFC 4122 UUID regex. Journal content is limited to:

```json
{
  "schemaVersion": 1,
  "migrationId": "provider-secrets-v2",
  "sourceRevision": "4f15f251b51f06e4b449afd6558f8d47e7721f48ca578e8cbcc8f641f17703c4",
  "phase": "secrets-written",
  "entries": [
    {
      "id": "provider-id:api-key",
      "reference": "aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api-key/v1",
      "revision": 1
    }
  ],
  "updatedAt": 1783612800000
}
```

Phase order is `pending` → individual helper writes/readbacks → `secrets-written` → redacted backup → atomic redacted state replacement → `state-committed` → idempotent legacy cleanup → `committed`. Persist the `committed` marker only after cleanup succeeds. If a create-only write conflicts after a crash, read the existing protected value and resume only when it exactly equals the in-memory legacy value.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test plugin/panel/test/secret-reference.test.js plugin/panel/test/secret-migration.test.js`

Expected: PASS; every crash phase resumes, stale conflicting values fail closed, delete is idempotent, and persisted text contains no plaintext or secret-derived hash.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/platform/secret-reference.js plugin/panel/src/cep/platform/secret-migration.js plugin/panel/test/secret-reference.test.js plugin/panel/test/secret-migration.test.js
git commit -m "feat(secrets): add references and resumable migration journal"
```

### Task 7: Centralize platform paths, environment completion, and process execution

**Files:**
- Create: `plugin/panel/src/cep/platform/types.js`
- Create: `plugin/panel/src/cep/platform/paths.js`
- Create: `plugin/panel/src/cep/platform/process.js`
- Create: `plugin/panel/src/cep/platform/macos.js`
- Create: `plugin/panel/src/cep/platform/windows.js`
- Create: `plugin/panel/src/cep/platform/index.js`
- Create: `plugin/panel/test/platform-paths.test.js`
- Create: `plugin/panel/test/platform-process.test.js`
- Create: `plugin/panel/test/platform-adapters.test.js`
- Create: `packages/core/ae_mcp/platform_files.py`
- Create: `packages/core/tests/test_platform_files.py`

**Interfaces:**
- Consumes: `SupportMatrixV1` and stable runtime layout.
- Produces: the sole Panel platform capability boundary.

```ts
import type { ChildProcess, SpawnOptions } from "node:child_process";

type PlatformId = "macos-arm64" | "windows-x64";
type ExecutableId = "ae-mcp" | "node" | "claude" | "codex" | "zcode" | "uv" | "npm" | "opencode";
type CompletedEnvironment = Record<string, string>;

type PathCatalog = {
  home: string;
  tempRoot: string;
  configRoot: string;
  toolsRoot: string;
  legacySkillsRoot: string;
  migrationRoot: string;
  logsRoot: string;
  captureSpool: string;
  runtimeRoot: string;
  currentPointer: string;
  previousPointer: string;
  binRoot: string;
  launcher: string;
  join(parts: ReadonlyArray<string>): string;
  dirname(value: string): string;
  basename(value: string): string;
  resolve(parts: ReadonlyArray<string>): string;
};

type PlatformDependencies = {
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  home: string;
  temp: string;
  env: Record<string, string | undefined>;
  fs: typeof import("node:fs");
  spawnImpl: typeof import("node:child_process").spawn;
  now: () => number;
};

type ResolveExecutableOptions = {
  overridePath?: string;
  env?: Record<string, string | undefined>;
  minimumVersion?: string;
  requiredArch?: "arm64" | "x64";
};

type SuccessfulExecutableResolution = {
  ok: true;
  id: ExecutableId;
  path: string;
  argsPrefix: string[];
  source: "override" | "runtime" | "path" | "login-shell" | "standard";
  version: string | null;
  arch: "arm64" | "x64" | null;
};

type ExecutableResolution = SuccessfulExecutableResolution | {
  ok: false;
  id: ExecutableId;
  code: "NOT_FOUND" | "VERSION_TOO_OLD" | "ARCH_MISMATCH" | "PROBE_FAILED";
  attempts: Array<{ path: string; source: SuccessfulExecutableResolution["source"]; detail: string }>;
};

type ProcessRequest = {
  executable: SuccessfulExecutableResolution;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
};

function createPlatformAdapter(deps?: PlatformDependencies): PlatformAdapter;

interface PlatformAdapter {
  readonly id: PlatformId;
  readonly paths: PathCatalog;
  completeSpawnEnv(base?: Record<string, string>, additions?: Record<string, string>): CompletedEnvironment;
  resolveExecutable(id: ExecutableId, options?: ResolveExecutableOptions): Promise<ExecutableResolution>;
  run(request: ProcessRequest): Promise<ProcessResult>;
  spawn(executable: SuccessfulExecutableResolution, args?: string[], options?: SpawnOptions): ChildProcess;
  revealFile(filePath: string): Promise<ProcessResult>;
  openLoginTerminal(tool: "claude" | "codex"): Promise<ProcessResult>;
}
```

The Python filesystem boundary is exact and is the only temporary/atomic persistence API the Tool Library plan may consume:

```text
private_temp_dir(*, prefix: str) -> ContextManager[Path]
atomic_replace_bytes(destination: Path, data: bytes, *, mode: int = 0o600) -> None
atomic_replace_file(source: Path, destination: Path, *, mode: int | None = None) -> None
fsync_parent(directory: Path) -> None
```

- [ ] **Step 1: Write failing POSIX/Windows fixture and process tests**

```js
test('path catalog uses native separators and stable runtime locations', () => {
  const mac = makeMacAdapter({ home: '/Users/a', temp: '/private/tmp' });
  const win = makeWindowsAdapter({ home: 'C:\\Users\\a', temp: 'C:\\Temp' });
  assert.equal(mac.paths.runtimeRoot, '/Users/a/.ae-mcp/runtime');
  assert.equal(mac.paths.toolsRoot, '/Users/a/.ae-mcp/tools');
  assert.equal(mac.paths.legacySkillsRoot, '/Users/a/.ae-mcp/skills');
  assert.equal(mac.paths.launcher, '/Users/a/.ae-mcp/bin/ae-mcp');
  assert.equal(win.paths.runtimeRoot, 'C:\\Users\\a\\.ae-mcp\\runtime');
  assert.equal(win.paths.toolsRoot, 'C:\\Users\\a\\.ae-mcp\\tools');
  assert.equal(win.paths.legacySkillsRoot, 'C:\\Users\\a\\.ae-mcp\\skills');
  assert.equal(win.paths.launcher, 'C:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe');
});

test('resolution order is override then runtime then PATH then login shell then standard', async () => {
  const harness = makeResolutionHarness();
  await harness.adapter.resolveExecutable('codex', { env: { AE_MCP_CODEX_CLI: '/override/codex' } });
  assert.deepEqual(harness.probes, ['/override/codex']);
});
```

Add tests for empty/invalid HOME and PATH, paths with spaces, symlinks, minimum versions, architecture mismatch, nonzero exit, cancellation, timeout, 8192-byte output cap, and login-shell sentinel pollution.

Add Python tests that assert `private_temp_dir(prefix="tool-import-")` is removed after normal return and exceptions, rejects separators and prefixes longer than 48 bytes, has mode `0700` on macOS, and has a protected DACL granting full control only to the current user SID on Windows. Add fault-injection tests proving both atomic replace functions create their temporary file beside the destination, fsync file contents before replacement, preserve the old destination on write/fsync failure, use write-through replacement, and fsync the parent directory where the OS supports directory handles.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test plugin/panel/test/platform-paths.test.js plugin/panel/test/platform-process.test.js plugin/panel/test/platform-adapters.test.js
uv run pytest packages/core/tests/test_platform_files.py -q
```

Expected: Node tests FAIL because the adapter modules do not exist, and pytest fails to import `ae_mcp.platform_files`.

- [ ] **Step 3: Implement the adapters and bounded resolver**

The only platform selection code in Panel is:

```js
export function createPlatformAdapter(deps = defaultDependencies()) {
  if (deps.platform === 'darwin' && deps.arch === 'arm64') return createMacosAdapter(deps);
  if (deps.platform === 'win32' && deps.arch === 'x64') return createWindowsAdapter(deps);
  throw new PlatformCapabilityError('UNSUPPORTED_PLATFORM', deps.platform + '-' + deps.arch + ' is not supported');
}
```

Resolution order is explicit override → bundled runtime/known app path → inherited PATH → macOS login-shell probe → standard install directories. Login-shell probing is macOS-only, uses a fixed executable name rather than user input, has a 2500 ms timeout and 8192-byte combined-output limit, and accepts exactly one sentinel result line. Spawn uses `shell:false`; Windows `.cmd` shims are represented as `{file:'cmd.exe',argsPrefix:['/d','/s','/c']}` rather than enabling a general shell.

`private_temp_dir` creates its directory with private permissions from the first observable handle: `tempfile.mkdtemp` creates mode `0700` atomically on macOS and the Windows branch calls `CreateDirectoryW` with a protected DACL containing exactly one access-allowed ACE for the process token user's SID with `FILE_ALL_ACCESS` and no inherited ACEs. It verifies the resulting mode or DACL before yielding and removes the tree without following reparse points or symlinks. `atomic_replace_bytes` and `atomic_replace_file` always create an exclusive sibling temporary file, flush and fsync its bytes, apply the requested mode, replace with `os.replace` on macOS or `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` on Windows, and fsync the parent directory on macOS. `atomic_replace_file` copies into that sibling even when its source is on another volume; no caller may rename directly from the system temporary root.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node --test plugin/panel/test/platform-paths.test.js plugin/panel/test/platform-process.test.js plugin/panel/test/platform-adapters.test.js
uv run pytest packages/core/tests/test_platform_files.py -q
```

Expected: Node tests PASS with both fixture families and every timeout/cancel/pollution case passing; Python tests PASS with private permissions, cleanup, same-filesystem replacement, fsync, and failure atomicity proven on the current OS.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/platform/types.js plugin/panel/src/cep/platform/paths.js plugin/panel/src/cep/platform/process.js plugin/panel/src/cep/platform/macos.js plugin/panel/src/cep/platform/windows.js plugin/panel/src/cep/platform/index.js plugin/panel/test/platform-paths.test.js plugin/panel/test/platform-process.test.js plugin/panel/test/platform-adapters.test.js packages/core/ae_mcp/platform_files.py packages/core/tests/test_platform_files.py
git commit -m "feat(platform): centralize paths processes and private files"
```

### Task 8: Route MCP, Claude, and Codex through the platform adapter

**Files:**
- Modify: `plugin/panel/src/cep/mcpClient.js:8-95,159-240`
- Modify: `plugin/panel/src/cep/claudeAgentBackend.js:4-59,75-90,193-245`
- Modify: `plugin/panel/src/cep/claudeAuth.js:4-43,45-116`
- Modify: `plugin/panel/src/cep/codexBackend.js:14-57,200-230,232-253,455-483,672-681`
- Modify: `plugin/panel/src/cep/hostBridge.js:5-13,63-91`
- Modify: `plugin/panel/test/mcpClient.test.js`
- Modify: `plugin/panel/test/claudeAgentBackend.test.js`
- Modify: `plugin/panel/test/claudeAuth.test.js`
- Modify: `plugin/panel/test/codexBackend.test.js`
- Modify: `plugin/panel/test/hostBridge.test.js`

**Interfaces:**
- Consumes: `PlatformAdapter` from Task 7.
- Produces: unchanged backend public behavior with injected `platform` for tests.

```ts
function resolveMcpCommand(input?: {
  explicitPath?: string;
  platform?: PlatformAdapter;
  extRoot?: string;
  repoRoot?: string;
}): Promise<{ command: string; args: string[]; source: string }>;

type BackendMessage = Record<string, unknown>;

type ClaudeAgentBackend = {
  sendUser(text: string): Promise<unknown>;
  approve(toolUseId: string, decision: string): void;
  stop(): void;
  reset(): void;
  getMessages(): BackendMessage[];
  getStderrTail(): string;
};

type CodexBackend = {
  sendUser(text: string): Promise<unknown>;
  approve(toolUseId: string, decision: string): void;
  stop(): void;
  reset(): void;
  getMessages(): BackendMessage[];
  probeAccount(): Promise<Record<string, unknown>>;
};

function createClaudeAgentBackend(input: {
  platform?: PlatformAdapter;
  sidecarPath: string;
  getMcpSpec: () => Record<string, unknown>;
  getToolMeta: () => Record<string, unknown>;
  getModel: () => string;
  getPermissionMode: () => string;
  getEffort: () => string;
  getThinking: () => boolean;
  getChannel?: () => string;
  getApiProvider?: () => Record<string, unknown> | null;
  onEvent?: (event: Record<string, unknown>) => void;
  lang?: "zh" | "en";
  env?: Record<string, string>;
}): ClaudeAgentBackend;

function createCodexBackend(input: {
  platform?: PlatformAdapter;
  getModel: () => string;
  getEffort: () => string;
  getFast: () => boolean;
  getPermissionMode: () => string;
  getMcpSpec: () => Record<string, unknown>;
  getToolMeta: () => Record<string, unknown>;
  getExpertGuidance?: () => boolean;
  getServerInstructions?: () => string;
  getProviderProfile?: () => Record<string, unknown>;
  getCliConfigProvider?: () => Record<string, unknown> | null;
  onEvent?: (event: Record<string, unknown>) => void;
  lang?: "zh" | "en";
  env?: Record<string, string>;
}): CodexBackend;
```

- [ ] **Step 1: Replace Windows-only expectations with failing adapter expectations**

```js
test('resolveMcpCommand prefers the installed stable launcher on both platforms', async () => {
  const mac = fakePlatform({ launcher: '/Users/a/.ae-mcp/bin/ae-mcp' });
  const win = fakePlatform({ launcher: 'C:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe' });
  assert.deepEqual(await resolveMcpCommand({ platform: mac }), {
    command: '/Users/a/.ae-mcp/bin/ae-mcp', args: [], source: 'runtime',
  });
  assert.deepEqual(await resolveMcpCommand({ platform: win }), {
    command: 'C:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe', args: [], source: 'runtime',
  });
});

test('codex spawn uses a resolved absolute command and no general shell', async () => {
  const platform = fakePlatform({ executable: '/Users/a/.local/bin/codex' });
  const backend = makeCodexBackend({ platform });
  await backend.probeAccount();
  assert.equal(platform.spawnCalls[0].executable.path, '/Users/a/.local/bin/codex');
  assert.equal(platform.spawnCalls[0].options.shell, undefined);
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test plugin/panel/test/mcpClient.test.js plugin/panel/test/claudeAgentBackend.test.js plugin/panel/test/claudeAuth.test.js plugin/panel/test/codexBackend.test.js plugin/panel/test/hostBridge.test.js
```

Expected: FAIL because existing functions ignore `platform`, call Windows `where`, normalize paths to backslashes, and spawn Codex with `shell:true`.

- [ ] **Step 3: Replace local discovery/path/spawn implementations**

Remove `normalizeFsPath`, manual `dirname`, manual `joinPath`, `defaultWhereImpl`, fixed `C:\Program Files` candidates, and direct `child_process` discovery from these files. Use `platform.paths`, `platform.resolveExecutable`, `platform.completeSpawnEnv`, and `platform.spawn`.

`resolveSidecarPath` uses `platform.paths.join([extRoot, 'sidecar', 'agent-sidecar.mjs'])` with the repository fallback expressed through the same catalog. Claude always uses the bundled Node resolution when runtime is installed. Codex `cwd` is the native parent of the extension root, or platform temp root when unavailable.

`createHostController.start` must pass normalized extension/runtime roots into `plugin/host/server.js`; it does not open the native helper itself.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the command from Step 2.

Expected: PASS; no test invokes `where`, no path is forced to Windows separators on macOS, and Codex/Claude launches are absolute and shell-free.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/mcpClient.js plugin/panel/src/cep/claudeAgentBackend.js plugin/panel/src/cep/claudeAuth.js plugin/panel/src/cep/codexBackend.js plugin/panel/src/cep/hostBridge.js plugin/panel/test/mcpClient.test.js plugin/panel/test/claudeAgentBackend.test.js plugin/panel/test/claudeAuth.test.js plugin/panel/test/codexBackend.test.js plugin/panel/test/hostBridge.test.js
git commit -m "refactor(panel): use platform adapter for mcp claude and codex"
```

### Task 9: Remove remaining platform leaks and unsupported ZCode credential scraping

**Files:**
- Create: `scripts/package/test/no-platform-leaks.test.mjs`
- Modify: `plugin/panel/src/cep/zcodeBackend.js:50-111,369-511,730-736,1118-1179`
- Modify: `plugin/panel/src/cep/codexConfig.js:78-110`
- Modify: `plugin/panel/src/cep/claudeSettingsImport.js:13-28`
- Modify: `plugin/panel/src/cep/ccSwitch.js:14-23,48-62`
- Modify: `plugin/panel/src/cep/openCodeBackend.js:250-340`
- Modify: `plugin/panel/src/cep/logExportFs.js:1-27`
- Modify: `plugin/panel/src/cep/diagnostics.js:1-40,69-157`
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx:227-246`
- Modify: `plugin/panel/test/zcodeBackend.test.js`
- Modify: `plugin/panel/test/codexConfig.test.js`
- Modify: `plugin/panel/test/claudeSettingsImport.test.js`
- Modify: `plugin/panel/test/ccSwitch.test.js`
- Modify: `plugin/panel/test/openCodeBackend.test.js`
- Modify: `plugin/panel/test/logExport.test.js`
- Modify: `plugin/panel/test/diagnostics.test.js`

**Interfaces:**
- Consumes: `PlatformAdapter` and `PathCatalog`.
- Produces: repository enforcement that business modules contain no platform branching/system commands.

```ts
function readCodexCliConfig(input?: { platform?: PlatformAdapter; fsImpl?: FsLike }): CodexCliConfig | null;
function readClaudeSettingsEnv(input?: { platform?: PlatformAdapter; fsImpl?: FsLike }): ClaudeSettingsEnv | null;
function detectCcSwitch(input?: { platform?: PlatformAdapter; fsImpl?: FsLike }): CcSwitchDetection | null;
function writeLogExport(input: { text: string; fileName: string; platform?: PlatformAdapter; fsImpl?: FsLike }): string;
function revealLogExport(filePath: string, platform?: PlatformAdapter): Promise<ProcessResult>;
```

- [ ] **Step 1: Write the failing repository boundary test**

```js
test('business modules do not branch on platform or invoke system discovery commands', () => {
  const forbidden = [
    /process\.platform/,
    /execFile\(['"]where['"]/,
    /['"]powershell['"]/i,
    /explorer\.exe/i,
    /LOCALAPPDATA/,
    /USERPROFILE/,
  ];
  for (const file of panelBusinessFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, file + ' leaks platform logic');
  }
});
```

`panelBusinessFiles()` scans `plugin/panel/src/cep` and excludes only `plugin/panel/src/cep/platform/`.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test scripts/package/test/no-platform-leaks.test.mjs plugin/panel/test/zcodeBackend.test.js plugin/panel/test/codexConfig.test.js plugin/panel/test/claudeSettingsImport.test.js plugin/panel/test/ccSwitch.test.js plugin/panel/test/openCodeBackend.test.js plugin/panel/test/logExport.test.js plugin/panel/test/diagnostics.test.js
```

Expected: FAIL and list existing `where`, `USERPROFILE`, `LOCALAPPDATA`, PowerShell, Explorer, and manual backslash call sites.

- [ ] **Step 3: Route every remaining operation through the adapter**

ZCode config paths, CLI resolution, and workspace paths use `PathCatalog`. Remove `decryptZcodeCredentialValue`, `readZcodeOAuthAccessToken`, `resolveZcodeCodingPlanApiKey`, their dependency injection parameters, and the runtime branch that exchanges a desktop OAuth token for a provider API key. This behavior is explicitly outside scope and has no audited stable interface.

OpenCode uses `platform.paths.tempRoot` and a resolved executable. Log reveal calls `platform.revealFile`. Diagnostics reports bundled runtime/helper state and optional CLI results with structured fix actions; it no longer recommends winget, PowerShell, npm, or uv for core operation. Settings reads the auth-token path through `PathCatalog`.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the command from Step 2.

Expected: PASS; the repository boundary test reports zero platform leaks outside the platform directory, and ZCode tests prove no OAuth credential file is read or decrypted.

- [ ] **Step 5: Commit**

```bash
git add scripts/package/test/no-platform-leaks.test.mjs plugin/panel/src/cep/zcodeBackend.js plugin/panel/src/cep/codexConfig.js plugin/panel/src/cep/claudeSettingsImport.js plugin/panel/src/cep/ccSwitch.js plugin/panel/src/cep/openCodeBackend.js plugin/panel/src/cep/logExportFs.js plugin/panel/src/cep/diagnostics.js plugin/panel/src/screens/SettingsScreen.jsx plugin/panel/test/zcodeBackend.test.js plugin/panel/test/codexConfig.test.js plugin/panel/test/claudeSettingsImport.test.js plugin/panel/test/ccSwitch.test.js plugin/panel/test/openCodeBackend.test.js plugin/panel/test/logExport.test.js plugin/panel/test/diagnostics.test.js
git commit -m "refactor(panel): remove platform leaks from integrations"
```

### Task 10: Install, verify, switch, roll back, and uninstall offline runtimes

**Files:**
- Create: `plugin/panel/src/cep/platform/runtime-manager.js`
- Create: `plugin/panel/test/runtime-manager.test.js`
- Create: `packaging/launchers/macos-arm64/ae-mcp`
- Modify: `native/platform-helper/windows/src/ae_mcp_launcher.cpp`

**Interfaces:**
- Consumes: runtime payload from Task 2 and `PathCatalog` from Task 7.
- Produces: `RuntimeManager`, stable launcher, atomic current/previous pointers.

```ts
type RuntimeStatus = {
  state: "missing" | "installing" | "ready" | "invalid" | "rollback-available";
  version: string | null;
  platform: "macos-arm64" | "windows-x64";
  activePath: string | null;
  previousPath: string | null;
  launcherPath: string;
  diagnostics: Array<{ code: string; detail: string }>;
};

type RuntimeManager = {
  inspect(): Promise<RuntimeStatus>;
  install(): Promise<{ status: "installed" | "already-current"; activePath: string; launcherPath: string; previousPath: string | null }>;
  rollback(): Promise<RuntimeStatus>;
  pruneUnused(): Promise<{ removed: string[] }>;
  uninstall(): Promise<{ removedLaunchers: string[]; removedRuntimes: string[]; retainedConfigRoot: string }>;
};

function createRuntimeManager(input: {
  platform: PlatformAdapter;
  fs: typeof import("node:fs");
  crypto: typeof import("node:crypto");
  extensionRoot: string;
  version: string;
}): RuntimeManager;
```

- [ ] **Step 1: Write failing install/upgrade/rollback tests**

```js
test('failed smoke never changes current pointer', async () => {
  const h = makeRuntimeHarness({ current: '0.9.0/macos-arm64', smokeOk: false });
  await assert.rejects(h.manager.install(), { code: 'RUNTIME_SMOKE_FAILED' });
  assert.equal(h.readPointer('current'), '0.9.0/macos-arm64');
  assert.equal(h.exists('0.9.1/macos-arm64'), false);
});

test('successful upgrade switches atomically and preserves rollback pointer', async () => {
  const h = makeRuntimeHarness({ current: '0.9.0/windows-x64', smokeOk: true });
  await h.manager.install();
  assert.equal(h.readPointer('current'), '0.9.1/windows-x64');
  assert.equal(h.readPointer('previous'), '0.9.0/windows-x64');
  await h.manager.rollback();
  assert.equal(h.readPointer('current'), '0.9.0/windows-x64');
});
```

Add tests for fresh install, already-current, malformed manifest, hash mismatch, wrong native architecture, missing executable mode, stale staging cleanup, pointer path traversal, prune, and uninstall retaining settings and Tool Library directories.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test plugin/panel/test/runtime-manager.test.js`

Expected: FAIL because `runtime-manager.js` does not exist.

- [ ] **Step 3: Implement copy-verify-smoke-switch semantics**

Source is `extensionRoot/runtime/<platform-id>`. Destination is `~/.ae-mcp/runtime/<version>/<platform-id>`. Copy into a sibling staging directory, preserve manifest modes, reject links escaping the payload, verify every hash and native architecture, run portable Python imports and portable Node module imports, rename staging to the version directory, then atomically replace `previous` and `current` text pointers.

The macOS launcher is:

```sh
#!/bin/sh
set -eu
base="${AE_MCP_HOME:-$HOME/.ae-mcp}"
relative="$(/bin/cat "$base/runtime/current")"
case "$relative" in
  ""|/*|*..*) exit 78 ;;
esac
exec "$base/runtime/$relative/python/bin/python3" -I -m ae_mcp "$@"
```

Windows launcher applies the same relative-path validation in native C++ and uses `CreateProcessW` with inherited standard handles. Uninstall removes launchers and pointer files, then removes runtimes no longer referenced; it never deletes settings, migrations, providers, logs, or Tool Library data.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test plugin/panel/test/runtime-manager.test.js`

Expected: PASS; smoke failure leaves `current` byte-for-byte unchanged, upgrade sets `previous`, rollback restores it, and uninstall retains the config root.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/platform/runtime-manager.js plugin/panel/test/runtime-manager.test.js packaging/launchers/macos-arm64/ae-mcp native/platform-helper/windows/src/ae_mcp_launcher.cpp
git commit -m "feat(runtime): install and switch offline platform runtimes"
```

### Task 11: Bootstrap runtime/helper in Wizard and Settings without online installers

**Files:**
- Modify: `plugin/panel/src/cep/wizardActions.js:1-123`
- Modify: `plugin/panel/src/cep/externalClients.js:76-114`
- Modify: `plugin/panel/src/app/wizardWiring.js:1-151`
- Modify: `plugin/panel/src/app/App.jsx:168-236,344-430,701-716,781-816,880-940`
- Modify: `plugin/panel/src/lib/wizardSteps.js:1-54`
- Modify: `plugin/panel/src/screens/WizardScreen.jsx:12-57,100-133,195-254`
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx`
- Modify: `plugin/panel/test/wizardActions.test.js`
- Modify: `plugin/panel/test/wizardSteps.test.js`
- Modify: `plugin/panel/test/externalClients.test.js`
- Modify: `plugin/panel/test/hostBridge.test.js`
- Modify: `scripts/install-plugin-dev-macos.sh`
- Modify: `scripts/install-plugin-dev.ps1`
- Modify: `plugin/client/dist/app.js`

**Interfaces:**
- Consumes: `RuntimeManager`, `PlatformAdapter`, and helper transport.
- Produces: first-launch bootstrap, stable external MCP config, Settings rollback/uninstall actions.

```ts
const LOCAL_STEPS = ["runtime", "helper"] as const;

function mcpConfigFor(
  client: ExternalClient,
  port: number,
  expertGuidance: boolean,
  options: { launcherPath: string },
): object;

function useWizardWiring(input: {
  runtimeManager: RuntimeManager;
  platform: PlatformAdapter;
  helperCapabilities: PlatformCapabilities | null;
  lang: "zh" | "en";
}): WizardWiring;
```

- [ ] **Step 1: Update tests to require offline bootstrap**

```js
test('wizard core steps are bundled runtime and signed helper only', () => {
  assert.deepEqual(LOCAL_STEPS, ['runtime', 'helper']);
  assert.equal(SUBSCRIPTION_STEPS.includes('node'), false);
  assert.equal(SUBSCRIPTION_STEPS.includes('uv'), false);
});

test('external MCP config uses the stable absolute launcher', () => {
  const config = mcpConfigFor(EXTERNAL_CLIENTS[0], 11488, true, {
    launcherPath: '/Users/a/.ae-mcp/bin/ae-mcp',
  });
  assert.equal(config.mcpServers.ae.command, '/Users/a/.ae-mcp/bin/ae-mcp');
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test plugin/panel/test/wizardActions.test.js plugin/panel/test/wizardSteps.test.js plugin/panel/test/externalClients.test.js plugin/panel/test/hostBridge.test.js
```

Expected: FAIL because current Wizard requires uv, system Node, winget, PowerShell, npm, and `command: "ae-mcp"`.

- [ ] **Step 3: Wire first-launch runtime and helper lifecycle**

On mount, inspect/install the bundled runtime before creating backend processes. Start the HTTP host even when runtime/helper installation fails so diagnostics and unrelated AE functions remain available; report the failed capability structurally. The host receives the verified helper root and opens the helper transport. Wizard retry invokes only local runtime copy/verification or helper registration, never a network installer.

Settings shows active/previous runtime, resolved launcher, helper version/capabilities, Roll Back, and Uninstall. Uninstall requires the existing confirmation dialog and calls `RuntimeManager.uninstall()`; it does not delete user configuration or tools.

The macOS developer script must be executable and run panel build, host/sidecar dependency verification, platform helper build, and runtime verification before atomically replacing the dev CEP extension. The Windows script performs the same checks with native Windows commands. Both support `AE_MCP_DEV_SKIP_DEP_INSTALL=1` for deterministic script tests but production packaging never sets it.

- [ ] **Step 4: Run focused tests and rebuild Panel to verify GREEN**

Run the command from Step 2.

Expected: PASS; no Wizard test contains winget, PowerShell, online uv install, system Node install, or relative launcher command.

Run:

```bash
bash -n scripts/install-plugin-dev-macos.sh
npm --prefix plugin/panel run build
```

Expected: shell syntax exits 0; esbuild updates `plugin/client/dist/app.js` without errors.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/wizardActions.js plugin/panel/src/cep/externalClients.js plugin/panel/src/app/wizardWiring.js plugin/panel/src/app/App.jsx plugin/panel/src/lib/wizardSteps.js plugin/panel/src/screens/WizardScreen.jsx plugin/panel/src/screens/SettingsScreen.jsx plugin/panel/test/wizardActions.test.js plugin/panel/test/wizardSteps.test.js plugin/panel/test/externalClients.test.js plugin/panel/test/hostBridge.test.js scripts/install-plugin-dev-macos.sh scripts/install-plugin-dev.ps1 plugin/client/dist/app.js
git update-index --chmod=+x scripts/install-plugin-dev-macos.sh
git commit -m "feat(panel): bootstrap bundled runtime in setup and settings"
```

### Task 12: Implement authenticated After Effects window capture on both helpers

**Files:**
- Modify: `native/platform-helper/macos/Sources/PlatformHelperService/ScreenCaptureBackend.swift`
- Modify: `native/platform-helper/macos/Sources/PlatformHelperService/ProtocolDispatcher.swift`
- Modify: `native/platform-helper/macos/Tests/PlatformHelperTests/ScreenCaptureBackendTests.swift`
- Modify: `native/platform-helper/macos/Tests/PlatformHelperTests/ProtocolDispatcherTests.swift`
- Modify: `native/platform-helper/windows/src/window_capture.cpp`
- Modify: `native/platform-helper/windows/src/protocol.cpp`
- Modify: `native/platform-helper/windows/tests/window_capture_test.cpp`
- Modify: `native/platform-helper/windows/tests/protocol_test.cpp`
- Modify: `packaging/helper-identity-policy.json`

**Interfaces:**
- Consumes: authorized caller, helper protocol, and fixed capture spool path.
- Produces: `window.find`, `window.describe`, and `window.capture` for Adobe-signed AE windows only.

```ts
type WindowDescription = {
  reference: string;
  application: "after-effects";
  ownerBundleId: "com.adobe.AfterEffects.application";
  ownerTeamId: "JQ525L2MZD";
  processId: number;
  title: string;
  frame: { x: number; y: number; width: number; height: number };
  scale: number;
  capturable: boolean;
};

type CaptureResult = {
  captureId: string;
  reference: string;
  spoolPath: string;
  width: number;
  height: number;
  scale: number;
  method: "ScreenCaptureKit" | "WindowsGraphicsCapture";
  sha256: string;
};
```

- [ ] **Step 1: Write failing capture policy tests**

```swift
func testPermissionDeniedReturnsRequiredCodeWithoutDesktopFallback() async throws {
    let backend = ScreenCaptureBackend(
        permission: FakePermission(preflight: false, request: false),
        windows: FakeWindows.afterEffectsOnRetinaDisplay,
        screenshot: FailingIfInvokedScreenshotManager()
    )
    await XCTAssertThrowsErrorAsync(try await backend.capture(target: .afterEffectsMain, captureId: "capture-1")) { error in
        XCTAssertEqual((error as? PlatformHelperError)?.code, "SCREEN_RECORDING_PERMISSION_REQUIRED")
    }
}
```

```cpp
TEST_CASE(MinimizedAfterEffectsWindowIsNotCapturable) {
    FakeWindowCatalog windows = FakeWindowCatalog::MinimizedAfterEffects();
    WindowsCaptureBackend backend(windows, FakeGraphicsCapture());
    REQUIRE_THROWS_CODE(backend.Capture(MainAfterEffectsTarget(), "capture-1"), "AE_WINDOW_NOT_CAPTURABLE");
}
```

Add macOS tests for first denial, later authorization, Retina scale, negative/positive multi-display coordinates, occluded window capture, minimized window, other Space, disappearing window, and no AE window. Add Windows tests for Adobe signer filtering, largest valid AE window, occlusion, minimized window, disappearing HWND, and no desktop fallback.

- [ ] **Step 2: Run native tests to verify RED**

Run on macOS:

`swift test --package-path native/platform-helper/macos`

Run on Windows:

`ctest --test-dir build/helper-win -C Release --output-on-failure`

Expected: capture tests fail because production ScreenCaptureKit and Windows Graphics Capture backends are not implemented.

- [ ] **Step 3: Implement platform capture backends**

macOS uses Quartz only to enumerate windows, inspect owning process metadata, and convert coordinates. It uses `SCShareableContent`, an `SCContentFilter` limited to the selected Adobe-signed AE window, and `SCScreenshotManager` for pixels. It checks `CGPreflightScreenCaptureAccess`; denial returns `SCREEN_RECORDING_PERMISSION_REQUIRED`. Missing target returns `AE_WINDOW_NOT_FOUND`. Minimized, other-Space, or vanished target returns `AE_WINDOW_NOT_CAPTURABLE`. No Quartz image API or full-display capture branch exists.

Windows enumerates top-level HWNDs, verifies `AfterFX.exe`, Adobe Authenticode publisher, current session user, and AE major 25/26. It captures the selected window through Windows Graphics Capture and Direct3D11, including occluded content. It rejects minimized/invalid windows and never calls a desktop capture API.

Input `method` accepts only `auto`, `DesktopCopy`, or `PrintWindow` for backward compatibility. All three select the one native helper backend for the current platform; `DesktopCopy` and `PrintWindow` are compatibility labels, not permission to invoke the retired desktop-copy or Win32 PrintWindow implementations.

Both implementations write PNG only beneath `~/.ae-mcp/captures/spool/<captureId>.png`, create with current-user-only permissions, return metadata, and rely on the host to delete the spool file after transfer.

- [ ] **Step 4: Run native and hardware tests to verify GREEN**

Run both commands from Step 2.

Expected: all native tests pass.

Run the AE 25/26 Phase 0 collectors again on both platforms and validate:

`node --test scripts/phase0/test/phase0-evidence.test.mjs`

Expected: PASS with permission denial/recovery, Retina, multi-display, occlusion, minimized/not-current-Space, missing-window, and no-desktop-fallback evidence.

- [ ] **Step 5: Commit**

```bash
git add native/platform-helper/macos/Sources/PlatformHelperService/ScreenCaptureBackend.swift native/platform-helper/macos/Sources/PlatformHelperService/ProtocolDispatcher.swift native/platform-helper/macos/Tests/PlatformHelperTests/ScreenCaptureBackendTests.swift native/platform-helper/macos/Tests/PlatformHelperTests/ProtocolDispatcherTests.swift native/platform-helper/windows/src/window_capture.cpp native/platform-helper/windows/src/protocol.cpp native/platform-helper/windows/tests/window_capture_test.cpp native/platform-helper/windows/tests/protocol_test.cpp packaging/helper-identity-policy.json
git commit -m "feat(helper): capture authenticated after effects windows"
```

### Task 13: Proxy snapshot bytes through the authenticated host and replace snapshot-mss

**Files:**
- Create: `packages/snapshot-host/pyproject.toml`
- Create: `packages/snapshot-host/README.md`
- Create: `packages/snapshot-host/ae_mcp_snapshot_host/__init__.py`
- Create: `packages/snapshot-host/tests/__init__.py`
- Create: `packages/snapshot-host/tests/test_host_snapshot.py`
- Modify: `plugin/host/server.js:1-21,55-77,177-289,304-324`
- Modify: `plugin/host/server.test.js`
- Modify: `packages/bridge/ae_mcp_bridge/__init__.py:13-123`
- Modify: `packages/bridge/tests/test_http_bridge.py`
- Modify: `packages/core/ae_mcp/snapshot/base.py:9-24`
- Modify: `packages/core/ae_mcp/handlers/core.py:488-513,712-732`
- Modify: `packages/core/tests/test_handlers_core.py`
- Modify: `packages/core/tests/live/test_smoke.py`
- Modify: `pyproject.toml:1-24`
- Modify: `uv.lock`
- Delete: `packages/snapshot-mss/pyproject.toml`
- Delete: `packages/snapshot-mss/README.md`
- Delete: `packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`
- Delete: `packages/snapshot-mss/ae_mcp_snapshot_mss/_hwnd_rect.py`
- Delete: `packages/snapshot-mss/tests/__init__.py`
- Delete: `packages/snapshot-mss/tests/test_mss_snapshot.py`

**Interfaces:**
- Consumes: host helper client and capture backend from Tasks 3 and 12.
- Produces: authenticated `/capture` binary route and `HostBridgeSnapshotter` entry point.

```py
from typing import Literal, TypeAlias, TypedDict

class CaptureSuccess(TypedDict):
    ok: Literal[True]
    path: str
    bytes: int
    width: int
    height: int
    scale: float
    windowRef: str
    hwnd: str | None
    method: Literal["ScreenCaptureKit", "WindowsGraphicsCapture"]
    sha256: str

class CaptureFailure(TypedDict):
    ok: Literal[False]
    errorCode: str
    message: str

CaptureWindowResult: TypeAlias = CaptureSuccess | CaptureFailure
CaptureMethod: TypeAlias = Literal["auto", "DesktopCopy", "PrintWindow"]
```

```text
HttpBridge.capture_window(
    out_path: Path | None,
    *,
    window_ref: str | None = None,
    main_window: bool = False,
    method: CaptureMethod = "auto",
    timeout_sec: float = 30.0,
) -> Awaitable[CaptureWindowResult]

HostBridgeSnapshotter.name: Literal["host"]
HostBridgeSnapshotter.__init__(bridge: HttpBridge | None = None) -> None
HostBridgeSnapshotter.supports_platform() -> bool
HostBridgeSnapshotter.capture(
    out_path: Path | None,
    *,
    hwnd: str | None = None,
    main_window: bool = False,
    method: CaptureMethod = "auto",
) -> Awaitable[CaptureWindowResult]
```

The HTTP contract is fixed:

```text
POST /capture
Request headers: X-AE-MCP-Token, x-ae-mcp-client, x-ae-mcp-python
JSON body: {"windowRef": string | null, "mainWindow": boolean, "method": "auto" | "DesktopCopy" | "PrintWindow"}
200 content type: image/png
200 headers: x-ae-mcp-capture-width, x-ae-mcp-capture-height, x-ae-mcp-capture-scale, x-ae-mcp-capture-method, x-ae-mcp-window-ref, x-ae-mcp-capture-sha256
Error body: {"ok": false, "code": string, "message": string}
```

Status mapping is `400` for invalid input, `401` for a bad token, `403` for a blocked client, `503` for the panel kill switch, `428` for `SCREEN_RECORDING_PERMISSION_REQUIRED`, `404` for `AE_WINDOW_NOT_FOUND`, `409` for `AE_WINDOW_NOT_CAPTURABLE`, and `502` for other helper/capture failures.

- [ ] **Step 1: Write failing host, bridge, and snapshot tests**

```js
test('capture rejects a bad token before helper access', async () => {
  const helper = fakePlatformHelper();
  const app = server.buildApp({ platformHelper: helper });
  const response = await request(app).post('/capture').set('X-AE-MCP-Token', 'wrong').send({ mainWindow: true });
  assert.equal(response.status, 401);
  assert.equal(helper.captureCalls, 0);
});

test('host exposes no secret HTTP route', async () => {
  const app = server.buildApp({ platformHelper: fakePlatformHelper() });
  for (const route of ['/secret', '/secret/get', '/platform/secret.get']) {
    const response = await request(app).post(route).send({});
    assert.equal(response.status, 404);
  }
});
```

```py
@pytest.mark.asyncio
async def test_host_snapshot_writes_png_from_authenticated_capture(tmp_path):
    bridge = AsyncMock()
    bridge.capture_window.return_value = {
        "ok": True, "path": str(tmp_path / "ae.png"), "width": 200,
        "height": 100, "method": "ScreenCaptureKit",
    }
    snapshotter = HostBridgeSnapshotter(bridge=bridge)
    result = await snapshotter.capture(tmp_path / "ae.png", main_window=True)
    assert result["ok"] is True
    bridge.capture_window.assert_awaited_once()
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test plugin/host/server.test.js
uv run pytest packages/bridge/tests/test_http_bridge.py packages/snapshot-host/tests/test_host_snapshot.py packages/core/tests/test_handlers_core.py -q
```

Expected: `/capture` returns 404 and Python fails to import `ae_mcp_snapshot_host`.

- [ ] **Step 3: Implement the capture route and host snapshot package**

Factor the existing auth-token/client-block/pause checks so `/exec` and `/capture` use the same gate. `/capture` accepts only `windowRef`, `mainWindow`, and `method`; the host creates a cryptographically random `captureId`, calls `platformHelper.windowCapture`, verifies the returned `spoolPath` real path is inside the capture spool, verifies its SHA-256 against helper metadata, sends `image/png` bytes with the fixed headers above, and deletes the spool file on response completion or abort.

`HttpBridge.capture_window` sends the existing auth token and client headers, validates the PNG signature and SHA-256 response header, then writes through `ae_mcp.platform_files.atomic_replace_bytes` so the replacement is same-filesystem and durable. It maps helper error codes into the returned result without hiding `SCREEN_RECORDING_PERMISSION_REQUIRED`, `AE_WINDOW_NOT_FOUND`, or `AE_WINDOW_NOT_CAPTURABLE`.

`HostBridgeSnapshotter` passes legacy `hwnd` as the opaque helper `windowRef`; it never imports, starts, or discovers the native helper. Update the root workspace and pytest paths from `snapshot-mss` to `snapshot-host`, then regenerate `uv.lock`.

- [ ] **Step 4: Run tests and lock verification to verify GREEN**

Run:

```bash
node --test plugin/host/server.test.js
uv lock
uv run pytest packages/bridge/tests/test_http_bridge.py packages/snapshot-host/tests/test_host_snapshot.py packages/core/tests/test_handlers_core.py -q
```

Expected: host tests pass with bad-token helper access count zero and all secret routes 404; Python tests pass; `uv.lock` contains `ae-mcp-snapshot-host` and no `ae-mcp-snapshot-mss` or `mss` runtime dependency.

- [ ] **Step 5: Commit**

```bash
git add plugin/host/server.js plugin/host/server.test.js packages/bridge/ae_mcp_bridge/__init__.py packages/bridge/tests/test_http_bridge.py packages/core/ae_mcp/snapshot/base.py packages/core/ae_mcp/handlers/core.py packages/core/tests/test_handlers_core.py packages/core/tests/live/test_smoke.py packages/snapshot-host pyproject.toml uv.lock
git add -u packages/snapshot-mss
git commit -m "feat(snapshot): proxy capture through authenticated host"
```

### Task 14: Stage and verify exact platform bundles

**Files:**
- Create: `packaging/schemas/bundle-manifest.schema.json`
- Create: `scripts/package/lib/binary-arch.mjs`
- Create: `scripts/package/lib/manifest.mjs`
- Create: `scripts/package/stage-platform-bundle.mjs`
- Create: `scripts/package/verify-platform-bundle.mjs`
- Create: `scripts/package/test/stage-platform-bundle.test.mjs`
- Create: `scripts/package/test/verify-platform-bundle.test.mjs`
- Modify: `scripts/package-zxp.ps1`

**Interfaces:**
- Consumes: verified runtime, native helper, launchers, Panel bundle, support matrix, inventories.
- Produces: one deterministic unsigned staging tree and its internal `bundle-manifest.json` inventory per platform; this inventory is not a final release artifact manifest.

```ts
type BundleManifestV1 = {
  schemaVersion: 1;
  version: string;
  platform: "macos-arm64" | "windows-x64";
  sourceCommitSha: string;
  runtime: { nodeVersion: "24.17.0"; pythonVersion: "3.13.14" };
  files: Array<{ path: string; sha256: string; mode: string; size: number }>;
};

async function stagePlatformBundle(input: {
  platform: "macos-arm64" | "windows-x64";
  version: string;
  outDir: string;
  repoRoot: string;
  sourceCommitSha?: string;
}): Promise<{ root: string; manifestPath: string }>;

async function verifyPlatformBundle(input: {
  root: string;
  platform: "macos-arm64" | "windows-x64";
  version: string;
}): Promise<void>;
```

Public CLIs are fixed:

```text
node scripts/package/stage-platform-bundle.mjs --platform <macos-arm64|windows-x64> --version <semver> --out <dir>
node scripts/package/verify-platform-bundle.mjs --root <dir> --platform <macos-arm64|windows-x64> --version <semver>
```

- [ ] **Step 1: Write failing stage and tamper tests**

```js
test('stage contains one platform and omits development files', async () => {
  const h = await makeStageHarness('macos-arm64');
  await stagePlatformBundle(h.input);
  assert.equal(h.manifest().sourceCommitSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(h.exists('runtime/macos-arm64/runtime-manifest.json'), true);
  assert.equal(h.exists('runtime/windows-x64'), false);
  assert.equal(h.exists('.debug'), false);
  assert.equal(h.exists('panel'), false);
  assert.equal(h.exists('sidecar/test'), false);
});

test('verification rejects one changed byte and wrong native architecture', async () => {
  const h = await makeVerifiedStageHarness('windows-x64');
  h.flipByte('runtime/windows-x64/python/python.exe');
  await assert.rejects(verifyPlatformBundle(h.verifyInput), { code: 'BUNDLE_HASH_MISMATCH' });
});

test('stage rejects a noncanonical source commit SHA', async () => {
  const h = await makeStageHarness('macos-arm64', { sourceCommitSha: 'ABC123' });
  await assert.rejects(stagePlatformBundle(h.input), { code: 'INVALID_SOURCE_COMMIT_SHA' });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test scripts/package/test/stage-platform-bundle.test.mjs scripts/package/test/verify-platform-bundle.test.mjs`

Expected: FAIL because stage and verify modules do not exist.

- [ ] **Step 3: Implement deterministic staging and verification**

Stage into a new empty directory and refuse an existing nonempty output. Copy production Panel/host/sidecar assets, exactly one runtime, exactly one helper/addon/launcher set, bundled tools, runtime inventory, license inventory, and SBOM. Exclude `.debug`, Panel source, tests, caches, development dependencies, and foreign native optional packages.

`bundle-manifest.json` records schema version, semver, `PlatformId`, `sourceCommitSha`, runtime versions, and every relative file path with SHA-256, byte length, and POSIX mode. `sourceCommitSha` is exactly 40 lowercase hexadecimal characters. The library accepts it explicitly for fixture tests; the public CLI resolves `AE_MCP_SOURCE_COMMIT_SHA` when set and otherwise reads `git rev-parse HEAD`, then rejects any missing, uppercase, abbreviated, or non-hex value. Do not include wall-clock timestamps; use `SOURCE_DATE_EPOCH` when archive metadata needs a time.

Verification checks manifest/schema/version/platform, `sourceCommitSha` against `/^[0-9a-f]{40}$/`, every hash/mode/size, Mach-O/PE architecture, helper identity metadata, CEP range `[25.0,26.9]`, platform-specific sidecar native package, executable bits on macOS, absence of foreign payloads, and absence of development files. The later release plan compares this exact camelCase field byte-for-byte with its `candidateSha`.

Rewrite `scripts/package-zxp.ps1` as a Windows compatibility wrapper over these unsigned stage/verify CLIs; remove its `npm ci`, signing, and self-signed certificate creation. The wrapper must never create a signed candidate.

- [ ] **Step 4: Run tests and both fixture CLIs to verify GREEN**

Run:

```bash
node --test scripts/package/test/stage-platform-bundle.test.mjs scripts/package/test/verify-platform-bundle.test.mjs
node scripts/package/stage-platform-bundle.mjs --platform macos-arm64 --version 0.9.1 --out build/stage/macos-arm64
node scripts/package/verify-platform-bundle.mjs --root build/stage/macos-arm64 --platform macos-arm64 --version 0.9.1
```

Run on Windows:

```powershell
node scripts/package/stage-platform-bundle.mjs --platform windows-x64 --version 0.9.1 --out build\stage\windows-x64
node scripts/package/verify-platform-bundle.mjs --root build\stage\windows-x64 --platform windows-x64 --version 0.9.1
```

Expected: tests pass; both verify commands print `bundle verified` with the matching platform/version and exit 0.

- [ ] **Step 5: Commit**

```bash
git add packaging/schemas/bundle-manifest.schema.json scripts/package/lib/binary-arch.mjs scripts/package/lib/manifest.mjs scripts/package/stage-platform-bundle.mjs scripts/package/verify-platform-bundle.mjs scripts/package/test/stage-platform-bundle.test.mjs scripts/package/test/verify-platform-bundle.test.mjs scripts/package-zxp.ps1
git commit -m "build(package): stage and verify platform bundles"
```

### Task 15: Prove the nested signing chains with disposable Phase 0 outputs

**Files:**
- Create: `scripts/package/signing-plan.mjs`
- Create: `scripts/package/build-zxp.mjs`
- Create: `scripts/package/sign-macos-nested.sh`
- Create: `scripts/package/sign-windows-nested.ps1`
- Create: `scripts/package/package-macos-dmg.sh`
- Create: `scripts/phase0/run-signing-probe-macos.sh`
- Create: `scripts/phase0/run-signing-probe-windows.ps1`
- Create: `scripts/phase0/verify-signing-evidence.mjs`
- Create: `scripts/package/test/signing-plan.test.mjs`
- Modify: `packaging/schemas/phase0-evidence.schema.json`
- Modify: `docs/platform/PHASE0.md`
- Create: `docs/platform/PLATFORM_HELPER_SECURITY.md`

**Interfaces:**
- Consumes: an unsigned staging root verified by Task 14 and signing credentials supplied only to the local Phase 0 probe.
- Produces: reusable nested-signing scripts plus disposable `Phase0SigningEvidenceV1`; it does not produce a signed candidate, build lock, final signing report, or releasable artifact.

```ts
type SigningStepId =
  | "sign-helper"
  | "sign-xpc"
  | "sign-addon"
  | "sign-launcher"
  | "verify-nested"
  | "sign-zxp"
  | "verify-zxp"
  | "build-dmg"
  | "sign-dmg"
  | "notarize-dmg"
  | "staple-dmg"
  | "verify-gatekeeper"
  | "verify-authenticode";

type SigningPlan = {
  platform: "macos-arm64" | "windows-x64";
  steps: ReadonlyArray<{ id: SigningStepId; mutates: ReadonlyArray<string> }>;
};

type Phase0SigningEvidenceV1 = {
  schemaVersion: 1;
  platform: "macos-arm64" | "windows-x64";
  sourceStageSha256: string;
  disposableOutputRoot: string;
  steps: Array<{ id: SigningStepId; inputSha256: string; outputSha256: string; exitCode: 0 }>;
  verifiedIdentity: string;
  verifiedAt: string;
  publicationAttempted: false;
};

function buildSigningPlan(platform: "macos-arm64" | "windows-x64"): SigningPlan;
async function verifyPhase0SigningEvidence(input: { evidencePath: string; expectedPlatform: "macos-arm64" | "windows-x64"; expectedStageSha256: string }): Promise<void>;
```

The scripts read these names without printing their values:

```text
AE_MCP_APPLE_SIGNING_IDENTITY
AE_MCP_NOTARY_KEYCHAIN_PROFILE
AE_MCP_WINDOWS_SIGNING_CERT_SHA1
AE_MCP_WINDOWS_TIMESTAMP_URL
AE_MCP_ZXP_SIGN_CMD
AE_MCP_ZXP_CERT_PATH
AE_MCP_ZXP_CERT_PASSWORD
```

Reusable production entry points are fixed for the release plan:

```text
bash scripts/package/sign-macos-nested.sh --root <absolute-signing-root> --evidence <absolute-nested-evidence.json>
pwsh -NoProfile -File scripts/package/sign-windows-nested.ps1 -Root <absolute-signing-root> -Evidence <absolute-nested-evidence.json>
node scripts/package/build-zxp.mjs --root <absolute-signing-root> --platform <macos-arm64|windows-x64> --out <absolute-zxp> --evidence <absolute-zxp-evidence.json>
bash scripts/package/package-macos-dmg.sh --zxp <absolute-zxp> --out <absolute-dmg> --evidence <absolute-dmg-evidence.json>
```

Angle-bracketed terms are typed CLI metavariables, not literal values. Each evidence file is canonical JSON and contains only its contiguous `SigningStepId` slice, input/output SHA-256, exit code, and non-secret verified identity. Mac nested evidence covers `sign-helper` through `verify-nested`; ZXP evidence covers `sign-zxp` and `verify-zxp`; DMG evidence covers `build-dmg` through `verify-gatekeeper`. Windows nested evidence covers `sign-helper` through `verify-authenticode`. The scripts reject relative/overlapping paths and never log environment values.

- [ ] **Step 1: Write failing plan, mutation-boundary, and evidence tests**

```js
test('mac Phase 0 plan signs inward to outward', () => {
  assert.deepEqual(buildSigningPlan('macos-arm64').steps.map((step) => step.id), [
    'sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher',
    'verify-nested', 'sign-zxp', 'verify-zxp', 'build-dmg',
    'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-gatekeeper',
  ]);
});

test('windows Phase 0 plan signs every PE before the ZXP', () => {
  assert.deepEqual(buildSigningPlan('windows-x64').steps.map((step) => step.id), [
    'sign-helper', 'sign-addon', 'sign-launcher',
    'verify-authenticode', 'sign-zxp', 'verify-zxp',
  ]);
});

test('Phase 0 output cannot claim publication', async () => {
  const evidence = validPhase0Evidence({ publicationAttempted: true });
  await assert.rejects(writeAndVerify(evidence), { code: 'PHASE0_PUBLICATION_FORBIDDEN' });
});
```

Add tests that reject a staging path reused as an output path, a missing input digest, step reordering, unsigned nested code, identity mismatch, a post-signing byte change, and any evidence path outside `build/phase0/signing/`.

- [ ] **Step 2: Run the tests to verify RED**

Run: `node --test scripts/package/test/signing-plan.test.mjs`

Expected: FAIL because the plan, scripts, and evidence verifier do not exist.

- [ ] **Step 3: Implement reusable scripts with a Phase 0-only runner**

Both probe runners require an already verified unsigned stage, hash it, copy it into a fresh `build/phase0/signing/<platform>/work` directory, and refuse an output inside the source stage. They invoke only the reusable nested-signing scripts; they never invoke staging/runtime builders, GitHub APIs, `git tag`, or a release command.

On macOS, sign helper/XPC/addon/launcher Mach-O code with hardened runtime and timestamp, verify identity and arm64 architecture, sign and verify the ZXP, put that exact ZXP byte sequence into the probe DMG, sign/notarize/staple the probe DMG, and verify it with `spctl`. The raw ZXP is not a notarization or staple target. On Windows, sign helper EXE, transport `.node`, and launcher EXE with SHA-256 plus RFC 3161 timestamp, verify each with `signtool verify /pa /all`, then sign and verify the probe ZXP.

Define `sourceStageSha256` as SHA-256 of the exact verified `bundle-manifest.json` bytes. Write `phase0-signing-evidence.json` with that source digest, per-step input/output digest, command exit status, verified identity, UTC verification time, and `publicationAttempted:false`. Redact command arguments matching password, certificate, token, keychain-profile, or credential names. Extend the Phase 0 schema and `collect-phase0-evidence.mjs` from Task 3 so the merged helper evidence requires the verified signing-evidence SHA-256 for both platforms, without embedding signing evidence or secrets.

- [ ] **Step 4: Run unit and real Phase 0 signing probes to verify GREEN**

Run: `node --test scripts/package/test/signing-plan.test.mjs scripts/phase0/test/phase0-evidence.test.mjs`

Expected: PASS with exact ordering, mutation boundaries, redaction, and publication rejection.

Run on the macOS signing host:

```bash
bash scripts/phase0/run-signing-probe-macos.sh build/stage/macos-arm64 build/phase0/signing/macos-arm64
node scripts/phase0/verify-signing-evidence.mjs --evidence build/phase0/signing/macos-arm64/phase0-signing-evidence.json --platform macos-arm64 --stage build/stage/macos-arm64
```

Expected: the probe exits 0; `codesign`, ZXPSignCmd, notarytool, stapler, and Gatekeeper checks are recorded as successful; the unsigned source stage digest is unchanged; no output exists outside `build/phase0/signing/macos-arm64`.

Run on the Windows signing host:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\phase0\run-signing-probe-windows.ps1 -StageRoot build\stage\windows-x64 -OutRoot build\phase0\signing\windows-x64
node scripts/phase0/verify-signing-evidence.mjs --evidence build/phase0/signing/windows-x64/phase0-signing-evidence.json --platform windows-x64 --stage build/stage/windows-x64
```

Expected: the probe exits 0; Authenticode and ZXP verification are recorded as successful; the unsigned source stage digest is unchanged; no output exists outside `build\phase0\signing\windows-x64`.

After both probes, rerun the merged evidence gate:

```bash
node scripts/phase0/collect-phase0-evidence.mjs --merge build/phase0/macos-helper.json build/phase0/windows-helper.json --signing-evidence build/phase0/signing/macos-arm64/phase0-signing-evidence.json build/phase0/signing/windows-x64/phase0-signing-evidence.json --out build/phase0/platform-helper.json
node --test scripts/phase0/test/phase0-evidence.test.mjs
```

Expected: PASS only when the helper evidence and nested-signing evidence validate for both platform IDs; a missing, swapped, malformed, or digest-mismatched signing evidence file fails closed.

- [ ] **Step 5: Commit**

```bash
git add scripts/package/signing-plan.mjs scripts/package/build-zxp.mjs scripts/package/sign-macos-nested.sh scripts/package/sign-windows-nested.ps1 scripts/package/package-macos-dmg.sh scripts/package/test/signing-plan.test.mjs scripts/phase0/run-signing-probe-macos.sh scripts/phase0/run-signing-probe-windows.ps1 scripts/phase0/verify-signing-evidence.mjs scripts/phase0/collect-phase0-evidence.mjs scripts/phase0/test/phase0-evidence.test.mjs packaging/schemas/phase0-evidence.schema.json docs/platform/PHASE0.md docs/platform/PLATFORM_HELPER_SECURITY.md
git update-index --chmod=+x scripts/package/sign-macos-nested.sh scripts/package/package-macos-dmg.sh scripts/phase0/run-signing-probe-macos.sh
git commit -m "build(signing): prove nested chains in phase zero"
```

### Task 16: Run foundation regressions on native CI runners

**Files:**
- Create: `.github/workflows/platform-foundation-ci.yml`
- Create: `scripts/package/test/workflow-boundary.test.mjs`
- Modify: `.github/workflows/ci.yml:9-70`

**Interfaces:**
- Consumes: unit/native test commands, portable-runtime fixture builder, and unsigned stage/verify CLIs from Tasks 1-15.
- Produces: ordinary push/pull-request pass/fail checks on macOS arm64 and Windows x64. It has no signing credentials, protected release Environment, dispatch input, build lock, uploaded distributable, or release metadata.

```ts
type FoundationCiContract = {
  triggers: ReadonlyArray<"push" | "pull_request">;
  permissions: { contents: "read" };
  platforms: ReadonlyArray<"macos-arm64" | "windows-x64">;
  signs: false;
  publishes: false;
  uploadsDistributables: false;
};
```

- [ ] **Step 1: Write the failing workflow-boundary test**

```js
test('foundation CI is unprivileged and cannot create a release candidate', () => {
  const workflow = fs.readFileSync('.github/workflows/platform-foundation-ci.yml', 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /contents:\s*read/);
  assert.doesNotMatch(workflow, /workflow_dispatch|environment:|release-signing/);
  assert.doesNotMatch(workflow, /notarytool|signtool|ZXPSignCmd|upload-artifact/);
  assert.doesNotMatch(workflow, /candidate|artifact-set|git\s+tag|gh\s+release/i);
});
```

Add assertions that the macOS job checks `uname -m` equals `arm64`, the Windows job checks `PROCESSOR_ARCHITECTURE` equals `AMD64`, both run the exact runtime inventory and unsigned bundle verification commands, and neither job can continue after a failed architecture check.

Also assert an explicit minimum-OS compatibility job uses `runs-on: macos-14`, validates arm64, and cannot be skipped with `continue-on-error`. If GitHub removes that hosted label, the only accepted edit is to replace it with `[self-hosted, macOS, ARM64, ae-mcp-macos-14]`; deleting the job requires a separately approved support-matrix change.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test scripts/package/test/workflow-boundary.test.mjs`

Expected: FAIL because `platform-foundation-ci.yml` does not exist.

- [ ] **Step 3: Add the unprivileged native CI workflow**

Trigger `platform-foundation-ci.yml` only on `push` and `pull_request`, set workflow permissions to `contents: read`, and give each job a 45-minute timeout. The primary macOS job uses a native Apple Silicon `macos-15` runner, asserts `arm64`, sets `MACOSX_DEPLOYMENT_TARGET=14.0`, runs Swift tests, Node/Python suites, the portable-runtime fixture build, runtime inventory verification, and an unsigned macOS stage/verify fixture. A second required `macos-14-compat` job runs the same built-runtime import, Panel/host tests, deployment-target inspection, and unsigned verify path on the minimum supported OS; it does not sign or upload. The Windows job uses `windows-2025`, asserts `AMD64`, runs CMake/CTest, Node/Python suites, the portable-runtime fixture build, runtime inventory verification, and an unsigned Windows stage/verify fixture.

The workflow must not read repository Environment secrets, invoke any signing command, create a signed archive, upload a distributable, call a GitHub write API, or accept a manual SHA/version input. Keep the existing fast Linux-neutral checks in `ci.yml`; make the native workflow a required platform foundation check rather than a release builder.

- [ ] **Step 4: Run workflow and local contract checks to verify GREEN**

Run:

```bash
node --test scripts/package/test/workflow-boundary.test.mjs
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/platform-foundation-ci.yml'); YAML.load_file('.github/workflows/ci.yml')"
```

Expected: the boundary test passes and both workflow files parse as YAML.

Open a pull request that touches `native/platform-helper`, `packaging`, or `scripts/package`. Expected: `macos-15`, `macos-14-compat`, and `windows-2025` all run automatically, verify the applicable unsigned fixture stages, write only job summaries, and expose no downloadable product artifact or signing secret.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/platform-foundation-ci.yml .github/workflows/ci.yml scripts/package/test/workflow-boundary.test.mjs
git commit -m "ci(platform): test foundation on native runners"
```

### Task 17: Update installation and developer docs, then run the foundation regression gate

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/INSTALL.md`
- Modify: `docs/RELEASE.md`
- Modify: `docs/WORKFLOW.md`
- Modify: `packages/bridge/README.md`
- Modify: `packages/snapshot-host/README.md`
- Modify: `scripts/install-plugin-dev-macos.sh`
- Modify: `scripts/install-plugin-dev.ps1`
- Modify: `plugin/client/dist/app.js`

**Interfaces:**
- Consumes: completed platform foundation.
- Produces: user/developer documentation matching the actual offline bundle and support contract.

- [ ] **Step 1: Write exact documentation assertions into the boundary test**

Extend `scripts/package/test/no-platform-leaks.test.mjs` with:

```js
test('user install docs describe offline bundles and exact support range', () => {
  const install = fs.readFileSync('docs/INSTALL.md', 'utf8');
  const release = fs.readFileSync('docs/RELEASE.md', 'utf8');
  assert.match(install, /macOS 14.*Apple Silicon/s);
  assert.match(install, /Windows 11 24H2.*x64/s);
  assert.match(install, /After Effects 25\.x.*26\.x/s);
  assert.match(install, /~\/\.ae-mcp\/bin\/ae-mcp/);
  assert.doesNotMatch(install, /pip install .*snapshot-mss/);
  assert.doesNotMatch(install, /winget.*Node/i);
  assert.match(release, /stage-platform-bundle\.mjs/);
  assert.match(release, /verify-platform-bundle\.mjs/);
  assert.match(release, /\[25\.0,26\.9\]/);
});
```

- [ ] **Step 2: Run the documentation test to verify RED**

Run: `node --test scripts/package/test/no-platform-leaks.test.mjs`

Expected: FAIL because current docs describe Windows-only verification, manual pip/uv/npm setup, `snapshot-mss`, and online system runtime installation.

- [ ] **Step 3: Rewrite installation, upgrade, rollback, uninstall, and release guidance**

Document the exact supported matrix, ZXP-contained runtime, first-launch offline copy, stable launcher, current/previous pointers, Settings rollback/uninstall, macOS Screen Recording permission and recovery, Keychain/Credential Manager behavior, optional external AI CLIs, and platform-specific artifact names. User installation must not require Windows commands on macOS or require system Python/Node/uv on either platform.

Release documentation in this plan is limited to the handoff contract: invoke the unified unsigned stage/verify CLIs, identify the reusable nested-signing scripts, link the unprivileged native CI workflow, and state that the dual-platform release plan owns signed-candidate orchestration, candidate/build locks, final artifact manifests, attestation, tags, and publication. Replace all `snapshot-mss` references with `snapshot-host` and state that Python never captures the desktop or starts the helper.

Ensure the macOS developer installer is executable and both developer installers verify Panel, host, sidecar, helper, runtime, architecture, and executable modes.

- [ ] **Step 4: Run the complete foundation verification to verify GREEN**

Run:

```bash
node --test scripts/package/test/support-matrix.test.mjs scripts/package/test/runtime-lock.test.mjs scripts/package/test/runtime-inventory.test.mjs scripts/package/test/no-platform-leaks.test.mjs scripts/package/test/stage-platform-bundle.test.mjs scripts/package/test/verify-platform-bundle.test.mjs scripts/package/test/signing-plan.test.mjs scripts/package/test/workflow-boundary.test.mjs
npm --prefix plugin/host test
npm --prefix plugin/panel test
npm --prefix plugin/sidecar test
uv run pytest -q
bash -n scripts/install-plugin-dev-macos.sh
npm --prefix plugin/panel run build
git diff --exit-code -- plugin/client/dist
```

Expected: every Node and pytest suite exits 0; shell syntax exits 0; Panel build succeeds; generated Panel dist has no remaining diff.

Run on macOS:

```bash
swift test --package-path native/platform-helper/macos
node scripts/package/verify-platform-bundle.mjs --root build/stage/macos-arm64 --platform macos-arm64 --version 0.9.1
```

Expected: Swift tests pass and bundle verification prints `bundle verified: macos-arm64 0.9.1`.

Run on Windows:

```powershell
cmake --build build/helper-win --config Release
ctest --test-dir build/helper-win -C Release --output-on-failure
node scripts/package/verify-platform-bundle.mjs --root build\stage\windows-x64 --platform windows-x64 --version 0.9.1
```

Expected: native build/CTest pass and bundle verification prints `bundle verified: windows-x64 0.9.1`.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-CN.md docs/INSTALL.md docs/RELEASE.md docs/WORKFLOW.md packages/bridge/README.md packages/snapshot-host/README.md scripts/install-plugin-dev-macos.sh scripts/install-plugin-dev.ps1 plugin/client/dist/app.js scripts/package/test/no-platform-leaks.test.mjs
git update-index --chmod=+x scripts/install-plugin-dev-macos.sh
git commit -m "docs(install): document offline dual-platform foundation"
```

## Cross-Plan Handoff

- The request-header/provider plan runs after Tasks 6, 8, 10, and 11. It owns `plugin/panel/src/cep/providerStore.js`, provider schema v2, provider-specific use of `SecretReference`, and the `App.jsx` hydration that resolves provider values only when needed.
- The request-header plan calls host-direct `secretGet`, `secretSet`, and `secretDelete`; it must not add a secret HTTP endpoint.
- Tool Library work may consume `PathCatalog`, runtime diagnostics, `private_temp_dir(*, prefix: str) -> ContextManager[Path]`, `atomic_replace_bytes`, and `atomic_replace_file`; it must not reimplement permissions, ACLs, fsync/replace semantics, or platform branching.
- The dual-platform release plan consumes the exact unsigned stage/verify CLIs, nested-signing scripts, and successful Phase 0 signing evidence. It alone creates the signed-candidate workflow, candidate/build lock, final signing reports, final artifact-set or release manifest, RC attestation, tags, and releases; it must not rebuild foundation code while signing a candidate.
