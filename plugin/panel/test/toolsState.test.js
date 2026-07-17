import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_TOOLS_STATE,
  buildArtifactEditChanges,
  canEditArtifact,
  canExecuteArtifact,
  canPromoteArtifact,
  displayArtifactContent,
  emptyToolRunInputs,
  normalizeExpressionTarget,
  confirmToolAction,
  reduceToolsState,
  searchArgsFromState,
  toolExecutionCapabilities,
} from '../src/lib/toolsState.js';

function summary(overrides = {}) {
  return {
    id: 'user:1',
    name: 'Tool',
    description: '',
    kind: 'jsx',
    category: 'animation',
    tags: [],
    status: 'saved',
    verified: false,
    declaredRisk: 'write',
    sourceType: 'user',
    updatedAt: 1,
    ...overrides,
  };
}

test('initial discovery filters exclude non-executable statuses', () => {
  assert.deepEqual(INITIAL_TOOLS_STATE.statuses, ['saved', 'pinned']);
  assert.equal(Object.isFrozen(INITIAL_TOOLS_STATE.statuses), true);
  assert.equal(Object.isFrozen(INITIAL_TOOLS_STATE.summaries), true);
  assert.deepEqual(searchArgsFromState(INITIAL_TOOLS_STATE), {
    query: '',
    statuses: ['saved', 'pinned'],
    offset: 0,
    limit: 100,
  });
  const filtered = reduceToolsState(INITIAL_TOOLS_STATE, {
    type: 'set-filter', key: 'risk', value: 'external',
  });
  assert.deepEqual(searchArgsFromState(filtered).risks, ['external']);
  assert.deepEqual(searchArgsFromState({
    ...filtered,
    kinds: ['expression'],
    category: 'animation',
    sourceType: 'legacy',
  }), {
    query: '',
    kinds: ['expression'],
    categories: ['animation'],
    risks: ['external'],
    statuses: ['saved', 'pinned'],
    source_types: ['legacy'],
    offset: 0,
    limit: 100,
  });
});

test('selection never invents content and inspect retains trust', () => {
  const loaded = reduceToolsState(INITIAL_TOOLS_STATE, {
    type: 'load-success', payload: { artifacts: [{ ...summary(), content: 'must not survive' }], total: 1 },
  });
  const selected = reduceToolsState(loaded, { type: 'select', id: 'user:1' });
  assert.equal(selected.selectedId, 'user:1');
  assert.equal(selected.inspected, null);
  assert.equal(Object.hasOwn(selected.summaries[0], 'content'), false);

  const inspected = reduceToolsState(selected, {
    type: 'inspect-success',
    payload: { artifact: { ...summary(), content: 'return 1;' }, trust: 'user-untrusted' },
  });
  assert.equal(inspected.inspected.artifact.content, 'return 1;');
  assert.equal(inspected.inspected.trust, 'user-untrusted');
});

test('save-success refreshes summaries without an own content key', () => {
  const state = { ...INITIAL_TOOLS_STATE, summaries: [summary()], total: 1 };
  const next = reduceToolsState(state, {
    type: 'save-success', artifact: { ...summary(), content: 'full source', revision: 2 },
  });
  assert.equal(Object.hasOwn(next.summaries[0], 'content'), false);
  assert.equal(Object.hasOwn(next.summaries[0], 'argsSchema'), false);
  assert.equal(Object.hasOwn(next.summaries[0], 'source'), false);
  assert.equal(next.summaries[0].revision, 2);
});

test('load sorting prioritizes pinned, verified, status, source, and lower risk', () => {
  const rows = [
    summary({ id: 'external', declaredRisk: 'external' }),
    summary({ id: 'legacy', sourceType: 'legacy', declaredRisk: 'read' }),
    summary({ id: 'verified', verified: true, declaredRisk: 'write' }),
    summary({ id: 'pinned', status: 'pinned', sourceType: 'bundled', declaredRisk: 'external' }),
  ];
  const state = reduceToolsState(INITIAL_TOOLS_STATE, {
    type: 'load-success', payload: { artifacts: rows, total: rows.length },
  });
  assert.deepEqual(state.summaries.map((row) => row.id), [
    'pinned', 'verified', 'legacy', 'external',
  ]);
});

