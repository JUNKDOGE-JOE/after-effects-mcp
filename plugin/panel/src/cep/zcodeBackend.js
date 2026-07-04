// Embedded ZCode chat backend.
//
// Spawns the ZCode CLI (`zcode.cjs app-server`) as a stdio JSON-RPC server and
// drives it through the ZCode Protocol (NOT standard MCP — messages omit the
// `jsonrpc` envelope; the server strict-parses and rejects it). Login state is
// shared with the ZCode Electron app via ~/.zcode/v2/config.json. The embedded
// app-server session is isolated from the CLI TUI config, so session/create
// receives the ae MCP server explicitly.
//
// ZCode app-server protocol:
//   session/create  {workspace:{workspacePath,workspaceKey}, mode} -> result.session.sessionId
//   session/subscribe {sessionId, deliveryKind:"desktop-continuous"}  -> streams notifications
//   session/send    {sessionId, content} -> {accepted:true}
//   session/stop    {sessionId}
//   session/messages {sessionId} -> {messages:[...]}
// Events (notifications, payload under .payload):
//   turn.started, model.streaming {delta, kind:"text_delta", done}, tool.updated,
//   permission.requested {toolCallId, toolName, riskLevel, options[]},
//   permission.resolved, turn.completed {response, usage}
// Approval is answered via elicitation/create.
//
// Message format: {method, params, id?} — NO jsonrpc field (server rejects it).

import { createNdjsonReader } from '../lib/ndjson.js';
import { resolveSystemNode } from './claudeAgentBackend.js';
import { expertGuidanceEnv } from './externalClients.js';
import { createApiKeyStore } from './apiKey.js';
import { localizeZcodeError } from '../lib/zcodeErrors.js';

const RPC_TIMEOUT_MS = 30000;
const STDERR_TAIL_LIMIT = 4096;
const DELIVERY_KIND = 'desktop-continuous';
const ZCODE_BUILTIN_DEFAULT_MODEL = 'builtin:bigmodel-start-plan/GLM-5.2';
const LEGACY_ZCODE_MODEL_REFS = new Set(['mediastorm_glm/glm-5.2']);
const ZCODE_THOUGHT_LEVELS = new Set(['nothink', 'high', 'max', 'low', 'medium']);
const ZCODE_CREDENTIAL_PREFIX = 'enc:v1:';
const ZCODE_API_KEY_NAME = 'zcode-api-key';
const BIGMODEL_API_ORIGIN = 'https://bigmodel.cn';
const ZAI_BIZ_API_ORIGIN = 'https://api.z.ai';
const JSON_CONTENT_TYPE = 'application/json';

// ZCode permission modes map onto the panel's four approval tiers.
const MODE_BY_TIER = {
  readonly: 'plan',
  manual: 'build',
  auto: 'edit',
  none: 'yolo',
};

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function getCepEnv() {
  return (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env) || {};
}

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Resolve the ZCode CLI bundle. Checks the env override first, then the
// standard install path under LOCALAPPDATA, then `where zcode` on PATH.
async function resolveZcodeCli({ env, execFileImpl }) {
  const override = env && env.AE_MCP_ZCODE_CLI;
  if (override) return { ok: true, cliPath: override };

  const localAppData = env && (env.LOCALAPPDATA || env.LocalAppData);
  if (localAppData) {
    const path = localAppData + '\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
    try {
      await statFile(path);
      return { ok: true, cliPath: path };
    } catch (e) { /* not installed here, fall through */ }
  }

  // Last resort: a `zcode` shim on PATH (rare; the installer is Electron-only).
  const execFile = execFileImpl || getCepRequire()('child_process').execFile;
  try {
    const where = await execFileAsync(execFile, 'where', ['zcode'], env || {});
    if (!where.err && where.stdout) {
      const exe = String(where.stdout).split(/\r?\n/)[0].trim();
      if (exe) return { ok: true, cliPath: exe, isExe: true };
    }
  } catch (e) { /* ignore */ }

  return { ok: false, detail: 'ZCode CLI not found. Install ZCode or set AE_MCP_ZCODE_CLI to the zcode.cjs path.' };
}

function statFile(path) {
  const fs = getCepRequire()('fs');
  return new Promise((resolve, reject) => fs.stat(path, (err) => (err ? reject(err) : resolve())));
}

function execFileAsync(execFile, cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Minimal RPC for ZCode's stripped protocol (no jsonrpc field).
function createRpc({ writeLine, onNotification, onRequest, timeoutMs = RPC_TIMEOUT_MS }) {
  let nextId = 1;
  const pending = new Map();

  function writeMessage(message) {
    writeLine(JSON.stringify(message) + '\n');
  }

  function rejectPending(id, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;

    if (hasId && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'ZCode request failed');
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method && hasId) {
      if (onRequest) onRequest(message);
      return;
    }

    if (message.method && onNotification) onNotification(message);
  }

  function request(method, params, timeoutOverrideMs) {
    const id = nextId++;
    const message = { id, method };
    if (params !== undefined) message.params = params;
    const limit = timeoutOverrideMs || timeoutMs;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => rejectPending(id, new Error(method + ' timed out after ' + limit + 'ms')), limit);
      pending.set(id, { resolve, reject, timer });
    });
    writeMessage(message);
    return promise;
  }

  function fireRequest(method, params) {
    const id = nextId++;
    const message = { id, method };
    if (params !== undefined) message.params = params;
    writeMessage(message);
    return id;
  }

  function respond(id, result) {
    writeMessage({ id, result });
  }

  function respondError(id, code, message) {
    writeMessage({ id, error: { code, message } });
  }

  function close(reason = new Error('ZCode app-server closed')) {
    for (const id of Array.from(pending.keys())) rejectPending(id, reason);
  }

  return { request, fireRequest, respond, respondError, close, handleMessage };
}

function mcpToolName(name) {
  const text = String(name || '');
  return text.startsWith('mcp__') ? text : 'mcp__ae__' + text;
}

function zcodeProviderId(modelRef) {
  const text = String(modelRef || '').trim();
  const slash = text.indexOf('/');
  return slash > 0 ? text.slice(0, slash).trim() : '';
}

