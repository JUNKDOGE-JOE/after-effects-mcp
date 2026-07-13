# Provider Request Route Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the custom-provider request path on current `main` with secret-reference-only profiles, verified dialect selection, an authenticated and bounded Responses-to-Chat facade, and a real-Codex compact/long-context gate.

**Architecture:** Provider JSON stores only non-secret policy plus opaque helper references; the signed platform helper remains the only secret store and the Panel resolves values only for the lifetime of a probe, native Codex spawn, or authenticated facade request. Dialect is selected for the exact model ID because one Provider may expose a mixture of native Responses and Chat-only models. Native Responses models stay direct and use Codex `env_http_headers`; Chat-only models run behind a loopback facade that presents the Responses API to Codex, validates every request, and translates only an explicit supported schema. The facade is not connected to `codexBackend` until endpoint, header, token, resource, and compact tests are all green.

**Tech Stack:** React 18 CEP Panel, CEP Node CommonJS bridge, ESM JavaScript, Node built-ins (`http`, `https`, `crypto`, `stream`), `node:test`, `node:assert/strict`, Codex app-server.

## Global Constraints

- Authoritative design: `docs/superpowers/specs/2026-07-10-macos-header-tool-library-dual-release-design.md`, especially sections 6, 8, 9, and 12.2.
- Start only after the platform runtime/helper/App wiring is merged into protected `main`; rebase this work before touching `plugin/panel/src/app/App.jsx` or `plugin/panel/src/cep/codexBackend.js`.
- Consume `plugin/host/platform-helper-client.js`, `plugin/panel/src/cep/platform/secret-reference.js`, `plugin/panel/src/cep/platform/secret-migration.js`, and host-owned in-process `secretGet`/`secretSet`/`secretDelete`; do not implement a second helper and do not add a secret HTTP endpoint.
- Keep CEP as the only production host. Do not introduce UXP code.
- Provider configuration is not exportable. JSON, localStorage, logs, diagnostics, backups, fixtures, and `.aemcptools` must never contain a provider secret value.
- Provider extra headers whose names indicate credentials must use `SecretValueRef`; literal values matching a credential syntax fail closed even when the header name looks non-sensitive.
- The only persisted secret locator is `aemcp-secret://provider/<lowercase-uuid>/<slot>/v1`; never construct a Keychain service/account or Credential Manager target in Panel code.
- The current Codex configuration reference permits only `wire_api = "responses"`. A stored dialect value of `chat` selects the local facade; it is never emitted as Codex `wire_api = "chat"`.
- `GET /v1/models` only enumerates model IDs; it is not evidence that every model behind the Provider shares one dialect.
- Dialect detection requires an explicit current `modelId`, sends valid minimal requests to that model, prefers a schema-valid native Responses result, and falls back to a schema-valid Chat Completion result. The verified result is cached and consumed only for that exact model ID.
- A legacy Provider-level `detected` singleton has no safe model binding and therefore fails closed instead of being applied to every model.
- Native Responses provider values enter Codex only through `model_providers.<id>.env_http_headers` plus the spawned process environment. Command arguments contain header names and environment variable names, never values.
- The facade binds only `127.0.0.1`, generates a fresh 32-byte base64url route token per lifetime, and requires `Authorization: Bearer <route-token>` on every request.
- Missing or invalid route auth returns 401 before URL parsing that could cause DNS, before secret resolution, and before any upstream call.
- Header limits are 8 KiB per value, 32 KiB total, and 64 fields. Request body limit is 16 MiB, SSE frame limit is 1 MiB, concurrency is 4, connect timeout is 15 seconds, active idle timeout is 120 seconds, total call timeout is 30 minutes, and provider error body limit is 64 KiB.
- `/v1/responses/compact` for chat-only providers returns 501 `provider_compaction_unsupported`; it is never translated to a normal Chat Completion and never fabricates `encrypted_content`.
- A fixed real Codex version must continue after that 501 in the long-context smoke. If it cannot continue, chat-only support remains incomplete and this plan fails rather than weakening the test.
- The fixed macOS arm64 live-gate binary is `codex-cli 0.144.0-alpha.4` with SHA-256 `ea2164f4728fea4049e3bf1eb882dc15c34597ac75544b47976a529feab3c7b4`; changing either value requires an approved design/fixture update before rerunning the gate.
- Preserve the user's existing dirty files. This plan modifies only the paths listed below and uses an isolated `codex/provider-route-closure` worktree when executed.
- `plugin/client/dist/app.js` is generated once in the final task with `npm run build`; never edit it by hand and never copy the binary from `origin/feat/provider-dialect-autodetect`.

---

## File Responsibility Map

### Create

- `plugin/panel/src/cep/providerSecrets.js` — narrow Panel wrapper around host-owned secret methods; raw values never enter store/UI objects.
- `plugin/panel/src/cep/providerMigration.js` — provider-specific v1-to-v2 plan for the generic two-phase secret migration runner.
- `plugin/panel/src/app/providerProfileFlow.js` — save/edit/delete/import orchestration, copy-on-write secret references, and JSON commit ordering.
- `plugin/panel/src/cep/providerDetect.js` — side-effect-minimized, schema-verified dialect detection.
- `plugin/panel/src/app/providerProbeFlow.js` — profile-aware model/dialect probe orchestration and cache persistence.
- `plugin/panel/src/lib/providerDialectBadge.js` — pure UI presentation for override/detected/unconfirmed state.
- `plugin/panel/src/lib/providerUrl.js` — secure base URL validation, endpoint join, base-path preservation, and query preservation.
- `plugin/panel/src/lib/providerHeaders.js` — request allowlist/denylist, provider header validation, precedence, limits, and response allowlist.
- `plugin/panel/src/lib/codexResponsesCodec.js` — fail-closed Responses request validation and exact Chat/SSE conversion.
- `plugin/panel/src/cep/providerRouteAuth.js` — ephemeral route-token generation, fixed Bearer parsing, and constant-time verification.
- `plugin/panel/src/cep/codexResponsesRoute.js` — loopback server, endpoint dispatch, upstream lifecycle, limits, and audit events.
- `plugin/panel/test/providerSecrets.test.js`
- `plugin/panel/test/providerMigration.test.js`
- `plugin/panel/test/providerProfileFlow.test.js`
- `plugin/panel/test/providerDetect.test.js`
- `plugin/panel/test/providerProbeFlow.test.js`
- `plugin/panel/test/providerDialectBadge.test.js`
- `plugin/panel/test/providerUrl.test.js`
- `plugin/panel/test/providerHeaders.test.js`
- `plugin/panel/test/providerRouteAuth.test.js`
- `plugin/panel/test/codexResponsesCodec.test.js`
- `plugin/panel/test/codexResponsesRoute.endpoint.test.js`
- `plugin/panel/test/codexResponsesRoute.headers.test.js`
- `plugin/panel/test/codexResponsesRoute.token.test.js`
- `plugin/panel/test/codexResponsesRoute.resource.test.js`
- `plugin/panel/test/codexResponsesRoute.compact.test.js`
- `plugin/panel/test/codexResponsesRoute.codex-live.test.js`
- `plugin/panel/test/helpers/providerRouteFixtures.js`
- `plugin/panel/test/fixtures/codex/responses-request-supported.json`
- `plugin/panel/test/fixtures/codex/responses-request-unsupported-image.json`
- `plugin/panel/test/fixtures/codex/chat-completion.json`
- `plugin/panel/test/fixtures/codex/chat-completion.sse`
- `plugin/panel/test/fixtures/codex/responses-stream.expected.sse`

### Modify

- `plugin/panel/src/cep/providerStore.js`
- `plugin/panel/src/lib/providerProfile.js`
- `plugin/panel/src/lib/providerManagerState.js`
- `plugin/panel/src/cep/modelProbe.js`
- `plugin/panel/src/cep/ccSwitch.js`
- `plugin/panel/src/cep/claudeSettingsImport.js`
- `plugin/panel/src/cep/codexConfig.js`
- `plugin/panel/src/cep/codexBackend.js`
- `plugin/panel/src/cep/claudeAgentBackend.js`
- `plugin/panel/src/lib/claudeChannel.js`
- `plugin/panel/src/lib/agentLoop.js`
- `plugin/panel/src/lib/anthropic.js`
- `plugin/panel/src/cep/modelsApi.js`
- `plugin/panel/src/app/App.jsx`
- `plugin/panel/src/components/settings/ProviderManagerSection.jsx`
- `plugin/panel/src/lib/channels.js`
- `plugin/panel/src/lib/backendSelect.js`
- `plugin/panel/src/lib/logExport.js`
- `plugin/panel/test/providerStore.test.js`
- `plugin/panel/test/providerProfile.test.js`
- `plugin/panel/test/providerManagerState.test.js`
- `plugin/panel/test/modelProbe.test.js`
- `plugin/panel/test/ccSwitch.test.js`
- `plugin/panel/test/claudeSettingsImport.test.js`
- `plugin/panel/test/codexConfig.test.js`
- `plugin/panel/test/codexBackend.test.js`
- `plugin/panel/test/claudeAgentBackend.test.js`
- `plugin/panel/test/claudeChannel.test.js`
- `plugin/panel/test/agentLoop.test.js`
- `plugin/panel/test/anthropic.test.js`
- `plugin/panel/test/modelsApi.test.js`
- `plugin/panel/test/channels.test.js`
- `plugin/panel/test/backendSelect.test.js`
- `plugin/panel/test/logExport.test.js`
- `plugin/client/dist/app.js` — generated in Task 10 only.

### Read but do not modify

- `plugin/host/platform-helper-client.js`
- `plugin/panel/src/cep/platform/secret-reference.js`
- `plugin/panel/src/cep/platform/secret-migration.js`
- `plugin/panel/src/cep/platform/index.js`
- `plugin/host/server.js`
- `plugin/host/platform-helper-client.test.js`
- `plugin/panel/test/secret-reference.test.js`
- `plugin/panel/test/secret-migration.test.js`

---

## Locked Interfaces and Schemas

Use these names and shapes exactly in every task.

```js
/** @typedef {'probe'|'model'} ProviderScope */

/**
 * @typedef {{
 *   kind:'secret',
 *   reference:string,
 *   revision:number
 * }} SecretValueRef
 */

/**
 * @typedef (
 *   {kind:'literal',value:string} |
 *   SecretValueRef
 * ) HeaderValueRef
 */

/**
 * @typedef (
 *   {kind:'none'} |
 *   {kind:'bearer'|'x-api-key',valueRef:SecretValueRef} |
 *   {kind:'custom',headerName:string,valueRef:SecretValueRef}
 * ) AuthPolicy
 */

/** @typedef ({kind:'inherit-model'}|AuthPolicy) ProbeAuthPolicy */

/**
 * @typedef {{
 *   id:string,
 *   name:string,
 *   scopes:ProviderScope[],
 *   valueRef:HeaderValueRef
 * }} ProviderExtraHeader
 */

/**
 * @typedef {{
 *   modelId:string,
 *   wireApi:'responses'|'chat',
 *   baseUrl:string,
 *   authProfileRevision:number,
 *   detectedAt:number,
 *   evidence:'responses-success-schema'|'chat-success-schema'
 * }} DetectedProviderDialect
 */

/**
 * @typedef {{
 *   override:null|{
 *     wireApi:'responses'|'chat',
 *     source:'manual'|'legacy-v0.9'|'ccswitch-import',
 *     updatedAt:number
 *   },
 *   detected:DetectedProviderDialect[]
 * }} ProviderDialectState
 */

/**
 * @typedef {{
 *   id:string,
 *   credentialId:string,
 *   name:string,
 *   protocol:'openai-compatible'|'anthropic',
 *   baseUrl:string,
 *   allowInsecureHttp:boolean,
 *   authProfileRevision:number,
 *   auth:{model:AuthPolicy,probe:ProbeAuthPolicy},
 *   headers:ProviderExtraHeader[],
 *   dialect:ProviderDialectState,
 *   probedModels:Array<{id:string,label:string}>,
 *   probedAt:number
 * }} ProviderEntryV2
 */
```

