import React from 'react';

export function useActivity(getHost) {
  const [events, setEvents] = React.useState([]);

  React.useEffect(() => {
    let unsub = null;
    let retry = null;
    let disposed = false;

    const attach = () => {
      if (disposed) return;
      const host = getHost && getHost();
      const act = host && host.activity;
      if (!act) {
        retry = setTimeout(attach, 2000);
        return;
      }
      setEvents(act.list());
      unsub = act.subscribe((e) => setEvents((xs) => [...xs.slice(-499), e]));
    };

    attach();
    return () => {
      disposed = true;
      if (unsub) unsub();
      if (retry) clearTimeout(retry);
    };
  }, [getHost]);

  const clear = React.useCallback(() => setEvents([]), []);
  return { events, clear };
}
