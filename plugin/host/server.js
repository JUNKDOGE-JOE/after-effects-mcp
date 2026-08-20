// HTTP server for the ae-mcp CEP plugin. Exposes /health and /exec.
// CEP 11 (AE 2023/2024) runtime polyfills MUST load before any other host
// module — see cep-runtime-compat.js and cep-runtime-contract.test.js.
require('./cep-runtime-compat');
const path = require('path');
const jsxBridge = require('./jsx-bridge');
const authToken = require('./auth-token');
const activity = require('./activity');
const hostLog = require('./host-log');
const nativeAegp = require('./native-aegp-client');
const mountMcp = require('./mcp');
const { createClientBlocklist } = require('./mcp/client-blocklist');
const PKG_VERSION = require('./package.json').version;

let app = null;
let httpServer = null;
let currentPort = null;
let runtimeDependencies = null;
// The shared secret /exec requires. Populated in start() so the file is read
// (and generated if missing) exactly once per host lifetime.
let execToken = null;
let paused = false;
let nativeAegpClient = null;
let nativeAegpClientFactory = null;
let nativeAegpRuntime = null;
let restoreHostConsole = null;
let unsubscribeHostActivity = null;
const clients = new Map();
const blocked = new Set();
let clientBlocklist = null;
// Self-reported label of the panel's own diagnostic /exec probes. Must match
// the x-ae-mcp-client header in plugin/panel/src/cep/diagnostics.js.
const INTERNAL_CLIENT = 'panel-diagnostics/internal';
const NATIVE_MAX_REQUEST_WINDOW_MS = 30000;
const NATIVE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function setRuntimeDependencies(dependencies) {
    if (!dependencies || typeof dependencies.express !== 'function') {
        throw new TypeError('runtime dependencies require an Express factory');
    }
    runtimeDependencies = Object.freeze({ express: dependencies.express });
}

function expressFactory() {
    if (runtimeDependencies) return runtimeDependencies.express;
    const error = new Error('host runtime dependencies were not bound');
    error.code = 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE';
    throw error;
}

function setPaused(v) {
    paused = !!v;
}

function isPaused() {
    return paused;
}

function touchClient(label) {
    const key = String(label || 'unknown');
    const lastSeen = Date.now();
    clients.set(key, { lastSeen: lastSeen });
    return { label: key, lastSeen: lastSeen, blocked: blocked.has(key) };
}

function ensureClientBlocklist() {
    if (clientBlocklist) return clientBlocklist;
    clientBlocklist = createClientBlocklist({
        logger: function (event) { hostLog.record(event); },
    });
    blocked.clear();
    clientBlocklist.list().forEach(function (name) { blocked.add(name); });
    return clientBlocklist;
}

function isClientBlocked(label) {
    const key = String(label || '').trim();
    if (!key) return false;
    return blocked.has(key) || ensureClientBlocklist().has(key);
}

function getClients() {
    ensureClientBlocklist();
    const labels = new Set(Array.from(clients.keys()).concat(Array.from(blocked.keys())));
    return Array.from(labels).map((label) => {
        const item = clients.get(label) || {};
        return { label: label, lastSeen: item.lastSeen || null, blocked: blocked.has(label) };
    }).sort((a, b) => {
        if ((b.lastSeen || 0) !== (a.lastSeen || 0)) return (b.lastSeen || 0) - (a.lastSeen || 0);
        return a.label.localeCompare(b.label);
    });
}

function setClientBlocked(label, v) {
    const key = String(label || 'unknown');
    if (v) blocked.add(key);
    else blocked.delete(key);
    ensureClientBlocklist().set(key, !!v);
}

function getMcpSessions() {
    const mounted = module.exports.mcp;
    if (!mounted || !mounted.sessions || typeof mounted.sessions.list !== 'function') return [];
    return mounted.sessions.list().map(function (session) {
        return Object.assign({}, session, {
            blocked: isClientBlocked(session.clientInfo && session.clientInfo.name),
        });
    });
}

