'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { InstanceRegistry, normalizeProjectPath } = require('./instance-registry');
const { createInstanceLauncher } = require('./instance-launcher');
const { WorkspaceManager } = require('./mcp/workspaces');
const { WorkspaceRouter, contextInstanceId, failure } = require('./mcp/workspace-router');
const { parseJsxResult } = require('./mcp/jsx-result');
const { enforce } = require('./mcp/approval-gate');
const { textResult } = require('./mcp/tool-result');
const { PRIMITIVES } = require('./mcp/native-program');

const PROJECT_READ = '(function(){var p=app.project;var root=p.rootFolder;var s=$.global.__aemcpObservedProject;var valid=false;'
    + 'try{valid=!!s&&(typeof isValid==="function"?isValid(s.root):true)&&s.root.id===root.id&&p.revision>=s.revision;}catch(e){}'
    + 'if(!valid){var n=($.global.__aemcpProjectSerial||0)+1;$.global.__aemcpProjectSerial=n;'
    + 's={root:root,generation:n,revision:p.revision};$.global.__aemcpObservedProject=s;}s.revision=p.revision;'
    + 'return JSON.stringify({projectPath:p.file?p.file.fsName:null,projectGeneration:s.generation,revision:p.revision,dirty:p.dirty,numItems:p.numItems});}())';

function changesProject(name, args) {
    if (['ae_exec', 'ae_execRecover', 'ae_revert', 'ae_toolUse'].includes(name)) return true;
    if (name === 'ae_checkpoint') return args.action === 'create';
    if (name === 'ae_skillUse') return args.execute === true;
    if (name === 'ae_nativeExec') return !Array.isArray(args.operations) || args.operations.some(operation => {
        const primitive = PRIMITIVES.find(value => value.id === operation.op);
        return !primitive || primitive.mutability !== 'read';
    });
    return false;
}

function projectTool(name, args) {
    return !['ae_instances', 'ae_workspace', 'ae_toolSearch', 'ae_toolSave'].includes(name)
        && !(name === 'ae_skillUse' && args.execute !== true);
}

function publicContext(value) {
    if (!value) return null;
    return { context_id: value.contextId, workspace_id: value.workspaceId, instance_id: value.instanceId,
        access: value.access, work_dir: value.workDir, project_path: value.projectPath, valid: value.valid };
}

