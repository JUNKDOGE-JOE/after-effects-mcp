'use strict';

const MAX_MESSAGE_BYTES = 65536;

function helperError(code, message, retryable, cause) {
    const error = new Error(message);
    error.code = code;
    error.retryable = Boolean(retryable);
    if (cause !== undefined) error.cause = cause;
    return error;
}

function unavailable(message, cause) {
    return helperError('HELPER_UNAVAILABLE', message, true, cause);
}

function startFailed(cause) {
    return helperError(
        'HELPER_START_FAILED',
        'platform helper broker could not be started',
        true,
        cause,
    );
}

function createPlatformHelperStdioTransport(options) {
    const input = options || {};
    if (typeof input.helperPath !== 'string' || input.helperPath.length === 0) {
        throw new TypeError('helperPath must be a non-empty string');
    }
    const maxMessageBytes = input.maxMessageBytes === undefined
        ? MAX_MESSAGE_BYTES
        : input.maxMessageBytes;
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
        throw new TypeError('maxMessageBytes must be a positive safe integer');
    }
    const spawnImpl = input.spawnImpl
        || function (file, args, spawnOptions) {
            return require('child_process').spawn(file, args, spawnOptions);
        };

    let child = null;
    let startupError = null;
    let terminalError = null;
    let closed = false;
    let stdoutBuffer = Buffer.alloc(0);
    const pending = [];

    function rejectPending(error) {
        while (pending.length > 0) pending.shift().reject(error);
    }

    function fail(error) {
        if (terminalError || closed) return;
        terminalError = error;
        rejectPending(error);
    }

    try {
        child = spawnImpl(input.helperPath, ['--client-stdio'], {
            windowsHide: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!child
            || !child.stdin
            || typeof child.stdin.write !== 'function'
            || typeof child.stdin.end !== 'function'
            || !child.stdout
            || typeof child.stdout.on !== 'function'
            || !child.stderr
            || typeof child.stderr.on !== 'function'
            || typeof child.on !== 'function') {
            throw new TypeError('platform helper broker process is invalid');
        }
    } catch (cause) {
        startupError = startFailed(cause);
    }

    if (child) {
        child.stdout.on('data', function (chunk) {
            if (terminalError || closed) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
            if (stdoutBuffer.length > maxMessageBytes && stdoutBuffer.indexOf(0x0a) === -1) {
                fail(unavailable('platform helper broker returned an oversized response'));
                return;
            }
            let newline = stdoutBuffer.indexOf(0x0a);
            while (newline !== -1 && !terminalError) {
                let frame = stdoutBuffer.subarray(0, newline);
                stdoutBuffer = stdoutBuffer.subarray(newline + 1);
                if (frame.length > 0 && frame[frame.length - 1] === 0x0d) {
                    frame = frame.subarray(0, frame.length - 1);
                }
                if (frame.length === 0 || frame.length > maxMessageBytes || pending.length === 0) {
                    fail(unavailable('platform helper broker returned an invalid response'));
                    return;
                }
                pending.shift().resolve(frame.toString('utf8'));
                newline = stdoutBuffer.indexOf(0x0a);
            }
            if (stdoutBuffer.length > maxMessageBytes) {
                fail(unavailable('platform helper broker returned an oversized response'));
            }
        });
        child.stdout.on('error', function (cause) {
            fail(unavailable('platform helper broker output failed', cause));
        });
        child.stderr.on('data', function () {
            // Deliberately discard bounded public diagnostics. Native stderr may
            // contain local paths and never crosses the host error boundary.
        });
        child.stderr.on('error', function () {});
        child.stdin.on('error', function (cause) {
            fail(unavailable('platform helper broker input failed', cause));
        });
        child.on('error', function (cause) {
            fail(startFailed(cause));
        });
        child.on('exit', function () {
            if (!closed) fail(startFailed());
        });
    }

    return Object.freeze({
        request: function (jsonUtf8) {
            if (closed) {
                return Promise.reject(unavailable('platform helper broker transport is closed'));
            }
            if (startupError) return Promise.reject(startupError);
            if (terminalError) return Promise.reject(terminalError);
            if (typeof jsonUtf8 !== 'string'
                || jsonUtf8.length === 0
                || jsonUtf8.includes('\n')
                || jsonUtf8.includes('\r')
                || Buffer.byteLength(jsonUtf8, 'utf8') > maxMessageBytes) {
                return Promise.reject(unavailable('platform helper request is invalid'));
            }
            return new Promise(function (resolve, reject) {
                pending.push({ resolve, reject });
                try {
                    child.stdin.write(jsonUtf8 + '\n');
                } catch (cause) {
                    fail(unavailable('platform helper broker input failed', cause));
                }
            });
        },
        close: function () {
            if (closed) return Promise.resolve();
            closed = true;
            rejectPending(unavailable('platform helper broker transport is closed'));
            if (child && child.stdin && child.stdin.writable !== false) {
                try { child.stdin.end(); } catch (_) {}
            }
            return Promise.resolve();
        },
    });
}

module.exports = { createPlatformHelperStdioTransport };
