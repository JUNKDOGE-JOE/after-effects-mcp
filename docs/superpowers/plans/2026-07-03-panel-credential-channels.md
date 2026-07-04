# 面板凭据通道与 Settings UX 重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三个 AI 后端（Claude / Codex / ZCode）的凭据检测统一为"有序凭据通道"模型（继承外部配置为主、面板手填兜底），修复三个已知凭据故障，并把 Settings 重构为可折叠分区 + 通道卡 + 内建 Provider 管理器。

**Architecture:** Phase 1 全部在 CEP 面板的纯逻辑层（`plugin/panel/src/cep/*.js`、`src/lib/*.js`，node --test 可测）与 sidecar（`plugin/sidecar/lib.mjs`）落地：新增 providerStore（`~/.ae-mcp/providers.json`）与 modelProbe（`/v1/models` 双协议），修 ZCode 评分/CLI 配置合并、Codex spawn env、Claude 按通道条件化 env，最后以统一 `probeChannels()` 数据结构重写 `pickBackend`。Phase 2 在其上重构 SettingsScreen（可折叠 Section、三选一 Segmented、通道卡、Provider 管理、日志导出、死码清理）。Phase 3 全量单测 + live 手测矩阵。

**Tech Stack:** React 18（CEP 面板，esbuild 打包）、CEP cep_node（Node require：fs/os/path/child_process/https）、node:test + node:assert/strict（`plugin/panel`、`plugin/sidecar` 各自 `npm test` = `node --test`）、@anthropic-ai/claude-agent-sdk（sidecar）。

---

## 基线与实机事实（写死进计划的假设）

- 分支 `feat/panel-credential-channels`，HEAD=4e990d8（spec commit）。**不动仓库根目录 6 个未跟踪文件**（`_asset_server.js`、`_build_manifest.js`、`_extract_frames.js`、`_nas_copy.js`、`_nas_resolve.js`、`prompt-box-responsive.html`）。
- 测试运行方式：`cd plugin/panel && node --test test/`；sidecar：`cd plugin/sidecar && node --test test/`。测试文件均为 ESM + `node:test`/`assert/strict`，通过依赖注入（`fsImpl`/`spawnImpl`/`deps`）隔离 CEP 环境。JSX 组件不在 node --test 下渲染测试——**所有可测逻辑必须提炼进 `src/lib/` 纯函数**（现有惯例，如 `settingsState.js`）。
- 用户实机 `~/.zcode/cli/config.json` 结构（可直接解析）：
  ```json
  {"provider":{"mediastorm_glm":{"kind":"openai-compatible","name":"...","options":{"baseURL":"https://api.example.com/v1","apiKeyEnv":"MEDIASTORM_GLM_API_KEY"}}},"model":"mediastorm_glm/glm-5.2","mcp":{}}
  ```
- 相关 API key 环境变量**不是** Windows 持久化变量，CEP 面板继承不到 → `apiKeyEnv` 解析链必须有面板粘贴兜底（存 `~/.ae-mcp/zcode-key`）。
- 用户中转站（New API 类网关）`GET /v1/models`（Bearer 鉴权）实测 200 + 16 个模型 → 探测方案可行。
- cc-switch 实机未安装；检测三个位置即可：`~/.cc-switch`、`~/.config/cc-switch`、`%APPDATA%/cc-switch`。仅作可选导入源，不进向导依赖。
- Claude-3p host-creds 文件不自动读取（spec 明确排除）；UI 提示手填。
- `~/.ae-mcp` 密钥文件写入模式沿用 `plugin/panel/src/cep/apiKey.js`：`mkdirSync(recursive)` → 临时文件 `writeFileSync` → `chmodSync 0o600`（best-effort）→ `renameSync` 原子替换。
- 三处无条件 `delete ANTHROPIC_API_KEY`：`plugin/panel/src/cep/claudeAuth.js:62`、`plugin/panel/src/cep/claudeAgentBackend.js:71`（`sanitizeEnv`）、`plugin/sidecar/lib.mjs:495`（`cleanEnv`）。
- 每个 Task 结束 commit；commit message 末尾统一带 trailer：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（下文各 commit 步骤不再重复写出，执行时必须附加）。

## Spec 覆盖索引

| Spec 节 | 本计划 Task |
|---|---|
| A 统一凭据模型（后端×通道、来源徽标、通道锁定） | Task 10, 12 |
| A2 Provider 管理器（providers.json、迁移、模型探测、通道引用、cc-switch） | Task 2, 3, 13 |
| B1 ZCode（CLI 配置合并、评分修正、apiKeyEnv 链、错误本地化） | Task 1, 4, 5 |
| B2 Codex（spawn env 补全、probe 诊断路径/版本、AE_MCP_CODEX_CLI） | Task 6 |
| B3 Claude（订阅失败引导、settings.json 一键导入、host-creds 说明） | Task 7, 8, 9, 12 |
| C Settings 布局（折叠、通道卡、Provider 管理入口、清理、日志、职责收敛） | Task 11–15 |
| D 数据流（probeChannels 结构、pickBackend、双语 fixHint） | Task 10 |
| E 测试（panel/sidecar 单测 + live 手测） | 各 Task 的 TDD 步骤 + Task 16 |

---

# Phase 1 — 后端凭据逻辑

## Task 1: apiKey.js 支持 zcode-key

ZCode 面板粘贴兜底 key 需要一个 `~/.ae-mcp/zcode-key` 文件槽位。最小改动：`KEY_FILES` 加一行。

**Files:**
- Modify: `plugin/panel/src/cep/apiKey.js`（第 1–4 行 `KEY_FILES` 常量）
- Test: `plugin/panel/test/apiKey.test.js`

- [ ] **Step 1: 写失败测试**

  在 `plugin/panel/test/apiKey.test.js` 末尾追加：

  ```js
  test('writeKey can store a ZCode fallback key at ~/.ae-mcp/zcode-key', () => {
    const deps = makeDeps();
    const store = createApiKeyStore(deps);
    store.writeKey('zc-secret', 'zcode');
    assert.equal(store.readKey('zcode'), 'zc-secret');
    assert.equal(deps.files.has('/home/user/.ae-mcp/zcode-key'), true);
    store.clearKey('zcode');
    assert.equal(store.readKey('zcode'), '');
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/apiKey.test.js
  ```

  预期：新用例失败，报 `Unsupported API key name: zcode`。

- [ ] **Step 3: 最小实现**

  修改 `plugin/panel/src/cep/apiKey.js` 顶部常量：

  ```js
  const KEY_FILES = {
    anthropic: 'anthropic-key',
    codex: 'codex-key',
    zcode: 'zcode-key',
  };
  ```

- [ ] **Step 4: 跑测试确认通过**

  ```
  cd plugin/panel && node --test test/apiKey.test.js
  ```

  预期：全部用例通过（原有 4 个 + 新 1 个）。

- [ ] **Step 5: commit**

  ```
  git add plugin/panel/src/cep/apiKey.js plugin/panel/test/apiKey.test.js
  git commit -m "feat(panel): add zcode-key slot to api key store"
  ```

## Task 2: providerStore — providers.json CRUD + 旧配置迁移

统一自定义 provider 存储（spec A2）。新模块 `providerStore.js`，文件 `~/.ae-mcp/providers.json`，条目 `{id, name, protocol, baseUrl, apiKey, probedModels, probedAt}`；首次启动把 `~/.ae-mcp/anthropic-key` + localStorage `ae_mcp_anthropic_base_url` 迁移为 `legacy-anthropic`，`codex-key` + `ae_mcp_codex_base_url` 迁移为 `legacy-codex`。

**Files:**
- Create: `plugin/panel/src/cep/providerStore.js`
- Test: `plugin/panel/test/providerStore.test.js`（新建）