Only `source:'manual'` is an effective global override. The other source values are accepted only to read older state safely; they never select a runtime dialect and are removed when that Provider is edited without an explicit manual override.

Persisted state:

```js
{
  version: 2,
  revision: 7,
  migratedLegacy: true,
  pendingSecretDeletes: [],
  providers: [
    {
      id: 'relay',
      credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
      name: 'Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example/openai',
      allowInsecureHttp: false,
      authProfileRevision: 3,
      auth: {
        model: {
          kind: 'bearer',
          valueRef: {
            kind: 'secret',
            reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model-a13f28/v1',
            revision: 1
          }
        },
        probe: { kind: 'inherit-model' }
      },
      headers: [],
      dialect: {
        override: null,
        detected: []
      },
      probedModels: [],
      probedAt: 0
    }
  ]
}
```

Store and runtime signatures:

```js
createProviderStore(deps?): {
  filePath():string,
  readState():{version:2,revision:number,migratedLegacy:boolean,pendingSecretDeletes:SecretValueRef[],providers:ProviderEntryV2[]},
  readLegacyMigrationInput():null|{sourceRevision:string,state:unknown},
  list():ProviderEntryV2[],
  get(id:string):ProviderEntryV2|null,
  upsert(entry:ProviderEntryV2,options?:{expectedRevision?:number,pendingSecretDeletes?:SecretValueRef[]}):{entry:ProviderEntryV2,stateRevision:number},
  remove(id:string,options?:{expectedRevision?:number,pendingSecretDeletes?:SecretValueRef[]}):{removed:boolean,stateRevision:number},
  acknowledgeSecretDelete(reference:string,options?:{expectedRevision?:number}):{stateRevision:number},
  replaceState(state:unknown,options?:{expectedRevision?:number}):{stateRevision:number},
  writeRedactedBackup(state:unknown,policy:{keep:3,maxAgeDays:30}):Promise<void>,
  needsSecretMigration():boolean
}

createProviderSecretService({getHost,createReference?,randomBytes?}): {
  resolve(valueRef:SecretValueRef):Promise<string>,
  create(input:{credentialId:string,slotPrefix:'auth-model'|'auth-probe'|'header',value:string}):Promise<SecretValueRef>,
  delete(valueRef:SecretValueRef):Promise<{deleted:boolean,revision:number|null}>
}

migrateProviderStoreSecrets({
  store,
  legacyKeyStore,
  runner,
  secretStore,
  now?,
  legacyCredentialId
}):Promise<{
  status:'committed'|'already-committed',
  written:number,
  resumedFrom:'pending'|'secrets-written'|'state-committed'|'committed'
}>

// legacyKeyStore is migration-only; production request code never receives it.
legacyKeyStore: {
  readKey(name:'anthropic'|'codex'|'zcode'):string,
  cleanupCommittedProviderSecrets():Promise<void>
}

resolveProviderRequestProfile(provider:ProviderEntryV2,options:{
  scope:'probe'|'model',
  secretService:ReturnType<typeof createProviderSecretService>
}):Promise<{
  providerId:string,
  baseUrl:string,
  allowInsecureHttp:boolean,
  auth:{kind:'none'}|{kind:'header',name:string,value:string},
  extraHeaders:Array<{name:string,value:string,source:'literal'|'secret'}>,
  authProfileRevision:number
}>
```

Dialect signatures:

```js
detectProviderDialect({provider,resolveRequestProfile,requestImpl,modelId,timeoutMs?,now?}):Promise<
  | {ok:true,dialect:DetectedProviderDialect,models:Array<{id:string,label:string}>,tried:Array<object>}
  | {ok:false,reason:'configuration'|'authentication'|'network'|'path-unsupported'|'dialect-incompatible',detail:string,tried:Array<object>}
>

effectiveProviderDialect(provider:ProviderEntryV2,options:{modelId:string,now?:()=>number,maxAgeMs?:number}):'responses'|'chat'|null
```

Header, URL, token, codec, and route signatures:

```js
collectCodexHeaders(rawHeaders:string[],limits?:{
  maxValueBytes?:number,
  maxTotalBytes?:number,
  maxCount?:number
}):Array<{name:string,value:string}>

mergeUpstreamHeaders({rawHeaders,providerHeaders,auth,contentType}):Record<string,string>

filterUpstreamResponseHeaders(rawHeaders:string[]):Record<string,string>

buildProviderEndpoint({
  baseUrl:string,
  resource:'models'|'responses'|'chat-completions',
  inboundSearch?:string,
  allowInsecureHttp?:boolean
}):URL

generateRouteToken({randomBytes}):string
parseRouteAuthorization(rawHeaders:string[]):string|null
routeTokenMatches(candidate:string,expected:string,deps:{createHash,timingSafeEqual}):boolean

responsesBodyToChatBody(body:unknown):Record<string,unknown>
chatCompletionToResponse(chat:unknown,context:{id:string,model:string}):Record<string,unknown>
createChatSseToResponses({id,model,maxFrameBytes,writeEvent,fail}):{
  feed(chunk:string|Uint8Array):void,
  end():void
}

createCodexResponsesRoute({
  provider,
  resolveRequestProfile, // (provider,{scope:'probe'|'model'}) => Promise<resolved profile>
  requireImpl,
  createUpstreamRequest?,
  lookupImpl?,
  cryptoImpl,
  limits?,
  onAudit?
}):{
  start():Promise<{baseUrl:string,routeToken:string}>,
  close():Promise<void>
}
```

Codex runtime signatures:

```js
codexAppServerArgs(runtimeConfig?:{
  providerId:string,
  baseUrl:string,
  envHeaders:Array<{name:string,envName:string}>
}):string[]

codexSpawnEnv(runtimeConfig:{
  envHeaders:Array<{name:string,envName:string,value:string}>
},baseEnv?:Record<string,string>):Record<string,string>
```

The route limits are fixed defaults but injectable downward in tests:

```js
export const DEFAULT_ROUTE_LIMITS = Object.freeze({
  requestBodyBytes: 16 * 1024 * 1024,
  sseFrameBytes: 1024 * 1024,
  concurrent: 4,
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 120_000,
  totalTimeoutMs: 30 * 60_000,
  errorBodyBytes: 64 * 1024,
  headerValueBytes: 8 * 1024,
  headerTotalBytes: 32 * 1024,
  headerCount: 64
});
```

---

### Task 1: Add the provider v2 schema and helper-backed secret primitives without switching production callers

**Files:**

- Create: `plugin/panel/src/cep/providerSecrets.js`
- Create: `plugin/panel/src/cep/providerMigration.js`
- Modify: `plugin/panel/src/lib/providerProfile.js`
- Create: `plugin/panel/test/providerSecrets.test.js`
- Create: `plugin/panel/test/providerMigration.test.js`
- Modify: `plugin/panel/test/providerProfile.test.js`
- Read: `plugin/panel/src/cep/platform/secret-reference.js`
- Read: `plugin/panel/src/cep/platform/secret-migration.js`

**Interfaces:**

- Consumes: host `secretGet(reference)`, `secretSet({reference,value,expectedRevision})`, `secretDelete({reference,expectedRevision})`; platform `createProviderSecretReference({providerId,slot})`; platform `createSecretMigrationRunner({journalStore,secretStore,now}).run(plan)`.
- Produces: `normalizeProviderEntryV2`, `resolveProviderRequestProfile`, `createProviderSecretService`, and `migrateProviderStoreSecrets` with the locked signatures above.
- Compatibility: keep the current `normalizeProviderProfile`, `codexAppServerArgs`, and `codexSpawnEnv` exports working until Task 9 switches their callers.

- [ ] **Step 1: Write failing schema and secret-service tests**

Add exact cases proving strict references, read-back, revision checking, no enumeration, and no secret in returned errors:

```js
function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/' + slot + '/v1',
    revision
  };
}

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: [] },
    probedModels: [],
    probedAt: 0
  }, overrides);
}
```

```js
test('provider secret service creates, reads back, and returns only a reference plus revision', async () => {
  const calls = [];
  const values = new Map();
  const host = {
    async secretSet(input) {
      calls.push(['set', input.reference, input.expectedRevision]);
      values.set(input.reference, { value: input.value, revision: 1 });
      return { reference: input.reference, revision: 1 };
    },
    async secretGet(reference) {
      calls.push(['get', reference]);
      const item = values.get(reference);
      return item
        ? { found: true, reference, value: item.value, revision: item.revision }
        : { found: false, reference, revision: null };
    },
    async secretDelete(input) {
      calls.push(['delete', input.reference]);
      const deleted = values.delete(input.reference);
      return { reference: input.reference, deleted, revision: null };
    }
  };
  const service = createProviderSecretService({
    getHost: () => host,
    randomBytes: () => Buffer.from('a13f28', 'utf8')
  });
  const ref = await service.create({
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    slotPrefix: 'auth-model',
    value: 'sk-provider-secret'
  });
  assert.equal(ref.kind, 'secret');
  assert.equal(ref.revision, 1);
  assert.match(ref.reference, /^aemcp-secret:\/\/provider\/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2\/auth-model-[a-z0-9_-]+\/v1$/);
  assert.equal(JSON.stringify(ref).includes('sk-provider-secret'), false);
  assert.equal(await service.resolve(ref), 'sk-provider-secret');
  assert.deepEqual(calls.map((call) => call[0]), ['set', 'get', 'get']);
});

test('resolveProviderRequestProfile separates probe and model auth', async () => {
  const provider = providerFixture({
    auth: {
      model: { kind: 'bearer', valueRef: secretRef('auth-model', 4) },
      probe: { kind: 'custom', headerName: 'x-probe-token', valueRef: secretRef('auth-probe', 2) }
    }
  });
  const secretService = {
    resolve: async (ref) => ref.reference.includes('auth-probe') ? 'probe-secret' : 'model-secret'
  };
  const probe = await resolveProviderRequestProfile(provider, { scope: 'probe', secretService });
  const model = await resolveProviderRequestProfile(provider, { scope: 'model', secretService });
  assert.deepEqual(probe.auth, { kind: 'header', name: 'x-probe-token', value: 'probe-secret' });
  assert.deepEqual(model.auth, { kind: 'header', name: 'Authorization', value: 'Bearer model-secret' });
});

test('resolveProviderRequestProfile filters extra headers by scope and preserves source', async () => {
  const provider = providerFixture({
    headers: [
      { id: 'probe-feature', name: 'x-probe-feature', scopes: ['probe'], valueRef: { kind: 'literal', value: 'probe-on' } },
      { id: 'model-token', name: 'x-model-token', scopes: ['model'], valueRef: secretRef('header-model', 3) },
      { id: 'shared', name: 'x-shared-feature', scopes: ['probe', 'model'], valueRef: { kind: 'literal', value: 'shared-on' } }
    ]
  });
  const secretService = { resolve: async () => 'resolved-header-secret' };
  const probe = await resolveProviderRequestProfile(provider, { scope: 'probe', secretService });
  const model = await resolveProviderRequestProfile(provider, { scope: 'model', secretService });
  assert.deepEqual(probe.extraHeaders, [
    { name: 'x-probe-feature', value: 'probe-on', source: 'literal' },
    { name: 'x-shared-feature', value: 'shared-on', source: 'literal' }
  ]);
  assert.deepEqual(model.extraHeaders, [
    { name: 'x-model-token', value: 'resolved-header-secret', source: 'secret' },
    { name: 'x-shared-feature', value: 'shared-on', source: 'literal' }
  ]);
});
```

In `providerMigration.test.js`, use the real generic runner with in-memory `journalStore` and `secretStore`. Assert the v1 input includes a known marker while the backup, committed v2 state, and journal do not:

