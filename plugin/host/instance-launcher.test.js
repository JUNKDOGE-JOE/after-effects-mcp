'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createInstanceLauncher, discoverAfterEffects } = require('./instance-launcher');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-launcher-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const platform = process.platform === 'win32' ? 'win32' : 'darwin';
    const executable = path.join(root, platform === 'win32' ? 'AfterFX.exe' : 'After Effects');
    const project = path.join(root, 'project.aep');
    const script = path.join(root, 'read.jsx');
    for (const file of [executable, project, script]) fs.writeFileSync(file, 'fixture');
    const calls = [];
    const spawn = (exe, args, options) => {
        const child = new EventEmitter();
        child.pid = 4242 + calls.length;
        child.unrefCalls = 0;
        child.unref = () => { child.unrefCalls += 1; };
        child.kill = () => { child.killed = true; return true; };
        calls.push({ exe, args, options, child });
        process.nextTick(() => child.emit('spawn'));
        return child;
    };
    return { root, platform, executable, project, script, calls, spawn };
}

test('formal discovery excludes Beta and selects the newest installed executable', () => {
    const root = 'C:\\Program Files\\Adobe';
    const existing = new Set(['2025', '2026'].map((year) => `${root}\\Adobe After Effects ${year}\\Support Files\\AfterFX.exe`));
    const files = {
        readdirSync: () => ['Adobe After Effects 2025', 'Adobe After Effects 2026', 'Adobe After Effects 2027 (Beta)'],
        statSync: (value) => { if (!existing.has(value)) throw new Error('missing'); return { isFile: () => true }; },
    };
    assert.equal(discoverAfterEffects({ platform: 'win32', fs: files, env: {}, installRoots: [root] }),
        `${root}\\Adobe After Effects 2026\\Support Files\\AfterFX.exe`);
    assert.throws(() => discoverAfterEffects({ platform: 'win32', fs: files, afterEffectsPath: `${root}\\Adobe After Effects 2027 (Beta)\\Support Files\\AfterFX.exe` }),
        { code: 'AE_EXECUTABLE_INVALID' });
});

test('primary launch preserves its project path and supplies a PID ticket without claiming readiness', async (t) => {
    const f = fixture(t);
    let registered;
    const launcher = createInstanceLauncher({ platform: f.platform, afterEffectsPath: f.executable, spawn: f.spawn, arch: 'arm64', dispatchMacScript: async () => ({ dispatched: true }),
        env: { TASK_ENV: 'kept', OPENAI_API_KEY: 'secret-key', anthropic_auth_token: 'secret-token', CUSTOM_API_KEY: 'custom-key', OPENCODE_CONFIG_CONTENT: '{"apiKey":"secret"}' } });
    const record = await launcher.startPrimary({ instanceId: 'main-one', workDir: f.root, projectPath: f.project,
        registration: (ticket) => { registered = ticket; } });
    const call = f.calls[0];
    assert.deepEqual(call.args.slice(0, 2), f.platform === 'darwin' ? ['-m'] : ['-m', '-r']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, true);
    assert.equal(call.options.stdio, 'ignore');
    assert.equal(call.child.unrefCalls, 1);
    assert.equal(call.options.cwd, f.root);
    assert.equal(call.options.env.AE_MCP_INSTANCE_ROLE, 'primary');
    assert.equal(call.options.env.TASK_ENV, 'kept');
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env.anthropic_auth_token, undefined);
    assert.equal(call.options.env.CUSTOM_API_KEY, undefined);
    assert.equal(call.options.env.OPENCODE_CONFIG_CONTENT, undefined);
    const ticket = JSON.parse(fs.readFileSync(record.ticketPath, 'utf8'));
    assert.equal(ticket.pid, record.pid);
    assert.equal(ticket.projectPath, f.project);
    assert.equal(ticket.state, 'starting');
    assert.equal(registered.pid, record.pid);
    assert.equal(fs.readFileSync(f.project, 'utf8'), 'fixture');
    assert.throws(() => launcher.stopOwnedWorker(record), { code: 'WORKER_NOT_OWNED' });
    await assert.rejects(launcher.startPrimary({ instanceId: 'main-one', workDir: f.root, projectPath: f.project }), { code: 'INSTANCE_ALREADY_STARTED' });
    assert.equal(f.calls.length, 1);
});