function createInstanceService(options) {
    const input = options || {};
    const registry = input.registry || new InstanceRegistry({ statePaths: input.statePaths,
        minFreeMemoryBytes: 2 * 1024 * 1024 * 1024, workerEstimateBytes: 1024 * 1024 * 1024 });
    const launcher = input.launcher || createInstanceLauncher();
    const router = new WorkspaceRouter(registry, input.routerOptions);
    let instanceId = input.instanceId || 'ae_' + crypto.randomBytes(16).toString('hex');
    let expectedProject = input.projectPath;
    const cepPid = input.executeJsx ? (input.cepPid === undefined ? process.pid : input.cepPid) : null;
    let replacesInstanceId = null;
    if (registry.file) {
        try {
            const records = JSON.parse(fs.readFileSync(registry.file, 'utf8')).instances;
            const disconnected = typeof registry.canReattach === 'function' && input.executeJsx
                ? records.find(record => registry.canReattach(record, { pid: input.aePid, cepPid })) : null;
            if (disconnected || records.some(record => record.instanceId === instanceId && record.state === 'closed')) {
                replacesInstanceId = disconnected ? disconnected.instanceId : null;
                instanceId = 'ae_' + crypto.randomBytes(16).toString('hex');
                expectedProject = undefined;
            }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const defaults = new Map();
    const ownerClosedPath = registry.root ? path.join(registry.root, instanceId + '.closed') : null;
    const observations = new Map();
    const reconciliations = new Map();
    let accepting = true;
    let registered = false;
    let info = { instanceId, workspaceId: null, workDir: input.workDir || null, aePid: input.aePid || null, cepPid, role: 'primary' };
    let knownProject = undefined;
    let jobs = null;
    let closePromise = null;

    async function readProject() {
        if (!input.executeJsx) throw failure('PROJECT_UNAVAILABLE', 'No AE is attached to this connector.');
        const reply = await input.executeJsx({ code: PROJECT_READ, timeoutMs: 10000,
            nativeProjectGraphEffect: 'preserve', client: 'instance-service/internal' });
        const payload = reply && reply.payload;
        if (!payload || payload.ok === false) throw failure('PROJECT_UNAVAILABLE', 'The selected AE did not report its current project.');
        const project = parseJsxResult(payload.result);
        if (!project || project.projectPath === undefined) throw failure('PROJECT_UNAVAILABLE', 'Invalid AE project response.');
        if (registered && knownProject !== project.projectPath) {
            await registry.update(instanceId, { projectPath: project.projectPath });
            knownProject = project.projectPath;
        }
        return project;
    }

    const workspaces = input.executeJsx ? new WorkspaceManager({ instanceId, readProject }) : null;

    async function publish(endpoint) {
        let project = await readProject();
        // CEP may restore before a PID-targeted bootstrap opens the ticket's project.
        // Wait only on a pristine empty project; never open it ourselves or accept a mismatch.
        for (let attempt = 0; expectedProject && project.projectPath === null
            && project.dirty === false && project.numItems === 0 && attempt < 60; attempt += 1) {
            if (!accepting) throw failure('STARTUP_ABORTED', 'Panel closed during project startup.');
            await (input.startupWait || (() => new Promise(resolve => setTimeout(resolve, 500))))();
            if (!accepting) throw failure('STARTUP_ABORTED', 'Panel closed during project startup.');
            project = await readProject();
        }
        if (!accepting) throw failure('STARTUP_ABORTED', 'Panel closed during project startup.');
        if (expectedProject && normalizeProjectPath(expectedProject) !== normalizeProjectPath(project.projectPath)) {
            await registry.update(instanceId, { state: 'unknown', reason: 'startup-project-mismatch' }).catch(() => {});
            throw failure('STARTUP_PROJECT_MISMATCH', 'AE opened a different project than the requested startup ticket.');
        }
        const record = await registry.register({ instanceId, role: 'primary', endpoint,
            pid: info.aePid, cepPid: info.cepPid, projectPath: project.projectPath, workspaceId: workspaces.workspaceId,
            ...(replacesInstanceId ? { replacesInstanceId } : {}) });
        replacesInstanceId = null;
        registered = true;
        knownProject = project.projectPath;
        info = Object.assign({}, info, { endpoint, workspaceId: workspaces.workspaceId, projectPath: project.projectPath });
        return record;
    }

    function configure(patch) {
        if (patch.workDir !== undefined) {
            if (patch.workDir !== null) normalizeProjectPath(patch.workDir);
            info.workDir = patch.workDir;
        }
        if (patch.aePid !== undefined) info.aePid = patch.aePid;
    }

    async function target(args) {
        const id = args.instance_id || contextInstanceId(args.context_id);
        if (id) return id;
        if (args.project_path) {
            const key = normalizeProjectPath(args.project_path);
            const matches = (await registry.list()).filter(record => record.role === 'primary' && record.projectKey === key);
            if (matches.length !== 1) throw failure('INSTANCE_REQUIRED', 'Select exactly one registered primary for this project.');
            return matches[0].instanceId;
        }
        if (workspaces) return instanceId;
        throw failure('INSTANCE_REQUIRED', 'Select a registered instance or project explicitly.');
    }

    async function workspace(action, args, context) {
        if (!accepting) throw failure('WORKSPACE_CLOSED', 'The owner panel was closed.');
        const selected = await target(args);
        if (!accepting) throw failure('WORKSPACE_CLOSED', 'The owner panel stopped accepting work.');
        if (selected !== instanceId || !workspaces) {
            return { forwarded: await router.call(selected, { name: 'ae_workspace', arguments: args }) };
        }
        let value;
        if (action === 'bind') {
            value = await workspaces.bind({ access: args.access || 'read', workDir: args.work_dir === undefined ? info.workDir : args.work_dir,
                projectPath: args.project_path, contextId: args.context_id });
            if (context && context.session) context.session.workContextId = value.contextId;
            await registry.update(instanceId, { workspaceId: value.workspaceId, projectPath: value.projectPath });
            info.workspaceId = value.workspaceId;
            return Object.assign({ ok: true }, publicContext(value));
        }
        if (action === 'inspect') {
            const state = workspaces.inspect(args.context_id);
            return { ok: true, instance_id: instanceId, workspace_id: state.workspaceId,
                project: state.project, has_writer: Boolean(state.writerContextId),
                pending: state.pending, inflight: state.inflight, uncertain: Boolean(state.uncertain),
                context: publicContext(state.context) };
        }
        if (action === 'reconcile') {
            const evidence = observations.get(args.observation_id);
            const state = workspaces.inspect();
            if (args.confirm !== true || !evidence || evidence.contextId !== args.context_id
                || !state.uncertain || evidence.at < state.uncertain.at) {
                throw failure('RECONCILIATION_REQUIRED', 'Read and verify the current AE state, then confirm that observation_id.');
            }
            const current = await readProject();
            if (current.projectPath !== evidence.projectPath || current.revision !== evidence.revision
                || current.projectGeneration !== evidence.projectGeneration) {
                throw failure('OBSERVATION_STALE', 'AE changed after that observation; read its current state again.');
            }
            value = await workspaces.reconcile(args.context_id, { resolved: true, evidenceId: args.observation_id });
            reconciliations.set(args.context_id, Date.now());
            observations.delete(args.observation_id);
            return { ok: true, resolved: value.resolved, observation_id: args.observation_id };
        }
        if (action === 'release') {
            value = await workspaces.release(args.context_id);
            if (context && context.session && context.session.workContextId === args.context_id) context.session.workContextId = null;
        } else if (action === 'transfer') {
            if (args.target_context_id) value = publicContext(await workspaces.transfer(args.context_id, args.target_context_id));
            else {
                if (args.confirm !== true) throw failure('TRANSFER_CONFIRMATION_REQUIRED', 'Explicit user confirmation is required to take over writes.');
                const writer = workspaces.inspect().writerContextId;
                value = publicContext(writer ? await workspaces.transfer(writer, args.context_id)
                    : await workspaces.bind({ contextId: args.context_id, access: 'write' }));
            }
        } else throw failure('INVALID_ACTION', 'Unknown workspace action.');
        return Object.assign({ ok: true }, value);
    }

    async function instances(action, args) {
        if (action === 'list') {
            for (const record of await registry.list()) {
                if (record.state !== 'starting' || !record.ticketPath) continue;
                let reason = null;
                try {
                    const ticket = JSON.parse(fs.readFileSync(record.ticketPath, 'utf8'));
                    const state = JSON.parse(fs.readFileSync(ticket.bootstrapStatusPath, 'utf8'));
                    if (['project-failed', 'panel-failed', 'panel-unavailable'].includes(state.state)) reason = state.state;
                } catch (error) { if (error.code !== 'ENOENT') reason = 'bootstrap-status-unreadable'; }
                if (!reason && Date.now() - record.updatedAt > 120000) reason = 'registration-timeout';
                if (reason) await registry.update(record.instanceId, { state: 'unknown', reason });
            }
            return { ok: true, instances: await registry.list({ includeClosed: true }) };
        }
        if (action === 'start') {
            if (!args.project_path || !args.work_dir) throw failure('START_ARGUMENTS_REQUIRED', 'project_path and work_dir are required.');
            normalizeProjectPath(args.project_path); normalizeProjectPath(args.work_dir);
            if (!fs.statSync(args.project_path).isFile() || !fs.statSync(args.work_dir).isDirectory()) throw failure('INVALID_PATH', 'The saved project and working directory must exist.');
            const reservation = await registry.reserve({ role: 'primary', projectPath: args.project_path });
            let launchedPrimary = null;
            try {
                const launch = launchedPrimary = await launcher.startPrimary({ instanceId: reservation.instanceId, projectPath: args.project_path,
                    workDir: args.work_dir, registration: ticket => registry.update(reservation.instanceId, { pid: ticket.pid }) });
                const release = () => registry.unregister(reservation.instanceId, 'primary-exited').catch(() => {});
                if (launch.process) launch.process.once('exit', release);
                const exited = launch.exited || launch.process && (launch.process.exitCode !== null && launch.process.exitCode !== undefined
                    || launch.process.signalCode !== null && launch.process.signalCode !== undefined);
                if (exited) { await release(); throw failure('PRIMARY_EXITED', 'AE exited before its primary could become ready.'); }
                await registry.update(reservation.instanceId, { pid: launch.pid, ticketPath: launch.ticketPath });
                return { ok: true, instance_id: reservation.instanceId, state: 'starting', pid: launch.pid,
                    message: 'Wait for the instance to register, then bind it. A started process is not yet an AE acceptance result.' };
            } catch (error) {
                const launch = launchedPrimary || error.launchedInstance;
                if (!launch) await registry.unregister(reservation.instanceId, 'launch-failed');
                else {
                    const process = launch.process || launch.child;
                    const exited = launch.exited || process && (process.exitCode !== null && process.exitCode !== undefined
                        || process.signalCode !== null && process.signalCode !== undefined);
                    const release = () => registry.unregister(reservation.instanceId, 'primary-exited').catch(() => {});
                    if (exited) await release();
                    else {
                        if (process) process.once('exit', release);
                        await registry.update(reservation.instanceId, { state: 'unknown', reason: 'startup-bookkeeping-failed' }).catch(() => {});
                    }
                }
                throw error;
            }
        }
        if (action !== 'stop') throw failure('INVALID_ACTION', 'Unknown instance action.');
        const record = await registry.get(args.instance_id);
        if (!record || record.role !== 'primary') throw failure('INSTANCE_REQUIRED', 'Select a registered primary.');
        if (record.instanceId !== instanceId || !workspaces) {
            return { forwarded: await router.call(record.instanceId, { name: 'ae_instances', arguments: args }) };
        }
        const active = workspaces.inspect();
        if (active.pending || active.inflight || active.uncertain || active.writerContextId) {
            throw failure('WORKSPACE_BUSY', 'Release the writer and reconcile outstanding work before explicitly stopping AE.');
        }
        const policy = args.save_policy || 'refuse-dirty';
        if (!['refuse-dirty', 'save', 'discard'].includes(policy)) throw failure('INVALID_SAVE_POLICY', 'Invalid save policy.');
        accepting = false;
        const code = '(function(){var p=app.project;var policy=' + JSON.stringify(policy) + ';'
            + 'if(p.dirty&&policy==="refuse-dirty")return JSON.stringify({ok:false,error:"unsaved-changes"});'
            + 'if(policy==="save"){if(!p.file)return JSON.stringify({ok:false,error:"needs-save-path"});p.save();}'
            + 'p.close(CloseOptions.DO_NOT_SAVE_CHANGES);app.scheduleTask("app.quit()",500,false);return JSON.stringify({ok:true,stopRequested:true});}())';
        let execution;
        try { execution = await input.executeJsx({ code, timeoutMs: 10000, client: 'instance-stop', nativeProjectGraphEffect: 'invalidate' }); }
        catch (error) {
            await registry.update(instanceId, { state: 'unknown', reason: 'stop-result-unknown' });
            throw error;
        }
        const result = execution && execution.payload && execution.payload.ok === true
            ? parseJsxResult(execution.payload.result)
            : { ok: false, code: 'STOP_RESULT_UNKNOWN', error: 'AE stop result must be reconciled.', disposition: execution && execution.disposition };
        if (result && result.ok) {
            workspaces.close();
            await registry.update(instanceId, { state: 'closing' });
        } else if (result && result.code !== 'STOP_RESULT_UNKNOWN') accepting = true;
        else await registry.update(instanceId, { state: 'unknown', reason: 'stop-result-unknown' });
        return result;
    }

    async function contextFor(args, context, write) {
        const supplied = args.context_id || context.session && context.session.workContextId;
        if (supplied) return workspaces.getContext(supplied);
        const key = context.conversation && context.conversation.id || context.session && context.session.id;
        let existing = defaults.get(key);
        if (!existing || (write && existing.access !== 'write')) {
            existing = await workspaces.bind({ access: write ? 'write' : 'read',
                workDir: context.conversation && context.conversation.workDir || info.workDir });
            defaults.set(key, existing);
        }
        return existing;
    }

    async function routeTool(params, context, invoke) {
        if (!accepting) return { result: textResult({ ok: false, code: 'OWNER_CLOSED', error: 'This project owner stopped accepting requests.' }, true) };
        const args = params.arguments || {};
        const name = params.name;
        if (['ae_instances', 'ae_workspace'].includes(name)) return invoke(context);
        const selected = contextInstanceId(args.context_id);
        if (selected && selected !== instanceId) {
            if (changesProject(name, args)) {
                const denied = await enforce(name, Object.assign({}, context, { arguments: args }), input.approvalDeps || {});
                if (denied) return { result: textResult(denied, true) };
            }
            return { result: await router.call(selected, params) };
        }
        if (!projectTool(name, args)) return invoke(context);
        const write = changesProject(name, args);
        const bound = await contextFor(args, context, write);
        if (!accepting) throw failure('WORKSPACE_CLOSED', 'The owner panel stopped accepting work.');
        const execute = async current => {
            const observe = !write && ['ae_read', 'ae_previewFrame'].includes(name) && workspaces.inspect().uncertain;
            const before = observe ? await readProject() : null;
            const result = await invoke(Object.assign({}, context, current, {
                checkpointContinue: args.checkpoint_continue,
                reconciledAt: reconciliations.get(current.contextId),
                workspace: { instanceId, workspaceId: current.workspaceId },
            }));
            if (observe && result.result && result.result.structuredContent && !result.result.isError) {
                const after = await readProject();
                if (before.projectPath === after.projectPath && before.revision === after.revision
                    && before.projectGeneration === after.projectGeneration) {
                    const observationId = 'obs_' + crypto.randomBytes(12).toString('hex');
                    while (observations.size >= 32) observations.delete(observations.keys().next().value);
                    observations.set(observationId, Object.assign({ contextId: current.contextId, at: Date.now() }, after));
                    result.result.structuredContent.observation_id = observationId;
                    result.result.content = result.result.content || [];
                    result.result.content.push({ type: 'text', text: 'Observation for explicit reconciliation: ' + observationId });
                }
            }
            return result;
        };
        if (name === 'ae_readJob') {
            if (args.action === 'submit' || !args.action) await workspaces.assertContext(bound.contextId, false);
            return execute(workspaces.getContext(bound.contextId));
        }
        const result = await workspaces.run(bound.contextId, write, execute);
        if (result.result && result.result.structuredContent) {
            const source = { instance_id: instanceId, workspace_id: bound.workspaceId,
                context_id: bound.contextId, mode: 'live', project_path: bound.projectPath };
            result.result.structuredContent.execution_source = source;
            result.result.content = result.result.content || [];
            result.result.content.push({ type: 'text', text: JSON.stringify({ execution_source: source }) });
        }
        return result;
    }

    function setJobs(value) { jobs = value; }
    function markClosed(reason) {
        if (closePromise) return closePromise;
        accepting = false;
        if (workspaces) workspaces.close();
        let markerError = null;
        if (ownerClosedPath) {
            try {
                fs.mkdirSync(registry.root, { recursive: true });
                fs.writeFileSync(ownerClosedPath, JSON.stringify({ instanceId, reason: reason || 'panel-closed' }), 'utf8');
            } catch (error) { markerError = error; }
        }
        router.clear();
        // The unloading CEP must not take the registry lock or release a still-live AE's project.
        try {
            closePromise = Promise.resolve(jobs ? jobs.close() : null).then(value => {
                if (markerError) throw markerError;
                return value;
            });
        } catch (error) { closePromise = Promise.reject(error); }
        return closePromise;
    }

    return { instanceId, ownerClosedPath, registry, launcher, router, workspaces, publish, configure, workspace, instances,
        target, contextFor, routeTool, setJobs, markClosed, accepting: () => accepting,
        setApprovalDeps: value => { input.approvalDeps = value; },
        getInfo: () => Object.assign({}, info, { workspaceId: workspaces ? workspaces.workspaceId : null }) };
}

module.exports = { createInstanceService, publicContext, PROJECT_READ, changesProject };
