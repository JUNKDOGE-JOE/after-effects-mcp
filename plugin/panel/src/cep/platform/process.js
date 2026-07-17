const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_OUTPUT_LIMIT = 8192;
const TERMINATE_GRACE_MS = 50;
const FORCE_CLOSE_GRACE_MS = 250;
const EXECUTABLE_IDS = new Set(['ae-mcp', 'node', 'claude', 'codex', 'zcode', 'uv', 'npm', 'opencode', 'brew', 'winget', 'powershell']);
const WINDOWS_COMMAND_SCRIPT = /\.(?:cmd|bat)$/i;

function environmentKey(environment, name, caseInsensitive) {
  if (!caseInsensitive) return Object.prototype.hasOwnProperty.call(environment, name) ? name : null;
  const normalized = String(name).toLowerCase();
  return Object.keys(environment).find((key) => key.toLowerCase() === normalized) || null;
}

function environmentValue(environment, name, caseInsensitive) {
  const key = environmentKey(environment, name, caseInsensitive);
  return key === null ? undefined : environment[key];
}

function setEnvironmentDefault(environment, name, value, caseInsensitive) {
  const existing = environmentKey(environment, name, caseInsensitive);
  if (existing === null || !environment[existing]) environment[existing || name] = String(value);
}

function definedEnvironment(caseInsensitive, ...sources) {
  const result = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value === undefined || value === null) continue;
      const existing = environmentKey(result, key, caseInsensitive);
      if (existing !== null && existing !== key) delete result[existing];
      result[key] = String(value);
    }
  }
  return result;
}

function appendBytes(current, chunk, remaining) {
  if (remaining <= 0) return current;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''));
  let decoded = buffer.subarray(0, remaining).toString('utf8');
  while (Buffer.byteLength(decoded, 'utf8') > remaining) decoded = decoded.slice(0, -1);
  return current + decoded;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function compareVersions(actual, minimum) {
  const left = String(actual || '').match(/\d+(?:\.\d+){0,3}/);
  const right = String(minimum || '').match(/\d+(?:\.\d+){0,3}/);
  if (!left || !right) return null;
  const a = left[0].split('.').map(Number);
  const b = right[0].split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function reportedArch(output) {
  if (/\b(?:arm64|aarch64)\b/i.test(output)) return 'arm64';
  if (/\b(?:x64|amd64|x86_64)\b/i.test(output)) return 'x64';
  return null;
}

function cpuArchitecture(cpuType) {
  if (cpuType === 0x0100000c) return 'arm64';
  if (cpuType === 0x01000007) return 'x64';
  return null;
}

function inspectNativeArchitectures(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return [];
  const architectures = new Set();
  const littleMagic = bytes.readUInt32LE(0);
  const bigMagic = bytes.readUInt32BE(0);
  if (littleMagic === 0xfeedfacf || littleMagic === 0xfeedface) {
    const arch = cpuArchitecture(bytes.readUInt32LE(4));
    if (arch) architectures.add(arch);
  } else if (bigMagic === 0xfeedfacf || bigMagic === 0xfeedface) {
    const arch = cpuArchitecture(bytes.readUInt32BE(4));
    if (arch) architectures.add(arch);
  } else if ([0xcafebabe, 0xcafebabf].includes(bigMagic)) {
    const entryBytes = bigMagic === 0xcafebabf ? 32 : 20;
    const count = bytes.readUInt32BE(4);
    if (count <= 64 && 8 + (count * entryBytes) <= bytes.length) {
      for (let index = 0; index < count; index += 1) {
        const arch = cpuArchitecture(bytes.readUInt32BE(8 + (index * entryBytes)));
        if (arch) architectures.add(arch);
      }
    }
  } else if ([0xbebafeca, 0xbfbafeca].includes(littleMagic)) {
    const entryBytes = littleMagic === 0xbfbafeca ? 32 : 20;
    const count = bytes.readUInt32LE(4);
    if (count <= 64 && 8 + (count * entryBytes) <= bytes.length) {
      for (let index = 0; index < count; index += 1) {
        const arch = cpuArchitecture(bytes.readUInt32LE(8 + (index * entryBytes)));
        if (arch) architectures.add(arch);
      }
    }
  } else if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 0x40) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset <= bytes.length - 6 && bytes.toString('binary', peOffset, peOffset + 4) === 'PE\0\0') {
      const machine = bytes.readUInt16LE(peOffset + 4);
      if (machine === 0x8664) architectures.add('x64');
      if (machine === 0xaa64) architectures.add('arm64');
    }
  }
  return [...architectures];
}