```js
assert.match(JSON.stringify(legacyState), /sk-legacy-marker/);
assert.doesNotMatch(JSON.stringify(redactedBackup), /sk-legacy-marker/);
assert.doesNotMatch(JSON.stringify(committedState), /sk-legacy-marker/);
assert.doesNotMatch(JSON.stringify(journalStore.snapshot()), /sk-legacy-marker/);
assert.equal(committedState.version, 2);
assert.deepEqual(committedState.pendingSecretDeletes, []);
assert.equal(committedState.providers[0].auth.model.valueRef.kind, 'secret');
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/providerSecrets.test.js test/providerMigration.test.js test/providerProfile.test.js
```

Expected: exit 1. The first run reports `ERR_MODULE_NOT_FOUND` for `providerSecrets.js` or `providerMigration.js`; after module shells exist, assertions fail until strict v2 normalization, read-back, and redacted migration are implemented.

- [ ] **Step 3: Implement the minimal v2 primitives**

In `providerSecrets.js`, require an initialized host and verify the helper revision on every resolve:

```js
async function resolve(valueRef) {
  const result = await requireHost().secretGet(valueRef.reference);
  if (!result.found) throw providerSecretError('SECRET_NOT_FOUND');
  if (result.revision !== valueRef.revision) throw providerSecretError('SECRET_CONFLICT');
  return result.value;
}
```

For ordinary edits, generate a new reference with a bounded slot, call `secretSet` with `expectedRevision: null`, immediately call `secretGet`, compare value and revision, and return only `{kind:'secret',reference,revision}`. Never return the helper error's `reference` or value in the user-facing error.

In `providerMigration.js`, build this exact generic runner plan:

```js
return runner.run({
  migrationId: 'provider-store-v1-to-v2',
  sourceRevision,
  entries,
  buildRedactedState: (writes) => buildProviderV2State(legacyState, writes, legacyCredentialId),
  validateRedactedState: (state) => validateProviderStateV2(state),
  writeRedactedBackup: (state) => store.writeRedactedBackup(state, { keep: 3, maxAgeDays: 30 }),
  commitRedactedState: (state) => store.replaceState(state),
  cleanupLegacy: () => legacyKeyStore.cleanupCommittedProviderSecrets()
});
```

`buildProviderV2State` initializes `pendingSecretDeletes: []`; migration retries never use that ordinary-edit cleanup queue for partially written migration secrets because the generic migration journal owns those phases.

Use a deterministic UUIDv5 function for legacy provider IDs so a crash before JSON commit cannot choose a different credential namespace. Use file revision/mtime for `sourceRevision`; do not derive it from secret bytes or a secret hash.

In `normalizeProviderEntryV2`, reject literal extra headers when the normalized name matches `/(?:^|[-_])(?:authorization|api[-_]?key|token|secret|password)(?:$|[-_])/i`. Also reject literal values matching any exact credential syntax below; users must store those values through `SecretValueRef`:

```js
const SECRET_LIKE_LITERAL = /^(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})$/;
```

Add schema tests for `x-provider-token: literal`, `x-feature: sk-test-secret-1234`, and a JWT-shaped literal; each throws code `provider_header_secret_reference_required`. Confirm `{name:'x-provider-feature',valueRef:{kind:'literal',value:'enabled'}}` remains valid.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/providerSecrets.test.js test/providerMigration.test.js test/providerProfile.test.js
```

Expected: exit 0; all named tests pass, and serialized references/backups/journals contain no marker secret.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/providerSecrets.js plugin/panel/src/cep/providerMigration.js plugin/panel/src/lib/providerProfile.js plugin/panel/test/providerSecrets.test.js plugin/panel/test/providerMigration.test.js plugin/panel/test/providerProfile.test.js
git commit -m "feat(panel): add provider secret reference primitives"
```

### Task 2: Switch provider persistence, imports, selection, and UI to v2 references

**Files:**

- Create: `plugin/panel/src/app/providerProfileFlow.js`
- Modify: `plugin/panel/src/cep/providerStore.js`
- Modify: `plugin/panel/src/lib/providerManagerState.js`
- Modify: `plugin/panel/src/cep/ccSwitch.js`
- Modify: `plugin/panel/src/cep/claudeSettingsImport.js`
- Modify: `plugin/panel/src/cep/codexConfig.js`
- Modify: `plugin/panel/src/app/App.jsx`
- Modify: `plugin/panel/src/components/settings/ProviderManagerSection.jsx`
- Modify: `plugin/panel/src/lib/channels.js`
- Modify: `plugin/panel/src/lib/backendSelect.js`
- Modify: `plugin/panel/src/cep/claudeAgentBackend.js`
- Modify: `plugin/panel/src/lib/claudeChannel.js`
- Modify: `plugin/panel/src/lib/agentLoop.js`
- Modify: `plugin/panel/src/lib/anthropic.js`
- Modify: `plugin/panel/src/cep/modelsApi.js`
- Modify: `plugin/panel/src/lib/logExport.js`
- Create: `plugin/panel/test/providerProfileFlow.test.js`
- Modify: `plugin/panel/test/providerStore.test.js`
- Modify: `plugin/panel/test/providerManagerState.test.js`
- Modify: `plugin/panel/test/ccSwitch.test.js`
- Modify: `plugin/panel/test/claudeSettingsImport.test.js`
- Modify: `plugin/panel/test/codexConfig.test.js`
- Modify: `plugin/panel/test/channels.test.js`
- Modify: `plugin/panel/test/backendSelect.test.js`
- Modify: `plugin/panel/test/claudeAgentBackend.test.js`
- Modify: `plugin/panel/test/claudeChannel.test.js`
- Modify: `plugin/panel/test/agentLoop.test.js`
- Modify: `plugin/panel/test/anthropic.test.js`
- Modify: `plugin/panel/test/modelsApi.test.js`
- Modify: `plugin/panel/test/logExport.test.js`

**Interfaces:**

- Consumes: Task 1 v2 normalizer/service/migration; platform host readiness from the already-merged platform App wiring.
- Produces: the locked `createProviderStore` API and these orchestration functions:

```js
saveProviderDraft({draft,current,store,secretService,confirmInsecureHttp,randomUUID,randomBytes}):Promise<ProviderEntryV2>
deleteProviderProfile({provider,store,secretService}):Promise<{removed:boolean}>
importProviderDraft({candidate,store,secretService,randomUUID,randomBytes}):Promise<ProviderEntryV2>
drainPendingProviderSecretDeletes({store,secretService}):Promise<{deleted:number,pending:number}>

detectCcSwitch({env,fsImpl}):null|{
  dir:string,
  file:string,
  sourceRevision:string,
  providers:Array<{candidateId:string,name:string,protocol:'openai-compatible'|'anthropic',baseUrl:string,dialectHint:null|'responses'|'chat'}>
}

readCcSwitchProviderDrafts({file,expectedSourceRevision,fsImpl}):Array<{
  candidateId:string,
  name:string,
  protocol:'openai-compatible'|'anthropic',
  baseUrl:string,
  modelAuthKind:'bearer',
  modelAuthSecret:string,
  dialectHint:null|'responses'|'chat'
}>

inspectClaudeSettingsEnv({env,fsImpl}):null|{available:true,baseUrl:string,sourceRevision:string}
readClaudeSettingsProviderDraft({env,expectedSourceRevision,fsImpl}):null|{
  name:string,
  protocol:'anthropic',
  baseUrl:string,
  modelAuthKind:'bearer',
  modelAuthSecret:string
}

codexCliCredentialAvailable({provider,env,storedValueRef}):boolean
resolveCodexCliCredential({provider,env,storedValueRef,secretService}):Promise<string>
```

- Runtime rule: React state holds `ProviderEntryV2` and non-secret availability status only. A resolved raw value may live in a local async call variable but not in state, refs, logs, or callbacks.
- Import rule: cc-switch and Claude settings previews contain no key/token/reference. The confirm handler re-reads the source with the preview's SHA-256 `sourceRevision`, rejects code `provider_import_source_changed` on mismatch, imports each raw value immediately, and discards the draft before updating React state.
- CLI-config rule: App may retain Codex `envKey` and a Boolean availability result, but never `resolveCodexProviderApiKey()` output. Probe/spawn code calls `resolveCodexCliCredential()` into a local variable at the last responsible moment and clears its temporary env object on completion.
- Direct Anthropic HTTP consumes `resolveRequestProfile()` once per model/probe request. Claude Agent SDK resolves a compatible provider only while constructing its spawn environment; custom auth or extra headers force the direct HTTP path.
- Update runtime signatures exactly:

```js
createAgentLoop({
  resolveRequestProfile,
  getModel,
  mcp,
  getPermissionMode,
  getEffort,
  getFast,
  onEvent,
  anthropic?,
  maxToolRounds?,
  lang?
})

sendAnthropicMessage({
  requestProfile,
  model,
  system,
  messages,
  tools,
  signal,
  effort?,
  fast?,
  fetchImpl?,
  onTextDelta?
})

createClaudeAgentBackend({
  resolveApiProvider,
  getChannel,
  resolveNode,
  sidecarPath,
  getMcpSpec,
  getToolMeta,
  getModel,
  getPermissionMode,
  getEffort,
  getThinking,
  onEvent,
  lang,
  spawnImpl,
  env
})
```

- [ ] **Step 1: Write failing store/flow/import/UI-logic tests**

Add a copy-on-write save test with an injected store failure:

```js
function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/' + slot + '/v1',
    revision
  };
}

function providerDraft(overrides = {}) {
  return Object.assign({
    id: '',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    modelAuthKind: 'bearer',
    modelAuthHeaderName: '',
    modelAuthSecret: '',
    probeAuthMode: 'inherit-model',
    probeAuthKind: 'none',
    probeAuthHeaderName: '',
    probeAuthSecret: '',
    headers: [],
    dialectOverride: ''
  }, overrides);
}
```

```js
test('saveProviderDraft deletes a newly-created secret when JSON commit fails', async () => {
  const created = [];
  const deleted = [];
  const secretService = {
    create: async () => {
      const ref = secretRef('auth-model-new', 1);
      created.push(ref.reference);
      return ref;
    },
    delete: async (ref) => {
      deleted.push(ref.reference);
      return { deleted: true, revision: null };
    }
  };
  const store = { upsert: () => { throw new Error('disk full'); } };
  await assert.rejects(
    saveProviderDraft({
      draft: providerDraft({ modelAuthSecret: 'sk-new' }),
      current: null,
      store,
      secretService,
      confirmInsecureHttp: async () => true,
      randomUUID: () => '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2'
    }),
    /disk full/
  );
  assert.deepEqual(deleted, created);
});
```

Add exact persisted-state assertions:

```js
const raw = JSON.parse(deps.files.get('/home/user/.ae-mcp/providers.json'));
assert.equal(raw.version, 2);
assert.deepEqual(raw.pendingSecretDeletes, []);
assert.equal(Object.hasOwn(raw.providers[0], 'apiKey'), false);
assert.equal(JSON.stringify(raw).includes('sk-provider-secret'), false);
assert.match(raw.providers[0].auth.model.valueRef.reference, /^aemcp-secret:\/\//);
```

Add runtime lifetime assertions:

```js
assert.equal(Object.hasOwn(appStateSnapshot, 'apiKey'), false);
assert.equal(Object.hasOwn(appStateSnapshot, 'codexApiKey'), false);
assert.equal(resolveRequestProfileCalls, 1);
assert.equal(fetchCalls[0].headers['x-api-key'], 'resolved-only-for-request');
assert.equal(JSON.stringify(agentEvents).includes('resolved-only-for-request'), false);
assert.equal(JSON.stringify(modelCache).includes('resolved-only-for-request'), false);
```

