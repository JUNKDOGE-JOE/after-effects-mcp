import React from 'react';

// Polls the in-process host for the first /health probe after `since`.
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
      if (info && info.lastHealthAt && info.lastHealthAt > since) { setState('success'); clearInterval(t); }
      else if (Date.now() - started > 60000) { setState('timeout'); clearInterval(t); }
    }, 1500);
    return () => clearInterval(t);
  }, [getHost, active]);
  return state;
}
