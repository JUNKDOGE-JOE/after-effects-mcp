import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const generator = path.join(repositoryRoot, 'scripts/generate_capability_package_index.py');

function runGenerator(args) {
  return spawnSync('python3', [generator, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('indexes every tracked capability brief deterministically', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-brief-index-'));
  const first = runGenerator(['--output-dir', outputRoot]);
  assert.equal(first.status, 0, first.stderr);

  const briefs = fs.readdirSync(path.join(repositoryRoot, 'docs/capability-packages'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const indexes = fs.readdirSync(outputRoot).sort();
  assert.deepEqual(indexes, briefs.map((name) => name.replace(/\.md$/u, '.index.json')));

  const indexPath = path.join(outputRoot, 'issue157-keyframe-authoring.index.json');
  const firstBytes = fs.readFileSync(indexPath);
  const firstMtime = fs.statSync(indexPath).mtimeMs;
  const parsed = JSON.parse(firstBytes);
  assert.equal(parsed.tools.length, 7);
  assert.deepEqual(
    parsed.tools.map((entry) => entry.name),
    [
      'ae_getLayerPropertyKeyframeDetails',
      'ae_addLayerPropertyKeyframe',
      'ae_setLayerPropertyKeyframeValue',
      'ae_setLayerPropertyKeyframeInterpolation',
      'ae_setLayerPropertyKeyframeTemporalEase',
      'ae_setLayerPropertyKeyframeBehavior',
      'ae_deleteLayerPropertyKeyframe',
    ],
  );
  assert.ok(parsed.tools.every((entry) => entry.schema.status === 'narrative'));
  assert.deepEqual(parsed.tools[0].schema.sharedBlocks[0].lineRange, { start: 13, end: 50 });
  assert.deepEqual(parsed.tools[1].undoModel.lineRanges, [{ start: 72, end: 82 }]);

  const second = runGenerator(['--output-dir', outputRoot]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readFileSync(indexPath), firstBytes);
  assert.equal(fs.statSync(indexPath).mtimeMs, firstMtime);
});

test('indexes a split public-tool registry without admitting unrelated tool tables', () => {
  const result = runGenerator([
    path.join(repositoryRoot, 'docs/capability-packages/text-shape-marker.md'),
    '--stdout',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(
    parsed.tools.map((entry) => entry.name),
    [
      'ae_listInstalledFonts',
      'ae_createTextLayer',
      'ae_getTextDocument',
      'ae_setTextContent',
      'ae_setTextCharacterStyle',
      'ae_setTextParagraphStyle',
      'ae_createShapeLayer',
      'ae_listShapeGroups',
      'ae_createShapeGroup',
      'ae_setShapePath',
      'ae_setShapeFillStyle',
      'ae_setShapeStrokeStyle',
      'ae_reorderShapeGroup',
      'ae_listMarkers',
      'ae_createMarker',
      'ae_setMarker',
      'ae_deleteMarker',
    ],
  );
});

test('fails closed and writes no index when required brief structure is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-bad-brief-'));
  const brief = path.join(root, 'bad.md');
  const output = path.join(root, 'derived');
  fs.writeFileSync(brief, [
    '# Incomplete package brief',
    '',
    '## Public surface',
    '',
    '| Public MCP tool | Effect |',
    '| --- | --- |',
    '| `ae_setSomething` | write |',
    '',
  ].join('\n'));

  const result = runGenerator([brief, '--output-dir', output]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no fenced public-MCP execution path/u);
  assert.equal(fs.existsSync(output), false);
});

test('does not disguise a missing per-tool JSON schema as narrative', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-partial-schema-'));
  const brief = path.join(root, 'partial.md');
  const output = path.join(root, 'derived');
  fs.writeFileSync(brief, [
    '# Partial package brief',
    '',
    '## Public surface',
    '',
    '| Public MCP tool | Effect |',
    '| --- | --- |',
    '| `ae_setFirst` | write |',
    '| `ae_setSecond` | write |',
    '',
    '## Public schemas',
    '',
    '```json',
    '{',
    '  "ae_setFirst": { "type": "object" }',
    '}',
    '```',
    '',
    '## Execution path',
    '',
    '```text',
    'public MCP -> Core -> native RPC -> AE state',
    '```',
    '',
    '## Undo model',
    '',
    'Every write receives one real AE Undo.',
    '',
    '## Acceptance',
    '',
    'Every public tool is required in package acceptance.',
    '',
  ].join('\n'));

  const result = runGenerator([brief, '--output-dir', output]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /schema blocks name other public tools but omit ae_setSecond/u);
  assert.equal(fs.existsSync(output), false);
});
