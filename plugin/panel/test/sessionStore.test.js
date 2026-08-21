import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/cep/sessionStore.js';

function createMemoryPlatform() {
  const files = new Map();
  const calls = [];
  const directories = new Set();
  const fs = {
    failRename: false,
    readFileSync(path) {
      if (!files.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    writeFileSync(path, value) {
      calls.push({ type: 'write', path });
      files.set(path, String(value));
    },
    renameSync(from, to) {
      calls.push({ type: 'rename', from, to });
      if (fs.failRename) throw new Error('rename failed');
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync(path) {
      calls.push({ type: 'unlink', path });
      if (!files.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      files.delete(path);
    },
    mkdirSync(path) {
      calls.push({ type: 'mkdir', path });
      directories.add(path);
    },
    chmodSync(path, mode) {
      calls.push({ type: 'chmod', path, mode });
    },
    existsSync(path) {
      return files.has(path) || directories.has(path);
    },
    readdirSync() {
      return [];
    },
    rmSync(path) {
      files.delete(path);
    },
  };
  return {
    files,
    calls,
    fs,
    paths: {
      configRoot: '/home/test/.ae-mcp',
      join: (parts) => parts.join('/').replace(/\/+/g, '/'),
    },
  };
}

test('session store round-trips index and transcripts through atomic private writes', () => {
  const platform = createMemoryPlatform();
  const store = createSessionStore({ platform });
  const index = {
    version: 1,
    activeId: 'chat-one',
    sessions: [{ id: 'chat-one', title: 'One' }],
  };
  store.saveIndex(index);
  const saved = store.saveTranscript('chat-one', [{ id: 'user-1', type: 'user-text', text: 'hello' }]);
  assert.deepEqual(store.loadIndex(), index);
  assert.deepEqual(store.loadTranscript('chat-one'), saved);
  assert.equal(saved.entries[0].sid, 'chat-one:1');
  assert.ok(platform.calls.some((call) => call.type === 'rename' && call.to.endsWith('/index.json')));
  assert.ok(platform.calls.some((call) => call.type === 'chmod' && call.mode === 0o600));
});

test('session store removes a failed atomic temp write and tags the error', () => {
  const platform = createMemoryPlatform();
  const store = createSessionStore({ platform });
  platform.fs.failRename = true;
  assert.throws(() => store.saveIndex({ version: 1, activeId: null, sessions: [] }), (error) => {
    assert.equal(error.code, 'SESSION_STORE_UNAVAILABLE');
    return true;
  });
  assert.ok(platform.calls.some((call) => call.type === 'unlink' && call.path.endsWith('.tmp')));
});

test('session store fails open for corrupt or unsupported index data and logs it', () => {
  const platform = createMemoryPlatform();
  const logs = [];
  const store = createSessionStore({ platform, log: (line) => logs.push(line) });
  platform.files.set('/home/test/.ae-mcp/sessions/index.json', '{broken');
  assert.deepEqual(store.loadIndex(), { version: 1, activeId: null, sessions: [] });
  platform.files.set('/home/test/.ae-mcp/sessions/index.json', JSON.stringify({ version: 9, sessions: [] }));
  assert.deepEqual(store.loadIndex(), { version: 1, activeId: null, sessions: [] });
  assert.ok(logs.length >= 2);
});

test('session transcripts retain at most four hundred entries and stay within 1.5 MB', () => {
  const platform = createMemoryPlatform();
  const store = createSessionStore({ platform });
  const countLimited = store.saveTranscript('chat-many', Array.from({ length: 405 }, (_, index) => ({
    type: 'ai-text',
    text: String(index),
  })));
  assert.equal(countLimited.entries.length, 400);
  assert.equal(countLimited.entries[0].text, '5');
  assert.equal(countLimited.truncated, true);

  const sizeLimited = store.saveTranscript('chat-large', Array.from({ length: 5 }, (_, index) => ({
    type: 'ai-text',
    text: `${index}:${'x'.repeat(500_000)}`,
  })));
  assert.equal(sizeLimited.truncated, true);
  const serialized = platform.files.get('/home/test/.ae-mcp/sessions/chat-large.json');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 1.5 * 1024 * 1024);
  assert.ok(sizeLimited.entries.length < 5);
});

test('deleteTranscript removes the local transcript and ignores ENOENT', () => {
  const platform = createMemoryPlatform();
  const store = createSessionStore({ platform });
  store.saveTranscript('chat-delete', [{ type: 'user-text', text: 'bye' }]);
  assert.equal(store.deleteTranscript('chat-delete'), true);
  assert.equal(store.loadTranscript('chat-delete'), null);
  assert.equal(store.deleteTranscript('chat-delete'), false);
});
