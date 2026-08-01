// Reproduce the INVALID_ARGUMENT cluster from the 2026-08-02 native sweep:
// selectedLayers.list, frameRate.set, pixelAspectRatio.set, temporalEase.set.
'use strict';
const fs = require('node:fs');

const TOKEN = fs.readFileSync(String.raw`C:\Users\A\.ae-mcp\auth-token`, 'utf8').trim();
const BASE = 'http://127.0.0.1:11488';

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ae-mcp-token': TOKEN },
    body: JSON.stringify(body),
  });
  return res.json();
}

function invoke(requestId, args, write = false) {
  const body = {
    requestId,
    capabilityId: 'ae.native.exec',
    capabilityVersion: 1,
    arguments: write
      ? { operations: args, operationKey: 'repro-' + requestId, undoGroup: 'repro' }
      : { operations: args },
    deadlineUnixMs: Date.now() + 15000,
  };
  return call('/native/invoke', body);
}

async function main() {
  // Chain: resolve comp -> selectedLayers.list (read), using backward typed ref.
  const r1 = await invoke('repro-read-0001', [
    { op: 'composition.resolve', args: {}, saveAs: 'comp' },
    { op: 'composition.selectedLayers.list', args: { composition: { ref: 'comp' } } },
  ]);
  console.log('selectedLayers:', JSON.stringify(r1).slice(0, 300));

  // frameRate.set with ratio arg (write program).
  const r2 = await invoke('repro-write-0001', [
    { op: 'composition.resolve', args: {}, saveAs: 'comp' },
    { op: 'composition.frameRate.set', args: { composition: { ref: 'comp' }, frameRate: { numerator: 30, denominator: 1 } } },
  ], true);
  console.log('frameRate.set:', JSON.stringify(r2).slice(0, 300));
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
