import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createPlatformAdapter } from './platform/index.js';
import { resolveClaudeCli } from './claudeAgentBackend.js';

export async function probeClaudeLogin({
  platform,
  resolveClaude,
  spawnImpl,
  env,
  timeoutMs = 10000,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  const resolver = resolveClaude || resolveClaudeCli;
  const resolved = await resolver({ platform: adapter, env });
  if (!resolved || resolved.ok === false) {
    return {
      loggedIn: false,
      cliOk: false,
      reason: resolved?.code === 'VERSION_TOO_OLD' ? 'cli-too-old' : 'cli-missing',
      detail: resolved?.detail || 'Claude CLI is unavailable',
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let proc = null;
    const spawnEnv = claudeChannelEnv(adapter.completeSpawnEnv(env || {}), {
      channel: 'subscription',
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    const timer = setTimeout(() => {
      if (proc && proc.kill) {
        try { proc.kill(); } catch (e) { /* best effort */ }
      }
      finish({
        loggedIn: false,
        cliOk: true,
        cliVersion: resolved.version,
        cliPath: resolved.displayPath || resolved.cliPath,
        reason: 'probe-timeout',
        detail: 'Claude CLI auth probe timed out',
      });
    }, timeoutMs);

    try {
      const executable = resolved.executable || {
        ok: true,
        id: 'claude',
        path: resolved.cliPath,
        argsPrefix: [],
        source: 'path',
        version: resolved.version || null,
        arch: null,
      };
      const args = ['auth', 'status', '--json'];
      proc = spawnImpl
        ? spawnImpl(
          executable.path,
          [...(executable.argsPrefix || []), ...args],
          { stdio: 'pipe', windowsHide: true, env: spawnEnv },
        )
        : adapter.spawn(executable, args, {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnv,
        });
    } catch (e) {
      finish({
        loggedIn: false,
        cliOk: true,
        cliVersion: resolved.version,
        cliPath: resolved.displayPath || resolved.cliPath,
        reason: 'probe-failed',
        detail: e?.message || String(e),
      });
      return;
    }

    proc.stdout?.on?.('data', (chunk) => {
      stdout = (stdout + String(chunk || '')).slice(-4000);
    });
    if (proc.stderr && proc.stderr.on) {
      proc.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
    }
    if (proc.on) {
      proc.on('error', (err) => {
        finish({
          loggedIn: false,
          cliOk: true,
          cliVersion: resolved.version,
          cliPath: resolved.displayPath || resolved.cliPath,
          reason: 'probe-failed',
          detail: err?.message || String(err),
        });
      });
      proc.on('exit', () => {
        let status = null;
        try { status = JSON.parse(stdout); } catch {}
        if (status && typeof status.loggedIn === 'boolean') {
          finish({
            loggedIn: status.loggedIn,
            cliOk: true,
            cliVersion: resolved.version,
            cliPath: resolved.displayPath || resolved.cliPath,
            reason: status.loggedIn ? null : 'not-logged-in',
            detail: status.loggedIn
              ? [resolved.version, resolved.displayPath || resolved.cliPath]
                .filter(Boolean)
                .join(' · ')
              : 'Claude CLI is not logged in.',
          });
          return;
        }
        finish({
          loggedIn: false,
          cliOk: true,
          cliVersion: resolved.version,
          cliPath: resolved.displayPath || resolved.cliPath,
          reason: 'probe-failed',
          detail: stderr.trim() || stdout.trim() || 'Claude auth probe exited without JSON',
        });
      });
    }
  });
}
