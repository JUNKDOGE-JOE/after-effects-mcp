'use strict';

const { requestMcp } = require('../stdio-shim');

function contextInstanceId(value) {
    if (typeof value !== 'string') return null;
    const split = value.indexOf(':');
    return split > 0 ? value.slice(0, split) : null;
}

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

class WorkspaceRouter {
    constructor(registry, options) {
        this.registry = registry;
        this.peers = new Map();
        this.request = options && options.request || requestMcp;
        this.nextId = 1;
    }

    async send(peer, method, params) {
        const id = this.nextId++;
        let response = null;
        const output = { write(line) {
            const value = JSON.parse(line);
            if (value.id === id && !value.method) response = value;
        } };
        await this.request({ jsonrpc: '2.0', id, method, params }, peer, output, peer.url);
        if (!response) throw failure('INSTANCE_NO_RESPONSE', 'The target returned no MCP response.');
        if (response.error) throw failure('INSTANCE_MCP_ERROR', response.error.message);
        return response.result;
    }

    async peer(instanceId) {
        const record = await this.registry.get(instanceId);
        if (!record || record.state !== 'running' || !record.endpoint) {
            this.peers.delete(instanceId);
            throw failure('INSTANCE_NOT_READY', 'The selected AE is not connected; it will not be restarted automatically.');
        }
        const endpoint = new URL(record.endpoint);
        if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) {
            throw failure('INSTANCE_INVALID_ENDPOINT', 'Only a registered local AE endpoint is supported.');
        }
        let peer = this.peers.get(instanceId);
        if (!peer || peer.url !== record.endpoint || peer.cepPid !== record.cepPid) {
            peer = { url: record.endpoint, cepPid: record.cepPid, sessionId: null, protocolVersion: null, ready: null };
            this.peers.set(instanceId, peer);
        }
        if (!peer.ready) {
            peer.ready = this.send(peer, 'initialize', {
                protocolVersion: '2025-06-18', capabilities: {},
                clientInfo: { name: 'ae-mcp-workspace-router', version: '1' },
            }).then(async () => {
                await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, peer, { write() {} }, peer.url);
                return peer;
            }).catch(error => { peer.ready = null; throw error; });
        }
        return peer.ready;
    }

    async call(instanceId, params) {
        const peer = await this.peer(instanceId);
        // A failed dispatched call is never replayed after reconnecting.
        return this.send(peer, 'tools/call', params);
    }

    clear() { this.peers.clear(); }
}

module.exports = { WorkspaceRouter, contextInstanceId, failure };