function getConnectionInfo() {
    const lastClientSeenAt = getClients().reduce((max, c) => Math.max(max, c.lastSeen || 0), 0) || null;
    return {
        port: currentPort,
        hostVersion: PKG_VERSION,
        lastClientSeenAt: lastClientSeenAt,
    };
}

function regenerateToken(cb) {
    try {
        const token = authToken.regenerate();
        execToken = token;
        if (cb) cb(null, token);
        return token;
    } catch (e) {
        if (cb) cb(e);
        else throw e;
        return null;
    }
}

function makeNativeAegpClient() {
    if (nativeAegpClient) return nativeAegpClient;
    const factory = nativeAegpClientFactory || nativeAegp.createNativeAegpClient;
    nativeAegpClient = factory({
        version: PKG_VERSION,
        component: 'core-broker',
        runtime: nativeAegpRuntime,
    });
    if (!nativeAegpClient
        || typeof nativeAegpClient.connect !== 'function'
        || typeof nativeAegpClient.negotiate !== 'function'
        || typeof nativeAegpClient.capabilities !== 'function'
        || typeof nativeAegpClient.invoke !== 'function'
        || typeof nativeAegpClient.cancel !== 'function'
        || typeof nativeAegpClient.invalidateProjectGraph !== 'function'
        || typeof nativeAegpClient.status !== 'function'
        || typeof nativeAegpClient.close !== 'function') {
        nativeAegpClient = null;
        const error = new Error('native AEGP client factory returned an invalid client');
        error.code = 'NATIVE_UNAVAILABLE';
        error.retryable = true;
        throw error;
    }
    return nativeAegpClient;
}

async function invalidateConnectedNativeProjectGraph(deadlineUnixMs) {
    const client = nativeAegpClient;
    if (!client || client.status()?.state !== 'connected') return;
    await client.invalidateProjectGraph({ deadlineUnixMs });
}

function closeNativeAegpClient() {
    const client = nativeAegpClient;
    nativeAegpClient = null;
    if (!client) return;
    try { Promise.resolve(client.close()).catch(() => {}); } catch (_) {}
}

function setNativeAegpRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
        || !['darwin', 'win32'].includes(runtime.platform)
        || !['arm64', 'x64'].includes(runtime.arch)) {
        throw new TypeError('native AEGP runtime is invalid');
    }
    if (nativeAegpRuntime
        && (nativeAegpRuntime.platform !== runtime.platform || nativeAegpRuntime.arch !== runtime.arch)) {
        closeNativeAegpClient();
    }
    nativeAegpRuntime = Object.freeze({ platform: runtime.platform, arch: runtime.arch });
}

