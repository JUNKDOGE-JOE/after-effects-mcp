import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyWizardConfig } from '../src/lib/wizardCopy.js';

test('copyWizardConfig copies the requested wizard text when provided', () => {
  const copied = [];
  const mcpConfigStr = JSON.stringify({ mcpServers: { ae: { command: 'ae-mcp' } } });
  const copyText = (text) => copied.push(text);
  const requestedText = 'Connect After Effects for me.';

  copyWizardConfig(copyText, mcpConfigStr, requestedText);

  assert.equal(copied.length, 1);
  assert.equal(copied[0], requestedText);
});

test('copyWizardConfig falls back to generic config when no selected config is passed', () => {
  const copied = [];
  const mcpConfigStr = JSON.stringify({ mcpServers: { ae: { command: 'ae-mcp' } } });
  const copyText = (text) => copied.push(text);

  copyWizardConfig(copyText, mcpConfigStr);

  assert.equal(copied[0], mcpConfigStr);
});
