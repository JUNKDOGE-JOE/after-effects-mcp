import {
  PLAN_SCHEMA_KEY,
  approvalResult,
  extractToolPlan,
} from '../../../shared/tool-approval.mjs';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneVisible(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => cloneVisible(item, seen)).filter((item) => item !== undefined);
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      const cloned = cloneVisible(item, seen);
      if (cloned !== undefined) {
        Object.defineProperty(result, key, {
          value: cloned,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }
  seen.delete(value);
  return result;
}

function freezeVisible(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeVisible(item);
  return Object.freeze(value);
}

function cancelResult() {
  return { action: 'cancel', content: {} };
}

function declineResult() {
  return { action: 'decline', content: {} };
}

function normalizeDirectResult(value) {
  if (!isPlainObject(value) || !['accept', 'decline', 'cancel'].includes(value.action)) return null;
  const content = isPlainObject(value.content) ? cloneVisible(value.content) : {};
  return { action: value.action, content };
}

function decisionResult(decision, policy) {
  if (decision === 'abort' || decision === 'cancel') return cancelResult();
  if (decision === 'deny' || decision === 'decline') return declineResult();
  if (decision === 'allow-session') return approvalResult('session', policy);
  return approvalResult(decision, policy);
}

export function createElicitationCoordinator({
  resolveApproval,
  presentGenericForm,
  now = () => Date.now(),
} = {}) {
  const entries = [];
  const listeners = new Set();
  const disposeController = new AbortController();
  let classificationTail = Promise.resolve();
  let sequence = 0;
  let disposed = false;

  function snapshot() {
    return entries.length ? entries[0].record : null;
  }

  function publish() {
    const current = snapshot();
    for (const listener of [...listeners]) {
      try { listener(current); } catch {}
    }
  }

  function removeEntry(entry, result) {
    const index = entries.indexOf(entry);
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
    }
    if (entry.externalSignal && entry.forwardAbort) {
      entry.externalSignal.removeEventListener('abort', entry.forwardAbort);
    }
    entry.resolve(result);
    if (index === 0) activateHead();
    return true;
  }

  function activateHead() {
    const entry = entries[0];
    if (!entry) {
      publish();
      return;
    }
    if (entry.activated) return;
    entry.activated = true;
    publish();
    if (entries[0] !== entry) return;
    if (entry.plan || typeof presentGenericForm !== 'function') return;
    Promise.resolve()
      .then(() => presentGenericForm(entry.record.request, {
        ...entry.record.context,
        signal: entry.signal,
      }))
      .then(
        (value) => {
          if (!entries.includes(entry) || entry.signal?.aborted) return;
          const direct = normalizeDirectResult(value);
          if (direct) {
            removeEntry(entry, direct);
            return;
          }
          entry.record = freezeVisible({
            ...entry.record,
            presentation: cloneVisible(value),
          });
          if (entries[0] === entry) publish();
        },
        () => {
          if (entries.includes(entry)) removeEntry(entry, declineResult());
        },
      );
  }

  function enqueue(request, context, plan, policy) {
    if (disposed || context?.signal?.aborted) return Promise.resolve(cancelResult());
    sequence += 1;
    const contextView = { ...context };
    delete contextView.signal;
    const record = freezeVisible({
      id: `elicitation-${sequence}`,
      request: cloneVisible(request) || {},
      context: cloneVisible(contextView) || {},
      plan,
      policy: cloneVisible(policy),
      presentation: undefined,
    });
    return new Promise((resolve) => {
      const controller = new AbortController();
      const entry = {
        record,
        policy: policy || {},
        resolve,
        signal: controller.signal,
        controller,
        externalSignal: context?.signal || null,
        forwardAbort: null,
        abortHandler: null,
        plan,
        activated: false,
      };
      entry.abortHandler = () => removeEntry(entry, cancelResult());
      entry.signal.addEventListener('abort', entry.abortHandler, { once: true });
      if (entry.externalSignal) {
        entry.forwardAbort = () => controller.abort();
        entry.externalSignal.addEventListener('abort', entry.forwardAbort, { once: true });
      }
      const wasEmpty = entries.length === 0;
      entries.push(entry);
      if (wasEmpty) activateHead();
    });
  }

  async function invoke(strategy, request, context, plan) {
    if (typeof strategy !== 'function') return { aborted: false, value: null };
    const controller = new AbortController();
    const sources = [context?.signal, disposeController.signal].filter(Boolean);
    const forwardAbort = () => controller.abort();
    for (const source of sources) source.addEventListener('abort', forwardAbort, { once: true });
    if (sources.some((source) => source.aborted)) controller.abort();
    const signal = controller.signal;
    if (signal.aborted) {
      for (const source of sources) source.removeEventListener('abort', forwardAbort);
      return { aborted: true, value: null };
    }
    const aborted = new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => resolve({ aborted: true, value: null }),
        { once: true },
      );
    });
    const called = Promise.resolve()
      .then(() => strategy(request, { ...context, signal, plan }))
      .then(
        (value) => ({ aborted: false, value }),
        () => ({ aborted: false, value: declineResult() }),
      );
    const outcome = await Promise.race([called, aborted]);
    for (const source of sources) source.removeEventListener('abort', forwardAbort);
    return outcome;
  }

  async function handle(request, context = {}) {
    const predecessor = classificationTail;
    let releaseClassification;
    classificationTail = new Promise((resolve) => { releaseClassification = resolve; });
    await predecessor;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseClassification();
    };
    try {
      if (disposed || context?.signal?.aborted) return cancelResult();
      const requestedSchema = isPlainObject(request) ? request.requestedSchema : null;
      const hasPlanMarker = isPlainObject(requestedSchema)
        && Object.prototype.hasOwnProperty.call(requestedSchema, PLAN_SCHEMA_KEY);
      const plan = hasPlanMarker ? extractToolPlan(requestedSchema, now) : null;
      if (hasPlanMarker && !plan) return declineResult();

      if (!plan) {
        if (typeof presentGenericForm !== 'function') return declineResult();
        const pending = enqueue(request, context, null, null);
        release();
        return await pending;
      }

      const outcome = await invoke(resolveApproval, request, context, plan);
      if (outcome.aborted || context?.signal?.aborted) return cancelResult();
      const direct = normalizeDirectResult(outcome.value);
      if (direct) {
        if (plan && direct.action === 'accept') {
          return approvalResult(direct.content.decision, { allowSession: false });
        }
        return direct;
      }

      if (plan && isPlainObject(outcome.value)) {
        if (outcome.value.decision === 'allow') return approvalResult('once', outcome.value);
        if (outcome.value.decision === 'deny') return declineResult();
        if (outcome.value.decision !== 'ask') return declineResult();
        const pending = enqueue(request, context, plan, outcome.value);
        release();
        return await pending;
      }
      return declineResult();
    } finally {
      release();
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function' || disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function resolveVisible(result) {
    if (!entries.length || !isPlainObject(result)) return false;
    const entry = entries[0];
    const suppliedId = result.id ?? result.requestId ?? result.elicitationId;
    if (suppliedId === undefined || suppliedId !== entry.record.id) return false;
    let direct = normalizeDirectResult(result);
    if (direct && entry.record.plan && direct.action === 'accept') {
      direct = approvalResult(direct.content.decision, entry.policy);
    }
    const response = direct || decisionResult(result.decision, entry.policy);
    return removeEntry(entry, response);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeController.abort();
    const pending = entries.splice(0);
    listeners.clear();
    for (const entry of pending) {
      if (entry.signal && entry.abortHandler) {
        entry.signal.removeEventListener('abort', entry.abortHandler);
      }
      if (entry.externalSignal && entry.forwardAbort) {
        entry.externalSignal.removeEventListener('abort', entry.forwardAbort);
      }
      entry.controller.abort();
      entry.resolve(cancelResult());
    }
  }

  return { handle, snapshot, subscribe, resolveVisible, dispose };
}
