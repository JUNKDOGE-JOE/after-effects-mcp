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
const invoke = (requestId, operations, write = false) => call('/native/invoke', {
  requestId,
  capabilityId: 'ae.native.exec',
  capabilityVersion: 1,
  arguments: write
    ? { operations, operationKey: 'repro3-' + requestId, undoGroup: 'repro3' }
    : { operations },
  deadlineUnixMs: Date.now() + 15000,
});

async function main() {
  const items = await invoke('r3-items-01', [
    { op: 'project.items.list', args: { offset: 0, limit: 10 }, returnAs: 'items' },
  ]);
  const out = items.result?.outputs?.items;
  console.log('items out:', JSON.stringify(out).slice(0, 600));
  const comp = (out?.items ?? []).find((i) => i.kind === 'composition' || i.type === 'composition' || i.itemKind === 'composition');
  const locator = comp?.locator ?? comp?.compositionLocator;
  if (!locator) { console.log('NO COMP LOCATOR'); return; }

  const r1 = await invoke('r3-sel-01', [
    { op: 'composition.resolve', args: { locator }, saveAs: 'comp' },
    { op: 'composition.selectedLayers.list', args: { composition: { ref: 'comp' }, offset: 0, limit: 25 } },
  ]);
  console.log('selectedLayers:', JSON.stringify(r1).slice(0, 400));

  const r2 = await invoke('r3-fps-01', [
    { op: 'composition.resolve', args: { locator }, saveAs: 'comp' },
    { op: 'composition.frameRate.set', args: { composition: { ref: 'comp' }, frameRate: { numerator: 30, denominator: 1 } } },
  ], true);
  console.log('frameRate.set:', JSON.stringify(r2).slice(0, 400));
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
