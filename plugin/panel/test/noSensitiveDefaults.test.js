import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { userTurnEntry, reduceEvent } from '../src/lib/chatEntries.js';
import { attachmentPathSecrets, buildLogExport } from '../src/lib/logExport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const forbiddenHost = ['token', 'mediastorm', 'studio'].join('.');
const scanRoots = [
  'docs',
  'plugin/client/dist',
  'plugin/panel/src',
  'plugin/panel/test',
];

async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

test('provider examples and defaults do not expose private hostnames', async () => {
  const hits = [];
  for (const root of scanRoots) {
    for await (const filePath of walkFiles(path.join(repoRoot, root))) {
      const body = await readFile(filePath, 'utf8');
      if (body.includes(forbiddenHost)) {
        hits.push(path.relative(repoRoot, filePath));
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('attachment paths stay out of transcript, events, diagnostics, and exported logs', () => {
  const secret = '/private/attachment-secret/customer.mov';
  const turn = {
    turnId: 'turn-sensitive',
    text: 'inspect',
    attachments: [{
      id: 'att-sensitive',
      name: 'customer.mov',
      localPath: secret,
      size: 42,
      mediaType: 'video/quicktime',
      temporary: false,
    }],
  };
  const transcript = userTurnEntry(turn);
  const eventEntries = reduceEvent([], {
    type: 'error',
    kind: 'transport',
    message: 'Attachment failed at [attachment-path]',
    turnId: turn.turnId,
    dispatchState: 'uncertain',
  });
  const exactSecrets = attachmentPathSecrets({
    draft: { items: [{ ref: turn.attachments[0] }] },
    pendingTurn: turn,
  });
  const exported = buildLogExport({
    panelLogs: ['diagnostic selected ' + secret],
    sidecarTail: 'sidecar failed to read ' + secret,
    exactSecrets,
  });

  assert.equal(JSON.stringify(transcript).includes(secret), false);
  assert.equal(JSON.stringify(eventEntries).includes(secret), false);
  assert.deepEqual(exactSecrets, [secret]);
  assert.equal(exported.includes(secret), false);
  assert.match(exported, /\[redacted\]/);
});
