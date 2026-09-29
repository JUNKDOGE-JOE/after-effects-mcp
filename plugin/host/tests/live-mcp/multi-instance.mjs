import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import png from '../../mcp/png.js';

const argv = process.argv.slice(2);
if (!argv.includes('--run') || !argv.includes('--validation-root')) {
    console.log('Usage: node tests/live-mcp/multi-instance.mjs --run --validation-root <absolute directory> [--url <primary /mcp URL>]');
    console.log('Requires an empty disposable primary. Creates only its owned fixture; a failed run is retained for reconciliation.');
    process.exit(0);
}
const validationRoot = argv[argv.indexOf('--validation-root') + 1];
assert.ok(path.isAbsolute(validationRoot || ''), 'an absolute validation root is required');
const active = path.join(validationRoot, 'active', 'multi-instance');
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://127.0.0.1:11488/mcp';
assert.ok(!fs.existsSync(active), 'reconcile and archive the previous active fixture before retrying');
fs.mkdirSync(active, { recursive: true });
const evidence = { validationProfile: 'development', candidateRun: false, candidateEvidence: false,
    lifecycle: 'ephemeral-validation', requests: [], cases: [], workerSamples: [], guideObservations: [], fixture: { active }, completed: false };
const fileA = path.join(active, 'A.aep');
const fileB = path.join(active, 'B.aep');
let sessionId;
let requestId = 0;
let contextA;
let contextB;
let instanceB;
let job;
let unknownWrite = false;

function errorDetails(error) {
    return { error: error.message, code: error.code || null, disposition: error.disposition || null,
        layer: error.layer || 'assertion', requestId: error.requestId || null };
}
async function rpc(method, params) {
    const message = { jsonrpc: '2.0', id: ++requestId, method, params };
    const record = { request: message, started: Date.now() };
    evidence.requests.push(record);
    try {
        const response = await fetch(url, { method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        }, body: JSON.stringify(message), signal: AbortSignal.timeout(180000) });
        sessionId = response.headers.get('mcp-session-id') || sessionId;
        record.httpStatus = response.status;
        const raw = await response.text();
        const events = response.headers.get('content-type')?.includes('text/event-stream');
        const payload = JSON.parse(events ? raw.split('\n').filter(line => line.startsWith('data: ')).at(-1).slice(6) : raw);
        record.response = payload;
        if (!response.ok || payload.error) throw Object.assign(new Error(JSON.stringify(payload.error || payload)),
            { layer: 'mcp-protocol', code: payload.error?.code });
        return payload.result;
    } catch (error) {
        error.layer ||= 'transport';
        error.requestId = message.id;
        record.failure = errorDetails(error);
        throw error;
    } finally { record.ended = Date.now(); }
}
async function call(name, args) {
    const reply = await rpc('tools/call', { name, arguments: args });
    const result = reply?.structuredContent;
    if (reply?.isError || !result || result.ok === false) {
        throw Object.assign(new Error(JSON.stringify(result || reply)), { layer: 'public-mcp', tool: name,
            code: result?.code, disposition: result?.disposition, requestId,
            saveCompleted: result?.saveCompleted === true });
    }
    return result;
}
async function exec(contextId, code, extra = {}) {
    const result = await call('ae_exec', { context_id: contextId, code, ...extra });
    return JSON.parse(result.content);
}
async function check(name, work, { writes = false, requires = true, dependency = '' } = {}) {
    const firstRequest = requestId + 1;
    const state = { reconciled: false };
    const entry = { name, requestIds: [], sideEffects: writes ? 'not-started' : 'read-only' };
    evidence.cases.push(entry);
    if (!requires) {
        Object.assign(entry, { status: 'BLOCKED', dependency });
        return { ok: false };
    }
    try {
        const value = await work(state);
        Object.assign(entry, { status: 'PASS', sideEffects: writes ? 'reconciled' : 'read-only' });
        return { ok: true, value };
    } catch (error) {
        const notStarted = ['not_dispatched', 'not-started', 'not_started'].includes(error.disposition);
        const unresolved = writes && !state.reconciled && !notStarted;
        const uncertain = unresolved || ['uncertain', 'indeterminate'].includes(error.disposition);
        Object.assign(entry, errorDetails(error), { status: uncertain ? 'INDETERMINATE' : 'FAIL',
            sideEffects: unresolved ? 'unreconciled' : state.reconciled ? 'reconciled' : error.saveCompleted ? 'save-completed' : writes ? 'not-started' : 'read-only',
            stateReconciliation: state.reconciled ? 'verified' : unresolved ? 'required' : 'not-required' });
        if (unresolved) { unknownWrite = true; throw error; }
        return { ok: false };
    } finally {
        entry.requestIds = evidence.requests.filter(item => item.request.id >= firstRequest).map(item => item.request.id);
        console.log(JSON.stringify({ case: name, status: entry.status }));
    }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function pixel(frame, x, y) {
    const image = png.decodeRgba(fs.readFileSync(frame.path));
    const offset = (Math.floor(y * image.height / 72) * image.width + Math.floor(x * image.width / 128)) * 4;
    return Array.from(image.rgba.slice(offset, offset + 3));
}
function recordGuide(frame, source) {
    const rgb = pixel(frame, 24, 36);
    const visible = rgb.every((value, index) => value === [255, 0, 0][index]);
    evidence.guideObservations.push({ source, rgb, expectedIfIncluded: [255, 0, 0],
        status: visible ? 'observed' : 'accepted-limitation',
        note: 'Guide output is observational; the runner does not adjust guideLayer or visibility before preview.' });
}
function collectAeps(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) collectAeps(file, files);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.aep') {
            const relative = path.relative(active, file);
            const role = [fileA, fileB].includes(file) ? 'primary-fixture'
                : relative.split(path.sep).includes('checkpoints') ? 'checkpoint'
                    : entry.name === 'snapshot.aep' ? 'worker-snapshot' : 'other';
            files.push({ path: file, role, sizeBytes: fs.statSync(file).size });
        }
    }
    return files;
}

