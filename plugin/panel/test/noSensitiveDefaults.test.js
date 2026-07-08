import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
