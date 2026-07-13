import React from 'react';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';

const L = {
  zh: {
    title: '批准工具执行？', once: '仅本次允许', session: '本会话允许', deny: '拒绝',
    artifact: '工具', operation: '操作', risk: '风险', args: '参数', target: '目标',
  },
  en: {
    title: 'Approve tool execution?', once: 'Allow once', session: 'Allow for session', deny: 'Deny',
    artifact: 'Artifact', operation: 'Operation', risk: 'Risk', args: 'Arguments', target: 'Target',
  },
};

export function ToolApprovalDialog({ record, lang = 'zh', onResolve }) {
  if (!record) return null;
  const t = L[lang] || L.zh;
  const plan = record.plan || {};
  const resolve = (decision) => onResolve && onResolve({ id: record.id, decision });
  return (
    <div className="tools-modal" role="presentation">
      <div className="tools-modal__scrim" onClick={() => resolve('deny')} />
      <div className="tools-approval" role="alertdialog" aria-label={t.title}>
        <div className="tools-approval__heading">
          <span>{t.title}</span>
          <Badge status={plan.risk === 'destructive' || plan.risk === 'external' ? 'error' : 'warn'}>{plan.risk}</Badge>
        </div>
        <dl className="tools-kv">
          <dt>{t.artifact}</dt><dd>{plan.artifactId || '-'}</dd>
          <dt>{t.operation}</dt><dd>{plan.operation || '-'}</dd>
          <dt>{t.risk}</dt><dd>{plan.risk || '-'}</dd>
          <dt>{t.args}</dt><dd><pre>{JSON.stringify(plan.normalizedArgs || {}, null, 2)}</pre></dd>
          <dt>{t.target}</dt><dd><pre>{JSON.stringify(plan.target || {}, null, 2)}</pre></dd>
        </dl>
        <div className="tools-approval__actions">
          <Button variant="ghost" onClick={() => resolve('deny')}>{t.deny}</Button>
          {record.policy && record.policy.allowSession ? (
            <Button variant="secondary" onClick={() => resolve('session')}>{t.session}</Button>
          ) : null}
          <Button variant="primary" onClick={() => resolve('once')}>{t.once}</Button>
        </div>
      </div>
    </div>
  );
}
