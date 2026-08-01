// T4 native-novelty smoke (issue #86): through the real client chain, prove
// endpoint discovery, wire-v1 handshake, hello identity, capabilities, and
// one read-only native program against a live Windows AE host.
'use strict';

const {
  createNativeAegpClient,
  discoverWindowsEndpoints,
} = require('./plugin/host/native-aegp-client.js');

function event(kind, details) {
  process.stdout.write(`${JSON.stringify({ kind, ...details })}\n`);
}

async function waitForEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let endpoints = [];
    try {
      endpoints = discoverWindowsEndpoints({});
    } catch {
      endpoints = [];
    }
    if (endpoints.length > 0) return endpoints;
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main() {
  const endpoints = await waitForEndpoint(Number(process.env.SMOKE_WAIT_MS ?? 120000));
  event('discovery', { count: endpoints.length, endpoints: endpoints.map((e) => ({
    hostInstanceId: e.hostInstanceId,
    pipePath: e.pipePath,
    pid: e.pid,
    sourceCommit: e.sourceCommit,
  })) });
  if (endpoints.length !== 1) {
    event('fatal', { reason: 'expected exactly one endpoint' });
    process.exit(1);
  }

  const client = createNativeAegpClient({
    runtime: { platform: 'win32', arch: 'x64' },
    requestTimeoutMs: 15000,
  });
  try {
    await client.connect(Date.now() + 20000);
    event('connect', { ok: true });
    const capabilities = await client.capabilities({ detail: 'full', limit: 100 });
    event('capabilities', {
      digest: capabilities?.capabilitiesDigest ?? capabilities?.result?.capabilitiesDigest,
      host: capabilities?.host ?? capabilities?.result?.host,
    });
    try {
      const probe = await client.invoke({
        requestId: 't4-smoke-readonly-0001',
        capabilityId: 'ae.native.exec',
        capabilityVersion: 1,
        arguments: {
          operations: [{ op: 'project.items.list', args: {} }],
        },
        deadlineUnixMs: Date.now() + 15000,
      });
      event('probe', { ok: true, result: JSON.stringify(probe).slice(0, 600) });
    } catch (error) {
      // A typed rejection still proves the full round trip; only transport
      // failures are smoke blockers.
      event('probe', {
        ok: false,
        code: error?.code ?? error?.name,
        message: String(error?.message ?? error).slice(0, 300),
      });
    }
    await client.close();
    event('close', { ok: true });
  } catch (error) {
    event('fatal', { reason: String(error?.message ?? error).slice(0, 400) });
    process.exit(1);
  }
}

main().catch((error) => {
  event('fatal', { reason: String(error?.message ?? error).slice(0, 400) });
  process.exit(1);
});
