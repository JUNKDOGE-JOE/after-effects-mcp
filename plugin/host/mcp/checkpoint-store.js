'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStatePaths } = require('../state-paths');

let lastMs = 0;

function isWindowsProjectPath(sourcePath) {
    return /^[A-Za-z]:/.test(sourcePath)
        || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(sourcePath);
}

function resolveForKey(sourcePath) {
    if (isWindowsProjectPath(sourcePath)) {
        return path.win32.normalize(sourcePath).toLowerCase();
    }
    try {
        return path.normalize(fs.realpathSync(sourcePath));
    } catch (error) {
        return path.normalize(path.resolve(sourcePath));
    }
}

function safeStem(sourcePath) {
    const basename = isWindowsProjectPath(sourcePath)
        ? path.win32.basename(path.win32.normalize(sourcePath)) : path.basename(sourcePath);
    const extension = isWindowsProjectPath(sourcePath)
        ? path.win32.extname(basename) : path.extname(basename);
    const stem = basename.slice(0, basename.length - extension.length);
    const characters = Array.from(stem).map(function (character) {
        return /[\p{L}\p{N}._\- ]/u.test(character) ? character : '_';
    }).join('').trim();
    return (characters || 'project').slice(0, 48);
}

function projectDirKey(sourcePath) {
    if (!sourcePath) return '_untitled';
    const digest = crypto.createHash('sha256').update(resolveForKey(sourcePath), 'utf8').digest('hex');
    return safeStem(sourcePath) + '_' + digest.slice(0, 12);
}

function isInside(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (relative.slice(0, 2) !== '..' && !path.isAbsolute(relative));
}

function checkpointKeep(environment) {
    const raw = environment.AE_MCP_CHECKPOINT_KEEP;
    if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw.trim())) return 50;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? Math.max(1, parsed) : 50;
}

class CheckpointStore {
    constructor(options, positionalKeep) {
        const input = typeof options === 'string'
            ? { root: options, keep: positionalKeep } : options || {};
        const environment = input.env || process.env;
        const statePaths = input.statePaths || createStatePaths({
            stateDir: input.stateDir,
            env: environment,
            home: input.home,
            homedir: input.homedir,
        });
        this.root = path.resolve(input.root || statePaths.checkpoints);
        this.references = new Map();
        this.keep = input.keep === undefined
            ? checkpointKeep(environment) : Math.max(1, Number(input.keep) || 1);
        fs.mkdirSync(this.root, { recursive: true });
    }

    dirFor(sourcePath) {
        return path.join(this.root, projectDirKey(sourcePath));
    }

    _dirFor(sourcePath) {
        return this.dirFor(sourcePath);
    }

