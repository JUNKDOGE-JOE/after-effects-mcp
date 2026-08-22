import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalClientSetupPrompt } from '../src/lib/externalClientPrompt.js';

test('externalClientSetupPrompt inserts the live URL and extension shim path', () => {
  const prompt = externalClientSetupPrompt({
    lang: 'zh',
    port: 12000,
    extensionRoot: 'C:/Program Files/ae-mcp',
  });

  assert.match(prompt, /http:\/\/127\.0\.0\.1:12000\/mcp/);
  assert.match(prompt, /C:\/Program Files\/ae-mcp\/host\/stdio-shim\.js/);
  assert.doesNotMatch(prompt, /<extension root>/);
});

test('externalClientSetupPrompt trims trailing path separators before adding the shim path', () => {
  const slashPrompt = externalClientSetupPrompt({ extensionRoot: '/opt/ae-mcp/' });
  const backslashPrompt = externalClientSetupPrompt({ extensionRoot: 'C:\\ae-mcp\\' });

  assert.ok(slashPrompt.includes('/opt/ae-mcp/host/stdio-shim.js'));
  assert.ok(!slashPrompt.includes('/opt/ae-mcp//host/stdio-shim.js'));
  assert.ok(backslashPrompt.includes('C:\\ae-mcp/host/stdio-shim.js'));
  assert.ok(!backslashPrompt.includes('C:\\ae-mcp\\/host/stdio-shim.js'));
});

test('externalClientSetupPrompt localizes English and falls back to Chinese', () => {
  const english = externalClientSetupPrompt({ lang: 'en' });
  const chinese = externalClientSetupPrompt({ lang: 'zh' });
  const fallback = externalClientSetupPrompt({ lang: 'unknown' });

  assert.notEqual(english, chinese);
  assert.equal(fallback, chinese);
});

test('externalClientSetupPrompt includes the verification and stdio environment contracts', () => {
  for (const lang of ['zh', 'en']) {
    const prompt = externalClientSetupPrompt({ lang });
    assert.match(prompt, /ae_ping/);
    assert.match(prompt, /AE_MCP_HTTP_URL/);
  }
});
