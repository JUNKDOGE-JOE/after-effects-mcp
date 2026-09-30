'use strict';

const { createInstanceService } = require('./instance-service');
const { createStatePaths } = require('./state-paths');
const { TOOL_MODULES, publicDefinition } = require('./mcp/tools');
const { textResult } = require('./mcp/tool-result');
const { contextInstanceId } = require('./mcp/workspace-router');
const version = require('./package.json').version;

function run(input, output, errorOutput, options) {
    const service = options && options.service || createInstanceService({ statePaths: createStatePaths() });
    const source = input || process.stdin;
    const sink = output || process.stdout;
    let initialized = false;
    let buffer = '';
    const pending = new Set();
    const send = value => sink.write(JSON.stringify(value) + '\n');

    async function callTool(params) {
        const args = params.arguments || {};
        let value;
        if (params.name === 'ae_instances') value = await service.instances(args.action || 'list', args);
        else {
            const target = params.name === 'ae_workspace' ? await service.target(args) : contextInstanceId(args.context_id);
            if (!target) throw Object.assign(new Error('Bind an instance with ae_workspace and pass context_id. No current AE is assumed.'), { code: 'WORKSPACE_REQUIRED' });
            return service.router.call(target, params);
        }
        return value.forwarded || textResult(value, value.ok === false);
    }

    async function dispatch(line) {
        let message;
        try { message = JSON.parse(line); }
        catch (_) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        if (!message || typeof message.method !== 'string') {
            send({ jsonrpc: '2.0', id: message && message.id || null, error: { code: -32600, message: 'Invalid request' } }); return;
        }
        if (message.id === undefined) return;
        try {
            let result;
            if (message.method === 'initialize') {
                initialized = true;
                const requested = message.params && message.params.protocolVersion;
                result = { protocolVersion: ['2025-06-18', '2025-03-26'].includes(requested) ? requested : '2025-06-18', capabilities: { tools: {} },
                    serverInfo: { name: 'ae-mcp-connector', version },
                    instructions: 'Use ae_instances to discover or explicitly start a primary. Bind with ae_workspace and carry context_id on AE calls. Never start a replacement after timeout or intentional panel closure. Only pass continuation confirmation after explicit user authorization.' };
            } else if (!initialized) throw new Error('Initialize the MCP connection first.');
            else if (message.method === 'ping') result = {};
            else if (message.method === 'tools/list') result = { tools: TOOL_MODULES.map(publicDefinition) };
            else if (message.method === 'tools/call') result = await callTool(message.params || {});
            else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
            send({ jsonrpc: '2.0', id: message.id, result });
        } catch (error) {
            const result = textResult({ ok: false, code: error.code || 'CONNECTOR_ERROR', error: error.message }, true);
            send(message.method === 'tools/call' ? { jsonrpc: '2.0', id: message.id, result }
                : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
        }
    }

    function enqueue(line) {
        if (!line.trim()) return;
        const task = dispatch(line);
        pending.add(task);
        task.finally(() => pending.delete(task));
    }

    return new Promise((resolve, reject) => {
        source.setEncoding('utf8');
        source.on('error', reject);
        source.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            lines.forEach(enqueue);
        });
        source.on('end', () => {
            enqueue(buffer);
            Promise.all(Array.from(pending)).then(resolve, reject);
        });
    });
}

module.exports = { run };
