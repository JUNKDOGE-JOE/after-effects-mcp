import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('self-signed Windows ZXP stages Express at the direct host path', async () => {
  const source = await fs.promises.readFile('scripts/package-zxp.ps1', 'utf8');

  assert.match(
    source,
    /\$hostDir\s*=\s*Join-Path \$stageDir 'host'/,
  );
  assert.match(source, /Copy-Item -LiteralPath \(Join-Path \$pluginSrc \$payload\)/);
  assert.match(source, /-Destination \(Join-Path \$stageDir \$payload\)/);
  assert.match(source, /\$payloadRoots\s*=\s*@\('client', 'CSXS', 'host', 'icons', 'jsx', 'shared'\)/);
  assert.match(source, /Push-Location \$hostDir[\s\S]+?npm ci --omit=dev/);
  assert.match(source, /node_modules\\express\\package\.json/);
  assert.match(source, /IsNullOrWhiteSpace\(\$Tsa\)/);
  assert.match(source, /& \$ZxpSignCmd -verify \$OutputPath/);
  assert.doesNotMatch(
    source,
    /Push-Location \(Join-Path \$stageDir 'host'\)[\s\S]+?npm ci --omit=dev/,
  );
});
