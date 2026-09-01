'use strict';

const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const completed = new Set();

function scanDirectory(directory, sessionName, currentSessionId, files, directories) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
    entries.forEach(function (entry) {
        const item = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) return;
        if (entry.isDirectory()) {
            directories.push(item);
            scanDirectory(item, sessionName, currentSessionId, files, directories);
            return;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png') return;
        try {
            const stat = fs.statSync(item);
            files.push({ path: item, size: stat.size, mtimeMs: stat.mtimeMs, current: sessionName === currentSessionId });
        } catch (_) {}
    });
}

function inventory(root, currentSessionId) {
    let sessions;
    try { sessions = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return { files: [], directories: [] }; }
    const files = [];
    const directories = [];
    sessions.forEach(function (entry) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) return;
        const directory = path.join(root, entry.name);
        directories.push(directory);
        scanDirectory(directory, entry.name, currentSessionId, files, directories);
    });
    return { files: files, directories: directories };
}

function removeFile(file) {
    try { fs.unlinkSync(file.path); return true; } catch (_) { return false; }
}

function removeEmptyDirectories(directories, currentDirectory) {
    directories.sort(function (a, b) { return b.length - a.length; }).forEach(function (directory) {
        if (path.resolve(directory) === currentDirectory) return;
        try { fs.rmdirSync(directory); } catch (_) {}
    });
}

function prunePreviewRoot(root, currentSessionId, options) {
    const setting = options || {};
    const now = setting.now === undefined ? Date.now() : setting.now;
    const maxAgeMs = setting.maxAgeMs === undefined ? MAX_AGE_MS : setting.maxAgeMs;
    const maxTotalBytes = setting.maxTotalBytes === undefined ? MAX_TOTAL_BYTES : setting.maxTotalBytes;
    const currentDirectory = path.resolve(root, currentSessionId);
    const first = inventory(root, currentSessionId);
    first.files.forEach(function (file) {
        if (!file.current && file.mtimeMs < now - maxAgeMs) removeFile(file);
    });

    const second = inventory(root, currentSessionId);
    let totalBytes = second.files.reduce(function (total, file) { return total + file.size; }, 0);
    second.files.filter(function (file) { return !file.current; }).sort(function (a, b) {
        return a.mtimeMs - b.mtimeMs;
    }).some(function (file) {
        if (totalBytes <= maxTotalBytes) return true;
        if (removeFile(file)) totalBytes -= file.size;
        return false;
    });
    removeEmptyDirectories(inventory(root, currentSessionId).directories, currentDirectory);
}

function prunePreviewRootOnce(root, currentSessionId, options) {
    const key = path.resolve(root, currentSessionId);
    if (completed.has(key)) return;
    completed.add(key);
    try { prunePreviewRoot(root, currentSessionId, options); } catch (_) {}
}

module.exports = {
    MAX_AGE_MS: MAX_AGE_MS,
    MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
    prunePreviewRoot: prunePreviewRoot,
    prunePreviewRootOnce: prunePreviewRootOnce,
};
