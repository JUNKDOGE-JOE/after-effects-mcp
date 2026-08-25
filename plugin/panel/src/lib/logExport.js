import { redactCredentialText } from './credentialTextRedaction.js';

export function redactSecrets(text, exactSecrets = []) {
  return redactCredentialText(String(text ?? ''), exactSecrets);
}

export function attachmentPathSecrets({ draft, pendingTurn } = {}) {
  const paths = [];
  for (const item of draft?.items || []) {
    if (typeof item?.ref?.localPath === 'string' && item.ref.localPath) paths.push(item.ref.localPath);
  }
  for (const attachment of pendingTurn?.attachments || []) {
    if (typeof attachment?.localPath === 'string' && attachment.localPath) paths.push(attachment.localPath);
  }
  return [...new Set(paths)];
}

function scalar(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (error) { return '[unserializable]'; }
  }
  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function iso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toISOString();
}

function unavailable(reason) {
  return '(unavailable: ' + String(reason || 'source unavailable') + ')';
}

function formatObject(value) {
  if (!value || typeof value !== 'object') return '-';
  return Object.entries(value).map(([key, item]) => key + '=' + scalar(item)).join(' ') || '-';
}

function appendRedacted(lines, value, exactSecrets) {
  lines.push(redactSecrets(value, exactSecrets));
}

function redactBackendStderrLine(value, exactSecrets) {
  const text = String(value ?? '');
  const bounded = text.replace(/https?:\/\/\S+/gi, '[redacted-url]');
  return redactSecrets(bounded, exactSecrets);
}

function formatActivity(event) {
  if (!event || typeof event !== 'object') return '-';
  return [
    '#' + scalar(event.id),
    iso(event.ts),
    'client=' + scalar(event.client),
    'engine=' + scalar(event.engine),
    'ok=' + scalar(event.ok),
    event.denied !== undefined ? 'denied=' + scalar(event.denied) : null,
    event.disposition !== undefined ? 'disposition=' + scalar(event.disposition) : null,
    event.error !== undefined ? 'error=' + scalar(event.error) : null,
    event.durationMs !== undefined ? 'durationMs=' + scalar(event.durationMs) : null,
    event.undoGroup !== undefined ? 'undoGroup=' + scalar(event.undoGroup) : null,
    event.tool !== undefined ? 'tool=' + scalar(event.tool) : null,
    event.transport !== undefined ? 'transport=' + scalar(event.transport) : null,
    event.scriptChars !== undefined ? 'scriptChars=' + scalar(event.scriptChars) : null,
    event.scriptHead !== undefined ? 'scriptHead=' + scalar(event.scriptHead) : null,
    event.hinted !== undefined ? 'hinted=' + scalar(event.hinted) : null,
    event.hintIndex !== undefined ? 'hintIndex=' + scalar(event.hintIndex) : null,
  ].filter(Boolean).join(' ');
}

function redactedField(value, exactSecrets) {
  return redactCredentialText(
    String(value ?? '').replace(/https?:\/\/\S+/gi, '[redacted-url]'),
    exactSecrets,
  );
}

function redactedBackendErrorField(value, exactSecrets) {
  return redactBackendStderrLine(value, exactSecrets);
}

