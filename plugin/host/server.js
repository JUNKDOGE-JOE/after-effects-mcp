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

const EVAL_SCRIPT_QUOTE_SOURCE = (
    'var __aemcp_quote_re=/[\\u0000-\\u001f"\\\\\\u007f-\\uffff]/g;' +
    'function __aemcp_quote_char(c){' +
    'var n=c.charCodeAt(0);' +
    'if(n===8){return "\\\\b";}' +
    'if(n===9){return "\\\\t";}' +
    'if(n===10){return "\\\\n";}' +
    'if(n===12){return "\\\\f";}' +
    'if(n===13){return "\\\\r";}' +
    'if(n===34){return "\\\\\\"";}' +
    'if(n===92){return "\\\\\\\\";}' +
    'return "\\\\u"+("0000"+n.toString(16)).slice(-4);' +
    '}' +
    'function __aemcp_quote_slow(v){' +
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
    'function __aemcp_quote_fast(v){' +
    'var s=String(v);' +
    '__aemcp_quote_re.lastIndex=0;' +
    'if(!__aemcp_quote_re.test(s)){return "\\""+s+"\\"";}' +
    '__aemcp_quote_re.lastIndex=0;' +
    'return "\\""+s.replace(__aemcp_quote_re,__aemcp_quote_char)+"\\"";' +
    '}' +
    'var __aemcp_quote=(function(){' +
    'var probe="\\u0001\\b\\t\\n\\f\\r\\"\\\\\\u007f\\u00e9\\u4e2d\\ud83d\\ude00 ok";' +
    'try{if(__aemcp_quote_fast(probe)===__aemcp_quote_slow(probe)){return __aemcp_quote_fast;}}catch(ignore){}' +
    'return __aemcp_quote_slow;' +
    '})();'
);

