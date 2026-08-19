// Persistent, best-effort diagnostics log for the CEP host process.
// CEP 11 runs Node 15, so keep this CommonJS file dependency-free and avoid
// node:-prefixed builtins.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_MEMORY = 2000;
const RETENTION_DAYS = 14;
const DATE_MS = 24 * 60 * 60 * 1000;

let fileSystem = fs;
let logDir = null;
let nowImpl = () => new Date();
let initialized = false;
let entries = [];
let sequence = 0;
let writeErrors = 0;

function asDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function currentDate() {
    return asDate(nowImpl());
}

function dateKey(value) {
    const date = asDate(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
}

function dateFromKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function hostFile(date) {
    return path.join(logDir, 'host-' + dateKey(date) + '.jsonl');
}

function tryWrite(event) {
    if (!initialized || !logDir) return;
    try {
        fileSystem.appendFileSync(hostFile(event.ts), JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
        // Diagnostics must never become the reason the host request failed.
        writeErrors += 1;
    }
}

function cleanupOldFiles(now) {
    if (!logDir || !fileSystem.readdirSync) return;
    const cutoff = new Date(asDate(now).getTime() - RETENTION_DAYS * DATE_MS);
    let names;
    try {
        names = fileSystem.readdirSync(logDir);
    } catch (error) {
        return;
    }
    for (const name of names) {
        const text = String(name);
        const match = /^(?:host|server)-(\d{4}-\d{2}-\d{2})\.(?:jsonl|log)$/.exec(text)
            || /^export-(\d{4}-\d{2}-\d{2})[T-].*\.txt$/.exec(text);
        if (!match) continue;
        const fileDate = dateFromKey(match[1]);
        if (!fileDate || fileDate >= cutoff) continue;
        try {
            fileSystem.unlinkSync(path.join(logDir, text));
        } catch (error) {
            // Retention is best effort for the same reason writes are.
        }
    }
}

function init(options = {}) {
    fileSystem = options.fsImpl || fs;
    nowImpl = typeof options.now === 'function' ? options.now : () => new Date();
    logDir = options.dir || process.env.AE_MCP_LOG_DIR || path.join(os.homedir(), '.ae-mcp', 'logs');
    entries = [];
    sequence = 0;
    writeErrors = 0;
    initialized = true;
    try {
        if (!fileSystem.existsSync(logDir)) fileSystem.mkdirSync(logDir, { recursive: true });
        cleanupOldFiles(currentDate());
    } catch (error) {
        // Keep the in-memory logger usable when the directory is unavailable.
    }
    return stats();
}

function record(fields = {}) {
    const date = currentDate();
    const message = fields.message === undefined ? '' : String(fields.message);
    const event = Object.assign({}, fields, {
        id: ++sequence,
        ts: date.toISOString(),
        pid: process.pid,
        level: ['debug', 'info', 'warn', 'error'].includes(fields.level) ? fields.level : 'info',
        source: fields.source ? String(fields.source) : 'host',
        message,
    });
    entries.push(event);
    if (entries.length > MAX_MEMORY) entries = entries.slice(-MAX_MEMORY);
    tryWrite(event);
    return event;
}

function list(options = {}) {
    if (typeof options === 'number' || typeof options === 'string') options = { since: options };
    let since = options.since instanceof Date ? options.since.getTime() : Number(options.since || 0);
    if (!Number.isFinite(since) && typeof options.since === 'string') since = Date.parse(options.since);
    let result = entries.slice();
    if (Number.isFinite(since) && since > 0) {
        result = since > 100000000000
            ? result.filter((event) => Date.parse(event.ts) > since)
            : result.filter((event) => event.id > since);
    }
    if (Number.isFinite(options.limit) && options.limit >= 0) result = result.slice(-Math.floor(options.limit));
    return result;
}

function tail(n = 200) {
    const count = Math.max(0, Number(n) || 0);
    return entries.slice(-count);
}

function readFileTail(options = {}) {
    const days = Math.max(1, Math.min(14, Math.floor(Number(options.days) || 2)));
    const lines = Math.max(0, Math.floor(Number(options.lines) || 500));
    const end = currentDate();
    const result = [];
    if (!logDir || !fileSystem.readFileSync) return result;
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(end.getTime());
        date.setDate(date.getDate() - offset);
        const file = hostFile(date);
        let text;
        try {
            text = fileSystem.readFileSync(file, 'utf8');
        } catch (error) {
            continue;
        }
        for (const line of String(text).split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);
                if (event && typeof event === 'object') result.push(event);
            } catch (error) {
                // A partially written line must not hide the rest of the tail.
            }
        }
    }
    return lines ? result.slice(-lines) : [];
}

function formatConsoleArg(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (error) { return String(value); }
}

function captureConsole(consoleObj) {
    const target = consoleObj || console;
    const originals = {};
    for (const level of ['log', 'info', 'warn', 'error']) {
        if (typeof target[level] !== 'function') continue;
        originals[level] = target[level];
        target[level] = function capturedConsoleMethod() {
            record({
                level: level === 'log' ? 'info' : level,
                source: 'console',
                message: Array.prototype.map.call(arguments, formatConsoleArg).join(' '),
            });
            return originals[level].apply(this, arguments);
        };
    }
    return () => {
        for (const level of Object.keys(originals)) target[level] = originals[level];
    };
}

function subscribeActivity(activity) {
    if (!activity || typeof activity.subscribe !== 'function') return () => {};
    return activity.subscribe((event) => {
        record(Object.assign({
            source: 'activity',
            level: event && event.ok === false ? 'warn' : 'info',
        }, event || {}, {
            activityId: event && event.id,
            activityTs: event && event.ts,
        }));
    });
}

function stats() {
    return {
        dir: logDir,
        initialized,
        memoryCount: entries.length,
        maxMemory: MAX_MEMORY,
        writeErrors,
        pid: process.pid,
        nodeVersion: process.version,
    };
}

function _reset() {
    fileSystem = fs;
    logDir = null;
    nowImpl = () => new Date();
    initialized = false;
    entries = [];
    sequence = 0;
    writeErrors = 0;
}

module.exports = {
    init,
    record,
    list,
    tail,
    readFileTail,
    stats,
    captureConsole,
    subscribeActivity,
    _reset,
    MAX_MEMORY,
};
