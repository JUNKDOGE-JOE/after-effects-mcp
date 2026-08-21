#!/usr/bin/env node
// Manual real-AE acceptance. It is intentionally not part of npm test / CI.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDeepStrictEqual } from 'util';

const sections = [
    'status',
    'exec',
    'read',
    'previewFrame',
    'checkpoint',
    'recovery',
    'validateExpressions',
    'toolLibrary',
    'conversation',
    'perf',
];
const argv = process.argv.slice(2);
const only = argv.indexOf('--only');
if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node tests/live-mcp/run.mjs [--no-cdp] [--keep-ae] [--only <section>]');
    console.log('Sections: ' + sections.join(', '));
    process.exit(0);
}
const selected = only < 0 ? sections : [argv[only + 1]];
if (
    selected.some(function (name) {
        return sections.indexOf(name) < 0;
    })
)
    throw new Error('unknown --only section');
const hostUrl = process.env.AE_MCP_HOST_URL || 'http://127.0.0.1:11488';
const cdpUrl = process.env.AE_MCP_CDP_URL || 'http://127.0.0.1:9080';
const noCdp = argv.includes('--no-cdp');
const keepAe = argv.includes('--keep-ae');
const extensionRoot =
    process.env.AE_MCP_EXTENSION_ROOT || 'C:/Users/A/AppData/Roaming/Adobe/CEP/extensions/com.aemcp.panel';