// CEP can corrupt non-ASCII result text when CSInterface.evalScript crosses
// the ExtendScript -> panel boundary on localized Windows installs. Return an
// ASCII-only JSON envelope from JSX, then decode it in Node before HTTP JSON.
function wrapForEvalScriptTransportDefault(code) {
    return (
        '(function(){' +
        'var __aemcp_max_depth=12,__aemcp_max_length=1000000;' +
        EVAL_SCRIPT_QUOTE_SOURCE +
        'function __aemcp_projection_error(reason){' +
        'throw new Error("ae_exec result "+reason+"; return a smaller projection (for example, map to the fields you need)");' +
        '}' +
        'function __aemcp_piece(state,piece){' +
        'state.length+=piece.length;' +
        'if(state.length>__aemcp_max_length){__aemcp_projection_error("exceeds the 1000000 character serialization limit");}' +
        'return piece;' +
        '}' +
        'function __aemcp_seen(stack,value){' +
        'for(var i=0;i<stack.length;i++){if(stack[i]===value){return true;}}' +
        'return false;' +
        '}' +
        'function __aemcp_kind(value){' +
        'var tag;' +
        'try{tag=Object.prototype.toString.call(value);}catch(ignore){return "leaf";}' +
        'if(tag==="[object Array]"){return "array";}' +
        'if(tag!=="[object Object]"){return "leaf";}' +
        'var constructorValue;' +
        'try{constructorValue=value.constructor;}catch(ignoreConstructor){return "leaf";}' +
        'return constructorValue===Object?"object":"leaf";' +
        '}' +
        'function __aemcp_json(value,depth,seen,state){' +
        'if(value===null){return __aemcp_piece(state,"null");}' +
        'var valueType=typeof value;' +
        'if(valueType==="string"){return __aemcp_piece(state,__aemcp_quote(value));}' +
        'if(valueType==="number"){return __aemcp_piece(state,isFinite(value)?String(value):"null");}' +
        'if(valueType==="boolean"){return __aemcp_piece(state,value?"true":"false");}' +
        'if(valueType==="undefined"||valueType==="function"){return null;}' +
        'if(valueType!=="object"){return __aemcp_piece(state,__aemcp_quote(String(value)));}' +
        'var kind=__aemcp_kind(value);' +
        'if(kind==="leaf"){return __aemcp_piece(state,__aemcp_quote(String(value)));}' +
        'if(depth>=__aemcp_max_depth){__aemcp_projection_error("exceeds the maximum serialization depth of 12");}' +
        'if(__aemcp_seen(seen,value)){__aemcp_projection_error("contains a cyclic plain Object or Array");}' +
        'seen.push(value);' +
        'try{' +
        'var out,child,childValue,readable,i,key,own,first=true;' +
        'if(kind==="array"){' +
        'out=__aemcp_piece(state,"[");' +
        'var arrayLength=0;' +
        'try{arrayLength=value.length;}catch(ignoreLength){arrayLength=0;}' +
        'for(i=0;i<arrayLength;i++){' +
        'if(i>0){out+=__aemcp_piece(state,",");}' +
        'readable=true;' +
        'try{childValue=value[i];}catch(ignoreArrayProperty){readable=false;}' +
        'child=readable?__aemcp_json(childValue,depth+1,seen,state):null;' +
        'if(child===null){child=__aemcp_piece(state,"null");}' +
        'out+=child;' +
        '}' +
        'return out+__aemcp_piece(state,"]");' +
        '}' +
        'out=__aemcp_piece(state,"{");' +
        'for(key in value){' +
        'own=false;' +
        'try{own=Object.prototype.hasOwnProperty.call(value,key);}catch(ignoreOwn){own=false;}' +
        'if(!own){continue;}' +
        'readable=true;' +
        'try{childValue=value[key];}catch(ignoreObjectProperty){readable=false;}' +
        'if(!readable){continue;}' +
        'child=__aemcp_json(childValue,depth+1,seen,state);' +
        'if(child===null){continue;}' +
        'if(!first){out+=__aemcp_piece(state,",");}' +
        'first=false;' +
        'out+=__aemcp_piece(state,__aemcp_quote(key))+__aemcp_piece(state,":")+child;' +
        '}' +
        'return out+__aemcp_piece(state,"}");' +
        '}finally{seen.pop();}' +
        '}' +
        'try{' +
        'var __aemcp_value=eval(' + quoteAsciiJsString(code) + ');' +
        'var __aemcp_type=typeof __aemcp_value;' +
        'if(__aemcp_type==="string"||__aemcp_type==="undefined"||__aemcp_type==="function"){' +
        'return "{\\"ok\\":true,\\"resultType\\":\\"string\\",\\"result\\":"+__aemcp_quote(__aemcp_value)+"}";' +
        '}' +
        'var __aemcp_result=__aemcp_json(__aemcp_value,0,[],{length:0});' +
        'return "{\\"ok\\":true,\\"resultType\\":\\"json\\",\\"result\\":"+__aemcp_quote(__aemcp_result)+"}";' +
        '}catch(e){' +
        'var __aemcp_detail=String(e);' +
        'if(e&&e.line){__aemcp_detail+=" (line "+e.line+")";}' +
        'return "{\\"ok\\":false,\\"error\\":"+__aemcp_quote(__aemcp_detail)+"}";' +
        '}' +
        '})()'
    );
}

