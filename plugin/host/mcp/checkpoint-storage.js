'use strict';

const fs = require('fs');
const path = require('path');
const { projectDirKey } = require('./checkpoint-store');

function absolutePath(value, name) {
    const qualified = process.platform !== 'win32'
        || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value);
    if (typeof value !== 'string' || !value || value.includes('\0')
        || !path.isAbsolute(value) || !qualified) {
        throw new TypeError(name + ' must be a fully qualified absolute path');
    }
    return path.normalize(value);
}

function isDirectory(directory) {
    try {
        return fs.statSync(directory).isDirectory();
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
    }
}

function resolveCheckpointLocation({ projectPath, workDir } = {}) {
    const sourcePath = absolutePath(projectPath, 'projectPath');
    let base = ['Adobe After Effects Auto-Save', '自动保存']
        .map(name => path.join(path.dirname(sourcePath), name)).find(isDirectory);
    let source = 'adjacent-auto-save';
    if (!base) {
        base = absolutePath(workDir, 'workDir');
        if (!isDirectory(base)) throw new TypeError('workDir must be an existing directory');
        source = 'session-workdir';
    }
    return {
        directory: path.join(base, 'ae-mcp', 'checkpoints', projectDirKey(sourcePath)),
        source,
    };
}

module.exports = { resolveCheckpointLocation };