function nativeErrorPayload(error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
        ? error.code : 'NATIVE_UNAVAILABLE';
    const policies = {
        NATIVE_UNAVAILABLE: [true, 'not-started', 'reconnect'],
        NATIVE_UNSUPPORTED: [false, 'not-started', 'refresh-capabilities'],
        NATIVE_CONTRACT_MISMATCH: [false, 'not-started', 'refresh-capabilities'],
        WIRE_VERSION_MISMATCH: [false, 'not-started', 'reconnect'],
        INVALID_REQUEST: [false, 'not-started', 'none'],
        INVALID_ARGUMENT: [false, 'not-started', 'change-arguments'],
        TRACK_MATTE_COMPOSITION_MISMATCH: [false, 'not-started', 'change-arguments'],
        LAYER_HAS_NO_AUDIO: [false, 'not-started', 'change-arguments'],
        LAYER_HAS_NO_VIDEO: [false, 'not-started', 'change-arguments'],
        DUPLICATE_REQUEST: [false, 'not-started', 'inspect-state'],
        PRECONDITION_FAILED: [false, 'not-started', 'open-project'],
        STALE_LOCATOR: [true, 'not-started', 'refresh-locator'],
        DEADLINE_EXCEEDED: [true, 'not-started', 'retry'],
        CANCELLED: [false, 'not-started', 'none'],
        QUEUE_FULL: [true, 'not-started', 'retry'],
        AE_SHUTTING_DOWN: [true, 'not-started', 'reconnect'],
        SESSION_STALE: [true, 'not-started', 'reconnect'],
        CAPABILITY_FAILED: [false, 'not-started', 'inspect-state'],
        POSSIBLY_SIDE_EFFECTING_FAILURE: [false, 'may-have-occurred', 'inspect-state'],
    };
    const policy = policies[code] || policies.NATIVE_UNAVAILABLE;
    const fixedContractMismatch = code === 'NATIVE_CONTRACT_MISMATCH';
    const recovery = !fixedContractMismatch
        && error?.recovery && typeof error.recovery === 'object'
        ? { ...error.recovery }
        : {
            action: policy[2],
            hint: fixedContractMismatch
                ? 'Refresh the authenticated native contract before retrying.'
                : 'Follow the recovery action before retrying the native request.',
        };
    const payload = {
        code,
        message: typeof error?.message === 'string' && error.message.length > 0
            ? error.message : 'Native AEGP request failed with ' + code + '.',
        retryable: fixedContractMismatch
            ? false : typeof error?.retryable === 'boolean' ? error.retryable : policy[0],
        sideEffect: fixedContractMismatch
            ? 'not-started' : typeof error?.sideEffect === 'string' ? error.sideEffect : policy[1],
        recovery,
    };
    if (error?.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
        payload.details = { ...error.details };
    }
    return payload;
}

function exactBody(value, required, optional) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(required.concat(optional || []));
    return required.every(function (key) { return Object.hasOwn(value, key); })
        && Object.keys(value).every(function (key) { return allowed.has(key); });
}

function validDeadline(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function validNativeInvokeBody(body) {
    return nativeAegp.validNativeInvokeRequest(body);
}

function validNativeCancelBody(body) {
    return exactBody(body, [
        'requestId',
        'targetRequestId',
        'deadlineUnixMs',
    ])
        && typeof body.requestId === 'string'
        && NATIVE_REQUEST_ID_PATTERN.test(body.requestId)
        && typeof body.targetRequestId === 'string'
        && NATIVE_REQUEST_ID_PATTERN.test(body.targetRequestId)
        && body.requestId !== body.targetRequestId
        && validDeadline(body.deadlineUnixMs);
}

function nativeGateError(code, message, retryable, action, hint) {
    return {
        code,
        message,
        retryable,
        sideEffect: 'not-started',
        recovery: { action, hint },
    };
}

function nativeRequestGate(req, res) {
    const provided = req.get(authToken.HEADER);
    if (!authToken.tokenMatches(provided, execToken)) {
        res.status(401).json({
            ok: false,
            error: nativeGateError(
                'UNAUTHORIZED', 'unauthorized', false, 'reconnect',
                'Reload the shared loopback token before reconnecting.',
            ),
        });
        return null;
    }
    const client = req.get('x-ae-mcp-client') || 'unknown';
    if (client !== INTERNAL_CLIENT) touchClient(client);
    if (blocked.has(client)) {
        activity.record({ client, engine: 'native-aegp', ok: false, denied: 'blocked' });
        res.status(403).json({
            ok: false,
            error: nativeGateError(
                'CLIENT_BLOCKED', 'this client is blocked in the panel', false, 'none',
                'A user must unblock this client in the panel before another request.',
            ),
        });
        return null;
    }
    if (paused) {
        activity.record({ client, engine: 'native-aegp', ok: false, denied: 'paused' });
        res.status(503).json({
            ok: false,
            error: nativeGateError(
                'ACTIONS_PAUSED', 'AI actions are paused in the panel', true, 'retry',
                'Resume AI actions in the panel before retrying.',
            ),
        });
        return null;
    }
    return client;
}

async function connectedNativeClient(deadlineUnixMs) {
    const client = makeNativeAegpClient();
    const status = client.status();
    if (status.state === 'connected') return client;
    await client.connect(deadlineUnixMs);
    return client;
}

function sendNativeFailure(res, error) {
    const payload = nativeErrorPayload(error);
    const status = payload.code === 'INVALID_ARGUMENT' ? 400 : 503;
    const response = { ok: false, error: payload };
    res.status(status).json(response);
}

// Wrap user JSX in app.beginUndoGroup / app.endUndoGroup.
//
// Multi-statement user code is evaluated via ExtendScript's `eval()` so that
// every statement runs and the value of the last expression is returned to
// CSInterface — same semantics as the no-undoGroup path where `code` is
// passed to evalScript directly.
//
// The earlier `try { return <code>; }` shape silently dropped everything past
// the first statement: `return var x = 1; ...` is invalid as a `return`
// expression, so for multi-statement scripts the wrapper executed only
// `app.beginUndoGroup(...)` (returning undefined) and skipped the rest.
function wrapWithUndoGroup(code, undoGroup) {
    return (
        '(function(){' +
        'app.beginUndoGroup(' + JSON.stringify(undoGroup) + ');' +
        'try { return eval(' + JSON.stringify(code) + '); }' +
        'finally { app.endUndoGroup(); }' +
        '})()'
    );
}

function quoteAsciiJsString(value) {
    const s = String(value);
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        switch (c) {
            case 8: out += '\\b'; break;
            case 9: out += '\\t'; break;
            case 10: out += '\\n'; break;
            case 12: out += '\\f'; break;
            case 13: out += '\\r'; break;
            case 34: out += '\\"'; break;
            case 92: out += '\\\\'; break;
            default:
                if (c < 32 || c > 126) {
                    out += '\\u' + ('0000' + c.toString(16)).slice(-4);
                } else {
                    out += s.charAt(i);
                }
        }
    }
    return out + '"';
}

