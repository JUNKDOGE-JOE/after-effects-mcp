import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalClientSetupPrompt } from '../src/lib/externalClientPrompt.js';
import { readFileSync } from 'node:fs';

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
    assert.match(prompt, /ae_status/);
    assert.doesNotMatch(prompt, /ae_ping/);
    assert.match(prompt, /AE_MCP_HTTP_URL/);
  }
});

test('both prompt entry points target the receiving client without a client-specific command', () => {
  for (const lang of ['zh', 'en']) {
    const readme = readFileSync(new URL(lang === 'zh' ? '../../../README.zh-CN.md' : '../../../README.md', import.meta.url), 'utf8');
    const setup = readme.match(/```text\n([\s\S]*?)```/)[1];
    for (const prompt of [setup, externalClientSetupPrompt({ lang })]) {
      assert.match(prompt, lang === 'zh' ? /正在接收并执行此提示词的当前客户端/ : /current client receiving and executing/);
      assert.match(prompt, lang === 'zh' ? /手动步骤/ : /manual steps/);
      assert.match(prompt, lang === 'zh' ? /其它 MCP/ : /other\s+MCP/);
      assert.match(prompt, /Streamable HTTP/);
      assert.match(prompt, /stdio/);
      assert.match(prompt, /ae_status/);
      assert.doesNotMatch(prompt, /claude mcp add|\.claude|\.cursor|\.codex/);
    }
  }
});
