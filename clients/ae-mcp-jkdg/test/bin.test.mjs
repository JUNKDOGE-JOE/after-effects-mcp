import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const binPath = fileURLToPath(new URL('../bin/ae-mcp-jkdg.js', import.meta.url));

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: Object.assign({}, process.env, options.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input || '');
  });
}

test('bin forwards initialize through the local Streamable HTTP endpoint', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      requests.push({ method: req.method, url: req.url });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      requests.push({ method: req.method, url: req.url, message });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const input = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'connector-test', version: '1' } },
  }) + '\n';
  try {
    const result = await runCli([], {
      env: { AE_MCP_HTTP_URL: `http://127.0.0.1:${port}/mcp` },
      input,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.equal(requests.some((request) => request.method === 'GET' && request.url === '/health'), true);
    assert.equal(requests.some((request) => request.method === 'POST' && request.url === '/mcp'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('--version prints the package version and exits successfully', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await runCli(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, packageJson.version + '\n');
  assert.equal(result.stderr, '');
});

test('--help prints usage and exits successfully', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage: ae-mcp-jkdg/u);
  assert.match(result.stdout, /--url=<http url>/u);
  assert.equal(result.stderr, '');
});
