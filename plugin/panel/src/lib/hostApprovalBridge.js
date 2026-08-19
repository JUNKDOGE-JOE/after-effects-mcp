const APPROVAL_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    approve: Object.freeze({
      type: 'boolean',
      title: 'Approve',
      description: 'Approve this After Effects action.',
    }),
  }),
  required: Object.freeze(['approve']),
});

function summaryLines(summary) {
  const value = summary && typeof summary === 'object' ? summary : {};
  return [
    value.code ? `Code: ${String(value.code).slice(0, 200)}` : '',
    value.undo_group_name ? `Undo group: ${value.undo_group_name}` : '',
    value.checkpoint_label ? `Checkpoint: ${value.checkpoint_label}` : '',
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
    requestedSchema: APPROVAL_SCHEMA,
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
      Promise.resolve(coordinator.handle(approvalRequestFor(item), {
        ...context,
        conversationId: item.conversationId,
        approvalId: item.id,
        signal: controller.signal,
      })).then((result) => {
        if (binding !== nextBinding || controller.signal.aborted) return;
        const accepted = result
          && result.action === 'accept'
          && result.content
          && result.content.approve === true;
        approvals.resolve(item.id, accepted ? 'accept' : 'decline');
      }, () => {
        if (binding === nextBinding && !controller.signal.aborted) {
          approvals.resolve(item.id, 'decline');
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
