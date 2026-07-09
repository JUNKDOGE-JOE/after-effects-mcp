import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('support matrix and CEP manifest promise only the verified matrix', () => {
  const matrix = JSON.parse(fs.readFileSync('packaging/support-matrix.json', 'utf8'));
  const manifest = fs.readFileSync('plugin/CSXS/manifest.xml', 'utf8');
  assert.deepEqual(matrix, {
    schemaVersion: 1,
    platforms: {
      'macos-arm64': {
        minOsVersion: '14.0', arch: 'arm64', rosetta: false,
      },
      'windows-x64': {
        minOsVersion: '11.0.26100', arch: 'x64',
      },
    },
    afterEffects: {
      majors: [25, 26],
      manifestRange: '[25.0,26.9]',
    },
  });
  assert.match(manifest, /<Host Name="AEFT" Version="\[25\.0,26\.9\]" \/>/);
  assert.doesNotMatch(manifest, /99\.9/);
});