function zcodeProviderApiKeyEnv(providerId) {
  const text = String(providerId || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return text ? text + '_API_KEY' : '';
}

function zcodeModelIds(provider) {
  const models = provider && provider.models;
  if (Array.isArray(models)) return models.map((m) => m && (m.id || m.modelID || m.modelId || m.name)).filter(Boolean).map(String);
  if (models && typeof models === 'object') return Object.keys(models);
  return [];
}

function zcodePreferredModelId(provider) {
  const ids = zcodeModelIds(provider);
  if (!ids.length) return '';
  return ids.find((id) => id === 'GLM-5.2') || ids.find((id) => /GLM-5\.2/i.test(id)) || ids[0];
}

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

export function zcodeModelFromDesktopConfig({ config, setting, env = {} }) {
  const entry = zcodeDesktopProviderEntry({ config, setting, env });
  return entry ? entry.providerId + '/' + entry.modelId : '';
}

function zcodeProtocolProviderKind(kind) {
  const text = String(kind || '').trim();
  if (text === 'openai' || text === 'openai-compatible') return text;
  return 'anthropic';
}

function zcodeProtocolApiFormat(provider, kind) {
  const direct = provider && (provider.apiFormat || provider.api_format);
  if (direct) return direct;
  if (kind === 'openai') return 'openai-responses';
  if (kind === 'openai-compatible') return 'openai-chat-completions';
  return 'anthropic-messages';
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function zcodeProtocolModelEntry(modelId, raw) {
  const model = raw && typeof raw === 'object' ? raw : {};
  const limit = model.limit && typeof model.limit === 'object' ? model.limit : {};
  return {
    modelId,
    ...(model.label || model.name ? { label: model.label || model.name } : {}),
    ...(positiveNumber(model.contextWindow || limit.contextWindow) ? { contextWindow: positiveNumber(model.contextWindow || limit.contextWindow) } : {}),
    ...(positiveNumber(model.maxOutputTokens || limit.maxOutputTokens) ? { maxOutputTokens: positiveNumber(model.maxOutputTokens || limit.maxOutputTokens) } : {}),
  };
}

function zcodeProtocolModels(provider, selectedModelId) {
  const models = provider && provider.models;
  const result = [];
  if (Array.isArray(models)) {
    for (const raw of models) {
      const id = raw && (raw.id || raw.modelID || raw.modelId || raw.name);
      if (id) result.push(zcodeProtocolModelEntry(String(id), raw));
    }
  } else if (models && typeof models === 'object') {
    for (const [id, raw] of Object.entries(models)) result.push(zcodeProtocolModelEntry(String(id), raw));
  }
  if (selectedModelId && !result.some((m) => m.modelId === selectedModelId)) {
    result.unshift({ modelId: selectedModelId });
  }
  return result;
}

export function resolveZcodeProviderApiKey({ provider, env = {}, storedKey = '' } = {}) {
  const options = provider && provider.options && typeof provider.options === 'object' ? provider.options : {};
  const inline = options.apiKey || (provider && provider.apiKey);
  if (inline) return { key: String(inline), source: 'config' };
  const keyEnv = String(options.apiKeyEnv || '').trim();
  if (keyEnv && env[keyEnv]) return { key: String(env[keyEnv]), source: 'env' };
  if (storedKey) return { key: String(storedKey), source: 'panel' };
  return { key: '', source: '' };
}

export function zcodeRuntimeModelFromDesktopConfig({ config, setting, modelRef, thoughtLevel, env = {}, storedKey = '' } = {}) {
  const entry = zcodeDesktopProviderEntry({ config, setting, modelRef, env });
  if (!entry) return null;

  const provider = entry.provider || {};
  const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
  const kind = zcodeProtocolProviderKind(provider.kind);
  const apiKey = resolveZcodeProviderApiKey({ provider, env, storedKey }).key;
  const protocolProvider = {
    providerId: entry.providerId,
    kind,
    apiFormat: zcodeProtocolApiFormat(provider, kind),
    ...(provider.name || provider.label ? { label: provider.name || provider.label } : {}),
    source: provider.source || 'custom',
    ...(options.baseURL || provider.baseURL || (provider.endpoints && provider.endpoints.baseURL) ? { baseURL: options.baseURL || provider.baseURL || provider.endpoints.baseURL } : {}),
    ...(apiKey ? { apiKey: { source: 'inline', value: String(apiKey) } } : {}),
    ...(typeof options.apiKeyRequired === 'boolean' || typeof provider.apiKeyRequired === 'boolean' ? { apiKeyRequired: options.apiKeyRequired ?? provider.apiKeyRequired } : {}),
    models: zcodeProtocolModels(provider, entry.modelId),
  };

  return {
    revision: 'desktop-v2:' + entry.providerId,
    generatedAt: Date.now(),
    model: { providerId: entry.providerId, modelId: entry.modelId },
    provider: protocolProvider,
    ...(thoughtLevel ? { thoughtLevel } : {}),
  };
}

function zcodeDesktopBasePath(env) {
  const home = env && (env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : ''));
  return home ? String(home).replace(/[\\/]+$/, '') + '\\.zcode\\v2' : '';
}

function readJsonFile(fsImpl, path) {
  try {
    return JSON.parse(fsImpl.readFileSync(path, 'utf8'));
  } catch (e) {
    return null;
  }
}

function zcodeCliBasePath(env) {
  const home = env && (env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : ''));
  return home ? String(home).replace(/[\\/]+$/, '') + '\\.zcode\\cli' : '';
}

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
  const desktopConfig = desktopBase ? readJsonFile(fs, desktopBase + '\\config.json') : null;
  const setting = desktopBase ? readJsonFile(fs, desktopBase + '\\setting.json') : null;
  const cliConfig = cliBase ? readJsonFile(fs, cliBase + '\\config.json') : null;
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
      // Probe-driven model discovery (spec A2 applied to zcode): baseUrl +
      // protocol let the panel call probeProviderModels against /v1/models
      // when session/create's settings.model.available comes back empty.
      baseUrl: String((cliProvider.options && cliProvider.options.baseURL) || cliProvider.baseURL || ''),
      protocol: zcodeProtocolProviderKind(cliProvider.kind),
    } : null,
    desktop: desktopIds.length ? { providerId: desktopIds[0] } : null,
    startPlan: startPlanId ? {
      providerId: startPlanId,
      hasCredential: hasZcodeProviderCredential(startPlanProvider, env),
    } : null,
  };
}

function zcodeProviderFamily(providerId) {
  const text = String(providerId || '').trim();
  const id = text.startsWith('builtin:') ? text.slice('builtin:'.length) : text;
  return id.replace(/-(?:start|coding)-plan$/i, '').split(/[/:]/)[0];
}

function getNodeBuffer() {
  return globalThis.Buffer || getCepRequire()('buffer').Buffer;
}

