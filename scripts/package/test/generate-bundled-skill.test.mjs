import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { generateBundledSkill, parseArguments } from '../generate-bundled-skill.mjs';

const require = createRequire(import.meta.url);
const { ToolLibrary, computeContentHash } = require('../../../plugin/host/mcp/tool-library.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-bundled-skill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function artifact(overrides = {}) {
  const value = {
    schemaVersion: 1,
    id: 'user:11111111-1111-4111-8111-111111111111',
    name: 'bundle-test',
    description: 'Bundled generator fixture.',
    kind: 'jsx',
    category: 'workflow',
    tags: [],
    compatibility: {},
    declaredRisk: 'write',
    source: { type: 'user', ref: 'test', client: null, productVersion: null, provenance: {} },
    status: 'saved',
    verified: false,
    verification: null,
    content: 'app.project.activeItem;',
    argsSchema: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
  value.contentHash = computeContentHash(value.kind, value.content, value.argsSchema);
  return value;
}

function outputDirectory(root) {
  const output = path.join(root, 'skills_bundled');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    productVersion: '0.10.3',
    artifacts: [{ path: 'existing.json', sha256: 'a'.repeat(64) }],
  }, null, 2) + '\n');
  return output;
}

test('generator converts an exported wire and updates only its temporary manifest entry', (t) => {
  const root = tempRoot(t);
  const outputDir = outputDirectory(root);
  const source = artifact();
  const inputPath = path.join(root, 'export.json');
  fs.writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, exportedAt: 1, artifact: source }) + '\n');

  const result = generateBundledSkill({ inputPath, outputDir });
  const skillText = fs.readFileSync(result.skillPath, 'utf8');
  const skill = JSON.parse(skillText);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.deepEqual(skill, {
    name: source.name,
    description: source.description,
    template_type: 'jsx',
    template: source.content,
    args_schema: source.argsSchema,
  });
  assert.equal(manifest.productVersion, '0.10.3');
  assert.equal(manifest.artifacts.find((entry) => entry.path === 'bundle-test.json').sha256,
    crypto.createHash('sha256').update(skillText, 'utf8').digest('hex'));
  const prompt = artifact({
    id: 'user:22222222-2222-4222-8222-222222222222',
    name: 'bundle-prompt',
    kind: 'prompt-skill',
    declaredRisk: 'read',
    content: 'Review ${topic}.',
  });
  const promptPath = path.join(root, 'prompt-export.json');
  fs.writeFileSync(promptPath, JSON.stringify({ schemaVersion: 1, exportedAt: 1, artifact: prompt }) + '\n');
  const promptResult = generateBundledSkill({ inputPath: promptPath, outputDir });
  assert.equal(JSON.parse(fs.readFileSync(promptResult.skillPath, 'utf8')).template_type, 'prompt');
  assert.equal(fs.existsSync(path.join(root, 'plugin', 'host', 'mcp', 'skills_bundled')), false);
});

test('generator reads a saved state artifact and dry-run leaves the directory unchanged', (t) => {
  const root = tempRoot(t);
  const outputDir = outputDirectory(root);
  const library = new ToolLibrary({ stateDir: path.join(root, 'state') });
  const saved = library.saveArtifact(artifact());
  const before = fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8');

  const result = generateBundledSkill({ artifactId: saved.id, stateDir: path.join(root, 'state'), outputDir, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(path.join(outputDir, 'bundle-test.json')), false);
  assert.equal(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'), before);
});

test('generator validates its command arguments and only accepts saved artifacts', (t) => {
  const root = tempRoot(t);
  const outputDir = outputDirectory(root);
  const library = new ToolLibrary({ stateDir: path.join(root, 'state') });
  const archived = library.saveArtifact(artifact({ status: 'archived' }));
  assert.deepEqual(parseArguments(['--input', 'one.json', '--output-dir', 'out', '--dry-run']), {
    inputPath: 'one.json', outputDir: 'out', dryRun: true,
  });
  assert.throws(() => parseArguments(['--input']), /missing value/i);
  assert.throws(() => generateBundledSkill({ artifactId: archived.id, stateDir: path.join(root, 'state'), outputDir }), /only saved/i);
});
