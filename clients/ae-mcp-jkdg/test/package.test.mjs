import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function json(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

test('package metadata identifies the connector and registry server', async () => {
  const [connector, host] = await Promise.all([
    json(new URL('../package.json', import.meta.url)),
    json(new URL('../../../plugin/host/package.json', import.meta.url)),
  ]);
  assert.equal(connector.name, 'ae-mcp-jkdg');
  assert.deepEqual(connector.bin, { 'ae-mcp-jkdg': 'bin/ae-mcp-jkdg.js' });
  assert.equal(connector.mcpName, 'io.github.junkdoge-joe/ae-mcp');
  assert.deepEqual(connector.engines, { node: '>=18' });
  assert.equal(connector.version, host.version);
});
