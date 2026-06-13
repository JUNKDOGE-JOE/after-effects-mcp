export function eventTitle(evt, lang) {
  const raw = evt.undoGroup || '';
  const m = /^MCP\s+([^:]+):?\s*(.*)$/.exec(raw);
  if (m) return m[2] ? `${m[1].trim()} · ${m[2].trim()}` : m[1].trim();
  if (raw) return raw;
  return lang === 'zh' ? '原始脚本' : 'Raw script';
}

export function eventOutcome(evt) {
  if (evt.denied === 'paused') return 'denied-paused';
  if (evt.denied === 'blocked') return 'denied-blocked';
  if (evt.denied) return 'denied';
  if (evt.ok && evt.emptyResult) return 'empty';
  return evt.ok ? 'ok' : 'error';
}

function parseToolPayload(result) {
  if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
    try {
      return JSON.parse(result.content[0].text);
    } catch (e) {
      return result;
    }
  }
  return result;
}

export async function revertToPreviousCheckpoint(mcp, { branchBeforeRevert = true } = {}) {
  if (!mcp || typeof mcp.callTool !== 'function') {
    throw new Error('MCP client is unavailable');
  }
  const listResult = await mcp.callTool('ae.checkpoint', { action: 'list', limit: 1 });
  const listed = parseToolPayload(listResult);
  if ((listResult && listResult.isError) || (listed && listed.ok === false)) {
    throw new Error((listed && listed.error) || 'Checkpoint list failed');
  }
  const checkpoints = listed && Array.isArray(listed.checkpoints) ? listed.checkpoints : [];
  const checkpoint = checkpoints[0] || null;
  const checkpointId = checkpoint && (checkpoint.id || checkpoint.checkpoint_id);
  if (!checkpointId) {
    throw new Error('No checkpoint available to revert');
  }
  const revertResult = await mcp.callTool('ae.revert', {
    checkpoint_id: checkpointId,
    branch_before_revert: branchBeforeRevert,
  });
  const reverted = parseToolPayload(revertResult);
  if ((revertResult && revertResult.isError) || (reverted && reverted.ok === false)) {
    throw new Error((reverted && reverted.error) || 'Checkpoint revert failed');
  }
  return reverted;
}

export function filterEvents(events, { mode, query }) {
  let out = events;
  if (mode === 'failed') out = out.filter((e) => eventOutcome(e) !== 'ok');
  const q = (query || '').trim().toLowerCase();
  if (q) {
    out = out.filter((e) => [e.undoGroup, e.client, e.error].some((s) => s && String(s).toLowerCase().includes(q)));
  }
  return out;
}