function isNodeScript(path, bytes) {
  if (/\.(?:cjs|mjs|js)$/i.test(path)) return true;
  if (!Buffer.isBuffer(bytes) || bytes.length < 2) return false;
  const firstLine = bytes.toString('utf8', 0, Math.min(bytes.length, 512)).split(/\r?\n/, 1)[0];
  return /^#!.*\bnode(?:\.exe)?(?:\s|$)/i.test(firstLine);
}

export function createProcessBoundary({ deps, paths, platform }) {
  const windows = platform === 'win32';
  const separator = windows ? ';' : ':';

  function completeEnvironment(...sources) {
    const result = definedEnvironment(windows, ...sources);
    if (windows) {
      setEnvironmentDefault(result, 'USERPROFILE', paths.home, true);
      setEnvironmentDefault(result, 'HOME', paths.home, true);
      setEnvironmentDefault(result, 'APPDATA', paths.join([paths.home, 'AppData', 'Roaming']), true);
      setEnvironmentDefault(result, 'LOCALAPPDATA', paths.join([paths.home, 'AppData', 'Local']), true);
      setEnvironmentDefault(result, 'TEMP', paths.tempRoot, true);
      setEnvironmentDefault(result, 'TMP', paths.tempRoot, true);
      const pathKey = environmentKey(result, 'PATH', true) || 'Path';
      const inherited = String(result[pathKey] || '').split(separator)
        .filter((entry) => entry && entry.toLowerCase() !== paths.binRoot.toLowerCase());
      result[pathKey] = [paths.binRoot, ...inherited].join(separator);
    } else {
      setEnvironmentDefault(result, 'HOME', paths.home, false);
      const inherited = String(result.PATH || '').split(separator).filter((entry) => entry && entry !== paths.binRoot);
      result.PATH = [paths.binRoot, ...inherited].join(separator);
    }
    return result;
  }

  function completeSpawnEnv(base = {}, additions = {}) {
    return completeEnvironment(deps.env, base, additions);
  }

  function spawn(executable, args = [], options = {}) {
    if (!executable || executable.ok !== true || !executable.path) throw new TypeError('A successful executable resolution is required');
    if (windows && WINDOWS_COMMAND_SCRIPT.test(executable.path)) {
      throw new TypeError('Windows command scripts must be materialized through a verified native Node executable');
    }
    const hasExplicitEnv = Object.prototype.hasOwnProperty.call(options, 'env');
    const environment = hasExplicitEnv ? completeEnvironment(options.env || {}) : completeSpawnEnv();
    const commandArgs = [...(executable.argsPrefix || []), ...args];
    return deps.spawnImpl(executable.path, commandArgs, {
      ...options,
      shell: false,
      env: environment,
    });
  }

  function run(request) {
    const started = deps.now();
    const timeoutMs = request.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(0, Number(request.timeoutMs));
    const maxOutputBytes = request.maxOutputBytes === undefined ? DEFAULT_OUTPUT_LIMIT : Math.max(0, Number(request.maxOutputBytes));
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    let killTimer = null;
    let forceCloseTimer = null;

    return new Promise((resolve) => {
      let proc;
      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        if (request.signal) request.signal.removeEventListener('abort', onAbort);
        resolve({
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          signal: signal || null,
          stdout,
          stderr,
          durationMs: Math.max(0, deps.now() - started),
          timedOut,
          aborted,
        });
      };
      const armForceClose = (signal) => {
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        forceCloseTimer = setTimeout(() => finish(null, signal), FORCE_CLOSE_GRACE_MS);
      };
      const terminate = (reason) => {
        if (settled) return;
        if (reason === 'timeout') timedOut = true;
        if (reason === 'abort') aborted = true;
        try {
          if (!proc) {
            armForceClose('SIGTERM');
            return;
          }
          proc.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (settled) return;
            try {
              proc.kill('SIGKILL');
            } catch (error) {
              // A failed kill request still waits for close until the same
              // bounded fallback used after a successfully requested kill.
            }
            // kill() only confirms that the request was sent.  Drain stdio
            // through close, with one final bounded fallback for broken hosts.
            armForceClose('SIGKILL');
          }, TERMINATE_GRACE_MS);
        } catch (error) {
          armForceClose('SIGTERM');
        }
      };
      const onAbort = () => terminate('abort');

      if (request.signal?.aborted) {
        aborted = true;
        finish(null, null);
        return;
      }
      try {
        const spawnOptions = {
          cwd: request.cwd,
          stdio: 'pipe',
          windowsHide: true,
        };
        if (Object.prototype.hasOwnProperty.call(request, 'env')) spawnOptions.env = request.env || {};
        proc = spawn(request.executable, request.args || [], spawnOptions);
      } catch (error) {
        stderr = String(error && error.message ? error.message : error);
        finish(null, null);
        return;
      }
      proc.stdout?.on?.('data', (chunk) => {
        const remaining = maxOutputBytes - byteLength(stdout) - byteLength(stderr);
        stdout = appendBytes(stdout, chunk, remaining);
      });
      proc.stderr?.on?.('data', (chunk) => {
        const remaining = maxOutputBytes - byteLength(stdout) - byteLength(stderr);
        stderr = appendBytes(stderr, chunk, remaining);
      });
      proc.on?.('error', (error) => {
        const remaining = maxOutputBytes - byteLength(stdout) - byteLength(stderr);
        stderr = appendBytes(stderr, error && error.message ? error.message : error, remaining);
      });
      proc.on?.('close', finish);
      if (request.stdin !== undefined && proc.stdin?.end) proc.stdin.end(String(request.stdin));
      if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => terminate('timeout'), timeoutMs);
    });
  }

  function readCandidatePrefix(path) {
    try {
      if (deps.fs.openSync && deps.fs.readSync && deps.fs.closeSync) {
        const fd = deps.fs.openSync(path, 'r');
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const bytesRead = deps.fs.readSync(fd, buffer, 0, buffer.length, 0);
          return buffer.subarray(0, bytesRead);
        } finally {
          deps.fs.closeSync(fd);
        }
      }
      if (deps.fs.readFileSync) {
        const value = deps.fs.readFileSync(path);
        return Buffer.from(value).subarray(0, 64 * 1024);
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function fileCandidate(path, source, environment = deps.env, readableScript = false) {
    try {
      if (!deps.fs.existsSync(path)) return null;
      const resolved = deps.fs.realpathSync ? deps.fs.realpathSync(path) : path;
      if (deps.fs.statSync && !deps.fs.statSync(resolved).isFile()) return null;
      const bytes = readCandidatePrefix(resolved);
      const nodeScript = readableScript && isNodeScript(resolved, bytes);
      if (deps.fs.accessSync) {
        const posixMode = nodeScript
          ? (deps.fs.constants?.R_OK ?? 4)
          : (deps.fs.constants?.X_OK ?? 1);
        deps.fs.accessSync(resolved, windows ? undefined : posixMode);
      }
      return {
        path: resolved,
        argsPrefix: [],
        displayPath: resolved,
        source,
        architectureInspected: Boolean(bytes && bytes.length),
        nativeArchitectures: inspectNativeArchitectures(bytes),
        nodeScript,
        windowsCommandScript: windows && WINDOWS_COMMAND_SCRIPT.test(resolved),
        prefixBytes: bytes,
      };
    } catch (error) {
      return null;
    }
  }

  function runtimeCandidates(id) {
    if (id === 'ae-mcp') return [paths.launcher];
    // `current` is an authenticated RuntimeManager text pointer, not a
    // directory or symlink.  Until the helper-gated manager supplies a
    // verified active root, process discovery must not derive paths from it.
    return [];
  }

  function pathCandidates(id, env) {
    const raw = windows ? (environmentValue(env, 'PATH', true) || '') : (env.PATH || '');
    const extensions = windows ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
    const result = [];
    for (const directory of String(raw).split(separator).filter(Boolean)) {
      for (const extension of extensions) result.push(paths.join([directory, id + extension]));
    }
    return result;
  }

  function standardCandidates(id, env) {
    if (!windows) {
      const values = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((root) => paths.join([root, id]));
      if (id === 'zcode') values.unshift('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
      return values;
    }
    const values = [];
    const systemRoot = String(environmentValue(env, 'SystemRoot', true) || environmentValue(env, 'WINDIR', true) || 'C:\\Windows');
    if (id === 'node') values.push(paths.join([environmentValue(env, 'ProgramFiles', true) || 'C:\\Program Files', 'nodejs', 'node.exe']));
    const appData = environmentValue(env, 'APPDATA', true) || paths.join([paths.home, 'AppData', 'Roaming']);
    values.push(paths.join([appData, 'npm', id + '.cmd']));
    const local = environmentValue(env, 'LOCALAPPDATA', true) || paths.join([paths.home, 'AppData', 'Local']);
    if (id === 'zcode') values.unshift(paths.join([local, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs']));
    if (id === 'winget') values.unshift(paths.join([local, 'Microsoft', 'WindowsApps', 'winget.exe']));
    if (id === 'powershell') values.unshift(paths.join([systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']));
    values.push(paths.join([local, 'Programs', id, id + '.exe']));
    return values;
  }

  function windowsPathInside(root, candidate) {
    const normalizedRoot = String(paths.resolve([root])).replace(/\\+$/, '').toLowerCase();
    const normalizedCandidate = String(paths.resolve([candidate])).toLowerCase();
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + '\\');
  }

  function strictNpmCmdEntry(candidate) {
    if (!/\.cmd$/i.test(candidate.path) || !Buffer.isBuffer(candidate.prefixBytes)) return null;
    const text = candidate.prefixBytes.toString('utf8');
    if (text.includes('\0') || /\r(?!\n)/.test(text)) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const common = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
    ];
    if (common.some((line, index) => lines[index] !== line)) return null;
    let invocation = null;
    if (lines.length === common.length + 3
        && lines[common.length] === ')' && lines[common.length + 1] === '') {
      invocation = lines[common.length + 2].match(
        /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & set PATHEXT=%PATHEXT:;\.JS;=;% & "%_prog%" {1,2}"%dp0%\\([^"\r\n]+?\.(?:cjs|mjs|js))" %\*$/,
      );
    } else if (lines.length === common.length + 4
        && lines[common.length] === '  SET PATHEXT=%PATHEXT:;.JS;=;%'
        && lines[common.length + 1] === ')' && lines[common.length + 2] === '') {
      invocation = lines[common.length + 3].match(
        /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" {1,2}"%dp0%\\([^"\r\n]+?\.(?:cjs|mjs|js))" %\*$/,
      );
    }
    if (!invocation || /[%:*?"<>|]/.test(invocation[1])) return null;

    const shimDirectory = paths.dirname(candidate.displayPath);
    const localNodeModules = paths.basename(shimDirectory).toLowerCase() === '.bin'
      && paths.basename(paths.dirname(shimDirectory)).toLowerCase() === 'node_modules'
      ? paths.dirname(shimDirectory)
      : null;
    const globalNodeModules = invocation[1].toLowerCase().startsWith('node_modules\\')
      ? paths.join([shimDirectory, 'node_modules'])
      : null;
    const allowedRoot = localNodeModules || globalNodeModules;
    if (!allowedRoot) return null;

    const lexicalEntry = paths.resolve([shimDirectory, invocation[1]]);
    if (!windowsPathInside(allowedRoot, lexicalEntry) || !deps.fs.existsSync(lexicalEntry)) return null;
    try {
      const entryInfo = (deps.fs.lstatSync || deps.fs.statSync).call(deps.fs, lexicalEntry);
      if (!entryInfo || !entryInfo.isFile() || entryInfo.isSymbolicLink?.()) return null;
      deps.fs.accessSync?.(lexicalEntry, deps.fs.constants?.R_OK ?? 4);
      const realEntry = deps.fs.realpathSync ? deps.fs.realpathSync(lexicalEntry) : lexicalEntry;
      const realRoot = deps.fs.realpathSync ? deps.fs.realpathSync(allowedRoot) : allowedRoot;
      if (!windowsPathInside(realRoot, realEntry)) return null;
      return realEntry;
    } catch (error) {
      return null;
    }
  }

  async function materializeScriptCandidate(candidate, id, options, attempts) {
    if (candidate.windowsCommandScript && id === 'node') {
      attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'Node command wrappers are not trusted interpreters' });
      return { candidate: null, failure: 'NOT_FOUND' };
    }
    if (!candidate.nodeScript && !candidate.windowsCommandScript) {
      return { candidate, failure: null };
    }
    let scriptEntry = candidate.displayPath;
    if (candidate.windowsCommandScript) {
      scriptEntry = strictNpmCmdEntry(candidate);
      if (!scriptEntry) {
        attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'command wrapper is not a strict in-root npm cmd-shim' });
        return { candidate: null, failure: 'NOT_FOUND' };
      }
    }
    const node = await resolveExecutable('node', {
      env: options.env,
      minimumVersion: '18.0.0',
      requiredArch: options.requiredArch,
    });
    if (!node.ok) {
      attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'bundled script requires Node: ' + node.code });
      return { candidate: null, failure: node.code || 'NOT_FOUND' };
    }
    return {
      failure: null,
      candidate: {
        ...candidate,
        path: node.path,
        argsPrefix: [...(node.argsPrefix || []), scriptEntry],
        forcedArch: node.arch,
        windowsCommandScript: false,
      },
    };
  }

  async function probe(candidate, id, options, attempts) {
    const executable = { ok: true, id, path: candidate.path, argsPrefix: candidate.argsPrefix, source: candidate.source, version: null, arch: null };
    let verifiedArch = candidate.forcedArch || null;
    if (options.requiredArch && candidate.nativeArchitectures?.length) {
      if (!candidate.nativeArchitectures.includes(options.requiredArch)) {
        attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'native architecture does not match ' + options.requiredArch });
        return { failure: 'ARCH_MISMATCH' };
      }
      verifiedArch = options.requiredArch;
    } else if (options.requiredArch && candidate.architectureInspected && !verifiedArch) {
      attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'native or interpreter architecture could not be verified' });
      return { failure: 'ARCH_MISMATCH' };
    }
    if (options.requiredArch && verifiedArch && verifiedArch !== options.requiredArch) {
      attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'architecture ' + verifiedArch + ' does not match ' + options.requiredArch });
      return { failure: 'ARCH_MISMATCH' };
    }
    if (id === 'ae-mcp') return { success: executable };
    const args = id === 'node'
      ? ['-p', 'process.version + " " + process.arch']
      : (id === 'powershell' ? ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] : ['--version']);
    const result = await run({ executable, args, env: options.env, timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_OUTPUT_LIMIT });
    const output = (result.stdout + '\n' + result.stderr).trim();
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      attempts.push({ path: candidate.displayPath, source: candidate.source, detail: result.timedOut ? 'probe timed out' : (output || 'probe failed') });
      return { failure: 'PROBE_FAILED' };
    }
    const versionMatch = output.match(/\d+(?:\.\d+){0,3}/);
    const version = versionMatch ? versionMatch[0] : null;
    if (options.minimumVersion) {
      const compared = compareVersions(version, options.minimumVersion);
      if (compared === null || compared < 0) {
        attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'version ' + (version || 'unknown') + ' is below ' + options.minimumVersion });
        return { failure: 'VERSION_TOO_OLD' };
      }
    }
    const arch = verifiedArch || (candidate.nativeArchitectures?.length === 1 ? candidate.nativeArchitectures[0] : reportedArch(output));
    if (options.requiredArch && arch !== options.requiredArch) {
      attempts.push({ path: candidate.displayPath, source: candidate.source, detail: 'architecture ' + arch + ' does not match ' + options.requiredArch });
      return { failure: 'ARCH_MISMATCH' };
    }
    return { success: { ...executable, version, arch } };
  }

  async function loginShellCandidate(id, env, attempts) {
    if (windows || !['claude', 'codex', 'zcode', 'uv', 'npm', 'opencode', 'node', 'ae-mcp'].includes(id)) return null;
    const shell = fileCandidate('/bin/zsh', 'standard', env);
    if (!shell) return null;
    const begin = '__AE_MCP_PATH_BEGIN__';
    const end = '__AE_MCP_PATH_END__';
    const fixedName = id;
    const command = 'p="$(command -v -- ' + fixedName + ' 2>/dev/null)"; printf "' + begin + '%s' + end + '\\n" "$p"';
    const result = await run({
      executable: { ok: true, id, path: shell.path, argsPrefix: [], source: 'login-shell', version: null, arch: null },
      args: ['-lc', command], env, timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_OUTPUT_LIMIT,
    });
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const match = lines.length === 1 && !result.stderr.trim()
      ? lines[0].match(/^__AE_MCP_PATH_BEGIN__(.+)__AE_MCP_PATH_END__$/)
      : null;
    if (!match) {
      if (result.stdout || result.stderr) attempts.push({ path: '/bin/zsh', source: 'login-shell', detail: 'login shell output was polluted or empty' });
      return null;
    }
    return fileCandidate(match[1], 'login-shell', env, id === 'zcode');
  }

  async function resolveExecutable(id, options = {}) {
    if (!EXECUTABLE_IDS.has(id)) throw new TypeError('Unsupported executable id: ' + id);
    const hasExplicitEnv = Object.prototype.hasOwnProperty.call(options, 'env');
    const env = hasExplicitEnv
      ? completeEnvironment(options.env || {})
      : completeSpawnEnv();
    const envKey = 'AE_MCP_' + id.toUpperCase().replace('-', '_') + '_CLI';
    const override = String(options.overridePath || environmentValue(env, envKey, windows) || '').trim();
    const stableLauncherOnly = !windows && id === 'ae-mcp' && options.allowDevelopmentPath !== true;
    const attempts = [];
    let strongestFailure = 'NOT_FOUND';
    const groups = [
      { source: 'override', values: override ? [override] : [] },
      { source: 'runtime', values: runtimeCandidates(id) },
      ...(stableLauncherOnly ? [] : [{ source: 'path', values: pathCandidates(id, env) }]),
    ];
    for (const group of groups) {
      for (const path of group.values) {
        const rawCandidate = fileCandidate(path, group.source, env, id !== 'node');
        if (!rawCandidate) continue;
        const materialized = await materializeScriptCandidate(rawCandidate, id, { ...options, env }, attempts);
        const candidate = materialized.candidate;
        if (!candidate) {
          if (materialized.failure === 'ARCH_MISMATCH') strongestFailure = 'ARCH_MISMATCH';
          else if (materialized.failure === 'VERSION_TOO_OLD' && strongestFailure !== 'ARCH_MISMATCH') strongestFailure = 'VERSION_TOO_OLD';
          continue;
        }
        const result = await probe(candidate, id, { ...options, env }, attempts);
        if (result.success) return result.success;
        strongestFailure = result.failure === 'ARCH_MISMATCH' ? result.failure
          : (strongestFailure === 'NOT_FOUND' || (strongestFailure === 'PROBE_FAILED' && result.failure === 'VERSION_TOO_OLD') ? result.failure : strongestFailure);
      }
    }
    const shellCandidate = stableLauncherOnly ? null : await loginShellCandidate(id, env, attempts);
    if (shellCandidate) {
      const result = await probe(shellCandidate, id, { ...options, env }, attempts);
      if (result.success) return result.success;
      strongestFailure = result.failure;
    }
    for (const path of stableLauncherOnly ? [] : standardCandidates(id, env)) {
      const rawCandidate = fileCandidate(path, 'standard', env, id !== 'node');
      if (!rawCandidate) continue;
      const materialized = await materializeScriptCandidate(rawCandidate, id, { ...options, env }, attempts);
      const candidate = materialized.candidate;
      if (!candidate) {
        if (materialized.failure === 'ARCH_MISMATCH') strongestFailure = 'ARCH_MISMATCH';
        else if (materialized.failure === 'VERSION_TOO_OLD' && strongestFailure !== 'ARCH_MISMATCH') strongestFailure = 'VERSION_TOO_OLD';
        continue;
      }
      const result = await probe(candidate, id, { ...options, env }, attempts);
      if (result.success) return result.success;
      strongestFailure = result.failure;
    }
    return { ok: false, id, code: strongestFailure, attempts };
  }

  return { completeSpawnEnv, resolveExecutable, run, spawn };
}
