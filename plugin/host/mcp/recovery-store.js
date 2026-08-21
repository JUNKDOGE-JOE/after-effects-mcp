'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RECOVERY_ID = /^[a-z0-9]{6}$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function assertRecoveryId(value) {
    if (typeof value !== 'string' || !RECOVERY_ID.test(value)) {
        throw new Error('invalid recoveryId: ' + String(value));
    }
    return value;
}

function isInside(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (relative.slice(0, 2) !== '..' && !path.isAbsolute(relative));
}

class RecoveryStore {
    constructor(options) {
        const input = options || {};
        if (!input.checkpointStore || typeof input.checkpointStore.dirFor !== 'function') {
            throw new Error('RecoveryStore requires a CheckpointStore');
        }
        this.checkpointStore = input.checkpointStore;
        this.root = path.resolve(input.checkpointStore.root);
        this.keep = input.keep === undefined
            ? Math.max(1, Number(input.checkpointStore.keep) || 50)
            : Math.max(1, Number(input.keep) || 1);
    }

    _recoveryDir(sourcePath) {
        return path.join(this.checkpointStore.dirFor(sourcePath), 'recovery');
    }

    _validateEntry(entry) {
        if (!entry || typeof entry !== 'object') throw new Error('invalid recovery entry');
        const id = assertRecoveryId(entry.recoveryId);
        const scriptPath = path.resolve(String(entry.scriptPath || ''));
        const metaPath = path.resolve(String(entry.metaPath || ''));
        if (!isInside(scriptPath, this.root) || !isInside(metaPath, this.root)
            || path.basename(path.dirname(scriptPath)) !== 'recovery'
            || path.dirname(scriptPath) !== path.dirname(metaPath)
            || path.basename(scriptPath) !== id + '.jsx'
            || path.basename(metaPath) !== id + '.json') {
            throw new Error('invalid recovery entry path');
        }
        return Object.assign({}, entry, { recoveryId: id, scriptPath, metaPath });
    }

    _makeId(directory) {
        for (;;) {
            const bytes = crypto.randomBytes(6);
            let id = '';
            for (let i = 0; i < 6; i += 1) id += ID_ALPHABET.charAt(bytes[i] % ID_ALPHABET.length);
            const scriptPath = path.join(directory, id + '.jsx');
            const metaPath = path.join(directory, id + '.json');
            if (!fs.existsSync(scriptPath) && !fs.existsSync(metaPath)) return id;
        }
    }

    create(values) {
        const input = values || {};
        const sourceProjectPath = input.sourceProjectPath || null;
        const directory = this._recoveryDir(sourceProjectPath);
        fs.mkdirSync(directory, { recursive: true });
        const recoveryId = this._makeId(directory);
        const paths = {
            recoveryId,
            scriptPath: path.resolve(directory, recoveryId + '.jsx'),
            metaPath: path.resolve(directory, recoveryId + '.json'),
        };
        const supplied = input.meta && typeof input.meta === 'object' ? input.meta : {};
        const meta = Object.assign({
            recoveryId,
            createdAt: new Date().toISOString(),
            sourceProjectPath,
            scriptPath: paths.scriptPath,
            checkpointId: null,
            args: {
                undo_group_name: null,
                checkpoint_label: null,
                timeout_sec: null,
            },
            client: null,
            conversationId: null,
            attempts: [],
        }, supplied, {
            recoveryId,
            sourceProjectPath,
            scriptPath: paths.scriptPath,
        });
        if (!Array.isArray(meta.attempts)) meta.attempts = [];
        fs.writeFileSync(paths.scriptPath, String(input.code), 'utf8');
        fs.writeFileSync(paths.metaPath, JSON.stringify(meta), 'utf8');
        this.prune(sourceProjectPath);
        return paths;
    }

    _lookupInDirectory(recoveryId, directory) {
        const id = assertRecoveryId(recoveryId);
        const scriptPath = path.resolve(directory, id + '.jsx');
        const metaPath = path.resolve(directory, id + '.json');
        if (!isInside(scriptPath, this.root) || !isInside(metaPath, this.root)
            || !fs.existsSync(scriptPath) || !fs.existsSync(metaPath)) return null;
        return { recoveryId: id, scriptPath, metaPath };
    }

    lookup(recoveryId, sourcePathHint) {
        const id = assertRecoveryId(recoveryId);
        if (sourcePathHint !== undefined) {
            const hinted = this._lookupInDirectory(id, this._recoveryDir(sourcePathHint || null));
            if (hinted) return hinted;
        }
        if (!fs.existsSync(this.root)) return null;
        const names = fs.readdirSync(this.root);
        for (let i = 0; i < names.length; i += 1) {
            const directory = path.join(this.root, names[i], 'recovery');
            let stat;
            try { stat = fs.statSync(directory); } catch (error) { continue; }
            if (!stat.isDirectory()) continue;
            const found = this._lookupInDirectory(id, directory);
            if (found) return found;
        }
        return null;
    }

    readScript(entry) {
        const value = this._validateEntry(entry);
        return fs.readFileSync(value.scriptPath, 'utf8');
    }

    writeScript(entry, code) {
        const value = this._validateEntry(entry);
        fs.writeFileSync(value.scriptPath, String(code), 'utf8');
        return value.scriptPath;
    }

    readMeta(entry) {
        const value = this._validateEntry(entry);
        return JSON.parse(fs.readFileSync(value.metaPath, 'utf8'));
    }

    writeMeta(entry, meta) {
        const value = this._validateEntry(entry);
        const output = Object.assign({}, meta || {}, {
            recoveryId: value.recoveryId,
            scriptPath: value.scriptPath,
        });
        fs.writeFileSync(value.metaPath, JSON.stringify(output), 'utf8');
        return value.metaPath;
    }

    appendAttempt(entry, attempt) {
        const meta = this.readMeta(entry);
        if (!Array.isArray(meta.attempts)) meta.attempts = [];
        const next = Object.assign({ n: meta.attempts.length + 1 }, attempt || {});
        meta.attempts.push(next);
        this.writeMeta(entry, meta);
        return next;
    }

    prune(sourcePath) {
        const directory = this._recoveryDir(sourcePath || null);
        if (!fs.existsSync(directory)) return [];
        const entries = fs.readdirSync(directory).filter(function (name) {
            return RECOVERY_ID.test(path.basename(name, path.extname(name))) && path.extname(name) === '.json';
        }).map(function (name) {
            const metaPath = path.join(directory, name);
            let createdAt = '';
            try { createdAt = JSON.parse(fs.readFileSync(metaPath, 'utf8')).createdAt || ''; } catch (error) {}
            return { id: path.basename(name, '.json'), createdAt, metaPath };
        });
        entries.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
        const removed = [];
        for (let i = this.keep; i < entries.length; i += 1) {
            const id = entries[i].id;
            ['.jsx', '.json'].forEach(function (extension) {
                try { fs.unlinkSync(path.join(directory, id + extension)); } catch (error) {
                    if (!error || error.code !== 'ENOENT') throw error;
                }
            });
            removed.push(id);
        }
        return removed;
    }
}

module.exports = { RecoveryStore, RECOVERY_ID, assertRecoveryId };
