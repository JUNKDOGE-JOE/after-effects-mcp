// End-to-end retest of the previously INVALID_ARGUMENT-rejected native ops
// after the OP_PATTERN fix: selectedLayers.list (read) and frameRate.set
// (write), driven through the panel host HTTP surface.
'use strict';
const fs = require('node:fs');

const TOKEN = fs.readFileSync(String.raw`C:\Users\A\.ae-mcp\auth-token`, 'utf8').trim();
const BASE = 'http://127.0.0.1:11488';

async function call(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-ae-mcp-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

function jsx(script) {
  return call('/exec', { script });
}

function invoke(requestId, operations, write = false) {
  return call('/native/invoke', {
    requestId,
    capabilityId: 'ae.native.exec',
    capabilityVersion: 1,
    arguments: write
      ? { operations, operationKey: 'repro-camelcase-' + requestId, undoGroup: 'repro camelCase fix' }
      : { operations },
    deadlineUnixMs: Date.now() + 15000,
  });
}

async function main() {
  const setup = await jsx(
    'var c = app.project.items.addComp("camelRepro", 1280, 720, 1, 4, 25);'
    + 'var s = c.layers.addSolid([0.2, 0.4, 0.8], "S", 1280, 720, 1, 4);'
    + 's.selected = true; "ok"'
  );
  console.log('setup:', JSON.stringify(setup).slice(0, 160));

  const r1 = await invoke('repro-cc-read-01', [
    { op: 'composition.resolve', args: {}, saveAs: 'comp' },
    { op: 'composition.selectedLayers.list', args: { composition: { ref: 'comp' } } },
  ]);
  console.log('selectedLayers:', JSON.stringify(r1).slice(0, 420));

  const r2 = await invoke('repro-cc-write-01', [
    { op: 'composition.resolve', args: {}, saveAs: 'comp' },
    { op: 'composition.frameRate.set', args: { composition: { ref: 'comp' }, frameRate: { numerator: 30, denominator: 1 } } },
  ], true);
  console.log('frameRate.set:', JSON.stringify(r2).slice(0, 420));

  const check = await jsx('"frameRate=" + app.project.activeItem.frameRate');
  console.log('jsx readback:', JSON.stringify(check).slice(0, 160));
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
