import { deriveTitle } from './sessionList.js';

const VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyIndex() {
  return { version: VERSION, activeId: null, sessions: [] };
}

function isoTime(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function validIndex(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.sessions)) return emptyIndex();
  return {
    version: VERSION,
    activeId: typeof value.activeId === 'string' ? value.activeId : null,
    sessions: value.sessions.map((meta) => {
      const copy = clone(meta);
      delete copy.touched;
      return copy;
    }),
  };
}

function backendRef(value) {
  if (!value || typeof value !== 'object' || !value.kind || !value.id) return null;
  return { kind: String(value.kind), id: String(value.id) };
}

export function sanitizeRestored(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const next = clone(entry);
    if (next.type === 'tool-call' && next.state === 'awaiting-approval') next.state = 'denied';
    if (next.type === 'question' && next.state === 'pending') next.state = 'cancelled';
    if (next.state === 'streaming') next.state = 'complete';
    if (Object.prototype.hasOwnProperty.call(next, 'streaming')) next.streaming = false;
    if (Object.prototype.hasOwnProperty.call(next, 'isStreaming')) next.isStreaming = false;
    return next;
  });
}

export function createSessionController({
  store,
  now = () => Date.now(),
  uuid,
  deps = {},
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (!store || typeof store.loadIndex !== 'function') {
    throw new TypeError('A session store is required');
  }
  if (typeof uuid !== 'function') throw new TypeError('A UUID function is required');
  const scheduleTimeout = setTimeoutImpl || deps.setTimeout || setTimeout;
  const cancelTimeout = clearTimeoutImpl || deps.clearTimeout || clearTimeout;
  const listeners = new Set();
  let index = emptyIndex();
  let activeId = null;
  let activeMeta = null;
  let latestEntries = [];
  let dirty = false;
  let timer = null;
  let booted = false;
  let operationTail = Promise.resolve();

  function report(message, error) {
    if (typeof deps.log !== 'function') return;
    try { deps.log(`${message}: ${error?.message || String(error || '')}`); } catch {}
  }

  function snapshot() {
    return { sessions: clone(index.sessions), activeId };
  }

  function publish() {
    const value = snapshot();
    for (const listener of [...listeners]) {
      try { listener(value); } catch {}
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function enqueue(operation) {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.catch(() => {});
    return pending;
  }

  function currentIndexMeta() {
    return index.sessions.find((meta) => meta.id === activeId) || null;
  }

  function upsertActiveMeta() {
    if (!activeMeta) return;
    const position = index.sessions.findIndex((meta) => meta.id === activeMeta.id);
    const value = clone(activeMeta);
    delete value.touched;
    if (position >= 0) index.sessions[position] = value;
    else index.sessions.push(value);
  }

  function saveIndex() {
    try {
      store.saveIndex({
        ...index,
        sessions: index.sessions.map((meta) => {
          const value = clone(meta);
          delete value.touched;
          return value;
        }),
      });
      dirty = false;
    } catch (error) {
      dirty = true;
      report('Session index save failed', error);
    }
  }

  function materialized() {
    return Boolean(activeMeta && (
      activeMeta.touched
      || latestEntries.length
      || index.sessions.some((meta) => meta.id === activeMeta.id)
    ));
  }

  function refreshActiveMeta() {
    if (!activeMeta) return;
    activeMeta.entryCount = latestEntries.length;
    if (activeMeta.titleSource !== 'manual') {
      activeMeta.title = deriveTitle(latestEntries);
      activeMeta.titleSource = 'auto';
    }
  }

  function persistActive() {
    if (!activeMeta || !activeId) return false;
    const currentRef = backendRef(
      typeof deps.getBackendRef === 'function' ? deps.getBackendRef() : null,
    );
    if (currentRef) activeMeta.backendRef = currentRef;
    refreshActiveMeta();
    if (!materialized()) {
      if (index.activeId === activeId) {
        index.activeId = null;
        saveIndex();
      }
      return false;
    }
    try {
      store.saveTranscript(activeId, latestEntries);
    } catch (error) {
      dirty = true;
      report('Session transcript save failed', error);
    }
    upsertActiveMeta();
    index.activeId = activeId;
    saveIndex();
    publish();
    return true;
  }

  function clearDebounce() {
    if (timer === null) return;
    cancelTimeout(timer);
    timer = null;
  }

  function flush() {
    clearDebounce();
    return persistActive();
  }

  function schedulePersist(immediate) {
    clearDebounce();
    if (immediate) {
      persistActive();
      return;
    }
    timer = scheduleTimeout(() => {
      timer = null;
      persistActive();
    }, 400);
  }

  function newMeta() {
    const timestamp = isoTime(now);
    return {
      id: `chat-${uuid()}`,
      title: null,
      titleSource: 'auto',
      createdAt: timestamp,
      updatedAt: timestamp,
      backend: deps.currentBackend(),
      channel: deps.currentChannel(),
      model: deps.currentModel() || null,
      backendRef: null,
      archived: false,
      entryCount: 0,
      touched: false,
    };
  }

  async function switchAway() {
    clearDebounce();
    await Promise.resolve(deps.stopActiveTurn && deps.stopActiveTurn());
    await Promise.resolve(deps.resetActiveBackend && deps.resetActiveBackend());
    await Promise.resolve(deps.cancelPendingUi && deps.cancelPendingUi());
    persistActive();
  }

  async function createSessionInternal() {
    if (activeMeta) {
      persistActive();
      await switchAway();
    }
    activeMeta = newMeta();
    activeId = activeMeta.id;
    latestEntries = [];
    index.activeId = null;
    saveIndex();
    if (typeof deps.setEntries === 'function') deps.setEntries([]);
    if (typeof deps.rotateHostConversation === 'function') {
      await Promise.resolve(deps.rotateHostConversation(activeId));
    }
    publish();
    return activeId;
  }

  async function bootInternal() {
    if (booted) return snapshot();
    booted = true;
    try { index = validIndex(store.loadIndex()); } catch (error) {
      report('Session index load failed', error);
      index = emptyIndex();
    }
    const meta = index.sessions.find((candidate) => candidate.id === index.activeId);
    if (!meta || meta.archived || meta.backend !== deps.currentBackend()) {
      activeId = null;
      activeMeta = null;
      return createSessionInternal();
    }
    activeId = meta.id;
    activeMeta = { ...clone(meta), touched: true };
    let transcript = null;
    try { transcript = store.loadTranscript(activeId); } catch (error) {
      report('Session transcript load failed', error);
    }
    latestEntries = sanitizeRestored(transcript && transcript.entries);
    refreshActiveMeta();
    if (typeof deps.setEntries === 'function') deps.setEntries(clone(latestEntries));
    if (typeof deps.adoptBackendRef === 'function') {
      await Promise.resolve(deps.adoptBackendRef(activeMeta.backend, backendRef(activeMeta.backendRef)));
    }
    if (typeof deps.rotateHostConversation === 'function') {
      await Promise.resolve(deps.rotateHostConversation(activeId));
    }
    publish();
    return snapshot();
  }

  async function switchToInternal(id) {
    const target = index.sessions.find((meta) => meta.id === id);
    if (!target) throw new Error(`Unknown session: ${id}`);
    if (id === activeId) return snapshot();
    if (activeMeta) {
      persistActive();
      await switchAway();
    }
    if (target.backend !== deps.currentBackend() && typeof deps.selectBackend === 'function') {
      await Promise.resolve(deps.selectBackend(target.backend));
    }
    let transcript = null;
    try { transcript = store.loadTranscript(target.id); } catch (error) {
      report('Session transcript load failed', error);
    }
    latestEntries = sanitizeRestored(transcript && transcript.entries);
    if (typeof deps.setEntries === 'function') deps.setEntries(clone(latestEntries));
    if (typeof deps.adoptBackendRef === 'function') {
      await Promise.resolve(deps.adoptBackendRef(target.backend, backendRef(target.backendRef)));
    }
    if (typeof deps.rotateHostConversation === 'function') {
      await Promise.resolve(deps.rotateHostConversation(target.id));
    }
    activeId = target.id;
    activeMeta = { ...clone(target), touched: true };
    refreshActiveMeta();
    index.activeId = activeId;
    saveIndex();
    publish();
    return snapshot();
  }

  function recordEntries(entries, event) {
    if (!activeMeta) return;
    latestEntries = clone(Array.isArray(entries) ? entries : []);
    activeMeta.updatedAt = isoTime(now);
    refreshActiveMeta();
    if (latestEntries.length) upsertActiveMeta();
    dirty = true;
    publish();
    schedulePersist(event?.type === 'turn-end' || event?.type === 'error');
  }

  function recordBackendRef(ref) {
    if (!activeMeta) return;
    activeMeta.backendRef = backendRef(ref);
    activeMeta.updatedAt = isoTime(now);
    activeMeta.touched = true;
    upsertActiveMeta();
    index.activeId = activeId;
    dirty = true;
    saveIndex();
    publish();
  }

  function rename(id, title) {
    const value = String(title || '').trim();
    const meta = id === activeId ? activeMeta : index.sessions.find((candidate) => candidate.id === id);
    if (!meta) return false;
    meta.title = value || null;
    meta.titleSource = 'manual';
    meta.updatedAt = isoTime(now);
    if (id === activeId) {
      meta.touched = true;
      activeMeta = meta;
    }
    upsertActiveMeta();
    if (id !== activeId) {
      const position = index.sessions.findIndex((candidate) => candidate.id === id);
      index.sessions[position] = clone(meta);
    }
    if (id === activeId) index.activeId = id;
    saveIndex();
    publish();
    return true;
  }

  async function archiveInternal(id) {
    if (id === activeId && activeMeta) {
      activeMeta.touched = true;
      await createSessionInternal();
    }
    const meta = index.sessions.find((candidate) => candidate.id === id);
    if (!meta) return false;
    meta.archived = true;
    meta.updatedAt = isoTime(now);
    saveIndex();
    publish();
    return true;
  }

  function unarchive(id) {
    const meta = index.sessions.find((candidate) => candidate.id === id);
    if (!meta) return false;
    meta.archived = false;
    meta.updatedAt = isoTime(now);
    saveIndex();
    publish();
    return true;
  }

  async function removeInternal(id) {
    const meta = id === activeId ? (activeMeta || currentIndexMeta())
      : index.sessions.find((candidate) => candidate.id === id);
    if (!meta) return null;
    const ref = backendRef(meta.backendRef);
    if (id === activeId) await createSessionInternal();
    try { store.deleteTranscript(id); } catch (error) {
      report('Session transcript delete failed', error);
    }
    index.sessions = index.sessions.filter((candidate) => candidate.id !== id);
    if (index.activeId === id) index.activeId = null;
    saveIndex();
    publish();
    return ref;
  }

  return {
    boot: () => enqueue(bootInternal),
    createSession: () => enqueue(createSessionInternal),
    switchTo: (id) => enqueue(() => switchToInternal(id)),
    recordEntries,
    recordBackendRef,
    rename,
    archive: (id) => enqueue(() => archiveInternal(id)),
    unarchive,
    remove: (id) => enqueue(() => removeInternal(id)),
    flush,
    snapshot,
    subscribe,
  };
}
