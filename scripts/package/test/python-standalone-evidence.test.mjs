import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  chunkPythonStandaloneEvidenceContent,
  encodePythonStandaloneEvidenceContent,
} from '../lib/python-standalone-evidence.mjs';
import test from 'node:test';

const moduleUrl = new URL('../lib/python-standalone-evidence.mjs', import.meta.url);
const CPYTHON_LICENSE_RATIONALE =
  'SPDX Python-2.0 is the composite Python license and already includes the CNRI agreement represented separately by python-build-standalone metadata.';
const TCL_LIBRARY_RATIONALE =
  'PYTHON.json records Tcl library directory ABI labels; reviewed component versions are locked by the Python standalone BOM.';
const TCL_LIBRARY_PLATFORMS = {
  'macos-arm64': {
    observed: ['itcl4.3.5', 'thread3.0.4', 'tk9.0'],
    components: [
      { name: 'itcl', version: '4.3.5', paths: ['itcl4.3.5'] },
      { name: 'tcl-thread', version: '3.0.4', paths: ['thread3.0.4'] },
      { name: 'tk', version: '9.0.3', paths: ['tk9.0'] },
    ],
  },
  'windows-x64': {
    observed: ['dde1.4', 'reg1.3', 'tcl8.6', 'tk8.6', 'tcl8', 'tix8.4.3'],
    components: [
      { name: 'tcl', version: '8.6.12', paths: ['dde1.4', 'reg1.3', 'tcl8.6', 'tcl8'] },
      { name: 'tk', version: '8.6.12', paths: ['tk8.6'] },
      { name: 'tix', version: '8.4.3.6', paths: ['tix8.4.3'] },
    ],
  },
};

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

