import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const vendorUrl = new URL('../vendor/stdio-shim.js', import.meta.url);
const sourceUrl = new URL('../../../plugin/host/stdio-shim.js', import.meta.url);

test('vendored stdio shim is byte-identical to the host source', async () => {
  const [vendor, source] = await Promise.all([
    readFile(vendorUrl),
    readFile(sourceUrl),
  ]);
  assert.equal(Buffer.compare(vendor, source), 0);
});
