import { redactCredentialText } from './credentialTextRedaction.js';

export function redactSecrets(text, exactSecrets = []) {
  return redactCredentialText(text, exactSecrets);
}

export function buildLogExport({ panelLogs = [], hostInfo = {}, sidecarTail = '', version = '', now = new Date(), exactSecrets = [] } = {}) {
  const lines = [];
  lines.push('# ae-mcp panel log export');
  lines.push('exported-at: ' + now.toISOString());
  lines.push('panel-version: ' + (version || '-'));
  lines.push('host-version: ' + (hostInfo.hostVersion || '-'));
  lines.push('python-version: ' + (hostInfo.pythonVersion || '-'));
  lines.push('');
  lines.push('## panel logs (' + panelLogs.length + ')');
  for (const line of panelLogs) lines.push(redactSecrets(line, exactSecrets));
  lines.push('');
  lines.push('## sidecar stderr tail');
  lines.push(sidecarTail ? redactSecrets(sidecarTail, exactSecrets) : '(empty)');
  return lines.join('\n') + '\n';
}

export function exportFileName(now = new Date()) {
  return 'export-' + now.toISOString().replace(/[:.]/g, '-') + '.txt';
}

export function keepLogLine(level, message) {
  if (level !== 'error') return true;
  return /error|failed|exception/i.test(String(message || ''));
}
