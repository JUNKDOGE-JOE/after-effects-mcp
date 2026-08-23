import { PLAN_SCHEMA_KEY } from '../../../shared/tool-approval.mjs';

function fallbackPlan(item) {
  const source = String((item && item.id) || 'host-approval');
  const hex = Array.from(source).map((character) => character.charCodeAt(0).toString(16)).join('');
  const digest = (hex + '0'.repeat(64)).slice(0, 64);
  const risk = String((item && item.risk) || '') === 'destructive'
    ? 'destructive' : String((item && item.risk) || '') === 'read-only' ? 'read' : 'write';
  const summary = item && item.summary && typeof item.summary === 'object' ? item.summary : {};
  return {
    artifactId: `host-${String((item && item.tool) || 'unknown')}`,
    contentHash: digest,
    planHash: digest,
    operation: 'execute',
    risk,
    normalizedArgs: {
      code: typeof summary.code === 'string' ? summary.code : '',
      undo_group_name: summary.undo_group_name === undefined ? null : summary.undo_group_name,
      checkpoint_label: summary.checkpoint_label === undefined ? null : summary.checkpoint_label,
    },
    target: { tool: String((item && item.tool) || 'unknown') },
    expiresAt: Date.now() + (10 * 60 * 1000),
  };
}

function summaryLines(summary) {
  const value = summary && typeof summary === 'object' ? summary : {};
  const retry = value.recoveryId
    ? `Retry: ${value.recoveryId} (${value.retryMode === 'continue'
      ? 'continue'
      : `restore checkpoint ${value.restoreCheckpointId || 'unavailable'}`})`
    : '';
  return [
    value.code ? `Code: ${String(value.code).slice(0, 200)}` : '',
    value.undo_group_name ? `Undo group: ${value.undo_group_name}` : '',
    value.checkpoint_label ? `Checkpoint: ${value.checkpoint_label}` : '',
    retry,
  ].filter(Boolean);
}

export function approvalRequestFor(item) {
  const tool = String((item && item.tool) || 'unknown');
  const risk = String((item && item.risk) || 'unknown');
  const lines = [
    `Approve After Effects tool action ${tool} (${risk})?`,
    ...summaryLines(item && item.summary),
  ];
  return {
    method: 'elicitation/create',
    message: lines.join('\n'),
    requestedSchema: Object.freeze({
      type: 'object',
      [PLAN_SCHEMA_KEY]: item && item.plan ? item.plan : fallbackPlan(item),
    }),
  };
}

function removeListener(emitter, listener) {
  if (typeof emitter.off === 'function') emitter.off('request', listener);
  else if (typeof emitter.removeListener === 'function') emitter.removeListener('request', listener);
}

export function createHostApprovalBridge() {
  let binding = null;

  function detach() {
    if (!binding) return;
    const prior = binding;
    binding = null;
    removeListener(prior.approvals, prior.listener);
    for (const controller of prior.controllers) controller.abort();
    prior.controllers.clear();
  }

  function attach({ approvals, coordinator, resolveConversationContext } = {}) {
    if (
      !approvals
      || typeof approvals.on !== 'function'
      || !coordinator
      || typeof coordinator.handle !== 'function'
      || typeof resolveConversationContext !== 'function'
    ) {
      detach();
      return detach;
    }
    if (
      binding
      && binding.approvals === approvals
      && binding.coordinator === coordinator
      && binding.resolveConversationContext === resolveConversationContext
    ) return detach;

    detach();
    const controllers = new Set();
    const nextBinding = {
      approvals,
      coordinator,
      resolveConversationContext,
      controllers,
      listener: null,
    };
    const listener = (item) => {
      const context = resolveConversationContext(item && item.conversationId, item);
      if (!context) return;
      const controller = new AbortController();
      controllers.add(controller);
      controller.signal.addEventListener('abort', () => {
        // Detaching the bridge means the panel can no longer present this
        // approval (session switch, stop, reload, or host shutdown). Resolve
        // the host queue immediately instead of leaving it to time out and
        // misreporting the cancellation later.
        approvals.resolve(item.id, 'cancel');
      }, { once: true });
      Promise.resolve(coordinator.handle(approvalRequestFor(item), {
        ...context,
        hostApproval: true,
        conversationId: item.conversationId,
        approvalId: item.id,
        signal: controller.signal,
      })).then((result) => {
        if (binding !== nextBinding || controller.signal.aborted) return;
        const decision = result && result.action === 'accept'
          ? 'accept'
          : result && result.action === 'cancel'
            ? 'cancel'
            : result && result.action === 'decline'
              ? 'decline'
              : 'unavailable';
        approvals.resolve(item.id, decision);
      }, () => {
        if (binding === nextBinding && !controller.signal.aborted) {
          approvals.resolve(item.id, 'unavailable');
        }
      }).finally(() => controllers.delete(controller));
    };
    nextBinding.listener = listener;
    binding = nextBinding;
    approvals.on('request', listener);
    return detach;
  }

  return { attach, detach };
}