// Host methods do not dispatch through JS prototypes, so attribution uses bounded snapshots.
// Keep the inner transport JSON opaque so large user results are never escaped twice.
function wrapForEvalScriptTransportDiagnostics(code) {
    const transported = wrapForEvalScriptTransportDefault(code);
    return [
        '(function(){',
        'var __aemcp_max_depth=12,__aemcp_max_length=1000000;',
        'var __aemcp_logs=[],__aemcp_log_length=0,__aemcp_logs_truncated=false,__aemcp_notes=[];',
        'var __aemcp_revision_before=null,__aemcp_revision_after=null,__aemcp_project_path=null;',
        'var __aemcp_before=null,__aemcp_after=null;',
        'var __aemcp_dollar=null,__aemcp_writeln=null,__aemcp_writeln_own=false,__aemcp_writeln_replacement=null;',
        'function __aemcp_note(stage,err){try{if(__aemcp_notes.length<20){var text=stage;if(err!==undefined&&err!==null){text+=": "+String(err);}__aemcp_notes.push(String(text).slice(0,160));}}catch(ignore){}}',
        EVAL_SCRIPT_QUOTE_SOURCE,
        'function __aemcp_projection_error(reason){throw new Error(reason);}',
        'function __aemcp_piece(state,piece){state.length+=piece.length;if(state.length>__aemcp_max_length){__aemcp_projection_error("diagnostics serialization limit exceeded");}return piece;}',
        'function __aemcp_seen(stack,value){for(var i=0;i<stack.length;i++){if(stack[i]===value){return true;}}return false;}',
        'function __aemcp_kind(value){var tag;try{tag=Object.prototype.toString.call(value);}catch(ignore){return "leaf";}if(tag==="[object Array]"){return "array";}if(tag!=="[object Object]"){return "leaf";}var constructorValue;try{constructorValue=value.constructor;}catch(ignoreConstructor){return "leaf";}return constructorValue===Object?"object":"leaf";}',
        'function __aemcp_json(value,depth,seen,state){if(arguments.length===1){depth=0;seen=[];state={length:0};}if(value===null){return __aemcp_piece(state,"null");}var valueType=typeof value;if(valueType==="string"){return __aemcp_piece(state,__aemcp_quote(value));}if(valueType==="number"){return __aemcp_piece(state,isFinite(value)?String(value):"null");}if(valueType==="boolean"){return __aemcp_piece(state,value?"true":"false");}if(valueType==="undefined"||valueType==="function"){return null;}if(valueType!=="object"){return __aemcp_piece(state,__aemcp_quote(String(value)));}var kind=__aemcp_kind(value);if(kind==="leaf"){return __aemcp_piece(state,__aemcp_quote(String(value)));}if(depth>=__aemcp_max_depth){__aemcp_projection_error("diagnostics maximum depth exceeded");}if(__aemcp_seen(seen,value)){__aemcp_projection_error("diagnostics contain a cycle");}seen.push(value);try{var out,child,childValue,readable,i,key,own,first=true;if(kind==="array"){out=__aemcp_piece(state,"[");var arrayLength=0;try{arrayLength=value.length;}catch(ignoreLength){arrayLength=0;}for(i=0;i<arrayLength;i++){if(i>0){out+=__aemcp_piece(state,",");}readable=true;try{childValue=value[i];}catch(ignoreArrayProperty){readable=false;}child=readable?__aemcp_json(childValue,depth+1,seen,state):null;if(child===null){child=__aemcp_piece(state,"null");}out+=child;}return out+__aemcp_piece(state,"]");}out=__aemcp_piece(state,"{");for(key in value){own=false;try{own=Object.prototype.hasOwnProperty.call(value,key);}catch(ignoreOwn){own=false;}if(!own){continue;}readable=true;try{childValue=value[key];}catch(ignoreObjectProperty){readable=false;}if(!readable){continue;}child=__aemcp_json(childValue,depth+1,seen,state);if(child===null){continue;}if(!first){out+=__aemcp_piece(state,",");}first=false;out+=__aemcp_piece(state,__aemcp_quote(key))+__aemcp_piece(state,":")+child;}return out+__aemcp_piece(state,"}");}finally{seen.pop();}}',
        'function __aemcp_read_revision(){try{if(typeof app!=="undefined"&&app&&app.project){var v=app.project.revision;return typeof v==="number"&&isFinite(v)?v:null;}}catch(ignore){}return null;}',
        'function __aemcp_read_project_path(){try{if(typeof app!=="undefined"&&app&&app.project&&app.project.file){return app.project.file.fsName?String(app.project.file.fsName):null;}}catch(ignore){}return null;}',
        'function __aemcp_read(o,n,stage){try{var v=o?o[n]:null;return v===undefined?null:v;}catch(err){__aemcp_note(stage,err);return null;}}',
        'function __aemcp_is_comp(item){try{return typeof CompItem!=="undefined"&&item instanceof CompItem;}catch(err){__aemcp_note("comp type",err);return false;}}',
        'function __aemcp_item_at(items,index){try{if(items&&typeof items.item==="function"){return items.item(index);}return items?items[index]:null;}catch(err){__aemcp_note("project item "+index,err);return null;}}',
        'function __aemcp_comp_info(comp){if(!comp){return null;}return {id:__aemcp_read(comp,"id","comp id"),name:__aemcp_read(comp,"name","comp name"),numLayers:__aemcp_read(comp,"numLayers","comp layers")};}',
        'function __aemcp_active_comp(){try{if(typeof app!=="undefined"&&app&&app.project){var item=app.project.activeItem;return __aemcp_is_comp(item)?item:null;}}catch(err){__aemcp_note("active comp",err);}return null;}',
        'function __aemcp_layer_at(comp,index){try{if(comp&&typeof comp.layer==="function"){return comp.layer(index);}return comp&&comp.layers?comp.layers[index]:null;}catch(err){__aemcp_note("layer "+index,err);return null;}}',
        'function __aemcp_group(layer,name,stage){try{return layer&&typeof layer.property==="function"?layer.property(name):null;}catch(err){__aemcp_note(stage,err);return null;}}',
        'function __aemcp_property_value(group,name,stage){try{var prop=group&&typeof group.property==="function"?group.property(name):null;return prop?String(prop.value):null;}catch(err){__aemcp_note(stage,err);return null;}}',
        'function __aemcp_group_count(layer,name,stage){try{var group=layer&&typeof layer.property==="function"?layer.property(name):null;var count=group?group.numProperties:null;return count===undefined?null:count;}catch(err){__aemcp_note(stage,err);return null;}}',
        'function __aemcp_layer_fingerprint(layer){if(!layer){return null;}var transform=__aemcp_group(layer,"ADBE Transform Group","transform group");var out={id:__aemcp_read(layer,"id","layer id"),index:__aemcp_read(layer,"index","layer index"),name:__aemcp_read(layer,"name","layer name"),enabled:__aemcp_read(layer,"enabled","layer enabled"),solo:__aemcp_read(layer,"solo","layer solo"),shy:__aemcp_read(layer,"shy","layer shy"),locked:__aemcp_read(layer,"locked","layer locked"),label:__aemcp_read(layer,"label","layer label"),inPoint:__aemcp_read(layer,"inPoint","layer inPoint"),outPoint:__aemcp_read(layer,"outPoint","layer outPoint"),startTime:__aemcp_read(layer,"startTime","layer startTime"),stretch:__aemcp_read(layer,"stretch","layer stretch"),parentId:null,blendingMode:null,numEffects:__aemcp_group_count(layer,"ADBE Effect Parade","layer effects"),numMasks:__aemcp_group_count(layer,"ADBE Mask Parade","layer masks"),threeD:__aemcp_read(layer,"threeDLayer","layer 3D"),transform:{anchor:__aemcp_property_value(transform,"ADBE Anchor Point","transform anchor"),position:__aemcp_property_value(transform,"ADBE Position","transform position"),scale:__aemcp_property_value(transform,"ADBE Scale","transform scale"),rotation:__aemcp_property_value(transform,"ADBE Rotate Z","transform rotation"),opacity:__aemcp_property_value(transform,"ADBE Opacity","transform opacity")}};try{var parent=layer.parent;if(parent){var stableParentId=__aemcp_read(parent,"id","layer parent id");if(stableParentId!==null){out.parentId=stableParentId;}else{var parentName=__aemcp_read(parent,"name","layer parent name");out.parentId=parentName===null?null:"name:"+String(parentName);}}}catch(errParent){__aemcp_note("layer parent",errParent);}try{var blend=layer.blendingMode;out.blendingMode=blend===undefined||blend===null?null:String(blend);}catch(errBlend){__aemcp_note("layer blendingMode",errBlend);}try{var textGroup=layer&&typeof layer.property==="function"?layer.property("ADBE Text Properties"):null;var source=textGroup&&typeof textGroup.property==="function"?textGroup.property("ADBE Text Document"):null;if(source){var documentValue=source.value;out.text=documentValue&&documentValue.text!==undefined?String(documentValue.text).slice(0,64):null;}}catch(errText){__aemcp_note("layer text",errText);}return out;}',
        'function __aemcp_snapshot(targetCompId,useTarget){var result={items:[],activeComp:null,layers:[],truncated:false};try{if(typeof app==="undefined"||!app||!app.project){return result;}var project=app.project,items=project.items,count=0;try{count=typeof project.numItems==="number"?project.numItems:(items&&typeof items.length==="number"?items.length:0);}catch(errCount){__aemcp_note("project item count",errCount);}if(count>500){result.truncated=true;count=500;}for(var i=1;i<=count;i++){var item=__aemcp_item_at(items,i);if(!item){continue;}var entry={id:__aemcp_read(item,"id","item id"),name:__aemcp_read(item,"name","item name"),type:__aemcp_read(item,"typeName","item type")};if(__aemcp_is_comp(item)){entry.numLayers=__aemcp_read(item,"numLayers","item layers");}result.items.push(entry);}var comp=null;if(useTarget){if(targetCompId!==null&&targetCompId!==undefined){try{var target=project.itemByID(targetCompId);if(__aemcp_is_comp(target)){comp=target;}}catch(errTarget){__aemcp_note("target comp",errTarget);}}}else{comp=__aemcp_active_comp();}result.activeComp=__aemcp_comp_info(comp);if(comp){var layerCount=__aemcp_read(comp,"numLayers","active comp layers");layerCount=typeof layerCount==="number"?layerCount:0;if(layerCount>200){result.truncated=true;layerCount=200;}for(var li=1;li<=layerCount;li++){var fingerprint=__aemcp_layer_fingerprint(__aemcp_layer_at(comp,li));if(fingerprint){result.layers.push(fingerprint);}}}}catch(err){__aemcp_note("snapshot",err);}return result;}',
        'function __aemcp_key(entry,layer){if(!entry){return "missing";}if(entry.id!==null&&entry.id!==undefined){return "id:"+String(entry.id);}return layer?("fallback:"+String(entry.index)+"|"+String(entry.name)):("fallback:"+String(entry.name)+"|"+String(entry.type));}',
        'function __aemcp_index(list,layer){var out={};for(var i=0;i<list.length;i++){out["$"+__aemcp_key(list[i],layer)]=list[i];}return out;}',
        'function __aemcp_layer_ref(layer){return {index:layer.index,name:layer.name,id:layer.id};}',
        'function __aemcp_item_ref(item){return {id:item.id,name:item.name,type:item.type};}',
        'function __aemcp_change(changes,field,before,after,state){if(before===after){return;}if(changes.length>=20){state.truncated=true;return;}changes.push({field:field,before:before,after:after});}',
        'function __aemcp_diff(before,after,currentActive){var state={truncated:!!(before.truncated||after.truncated),itemsAdded:[],itemsRemoved:[],layersAdded:[],layersRemoved:[],layersChanged:[]};var beforeItems=__aemcp_index(before.items,false),afterItems=__aemcp_index(after.items,false),key;for(key in afterItems){if(Object.prototype.hasOwnProperty.call(afterItems,key)&&!Object.prototype.hasOwnProperty.call(beforeItems,key)){state.itemsAdded.push(__aemcp_item_ref(afterItems[key]));}}for(key in beforeItems){if(Object.prototype.hasOwnProperty.call(beforeItems,key)&&!Object.prototype.hasOwnProperty.call(afterItems,key)){state.itemsRemoved.push(__aemcp_item_ref(beforeItems[key]));}}var beforeLayers=__aemcp_index(before.layers,true),afterLayers=__aemcp_index(after.layers,true);for(key in afterLayers){if(Object.prototype.hasOwnProperty.call(afterLayers,key)&&!Object.prototype.hasOwnProperty.call(beforeLayers,key)){state.layersAdded.push(__aemcp_layer_ref(afterLayers[key]));}}for(key in beforeLayers){if(Object.prototype.hasOwnProperty.call(beforeLayers,key)&&!Object.prototype.hasOwnProperty.call(afterLayers,key)){state.layersRemoved.push(__aemcp_layer_ref(beforeLayers[key]));}}var fields=["name","enabled","solo","shy","locked","label","inPoint","outPoint","startTime","stretch","parentId","blendingMode","numEffects","numMasks","threeD","text"];var transforms=["anchor","position","scale","rotation","opacity"];for(key in beforeLayers){if(!Object.prototype.hasOwnProperty.call(beforeLayers,key)||!Object.prototype.hasOwnProperty.call(afterLayers,key)){continue;}var b=beforeLayers[key],a=afterLayers[key],changes=[];for(var fi=0;fi<fields.length;fi++){var field=fields[fi];__aemcp_change(changes,field,b[field],a[field],state);}for(var ti=0;ti<transforms.length;ti++){var transformField=transforms[ti];__aemcp_change(changes,"transform."+transformField,b.transform?b.transform[transformField]:null,a.transform?a.transform[transformField]:null,state);}if(changes.length){if(state.layersChanged.length>=50){state.truncated=true;}else{state.layersChanged.push({layer:__aemcp_layer_ref(a),changes:changes});}}}var from=before.activeComp?{id:before.activeComp.id,name:before.activeComp.name}:null;var to=currentActive?{id:currentActive.id,name:currentActive.name}:null;var fromKey=from?__aemcp_key(from,false):"none",toKey=to?__aemcp_key(to,false):"none";var activeChanged=fromKey===toKey?null:{from:from,to:to};var level=state.layersAdded.length||state.layersRemoved.length||state.layersChanged.length?"layer_diff":(state.itemsAdded.length||state.itemsRemoved.length?"item_diff":"none");return {level:level,method:"snapshot-diff",comp:from,activeCompChanged:activeChanged,layersAdded:state.layersAdded,layersRemoved:state.layersRemoved,layersChanged:state.layersChanged,itemsAdded:state.itemsAdded,itemsRemoved:state.itemsRemoved,truncated:state.truncated,notes:__aemcp_notes.slice(0)};}',
        'function __aemcp_log(args){try{var values=[];for(var i=0;i<args.length;i++){values.push(String(args[i]));}var lines=values.join(" ").split(/\\r?\\n/);for(var j=0;j<lines.length;j++){if(__aemcp_logs.length>=200||__aemcp_log_length>=16000){__aemcp_logs_truncated=true;return;}var remaining=16000-__aemcp_log_length;var line=String(lines[j]);if(line.length>remaining){line=line.slice(0,remaining);__aemcp_logs_truncated=true;}__aemcp_logs.push(line);__aemcp_log_length+=line.length;}}catch(ignore){}}',
        'function __aemcp_install_writeln(){try{if(typeof $==="undefined"||!$||typeof $.writeln!=="function"){return;}__aemcp_dollar=$;__aemcp_writeln=$.writeln;__aemcp_writeln_own=Object.prototype.hasOwnProperty.call($,"writeln");__aemcp_writeln_replacement=function(){__aemcp_log(arguments);return __aemcp_writeln.apply(__aemcp_dollar,arguments);};try{$.writeln=__aemcp_writeln_replacement;}catch(ignoreAssign){return;}if($.writeln!==__aemcp_writeln_replacement){return;}}catch(ignore){}}',
        'function __aemcp_uninstall_writeln(){try{if(__aemcp_dollar&&__aemcp_writeln_replacement){if(__aemcp_writeln_own){__aemcp_dollar.writeln=__aemcp_writeln;}else{delete __aemcp_dollar.writeln;}}}catch(ignore){}}',
        '__aemcp_revision_before=__aemcp_read_revision();__aemcp_project_path=__aemcp_read_project_path();__aemcp_before=__aemcp_snapshot(null,false);',
        'var __aemcp_inner=null,__aemcp_outer_error=null;',
        'try{try{__aemcp_install_writeln();}catch(ignoreInstall){}try{__aemcp_inner=eval(',
        quoteAsciiJsString(transported),
        ');}catch(fatal){__aemcp_outer_error=fatal;}}finally{try{__aemcp_uninstall_writeln();}catch(ignoreUninstall){}__aemcp_revision_after=__aemcp_read_revision();}',
        'var __aemcp_diag={projectPath:__aemcp_project_path,revision:{before:__aemcp_revision_before,after:__aemcp_revision_after}};if(__aemcp_logs.length){__aemcp_diag.logs=__aemcp_logs;}if(__aemcp_logs_truncated){__aemcp_diag.logsTruncated=true;}',
        'if(__aemcp_outer_error){__aemcp_diag.fatal=String(__aemcp_outer_error);return "{\\\"inner\\\":null,\\\"diag\\\":"+__aemcp_json(__aemcp_diag)+"}";}',
        'if(typeof __aemcp_inner!=="string"){__aemcp_diag.fatal="invalid evalScript transport envelope shape";return "{\\\"inner\\\":null,\\\"diag\\\":"+__aemcp_json(__aemcp_diag)+"}";}',
        'if(__aemcp_inner.slice(0,10)==="{\\\"ok\\\":true"){return "{\\\"inner\\\":"+__aemcp_inner+",\\\"diag\\\":"+__aemcp_json(__aemcp_diag)+"}";}',
        'var __aemcp_error="invalid evalScript transport envelope shape",__aemcp_line=null;try{var __aemcp_failure=JSON.parse(__aemcp_inner);if(__aemcp_failure&&typeof __aemcp_failure.error==="string"){__aemcp_error=__aemcp_failure.error;}var __aemcp_match=/\\(line ([0-9]+)\\)$/.exec(__aemcp_error);if(__aemcp_match){__aemcp_line=Number(__aemcp_match[1]);}}catch(ignoreFailure){}__aemcp_diag.line=__aemcp_line;__aemcp_diag.touched=null;try{var __aemcp_target_id=__aemcp_before&&__aemcp_before.activeComp?__aemcp_before.activeComp.id:null;__aemcp_after=__aemcp_snapshot(__aemcp_target_id,true);__aemcp_diag.touched=__aemcp_diff(__aemcp_before,__aemcp_after,__aemcp_comp_info(__aemcp_active_comp()));if(__aemcp_logs_truncated&&__aemcp_diag.touched){__aemcp_diag.touched.truncated=true;}}catch(ignoreTouched){__aemcp_diag.touched=null;}return "{\\\"inner\\\":"+__aemcp_inner+",\\\"diag\\\":"+__aemcp_json(__aemcp_diag)+"}";',
        '})()',
    ].join('');
}

