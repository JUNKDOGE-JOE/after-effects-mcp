'use strict';

// This file runs under the user's system Node, not CEP's embedded Node. It is
// intentionally dependency-free so stdio-only MCP clients can reach the host.
const http = require('http');
const urlApi = require('url');

const DEFAULT_URL = 'http://127.0.0.1:11488/mcp';

function writeLine(output, value) {
    output.write(JSON.stringify(value) + '\n');
}

function updateSession(state, response, request, value) {
    const sessionId = response.headers['mcp-session-id'];
    if (sessionId) state.sessionId = sessionId;
    const result = value && value.result;
    if (request.method === 'initialize' && result && typeof result.protocolVersion === 'string') {
        state.protocolVersion = result.protocolVersion;
    }
}

function emitSseEvent(text, state, output) {
    const data = [];
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].slice(0, 5) === 'data:') data.push(lines[i].slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    const value = data.join('\n').trim();
    if (!value || value === '[DONE]') return;
    try {
        writeLine(output, JSON.parse(value));
    } catch (error) {
        throw new Error('MCP SSE data was not JSON: ' + error.message);
    }
}

function createSseDecoder(state, output) {
    let buffer = '';
    return {
        push: function (chunk) {
            buffer += chunk;
            buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            let split = buffer.indexOf('\n\n');
            while (split !== -1) {
                emitSseEvent(buffer.slice(0, split), state, output);
                buffer = buffer.slice(split + 2);
                split = buffer.indexOf('\n\n');
            }
        },
        end: function () {
            if (buffer.trim()) emitSseEvent(buffer, state, output);
        },
    };
}

function requestMcp(message, state, output, targetUrl) {
    const target = new urlApi.URL(targetUrl || state.url || DEFAULT_URL);
    const body = JSON.stringify(message);
    const headers = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    };
    if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
    if (state.protocolVersion) headers['Mcp-Protocol-Version'] = state.protocolVersion;

    return new Promise(function (resolve, reject) {
        const request = http.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: 'POST',
            headers,
        }, function (response) {
            const contentType = String(response.headers['content-type'] || '').toLowerCase();
            const stream = contentType.indexOf('text/event-stream') !== -1;
            const decoder = stream ? createSseDecoder(state, output) : null;
            let text = '';
            response.setEncoding('utf8');
            response.on('data', function (chunk) {
                if (decoder) decoder.push(chunk);
                else text += chunk;
            });
            response.on('end', function () {
                try {
                    if (decoder) {
                        decoder.end();
                    } else if (text.trim()) {
                        const value = JSON.parse(text);
                        updateSession(state, response, message, value);
                        writeLine(output, value);
                    }
                    if (response.statusCode >= 400 && !text.trim() && !decoder) {
                        throw new Error('MCP HTTP ' + response.statusCode);
                    }
                    if (decoder) updateSession(state, response, message, null);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

function run(input, output, errorOutput, targetUrl) {
    const source = input || process.stdin;
    const destination = output || process.stdout;
    const errors = errorOutput || process.stderr;
    const state = {
        url: targetUrl || process.env.AE_MCP_HTTP_URL || DEFAULT_URL,
        sessionId: null,
        protocolVersion: null,
    };
    let buffer = '';
    let queue = Promise.resolve();

    function handleLine(line) {
        if (!line.trim()) return Promise.resolve();
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            writeLine(destination, {
                jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
            });
            return Promise.resolve();
        }
        return requestMcp(message, state, destination, state.url).catch(function (error) {
            // Keep the line queue alive: surface the failure to the client (for
            // requests) and keep serving later lines. A thrown error here would
            // leave the promise chain rejected and silently drop all traffic.
            errors.write('stdio-shim: ' + error.message + '\n');
            if (message && message.id !== undefined && message.id !== null) {
                writeLine(destination, {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32000, message: 'stdio-shim: ' + error.message },
                });
            }
        });
    }

    source.setEncoding('utf8');
    source.on('data', function (chunk) {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.forEach(function (line) {
            queue = queue.then(function () { return handleLine(line); });
        });
    });
    source.on('end', function () {
        if (buffer.trim()) queue = queue.then(function () { return handleLine(buffer); });
    });
    return queue;
}

if (require.main === module) {
    run().catch(function () { process.exitCode = 1; });
}

module.exports = { DEFAULT_URL, createSseDecoder, requestMcp, run };