// CEP can corrupt non-ASCII result text when CSInterface.evalScript crosses
// the ExtendScript -> panel boundary on localized Windows installs. Return an
// ASCII-only JSON envelope from JSX, then decode it in Node before HTTP JSON.
function wrapForEvalScriptTransport(code) {
    return (
        '(function(){' +
        'function __aemcp_quote(v){' +
        'var s=String(v),out="\\"";' +
        'for(var i=0;i<s.length;i++){' +
        'var c=s.charCodeAt(i);' +
        'if(c===8){out+="\\\\b";}' +
        'else if(c===9){out+="\\\\t";}' +
        'else if(c===10){out+="\\\\n";}' +
        'else if(c===12){out+="\\\\f";}' +
        'else if(c===13){out+="\\\\r";}' +
        'else if(c===34){out+="\\\\\\"";}' +
        'else if(c===92){out+="\\\\\\\\";}' +
        'else if(c<32||c>126){out+="\\\\u"+("0000"+c.toString(16)).slice(-4);}' +
        'else{out+=s.charAt(i);}' +
        '}' +
        'return out+"\\"";' +
        '}' +
        'try{' +
        'var __aemcp_value=eval(' + quoteAsciiJsString(code) + ');' +
        'return "{\\"ok\\":true,\\"result\\":"+__aemcp_quote(__aemcp_value)+"}";' +
        '}catch(e){' +
        'var __aemcp_detail=String(e);' +
        'if(e&&e.line){__aemcp_detail+=" (line "+e.line+")";}' +
        'return "{\\"ok\\":false,\\"error\\":"+__aemcp_quote(__aemcp_detail)+"}";' +
        '}' +
        '})()'
    );
}

function decodeEvalScriptTransportResult(text) {
    let payload = null;
    if (String(text || '').trim() === '') {
        throw new Error('evalScript returned no output (ExtendScript engine did not run the transport envelope)');
    }
    try {
        payload = JSON.parse(String(text));
    } catch (e) {
        throw new Error('invalid evalScript transport envelope: ' + String(text || '').slice(0, 120));
    }
    if (payload && payload.ok === false && typeof payload.error === 'string') {
        // The envelope ran to completion and reported a definite ExtendScript
        // error: the script executed, so this is `failed`, not `uncertain`
        // (#260 real-machine check). Undecodable / empty output stays untagged
        // and is classified as uncertain by the caller.
        const error = new Error('ExtendScript error: ' + payload.error);
        error.disposition = 'failed';
        throw error;
    }
    if (!payload || payload.ok !== true || typeof payload.result !== 'string') {
        throw new Error('invalid evalScript transport envelope shape');
    }
    return payload.result;
}

