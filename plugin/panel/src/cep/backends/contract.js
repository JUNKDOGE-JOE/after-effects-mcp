// Embedded chat backend contract. Every backend (Claude CLI, Codex
// app-server, OpenCode serve) conforms to this regardless of transport
// (stdio stream-json / stdio JSON-RPC / HTTP+SSE).
//
// Factory(deps) -> {
//   sendUser(text): Promise        // resolves when the turn settles
//   approve(toolUseId, decision)   // 'allow' | 'allow-session' | 'deny'
//   answerQuestion?(toolUseId, result) // {action:'submit', values} | {action:'cancel'}
//   stop()                         // interrupt; MUST drain pending approvals
//   reset()                        // kill process/session, clear conversation
//   getSessionRef(): {kind,id}|null
//   adoptSessionRef(ref|null)      // record only; the next send performs resume
//   deleteSessionRef(ref): Promise<{ok,skipped?,detail?}> // never throws
//   getMessages(): {role,text}[]
// }
// (Login/readiness probing is backend-specific: probeClaudeLogin uses
//  `claude auth status`; codex/openCode backends expose probeAccount.)
//
// onEvent emission contract (order within a turn):
//   turn-start
//   turn-accepted{turnId,transport}
//   session-ref{ref} may appear before or after turn-accepted
//   turn-progress{turnId?,stage}, where stage is spawn, session, or dispatch,
//     may repeat after sendUser and before the first text-delta, tool-start,
//     approval-required, or question-required event. Thinking does not end
//     progress, and progress never appears after turn-end.
//   ( text-delta{text,phase?}
//   | tool-start{toolUseId,name,input}
//   | tool-result{toolUseId,ok,text,durationMs}
//   | approval-required{toolUseId,name,input,risk}
//       -> approve -> tool-allowed{toolUseId}
//       -> deny    -> tool-denied{toolUseId}
//   | question-required{toolUseId,source,title,questions}
//       -> answerQuestion submit -> question-resolved{toolUseId,outcome:'answered',answers}
//       -> answerQuestion cancel -> question-resolved{toolUseId,outcome:'cancelled'}
//       (backend teardown settles it as cancelled — a question never outlives
//        its backend; see #219/#220. source is the protocol origin:
//        codex-user-input (#228) / claude-ask-user-question (#228))
//   | thinking{active} )*
//   turn-end{stopReason} | error{kind,message}
//
// An error before a model-turn request is sent includes the matching turnId
// and dispatchState:'not-started'. A transport failure after request dispatch
// but before turn-accepted includes the matching turnId and
// dispatchState:'uncertain'. Backends never retry an uncertain turn
// automatically.
//
// stop(): drains every pending approval (deny + tool-denied) and emits
//   exactly one error{kind:'aborted'}.
//
// New backends are validated against this in backends-contract.test.js.
export const BACKEND_EVENTS = Object.freeze([
  'turn-start',
  'turn-accepted',
  'session-ref',
  'turn-progress',
  'text-delta',
  'tool-start',
  'tool-result',
  'approval-required',
  'tool-allowed',
  'tool-denied',
  'question-required',
  'question-resolved',
  'thinking',
  'turn-end',
  'error',
]);
