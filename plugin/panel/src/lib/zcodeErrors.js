// Spec B1: localize + actionable-ize ZCode failures. For zh a header line
// with concrete next steps is prepended; the raw English detail is kept
// below for diagnostics. en (and unknown patterns) pass through.
const ZH_RULES = [
  {
    // Provider ids may contain dots (e.g. "mediastorm_glm/glm-5.2"): capture the
    // whole non-space run, then drop one trailing sentence terminator if present.
    re: /Model provider is missing an API key:\s*([^\s]+?)[.。]?(?=\s|$)/i,
    hint: (m) => 'ZCode provider「' + m[1] + '」缺少 API Key —— 到 设置 → AI 服务 → ZCode 通道 粘贴一次 Key（保存在本机 ~/.ae-mcp/zcode-key），或在 ~/.zcode/cli/config.json 里配置。',
  },
  {
    re: /Model config is missing/i,
    hint: () => '未找到 ZCode 模型配置 —— 打开 ZCode 选择 provider/model，或创建 ~/.zcode/cli/config.json 指定 provider 与默认模型。',
  },
  {
    re: /Provider authentication failed/i,
    hint: () => 'ZCode provider 鉴权失败 —— 检查 API Key 是否有效；若是官方托管计划（start-plan），面板尚不支持其桌面验证码桥接，请改用 CLI 配置通道。',
  },
];

export function localizeZcodeError(message, lang = 'en') {
  const text = String(message || '');
  if (lang !== 'zh' || !text) return text;
  for (const rule of ZH_RULES) {
    const m = rule.re.exec(text);
    if (m) {
      const hint = rule.hint(m);
      // Idempotent: if the text already starts with this guidance header
      // (i.e. it was localized before), do not prepend it again.
      if (text.startsWith(hint)) return text;
      return hint + '\n' + text;
    }
  }
  return text;
}
