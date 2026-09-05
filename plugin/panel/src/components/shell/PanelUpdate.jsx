import React from 'react';
import { Button } from '../core/Button';
import { IconButton } from '../core/IconButton';

export function PanelUpdateBanner({ update, lang, onOpen, onDismiss }) {
  const en = lang === 'en';
  const text = en ? `Panel ${update.current} → ${update.latest}` : `面板 ${update.current} → ${update.latest}`;
  return <div className="panel-update-banner" role="status">
    <span title={text}>{text}</span>
    <Button size="sm" variant="ghost" onClick={onOpen}>{en ? 'View release' : '查看更新'}</Button>
    <IconButton icon="x" title={en ? 'Dismiss this version' : '关闭此版本提醒'} onClick={onDismiss} />
  </div>;
}

export function PanelUpdateSettings({ update, lang, onCheck, onOpen }) {
  const en = lang === 'en';
  const reasons = en ? { timeout: 'Request timed out.', network: 'Network or service unavailable.',
    limited: 'GitHub limited or denied the request.', release: 'No comparable stable release.', version: 'Panel version cannot be compared.' }
    : { timeout: '请求超时。', network: '网络或服务不可用。', limited: 'GitHub 限流或拒绝请求。',
      release: '未获得可比较的稳定版。', version: '面板版本无法比较。' };
  const message = update?.status === 'checking' ? (en ? 'Checking panel release…' : '正在检查面板 Release…')
    : update?.status === 'update' ? (en ? `Panel update: ${update.latest}` : `面板可更新：${update.latest}`)
    : update?.status === 'current' ? (en ? `No newer stable panel release (${update.latest}).` : `没有更高的面板稳定版（${update.latest}）。`)
    : (en ? 'Panel update unknown. ' : '面板更新状态未知。') + (reasons[update?.reason] || '');
  return <div className="panel-update-settings">
    <div role="status">{message}</div>
    {update?.openFailed ? <div role="alert">{en ? 'Could not open the release page. Check your default browser and retry.' : '无法打开 Release 页面，请检查默认浏览器后重试。'}</div> : null}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <Button size="sm" disabled={update?.status === 'checking'} onClick={onCheck}>{en ? 'Check panel updates' : '检查面板更新'}</Button>
      {update?.status === 'update' ? <Button size="sm" onClick={onOpen}>{en ? 'View release' : '查看更新'}</Button> : null}
    </div>
  </div>;
}