try {
    let primary;
    const setup = await check('connect and verify the empty disposable primary', async () => {
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'multi-instance-hdev', version: '1' } });
        const listed = await call('ae_instances', { action: 'list' });
        primary = listed.instances.find(record => record.endpoint === url && record.state === 'running');
        assert.ok(primary, 'the selected primary must be registered');
        contextA = (await call('ae_workspace', { action: 'bind', instance_id: primary.instanceId, access: 'write', work_dir: active })).context_id;
        const initial = await call('ae_workspace', { action: 'inspect', context_id: contextA });
        const contents = await call('ae_read', { context_id: contextA, target: 'project' });
        assert.ok(!initial.project.projectPath && contents.total === 0, 'refusing to replace a nonempty or saved user project');
    });
    if (!setup.ok) throw new Error('primary preflight failed');
    let comps;
    const built = await check('build and save the disposable fixture', async state => {
        comps = await exec(contextA,
            'var p=app.project;if(p.file||p.numItems)throw new Error("not empty");p.bitsPerChannel=8;'
            + 'var c=p.items.addComp("GuidePreview",128,72,1,1,24);c.resolutionFactor=[1,1];'
            + 'c.layers.addSolid([0,0,0],"Background",128,72,1);'
            + 'var b=c.layers.addSolid([0,0,1],"Content",24,24,1);b.position.setValue([90,36]);'
            + 'var g=c.layers.addSolid([1,0,0],"Visible guide",24,24,1);g.position.setValue([24,36]);g.guideLayer=true;'
            + 'var d=p.items.addComp("SecondComp",128,72,1,1,24);d.layers.addSolid([0,1,0],"Green",128,72,1);'
            + 'p.save(new File(' + JSON.stringify(fileA) + '));if(!p.file.copy(' + JSON.stringify(fileB) + '))throw new Error("fixture copy failed");'
            + '({comp:String(c.id),other:String(d.id),path:p.file.fsName})');
        assert.equal(path.resolve(comps.path), path.resolve(fileA));
        assert.ok(fs.existsSync(fileA) && fs.existsSync(fileB));
        state.reconciled = true;
    }, { writes: true });
    const bound = await check('bind the saved fixture', async () => {
        contextA = (await call('ae_workspace', { action: 'bind', instance_id: primary.instanceId, access: 'write', work_dir: active, project_path: fileA })).context_id;
    }, { requires: built.ok, dependency: 'fixture creation' });
    await check('single writer rejects a second write context', async () => {
        const denied = await rpc('tools/call', { name: 'ae_workspace', arguments: { action: 'bind', instance_id: primary.instanceId, access: 'write', work_dir: active } });
        assert.equal(denied.structuredContent.code, 'WORKSPACE_BUSY');
    }, { requires: bound.ok, dependency: 'saved fixture binding' });
    await check('native preview includes ordinary content and records Guide output', async () => {
        const before = await call('ae_previewFrame', { context_id: contextA, comp_id: comps.comp, time: 0 });
        assert.equal(before.compId, comps.comp);
        recordGuide(before.frames[0], { mode: 'live', instance_id: primary.instanceId });
        assert.deepEqual(pixel(before.frames[0], 90, 36), [0, 0, 255]);
    }, { requires: bound.ok, dependency: 'saved fixture binding' });
    let checkpoint;
    let snapshotUsable = false;
    await check('checkpoint uses the declared storage branch and preserves the original path', async state => {
        const adjacent = ['Adobe After Effects Auto-Save', '自动保存']
            .map(name => path.join(path.dirname(fileA), name))
            .find(directory => fs.existsSync(directory) && fs.statSync(directory).isDirectory());
        const hasAdjacent = Boolean(adjacent);
        checkpoint = await call('ae_checkpoint', { context_id: contextA, action: 'create', label: 'multi-instance-hdev' });
        assert.equal(path.resolve((await call('ae_workspace', { action: 'inspect', context_id: contextA })).project.projectPath), path.resolve(fileA));
        assert.ok(fs.statSync(checkpoint.path).isFile() && fs.statSync(checkpoint.path).size > 0);
        snapshotUsable = true;
        state.reconciled = true;
        assert.equal(checkpoint.placementSource, hasAdjacent ? 'adjacent-auto-save' : 'session-workdir');
        assert.equal(path.dirname(path.dirname(path.resolve(checkpoint.path))), path.join(hasAdjacent ? adjacent : active, 'ae-mcp', 'checkpoints'));
    }, { writes: true, requires: bound.ok, dependency: 'saved fixture binding' });
    const submitted = await check('submit both readonly snapshot preview tasks', async () => {
        job = await call('ae_readJob', { context_id: contextA, action: 'submit', checkpoint_id: checkpoint.id,
            requests: [{ id: 'guide', tool: 'ae_previewFrame', arguments: { comp_id: comps.comp, time: 0 } },
                { id: 'second', tool: 'ae_previewFrame', arguments: { comp_id: comps.other, time: 0 } }] });
    }, { requires: snapshotUsable, dependency: 'verified checkpoint' });
    await check('readonly job reaches a successful terminal state', async () => {
        const deadline = Date.now() + 180000;
        let status;
        do {
            await wait(500);
            status = await call('ae_readJob', { context_id: contextA, action: 'status', job_id: job.job_id });
            const instances = (await call('ae_instances', { action: 'list' })).instances;
            evidence.workerSamples.push({ at: Date.now(), instances: instances.filter(item => item.role === 'worker' && item.ownerInstanceId === primary.instanceId) });
        } while (['queued', 'running', 'cancel_requested'].includes(status.state) && Date.now() < deadline);
        evidence.job = status;
        assert.equal(status.state, 'completed', JSON.stringify(status));
    }, { requires: submitted.ok, dependency: 'read job submission' });
    const results = [];
    for (const [index, id, compId, sample, color] of [
        [0, 'guide', comps?.comp, [90, 36], [0, 0, 255]],
        [1, 'second', comps?.other, [64, 36], [0, 255, 0]],
    ]) {
        await check('snapshot result ' + id + ' has the correct pixels and provenance', async () => {
            const page = await call('ae_readJob', { context_id: contextA, action: 'result', job_id: job.job_id, offset: index, limit: 1 });
            const entry = page.results[0];
            results[index] = entry;
            assert.equal(entry.id, id);
            assert.equal(entry.status, 'completed', JSON.stringify(entry));
            assert.equal(entry.source.checkpoint_id, checkpoint.id);
            assert.equal(entry.source.realtime, false);
            assert.equal(entry.result.compId, compId);
            assert.equal(entry.result.frames[0].time, 0);
            assert.deepEqual(pixel(entry.result.frames[0], ...sample), color);
            if (id === 'guide') recordGuide(entry.result.frames[0], entry.source);
        }, { requires: submitted.ok, dependency: 'read job submission' });
    }
    await check('both workers actually execute a snapshot task', async () => {
        const indices = results.map(entry => entry.worker_index);
        assert.ok(indices.every(Number.isInteger));
        assert.equal(new Set(indices).size, 2, 'one worker executed both tasks; two-worker execution was not demonstrated');
        const instances = new Map(evidence.workerSamples.flatMap(sample => sample.instances).map(record => [record.instanceId, record]));
        evidence.workers = { indices, instances: Array.from(instances.values()) };
        assert.ok(instances.size >= 2, 'two distinct owned worker instances were not observed');
    }, { requires: results.length === 2 && results.every(entry => entry?.status === 'completed'), dependency: 'two completed per-task results' });
    const second = await check('start and bind the second primary fixture', async state => {
        instanceB = (await call('ae_instances', { action: 'start', project_path: fileB, work_dir: active })).instance_id;
        const deadline = Date.now() + 120000;
        let ready;
        do { await wait(500); ready = (await call('ae_instances', { action: 'list' })).instances.find(record => record.instanceId === instanceB); }
        while (ready && ready.state === 'starting' && Date.now() < deadline);
        assert.equal(ready?.state, 'running', 'second primary must load its CEP and register');
        contextB = (await call('ae_workspace', { action: 'bind', instance_id: instanceB, access: 'write', work_dir: active, project_path: fileB })).context_id;
        state.reconciled = true;
    }, { writes: true, requires: built.ok, dependency: 'saved B fixture' });
    await check('one MCP connection routes two live projects independently', async () => {
        const reads = await Promise.allSettled([call('ae_read', { context_id: contextA, target: 'comps' }), call('ae_read', { context_id: contextB, target: 'comps' })]);
        for (const result of reads) if (result.status === 'rejected') throw result.reason;
        assert.equal(reads[0].value.execution_source.instance_id, primary.instanceId);
        assert.equal(reads[1].value.execution_source.instance_id, instanceB);
    }, { requires: bound.ok && second.ok, dependency: 'both primary bindings' });
    await check('real write and Undo preserve the fixture baseline', async state => {
        await exec(contextB, 'app.project.itemByID(' + comps.comp + ').name="UndoProbe";({ok:true})', { undo_group_name: 'multi-instance-write' });
        const changed = await call('ae_read', { context_id: contextB, target: 'comps' });
        assert.equal(changed.items.find(item => item.itemId === comps.comp)?.name, 'UndoProbe');
        await exec(contextB, 'app.executeCommand(16);({ok:true})');
        const restored = await call('ae_read', { context_id: contextB, target: 'comps' });
        assert.equal(restored.items.find(item => item.itemId === comps.comp)?.name, 'GuidePreview');
        state.reconciled = true;
    }, { writes: true, requires: second.ok, dependency: 'second primary binding' });
} catch (error) {
    evidence.cases.push({ name: 'remaining dependent cases', status: 'BLOCKED', ...errorDetails(error),
        dependency: unknownWrite ? 'unreconciled write: sweep stopped' : 'failed setup prerequisite' });
} finally {
    try {
        if (!unknownWrite && job && ['queued', 'running', 'cancel_requested'].includes(evidence.job?.state)) {
            await check('cancel outstanding readonly job', () => call('ae_readJob', { context_id: contextA, action: 'cancel', job_id: job.job_id }));
        }
        if (!unknownWrite && instanceB) {
            const released = contextB ? await check('release the second fixture writer', () => call('ae_workspace', { action: 'release', context_id: contextB })) : { ok: true };
            await check('request shutdown of the owned second primary', async state => {
                const result = await call('ae_instances', { action: 'stop', instance_id: instanceB, save_policy: 'discard' });
                assert.equal(result.stopRequested, true);
                state.reconciled = true;
            }, { writes: true, requires: released.ok, dependency: 'second writer release' });
        }
    } catch (error) { evidence.cleanupError = errorDetails(error); }
    finally {
        try {
            const files = collectAeps(active);
            evidence.fixture.files = files;
            evidence.fixture.created = files.some(file => file.role === 'primary-fixture');
            evidence.fixture.aepCounts = { present: files.length,
                primaryFixtures: files.filter(file => file.role === 'primary-fixture').length,
                checkpoints: files.filter(file => file.role === 'checkpoint').length,
                workerSnapshots: files.filter(file => file.role === 'worker-snapshot').length,
                unclassified: files.filter(file => file.role === 'other').length, archivedByRunner: 0 };
            evidence.fixture.presentBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
        } catch (error) { evidence.fixture.inventoryError = error.message; }
        evidence.fixture.retention = 'active until explicit state reconciliation and recoverable archival';
        evidence.completed = !unknownWrite && !evidence.cleanupError && !evidence.fixture.inventoryError
            && evidence.cases.length > 0 && evidence.cases.every(item => item.status === 'PASS');
        const evidencePath = path.join(active, 'evidence.json');
        try { fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); }
        catch (error) { evidence.completed = false; console.error(JSON.stringify({ evidenceWriteError: error.message, evidence })); }
        console.log(JSON.stringify({ completed: evidence.completed, evidence: evidencePath, cases: evidence.cases, aepCounts: evidence.fixture.aepCounts }));
        process.exitCode = evidence.completed ? 0 : 1;
    }
}
