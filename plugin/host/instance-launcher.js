'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function aeEnvironment(base) {
    const clean = {};
    for (const [key, value] of Object.entries(base)) {
        if (/^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|CODEX_|CLAUDE_|OPENCODE_)/i.test(key)
            || /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)$/i.test(key)) continue;
        clean[key] = value;
    }
    return clean;
}

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function discoverAfterEffects(options) {
    const input = options || {};
    const platform = input.platform || process.platform;
    const files = input.fs || fs;
    const environment = input.env || process.env;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (!['win32', 'darwin'].includes(platform)) {
        throw failure('AE_LAUNCH_UNSUPPORTED', 'After Effects launching requires Windows or macOS');
    }
    const isExecutable = (candidate) => {
        try { return files.statSync(candidate).isFile(); } catch (_) { return false; }
    };
    const explicit = input.afterEffectsPath || input.executablePath || environment.AE_MCP_AFTER_EFFECTS;
    if (explicit) {
        const expectedName = platform === 'win32' ? /^AfterFX\.exe$/i : /^After Effects$/;
        if (!paths.isAbsolute(explicit) || !expectedName.test(paths.basename(explicit))
            || /Adobe After Effects[^\\/]*beta/i.test(explicit) || !isExecutable(explicit)) {
            throw failure('AE_EXECUTABLE_INVALID', 'The explicit path must name an installed formal After Effects executable');
        }
        return explicit;
    }
    const roots = input.installRoots || (platform === 'win32'
        ? [paths.join(environment.ProgramFiles || 'C:\\Program Files', 'Adobe')]
        : ['/Applications']);
    const candidates = [];
    for (const root of roots) {
        let names;
        try { names = files.readdirSync(root); } catch (_) { continue; }
        for (const name of names) {
            if (!/^Adobe After Effects(?:\s|$)/i.test(name) || /beta/i.test(name)) continue;
            const executable = platform === 'win32'
                ? paths.join(root, name, 'Support Files', 'AfterFX.exe')
                : paths.join(root, name, name.replace(/\.app$/, '') + '.app', 'Contents', 'MacOS', 'After Effects');
            const directApp = platform === 'darwin' && /\.app$/.test(name)
                ? paths.join(root, name, 'Contents', 'MacOS', 'After Effects') : null;
            const candidate = directApp || executable;
            if (isExecutable(candidate)) candidates.push({ path: candidate, version: Number((name.match(/\d{4}/) || [0])[0]) });
        }
    }
    candidates.sort((a, b) => b.version - a.version || a.path.localeCompare(b.path));
    if (!candidates.length) throw failure('AE_NOT_INSTALLED', 'No formal After Effects installation was found; supply afterEffectsPath');
    return candidates[0].path;
}

// JXA uses the OS-provided bridge; no compiler or application-name delivery is required.
const MAC_DISPATCH = `ObjC.import('AppKit');
function run(a) {
  var pid=Number(a[0]), executable=a[1], expectedStart=a[2], script=a[3], id=a[4], role=a[5];
  var app, deadline=Date.now()+20000;
  while(Date.now()<deadline) {
    app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if(app && !app.isNil() && app.finishedLaunching) break;
    $.NSThread.sleepForTimeInterval(0.1);
  }
  if(!app || app.isNil() || !app.finishedLaunching) throw Error('AE_PID_NOT_READY');
  var task=$.NSTask.alloc.init, pipe=$.NSPipe.pipe;
  task.launchPath='/bin/ps'; task.arguments=['-p',String(pid),'-o','lstart=']; task.standardOutput=pipe;
  task.launch; var data=pipe.fileHandleForReading.readDataToEndOfFile; task.waitUntilExit;
  var start=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,4)).trim();
  if(start!==expectedStart || ObjC.unwrap(app.executableURL.path)!==executable || app.terminated)
    throw Error('AE_PID_IDENTITY_CHANGED');
  var target=$.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
  var event=$.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x6d697363,0x646f7363,target,-1,0);
  var guard='if($.getenv("AE_MCP_INSTANCE_ID")!=='+JSON.stringify(id)+'||app.project.file||app.project.dirty||app.project.numItems!==0)throw new Error("STARTUP_PROJECT_CHANGED");';
  event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(guard+'$.evalFile(new File('+JSON.stringify(script)+'));'),0x2d2d2d2d);
  var error=Ref();
  // Never prompt for TCC or allow target interaction. Worker scripts run until their job ends.
  var reply=event.sendEventWithOptionsTimeoutError(0x20010|(role==='worker'?1:3),15,error);
  if(error[0] && !error[0].isNil()) throw Error('AE_APPLE_EVENT_'+Number(error[0].code)+': '+ObjC.unwrap(error[0].localizedDescription));
  if(role!=='worker' && ObjC.unwrap(reply.paramDescriptorForKeyword(0x2d2d2d2d).stringValue)!=='0')
    throw Error('AE_SCRIPT_RESULT_UNKNOWN');
  return JSON.stringify({pid:pid,launchIdentity:start,dispatched:true});
}`;