// Shared /exec and MCP ae_exec execution path. The HTTP route keeps its
// existing response shape; MCP maps this internal result into a tool result.
async function executeJsx(request) {
    const input = request || {};
    const code = input.code;
    const undoGroup = input.undoGroup;
    const nativeProjectGraphEffect = input.nativeProjectGraphEffect === undefined
        ? 'invalidate' : input.nativeProjectGraphEffect;
    const client = input.client || 'unknown';
    if (client !== INTERNAL_CLIENT) touchClient(client);
    if (blocked.has(client)) {
        activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'blocked' });
        return { status: 403, payload: { ok: false, error: 'blocked: this client is blocked in the panel' } };
    }
    if (paused) {
        activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'paused' });
        return { status: 503, payload: { ok: false, error: 'paused: AI actions are blocked by the panel kill switch' } };
    }
    if (typeof code !== 'string' || code.length === 0) {
        activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'invalid_request' });
        return { status: 400, payload: { ok: false, error: 'missing or empty `code`' } };
    }
    if (!['invalidate', 'preserve'].includes(nativeProjectGraphEffect)) {
        activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'invalid_request' });
        return {
            status: 400,
            payload: { ok: false, error: '`nativeProjectGraphEffect` must be invalidate or preserve' },
        };
    }
    const t = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 30000;
    const wrapped = undoGroup ? wrapWithUndoGroup(code, undoGroup) : code;
    const transported = wrapForEvalScriptTransport(wrapped);
    const startedAt = Date.now();
    let dispatched = false;
    try {
        const invalidationDeadlineUnixMs = Math.min(
            Number.MAX_SAFE_INTEGER,
            startedAt + Math.min(Math.ceil(t), NATIVE_MAX_REQUEST_WINDOW_MS),
        );
        if (nativeProjectGraphEffect === 'invalidate') {
            await invalidateConnectedNativeProjectGraph(invalidationDeadlineUnixMs);
        }
        dispatched = true;
        const encoded = await jsxBridge.evalScript(transported, t);
        const result = decodeEvalScriptTransportResult(encoded);
        activity.record({
            client,
            undoGroup: undoGroup || null,
            ok: true,
            durationMs: Date.now() - startedAt,
            ...(result === '' ? { emptyResult: true } : {}),
        });
        return { status: 200, payload: { ok: true, result: result || '' } };
    } catch (e) {
        // Closed three-value disposition (#260): the bridge tags its own
        // rejections; anything untagged is classified by whether the script
        // had been handed to the bridge yet.
        const disposition = ['not_dispatched', 'uncertain', 'failed'].includes(e.disposition)
            ? e.disposition
            : (dispatched ? 'uncertain' : 'not_dispatched');
        const bridgeState = jsxBridge.getState();
        activity.record({
            client,
            undoGroup: undoGroup || null,
            ok: false,
            error: e.message,
            disposition,
            durationMs: Date.now() - startedAt,
        });
        return {
            status: 200,
            payload: {
                ok: false,
                error: e.message,
                disposition,
                jsxBridge: bridgeState,
            },
            disposition,
        };
    }
}