    _canonicalSourcePath(sourcePath) {
        if (!sourcePath || !isInside(sourcePath, this.root)) return sourcePath;
        const metaPath = sourcePath.slice(0, sourcePath.length - path.extname(sourcePath).length) + '.json';
        if (!fs.existsSync(metaPath)) return sourcePath;
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            return meta.sourceProjectPath || sourcePath;
        } catch (error) {
            return sourcePath;
        }
    }

    aepPath(sourcePath, id) {
        return path.join(this._dirFor(sourcePath), id + '.aep');
    }

    aep_path(sourcePath, id) {
        return this.aepPath(sourcePath, id);
    }

    metaPath(sourcePath, id) {
        return path.join(this._dirFor(sourcePath), id + '.json');
    }

    meta_path(sourcePath, id) {
        return this.metaPath(sourcePath, id);
    }

    checkpointPath(sourcePath, id, meta) {
        if (!meta || !meta.checkpointPath) return this.aepPath(sourcePath, id);
        const file = path.normalize(meta.checkpointPath);
        const directory = path.dirname(file);
        if (!path.isAbsolute(file) || path.basename(file) !== id + '.aep'
            || path.basename(directory) !== projectDirKey(sourcePath)
            || path.basename(path.dirname(directory)) !== 'checkpoints'
            || path.basename(path.dirname(path.dirname(directory))) !== 'ae-mcp') {
            throw new Error('invalid registered checkpoint path');
        }
        return file;
    }

    retain(sourcePath, id) {
        if (!this.lookupAep(sourcePath, id)) throw new Error('checkpoint not found');
        const key = projectDirKey(this._canonicalSourcePath(sourcePath)) + '/' + id;
        this.references.set(key, (this.references.get(key) || 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const count = this.references.get(key) - 1;
            if (count > 0) this.references.set(key, count);
            else this.references.delete(key);
        };
    }

    readMeta(sourcePath, id) {
        const candidate = this.metaPath(this._canonicalSourcePath(sourcePath), id);
        if (!fs.existsSync(candidate)) return null;
        try {
            return JSON.parse(fs.readFileSync(candidate, 'utf8'));
        } catch (error) {
            return null;
        }
    }

    makeId() {
        let milliseconds = Date.now();
        if (milliseconds <= lastMs) milliseconds = lastMs + 1;
        lastMs = milliseconds;
        return String(milliseconds) + '_' + crypto.randomBytes(4).toString('hex');
    }

    make_id() {
        return this.makeId();
    }

    writeMeta(values) {
        const directory = this._dirFor(values.sourceProjectPath);
        fs.mkdirSync(directory, { recursive: true });
        const meta = {
            id: values.id,
            label: values.label,
            ts: new Date().toISOString(),
            sourceProjectPath: values.sourceProjectPath,
            activeCompId: values.activeCompId,
            currentTime: values.currentTime,
            sizeBytes: values.sizeBytes,
        };
        if (values.checkpointPath) {
            meta.checkpointPath = this.checkpointPath(values.sourceProjectPath, values.id, values);
            meta.placementSource = values.placementSource;
        }
        const output = path.join(directory, values.id + '.json');
        fs.writeFileSync(output, JSON.stringify(meta), 'utf8');
        return output;
    }

    write_meta(values) {
        return this.writeMeta(values);
    }

    list(sourcePath, options) {
        const input = typeof options === 'number' ? { limit: options } : options || {};
        const limit = input.limit === undefined ? 20 : Math.max(0, Number(input.limit) || 0);
        const canonical = this._canonicalSourcePath(sourcePath);
        const directory = this._dirFor(canonical);
        if (!fs.existsSync(directory)) return [];
        const wantKey = canonical ? resolveForKey(canonical) : null;
        const entries = [];
        const names = fs.readdirSync(directory);
        for (let i = 0; i < names.length; i += 1) {
            if (path.extname(names[i]) !== '.json') continue;
            const id = path.basename(names[i], '.json');
            const metaPath = path.join(directory, names[i]);
            let meta;
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            } catch (error) {
                continue;
            }
            if (wantKey && meta.sourceProjectPath
                && resolveForKey(meta.sourceProjectPath) !== wantKey) continue;
            let aepPath;
            try { aepPath = this.checkpointPath(canonical, id, meta); } catch (_) { continue; }
            if (!fs.existsSync(aepPath)) {
                try { fs.unlinkSync(metaPath); } catch (_) {}
                continue;
            }
            entries.push(meta);
        }
        entries.sort(function (a, b) {
            return String(b.ts || '').localeCompare(String(a.ts || '')) || String(b.id).localeCompare(String(a.id));
        });
        return entries.slice(0, limit);
    }

    listCheckpoints(sourcePath, options) {
        return this.list(sourcePath, options);
    }

    list_checkpoints(sourcePath, options) {
        return this.list(sourcePath, options);
    }

    lookupAep(sourcePath, id) {
        const canonical = this._canonicalSourcePath(sourcePath);
        const candidate = this.checkpointPath(canonical, id, this.readMeta(canonical, id));
        return fs.existsSync(candidate) ? candidate : null;
    }

    lookup_aep(sourcePath, id) {
        return this.lookupAep(sourcePath, id);
    }

    latest(sourcePath) {
        const entries = this.list(sourcePath, { limit: 1 });
        return entries.length ? entries[0] : null;
    }

    remove(sourcePath, id) {
        const canonical = this._canonicalSourcePath(sourcePath);
        if (this.references.has(projectDirKey(canonical) + '/' + id)) return false;
        const meta = this.readMeta(canonical, id);
        if (meta && meta.sourceProjectPath && resolveForKey(meta.sourceProjectPath) !== resolveForKey(canonical)) return false;
        const files = [this.checkpointPath(canonical, id, meta), this.metaPath(canonical, id)];
        let removed = false;
        files.forEach(function (candidate) {
            try {
                fs.unlinkSync(candidate);
                removed = true;
            } catch (error) {
                if (!error || error.code !== 'ENOENT') throw error;
            }
        });
        return removed;
    }

    prune(sourcePath) {
        const canonical = this._canonicalSourcePath(sourcePath);
        const entries = this.list(canonical, { limit: 10000 });
        const removed = [];
        for (let i = this.keep; i < entries.length; i += 1) {
            if (this.remove(canonical, entries[i].id)) removed.push(entries[i].id);
        }
        return removed;
    }
}

module.exports = {
    CheckpointStore,
    isWindowsProjectPath,
    resolveForKey,
    projectDirKey,
};
