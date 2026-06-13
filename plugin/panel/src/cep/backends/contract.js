// Embedded chat backend contract. Every backend (Claude sidecar, Codex
// app-server, OpenCode serve) conforms to this regardless of transport
// (stdio+SDK / stdio+JSON-RPC / HTTP+SSE).
//
// Factory(deps) -> {
//   sendUser(text): Promise        // resolves when the turn settles
//   approve(toolUseId, decision)   // 'allow' | 'allow-session' | 'deny'
//   stop()                         // interrupt; MUST drain pending approvals
//   reset()                        // kill process/session, clear conversation
//   getMessages(): {role,text}[]
// }
// (Login/readiness probing is backend-specific: probeClaudeLogin for the
//  sidecar, codex/openCode backends expose probeAccount.)
//
// onEvent emission contract (order within a turn):
//   turn-start
//   ( text-delta{text,phase?}
//   | tool-start{toolUseId,name,input}
//   | tool-result{toolUseId,ok,text,durationMs}
//   | approval-required{toolUseId,name,input,risk}
//       -> approve -> tool-allowed{toolUseId}
//       -> deny    -> tool-denied{toolUseId}
//   | thinking{active} )*
//   turn-end{stopReason} | error{kind,message}
//
// stop(): drains every pending approval (deny + tool-denied) and emits
//   exactly one error{kind:'aborted'}.
//
// New backends are validated against this in backends-contract.test.js.
export const BACKEND_EVENTS = Object.freeze([
  'turn-start',
  'text-delta',
  'tool-start',
  'tool-result',
  'approval-required',
  'tool-allowed',
  'tool-denied',
  'thinking',
  'turn-end',
  'error',
]);