test('worker executes only the supplied maintained script and only its owner may stop it', async (t) => {
    const f = fixture(t);
    const launcher = createInstanceLauncher({ platform: f.platform, afterEffectsPath: f.executable, spawn: f.spawn, arch: 'arm64', dispatchMacScript: async () => ({ dispatched: true }), env: {} });
    const record = await launcher.startWorker({ instanceId: 'worker-one', scriptPath: f.script, workDir: f.root, env: { JOB_PATH: 'job.json' } });
    assert.deepEqual(f.calls[0].args, f.platform === 'darwin' ? ['-m'] : ['-m', '-r', f.script]);
    assert.equal(f.calls[0].options.env.AE_MCP_INSTANCE_ROLE, 'worker');
    assert.equal(f.calls[0].options.detached, false);
    assert.equal(f.calls[0].options.stdio, 'ignore');
    assert.equal(f.calls[0].child.unrefCalls, 1);
    assert.equal(f.calls[0].options.env.JOB_PATH, 'job.json');
    assert.equal(record.process, record.child);
    assert.throws(() => launcher.stopOwnedWorker({ ...record }), { code: 'WORKER_NOT_OWNED' });
    assert.equal(launcher.stopOwnedWorker(record), true);
    record.process.emit('exit', 0, null);
    assert.equal(launcher.stopOwnedWorker(record), false);
});

test('launcher rejects missing work directory before any process starts', async (t) => {
    const f = fixture(t);
    const launcher = createInstanceLauncher({ platform: f.platform, afterEffectsPath: f.executable, spawn: f.spawn, arch: 'arm64', dispatchMacScript: async () => ({ dispatched: true }) });
    await assert.rejects(launcher.startWorker({ scriptPath: f.script }), { code: 'WORK_DIRECTORY_REQUIRED' });
    assert.equal(f.calls.length, 0);
});

test('registration failure exposes the already-started process instead of killing or replacing it', async (t) => {
    const f = fixture(t);
    const launcher = createInstanceLauncher({ platform: f.platform, afterEffectsPath: f.executable, spawn: f.spawn, arch: 'arm64', dispatchMacScript: async () => ({ dispatched: true }), env: {} });
    await assert.rejects(launcher.startPrimary({ instanceId: 'main-uncertain', projectPath: f.project, workDir: f.root,
        registration: () => { throw new Error('registration unavailable'); } }), (error) => {
        assert.equal(error.launchedInstance.pid, 4242);
        assert.equal(error.launchedInstance.process.killed, undefined);
        return /registration unavailable/.test(error.message);
    });
    assert.equal(f.calls.length, 1);
});

test('an asynchronous spawn failure without a PID is not reported as a live AE instance', async (t) => {
    const f = fixture(t);
    const launcher = createInstanceLauncher({ platform: f.platform, afterEffectsPath: f.executable, env: {},
        spawn: () => {
            const child = new EventEmitter();
            process.nextTick(() => child.emit('error', Object.assign(new Error('spawn refused'), { code: 'EACCES' })));
            return child;
        } });
    await assert.rejects(launcher.startWorker({ instanceId: 'never-started', workDir: f.root, scriptPath: f.script }), error => {
        assert.equal(error.launchedInstance, undefined);
        return error.code === 'EACCES';
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'ae-mcp/launches/never-started/ticket.json'), 'utf8')).state, 'launch-failed');
});

