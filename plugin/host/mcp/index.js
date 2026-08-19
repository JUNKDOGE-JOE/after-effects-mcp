'use strict';

const jsonrpc = require('./jsonrpc');
const { SessionStore } = require('./session');
const { SseWriter } = require('./sse');
const { buildTools } = require('./tools');

const PROTOCOLS = ['2025-06-18', '2025-03-26'];
const DEFAULT_PROTOCOL = '2025-03-26';

function sessionId(req) {
    return req.get('mcp-session-id');
}

function allowedLocalRequest(req) {
    const port = String(req.socket.localPort || '');
    const host = String(req.get('host') || '').toLowerCase();
    const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
    if (hosts.indexOf(host) === -1) return false;
    const origin = req.get('origin');
    if (!origin || origin === 'null') return true;
    return ['http://127.0.0.1:' + port, 'http://localhost:' + port].indexOf(origin.toLowerCase()) !== -1;
}

function selectProtocol(req) {
    const requested = req.get('mcp-protocol-version');
    return PROTOCOLS.indexOf(requested) !== -1 ? requested : DEFAULT_PROTOCOL;
}

function clientName(params, id) {
    const info = params && params.clientInfo;
    return info && typeof info.name === 'string' && info.name.trim()
        ? info.name.trim() : 'mcp:' + id.slice(0, 8);
}

function gate(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!allowedLocalRequest(req)) {
        res.status(403).json({ ok: false, error: 'forbidden origin or host' });
        return;
    }
    next();
}

function missingSession(message, status, detail) {
    return { status, response: jsonrpc.error(jsonrpc.requestId(message), -32600, 'Invalid Request', detail) };
}

function progressMessage(token, startedAt, now) {
    return {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
            progressToken: token,
            progress: Math.floor(((now === undefined ? Date.now() : now) - startedAt) / 1000),
            message: 'ae_exec is still running',
        },
    };
}

function mountMcp(app, deps) {
    const sessions = new SessionStore();
    const sseOptions = deps.sseOptions || null;
    const progressIntervalMs = deps.progressIntervalMs || 5000;
    const tools = buildTools({
        getStatus: deps.getStatus,
        executeJsx: deps.executeJsx,
        sessionCount: function () { return sessions.size; },
    });

    async function dispatch(req, message) {
        if (jsonrpc.isResponse(message)) return { status: 202, response: null };
        const problem = jsonrpc.validateMessage(message);
        // MCP SDKs treat a non-2xx response as a transport failure and discard
        // the JSON-RPC body. Parsed JSON-RPC failures must therefore stay 200.
        if (problem) return { status: 200, response: jsonrpc.invalidRequest(message, problem) };
        const params = message.params || {};
        if (message.method === 'initialize') {
            if (!jsonrpc.isObject(params)) return { status: 200, response: jsonrpc.invalidParams(message, 'initialize params must be an object') };
            const protocolVersion = selectProtocol(req);
            const session = sessions.create(protocolVersion, 'pending');
            session.clientName = clientName(params, session.id);
            const value = {
                protocolVersion,
                capabilities: { tools: { listChanged: false }, logging: {} },
                serverInfo: { name: 'ae-mcp-host', version: deps.version },
                instructions: 'Experimental CEP-hosted MCP spike. The panel must remain open.',
            };
            return { status: 200, session, response: jsonrpc.result(message, value) };
        }
        const id = sessionId(req);
        if (!id) return missingSession(message, 400, 'Mcp-Session-Id header is required');
        const session = sessions.get(id);
        if (!session) return missingSession(message, 404, 'Mcp-Session-Id is unknown');
        if (message.method === 'notifications/initialized') {
            session.initialized = true;
            return { status: 202, session, response: jsonrpc.result(message, {}) };
        }
        if (message.method === 'ping') return { status: 200, session, response: jsonrpc.result(message, {}) };
        if (message.method === 'tools/list') {
            return { status: 200, session, response: jsonrpc.result(message, { tools: tools.list() }) };
        }
        if (message.method === 'tools/call') {
            const output = await tools.call(params, { session, port: req.socket.localPort });
            if (output.invalid) return { status: 200, session, response: jsonrpc.invalidParams(message, output.invalid) };
            return { status: 200, session, response: jsonrpc.result(message, output.result) };
        }
        return {
            status: 200,
            session,
            response: jsonrpc.isNotification(message) ? null : jsonrpc.methodNotFound(message),
        };
    }

    function wantsProgressStream(body) {
        return jsonrpc.isObject(body) && body.method === 'tools/call'
            && jsonrpc.isObject(body.params) && jsonrpc.isObject(body.params._meta)
            && Object.prototype.hasOwnProperty.call(body.params._meta, 'progressToken');
    }

    app.get('/mcp', gate, function (req, res) {
        if (!String(req.get('accept') || '').toLowerCase().includes('text/event-stream')) {
            return res.status(405).json({ ok: false, error: 'Accept: text/event-stream is required' });
        }
        const id = sessionId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Mcp-Session-Id header is required' });
        const session = sessions.get(id);
        if (!session) return res.status(404).json({ ok: false, error: 'Mcp-Session-Id is unknown' });
        const writer = new SseWriter(res, sseOptions).start();
        sessions.addWriter(session, writer);
    });

    app.delete('/mcp', gate, function (req, res) {
        const id = sessionId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Mcp-Session-Id header is required' });
        if (!sessions.delete(id)) return res.status(404).json({ ok: false, error: 'Mcp-Session-Id is unknown' });
        res.status(204).end();
    });

    app.post('/mcp', gate, async function (req, res) {
        const body = req.body;
        const batch = Array.isArray(body);
        if (batch && body.length === 0) return res.status(200).json(jsonrpc.invalidRequest({}, 'batch must not be empty'));
        const stream = !batch && wantsProgressStream(body) && sessions.get(sessionId(req));
        if (stream) {
            const writer = new SseWriter(res, sseOptions).start();
            const startedAt = Date.now();
            const token = body.params._meta.progressToken;
            // Progress for an in-flight request travels only on that request's
            // own SSE response; publishing it on the standalone GET stream too
            // makes official clients deliver every notification twice
            // (observed live with the TS SDK against AE 2026).
            const notify = function () {
                writer.send(progressMessage(token, startedAt));
            };
            notify();
            const timer = setInterval(notify, progressIntervalMs);
            try {
                const output = await dispatch(req, body);
                if (output.response) writer.send(output.response);
            } finally {
                clearInterval(timer);
                writer.close();
            }
            return;
        }
        const messages = batch ? body : [body];
        const responses = [];
        let status = 200;
        let initializedSession = null;
        for (let i = 0; i < messages.length; i += 1) {
            const output = await dispatch(req, messages[i]);
            status = Math.max(status, output.status);
            if (output.session && output.session.id) initializedSession = output.session;
            if (output.response) responses.push(output.response);
        }
        if (initializedSession) res.set('Mcp-Session-Id', initializedSession.id);
        if (responses.length === 0) return res.status(202).end();
        res.status(status).json(batch ? responses : responses[0]);
    });

    app.use('/mcp', function (error, req, res, next) {
        if (!error) return next();
        res.set('Cache-Control', 'no-store');
        res.status(400).json(jsonrpc.error(null, -32700, 'Parse error'));
    });
    app.all('/mcp', gate, function (req, res) { res.status(405).end(); });
    return { sessions, dispatch };
}

module.exports = mountMcp;
module.exports.allowedLocalRequest = allowedLocalRequest;
module.exports.selectProtocol = selectProtocol;
module.exports.progressMessage = progressMessage;