Add crash-safe cleanup cases. Updating or deleting a profile must commit the new provider state and the replaced `SecretValueRef` values into `pendingSecretDeletes` in the same CAS write. Simulate `secretService.delete` failing after that commit, reconstruct the store, run `drainPendingProviderSecretDeletes`, and prove it deletes idempotently then acknowledges each reference. Assert the journal contains references/revisions only and never the old secret value. Simulate a failure before JSON commit and prove newly created references are deleted immediately while old references are neither deleted nor queued.

`modelsApi` cache keys use provider ID, normalized base URL, and `authProfileRevision`; remove the current API-key suffix from cache identity.

Change `ccSwitchProviderEntries` into a pure non-secret preview mapper; only `readCcSwitchProviderDrafts` returns an ephemeral `modelAuthSecret` plus explicit dialect hint after source-revision validation. Assert `providerStore.upsert` never receives `modelAuthSecret`. Add log redaction:

```js
assert.equal(
  redactSecrets('ref=aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1'),
  'ref=[secret-reference-redacted]'
);
```

Replace the old long-lived import objects with preview-then-read assertions:

```js
const preview = detectCcSwitch({ env, fsImpl });
assert.equal(JSON.stringify(preview).includes('sk-ccswitch-marker'), false);
assert.equal(Object.hasOwn(preview.providers[0], 'secretInput'), false);
assert.match(preview.sourceRevision, /^[a-f0-9]{64}$/);

const draft = readCcSwitchProviderDrafts({
  file: preview.file,
  expectedSourceRevision: preview.sourceRevision,
  fsImpl
})[0];
assert.equal(draft.modelAuthSecret, 'sk-ccswitch-marker');

fsImpl.files.set(preview.file, changedConfigText);
assert.throws(
  () => readCcSwitchProviderDrafts({ file: preview.file, expectedSourceRevision: preview.sourceRevision, fsImpl }),
  (error) => error.code === 'provider_import_source_changed'
);
```

Add the same no-secret preview and source-revision mismatch cases for `inspectClaudeSettingsEnv`/`readClaudeSettingsProviderDraft`. Add a Codex CLI config test proving `codexCliCredentialAvailable` returns only a Boolean and `resolveCodexCliCredential` is not called during App render/channel calculation. Its env/ref resolution occurs exactly once inside a probe or spawn call, and the raw marker is absent from App snapshots, callbacks, and emitted events.

Add an insecure-HTTP confirmation test. A non-loopback `http:` draft with the toggle off fails `provider_insecure_http_forbidden`; with the toggle on, save calls `confirmInsecureHttp({baseUrl,providerId})` and still fails `provider_insecure_http_confirmation_required` when it returns false. It may commit only after true. Editing an already-confirmed entry requires confirmation again when the normalized origin/base path changes or after the toggle has been turned off and back on; loopback HTTP never prompts.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/providerStore.test.js test/providerProfileFlow.test.js test/providerManagerState.test.js test/ccSwitch.test.js test/claudeSettingsImport.test.js test/codexConfig.test.js test/channels.test.js test/backendSelect.test.js test/claudeAgentBackend.test.js test/claudeChannel.test.js test/agentLoop.test.js test/anthropic.test.js test/modelsApi.test.js test/logExport.test.js
```

Expected: exit 1. Existing store persists `apiKey`; imports write secrets directly; channel availability is based on `apiKey`; `providerProfileFlow.js` is absent; the reference URI is visible in exported logs.

- [ ] **Step 3: Implement the production switch atomically**

Implement `providerStore` state revision/CAS, atomic temp-file rename, strict v2 validation, and `needsSecretMigration()`. A v1 file may be read only by `providerMigration`; `list()` must not expose its plaintext `apiKey` to App state.

In `App.jsx`, after platform host status becomes `ok`:

```js
await migrateProviderStoreSecrets({
  store: providerStore,
  legacyKeyStore,
  runner: secretMigrationRunner,
  secretStore: getHost(),
  legacyCredentialId
});
await drainPendingProviderSecretDeletes({
  store: providerStore,
  secretService: providerSecretService
});
setProviders(providerStore.list());
```

Until this resolves, custom provider channels report `checking: true`. For `SECRET_STORE_UNAVAILABLE`, keep the v1 source untouched, report the provider channel unavailable with an actionable repair hint, and do not fall back to the plaintext file.

Replace the cc-switch and Claude settings `useMemo` values with the non-secret preview objects above. Their async click handlers use a `let draft`, re-read by `sourceRevision`, pass it directly to `importProviderDraft`, set `draft = null` in `finally`, and put only returned `ProviderEntryV2` objects into state. Remove `codexCliConfigApiKey` from `App.jsx`; channel calculation uses `codexCliCredentialAvailable`, while model probe and backend spawn receive a resolver function and materialize the value only in their local request/spawn scope.

Provider Manager draft fields must be exact:

```js
{
  id: '',
  name: '',
  protocol: 'openai-compatible',
  baseUrl: '',
  allowInsecureHttp: false,
  modelAuthKind: 'bearer',
  modelAuthHeaderName: '',
  modelAuthSecret: '',
  probeAuthMode: 'inherit-model',
  probeAuthKind: 'none',
  probeAuthHeaderName: '',
  probeAuthSecret: '',
  headers: [],
  dialectOverride: ''
}
```

An empty secret field while editing retains the existing reference. A non-empty field creates a new reference, then commits the new entry plus the replaced reference into `pendingSecretDeletes` in one CAS write. Deletion likewise commits removal plus every removed reference atomically. Delete protected entries afterward and acknowledge each reference in a later CAS write. If cleanup fails, retain only that reference/revision queue and call `drainPendingProviderSecretDeletes` before exposing provider availability on the next startup; idempotent helper deletion makes crash retry safe.

Non-official Anthropic-compatible providers continue through the direct HTTP agent loop rather than the Agent SDK, preserving the existing `backendSelect` branch fix while the selected credential is resolved only for the request lifetime.

- [ ] **Step 4: Run focused tests, build JSX, and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/providerStore.test.js test/providerProfileFlow.test.js test/providerManagerState.test.js test/ccSwitch.test.js test/claudeSettingsImport.test.js test/codexConfig.test.js test/channels.test.js test/backendSelect.test.js test/claudeAgentBackend.test.js test/claudeChannel.test.js test/agentLoop.test.js test/anthropic.test.js test/modelsApi.test.js test/logExport.test.js
./node_modules/.bin/esbuild src/main.jsx --bundle --outfile=/tmp/ae-mcp-panel-provider-route-check.js --format=iife --target=es2019 --jsx=automatic '--define:process.env.NODE_ENV="production"' --loader:.css=css
```

Expected: both commands exit 0. The store tests prove no secret value persists; channel tests use reference/availability status; JSX compiles to `/tmp` with the new form props and does not modify tracked bundle files.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/app/providerProfileFlow.js plugin/panel/src/cep/providerStore.js plugin/panel/src/lib/providerManagerState.js plugin/panel/src/cep/ccSwitch.js plugin/panel/src/cep/claudeSettingsImport.js plugin/panel/src/cep/codexConfig.js plugin/panel/src/app/App.jsx plugin/panel/src/components/settings/ProviderManagerSection.jsx plugin/panel/src/lib/channels.js plugin/panel/src/lib/backendSelect.js plugin/panel/src/cep/claudeAgentBackend.js plugin/panel/src/lib/claudeChannel.js plugin/panel/src/lib/agentLoop.js plugin/panel/src/lib/anthropic.js plugin/panel/src/cep/modelsApi.js plugin/panel/src/lib/logExport.js plugin/panel/test/providerProfileFlow.test.js plugin/panel/test/providerStore.test.js plugin/panel/test/providerManagerState.test.js plugin/panel/test/ccSwitch.test.js plugin/panel/test/claudeSettingsImport.test.js plugin/panel/test/codexConfig.test.js plugin/panel/test/channels.test.js plugin/panel/test/backendSelect.test.js plugin/panel/test/claudeAgentBackend.test.js plugin/panel/test/claudeChannel.test.js plugin/panel/test/agentLoop.test.js plugin/panel/test/anthropic.test.js plugin/panel/test/modelsApi.test.js plugin/panel/test/logExport.test.js
git commit -m "feat(panel): persist provider profiles without plaintext secrets"
```

### Task 3: Add verified dialect detection and explicit cache invalidation

> **Implementation correction (2026-07-11):** A Provider may contain heterogeneous models. `/v1/models` only supplies the selectable IDs; it does not select a dialect. Detection and cache lookup are keyed by the exact, explicit current `modelId`: send a valid minimal Responses request first, then a valid minimal Chat Completions request only if Responses is not schema-valid. Cache entries for other model IDs are preserved. Legacy Provider-level `detected` objects, missing-field `{model}` probes, and examples below that couple model enumeration to dialect detection are superseded and must fail closed rather than route all models alike.

**Files:**

- Create: `plugin/panel/src/cep/providerDetect.js`
- Create: `plugin/panel/src/app/providerProbeFlow.js`
- Create: `plugin/panel/src/lib/providerDialectBadge.js`
- Modify: `plugin/panel/src/cep/modelProbe.js`
- Modify: `plugin/panel/src/app/App.jsx`
- Modify: `plugin/panel/src/components/settings/ProviderManagerSection.jsx`
- Modify: `plugin/panel/src/cep/ccSwitch.js`
- Create: `plugin/panel/test/providerDetect.test.js`
- Create: `plugin/panel/test/providerProbeFlow.test.js`
- Create: `plugin/panel/test/providerDialectBadge.test.js`
- Modify: `plugin/panel/test/modelProbe.test.js`
- Modify: `plugin/panel/test/ccSwitch.test.js`

**Interfaces:**

- Consumes: `resolveProviderRequestProfile(provider,{scope,secretService})`, `buildProviderEndpoint`, `parseModelsList`.
- Produces: locked `detectProviderDialect` and `effectiveProviderDialect` signatures.
- Detection never guesses auth. `/v1/models` uses the resolved `probe` profile; endpoint semantics use the resolved `model` profile.

- [ ] **Step 1: Write failing positive, false-positive, cache, and scope tests**

Use a request fake that records only method/path/header names in the returned `tried` structure. Add this exact generic-400 negative:

```js
function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: [] },
    probedModels: [],
    probedAt: 0
  }, overrides);
}

function jsonResult(status, value, headers = { 'content-type': 'application/json' }) {
  return { status, headers, body: JSON.stringify(value) };
}

function sequenceRequest(results) {
  const queue = results.slice();
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    if (queue.length === 0) throw new Error('unexpected provider request');
    return queue.shift();
  };
  request.calls = calls;
  return request;
}

function resolvedProfiles() {
  return async (provider, { scope }) => ({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    allowInsecureHttp: false,
    auth: scope === 'probe'
      ? { kind: 'header', name: 'x-probe-token', value: 'probe-value' }
      : { kind: 'header', name: 'Authorization', value: 'Bearer model-value' },
    extraHeaders: [],
    authProfileRevision: provider.authProfileRevision
  });
}

test('generic JSON 400 is not Responses evidence', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-1' }] }),
    jsonResult(400, { error: { message: 'unsupported parameter' } }),
    jsonResult(422, { error: { param: 'messages', code: 'missing_required_parameter' } })
  ]);
  const result = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
    now: () => 1000
  });
  assert.equal(result.ok, true);
  assert.equal(result.dialect.wireApi, 'chat');
  assert.equal(result.dialect.evidence, 'chat-missing-messages');
  const calls = requestImpl.calls;
  assert.equal(calls.length, 3);
});
```

Add HTML, WAF, redirect, valid Responses object, `param: input`, authentication 401/403, network, models 404, explicit override, base URL change, auth revision change, and 24-hour expiry tests. Assert probe and model headers differ:

```js
test('uses probe auth for models and model auth for endpoint semantics', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-1' }] }),
    jsonResult(422, { error: { param: 'input', code: 'missing_required_parameter' } })
  ]);
  const result = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
    now: () => 1000
  });
  const calls = requestImpl.calls;
  assert.equal(calls[0].headers['x-probe-token'], 'probe-value');
  assert.equal(calls[1].headers.authorization, 'Bearer model-value');
  assert.equal(JSON.stringify(result).includes('probe-value'), false);
  assert.equal(JSON.stringify(result).includes('model-value'), false);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/providerDetect.test.js test/providerProbeFlow.test.js test/providerDialectBadge.test.js test/modelProbe.test.js test/ccSwitch.test.js