function wrapForEvalScriptTransport(code, options) {
    return options && options.diagnostics === true
        ? wrapForEvalScriptTransportDiagnostics(code)
        : wrapForEvalScriptTransportDefault(code);
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
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'inner')
        && payload.diag && typeof payload.diag === 'object') {
        const outer = payload;
        const diag = outer.diag;
        if (outer.inner === null && typeof diag.fatal === 'string') {
            payload = { ok: false, error: diag.fatal };
        } else {
            payload = outer.inner;
        }
        if (payload && typeof payload === 'object') {
            ['projectPath', 'revision', 'logs', 'logsTruncated'].forEach(function (field) {
                if (Object.prototype.hasOwnProperty.call(diag, field)) payload[field] = diag[field];
            });
            if (payload.ok !== true) {
                ['line', 'touched'].forEach(function (field) {
                    if (Object.prototype.hasOwnProperty.call(diag, field)) payload[field] = diag[field];
                });
            }
        }
    }
    if (payload && payload.ok === false && typeof payload.error === 'string') {
        // The envelope ran to completion and reported a definite ExtendScript
        // error: the script executed, so this is `failed`, not `uncertain`
        // (#260 real-machine check). Undecodable / empty output stays untagged
        // and is classified as uncertain by the caller.
        const error = new Error('ExtendScript error: ' + payload.error);
        error.disposition = 'failed';
        if (Object.prototype.hasOwnProperty.call(payload, 'line')) error.line = payload.line;
        if (Object.prototype.hasOwnProperty.call(payload, 'touched')) error.touched = payload.touched;
        if (Object.prototype.hasOwnProperty.call(payload, 'logs')) error.logs = payload.logs;
        if (Object.prototype.hasOwnProperty.call(payload, 'logsTruncated')) {
            error.logsTruncated = payload.logsTruncated;
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'revision')) error.revision = payload.revision;
        if (Object.prototype.hasOwnProperty.call(payload, 'projectPath')) error.projectPath = payload.projectPath;
        throw error;
    }
    if (!payload || payload.ok !== true || typeof payload.result !== 'string') {
        throw new Error('invalid evalScript transport envelope shape');
    }
    if (payload.resultType !== 'string' && payload.resultType !== 'json') {
        throw new Error('invalid evalScript transport envelope resultType');
    }
    const decoded = { resultType: payload.resultType, result: payload.result };
    if (Object.prototype.hasOwnProperty.call(payload, 'logs')) decoded.logs = payload.logs;
    if (Object.prototype.hasOwnProperty.call(payload, 'logsTruncated')) {
        decoded.logsTruncated = payload.logsTruncated;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'revision')) decoded.revision = payload.revision;
    if (Object.prototype.hasOwnProperty.call(payload, 'projectPath')) decoded.projectPath = payload.projectPath;
    return decoded;
}

