import React from 'react';

export function handshakeReached(info, since) {
  if (!info) return false;
  if (info.lastHealthAt && info.lastHealthAt > since) return true;
  if (info.lastClientSeenAt && info.lastClientSeenAt > since) return true;
  return false;
}

// Polls the in-process host for the first Python signal after `since`.
export function useHandshake(getHost, active) {
  const [state, setState] = React.useState('waiting');
  React.useEffect(() => {
    if (!active) return undefined;
    const since = Date.now();
    setState('waiting');
    const started = Date.now();
    const t = setInterval(() => {
      const host = getHost && getHost();
      const info = host && host.getConnectionInfo && host.getConnectionInfo();
      if (handshakeReached(info, since)) { setState('success'); clearInterval(t); }
      else if (Date.now() - started > 60000) { setState('timeout'); clearInterval(t); }
    }, 1500);
    return () => clearInterval(t);
  }, [getHost, active]);
  return state;
}
