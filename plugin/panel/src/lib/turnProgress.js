import { backendLabel } from './sessionList.js';

const TERMINAL_EVENT_TYPES = new Set([
  'text-delta',
  'tool-start',
  'approval-required',
  'question-required',
  'turn-end',
  'error',
]);

export function reduceTurnStage(current, evt, { pendingTurnId } = {}) {
  if (!evt || typeof evt !== 'object') return current;

  if (evt.type === 'turn-progress') {
    if (evt.turnId && evt.turnId !== pendingTurnId) {
      return current;
    }
    return evt.stage || current;
  }

  if (TERMINAL_EVENT_TYPES.has(evt.type)) {
    return null;
  }

  return current;
}

export function turnProgressText(stage, backend, lang = 'zh') {
  const label = backendLabel(backend, lang);
  const zh = lang === 'zh';

  if (stage === 'connect') {
    return zh ? `正在连接 ${label}…` : `Connecting to ${label}…`;
  }
  if (stage === 'spawn') {
    return zh ? `正在启动 ${label}…` : `Starting ${label}…`;
  }
  if (stage === 'session') {
    return zh ? '正在建立会话…' : 'Creating session…';
  }
  if (stage === 'dispatch') {
    return zh ? '等待模型回复…' : 'Waiting for the model…';
  }
  if (stage === 'thinking') {
    return zh ? '模型思考中…' : 'Model is thinking…';
  }
  return '';
}
