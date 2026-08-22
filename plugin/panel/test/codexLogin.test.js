import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexLoginCommand, codexLoginCommands } from '../src/lib/codexLogin.js';

test('codexLoginCommand selects PowerShell for Windows', () => {
  assert.equal(codexLoginCommand({
    codexHome: 'C:\\Users\\test\\.ae-mcp\\codex-home',
    platformId: 'windows-x64',
  }), "$env:CODEX_HOME='C:\\Users\\test\\.ae-mcp\\codex-home'; codex login");
});

test('codexLoginCommand selects POSIX syntax for macOS and missing platform ids', () => {
  assert.equal(codexLoginCommand({
    codexHome: '/Users/t/.ae-mcp/codex-home',
    platformId: 'macos-arm64',
  }), "CODEX_HOME='/Users/t/.ae-mcp/codex-home' codex login");
  assert.equal(codexLoginCommand({
    codexHome: '/home/t/.ae-mcp/codex-home',
  }), "CODEX_HOME='/home/t/.ae-mcp/codex-home' codex login");
});

test('codexLoginCommands escape single quotes for each shell', () => {
  assert.deepEqual(codexLoginCommands({ codexHome: "C:\\Users\\O'Neil\\codex-home" }), {
    powershell: "$env:CODEX_HOME='C:\\Users\\O''Neil\\codex-home'; codex login",
    posix: "CODEX_HOME='C:\\Users\\O'\\''Neil\\codex-home' codex login",
  });
});

test('codexLoginCommand returns an empty string without a home', () => {
  assert.equal(codexLoginCommand({ codexHome: '', platformId: 'windows-x64' }), '');
});
