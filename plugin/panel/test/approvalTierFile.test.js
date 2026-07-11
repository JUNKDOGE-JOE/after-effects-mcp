import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_TIER_ENV,
  createApprovalTierFile,
  withToolApprovalTier,
} from '../src/cep/approvalTierFile.js';

function makeDeps() {
  const files = new Map();
  const dirs = new Set();
  const descriptors = new Map();
  const events = [];
  let nextFd = 10;
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fs = {
    mkdirSync(path, options) {
      dirs.add(path);
      events.push(['mkdir', path, options]);
    },
    chmodSync(path, mode) {
      events.push(['chmod', path, mode]);
    },
    openSync(path, flags, mode) {
      if (flags === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const fd = nextFd++;
      descriptors.set(fd, path);
      files.set(path, '');
      events.push(['open', path, flags, mode, fd]);
      return fd;
    },
    writeFileSync(target, value, encoding) {
      const path = typeof target === 'number' ? descriptors.get(target) : target;
      files.set(path, String(value));
      events.push(['write', path, value, encoding]);
    },
    fsyncSync(fd) {
      events.push(['fsync', fd]);
    },
    closeSync(fd) {
      descriptors.delete(fd);
      events.push(['close', fd]);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      events.push(['rename', from, to]);
    },
    unlinkSync(path) {
      if (!files.has(path)) throw missing();
      files.delete(path);
      events.push(['unlink', path]);
    },
  };
  return {
    fs,
    os: { homedir: () => '/home/user' },
    path: { join: (...parts) => parts.join('/') },
    pid: 42,
    now: () => 1234,
    nonce: () => 'nonce',
    files,
    dirs,
    events,
  };
}

test('approval tier writes atomically with private directory and file modes', () => {
  const deps = makeDeps();
  const service = createApprovalTierFile(deps);
  const expected = '/home/user/.ae-mcp/runtime/approval/panel-42.tier';

  assert.equal(service.path(), expected);
  assert.deepEqual(service.env(), { [TOOL_TIER_ENV]: expected });
  assert.equal(service.write('manual'), 'manual');
  assert.equal(deps.files.get(expected), 'manual\n');
  assert.equal(deps.events.some((entry) => entry[0] === 'chmod' && entry[1].endsWith('/approval') && entry[2] === 0o700), true);
  assert.equal(deps.events.some((entry) => entry[0] === 'open' && entry[2] === 'wx' && entry[3] === 0o600), true);
  const fsyncIndex = deps.events.findIndex((entry) => entry[0] === 'fsync');
  const renameIndex = deps.events.findIndex((entry) => entry[0] === 'rename');
  assert.ok(fsyncIndex >= 0 && fsyncIndex < renameIndex);
  assert.equal(deps.events.some((entry) => entry[0] === 'chmod' && entry[1].endsWith('.tmp') && entry[2] === 0o600), true);
});

test('approval tier validates before touching disk and dispose removes only its file', () => {
  const deps = makeDeps();
  const service = createApprovalTierFile(deps);

  assert.throws(() => service.write('automatic'), /tier/i);
  assert.equal(deps.events.length, 0);
  service.write('readonly');
  deps.files.set('/home/user/.ae-mcp/runtime/approval/other.tier', 'none\n');
  service.dispose();
  service.dispose();

  assert.equal(deps.files.has(service.path()), false);
  assert.equal(deps.files.has('/home/user/.ae-mcp/runtime/approval/other.tier'), true);
});

test('withToolApprovalTier returns a new command and merges environment', () => {
  const deps = makeDeps();
  const service = createApprovalTierFile(deps);
  const original = { command: 'ae-mcp', args: ['serve'], env: { KEEP: '1' } };
  const merged = withToolApprovalTier(original, service);

  assert.notEqual(merged, original);
  assert.notEqual(merged.env, original.env);
  assert.deepEqual(merged, {
    command: 'ae-mcp',
    args: ['serve'],
    env: { KEEP: '1', [TOOL_TIER_ENV]: service.path() },
  });
  assert.deepEqual(original.env, { KEEP: '1' });
});

test('failed atomic write cleans only its temporary file', () => {
  const deps = makeDeps();
  deps.fs.renameSync = (from) => {
    deps.events.push(['rename-failed', from]);
    throw new Error('rename failed');
  };
  const service = createApprovalTierFile(deps);

  assert.throws(() => service.write('auto'), /rename failed/);
  assert.equal([...deps.files.keys()].some((path) => path.endsWith('.tmp')), false);
});
