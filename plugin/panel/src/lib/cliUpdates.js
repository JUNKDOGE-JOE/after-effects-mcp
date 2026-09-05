import { compareVersions, createVersionChecker } from './versionUpdates.js';
export { compareVersions } from './versionUpdates.js';
export const ASTRA_CLI_BASELINE = '0.153.4';
const PACKAGES = { codex: '@openai/codex', subscription: '@anthropic-ai/claude-code', opencode: 'opencode-ai' };
const DOCS = {
  codex: 'https://learn.chatgpt.com/docs/cli',
  subscription: 'https://code.claude.com/docs/en/setup',
  opencode: 'https://opencode.ai/docs/cli/#upgrade',
};

export function cliIdentity(executable, fs) {
  if (!executable?.ok) return null;
  const path = executable.displayPath || executable.path;
  let realPath = executable.argsPrefix?.[0] || executable.path;
  try { realPath = fs?.realpathSync?.(realPath) || realPath; } catch {}
  return { path, version: executable.version || '', source: executable.source,
    launchPath: executable.path, realPath, script: executable.argsPrefix?.[0] || '' };
}

export function cliUpdateGuide(backend, cli, lang = 'zh') {
  const en = lang === 'en';
  const paths = [cli?.path, cli?.realPath, cli?.script].join('/').replace(/\\/g, '/').toLowerCase();
  let command = '', source = 'standalone';
  let url = DOCS[backend];
  let detail = en ? 'Use the original installation source to update this executable.' : '请按此可执行文件的原安装来源更新。';
  if (backend === 'opencode' && cli?.source === 'runtime') {
    source = 'bundled';
    url = 'https://github.com/JUNKDOGE-JOE/after-effects-mcp/releases';
    detail = en ? 'Choose a panel release whose notes include a newer OpenCode runtime. Reinstalling the same panel version does not upgrade it.'
      : '请选用发行说明明确附带新版 OpenCode runtime 的面板 Release。重装同一面板版本不会升级它。';
  } else if (/\/openai\/codex\/bin\//.test(paths)) {
    source = 'desktop';
    detail = en ? 'Update the Codex desktop app that owns this executable.' : '请更新提供此可执行文件的 Codex 桌面应用。';
  } else if (/\/winget\/(packages|links)\//.test(paths)) {
    source = 'winget';
    if (backend === 'subscription') command = 'winget upgrade Anthropic.ClaudeCode';
  } else if (/\/(cellar|caskroom)\/(codex|opencode|claude-code)(?:@latest)?\//.test(paths)) {
    source = 'homebrew';
    const name = backend === 'subscription' ? (paths.includes('claude-code@latest') ? 'claude-code@latest' : 'claude-code') : backend;
    command = 'brew upgrade ' + name;
  } else if (/\/node_modules\//.test(paths)) {
    source = paths.includes('/pnpm/') || paths.includes('/.pnpm/') ? 'pnpm' : paths.includes('/bun/') ? 'bun' : 'npm';
    command = source === 'npm' ? `npm install -g ${PACKAGES[backend]}@latest` : `${source} add -g ${PACKAGES[backend]}@latest`;
  } else if (backend === 'subscription' && /\/\.local\/(bin\/claude|share\/claude\/)/.test(paths)) {
    source = 'native'; command = 'claude update';
  } else if (backend === 'opencode' && /\/\.opencode\/bin\//.test(paths)) {
    source = 'native'; command = 'opencode upgrade';
  }
  return { source, command, url, detail };
}

export function createCliUpdateChecker({ requestJson, now = Date.now, timeoutMs = 8000 }) {
  const checkers = new Map();
  return async (backend, cli, options = {}) => {
    const current = cli?.version || '';
    if (!PACKAGES[backend] || !cli) return { status: 'unknown', current };
    if (!checkers.has(backend)) {
      checkers.set(backend, createVersionChecker({ requestJson, now, timeoutMs,
        url: `https://registry.npmjs.org/${PACKAGES[backend]}/latest`, parseRelease: (json) => ({ latest: json?.version }) }));
    }
    return checkers.get(backend)(current, options);
  };
}

export function codexCatalogNotice(probe, lang = 'zh') {
  const en = lang === 'en';
  if (!probe) return en ? 'Checking model catalog…' : '正在检查模型目录…';
  if (probe.catalogStatus !== 'complete') return en
    ? 'Model catalog check failed; saved choices are retained. Recheck to confirm availability.'
    : '模型目录检查失败，已保留原有选择；请重新检测以确认可用性。';
  if (probe.models?.some((m) => m.id === 'gpt-6-astra' && !m.hidden)) return '';
  if (compareVersions(probe.cliVersion, ASTRA_CLI_BASELINE) === -1) return en
    ? `Astra is absent from this old CLI catalog. Update Codex to ${ASTRA_CLI_BASELINE} or later, then recheck; other available models remain usable.`
    : `当前旧 CLI 目录没有 Astra。请更新 Codex 至 ${ASTRA_CLI_BASELINE} 或更高版本后重新检测；其他可用模型仍可使用。`;
  return en ? 'This account or route does not list Astra as available. Choose a listed model.'
    : '当前账号或路由未将 Astra 列为可用模型，请选择目录内的模型。';
}
