const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hostLog = require('./host-log');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-log-'));
}

test('keeps a 2000-entry memory ring and appends by local day', () => {
    const dir = tempDir();
    try {
        const now = new Date(2026, 7, 19, 12, 0, 0);
        hostLog.init({ dir, now: () => now });
        for (let i = 0; i < 2001; i += 1) hostLog.record({ source: 'host', message: 'line-' + i });
        assert.equal(hostLog.tail(1)[0].message, 'line-2000');
        assert.equal(hostLog.stats().memoryCount, 2000);
        const file = path.join(dir, 'host-2026-08-19.jsonl');
        assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2001);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cleans host, server, and export files older than 14 days', () => {
    const dir = tempDir();
    try {
        for (const name of [
            'host-2026-08-01.jsonl',
            'server-2026-08-01.log',
            'export-2026-08-01T00-00-00-000Z.txt',
            'host-2026-08-10.jsonl',
        ]) fs.writeFileSync(path.join(dir, name), 'old');
        hostLog.init({ dir, now: () => new Date(2026, 7, 19, 12, 0, 0) });
        assert.equal(fs.existsSync(path.join(dir, 'host-2026-08-01.jsonl')), false);
        assert.equal(fs.existsSync(path.join(dir, 'server-2026-08-01.log')), false);
        assert.equal(fs.existsSync(path.join(dir, 'export-2026-08-01T00-00-00-000Z.txt')), false);
        assert.equal(fs.existsSync(path.join(dir, 'host-2026-08-10.jsonl')), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('captures console calls, preserves passthrough, and subscribes to activity', () => {
    const dir = tempDir();
    try {
        hostLog.init({ dir, now: () => new Date(2026, 7, 19) });
        const calls = [];
        const fakeConsole = { log: (...args) => calls.push(args.join(' ')), info() {}, warn() {}, error() {} };
        const restore = hostLog.captureConsole(fakeConsole);
        fakeConsole.log('hello', { ok: true });
        restore();
        assert.equal(calls[0], 'hello [object Object]');
        assert.equal(hostLog.tail(1)[0].source, 'console');

        let callback;
        const unsubscribe = hostLog.subscribeActivity({ subscribe(fn) { callback = fn; return () => { callback = null; }; } });
        callback({ id: 7, ts: 1234, client: 'test', ok: false, error: 'boom' });
        assert.equal(hostLog.tail(1)[0].source, 'activity');
        assert.equal(hostLog.tail(1)[0].level, 'warn');
        assert.equal(hostLog.tail(1)[0].activityId, 7);
        assert.equal(hostLog.tail(1)[0].activityTs, 1234);
        unsubscribe();
        assert.equal(callback, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('swallows append failures and counts them', () => {
    const failingFs = {
        existsSync: () => true,
        readdirSync: () => [],
        appendFileSync: () => { throw new Error('disk full'); },
    };
    assert.doesNotThrow(() => {
        hostLog.init({ dir: 'ignored', fsImpl: failingFs, now: () => new Date(2026, 7, 19) });
        hostLog.record({ source: 'host', message: 'still available' });
    });
    assert.equal(hostLog.stats().writeErrors, 1);
});

test('reads the last lines across today and yesterday after a reload', () => {
    const dir = tempDir();
    try {
        hostLog.init({ dir, now: () => new Date(2026, 7, 18, 23, 59, 0) });
        hostLog.record({ source: 'panel', message: 'before reload' });
        hostLog.init({ dir, now: () => new Date(2026, 7, 19, 0, 1, 0) });
        hostLog.record({ source: 'activity', message: 'after reload' });
        const events = hostLog.readFileTail({ days: 2, lines: 500 });
        assert.deepEqual(events.map((event) => event.message), ['before reload', 'after reload']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
