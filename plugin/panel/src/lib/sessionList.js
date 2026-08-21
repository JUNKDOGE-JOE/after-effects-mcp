const TITLE_LIMIT = 40;

function compactText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function truncateTitle(value) {
  const chars = Array.from(compactText(value));
  if (chars.length <= TITLE_LIMIT) return chars.join('');
  return chars.slice(0, TITLE_LIMIT).join('') + '…';
}

function localDate(value, lang) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN');
}

export function deriveTitle(entries) {
  const first = (Array.isArray(entries) ? entries : [])
    .find((entry) => entry && entry.type === 'user-text' && compactText(entry.text));
  return first ? truncateTitle(first.text) : null;
}

export function displayTitle(meta, lang = 'zh') {
  const title = compactText(meta && meta.title);
  if (title) return title;
  const label = lang === 'en' ? 'New session' : '新会话';
  const date = localDate(meta && (meta.createdAt || meta.updatedAt), lang);
  return date ? `${label} · ${date}` : label;
}

export function sortSessions(list) {
  return [...(Array.isArray(list) ? list : [])].sort((left, right) => {
    const leftTime = new Date(left && left.updatedAt).getTime() || 0;
    const rightTime = new Date(right && right.updatedAt).getTime() || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left && left.id).localeCompare(String(right && right.id));
  });
}

export function filterSessions(list, { archived = false, search = '' } = {}) {
  const query = compactText(search).toLocaleLowerCase();
  return (Array.isArray(list) ? list : []).filter((meta) => {
    if (Boolean(meta && meta.archived) !== Boolean(archived)) return false;
    if (!query) return true;
    return compactText(meta && meta.title).toLocaleLowerCase().includes(query);
  });
}

export function relativeTime(timestamp, now = Date.now(), lang = 'zh') {
  const value = new Date(timestamp).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(value) || !Number.isFinite(current)) return '';
  const elapsed = Math.max(0, current - value);
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return lang === 'en' ? 'Just now' : '刚刚';
  if (minutes < 60) return lang === 'en' ? `${minutes}m ago` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return lang === 'en' ? `${hours}h ago` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return lang === 'en' ? `${days}d ago` : `${days} 天前`;
  return localDate(timestamp, lang);
}

export function backendLabel(backend, lang = 'zh') {
  const labels = {
    subscription: 'Claude',
    codex: 'Codex',
    opencode: 'OpenCode',
  };
  return labels[backend] || (lang === 'en' ? 'Unknown' : '未知');
}

