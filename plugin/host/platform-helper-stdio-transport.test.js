const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
    createPlatformHelperStdioTransport,
} = require('./platform-helper-stdio-transport');

function fakeChild() {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.writes = [];
    child.stdin.write = function (value) {
        child.stdin.writes.push(value);
        return true;
    };
    child.stdin.end = function () {
        child.stdin.writable = false;
        child.stdin.emit('finish');
    };
    return child;
}

test('stdio transport spawns only the verified Helper broker with private pipes', async () => {
    const child = fakeChild();
    const calls = [];
    const transport = createPlatformHelperStdioTransport({
        helperPath: '/verified/ae-mcp-platform-helper',
        spawnImpl: function (file, args, options) {
            calls.push({ file, args, options });
            return child;
        },
    });

    const response = transport.request('{"protocolVersion":1,"id":1,"method":"capabilities","params":{}}');
    assert.deepEqual(calls, [{
        file: '/verified/ae-mcp-platform-helper',
        args: ['--client-stdio'],
        options: {
            windowsHide: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    }]);
    assert.deepEqual(child.stdin.writes, [
        '{"protocolVersion":1,"id":1,"method":"capabilities","params":{}}\n',
    ]);
    child.stdout.emit('data', Buffer.from('{"protocolVersion":1,"id":1,"ok":true,"result":{}}\n'));
    assert.equal(
        await response,
        '{"protocolVersion":1,"id":1,"ok":true,"result":{}}',
    );
    await transport.close();
    assert.equal(child.stdin.writable, false);
});

test('stdio transport preserves FIFO framing across concurrent requests', async () => {
    const child = fakeChild();
    const transport = createPlatformHelperStdioTransport({
        helperPath: '/verified/ae-mcp-platform-helper',
        spawnImpl: function () { return child; },
    });

    const first = transport.request('one');
    const second = transport.request('two');
    child.stdout.emit('data', Buffer.from('first\nsec'));
    child.stdout.emit('data', Buffer.from('ond\n'));

    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(child.stdin.writes, ['one\n', 'two\n']);
    await transport.close();
});

test('stdio transport fails closed on oversized output and rejects every pending request', async () => {
    const child = fakeChild();
    const transport = createPlatformHelperStdioTransport({
        helperPath: '/verified/ae-mcp-platform-helper',
        maxMessageBytes: 8,
        spawnImpl: function () { return child; },
    });
    const first = transport.request('one');
    const second = transport.request('two');
    child.stdout.emit('data', Buffer.from('123456789'));

    await assert.rejects(first, { code: 'HELPER_UNAVAILABLE', retryable: true });
    await assert.rejects(second, { code: 'HELPER_UNAVAILABLE', retryable: true });
    await transport.close();
});

test('stdio transport classifies spawn and premature-exit failures without stderr leakage', async () => {
    const spawnFailure = createPlatformHelperStdioTransport({
        helperPath: '/verified/ae-mcp-platform-helper',
        spawnImpl: function () { throw new Error('/private/path secret detail'); },
    });
    await assert.rejects(spawnFailure.request('{}'), function (error) {
        assert.equal(error.code, 'HELPER_START_FAILED');
        assert.equal(error.retryable, true);
        assert.equal(error.message.includes('/private/path'), false);
        return true;
    });

    const child = fakeChild();
    const exited = createPlatformHelperStdioTransport({
        helperPath: '/verified/ae-mcp-platform-helper',
        spawnImpl: function () { return child; },
    });
    const request = exited.request('{}');
    child.stderr.emit('data', Buffer.from('credential-shaped private detail'));
    child.emit('exit', 78, null);
    await assert.rejects(request, function (error) {
        assert.equal(error.code, 'HELPER_START_FAILED');
        assert.equal(error.message.includes('credential-shaped'), false);
        return true;
    });
    await exited.close();
});

test('stdio transport rejects newline requests before writing to the broker', async () => {
    const child = fakeChild();
    const transport = createPlatformHelperStdioTransport({
        helperPath: '/verified/ae-mcp-platform-helper',
        spawnImpl: function () { return child; },
    });
    await assert.rejects(transport.request('one\ntwo'), {
        code: 'HELPER_UNAVAILABLE',
        retryable: true,
    });
    assert.deepEqual(child.stdin.writes, []);
    await transport.close();
});
