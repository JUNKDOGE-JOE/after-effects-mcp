// HTTP server for the ae-mcp CEP plugin. Exposes /health and /exec.
const express = require('express');
const jsxBridge = require('./jsx-bridge');
const authToken = require('./auth-token');
const PKG_VERSION = require('./package.json').version;

let app = null;
let httpServer = null;
let currentPort = null;
// The shared secret /exec requires. Populated in start() so the file is read
// (and generated if missing) exactly once per host lifetime.
let execToken = null;

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

function buildApp() {
    const a = express();
    a.use(express.json({ limit: '5mb' }));

    a.get('/health', (req, res) => {
        // Presence of CSInterface (set up by the panel at startup) is the
        // readiness proxy. /exec is what actually probes AE.
        res.json({
            ok: true,
            pluginVersion: PKG_VERSION,
            port: currentPort,
        });
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
        if (typeof code !== 'string' || code.length === 0) {
            return res.status(400).json({ ok: false, error: 'missing or empty `code`' });
        }
        const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

        // Wrap user JSX in undo group if requested. checkpointLabel currently
        // forwarded but unused; later sub-specs will wire it to the checkpoint
        // store.
        const wrapped = undoGroup ? wrapWithUndoGroup(code, undoGroup) : code;

        try {
            const result = await jsxBridge.evalScript(wrapped, t);
            res.json({ ok: true, result: result || '' });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    return a;
}

function start(port, callback) {
    if (httpServer) {
        return callback(new Error('already started; call restart() to change port'));
    }
    // Ensure the shared-secret token exists (generate on first run) before we
    // accept any /exec request. The Python bridge reads the same file.
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
    if (!httpServer) return callback ? callback() : null;
    httpServer.close(() => {
        httpServer = null;
        currentPort = null;
        if (callback) callback();
    });
}

function restart(port, callback) {
    stop(() => start(port, callback));
}

module.exports = {
    start,
    stop,
    restart,
    setCSInterface: jsxBridge.setCSInterface,
    // Exported for unit-testing the wrap shape without spinning up Express.
    wrapWithUndoGroup,
    // Exported so tests can build the app and inject a known token without
    // touching the real token file.
    buildApp,
    _setExecToken: function (t) { execToken = t; },
};
