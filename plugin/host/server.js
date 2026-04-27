// HTTP server for the ae-mcp CEP plugin. Exposes /health and /exec.
const express = require('express');
const jsxBridge = require('./jsx-bridge');

let app = null;
let httpServer = null;
let currentPort = null;

function buildApp() {
    const a = express();
    a.use(express.json({ limit: '5mb' }));

    a.get('/health', (req, res) => {
        // Presence of CSInterface (set up by the panel at startup) is the
        // readiness proxy. /exec is what actually probes AE.
        res.json({
            ok: true,
            pluginVersion: '0.1.0',
            port: currentPort,
        });
    });

    a.post('/exec', async (req, res) => {
        const { code, undoGroup, checkpointLabel, timeoutMs } = req.body || {};
        if (typeof code !== 'string' || code.length === 0) {
            return res.status(400).json({ ok: false, error: 'missing or empty `code`' });
        }
        const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

        // Wrap user JSX in undo group if requested. checkpointLabel currently
        // forwarded but unused; later sub-specs will wire it to the checkpoint
        // store.
        let wrapped = code;
        if (undoGroup) {
            wrapped =
                '(function(){ app.beginUndoGroup(' + JSON.stringify(undoGroup) + '); ' +
                'try { return ' + code + '; } finally { app.endUndoGroup(); } })()';
        }

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
};
