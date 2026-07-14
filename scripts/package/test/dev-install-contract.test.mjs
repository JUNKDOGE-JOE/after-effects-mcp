import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source, 'utf8');
  await chmod(filePath, 0o755);
}

async function makeMacFixture(t, {
  pgrepExitCode = 1,
  failSecondMove = false,
  sourceSymlink = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ae-mcp-dev-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRepo = path.join(root, 'repo');
  const fixtureScripts = path.join(fixtureRepo, 'scripts');
  const plugin = path.join(fixtureRepo, 'plugin');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await mkdir(fixtureScripts, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const relative of [
    'CSXS/manifest.xml',
    'client/index.html',
    'client/dist/app.js',
    'host/server.js',
    'jsx/runtime.jsx',
    '.debug',
  ]) {
    const target = path.join(plugin, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `fixture:${relative}\n`, 'utf8');
  }
  await symlink('client/index.html', path.join(plugin, 'internal-link'));
  if (sourceSymlink) await symlink('/tmp', path.join(plugin, 'external-link'));
  const installer = path.join(fixtureScripts, 'install-plugin-dev-macos.sh');
  await cp(path.join(repoRoot, 'scripts/install-plugin-dev-macos.sh'), installer);
  await chmod(installer, 0o755);

  await writeExecutable(path.join(bin, 'pgrep'), `#!/bin/sh\nexit ${pgrepExitCode}\n`);
  await writeExecutable(path.join(bin, 'defaults'), '#!/bin/sh\nexit 0\n');
  if (failSecondMove) {
    const counter = path.join(root, 'mv-count');
    await writeExecutable(path.join(bin, 'mv'), `#!/bin/sh
count=0
if [ -f '${counter}' ]; then count=$(cat '${counter}'); fi
count=$((count + 1))
printf '%s' "$count" > '${counter}'
if [ "$count" -eq 2 ]; then exit 73; fi
exec /bin/mv "$@"
`);
  }

  const scanRoot = path.join(home, 'Library/Application Support/Adobe/CEP/extensions');
  const target = path.join(scanRoot, 'com.aemcp.panel');
  const stateDir = path.join(
    home,
    'Library/Application Support/AfterEffectsMCP/cep-panel-dev-v1',
  );
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'old-install.txt'), 'preserve me\n', 'utf8');
  return {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    },
    fixtureRepo,
    installer,
    plugin,
    scanRoot,
    stateDir,
    target,
  };
}

test('macOS dev install refuses a running AE before touching the deployed panel', async (t) => {
  const fixture = await makeMacFixture(t, { pgrepExitCode: 0 });
  await assert.rejects(
    execFileAsync(fixture.installer, [], { cwd: fixture.fixtureRepo, env: fixture.env }),
    /After Effects.*closed/i,
  );
  assert.equal(await readFile(path.join(fixture.target, 'old-install.txt'), 'utf8'), 'preserve me\n');
});

test('macOS dev install fails closed when AE process inspection itself fails', async (t) => {
  const fixture = await makeMacFixture(t, { pgrepExitCode: 2 });
  await assert.rejects(
    execFileAsync(fixture.installer, [], { cwd: fixture.fixtureRepo, env: fixture.env }),
    /could not determine whether After Effects is running/i,
  );
  assert.equal(await readFile(path.join(fixture.target, 'old-install.txt'), 'utf8'), 'preserve me\n');
});

test('macOS dev install rejects symlinks anywhere in the source tree', async (t) => {
  const fixture = await makeMacFixture(t, { sourceSymlink: true });
  await assert.rejects(
    execFileAsync(fixture.installer, [], { cwd: fixture.fixtureRepo, env: fixture.env }),
    /symlink escapes plugin tree|regular files and directories/i,
  );
  assert.equal(await readFile(path.join(fixture.target, 'old-install.txt'), 'utf8'), 'preserve me\n');
});

