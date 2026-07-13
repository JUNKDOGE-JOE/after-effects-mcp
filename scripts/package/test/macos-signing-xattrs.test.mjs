import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MACOS_SIGNING_REMOVABLE_XATTRS,
  prepareMacosSigningXattrs,
} from '../macos-signing-xattrs.mjs';

function fakeXattr(attributesByPath) {
  const calls = [];
  const values = new Map(
    [...attributesByPath.entries()].map(([filePath, names]) => [filePath, new Set(names)]),
  );
  const execFileImpl = async (file, args, context) => {
    calls.push({ file, args: [...args] });
    assert.equal(file, '/usr/bin/xattr');
    const target = context?.absolute ?? args.at(-1);
    if (args[0] === '-p') {
      if (!values.get(target)?.has(args[1])) throw new Error('attribute is missing');
      return { stdout: '', stderr: '' };
    }
    if (args[0] !== '-d') {
      const names = [...(values.get(target) ?? [])];
      return { stdout: names.length > 0 ? `${names.join('\n')}\n` : '', stderr: '' };
    }
    assert.equal(args[0], '-d');
    values.get(target)?.delete(args[1]);
    return { stdout: '', stderr: '' };
  };
  return { calls, execFileImpl, values };
}

test('pre-sign xattr policy removes only audited packaging metadata and retains provenance', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload.bin');
  await fs.promises.writeFile(payload, 'fixture');
  const fake = fakeXattr(new Map([
    [root, ['com.apple.fileprovider.dir#N', 'com.apple.quarantine']],
    [payload, [
      'com.apple.FinderInfo',
      'com.apple.ResourceFork',
      'com.apple.fileprovider.fpfs#P',
      'com.apple.provenance',
    ]],
  ]));

  const audit = await prepareMacosSigningXattrs({ root, execFileImpl: fake.execFileImpl });

  assert.deepEqual(MACOS_SIGNING_REMOVABLE_XATTRS, [
    'com.apple.FinderInfo',
    'com.apple.ResourceFork',
    'com.apple.TextEncoding',
    'com.apple.fileprovider.dir#N',
    'com.apple.fileprovider.fpfs#P',
    'com.apple.quarantine',
  ]);
  assert.deepEqual(audit, {
    schemaVersion: 1,
    policy: 'macos-signing-xattrs-v1',
    removed: [
      { path: '.', attribute: 'com.apple.fileprovider.dir#N' },
      { path: '.', attribute: 'com.apple.quarantine' },
      { path: 'payload.bin', attribute: 'com.apple.FinderInfo' },
      { path: 'payload.bin', attribute: 'com.apple.ResourceFork' },
      { path: 'payload.bin', attribute: 'com.apple.fileprovider.fpfs#P' },
    ],
    retained: [{ path: 'payload.bin', attribute: 'com.apple.provenance' }],
  });
  assert.deepEqual([...fake.values.get(root)], []);
  assert.deepEqual([...fake.values.get(payload)], ['com.apple.provenance']);
  const deletions = fake.calls.filter((call) => call.args[0] === '-d');
  assert.equal(deletions.length, 5);
  assert.equal(deletions.every((call) => call.args.at(-1) === '/dev/fd/3'), true);
});

test('pre-sign xattr policy rejects unknown metadata before mutating anything', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload.bin');
  await fs.promises.writeFile(payload, 'fixture');
  const fake = fakeXattr(new Map([
    [root, ['com.apple.fileprovider.dir#N']],
    [payload, ['com.apple.decmpfs']],
  ]));

  await assert.rejects(
    prepareMacosSigningXattrs({ root, execFileImpl: fake.execFileImpl }),
    { code: 'SIGNING_XATTR_FORBIDDEN' },
  );
  assert.equal(fake.calls.some((call) => call.args[0] === '-d'), false);
  assert.deepEqual([...fake.values.get(root)], ['com.apple.fileprovider.dir#N']);
});