function buildApp() {
    const express = expressFactory();
    ensureClientBlocklist();
    const a = express();
    a.use(express.json({ limit: '5mb' }));
    async function nativeNegotiate(deadlineUnixMs) {
        const client = await connectedNativeClient(deadlineUnixMs);
        const hello = await client.negotiate({ deadlineUnixMs });
        return {
            selectedWireVersion: hello.selectedWireVersion,
            pluginVersion: hello.pluginVersion,
            compiledSdkVersion: hello.compiledSdk.version,
            sourceCommit: hello.sourceCommit,
            hostInstanceId: hello.host.instanceId,
            hostPlatform: hello.host.platform,
            sessionId: hello.sessionId,
            sessionGeneration: hello.sessionGeneration,
            capabilitiesDigest: hello.capabilitiesDigest,
        };
    }
    async function nativeInvoke(body) {
        const client = await connectedNativeClient(body.deadlineUnixMs);
        return client.invoke(body);
    }
    const getStatus = function (requestPort) {
        return {
            ok: true,
            pluginVersion: PKG_VERSION,
            port: currentPort || requestPort || null,
            jsxBridge: typeof jsxBridge.getState === 'function' ? jsxBridge.getState() : null,
            paused: isPaused(),
            clients: getClients(),
            nativeExecutionPlane: (function () {
                try {
                    const nativeStatus = makeNativeAegpClient().status();
                    return nativeStatus && nativeStatus.state === 'connected'
                        ? { available: true, adapter: 'native-aegp', engine: 'native-aegp' }
                        : { available: false, adapter: null, engine: null };
                } catch (_) {
                    return { available: false, adapter: null, engine: null };
                }
            }()),
        };
    };
    // mcp/index.js currently forwards getStatus while its dependency object is
    // being shared with the panel work. Keep a private fallback there until
    // that owner forwards the two explicit native fields directly.
    getStatus.nativeNegotiate = nativeNegotiate;
    getStatus.nativeInvoke = nativeInvoke;
    module.exports.mcp = mountMcp(a, {
        version: PKG_VERSION,
        getStatus,
        executeJsx,
        nativeNegotiate,
        nativeInvoke,
        hostLog,
        getNativeStatus: function () { return makeNativeAegpClient().status(); },
        getClients,
        touchClient,
        isClientBlocked,
        isPaused,
        recordMcpActivity: function (event) { activity.record(event); },
    });

    a.get('/health', (req, res) => {
        // Presence of CSInterface (set up by the panel at startup) is the
        // readiness proxy. /exec is what actually probes AE.
        res.json({
            ok: true,
            pluginVersion: PKG_VERSION,
            port: currentPort,
            jsxBridge: jsxBridge.getState(),
        });
    });

    a.get('/activity', (req, res) => {
        const provided = req.get(authToken.HEADER);
        if (!authToken.tokenMatches(provided, execToken)) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
        const since = parseInt(req.query.since, 10);
        res.json({ ok: true, events: activity.list(Number.isFinite(since) ? since : 0) });
    });

    a.get('/native/status', (req, res) => {
        if (nativeRequestGate(req, res) === null) return;
        try {
            const status = makeNativeAegpClient().status();
            res.json({ ok: true, status });
        } catch (error) {
            sendNativeFailure(res, error);
        }
    });

    a.post('/native/negotiate', async (req, res) => {
        const clientLabel = nativeRequestGate(req, res);
        if (clientLabel === null) return;
        const body = req.body || {};
        if (!exactBody(body, ['deadlineUnixMs']) || !validDeadline(body.deadlineUnixMs)) {
            return res.status(400).json({
                ok: false,
                error: nativeErrorPayload(Object.assign(
                    new Error('native negotiation parameters are invalid'),
                    { code: 'INVALID_ARGUMENT', retryable: false },
                )),
            });
        }
        const startedAt = Date.now();
        try {
            const client = await connectedNativeClient(body.deadlineUnixMs);
            const hello = await client.negotiate({ deadlineUnixMs: body.deadlineUnixMs });
            const result = {
                selectedWireVersion: hello.selectedWireVersion,
                pluginVersion: hello.pluginVersion,
                compiledSdkVersion: hello.compiledSdk.version,
                sourceCommit: hello.sourceCommit,
                hostInstanceId: hello.host.instanceId,
                hostPlatform: hello.host.platform,
                sessionId: hello.sessionId,
                sessionGeneration: hello.sessionGeneration,
                capabilitiesDigest: hello.capabilitiesDigest,
            };
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'negotiate',
                ok: true,
                hostInstanceId: result.hostInstanceId,
                sessionGeneration: result.sessionGeneration,
                durationMs: Date.now() - startedAt,
            });
            res.json({ ok: true, result });
        } catch (error) {
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'negotiate',
                ok: false,
                error: nativeErrorPayload(error).code,
                durationMs: Date.now() - startedAt,
            });
            sendNativeFailure(res, error);
        }
    });

    a.post('/native/capabilities', async (req, res) => {
        const clientLabel = nativeRequestGate(req, res);
        if (clientLabel === null) return;
        const body = req.body || {};
        const validIds = !Object.hasOwn(body, 'ids')
            || (Array.isArray(body.ids) && body.ids.length >= 1 && body.ids.length <= 32
                && body.ids.every(function (id) { return typeof id === 'string' && id.length > 0; })
                && new Set(body.ids).size === body.ids.length);
        if (!exactBody(body, ['detail', 'limit', 'deadlineUnixMs'], ['ids'])
            || body.detail !== 'full'
            || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100
            || !validDeadline(body.deadlineUnixMs) || !validIds) {
            return res.status(400).json({
                ok: false,
                error: nativeErrorPayload(Object.assign(
                    new Error('native capabilities parameters are invalid'),
                    { code: 'INVALID_ARGUMENT', retryable: false },
                )),
            });
        }
        const startedAt = Date.now();
        try {
            const client = await connectedNativeClient(body.deadlineUnixMs);
            const query = {
                detail: body.detail,
                limit: body.limit,
                deadlineUnixMs: body.deadlineUnixMs,
            };
            // ids=None is represented by omission across both HTTP and UDS.
            if (Object.hasOwn(body, 'ids')) query.ids = body.ids;
            const nativeResult = await client.capabilities(query);
            const result = { sessionId: client.status().sessionId, ...nativeResult };
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'capabilities',
                ok: true,
                itemCount: result.items.length,
                durationMs: Date.now() - startedAt,
            });
            res.json({ ok: true, result });
        } catch (error) {
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'capabilities',
                ok: false,
                error: nativeErrorPayload(error).code,
                durationMs: Date.now() - startedAt,
            });
            sendNativeFailure(res, error);
        }
    });

    a.post('/native/invoke', async (req, res) => {
        const clientLabel = nativeRequestGate(req, res);
        if (clientLabel === null) return;
        const body = req.body || {};
        if (!validNativeInvokeBody(body)) {
            return res.status(400).json({
                ok: false,
                error: nativeErrorPayload(Object.assign(
                    new Error('native invoke parameters are invalid'),
                    { code: 'INVALID_ARGUMENT', retryable: false },
                )),
            });
        }
        const startedAt = Date.now();
        try {
            const client = await connectedNativeClient(body.deadlineUnixMs);
            const result = await client.invoke(body);
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                capabilityId: body.capabilityId,
                requestId: body.requestId,
                ok: true,
                durationMs: Date.now() - startedAt,
            });
            res.json({ ok: true, result });
        } catch (error) {
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                capabilityId: body.capabilityId,
                requestId: body.requestId,
                ok: false,
                error: nativeErrorPayload(error).code,
                durationMs: Date.now() - startedAt,
            });
            sendNativeFailure(res, error);
        }
    });

    a.post('/native/cancel', async (req, res) => {
        const clientLabel = nativeRequestGate(req, res);
        if (clientLabel === null) return;
        const body = req.body || {};
        if (!validNativeCancelBody(body)) {
            return res.status(400).json({
                ok: false,
                error: nativeErrorPayload(Object.assign(
                    new Error('native cancellation parameters are invalid'),
                    { code: 'INVALID_ARGUMENT', retryable: false },
                )),
            });
        }
        const startedAt = Date.now();
        try {
            const client = await connectedNativeClient(body.deadlineUnixMs);
            const result = await client.cancel(body);
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'cancel',
                requestId: body.requestId,
                targetRequestId: body.targetRequestId,
                ok: true,
                durationMs: Date.now() - startedAt,
            });
            res.json({ ok: true, result });
        } catch (error) {
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'cancel',
                requestId: body.requestId,
                targetRequestId: body.targetRequestId,
                ok: false,
                error: nativeErrorPayload(error).code,
                durationMs: Date.now() - startedAt,
            });
            sendNativeFailure(res, error);
        }
    });

    a.post('/exec', async (req, res) => {
        // Require the shared-secret token. /exec runs arbitrary ExtendScript, so
        // every caller must prove it can read ~/.ae-mcp/auth-token. Constant-time
        // compare to avoid leaking the token via timing.
        const provided = req.get(authToken.HEADER);
        if (!authToken.tokenMatches(provided, execToken)) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        const {
            code,
            undoGroup,
            checkpointLabel,
            timeoutMs,
            nativeProjectGraphEffect = 'invalidate',
        } = req.body || {};
        const client = req.get('x-ae-mcp-client') || 'unknown';
        // checkpointLabel remains accepted but deliberately unused until the
        // Phase 1 checkpoint store arrives.
        const output = await executeJsx({
            code,
            undoGroup,
            checkpointLabel,
            timeoutMs,
            nativeProjectGraphEffect,
            client,
        });
        res.status(output.status).json(output.payload);
    });

    return a;
}