```

Expected: exit 1. On `main`, the new modules are absent. If the PR #51 implementation is temporarily copied as a starting point, the generic JSON 400 test fails because it incorrectly returns `responses`.

- [ ] **Step 3: Implement schema-specific per-model detection and cache selection**

Require a non-empty explicit current `modelId`. For Responses, send a valid minimal request such as `{model,input:'OK',max_output_tokens:16,stream:false}` and accept only HTTP 200 with the known Responses success schema. Only if that fails, send a valid minimal Chat request such as `{model,messages:[{role:'user',content:'OK'}],max_tokens:4,stream:false}` and accept only HTTP 200 with the known Chat Completion success schema. Missing-field errors, generic JSON errors, and `/models` success are not dialect evidence.

`effectiveProviderDialect` returns a deliberate manual override first. Otherwise it requires an exact case-sensitive `modelId` match, exact normalized base URL, equal `authProfileRevision`, non-future timestamp, and age no greater than `86_400_000` ms. Detection failure returns a reason/detail but leaves stored entries for all models untouched; the UI displays `unconfirmed` when the current model has no effective result. A successful detection replaces only the matching model entry.

Treat cc-switch `wire_api`/`apiFormat` only as non-authoritative preview metadata. Import never persists it as a Provider-wide override; the user must explicitly choose the global manual override or detect each selected model.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/providerDetect.test.js test/providerProbeFlow.test.js test/providerDialectBadge.test.js test/modelProbe.test.js test/ccSwitch.test.js
./node_modules/.bin/esbuild src/main.jsx --bundle --outfile=/tmp/ae-mcp-panel-provider-detect-check.js --format=iife --target=es2019 --jsx=automatic '--define:process.env.NODE_ENV="production"' --loader:.css=css
```

Expected: both commands exit 0. Generic 400, HTML, WAF, and redirect cases stay unconfirmed; exact endpoint semantics and cache invalidation pass; JSX compiles without modifying tracked bundle files.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/providerDetect.js plugin/panel/src/app/providerProbeFlow.js plugin/panel/src/lib/providerDialectBadge.js plugin/panel/src/cep/modelProbe.js plugin/panel/src/app/App.jsx plugin/panel/src/components/settings/ProviderManagerSection.jsx plugin/panel/src/cep/ccSwitch.js plugin/panel/test/providerDetect.test.js plugin/panel/test/providerProbeFlow.test.js plugin/panel/test/providerDialectBadge.test.js plugin/panel/test/modelProbe.test.js plugin/panel/test/ccSwitch.test.js
git commit -m "feat(panel): verify provider dialect without false positives"
```

### Task 4: Build a fail-closed Responses-to-Chat codec from fixed Codex fixtures

**Files:**

- Create: `plugin/panel/src/lib/codexResponsesCodec.js`
- Create: `plugin/panel/test/codexResponsesCodec.test.js`
- Create: `plugin/panel/test/fixtures/codex/responses-request-supported.json`
- Create: `plugin/panel/test/fixtures/codex/responses-request-unsupported-image.json`
- Create: `plugin/panel/test/fixtures/codex/chat-completion.json`
- Create: `plugin/panel/test/fixtures/codex/chat-completion.sse`
- Create: `plugin/panel/test/fixtures/codex/responses-stream.expected.sse`
- Reference only: `origin/feat/provider-dialect-autodetect:plugin/panel/src/cep/codexResponsesRoute.js`

**Interfaces:**

- Consumes: JSON-compatible Responses request bodies and Chat Completion JSON/SSE frames.
- Produces: locked `responsesBodyToChatBody`, `chatCompletionToResponse`, and `createChatSseToResponses` signatures.
- Error contract:

```js
{
  name: 'ResponsesCompatibilityError',
  status: 501,
  code: 'unsupported_responses_field',
  param: 'input[0].content[0].type',
  message: 'Unsupported Responses field: input[0].content[0].type'
}
```

Malformed values for fields the facade does support remain `400 invalid_responses_field`; the `501` contract is reserved for fields or capabilities that cannot be represented without loss.

- [ ] **Step 1: Write the supported request and exact conversion fixtures**

`responses-request-supported.json` must contain every supported category in one deterministic fixture:

```json
{
  "model": "fixture-model",
  "instructions": "Keep the answer short.",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Check the composition." }
      ]
    },
    {
      "type": "function_call",
      "call_id": "call_1",
      "name": "ae_overview",
      "arguments": "{}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_1",
      "output": "{\"ok\":true}"
    }
  ],
  "max_output_tokens": 128,
  "temperature": 0.2,
  "top_p": 0.9,
  "tools": [
    {
      "type": "function",
      "name": "ae_overview",
      "description": "Read project state",
      "parameters": { "type": "object", "properties": {} },
      "strict": true
    }
  ],
  "tool_choice": { "type": "function", "name": "ae_overview" },
  "parallel_tool_calls": false,
  "stream": true
}
```

Write tests that deep-equal the complete Chat request, non-streaming Responses output, and the full emitted SSE fixture. Add table-driven rejections for these exact parameter paths:

```js
const imageRequest = {
  model: 'm',
  input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }]
};
const audioRequest = {
  model: 'm',
  input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }]
};
const fileRequest = {
  model: 'm',
  input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }]
};
const hostedToolRequest = {
  model: 'm',
  input: 'x',
  tools: [{ type: 'web_search_preview' }]
};
const unknownOutputRequest = {
  model: 'm',
  input: [{ type: 'computer_call', id: 'item_1' }]
};
const rejected = [
  ['image input', imageRequest, 'input[0].content[0].type'],
  ['audio input', audioRequest, 'input[0].content[0].type'],
  ['file input', fileRequest, 'input[0].content[0].type'],
  ['hosted tool', hostedToolRequest, 'tools[0].type'],
  ['conversation', { model: 'm', input: 'x', conversation: 'c1' }, 'conversation'],
  ['previous response', { model: 'm', input: 'x', previous_response_id: 'r1' }, 'previous_response_id'],
  ['background', { model: 'm', input: 'x', background: true }, 'background'],
  ['unknown top-level field', { model: 'm', input: 'x', store: false }, 'store'],
  ['unknown output item', unknownOutputRequest, 'input[0].type']
];
for (const [name, body, param] of rejected) {
  test('rejects ' + name, () => {
    assert.throws(
      () => responsesBodyToChatBody(body),
      (error) => error.code === 'unsupported_responses_field' && error.param === param
    );
  });
}
```

- [ ] **Step 2: Run codec tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/codexResponsesCodec.test.js
```

Expected: exit 1 with `ERR_MODULE_NOT_FOUND` before implementation. If the PR #51 converter is used as a starting point, rejection tests fail because that converter silently ignores unsupported fields and reasoning items.

- [ ] **Step 3: Implement explicit validation before conversion**

Use exact top-level allowed fields:

```js
const SUPPORTED_RESPONSE_FIELDS = new Set([
  'model',
  'instructions',
  'input',
  'max_output_tokens',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream'
]);
```

Validate the entire tree before returning a Chat body. Supported input is a string or an array of text messages, `function_call`, and `function_call_output`. Supported tools are function tools only. Supported `tool_choice` values are `auto`, `none`, `required`, or `{type:'function',name}`. `max_output_tokens` maps to `max_tokens`; no undocumented aliases are accepted.

For SSE, require each non-comment event frame to stay within `maxFrameBytes`, parse every `data:` JSON frame, emit deterministic Responses events, and fail on malformed JSON rather than ignoring it. Finish text and function calls before the final `response.completed` event.

- [ ] **Step 4: Run codec tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/codexResponsesCodec.test.js
```

Expected: exit 0; the exact fixture comparison and every unsupported-field path pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/lib/codexResponsesCodec.js plugin/panel/test/codexResponsesCodec.test.js plugin/panel/test/fixtures/codex/responses-request-supported.json plugin/panel/test/fixtures/codex/responses-request-unsupported-image.json plugin/panel/test/fixtures/codex/chat-completion.json plugin/panel/test/fixtures/codex/chat-completion.sse plugin/panel/test/fixtures/codex/responses-stream.expected.sse
git commit -m "feat(panel): add fail-closed Responses chat codec"
```

### Task 5: Enforce facade endpoints, methods, URL safety, base paths, and query preservation

**Files:**

- Create: `plugin/panel/src/lib/providerUrl.js`
- Create: `plugin/panel/src/cep/codexResponsesRoute.js`
- Create: `plugin/panel/test/providerUrl.test.js`
- Create: `plugin/panel/test/codexResponsesRoute.endpoint.test.js`
- Create: `plugin/panel/test/helpers/providerRouteFixtures.js`
- Reference only: `origin/feat/provider-dialect-autodetect:plugin/panel/src/cep/codexResponsesRoute.js`

**Interfaces:**

- Consumes: Task 4 codec and a non-secret `ProviderEntryV2`.
- Produces: locked `buildProviderEndpoint` and `createCodexResponsesRoute` signatures.
- This task deliberately does not connect the route to `codexBackend`; Tasks 6 through 8 must secure it first.

- [ ] **Step 1: Write failing endpoint and URL policy tests**

Test this exact routing table:

| Local request | Chat-only upstream | Expected |
|---|---|---|
| `GET /v1/models?after=m1&limit=10` | `GET <base>/v1/models?after=m1&limit=10` | transparent status/body, response headers filtered later |
| `POST /v1/responses?api-version=2026-01-01` | `POST <base>/v1/chat/completions?api-version=2026-01-01` | codec conversion |
| `POST /v1/responses/compact` | no upstream | conservative 501 `unsupported_endpoint`; Task 9 replaces it with the required provider-specific contract |
| `POST /v1/chat/completions` | no upstream | 404 |
| `GET /v1/responses` | no upstream | 405 with `Allow: POST` |
| `POST /v1/models` | no upstream | 405 with `Allow: GET` |
| `GET /unknown` | no upstream | 404 |

Add exact base-path and security assertions:

```js
function hasCode(code) {
  return (error) => Boolean(error && error.code === code);
}

assert.equal(
  buildProviderEndpoint({
    baseUrl: 'https://relay.example/openai/',
    resource: 'models',
    inboundSearch: '?after=m1&limit=10'
  }).toString(),
  'https://relay.example/openai/v1/models?after=m1&limit=10'
);

assert.equal(
  buildProviderEndpoint({
    baseUrl: 'https://relay.example/openai/v1',
    resource: 'chat-completions',
    inboundSearch: '?api-version=2026-01-01'
  }).toString(),
  'https://relay.example/openai/v1/chat/completions?api-version=2026-01-01'
);

assert.throws(() => buildProviderEndpoint({
  baseUrl: 'https://user:pass@relay.example/v1',
  resource: 'models'
}), hasCode('provider_url_userinfo_forbidden'));

assert.throws(() => buildProviderEndpoint({
  baseUrl: 'http://relay.example/v1',
  resource: 'models'
}), hasCode('provider_insecure_http_forbidden'));

assert.equal(
  buildProviderEndpoint({
    baseUrl: 'http://lab-relay.example/openai',
    resource: 'models',
    allowInsecureHttp: true
  }).toString(),
  'http://lab-relay.example/openai/v1/models'
);
```

Cover `127.0.0.0/8`, `localhost`, `.localhost`, `::1`, and IPv4-mapped loopback as allowed HTTP loopback hosts. Cover non-loopback HTTP as rejected unless `allowInsecureHttp === true`; Task 2 is the only place that can persist that flag and it requires a fresh UI confirmation. Cover protocol-relative URLs, fragments, raw/percent-encoded `..`, and a final-origin mismatch as rejected.