test('pre-sign xattr policy fails closed if FileProvider metadata reappears', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const attributes = new Map([[root, new Set(['com.apple.FinderInfo'])]]);
  let listed = 0;
  const execFileImpl = async (_file, args, context) => {
    if (args[0] === '-p') {
      if (!attributes.get(context.absolute)?.has(args[1])) throw new Error('attribute is missing');
      return { stdout: '', stderr: '' };
    }
    if (args[0] !== '-d') {
      listed += 1;
      if (listed > 1) attributes.get(root).add('com.apple.fileprovider.fpfs#P');
      const names = [...attributes.get(root)];
      return { stdout: names.length > 0 ? `${names.join('\n')}\n` : '', stderr: '' };
    }
    attributes.get(context.absolute).delete(args[1]);
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    prepareMacosSigningXattrs({ root, execFileImpl }),
    { code: 'SIGNING_XATTR_CLEANUP_FAILED' },
  );
});

test('pre-sign xattr policy refuses symlinks without invoking xattr', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(root, 'target'), 'fixture');
  await fs.promises.symlink('target', path.join(root, 'alias'));
  let calls = 0;

  await assert.rejects(
    prepareMacosSigningXattrs({
      root,
      execFileImpl: async () => { calls += 1; return { stdout: '' }; },
    }),
    { code: 'SIGNING_XATTR_UNSAFE_ENTRY' },
  );
  assert.equal(calls, 0);
});

test('pre-sign xattr policy never cleans a replacement hard link outside the root', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-race-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'signing-root');
  const payload = path.join(root, 'payload.bin');
  const outside = path.join(parent, 'outside.bin');
  await fs.promises.mkdir(root);
  await fs.promises.writeFile(payload, 'inside');
  await fs.promises.writeFile(outside, 'outside');

  const identityKey = (stats) => `${stats.dev}:${stats.ino}`;
  const rootKey = identityKey(await fs.promises.lstat(root));
  const payloadKey = identityKey(await fs.promises.lstat(payload));
  const outsideKey = identityKey(await fs.promises.lstat(outside));
  const values = new Map([
    [rootKey, new Set()],
    [payloadKey, new Set(['com.apple.FinderInfo'])],
    [outsideKey, new Set(['com.apple.FinderInfo'])],
  ]);
  let replaced = false;

  const execFileImpl = async (_file, args, context) => {
    const target = args.at(-1);
    const stats = target === '/dev/fd/3'
      ? await context.fileHandle.stat()
      : await fs.promises.lstat(target);
    const key = identityKey(stats);
    if (args[0] === '-p') {
      if (!values.get(key)?.has(args[1])) throw new Error('attribute is missing');
      return { stdout: '', stderr: '' };
    }
    if (args[0] !== '-d') {
      const names = [...(values.get(key) ?? [])];
      const stdout = names.length > 0 ? `${names.join('\n')}\n` : '';
      if (key === payloadKey && !replaced) {
        await fs.promises.unlink(payload);
        try {
          await fs.promises.link(outside, payload);
        } catch (error) {
          if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            t.skip('hard links are unavailable on this filesystem');
            return { stdout: '', stderr: '' };
          }
          throw error;
        }
        replaced = true;
      }
      return { stdout, stderr: '' };
    }
    values.get(key)?.delete(args[1] === '-s' ? args[2] : args[1]);
    return { stdout: '', stderr: '' };
  };

  let failure;
  try {
    await prepareMacosSigningXattrs({ root, execFileImpl });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'SIGNING_XATTR_SOURCE_CHANGED');
  assert.deepEqual([...values.get(outsideKey)], ['com.apple.FinderInfo']);
});