test('a ticket write failure after spawn still tracks the eventual process exit', async (t) => {
    const f = fixture(t);
    const files = { ...fs, writeFileSync(file, ...args) {
        if (String(file).endsWith('.pending')) throw Object.assign(new Error('ticket disk full'), { code: 'ENOSPC' });
        return fs.writeFileSync(file, ...args);
    } };
    const launcher = createInstanceLauncher({ fs: files, platform: f.platform, afterEffectsPath: f.executable, spawn: f.spawn, arch: 'arm64', dispatchMacScript: async () => ({ dispatched: true }), env: {} });
    let record;
    await assert.rejects(launcher.startWorker({ instanceId: 'ticket-failed', workDir: f.root, scriptPath: f.script }), error => {
        record = error.launchedInstance;
        assert.equal(record.pid, 4242);
        return error.code === 'ENOSPC';
    });
    f.calls[0].child.emit('exit', 0, null);
    assert.equal(record.exited, true);
    assert.equal(record.exitCode, 0);
});

function bootstrapHarness(initialStatus, options = {}) {
    const ticket = { instanceId: 'fixture-main', projectPath: '/project.aep', bootstrapStatusPath: '/status.json' };
    let saved = initialStatus || '';
    const scheduled = [];
    const executed = [];
    const events = [];
    const libraries = [];
    function File(name) {
        this.exists = true;
        this.open = () => true;
        this.close = () => {};
        this.read = () => saved;
        this.write = (text) => { saved = text; };
    }
    function ExternalObject(name) {
        if (options.libraryError) throw options.libraryError;
        libraries.push(name);
    }
    function CSXSEvent() {
        this.dispatch = () => {
            events.push({ type: this.type, data: this.data });
            if (options.acknowledge) saved = JSON.stringify({ instanceId: ticket.instanceId, state: options.acknowledge });
        };
    }
    const context = { File, ExternalObject, CSXSEvent, $: { global: {} }, app: {
        open: () => ({}), findMenuCommandId: () => { assert.fail('bootstrap must not toggle the panel menu'); },
        executeCommand: (id) => executed.push(id), scheduleTask: (source) => scheduled.push(source),
    } };
    const template = fs.readFileSync(path.join(__dirname, '../jsx/templates/instance_bootstrap.jsx'), 'utf8');
    vm.runInNewContext(template.replace('$bootstrap_json', JSON.stringify(ticket)), context);
    return { executed, events, libraries, scheduled, context, getStatus: () => saved,
        setStatus: (state) => { saved = JSON.stringify({ instanceId: ticket.instanceId, state }); },
        tick: () => vm.runInNewContext(scheduled.shift(), context) };
}

test('bootstrap dispatches the manifest startup event and waits for real host readiness', () => {
    const h = bootstrapHarness();
    h.tick();
    const manifest = fs.readFileSync(path.join(__dirname, '../CSXS/manifest.xml'), 'utf8');
    assert.match(manifest, /<StartOn>\s*<Event>com\.aemcp\.panel\.launch<\/Event>\s*<\/StartOn>/);
    assert.deepEqual(h.events, [{ type: 'com.aemcp.panel.launch', data: 'fixture-main' }]);
    assert.deepEqual(h.executed, []);
    assert.equal(JSON.parse(h.getStatus()).state, 'panel-requested');
    h.setStatus('host-started');
    h.tick();
    assert.equal(h.scheduled.length, 0);
});

test('bootstrap does not toggle a restored panel or reopen an intentionally closed one', () => {
    for (const state of ['panel-loading', 'host-started', 'intentional-disconnect']) {
        const h = bootstrapHarness(JSON.stringify({ instanceId: 'fixture-main', state }));
        h.tick();
        assert.deepEqual(h.executed, []);
        assert.deepEqual(h.events, []);
    }
});

test('bootstrap bounds unacknowledged events and loads the existing CEP library only once', () => {
    const h = bootstrapHarness();
    while (h.scheduled.length) h.tick();
    assert.equal(JSON.parse(h.getStatus()).state, 'panel-unavailable');
    assert.deepEqual(h.executed, []);
    assert.equal(h.events.length, 30);
    assert.deepEqual(h.libraries, ['lib:PlugPlugExternalObject']);
});