// Shared /exec and MCP ae_exec execution path. Both surfaces receive the
// explicit transport resultType; MCP maps it into contentType.
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
    const transported = wrapForEvalScriptTransport(wrapped, {
        diagnostics: input.diagnostics === true,
    });
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
        const decoded = decodeEvalScriptTransportResult(encoded);
        activity.record({
            client,
            undoGroup: undoGroup || null,
            ok: true,
            durationMs: Date.now() - startedAt,
            ...(decoded.result === '' ? { emptyResult: true } : {}),
        });
        const payload = {
            ok: true,
            resultType: decoded.resultType,
            result: decoded.result || '',
        };
        ['projectPath', 'revision', 'logs', 'logsTruncated'].forEach(function (field) {
            if (Object.prototype.hasOwnProperty.call(decoded, field)) payload[field] = decoded[field];
        });
        return {
            status: 200,
            payload,
        };
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
        const payload = {
            ok: false,
            error: e.message,
            disposition,
            jsxBridge: bridgeState,
        };
        if (Object.prototype.hasOwnProperty.call(e, 'line')) payload.errorLine = e.line;
        ['touched', 'logs', 'logsTruncated', 'revision', 'projectPath'].forEach(function (field) {
            if (Object.prototype.hasOwnProperty.call(e, field)) payload[field] = e[field];
        });
        return {
            status: 200,
            payload,
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