test('descriptor-bound cleanup cannot be redirected to a hard link swapped in during xattr', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-race-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'signing-root');
  const payload = path.join(root, 'payload.bin');
  const outside = path.join(parent, 'outside.bin');
  await fs.promises.mkdir(root);
  await fs.promises.writeFile(payload, 'inside');
  await fs.promises.writeFile(outside, 'outside');

  const identityKey = (stats) => `${stats.dev}:${stats.ino}`;
  const payloadKey = identityKey(await fs.promises.lstat(payload));
  const outsideKey = identityKey(await fs.promises.lstat(outside));
  const values = new Map([
    [identityKey(await fs.promises.lstat(root)), new Set()],
    [payloadKey, new Set(['com.apple.FinderInfo'])],
    [outsideKey, new Set(['com.apple.FinderInfo'])],
  ]);
  let replaced = false;
  const execFileImpl = async (_file, args, context) => {
    const target = args.at(-1);
    if (args[0] === '-p') {
      const stats = target === '/dev/fd/3'
        ? await context.fileHandle.stat()
        : await fs.promises.lstat(target);
      if (!values.get(identityKey(stats))?.has(args[1])) throw new Error('attribute is missing');
      return { stdout: '', stderr: '' };
    }
    if (args[0] !== '-d') {
      const stats = target === '/dev/fd/3'
        ? await context.fileHandle.stat()
        : await fs.promises.lstat(target);
      const names = [...(values.get(identityKey(stats)) ?? [])];
      return { stdout: names.length > 0 ? `${names.join('\n')}\n` : '' };
    }
    if (!replaced) {
      await fs.promises.unlink(payload);
      try {
        await fs.promises.link(outside, payload);
      } catch (error) {
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
          t.skip('hard links are unavailable on this filesystem');
          return { stdout: '', stderr: '' };
        }
        throw error;
      }
      replaced = true;
    }
    const stats = target === '/dev/fd/3'
      ? await context.fileHandle.stat()
      : await fs.promises.lstat(target);
    values.get(identityKey(stats))?.delete(args[1] === '-s' ? args[2] : args[1]);
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    prepareMacosSigningXattrs({ root, execFileImpl }),
    { code: 'SIGNING_XATTR_SOURCE_CHANGED' },
  );
  assert.deepEqual([...values.get(payloadKey)], []);
  assert.deepEqual([...values.get(outsideKey)], ['com.apple.FinderInfo']);
});

test('pre-sign xattr policy re-traverses the complete entry set after cleanup', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-race-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload.bin');
  const late = path.join(root, 'late.bin');
  await fs.promises.writeFile(payload, 'fixture');
  const fake = fakeXattr(new Map([
    [root, []],
    [payload, ['com.apple.FinderInfo']],
  ]));
  let inserted = false;
  const execFileImpl = async (file, args, context) => {
    const result = await fake.execFileImpl(file, args, context);
    if (!inserted && args[0] === '-d') {
      await fs.promises.writeFile(late, 'appeared during cleanup');
      inserted = true;
    }
    return result;
  };

  await assert.rejects(
    prepareMacosSigningXattrs({ root, execFileImpl }),
    { code: 'SIGNING_XATTR_SOURCE_CHANGED' },
  );
});

test('pre-sign xattr policy rejects ambiguous or control-bearing xattr list output', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-output-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload.bin');
  await fs.promises.writeFile(payload, 'fixture');

  for (const raw of [
    'com.apple.provenance\n\n',
    'com.apple.provenance\r\n',
    'com.apple.provenance\ncom.apple.provenance\n',
  ]) {
    const execFileImpl = async (_file, args, context) => {
      if (args[0] === '-d') throw new Error('cleanup must not begin');
      if (args[0] === '-p') return { stdout: '', stderr: '' };
      return { stdout: context.absolute === payload ? raw : '', stderr: '' };
    };
    await assert.rejects(
      prepareMacosSigningXattrs({ root, execFileImpl }),
      { code: 'SIGNING_XATTR_OUTPUT_INVALID' },
      `raw xattr output must fail closed: ${JSON.stringify(raw)}`,
    );
  }
});

test('pre-sign xattr policy proves each parsed allowlisted name exists before cleanup', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-xattrs-output-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload.bin');
  await fs.promises.writeFile(payload, 'fixture');
  let deletions = 0;
  const execFileImpl = async (_file, args, context) => {
    if (args[0] === '-d') {
      deletions += 1;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '-p') {
      throw new Error('the apparent allowlisted name does not exist exactly');
    }
    return {
      stdout: context.absolute === payload
        ? 'com.apple.FinderInfo\ncom.apple.ResourceFork\n'
        : '',
      stderr: '',
    };
  };

  await assert.rejects(
    prepareMacosSigningXattrs({ root, execFileImpl }),
    { code: 'SIGNING_XATTR_OUTPUT_INVALID' },
  );
  assert.equal(deletions, 0);
});