- [ ] **Step 1: 写失败测试（CRUD）**

  新建 `plugin/panel/test/providerStore.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { createProviderStore, normalizeProviderEntry } from '../src/cep/providerStore.js';

  function makeDeps() {
    const files = new Map();
    const dirs = new Set();
    const fs = {
      existsSync: (p) => dirs.has(p) || files.has(p),
      mkdirSync: (p) => { dirs.add(p); },
      readFileSync: (p) => {
        if (!files.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
        return files.get(p);
      },
      writeFileSync: (p, v) => { files.set(p, v); },
      chmodSync: () => {},
      renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
      unlinkSync: (p) => { files.delete(p); },
    };
    const path = { join: (...parts) => parts.join('/') };
    const os = { homedir: () => '/home/user' };
    return { fs, path, os, pid: 42, files, dirs };
  }

  test('list returns [] when providers.json is missing', () => {
    const store = createProviderStore(makeDeps());
    assert.deepEqual(store.list(), []);
  });

  test('upsert adds then updates a provider entry and persists JSON', () => {
    const deps = makeDeps();
    const store = createProviderStore(deps);
    store.upsert({ id: 'relay', name: '中转站', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1' });
    assert.equal(store.get('relay').apiKey, 'sk-1');
    store.upsert({ id: 'relay', name: '中转站', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-2' });
    assert.equal(store.list().length, 1);
    assert.equal(store.get('relay').apiKey, 'sk-2');
    const raw = JSON.parse(deps.files.get('/home/user/.ae-mcp/providers.json'));
    assert.equal(raw.version, 1);
    assert.equal(raw.providers[0].id, 'relay');
  });

  test('remove deletes an entry and tolerates unknown ids', () => {
    const store = createProviderStore(makeDeps());
    store.upsert({ id: 'a', name: 'A', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' });
    store.remove('a');
    assert.deepEqual(store.list(), []);
    assert.doesNotThrow(() => store.remove('nope'));
  });

  test('normalizeProviderEntry fills defaults and rejects bad protocol', () => {
    const e = normalizeProviderEntry({ id: ' x ', name: '', baseUrl: 'https://h/v1/', apiKey: ' k ' });
    assert.equal(e.id, 'x');
    assert.equal(e.name, 'x');
    assert.equal(e.protocol, 'openai-compatible');
    assert.equal(e.baseUrl, 'https://h/v1');
    assert.equal(e.apiKey, 'k');
    assert.deepEqual(e.probedModels, []);
    assert.equal(e.probedAt, 0);
    assert.throws(() => normalizeProviderEntry({ id: 'y', protocol: 'grpc', baseUrl: 'https://h' }));
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/providerStore.test.js
  ```

  预期：模块不存在，`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现 providerStore.js（CRUD 部分）**

  新建 `plugin/panel/src/cep/providerStore.js`：

  ```js
  // Unified custom-provider store: ~/.ae-mcp/providers.json (spec A2).
  // Entry: {id, name, protocol: 'anthropic'|'openai-compatible', baseUrl,
  // apiKey, probedModels: [{id,label}], probedAt: ms}. Atomic write + chmod
  // 600 mirrors apiKey.js.
  const PROTOCOLS = new Set(['anthropic', 'openai-compatible']);
  const FILE_NAME = 'providers.json';

  function cepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    return null;
  }

  function defaultDeps() {
    const req = cepRequire();
    if (!req) throw new Error('CEP Node require is unavailable');
    return {
      fs: req('fs'),
      os: req('os'),
      path: req('path'),
      pid: req('process') && req('process').pid,
    };
  }

  export function normalizeProviderEntry(input = {}) {
    const id = String(input.id || '').trim();
    if (!id) throw new Error('Provider entry needs an id');
    const protocol = String(input.protocol || 'openai-compatible');
    if (!PROTOCOLS.has(protocol)) throw new Error('Unsupported provider protocol: ' + protocol);
    return {
      id,
      name: String(input.name || '').trim() || id,
      protocol,
      baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(input.apiKey || '').trim(),
      probedModels: Array.isArray(input.probedModels) ? input.probedModels : [],
      probedAt: Number(input.probedAt) || 0,
    };
  }

  export function createProviderStore(deps = defaultDeps()) {
    const { fs, os, path } = deps;

    function dir() { return path.join(os.homedir(), '.ae-mcp'); }
    function filePath() { return path.join(dir(), FILE_NAME); }

    function readState() {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
          return { version: 1, migratedLegacy: false, providers: [] };
        }
        return { version: 1, migratedLegacy: parsed.migratedLegacy === true, providers: parsed.providers };
      } catch (e) {
        return { version: 1, migratedLegacy: false, providers: [] };
      }
    }

    function writeState(state) {
      const d = dir();
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      const pid = deps.pid || 0;
      const tmp = path.join(d, FILE_NAME + '.' + pid + '.' + Date.now() + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      try { fs.chmodSync(tmp, 0o600); } catch (e) { /* best effort on Windows */ }
      fs.renameSync(tmp, filePath());
      return state;
    }

    function list() { return readState().providers.map((p) => normalizeProviderEntry(p)); }
    function get(id) { return list().find((p) => p.id === String(id || '').trim()) || null; }

    function upsert(entry) {
      const next = normalizeProviderEntry(entry);
      const state = readState();
      const idx = state.providers.findIndex((p) => p && p.id === next.id);
      if (idx === -1) state.providers.push(next);
      else state.providers[idx] = next;
      writeState(state);
      return next;
    }

    function remove(id) {
      const state = readState();
      state.providers = state.providers.filter((p) => p && p.id !== String(id || '').trim());
      writeState(state);
    }

    function migrateLegacy({ readKey, readPref, markDone = true } = {}) {
      const state = readState();
      if (state.migratedLegacy) return { migrated: [] };
      const migrated = [];
      const anthropicKey = readKey ? String(readKey('anthropic') || '') : '';
      const anthropicBase = readPref ? String(readPref('ae_mcp_anthropic_base_url') || '') : '';
      if (anthropicKey || anthropicBase) {
        migrated.push(upsert({
          id: 'legacy-anthropic',
          name: 'Claude API (migrated)',
          protocol: 'anthropic',
          baseUrl: anthropicBase || 'https://api.anthropic.com',
          apiKey: anthropicKey,
        }));
      }
      const codexKey = readKey ? String(readKey('codex') || '') : '';
      const codexBase = readPref ? String(readPref('ae_mcp_codex_base_url') || '') : '';
      if (codexKey || codexBase) {
        migrated.push(upsert({
          id: 'legacy-codex',
          name: 'Codex custom (migrated)',
          protocol: 'openai-compatible',
          baseUrl: codexBase,
          apiKey: codexKey,
        }));
      }
      if (markDone) {
        const after = readState();
        after.migratedLegacy = true;
        writeState(after);
      }
      return { migrated };
    }

    return { filePath, list, get, upsert, remove, migrateLegacy };
  }
  ```

- [ ] **Step 4: 跑测试确认 CRUD 通过**

  ```
  cd plugin/panel && node --test test/providerStore.test.js
  ```

  预期：4 个用例全部通过。

- [ ] **Step 5: 写失败测试（迁移）**

  追加到 `plugin/panel/test/providerStore.test.js`：

  ```js
  test('migrateLegacy imports anthropic-key/codex-key + base URL prefs once', () => {
    const deps = makeDeps();
    const store = createProviderStore(deps);
    const prefs = { ae_mcp_anthropic_base_url: 'https://relay.example/anthropic', ae_mcp_codex_base_url: 'https://relay.example/openai' };
    const keys = { anthropic: 'sk-ant-legacy', codex: 'sk-codex-legacy' };
    const first = store.migrateLegacy({ readKey: (n) => keys[n] || '', readPref: (k) => prefs[k] || '' });
    assert.equal(first.migrated.length, 2);
    const a = store.get('legacy-anthropic');
    assert.equal(a.protocol, 'anthropic');
    assert.equal(a.baseUrl, 'https://relay.example/anthropic');
    assert.equal(a.apiKey, 'sk-ant-legacy');
    const c = store.get('legacy-codex');
    assert.equal(c.protocol, 'openai-compatible');
    assert.equal(c.apiKey, 'sk-codex-legacy');
    // Second run is a no-op (migratedLegacy flag persisted).
    const second = store.migrateLegacy({ readKey: (n) => keys[n] || '', readPref: (k) => prefs[k] || '' });
    assert.equal(second.migrated.length, 0);
  });

  test('migrateLegacy with nothing to migrate still marks done', () => {
    const store = createProviderStore(makeDeps());
    assert.deepEqual(store.migrateLegacy({ readKey: () => '', readPref: () => '' }).migrated, []);
    assert.deepEqual(store.migrateLegacy({ readKey: () => 'late-key', readPref: () => '' }).migrated, []);
  });
  ```

- [ ] **Step 6: 跑测试确认全部通过**

  实现已在 Step 3 覆盖迁移逻辑；如失败按报错修 `migrateLegacy`。

  ```
  cd plugin/panel && node --test test/providerStore.test.js
  ```

  预期：6 个用例通过。

- [ ] **Step 7: commit**

  ```
  git add plugin/panel/src/cep/providerStore.js plugin/panel/test/providerStore.test.js
  git commit -m "feat(panel): provider store with providers.json CRUD and legacy migration"
  ```

## Task 3: modelProbe — /v1/models 双协议探测 + 失败降级

`GET {baseUrl}/v1/models`：`openai-compatible` 用 `Authorization: Bearer`，`anthropic` 用 `x-api-key` + `anthropic-version`（模式对齐现有 `modelsApi.js` 的 Node https 通道，CEP 浏览器 fetch 有 CORS 限制）。解析两种响应形态：OpenAI `{data:[{id}]}` 与 Anthropic `{data:[{id,display_name}]}`。失败返回 `{ok:false}`，调用方降级为手填模型 ID（保留现有"自定义模型 ID"能力）。

**Files:**
- Create: `plugin/panel/src/cep/modelProbe.js`
- Test: `plugin/panel/test/modelProbe.test.js`（新建）

- [ ] **Step 1: 写失败测试（解析器）**

  新建 `plugin/panel/test/modelProbe.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { parseModelsList, probeHeaders, probeProviderModels } from '../src/cep/modelProbe.js';

  test('parseModelsList handles OpenAI-style {data:[{id}]}', () => {
    const models = parseModelsList({ data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4' }, { object: 'noise' }] });
    assert.deepEqual(models, [
      { id: 'glm-5.2', label: 'glm-5.2' },
      { id: 'deepseek-v4', label: 'deepseek-v4' },
    ]);
  });

  test('parseModelsList handles Anthropic-style display_name and bare arrays', () => {
    assert.deepEqual(parseModelsList({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }),
      [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]);
    assert.deepEqual(parseModelsList([{ id: 'm1' }]), [{ id: 'm1', label: 'm1' }]);
    assert.deepEqual(parseModelsList(null), []);
  });

  test('probeHeaders picks auth scheme by protocol', () => {
    assert.deepEqual(probeHeaders('openai-compatible', 'sk-x'), { Authorization: 'Bearer sk-x' });
    assert.deepEqual(probeHeaders('anthropic', 'sk-a'), { 'x-api-key': 'sk-a', 'anthropic-version': '2023-06-01' });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/modelProbe.test.js
  ```

  预期：`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现 modelProbe.js**

  新建 `plugin/panel/src/cep/modelProbe.js`：

  ```js
  // Custom-provider model discovery: GET {baseUrl}/v1/models (spec A2).
  // openai-compatible -> Authorization: Bearer; anthropic -> x-api-key +
  // anthropic-version (Anthropic officially serves GET /v1/models too).
  // Uses cep_node https (browser fetch is CORS-blocked in CEP, see modelsApi.js).
  function getCepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error('CEP Node require is unavailable');
  }

  export function probeHeaders(protocol, apiKey) {
    if (protocol === 'anthropic') {
      return { 'x-api-key': String(apiKey || ''), 'anthropic-version': '2023-06-01' };
    }
    return { Authorization: 'Bearer ' + String(apiKey || '') };
  }

  export function parseModelsList(json) {
    const list = Array.isArray(json) ? json
      : json && Array.isArray(json.data) ? json.data
      : json && Array.isArray(json.models) ? json.models
      : [];
    return list
      .map((m) => {
        const id = m && (m.id || m.model || m.name);
        if (!id) return null;
        return { id: String(id), label: String(m.display_name || m.displayName || id) };
      })
      .filter(Boolean);
  }

  export function probeProviderModels({ baseUrl, apiKey, protocol = 'openai-compatible', httpsImpl, timeoutMs = 8000 } = {}) {
    let endpoint;
    try {
      const root = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
      endpoint = new URL(root + '/v1/models');
    } catch (e) {
      return Promise.resolve({ ok: false, status: 0, models: [], detail: 'Invalid base URL' });
    }
    let https;
    try {
      https = httpsImpl || getCepRequire()(endpoint.protocol === 'http:' ? 'http' : 'https');
    } catch (e) {
      return Promise.resolve({ ok: false, status: 0, models: [], detail: e.message });
    }
    return new Promise((resolve) => {
      const req = https.request({
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        protocol: endpoint.protocol,
        path: endpoint.pathname + endpoint.search,
        method: 'GET',
        headers: probeHeaders(protocol, apiKey),
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, status: res.statusCode, models: [], detail: 'HTTP ' + res.statusCode + ': ' + body.slice(0, 200) });
            return;
          }
          try {
            const models = parseModelsList(JSON.parse(body));
            resolve(models.length
              ? { ok: true, status: 200, models, detail: '' }
              : { ok: false, status: 200, models: [], detail: 'Empty model list' });
          } catch (e) {
            resolve({ ok: false, status: 200, models: [], detail: 'Response was not valid JSON' });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, status: 0, models: [], detail: err && err.message ? err.message : 'request failed' }));
      if (req.setTimeout) req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) { /* noop */ } resolve({ ok: false, status: 0, models: [], detail: 'timeout' }); });
      req.end();
    });
  }
  ```

  注意 URL 拼接防重：`baseUrl` 末尾斜杠剥掉后再剥掉一个尾部 `/v1`（用户实机 baseUrl 是 `https://api.example.com/v1`，直接拼会得到 `/v1/v1/models`）。下面 Step 5 的请求用例用带 `/v1/` 的 baseUrl 断言 `options.path === '/v1/models'`，锁住该行为。

- [ ] **Step 4: 跑测试确认解析器通过**

  ```
  cd plugin/panel && node --test test/modelProbe.test.js
  ```

- [ ] **Step 5: 写请求路径 + 失败降级测试，确认通过**

  追加到 `plugin/panel/test/modelProbe.test.js`：

  ```js
  function makeHttps(handler) {
    return {
      request(options, onRes) {
        const res = { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; } };
        const req = {
          handlers: {},
          on(ev, fn) { this.handlers[ev] = fn; return this; },
          setTimeout() {},
          destroy() {},
          end() { handler(options, res, onRes, req); },
        };
        return req;
      },
    };
  }

  test('probeProviderModels returns ok with parsed models on 200', async () => {
    const https = makeHttps((options, res, onRes) => {
      assert.equal(options.path, '/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer sk-x');
      onRes(Object.assign(res, { statusCode: 200 }));
      res.handlers.data(JSON.stringify({ data: [{ id: 'glm-5.2' }] }));
      res.handlers.end();
    });
    const result = await probeProviderModels({ baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-x', protocol: 'openai-compatible', httpsImpl: https });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [{ id: 'glm-5.2', label: 'glm-5.2' }]);
  });

  test('probeProviderModels degrades to ok:false on 401 and network error', async () => {
    const https401 = makeHttps((options, res, onRes) => {
      onRes(Object.assign(res, { statusCode: 401 }));
      res.handlers.data('unauthorized');
      res.handlers.end();
    });
    const denied = await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'bad', httpsImpl: https401 });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);

    const httpsErr = makeHttps((options, res, onRes, req) => { req.handlers.error(new Error('ECONNREFUSED')); });
    const down = await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'k', httpsImpl: httpsErr });
    assert.equal(down.ok, false);
    assert.match(down.detail, /ECONNREFUSED/);
  });
  ```

  跑 `cd plugin/panel && node --test test/modelProbe.test.js`，预期 5 个用例全部通过（请求实现与解析实现同文件一并落地，属同一最小实现单元）。

- [ ] **Step 6: commit**

  ```
  git add plugin/panel/src/cep/modelProbe.js plugin/panel/test/modelProbe.test.js
  git commit -m "feat(panel): /v1/models probe with dual auth protocols and graceful degradation"
  ```

## Task 4: ZCode — CLI 配置合并 + zcodeProviderScore 修正 + apiKeyEnv 解析链

三合一（spec B1 前三条）：
1. `~/.zcode/cli/config.json` 并入读取（CLI 优先于桌面版 `~/.zcode/v2/`）；CLI 顶层 `model` 字段作为默认 modelRef。
2. `zcodeProviderScore` 修正："有可用凭据" +300，必须压过 family(+80)+start-plan(+30)+enabled(+100) 的无 key 组合（最高 210）。
3. `apiKeyEnv` 解析链：inline apiKey（config）→ spawn env[apiKeyEnv]（env）→ 面板存储 `~/.ae-mcp/zcode-key`（panel）→ 无（UI 提示粘贴）。

关键陷阱（实机事实）：用户 CLI provider `mediastorm_glm` **没有 `models` 字段**（模型来自顶层 `model` 引用），现有 `zcodeProviderScore` 会因 `zcodeModelIds().length === 0` 直接 -1 排除。修法：显式 modelRef 命中的 provider 允许空 models（`zcodeProtocolModels` 已会把 selectedModelId unshift 进去）。

**Files:**
- Modify: `plugin/panel/src/cep/zcodeBackend.js`（`zcodeProviderScore` 225–240 行、`zcodeDesktopProviderEntry` 242–265 行、`zcodeModelFromDesktopConfig` 267–270 行、`zcodeRuntimeModelFromDesktopConfig` 318–345 行、`readZcodeDesktopModel`/`readZcodeDesktopRuntimeModel` 360–376 行、工厂 `currentEnv`/`currentRuntimeModel` 688–722 行）
- Test: `plugin/panel/test/zcodeBackend.test.js`

- [ ] **Step 1: 写失败测试（合并 + 评分回归 + key 链）**

  在 `plugin/panel/test/zcodeBackend.test.js` 顶部 import 行扩为：

  ```js
  import { createZcodeBackend, zcodeModelFromDesktopConfig, zcodeRuntimeModelFromDesktopConfig, mergeZcodeConfigs, resolveZcodeProviderApiKey, summarizeZcodeConfig, readZcodeDesktopModel } from '../src/cep/zcodeBackend.js';
  ```

  文件末尾追加：

  ```js
  // --- Task 4: CLI config merge + score fix + apiKeyEnv chain ---

  const CLI_PROVIDER = {
    kind: 'openai-compatible',
    name: 'MediaStorm GLM',
    options: { baseURL: 'https://api.example.com/v1', apiKeyEnv: 'MEDIASTORM_GLM_API_KEY' },
  };

  function fakeFs(files) {
    return {
      readFileSync(p) {
        if (!(p in files)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
        return files[p];
      },
    };
  }

  test('mergeZcodeConfigs lets CLI providers override desktop providers of the same id', () => {
    const merged = mergeZcodeConfigs({
      cliConfig: { provider: { shared: { kind: 'openai-compatible', options: { baseURL: 'https://cli' } }, cliOnly: {} } },
      desktopConfig: { provider: { shared: { kind: 'anthropic' }, desktopOnly: {} } },
    });
    assert.equal(merged.provider.shared.options.baseURL, 'https://cli');
    assert.ok(merged.provider.cliOnly);
    assert.ok(merged.provider.desktopOnly);
    assert.equal(mergeZcodeConfigs({}), null);
  });

  test('a credentialed custom provider outranks a keyless builtin start-plan (spec B1 regression)', () => {
    const model = zcodeModelFromDesktopConfig({
      setting: { providerFamilyDomain: 'zai' },
      env: { MEDIASTORM_GLM_API_KEY: 'sk-live' },
      config: {
        provider: {
          'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } },
          mediastorm_glm: { ...CLI_PROVIDER, models: { 'glm-5.2': {} } },
        },
      },
    });
    assert.equal(model, 'mediastorm_glm/glm-5.2');
  });

  test('without any credential the builtin start-plan still wins (no behavior change)', () => {
    const model = zcodeModelFromDesktopConfig({
      setting: { providerFamilyDomain: 'zai' },
      env: {},
      config: {
        provider: {
          'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } },
          mediastorm_glm: { ...CLI_PROVIDER, models: { 'glm-5.2': {} } },
        },
      },
    });
    assert.equal(model, 'builtin:zai-start-plan/GLM-5.2');
  });

  test('resolveZcodeProviderApiKey chain: config -> env[apiKeyEnv] -> stored panel key -> empty', () => {
    assert.deepEqual(resolveZcodeProviderApiKey({ provider: { options: { apiKey: 'inline' } } }), { key: 'inline', source: 'config' });
    assert.deepEqual(resolveZcodeProviderApiKey({ provider: CLI_PROVIDER, env: { MEDIASTORM_GLM_API_KEY: 'sk-env' } }), { key: 'sk-env', source: 'env' });
    assert.deepEqual(resolveZcodeProviderApiKey({ provider: CLI_PROVIDER, env: {}, storedKey: 'sk-panel' }), { key: 'sk-panel', source: 'panel' });
    assert.deepEqual(resolveZcodeProviderApiKey({ provider: CLI_PROVIDER, env: {} }), { key: '', source: '' });
  });

  test('zcodeRuntimeModelFromDesktopConfig injects the resolved apiKeyEnv key for a modelRef-selected provider without models', () => {
    const config = { provider: { mediastorm_glm: CLI_PROVIDER } };
    const fromEnv = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', env: { MEDIASTORM_GLM_API_KEY: 'sk-env' } });
    assert.equal(fromEnv.model.modelId, 'glm-5.2');
    assert.deepEqual(fromEnv.provider.apiKey, { source: 'inline', value: 'sk-env' });
    assert.deepEqual(fromEnv.provider.models, [{ modelId: 'glm-5.2' }]);
    const fromPanel = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', env: {}, storedKey: 'sk-panel' });
    assert.deepEqual(fromPanel.provider.apiKey, { source: 'inline', value: 'sk-panel' });
    const none = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', env: {} });
    assert.equal(none.provider.apiKey, undefined);
  });

  test('readZcodeDesktopModel merges ~/.zcode/cli/config.json and prefers its top-level model', () => {
    const env = { USERPROFILE: 'C:\Users\me' };
    const files = {
      'C:\Users\me\.zcode\cli\config.json': JSON.stringify({ provider: { mediastorm_glm: CLI_PROVIDER }, model: 'mediastorm_glm/glm-5.2' }),
      'C:\Users\me\.zcode\v2\config.json': JSON.stringify({ provider: { 'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } } } }),
      'C:\Users\me\.zcode\v2\setting.json': JSON.stringify({ providerFamilyDomain: 'zai' }),
    };
    assert.equal(readZcodeDesktopModel({ env, fsImpl: fakeFs(files) }), 'mediastorm_glm/glm-5.2');
  });

  test('summarizeZcodeConfig reports cli/desktop/start-plan channel facts', () => {
    const env = { USERPROFILE: 'C:\Users\me' };
    const files = {
      'C:\Users\me\.zcode\cli\config.json': JSON.stringify({ provider: { mediastorm_glm: CLI_PROVIDER }, model: 'mediastorm_glm/glm-5.2' }),
      'C:\Users\me\.zcode\v2\config.json': JSON.stringify({ provider: { 'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } } } }),
    };
    const bare = summarizeZcodeConfig({ env, fsImpl: fakeFs(files) });
    assert.equal(bare.cli.providerId, 'mediastorm_glm');
    assert.equal(bare.cli.model, 'mediastorm_glm/glm-5.2');
    assert.equal(bare.cli.apiKeyEnv, 'MEDIASTORM_GLM_API_KEY');
    assert.equal(bare.cli.hasCredential, false);
    assert.equal(bare.desktop.providerId, 'builtin:zai-start-plan');
    assert.equal(bare.startPlan.providerId, 'builtin:zai-start-plan');
    assert.equal(bare.startPlan.hasCredential, false);
    const withKey = summarizeZcodeConfig({ env: { ...env, MEDIASTORM_GLM_API_KEY: 'k' }, fsImpl: fakeFs(files) });
    assert.equal(withKey.cli.hasCredential, true);
    assert.equal(withKey.cli.keySource, 'env');
    const withStored = summarizeZcodeConfig({ env, fsImpl: fakeFs(files), storedKey: 'panel-key' });
    assert.equal(withStored.cli.hasCredential, true);
    assert.equal(withStored.cli.keySource, 'panel');
  });

  test('stored panel zcode key flows into spawn env via the apiKeyEnv chain', async () => {
    const { backend, spawned } = makeBackend({
      readStoredZcodeKey: () => 'sk-panel',
      env: {
        PATH: 'C:\Node', TEMP: 'C:\tmp', LOCALAPPDATA: 'C:\Users\test\AppData\Local',
        AE_MCP_PANEL_EXT_ROOT: 'C:\Repo\plugin\panel', AE_MCP_ZCODE_MODEL: 'mediastorm_glm/glm-5.2',
      },
    });
    backend.sendUser('hello');
    await flush();
    assert.equal(spawned.calls[0].options.env.ZCODE_API_KEY, 'sk-panel');
    assert.equal(spawned.calls[0].options.env.MEDIASTORM_GLM_API_KEY, 'sk-panel');
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/zcodeBackend.test.js
  ```

  预期：import 处直接报 `mergeZcodeConfigs` 等符号不存在（SyntaxError: The requested module does not provide an export）。

- [ ] **Step 3: 实现 — zcodeBackend.js 修改**

  3a. `zcodeProviderScore`（替换 225–240 行）与新导出的凭据判定：

  ```js
  export function hasZcodeProviderCredential(provider, env = {}) {
    const options = provider && provider.options && typeof provider.options === 'object' ? provider.options : {};
    if (options.apiKey || (provider && provider.apiKey)) return true;
    const keyEnv = String(options.apiKeyEnv || '').trim();
    return Boolean(keyEnv && env[keyEnv]);
  }

  function zcodeProviderScore(providerId, provider, family, env = {}, { allowEmptyModels = false } = {}) {
    if (!provider || typeof provider !== 'object') return -1;
    if (provider.enabled === false || provider.systemDisabledReason) return -1;
    if (!zcodeModelIds(provider).length && !allowEmptyModels) return -1;

    const id = String(providerId || '');
    let score = 0;
    if (provider.enabled === true) score += 100;
    if (family && id === 'builtin:' + family + '-start-plan') score += 80;
    if (family && id === 'builtin:' + family + '-coding-plan') score += 70;
    if (family && id === 'builtin:' + family) score += 40;
    if (/-start-plan$/.test(id)) score += 30;
    if (/-coding-plan$/.test(id)) score += 20;
    // Spec B1: usable credentials MUST outrank the fixed family/start-plan
    // bonuses. Max keyless total is 100+80+30 = 210, so credentials add 300 —
    // a keyed custom provider always beats a keyless builtin start-plan.
    if (hasZcodeProviderCredential(provider, env)) score += 300;
    return score;
  }
  ```

  3b. `zcodeDesktopProviderEntry`（替换 242–265 行）——签名加 `env`，requested 分支允许空 models：

  ```js
  function zcodeDesktopProviderEntry({ config, setting, modelRef, env = {} }) {
    const providers = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
    const entries = Object.entries(providers);
    if (!entries.length) return null;

    const family = String((setting && setting.providerFamilyDomain) || '').trim();
    const requested = zcodeProtocolModelFromRef(modelRef);
    if (requested && providers[requested.providerId]) {
      const provider = providers[requested.providerId];
      const score = zcodeProviderScore(requested.providerId, provider, family, env, { allowEmptyModels: true });
      if (score >= 0) return { providerId: requested.providerId, provider, modelId: requested.modelId, score };
    }

    let best = null;
    for (const [providerId, provider] of entries) {
      const score = zcodeProviderScore(providerId, provider, family, env);
      if (score < 0) continue;
      if (!best || score > best.score) best = { providerId, provider, score };
    }
    if (!best) return null;

    const modelId = zcodePreferredModelId(best.provider);
    return modelId ? { ...best, modelId } : null;
  }
  ```

  3c. `zcodeModelFromDesktopConfig`（替换 267–270 行）：

  ```js
  export function zcodeModelFromDesktopConfig({ config, setting, env = {} }) {
    const entry = zcodeDesktopProviderEntry({ config, setting, env });
    return entry ? entry.providerId + '/' + entry.modelId : '';
  }
  ```

  3d. 新增 key 链解析（放在 `zcodeRuntimeModelFromDesktopConfig` 之前）：

  ```js
  export function resolveZcodeProviderApiKey({ provider, env = {}, storedKey = '' } = {}) {
    const options = provider && provider.options && typeof provider.options === 'object' ? provider.options : {};
    const inline = options.apiKey || (provider && provider.apiKey);
    if (inline) return { key: String(inline), source: 'config' };
    const keyEnv = String(options.apiKeyEnv || '').trim();
    if (keyEnv && env[keyEnv]) return { key: String(env[keyEnv]), source: 'env' };
    if (storedKey) return { key: String(storedKey), source: 'panel' };
    return { key: '', source: '' };
  }
  ```

  3e. `zcodeRuntimeModelFromDesktopConfig`（318–345 行）：签名加 `env`、`storedKey`，`const apiKey = options.apiKey || provider.apiKey;` 一行替换为：

  ```js
  export function zcodeRuntimeModelFromDesktopConfig({ config, setting, modelRef, thoughtLevel, env = {}, storedKey = '' } = {}) {
    const entry = zcodeDesktopProviderEntry({ config, setting, modelRef, env });
    if (!entry) return null;

    const provider = entry.provider || {};
    const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
    const kind = zcodeProtocolProviderKind(provider.kind);
    const apiKey = resolveZcodeProviderApiKey({ provider, env, storedKey }).key;
  ```

  函数体其余部分（`protocolProvider` 构造与 return）保持原样不动。

  3f. CLI 配置读取 + 合并（放在 `zcodeDesktopBasePath` 之后；`readZcodeDesktopModel`/`readZcodeDesktopRuntimeModel` 360–376 行整体替换，并加 `export`）：

  ```js
  function zcodeCliBasePath(env) {
    const home = env && (env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : ''));
    return home ? String(home).replace(/[\/]+$/, '') + '\.zcode\cli' : '';
  }

  // Spec B1: merge CLI config (~/.zcode/cli/config.json) over desktop config
  // (~/.zcode/v2/config.json). CLI providers win on id collisions.
  export function mergeZcodeConfigs({ cliConfig, desktopConfig } = {}) {
    const desktopProviders = desktopConfig && desktopConfig.provider && typeof desktopConfig.provider === 'object' ? desktopConfig.provider : {};
    const cliProviders = cliConfig && cliConfig.provider && typeof cliConfig.provider === 'object' ? cliConfig.provider : {};
    const provider = Object.assign({}, desktopProviders, cliProviders);
    return Object.keys(provider).length ? { provider } : null;
  }

  function readZcodeConfigs({ env, fsImpl } = {}) {
    const fs = fsImpl || getCepRequire()('fs');
    const desktopBase = zcodeDesktopBasePath(env || {});
    const cliBase = zcodeCliBasePath(env || {});
    const desktopConfig = desktopBase ? readJsonFile(fs, desktopBase + '\config.json') : null;
    const setting = desktopBase ? readJsonFile(fs, desktopBase + '\setting.json') : null;
    const cliConfig = cliBase ? readJsonFile(fs, cliBase + '\config.json') : null;
    const cliModel = cliConfig && typeof cliConfig.model === 'string' ? cliConfig.model.trim() : '';
    return { config: mergeZcodeConfigs({ cliConfig, desktopConfig }), setting, cliModel, cliConfig, desktopConfig };
  }

  export function readZcodeDesktopModel({ env, fsImpl } = {}) {
    const { config, setting, cliModel } = readZcodeConfigs({ env, fsImpl });
    if (cliModel) {
      const requested = zcodeProtocolModelFromRef(cliModel);
      if (requested && config && config.provider && config.provider[requested.providerId]) return cliModel;
    }
    return zcodeModelFromDesktopConfig({ config, setting, env: env || {} });
  }

  export function readZcodeDesktopRuntimeModel({ env, fsImpl, modelRef, thoughtLevel, storedKey = '' } = {}) {
    const { config, setting, cliModel } = readZcodeConfigs({ env, fsImpl });
    const ref = modelRef || cliModel || '';
    return zcodeRuntimeModelFromDesktopConfig({ config, setting, modelRef: ref, thoughtLevel, env: env || {}, storedKey });
  }

  // Channel facts for the Settings channel card (spec A backend x channel).
  export function summarizeZcodeConfig({ env = {}, fsImpl, storedKey = '' } = {}) {
    const { cliConfig, desktopConfig, cliModel } = readZcodeConfigs({ env, fsImpl });
    const cliProviders = (cliConfig && cliConfig.provider) || {};
    const cliProviderId = zcodeProviderId(cliModel) || Object.keys(cliProviders)[0] || '';
    const cliProvider = cliProviderId ? cliProviders[cliProviderId] : null;
    const cliResolved = cliProvider ? resolveZcodeProviderApiKey({ provider: cliProvider, env, storedKey }) : { key: '', source: '' };
    const desktopIds = Object.keys((desktopConfig && desktopConfig.provider) || {});
    const startPlanId = desktopIds.find((id) => /-start-plan$/.test(id)) || '';
    const startPlanProvider = startPlanId ? desktopConfig.provider[startPlanId] : null;
    return {
      cli: cliProvider ? {
        providerId: cliProviderId,
        model: cliModel,
        apiKeyEnv: String((cliProvider.options && cliProvider.options.apiKeyEnv) || ''),
        hasCredential: Boolean(cliResolved.key),
        keySource: cliResolved.source,
      } : null,
      desktop: desktopIds.length ? { providerId: desktopIds[0] } : null,
      startPlan: startPlanId ? {
        providerId: startPlanId,
        hasCredential: hasZcodeProviderCredential(startPlanProvider, env),
      } : null,
    };
  }
  ```

  3g. 工厂接入面板存储 key：`createZcodeBackend` 参数列表加一项（放在 `resolveNode = resolveSystemNode,` 之后）：

  ```js
    readStoredZcodeKey = defaultReadStoredZcodeKey,
  ```

  文件顶部 import 区追加：

  ```js
  import { createApiKeyStore } from './apiKey.js';
  ```

  模块级（`createZcodeBackend` 之前）加默认实现：

  ```js
  function defaultReadStoredZcodeKey() {
    try { return createApiKeyStore().readKey('zcode'); } catch (e) { return ''; }
  }
  ```

  `currentEnv()`（688–699 行）中 `const panelApiKey = ...` 一行替换为：

  ```js
      const panelApiKey = (next.AE_MCP_ZCODE_API_KEY && String(next.AE_MCP_ZCODE_API_KEY).trim()) || String(readStoredZcodeKey() || '').trim();
  ```

  `currentRuntimeModel`（715–722 行）传入 storedKey：

  ```js
    function currentRuntimeModel(spawnEnv, modelRef, thoughtLevel) {
      if (!readDesktopRuntimeModel) return null;
      try {
        return readDesktopRuntimeModel({ env: spawnEnv, modelRef, thoughtLevel, storedKey: String(readStoredZcodeKey() || '').trim() }) || null;
      } catch (e) {
        return null;
      }
    }
  ```

- [ ] **Step 4: 跑测试确认通过（全文件回归）**

  ```
  cd plugin/panel && node --test test/zcodeBackend.test.js
  ```

  预期：新增 8 个用例 + 原有全部用例通过。特别核对原有用例 `zcodeModelFromDesktopConfig picks the enabled coding-plan provider from v2 settings`：其 `builtin:bigmodel-start-plan` 带 `options.apiKey: 'redacted'`（凭据 +300）仍最高分，行为不变。

- [ ] **Step 5: commit**

  ```
  git add plugin/panel/src/cep/zcodeBackend.js plugin/panel/test/zcodeBackend.test.js
  git commit -m "fix(panel): zcode CLI config merge, credential-first provider score, apiKeyEnv chain"
  ```

## Task 5: ZCode 错误文案本地化（zh/en）

spec B1 第 4 条：不可用/报错信息跟随界面语言、可操作化，不再裸透传 `builtin:zai-start-plan` 式内部错误。新纯函数 lib（可测），zcodeBackend 的错误出口统一路由。

**Files:**
- Create: `plugin/panel/src/lib/zcodeErrors.js`
- Modify: `plugin/panel/src/cep/zcodeBackend.js`（`zcodeErrorMessage` 621–635 行及其调用点）
- Test: `plugin/panel/test/zcodeErrors.test.js`（新建）、`plugin/panel/test/zcodeBackend.test.js`

- [ ] **Step 1: 写失败测试**

  新建 `plugin/panel/test/zcodeErrors.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { localizeZcodeError } from '../src/lib/zcodeErrors.js';

  test('zh adds an actionable header for missing-API-key errors, keeping the original detail', () => {
    const raw = 'Model provider is missing an API key: builtin:zai-start-plan.';
    const zh = localizeZcodeError(raw, 'zh');
    assert.match(zh, /builtin:zai-start-plan/);
    assert.match(zh, /缺少 API Key/);
    assert.match(zh, /设置 → AI 服务 → ZCode/);
    assert.match(zh, /zcode-key/);
    assert.ok(zh.includes(raw), 'original detail preserved for diagnostics');
  });

  test('zh localizes missing-model-config and provider-auth failures with next steps', () => {
    assert.match(localizeZcodeError('Model config is missing.', 'zh'), /打开 ZCode|config\.json/);
    assert.match(localizeZcodeError('Provider authentication failed.', 'zh'), /检查 API Key|验证码/);
  });

  test('en and unknown messages pass through unchanged', () => {
    const raw = 'Model provider is missing an API key: x.';
    assert.equal(localizeZcodeError(raw, 'en'), raw);
    assert.equal(localizeZcodeError('some other error', 'zh'), 'some other error');
    assert.equal(localizeZcodeError('', 'zh'), '');
  });
  ```

  在 `plugin/panel/test/zcodeBackend.test.js` 末尾追加集成用例：

  ```js
  test('zh lang backends localize turn.failed missing-key errors (spec B1)', async () => {
    const { backend, events, spawned } = makeBackend({ lang: 'zh' });
    const { proc, pending } = await startTurn(backend, spawned, 'hi');
    pushEvent(proc, 'turn.failed', { error: { message: 'Model provider is missing an API key: builtin:zai-start-plan' } });
    await pending;
    await flush();
    const err = events.find((e) => e.type === 'error');
    assert.match(err.message, /缺少 API Key/);
    assert.match(err.message, /builtin:zai-start-plan/);
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/zcodeErrors.test.js test/zcodeBackend.test.js
  ```

  预期：zcodeErrors.test.js `ERR_MODULE_NOT_FOUND`；集成用例断言 zh 文案失败。

- [ ] **Step 3: 实现**

  新建 `plugin/panel/src/lib/zcodeErrors.js`：

  ```js
  // Spec B1: localize + actionable-ize ZCode failures. For zh a header line
  // with concrete next steps is prepended; the raw English detail is kept
  // below for diagnostics. en (and unknown patterns) pass through.
  const ZH_RULES = [
    {
      re: /Model provider is missing an API key:\s*([^\s.]+)/i,
      hint: (m) => 'ZCode provider「' + m[1] + '」缺少 API Key —— 到 设置 → AI 服务 → ZCode 通道 粘贴一次 Key（保存在本机 ~/.ae-mcp/zcode-key），或在 ~/.zcode/cli/config.json 里配置。',
    },
    {
      re: /Model config is missing/i,
      hint: () => '未找到 ZCode 模型配置 —— 打开 ZCode 选择 provider/model，或创建 ~/.zcode/cli/config.json 指定 provider 与默认模型。',
    },
    {
      re: /Provider authentication failed/i,
      hint: () => 'ZCode provider 鉴权失败 —— 检查 API Key 是否有效；若是官方托管计划（start-plan），面板尚不支持其桌面验证码桥接，请改用 CLI 配置通道。',
    },
  ];

  export function localizeZcodeError(message, lang = 'en') {
    const text = String(message || '');
    if (lang !== 'zh' || !text) return text;
    for (const rule of ZH_RULES) {
      const m = rule.re.exec(text);
      if (m) return rule.hint(m) + '\n' + text;
    }
    return text;
  }
  ```

  修改 `plugin/panel/src/cep/zcodeBackend.js`：

  - import 区追加：`import { localizeZcodeError } from '../lib/zcodeErrors.js';`
  - `zcodeErrorMessage`（621–635 行）加第三参 `lang` 并在每个 return 外层包 `localizeZcodeError(..., lang)`：

  ```js
  function zcodeErrorMessage(value, fallback = 'ZCode turn failed', lang = 'en') {
    if (!value) return localizeZcodeError(zcodeRepairHint(fallback), lang);
    if (typeof value === 'string') return localizeZcodeError(zcodeRepairHint(value), lang);
    if (typeof value === 'object') {
      const direct = value.message || value.detail || value.reason || value.error;
      if (direct && direct !== value) return zcodeErrorMessage(direct, fallback, lang);
      try {
        const text = JSON.stringify(value);
        return localizeZcodeError(zcodeRepairHint(text && text !== '{}' ? text : fallback), lang);
      } catch (e) {
        return localizeZcodeError(zcodeRepairHint(fallback), lang);
      }
    }
    return localizeZcodeError(zcodeRepairHint(String(value)), lang);
  }
  ```

  - 工厂内 6 处调用点补传 `lang`（工厂闭包内可直接取）：`handleProviderRuntimeHeaders` 的 `zcodeErrorMessage(e, 'ZCode desktop OAuth header refresh failed.', lang)`；`turn.failed` 分支 `zcodeErrorMessage(payload.error || payload.message, undefined, lang)`（改为 `zcodeErrorMessage(payload.error || payload.message, 'ZCode turn failed', lang)`）；`sendUser` 两处 `zcodeErrorMessage(e, 'Failed to start ZCode turn.', lang)`；`probeAccount` 的 `zcodeErrorMessage(e, 'ZCode runtime unavailable.', lang)`。模块级默认参数保证既有 en 测试不受影响。

- [ ] **Step 4: 跑测试确认通过**

  ```
  cd plugin/panel && node --test test/zcodeErrors.test.js test/zcodeBackend.test.js
  ```

- [ ] **Step 5: commit**

  ```
  git add plugin/panel/src/lib/zcodeErrors.js plugin/panel/test/zcodeErrors.test.js plugin/panel/src/cep/zcodeBackend.js plugin/panel/test/zcodeBackend.test.js
  git commit -m "feat(panel): bilingual actionable ZCode error messages"
  ```

## Task 6: Codex — spawn env 补全 + AE_MCP_CODEX_CLI + probe 诊断

spec B2：CEP 环境是 AE 启动时快照，`USERPROFILE/HOME/APPDATA` 可能缺失、PATH 上的 codex 可能不是登录那份。三改：`ensureUserEnv` 补全用户目录变量；`AE_MCP_CODEX_CLI` 覆盖二进制（对齐 `AE_MCP_ZCODE_CLI`）；probe 附带解析到的 codex 绝对路径与版本。

**Files:**
- Modify: `plugin/panel/src/lib/providerProfile.js`（新增 `ensureUserEnv`）
- Modify: `plugin/panel/src/cep/codexBackend.js`（新增 `resolveCodexCli` + `execFileAsync`；`startProcess` 407–441 行；`probeAccount` 593–616 行；工厂参数加 `resolveCli`）
- Test: `plugin/panel/test/providerProfile.test.js`、`plugin/panel/test/codexBackend.test.js`

- [ ] **Step 1: 写失败测试（ensureUserEnv）**

  在 `plugin/panel/test/providerProfile.test.js`：import 行加入 `ensureUserEnv`，末尾追加：

  ```js
  test('ensureUserEnv fills USERPROFILE/HOME/APPDATA from whichever anchor exists', () => {
    const fromHome = ensureUserEnv({ HOME: 'C:\Users\me\' });
    assert.equal(fromHome.USERPROFILE, 'C:\Users\me');
    assert.equal(fromHome.HOME, 'C:\Users\me\');
    assert.equal(fromHome.APPDATA, 'C:\Users\me\AppData\Roaming');

    const fromHomedir = ensureUserEnv({}, { homedir: 'C:\Users\me' });
    assert.equal(fromHomedir.USERPROFILE, 'C:\Users\me');
    assert.equal(fromHomedir.HOME, 'C:\Users\me');

    const untouched = ensureUserEnv({ USERPROFILE: 'C:\U', HOME: 'C:\U', APPDATA: 'C:\A' });
    assert.equal(untouched.APPDATA, 'C:\A');

    assert.deepEqual(ensureUserEnv({ PATH: 'x' }), { PATH: 'x' });
  });
  ```

- [ ] **Step 2: 跑测试确认失败，实现 ensureUserEnv**

  ```
  cd plugin/panel && node --test test/providerProfile.test.js
  ```

  预期：import 报 `ensureUserEnv` 未导出。然后在 `plugin/panel/src/lib/providerProfile.js` 末尾追加：

  ```js
  // Spec B2: the CEP env snapshot can miss USERPROFILE/HOME/APPDATA (they are
  // whatever AE was launched with). codex app-server needs them to locate its
  // login state, so fill them in before spawning.
  export function ensureUserEnv(env = {}, { homedir = '', appData = '' } = {}) {
    const next = { ...env };
    const anchor = String(next.USERPROFILE || next.HOME || homedir || '').replace(/[\/]+$/, '');
    if (!anchor) return next;
    if (!next.USERPROFILE) next.USERPROFILE = anchor;
    if (!next.HOME) next.HOME = anchor;
    if (!next.APPDATA) next.APPDATA = appData || anchor + '\AppData\Roaming';
    return next;
  }
  ```

  再跑同一命令确认通过。

- [ ] **Step 3: 写失败测试（codexBackend）**

  在 `plugin/panel/test/codexBackend.test.js` 末尾追加（复用该文件既有的 `makeSpawn`/`flush`/`makeBackend` 类 harness；若 helper 名不同，按文件内实际名替换，断言不变）：

  ```js
  test('spawn env is completed with USERPROFILE/HOME/APPDATA (spec B2)', async () => {
    const spawned = makeSpawn();
    const backend = createCodexBackend({
      spawnImpl: spawned.spawn,
      getModel: () => 'gpt-5.5',
      getPermissionMode: () => 'manual',
      getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
      getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
      env: { PATH: 'C:\bin', HOME: 'C:\Users\test' },
    });
    backend.sendUser('hi');
    await flush();
    const env = spawned.calls[0].options.env;
    assert.equal(env.USERPROFILE, 'C:\Users\test');
    assert.equal(env.APPDATA, 'C:\Users\test\AppData\Roaming');
  });

  test('AE_MCP_CODEX_CLI overrides the spawned codex binary', async () => {
    const spawned = makeSpawn();
    const backend = createCodexBackend({
      spawnImpl: spawned.spawn,
      getModel: () => 'gpt-5.5',
      getPermissionMode: () => 'manual',
      getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
      getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
      env: { PATH: 'C:\bin', AE_MCP_CODEX_CLI: 'D:\tools\codex\codex.exe' },
    });
    backend.sendUser('hi');
    await flush();
    assert.equal(spawned.calls[0].command, 'D:\tools\codex\codex.exe');
  });

  test('probeAccount reports resolved codex cliPath and cliVersion for diagnostics', async () => {
    const spawned = makeSpawn();
    const backend = createCodexBackend({
      spawnImpl: spawned.spawn,
      getModel: () => 'gpt-5.5',
      getPermissionMode: () => 'manual',
      getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
      getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
      env: { PATH: 'C:\bin' },
      resolveCli: async () => ({ ok: true, cliPath: 'C:\bin\codex.exe', version: 'codex-cli 1.2.3' }),
    });
    const probe = backend.probeAccount();
    await flush();
    const proc = spawned.procs[0];
    const writes = proc.writes.map((l) => JSON.parse(l));
    const init = writes.find((m) => m.method === 'initialize');
    proc.pushStdout(JSON.stringify({ id: init.id, result: {} }) + '\n');
    await flush();
    const account = proc.writes.map((l) => JSON.parse(l)).find((m) => m.method === 'account/read');
    proc.pushStdout(JSON.stringify({ id: account.id, result: { account: { email: 'a@b.c', planType: 'pro' } } }) + '\n');
    await flush();
    const modelList = proc.writes.map((l) => JSON.parse(l)).find((m) => m.method === 'model/list');
    proc.pushStdout(JSON.stringify({ id: modelList.id, result: { models: [] } }) + '\n');
    await flush();
    const result = await probe;
    assert.equal(result.loggedIn, true);
    assert.equal(result.cliPath, 'C:\bin\codex.exe');
    assert.equal(result.cliVersion, 'codex-cli 1.2.3');
  });
  ```

- [ ] **Step 4: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/codexBackend.test.js
  ```

  预期：spawn env 无 USERPROFILE、command 仍为 `'codex'`、probe 无 cliPath 字段。

- [ ] **Step 5: 实现 codexBackend.js**

  5a. import 行改为：

  ```js
  import { codexAppServerArgs, codexSpawnEnv, ensureUserEnv, normalizeProviderProfile } from '../lib/providerProfile.js';
  ```

  5b. 模块级新增（`createCodexBackend` 之前）：

  ```js
  function execFileAsync(execFile, cmd, args, env) {
    return new Promise((resolve) => {
      execFile(cmd, args, { env, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  function getHomedir() {
    try { return getCepRequire()('os').homedir(); } catch (e) { return ''; }
  }

  // Spec B2: resolve the codex binary explicitly. AE_MCP_CODEX_CLI overrides
  // (mirrors AE_MCP_ZCODE_CLI); otherwise `where codex` on the spawn PATH.
  export async function resolveCodexCli({ env, execFileImpl } = {}) {
    const override = env && env.AE_MCP_CODEX_CLI;
    if (override) return { ok: true, cliPath: String(override), version: '' };
    let execFile = execFileImpl;
    if (!execFile) {
      try { execFile = getCepRequire()('child_process').execFile; } catch (e) { return { ok: false, cliPath: '', version: '', detail: 'child_process unavailable' }; }
    }
    const where = await execFileAsync(execFile, 'where', ['codex'], env || {});
    if (!where.err && where.stdout) {
      const exe = String(where.stdout).split(/\r?\n/)[0].trim();
      if (exe) {
        const v = await execFileAsync(execFile, exe, ['--version'], env || {});
        return { ok: true, cliPath: exe, version: v.err ? '' : String(v.stdout || v.stderr || '').trim() };
      }
    }
    return { ok: false, cliPath: '', version: '', detail: 'codex CLI not found on PATH. Sign in with codex in a terminal, or set AE_MCP_CODEX_CLI to the executable.' };
  }
  ```

  5c. 工厂参数列表加（`getProviderProfile = () => ({}),` 之后）：

  ```js
    resolveCli = resolveCodexCli,
  ```

  工厂内状态区加一行：`let lastCliInfo = null;`

  5d. `startProcess`（407–441 行）中 spawn 段替换为：

  ```js
      const spawn = getSpawn();
      const spawnEnv = ensureUserEnv(currentEnv(), { homedir: getHomedir() });
      const providerProfile = normalizeProviderProfile(getProviderProfile ? getProviderProfile() : {}, spawnEnv);
      stderrTail = '';
      stopping = false;
      let execFileImpl = null;
      try { execFileImpl = getCepRequire()('child_process').execFile; } catch (e) { /* non-CEP env */ }
      const cliOverride = spawnEnv.AE_MCP_CODEX_CLI ? { ok: true, cliPath: String(spawnEnv.AE_MCP_CODEX_CLI), version: '' } : null;
      lastCliInfo = cliOverride || lastCliInfo;
      const command = cliOverride ? cliOverride.cliPath : 'codex';
      proc = spawn(command, codexAppServerArgs(providerProfile), {
        stdio: 'pipe',
        windowsHide: true,
        shell: true,
        env: codexSpawnEnv(providerProfile, spawnEnv),
      });
  ```

  （PATH 解析仍交给 `shell: true`；只有显式 override 换 command，避免 `where` 在 spawn 热路径上的额外延迟。probe 路径才做完整解析。）

  5e. `probeAccount`（593–616 行）替换为：

  ```js
    async function probeAccount() {
      const spawnEnv = ensureUserEnv(currentEnv(), { homedir: getHomedir() });
      let cliInfo = { ok: false, cliPath: '', version: '' };
      try {
        let execFileImpl = null;
        try { execFileImpl = getCepRequire()('child_process').execFile; } catch (e) { /* non-CEP env */ }
        cliInfo = await resolveCli({ env: spawnEnv, execFileImpl });
        lastCliInfo = cliInfo;
      } catch (e) { /* diagnostics only, never blocks the probe */ }
      const diag = { cliPath: cliInfo.cliPath || '', cliVersion: cliInfo.version || '' };
      try {
        await initialize();
        const accountResult = await rpc.request('account/read', {});
        let models = null;
        try {
          const listed = await rpc.request('model/list', {});
          models = Array.isArray(listed) ? listed : listed && listed.models;
        } catch (e) {
          models = null;
        }
        const account = accountResult && accountResult.account;
        if (!account) return { loggedIn: false, runtimeOk: true, detail: accountResult && accountResult.requiresOpenaiAuth ? 'OpenAI auth required' : undefined, models, ...diag };
        return {
          loggedIn: true,
          runtimeOk: true,
          email: account.email,
          planType: account.planType,
          models,
          ...diag,
        };
      } catch (e) {
        const detail = [e && e.message ? e.message : String(e), cliInfo.ok ? '' : cliInfo.detail].filter(Boolean).join(' | ');
        return { loggedIn: false, runtimeOk: false, detail, ...diag };
      }
    }
  ```

- [ ] **Step 6: 跑测试确认通过（含既有用例回归）**

  ```
  cd plugin/panel && node --test test/codexBackend.test.js test/providerProfile.test.js
  ```

- [ ] **Step 7: commit**

  ```
  git add plugin/panel/src/lib/providerProfile.js plugin/panel/src/cep/codexBackend.js plugin/panel/test/providerProfile.test.js plugin/panel/test/codexBackend.test.js
  git commit -m "fix(panel): codex spawn env completion, AE_MCP_CODEX_CLI override, probe diagnostics"
  ```

## Task 7: Claude 通道条件化 env（面板侧）

spec A/B3：把 `claudeAuth.js:62` 与 `claudeAgentBackend.js:71` 两处无条件 `delete ANTHROPIC_API_KEY` 改为按通道条件化。新纯函数 `claudeChannelEnv`：`subscription` 通道删 `ANTHROPIC_API_KEY` 且清掉继承的 `ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`（防串路）；`api` 通道注入所选 provider 的 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（Agent SDK 原生支持 → 第三方中转获得完整 agentic 能力），同样删 `ANTHROPIC_API_KEY`（鉴权走 AUTH_TOKEN）。

**Files:**
- Create: `plugin/panel/src/lib/claudeChannel.js`
- Modify: `plugin/panel/src/cep/claudeAgentBackend.js`（`sanitizeEnv` 69–73 行删除；工厂参数 80–93 行加 `getChannel`/`getApiProvider`；`startSidecar` 210 行 spawnEnv、235–246 行 spawn args）
- Modify: `plugin/panel/src/cep/claudeAuth.js`（61–62 行）
- Test: `plugin/panel/test/claudeChannel.test.js`（新建）、`plugin/panel/test/claudeAgentBackend.test.js`

- [ ] **Step 1: 写失败测试（claudeChannelEnv）**

  新建 `plugin/panel/test/claudeChannel.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { claudeChannelEnv } from '../src/lib/claudeChannel.js';

  test('subscription channel strips ANTHROPIC_API_KEY and inherited base URL/token', () => {
    const env = claudeChannelEnv(
      { PATH: 'x', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://other', ANTHROPIC_AUTH_TOKEN: 'other-tok' },
      { channel: 'subscription' }
    );
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.PATH, 'x');
  });

  test('api channel injects provider base URL + auth token and still drops API key', () => {
    const env = claudeChannelEnv(
      { PATH: 'x', ANTHROPIC_API_KEY: 'leak' },
      { channel: 'api', provider: { baseUrl: 'https://relay.example/anthropic', apiKey: 'sk-relay' } }
    );
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://relay.example/anthropic');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-relay');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  test('api channel without a usable provider behaves like subscription', () => {
    const env = claudeChannelEnv({ ANTHROPIC_BASE_URL: 'https://stale' }, { channel: 'api', provider: null });
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  });
  ```

- [ ] **Step 2: 跑测试确认失败，实现 claudeChannel.js**

  ```
  cd plugin/panel && node --test test/claudeChannel.test.js
  ```

  预期 `ERR_MODULE_NOT_FOUND`。新建 `plugin/panel/src/lib/claudeChannel.js`：

  ```js
  // Spec A/B3: Claude backend credential channels.
  // 'subscription' -> Agent SDK self-discovery; remove ANTHROPIC_API_KEY and
  //   any inherited base URL/token so a stray env can't hijack the session.
  // 'api' -> inject ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN from the chosen
  //   provider entry (Agent SDK natively supports third-party endpoints, so
  //   the panel keeps full agentic capabilities on relays).
  export function claudeChannelEnv(baseEnv = {}, { channel = 'subscription', provider = null } = {}) {
    const env = { ...baseEnv };
    delete env.ANTHROPIC_API_KEY;
    if (channel === 'api' && provider && provider.baseUrl) {
      env.ANTHROPIC_BASE_URL = String(provider.baseUrl);
      if (provider.apiKey) env.ANTHROPIC_AUTH_TOKEN = String(provider.apiKey);
      else delete env.ANTHROPIC_AUTH_TOKEN;
      return env;
    }
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }
  ```

  确认 3 个用例通过。

- [ ] **Step 3: 写失败测试（backend 接线），实现 claudeAgentBackend + claudeAuth**

  在 `plugin/panel/test/claudeAgentBackend.test.js` 末尾追加（复用文件内既有 spawn harness；若命名不同按实际替换，断言不变；若无等价 helper，参照 zcodeBackend.test.js 的 `makeProc`/`makeSpawn`/`flush` 原样补一份到本文件）：

  ```js
  test('api channel spawns the sidecar with injected base URL/token and --channel api', async () => {
    const spawned = makeSpawn();
    const backend = createClaudeAgentBackend({
      resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
      sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
      getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
      getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
      getModel: () => 'claude-sonnet-5',
      getPermissionMode: () => 'manual',
      getChannel: () => 'api',
      getApiProvider: () => ({ baseUrl: 'https://relay.example/anthropic', apiKey: 'sk-relay' }),
      spawnImpl: spawned.spawn,
      env: { PATH: 'C:\bin', ANTHROPIC_API_KEY: 'leak' },
    });
    const run = backend.sendUser('hi');
    await flush();
    const proc = spawned.procs[0];
    proc.pushStdout(JSON.stringify({ t: 'ready' }) + '\n');
    await flush();
    const call = spawned.calls[0];
    assert.equal(call.options.env.ANTHROPIC_BASE_URL, 'https://relay.example/anthropic');
    assert.equal(call.options.env.ANTHROPIC_AUTH_TOKEN, 'sk-relay');
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
    const flagIndex = call.args.indexOf('--channel');
    assert.ok(flagIndex > -1, '--channel flag passed to sidecar');
    assert.equal(call.args[flagIndex + 1], 'api');
    backend.reset();
    await run;
  });

  test('default subscription channel keeps current sanitize behavior and passes --channel subscription', async () => {
    const spawned = makeSpawn();
    const backend = createClaudeAgentBackend({
      resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
      sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
      getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
      getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
      getModel: () => 'claude-sonnet-5',
      getPermissionMode: () => 'manual',
      spawnImpl: spawned.spawn,
      env: { PATH: 'C:\bin', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://stale' },
    });
    const run = backend.sendUser('hi');
    await flush();
    const proc = spawned.procs[0];
    proc.pushStdout(JSON.stringify({ t: 'ready' }) + '\n');
    await flush();
    const call = spawned.calls[0];
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.options.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(call.args[call.args.indexOf('--channel') + 1], 'subscription');
    backend.reset();
    await run;
  });
  ```

  跑 `node --test test/claudeAgentBackend.test.js` 确认失败（无 `--channel`、BASE_URL 未注入）。然后修改 `plugin/panel/src/cep/claudeAgentBackend.js`：

  - import 区追加：`import { claudeChannelEnv } from '../lib/claudeChannel.js';`
  - 删除 `sanitizeEnv`（69–73 行）。
  - 工厂签名（80–93 行）在 `getThinking,` 之后加两个参数：

  ```js
    getChannel = () => 'subscription',
    getApiProvider = () => null,
  ```

  - `startSidecar` 内（原 210 行）`const spawnEnv = sanitizeEnv(env || getCepEnv());` 替换为：

  ```js
        const channel = getChannel ? getChannel() : 'subscription';
        const spawnEnv = claudeChannelEnv(env || getCepEnv(), { channel, provider: getApiProvider ? getApiProvider() : null });
  ```

  - spawn 参数数组（原 235–246 行）在 `'--lang', lang,` 之后加：

  ```js
            '--channel', channel,
  ```

  修改 `plugin/panel/src/cep/claudeAuth.js`：import 区加 `import { claudeChannelEnv } from '../lib/claudeChannel.js';`，61–62 行

  ```js
      const spawnEnv = Object.assign({}, getCepEnv(), env || {});
      delete spawnEnv.ANTHROPIC_API_KEY;
  ```

  替换为：

  ```js
      // Subscription-channel probe: strip key/base-url overrides (spec B3).
      const spawnEnv = claudeChannelEnv(Object.assign({}, getCepEnv(), env || {}), { channel: 'subscription' });
  ```

- [ ] **Step 4: 跑测试确认通过（含 claudeAuth 回归）**

  ```
  cd plugin/panel && node --test test/claudeChannel.test.js test/claudeAgentBackend.test.js test/claudeAuth.test.js
  ```

- [ ] **Step 5: commit**

  ```
  git add plugin/panel/src/lib/claudeChannel.js plugin/panel/test/claudeChannel.test.js plugin/panel/src/cep/claudeAgentBackend.js plugin/panel/test/claudeAgentBackend.test.js plugin/panel/src/cep/claudeAuth.js
  git commit -m "feat(panel): channel-conditional anthropic env for claude backend"
  ```

## Task 8: sidecar — --channel 参数 + cleanEnv 条件化

spec B3/E 第三处：`plugin/sidecar/lib.mjs:495` 的 `cleanEnv` 无条件删 `ANTHROPIC_API_KEY`。改为：`subscription`（默认）保持删除；`api` 通道原样透传（面板注入的 `ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN` 不能被清掉，`ANTHROPIC_API_KEY` 已在面板侧删过，但即使残留也不再二次干预——单一职责在面板）。

**Files:**
- Modify: `plugin/sidecar/lib.mjs`（`parseArgv` 48–79 行、`createSidecar` 内 `baseEnv`、`normalizeOptions` 475–484 行、`cleanEnv` 493–497 行）
- Test: `plugin/sidecar/test/sidecar.test.js`

- [ ] **Step 1: 写失败测试**

  `plugin/sidecar/test/sidecar.test.js` 顶部 import 改为 `import { createSidecar, parseArgv } from '../lib.mjs'`，末尾追加：

  ```js
  test('parseArgv accepts --channel api and defaults to subscription', () => {
    assert.equal(parseArgv(['--channel', 'api']).channel, 'api')
    assert.equal(parseArgv([]).channel, 'subscription')
    assert.equal(parseArgv(['--channel', 'bogus']).channel, 'subscription')
  })

  test('api channel keeps injected anthropic env vars in query env', async () => {
    let queryEnv = null
    const sidecar = createSidecar({
      queryFn: async function * ({ options }) {
        queryEnv = options.env
        yield { type: 'result', subtype: 'success', is_error: false }
      },
      writeLine: () => {},
      argvOptions: { ...defaultOptions, channel: 'api' },
      env: { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'tok' }
    })
    sidecar.handleLine(JSON.stringify({ t: 'user', text: 'env', permissionMode: 'none' }))
    await waitFor(() => queryEnv !== null)
    assert.equal(queryEnv.ANTHROPIC_API_KEY, 'secret')
    assert.equal(queryEnv.ANTHROPIC_BASE_URL, 'https://relay.example')
    assert.equal(queryEnv.ANTHROPIC_AUTH_TOKEN, 'tok')
  })
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/sidecar && node --test test/sidecar.test.js
  ```

  预期：`parseArgv` 报 `Unknown argument: --channel`；api 用例 `queryEnv.ANTHROPIC_API_KEY` 为 undefined。

- [ ] **Step 3: 实现 lib.mjs**

  - `parseArgv` 的 options 初始化对象加 `channel: 'subscription'`；在 `--lang` 分支之后加：

  ```js
      } else if (arg === '--channel') {
        const channel = argv[++i]
        options.channel = channel === 'api' ? 'api' : 'subscription'
  ```

  - `createSidecar` 内 `const baseEnv = cleanEnv(env || {})` 改为 `const baseEnv = cleanEnv(env || {}, options.channel)`。
  - `normalizeOptions` 返回对象加 `channel: argvOptions.channel === 'api' ? 'api' : 'subscription',`。
  - `cleanEnv` 替换为：

  ```js
  function cleanEnv (inputEnv, channel = 'subscription') {
    const output = { ...inputEnv }
    // Subscription channel: the Agent SDK must self-discover login state, so a
    // stray ANTHROPIC_API_KEY would silently reroute billing (spec B3).
    // API-direct channel: the panel already curated the env (base URL + auth
    // token injected); pass it through untouched.
    if (channel !== 'api') {
      delete output.ANTHROPIC_API_KEY
    }
    return output
  }
  ```

- [ ] **Step 4: 跑测试确认通过（原 `query options env removes ANTHROPIC_API_KEY` 用例必须仍绿）**

  ```
  cd plugin/sidecar && node --test test/sidecar.test.js
  ```

- [ ] **Step 5: commit**

  ```
  git add plugin/sidecar/lib.mjs plugin/sidecar/test/sidecar.test.js
  git commit -m "feat(sidecar): channel-aware env handling via --channel flag"
  ```

## Task 9: ~/.claude/settings.json env 一键导入 reader

spec B3 低成本继承：若 `~/.claude/settings.json` 有 `env.ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`，提供一键导入预填 API 直连通道（UI 接线在 Task 12；本任务只做 reader）。

**Files:**
- Create: `plugin/panel/src/cep/claudeSettingsImport.js`
- Test: `plugin/panel/test/claudeSettingsImport.test.js`（新建）

- [ ] **Step 1: 写失败测试**

  新建 `plugin/panel/test/claudeSettingsImport.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { readClaudeSettingsEnv } from '../src/cep/claudeSettingsImport.js';

  function fakeFs(files) {
    return {
      readFileSync(p) {
        if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return files[p];
      },
    };
  }

  test('reads ANTHROPIC_BASE_URL/AUTH_TOKEN from ~/.claude/settings.json env block', () => {
    const files = {
      'C:\Users\me\.claude\settings.json': JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-relay' },
      }),
    };
    assert.deepEqual(
      readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\Users\me' }, fsImpl: fakeFs(files) }),
      { baseUrl: 'https://relay.example/anthropic', authToken: 'sk-relay' }
    );
  });

  test('returns null for missing file, bad JSON, or no relevant env keys', () => {
    assert.equal(readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\Users\me' }, fsImpl: fakeFs({}) }), null);
    assert.equal(readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\Users\me' }, fsImpl: fakeFs({ 'C:\Users\me\.claude\settings.json': '{oops' }) }), null);
    assert.equal(readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\Users\me' }, fsImpl: fakeFs({ 'C:\Users\me\.claude\settings.json': JSON.stringify({ env: { OTHER: '1' } }) }) }), null);
    assert.equal(readClaudeSettingsEnv({ env: {}, fsImpl: fakeFs({}) }), null);
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/claudeSettingsImport.test.js
  ```

- [ ] **Step 3: 实现**

  新建 `plugin/panel/src/cep/claudeSettingsImport.js`：

  ```js
  // Spec B3: one-click inherit of Claude Code's third-party endpoint config.
  // Only reads the documented env block of ~/.claude/settings.json; the
  // Claude-3p host-creds file is intentionally NOT read (internal format).
  function getCepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error('CEP Node require is unavailable');
  }

  export function readClaudeSettingsEnv({ env = {}, fsImpl } = {}) {
    const home = env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : '');
    if (!home) return null;
    let fs;
    try { fs = fsImpl || getCepRequire()('fs'); } catch (e) { return null; }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(String(home).replace(/[\/]+$/, '') + '\.claude\settings.json', 'utf8'));
    } catch (e) {
      return null;
    }
    const settingsEnv = parsed && parsed.env && typeof parsed.env === 'object' ? parsed.env : {};
    const baseUrl = String(settingsEnv.ANTHROPIC_BASE_URL || '').trim();
    const authToken = String(settingsEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
    if (!baseUrl && !authToken) return null;
    return { baseUrl, authToken };
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  ```
  cd plugin/panel && node --test test/claudeSettingsImport.test.js
  ```

- [ ] **Step 5: commit**

  ```
  git add plugin/panel/src/cep/claudeSettingsImport.js plugin/panel/test/claudeSettingsImport.test.js
  git commit -m "feat(panel): read anthropic endpoint env from ~/.claude/settings.json"
  ```

## Task 10: probeChannels 数据结构 + pickBackend 重构 + App.jsx 接线

spec A/D 核心：每后端统一 `[{channel, source, ok, checking, detail, fixHint:{zh,en}}]`；`pickBackend` 消费该结构替代 probe/codexProbe/zcodeProbe 三套异构判断；全部不可用状态携带双语可操作 `fixHint`；BYOK 从"第四个后端"降为 Claude 的 `api` 通道（`byok` 实例仅作 Node 缺失时的降级执行器）；支持手动锁定通道（`ae_mcp_channel_lock`）。

**Files:**
- Create: `plugin/panel/src/lib/channels.js`
- Modify: `plugin/panel/src/lib/backendSelect.js`（`pickBackend` 3–29 行整体重写）
- Modify: `plugin/panel/src/cep/backends/index.js`（注册 `claude-api`）
- Modify: `plugin/panel/src/app/App.jsx`（backendPref 迁移、channels 组装、effective 选择、backendInstances、disabledHint）
- Test: `plugin/panel/test/channels.test.js`（新建）、`plugin/panel/test/backendSelect.test.js`（重写 pickBackend 部分）

- [ ] **Step 1: 写失败测试（channels.js）**

  新建 `plugin/panel/test/channels.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { claudeChannels, codexChannels, zcodeChannels, pickChannel, migrateBackendPref } from '../src/lib/channels.js';

  test('claudeChannels: subscription reflects probe, api reflects provider entry', () => {
    const probing = claudeChannels({ probe: null, apiProvider: null });
    assert.equal(probing[0].channel, 'subscription');
    assert.equal(probing[0].checking, true);
    const ready = claudeChannels({ probe: { nodeOk: true, loggedIn: true }, apiProvider: null });
    assert.equal(ready[0].ok, true);
    assert.equal(ready[1].channel, 'api');
    assert.equal(ready[1].ok, false);
    assert.match(ready[1].fixHint.zh, /Provider 管理/);
    const withApi = claudeChannels({ probe: { nodeOk: true, loggedIn: false }, apiProvider: { baseUrl: 'https://r', apiKey: 'k' } });
    assert.equal(withApi[0].ok, false);
    assert.match(withApi[0].fixHint.zh, /API 直连/);
    assert.equal(withApi[1].ok, true);
  });

  test('codexChannels: cli login state + custom provider channel', () => {
    const list = codexChannels({ codexProbe: { loggedIn: true, runtimeOk: true, cliPath: 'C:\codex.exe', cliVersion: '1.2' }, customProvider: null });
    assert.equal(list[0].channel, 'cli');
    assert.equal(list[0].ok, true);
    assert.match(list[0].detail, /codex\.exe/);
    assert.equal(list[1].channel, 'custom');
    assert.equal(list[1].ok, false);
    const custom = codexChannels({ codexProbe: { loggedIn: false, runtimeOk: true }, customProvider: { baseUrl: 'https://r', apiKey: 'k' } });
    assert.equal(custom[1].ok, true);
    assert.match(codexChannels({ codexProbe: { loggedIn: false } }).find((c) => c.channel === 'cli').fixHint.zh, /AE_MCP_CODEX_CLI/);
  });

  test('zcodeChannels: cli-config first, desktop second, start-plan never ok without credentials', () => {
    const summary = {
      cli: { providerId: 'mediastorm_glm', model: 'mediastorm_glm/glm-5.2', apiKeyEnv: 'MEDIASTORM_GLM_API_KEY', hasCredential: true, keySource: 'env' },
      desktop: { providerId: 'builtin:zai-start-plan' },
      startPlan: { providerId: 'builtin:zai-start-plan', hasCredential: false },
    };
    const list = zcodeChannels({ zcodeProbe: { loggedIn: true, runtimeOk: true }, configSummary: summary });
    assert.deepEqual(list.map((c) => c.channel), ['cli-config', 'desktop', 'start-plan']);
    assert.equal(list[0].ok, true);
    assert.equal(list[2].ok, false, 'keyless start-plan must never be selectable (spec B1)');
    assert.match(list[2].fixHint.zh, /验证码/);
    const noKey = zcodeChannels({
      zcodeProbe: { loggedIn: true, runtimeOk: true },
      configSummary: { ...summary, cli: { ...summary.cli, hasCredential: false, keySource: '' } },
    });
    assert.equal(noKey[0].ok, false);
    assert.match(noKey[0].fixHint.zh, /粘贴/);
    assert.match(noKey[0].fixHint.en, /MEDIASTORM_GLM_API_KEY/);
  });

  test('pickChannel: first ok wins; explicit lock is honored even when not ok', () => {
    const channels = [
      { channel: 'a', ok: false },
      { channel: 'b', ok: true },
      { channel: 'c', ok: true },
    ];
    assert.equal(pickChannel(channels).channel, 'b');
    assert.equal(pickChannel(channels, 'c').channel, 'c');
    assert.equal(pickChannel(channels, 'a').channel, 'a');
    assert.equal(pickChannel([]), null);
  });

  test('migrateBackendPref maps legacy byok/opencode prefs onto the 3-way model', () => {
    function storage(init) {
      const map = new Map(Object.entries(init));
      return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), map };
    }
    const byok = storage({ ae_mcp_backend: 'byok' });
    assert.deepEqual(migrateBackendPref(byok), { pref: 'subscription', lockedChannel: 'api' });
    assert.equal(byok.map.get('ae_mcp_backend'), 'subscription');
    assert.equal(byok.map.get('ae_mcp_channel_lock'), 'api');
    const oc = storage({ ae_mcp_backend: 'opencode' });
    assert.deepEqual(migrateBackendPref(oc), { pref: 'subscription', lockedChannel: '' });
    const keep = storage({ ae_mcp_backend: 'codex', ae_mcp_channel_lock: 'cli' });
    assert.deepEqual(migrateBackendPref(keep), { pref: 'codex', lockedChannel: 'cli' });
    assert.deepEqual(migrateBackendPref(storage({})), { pref: 'subscription', lockedChannel: '' });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/channels.test.js
  ```

- [ ] **Step 3: 实现 channels.js**

  新建 `plugin/panel/src/lib/channels.js`：

  ```js
  // Spec A/D: unified per-backend credential channels.
  // ChannelProbe: { channel, source:{zh,en}, checking, ok, detail, fixHint:{zh,en} }
  // Order in each array IS the priority order (channel (1) first).

  export function claudeChannels({ probe, apiProvider } = {}) {
    const sub = {
      channel: 'subscription',
      source: { zh: '订阅登录', en: 'Subscription login' },
      checking: probe === null,
      ok: Boolean(probe && probe.nodeOk !== false && probe.loggedIn),
      detail: (probe && probe.detail) || '',
      fixHint: probe && probe.nodeOk === false
        ? { zh: '内嵌对话需要系统 Node 18+：安装 Node.js LTS 后重新检测；或使用下方「API 直连」通道（无 Node 时自动降级为直连 HTTP）。', en: 'Embedded chat needs system Node 18+: install Node.js LTS and re-check, or use the API direct channel below (falls back to direct HTTP without Node).' }
        : { zh: '订阅未登录：在终端运行 claude /login 完成登录后重新检测；或改用下方「API 直连」通道。', en: 'Not logged in: run claude /login in a terminal and re-check, or switch to the API direct channel below.' },
    };
    const api = {
      channel: 'api',
      source: { zh: '面板配置 · API 直连', en: 'Panel config · API direct' },
      checking: false,
      ok: Boolean(apiProvider && apiProvider.baseUrl && apiProvider.apiKey),
      detail: apiProvider && apiProvider.baseUrl ? apiProvider.baseUrl : '',
      fixHint: { zh: '在「Provider 管理」新增/选择一个 Anthropic 协议 provider（Base URL + Key/Token），或一键导入 ~/.claude/settings.json。Claude-3p 桌面版凭据无法自动读取，请手动填一次。', en: 'Add or pick an Anthropic-protocol provider (base URL + key/token) in Provider Manager, or import from ~/.claude/settings.json. Claude-3p desktop credentials cannot be read automatically; paste them once.' },
    };
    return [sub, api];
  }

  export function codexChannels({ codexProbe, customProvider } = {}) {
    const cli = {
      channel: 'cli',
      source: { zh: 'Codex CLI 登录态', en: 'Codex CLI login' },
      checking: codexProbe === null,
      ok: Boolean(codexProbe && codexProbe.loggedIn),
      detail: codexProbe ? [codexProbe.email, codexProbe.planType, codexProbe.cliPath, codexProbe.cliVersion].filter(Boolean).join(' · ') : '',
      fixHint: { zh: '在终端完成 codex 登录后重新检测；若 codex 不在面板 PATH 上，设置环境变量 AE_MCP_CODEX_CLI 指向 codex 可执行文件后重启 AE。', en: 'Sign in with codex in a terminal and re-check; if codex is not on the panel PATH, set AE_MCP_CODEX_CLI to the codex executable and restart AE.' },
    };
    const custom = {
      channel: 'custom',
      source: { zh: '自定义 provider', en: 'Custom provider' },
      checking: false,
      ok: Boolean(customProvider && customProvider.baseUrl && customProvider.apiKey && (!codexProbe || codexProbe.runtimeOk !== false)),
      detail: customProvider && customProvider.baseUrl ? customProvider.baseUrl : '',
      fixHint: { zh: '在「Provider 管理」新增/选择一个 OpenAI 兼容 provider（Base URL + Key）。', en: 'Add or pick an OpenAI-compatible provider (base URL + key) in Provider Manager.' },
    };
    return [cli, custom];
  }

  export function zcodeChannels({ zcodeProbe, configSummary } = {}) {
    const summary = configSummary || {};
    const runtimeOk = Boolean(zcodeProbe && zcodeProbe.runtimeOk !== false);
    const runtimeHint = { zh: 'ZCode 运行时不可用：安装 ZCode、确认系统 Node 可用，或设置 AE_MCP_ZCODE_CLI 后重新检测。', en: 'ZCode runtime unavailable: install ZCode, confirm system Node, or set AE_MCP_ZCODE_CLI, then re-check.' };
    const cli = {
      channel: 'cli-config',
      source: { zh: '继承自 ZCode CLI', en: 'Inherited from ZCode CLI' },
      checking: zcodeProbe === null,
      ok: Boolean(summary.cli && summary.cli.hasCredential && runtimeOk),
      detail: summary.cli ? (summary.cli.model || summary.cli.providerId) : '',
      fixHint: !runtimeOk && summary.cli ? runtimeHint
        : summary.cli && !summary.cli.hasCredential
          ? { zh: '检测到 ZCode CLI provider「' + summary.cli.providerId + '」，但其 API Key 环境变量（' + (summary.cli.apiKeyEnv || '-') + '）没有被面板继承。在下方粘贴一次 Key（保存到本机 ~/.ae-mcp/zcode-key）即可使用。', en: 'Found ZCode CLI provider "' + summary.cli.providerId + '", but its API key env (' + (summary.cli.apiKeyEnv || '-') + ') is not inherited by the panel. Paste the key once below (stored at ~/.ae-mcp/zcode-key).' }
          : { zh: '未找到 ~/.zcode/cli/config.json 的可用 provider：先在 ZCode CLI 里配置 provider 与默认模型。', en: 'No usable provider in ~/.zcode/cli/config.json: configure a provider and default model in the ZCode CLI first.' },
    };
    const desktop = {
      channel: 'desktop',
      source: { zh: '继承自 ZCode 桌面版', en: 'Inherited from ZCode desktop' },
      checking: zcodeProbe === null,
      ok: Boolean(summary.desktop && runtimeOk),
      detail: summary.desktop ? summary.desktop.providerId : '',
      fixHint: !runtimeOk && summary.desktop ? runtimeHint
        : { zh: '打开 ZCode 桌面版并选择一个 provider/model，然后重新检测。', en: 'Open ZCode desktop, pick a provider/model, then re-check.' },
    };
    const startPlan = {
      channel: 'start-plan',
      source: { zh: '官方托管计划', en: 'Official hosted plan' },
      checking: false,
      ok: Boolean(summary.startPlan && summary.startPlan.hasCredential && runtimeOk),
      detail: summary.startPlan ? summary.startPlan.providerId : '',
      fixHint: { zh: '官方托管计划需要 ZCode 桌面验证码桥接（面板尚未实现）：检测到有效凭据前不可选。请使用 CLI 配置或桌面版通道。', en: 'The hosted plan needs the ZCode desktop captcha bridge (not implemented in the panel yet) and stays unavailable until valid credentials are detected. Use the CLI-config or desktop channel instead.' },
    };
    return [cli, desktop, startPlan];
  }

  export function pickChannel(channels, lockedChannel = '') {
    const list = Array.isArray(channels) ? channels : [];
    if (lockedChannel) {
      const locked = list.find((c) => c && c.channel === lockedChannel);
      if (locked) return locked;
    }
    return list.find((c) => c && c.ok) || null;
  }

  // Legacy pref migration: 'byok' collapses into Claude's api channel (spec:
  // BYOK 并入 Claude); 'opencode' was never exposed in the 3-way UI.
  export function migrateBackendPref(storage) {
    let pref = 'subscription';
    let lockedChannel = '';
    try {
      const raw = storage.getItem('ae_mcp_backend') || 'subscription';
      lockedChannel = storage.getItem('ae_mcp_channel_lock') || '';
      if (raw === 'byok') {
        pref = 'subscription';
        lockedChannel = 'api';
        storage.setItem('ae_mcp_backend', pref);
        storage.setItem('ae_mcp_channel_lock', lockedChannel);
      } else if (raw === 'opencode') {
        pref = 'subscription';
        storage.setItem('ae_mcp_backend', pref);
      } else if (raw === 'codex' || raw === 'zcode' || raw === 'subscription') {
        pref = raw;
      }
    } catch (e) { /* storage unavailable -> defaults */ }
    return { pref, lockedChannel };
  }
  ```

  跑 `node --test test/channels.test.js` 确认 5 个用例通过。

- [ ] **Step 4: 写失败测试（pickBackend 新签名），重写 backendSelect**

  重写 `plugin/panel/test/backendSelect.test.js` 中所有 `pickBackend` 用例（`deriveToolMeta`/`shouldResetOnBackendChange` 用例保持不动），替换为：

  ```js
  import { pickBackend, deriveToolMeta, shouldResetOnBackendChange } from '../src/lib/backendSelect.js';
  import { claudeChannels, codexChannels, zcodeChannels } from '../src/lib/channels.js';

  function ch(channel, ok, fixHint = { zh: 'zh-fix', en: 'en-fix' }, checking = false) {
    return { channel, ok, checking, detail: '', source: { zh: 's', en: 's' }, fixHint };
  }

  test('pickBackend: claude subscription channel wins when ok', () => {
    const result = pickBackend({ pref: 'subscription', channels: { claude: [ch('subscription', true), ch('api', false)] } });
    assert.deepEqual(result, { backend: 'subscription', reason: 'ok', channel: 'subscription', fixHint: null });
  });

  test('pickBackend: claude api channel routes to claude-api with node, byok without', () => {
    const channels = { claude: [ch('subscription', false), ch('api', true)] };
    assert.equal(pickBackend({ pref: 'subscription', channels, nodeOk: true }).backend, 'claude-api');
    assert.equal(pickBackend({ pref: 'subscription', channels, nodeOk: false }).backend, 'byok');
  });

  test('pickBackend: probing and no-channel states carry reason + fixHint', () => {
    const probing = pickBackend({ pref: 'codex', channels: { codex: [ch('cli', false, undefined, true)] } });
    assert.deepEqual(probing, { backend: 'none', reason: 'codex-probing', channel: null, fixHint: null });
    const dead = pickBackend({ pref: 'zcode', channels: { zcode: [ch('cli-config', false), ch('desktop', false)] } });
    assert.equal(dead.backend, 'none');
    assert.equal(dead.reason, 'zcode-no-channel');
    assert.equal(dead.fixHint.zh, 'zh-fix');
  });

  test('pickBackend: locked channel is respected; a locked-but-broken channel surfaces its own fixHint', () => {
    const channels = { codex: [ch('cli', true), ch('custom', true)] };
    assert.equal(pickBackend({ pref: 'codex', channels, lockedChannel: 'custom' }).channel, 'custom');
    const brokenLock = pickBackend({ pref: 'codex', channels: { codex: [ch('cli', true), ch('custom', false, { zh: '配 provider', en: 'add provider' })] }, lockedChannel: 'custom' });
    assert.equal(brokenLock.backend, 'none');
    assert.equal(brokenLock.fixHint.zh, '配 provider');
  });

  test('pickBackend integrates with real channel builders end to end', () => {
    const channels = {
      claude: claudeChannels({ probe: { nodeOk: true, loggedIn: true }, apiProvider: null }),
      codex: codexChannels({ codexProbe: null }),
      zcode: zcodeChannels({ zcodeProbe: { runtimeOk: true }, configSummary: { startPlan: { providerId: 'builtin:zai-start-plan', hasCredential: false } } }),
    };
    assert.equal(pickBackend({ pref: 'subscription', channels }).backend, 'subscription');
    assert.equal(pickBackend({ pref: 'codex', channels }).reason, 'codex-probing');
    const zc = pickBackend({ pref: 'zcode', channels });
    assert.equal(zc.backend, 'none', 'keyless start-plan never becomes the default');
  });
  ```

  跑 `node --test test/backendSelect.test.js` 确认失败后，重写 `plugin/panel/src/lib/backendSelect.js` 的 `pickBackend`（3–29 行）：

  ```js
  import { REAL_BACKENDS } from '../cep/backends/index.js';
  import { pickChannel } from './channels.js';

  // Spec D: one selection algorithm for all backends, fed by uniform channel
  // probe arrays. `pref` is the 3-way backend choice (subscription|codex|zcode);
  // channels = { claude: [...], codex: [...], zcode: [...] }.
  export function pickBackend({ pref, channels = {}, lockedChannel = '', nodeOk = true }) {
    const group = pref === 'codex' || pref === 'zcode' ? pref : 'claude';
    const list = channels[group] || [];
    if (list.some((c) => c && c.checking)) {
      return { backend: 'none', reason: group + '-probing', channel: null, fixHint: null };
    }
    const chosen = pickChannel(list, lockedChannel);
    if (!chosen || !chosen.ok) {
      const hintSource = chosen || list.find((c) => c && !c.ok) || list[0] || null;
      return {
        backend: 'none',
        reason: group + '-no-channel',
        channel: chosen ? chosen.channel : null,
        fixHint: hintSource ? hintSource.fixHint || null : null,
      };
    }
    if (group === 'claude') {
      if (chosen.channel === 'api') {
        return { backend: nodeOk ? 'claude-api' : 'byok', reason: 'ok', channel: 'api', fixHint: null };
      }
      return { backend: 'subscription', reason: 'ok', channel: 'subscription', fixHint: null };
    }
    return { backend: group, reason: 'ok', channel: chosen.channel, fixHint: null };
  }
  ```

  修改 `plugin/panel/src/cep/backends/index.js`：`BACKENDS` 表加一行（`byok` 之后）：

  ```js
    'claude-api': { id: 'claude-api', baseDescriptor: byokStaticDescriptor },
  ```

  （`REAL_BACKENDS = Object.keys(BACKENDS)` 自动包含，backend 切换 reset 逻辑无需改。）

- [ ] **Step 5: App.jsx 接线**

  修改 `plugin/panel/src/app/App.jsx`（最小接线，UI 卡片在 Task 12）：

  5a. import 区追加：

  ```js
  import { claudeChannels, codexChannels, zcodeChannels, migrateBackendPref } from '../lib/channels.js';
  import { createProviderStore } from '../cep/providerStore';
  ```

  并把既有 `import { createZcodeBackend } from '../cep/zcodeBackend';` 合并为 `import { createZcodeBackend, summarizeZcodeConfig } from '../cep/zcodeBackend';`。

  5b. `backendPref` 初始化（原 252 行）替换为迁移读取，并新增通道锁与 provider 选择状态：

  ```js
    const backendMigration = React.useMemo(() => migrateBackendPref(window.localStorage), []);
    const [backendPref, setBackendPref] = React.useState(() => backendMigration.pref);
    const [channelLock, setChannelLock] = React.useState(() => backendMigration.lockedChannel);
    const providerStore = React.useMemo(() => {
      try {
        const store = createProviderStore();
        store.migrateLegacy({
          readKey: (name) => { try { return keyStore ? keyStore.readKey(name) : ''; } catch (e) { return ''; } },
          readPref: (key) => readPref(key, ''),
        });
        return store;
      } catch (e) { return null; }
    }, [keyStore]);
    const [providers, setProviders] = React.useState(() => (providerStore ? providerStore.list() : []));
    const [claudeProviderId, setClaudeProviderId] = React.useState(() => readPref('ae_mcp_claude_provider', ''));
    const [codexProviderId, setCodexProviderId] = React.useState(() => readPref('ae_mcp_codex_provider', ''));
  ```

  5c. 在 `providerProfile` useMemo 之前组装 provider/通道数据（`apiProvider` 优先取 providerStore 所选条目，回退旧 anthropic key/baseUrl，保证迁移期行为不变）：

  ```js
    const claudeApiProvider = React.useMemo(() => {
      const fromStore = providers.find((p) => p.id === claudeProviderId) || null;
      if (fromStore && fromStore.baseUrl && fromStore.apiKey) return fromStore;
      if (apiKey) return { id: 'legacy-anthropic', name: 'Claude API', protocol: 'anthropic', baseUrl: anthropicBaseUrl || 'https://api.anthropic.com', apiKey, probedModels: [], probedAt: 0 };
      return fromStore;
    }, [providers, claudeProviderId, apiKey, anthropicBaseUrl]);
    const codexCustomProvider = React.useMemo(() => {
      const fromStore = providers.find((p) => p.id === codexProviderId) || null;
      if (fromStore && fromStore.baseUrl && fromStore.apiKey) return fromStore;
      if (codexBaseUrl) return { id: 'legacy-codex', name: 'Codex custom', protocol: 'openai-compatible', baseUrl: codexBaseUrl, apiKey: codexApiKey, probedModels: [], probedAt: 0 };
      return fromStore;
    }, [providers, codexProviderId, codexBaseUrl, codexApiKey]);
    const zcodeConfigSummary = React.useMemo(() => {
      try { return summarizeZcodeConfig({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {}, storedKey: (() => { try { return keyStore ? keyStore.readKey('zcode') : ''; } catch (e) { return ''; } })() }); } catch (e) { return null; }
      // zcodeProbe in deps: re-summarize after each re-check so pasted keys reflect immediately.
    }, [keyStore, zcodeProbe]);
    const channels = React.useMemo(() => ({
      claude: claudeChannels({ probe, apiProvider: claudeApiProvider }),
      codex: codexChannels({ codexProbe, customProvider: codexCustomProvider }),
      zcode: zcodeChannels({ zcodeProbe, configSummary: zcodeConfigSummary }),
    }), [probe, claudeApiProvider, codexProbe, codexCustomProvider, zcodeProbe, zcodeConfigSummary]);
  ```

  5d. `selectedEffective`/`effective`（原 394–399 行）替换为：

  ```js
    const nodeOk = !(probe && probe.nodeOk === false);
    const effective = pickBackend({ pref: backendPref, channels, lockedChannel: channelLock, nodeOk });
  ```

  （删除原 opencode 三元分支；`pickBackend` import 不变。）

  5e. `providerProfile` useMemo（原 291–295 行）改为从 provider 条目取值，保证 codexBackend/byokLoop 沿用所选 provider：

  ```js
    const providerProfile = React.useMemo(() => normalizeProviderProfile({
      anthropicBaseUrl: claudeApiProvider ? claudeApiProvider.baseUrl : anthropicBaseUrl,
      codexApiKey: codexCustomProvider ? codexCustomProvider.apiKey : codexApiKey,
      codexBaseUrl: codexCustomProvider ? codexCustomProvider.baseUrl : codexBaseUrl,
    }), [claudeApiProvider, anthropicBaseUrl, codexCustomProvider, codexApiKey, codexBaseUrl]);
  ```

  同步 `runtimeRef`：对象里加 `claudeChannel: effective.backend === 'claude-api' ? 'api' : 'subscription'`、`claudeApiProvider`，并把 `apiKey` 行改为 `apiKey: claudeApiProvider ? claudeApiProvider.apiKey : apiKey,`、`apiBaseUrl: providerProfile.anthropicBaseUrl,`（保持既有字段）。注意 `runtimeRef.current = {...}` 赋值需下移到 `effective` 计算之后。

  5f. `claudeBackend` useMemo（原 344–355 行）加两个 getter：

  ```js
      getChannel: () => runtimeRef.current.claudeChannel || 'subscription',
      getApiProvider: () => runtimeRef.current.claudeApiProvider || null,
  ```

  5g. `backendInstances`（原 401 行）加映射：

  ```js
    const backendInstances = { subscription: claudeBackend, 'claude-api': claudeBackend, byok: byokLoop, codex: codexBackend, opencode: openCodeBackend, zcode: zcodeBackend };
  ```

  5h. `backendDisabledHint`（原 663–675 行）整体替换为 fixHint 优先：

  ```js
    const backendDisabledHint = (effective.fixHint && (effective.fixHint[lang] || effective.fixHint.zh))
      || (effective.reason && effective.reason.endsWith('-probing')
        ? (lang === 'zh' ? '正在检测凭据通道…' : 'Checking credential channels…')
        : '');
  ```

  （原 `T` 表中 `noKeyHint/probingHint/notLoggedInHint/codex*/openCode*/zcode*Hint/noNodeHint` 等键在 Task 15 一并清理；本任务保持 `T` 不动避免误删仍被引用的键。）

  5i. Claude probe 触发条件（原 419–422 行）维持 `backendPref !== 'subscription'` 早退，行为与现状一致；`claudeChannels` 的 api 通道 `checking:false`，锁定 api 通道时不会被订阅 probing 卡住。

- [ ] **Step 6: 全量跑测试 + 构建**

  ```
  cd plugin/panel && node --test test/
  cd plugin/panel && npm run build
  ```

  预期：全部测试通过；esbuild 构建成功（App.jsx 是 JSX，单测不覆盖，构建即语法验证）。

- [ ] **Step 7: commit**

  ```
  git add plugin/panel/src/lib/channels.js plugin/panel/test/channels.test.js plugin/panel/src/lib/backendSelect.js plugin/panel/test/backendSelect.test.js plugin/panel/src/cep/backends/index.js plugin/panel/src/app/App.jsx
  git commit -m "feat(panel): unified credential channel model + pickBackend rewrite (spec A/D)"
  ```

# Phase 1 出口检查

- [ ] `cd plugin/panel && node --test test/` 全绿；`cd plugin/sidecar && node --test test/` 全绿。
- [ ] `npm run build`（plugin/panel）成功 —— Phase 1 结束时面板是可构建、可运行的软件：三后端行为与 v0.8.3 兼容（旧 anthropic/codex key 经 legacy provider 迁移继续生效），新增 ZCode CLI 继承与 Claude API 直连能力。

# Phase 2 — Settings UI 重构

## Task 11: 可折叠 Section（左侧箭头 + localStorage 记忆）

spec C：六分区全部可折叠，默认仅展开「AI 服务」，展开状态存 localStorage（key `ae_mcp_settings_sections`）。逻辑入 lib（可测），JSX 只做渲染。

**Files:**
- Create: `plugin/panel/src/lib/settingsSections.js`
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx`（`Section` 组件 206–216 行重写；六处 `<Section title=...>` 调用加 id/expanded/onToggle）
- Test: `plugin/panel/test/settingsSections.test.js`（新建）

- [ ] **Step 1: 写失败测试**

  新建 `plugin/panel/test/settingsSections.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { SECTION_IDS, defaultSectionState, loadSectionState, saveSectionState, toggleSection } from '../src/lib/settingsSections.js';

  function storage(init = {}) {
    const map = new Map(Object.entries(init));
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
  }

  test('default state expands only the AI section', () => {
    const state = defaultSectionState();
    assert.equal(state.ai, true);
    for (const id of SECTION_IDS.filter((x) => x !== 'ai')) assert.equal(state[id], false);
  });

  test('load/save round-trips and ignores junk values', () => {
    const s = storage();
    const next = toggleSection(defaultSectionState(), 'conn');
    assert.equal(next.conn, true);
    assert.equal(next.ai, true);
    saveSectionState(s, next);
    assert.deepEqual(loadSectionState(s), next);
    assert.deepEqual(loadSectionState(storage({ ae_mcp_settings_sections: '{bad json' })), defaultSectionState());
    assert.deepEqual(loadSectionState(storage({ ae_mcp_settings_sections: JSON.stringify({ ai: 'yes', bogus: true }) })), defaultSectionState());
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/settingsSections.test.js
  ```

- [ ] **Step 3: 实现 lib**

  新建 `plugin/panel/src/lib/settingsSections.js`：

  ```js
  // Spec C: collapsible Settings sections; only AI expanded by default,
  // expansion state persisted per machine.
  const KEY = 'ae_mcp_settings_sections';

  export const SECTION_IDS = ['ai', 'conn', 'externalClients', 'sec', 'gen', 'about'];

  export function defaultSectionState() {
    return { ai: true, conn: false, externalClients: false, sec: false, gen: false, about: false };
  }

  export function loadSectionState(storage) {
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return defaultSectionState();
      const parsed = JSON.parse(raw);
      const state = defaultSectionState();
      for (const id of SECTION_IDS) {
        if (typeof parsed[id] === 'boolean') state[id] = parsed[id];
      }
      return state;
    } catch (e) {
      return defaultSectionState();
    }
  }

  export function saveSectionState(storage, state) {
    try { storage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* best effort */ }
  }

  export function toggleSection(state, id) {
    return { ...state, [id]: !state[id] };
  }
  ```

  跑测试确认通过。

- [ ] **Step 4: SettingsScreen 接入**

  修改 `plugin/panel/src/screens/SettingsScreen.jsx`：

  - import 区追加：

  ```js
  import { Icon } from '../components/core/Icon';
  import { loadSectionState, saveSectionState, toggleSection } from '../lib/settingsSections';
  ```

  - `Section` 组件（206–216 行）替换为：

  ```jsx
  function Section({ id, title, caption, expanded, onToggle, children }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="ds-focusable"
          onClick={() => onToggle && onToggle(id)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', padding: '0 0 2px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', textAlign: 'left' }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} strokeWidth={2} color="var(--text-tertiary)" />
          <span style={{ font: '600 11px/1 var(--font-ui)', letterSpacing: '0.04em', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{title}</span>
        </button>
        {expanded && caption ? <div style={{ font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{caption}</div> : null}
        {expanded ? children : null}
      </div>
    );
  }
  ```

  - `SettingsScreen` 组件体内 state 区加：

  ```js
    const [sections, setSections] = React.useState(() => loadSectionState(window.localStorage));
    const onToggleSection = (id) => setSections((s) => {
      const next = toggleSection(s, id);
      saveSectionState(window.localStorage, next);
      return next;
    });
  ```

  - 六处调用改造（title 不变）：`<Section title={t.ai}>` → `<Section id="ai" title={t.ai} expanded={sections.ai} onToggle={onToggleSection}>`；同理 `conn`、`externalClients`（保留 caption prop）、`sec`、`gen`、`about`。

- [ ] **Step 5: 构建验证 + commit**

  ```
  cd plugin/panel && node --test test/ && npm run build
  git add plugin/panel/src/lib/settingsSections.js plugin/panel/test/settingsSections.test.js plugin/panel/src/screens/SettingsScreen.jsx
  git commit -m "feat(panel): collapsible settings sections with persisted state"
  ```

## Task 12: 三选一 Segmented + 通道卡组件

spec A/C：「AI 服务」区改为 Segmented 三选一（Claude/Codex/ZCode，"BYOK"从 UI 消失）+ 每后端一张通道卡（状态点/来源徽标/detail/fixHint/锁定/检测按钮 + 每通道内嵌配置区），替代四套 if/else 分支。展示逻辑入 lib。

**Files:**
- Create: `plugin/panel/src/lib/channelCard.js`
- Create: `plugin/panel/src/components/settings/ChannelCard.jsx`
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx`（AI Section 445–560 行重构；props 签名更新）
- Modify: `plugin/panel/src/app/App.jsx`（SettingsScreen props 传递 729–801 行）
- Test: `plugin/panel/test/channelCard.test.js`（新建）

- [ ] **Step 1: 写失败测试（展示逻辑）**

  新建 `plugin/panel/test/channelCard.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { channelDot, channelTexts, lockLabel } from '../src/lib/channelCard.js';

  test('channelDot maps probe state to a status color token', () => {
    assert.equal(channelDot({ checking: true, ok: false }), 'neutral');
    assert.equal(channelDot({ checking: false, ok: true }), 'ok');
    assert.equal(channelDot({ checking: false, ok: false }), 'warn');
  });

  test('channelTexts picks language-specific source badge and fixHint', () => {
    const probe = { source: { zh: '订阅登录', en: 'Subscription login' }, ok: false, checking: false, detail: 'd', fixHint: { zh: '去登录', en: 'log in' } };
    assert.deepEqual(channelTexts(probe, 'zh'), { source: '订阅登录', detail: 'd', fixHint: '去登录' });
    assert.deepEqual(channelTexts(probe, 'en'), { source: 'Subscription login', detail: 'd', fixHint: 'log in' });
    assert.equal(channelTexts({ ...probe, ok: true }, 'zh').fixHint, '', 'no fixHint when channel is ok');
  });

  test('lockLabel reflects current lock', () => {
    assert.equal(lockLabel('api', 'api', 'zh'), '已锁定');
    assert.equal(lockLabel('api', '', 'zh'), '锁定');
    assert.equal(lockLabel('api', 'api', 'en'), 'Locked');
    assert.equal(lockLabel('api', '', 'en'), 'Lock');
  });
  ```

- [ ] **Step 2: 跑测试确认失败，实现 lib**

  ```
  cd plugin/panel && node --test test/channelCard.test.js
  ```

  新建 `plugin/panel/src/lib/channelCard.js`：

  ```js
  // Presentation logic for channel cards (spec A: status dot + source badge +
  // fixHint). Kept out of JSX so node --test covers it.
  export function channelDot(probe) {
    if (!probe || probe.checking) return 'neutral';
    return probe.ok ? 'ok' : 'warn';
  }

  export function channelTexts(probe, lang = 'zh') {
    const pick = (obj) => (obj ? (obj[lang] || obj.zh || '') : '');
    return {
      source: pick(probe && probe.source),
      detail: (probe && probe.detail) || '',
      fixHint: probe && !probe.ok && !probe.checking ? pick(probe.fixHint) : '',
    };
  }

  export function lockLabel(channel, lockedChannel, lang = 'zh') {
    const locked = channel === lockedChannel;
    if (lang === 'en') return locked ? 'Locked' : 'Lock';
    return locked ? '已锁定' : '锁定';
  }
  ```

  跑测试确认通过。

- [ ] **Step 3: ChannelCard 组件**

  新建 `plugin/panel/src/components/settings/ChannelCard.jsx`：

  ```jsx
  import React from 'react';
  import { Badge } from '../core/Badge';
  import { Button } from '../core/Button';
  import { StatusDot } from '../core/StatusDot';
  import { channelDot, channelTexts, lockLabel } from '../../lib/channelCard';

  // One card per backend; one row per credential channel (spec A).
  // channels: ChannelProbe[]; activeChannel: effective channel id;
  // lockedChannel: '' or a channel id; renderChannelBody(channel) -> extra
  // config fields (provider dropdown, key paste, import button...).
  export function ChannelCard({
    lang = 'zh',
    channels = [],
    activeChannel = '',
    lockedChannel = '',
    onLockChannel,
    onRecheck,
    recheckLabel,
    recheckDisabled = false,
    readOnly = false,
    renderChannelBody,
  }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {channels.map((probe) => {
          const texts = channelTexts(probe, lang);
          const isActive = probe.channel === activeChannel;
          return (
            <div key={probe.channel} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: `1px solid ${isActive ? 'var(--border-strong)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-md)', background: 'var(--bg-well)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusDot status={channelDot(probe)} />
                <Badge status={channelDot(probe)}>{texts.source}</Badge>
                {texts.detail ? <span style={{ flex: 1, minWidth: 0, font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{texts.detail}</span> : <span style={{ flex: 1 }} />}
                {!readOnly && onLockChannel ? (
                  <Button variant="ghost" size="sm" onClick={() => onLockChannel(probe.channel === lockedChannel ? '' : probe.channel)}>
                    {lockLabel(probe.channel, lockedChannel, lang)}
                  </Button>
                ) : null}
              </div>
              {texts.fixHint ? <div style={{ font: '400 10px/1.5 var(--font-ui)', color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap' }}>{texts.fixHint}</div> : null}
              {!readOnly && renderChannelBody ? renderChannelBody(probe.channel) : null}
            </div>
          );
        })}
        {!readOnly && onRecheck ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="secondary" icon="rotate-cw" disabled={recheckDisabled} onClick={onRecheck}>{recheckLabel}</Button>
          </div>
        ) : null}
      </div>
    );
  }
  ```

  （`StatusDot` 已存在：`ConnectionDrawer.jsx` 引用 `../components/core/StatusDot`。若其 `status` 取值枚举与 `'ok'|'warn'|'neutral'` 不一致，执行时以该组件实际枚举为准在 `channelDot` 内对齐并同步测试。）

- [ ] **Step 4: SettingsScreen AI 区重构**

  修改 `plugin/panel/src/screens/SettingsScreen.jsx`：

  4a. import 追加 `import { ChannelCard } from '../components/settings/ChannelCard';`

  4b. props：删除 `claudeStatus/onRecheckClaude/codexStatus/onRecheckCodex/openCodeStatus/onRecheckOpenCode/zcodeStatus/onRecheckZcode/apiKey/onSaveApiKey/onClearApiKey/anthropicBaseUrl/onAnthropicBaseUrlChange/codexApiKey/codexBaseUrl/onCodexBaseUrlChange/onSaveCodexApiKey/onClearCodexApiKey/validateKey`，新增：

  ```js
    channels = { claude: [], codex: [], zcode: [] },
    activeChannel = '',
    lockedChannel = '',
    onLockChannel,
    onRecheckBackend,
    recheckDisabled = false,
    providers = [],
    claudeProviderId = '',
    onClaudeProviderChange,
    codexProviderId = '',
    onCodexProviderChange,
    onImportClaudeSettings,
    claudeSettingsImportAvailable = false,
    onSaveZcodeKey,
    zcodeKeyStored = false,
    providerManager = null,
  ```

  4c. AI Section 内（原 446–540 行的 backend Segmented + 四分支）替换为：

  ```jsx
          <Field label={t.backend}>
            <Segmented full value={backend} onChange={onBackendChange} options={[
              { value: 'subscription', label: t.backendSub },
              { value: 'codex', label: t.backendCodex },
              { value: 'zcode', label: t.backendZcode },
            ]} />
          </Field>
          <ChannelCard
            lang={lang}
            channels={backend === 'codex' ? channels.codex : backend === 'zcode' ? channels.zcode : channels.claude}
            activeChannel={activeChannel}
            lockedChannel={lockedChannel}
            onLockChannel={onLockChannel}
            onRecheck={onRecheckBackend}
            recheckLabel={t.recheck}
            recheckDisabled={recheckDisabled}
            renderChannelBody={(channel) => {
              if (backend !== 'codex' && backend !== 'zcode' && channel === 'api') {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Select value={claudeProviderId} onChange={onClaudeProviderChange} options={[
                      { value: '', label: t.providerNone },
                      ...providers.filter((p) => p.protocol === 'anthropic').map((p) => ({ value: p.id, label: p.name })),
                    ]} />
                    {claudeSettingsImportAvailable ? (
                      <Button variant="secondary" size="sm" icon="download" onClick={onImportClaudeSettings}>{t.importClaudeSettings}</Button>
                    ) : null}
                    <div style={{ font: '400 10px/1.5 var(--font-ui)', color: 'var(--text-tertiary)' }}>{t.claude3pNote}</div>
                  </div>
                );
              }
              if (backend === 'codex' && channel === 'custom') {
                return (
                  <Select value={codexProviderId} onChange={onCodexProviderChange} options={[
                    { value: '', label: t.providerNone },
                    ...providers.filter((p) => p.protocol === 'openai-compatible').map((p) => ({ value: p.id, label: p.name })),
                  ]} />
                );
              }
              if (backend === 'zcode' && channel === 'cli-config') {
                return <ZcodeKeyFallback t={t} stored={zcodeKeyStored} onSave={onSaveZcodeKey} />;
              }
              return null;
            }}
          />
          {providerManager}
  ```

  4d. 新增内部组件（`Section` 组件之后）：

  ```jsx
  function ZcodeKeyFallback({ t, stored, onSave }) {
    const [draft, setDraft] = React.useState('');
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Input secret value={draft} onChange={setDraft} placeholder={stored ? t.zcodeKeyStored : t.zcodeKeyPlaceholder} style={{ flex: 1 }} />
        <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={() => { if (onSave) onSave(draft.trim()); setDraft(''); }}>{t.save}</Button>
      </div>
    );
  }
  ```

  4e. `S` 文案表 zh/en 各追加（并删除不再引用的 `backendByok/backendOpenCode/claude*/codex*/openCode*/zcode*` 状态徽标键——仅删本次重构后 grep 无引用的键）：

  ```js
      recheck: '重新检测',
      providerNone: '（未选择 provider）',
      importClaudeSettings: '从 ~/.claude/settings.json 导入',
      claude3pNote: 'Claude-3p 桌面版的凭据无法自动读取；请在 Provider 管理里手动填写一次 Base URL 与 Token。',
      zcodeKeyPlaceholder: '粘贴 provider API Key（存本机）',
      zcodeKeyStored: '已保存到 ~/.ae-mcp/zcode-key，可粘贴新值覆盖',
      providerManage: 'Provider 管理',
  ```

  ```js
      recheck: 'Re-check',
      providerNone: '(no provider selected)',
      importClaudeSettings: 'Import from ~/.claude/settings.json',
      claude3pNote: 'Claude-3p desktop credentials cannot be read automatically; fill the base URL and token once in Provider Manager.',
      zcodeKeyPlaceholder: 'Paste the provider API key (stored locally)',
      zcodeKeyStored: 'Saved to ~/.ae-mcp/zcode-key; paste a new value to overwrite',
      providerManage: 'Provider manager',
  ```

  4f. 原 `saveApiKey/saveCodexKey/clearApiKey/clearCodexKey` 函数与 `key/apiBaseUrlDraft/codexKeyDraft/codexBaseUrlDraft` state、对应 `React.useEffect` 同步行一并删除（其能力已收口进 Provider 管理器，Task 13）。`ApiProfileFields` import 移除。`validateAnthropicKey` 的"保存并验证"语义由 Task 13 的 provider 探测按钮取代。

- [ ] **Step 5: App.jsx props 接线**

  修改 `plugin/panel/src/app/App.jsx` 的 `<SettingsScreen ... />`（原 730–801 行）：删除已废弃 props（`apiKey/onSaveApiKey/onClearApiKey/anthropicBaseUrl/onAnthropicBaseUrlChange/codexApiKey/codexBaseUrl/onCodexBaseUrlChange/onSaveCodexApiKey/onClearCodexApiKey/validateKey/claudeStatus/onRecheckClaude/codexStatus/onRecheckCodex/openCodeStatus/onRecheckOpenCode/zcodeStatus/onRecheckZcode`），新增：

  ```jsx
              channels={channels}
              activeChannel={effective.channel || ''}
              lockedChannel={channelLock}
              onLockChannel={(c) => { setChannelLock(c); writePref('ae_mcp_channel_lock', c); }}
              onRecheckBackend={() => {
                if (backendPref === 'codex') runCodexProbe();
                else if (backendPref === 'zcode') runZcodeProbe();
                else runClaudeProbe();
              }}
              recheckDisabled={backendPref === 'codex' ? codexProbe === null : backendPref === 'zcode' ? zcodeProbe === null : probe === null}
              providers={providers}
              claudeProviderId={claudeProviderId}
              onClaudeProviderChange={(id) => { setClaudeProviderId(id); writePref('ae_mcp_claude_provider', id); }}
              codexProviderId={codexProviderId}
              onCodexProviderChange={(id) => { setCodexProviderId(id); writePref('ae_mcp_codex_provider', id); setCodexProbe(null); codexBackend.reset(); }}
              claudeSettingsImportAvailable={Boolean(claudeSettingsHint)}
              onImportClaudeSettings={() => {
                if (!claudeSettingsHint || !providerStore) return;
                const entry = providerStore.upsert({ id: 'claude-settings-import', name: 'Claude Code 配置', protocol: 'anthropic', baseUrl: claudeSettingsHint.baseUrl, apiKey: claudeSettingsHint.authToken });
                setProviders(providerStore.list());
                setClaudeProviderId(entry.id);
                writePref('ae_mcp_claude_provider', entry.id);
              }}
              onSaveZcodeKey={(k) => {
                if (keyStore) keyStore.writeKey(k, 'zcode');
                setZcodeProbe(null);
                zcodeBackend.reset();
                runZcodeProbe();
              }}
              zcodeKeyStored={(() => { try { return Boolean(keyStore && keyStore.readKey('zcode')); } catch (e) { return false; } })()}
  ```

  并在 state 区加一次性读取：

  ```js
    const claudeSettingsHint = React.useMemo(() => {
      try { return readClaudeSettingsEnv({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {} }); } catch (e) { return null; }
    }, []);
  ```

  import 区追加 `import { readClaudeSettingsEnv } from '../cep/claudeSettingsImport';`。

- [ ] **Step 6: 测试 + 构建 + commit**

  ```
  cd plugin/panel && node --test test/ && npm run build
  git add plugin/panel/src/lib/channelCard.js plugin/panel/test/channelCard.test.js plugin/panel/src/components/settings/ChannelCard.jsx plugin/panel/src/screens/SettingsScreen.jsx plugin/panel/src/app/App.jsx
  git commit -m "feat(panel): 3-way backend segmented + credential channel cards (spec A/C)"
  ```

## Task 13: Provider 管理 UI + cc-switch 可选导入

spec A2/C：AI 区内「Provider 管理」入口——列表 + 新增/编辑/删除 + 逐条「探测模型」（Task 3 的 `probeProviderModels`），探测结果写回 `probedModels/probedAt` 并驱动 composer 模型 chip；探测失败降级手填模型 ID。检测到 cc-switch 配置时提供一键导入（三个位置，实机未安装场景 = 不显示入口）。

**Files:**
- Create: `plugin/panel/src/cep/ccSwitch.js`
- Create: `plugin/panel/src/lib/providerManagerState.js`
- Create: `plugin/panel/src/components/settings/ProviderManagerSection.jsx`
- Modify: `plugin/panel/src/lib/backendCapabilities.js`（新增 `descriptorFromProbedModels`）
- Modify: `plugin/panel/src/app/App.jsx`（providerManager 渲染 + descriptor 接入）
- Test: `plugin/panel/test/ccSwitch.test.js`、`plugin/panel/test/providerManagerState.test.js`（新建）、`plugin/panel/test/backendCapabilities.test.js`

- [ ] **Step 1: 写失败测试（ccSwitch + descriptor + 表单状态）**

  新建 `plugin/panel/test/ccSwitch.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { detectCcSwitch, ccSwitchProviderEntries } from '../src/cep/ccSwitch.js';

  function fakeFs(files) {
    return {
      existsSync: (p) => p in files,
      readFileSync(p) {
        if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return files[p];
      },
    };
  }

  test('detectCcSwitch returns null when none of the three locations exist (live machine case)', () => {
    const env = { USERPROFILE: 'C:\Users\me', APPDATA: 'C:\Users\me\AppData\Roaming' };
    assert.equal(detectCcSwitch({ env, fsImpl: fakeFs({}) }), null);
  });

  test('detectCcSwitch finds a config in any of the three locations', () => {
    const env = { USERPROFILE: 'C:\Users\me', APPDATA: 'C:\Users\me\AppData\Roaming' };
    const config = JSON.stringify({ providers: [{ name: 'relay', baseUrl: 'https://r/v1', apiKey: 'k' }] });
    for (const dir of ['C:\Users\me\.cc-switch', 'C:\Users\me\.config\cc-switch', 'C:\Users\me\AppData\Roaming\cc-switch']) {
      const found = detectCcSwitch({ env, fsImpl: fakeFs({ [dir + '\config.json']: config }) });
      assert.equal(found.dir, dir);
      assert.equal(found.providers.length, 1);
    }
  });

  test('ccSwitchProviderEntries maps and skips malformed rows (third-party format is unstable)', () => {
    const entries = ccSwitchProviderEntries([
      { name: 'a', baseUrl: 'https://a/v1', apiKey: 'k1' },
      { title: 'b', base_url: 'https://b', api_key: 'k2', type: 'anthropic' },
      { junk: true },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, 'ccswitch-a');
    assert.equal(entries[0].protocol, 'openai-compatible');
    assert.equal(entries[1].id, 'ccswitch-b');
    assert.equal(entries[1].protocol, 'anthropic');
    assert.equal(entries[1].baseUrl, 'https://b');
  });
  ```

  新建 `plugin/panel/test/providerManagerState.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { emptyDraft, draftFromEntry, validateDraft } from '../src/lib/providerManagerState.js';

  test('emptyDraft/draftFromEntry round-trip provider fields', () => {
    assert.deepEqual(emptyDraft(), { id: '', name: '', protocol: 'openai-compatible', baseUrl: '', apiKey: '' });
    const entry = { id: 'x', name: 'X', protocol: 'anthropic', baseUrl: 'https://x', apiKey: 'k', probedModels: [{ id: 'm' }], probedAt: 5 };
    assert.deepEqual(draftFromEntry(entry), { id: 'x', name: 'X', protocol: 'anthropic', baseUrl: 'https://x', apiKey: 'k' });
  });

  test('validateDraft demands id-safe name and http(s) base URL', () => {
    assert.equal(validateDraft({ id: 'ok', name: 'OK', protocol: 'anthropic', baseUrl: 'https://h', apiKey: 'k' }), '');
    assert.match(validateDraft({ id: '', name: '', protocol: 'anthropic', baseUrl: 'https://h', apiKey: '' }), /名称/);
    assert.match(validateDraft({ id: 'x', name: 'x', protocol: 'anthropic', baseUrl: 'ftp://h', apiKey: '' }), /Base URL/);
  });
  ```

  在 `plugin/panel/test/backendCapabilities.test.js` 末尾追加：

  ```js
  test('descriptorFromProbedModels replaces curated models for custom-provider channels', async () => {
    const { byokStaticDescriptor, descriptorFromProbedModels } = await import('../src/lib/backendCapabilities.js');
    const base = byokStaticDescriptor();
    const probed = descriptorFromProbedModels(base, [{ id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'claude-sonnet-5', label: 'x' }]);
    assert.equal(probed.models.length, 2);
    assert.equal(probed.models[0].id, 'glm-5.2');
    assert.equal(probed.models[0].label, 'GLM 5.2');
    assert.equal(probed.models[1].label, 'Sonnet 5', 'curated metadata reused when ids match');
    assert.equal(probed.defaultModelId, 'glm-5.2');
    assert.equal(descriptorFromProbedModels(base, []), base, 'empty probe keeps descriptor (manual model id fallback)');
    assert.equal(descriptorFromProbedModels(base, null), base);
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```
  cd plugin/panel && node --test test/ccSwitch.test.js test/providerManagerState.test.js test/backendCapabilities.test.js
  ```

- [ ] **Step 3: 实现三个纯逻辑模块**

  新建 `plugin/panel/src/cep/ccSwitch.js`：

  ```js
  // Optional cc-switch inheritance (spec A2): detect-only, never a wizard
  // dependency. Third-party format is unstable -> tolerant field mapping.
  const CONFIG_NAMES = ['config.json', 'providers.json'];

  function getCepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error('CEP Node require is unavailable');
  }

  function candidateDirs(env = {}) {
    const home = String(env.USERPROFILE || env.HOME || '').replace(/[\/]+$/, '');
    const appData = String(env.APPDATA || (home ? home + '\AppData\Roaming' : '')).replace(/[\/]+$/, '');
    const dirs = [];
    if (home) {
      dirs.push(home + '\.cc-switch');
      dirs.push(home + '\.config\cc-switch');
    }
    if (appData) dirs.push(appData + '\cc-switch');
    return dirs;
  }

  function rawProviders(parsed) {
    if (!parsed || typeof parsed !== 'object') return [];
    if (Array.isArray(parsed.providers)) return parsed.providers;
    if (Array.isArray(parsed.profiles)) return parsed.profiles;
    if (parsed.providers && typeof parsed.providers === 'object') return Object.values(parsed.providers);
    return [];
  }

  export function ccSwitchProviderEntries(list) {
    return (Array.isArray(list) ? list : [])
      .map((p) => {
        if (!p || typeof p !== 'object') return null;
        const name = String(p.name || p.title || p.id || '').trim();
        const baseUrl = String(p.baseUrl || p.base_url || p.url || '').trim();
        const apiKey = String(p.apiKey || p.api_key || p.key || p.token || '').trim();
        if (!name || !baseUrl) return null;
        const protocol = /anthropic/i.test(String(p.type || p.protocol || p.kind || '')) ? 'anthropic' : 'openai-compatible';
        return { id: 'ccswitch-' + name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase(), name, protocol, baseUrl, apiKey };
      })
      .filter(Boolean);
  }

  export function detectCcSwitch({ env = {}, fsImpl } = {}) {
    let fs;
    try { fs = fsImpl || getCepRequire()('fs'); } catch (e) { return null; }
    for (const dir of candidateDirs(env)) {
      for (const name of CONFIG_NAMES) {
        const file = dir + '\' + name;
        try {
          if (!fs.existsSync(file)) continue;
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          const providers = ccSwitchProviderEntries(rawProviders(parsed));
          if (providers.length) return { dir, file, providers };
        } catch (e) { /* unreadable candidate -> keep scanning */ }
      }
    }
    return null;
  }
  ```

  新建 `plugin/panel/src/lib/providerManagerState.js`：

  ```js
  // Draft/validation logic for the Provider Manager form (spec A2).
  export function emptyDraft() {
    return { id: '', name: '', protocol: 'openai-compatible', baseUrl: '', apiKey: '' };
  }

  export function draftFromEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
    };
  }

  export function validateDraft(draft) {
    if (!String(draft.name || '').trim() && !String(draft.id || '').trim()) return '名称不能为空 / name is required';
    if (!/^https?:\/\//i.test(String(draft.baseUrl || '').trim())) return 'Base URL 必须以 http(s):// 开头 / must start with http(s)://';
    return '';
  }

  export function draftToEntry(draft) {
    const name = String(draft.name || draft.id || '').trim();
    const id = String(draft.id || '').trim() || name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase();
    return { id, name, protocol: draft.protocol, baseUrl: draft.baseUrl, apiKey: draft.apiKey };
  }
  ```

  在 `plugin/panel/src/lib/backendCapabilities.js` 末尾追加（curated 静态列表仅用于官方通道；自定义 provider 通道以探测结果为准）：

  ```js
  // Spec A2: custom-provider channels list what /v1/models actually returned;
  // curated metadata (effort levels, cost) is reused when ids overlap. An
  // empty/failed probe keeps the descriptor unchanged so the manual custom
  // model id path still works.
  export function descriptorFromProbedModels(descriptor, probedModels) {
    if (!Array.isArray(probedModels) || !probedModels.length) return descriptor;
    const curated = new Map(descriptor.models.map((m) => [m.id, m]));
    const models = probedModels.map((m) => {
      const known = curated.get(m.id);
      if (known) return known;
      return { id: m.id, label: m.label || m.id, effortLevels: [], cost: costTier(m.id), adaptive: false };
    });
    return { ...descriptor, models, defaultModelId: models[0].id };
  }
  ```

  跑 Step 1 三个测试文件确认通过。

- [ ] **Step 4: ProviderManagerSection 组件 + App 接入**

  新建 `plugin/panel/src/components/settings/ProviderManagerSection.jsx`：

  ```jsx
  import React from 'react';
  import { Badge } from '../core/Badge';
  import { Button } from '../core/Button';
  import { Input } from '../forms/Input';
  import { Select } from '../forms/Select';
  import { Field } from '../forms/Field';
  import { emptyDraft, draftFromEntry, validateDraft, draftToEntry } from '../../lib/providerManagerState';

  const L = {
    zh: { title: 'Provider 管理', add: '新增', edit: '编辑', del: '删除', probe: '探测模型', probing: '探测中…', save: '保存', cancel: '取消', name: '名称', protocol: '协议', baseUrl: 'Base URL', apiKey: 'API Key', keyCap: '仅保存在本机 ~/.ae-mcp/providers.json', models: (n) => `${n} 个模型`, probeFailed: '探测失败（可手填模型 ID 继续使用）：', importCc: '从 cc-switch 导入' },
    en: { title: 'Provider manager', add: 'Add', edit: 'Edit', del: 'Delete', probe: 'Probe models', probing: 'Probing…', save: 'Save', cancel: 'Cancel', name: 'Name', protocol: 'Protocol', baseUrl: 'Base URL', apiKey: 'API Key', keyCap: 'Stored locally in ~/.ae-mcp/providers.json', models: (n) => `${n} models`, probeFailed: 'Probe failed (manual model id still works): ', importCc: 'Import from cc-switch' },
  };

  export function ProviderManagerSection({ lang = 'zh', providers = [], onUpsert, onRemove, onProbe, probing = '', probeErrors = {}, ccSwitch = null, onImportCcSwitch }) {
    const t = L[lang] || L.zh;
    const [draft, setDraft] = React.useState(null);
    const [error, setError] = React.useState('');
    const save = () => {
      const message = validateDraft(draft);
      if (message) { setError(message); return; }
      onUpsert(draftToEntry(draft));
      setDraft(null);
      setError('');
    };
    return (
      <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', padding: '7px 8px' }}>
        <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{t.title}</span>
          <Button variant="secondary" size="sm" icon="plus" onClick={(e) => { e.preventDefault(); setDraft(emptyDraft()); }}>{t.add}</Button>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {ccSwitch && onImportCcSwitch ? (
            <Button variant="secondary" size="sm" icon="download" onClick={onImportCcSwitch}>{t.importCc}</Button>
          ) : null}
          {providers.map((p) => (
            <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <Badge status="neutral">{p.protocol}</Badge>
                {p.probedModels.length ? <Badge status="ok">{t.models(p.probedModels.length)}</Badge> : null}
                <Button variant="ghost" size="sm" disabled={probing === p.id} onClick={() => onProbe(p)}>{probing === p.id ? t.probing : t.probe}</Button>
                <Button variant="ghost" size="sm" onClick={() => { setDraft(draftFromEntry(p)); setError(''); }}>{t.edit}</Button>
                <Button variant="ghost" size="sm" onClick={() => onRemove(p.id)}>{t.del}</Button>
              </div>
              <div style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.baseUrl}</div>
              {probeErrors[p.id] ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{t.probeFailed}{probeErrors[p.id]}</div> : null}
            </div>
          ))}
          {draft ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
              <Field label={t.name}><Input value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} /></Field>
              <Field label={t.protocol}>
                <Select value={draft.protocol} onChange={(v) => setDraft({ ...draft, protocol: v })} options={[
                  { value: 'openai-compatible', label: 'OpenAI compatible' },
                  { value: 'anthropic', label: 'Anthropic' },
                ]} />
              </Field>
              <Field label={t.baseUrl}><Input mono value={draft.baseUrl} onChange={(v) => setDraft({ ...draft, baseUrl: v })} placeholder="https://api.example.com/v1" /></Field>
              <Field label={t.apiKey} caption={t.keyCap}><Input secret value={draft.apiKey} onChange={(v) => setDraft({ ...draft, apiKey: v })} /></Field>
              {error ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{error}</div> : null}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(''); }}>{t.cancel}</Button>
                <Button variant="primary" size="sm" onClick={save}>{t.save}</Button>
              </div>
            </div>
          ) : null}
        </div>
      </details>
    );
  }
  ```

  App.jsx 接入（import `ProviderManagerSection`、`probeProviderModels`、`detectCcSwitch`）：

  ```js
    const [providerProbing, setProviderProbing] = React.useState('');
    const [providerProbeErrors, setProviderProbeErrors] = React.useState({});
    const ccSwitchFound = React.useMemo(() => {
      try { return detectCcSwitch({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {} }); } catch (e) { return null; }
    }, []);
    const providerManager = (
      <ProviderManagerSection
        lang={lang}
        providers={providers}
        probing={providerProbing}
        probeErrors={providerProbeErrors}
        ccSwitch={ccSwitchFound}
        onImportCcSwitch={() => {
          if (!ccSwitchFound || !providerStore) return;
          for (const entry of ccSwitchFound.providers) providerStore.upsert(entry);
          setProviders(providerStore.list());
        }}
        onUpsert={(entry) => {
          if (!providerStore) return;
          const existing = providerStore.get(entry.id);
          providerStore.upsert({ ...entry, probedModels: existing ? existing.probedModels : [], probedAt: existing ? existing.probedAt : 0 });
          setProviders(providerStore.list());
        }}
        onRemove={(id) => {
          if (!providerStore) return;
          providerStore.remove(id);
          setProviders(providerStore.list());
          if (claudeProviderId === id) { setClaudeProviderId(''); writePref('ae_mcp_claude_provider', ''); }
          if (codexProviderId === id) { setCodexProviderId(''); writePref('ae_mcp_codex_provider', ''); }
        }}
        onProbe={async (p) => {
          setProviderProbing(p.id);
          const result = await probeProviderModels({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol });
          setProviderProbing('');
          if (result.ok && providerStore) {
            providerStore.upsert({ ...p, probedModels: result.models, probedAt: Date.now() });
            setProviders(providerStore.list());
            setProviderProbeErrors((errs) => ({ ...errs, [p.id]: '' }));
          } else {
            setProviderProbeErrors((errs) => ({ ...errs, [p.id]: result.detail || ('HTTP ' + result.status) }));
          }
        }}
      />
    );
  ```

  把 `providerManager` 作为 prop 传给 SettingsScreen（Task 12 已预留 `providerManager` prop 与渲染位）。

  descriptor 接入：`App.jsx` 的 descriptor `useEffect`（原 266–283 行）中 byok 分支之后追加自定义通道探测模型合并：

  ```js
      if (effective.backend === 'claude-api' && claudeApiProvider && claudeApiProvider.probedModels && claudeApiProvider.probedModels.length) {
        setDescriptor(descriptorFromProbedModels(byokStaticDescriptor(), claudeApiProvider.probedModels), customModelForBackend);
      }
      if (backendPref === 'codex' && codexCustomProvider && codexCustomProvider.probedModels && codexCustomProvider.probedModels.length) {
        setDescriptor(descriptorWithCustomModel(descriptorFromProbedModels(codexStaticDescriptor(), codexCustomProvider.probedModels), customModelForBackend));
      }
  ```

  （import 行补 `descriptorFromProbedModels`、`codexStaticDescriptor`；useEffect 依赖数组补 `effective.backend, claudeApiProvider, codexCustomProvider`。）

- [ ] **Step 5: 测试 + 构建 + commit**

  ```
  cd plugin/panel && node --test test/ && npm run build
  git add plugin/panel/src/cep/ccSwitch.js plugin/panel/test/ccSwitch.test.js plugin/panel/src/lib/providerManagerState.js plugin/panel/test/providerManagerState.test.js plugin/panel/src/components/settings/ProviderManagerSection.jsx plugin/panel/src/lib/backendCapabilities.js plugin/panel/test/backendCapabilities.test.js plugin/panel/src/app/App.jsx
  git commit -m "feat(panel): provider manager UI with model probing and cc-switch import (spec A2)"
  ```

## Task 14: 日志导出实现 + 日志级别生效

spec C：「导出日志」从恒 disabled 变为——聚合面板日志缓冲 + host 版本信息 + sidecar stderr tail，写 `~/.ae-mcp/logs/export-<时间戳>.txt`，并在资源管理器中定位；「日志级别」选择保留并确保生效（error 级只保留错误行）。

**Files:**
- Create: `plugin/panel/src/lib/logExport.js`
- Create: `plugin/panel/src/cep/logExportFs.js`
- Modify: `plugin/panel/src/cep/claudeAgentBackend.js`（返回对象加 `getStderrTail`）
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx`（导出按钮 + 级别 props 化）
- Modify: `plugin/panel/src/app/App.jsx`（`pushLog` 过滤 + onExportLogs）
- Test: `plugin/panel/test/logExport.test.js`（新建）、`plugin/panel/test/claudeAgentBackend.test.js`

- [ ] **Step 1: 写失败测试**

  新建 `plugin/panel/test/logExport.test.js`：

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { buildLogExport, exportFileName, keepLogLine } from '../src/lib/logExport.js';

  test('buildLogExport aggregates panel logs, host info, and sidecar tail', () => {
    const text = buildLogExport({
      panelLogs: ['[10:00:00] Host ready on 127.0.0.1:11488', '[10:00:05] Error: boom'],
      hostInfo: { hostVersion: '0.8.3', pythonVersion: '0.8.3' },
      sidecarTail: 'sidecar stderr line',
      version: '0.8.3',
      now: new Date('2026-07-03T10:00:00Z'),
    });
    assert.match(text, /# ae-mcp panel log export/);
    assert.match(text, /exported-at: 2026-07-03T10:00:00/);
    assert.match(text, /panel-version: 0\.8\.3/);
    assert.match(text, /host-version: 0\.8\.3/);
    assert.match(text, /## panel logs \(2\)/);
    assert.match(text, /Error: boom/);
    assert.match(text, /## sidecar stderr tail/);
    assert.match(text, /sidecar stderr line/);
  });

  test('exportFileName is timestamped and filesystem-safe', () => {
    const name = exportFileName(new Date('2026-07-03T10:00:00.123Z'));
    assert.equal(name, 'export-2026-07-03T10-00-00-123Z.txt');
    assert.ok(!/[:.]/.test(name.replace(/\.txt$/, '')));
  });

  test('keepLogLine filters by level: error keeps only error lines, info/debug keep all', () => {
    assert.equal(keepLogLine('error', '[t] Error: boom'), true);
    assert.equal(keepLogLine('error', '[t] Host ready'), false);
    assert.equal(keepLogLine('info', '[t] Host ready'), true);
    assert.equal(keepLogLine('debug', '[t] anything'), true);
  });
  ```

- [ ] **Step 2: 跑测试确认失败，实现 lib**

  ```
  cd plugin/panel && node --test test/logExport.test.js
  ```

  新建 `plugin/panel/src/lib/logExport.js`：

  ```js
  // Spec C: log export aggregation + level filtering (pure, node-testable).
  export function buildLogExport({ panelLogs = [], hostInfo = {}, sidecarTail = '', version = '', now = new Date() } = {}) {
    const lines = [];
    lines.push('# ae-mcp panel log export');
    lines.push('exported-at: ' + now.toISOString());
    lines.push('panel-version: ' + (version || '-'));
    lines.push('host-version: ' + (hostInfo.hostVersion || '-'));
    lines.push('python-version: ' + (hostInfo.pythonVersion || '-'));
    lines.push('');
    lines.push('## panel logs (' + panelLogs.length + ')');
    for (const line of panelLogs) lines.push(String(line));
    lines.push('');
    lines.push('## sidecar stderr tail');
    lines.push(sidecarTail ? String(sidecarTail) : '(empty)');
    return lines.join('\n') + '\n';
  }

  export function exportFileName(now = new Date()) {
    return 'export-' + now.toISOString().replace(/[:.]/g, '-') + '.txt';
  }

  export function keepLogLine(level, message) {
    if (level !== 'error') return true;
    return /error|failed|exception/i.test(String(message || ''));
  }
  ```

  跑测试确认通过。

- [ ] **Step 3: cep 写文件 + Explorer 定位 + sidecar tail 暴露**

  新建 `plugin/panel/src/cep/logExportFs.js`：

  ```js
  // Writes the export under ~/.ae-mcp/logs/ and reveals it in Explorer.
  function getCepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error('CEP Node require is unavailable');
  }

  export function writeLogExport({ text, fileName, deps }) {
    const req = deps ? null : getCepRequire();
    const fs = deps ? deps.fs : req('fs');
    const os = deps ? deps.os : req('os');
    const path = deps ? deps.path : req('path');
    const dir = path.join(os.homedir(), '.ae-mcp', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  }

  export function revealInExplorer(filePath, execImpl) {
    const exec = execImpl || getCepRequire()('child_process').exec;
    exec('explorer.exe /select,"' + String(filePath).replace(/\//g, '\') + '"', { windowsHide: true }, () => { /* fire and forget */ });
  }
  ```

  修改 `plugin/panel/src/cep/claudeAgentBackend.js`：返回对象（原 333–340 行）加一行 `getStderrTail: () => stderrTail,`。在 `plugin/panel/test/claudeAgentBackend.test.js` 追加：

  ```js
  test('getStderrTail exposes the sidecar stderr buffer for log export', async () => {
    const spawned = makeSpawn();
    const backend = createClaudeAgentBackend({
      resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
      sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
      getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
      getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
      getModel: () => 'claude-sonnet-5',
      getPermissionMode: () => 'manual',
      spawnImpl: spawned.spawn,
      env: { PATH: 'C:\bin' },
    });
    assert.equal(backend.getStderrTail(), '');
    const run = backend.sendUser('hi');
    await flush();
    const proc = spawned.procs[0];
    proc.pushStderr('sidecar warn: something');
    proc.pushStdout(JSON.stringify({ t: 'ready' }) + '\n');
    await flush();
    assert.match(backend.getStderrTail(), /sidecar warn/);
    backend.reset();
    await run;
  });
  ```

  （若该测试文件的 fake proc 没有 `pushStderr`，为其 harness 补上：`pushStderr(chunk) { for (const h of stderrHandlers) h(chunk); }`，对齐 makeProc 中 stdout 的写法。）

- [ ] **Step 4: UI 接线**

  SettingsScreen：props 加 `logLevel = 'info', onLogLevel, onExportLogs`；General 区 `logLevel` 本地 state（原 354 行 `const [logLevel, setLogLevel] = React.useState('info');`）删除，`<Select value={logLevel} onChange={onLogLevel} ...>`；导出按钮改 `<Button variant="secondary" icon="download" onClick={onExportLogs}>{t.exportLog}</Button>`（去掉 `disabled`）。

  App.jsx：

  ```js
    const [logLevel, setLogLevel] = React.useState(() => readPref('ae_mcp_log_level', 'info'));
    const logLevelRef = React.useRef(logLevel);
    logLevelRef.current = logLevel;
  ```

  `pushLog`（原 518–520 行）改为：

  ```js
    const pushLog = React.useCallback((m) => {
      if (!keepLogLine(logLevelRef.current, m)) return;
      setLogs((xs) => [...xs.slice(-199), `[${new Date().toLocaleTimeString()}] ${m}`]);
    }, []);
  ```

  导出 handler + props：

  ```js
    const exportLogs = React.useCallback(() => {
      try {
        const text = buildLogExport({
          panelLogs: logs,
          hostInfo: { hostVersion: (connInfo && connInfo.hostVersion) || '-', pythonVersion: (connInfo && connInfo.pythonVersion) || '-' },
          sidecarTail: claudeBackend.getStderrTail ? claudeBackend.getStderrTail() : '',
          version: pkgVersion,
        });
        const file = writeLogExport({ text, fileName: exportFileName() });
        revealInExplorer(file);
        pushLog('Log exported: ' + file);
      } catch (e) {
        pushLog('Log export failed: ' + (e && e.message ? e.message : String(e)));
      }
    }, [logs, connInfo, claudeBackend, pushLog]);
  ```

  （`pkgVersion`：App.jsx 顶部加 `import pkg from '../../package.json';` 与 `const pkgVersion = pkg.version;`。import 区补 `buildLogExport, exportFileName, keepLogLine`（lib/logExport.js）与 `writeLogExport, revealInExplorer`（cep/logExportFs.js）。SettingsScreen props 传 `logLevel={logLevel} onLogLevel={(v) => { setLogLevel(v); writePref('ae_mcp_log_level', v); }} onExportLogs={exportLogs}`。）

- [ ] **Step 5: 测试 + 构建 + commit**

  ```
  cd plugin/panel && node --test test/ && npm run build
  git add plugin/panel/src/lib/logExport.js plugin/panel/test/logExport.test.js plugin/panel/src/cep/logExportFs.js plugin/panel/src/cep/claudeAgentBackend.js plugin/panel/test/claudeAgentBackend.test.js plugin/panel/src/screens/SettingsScreen.jsx plugin/panel/src/app/App.jsx
  git commit -m "feat(panel): working log export + effective log level (spec C)"
  ```

## Task 15: 死码清理 + 关于区链接 + 重新运行向导 + Wizard 复用通道卡

spec C 清理与职责收敛。ConnectionDrawer 已是只读状态+诊断、端口/Token 编辑已只在 Settings（核对即可，不改）。

**Files:**
- Delete: `plugin/panel/src/screens/PanelFrame.jsx`
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx`（OpenCode 分支残留文案键、假自启开关、关于区）
- Modify: `plugin/panel/src/app/App.jsx`（openCode probe 接线删除、T 表死键清理、onRerunWizard）
- Modify: `plugin/panel/src/screens/WizardScreen.jsx`（第 3 步 builtin 复用 ChannelCard）
- Test: 全量回归

- [ ] **Step 1: 核对 PanelFrame 无引用并删除**

  ```
  cd plugin/panel && grep -rn "PanelFrame" src/ test/
  ```

  预期：仅 `src/screens/PanelFrame.jsx` 自身。然后：

  ```
  git rm plugin/panel/src/screens/PanelFrame.jsx
  ```

  （若 grep 出现其他引用，先把引用点改为直接使用 StatusBar/TabBar 再删。）

- [ ] **Step 2: SettingsScreen 清理**

  - 删除假"随 AE 启动"开关：`const [autostart, setAutostart] = React.useState(true);` 一行、连接区 `<Field layout="row" label={t.autostart} ...>` 块、`S` 表 zh/en 的 `autostart/autostartCap` 键。
  - OpenCode：Task 12 已删分支 JSX；本步 grep 清掉 `S` 表残留 `openCode*` 键与 props 残留。
  - 关于区（原 641–649 行）替换为：

  ```jsx
        <Section id="about" title={t.about} expanded={sections.about} onToggle={onToggleSection}>
          <VersionRow label={t.verPanel} value={`v${pkg.version}`} />
          <VersionRow label={t.verHost} value={hostVersion} badge={hostVersion === '-' ? <Badge status="neutral">{t.pending}</Badge> : null} />
          <VersionRow label={t.verPy} value={pythonVersion} badge={pythonVersion === '-' ? <Badge status="neutral">{t.pending}</Badge> : null} />
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="ghost" size="sm" icon="book-open" onClick={() => openExternal(DOCS_URL)}>{t.docs}</Button>
            <Button variant="ghost" size="sm" icon="github" onClick={() => openExternal(REPO_URL)}>{t.github}</Button>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" icon="rotate-cw" onClick={onRerunWizard}>{t.rerunWizard}</Button>
          </div>
        </Section>
  ```

  文件顶部（import 之后）加：

  ```js
  const REPO_URL = 'https://github.com/JUNKDOGE-JOE/AEMCP';
  const DOCS_URL = 'https://github.com/JUNKDOGE-JOE/AEMCP#readme';

  function openExternal(url) {
    try {
      if (globalThis.window && window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
        return;
      }
    } catch (e) { /* fall through */ }
    try { window.open(url, '_blank'); } catch (e) { /* best effort */ }
  }
  ```

  （执行时用 `git remote get-url origin` 核对仓库 URL，不一致则以实际为准。）props 加 `onRerunWizard`；`S` 表 zh/en 加 `rerunWizard: '重新运行向导'` / `rerunWizard: 'Re-run setup wizard'`。

- [ ] **Step 3: App.jsx 清理与接线**

  - 删除 `openCodeProbe/openCodeModels/runOpenCodeProbe` state 与 effect（原 257–258、445–464 行）、`readCachedOpenCodeModels/writeCachedOpenCodeModels`（147–166 行）、descriptor effect 中 opencode 分支（278–281 行）、`openCodeDescriptorFromModels` import。`openCodeBackend` 实例与 `backendInstances.opencode` 保留（防陈旧状态崩溃；`migrateBackendPref` 已把 pref 归一）。
  - `T` 表删除已无引用的键：`noKeyHint/probingHint/notLoggedInHint/codexProbingHint/codexNotLoggedInHint/codexRuntimeHint/openCodeProbingHint/openCodeNotLoggedInHint/zcodeProbingHint/zcodeNotLoggedInHint/zcodeRuntimeHint/noNodeHint`（Task 10 已改走 fixHint；删前逐一 grep 确认）。`zcodeUnavailableHint` import 与 `lib/settingsState.js` 中该函数若无引用一并删除（保留 `zcodeModelLocked/zcodeRuntimeBadge` 中仍被引用者；`zcodeRuntimeBadge` 在 Task 12 后应已无引用，删除并同步 `settingsState.test.js`）。
  - SettingsScreen props 加 `onRerunWizard={() => { try { window.localStorage.removeItem('ae_mcp_wizard_done'); } catch (e) {} setWizardDone(false); setWizStep(1); }}`。
  - WizardScreen props 加 `channels={channels} activeChannel={effective.channel || ''}`。

- [ ] **Step 4: Wizard 第 3 步复用通道卡**

  修改 `plugin/panel/src/screens/WizardScreen.jsx`：import `ChannelCard`；组件 props 加 `channels = { claude: [], codex: [], zcode: [] }, activeChannel = ''`；`client === 'builtin'` 块（原 234–250 行）SUBSCRIPTION_STEPS 列表之后追加：

  ```jsx
                <ChannelCard lang={lang} channels={channels.claude} activeChannel={activeChannel} readOnly />
  ```

- [ ] **Step 5: 全量回归 + 构建 + commit**

  ```
  cd plugin/panel && node --test test/ && npm run build
  cd plugin/panel && grep -rn "PanelFrame\|autostart\|openCodeStatus" src/ ; echo "expect: no matches"
  git add -A plugin/panel/src plugin/panel/test
  git commit -m "chore(panel): remove dead code, wire about links, wizard re-run + channel card reuse (spec C)"
  ```

# Phase 2 出口检查

- [ ] `node --test test/` 全绿 + `npm run build` 成功。
- [ ] Settings 六分区可折叠且状态持久；AI 区为三选一 + 通道卡 + Provider 管理；日志导出可用；无 OpenCode 分支/假开关/死文件；关于区按钮可点。

# Phase 3 — 收尾验证

## Task 16: 全量单测 + live 手测矩阵

**Files:**
- Test: `plugin/panel/test/`（全部）、`plugin/sidecar/test/`（全部）
- 无代码改动（发现问题回到对应 Task 修）

- [ ] **Step 1: 全量单测**

  ```
  cd plugin/panel && node --test test/
  cd plugin/sidecar && node --test test/
  ```

  预期：0 fail。任何失败回到对应 Task 的实现步骤修复后重跑。

- [ ] **Step 2: 构建 + 部署到面板运行时**

  ```
  cd plugin/panel && npm run build
  ```

  按仓库既有安装流程把构建产物同步到已安装的 CEP 面板目录（注意 memory 提示：已安装面板可能是陈旧副本，sidecar 的 `agent-sidecar.mjs`/`lib.mjs` 也要一并同步），重启 After Effects。

- [ ] **Step 3: live 手测矩阵（逐项勾选；全部在用户实机 Windows 11 + AE 上执行）**

  ZCode：
  - [ ] **CLI 继承**：设置 → AI 服务 → ZCode，通道①显示来源徽标「继承自 ZCode CLI」，detail 为 `mediastorm_glm/glm-5.2`。
  - [ ] **key 粘贴兜底**：环境变量未继承场景（面板默认即是），通道①先显示"粘贴一次 Key"fixHint → 粘贴中转站 key → 确认 `~/.ae-mcp/zcode-key` 生成、通道①变绿，发一条消息收到回复。
  - [ ] **评分回归**：全程不出现 `Model provider is missing an API key: builtin:zai-start-plan`（旧故障指纹）。
  - [ ] **桌面配置次级**：临时把 `~/.zcode/cli/config.json` 改名 → 重新检测 → 生效通道回落到「继承自 ZCode 桌面版」（若桌面配置存在）；测完还原文件。
  - [ ] **start-plan 无凭据不可选**：通道③始终灰显（ok=false），zh fixHint 提到验证码桥接未实现；锁定它时 composer 被禁用并显示该 fixHint。
  - [ ] **错误本地化**：界面语言=中文时人为触发一次 provider 错误（如临时填错 key），错误卡片首行为中文可操作指引。

  Codex：
  - [ ] **CLI 登录态识别**：终端 `codex` 已登录状态下，通道①显示已登录 + email/plan + codex 绝对路径与版本（probe 诊断）。
  - [ ] **自定义 provider**：Provider 管理新增中转站（openai-compatible）→ Codex 通道②选中它 → 发消息成功。
  - [ ] **AE_MCP_CODEX_CLI**：（可选）设置该环境变量指向 codex.exe 启动 AE，确认面板用它 spawn（日志/诊断路径一致）。

  Claude（API 直连，经第三方中转）：
  - [ ] **sidecar 注入路径**：Provider 管理新增 Anthropic 协议中转 provider → Claude 通道②选中并锁定 → 发消息，确认走 sidecar（完整 agentic：能调用 ae_ 工具），中转站后台可见 `/v1/messages` 流量。
  - [ ] **byokLoop 降级路径**：临时让 `resolveSystemNode` 失败（把 `C:\Program Files\nodejs\node.exe` 改名且 PATH 无 node）→ 同一通道自动降级为直连 HTTP（仍可对话），完成后还原。
  - [ ] **settings.json 一键导入**：在 `~/.claude/settings.json` 写入 `env.ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN` 测试值 → 面板 Claude 通道②出现导入按钮 → 点击后 Provider 管理出现 `claude-settings-import` 条目；测完清理该文件改动。
  - [ ] **订阅探测失败引导**：订阅未登录时，通道①fixHint（中文）明确指向「API 直连」通道。

  Provider 管理器：
  - [ ] **增/改/删**：新增 → 编辑 baseUrl → 删除，`~/.ae-mcp/providers.json` 内容随之变化；删除被引用的 provider 后对应通道下拉回落到"未选择"。
  - [ ] **探测成功**：中转站条目点「探测模型」→ 徽标显示 16 个模型 → Chat composer 模型 chip 列出探测结果。
  - [ ] **探测失败降级**：故意填错 key 探测 → 显示失败原因 → 「自定义模型 ID」手填仍可发消息。
  - [ ] **旧配置迁移**：（首次启动新版时观察）旧 `~/.ae-mcp/anthropic-key`/`codex-key` 自动出现为 `legacy-anthropic`/`legacy-codex` 条目，且原有对话能力不回退。
  - [ ] **cc-switch 未安装**：实机三个位置均不存在 → Provider 管理内不显示「从 cc-switch 导入」按钮。

  Settings UX：
  - [ ] **折叠持久化**：展开「通用」+ 折叠「AI 服务」→ 关闭重开面板 → 状态保持；默认首启只展开「AI 服务」。
  - [ ] **日志导出**：点「导出日志」→ 生成 `~/.ae-mcp/logs/export-<ts>.txt`（含 panel logs / host 版本 / sidecar tail 三段）→ 资源管理器自动打开并选中该文件。
  - [ ] **日志级别生效**：级别切 Error 后，普通 "Host ready" 类日志不再进入缓冲，Error 行仍进入。
  - [ ] **双语 fixHint**：任选一个不可用通道，中/英切换界面语言，fixHint 语言即时跟随。
  - [ ] **向导重跑**：关于区「重新运行向导」→ 从第 1 步开始；第 3 步选「面板内置对话」时显示只读通道卡（状态与 Settings 一致）。
  - [ ] **关于区链接**：Docs / GitHub 按钮在默认浏览器打开正确页面。
  - [ ] **职责收敛核对**：ConnectionDrawer 仅剩只读状态+诊断；端口/Token 编辑仅存在于 Settings。

  暂缓项（当前无对应凭据，不阻塞收尾；凭据就绪后补测）：
  - 【暂缓】**Claude 订阅登录通道**：`claude /login` 订阅态探测 + 订阅会话（无订阅凭据）。
  - 【暂缓】**官方 Anthropic API 直连**：官方 `api.anthropic.com` + 官方 key 的 API 直连通道（无官方 key）。

- [ ] **Step 4: 手测问题归零后，最终 commit（若矩阵执行中产生修复）**

  ```
  cd plugin/panel && node --test test/ && cd ../sidecar && node --test test/
  git add -A plugin/
  git commit -m "test(panel): live matrix fixes for credential channels"
  ```

  （若矩阵零修复则跳过本 commit。）

---

## 完成定义（DoD）

- spec A/A2/B/C/D/E 全部条目有对应落地 Task（见「Spec 覆盖索引」）。
- panel + sidecar 全量 `node --test` 通过；`npm run build` 成功。
- live 手测矩阵除两条【暂缓】外全部勾选。
- 三个原始故障的指纹全部消失：`builtin:zai-start-plan` 缺 key 英文透传、Codex "CLI 已登录面板判未登录"、Claude 第三方端点无法在面板使用。