Create `plugin/panel/test/helpers/providerRouteFixtures.js` with the shared route-test helpers so later task snippets use one exact implementation:

```js
import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createCodexResponsesRoute } from '../../src/cep/codexResponsesRoute.js';

export function deterministicCrypto(byte = 0x5a) {
  return {
    randomBytes: (size) => Buffer.alloc(size, byte),
    createHash,
    timingSafeEqual
  };
}

export function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: [] },
    probedModels: [],
    probedAt: 0
  }, overrides);
}

export function resolvedModelProfile(overrides = {}) {
  return Object.assign({
    providerId: 'provider-1',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    auth: { kind: 'none' },
    extraHeaders: [],
    authProfileRevision: 1
  }, overrides);
}

export function routeFixture(overrides = {}) {
  return createCodexResponsesRoute(Object.assign({
    provider: providerFixture(),
    resolveRequestProfile: async () => resolvedModelProfile(),
    requireImpl: (name) => name === 'http' ? http : https,
    cryptoImpl: deterministicCrypto()
  }, overrides));
}

export function requestText(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const req = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname + endpoint.search,
      method,
      headers
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
```

- [ ] **Step 2: Run endpoint tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/providerUrl.test.js test/codexResponsesRoute.endpoint.test.js
```

Expected: exit 1 with absent modules. If the PR #51 route is copied first, the query/base-path assertions fail because it strips the local query and rebuilds a simplified `/v1` root.

- [ ] **Step 3: Implement URL validation and exact dispatch**

Parse the raw local request URL once against a loopback dummy origin, but reject encoded traversal before URL normalization. Dispatch by exact pathname and method; unknown routes never become a general reverse proxy.

`buildProviderEndpoint` must preserve the configured prefix, add exactly one `/v1`, append only a fixed resource suffix, copy the incoming query in order, clear fragments, and re-check that final `origin` equals configured `origin`. HTTPS and loopback HTTP are accepted by default; non-loopback HTTP is accepted only when the already-confirmed profile passes `allowInsecureHttp: true`. No request-local input can set that flag.

Return errors in this exact envelope:

```js
{
  error: {
    type: 'invalid_request_error',
    code: 'method_not_allowed',
    message: 'Method GET is not allowed for /v1/responses.'
  }
}
```

For upstream 3xx, do not follow and do not copy `Location`; Task 8 converts it to `provider_redirect_blocked`. Until Task 9, compact fails closed with status 501 and code `unsupported_endpoint`, without reading its body, resolving a secret, or calling upstream.

- [ ] **Step 4: Run endpoint tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/providerUrl.test.js test/codexResponsesRoute.endpoint.test.js
```