test('artifact capabilities enforce source and status boundaries', () => {
  const bundled = summary({ sourceType: 'bundled' });
  const legacy = summary({ sourceType: 'legacy' });
  assert.equal(canEditArtifact(bundled), false);
  assert.equal(canEditArtifact(legacy), true);
  assert.equal(canExecuteArtifact(summary({ status: 'candidate' })), false);
  assert.equal(canPromoteArtifact(summary({ status: 'candidate' })), true);
  assert.equal(canExecuteArtifact(summary({ status: 'archived' })), false);
  assert.equal(canExecuteArtifact(summary({ status: 'deprecated' })), false);
  assert.equal(canExecuteArtifact(summary({ status: 'pinned' })), true);
});

test('execution capabilities enforce kind operations and executable statuses', () => {
  const unavailable = {
    render: false, execute: false, apply: false, directRun: false,
    operation: null, requiresTarget: false, disabledReason: null, runtime: null,
  };
  assert.deepEqual(toolExecutionCapabilities(summary({ kind: 'jsx' })), unavailable);

  const disabledReason = { code: 'tool_platform_incompatible', message: 'Wrong platform' };
  assert.deepEqual(toolExecutionCapabilities(summary({
    kind: 'recipe',
    executionCapabilities: {
      runtime: 'native-aegp',
      operations: ['render', 'execute'],
      directRun: {
        available: true, operation: 'execute', requiresTarget: false, disabledReason: null,
      },
    },
  })), {
    render: true, execute: true, apply: false, directRun: true,
    operation: 'execute', requiresTarget: false, disabledReason: null, runtime: 'native-aegp',
  });
  assert.deepEqual(toolExecutionCapabilities(summary({
    kind: 'jsx',
    executionCapabilities: {
      runtime: 'jsx', operations: ['render', 'execute'],
      directRun: { available: false, operation: 'execute', disabledReason },
    },
  })), {
    render: true, execute: true, apply: false, directRun: false,
    operation: 'execute', requiresTarget: false, disabledReason, runtime: 'jsx',
  });
});

test('stale revision errors retain the editor draft and request refresh', () => {
  const editor = { artifactId: 'user:1', name: 'Changed locally' };
  const state = { ...INITIAL_TOOLS_STATE, editor };
  const next = reduceToolsState(state, {
    type: 'load-error',
    error: Object.assign(new Error('Conflict'), { code: 'tool_revision_conflict' }),
  });
  assert.equal(next.editor, editor);
  assert.equal(next.refreshRequired, true);
  assert.equal(next.error, 'Conflict');
});

test('displayArtifactContent keeps strings plain and formats structured kinds', () => {
  assert.equal(displayArtifactContent({ content: 'wiggle(2, 30)' }), 'wiggle(2, 30)');
  assert.equal(displayArtifactContent({ content: { steps: [{ ref: 'user:1' }] } }), [
    '{',
    '  "steps": [',
    '    {',
    '      "ref": "user:1"',
    '    }',
    '  ]',
    '}',
  ].join('\n'));
});

test('execution inputs reset cleanly between artifacts', () => {
  const first = emptyToolRunInputs();
  first.args = '{"old":true}';
  first.target.compId = '7';
  const second = emptyToolRunInputs();
  assert.deepEqual(second, {
    args: '{}', target: { compId: '', layerId: '', path: '' },
  });
  assert.notEqual(first.target, second.target);
});

test('expression targets require a non-empty comp and positive integer layer', () => {
  assert.deepEqual(normalizeExpressionTarget({
    compId: ' 7 ', layerId: '2', path: ' Transform/Opacity ',
  }), { compId: '7', layerId: 2, path: 'Transform/Opacity' });
  for (const layerId of ['abc', '', '0', '-1', '1.5']) {
    assert.throws(
      () => normalizeExpressionTarget({ compId: '7', layerId, path: 'Transform/Opacity' }),
      /invalid/,
    );
  }
  assert.throws(() => normalizeExpressionTarget({
    compId: '', layerId: '1', path: 'Transform/Opacity',
  }), /invalid/);
});

