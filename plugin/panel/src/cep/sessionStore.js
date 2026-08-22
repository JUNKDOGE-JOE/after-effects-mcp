import { createPlatformAdapter } from './platform/index.js';

const VERSION = 1;
const TRANSCRIPT_ENTRY_LIMIT = 400;
const TRANSCRIPT_BYTE_LIMIT = Math.floor(1.5 * 1024 * 1024);

function emptyIndex() {
  return { version: VERSION, activeId: null, sessions: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sessionStoreError(error) {
  const result = error instanceof Error ? error : new Error(String(error || 'Session store unavailable'));
  result.code = 'SESSION_STORE_UNAVAILABLE';
  return result;
}

function utf8Length(value) {
  let bytes = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF
      && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xDC00
      && text.charCodeAt(index + 1) <= 0xDFFF) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function stableEntries(id, entries) {
  const source = clone(Array.isArray(entries) ? entries : []);
  const used = new Set();
  let sequence = 0;
  const matcher = new RegExp(`^${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)$`);
  for (const entry of source) {
    const sid = typeof entry.sid === 'string' ? entry.sid : '';
    const match = sid.match(matcher);
    if (sid && !used.has(sid)) {
      used.add(sid);
      if (match) sequence = Math.max(sequence, Number(match[1]) || 0);
    } else {
      delete entry.sid;
    }
  }
  for (const entry of source) {
    if (entry.sid) continue;
    do { sequence += 1; } while (used.has(`${id}:${sequence}`));
    entry.sid = `${id}:${sequence}`;
    used.add(entry.sid);
  }
  return source;
}

function serializedTranscriptSize(value) {
  return utf8Length(`${JSON.stringify(value, null, 2)}\n`);
}

function transcriptPayload(id, entries) {
  const source = stableEntries(id, entries);
  let start = Math.max(0, source.length - TRANSCRIPT_ENTRY_LIMIT);
  let truncated = start > 0;
  let payload = { version: VERSION, id, entries: source.slice(start), truncated };
  if (serializedTranscriptSize(payload) <= TRANSCRIPT_BYTE_LIMIT) return payload;

  truncated = true;
  let low = start;
  let high = source.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { version: VERSION, id, entries: source.slice(middle), truncated };
    if (serializedTranscriptSize(candidate) <= TRANSCRIPT_BYTE_LIMIT) high = middle;
    else low = middle + 1;
  }
  payload = { version: VERSION, id, entries: source.slice(low), truncated };
  return payload;
}

export function createSessionStore({ platform, log } = {}) {
  const adapter = platform || createPlatformAdapter();
  const fs = adapter && adapter.fs;
  if (!fs || !adapter?.paths?.join || !adapter?.paths?.configRoot) {
    throw new TypeError('A platform adapter with file access is required');
  }
  const sessionsRoot = adapter.paths.join([adapter.paths.configRoot, 'sessions']);
  const indexFile = adapter.paths.join([sessionsRoot, 'index.json']);
  let nonce = 0;

  function report(message, error) {
    if (typeof log !== 'function') return;
    try { log(`${message}: ${error?.message || String(error || '')}`); } catch {}
  }

  function readJson(file) {
    try {
      return JSON.parse(String(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      try {
        if (!fs.existsSync(file)) return null;
      } catch {}
      report('Session store read failed', error);
      return null;
    }
  }

  function writeAtomic(file, value) {
    const temp = `${file}.${Date.now()}-${nonce += 1}.tmp`;
    try {
      fs.mkdirSync(sessionsRoot, { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      try { fs.chmodSync(temp, 0o600); } catch {}
      fs.renameSync(temp, file);
      try { fs.chmodSync(file, 0o600); } catch {}
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw sessionStoreError(error);
    }
  }

  function transcriptFile(id) {
    const value = String(id || '');
    if (!/^chat-[A-Za-z0-9-]+$/.test(value)) {
      throw sessionStoreError(new Error('Session id is invalid'));
    }
    return adapter.paths.join([sessionsRoot, `${value}.json`]);
  }

  function loadIndex() {
    const value = readJson(indexFile);
    if (value === null) return emptyIndex();
    if (!value || value.version !== VERSION || !Array.isArray(value.sessions)
      || (value.activeId !== null && typeof value.activeId !== 'string')) {
      report('Session index is invalid', new Error('unsupported or malformed index'));
      return emptyIndex();
    }
    return clone(value);
  }

  function saveIndex(index) {
    const value = {
      version: VERSION,
      activeId: typeof index?.activeId === 'string' ? index.activeId : null,
      sessions: Array.isArray(index?.sessions) ? clone(index.sessions) : [],
    };
    writeAtomic(indexFile, value);
    return clone(value);
  }

  function loadTranscript(id) {
    let value;
    try { value = readJson(transcriptFile(id)); } catch (error) {
      report('Session transcript path is invalid', error);
      return null;
    }
    if (value === null) return null;
    if (!value || value.version !== VERSION || value.id !== id || !Array.isArray(value.entries)) {
      report('Session transcript is invalid', new Error('unsupported or malformed transcript'));
      return null;
    }
    return {
      version: VERSION,
      id,
      entries: clone(value.entries),
      truncated: value.truncated === true,
    };
  }

  function saveTranscript(id, entries) {
    const payload = transcriptPayload(id, entries);
    writeAtomic(transcriptFile(id), payload);
    return clone(payload);
  }

  function deleteTranscript(id) {
    const file = transcriptFile(id);
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      try {
        if (!fs.existsSync(file)) return false;
      } catch {}
      throw sessionStoreError(error);
    }
  }

  return {
    loadIndex,
    saveIndex,
    loadTranscript,
    saveTranscript,
    deleteTranscript,
  };
}
