import React from 'react';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';
import {
  channelChoiceState,
  channelCopiedLabel,
  channelDot,
  channelTexts,
} from '../../lib/channelCard';
import { copyText } from '../../lib/clipboard';

const DOT_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', neutral: 'var(--text-tertiary)' };

function ChannelDot({ token }) {
  return <span style={{ width: 8, height: 8, flex: 'none', borderRadius: '50%', background: DOT_COLOR[token] || DOT_COLOR.neutral }}></span>;
}

// One card per backend; one row per credential channel (spec A).
// channels: ChannelProbe[]; activeChannel: effective channel id;
// selectedChannel: the user-enabled channel (#229 — routing follows it
// exactly); renderChannelBody(channel) -> extra config fields (provider
// dropdown, key paste, import button...).
export function ChannelCard({
  lang = 'zh',
  channels = [],
  activeChannel = '',
  selectedChannel = '',
  onSelectChannel,
  onRecheck,
  recheckLabel,
  recheckDisabled = false,
  readOnly = false,
  renderChannelBody,
}) {
  const [copied, setCopied] = React.useState('');
  const copyTimerRef = React.useRef(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyLoginCommand = (channel, text) => {
    copyText(text).then(() => {
      if (!mountedRef.current) return;
      setCopied(channel);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        if (mountedRef.current) setCopied('');
      }, 1200);
    }).catch(() => {});
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {channels.map((probe) => {
        const texts = channelTexts(probe, lang);
        const isActive = probe.channel === activeChannel;
        const choice = channelChoiceState(probe.channel, selectedChannel, lang);
        return (
          <div key={probe.channel} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: `1px solid ${isActive ? 'var(--border-strong)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-md)', background: 'var(--bg-well)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ChannelDot token={channelDot(probe)} />
              <Badge status={channelDot(probe)}>{texts.source}</Badge>
              {texts.detail ? <span title={texts.detail} style={{ flex: 1, minWidth: 0, font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 4 }}>{texts.detail}</span> : <span style={{ flex: 1 }} />}
              {!readOnly && onSelectChannel ? (
                <Button variant={choice.active ? 'secondary' : 'ghost'} size="sm" disabled={choice.active} onClick={() => onSelectChannel(probe.channel)}>
                  {choice.label}
                </Button>
              ) : null}
            </div>
            {texts.fixHint ? <div style={{ font: '400 10px/1.5 var(--font-ui)', color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap' }}>{texts.fixHint}</div> : null}
            {!readOnly && texts.copyText ? (
              <div>
                <Button variant="secondary" size="sm" icon="copy" onClick={() => copyLoginCommand(probe.channel, texts.copyText)}>
                  {copied === probe.channel ? channelCopiedLabel(lang) : texts.copyLabel}
                </Button>
              </div>
            ) : null}
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
