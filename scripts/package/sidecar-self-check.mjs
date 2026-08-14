#!/usr/bin/env node

// Hermetic sidecar self-check (#239): prove that a REAL staged artifact can
// start the Claude sidecar where production resolves it.
//
// Offline by construction — no account, no network round-trip: the resolved
// entrypoint is spawned with `--self-check`, which exits right after the
// import closure (lib.mjs, ../shared/*, @anthropic-ai/claude-agent-sdk and
// its platform binary package) has actually loaded. A bounded timeout kills
// hangs. Never run the networked `--probe` here.
//
// Modes:
//   --ext-root <staged extension root> --platform windows-x64
//       the full production resolver path: development-vs-packaged decision,
//       then the closure contract (plugin/panel/src/cep/claudeAuth.js)
//   --node-root <runtime/<platform>/node dir> --platform macos-arm64
//       the closure contract at an explicit node root, for staged bundles
//       that have no runtime activation yet (CI); shares the same production
//       requireSidecarClosure code path via verifySidecarClosureAt
//
// Known blind spot (verified by mutation on a real staged artifact): the SDK's
// platform binary (e.g. claude-agent-sdk-win32-x64/claude.exe) is spawned at
// query time, not imported, so removing it does NOT fail this check. The
// binary is enforced statically instead — by stage-sidecar-payload.mjs's
// fail-closed closure and by the stage verifier whitelists.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  resolveSidecarPath,
  verifySidecarClosureAt,
} from '../../plugin/panel/src/cep/claudeAuth.js';

const DEFAULT_TIMEOUT_MS = 30000;

function checkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function realAdapter(platformId) {
  return {
    id: platformId,
    fs,
    paths: {
      join: (parts) => path.join(...parts),
    },
  };
}

function scrubbedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|AE_MCP_)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export async function runSidecarSelfCheck({ extRoot, nodeRoot, platform, timeoutMs }) {
  let entry;
  if (extRoot) {
    entry = resolveSidecarPath({
      extRoot: path.resolve(extRoot),
      platform: realAdapter(platform),
      fsImpl: fs,
    });
    if (!entry) {
      throw checkError('SELF_CHECK_UNRESOLVED', 'the production resolver returned no sidecar path');
    }
    const expectedSegment = path.join('runtime', platform, 'node', 'sidecar');
    if (!entry.includes(expectedSegment)) {
      throw checkError(
        'SELF_CHECK_WRONG_BRANCH',
        `the resolver selected a non-packaged path: ${entry}`,
      );
    }
  } else {
    entry = verifySidecarClosureAt({
      nodeRoot: path.resolve(nodeRoot),
      platform: realAdapter(platform),
      fsImpl: fs,
    });
  }

  const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--self-check'], {
      cwd: path.dirname(entry),
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(checkError('SELF_CHECK_TIMEOUT', `self-check exceeded ${budget}ms`));
    }, budget);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        reject(checkError(
          'SELF_CHECK_FAILED',
          `sidecar exited ${code}: ${stderr.trim().slice(0, 2000) || '(no stderr)'}`,
        ));
      }
    });
  });

  let parsed;
  try {
    parsed = JSON.parse(output.trim().split('\n')[0]);
  } catch {
    throw checkError('SELF_CHECK_OUTPUT_INVALID', `unparseable self-check output: ${output.slice(0, 500)}`);
  }
  if (parsed.ok !== true || parsed.selfCheck?.sdkLoaded !== true) {
    throw checkError('SELF_CHECK_OUTPUT_INVALID', `self-check did not confirm the closure: ${output.slice(0, 500)}`);
  }
  return { entry, selfCheck: parsed.selfCheck };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--ext-root', '--node-root', '--platform', '--timeout-ms'].includes(key)
        || value === undefined || values.has(key)) {
      throw checkError('SELF_CHECK_ARGUMENT_INVALID', `invalid argument: ${String(key)}`);
    }
    values.set(key, value);
  }
  const extRoot = values.get('--ext-root');
  const nodeRoot = values.get('--node-root');
  if ((!extRoot && !nodeRoot) || (extRoot && nodeRoot) || !values.has('--platform')) {
    throw checkError(
      'SELF_CHECK_ARGUMENT_INVALID',
      'exactly one of --ext-root/--node-root plus --platform is required',
    );
  }
  return {
    extRoot,
    nodeRoot,
    platform: values.get('--platform'),
    timeoutMs: values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : undefined,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = await runSidecarSelfCheck(parseArgs(process.argv.slice(2)));
    process.stdout.write(`sidecar self-check passed: ${result.entry}\n`);
    process.stdout.write(`${JSON.stringify(result.selfCheck)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'SELF_CHECK_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
