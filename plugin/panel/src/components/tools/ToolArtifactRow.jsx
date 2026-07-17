import React from 'react';
import { Badge } from '../core/Badge';

const L = {
  zh: { never: '未使用', verified: '已验证', run: '运行' },
  en: { never: 'Never used', verified: 'Verified', run: 'Run' },
};

function riskStatus(risk) {
  if (risk === 'external' || risk === 'destructive') return 'error';
  if (risk === 'write') return 'warn';
  return 'neutral';
}

function lastUsed(value, t) {
  if (!value) return t.never;
  try { return new Date(value).toLocaleString(); } catch { return t.never; }
}

export function ToolArtifactRow({
  artifact, selected = false, onSelect, onRun, runDisabled = false, lang = 'zh',
}) {
  const t = L[lang] || L.zh;
  const directRun = Boolean(
    artifact && artifact.executionCapabilities
    && artifact.executionCapabilities.directRun
    && artifact.executionCapabilities.directRun.available,
  );
  return (
    <div
      className={`tools-artifact-row ds-focusable${selected ? ' is-selected' : ''}`}
    >
      <button
        type="button"
        className="tools-artifact-row__select"
        aria-current={selected || undefined}
        onClick={() => onSelect && onSelect(artifact.id)}
      >
        <span className="tools-artifact-row__top">
          <span className="tools-artifact-row__name">{artifact.name}</span>
          {artifact.verified ? <Badge status="ok" icon="check">{t.verified}</Badge> : null}
        </span>
        <span className="tools-artifact-row__badges">
          <Badge>{artifact.kind}</Badge>
          <Badge>{artifact.category}</Badge>
          <Badge status={riskStatus(artifact.declaredRisk)}>{artifact.declaredRisk}</Badge>
          <Badge status={artifact.status === 'candidate' ? 'warn' : artifact.status === 'pinned' ? 'accent' : 'neutral'}>{artifact.status}</Badge>
        </span>
        <span className="tools-artifact-row__meta">
          <span>{artifact.sourceType}</span>
          <span>{lastUsed(artifact.lastUsedAt, t)}</span>
        </span>
      </button>
      {directRun ? (
        <button
          type="button"
          className="tools-artifact-row__run"
          onClick={() => onRun && onRun(artifact)}
          disabled={runDisabled}
        >
          {t.run}
        </button>
      ) : null}
    </div>
  );
}
