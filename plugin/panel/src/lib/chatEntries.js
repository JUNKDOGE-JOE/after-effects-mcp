function nextId(entries, prefix) {
  return `${prefix}-${entries.length + 1}`;
}

function updateTool(entries, toolUseId, updater) {
  return entries.map((entry) => {
    if (entry.type !== 'tool-call' || entry.toolUseId !== toolUseId) return entry;
    return updater(entry);
  });
}

export function reduceEvent(entries, evt) {
  const current = Array.isArray(entries) ? entries : [];
  if (!evt || !evt.type) return current;

  switch (evt.type) {
    case 'turn-start':
      return current;

    case 'text-delta': {
      const text = String(evt.text || '');
      if (!text) return current;
      const last = current[current.length - 1];
      if (last && last.type === 'ai-text') {
        return current.slice(0, -1).concat({ ...last, text: `${last.text || ''}${text}` });
      }
      return current.concat({ id: nextId(current, 'ai'), type: 'ai-text', text });
    }

    case 'tool-start':
      return current.concat({
        id: evt.toolUseId || nextId(current, 'tool'),
        type: 'tool-call',
        toolUseId: evt.toolUseId,
        name: evt.name || '',
        input: evt.input,
        state: 'running',
      });

    case 'approval-required':
      if (!current.some((entry) => entry.type === 'tool-call' && entry.toolUseId === evt.toolUseId)) {
        return current.concat({
          id: evt.toolUseId || nextId(current, 'tool'),
          type: 'tool-call',
          toolUseId: evt.toolUseId,
          name: evt.name || '',
          input: evt.input,
          risk: evt.risk,
          state: 'awaiting-approval',
        });
      }
      return updateTool(current, evt.toolUseId, (entry) => ({
        ...entry,
        name: evt.name || entry.name,
        input: evt.input === undefined ? entry.input : evt.input,
        risk: evt.risk,
        state: 'awaiting-approval',
      }));

    case 'tool-result':
      if (!current.some((entry) => entry.type === 'tool-call' && entry.toolUseId === evt.toolUseId)) {
        return current.concat({
          id: evt.toolUseId || nextId(current, 'tool'),
          type: 'tool-call',
          toolUseId: evt.toolUseId,
          name: evt.name || '',
          state: evt.ok ? 'ok' : 'error',
          ok: !!evt.ok,
          text: evt.text || '',
          durationMs: evt.durationMs,
        });
      }
      return updateTool(current, evt.toolUseId, (entry) => ({
        ...entry,
        state: evt.ok ? 'ok' : 'error',
        ok: !!evt.ok,
        text: evt.text || '',
        durationMs: evt.durationMs,
      }));

    case 'tool-denied':
      return updateTool(current, evt.toolUseId, (entry) => ({
        ...entry,
        state: 'denied',
      }));

    case 'turn-end':
      return current;

    case 'error':
      return current.concat({
        id: nextId(current, 'error'),
        type: 'error',
        kind: evt.kind,
        message: evt.message || '',
      });

    default:
      return current;
  }
}