function writeTarAscii(buffer, offset, length, value) {
  const encoded = Buffer.from(value, 'ascii');
  assert.ok(encoded.length <= length, `${value} exceeds ${length} tar bytes`);
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  writeTarAscii(buffer, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function makeTar(entries) {
  const blocks = [];
  for (const { path: memberPath, content } of entries) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    writeTarAscii(header, 0, 100, memberPath);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeTarAscii(header, 156, 1, '0');
    writeTarAscii(header, 257, 6, 'ustar\0');
    writeTarAscii(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function replaceOriginSha(f, oldSha, newSha) {
  for (const evidenceEntry of f.bundle.entries) {
    if (evidenceEntry.origin.sha256 === oldSha) evidenceEntry.origin.sha256 = newSha;
  }
  for (const platform of ['macos-arm64', 'windows-x64']) {
    for (const component of f.bom.platforms[platform].components) {
      if (component.source?.sha256 === oldSha) component.source.sha256 = newSha;
      for (const origin of component.evidenceOrigins ?? []) {
        if (origin.sha256 === oldSha) origin.sha256 = newSha;
      }
      for (const record of component.licenseEvidence ?? []) {
        if (record.archiveSha256 === oldSha) record.archiveSha256 = newSha;
      }
    }
  }
}

function entry({ platforms, kind, origin, memberPath, content }) {
  const bytes = Buffer.from(content);
  return {
    platforms,
    kind,
    origin,
    memberPath,
    sha256: sha256(bytes),
    size: bytes.length,
    encoding: 'gzip-base64',
    content: chunkPythonStandaloneEvidenceContent(
      encodePythonStandaloneEvidenceContent(bytes),
    ),
  };
}

function fixture() {
  const metadataOrigins = {
    'macos-arm64': {
      url: 'https://example.invalid/python-macos-full.tar.zst',
      sha256: 'a'.repeat(64),
    },
    'windows-x64': {
      url: 'https://example.invalid/python-windows-full.tar.zst',
      sha256: 'b'.repeat(64),
    },
  };
  const source = {
    kind: 'archive',
    url: 'https://example.invalid/Python-3.13.14.tar.xz',
    sha256: 'c'.repeat(64),
  };
  const pythonMetadata = {
    'macos-arm64': {
      build_options: 'pgo+lto',
      license_path: 'licenses/LICENSE.example.txt',
      licenses: ['Python-2.0', 'CNRI-Python'],
      target: 'macos-arm64',
      target_triple: 'aarch64-apple-darwin',
      tcl_library_paths: TCL_LIBRARY_PLATFORMS['macos-arm64'].observed,
      version: '3.13.14',
    },
    'windows-x64': {
      build_options: 'pgo',
      license_path: 'licenses/LICENSE.example.txt',
      licenses: ['Python-2.0', 'CNRI-Python'],
      target: 'windows-x64',
      target_triple: 'x86_64-pc-windows-msvc',
      tcl_library_paths: TCL_LIBRARY_PLATFORMS['windows-x64'].observed,
      version: '3.13.14',
    },
  };
  const pythonBytes = Object.fromEntries(Object.entries(pythonMetadata)
    .map(([platform, metadata]) => [
      platform,
      Buffer.from(`${JSON.stringify(metadata)}\n`),
    ]));
  const licenseBytes = {
    'macos-arm64': Buffer.from('mac license\n'),
    'windows-x64': Buffer.from('windows license\r\n'),
  };
  const sourceBytes = Buffer.from('source license\n');
  const payloadBytes = Buffer.from('runtime dll bytes');
  const metadataRecord = (platform) => ({
    kind: 'metadata-file',
    path: 'python/licenses/LICENSE.example.txt',
    sha256: sha256(licenseBytes[platform]),
  });
  const sourceRecord = {
    kind: 'source-file',
    path: 'Python-3.13.14/LICENSE',
    sha256: sha256(sourceBytes),
  };
  const payloadRecord = {
    kind: 'payload-file',
    path: 'python/vcruntime140.dll',
    sha256: sha256(payloadBytes),
  };
  const runtimeLock = {
    python: {
      metadataAssets: Object.fromEntries(
        Object.entries(metadataOrigins).map(([platform, origin]) => [platform, {
          ...origin,
          size: 1,
          expandedTarBytes: 1,
          expandedTarSha256: platform === 'macos-arm64' ? 'd'.repeat(64) : 'e'.repeat(64),
          pythonJsonSha256: sha256(pythonBytes[platform]),
        }]),
      ),
    },
  };
  const bom = {
    platforms: Object.fromEntries(
      Object.keys(metadataOrigins).map((platform) => [platform, {
        metadataSource: {
          ...metadataOrigins[platform],
          size: 1,
          expandedTarBytes: 1,
          expandedTarSha256: platform === 'macos-arm64' ? 'd'.repeat(64) : 'e'.repeat(64),
          targetTriple: pythonMetadata[platform].target_triple,
          buildOptions: pythonMetadata[platform].build_options.split('+'),
          pythonJson: {
            path: 'python/PYTHON.json',
            sha256: sha256(pythonBytes[platform]),
          },
        },
        components: [
          {
            name: 'cpython',
            licenseDeclared: 'Python-2.0',
            source,
            evidenceOrigins: [{ ...metadataOrigins[platform] }],
            licenseEvidence: [metadataRecord(platform)],
          },
          {
            name: 'source',
            source,
            evidenceOrigins: [{ url: source.url, sha256: source.sha256 }],
            licenseEvidence: [sourceRecord],
          },
          ...(platform === 'windows-x64'
            ? [{ name: 'runtime', source, evidenceOrigins: [], licenseEvidence: [payloadRecord] }]
            : []),
          ...TCL_LIBRARY_PLATFORMS[platform].components.map((component) => ({
            ...component,
            source,
            evidenceOrigins: [],
            licenseEvidence: [],
          })),
        ],
      }]),
    ),
  };
  const bundle = {
    schemaVersion: 1,
    format: 'python-standalone-evidence-gzip-base64-v1',
    reviewedOverlays: {
      cpythonLicense: {
        observed: ['Python-2.0', 'CNRI-Python'],
        normalized: 'Python-2.0',
        rationale: CPYTHON_LICENSE_RATIONALE,
      },
      tclLibraryPaths: {
        rationale: TCL_LIBRARY_RATIONALE,
        platforms: structuredClone(TCL_LIBRARY_PLATFORMS),
      },
      metadataLicensePathExclusions: {
        'macos-arm64': [],
        'windows-x64': [],
      },
    },
    entries: [
      entry({
        platforms: ['macos-arm64'],
        kind: 'metadata-file',
        origin: metadataOrigins['macos-arm64'],
        memberPath: metadataRecord('macos-arm64').path,
        content: licenseBytes['macos-arm64'],
      }),
      entry({
        platforms: ['macos-arm64'],
        kind: 'python-json',
        origin: metadataOrigins['macos-arm64'],
        memberPath: 'python/PYTHON.json',
        content: pythonBytes['macos-arm64'],
      }),
      entry({
        platforms: ['macos-arm64', 'windows-x64'],
        kind: 'source-file',
        origin: { url: source.url, sha256: source.sha256 },
        memberPath: sourceRecord.path,
        content: sourceBytes,
      }),
      entry({
        platforms: ['windows-x64'],
        kind: 'metadata-file',
        origin: metadataOrigins['windows-x64'],
        memberPath: metadataRecord('windows-x64').path,
        content: licenseBytes['windows-x64'],
      }),
      entry({
        platforms: ['windows-x64'],
        kind: 'python-json',
        origin: metadataOrigins['windows-x64'],
        memberPath: 'python/PYTHON.json',
        content: pythonBytes['windows-x64'],
      }),
    ],
  };
  return {
    bom,
    bundle,
    licenseBytes,
    metadataOrigins,
    metadataRecord,
    payloadBytes,
    payloadRecord,
    pythonBytes,
    pythonMetadata,
    runtimeLock,
    source,
    sourceBytes,
    sourceRecord,
  };
}

function relockPythonJson(f, platform, mutate) {
  const metadata = JSON.parse(f.pythonBytes[platform].toString('utf8'));
  mutate(metadata);
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`);
  f.pythonBytes[platform] = bytes;
  f.pythonMetadata[platform] = metadata;
  const digest = sha256(bytes);
  f.runtimeLock.python.metadataAssets[platform].pythonJsonSha256 = digest;
  f.bom.platforms[platform].metadataSource.pythonJson.sha256 = digest;
  const entryValue = f.bundle.entries.find((candidate) =>
    candidate.kind === 'python-json' && candidate.platforms.includes(platform));
  entryValue.sha256 = digest;
  entryValue.size = bytes.length;
  entryValue.content = chunkPythonStandaloneEvidenceContent(
    encodePythonStandaloneEvidenceContent(bytes),
  );
}

function subtreeManifest(runtimeRoot, subtreePath) {
  const subtreeRoot = path.join(runtimeRoot, subtreePath);
  const rows = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else {
        const relative = path.relative(runtimeRoot, absolute).split(path.sep).join('/');
        const bytes = fs.readFileSync(absolute);
        rows.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  visit(subtreeRoot);
  rows.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const canonical = rows.map((row) => `${row.path}\t${row.size}\t${row.sha256}\n`).join('');
  return { entryCount: rows.length, sha256: sha256(canonical) };
}

function payloadEvidenceFixture() {
  const f = fixture();
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-payload-evidence-'));
  const subtreePath = 'python/lib/itcl4.3.5';
  fs.mkdirSync(path.join(runtimeRoot, subtreePath), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, subtreePath, 'pkgIndex.tcl'), 'package ifneeded Itcl\n');
  fs.writeFileSync(path.join(runtimeRoot, subtreePath, 'libitcl.dylib'), 'native bytes\n');
  const pkgBytes = fs.readFileSync(path.join(runtimeRoot, subtreePath, 'pkgIndex.tcl'));
  const lockedSubtree = subtreeManifest(runtimeRoot, subtreePath);
  f.bom.platforms['macos-arm64'].components.push({
    name: 'itcl',
    payloadEvidence: {
      pkgIndex: {
        path: `${subtreePath}/pkgIndex.tcl`,
        size: pkgBytes.length,
        sha256: sha256(pkgBytes),
      },
      subtreeManifest: {
        path: subtreePath,
        entryCount: lockedSubtree.entryCount,
        algorithm: 'c-byte-sort-path-tab-size-tab-sha256-lf-v1',
        sha256: lockedSubtree.sha256,
      },
    },
  });
  return { f, lockedSubtree, pkgBytes, runtimeRoot, subtreePath };
}

function provenanceEvidenceFixture() {
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw new Error('fixture requires Node.js 24 zstd support');
  }
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'python-provenance-evidence-'));
  const metadataArchives = {};
  const metadataTarBytes = {};
  for (const platform of ['macos-arm64', 'windows-x64']) {
    metadataTarBytes[platform] = makeTar([
      { path: 'python/PYTHON.json', content: f.pythonBytes[platform] },
      {
        path: 'python/licenses/LICENSE.example.txt',
        content: f.licenseBytes[platform],
      },
    ]);
    const compressed = zlib.zstdCompressSync(metadataTarBytes[platform]);
    metadataArchives[platform] = path.join(directory, `${platform}.tar.zst`);
    fs.writeFileSync(metadataArchives[platform], compressed);
    const oldSha = f.runtimeLock.python.metadataAssets[platform].sha256;
    const asset = f.runtimeLock.python.metadataAssets[platform];
    const metadataSource = f.bom.platforms[platform].metadataSource;
    const newSha = sha256(compressed);
    Object.assign(asset, {
      sha256: newSha,
      size: compressed.length,
      expandedTarBytes: metadataTarBytes[platform].length,
      expandedTarSha256: sha256(metadataTarBytes[platform]),
    });
    Object.assign(metadataSource, {
      sha256: newSha,
      size: compressed.length,
      expandedTarBytes: metadataTarBytes[platform].length,
      expandedTarSha256: sha256(metadataTarBytes[platform]),
    });
    replaceOriginSha(f, oldSha, newSha);
  }
  const sourceTarBytes = makeTar([{
    path: f.sourceRecord.path,
    content: f.sourceBytes,
  }]);
  const sourceArchive = path.join(directory, 'source.tar');
  fs.writeFileSync(sourceArchive, sourceTarBytes);
  const oldSourceSha = f.source.sha256;
  const sourceSha = sha256(sourceTarBytes);
  replaceOriginSha(f, oldSourceSha, sourceSha);
  return {
    directory,
    f,
    metadataArchives,
    metadataTarBytes,
    sourceArchive,
    sourceSha,
    sourceTarBytes,
  };
}

function relockMetadataArchive(state, platform, entries) {
  const tarBytes = makeTar(entries);
  const compressed = zlib.zstdCompressSync(tarBytes);
  fs.writeFileSync(state.metadataArchives[platform], compressed);
  const asset = state.f.runtimeLock.python.metadataAssets[platform];
  const metadataSource = state.f.bom.platforms[platform].metadataSource;
  const oldSha = asset.sha256;
  const newSha = sha256(compressed);
  Object.assign(asset, {
    sha256: newSha,
    size: compressed.length,
    expandedTarBytes: tarBytes.length,
    expandedTarSha256: sha256(tarBytes),
  });
  Object.assign(metadataSource, {
    sha256: newSha,
    size: compressed.length,
    expandedTarBytes: tarBytes.length,
    expandedTarSha256: sha256(tarBytes),
  });
  replaceOriginSha(state.f, oldSha, newSha);
  state.metadataTarBytes[platform] = tarBytes;
}

function relockSourceArchive(state, entries) {
  const tarBytes = makeTar(entries);
  fs.writeFileSync(state.sourceArchive, tarBytes);
  const oldSha = state.sourceSha;
  const newSha = sha256(tarBytes);
  replaceOriginSha(state.f, oldSha, newSha);
  state.sourceSha = newSha;
  state.sourceTarBytes = tarBytes;
}

test('exports a loader for the locked Python standalone evidence bundle', async () => {
  let subject;
  try {
    subject = await import(moduleUrl);
  } catch {
    subject = undefined;
  }

  assert.equal(typeof subject?.loadPythonStandaloneEvidence, 'function');
});

test('canonical evidence gzip is byte-stable without depending on the Node zlib encoder', async () => {
  const subject = await import(moduleUrl);
  const encoded = subject.encodePythonStandaloneEvidenceContent(Buffer.from('hello\n'));
  assert.equal(encoded, 'H4sIAAAAAAAA/wEGAPn/aGVsbG8KIDA6NgYAAAA=');
  assert.equal(zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString(), 'hello\n');
});

test('loads both PYTHON.json files and verifies BOM evidence records offline', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const evidence = subject.loadPythonStandaloneEvidence({
    bundle: f.bundle,
    runtimeLock: f.runtimeLock,
    bom: f.bom,
  });

  assert.deepEqual(evidence.pythonJson['macos-arm64'], f.pythonMetadata['macos-arm64']);
  assert.deepEqual(evidence.pythonJson['windows-x64'], f.pythonMetadata['windows-x64']);
  assert.deepEqual(evidence.licenseProjection.cpython['macos-arm64'], {
    observed: ['Python-2.0', 'CNRI-Python'],
    normalized: 'Python-2.0',
    rationale: CPYTHON_LICENSE_RATIONALE,
  });
  assert.deepEqual(
    evidence.componentProjection.tclLibraries['macos-arm64'],
    TCL_LIBRARY_PLATFORMS['macos-arm64'],
  );
  assert.deepEqual(
    evidence.verifyEvidenceRecord('macos-arm64', f.metadataRecord('macos-arm64'), {
      source: f.source,
    }),
    f.licenseBytes['macos-arm64'],
  );
  assert.deepEqual(
    evidence.verifyEvidenceRecord('windows-x64', f.sourceRecord, { source: f.source }),
    f.sourceBytes,
  );
  assert.deepEqual(
    evidence.verifyEvidenceRecord('windows-x64', f.payloadRecord, {
      content: f.payloadBytes,
      source: f.source,
    }),
    f.payloadBytes,
  );
  assert.deepEqual(
    evidence.payloadRecordForEvidence(
      'macos-arm64',
      f.metadataRecord('macos-arm64'),
    ),
    {
      kind: 'payload-file',
      path: 'licenses/python-standalone/macos-arm64/metadata-file/python/licenses/LICENSE.example.txt',
      sha256: f.metadataRecord('macos-arm64').sha256,
    },
  );
});

test('rejects an unreferenced bundle entry with a path escape', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  f.bundle.entries.push(entry({
    platforms: ['macos-arm64'],
    kind: 'metadata-file',
    origin: f.metadataOrigins['macos-arm64'],
    memberPath: '../outside.txt',
    content: 'escape\n',
  }));

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /unsafe evidence member path/i,
  );
});

test('rejects path escapes in caller-supplied payload evidence records', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const evidence = subject.loadPythonStandaloneEvidence({
    bundle: f.bundle,
    runtimeLock: f.runtimeLock,
    bom: f.bom,
  });
  assert.throws(
    () => evidence.verifyEvidenceRecord('windows-x64', {
      ...f.payloadRecord,
      path: '../outside.dll',
    }, { content: f.payloadBytes }),
    /unsafe evidence member path/i,
  );
});

test('rejects content tampering even when gzip remains valid', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const target = f.bundle.entries.find(({ kind }) => kind === 'python-json');
  target.content = chunkPythonStandaloneEvidenceContent(
    encodePythonStandaloneEvidenceContent(Buffer.from('{"tampered":true}\n')),
  );

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /(size|SHA-256) mismatch/,
  );
});

test('rejects a forged origin URL even when member bytes are unchanged', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  f.bundle.entries.find(({ kind }) => kind === 'python-json').origin.url =
    'https://attacker.invalid/forged.tar.zst';

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /PYTHON\.json provenance mismatch/,
  );
});

test('rejects omission of a BOM-referenced source member', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  f.bundle.entries = f.bundle.entries.filter(({ kind }) => kind !== 'source-file');

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /Missing bundled evidence/,
  );
});

test('rejects non-canonical base64 for otherwise valid content', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const chunks = f.bundle.entries[0].content;
  chunks[chunks.length - 1] += '\n';

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /canonical base64/,
  );
});

test('rejects a non-deterministic gzip representation of valid bytes', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const target = f.bundle.entries[0];
  const bytes = zlib.gunzipSync(Buffer.from(target.content.join(''), 'base64'));
  target.content = chunkPythonStandaloneEvidenceContent(
    zlib.gzipSync(bytes, { level: 1, mtime: 0 }).toString('base64'),
  );

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /deterministic gzip/,
  );
});

test('rejects case-folded duplicate member identities for portable staging', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  f.bundle.entries.push(entry({
    platforms: ['macos-arm64'],
    kind: 'metadata-file',
    origin: f.metadataOrigins['macos-arm64'],
    memberPath: 'python/licenses/license.example.txt',
    content: 'another license\n',
  }));

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /portable duplicate evidence entry/i,
  );
});

test('atomically stages every BOM-referenced license original and returns payload evidence', async (t) => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const evidence = subject.loadPythonStandaloneEvidence({
    bundle: f.bundle,
    runtimeLock: f.runtimeLock,
    bom: f.bom,
  });
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-evidence-stage-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

  const records = subject.stagePythonStandaloneNotices({
    runtimeRoot,
    platform: 'macos-arm64',
    evidence,
  });

  assert.deepEqual(records, [
    {
      kind: 'payload-file',
      path: 'licenses/python-standalone/macos-arm64/metadata-file/python/licenses/LICENSE.example.txt',
      sha256: f.metadataRecord('macos-arm64').sha256,
    },
    {
      kind: 'payload-file',
      path: 'licenses/python-standalone/macos-arm64/source-file/Python-3.13.14/LICENSE',
      sha256: f.sourceRecord.sha256,
    },
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(runtimeRoot, records[0].path)),
    f.licenseBytes['macos-arm64'],
  );
  assert.deepEqual(
    fs.readFileSync(path.join(runtimeRoot, records[1].path)),
    f.sourceBytes,
  );
  assert.deepEqual(
    evidence.verifyStagedPythonStandaloneNotices({ runtimeRoot, platform: 'macos-arm64' }),
    records,
  );
});

test('rejects unsafe declared sizes before attempting decompression', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  f.bundle.entries[0].size = Number.MAX_SAFE_INTEGER;

  assert.throws(
    () => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }),
    /evidence entry size limit/i,
  );
});

test('rejects unknown entry fields, platforms, kinds, and insecure origins', async (t) => {
  const subject = await import(moduleUrl);
  const cases = [
    ['unknown field', (target) => { target.unreviewed = true; }],
    ['platform', (target) => { target.platforms = ['linux-x64']; }],
    ['kind', (target) => { target.kind = 'arbitrary-file'; }],
    ['HTTPS origin', (target) => { target.origin.url = 'http://example.invalid/archive'; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const f = fixture();
      mutate(f.bundle.entries[0]);
      assert.throws(
        () => subject.loadPythonStandaloneEvidence({
          bundle: f.bundle,
          runtimeLock: f.runtimeLock,
          bom: f.bom,
        }),
        /invalid evidence entry/i,
      );
    });
  }
});

test('verifies locked pkgIndex and C-byte canonical subtree payload evidence', async (t) => {
  const subject = await import(moduleUrl);
  const { f, lockedSubtree, pkgBytes, runtimeRoot } = payloadEvidenceFixture();
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

  assert.deepEqual(
    subject.verifyPythonStandalonePayloadEvidence({
      runtimeRoot,
      platform: 'macos-arm64',
      bom: f.bom,
    }),
    [{
      component: 'itcl',
      entryCount: lockedSubtree.entryCount,
      pkgIndexSha256: sha256(pkgBytes),
      subtreeSha256: lockedSubtree.sha256,
    }],
  );
});

test('fails closed when a locked payload subtree file is deleted, added, changed, or symlinked', async (t) => {
  const subject = await import(moduleUrl);
  const cases = [
    ['deleted', ({ runtimeRoot, subtreePath }) => {
      fs.unlinkSync(path.join(runtimeRoot, subtreePath, 'libitcl.dylib'));
    }],
    ['added', ({ runtimeRoot, subtreePath }) => {
      fs.writeFileSync(path.join(runtimeRoot, subtreePath, 'injected.txt'), 'injected\n');
    }],
    ['changed', ({ runtimeRoot, subtreePath }) => {
      fs.writeFileSync(path.join(runtimeRoot, subtreePath, 'libitcl.dylib'), 'tampered bytes\n');
    }],
    ['symlinked', ({ runtimeRoot, subtreePath }) => {
      const target = path.join(runtimeRoot, subtreePath, 'libitcl.dylib');
      fs.unlinkSync(target);
      fs.symlinkSync('pkgIndex.tcl', target);
    }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const state = payloadEvidenceFixture();
      t.after(() => fs.rmSync(state.runtimeRoot, { recursive: true, force: true }));
      mutate(state);
      assert.throws(
        () => subject.verifyPythonStandalonePayloadEvidence({
          runtimeRoot: state.runtimeRoot,
          platform: 'macos-arm64',
          bom: state.f.bom,
        }),
        /(manifest mismatch|Symlink is forbidden)/,
      );
    });
  }
});

test('binds source-archive-member evidence to its explicit archive SHA, not the component upstream', async () => {
  const subject = await import(moduleUrl);
  const f = fixture();
  const containingArchive = {
    kind: 'archive',
    url: 'https://example.invalid/Python-3.13.14.tar.xz',
    sha256: 'd'.repeat(64),
  };
  const record = {
    kind: 'source-archive-member',
    path: 'Python-3.13.14/Modules/_vendored/LICENSE.c',
    archiveSha256: containingArchive.sha256,
    memberSha256: sha256('vendored terms\n'),
  };
  f.bundle.entries.push(entry({
    platforms: ['macos-arm64', 'windows-x64'],
    kind: record.kind,
    origin: { url: containingArchive.url, sha256: containingArchive.sha256 },
    memberPath: record.path,
    content: 'vendored terms\n',
  }));
  for (const platform of ['macos-arm64', 'windows-x64']) {
    f.bom.platforms[platform].components.push(
      {
        name: 'containing-archive',
        source: containingArchive,
        evidenceOrigins: [],
        licenseEvidence: [],
      },
      {
        name: 'vendored-component',
        source: f.source,
        evidenceOrigins: [{
          url: containingArchive.url,
          sha256: containingArchive.sha256,
        }],
        licenseEvidence: [record],
      },
    );
  }

  const evidence = subject.loadPythonStandaloneEvidence({
    bundle: f.bundle,
    runtimeLock: f.runtimeLock,
    bom: f.bom,
  });
  assert.deepEqual(
    evidence.verifyEvidenceRecord('macos-arm64', record, { source: f.source }),
    Buffer.from('vendored terms\n'),
  );
});

test('component evidenceOrigins are required, authorize every bundled record, and have no slack', async (t) => {
  const subject = await import(moduleUrl);
  const cases = [
    ['missing allowlist', (component) => { delete component.evidenceOrigins; }, /evidenceOrigins.*required/i],
    ['unlisted record origin', (component) => { component.evidenceOrigins = []; }, /not authorized.*evidenceOrigins/i],
    ['unused origin', (component) => {
      component.evidenceOrigins.push({
        url: 'https://unused.invalid/source.tar.gz',
        sha256: '9'.repeat(64),
      });
    }, /unused.*evidenceOrigins/i],
    ['duplicate origin', (component) => {
      component.evidenceOrigins.push(structuredClone(component.evidenceOrigins[0]));
    }, /duplicate.*evidenceOrigins/i],
  ];
  for (const [label, mutate, expected] of cases) {
    await t.test(label, () => {
      const f = fixture();
      const component = f.bom.platforms['macos-arm64'].components
        .find(({ name }) => name === 'cpython');
      mutate(component);
      assert.throws(
        () => subject.loadPythonStandaloneEvidence({
          bundle: f.bundle,
          runtimeLock: f.runtimeLock,
          bom: f.bom,
        }),
        expected,
      );
    });
  }
});

test('staged notice verification rejects deletion, tampering, and symlinks', async (t) => {
  const subject = await import(moduleUrl);
  const cases = [
    ['deletion', (target) => fs.unlinkSync(target)],
    ['tampering', (target) => fs.writeFileSync(target, 'tampered notice\n')],
    ['symlink', (target) => {
      fs.unlinkSync(target);
      fs.symlinkSync('LICENSE.example.txt', target);
    }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const f = fixture();
      const evidence = subject.loadPythonStandaloneEvidence({
        bundle: f.bundle,
        runtimeLock: f.runtimeLock,
        bom: f.bom,
      });
      const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-notice-negative-'));
      t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
      const records = subject.stagePythonStandaloneNotices({
        runtimeRoot,
        platform: 'macos-arm64',
        evidence,
      });
      mutate(path.join(runtimeRoot, records[0].path));
      assert.throws(
        () => evidence.verifyStagedPythonStandaloneNotices({
          runtimeRoot,
          platform: 'macos-arm64',
        }),
        /(Missing staged|SHA-256(?: or size)? mismatch|Unsafe staged)/,
      );
    });
  }
});

test('staged notice verification rejects symlinked ancestors and hash-time mutation', async (t) => {
  const subject = await import(moduleUrl);
  const stage = () => {
    const f = fixture();
    const evidence = subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    });
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-notice-hardening-'));
    const records = subject.stagePythonStandaloneNotices({
      runtimeRoot,
      platform: 'macos-arm64',
      evidence,
    });
    return { evidence, records, runtimeRoot };
  };

  for (const level of ['python-standalone', 'platform-root']) {
    await t.test(`symlinked ${level}`, () => {
      const state = stage();
      t.after(() => fs.rmSync(state.runtimeRoot, { recursive: true, force: true }));
      const parent = path.join(state.runtimeRoot, 'licenses', 'python-standalone');
      const target = level === 'python-standalone'
        ? parent
        : path.join(parent, 'macos-arm64');
      const moved = `${target}.real`;
      fs.renameSync(target, moved);
      fs.symlinkSync(path.basename(moved), target);
      assert.throws(
        () => state.evidence.verifyStagedPythonStandaloneNotices({
          runtimeRoot: state.runtimeRoot,
          platform: 'macos-arm64',
        }),
        /symlink.*staged Python standalone notice (ancestor|root)/i,
      );
    });
  }

  await t.test('same-size mutation after read but before final fstat', () => {
    const state = stage();
    t.after(() => fs.rmSync(state.runtimeRoot, { recursive: true, force: true }));
    const target = path.join(state.runtimeRoot, state.records[0].path);
    const originalReadSync = fs.readSync;
    let mutated = false;
    fs.readSync = function readAndMutate(...args) {
      const count = originalReadSync.apply(this, args);
      if (!mutated && count > 0) {
        mutated = true;
        fs.writeFileSync(target, Buffer.alloc(fs.statSync(target).size, 0x58));
      }
      return count;
    };
    try {
      assert.throws(
        () => state.evidence.verifyStagedPythonStandaloneNotices({
          runtimeRoot: state.runtimeRoot,
          platform: 'macos-arm64',
        }),
        /(changed while hashing|snapshot changed)/i,
      );
      assert.equal(mutated, true);
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  await t.test('path replacement after opening the verified descriptor', () => {
    const state = stage();
    t.after(() => fs.rmSync(state.runtimeRoot, { recursive: true, force: true }));
    const target = path.join(state.runtimeRoot, state.records[0].path);
    const originalReadSync = fs.readSync;
    let swapped = false;
    fs.readSync = function readAndSwap(...args) {
      const count = originalReadSync.apply(this, args);
      if (!swapped && count > 0) {
        swapped = true;
        fs.renameSync(target, `${target}.verified-old`);
        fs.writeFileSync(target, Buffer.alloc(count, 0x59));
      }
      return count;
    };
    try {
      assert.throws(
        () => state.evidence.verifyStagedPythonStandaloneNotices({
          runtimeRoot: state.runtimeRoot,
          platform: 'macos-arm64',
        }),
        /(?:path|file) changed while hashing/i,
      );
      assert.equal(swapped, true);
    } finally {
      fs.readSync = originalReadSync;
    }
  });
});

test('requires the exact reviewed CPython composite-license overlay and BOM projection', async (t) => {
  const subject = await import(moduleUrl);
  const cases = [
    ['observed metadata', (f) => { f.bundle.reviewedOverlays.cpythonLicense.observed.reverse(); }],
    ['normalization', (f) => { f.bundle.reviewedOverlays.cpythonLicense.normalized = 'CNRI-Python'; }],
    ['BOM projection', (f) => {
      f.bom.platforms['macos-arm64'].components
        .find(({ name }) => name === 'cpython').licenseDeclared = 'Python-2.0 AND CNRI-Python';
    }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const f = fixture();
      mutate(f);
      assert.throws(
        () => subject.loadPythonStandaloneEvidence({
          bundle: f.bundle,
          runtimeLock: f.runtimeLock,
          bom: f.bom,
        }),
        /(reviewed CPython license overlay|Reviewed CPython license projection mismatch)/,
      );
    });
  }
});

test('enforces bundle entry-count and aggregate decompressed-size limits before gunzip', async (t) => {
  const subject = await import(moduleUrl);
  await t.test('entry count', () => {
    const f = fixture();
    f.bundle.entries = Array.from({ length: 513 }, () => structuredClone(f.bundle.entries[0]));
    assert.throws(
      () => subject.loadPythonStandaloneEvidence({
        bundle: f.bundle,
        runtimeLock: f.runtimeLock,
        bom: f.bom,
      }),
      /entry count/,
    );
  });
  await t.test('aggregate decompressed bytes', () => {
    const f = fixture();
    for (let index = 0; index < 9; index += 1) {
      const extra = structuredClone(f.bundle.entries[0]);
      extra.memberPath = `python/licenses/EXTRA-${index}.txt`;
      extra.size = 1024 * 1024;
      f.bundle.entries.push(extra);
    }
    assert.throws(
      () => subject.loadPythonStandaloneEvidence({
        bundle: f.bundle,
        runtimeLock: f.runtimeLock,
        bom: f.bom,
      }),
      /total size limit/,
    );
  });
});

test('documents offline verify and provenance refresh CLI contracts', () => {
  const result = childProcess.spawnSync(process.execPath, [fileURLToPath(moduleUrl), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify .*--metadata-archive/);
  assert.match(result.stdout, /refresh .*--metadata-archive/);
  assert.doesNotMatch(result.stdout, /metadata-root/);
  assert.match(result.stdout, /normal verify performs no network access/i);
});

test('normal CLI verify validates the repository bundle entirely offline', () => {
  const result = childProcess.spawnSync(process.execPath, [fileURLToPath(moduleUrl), 'verify'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, {
    command: 'verify',
    entries: 37,
    originsVerified: 0,
    platforms: ['macos-arm64', 'windows-x64'],
  });
});

test('Node 20 structural verify remains available while provenance fails with a capability error', async () => {
  const subject = await import(moduleUrl);
  if (typeof zlib.zstdDecompressSync === 'function') return;
  const f = fixture();
  assert.throws(
    () => subject.verifyPythonStandaloneEvidenceOrigins({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
      requireAll: true,
    }),
    /requires Node\.js 24\+.*zstdDecompressSync/i,
  );
});

test('provenance verifies compressed assets, expanded tar bytes, and exact members', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const subject = await import(moduleUrl);
  const state = provenanceEvidenceFixture();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));

  assert.deepEqual(subject.verifyPythonStandaloneEvidenceOrigins({
    bundle: state.f.bundle,
    runtimeLock: state.f.runtimeLock,
    bom: state.f.bom,
    metadataArchives: state.metadataArchives,
    sourceArchives: { [state.sourceSha]: state.sourceArchive },
    requireAll: true,
  }), {
    entries: state.f.bundle.entries.length,
    originsVerified: 3,
    platforms: ['macos-arm64', 'windows-x64'],
  });

  fs.appendFileSync(state.sourceArchive, 'tampered');
  assert.throws(
    () => subject.verifyPythonStandaloneEvidenceOrigins({
      bundle: state.f.bundle,
      runtimeLock: state.f.runtimeLock,
      bom: state.f.bom,
      metadataArchives: state.metadataArchives,
      sourceArchives: { [state.sourceSha]: state.sourceArchive },
      requireAll: true,
    }),
    /origin archive SHA-256 mismatch/i,
  );
});

test('provenance rejects metadata/source member drift after whole-archive relocking', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const subject = await import(moduleUrl);
  await t.test('metadata member', () => {
    const state = provenanceEvidenceFixture();
    t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
    relockMetadataArchive(state, 'macos-arm64', [
      { path: 'python/PYTHON.json', content: state.f.pythonBytes['macos-arm64'] },
      { path: 'python/licenses/LICENSE.example.txt', content: 'tampered license\n' },
    ]);
    assert.throws(
      () => subject.verifyPythonStandaloneEvidenceOrigins({
        bundle: state.f.bundle,
        runtimeLock: state.f.runtimeLock,
        bom: state.f.bom,
        metadataArchives: state.metadataArchives,
        sourceArchives: { [state.sourceSha]: state.sourceArchive },
        requireAll: true,
      }),
      /origin member.*LICENSE\.example\.txt.*mismatch/i,
    );
  });
  await t.test('source member', () => {
    const state = provenanceEvidenceFixture();
    t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
    relockSourceArchive(state, [{
      path: state.f.sourceRecord.path,
      content: 'tampered source member\n',
    }]);
    assert.throws(
      () => subject.verifyPythonStandaloneEvidenceOrigins({
        bundle: state.f.bundle,
        runtimeLock: state.f.runtimeLock,
        bom: state.f.bom,
        metadataArchives: state.metadataArchives,
        sourceArchives: { [state.sourceSha]: state.sourceArchive },
        requireAll: true,
      }),
      /origin member.*Python-3\.13\.14\/LICENSE.*mismatch/i,
    );
  });
});

test('provenance rejects a relocked compressed asset with the wrong expanded tar digest', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const subject = await import(moduleUrl);
  const state = provenanceEvidenceFixture();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  const wrong = 'f'.repeat(64);
  state.f.runtimeLock.python.metadataAssets['macos-arm64'].expandedTarSha256 = wrong;
  state.f.bom.platforms['macos-arm64'].metadataSource.expandedTarSha256 = wrong;
  assert.throws(
    () => subject.verifyPythonStandaloneEvidenceOrigins({
      bundle: state.f.bundle,
      runtimeLock: state.f.runtimeLock,
      bom: state.f.bom,
      metadataArchives: state.metadataArchives,
      sourceArchives: { [state.sourceSha]: state.sourceArchive },
      requireAll: true,
    }),
    /expanded tar SHA-256 mismatch/i,
  );
});

test('CLI verify accepts exact local provenance archives and no network inputs', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const subject = await import(moduleUrl);
  const state = provenanceEvidenceFixture();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  const jsonPaths = {};
  for (const [name, value] of Object.entries({
    bundle: state.f.bundle,
    'runtime-lock': state.f.runtimeLock,
    bom: state.f.bom,
  })) {
    jsonPaths[name] = path.join(state.directory, `${name}.json`);
    fs.writeFileSync(jsonPaths[name], JSON.stringify(value));
  }

  const result = subject.pythonStandaloneEvidenceCli([
    'verify',
    '--bundle', jsonPaths.bundle,
    '--runtime-lock', jsonPaths['runtime-lock'],
    '--bom', jsonPaths.bom,
    '--metadata-archive', `macos-arm64=${state.metadataArchives['macos-arm64']}`,
    '--metadata-archive', `windows-x64=${state.metadataArchives['windows-x64']}`,
    '--source-archive', `${state.sourceSha}=${state.sourceArchive}`,
    '--require-origin-archives',
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: 'verify',
    entries: state.f.bundle.entries.length,
    originsVerified: 3,
    platforms: ['macos-arm64', 'windows-x64'],
  });
});

test('refresh reconstructs from the same verified archives without roots or injected readers', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const subject = await import(moduleUrl);
  const state = provenanceEvidenceFixture();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));

  const refreshed = subject.refreshPythonStandaloneEvidenceBundle({
    bundle: state.f.bundle,
    runtimeLock: state.f.runtimeLock,
    bom: state.f.bom,
    metadataArchives: state.metadataArchives,
    sourceArchives: { [state.sourceSha]: state.sourceArchive },
  });
  assert.deepEqual(refreshed, state.f.bundle);
  assert.throws(
    () => subject.refreshPythonStandaloneEvidenceBundle({
      bundle: state.f.bundle,
      runtimeLock: state.f.runtimeLock,
      bom: state.f.bom,
      metadataArchives: state.metadataArchives,
      sourceArchives: { [state.sourceSha]: state.sourceArchive },
      metadataRoots: { 'macos-arm64': '/untrusted/root' },
    }),
    /unverified provenance option.*metadataRoots/i,
  );
  assert.throws(
    () => subject.refreshPythonStandaloneEvidenceBundle({
      bundle: state.f.bundle,
      runtimeLock: state.f.runtimeLock,
      bom: state.f.bom,
      metadataArchives: state.metadataArchives,
      sourceArchives: { [state.sourceSha]: state.sourceArchive },
      readSourceArchiveMember: () => state.f.sourceBytes,
    }),
    /unverified provenance option.*readSourceArchiveMember/i,
  );
});

test('CLI refresh emits deterministic JSON without metadata roots or repository writes', {
  skip: typeof zlib.zstdDecompressSync !== 'function',
}, async (t) => {
  const subject = await import(moduleUrl);
  const state = provenanceEvidenceFixture();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  const jsonPaths = {};
  for (const [name, value] of Object.entries({
    bundle: state.f.bundle,
    'runtime-lock': state.f.runtimeLock,
    bom: state.f.bom,
  })) {
    jsonPaths[name] = path.join(state.directory, `${name}.json`);
    fs.writeFileSync(jsonPaths[name], `${JSON.stringify(value, null, 2)}\n`);
  }
  const before = fs.readFileSync(jsonPaths.bundle);
  const result = subject.pythonStandaloneEvidenceCli([
    'refresh',
    '--bundle', jsonPaths.bundle,
    '--runtime-lock', jsonPaths['runtime-lock'],
    '--bom', jsonPaths.bom,
    '--metadata-archive', `macos-arm64=${state.metadataArchives['macos-arm64']}`,
    '--metadata-archive', `windows-x64=${state.metadataArchives['windows-x64']}`,
    '--source-archive', `${state.sourceSha}=${state.sourceArchive}`,
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), state.f.bundle);
  assert.deepEqual(fs.readFileSync(jsonPaths.bundle), before);
});

test('fails closed on PYTHON.json target, build, license, and Tcl closure mutations', async (t) => {
  const subject = await import(moduleUrl);
  const cases = [
    ['metadata origin', (f) => {
      f.bom.platforms['macos-arm64'].metadataSource.url =
        'https://attacker.invalid/forged-full.tar.zst';
    }, /metadata source mismatch/],
    ['metadata compressed size type', (f) => {
      f.runtimeLock.python.metadataAssets['macos-arm64'].size = '1';
      f.bom.platforms['macos-arm64'].metadataSource.size = '1';
    }, /metadata source mismatch/],
    ['target triple', (f) => relockPythonJson(f, 'macos-arm64', (metadata) => {
      metadata.target_triple = 'x86_64-apple-darwin';
    }), /target\/build options mismatch/],
    ['build options', (f) => relockPythonJson(f, 'macos-arm64', (metadata) => {
      metadata.build_options = 'pgo';
    }), /target\/build options mismatch/],
    ['license path', (f) => relockPythonJson(f, 'macos-arm64', (metadata) => {
      metadata.license_path = 'licenses/MISSING.txt';
    }), /Missing bundled PYTHON\.json license path/],
    ['unknown Tcl path', (f) => relockPythonJson(f, 'macos-arm64', (metadata) => {
      metadata.tcl_library_paths[0] = 'unknown1.0';
    }), /Tcl library path partition mismatch/],
    ['missing Tcl path', (f) => relockPythonJson(f, 'windows-x64', (metadata) => {
      metadata.tcl_library_paths.pop();
    }), /Tcl library path partition mismatch/],
    ['duplicate Tcl path', (f) => relockPythonJson(f, 'windows-x64', (metadata) => {
      metadata.tcl_library_paths[1] = metadata.tcl_library_paths[0];
    }), /Tcl library path partition mismatch/],
    ['missing Tcl component', (f) => {
      f.bom.platforms['macos-arm64'].components =
        f.bom.platforms['macos-arm64'].components.filter(({ name }) => name !== 'itcl');
    }, /Missing or mismatched reviewed Tcl component/],
    ['wrong Tcl component version', (f) => {
      f.bom.platforms['windows-x64'].components
        .find(({ name }) => name === 'tix').version = '8.4.3';
    }, /Missing or mismatched reviewed Tcl component/],
    ['duplicate Tcl component', (f) => {
      const duplicate = structuredClone(
        f.bom.platforms['macos-arm64'].components.find(({ name }) => name === 'tk'),
      );
      f.bom.platforms['macos-arm64'].components.push(duplicate);
    }, /Duplicate Python standalone BOM component/],
  ];
  for (const [label, mutate, expected] of cases) {
    await t.test(label, () => {
      const f = fixture();
      mutate(f);
      assert.throws(
        () => subject.loadPythonStandaloneEvidence({
          bundle: f.bundle,
          runtimeLock: f.runtimeLock,
          bom: f.bom,
        }),
        expected,
      );
    });
  }
});

test('repository bundle stages and re-verifies the exact BOM notice set on both platforms', async (t) => {
  const subject = await import(moduleUrl);
  const evidence = subject.loadPythonStandaloneEvidence();
  const bom = JSON.parse(fs.readFileSync('packaging/python-standalone-bom.json', 'utf8'));
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `python-real-notices-${platform}-`));
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const expected = new Map();
    for (const component of bom.platforms[platform].components) {
      for (const record of component.licenseEvidence ?? []) {
        if (!['metadata-file', 'source-file', 'source-archive-member'].includes(record.kind)) {
          continue;
        }
        const payloadRecord = evidence.payloadRecordForEvidence(platform, record);
        expected.set(payloadRecord.path.toLowerCase(), payloadRecord);
      }
    }
    const expectedRecords = [...expected.values()]
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
      );
    assert.deepEqual(subject.stagePythonStandaloneNotices({
      runtimeRoot,
      platform,
      evidence,
    }), expectedRecords);
    assert.deepEqual(evidence.verifyStagedPythonStandaloneNotices({
      runtimeRoot,
      platform,
    }), expectedRecords);
  }
});

test('permits only reviewed missing metadata licenses for external system-link variants', async (t) => {
  const subject = await import(moduleUrl);
  const addMissingSystemLicense = (f, { system = true, exclusion = true } = {}) => {
    relockPythonJson(f, 'macos-arm64', (metadata) => {
      metadata.build_info = {
        extensions: {
          zlib: [{
            license_paths: ['licenses/LICENSE.missing-system.txt'],
            links: [{ name: 'z', system }],
          }],
        },
      };
    });
    if (exclusion) {
      f.bundle.reviewedOverlays.metadataLicensePathExclusions['macos-arm64'].push({
        path: 'licenses/LICENSE.missing-system.txt',
        disposition: 'external-system-upstream-metadata-missing-member',
        rationale: 'Synthetic fixture models a missing metadata license for an external system link.',
      });
    }
  };

  await t.test('reviewed external system link', () => {
    const f = fixture();
    addMissingSystemLicense(f);
    assert.doesNotThrow(() => subject.loadPythonStandaloneEvidence({
      bundle: f.bundle,
      runtimeLock: f.runtimeLock,
      bom: f.bom,
    }));
  });
  for (const [label, options, expected] of [
    ['missing review', { exclusion: false }, /Missing bundled PYTHON\.json license path/],
    ['non-system link', { system: false }, /Missing bundled PYTHON\.json license path/],
  ]) {
    await t.test(label, () => {
      const f = fixture();
      addMissingSystemLicense(f, options);
      assert.throws(() => subject.loadPythonStandaloneEvidence({
        bundle: f.bundle,
        runtimeLock: f.runtimeLock,
        bom: f.bom,
      }), expected);
    });
  }
});