test('bootstrap preserves a synchronous panel-loading acknowledgement and never retries after intentional close', () => {
    const h = bootstrapHarness('', { acknowledge: 'panel-loading' });
    h.tick();
    assert.equal(JSON.parse(h.getStatus()).state, 'panel-loading');
    h.setStatus('intentional-disconnect');
    h.tick();
    assert.equal(h.events.length, 1);
    assert.equal(h.scheduled.length, 0);
});

test('bootstrap reports an unavailable CEP event bridge without attempting a menu fallback', () => {
    const h = bootstrapHarness('', { libraryError: new Error('PlugPlug unavailable') });
    h.tick();
    assert.equal(JSON.parse(h.getStatus()).state, 'panel-failed');
    assert.match(JSON.parse(h.getStatus()).detail, /PlugPlug unavailable/);
    assert.deepEqual(h.executed, []);
    assert.equal(h.scheduled.length, 0);
});

test('Mac dispatcher binds the captured PID birth identity and never requests TCC interaction', async () => {
    const { dispatchMacScript, MAC_DISPATCH } = require('./instance-launcher');
    const calls = [];
    const execFile = (exe, args, options, callback) => {
        calls.push({ exe, args, options });
        if (exe === '/bin/ps') callback(null, ' Wed Sep 30 13:29:19 2026\n');
        else callback(null, '{"pid":42,"dispatched":true}');
    };
    const record = { pid: 42, instanceId: 'ticket-42', role: 'primary', ticket: {} };
    assert.equal((await dispatchMacScript(record, '/fixture/bootstrap.jsx', '/AE/After Effects', execFile)).pid, 42);
    assert.deepEqual(calls[0].args, ['-p', '42', '-o', 'lstart=']);
    assert.deepEqual(calls[1].args.slice(4), ['42', '/AE/After Effects', 'Wed Sep 30 13:29:19 2026', '/fixture/bootstrap.jsx', 'ticket-42', 'primary']);
    assert.match(MAC_DISPATCH, /descriptorWithProcessIdentifier\(pid\)/);
    assert.match(MAC_DISPATCH, /start!==expectedStart/);
    assert.match(MAC_DISPATCH, /0x20010/);
    assert.match(MAC_DISPATCH, /STARTUP_PROJECT_CHANGED/);
    assert.equal(calls[1].options.timeout, 40000);
});

test('Mac dispatcher reports permission failure and never retries a dispatched event', async () => {
    const { dispatchMacScript } = require('./instance-launcher');
    for (const code of [-1743, -1744, -1712]) {
        let sent = 0;
        const execFile = (exe, args, options, callback) => {
            if (exe === '/bin/ps') callback(null, 'start');
            else { sent += 1; callback(new Error('failed'), '', 'AE_APPLE_EVENT_' + code); }
        };
        await assert.rejects(dispatchMacScript({ pid: 42, role: 'primary', ticket: {} }, '/script', '/AE', execFile),
            { code: code === -1712 ? 'AE_SCRIPT_DISPATCH_FAILED' : 'AE_AUTOMATION_PERMISSION_REQUIRED' });
        assert.equal(sent, 1);
    }
});

test('Mac post-spawn dispatch failure preserves ownership for reconciliation', async (t) => {
    const f = fixture(t);
    if (f.platform !== 'darwin') return;
    const launcher = createInstanceLauncher({ platform: 'darwin', arch: 'arm64', afterEffectsPath: f.executable,
        spawn: f.spawn, dispatchMacScript: async () => { throw new Error('permission blocked'); } });
    await assert.rejects(launcher.startPrimary({ instanceId: 'blocked-mac', workDir: f.root, projectPath: f.project }),
        error => error.launchedInstance.pid === f.calls[0].child.pid);
    await assert.rejects(launcher.startPrimary({ instanceId: 'blocked-mac', workDir: f.root, projectPath: f.project }),
        { code: 'INSTANCE_ALREADY_STARTED' });
    assert.equal(f.calls.length, 1);
});