Expected: exit 0; exact endpoint/method/query/base-path assertions pass and no `/v1/chat/completions` local entry exists.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/lib/providerUrl.js plugin/panel/src/cep/codexResponsesRoute.js plugin/panel/test/providerUrl.test.js plugin/panel/test/codexResponsesRoute.endpoint.test.js plugin/panel/test/helpers/providerRouteFixtures.js
git commit -m "feat(panel): enforce provider facade endpoint contract"
```

### Task 6: Enforce request-header precedence, deny lists, limits, and response allowlist

**Files:**

- Create: `plugin/panel/src/lib/providerHeaders.js`
- Modify: `plugin/panel/src/cep/codexResponsesRoute.js`
- Create: `plugin/panel/test/providerHeaders.test.js`
- Create: `plugin/panel/test/codexResponsesRoute.headers.test.js`

**Interfaces:**

- Consumes: Node `req.rawHeaders`, resolved provider extra headers, and one resolved auth policy.
- Produces: locked `collectCodexHeaders`, `mergeUpstreamHeaders`, and `filterUpstreamResponseHeaders` signatures.
- Merge order is safe Codex metadata, then provider extras, then the single auth-layer header. Final validation runs after every layer and immediately before `http.request`/`https.request`.
- Scope selection is exact: authenticated `GET /v1/models` resolves `{scope:'probe'}` once; authenticated `POST /v1/responses` resolves `{scope:'model'}` once. Rejected endpoint/method/auth requests and compact resolve neither.

- [ ] **Step 1: Write failing allowlist, denylist, precedence, duplicate, and limit tests**

Allowed inbound exact names are case-insensitive:

```js
const INBOUND_EXACT = new Set([
  'accept',
  'content-type',
  'openai-beta',
  'user-agent',
  'x-client-request-id',
  'x-request-id',
  'traceparent',
  'tracestate'
]);
```

Allowed prefixes are `x-stainless-` and `x-codex-`. Test case-insensitive names, prefix boundary, and supported JSON media types `application/json` and `application/*+json` with optional UTF-8 charset.

Add a precedence test:

```js
const merged = mergeUpstreamHeaders({
  rawHeaders: [
    'User-Agent', 'codex/1.2.3',
    'X-Codex-Version', '1.2.3',
    'Content-Type', 'application/json'
  ],
  providerHeaders: [
    { name: 'user-agent', value: 'provider-agent', source: 'literal' },
    { name: 'x-provider-feature', value: 'enabled', source: 'literal' }
  ],
  auth: { kind: 'header', name: 'x-api-key', value: 'provider-secret' },
  contentType: 'application/json'
});
assert.equal(merged['user-agent'], 'provider-agent');
assert.equal(merged['x-codex-version'], '1.2.3');
assert.equal(merged['x-provider-feature'], 'enabled');
assert.equal(merged['x-api-key'], 'provider-secret');
assert.equal(Object.hasOwn(merged, 'authorization'), false);
```

Add an integration test with disjoint `x-probe-feature` and `x-model-feature` headers. `/v1/models` must send only the probe header/auth and `/v1/responses` only the model header/auth; each request resolves its profile exactly once, and neither audit record contains a value.

Add individual rejections for:

- `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade`, `Keep-Alive`, `TE`, `Trailer`, `Expect`.
- `Cookie`, `Set-Cookie`, `Forwarded`, `X-Forwarded-*`, `Proxy-*`, `Sec-*`.
- `Authorization`, `x-api-key`, the selected custom auth header, local route-auth aliases, and routing-control names when supplied as provider extras.
- CR, LF, NUL, non-RFC-token names, duplicate single-value headers, 8 KiB plus one byte, 32 KiB plus one byte, and 65 fields.
- Credential-like extra-header names backed by a literal and literal values shaped as Bearer, Basic, `sk-`, or JWT credentials; each must use a secret reference before runtime resolution.

Exercise the structural/name/value/byte-limit cases at every applicable merge source: Codex inbound metadata, provider extra headers, and custom-auth configuration. A configured custom auth name such as `Host`, `Cookie`, `Proxy-Authorization`, `x-ae-mcp-route-token`, or a non-token/CRLF name must fail before secret resolution or upstream request creation. The one ordinary Node-generated inbound `Host` field is consumed by the local server and never forwarded; duplicate or malformed inbound Host fields are rejected.

Response tests must retain only `content-type`, `cache-control`, `retry-after`, `x-request-id`, `request-id`, `openai-request-id`, `x-goog-request-id`, `x-amzn-requestid`, `ratelimit-*`, and `x-ratelimit-*`; explicitly reject `set-cookie`, `connection`, `www-authenticate`, and unknown `x-provider-auth`.

- [ ] **Step 2: Run header tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/providerHeaders.test.js test/codexResponsesRoute.headers.test.js
```

Expected: exit 1. The PR #51 behavior sends only auth and `Content-Type`, drops required `x-codex-*`, accepts unsafe provider names, and copies all upstream response headers.

- [ ] **Step 3: Implement byte-accurate validation and audited merging**

Validate RFC token names with:

```js
const RFC_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
```

Measure UTF-8 values and aggregate `name + ': ' + value` bytes. Reject duplicates by inspecting `rawHeaders`, not Node's coalesced `req.headers`. Ignore Node-generated inbound `Host` rather than forwarding it; provider-configured `Host` remains a hard error.

Re-run the same sensitive-name and secret-like-literal predicates during final provider-header validation even though v2 normalization already applied them. `resolveProviderRequestProfile` preserves each extra header's `source: 'literal'|'secret'`; reject a sensitive name or secret-like value only when `source !== 'secret'`. This second check prevents a hand-constructed runtime profile from bypassing persistence validation without rejecting a correctly resolved secret reference.

Emit audit data containing names and decisions only:

```js
onAudit({
  event: 'provider_headers',
  requestId,
  forwardedNames: ['openai-beta', 'x-codex-version'],
  providerNames: ['x-provider-feature'],
  authName: 'x-api-key',
  decision: 'allowed'
});
```

Never pass header values, value hashes, or secret references to `onAudit`.

- [ ] **Step 4: Run header tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/providerHeaders.test.js test/codexResponsesRoute.headers.test.js
```

Expected: exit 0; required Codex metadata reaches upstream, provider precedence/auth ownership is exact, and unsafe/oversized/duplicate headers fail before upstream request creation.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/lib/providerHeaders.js plugin/panel/src/cep/codexResponsesRoute.js plugin/panel/test/providerHeaders.test.js plugin/panel/test/codexResponsesRoute.headers.test.js
git commit -m "feat(panel): enforce provider header policy"
```

### Task 7: Add a 256-bit ephemeral route token and zero-side-effect 401 handling

**Files:**

- Create: `plugin/panel/src/cep/providerRouteAuth.js`
- Modify: `plugin/panel/src/cep/codexResponsesRoute.js`
- Create: `plugin/panel/test/providerRouteAuth.test.js`
- Create: `plugin/panel/test/codexResponsesRoute.token.test.js`

**Interfaces:**

- Consumes: Node crypto `randomBytes`, `createHash`, and `timingSafeEqual` through injection.
- Produces: locked token helper signatures and `start(): Promise<{baseUrl,routeToken}>`.
- Authorization must run before endpoint-specific secret resolution. The server remains bound to `127.0.0.1`.

- [ ] **Step 1: Write failing token generation, parser, lifecycle, and zero-side-effect tests**

In `codexResponsesRoute.token.test.js`, import the route and shared fixtures explicitly:

```js
import http from 'node:http';
import https from 'node:https';
import { createCodexResponsesRoute } from '../src/cep/codexResponsesRoute.js';
import {
  deterministicCrypto,
  providerFixture,
  requestText,
  resolvedModelProfile
} from './helpers/providerRouteFixtures.js';
```

Add deterministic token tests:

```js
test('generateRouteToken uses exactly 32 random bytes and base64url', () => {
  let requested = 0;
  const token = generateRouteToken({
    randomBytes(size) {
      requested = size;
      return Buffer.alloc(size, 0xab);
    }
  });
  assert.equal(requested, 32);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token.includes('='), false);
});
```

Add parser cases for missing header, wrong scheme, comma/coalesced values, duplicate Authorization, leading/trailing whitespace, multiple spaces, and case-insensitive `Bearer`. Add a crypto spy proving equal-size digests reach `timingSafeEqual` for both same-length and different-length candidate strings.

The route test must count every forbidden side effect:

```js
const counts = { resolve: 0, request: 0, dns: 0 };
const route = createCodexResponsesRoute({
  provider: providerFixture(),
  resolveRequestProfile: async () => {
    counts.resolve += 1;
    return resolvedModelProfile();
  },
  requireImpl: (name) => name === 'http' ? http : https,
  createUpstreamRequest: () => {
    counts.request += 1;
    throw new Error('unauthorized request reached upstream creation');
  },
  lookupImpl: () => {
    counts.dns += 1;
    throw new Error('unauthorized request reached DNS');
  },
  cryptoImpl: deterministicCrypto()
});
const local = await route.start();
const denied = await requestText(local.baseUrl + '/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"model":"m","input":"x"}'
});
assert.equal(denied.status, 401);
assert.deepEqual(counts, { resolve: 0, request: 0, dns: 0 });
```

Repeat with a wrong token and with an unknown path. Test `close()` then `start()` with sequential random bytes; old token must receive 401 after restart.

- [ ] **Step 2: Run token tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/providerRouteAuth.test.js test/codexResponsesRoute.token.test.js
```

Expected: exit 1. The PR #51 route creates a short `Math.random()` token, never validates it, and calls upstream for missing/wrong auth.

- [ ] **Step 3: Implement fixed Bearer parsing and digest comparison**

Generate once during each server lifetime and store only in the route closure. Parse exactly one Authorization field with exactly one ASCII space between scheme and token. Compare SHA-256 digests:

```js
export function routeTokenMatches(candidate, expected, { createHash, timingSafeEqual }) {
  const left = createHash('sha256').update(String(candidate), 'utf8').digest();
  const right = createHash('sha256').update(String(expected), 'utf8').digest();
  return timingSafeEqual(left, right);
}
```

At the start of the server callback, authenticate before dispatch. Return:

```js
{
  error: {
    type: 'authentication_error',
    code: 'invalid_route_token',
    message: 'Invalid local provider route token.'
  }
}
```

Do not include `WWW-Authenticate`, the candidate, expected token, or a token digest. `close()` sets the closure token to `null` after the listener closes.

- [ ] **Step 4: Run token tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/providerRouteAuth.test.js test/codexResponsesRoute.token.test.js
```

Expected: exit 0; every unauthorized path returns 401 with resolve/request/DNS counts at zero, and lifecycle rotation invalidates the old token.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/providerRouteAuth.js plugin/panel/src/cep/codexResponsesRoute.js plugin/panel/test/providerRouteAuth.test.js plugin/panel/test/codexResponsesRoute.token.test.js
git commit -m "feat(panel): authenticate local provider facade"
```

### Task 8: Bound body, headers, streams, concurrency, timeouts, redirects, cancellation, and error bodies

**Files:**

- Modify: `plugin/panel/src/cep/codexResponsesRoute.js`
- Modify: `plugin/panel/src/lib/codexResponsesCodec.js`
- Create: `plugin/panel/test/codexResponsesRoute.resource.test.js`
- Modify: `plugin/panel/test/codexResponsesCodec.test.js`

**Interfaces:**

- Consumes: `DEFAULT_ROUTE_LIMITS`, authenticated request dispatch, safe URL/header builders, and the codec stream adapter.
- Produces: bounded request/upstream lifecycle with exact codes below.
- Tests inject small limits and short timers; production defaults remain the locked design values.

- [ ] **Step 1: Write failing boundary and lifecycle tests**

Import `once` from `node:events` and build upstream request/response fakes from `EventEmitter`; the fake request's idempotent `destroy()` increments `destroyCalls` and emits `destroyed` so cancellation assertions cannot pass on timing alone.

Use an injected limit object so tests complete quickly:

```js
const TEST_LIMITS = {
  requestBodyBytes: 32,
  sseFrameBytes: 24,
  concurrent: 2,
  connectTimeoutMs: 25,
  idleTimeoutMs: 30,
  totalTimeoutMs: 60,
  errorBodyBytes: 40,
  headerValueBytes: 64,
  headerTotalBytes: 256,
  headerCount: 8
};
```

Write exact limit tests:

- 32-byte body is accepted; 33-byte body returns 413 `request_body_too_large` and creates no upstream request.
- Two delayed authenticated requests are admitted; the third returns 429 `route_concurrency_limit`; completing one admits the next.
- A request that never emits an upstream response hits `provider_connect_timeout` at the injected connect limit.
- A stream that emits headers and then stays silent hits `provider_idle_timeout`; each received byte resets only the idle timer.
- A continuously active stream still ends at `provider_total_timeout`.
- A 24-byte SSE frame is accepted; a 25-byte frame emits one Responses `error` event with `upstream_sse_frame_too_large`, destroys upstream, and ends.
- Client `aborted` and response `close` destroy upstream exactly once and release concurrency exactly once.
- Each 3xx response returns 502 `provider_redirect_blocked`, does not copy `Location`, and makes no second request.
- A 40-byte error body is parsed; a 41-byte body is truncated without passing raw text to UI.
- Provider error text containing auth and configured header values returns a redacted message.

Key cancellation assertion:

```js
clientRequest.destroy();
await once(upstreamRequest, 'destroyed');
assert.equal(upstreamRequest.destroyCalls, 1);
assert.equal(routeStats.active, 0);
```

Key error-body assertion:

```js
assert.equal(result.status, 502);
assert.equal(result.body.error.code, 'provider_error');
assert.doesNotMatch(JSON.stringify(result.body), /sk-model-secret/);
assert.doesNotMatch(JSON.stringify(result.body), /x-provider-secret-value/);
assert.equal(JSON.stringify(result.body).length < 1024, true);
```

- [ ] **Step 2: Run resource tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/codexResponsesRoute.resource.test.js test/codexResponsesCodec.test.js
```

Expected: exit 1. The PR #51 route reads unbounded body/error strings, has no concurrency or timers, ignores malformed/oversized SSE, and relies only on Node's no-follow behavior without returning a controlled redirect error.

- [ ] **Step 3: Implement single-owner lifecycle cleanup**

Track each admitted request with a context that owns timers, upstream request, active counter, and a `finished` flag:

```js
function finishOnce(context) {
  if (context.finished) return false;
  context.finished = true;
  clearTimeout(context.connectTimer);
  clearTimeout(context.idleTimer);
  clearTimeout(context.totalTimer);
  context.gate.release();
  return true;
}
```

Read request bodies as byte buffers and reject as soon as the next chunk crosses the limit. Start the connect timer immediately before `requestImpl.request`; replace it with the idle timer after upstream headers. Start total timer at admission. On client close/abort, destroy upstream and call `finishOnce`.

Do not automatically follow redirects. Convert all 3xx statuses to:

```js
{
  error: {
    type: 'provider_protocol_error',
    code: 'provider_redirect_blocked',
    message: 'Provider redirects are not followed.'
  }
}
```

Read at most `errorBodyBytes + 1`, destroy the upstream stream when exceeded, parse JSON when content type is JSON, redact every resolved auth/extra-header value in memory, and expose at most a generic provider message plus status/request ID. Never forward the original body verbatim.

Use these exact status/code mappings:

| Condition | Local status | Code |
|---|---:|---|
| body too large | 413 | `request_body_too_large` |
| concurrency full | 429 | `route_concurrency_limit` |
| connect timeout | 504 | `provider_connect_timeout` |
| idle timeout | 504 | `provider_idle_timeout` |
| total timeout | 504 | `provider_total_timeout` |
| redirect | 502 | `provider_redirect_blocked` |
| bounded provider error | 502 or original 4xx | `provider_error` |

For a streaming response whose headers were already sent, emit one `event: error` with the exact code and close; do not attempt a second JSON response.

- [ ] **Step 4: Run resource tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/codexResponsesRoute.resource.test.js test/codexResponsesCodec.test.js
```

Expected: exit 0; every exact boundary, timeout, redirect, cancellation, truncation, and redaction assertion passes without a test exceeding one second.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/cep/codexResponsesRoute.js plugin/panel/src/lib/codexResponsesCodec.js plugin/panel/test/codexResponsesRoute.resource.test.js plugin/panel/test/codexResponsesCodec.test.js
git commit -m "feat(panel): bound provider facade resources"
```

### Task 9: Close compact semantics and connect native/facade profiles to Codex

**Files:**

- Modify: `plugin/panel/src/lib/providerProfile.js`
- Modify: `plugin/panel/src/cep/codexBackend.js`
- Modify: `plugin/panel/src/app/App.jsx`
- Modify: `plugin/panel/src/lib/channels.js`
- Modify: `plugin/panel/src/cep/codexResponsesRoute.js`
- Create: `plugin/panel/test/codexResponsesRoute.compact.test.js`
- Modify: `plugin/panel/test/providerProfile.test.js`
- Modify: `plugin/panel/test/codexBackend.test.js`
- Modify: `plugin/panel/test/channels.test.js`

**Interfaces:**

- Consumes: effective provider dialect, resolved model request profile, secured facade, platform-completed spawn environment.
- Produces: `codexAppServerArgs`/`codexSpawnEnv` locked runtime signatures, chat-only facade lifecycle, and exact compact behavior.
- Native Responses bypasses the facade. Chat-only uses facade base URL and route token but Codex still receives `wire_api = "responses"`.

- [ ] **Step 1: Write failing compact and Codex runtime tests**

Import `routeFixture`, `requestText`, and `resolvedModelProfile` from `test/helpers/providerRouteFixtures.js`; do not duplicate route setup in the compact file.

Add an authenticated compact test with separate counters:

```js
test('chat-only compact returns 501 without secret resolution or upstream', async () => {
  const counts = { resolve: 0, upstream: 0 };
  const route = routeFixture({
    resolveRequestProfile: async () => {
      counts.resolve += 1;
      return resolvedModelProfile();
    },
    createUpstreamRequest: () => {
      counts.upstream += 1;
      throw new Error('compact reached upstream creation');
    }
  });
  const local = await route.start();
  const result = await requestText(local.baseUrl + '/responses/compact', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + local.routeToken, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(result.status, 501);
  assert.deepEqual(JSON.parse(result.body), {
    error: {
      type: 'provider_compaction_unsupported',
      code: 'provider_compaction_unsupported',
      message: 'This chat-only provider cannot compact Responses context.'
    }
  });
  assert.deepEqual(counts, { resolve: 0, upstream: 0 });
});
```

Update `providerProfile.test.js` to require native header values only in env:

```js
const runtime = {
  providerId: 'my-provider',
  baseUrl: 'https://proxy.example/openai/v1',
  envHeaders: [
    { name: 'Authorization', envName: 'AE_MCP_PROVIDER_HEADER_00', value: 'Bearer sk-secret' },
    { name: 'x-provider-feature', envName: 'AE_MCP_PROVIDER_HEADER_01', value: 'enabled-secret' }
  ]
};
const args = codexAppServerArgs(runtime);
const env = codexSpawnEnv(runtime, { PATH: '/usr/bin' });
assert.match(args.join('\n'), /wire_api="responses"/);
assert.match(args.join('\n'), /env_http_headers\."Authorization"="AE_MCP_PROVIDER_HEADER_00"/);
assert.doesNotMatch(args.join('\n'), /sk-secret|enabled-secret/);
assert.equal(env.AE_MCP_PROVIDER_HEADER_00, 'Bearer sk-secret');
assert.equal(env.AE_MCP_PROVIDER_HEADER_01, 'enabled-secret');
```

Add backend cases:

- Native effective dialect `responses`: `createResponsesRoute` call count 0; spawn base URL is the real provider; resolved model auth/extra headers become env header entries.
- Effective dialect `chat`: route starts once; spawn base URL is `http://127.0.0.1:<port>/v1`; only local Authorization env header exists; upstream provider secrets are not resolved at spawn.
- No effective dialect: custom channel is unavailable and app-server is not spawned against a guessed wire API.
- Reset/exit/error closes the route exactly once and clears the token-bearing runtime env object.
- No argument contains `wire_api="chat"`, `apiKey`, raw header value, or secret reference.

- [ ] **Step 2: Run compact/backend tests and verify RED**

Run:

```bash
cd plugin/panel
node --test test/codexResponsesRoute.compact.test.js test/providerProfile.test.js test/codexBackend.test.js test/channels.test.js
```

Expected: exit 1. The PR #51 implementation forwards compact as a normal Chat Completion and emits `wire_api="chat"`; current `main` uses plaintext `env_key` rather than generic `env_http_headers`.

- [ ] **Step 3: Implement compact 501 and current Codex config generation**

After successful local auth and before body/secret/upstream work, return the exact compact envelope above. Do not call the codec and do not inspect or manufacture compacted items.

For native providers, merge/validate resolved model headers, assign deterministic environment names `AE_MCP_PROVIDER_HEADER_00` through `AE_MCP_PROVIDER_HEADER_63`, and emit one dotted TOML override per header:

```js
`model_providers.${provider}.env_http_headers.${tomlString(header.name)}=${tomlString(header.envName)}`
```

Every custom Codex provider gets:

```js
'-c', `model_providers.${provider}.wire_api="responses"`,
'-c', `model_providers.${provider}.requires_openai_auth=false`
```

Do not emit `env_key`. Bearer, `x-api-key`, custom auth, none, and provider extras all use the validated env-header map. For chat-only, construct a one-header runtime profile containing `Authorization: Bearer <routeToken>`; facade resolution of upstream probe/model profiles remains lazy and happens after local auth.

`createCodexBackend` additions are exact:

```js
createCodexBackend({
  getProviderProfile: () => null,
  resolveRequestProfile,
  createResponsesRoute = createCodexResponsesRoute,
  spawnImpl,
  getModel,
  getEffort,
  getFast,
  getPermissionMode,
  getMcpSpec,
  getToolMeta,
  getExpertGuidance,
  getServerInstructions,
  getCliConfigProvider,
  resolveCli,
  onEvent,
  lang,
  env
})
```

The platform task owns executable/path/spawn-environment discovery. Preserve its post-merge APIs; replace only provider config/header assembly and route lifecycle.

- [ ] **Step 4: Run compact/backend tests and verify GREEN**

Run:

```bash
cd plugin/panel
node --test test/codexResponsesRoute.compact.test.js test/providerProfile.test.js test/codexBackend.test.js test/channels.test.js
./node_modules/.bin/esbuild src/main.jsx --bundle --outfile=/tmp/ae-mcp-panel-codex-route-check.js --format=iife --target=es2019 --jsx=automatic '--define:process.env.NODE_ENV="production"' --loader:.css=css
```

Expected: both commands exit 0. Chat compact is 501 with zero provider side effects; native providers bypass the facade; all Codex provider configs use Responses plus env header names only; JSX compiles without modifying tracked bundle files.

- [ ] **Step 5: Commit**

```bash
git add plugin/panel/src/lib/providerProfile.js plugin/panel/src/cep/codexBackend.js plugin/panel/src/app/App.jsx plugin/panel/src/lib/channels.js plugin/panel/src/cep/codexResponsesRoute.js plugin/panel/test/codexResponsesRoute.compact.test.js plugin/panel/test/providerProfile.test.js plugin/panel/test/codexBackend.test.js plugin/panel/test/channels.test.js
git commit -m "fix(panel): close chat-only Responses facade contract"
```

### Task 10: Gate the route with real Codex, full regression, deterministic bundle, and leak scans

**Files:**

- Create: `plugin/panel/test/codexResponsesRoute.codex-live.test.js`
- Modify only through build: `plugin/client/dist/app.js`
- Test all production and test files listed in this plan.

**Interfaces:**

- Consumes: macOS arm64 `codex-cli 0.144.0-alpha.4`, binary SHA-256 `ea2164f4728fea4049e3bf1eb882dc15c34597ac75544b47976a529feab3c7b4`, the secured route, and a local chat-only mock provider.
- Produces: two real-Codex live gates: metadata-header forwarding and long-context continuation after chat-only compact 501.
- Environment gate: the live file skips only when `AE_MCP_CODEX_ROUTE_LIVE !== '1'`; when enabled, any missing CLI/version mismatch/compact failure is a test failure.

- [ ] **Step 1: Write the real-Codex metadata and long-context tests**

Before starting app-server, the live test resolves `AE_MCP_CODEX_CLI`, reads the binary, and fails unless both immutable facts match:

```js
const expectedVersion = 'codex-cli 0.144.0-alpha.4';
const expectedSha256 = 'ea2164f4728fea4049e3bf1eb882dc15c34597ac75544b47976a529feab3c7b4';
assert.equal((await execFileText(codexPath, ['--version'])).trim(), expectedVersion);
assert.equal(createHash('sha256').update(readFileSync(codexPath)).digest('hex'), expectedSha256);
```

`execFileText` is a local test helper that uses `child_process.execFile`, rejects on a non-zero exit, and resolves the complete UTF-8 stdout string. A version/digest mismatch fails before opening a facade or mock-provider socket.

The metadata mock returns 400 unless it receives these exact facts from real Codex through the facade:

```js
assert.match(req.headers['user-agent'], /codex/i);
assert.equal(typeof req.headers['x-client-request-id'], 'string');
assert.equal(req.headers['x-provider-feature'], 'required');
assert.equal(req.headers.authorization, 'Bearer upstream-secret');
assert.equal(Object.hasOwn(req.headers, 'x-ae-mcp-route-token'), false);
```

On success it returns a streaming Chat Completion containing `CODEX_ROUTE_METADATA_OK`; the app-server test waits for the corresponding final assistant delta and `turn/completed`.

For long context, spawn the same Codex binary with these fixed overrides in addition to the provider overrides:

```text
-c model_context_window=8192
-c model_auto_compact_token_limit=4096
-c model_auto_compact_token_limit_scope="total"
```

Drive app-server JSON-RPC with:

1. `initialize`.
2. `thread/start` using the local test model and no MCP servers.
3. Sequential `turn/start` calls containing a unique turn marker plus 8192 ASCII characters until the facade observes `/v1/responses/compact`, with a hard ceiling of 32 turns and 180 seconds.
4. Assert the compact response is the exact 501 contract.
5. Send `AFTER_COMPACT_CONTINUATION_MARKER` on the same thread.
6. Require a later upstream `/v1/responses` request containing that marker.
7. Require an assistant delta containing `AFTER_COMPACT_OK` and a final `turn/completed`.

The failing assertion message is exact:

```js
assert.equal(
  continuationCompleted,
  true,
  'chat-only provider cannot continue after provider_compaction_unsupported'
);
```

Do not accept “Codex returned a controlled error” as success. Do not skip after observing 501. The live mock records only method/path/header names/statuses and request byte counts; it must not print header values or bodies.

- [ ] **Step 2: Run the live test and verify RED before final fixes**

Run on the macOS development machine with the fixed release-candidate Codex binary:

```bash
cd plugin/panel
AE_MCP_CODEX_ROUTE_LIVE=1 AE_MCP_CODEX_CLI="$(command -v codex)" node --test test/codexResponsesRoute.codex-live.test.js
```

Expected before the live harness/backend wiring is complete: exit 1 because the metadata marker or post-501 continuation condition is absent. If the target Codex version itself cannot continue after 501, keep this failure and return to design review for real local compaction; do not modify the expectation.

- [ ] **Step 3: Run the complete deterministic unit/integration suite**

Run:

```bash
cd plugin/panel
node --test test/providerStore.test.js test/providerSecrets.test.js test/providerMigration.test.js test/providerProfileFlow.test.js test/providerManagerState.test.js test/providerProfile.test.js test/providerDetect.test.js test/providerProbeFlow.test.js test/providerDialectBadge.test.js test/modelProbe.test.js test/ccSwitch.test.js test/claudeSettingsImport.test.js test/codexConfig.test.js test/providerUrl.test.js test/providerHeaders.test.js test/providerRouteAuth.test.js test/codexResponsesCodec.test.js test/codexResponsesRoute.endpoint.test.js test/codexResponsesRoute.headers.test.js test/codexResponsesRoute.token.test.js test/codexResponsesRoute.resource.test.js test/codexResponsesRoute.compact.test.js test/codexBackend.test.js test/channels.test.js test/backendSelect.test.js test/claudeAgentBackend.test.js test/claudeChannel.test.js test/agentLoop.test.js test/anthropic.test.js test/modelsApi.test.js test/logExport.test.js
npm test
```

Expected: both commands exit 0. No live test is silently run in the ordinary suite because it reports an explicit SKIP unless the gate variable is `1`.

- [ ] **Step 4: Run the real-Codex test and verify GREEN**

Run:

```bash
cd plugin/panel
AE_MCP_CODEX_ROUTE_LIVE=1 AE_MCP_CODEX_CLI="$(command -v codex)" node --test test/codexResponsesRoute.codex-live.test.js
```

Expected: exit 0; version and digest match first, metadata forwarding passes, compact is observed with exact 501, and the same thread completes `AFTER_COMPACT_OK` afterward.

- [ ] **Step 5: Run secret/reference and unsafe-pattern leak scans**

Run:

```bash
rg -n 'codexApiKey|apiKey\s*:' plugin/panel/src/cep/providerStore.js plugin/panel/src/app/providerProfileFlow.js plugin/panel/src/app/App.jsx
rg -n 'wire_api=.*chat|Math\.random\(|set-cookie|encrypted_content' plugin/panel/src plugin/panel/test
rg -n '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2|sk-provider-secret|sk-legacy-marker' plugin/client/dist plugin/panel/test/fixtures
```

Expected:

- First command exits 1 with no matches in provider persistence/runtime wiring.
- Second command may match only negative test fixture strings/assertions; it has no production-source match for `wire_api=.*chat`, `Math.random(`, or `encrypted_content`, and response policy contains `set-cookie` only as a denied name.
- Third command exits 1 with no concrete sample reference or marker secret in the generated bundle or fixtures. Production code may contain the non-resolving URI scheme/parser literal, which is not itself a stored provider reference.

- [ ] **Step 6: Build and verify the tracked Panel bundle deterministically**

Run:

```bash
cd plugin/panel
npm run build
git add ../../plugin/client/dist/app.js
npm run build
git diff --exit-code -- ../../plugin/client/dist/app.js
```

Expected: both builds exit 0; the final diff check exits 0, proving the staged bundle matches a fresh build.

- [ ] **Step 7: Commit**

```bash
git add plugin/panel/test/codexResponsesRoute.codex-live.test.js plugin/client/dist/app.js
git commit -m "test(panel): gate provider route with real Codex"
```

---

## PR #51 Selective Absorption Rules

Use `origin/feat/provider-dialect-autodetect` as a read-only source. Port concepts, not commits.

Retain after rewriting:

- `providerDetect.js` dependency injection and non-secret `tried` event idea.
- `providerProbeFlow.js` separation between UI flow and HTTP probe.
- `providerDialectBadge.js` pure presentation helper.
- Function-call and SSE conversion state-machine ideas from `codexResponsesRoute.js`.
- Route start/close lifecycle ownership in `codexBackend.js`.
- `modelProbe.js` model-list parsing.

Do not port:

- `dialect.authScheme`; auth belongs to probe/model request profiles.
- Automatic Bearer, `x-api-key`, then none guessing with one secret.
- Acceptance of arbitrary JSON HTTP 400.
- Codex `wire_api = "chat"`.
- `Math.random()` token generation or an unvalidated token.
- Query removal through `split('?')[0]`.
- Treating `/responses/compact` as `/chat/completions`.
- Forwarding `upstream.headers` wholesale.
- Persisting `apiKey` in `providers.json` or tests/fixtures.
- Ignoring unsupported Responses fields or malformed SSE.
- Unbounded body, SSE frame, concurrency, timers, redirects, or provider error text.
- The branch's generated `plugin/client/dist/app.js`.

## Completion Evidence

The PR is ready for review only when all of the following are attached to the PR description:

- Baseline protected `main` SHA containing the platform helper/runtime/App contracts.
- The focused command and exit-0 output for each Task.
- Full `npm test` exit-0 output.
- Two deterministic `npm run build` passes and clean generated-bundle diff.
- Real Codex binary path and exact `codex --version` output.
- Metadata live-test PASS.
- Long-context record showing compact 501 followed by a later Responses request and `turn/completed` on the same thread.
- Leak-scan output proving provider persistence, fixtures, and generated bundle contain no secret/reference values.
- A statement that no `wire_api = "chat"`, fake `encrypted_content`, secret HTTP endpoint, provider-config export, or automatic redirect was introduced.
