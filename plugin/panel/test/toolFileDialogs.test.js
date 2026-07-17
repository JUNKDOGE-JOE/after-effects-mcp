import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseToolExportPath,
  chooseToolPackage,
} from '../src/cep/toolFileDialogs.js';

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
