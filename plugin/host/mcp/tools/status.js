'use strict';

// ae_status — read same-process host status. One tool per module: each file
// exports { definition, call(args, context, deps) } and tools.js aggregates
// them, so parallel tool work lands in separate files instead of one registry.

const { textResult } = require('../tool-result');
const fs = require('fs');
const path = require('path');

const DIAGNOSE_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../../jsx/templates/diagnose.jsx'), 'utf8');

const definition = {
    name: 'ae_status',
    description: 'Read same-process ae-mcp host status, ping the host, or diagnose AE responsiveness without a network round trip.',
    inputSchema: {
        type: 'object',
        properties: {
            depth: { type: 'string', enum: ['ping', 'status', 'diagnose'], default: 'status' },
            expect: { type: 'string', default: 'pong', description: 'String to echo for depth=ping.' },
        },
        additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

function errorResult(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}

function getNativeExecutionPlane(deps) {
    try {
        const status = typeof deps.getNativeStatus === 'function' ? deps.getNativeStatus() : null;
        if (status && status.state === 'connected') {
            return { available: true, adapter: 'native-aegp', engine: 'native-aegp' };
        }
    } catch (_) {}
    return { available: false, adapter: null, engine: null };
}

function baseStatus(context, deps) {
    const host = deps.getStatus(context.port) || {};
    const rawClients = typeof deps.getClients === 'function' ? deps.getClients() : (Array.isArray(host.clients) ? host.clients : []);
    const clients = rawClients.map(function (client) {
        return { name: client.label || client.name || 'unknown', blocked: client.blocked === true };
    });
    host.server = 'cep-host';
    host.python = null;
    host.paused = typeof deps.isPaused === 'function' ? deps.isPaused() : host.paused === true;
    host.clients = clients;
    host.nativeExecutionPlane = typeof deps.getNativeStatus === 'function'
        ? getNativeExecutionPlane(deps)
        : (host.nativeExecutionPlane || getNativeExecutionPlane(deps));
    host.mcp = { sessions: deps.sessionCount(), protocolVersion: context.session.protocolVersion };
    return host;
}

async function call(args, context, deps) {
    args = args || {};
    const keys = Object.keys(args);
    if (keys.some(function (key) { return key !== 'depth' && key !== 'expect'; })) return errorResult('ae_status received unknown arguments');
    const depth = args.depth === undefined ? 'status' : args.depth;
    if (['ping', 'status', 'diagnose'].indexOf(depth) === -1) return errorResult('`depth` must be ping, status, or diagnose');
    if (args.expect !== undefined && typeof args.expect !== 'string') return errorResult('`expect` must be a string');
    const status = baseStatus(context, deps);
    if (depth === 'ping') {
        return { result: textResult({ ok: true, pong: args.expect === undefined ? 'pong' : args.expect, server: 'cep-host', pluginVersion: status.pluginVersion || null, port: status.port || null }, false) };
    }
    if (depth === 'diagnose') {
        status.host = {
            reachable: true, pluginVersion: status.pluginVersion || null, port: status.port || null, jsxBridge: status.jsxBridge || null,
        };
        try {
            const execution = await deps.executeJsx({
                code: DIAGNOSE_TEMPLATE,
                timeoutMs: 10000, client: context.session.clientName, nativeProjectGraphEffect: 'preserve',
            });
            const raw = execution && execution.payload && execution.payload.result;
            const ae = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!ae || ae.ok !== true) throw new Error(ae && ae.error ? ae.error : 'diagnose failed');
            status.ae = { responsive: true, aeVersion: ae.aeVersion || null, projectFile: ae.projectFile === undefined ? null : ae.projectFile };
        } catch (error) {
            status.ae = { responsive: false, error: error && error.message ? error.message : String(error) };
        }
    }
    return { result: textResult(status, false) };
}

module.exports = { definition, call, baseStatus, getNativeExecutionPlane };
