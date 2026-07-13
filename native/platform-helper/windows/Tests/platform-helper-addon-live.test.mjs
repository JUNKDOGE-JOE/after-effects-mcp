import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

const pipeName = String.raw`\\.\pipe\com.junkdoge.ae-mcp.platform-helper`;
const addonPath = process.env.AE_MCP_WINDOWS_ADDON_PATH || '';
const helperPath = process.env.AE_MCP_WINDOWS_HELPER_PATH || '';

test('Windows addon rejects a squatted pipe before sending request bytes', {
  skip: process.platform !== 'win32' || !addonPath || !helperPath,
}, async (t) => {
  const server = net.createServer();
  const received = [];
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const addon = createRequire(import.meta.url)(addonPath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex');
  assert.throws(
    () => addon.createTransport({
      expectedServerPath: helperPath,
      expectedServerSha256: sha256,
    }),
    /server identity|server process|identity verification/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(Buffer.concat(received).length, 0);
});