function zcodeCredentialSecret(env, osImpl) {
  const explicit = env && env.ZCODE_CREDENTIAL_SECRET && String(env.ZCODE_CREDENTIAL_SECRET).trim();
  if (explicit) return explicit;
  const os = osImpl || getCepRequire()('os');
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (e) { /* keep fallback username */ }
  return 'zcode-credential-fallback:' + os.platform() + ':' + os.homedir() + ':' + username;
}

function decryptZcodeCredentialValue(value, { env, cryptoImpl, osImpl } = {}) {
  const text = String(value || '');
  if (!text.startsWith(ZCODE_CREDENTIAL_PREFIX)) return text;
  const crypto = cryptoImpl || getCepRequire()('crypto');
  const BufferImpl = getNodeBuffer();
  const parts = text.slice(ZCODE_CREDENTIAL_PREFIX.length).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Credential decrypt failed: invalid ciphertext format');
  }
  const key = crypto.createHash('sha256').update(zcodeCredentialSecret(env || {}, osImpl)).digest();
  const iv = BufferImpl.from(parts[0], 'base64url');
  const authTag = BufferImpl.from(parts[1], 'base64url');
  const cipherText = BufferImpl.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return BufferImpl.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

function readZcodeOAuthAccessToken({ env, fsImpl, providerId } = {}) {
  const base = zcodeDesktopBasePath(env || {});
  if (!base) return '';
  const fs = fsImpl || getCepRequire()('fs');
  const credentials = readJsonFile(fs, base + '\\credentials.json');
  if (!credentials || typeof credentials !== 'object') return '';

  const providers = [];
  const family = zcodeProviderFamily(providerId);
  if (family) providers.push(family);
  const active = credentials['oauth:active_provider'];
  if (active) {
    try {
      const activeProvider = decryptZcodeCredentialValue(active, { env });
      if (activeProvider && !providers.includes(activeProvider)) providers.push(activeProvider);
    } catch (e) { /* ignore unreadable active provider and try explicit provider */ }
  }

  for (const provider of providers) {
    const raw = credentials['oauth:' + provider + ':access_token'];
    if (!raw) continue;
    return decryptZcodeCredentialValue(raw, { env });
  }
  return '';
}

function resolveBigModelApiOrigin(env = {}) {
  const explicit = env.BIGMODEL_API_BASE_URL || env.BIGMODEL_PRODUCTION_API_BASE_URL;
  return String(explicit || BIGMODEL_API_ORIGIN).replace(/\/+$/, '');
}

function remoteCodeOk(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === '0' || code === '200';
}