function start(port, callback) {
    if (httpServer) {
        return callback(new Error('already started; call restart() to change port'));
    }
    hostLog.init();
    restoreHostConsole = hostLog.captureConsole(console);
    unsubscribeHostActivity = hostLog.subscribeActivity(activity);
    // Ensure the shared-secret token exists (generate on first run) before we
    // accept any /exec request. Panel and host-side clients share this file.
    try {
        execToken = authToken.ensureToken();
    } catch (e) {
        return callback(new Error('failed to initialize auth token: ' + e.message));
    }
    app = buildApp();
    httpServer = app.listen(port, '127.0.0.1', (err) => {
        if (err) return callback(err);
        currentPort = port;
        callback(null);
    });
    httpServer.on('error', (err) => {
        if (callback) callback(err);
    });
}

function stop(callback) {
    if (restoreHostConsole) {
        try { restoreHostConsole(); } catch (error) { /* best effort */ }
        restoreHostConsole = null;
    }
    if (unsubscribeHostActivity) {
        try { unsubscribeHostActivity(); } catch (error) { /* best effort */ }
        unsubscribeHostActivity = null;
    }
    closeNativeAegpClient();
    if (!httpServer) return callback ? callback() : null;
    httpServer.close(() => {
        httpServer = null;
        currentPort = null;
        if (callback) callback();
    });
}

