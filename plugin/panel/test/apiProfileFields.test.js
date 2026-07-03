import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

let componentModule;

async function loadComponent() {
  if (componentModule) return componentModule;
  const result = await esbuild.build({
    entryPoints: ['src/components/forms/ApiProfileFields.jsx'],
    absWorkingDir: process.cwd(),
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  componentModule = await import(`data:text/javascript;base64,${encoded}`);
  return componentModule;
}

function renderApiProfileFields({ saveDisabled = false, busy = false } = {}) {
  const onBaseUrlChange = () => {};
  const onApiKeyChange = () => {};
  const onSave = () => {};
  const onClear = () => {};

  return {
    handlers: { onBaseUrlChange, onApiKeyChange, onSave, onClear },
    props: {
      baseUrl: {
        value: 'https://proxy.example',
        onChange: onBaseUrlChange,
        label: 'API Base URL',
        caption: 'Leave blank to use the official API',
        placeholder: 'https://api.example.com',
      },
      apiKey: {
        value: 'sk-test',
        onChange: onApiKeyChange,
        label: 'API Key',
        caption: 'Stored locally',
        placeholder: 'sk-...',
        saveLabel: busy ? 'Validating...' : 'Save',
        busy,
        saveDisabled,
        onSave,
        clearLabel: 'Clear',
        onClear,
      },
    },
  };
}

test('ApiProfileFields renders base URL field caption and placeholder from props', async () => {
  const { ApiProfileFields } = await loadComponent();
  const { props } = renderApiProfileFields();
  const tree = ApiProfileFields(props);
  const baseUrlField = tree.props.children[0];
  const baseUrlInput = baseUrlField.props.children;

  assert.equal(baseUrlField.props.label, 'API Base URL');
  assert.equal(baseUrlField.props.caption, 'Leave blank to use the official API');
  assert.equal(baseUrlInput.props.placeholder, 'https://api.example.com');
  assert.equal(baseUrlInput.props.value, 'https://proxy.example');
  assert.equal(baseUrlInput.props.onChange, props.baseUrl.onChange);
});

test('ApiProfileFields save button follows saveDisabled and wires actions', async () => {
  const { ApiProfileFields } = await loadComponent();
  const { props, handlers } = renderApiProfileFields({ saveDisabled: true });
  const tree = ApiProfileFields(props);
  const apiKeyField = tree.props.children[1];
  const [apiKeyInput, saveButton, clearButton] = apiKeyField.props.children.props.children;

  assert.equal(apiKeyField.props.caption, 'Stored locally');
  assert.equal(apiKeyInput.props.placeholder, 'sk-...');
  assert.equal(apiKeyInput.props.onChange, handlers.onApiKeyChange);
  assert.equal(saveButton.props.disabled, true);
  assert.equal(saveButton.props.onClick, handlers.onSave);
  assert.equal(clearButton.props.disabled, false);
  assert.equal(clearButton.props.onClick, handlers.onClear);
});

test('ApiProfileFields disables both API key buttons while busy', async () => {
  const { ApiProfileFields } = await loadComponent();
  const { props } = renderApiProfileFields({ busy: true });
  const tree = ApiProfileFields(props);
  const [, saveButton, clearButton] = tree.props.children[1].props.children.props.children;

  assert.equal(saveButton.props.disabled, true);
  assert.equal(clearButton.props.disabled, true);
});
