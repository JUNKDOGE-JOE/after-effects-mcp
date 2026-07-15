// HTTP server for the ae-mcp CEP plugin. Exposes /health and /exec.
const path = require('path');
const jsxBridge = require('./jsx-bridge');
const authToken = require('./auth-token');
const activity = require('./activity');
const nativeAegp = require('./native-aegp-client');
const PKG_VERSION = require('./package.json').version;

let app = null;
let httpServer = null;
let currentPort = null;
let platformRoots = null;
let runtimeDependencies = null;
// The shared secret /exec requires. Populated in start() so the file is read
// (and generated if missing) exactly once per host lifetime.
let execToken = null;
let paused = false;
let lastHealthAt = null;
let lastPythonVersion = null;
let nativeAegpClient = null;
let nativeAegpClientFactory = null;
let nativeAegpRuntime = null;
const clients = new Map();
const blocked = new Set();
// Self-reported label of the panel's own diagnostic /exec probes. Must match
// the x-ae-mcp-client header in plugin/panel/src/cep/diagnostics.js.
const INTERNAL_CLIENT = 'panel-diagnostics/internal';
const NATIVE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PROJECT_SUMMARY_CAPABILITY = 'ae.project.summary';
const PROJECT_BIT_DEPTH_READ_CAPABILITY = 'ae.project.bit-depth.read';
const PROJECT_BIT_DEPTH_SET_CAPABILITY = 'ae.project.bit-depth.set';
const PROJECT_ITEMS_LIST_CAPABILITY = 'ae.project.items.list';
const COMPOSITION_LAYERS_LIST_CAPABILITY = 'ae.composition.layers.list';
const NATIVE_LOCATOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function normalizePlatformRoots(roots) {
    if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
        throw new TypeError('platform roots must be an object');
    }
    const extensionRoot = String(roots.extensionRoot || '').trim();
    const runtimeRoot = String(roots.runtimeRoot || '').trim();
    if (!extensionRoot || !runtimeRoot) {
        throw new TypeError('platform roots require extensionRoot and runtimeRoot');
    }
    return Object.freeze({
        extensionRoot: path.resolve(extensionRoot),
        runtimeRoot: path.resolve(runtimeRoot),
    });
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

function getClients() {
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
}

