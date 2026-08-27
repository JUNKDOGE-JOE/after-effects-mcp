'use strict';

const fs = require('fs');
const path = require('path');
const { createStatePaths } = require('../state-paths');

function defaultPath(options) {
    const input = options || {};
    return (input.statePaths || createStatePaths(input)).blockedClients;
}

function normalizeName(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNames(fileSystem, filePath, logger) {
    let raw;
    try {
        raw = fileSystem.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return [];
        if (logger) logger({
            level: 'warn',
            source: 'mcp-client-blocklist',
            message: 'blocked-clients.json could not be read; failing open',
            error: error && error.message ? error.message : String(error),
        });
        return [];
    }
    try {
        const value = JSON.parse(raw);
        const names = Array.isArray(value) ? value : value && value.clients;
        if (!Array.isArray(names)) throw new Error('expected an array of client names');
        return names.map(normalizeName).filter(Boolean);
    } catch (error) {
        if (logger) logger({
            level: 'warn',
            source: 'mcp-client-blocklist',
            message: 'blocked-clients.json is corrupt; failing open',
            error: error && error.message ? error.message : String(error),
        });
        return [];
    }
}

function writeNames(fileSystem, filePath, names, logger) {
    const directory = path.dirname(filePath);
    const temporary = path.join(
        directory,
        '.blocked-clients-' + process.pid + '-' + Date.now() + '.tmp',
    );
    try {
        fileSystem.mkdirSync(directory, { recursive: true });
        fileSystem.writeFileSync(temporary, JSON.stringify(Array.from(names).sort()) + '\n', 'utf8');
        fileSystem.renameSync(temporary, filePath);
        return true;
    } catch (error) {
        try { fileSystem.unlinkSync(temporary); } catch (_) {}
        if (logger) logger({
            level: 'warn',
            source: 'mcp-client-blocklist',
            message: 'blocked-clients.json could not be written',
            error: error && error.message ? error.message : String(error),
        });
        return false;
    }
}

function createClientBlocklist(options) {
    const input = options || {};
    const fileSystem = input.fsImpl || fs;
    const filePath = input.filePath || defaultPath(input);
    const logger = typeof input.logger === 'function' ? input.logger : null;
    const names = new Set(readNames(fileSystem, filePath, logger));

    return {
        path: filePath,
        has: function (name) {
            const key = normalizeName(name);
            return !!key && names.has(key);
        },
        list: function () { return Array.from(names).sort(); },
        set: function (name, blocked) {
            const key = normalizeName(name);
            if (!key) throw new TypeError('client name must be a non-empty string');
            if (blocked) names.add(key);
            else names.delete(key);
            return writeNames(fileSystem, filePath, names, logger);
        },
    };
}

module.exports = { createClientBlocklist, defaultPath };