test('macOS dev install stages, verifies, swaps, and retains a restorable backup', async (t) => {
  const fixture = await makeMacFixture(t);
  const { stdout } = await execFileAsync(fixture.installer, [], {
    cwd: fixture.fixtureRepo,
    env: fixture.env,
  });
  assert.equal(await readFile(path.join(fixture.target, 'client/dist/app.js'), 'utf8'),
    'fixture:client/dist/app.js\n');
  const scanRootEntries = await readdir(path.dirname(fixture.target));
  assert.deepEqual(scanRootEntries, ['com.aemcp.panel']);
  const backups = (await readdir(fixture.stateDir)).filter((name) => name.includes('.backup.'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(fixture.stateDir, backups[0], 'old-install.txt'), 'utf8'),
    'preserve me\n');
  assert.equal((await stat(fixture.stateDir)).mode & 0o077, 0);
  assert.match(stdout, /Restore command.*After Effects is closed/is);
  assert.match(stdout, new RegExp(backups[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('macOS dev install preserves legacy transaction artifacts outside the CEP scan root', async (t) => {
  const fixture = await makeMacFixture(t);
  const legacyName = '.com.aemcp.panel.backup.20260714T210715Z.54520.16325';
  const legacyArtifact = path.join(fixture.scanRoot, legacyName);
  await mkdir(legacyArtifact);
  await writeFile(path.join(legacyArtifact, 'legacy-install.txt'), 'legacy bytes\n', 'utf8');

  await execFileAsync(fixture.installer, [], {
    cwd: fixture.fixtureRepo,
    env: fixture.env,
  });

  assert.deepEqual(await readdir(fixture.scanRoot), ['com.aemcp.panel']);
  assert.equal(
    await readFile(path.join(fixture.stateDir, legacyName, 'legacy-install.txt'), 'utf8'),
    'legacy bytes\n',
  );
});

test('macOS dev install rejects symbolic or non-directory legacy transaction artifacts', async (t) => {
  for (const kind of ['symlink', 'file']) {
    await t.test(kind, async (child) => {
      const fixture = await makeMacFixture(child);
      const legacyName = `.com.aemcp.panel.failed.${kind}-fixture`;
      const legacyArtifact = path.join(fixture.scanRoot, legacyName);
      if (kind === 'symlink') await symlink(fixture.target, legacyArtifact);
      else await writeFile(legacyArtifact, 'not a directory\n', 'utf8');

      await assert.rejects(
        execFileAsync(fixture.installer, [], {
          cwd: fixture.fixtureRepo,
          env: fixture.env,
        }),
        /legacy CEP transaction artifact is not a regular directory/i,
      );
      assert.equal(await readFile(path.join(fixture.target, 'old-install.txt'), 'utf8'),
        'preserve me\n');
    });
  }
});

test('macOS dev install fails closed when a legacy artifact destination conflicts', async (t) => {
  const fixture = await makeMacFixture(t);
  const legacyName = '.com.aemcp.panel.replaced.conflict-fixture';
  const legacyArtifact = path.join(fixture.scanRoot, legacyName);
  await mkdir(legacyArtifact);
  await writeFile(path.join(legacyArtifact, 'scan-root-copy.txt'), 'scan root\n', 'utf8');
  await mkdir(fixture.stateDir, { recursive: true });
  await mkdir(path.join(fixture.stateDir, legacyName));

  await assert.rejects(
    execFileAsync(fixture.installer, [], {
      cwd: fixture.fixtureRepo,
      env: fixture.env,
    }),
    /legacy CEP transaction destination already exists/i,
  );
  assert.equal(await readFile(path.join(legacyArtifact, 'scan-root-copy.txt'), 'utf8'),
    'scan root\n');
  assert.equal(await readFile(path.join(fixture.target, 'old-install.txt'), 'utf8'),
    'preserve me\n');
});

test('macOS dev install restores the old panel when the second atomic rename fails', async (t) => {
  const fixture = await makeMacFixture(t, { failSecondMove: true });
  await assert.rejects(
    execFileAsync(fixture.installer, [], { cwd: fixture.fixtureRepo, env: fixture.env }),
  );
  assert.equal(await readFile(path.join(fixture.target, 'old-install.txt'), 'utf8'), 'preserve me\n');
  assert.deepEqual(await readdir(path.dirname(fixture.target)), ['com.aemcp.panel']);
  const stateEntries = await readdir(fixture.stateDir);
  assert.equal(stateEntries.some((name) => name.includes('.staging.')), false);
});

test('dev installers encode preflight, isolated macOS state, rollback, and no delete-first path', async () => {
  const mac = await readFile(path.join(repoRoot, 'scripts/install-plugin-dev-macos.sh'), 'utf8');
  const windows = await readFile(path.join(repoRoot, 'scripts/install-plugin-dev.ps1'), 'utf8');

  assert.doesNotMatch(mac, /rm\s+-rf\s+"?\$\{?cep_dir/i);
  assert.match(mac, /pgrep[\s\S]*Adobe After Effects\|AfterFX/);
  assert.match(mac, /\.staging\./);
  assert.match(mac, /\.backup\./);
  assert.match(mac, /rsync[\s\S]*--delete/);
  assert.match(mac, /rsync[\s\S]*--checksum/);
  assert.match(mac, /restore/i);
  assert.match(mac, /AfterEffectsMCP\/cep-panel-dev-v1/);
  assert.match(mac, /state_dir=.*AfterEffectsMCP/);
  assert.match(mac, /staging="\$\{state_dir\}/);
  assert.match(mac, /backup="\$\{state_dir\}/);
  assert.match(mac, /failed_install="\$\{state_dir\}/);
  assert.match(mac, /restore_replaced="\$\{state_dir\}/);
  assert.doesNotMatch(mac, /staging="\$\{cep_parent\}/);
  assert.doesNotMatch(mac, /backup="\$\{cep_parent\}/);
  assert.doesNotMatch(mac, /failed_install="\$\{cep_parent\}/);
  assert.doesNotMatch(mac, /restore_replaced="\$\{cep_parent\}/);
  assert.ok(mac.indexOf('defaults write') < mac.indexOf('mv "$cep_dir" "$backup"'));
  for (const required of ['CSXS/manifest.xml', 'client/dist/app.js', 'host/server.js']) {
    assert.ok(mac.includes(required));
  }

  assert.doesNotMatch(windows, /Remove-Item[^\n]*\$cepDir/i);
  assert.match(windows, /Get-Process[\s\S]*AfterFX/);
  assert.match(windows, /Get-Process\s+-ErrorAction\s+Stop/);
  assert.match(windows, /could not determine whether After Effects is running/i);
  assert.match(windows, /\.staging\./);
  assert.match(windows, /\.backup\./);
  assert.match(windows, /Assert-TreeEqual/);
  assert.match(windows, /CEP extension parent[\s\S]*ReparsePoint/i);
  assert.match(windows, /Move-Item[\s\S]*\$backup[\s\S]*Move-Item[\s\S]*\$cepDir/);
  assert.match(windows, /Restore command/i);
  assert.match(windows, /Restore command[\s\S]*ErrorActionPreference[\s\S]*Stop/i);
  assert.ok(windows.indexOf('Set-ItemProperty') < windows.indexOf(
    'Move-Item -LiteralPath $cepDir -Destination $backup',
  ));
  for (const required of ['CSXS\\manifest.xml', 'client\\dist\\app.js', 'host\\server.js']) {
    assert.ok(windows.includes(required));
  }
});

test('macOS dev installer is executable as documented', async () => {
  const metadata = await stat(path.join(repoRoot, 'scripts/install-plugin-dev-macos.sh'));
  assert.notEqual(metadata.mode & 0o111, 0);
});
