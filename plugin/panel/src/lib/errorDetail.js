import { redactValue } from './exactSecretRedaction.js';
import { redactCredentialText } from './credentialTextRedaction.js';

function scalar(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[unserializable]'; }
  }
  return String(value);
}

function redactFreeText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => redactCredentialText(line.replace(/https?:\/\/\S+/gi, '[redacted-url]')))
    .join('\n');
}

export function formatErrorDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return '';
  const lines = [];
  const used = new Set();
  const hasExit = detail.exitCode !== undefined && detail.exitCode !== null;
  if (hasExit || detail.signal) {
    const exit = hasExit ? `exit ${detail.exitCode}` : 'process signal';
    lines.push(detail.signal ? `${exit} (${detail.signal})` : exit);
    used.add('exitCode');
    used.add('signal');
  }
  if (detail.method) {
    lines.push(`method: ${detail.method}`);
    used.add('method');
  }
  if (detail.httpStatus || detail.endpoint) {
    const status = detail.httpStatus ? `HTTP ${detail.httpStatus}` : 'HTTP request';
    lines.push(detail.endpoint ? `${status} ${detail.endpoint}` : status);
    used.add('httpStatus');
    used.add('endpoint');
  }
  if (detail.jsonRpcCode !== undefined && detail.jsonRpcCode !== null) {
    lines.push(`JSON-RPC code: ${detail.jsonRpcCode}`);
    used.add('jsonRpcCode');
  }
  if (detail.jsonRpcData !== undefined) {
    lines.push(`JSON-RPC data: ${scalar(detail.jsonRpcData)}`);
    used.add('jsonRpcData');
  }
  if (detail.errorName) {
    lines.push(`error: ${detail.errorName}`);
    used.add('errorName');
  }
  if (detail.mcpStatus !== undefined && detail.mcpStatus !== null && detail.mcpStatus !== '') {
    lines.push(`MCP status: ${scalar(detail.mcpStatus)}`);
    used.add('mcpStatus');
  }
  if (detail.lastError) {
    lines.push(`last error: ${redactFreeText(scalar(detail.lastError))}`);
    used.add('lastError');
  }
  for (const [key, label] of [
    ['upstreamMessage', 'upstream message'],
    ['responseExcerpt', 'response excerpt'],
  ]) {
    if (!detail[key]) continue;
    lines.push(`${label}: ${redactFreeText(scalar(detail[key]))}`);
    used.add(key);
  }
  if (detail.resolution && typeof detail.resolution === 'object') {
    const resolution = detail.resolution;
    if (resolution.code) lines.push(`resolution: ${resolution.code}`);
    const attempts = Array.isArray(resolution.attempts) ? resolution.attempts : [];
    if (attempts.length) {
      lines.push('attempts:');
      for (const attempt of attempts) {
        const source = attempt?.source ? ` [${attempt.source}]` : '';
        const suffix = attempt?.detail ? `: ${attempt.detail}` : '';
        lines.push(`- ${attempt?.path || '-'}${source}${suffix}`);
      }
    }
    used.add('resolution');
  }
  if (detail.stderrTail) {
    lines.push('stderr:');
    lines.push(redactFreeText(detail.stderrTail));
    used.add('stderrTail');
  }
  for (const [key, value] of Object.entries(detail)) {
    if (used.has(key) || value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${scalar(value)}`);
  }
  return lines.join('\n');
}

export function serializeErrorDetail(detail, exactSecrets = [], maxChars = 2000) {
  if (!detail || typeof detail !== 'object') return '';
  let text;
  try { text = JSON.stringify(redactValue(detail, exactSecrets)); } catch { text = '[unserializable]'; }
  text = redactCredentialText(text, exactSecrets);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function firstErrorDetailLine(detail, exactSecrets = []) {
  const line = formatErrorDetail(redactValue(detail, exactSecrets)).split(/\r?\n/, 1)[0] || '';
  return redactCredentialText(line, exactSecrets);
}