async function defaultHttpRequestJson({ url, method = 'GET', headers = {}, body }) {
  const target = new URL(url);
  const moduleName = target.protocol === 'http:' ? 'http' : 'https';
  const http = getCepRequire()(moduleName);
  const BufferImpl = getNodeBuffer();
  const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const requestHeaders = Object.assign({}, headers);
  if (payload !== null && requestHeaders['Content-Length'] === undefined) {
    requestHeaders['Content-Length'] = String(BufferImpl.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = BufferImpl.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('ZCode OAuth request failed with HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (e) {
          reject(new Error('ZCode OAuth response was not valid JSON'));
        }
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function requestRemoteData(requestJson, options) {
  const json = await requestJson(options);
  if (!json || typeof json !== 'object') throw new Error('ZCode OAuth response was empty');
  if (!remoteCodeOk(json.code)) throw new Error(json.msg || ('Remote business error ' + json.code));
  return json.data ?? null;
}

function pickOrgAndProject(customerInfo) {
  const organizations = customerInfo && Array.isArray(customerInfo.organizations) ? customerInfo.organizations : [];
  const org = organizations.find((item) => String(item.organizationName || '').includes('\u9ED8\u8BA4\u673A\u6784')) || organizations[0];
  const projects = org && Array.isArray(org.projects) ? org.projects : [];
  const project = projects.find((item) => String(item.projectName || '').includes('\u9ED8\u8BA4\u9879\u76EE')) || projects[0];
  if (!org || !project || !org.organizationId || !project.projectId) return null;
  return { organizationId: org.organizationId, projectId: project.projectId };
}

async function resolveBizApiKey({ authorization, host, requestJson, requireSecretKey = false }) {
  const headers = { Authorization: authorization, 'Content-Type': JSON_CONTENT_TYPE };
  const customer = await requestRemoteData(requestJson, {
    method: 'GET',
    url: host + '/api/biz/customer/getCustomerInfo',
    headers,
  });
  const orgProject = pickOrgAndProject(customer);
  if (!orgProject) throw new Error('Unable to resolve ZCode OAuth organization and project.');

  const apiKeysUrl = host + '/api/biz/v1/organization/' + encodeURIComponent(orgProject.organizationId)
    + '/projects/' + encodeURIComponent(orgProject.projectId) + '/api_keys';
  const apiKeys = await requestRemoteData(requestJson, { method: 'GET', url: apiKeysUrl, headers });
  const existing = Array.isArray(apiKeys) ? apiKeys.find((item) => item && item.name === ZCODE_API_KEY_NAME) : null;
  const created = existing || await requestRemoteData(requestJson, {
    method: 'POST',
    url: apiKeysUrl,
    headers,
    body: { name: ZCODE_API_KEY_NAME },
  });
  const apiKey = String((created && (created.apiKey || created.api_key)) || '').trim();
  if (!apiKey) throw new Error('ZCode OAuth API key response is missing apiKey.');

  const copied = await requestRemoteData(requestJson, {
    method: 'GET',
    url: apiKeysUrl + '/copy/' + encodeURIComponent(apiKey),
    headers,
  });
  const secretKey = String((copied && (copied.secretKey || copied.secret_key)) || '').trim();
  if (!secretKey && requireSecretKey) throw new Error('ZCode OAuth API key copy response is missing secretKey.');
  return secretKey ? apiKey + '.' + secretKey : apiKey;
}

async function resolveZcodeCodingPlanApiKey({ accessToken, providerId, env, requestJson = defaultHttpRequestJson } = {}) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('ZCode desktop OAuth token is unavailable.');
  const family = zcodeProviderFamily(providerId);
  if (family === 'zai') {
    const data = await requestRemoteData(requestJson, {
      method: 'POST',
      url: ZAI_BIZ_API_ORIGIN + '/api/auth/z/login',
      headers: { 'Content-Type': JSON_CONTENT_TYPE },
      body: { token },
    });
    const bizToken = String((data && (data.access_token || data.accessToken)) || '').trim();
    if (!bizToken) throw new Error('ZCode OAuth biz token response is missing access_token.');
    return resolveBizApiKey({ authorization: 'Bearer ' + bizToken, host: ZAI_BIZ_API_ORIGIN, requestJson, requireSecretKey: true });
  }
  return resolveBizApiKey({ authorization: token, host: resolveBigModelApiOrigin(env || {}), requestJson });
}

function runtimeModelWithApiKey(runtimeModel, apiKey) {
  const next = clone(runtimeModel);
  next.revision = (runtimeModel.revision || 'runtime-model') + ':oauth:' + Date.now();
  next.generatedAt = Date.now();
  next.provider = Object.assign({}, next.provider || {}, {
    apiKey: { source: 'inline', value: String(apiKey) },
  });
  return next;
}

function isZcodePlanRuntimeModel(runtimeModel, providerId) {
  const provider = runtimeModel && runtimeModel.provider ? runtimeModel.provider : {};
  const id = String(providerId || provider.providerId || '').trim();
  const baseURL = String(provider.baseURL || '').replace(/\/+$/, '').toLowerCase();
  return /-start-plan$/i.test(id) || baseURL.endsWith('/zcode-plan') || baseURL.endsWith('/zcode-plan/anthropic');
}

function zcodePlanRuntimeHeadersMessage() {
  return 'ZCode desktop OAuth plan providers require ZCode desktop captcha/runtime headers before model requests. '
    + 'The AE panel can read the desktop provider config, but the current app-server bridge cannot generate or apply those headers yet. '
    + 'Use ZCode Desktop chat or configure an API-key provider in ZCode for now.';
}

function isLegacyZcodeModelRef(modelRef) {
  return LEGACY_ZCODE_MODEL_REFS.has(String(modelRef || '').trim());
}

function zcodeProtocolModelFromRef(modelRef) {
  const text = String(modelRef || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return {
    providerId: text.slice(0, slash),
    modelId: text.slice(slash + 1),
  };
}

function zcodeMissingApiKeyHint(message) {
  const text = String(message || '');
  const match = /Model provider is missing an API key:\s*([^\s.]+)/i.exec(text);
  if (!match || /AE_MCP_ZCODE_API_KEY|ZCODE_API_KEY/.test(text)) return text;
  const providerEnv = zcodeProviderApiKeyEnv(match[1]);
  const vars = ['AE_MCP_ZCODE_API_KEY'];
  if (providerEnv) vars.push(providerEnv);
  vars.push('ZCODE_API_KEY');
  return (text.endsWith('.') ? text : text + '.') + ' Set ' + vars.join(', ') + ' before launching AE.';
}

function zcodeMissingModelConfigHint(message) {
  const text = String(message || '');
  if (!/Model config is missing/i.test(text) || /Open ZCode/.test(text)) return text;
  return (text.endsWith('.') ? text : text + '.') + ' Open ZCode and select a provider/model, or create ~/.zcode/cli/config.json with an explicit provider/model before launching AE.';
}

function zcodeProviderAuthenticationHint(message) {
  const text = String(message || '');
  if (!/Provider authentication failed/i.test(text) || /runtime headers/i.test(text)) return text;
  return (text.endsWith('.') ? text : text + '.') + ' If this is a ZCode desktop OAuth plan provider, the AE panel cannot yet bridge ZCode desktop captcha/runtime headers.';
}

function zcodePlanRuntimeFailureHint(message, runtimeModel) {
  const text = String(message || '');
  if (!/Provider authentication failed|Model request failed/i.test(text)) return text;
  if (/runtime headers/i.test(text) || !isZcodePlanRuntimeModel(runtimeModel)) return text;
  return (text.endsWith('.') ? text : text + '.') + ' ' + zcodePlanRuntimeHeadersMessage();
}

function zcodeRepairHint(message) {
  return zcodeProviderAuthenticationHint(zcodeMissingModelConfigHint(zcodeMissingApiKeyHint(message)));
}

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

function zcodeErrorKind(message) {
  return /\b(model|provider|api[-\s_]*key|credential|auth)\b/i.test(String(message || '')) ? 'model' : 'mcp';
}

function defaultReadStoredZcodeKey() {
  try { return createApiKeyStore().readKey('zcode'); } catch (e) { return ''; }
}

export function createZcodeBackend({
  spawnImpl,
  getModel,
  getPermissionMode,
  getEffort = () => null,
  getMcpSpec,
  getToolMeta,
  getExpertGuidance = () => true,
  getServerInstructions = () => '',
  onEvent,
  lang = 'zh',
  env,
  readDesktopModel = readZcodeDesktopModel,
  readDesktopRuntimeModel = readZcodeDesktopRuntimeModel,
  readOAuthAccessToken = readZcodeOAuthAccessToken,
  resolveCodingPlanApiKey = resolveZcodeCodingPlanApiKey,
  resolveCli = resolveZcodeCli,
  resolveNode = resolveSystemNode,
  readStoredZcodeKey = defaultReadStoredZcodeKey,
}) {
  let proc = null;
  let rpc = null;
  let startPromise = null;
  let sessionPromise = null;
  let sessionId = null;
  let sessionModelRef = null;
  let subscribed = false;
  let activeRuntimeModel = null;
  let stopping = false;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let toolMeta = { allowedTools: [], annotations: {} };
  const pendingApprovals = new Map();
  const pendingElicitations = new Map();
  const pendingUserInputs = new Map();
  const sessionAllowedTools = new Set();

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function getSpawn() {
    if (spawnImpl) return spawnImpl;
    return getCepRequire()('child_process').spawn;
  }

  function currentEnv() {
    const next = Object.assign({}, getCepEnv(), env || {});
    const panelModel = next.AE_MCP_ZCODE_MODEL && String(next.AE_MCP_ZCODE_MODEL).trim();
    if (!next.ZCODE_MODEL && panelModel) next.ZCODE_MODEL = panelModel;
    const panelApiKey = (next.AE_MCP_ZCODE_API_KEY && String(next.AE_MCP_ZCODE_API_KEY).trim()) || String(readStoredZcodeKey() || '').trim();
    if (panelApiKey) {
      if (!next.ZCODE_API_KEY) next.ZCODE_API_KEY = panelApiKey;
      const providerEnv = zcodeProviderApiKeyEnv(zcodeProviderId(next.ZCODE_MODEL));
      if (providerEnv && !next[providerEnv]) next[providerEnv] = panelApiKey;
    }
    return next;
  }

  function currentModelRef(spawnEnv) {
    const explicitEnvModel = spawnEnv && spawnEnv.ZCODE_MODEL && String(spawnEnv.ZCODE_MODEL).trim();
    if (explicitEnvModel) return explicitEnvModel;

    const selectedModel = getModel ? String(getModel() || '').trim() : '';
    if (selectedModel.includes('/') && !isLegacyZcodeModelRef(selectedModel)) return selectedModel;

    let desktopModel = '';
    try { desktopModel = readDesktopModel ? String(readDesktopModel({ env: spawnEnv }) || '').trim() : ''; } catch (e) { /* ignore unreadable desktop config */ }
    if (desktopModel) return desktopModel;
    if (selectedModel.includes('/')) return selectedModel;
    return ZCODE_BUILTIN_DEFAULT_MODEL;
  }

  function currentRuntimeModel(spawnEnv, modelRef, thoughtLevel) {
    if (!readDesktopRuntimeModel) return null;
    try {
      return readDesktopRuntimeModel({ env: spawnEnv, modelRef, thoughtLevel, storedKey: String(readStoredZcodeKey() || '').trim() }) || null;
    } catch (e) {
      return null;
    }
  }

  function finishActive() {
    if (!activeResolve) {
      activeRun = null;
      activeAssistantText = '';
      return;
    }
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    resolve();
  }

  function drainApprovals() {
    for (const [toolUseId, approval] of Array.from(pendingApprovals.entries())) {
      if (rpc) rpc.respond(approval.rpcId, { decision: 'decline' });
      pendingApprovals.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
    for (const [toolUseId, elicit] of Array.from(pendingElicitations.entries())) {
      if (rpc && elicit.rpcId) rpc.respond(elicit.rpcId, { action: 'decline' });
      pendingElicitations.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
    for (const [toolUseId, ui] of Array.from(pendingUserInputs.entries())) {
      if (rpc && ui.rpcId) rpc.respond(ui.rpcId, { decision: 'decline', answers: {} });
      pendingUserInputs.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
  }

  // ZCode sends two kinds of server-initiated REQUESTS (with id) that we must
  // reply to, or the agent hangs forever:
  //   - elicitation/create (mode:"form"): AskUserQuestion — the agent wants the
  //     user to pick from options defined in requestedSchema.properties. Reply
  //     with {action:"accept", content:{<field>:<value>}} or {action:"decline"}.
  //   - permission.requested / session/permission: tool approval. Reply with
  //     {decision:"allow"|"decline"}.
  // These have DIFFERENT reply shapes — mixing them up silently breaks the turn.
  function handleRequest(message) {
    const method = message.method;
    const params = message.params || {};

    // AskUserQuestion: ZCode sends interaction/requestUserInput as a REQUEST
    // (with id). params.input.questions[] carries the options. Reply with
    // {decision:"allow", answers:{<question text>:<selected label>}}.
    if (method === 'interaction/requestUserInput') {
      handleUserInput(params, message.id);
      return;
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      handleProviderRuntimeHeaders(params, message.id);
      return;
    }
    if (method === 'elicitation/create') {
      handleElicitation(params, message.id);
      return;
    }
    if (method === 'permission.requested' || method === 'session/permission' || method === 'interaction/requestPermission') {
      handlePermissionRequest(params, message.id);
      return;
    }
    // Unknown requests: respond so the agent can proceed instead of hanging.
    if (rpc) rpc.respondError(message.id, -32601, 'Method not found: ' + method);
  }

  async function handleProviderRuntimeHeaders(params, rpcId) {
    try {
      const spawnEnv = currentEnv();
      const providerId = String(params.providerId || (params.modelRef && params.modelRef.providerId) || (activeRuntimeModel && activeRuntimeModel.model && activeRuntimeModel.model.providerId) || '').trim();
      const modelId = String((params.modelRef && params.modelRef.modelId) || (activeRuntimeModel && activeRuntimeModel.model && activeRuntimeModel.model.modelId) || '').trim();
      const modelRef = providerId && modelId ? providerId + '/' + modelId : currentModelRef(spawnEnv);
      const runtimeModel = activeRuntimeModel || currentRuntimeModel(spawnEnv, modelRef, thoughtLevelFromEffort());
      if (!providerId || !runtimeModel) throw new Error('ZCode runtime model is unavailable for OAuth header refresh.');
      if (isZcodePlanRuntimeModel(runtimeModel, providerId)) {
        if (rpcId && rpc) rpc.respond(rpcId, { headersApplied: false, errorMessage: zcodePlanRuntimeHeadersMessage() });
        return;
      }
      const accessToken = await readOAuthAccessToken({ env: spawnEnv, providerId, modelRef });
      if (!accessToken) throw new Error('ZCode desktop OAuth token is unavailable. Open ZCode, sign in again, then retry from the panel.');
      const apiKey = await resolveCodingPlanApiKey({ accessToken, providerId, env: spawnEnv });
      const refreshedRuntimeModel = runtimeModelWithApiKey(runtimeModel, apiKey);
      await rpc.request('session/updateRuntimeModelConfig', {
        sessionId: params.sessionId || sessionId,
        runtimeModel: refreshedRuntimeModel,
      }, RPC_TIMEOUT_MS);
      activeRuntimeModel = refreshedRuntimeModel;
      if (rpcId && rpc) rpc.respond(rpcId, { headersApplied: true, providerRevision: refreshedRuntimeModel.revision });
    } catch (e) {
      const message = zcodeErrorMessage(e, 'ZCode desktop OAuth header refresh failed.', lang);
      if (rpcId && rpc) rpc.respond(rpcId, { headersApplied: false, errorMessage: message });
    }
  }

  // AskUserQuestion via interaction/requestUserInput. params shape:
  //   { input: { questions: [{ question, header, options: [{label, description}],
  //                            multiSelect }] }, prompt, questions }
  // Reply: { decision: "allow", answers: { <question text>: <chosen label> } }
  function handleUserInput(params, rpcId) {
    const input = params.input || params;
    const questions = input.questions || [];
    const tier = getPermissionMode ? getPermissionMode() : 'manual';

    // No questions or non-interactive tier: auto-accept with first option.
    if (!questions.length || tier === 'none' || tier === 'auto') {
      const answers = {};
      for (const q of questions) {
        const opts = q.options || [];
        answers[q.question || q.header || 'question'] = opts.length ? opts[0].label : '';
      }
      if (rpcId && rpc) rpc.respond(rpcId, { decision: 'allow', answers });
      return;
    }

    // Surface the FIRST question as an approval card. The panel's ApprovalCard
    // renders input.choices; the user's selection returns via approve().
    const q = questions[0];
    const choices = (q.options || []).map((o) => o.label);
    const toolUseId = 'ask_' + rpcId;
    pendingUserInputs.set(toolUseId, { rpcId, questions });
    emit({
      type: 'approval-required',
      toolUseId,
      name: 'AskUserQuestion',
      input: {
        question: q.question || q.header || '',
        header: q.header,
        choices,
        fields: questions.map((qq) => qq.question || qq.header || ''),
      },
      risk: 'write',
    });
  }

  // AskUserQuestion: the agent presents a form. requestedSchema.properties maps
  // field names to option definitions (each with an enum of choices). We surface
  // this as an approval-required event so the panel's ApprovalCard renders the
  // question + options; the user's selection comes back via approve() and we
  // reply with {action:"accept", content:{field:choice}}.
  function handleElicitation(params, rpcId) {
    const message = params.message || '';
    const schema = params.requestedSchema || {};
    const props = schema.properties || {};
    const required = schema.required || [];

    // If there are no properties, this is a simple yes/no — auto-accept.
    const fieldNames = Object.keys(props);
    if (!fieldNames.length) {
      if (rpcId && rpc) rpc.respond(rpcId, { action: 'accept', content: {} });
      return;
    }

    // In non-interactive tiers (none/auto), auto-accept with the first option
    // of each field so the turn isn't blocked.
    const tier = getPermissionMode ? getPermissionMode() : 'manual';
    if (tier === 'none' || tier === 'auto') {
      const autoContent = {};
      for (const fn of fieldNames) {
        const opts = props[fn] && props[fn].enum;
        autoContent[fn] = opts && opts.length ? opts[0] : '';
      }
      if (rpcId && rpc) rpc.respond(rpcId, { action: 'accept', content: autoContent });
      return;
    }

    // Build a single approval card: the question text + the first field's
    // options as choices (ZCode AskUserQuestion typically has one field).
    const primaryField = fieldNames[0];
    const primaryProp = props[primaryField] || {};
    const choices = Array.isArray(primaryProp.enum) ? primaryProp.enum : [];
    const toolUseId = 'elicit_' + rpcId;
    pendingElicitations.set(toolUseId, { rpcId, fieldNames, props, required });
    emit({
      type: 'approval-required',
      toolUseId,
      name: 'AskUserQuestion',
      input: { question: message, field: primaryField, choices, fields: fieldNames },
      risk: 'write',
    });
  }

  function handleNotification(message) {
    const params = message.params || {};
    const type = params.type || message.method;

    // state.updated is the reliable turn-lifecycle signal: status flips to
    // "running" on prompt start and back to "idle" on completion. We use the
    // idle transition as a FALLBACK for finishActive() in case turn.completed
    // is missed — without it, the panel stays "executing" forever.
    if (type === 'state.updated') {
      const patch = params.patch || params.payload || {};
      if (patch.status === 'idle' && activeRun) {
        drainApprovals();
        emit({ type: 'turn-end', stopReason: 'end_turn' });
        transcript.push({ role: 'assistant', text: activeAssistantText });
        finishActive();
      }
      return;
    }

    if (type === 'turn.started') {
      emit({ type: 'turn-start' });
      return;
    }
    if (type === 'model.streaming') {
      const payload = params.payload || {};
      if (payload.kind === 'text_delta' && payload.delta) {
        activeAssistantText += String(payload.delta);
        emit({ type: 'text-delta', text: String(payload.delta) });
      }
      return;
    }
    if (type === 'tool.updated' || type === 'part.started' || type === 'part.upserted') {
      const payload = params.payload || {};
      if (payload.toolName || payload.tool) {
        // Heuristic: parts carrying a tool name signal a tool call boundary.
        emit({
          type: 'tool-start',
          toolUseId: String(payload.toolCallId || payload.id || ''),
          name: mcpToolName(payload.toolName || payload.tool),
          input: payload.input || payload.arguments,
        });
      }
      return;
    }
    if (type === 'permission.requested') {
      handlePermissionRequest(params, null);
      return;
    }
    if (type === 'turn.completed') {
      drainApprovals();
      const payload = params.payload || {};
      emit({ type: 'turn-end', stopReason: 'end_turn' });
      transcript.push({ role: 'assistant', text: activeAssistantText || payload.response || '' });
      finishActive();
      return;
    }
    if (type === 'turn.failed') {
      const payload = params.payload || {};
      const message = zcodePlanRuntimeFailureHint(zcodeErrorMessage(payload.error || payload.message, 'ZCode turn failed', lang), activeRuntimeModel);
      emit({ type: 'error', kind: zcodeErrorKind(message), message });
      finishActive();
      return;
    }
  }

  function handlePermissionRequest(params, rpcId) {
    const payload = params.payload || params;
    const toolUseId = String(payload.toolCallId || payload.requestId || rpcId || '');
    const name = mcpToolName(payload.toolName || payload.tool || '');
    const input = payload.input || payload.arguments || {};
    const riskLevel = payload.riskLevel || 'medium';
    const annotations = (toolMeta && toolMeta.annotations) || {};
    const ann = annotations[name] || {};
    const tier = getPermissionMode ? getPermissionMode() : 'manual';

    // rpcId comes from handleRequest (elicitation/permission as a request) or
    // from the requestId field in a permission.requested notification.
    const replyId = rpcId || payload.requestId || null;

    if (sessionAllowedTools.has(name) || ann.readOnly || tier === 'none' || (tier === 'auto' && !ann.destructive && riskLevel === 'low')) {
      if (replyId && rpc) rpc.respond(replyId, { decision: 'allow' });
      emit({ type: 'tool-allowed', toolUseId });
      return;
    }

    if (tier === 'readonly') {
      if (replyId && rpc) rpc.respond(replyId, { decision: 'decline' });
      emit({ type: 'tool-denied', toolUseId });
      return;
    }

    pendingApprovals.set(toolUseId, { rpcId: replyId, name, input });
    emit({
      type: 'approval-required',
      toolUseId,
      name,
      input,
      risk: ann.destructive ? 'destructive' : 'write',
    });
  }

  function handleExit(code, signal) {
    const wasStopping = stopping;
    const detail = stderrTail ? String(code) + (signal ? ' ' + signal : '') + ' ' + stderrTail : String(code) + (signal ? ' ' + signal : '');
    if (rpc) rpc.close(new Error('ZCode app-server exited: ' + detail));
    proc = null;
    rpc = null;
    startPromise = null;
    sessionPromise = null;
    sessionId = null;
    sessionModelRef = null;
    subscribed = false;
    if (wasStopping) return;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: 'ZCode app-server exited: ' + detail });
      finishActive();
    }
  }

  function handleError(error) {
    const err = error instanceof Error ? error : new Error('ZCode app-server error');
    if (rpc) rpc.close(err);
    proc = null;
    rpc = null;
    startPromise = null;
    sessionPromise = null;
    sessionId = null;
    sessionModelRef = null;
    subscribed = false;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: err.message });
      finishActive();
    }
  }

  async function startProcess() {
    if (proc && rpc) return true;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      // execFileImpl is resolved lazily so tests can inject resolveCli without
      // a CEP Node environment being present (getCepRequire would throw).
      let execFileImpl = null;
      try { execFileImpl = getCepRequire()('child_process').execFile; } catch (e) { /* non-CEP env */ }
      const cli = await resolveCli({ env: currentEnv(), execFileImpl });
      if (!cli.ok) throw new Error(cli.detail);

      const spawn = getSpawn();
      const spawnEnv = currentEnv();
      stderrTail = '';
      stopping = false;

      let cmd;
      let cmdArgs;
      if (cli.isExe) {
        // A real `zcode` executable on PATH.
        cmd = cli.cliPath;
        cmdArgs = ['app-server'];
      } else {
        // zcode.cjs — spawn via system Node (matches the claudeAgentBackend pattern).
        const node = await resolveNode({ env: spawnEnv });
        if (!node.ok) throw new Error(node.detail);
        cmd = node.nodePath;
        cmdArgs = [cli.cliPath, 'app-server'];
      }

      proc = spawn(cmd, cmdArgs, {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      });
      rpc = createRpc({
        writeLine: (line) => proc.stdin.write(line),
        onNotification: handleNotification,
        onRequest: handleRequest,
      });
      const reader = createNdjsonReader((message) => rpc && rpc.handleMessage(message));
      if (proc.stdout && proc.stdout.on) proc.stdout.on('data', reader);
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', (chunk) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      proc.on('exit', (code, signal) => handleExit(code, signal));
      proc.on('error', (error) => handleError(error));
      return true;
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function workspaceFromEnv(spawnEnv) {
    // ZCode keys sessions by workspace; derive from the panel extension root.
    const extRoot = spawnEnv && (spawnEnv.AE_MCP_PANEL_EXT_ROOT || spawnEnv.EXTENSION_ROOT);
    const path = extRoot ? String(extRoot).replace(/\//g, '\\').replace(/\\+$/, '') : (spawnEnv && (spawnEnv.TEMP || spawnEnv.TMP) || '.');
    const key = path.replace(/\\/g, '\\');
    return { workspacePath: path, workspaceKey: key };
  }

  function modeFromTier() {
    const tier = getPermissionMode ? getPermissionMode() : 'manual';
    return MODE_BY_TIER[tier] || 'build';
  }

  // ZCode thoughtLevel support varies by bundled provider; accept the current
  // GLM values while keeping older app-server values valid for existing users.
  function thoughtLevelFromEffort() {
    const effort = getEffort ? getEffort() : null;
    if (!effort) return undefined;
    return ZCODE_THOUGHT_LEVELS.has(effort) ? effort : undefined;
  }

  async function ensureSession() {
    // If a session already exists but the caller's preferred model has
    // changed since that session was created (e.g. the user flipped
    // "默认模型" in Settings), invalidate it here so the next call below
    // establishes a fresh session/create bound to the new model. Kept inside
    // ensureSession (rather than requiring App.jsx to call reset()/stop()
    // explicitly) so this is robust regardless of call site.
    if (sessionId && !sessionPromise) {
      const desiredModelRef = currentModelRef(currentEnv());
      if (desiredModelRef && sessionModelRef && desiredModelRef !== sessionModelRef) {
        if (rpc && sessionId) {
          try { rpc.fireRequest('session/stop', { sessionId }); } catch (e) { /* best effort */ }
        }
        sessionId = null;
        sessionModelRef = null;
        subscribed = false;
      }
    }
    if (sessionId) return sessionId;
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      await startProcess();
      toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
      const spawnEnv = currentEnv();
      const createParams = {
        workspace: workspaceFromEnv(spawnEnv),
        mode: modeFromTier(),
      };
      const thoughtLevel = thoughtLevelFromEffort();
      const modelRef = currentModelRef(spawnEnv);
      const runtimeModel = currentRuntimeModel(spawnEnv, modelRef, thoughtLevel);
      if (runtimeModel) createParams.runtimeModel = runtimeModel;
      activeRuntimeModel = runtimeModel || null;
      const model = (runtimeModel && runtimeModel.model) || zcodeProtocolModelFromRef(modelRef);
      if (model) createParams.model = model;
      if (thoughtLevel) createParams.thoughtLevel = thoughtLevel;

      // Inject the ae MCP server into the session. ZCode app-server does NOT
      // auto-load mcp.servers from ~/.zcode/cli/config.json (that file is for
      // the CLI TUI); session/create accepts mcpServers on its input params
      // and each server env value is encoded as a {name, value} entry.
      if (getMcpSpec) {
        const spec = await getMcpSpec();
        if (spec && spec.command) {
          const envObj = Object.assign({}, spec.env || {}, {
            AE_MCP_BACKEND: 'ae-mcp',
            ...expertGuidanceEnv(getExpertGuidance()),
          });
          createParams.mcpServers = [{
            name: 'ae',
            command: spec.command,
            args: spec.args || [],
            env: Object.entries(envObj).map(([name, value]) => ({ name, value: String(value) })),
          }];
        }
      }

      const result = await rpc.request('session/create', createParams);
      const nextSessionId = (result && result.session && result.session.sessionId) || null;
      if (!nextSessionId) throw new Error('ZCode session/create returned no sessionId');

      // Surface the raw session/create result so the panel can build a live
      // model-chip descriptor from settings.model.available (see
      // zcodeDescriptorFromModels in lib/backendCapabilities.js). Without this
      // the composer's model chip has no data and disappears entirely.
      emit({ type: 'zcode-session-created', result: result });

      // Subscribe to the event stream. desktop-continuous streams turn events
      // as notifications for the life of the subscription. Use request() (not
      // fireRequest) so we wait for the ack and know the subscription is live
      // before sending the first turn — otherwise early events can be missed.
      if (!subscribed) {
        await rpc.request('session/subscribe', { sessionId: nextSessionId, deliveryKind: DELIVERY_KIND }, 10000);
        subscribed = true;
      }
      sessionId = nextSessionId;
      sessionModelRef = modelRef;
      return sessionId;
    })();
    try {
      return await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;
    activeAssistantText = '';
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });

    try {
      await ensureSession();
      const userText = String(text || '');
      transcript.push({ role: 'user', text: userText });

      // ZCode (like Codex) does not forward the ae-mcp server instructions to
      // the model, so prepend them as a one-shot preamble on the first turn.
      let turnText = userText;
      if (transcript.filter((m) => m.role === 'user').length === 1) {
        const instr = (getServerInstructions() || '').trim();
        if (instr) turnText = instr + '\n\n---\n\n' + userText;
      }

      // session/send resolves on acceptance, long before turn.completed.
      rpc.request('session/send', { sessionId, content: turnText }, 180000).catch((e) => {
        const message = zcodeErrorMessage(e, 'Failed to start ZCode turn.', lang);
        emit({ type: 'error', kind: zcodeErrorKind(message), message });
        finishActive();
      });
    } catch (e) {
      const message = zcodeErrorMessage(e, 'Failed to start ZCode turn.', lang);
      emit({ type: 'error', kind: zcodeErrorKind(message), message });
      finishActive();
    }
    return activeRun;
  }

  function approve(toolUseId, decision) {
    const id = String(toolUseId);

    // AskUserQuestion via interaction/requestUserInput: reply {decision, answers}.
    const userInput = pendingUserInputs.get(id);
    if (userInput) {
      pendingUserInputs.delete(id);
      if (decision === 'deny') {
        if (userInput.rpcId && rpc) rpc.respond(userInput.rpcId, { decision: 'decline', answers: {} });
        emit({ type: 'tool-denied', toolUseId: id });
      } else {
        // decision carries the chosen label; map it to each question.
        const answers = {};
        const chosen = typeof decision === 'string' && decision !== 'allow' && decision !== 'allow-session' ? decision : '';
        for (const q of userInput.questions) {
          const key = q.question || q.header || 'question';
          answers[key] = chosen || (q.options && q.options[0] && q.options[0].label) || '';
        }
        if (userInput.rpcId && rpc) rpc.respond(userInput.rpcId, { decision: 'allow', answers });
        emit({ type: 'tool-allowed', toolUseId: id });
      }
      return;
    }

    // Elicitation (AskUserQuestion) reply: {action, content}. The "decision"
    // from the panel carries the user's selected choice text.
    const elicit = pendingElicitations.get(id);
    if (elicit) {
      pendingElicitations.delete(id);
      if (decision === 'deny') {
        if (elicit.rpcId && rpc) rpc.respond(elicit.rpcId, { action: 'decline' });
        emit({ type: 'tool-denied', toolUseId: id });
      } else {
        // Build content from the chosen value; for single-field elicitation,
        // the decision string IS the chosen option.
        const content = {};
        const fn = elicit.fieldNames[0];
        content[fn] = typeof decision === 'string' && decision !== 'allow' && decision !== 'allow-session'
          ? decision
          : (elicit.props[fn] && elicit.props[fn].enum && elicit.props[fn].enum[0]) || '';
        if (elicit.rpcId && rpc) rpc.respond(elicit.rpcId, { action: 'accept', content });
        emit({ type: 'tool-allowed', toolUseId: id });
      }
      return;
    }

    // Permission (tool approval) reply: {decision}.
    const approval = pendingApprovals.get(id);
    if (!approval) return;
    pendingApprovals.delete(id);
    const allow = decision !== 'deny';
    if (allow && decision === 'allow-session') sessionAllowedTools.add(approval.name);
    if (approval.rpcId && rpc) rpc.respond(approval.rpcId, { decision: allow ? 'allow' : 'decline' });
    emit({ type: allow ? 'tool-allowed' : 'tool-denied', toolUseId: id });
  }

  function stop() {
    if (rpc && sessionId) {
      rpc.fireRequest('session/stop', { sessionId });
    }
    drainApprovals();
    if (activeRun) {
      emit({ type: 'error', kind: 'aborted', message: 'Turn aborted.' });
      finishActive();
    }
  }

  function reset() {
    stopping = true;
    drainApprovals();
    if (rpc) rpc.close(new Error('ZCode backend reset'));
    if (proc) {
      try { proc.kill(); } catch (e) { /* best effort */ }
    }
    proc = null;
    rpc = null;
    startPromise = null;
    sessionPromise = null;
    sessionId = null;
    sessionModelRef = null;
    subscribed = false;
    activeRuntimeModel = null;
    transcript = [];
    pendingApprovals.clear();
    pendingElicitations.clear();
    pendingUserInputs.clear();
    sessionAllowedTools.clear();
    toolMeta = { allowedTools: [], annotations: {} };
    finishActive();
    stderrTail = '';
    stopping = false;
  }

  // Per-turn thoughtLevel change (composer "thinking" chip). session/send does
  // not accept thoughtLevel, so a mid-conversation switch uses the dedicated
  // session/setThoughtLevel method (params: {sessionId, thoughtLevel, ...}).
  async function setThoughtLevel(level) {
    if (!sessionId || !rpc) return false;
    if (!ZCODE_THOUGHT_LEVELS.has(level)) return false;
    try {
      await rpc.request('session/setThoughtLevel', { sessionId, thoughtLevel: level });
      return true;
    } catch (e) {
      return false;
    }
  }

  // This probe validates the embedded app-server plumbing. Desktop OAuth plan
  // providers can still fail later when the first model request asks the host
  // for captcha/runtime headers.
  async function probeAccount() {
    try {
      await ensureSession();
      return { loggedIn: true, runtimeOk: true, provider: 'zcode' };
    } catch (e) {
      // Surface the real reason (CLI not found, Node missing, etc.) as a
      // runtime failure rather than a login failure.
      return {
        loggedIn: true,
        runtimeOk: false,
        provider: 'zcode',
        detail: zcodeErrorMessage(e, 'ZCode runtime unavailable.', lang),
      };
    }
  }

  return {
    sendUser,
    approve,
    stop,
    reset,
    setThoughtLevel,
    getMessages: () => clone(transcript),
    probeAccount,
  };
}
