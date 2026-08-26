import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCodexLogin } from '../src/cep/codexHeadlessLogin.js';

class FakeStream extends EventEmitter {
  setEncoding() {}
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killCount = 0;
  }

  kill() {
    this.killCount += 1;
    return true;
  }
}

function createAdapter(child = new FakeChild()) {
  const calls = { resolve: [], spawn: [] };
  return {
    child,
    calls,
    adapter: {
      completeSpawnEnv(base, additions) {
        return { PATH: 'inherited-path', ...base, ...additions };
      },
      async resolveExecutable(id, options) {
        calls.resolve.push({ id, options });
        return { ok: true, id, path: 'codex', argsPrefix: [], source: 'path' };
      },
      spawn(executable, args, options) {
        calls.spawn.push({ executable, args, options });
        return child;
      },
    },
  };
}

function spawned() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('startCodexLogin extracts the first complete https URL across chunks', async () => {
  const fake = createAdapter();
  const urls = [];
  const login = startCodexLogin({
    adapter: fake.adapter,
    codexHome: 'C:\\panel-codex',
    onUrl: (url) => urls.push(url),
  });
  await spawned();
  fake.child.stdout.emit('data', 'Open https://example');
  fake.child.stdout.emit('data', '.com/device\nIgnore https://second.example/\n');
  fake.child.emit('exit', 0, null);
  await login.promise;
  assert.deepEqual(urls, ['https://example.com/device']);
});

test('startCodexLogin inherits the environment, completes, and calls onDone', async () => {
  const fake = createAdapter();
  const completed = [];
  const login = startCodexLogin({
    adapter: fake.adapter,
    codexHome: '/panel/codex-home',
    onUrl: () => {},
    onDone: (result) => completed.push(result),
  });
  await spawned();
  fake.child.stderr.emit('data', 'https://auth.example/device\n');
  fake.child.emit('close', 0, null);
  const result = await login.promise;
  assert.deepEqual(fake.calls.spawn[0].args, ['login']);
  assert.deepEqual(fake.calls.spawn[0].options.env, {
    PATH: 'inherited-path',
    CODEX_HOME: '/panel/codex-home',
  });
  assert.deepEqual(completed, [result]);
});

test('startCodexLogin kills the child when the URL timeout triggers fallback', async () => {
  const fake = createAdapter();
  const login = startCodexLogin({
    adapter: fake.adapter,
    codexHome: '/panel/codex-home',
    urlTimeoutMs: 5,
    timeoutMs: 1000,
  });
  await assert.rejects(login.promise, { code: 'CODEX_LOGIN_URL_TIMEOUT' });
  assert.equal(fake.child.killCount, 1);
});

test('startCodexLogin cancel kills the active child', async () => {
  const fake = createAdapter();
  const login = startCodexLogin({
    adapter: fake.adapter,
    codexHome: '/panel/codex-home',
  });
  await spawned();
  login.cancel();
  await assert.rejects(login.promise, { code: 'CODEX_LOGIN_CANCELLED' });
  assert.equal(fake.child.killCount, 1);
});