function dispatchMacScript(record, scriptPath, executable, execFile) {
    return new Promise((resolve, reject) => {
        execFile('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], { env: { ...aeEnvironment(process.env), LC_ALL: 'C' } }, (identityError, identity) => {
            if (identityError || !String(identity).trim() || record.exited) return reject(failure('AE_PID_IDENTITY_CHANGED', 'New AE exited before dispatch'));
            execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_DISPATCH, String(record.pid), executable,
                String(identity).trim(), scriptPath, record.instanceId, record.role],
            { timeout: 40000, maxBuffer: 16384, env: { ...aeEnvironment(process.env), LC_ALL: 'C' } }, (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr || error.message);
                    const code = /AE_APPLE_EVENT_-(1743|1744)/.test(detail) ? 'AE_AUTOMATION_PERMISSION_REQUIRED' : 'AE_SCRIPT_DISPATCH_FAILED';
                    reject(failure(code, detail));
                } else {
                    try { resolve(JSON.parse(stdout)); } catch (_) { reject(failure('AE_SCRIPT_RESULT_UNKNOWN', 'Invalid PID dispatcher response')); }
                }
            });
        });
    });
}

function createInstanceLauncher(options) {
    const input = options || {};
    const files = input.fs || fs;
    const spawn = input.spawn || childProcess.spawn;
    const environment = input.env || process.env;
    const platform = input.platform || process.platform;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const owned = new Map();
    const now = input.now || Date.now;

    function writeTicket(ticketPath, ticket, initial) {
        const text = JSON.stringify(ticket, null, 2) + '\n';
        if (initial) files.writeFileSync(ticketPath, text, { flag: 'wx', mode: 0o600 });
        else {
            const pending = ticketPath + '.pending';
            files.writeFileSync(pending, text, { mode: 0o600 });
            files.renameSync(pending, ticketPath);
        }
    }

    async function launch(role, parameters) {
        const request = parameters || {};
        const instanceId = request.instanceId || crypto.randomBytes(16).toString('hex');
        if (!INSTANCE_ID.test(instanceId)) throw failure('INSTANCE_ID_INVALID', 'Invalid instanceId');
        if (owned.has(instanceId)) throw failure('INSTANCE_ALREADY_STARTED', 'This launcher already started the instance');
        const workDir = request.workDir;
        if (typeof workDir !== 'string' || !paths.isAbsolute(workDir)) {
            throw failure('WORK_DIRECTORY_REQUIRED', 'An explicit absolute workDir is required');
        }
        if (!files.statSync(workDir).isDirectory()) throw failure('WORK_DIRECTORY_INVALID', 'workDir is not a directory');
        if (platform === 'darwin' && (input.arch || process.arch) !== 'arm64') throw failure('AE_LAUNCH_UNSUPPORTED', 'macOS launching requires native arm64');
        const executable = discoverAfterEffects(Object.assign({}, input, request, { platform, fs: files, env: environment }));
        let scriptPath = request.scriptPath;
        if (role === 'primary') {
            if (typeof request.projectPath !== 'string' || !paths.isAbsolute(request.projectPath)
                || !files.statSync(request.projectPath).isFile()) {
                throw failure('PROJECT_PATH_REQUIRED', 'A saved projectPath is required before starting a primary instance');
            }
        } else if (typeof scriptPath !== 'string' || !paths.isAbsolute(scriptPath) || !files.statSync(scriptPath).isFile()) {
            throw failure('WORKER_SCRIPT_REQUIRED', 'A maintained worker scriptPath is required');
        }
        const launchDir = paths.join(workDir, 'ae-mcp', 'launches', instanceId);
        files.mkdirSync(launchDir, { recursive: true });
        const ticketPath = paths.join(launchDir, 'ticket.json');
        const ticket = {
            version: 1, instanceId, role, workDir, projectPath: request.projectPath || null,
            pid: null, executablePath: executable, createdAt: now(), state: 'starting',
            bootstrapStatusPath: paths.join(launchDir, 'bootstrap-status.json'),
        };
        writeTicket(ticketPath, ticket, true);
        if (role === 'primary') {
            const templatePath = input.bootstrapTemplatePath || path.join(__dirname, '../jsx/templates/instance_bootstrap.jsx');
            const template = files.readFileSync(templatePath, 'utf8');
            const literal = JSON.stringify(ticket).replace(/[\u2028\u2029]/g, (value) => '\\u' + value.charCodeAt(0).toString(16));
            scriptPath = paths.join(launchDir, 'bootstrap.jsx');
            files.writeFileSync(scriptPath, template.replace('$bootstrap_json', () => literal), { mode: 0o600 });
        }
        const env = Object.assign(aeEnvironment(Object.assign({}, environment, request.env || {})), {
            AE_MCP_INSTANCE_ID: instanceId,
            AE_MCP_INSTANCE_ROLE: role,
            AE_MCP_WORK_DIR: workDir,
            AE_MCP_LAUNCH_TICKET: ticketPath,
        });
        let child;
        try {
            const args = platform === 'darwin' ? ['-m'] : ['-m', '-r', scriptPath];
            // Workspace GUI extensions can block worker shutdown; snapshot reads do not need them.
            if (platform === 'win32' && role === 'worker') args.unshift('-noui');
            // Keep primary AE alive after connector exit; Windows libuv otherwise kills its child job.
            child = spawn(executable, args, {
                cwd: workDir, env, windowsHide: true, stdio: 'ignore', shell: false, detached: role === 'primary',
            });
        } catch (error) {
            ticket.state = 'launch-failed';
            writeTicket(ticketPath, ticket);
            throw error;
        }
        const record = { instanceId, role, pid: child.pid || null, process: child, child, ticketPath, ticket };
        owned.set(instanceId, record);
        child.on('error', (error) => { record.error = error; });
        child.once('exit', (code, signal) => {
            record.exitCode = code;
            record.exitSignal = signal;
            record.exited = true;
        });
        try {
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('spawn', () => { child.removeListener('error', reject); resolve(); });
            });
            if (!Number.isSafeInteger(child.pid) || child.pid <= 1) throw failure('AE_PID_UNAVAILABLE', 'Launched AE process did not provide a PID');
            record.pid = ticket.pid = child.pid;
            child.unref?.();
            writeTicket(ticketPath, ticket);
            if (typeof request.registration === 'function') await request.registration(Object.assign({}, ticket));
            if (platform === 'darwin') record.dispatch = await (input.dispatchMacScript || dispatchMacScript)(record, scriptPath, executable, input.execFile || childProcess.execFile);
            return record;
        } catch (error) {
            // A post-spawn bookkeeping failure must not hide a live primary or launch a replacement.
            if (Number.isSafeInteger(record.pid) && record.pid > 1) error.launchedInstance = record;
            else {
                owned.delete(instanceId);
                ticket.state = 'launch-failed';
                writeTicket(ticketPath, ticket);
            }
            throw error;
        }
    }

    function stopOwnedWorker(record) {
        if (!record || owned.get(record.instanceId) !== record || record.role !== 'worker') {
            throw failure('WORKER_NOT_OWNED', 'Only a worker started by this launcher can be stopped');
        }
        if (record.exited) return false;
        return record.process.kill();
    }

    return {
        discoverAfterEffects: (request) => discoverAfterEffects(Object.assign({}, input, request)),
        startPrimary: (request) => launch('primary', request),
        startWorker: (request) => launch('worker', request),
        stopOwnedWorker,
    };
}

module.exports = { createInstanceLauncher, discoverAfterEffects, dispatchMacScript, MAC_DISPATCH };