function redactedExtraValue(key, value, exactSecrets) {
  let encoded;
  try { encoded = JSON.stringify({ [key]: value }); } catch { return '[unserializable]'; }
  const redacted = redactCredentialText(
    encoded.replace(/https?:\/\/[^"\\\s]+/gi, '[redacted-url]'),
    exactSecrets,
  );
  try {
    const parsed = JSON.parse(redacted);
    return Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : '[redacted]';
  } catch {
    return '[redacted]';
  }
}

function formatHostLog(event, exactSecrets = []) {
  if (!event || typeof event !== 'object') return '-';
  const known = new Set(['id', 'ts', 'pid', 'level', 'source', 'message']);
  const extra = {};
  for (const [key, value] of Object.entries(event)) {
    if (!known.has(key)) extra[key] = redactedExtraValue(key, value, exactSecrets);
  }
  const suffix = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  return [
    iso(event.ts),
    'pid=' + scalar(redactedField(event.pid, exactSecrets)),
    scalar(redactedField(event.level, exactSecrets)),
    scalar(redactedField(event.source, exactSecrets)),
    scalar(redactedField(event.message, exactSecrets)) + suffix,
  ].join(' ');
}

function formatBackendError(event, exactSecrets) {
  if (!event || typeof event !== 'object') return '-';
  return [
    iso(event.ts),
    'pid=' + scalar(redactedField(event.pid, exactSecrets)),
    'backend=' + scalar(redactedField(event.backend, exactSecrets)),
    'code=' + scalar(redactedField(event.code, exactSecrets)),
    'kind=' + scalar(redactedField(event.kind, exactSecrets)),
    'message=' + scalar(redactedBackendErrorField(event.message, exactSecrets)),
    event.detail ? 'detail=' + scalar(redactedBackendErrorField(event.detail, exactSecrets)) : null,
  ].filter(Boolean).join(' ');
}

function backendErrorKey(event) {
  return [event.ts, event.backend, event.code, event.kind, event.message].map((value) => String(value ?? '')).join('\u0000');
}

function mergedBackendErrors(memoryErrors, diskEvents) {
  const merged = [];
  const positions = new Map();
  const add = (event) => {
    if (!event || typeof event !== 'object') return;
    const key = backendErrorKey(event);
    if (positions.has(key)) {
      const index = positions.get(key);
      if (event.pid !== undefined && merged[index].pid === undefined) merged[index] = event;
      return;
    }
    positions.set(key, merged.length);
    merged.push(event);
  };
  if (Array.isArray(memoryErrors)) memoryErrors.forEach(add);
  if (Array.isArray(diskEvents)) diskEvents
    .filter((event) => event && event.level === 'error' && event.source === 'chat')
    .forEach(add);
  return merged.sort((a, b) => {
    const left = Date.parse(a.ts);
    const right = Date.parse(b.ts);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    return 0;
  });
}

function section(lines, title, producer, exactSecrets, alreadyRedacted = false) {
  lines.push(title);
  try {
    const value = producer();
    if (Array.isArray(value)) {
      if (!value.length) appendRedacted(lines, '(empty)', exactSecrets);
      else if (alreadyRedacted) value.forEach((item) => lines.push(String(item)));
      else value.forEach((item) => appendRedacted(lines, item, exactSecrets));
    } else if (alreadyRedacted) lines.push(String(value));
    else appendRedacted(lines, value, exactSecrets);
  } catch (error) {
    appendRedacted(lines, unavailable(error?.message || String(error)), exactSecrets);
  }
  lines.push('');
}

function parseKeyValueTokens(text) {
  const fields = {};
  const token = /(\w+)=(?:"((?:\\.|[^"])*)"|(\S+))/g;
  let match;
  while ((match = token.exec(text))) {
    if (match[2] !== undefined) {
      try { fields[match[1]] = JSON.parse('"' + match[2] + '"'); } catch { fields[match[1]] = match[2]; }
    } else fields[match[1]] = match[3];
  }
  return fields;
}

export function parsePreviewFrameBranch(line) {
  const match = /previewFrame\.branch\b(.*)$/.exec(String(line || ''));
  if (!match) return null;
  const fields = parseKeyValueTokens(match[1]);
  if (!fields.source || !fields.method || fields.ok === undefined) return null;
  return { ...fields, ok: fields.ok === 'true' };
}

export function summarizePreviewFrameBranches(text = '') {
  const branches = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const branch = parsePreviewFrameBranch(line);
    if (branch) branches.push({ ...branch, raw: line });
  }
  const viewer = new Map();
  let comp = 0;
  let failed = 0;
  const fallbackReasons = new Map();
  for (const branch of branches) {
    if (branch.source === 'comp' && branch.method === 'saveFrameToPng') comp += 1;
    if (branch.source === 'viewer') viewer.set(branch.method, (viewer.get(branch.method) || 0) + 1);
    if (!branch.ok) failed += 1;
    if (branch.fallbackReason && branch.fallbackReason !== '-') {
      fallbackReasons.set(branch.fallbackReason, (fallbackReasons.get(branch.fallbackReason) || 0) + 1);
    }
  }
  const counts = ['comp/saveFrameToPng=' + comp];
  for (const [method, count] of viewer) counts.push('viewer/' + method + '=' + count);
  counts.push('failed=' + failed);
  return {
    branches,
    summary: counts.join('  '),
    fallbackReasons: [...fallbackReasons.entries()].map(([reason, count]) => ({ reason, count })),
    recent: branches.slice(-20).map((branch) => branch.raw),
  };
}

