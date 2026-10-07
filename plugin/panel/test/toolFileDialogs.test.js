import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseToolExportPath,
  chooseToolPackage,
  chooseWorkDirectory,
} from '../src/cep/toolFileDialogs.js';

test('work directory picker selects one folder, preserves cancellation and reports errors', () => {
  const cepFs = { showOpenDialog: (...args) => {
    assert.deepEqual(args, [false, true, '选择工作目录', 'C:\\工程', []]);
    return { err: 0, data: ['file:///C:/%E5%B7%A5%E7%A8%8B%20A'] };
  } };
  assert.equal(chooseWorkDirectory(cepFs, { title: '选择工作目录', initialPath: 'C:\\工程' }), 'C:/工程 A');
  assert.equal(chooseWorkDirectory({ showOpenDialog: () => ({ err: 0, data: [] }) }), null);
  assert.equal(chooseWorkDirectory({ showOpenDialog: () => ({ data: ['file://server/share/工程'] }) }), '//server/share/工程');
  assert.throws(() => chooseWorkDirectory({ showOpenDialog: () => ({ err: 5 }) }), /failed: 5/);
});

test('chooseToolPackage passes the exact CEP open-dialog contract', () => {
  const calls = [];
  const cepFs = {
    showOpenDialog(...args) {
      calls.push(args);
      return { err: 0, data: ['C:\\Tools\\in.aemcptools'] };
    },
  };
  assert.equal(chooseToolPackage(cepFs, {
    title: 'Import tools', initialPath: 'C:\\Tools', normalizePath: (value) => value.replaceAll('\\', '/'),
  }), 'C:/Tools/in.aemcptools');
  assert.deepEqual(calls, [[false, false, 'Import tools', 'C:\\Tools', [
    'aemcptools', 'ps1', 'psm1', 'bat', 'cmd', 'sh', 'command',
  ]]]);
});

test('chooseToolPackage returns null on cancel and rejects wrong extensions', () => {
  assert.equal(chooseToolPackage({
    showOpenDialog: () => ({ err: 0, data: [] }),
  }), null);
  assert.throws(() => chooseToolPackage({
    showOpenDialog: () => ({ err: 0, data: ['/tmp/tools.zip'] }),
  }), /\.aemcptools/i);
  assert.equal(chooseToolPackage({
    showOpenDialog: () => ({ err: 0, data: ['/tmp/developer.ps1'] }),
  }), '/tmp/developer.ps1');
});

test('chooseToolExportPath normalizes cancellation and appends the extension', () => {
  const calls = [];
  const cepFs = {
    showSaveDialog(...args) {
      calls.push(args);
      return { err: 0, data: '/tmp/my-tools' };
    },
  };
  assert.equal(chooseToolExportPath(cepFs, {
    title: 'Export tools', initialPath: '/tmp',
  }), '/tmp/my-tools.aemcptools');
  assert.deepEqual(calls, [['Export tools', '/tmp', ['aemcptools'], 'tools.aemcptools']]);
  assert.equal(chooseToolExportPath({
    showSaveDialog: () => ({ err: 0, data: '/tmp/already.AEMCPTOOLS' }),
  }), '/tmp/already.AEMCPTOOLS');
  assert.equal(chooseToolExportPath({
    showSaveDialog: () => ({ err: 0, data: '' }),
  }), null);
});