function getConnectionInfo() {
    const lastClientSeenAt = getClients().reduce((max, c) => Math.max(max, c.lastSeen || 0), 0) || null;
    return {
        port: currentPort,
        hostVersion: PKG_VERSION,
        pythonVersion: lastPythonVersion,
        lastHealthAt: lastHealthAt,
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
        || typeof nativeAegpClient.beginPairing !== 'function'
        || typeof nativeAegpClient.waitUntilConnected !== 'function'
        || typeof nativeAegpClient.negotiate !== 'function'
        || typeof nativeAegpClient.capabilities !== 'function'
        || typeof nativeAegpClient.invoke !== 'function'
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
        AUTH_REQUIRED: [false, 'not-started', 'approve-pairing'],
        WIRE_VERSION_MISMATCH: [false, 'not-started', 'reconnect'],
        INVALID_REQUEST: [false, 'not-started', 'none'],
        INVALID_ARGUMENT: [false, 'not-started', 'change-arguments'],
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
        NATIVE_PAIRING_REQUIRED: [true, 'not-started', 'approve-pairing'],
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
                : code === 'NATIVE_PAIRING_REQUIRED' || code === 'AUTH_REQUIRED'
                ? 'Approve the matching fingerprint in After Effects, then retry.'
                : 'Follow the recovery action before retrying the native request.',
        };
    const payload = {
        code,
        message: typeof error?.message === 'string' && error.message.length > 0
            ? error.message : code === 'NATIVE_PAIRING_REQUIRED'
            ? 'Approve the matching fingerprint from the After Effects AE MCP menu, then retry.'
            : 'Native AEGP request failed with ' + code + '.',
        retryable: fixedContractMismatch
            ? false : typeof error?.retryable === 'boolean' ? error.retryable : policy[0],
        sideEffect: fixedContractMismatch
            ? 'not-started' : typeof error?.sideEffect === 'string' ? error.sideEffect : policy[1],
        recovery,
    };
    if (code === 'NATIVE_PAIRING_REQUIRED' && error?.pairing) {
        payload.details = {
            pairingFingerprint: error.pairing.fingerprint,
            pairingExpiresInMs: error.pairing.expiresInMs,
            hostInstanceId: error.pairing.hostInstanceId,
            sourceCommit: error.pairing.sourceCommit,
        };
    } else if (error?.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
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

function validProjectBitDepthSetArguments(value) {
    return exactBody(value, ['targetDepth', 'idempotencyKey'])
        && [8, 16, 32].includes(value.targetDepth)
        && typeof value.idempotencyKey === 'string'
        && value.idempotencyKey.length >= 16
        && NATIVE_REQUEST_ID_PATTERN.test(value.idempotencyKey);
}

function validNativeLocator(value, kind) {
    return exactBody(value, [
        'kind', 'hostInstanceId', 'sessionId', 'projectId', 'generation', 'objectId',
    ])
        && value.kind === kind
        && NATIVE_LOCATOR_UUID_PATTERN.test(value.hostInstanceId)
        && NATIVE_LOCATOR_UUID_PATTERN.test(value.sessionId)
        && NATIVE_LOCATOR_UUID_PATTERN.test(value.projectId)
        && Number.isSafeInteger(value.generation) && value.generation > 0
        && NATIVE_LOCATOR_UUID_PATTERN.test(value.objectId);
}

function validProjectItemsListArguments(value) {
    return exactBody(value, ['offset', 'limit'], ['projectLocator'])
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 50
        && (value.projectLocator === undefined
            ? value.offset === 0 : validNativeLocator(value.projectLocator, 'project'));
}

function validCompositionLayersListArguments(value) {
    return exactBody(value, ['compositionLocator', 'offset', 'limit'])
        && validNativeLocator(value.compositionLocator, 'composition')
        && Number.isSafeInteger(value.offset) && value.offset >= 0
        && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 50;
}

function validNativeInvokeBody(body) {
    if (!exactBody(body, [
        'requestId', 'capabilityId', 'capabilityVersion', 'arguments', 'deadlineUnixMs',
    ])
        || typeof body.requestId !== 'string' || !NATIVE_REQUEST_ID_PATTERN.test(body.requestId)
        || !validDeadline(body.deadlineUnixMs)) return false;
    if ((body.capabilityId === PROJECT_SUMMARY_CAPABILITY
        || body.capabilityId === PROJECT_BIT_DEPTH_READ_CAPABILITY)
        && body.capabilityVersion === 1) {
        return exactBody(body.arguments, []);
    }
    if (body.capabilityId === PROJECT_BIT_DEPTH_SET_CAPABILITY && body.capabilityVersion === 1) {
        return validProjectBitDepthSetArguments(body.arguments);
    }
    if (body.capabilityId === PROJECT_ITEMS_LIST_CAPABILITY && body.capabilityVersion === 1) {
        return validProjectItemsListArguments(body.arguments);
    }
    if (body.capabilityId === COMPOSITION_LAYERS_LIST_CAPABILITY
        && body.capabilityVersion === 1) {
        return validCompositionLayersListArguments(body.arguments);
    }
    return false;
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
    const pythonVersion = req.get('x-ae-mcp-python');
    if (pythonVersion) lastPythonVersion = pythonVersion;
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

async function nativePairingRequired(client, deadlineUnixMs) {
    const pending = await client.beginPairing(deadlineUnixMs);
    const error = new Error('native AEGP pairing requires an After Effects decision');
    error.code = 'NATIVE_PAIRING_REQUIRED';
    error.retryable = true;
    error.pairing = pending;
    throw error;
}

async function connectedNativeClient(deadlineUnixMs) {
    const client = makeNativeAegpClient();
    const status = client.status();
    if (status.state === 'connected') return client;
    if (status.state === 'authenticating') {
        await client.waitUntilConnected(deadlineUnixMs);
        return client;
    }
    return nativePairingRequired(client, deadlineUnixMs);
}

function sendNativeFailure(res, error) {
    const payload = nativeErrorPayload(error);
    const status = payload.code === 'NATIVE_PAIRING_REQUIRED' ? 409
        : payload.code === 'INVALID_ARGUMENT' ? 400
            : payload.code === 'AUTH_REQUIRED' ? 401 : 503;
    const response = { ok: false, error: payload };
    if (payload.code === 'NATIVE_PAIRING_REQUIRED' && error?.pairing) {
        response.pairing = {
            fingerprint: error.pairing.fingerprint,
            expiresInMs: error.pairing.expiresInMs,
            hostInstanceId: error.pairing.hostInstanceId,
            sourceCommit: error.pairing.sourceCommit,
        };
    }
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
        throw new Error('ExtendScript error: ' + payload.error);
    }
    if (!payload || payload.ok !== true || typeof payload.result !== 'string') {
        throw new Error('invalid evalScript transport envelope shape');
    }
    return payload.result;
}

function buildApp() {
    const express = expressFactory();
    const a = express();
    a.use(express.json({ limit: '5mb' }));

    a.get('/health', (req, res) => {
        const pythonVersion = req.get('x-ae-mcp-python');
        if (pythonVersion) {
            lastHealthAt = Date.now();
            lastPythonVersion = pythonVersion;
        }
        // Presence of CSInterface (set up by the panel at startup) is the
        // readiness proxy. /exec is what actually probes AE.
        // Echo the last-seen Python handshake state so external MCP clients
        // (e.g. ae_diagnose) can verify the bridge is wired up without needing
        // an /exec round-trip. Fields are null until the Python bridge pings.
        res.json({
            ok: true,
            pluginVersion: PKG_VERSION,
            port: currentPort,
            pythonVersion: lastPythonVersion || null,
            pythonLastSeenAt: lastHealthAt || null,
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

    a.post('/native/pair', async (req, res) => {
        const clientLabel = nativeRequestGate(req, res);
        if (clientLabel === null) return;
        const startedAt = Date.now();
        try {
            const client = makeNativeAegpClient();
            if (client.status().state === 'connected') {
                return res.json({ ok: true, status: client.status() });
            }
            const pending = await client.beginPairing();
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'pair',
                ok: false,
                denied: 'pairing_required',
                durationMs: Date.now() - startedAt,
            });
            const error = new Error('native AEGP pairing requires an After Effects decision');
            error.code = 'NATIVE_PAIRING_REQUIRED';
            error.retryable = true;
            error.pairing = pending;
            sendNativeFailure(res, error);
        } catch (error) {
            activity.record({
                client: clientLabel,
                engine: 'native-aegp',
                operation: 'pair',
                ok: false,
                error: nativeErrorPayload(error).code,
                durationMs: Date.now() - startedAt,
            });
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

    a.post('/exec', async (req, res) => {
        // Require the shared-secret token. /exec runs arbitrary ExtendScript, so
        // every caller must prove it can read ~/.ae-mcp/auth-token. Constant-time
        // compare to avoid leaking the token via timing.
        const provided = req.get(authToken.HEADER);
        if (!authToken.tokenMatches(provided, execToken)) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        const { code, undoGroup, checkpointLabel, timeoutMs } = req.body || {};
        const client = req.get('x-ae-mcp-client') || 'unknown';
        const pythonVersion = req.get('x-ae-mcp-python');
        if (pythonVersion) lastPythonVersion = pythonVersion;
        // Panel-origin diagnostic probes stay out of the client registry so
        // they cannot bump lastClientSeenAt (wizard/diagnostics would
        // self-greenlight) or show up as a phantom client in Settings.
        // Must match the header constant in plugin/panel/src/cep/diagnostics.js.
        if (client !== INTERNAL_CLIENT) touchClient(client);
        if (blocked.has(client)) {
            activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'blocked' });
            return res.status(403).json({ ok: false, error: 'blocked: this client is blocked in the panel' });
        }
        if (paused) {
            activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'paused' });
            return res.status(503).json({ ok: false, error: 'paused: AI actions are blocked by the panel kill switch' });
        }
        if (typeof code !== 'string' || code.length === 0) {
            activity.record({ client, undoGroup: undoGroup || null, ok: false, denied: 'invalid_request' });
            return res.status(400).json({ ok: false, error: 'missing or empty `code`' });
        }
        const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

        // Wrap user JSX in undo group if requested. checkpointLabel currently
        // forwarded but unused; later sub-specs will wire it to the checkpoint
        // store.
        const wrapped = undoGroup ? wrapWithUndoGroup(code, undoGroup) : code;
        const transported = wrapForEvalScriptTransport(wrapped);

        const startedAt = Date.now();
        try {
            const encoded = await jsxBridge.evalScript(transported, t);
            const result = decodeEvalScriptTransportResult(encoded);
            activity.record({
                client,
                undoGroup: undoGroup || null,
                ok: true,
                durationMs: Date.now() - startedAt,
                ...(result === '' ? { emptyResult: true } : {}),
            });
            res.json({ ok: true, result: result || '' });
        } catch (e) {
            activity.record({ client, undoGroup: undoGroup || null, ok: false, error: e.message, durationMs: Date.now() - startedAt });
            res.json({ ok: false, error: e.message });
        }
    });

    return a;
}

function start(port, callback, roots) {
    if (httpServer) {
        return callback(new Error('already started; call restart() to change port'));
    }
    let nextRoots = platformRoots;
    try {
        if (roots !== undefined) nextRoots = normalizePlatformRoots(roots);
    } catch (e) {
        return callback(new Error('invalid platform roots: ' + e.message));
    }
    // Ensure the shared-secret token exists (generate on first run) before we
    // accept any /exec request. The Python bridge reads the same file.
    try {
        execToken = authToken.ensureToken();
    } catch (e) {
        return callback(new Error('failed to initialize auth token: ' + e.message));
    }
    platformRoots = nextRoots;
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
    closeNativeAegpClient();
    if (!httpServer) return callback ? callback() : null;
    httpServer.close(() => {
        httpServer = null;
        currentPort = null;
        if (callback) callback();
    });
}

function restart(port, callback, roots) {
    let nextRoots = platformRoots;
    try {
        if (roots !== undefined) nextRoots = normalizePlatformRoots(roots);
    } catch (e) {
        callback(new Error('invalid platform roots: ' + e.message));
        return;
    }
    stop(() => {
        if (nextRoots === null) start(port, callback);
        else start(port, callback, nextRoots);
    });
}

module.exports = {
    start,
    stop,
    restart,
    setPaused,
    isPaused,
    activity,
    getConnectionInfo,
    getClients,
    setClientBlocked,
    regenerateToken,
    setCSInterface: jsxBridge.setCSInterface,
    setRuntimeDependencies,
    setNativeAegpRuntime,
    // Exported for unit-testing the wrap shape without spinning up Express.
    wrapWithUndoGroup,
    wrapForEvalScriptTransport,
    decodeEvalScriptTransportResult,
    // Exported so tests can build the app and inject a known token without
    // touching the real token file.
    buildApp,
    _setExecToken: function (t) { execToken = t; },
    _setNativeAegpClientForTest: function (client) {
        closeNativeAegpClient();
        nativeAegpClient = client;
    },
    _setNativeAegpClientFactoryForTest: function (factory) {
        closeNativeAegpClient();
        nativeAegpClientFactory = factory;
    },
    // Test-only state inspection. Platform roots are never exposed over HTTP.
    _getPlatformRootsForTest: function () { return platformRoots; },
};