export function readDatedLogTail({ fsImpl, pathJoin, dir, prefix, suffix, now = new Date(), days = 2, lines = 300 } = {}) {
  if (!fsImpl || typeof fsImpl.readFileSync !== 'function' || typeof pathJoin !== 'function') {
    throw new Error('filesystem is unavailable');
  }
  const result = [];
  const count = Math.max(1, Math.floor(Number(days) || 2));
  const limit = Math.max(0, Math.floor(Number(lines) || 300));
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    const file = pathJoin([dir, prefix + key + suffix]);
    try {
      result.push(String(fsImpl.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return result.join('\n').split(/\r?\n/).filter(Boolean).slice(-limit).join('\n');
}

export function buildLogExport({
  panelLogs = [],
  hostInfo = {},
  backendStderrTails = null,
  backendErrors = [],
  hostActivity,
  hostLogMemory,
  hostLogDisk,
  diagnostics,
  diagnosticsError,
  version = '',
  now = new Date(),
  exactSecrets = [],
} = {}) {
  const lines = [];
  appendRedacted(lines, '# ae-mcp diagnostics bundle', exactSecrets);
  const header = [
    ['exported-at', now.toISOString()],
    ['panel-version', version || '-'],
    ['host-version', hostInfo.hostVersion || '-'],
    ['ae-app', formatObject(hostInfo.aeApp)],
    ['cep', hostInfo.cepVersion || '-'],
    ['os', formatObject(hostInfo.os)],
    ['host-node', hostInfo.hostNode || '-'],
    ['chromium-ua', hostInfo.chromiumUa || '-'],
    ['plugin-port', hostInfo.pluginPort || '-'],
    ['logs-dir', hostInfo.logsDir || '-'],
    ['log-level', hostInfo.logLevel || '-'],
  ];
  for (const [key, value] of header) appendRedacted(lines, key + ': ' + value, exactSecrets);
  lines.push('');

  section(lines, '## diagnostics', () => {
    if (diagnosticsError) return unavailable(diagnosticsError);
    if (!Array.isArray(diagnostics)) return unavailable('diagnostics were not collected');
    return diagnostics.map((item) => [item?.id || '-', item?.ok === true ? 'ok=true' : 'ok=false', item?.detail || '-'].join(' '));
  }, exactSecrets);
  section(lines, '## host activity (last N)', () => {
    if (!Array.isArray(hostActivity)) return unavailable('host activity is unavailable');
    return hostActivity.slice(-500).map(formatActivity);
  }, exactSecrets);
  section(lines, '## host log (memory, last 500)', () => {
    if (!Array.isArray(hostLogMemory)) return unavailable('host memory log is unavailable');
    return hostLogMemory.slice(-500).map((event) => formatHostLog(event, exactSecrets));
  }, exactSecrets, true);
  section(lines, '## host log (disk tail, 2 days, last 500)', () => {
    if (!Array.isArray(hostLogDisk)) return unavailable('host disk log is unavailable');
    return hostLogDisk.slice(-500).map((event) => formatHostLog(event, exactSecrets));
  }, exactSecrets, true);
  section(lines, '## panel log (' + panelLogs.length + ')', () => panelLogs.map(String), exactSecrets);
  section(lines, '## backend errors (last 50, memory + disk)', () => {
    if (!Array.isArray(backendErrors) && !Array.isArray(hostLogDisk)) return unavailable('backend error history is unavailable');
    return mergedBackendErrors(backendErrors, hostLogDisk).slice(-50)
      .map((event) => formatBackendError(event, exactSecrets));
  }, exactSecrets, true);
  section(lines, '## backend stderr tails', () => {
    const tails = backendStderrTails;
    if (!tails || typeof tails !== 'object' || !Object.keys(tails).length) return unavailable('no backend stderr tail is available');
    const result = [];
    for (const [name, tail] of Object.entries(tails)) {
      result.push('### ' + name);
      if (!tail) {
        result.push('(empty)');
        continue;
      }
      result.push(...String(tail).replace(/\r\n/g, '\n').split('\n')
        .map((line) => redactBackendStderrLine(line, exactSecrets)));
    }
    return result;
  }, exactSecrets, true);
  section(lines, '## previewFrame branches', () => {
    const previewSource = [hostLogMemory, hostLogDisk]
      .filter(Array.isArray)
      .flat()
      .map((event) => formatHostLog(event, exactSecrets))
      .join('\n');
    const summary = summarizePreviewFrameBranches(previewSource);
    const result = ['summary: ' + summary.summary];
    result.push('fallbackReason counts:');
    if (!summary.fallbackReasons.length) result.push('(none)');
    else summary.fallbackReasons.forEach((item) => result.push(item.reason + '=' + item.count));
    result.push('recent events:');
    result.push(...(summary.recent.length ? summary.recent : ['(none)']));
    return result;
  }, exactSecrets);

  // Each source line has already gone through redactSecrets. Applying the
  // stateful multiline redactor to the complete bundle would let one malformed
  // credential container truncate unrelated later sections.
  return lines.join('\n') + '\n';
}

export function exportFileName(now = new Date()) {
  return 'export-' + now.toISOString().replace(/[:.]/g, '-') + '.txt';
}

export function keepLogLine(level, message) {
  if (level !== 'error') return true;
  return /error|failed|exception/i.test(String(message || ''));
}