function editable(overrides = {}) {
  return {
    name: 'Legacy tool',
    description: 'Description',
    kind: 'jsx',
    category: 'workflow',
    tags: ['one'],
    declared_risk: 'write',
    content: 'return 1;',
    args_schema: { amount: { type: 'number', default: 1 } },
    ...overrides,
  };
}

function legacyArtifact() {
  return {
    id: 'legacy:abc',
    name: 'Legacy tool',
    description: 'Description',
    kind: 'jsx',
    category: 'workflow',
    tags: ['one'],
    declaredRisk: 'write',
    source: { type: 'legacy' },
    content: 'return 1;',
    argsSchema: { amount: { default: 1, type: 'number' } },
  };
}

test('legacy edit diffs omit rename and unchanged fields', () => {
  assert.deepEqual(buildArtifactEditChanges(
    legacyArtifact(),
    editable({ name: 'Attempted rename' }),
  ), {});
  assert.deepEqual(buildArtifactEditChanges(
    legacyArtifact(),
    editable({ description: 'Updated description' }),
  ), { description: 'Updated description' });
  assert.deepEqual(buildArtifactEditChanges(
    legacyArtifact(),
    editable({ category: 'animation', tags: ['two'], declared_risk: 'read' }),
  ), { category: 'animation', tags: ['two'], declared_risk: 'read' });
});

test('legacy edit rejects mixed skill and metadata transactions before API use', () => {
  assert.throws(
    () => buildArtifactEditChanges(
      legacyArtifact(),
      editable({ content: 'return 2;', category: 'animation' }),
    ),
    (error) => error.code === 'tool_legacy_transaction_required',
  );
});

test('native edit sends only values that actually changed', () => {
  const artifact = { ...legacyArtifact(), id: 'user:1', source: { type: 'user' } };
  assert.deepEqual(buildArtifactEditChanges(artifact, editable({
    name: 'Renamed',
    content: 'return 2;',
  })), {
    name: 'Renamed',
    content: 'return 2;',
  });
});

test('artifact edit diffs preserve hostile JSON keys without prototype pollution', () => {
  const objectPrototype = Object.getPrototypeOf({});
  const markerBefore = Object.prototype.marker;
  const originalContent = JSON.parse([
    '{"__proto__":{"marker":"before"},',
    '"constructor":{"prototype":{"marker":"stable"}}}',
  ].join(''));
  const protoChanged = JSON.parse([
    '{"__proto__":{"marker":"after"},',
    '"constructor":{"prototype":{"marker":"stable"}}}',
  ].join(''));
  const constructorChanged = JSON.parse([
    '{"__proto__":{"marker":"before"},',
    '"constructor":{"prototype":{"marker":"after"}}}',
  ].join(''));
  const artifact = {
    ...legacyArtifact(),
    id: 'user:hostile',
    source: { type: 'user' },
    content: originalContent,
  };

  assert.deepEqual(
    buildArtifactEditChanges(artifact, editable({ content: protoChanged })),
    { content: protoChanged },
  );
  assert.deepEqual(
    buildArtifactEditChanges(artifact, editable({ content: constructorChanged })),
    { content: constructorChanged },
  );
  assert.equal(Object.getPrototypeOf({}), objectPrototype);
  assert.equal(Object.prototype.marker, markerBefore);
  assert.equal(({}).marker, markerBefore);
});

test('destructive confirmation fails closed when host confirm is unavailable or throws', () => {
  assert.equal(confirmToolAction(undefined, 'Delete?'), false);
  assert.equal(confirmToolAction(() => { throw new Error('unavailable'); }, 'Delete?'), false);
  assert.equal(confirmToolAction(() => false, 'Delete?'), false);
  assert.equal(confirmToolAction(() => true, 'Delete?'), true);
});
