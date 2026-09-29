'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCheckpointLocation } = require('./checkpoint-storage');

function fixture(t) {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(tempRoot, 'ae-mcp-checkpoint-storage-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(directory)), tempRoot);
        assert.ok(path.basename(directory).startsWith('ae-mcp-checkpoint-storage-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

function assertPlacement(result, base) {
    assert.equal(path.dirname(result.directory), path.join(base, 'ae-mcp', 'checkpoints'));
    assert.equal(fs.existsSync(result.directory), false);
}

test('uses an existing adjacent auto-save directory before the session directory', (t) => {
    const root = fixture(t);
    const autoSave = path.join(root, 'Adobe After Effects Auto-Save');
    const workDir = path.join(root, 'session');
    fs.mkdirSync(autoSave);
    fs.mkdirSync(workDir);
    const result = resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep'), workDir });
    assert.equal(result.source, 'adjacent-auto-save');
    assertPlacement(result, autoSave);
    assert.deepEqual(fs.readdirSync(autoSave), []);
    assert.deepEqual(fs.readdirSync(workDir), []);
    assert.deepEqual(resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep') }), result);
});

test('falls back to the supplied session directory without creating folders', (t) => {
    const root = fixture(t);
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    const result = resolveCheckpointLocation({ projectPath: path.join(projectDir, 'Main.aep'), workDir: root });
    assert.equal(result.source, 'session-workdir');
    assertPlacement(result, root);
    assert.deepEqual(fs.readdirSync(root), ['project']);
});

test('requires an absolute existing session directory when auto-save is absent', (t) => {
    const root = fixture(t);
    const projectPath = path.join(root, 'Main.aep');
    for (const workDir of [undefined, '', 'relative', path.join(root, 'missing')]) {
        assert.throws(() => resolveCheckpointLocation({ projectPath, workDir }), /workDir/);
    }
});

test('rejects invalid project paths instead of deriving them from the process cwd', (t) => {
    const root = fixture(t);
    const invalid = [undefined, '', 'Main.aep', path.join(root, 'bad\0.aep')];
    if (process.platform === 'win32') invalid.push('C:Main.aep', '\\Main.aep');
    for (const projectPath of invalid) {
        assert.throws(() => resolveCheckpointLocation({ projectPath, workDir: root }), /projectPath/);
    }
});

test('keeps same-named projects from different directories separate', (t) => {
    const root = fixture(t);
    const first = resolveCheckpointLocation({ projectPath: path.join(root, 'one', 'Main.aep'), workDir: root });
    const second = resolveCheckpointLocation({ projectPath: path.join(root, 'two', 'Main.aep'), workDir: root });
    assert.notEqual(first.directory, second.directory);
    assertPlacement(first, root);
    assertPlacement(second, root);
});

test('does not treat a file with the auto-save folder name as a directory', (t) => {
    const root = fixture(t);
    const blocker = path.join(root, 'Adobe After Effects Auto-Save');
    fs.writeFileSync(blocker, 'existing file');
    const result = resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep'), workDir: root });
    assert.equal(result.source, 'session-workdir');
    assertPlacement(result, root);
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'existing file');
});


test('uses the observed Chinese auto-save directory without changing its contents', (t) => {
    const root = fixture(t);
    const autoSave = path.join(root, '自动保存');
    fs.mkdirSync(autoSave);
    fs.writeFileSync(path.join(autoSave, 'existing.txt'), 'keep');
    const result = resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep'), workDir: root });
    assert.equal(result.source, 'adjacent-auto-save');
    assertPlacement(result, autoSave);
    assert.deepEqual(fs.readdirSync(autoSave), ['existing.txt']);
    assert.equal(fs.readFileSync(path.join(autoSave, 'existing.txt'), 'utf8'), 'keep');
});

test('English has priority when both observed names exist regardless of creation order', (t) => {
    for (const names of [['自动保存', 'Adobe After Effects Auto-Save'], ['Adobe After Effects Auto-Save', '自动保存']]) {
        const root = fixture(t);
        names.forEach(name => fs.mkdirSync(path.join(root, name)));
        const result = resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep') });
        assert.equal(result.source, 'adjacent-auto-save');
        assertPlacement(result, path.join(root, 'Adobe After Effects Auto-Save'));
        names.forEach(name => assert.deepEqual(fs.readdirSync(path.join(root, name)), []));
    }
});

test('an English-named file does not shadow an existing Chinese auto-save directory', (t) => {
    const root = fixture(t);
    const blocker = path.join(root, 'Adobe After Effects Auto-Save');
    const autoSave = path.join(root, '自动保存');
    fs.writeFileSync(blocker, 'keep');
    fs.mkdirSync(autoSave);
    assertPlacement(resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep') }), autoSave);
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'keep');
});

test('files under both recognized names still fall back to the session directory', (t) => {
    const root = fixture(t);
    for (const name of ['Adobe After Effects Auto-Save', '自动保存']) fs.writeFileSync(path.join(root, name), 'keep');
    const result = resolveCheckpointLocation({ projectPath: path.join(root, 'Main.aep'), workDir: root });
    assert.equal(result.source, 'session-workdir');
    assertPlacement(result, root);
    assert.deepEqual(fs.readdirSync(root).sort(), ['Adobe After Effects Auto-Save', '自动保存'].sort());
});
