import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLogExport, summarizePreviewFrameBranches } from './logExport.js';

test('buildLogExport includes all diagnostic sections and sources', () => {
  const text = buildLogExport({
    version: '0.9.6',
    now: new Date('2026-08-19T10:20:30.000Z'),
    hostInfo: {
      hostVersion: '0.9.6', pythonVersion: '3.12.1',
      aeApp: { appName: 'After Effects', appVersion: '25.0', appLocale: 'en_US', appUILocale: 'en_US' },
      cepVersion: '11.0', os: { platform: 'win32', release: '10.0' },
      hostNode: 'v15.14.0', chromiumUa: 'Chrome/88', pluginPort: 11488,
      logsDir: '/home/user/.ae-mcp/logs', logLevel: 'info',
    },
    diagnostics: [{ id: 'host-listening', ok: true, detail: 'Host is ready' }],
    hostActivity: [{ id: 4, ts: Date.parse('2026-08-19T10:00:00Z'), client: 'claude', engine: 'jsx', ok: true }, { id: 5, ts: Date.parse('2026-08-19T10:00:01Z'), client: 'claude', ok: false, error: 'JSX timeout after 3000ms', disposition: 'uncertain' }],
    hostLogMemory: [{ ts: '2026-08-19T10:01:00Z', pid: 10, level: 'info', source: 'panel', message: 'memory line' }],
    hostLogDisk: [{ ts: '2026-08-18T10:01:00Z', pid: 10, level: 'info', source: 'activity', message: 'disk line' }],
    panelLogs: ['[10:02] panel line'],
    backendStderrTails: { claude: 'claude stderr', codex: '', opencode: 'opencode stderr' },
    pythonServerLog: '2026 INFO previewFrame.branch source=comp method=saveFrameToPng ok=true fallbackReason=- compId=7 durationMs=12',
  });
  for (const heading of [
    '# ae-mcp diagnostics bundle', '## diagnostics', '## host activity (last N)',
    '## host log (memory, last 500)', '## host log (disk tail, 2 days, last 500)',
    '## panel log (1)', '## backend stderr tails', '## python server log (tail)',
    '## previewFrame branches',
  ]) assert.match(text, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /summary: comp\/saveFrameToPng=1\s+failed=0/);
  assert.match(text, /#5 2026-08-19T10:00:01\.000Z client=claude engine=- ok=false disposition=uncertain error="JSX timeout after 3000ms"/);
});

test('a missing source only makes its own section unavailable', () => {
  const text = buildLogExport({ panelLogs: ['still here'], version: 'test' });
  assert.match(text, /## diagnostics\n\(unavailable:/);
  assert.match(text, /## host activity \(last N\)\n\(unavailable:/);
  assert.match(text, /## host log \(memory, last 500\)\n\(unavailable:/);
  assert.match(text, /## host log \(disk tail, 2 days, last 500\)\n\(unavailable:/);
  assert.match(text, /## panel log \(1\)\n\[?still here/);
  assert.match(text, /## python server log \(tail\)\n\(unavailable:/);
  assert.match(text, /## previewFrame branches\nsummary:/);
});

test('redacts exact secrets in activity and Python sections', () => {
  const secret = 'sk-test-log-export-secret';
  const text = buildLogExport({
    exactSecrets: [secret],
    hostActivity: [{ id: 1, ts: Date.now(), client: 'client', engine: 'jsx', ok: false, error: secret }],
    pythonServerLog: 'server error token=' + secret,
  });
  assert.equal(text.includes(secret), false);
  assert.match(text, /\[redacted\]/);
});

test('summarizes comp, viewer, failed, and fallback branches', () => {
  const result = summarizePreviewFrameBranches([
    'previewFrame.branch source=comp method=saveFrameToPng ok=true fallbackReason=- compId=7 durationMs=10',
    'previewFrame.branch source=viewer method=ViewerCapture ok=true fallbackReason="saveFrameToPng unavailable" compId=7 durationMs=20',
    'previewFrame.branch source=none method=- ok=false fallbackReason="saveFrameToPng unavailable" compId=7 durationMs=30 error="no snapshotter installed"',
  ].join('\n'));
  assert.equal(result.branches.length, 3);
  assert.match(result.summary, /comp\/saveFrameToPng=1/);
  assert.match(result.summary, /viewer\/ViewerCapture=1/);
  assert.match(result.summary, /failed=1/);
  assert.deepEqual(result.fallbackReasons, [{ reason: 'saveFrameToPng unavailable', count: 2 }]);
  assert.equal(result.recent.length, 3);
});
