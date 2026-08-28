import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  ToolLibrary,
  assertSecretFree,
  validateArtifact,
    normalizeArtifact,
} = require('../../plugin/host/mcp/tool-library.js');

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(label + ' has an invalid shape');
  }
}

function parseExportWire(text) {
  let wire;
  try { wire = JSON.parse(text); } catch { throw new Error('export wire JSON is invalid'); }
  exactKeys(wire, ['schemaVersion', 'exportedAt', 'artifact'], 'export wire');
  if (wire.schemaVersion !== 1 || !Number.isInteger(wire.exportedAt) || wire.exportedAt < 0) {
    throw new Error('export wire version or timestamp is invalid');
  }
  assertSecretFree(wire, 'artifact-export.json');
  return validateArtifact(normalizeArtifact(wire.artifact));
}

function artifactFromState(artifactId, stateDir) {
  if (!stateDir) throw new Error('AE_MCP_STATE_DIR is required when --artifact-id is used');
  const library = new ToolLibrary({ stateDir });
  const artifact = library.getArtifact(artifactId);
  if (artifact.status !== 'saved') throw new Error('only saved artifacts can generate bundled skills');
  return artifact;
}

function legacySkillFromArtifact(artifact) {
  if (artifact.kind !== 'jsx' && artifact.kind !== 'prompt-skill') {
    throw new Error('only JSX and prompt-skill artifacts can generate bundled skills');
  }
  if (!SKILL_NAME.test(artifact.name)) {
    throw new Error('artifact name is not a valid bundled skill name');
  }
  return {
    name: artifact.name,
    description: artifact.description,
    template_type: artifact.kind === 'jsx' ? 'jsx' : 'prompt',
    template: artifact.content,
    args_schema: artifact.argsSchema,
  };
}

function readManifest(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {
    throw new Error('bundled manifest is invalid or missing');
  }
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || typeof manifest.productVersion !== 'string'
      || !Array.isArray(manifest.artifacts)) {
    throw new Error('bundled manifest is invalid or missing');
  }
  return manifest;
}

function updatedManifest(manifest, skillFileName, sha256) {
  let found = false;
  const artifacts = manifest.artifacts.map((entry) => {
    if (!isObject(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('bundled manifest is invalid or missing');
    }
    if (entry.path !== skillFileName) return entry;
    found = true;
    return { path: skillFileName, sha256 };
  });
  if (!found) artifacts.push({ path: skillFileName, sha256 });
  return Object.assign({}, manifest, { artifacts });
}

export function generateBundledSkill({ inputPath, artifactId, outputDir, stateDir, dryRun = false } = {}) {
  if ((!inputPath && !artifactId) || (inputPath && artifactId)) {
    throw new Error('provide exactly one of inputPath or artifactId');
  }
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('outputDir is required');
  const artifact = inputPath
    ? parseExportWire(fs.readFileSync(path.resolve(inputPath), 'utf8'))
    : artifactFromState(artifactId, stateDir || process.env.AE_MCP_STATE_DIR);
  const skill = legacySkillFromArtifact(artifact);
  const directory = path.resolve(outputDir);
  const skillFileName = skill.name + '.json';
  const skillPath = path.join(directory, skillFileName);
  if (path.dirname(skillPath) !== directory) throw new Error('bundled skill path is invalid');
  const manifestPath = path.join(directory, 'manifest.json');
  const skillText = JSON.stringify(skill, null, 2) + '\n';
  const sha256 = crypto.createHash('sha256').update(skillText, 'utf8').digest('hex');
  const manifest = updatedManifest(readManifest(manifestPath), skillFileName, sha256);
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';

  if (!dryRun) {
    fs.writeFileSync(skillPath, skillText, 'utf8');
    fs.writeFileSync(manifestPath, manifestText, 'utf8');
  }
  return {
    artifactId: artifact.id,
    skillPath,
    manifestPath,
    sha256,
    dryRun: Boolean(dryRun),
    skill,
    manifest,
  };
}

export function parseArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('missing value for ' + arg);
    if (arg === '--input') options.inputPath = value;
    else if (arg === '--artifact-id') options.artifactId = value;
    else if (arg === '--output-dir') options.outputDir = value;
    else throw new Error('unknown argument: ' + arg);
    index += 1;
  }
  return options;
}

function main() {
  const result = generateBundledSkill(parseArguments(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
