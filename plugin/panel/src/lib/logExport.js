// Spec C: log export aggregation + level filtering (pure, node-testable).

// Redacts secrets, keeping the first 6 chars of each secret so users can
// still identify which key leaked. Ordering matters: env-var values and
// auth-header values are masked first; the generic sk- pass then cannot
// re-match already-masked text (the kept prefix is too short for the
// sk-[A-Za-z0-9_-]{8,} pattern), so each secret is redacted exactly once.
export function redactSecrets(text) {
  var s = String(text == null ? '' : text);
  var mask = function (v) { return v.slice(0, 6) + '...[redacted]'; };
  // Opaque references are sensitive locators and are hidden in full.
  s = s.replace(/aemcp-secret:\/\/provider\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9_-]+\/v1/g, '[secret-reference-redacted]');
  // 1) env-style assignments: keep var name, redact only the value.
  s = s.replace(/((?:ANTHROPIC_AUTH_TOKEN|[A-Z_]*API_KEY)\s*[=:]\s*)(\S+)/g, function (m, pre, v) {
    return pre + mask(v);
  });
  // 2) auth headers: keep header name (and optional "Bearer "), redact token.
  s = s.replace(/((?:Authorization|x-api-key)\s*[:=]\s*(?:Bearer\s+)?)(\S+)/gi, function (m, pre, v) {
    return pre + mask(v);
  });
  // 3) generic API key prefix anywhere else.
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, function (m) {
    return mask(m);
  });
  return s;
}

export function buildLogExport({ panelLogs = [], hostInfo = {}, sidecarTail = '', version = '', now = new Date() } = {}) {
  const lines = [];
  lines.push('# ae-mcp panel log export');
  lines.push('exported-at: ' + now.toISOString());
  lines.push('panel-version: ' + (version || '-'));
  lines.push('host-version: ' + (hostInfo.hostVersion || '-'));
  lines.push('python-version: ' + (hostInfo.pythonVersion || '-'));
  lines.push('');
  lines.push('## panel logs (' + panelLogs.length + ')');
  for (const line of panelLogs) lines.push(redactSecrets(line));
  lines.push('');
  lines.push('## sidecar stderr tail');
  lines.push(sidecarTail ? redactSecrets(sidecarTail) : '(empty)');
  return lines.join('\n') + '\n';
}

export function exportFileName(now = new Date()) {
  return 'export-' + now.toISOString().replace(/[:.]/g, '-') + '.txt';
}

export function keepLogLine(level, message) {
  if (level !== 'error') return true;
  return /error|failed|exception/i.test(String(message || ''));
}