function restart(port, callback) {
    stop(() => {
        start(port, callback);
    });
}

module.exports = {
    start,
    stop,
    restart,
    setPaused,
    isPaused,
    activity,
    hostLog,
    getConnectionInfo,
    getClients,
    getMcpSessions,
    setClientBlocked,
    regenerateToken,
    setCSInterface: jsxBridge.setCSInterface,
    setRuntimeDependencies,
    setNativeAegpRuntime,
    // Exported for unit-testing the wrap shape without spinning up Express.
    wrapWithUndoGroup,
    wrapForEvalScriptTransport,
    decodeEvalScriptTransportResult,
    executeJsx,
    mcp: null,
    // Exported so tests can build the app and inject a known token without
    // touching the real token file.
    buildApp,
    _setExecToken: function (t) { execToken = t; },
    _setClientBlocklistForTest: function (value) {
        clientBlocklist = value || null;
        blocked.clear();
        if (clientBlocklist && typeof clientBlocklist.list === 'function') {
            clientBlocklist.list().forEach(function (name) { blocked.add(name); });
        }
    },
    _setNativeAegpClientForTest: function (client) {
        closeNativeAegpClient();
        nativeAegpClient = client;
    },
    _setNativeAegpClientFactoryForTest: function (factory) {
        closeNativeAegpClient();
        nativeAegpClientFactory = factory;
    },
};