const results = [];
let client;
let transport;
let compId;
let savedPath;
function value(reply) {
    return reply && reply.structuredContent;
}
function parsedExecContent(reply) {
    const envelope = value(reply);
    if (!envelope || envelope.ok !== true || typeof envelope.content !== 'string') return null;
    return JSON.parse(envelope.content);
}
function check(name, passed, detail) {
    results.push({ name, passed });
    console.log(
        (passed ? 'PASS ' : 'FAIL ') + name + (detail ? ' ' + JSON.stringify(detail).slice(0, 300) : ''),
    );
}
async function section(name, work) {
    if (!selected.includes(name)) return;
    try {
        await work();
    } catch (error) {
        check(name + ' section completed', false, String((error && error.message) || error));
    }
}
async function cdp(expression) {
    const targets = await (await fetch(cdpUrl + '/json')).json();
    const page = targets.find(function (target) {
        return target.type === 'page' && /com\.aemcp\.panel/.test(target.url);
    });
    if (!page) throw new Error('panel page not found on CDP');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(function (resolve, reject) {
        socket.onopen = resolve;
        socket.onerror = reject;
    });
    const answer = new Promise(function (resolve) {
        socket.onmessage = function (message) {
            resolve(JSON.parse(message.data));
        };
    });
    socket.send(
        JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
        }),
    );
    const reply = await answer;
    socket.close();
    if (reply.error || reply.result.exceptionDetails)
        throw new Error(JSON.stringify(reply.error || reply.result.exceptionDetails));
    return reply.result.result.value;
}
async function connect(url, name) {
    let sessionId = null;
    let requestId = 1;
    let closed = false;
    async function post(message) {
        if (closed) throw new Error('MCP transport is closed');
        const headers = {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2025-03-26',
        };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(message),
        });
        if (!response.ok) throw new Error('MCP HTTP ' + response.status);
        sessionId = response.headers.get('mcp-session-id') || sessionId;
        const text = await response.text();
        if (!text.trim()) return null;
        const dataLines = text.split(/\r?\n/)
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));
        const payload = dataLines.length ? dataLines.at(-1) : text;
        return JSON.parse(payload);
    }
    const initialize = await post({
        jsonrpc: '2.0',
        id: requestId++,
        method: 'initialize',
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name, version: '1' },
        },
    });
    if (initialize?.error) throw new Error(initialize.error.message || 'MCP initialize failed');
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const nextClient = {
        async callTool({ name: toolName, arguments: args }) {
            const reply = await post({
                jsonrpc: '2.0',
                id: requestId++,
                method: 'tools/call',
                params: { name: toolName, arguments: args || {} },
            });
            if (reply?.error) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: reply.error.message || 'MCP error' }],
                };
            }
            return reply?.result || {};
        },
    };
    const nextTransport = {
        async close() { closed = true; },
    };
    return { client: nextClient, transport: nextTransport };
}
async function call(name, args) {
    return client.callTool({ name, arguments: args || {} });
}
async function prepareComp() {
    const made = parsedExecContent(
        await call('ae_exec', {
            undo_group_name: 'live-build',
            code: 'app.newProject(); var c=app.project.items.addComp("live-mcp",640,360,1,4,24); var l=c.layers.addSolid([1,0,0],"Red",100,100,1); var p=l.property("ADBE Transform Group").property("ADBE Position"); p.setValueAtTime(0,[50,50]); p.setValueAtTime(2,[400,200]); var t=c.layers.addText("live"); c.openInViewer(); ({ok:true,compId:String(c.id),layers:c.numLayers,keys:p.numKeys})',
        }),
    );
    compId = made && made.compId;
    check('exec creates disposable comp', made && made.ok && made.layers === 2 && made.keys === 2, made);
}
async function main() {
    ({ client, transport } = await connect(hostUrl + '/mcp', 'ae-mcp-live'));
    await section('status', async function () {
        for (const depth of ['ping', 'status', 'diagnose']) {
            const out = value(
                await call('ae_status', depth === 'ping' ? { depth, expect: 'live' } : { depth }),
            );
            check('status ' + depth, out && out.ok && (depth !== 'ping' || out.pong === 'live'), out);
        }
    });
    await section('exec', async function () {
        const bare = value(await call('ae_exec', { code: '"hi-"+app.version' }));
        check(
            'exec bare result',
            bare && bare.ok && bare.contentType === 'text' && /^hi-/.test(bare.content),
            bare,
        );
        const objectResult = value(
            await call('ae_exec', { code: '({ok:true,n:42})' }),
        );
        const parsedObject = objectResult && objectResult.contentType === 'json'
            ? JSON.parse(objectResult.content) : null;
        check(
            'exec preserves object result',
            objectResult
                && objectResult.ok
                && objectResult.contentType === 'json'
                && isDeepStrictEqual(parsedObject, { ok: true, n: 42 }),
            objectResult,
        );
        const arrayResult = value(
            await call('ae_exec', { code: '[1, "two", {three: 3}]' }),
        );
        const parsedArray = arrayResult && arrayResult.contentType === 'json'
            ? JSON.parse(arrayResult.content) : null;
        check(
            'exec preserves mixed array result',
            arrayResult
                && arrayResult.ok
                && arrayResult.contentType === 'json'
                && isDeepStrictEqual(parsedArray, [1, 'two', { three: 3 }]),
            arrayResult,
        );
        const empty = await call('ae_exec', { code: 'var x=1;' });
        check('exec undefined is tool error', empty.isError && value(empty).ok === false, value(empty));
        const thrown = await call('ae_exec', { code: 'throw new Error("live-boom")' });
        check(
            'exec throw is failed',
            thrown.isError && value(thrown).disposition === 'failed',
            value(thrown),
        );
        await prepareComp();
    });
    if (
        !compId &&
        selected.some(function (name) {
            return ['read', 'previewFrame', 'checkpoint', 'recovery', 'validateExpressions', 'perf'].indexOf(name) >= 0;
        })
    )
        await prepareComp();
    await section('read', async function () {
        const checks = [
            [
                'project',
                { target: 'project' },
                function (v) {
                    return Array.isArray(v.items);
                },
            ],
            [
                'comps',
                { target: 'comps' },
                function (v) {
                    return v.items.some(function (x) {
                        return x.itemId === compId;
                    });
                },
            ],
            [
                'layers',
                { target: 'layers', comp: { id: compId }, page: { offset: 0, limit: 1 } },
                function (v) {
                    return v.total === 2 && v.returned === 1 && v.hasMore === true && v.nextOffset === 1;
                },
            ],
            [
                'properties',
                { target: 'properties', comp: { id: compId }, layer: { index: 2 }, depth: 2 },
                function (v) {
                    return Array.isArray(v.properties);
                },
            ],
            [
                'keyframes',
                {
                    target: 'keyframes',
                    comp: { id: compId },
                    layer: { name: 'Red' },
                    property: { matchPath: 'ADBE Transform Group/ADBE Position' },
                },
                function (v) {
                    return v.total === 2;
                },
            ],
            [
                'compSettings',
                { target: 'compSettings', comp: { id: compId } },
                function (v) {
                    return v.width === 640 && v.height === 360;
                },
            ],
        ];
        for (const entry of checks) {
            const out = value(await call('ae_read', entry[1]));
            check('read ' + entry[0], out && entry[2](out), out);
        }
        const missing = await call('ae_read', { target: 'layers', comp: { name: 'not-live' } });
        check('read error', missing.isError, value(missing));
    });
    await section('previewFrame', async function () {
        const one = await call('ae_previewFrame', { comp_id: compId, time: 1 });
        const two = value(await call('ae_previewFrame', { comp_id: compId, times: [0, 2], scale: 0.5 }));
        check(
            'preview single image',
            !one.isError &&
                one.content.some(function (item) {
                    return item.type === 'image';
                }) &&
                value(one).frames[0].width > 0,
            value(one),
        );
        check(
            'preview scale two frames',
            two &&
                two.frames.length === 2 &&
                two.frames.every(function (frame) {
                    return frame.downsampled;
                }),
            two,
        );
        const gridReply = await call('ae_previewFrame', {
            comp_id: compId,
            range: { start: 0, end: 2, count: 4 },
            layout: 'grid',
        });
        const grid = value(gridReply);
        check(
            'preview range grid returns one image and four cells',
            grid && grid.grid && grid.grid.cells.length === 4
                && gridReply.content.filter(function (item) { return item.type === 'image'; }).length === 1,
            grid,
        );
        const sameReply = await call('ae_previewFrame', {
            comp_id: compId,
            compare: { a: { time: 1 }, b: { time: 1 } },
        });
        const same = value(sameReply);
        check(
            'preview compare identical time has no changed pixels',
            same && same.compare && same.compare.metrics.changedRatio === 0,
            same,
        );
        try {
            const hidden = parsedExecContent(await call('ae_exec', {
                undo_group_name: 'live-preview-hide-red',
                code: 'var l=AEMCP.compById(' + JSON.stringify(Number(compId)) + ').layer("Red"); l.property("ADBE Transform Group").property("ADBE Opacity").setValue(0); ({ok:true,opacity:l.property("ADBE Transform Group").property("ADBE Opacity").value})',
            }));
            check('preview compare hides Red', hidden && hidden.ok && hidden.opacity === 0, hidden);
            const changed = value(await call('ae_previewFrame', {
                comp_id: compId,
                compare: {
                    a: { capture_id: same.captureId, index: 0 },
                    b: { time: 1 },
                    mode: 'diff',
                },
            }));
            const bbox = changed && changed.compare && changed.compare.metrics.bbox;
            const intersectsRed = bbox && bbox.x < 275 && bbox.x + bbox.w > 175
                && bbox.y < 175 && bbox.y + bbox.h > 75;
            check('preview compare localizes the hidden Red layer', Boolean(intersectsRed), changed);
        } finally {
            const restored = parsedExecContent(await call('ae_exec', {
                undo_group_name: 'live-preview-restore-red',
                code: 'var l=AEMCP.compById(' + JSON.stringify(Number(compId)) + ').layer("Red"); l.property("ADBE Transform Group").property("ADBE Opacity").setValue(100); ({ok:true,opacity:l.property("ADBE Transform Group").property("ADBE Opacity").value})',
            }));
            check('preview compare restores Red opacity', restored && restored.ok && restored.opacity === 100, restored);
        }
    });
    await section('checkpoint', async function () {
        const untitled = value(
            await call('ae_exec', { code: 'JSON.stringify({ok:true})', checkpoint_label: 'untitled' }),
        );
        check(
            'exec untitled checkpoint stays best effort',
            untitled && untitled.checkpointSkipped === 'untitled-project',
            untitled,
        );
        savedPath = path.join(os.tmpdir(), 'ae-mcp-live', 'live-' + Date.now() + '.aep');
        fs.mkdirSync(path.dirname(savedPath), { recursive: true });
        const saved = parsedExecContent(
            await call('ae_exec', {
                code:
                    'app.project.save(new File(' +
                    JSON.stringify(savedPath) +
                    ')); ({ok:true,file:app.project.file.fsName})',
            }),
        );
        check('save disposable project', saved && saved.ok && saved.file, saved);
        const cp = value(await call('ae_checkpoint', { action: 'create', label: 'live' }));
        check('explicit checkpoint creates disk file', cp && cp.ok && fs.existsSync(cp.path), cp);
        await call('ae_exec', { code: 'AEMCP.compById(' + JSON.stringify(Number(compId)) + ').name="mutated"; JSON.stringify({ok:true})' });
        const reverted = value(await call('ae_revert', { checkpoint_id: cp.id }));
        check('revert succeeds', reverted && reverted.ok && reverted.reverted, reverted);
        const listed = value(await call('ae_checkpoint', { action: 'list', limit: 20 }));
        check(
            'checkpoint list contains created id',
            listed &&
                listed.checkpoints.some(function (item) {
                    return item.id === cp.id;
                }),
            listed,
        );
        const state = value(await call('ae_read', { target: 'comps' }));
        check(
            'revert restores comp name',
            state &&
                state.items.some(function (item) {
                    return item.itemId === compId && item.name === 'live-mcp';
                }),
            state,
        );
    });
    await section('recovery', async function () {
        if (!savedPath) {
            savedPath = path.join(os.tmpdir(), 'ae-mcp-live', 'recovery-' + Date.now() + '.aep');
            fs.mkdirSync(path.dirname(savedPath), { recursive: true });
            const saved = parsedExecContent(
                await call('ae_exec', {
                    code: 'app.project.save(new File(' + JSON.stringify(savedPath)
                        + '));({ok:true,path:app.project.file.fsName})',
                }),
            );
            check('recovery saves disposable project', saved && saved.ok && saved.path, saved);
        }
        const explicit = value(await call('ae_checkpoint', { action: 'create', label: 'recovery-live' }));
        check('recovery explicit checkpoint', explicit && explicit.ok, explicit);
        const before = value(await call('ae_read', { target: 'layers', comp: { id: compId } }));
        const baseLayers = before && before.total;
        const script = [
            'var c=AEMCP.compById(' + JSON.stringify(Number(compId)) + '),l=c.layers.addSolid([0,1,0],"Recovery Solid",80,80,1);',
            'l.property("ADBE Transform Group").property("ADBE Opacity").setValue(42);({ok:true,layers:c.numLayers});',
            'throw new Error("recovery-live");',
        ].join('\n');
        const firstReply = await call('ae_exec', {
            code: script,
            checkpoint_label: 'before-recovery-live',
            undo_group_name: 'Recovery live',
        });
        const first = value(firstReply);
        const touchedLayer = first && first.touched && first.touched.layersAdded
            && first.touched.layersAdded.some(function (layer) {
                return layer.name === 'Recovery Solid';
            });
        check('recovery failure envelope', firstReply.isError
            && /^[a-z0-9]{6}$/.test(first.recoveryId)
            && fs.existsSync(first.scriptPath)
            && fs.readFileSync(first.scriptPath, 'utf8') === script
            && first.errorLine === 3
            && first.errorSource === 'throw new Error("recovery-live");'
            && first.touched
            && first.touched.level === 'layer_diff'
            && touchedLayer, first);
        const fixed = script.split('\n').slice(0, 2).join('\n');
        fs.writeFileSync(first.scriptPath, fixed, 'utf8');
        const restored = value(await call('ae_exec', { recoveryId: first.recoveryId }));
        const restoredLayers = value(await call('ae_read', { target: 'layers', comp: { id: compId } }));
        check('recovery default restores before retry', restored && restored.ok
            && restored.restored === 'checkpoint'
            && restoredLayers && restoredLayers.total === baseLayers + 1,
        { restored, layers: restoredLayers && restoredLayers.total, baseLayers });

        const secondReply = await call('ae_exec', {
            code: script,
            checkpoint_label: 'before-recovery-continue',
            undo_group_name: 'Recovery continue live',
        });
        const second = value(secondReply);
        fs.writeFileSync(second.scriptPath, fixed, 'utf8');
        const continued = value(await call('ae_exec', {
            recoveryId: second.recoveryId,
            retryMode: 'continue',
        }));
        const continuedLayers = value(await call('ae_read', { target: 'layers', comp: { id: compId } }));
        check('recovery continue preserves failed state', continued && continued.ok
            && continued.restored === 'skipped'
            && continuedLayers && continuedLayers.total === baseLayers + 3,
        { continued, layers: continuedLayers && continuedLayers.total, baseLayers });

        for (let i = 0; i < 20; i += 1) {
            await call('ae_exec', { code: '"snapshot-clean-' + i + '"' });
        }
        const token = fs.readFileSync(path.join(os.homedir(), '.ae-mcp', 'auth-token'), 'utf8').trim();
        const cleanupResponse = await fetch(hostUrl + '/exec', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-ae-mcp-token': token,
                'x-ae-mcp-client': 'ae-mcp-live',
            },
            body: JSON.stringify({
                code: 'JSON.stringify({writelnNative:String($.writeln).indexOf("[native code]")>=0&&String($.writeln).indexOf("__aemcp")<0})',
            }),
        });
        const cleanupEnvelope = await cleanupResponse.json();
        const cleanup = cleanupEnvelope.ok && cleanupEnvelope.resultType === 'string'
            ? JSON.parse(cleanupEnvelope.result) : null;
        check('recovery diagnostics restore writeln', cleanupResponse.ok
            && cleanup && cleanup.writelnNative === true, { cleanupEnvelope, cleanup });
    });
    await section('validateExpressions', async function () {
        const setup = parsedExecContent(
            await call('ae_exec', {
                code: 'var c=AEMCP.compById(' + JSON.stringify(Number(compId)) + '); var bad=c.layers.addSolid([1,1,1],"bad",10,10,1); bad.property("ADBE Transform Group").property("ADBE Opacity").expression="thisIsNotDefined"; var good=c.layers.addSolid([1,1,1],"good",10,10,1); good.property("ADBE Transform Group").property("ADBE Opacity").expression="time*0+100"; ({ok:true})',
            }),
        );
        const checked = value(
            await call('ae_validateExpressions', { comp_id: compId, prop: 'Opacity', sample_times: [0, 1] }),
        );
        check('validate setup', setup && setup.ok, setup);
        check(
            'validate captures bad expression and permits locale-safe expression',
            checked &&
                checked.errors.some(function (item) {
                    return item.layerName === 'bad';
                }) &&
                checked.expressions.some(function (item) {
                    return item.layerName === 'good' && !item.expressionError;
                }),
            checked,
        );
    });
    await section('toolLibrary', async function () {
        const index = value(await call('ae_toolSearch', {}));
        check(
            'toolSearch index lists bundled skills',
            index && index.ok && Array.isArray(index.artifacts)
                && index.artifacts.some(function (a) { return a.id === 'builtin:skill:ae-execution-guide'; }),
            index && { count: index.artifacts && index.artifacts.length },
        );
        const found = value(await call('ae_toolSearch', { query: 'glow' }));
        check(
            'toolSearch query finds glow-recipes',
            found && found.ok && found.artifacts.some(function (a) { return a.name === 'glow-recipes'; }),
            found && { total: found.total },
        );
        const inspected = value(await call('ae_toolSearch', { name: 'builtin:skill:extendscript-cookbook' }));
        check(
            'toolSearch inspect returns full verified artifact',
            inspected && inspected.ok && inspected.artifact
                && typeof inspected.artifact.content === 'string' && inspected.artifact.verified === true,
            inspected && { kind: inspected.artifact && inspected.artifact.kind },
        );
        const missing = await call('ae_toolUse', { name: 'user:00000000-0000-4000-8000-000000000000' });
        check('toolUse missing tool is clean error', missing.isError && value(missing).ok === false, value(missing));
        const skills = value(await call('ae_skillUse', {}));
        check(
            'skillUse lists bundled skills',
            skills && skills.ok && Array.isArray(skills.skills) && skills.skills.length >= 8,
            skills && { count: skills.skills && skills.skills.length },
        );
        const rendered = value(await call('ae_skillUse', { name: 'ae-execution-guide' }));
        check(
            'skillUse renders the prompt skill',
            rendered && rendered.ok && rendered.template_type === 'prompt'
                && typeof rendered.rendered === 'string' && rendered.rendered.length > 200,
            rendered && { length: rendered.rendered && rendered.rendered.length },
        );
        // End-to-end execute: throwaway user skill in the real skill dir, removed afterwards.
        // JSX template values are JSON-encoded on render, so ${marker} must not be quoted.
        const skillDir = path.join(os.homedir(), '.ae-mcp', 'skills');
        const probePath = path.join(skillDir, 'aemcp-live-probe.json');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(probePath, JSON.stringify({
            name: 'aemcp-live-probe',
            description: 'throwaway live acceptance probe',
            template_type: 'jsx',
            template: 'JSON.stringify({ok:true,marker:${marker},ae:String(app.version)})',
            args_schema: { marker: { type: 'string' } },
        }, null, 2) + '\n');
        try {
            const executed = value(await call('ae_skillUse', {
                name: 'aemcp-live-probe', execute: true, args: { marker: 'p2b1' },
            }));
            check(
                'skillUse executes a user jsx skill end-to-end',
                executed && executed.ok === true && executed.marker === 'p2b1'
                    && /\d/.test(String(executed.ae)),
                executed,
            );
        } finally {
            fs.rmSync(probePath, { force: true });
        }
    });
    await section('conversation', async function () {
        if (noCdp) {
            console.log('SKIP conversation (--no-cdp)');
            return;
        }
        const server = 'window.cep_node.require(' + JSON.stringify(extensionRoot + '/host/server.js') + ')';
        const convo = JSON.parse(
            await cdp(
                'JSON.stringify(' +
                    server +
                    '.mcp.conversations.create({label:"live",policy:{approvalTier:"readonly"}}))',
            ),
        );
        const linked = await connect(hostUrl + convo.path, 'live-conversation');
        const denied = await linked.client.callTool({ name: 'ae_checkpoint', arguments: { action: 'list' } });
        check('conversation readonly denies checkpoint', denied.isError, value(denied));
        await cdp(
            server + '.mcp.conversations.update(' + JSON.stringify(convo.id) + ',{approvalTier:"none"})',
        );
        const allowed = value(
            await linked.client.callTool({ name: 'ae_exec', arguments: { code: '"allowed"' } }),
        );
        check('conversation update none', allowed && allowed.content === 'allowed', allowed);
        await linked.transport.close();
        await cdp(server + '.mcp.conversations.close(' + JSON.stringify(convo.id) + ')');
    });
    if (selected.includes('conversation') && !noCdp)
        try {
            const server =
                'window.cep_node.require(' + JSON.stringify(extensionRoot + '/host/server.js') + ')';
            const manual = JSON.parse(
                await cdp(
                    'JSON.stringify(' +
                        server +
                        '.mcp.conversations.create({label:"live-manual",policy:{approvalTier:"manual"}}))',
                ),
            );
            const linked = await connect(hostUrl + manual.path, 'live-manual');
            const pendingAccept = linked.client.callTool({
                name: 'ae_exec',
                arguments: { code: '"manual-accept"' },
            });
            let pending = [];
            for (let i = 0; i < 40 && !pending.length; i += 1) {
                await new Promise(function (resolve) {
                    setTimeout(resolve, 100);
                });
                pending = JSON.parse(await cdp('JSON.stringify(' + server + '.mcp.approvals.list())'));
            }
            check(
                'conversation manual queues approval',
                pending.length === 1 && pending[0].tool === 'ae_exec',
                pending[0],
            );
            await cdp(
                'JSON.stringify(' +
                    server +
                    '.mcp.approvals.resolve(' +
                    JSON.stringify(pending[0] && pending[0].id) +
                    ',"accept"))',
            );
            const accepted = value(await pendingAccept);
            check('conversation manual accept', accepted && accepted.content === 'manual-accept', accepted);
            const pendingDecline = linked.client.callTool({
                name: 'ae_exec',
                arguments: { code: '"manual-decline"' },
            });
            pending = [];
            for (let i = 0; i < 40 && !pending.length; i += 1) {
                await new Promise(function (resolve) {
                    setTimeout(resolve, 100);
                });
                pending = JSON.parse(await cdp('JSON.stringify(' + server + '.mcp.approvals.list())'));
            }
            await cdp(
                'JSON.stringify(' +
                    server +
                    '.mcp.approvals.resolve(' +
                    JSON.stringify(pending[0] && pending[0].id) +
                    ',"decline"))',
            );
            const declined = await pendingDecline;
            check(
                'conversation manual decline',
                declined.isError && value(declined).error === 'User denied this action.',
                value(declined),
            );
            const external = value(await call('ae_exec', { code: '"external-unaffected"' }));
            check(
                'external session unaffected',
                external && external.content === 'external-unaffected',
                external,
            );
            await cdp(server + '.mcp.conversations.close(' + JSON.stringify(manual.id) + ')');
            let closed = false;
            try {
                await linked.client.callTool({ name: 'ae_status', arguments: {} });
            } catch (error) {
                closed = true;
            }
            check('conversation close invalidates session', closed);
            await linked.transport.close();
            let unknown = false;
            try {
                await connect(hostUrl + '/mcp/c/deadbeef', 'unknown');
            } catch (error) {
                unknown = true;
            }
            check('unknown conversation token fails', unknown);
        } catch (error) {
            check('conversation manual/CDP', false, String((error && error.message) || error));
        }
    await section('perf', async function () {
        const script = fs.readFileSync(new URL('../../mcp/tools/read.perf.jsx', import.meta.url), 'utf8');
        const perf = parsedExecContent(await call('ae_exec', { code: script, timeout_sec: 300 }));
        check('perf fixture', perf && perf.ok, perf);
        const perfComps = value(await call('ae_read', { target: 'comps', filter: { nameContains: 'ae_read_perf' } }));
        const perfComp = perfComps && perfComps.items && perfComps.items[0] ? perfComps.items[0].itemId : null;
        check('perf comp found via ae_read comps', Boolean(perfComp), perfComps);
        const begin = Date.now();
        const out = value(
            await call('ae_read', { target: 'layers', comp: { id: perfComp }, page: { limit: 200 } }),
        );
        const ms = Date.now() - begin;
        check('perf ae_read layers ok and under 5s', out && out.total === 300 && out.returned === 200 && ms < 5000, { ms, total: out && out.total, returned: out && out.returned });
    });
}
main()
    .catch(function (error) {
        check('runner', false, String((error && error.stack) || error));
    })
    .finally(async function () {
        if (client) {
            const code = keepAe
                ? 'app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); "closed"'
                : 'app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.quit(); "bye"';
            await call('ae_exec', { code, timeout_sec: 10 }).catch(function () {});
        }
        if (transport) await transport.close().catch(function () {});
        if (savedPath)
            try {
                fs.rmSync(path.dirname(savedPath), { recursive: true, force: true });
            } catch (error) {}
        const failed = results.filter(function (item) {
            return !item.passed;
        }).length;
        console.log(results.length - failed + '/' + results.length + ' passed');
        process.exitCode = failed ? 1 : 0;
    });
