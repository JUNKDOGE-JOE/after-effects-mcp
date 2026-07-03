import React from 'react';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';
import { channelDot, channelTexts, lockLabel } from '../../lib/channelCard';

const DOT_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', neutral: 'var(--text-tertiary)' };

function ChannelDot({ token }) {
  return <span style={{ width: 8, height: 8, flex: 'none', borderRadius: '50%', background: DOT_COLOR[token] || DOT_COLOR.neutral }}></span>;
}

// One card per backend; one row per credential channel (spec A).
// channels: ChannelProbe[]; activeChannel: effective channel id;
// lockedChannel: '' or a channel id; renderChannelBody(channel) -> extra
// config fields (provider dropdown, key paste, import button...).
export function ChannelCard({
  lang = 'zh',
  channels = [],
  activeChannel = '',
  lockedChannel = '',
  onLockChannel,
  onRecheck,
  recheckLabel,
  recheckDisabled = false,
  readOnly = false,
  renderChannelBody,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {channels.map((probe) => {
        const texts = channelTexts(probe, lang);
        const isActive = probe.channel === activeChannel;
        return (
          <div key={probe.channel} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: `1px solid ${isActive ? 'var(--border-strong)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-md)', background: 'var(--bg-well)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ChannelDot token={channelDot(probe)} />
              <Badge status={channelDot(probe)}>{texts.source}</Badge>
              {texts.detail ? <span style={{ flex: 1, minWidth: 0, font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{texts.detail}</span> : <span style={{ flex: 1 }} />}
              {!readOnly && onLockChannel ? (
                <Button variant="ghost" size="sm" onClick={() => onLockChannel(probe.channel === lockedChannel ? '' : probe.channel)}>
                  {lockLabel(probe.channel, lockedChannel, lang)}
                </Button>
              ) : null}
            </div>
            {texts.fixHint ? <div style={{ font: '400 10px/1.5 var(--font-ui)', color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap' }}>{texts.fixHint}</div> : null}
            {!readOnly && renderChannelBody ? renderChannelBody(probe.channel) : null}
          </div>
        );
      })}
      {!readOnly && onRecheck ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" icon="rotate-cw" disabled={recheckDisabled} onClick={onRecheck}>{recheckLabel}</Button>
        </div>
      ) : null}
    </div>
  );
}
