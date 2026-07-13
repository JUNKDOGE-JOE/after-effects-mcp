import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('self-signed Windows ZXP stages Express at the production host runtime path', async () => {
  const source = await fs.promises.readFile('scripts/package-zxp.ps1', 'utf8');

  assert.match(
    source,
    /\$runtimeHostDir\s*=\s*Join-Path \$stageDir 'runtime\\windows-x64\\node\\host'/,
  );
  assert.match(source, /Copy-Item[^\r\n]+host\\package\.json[^\r\n]+\$runtimeHostDir/);
  assert.match(source, /Copy-Item[^\r\n]+host\\package-lock\.json[^\r\n]+\$runtimeHostDir/);
  assert.match(source, /Push-Location \$runtimeHostDir[\s\S]+?npm ci --omit=dev/);
  assert.match(source, /node_modules\\express\\package\.json/);
  assert.match(source, /IsNullOrWhiteSpace\(\$Tsa\)/);
  assert.match(source, /& \$ZxpSignCmd -verify \$OutputPath/);
  assert.doesNotMatch(
    source,
    /Push-Location \(Join-Path \$stageDir 'host'\)[\s\S]+?npm ci --omit=dev/,
  );
});
