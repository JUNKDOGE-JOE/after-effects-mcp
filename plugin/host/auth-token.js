// Shared-secret auth for /exec. The token lives at a per-user, cross-platform
// state path (default ~/.ae-mcp/auth-token) so the panel and host-side clients agree
// without any handshake. Loopback binding limits reach to local
// processes; the token defeats the "any local process can call /exec" threat.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStatePaths } = require('./state-paths');

function resolvePaths(options) {
    return options && options.statePaths
        ? options.statePaths : createStatePaths(options);
}

function tokenDir(options) {
    return resolvePaths(options).stateDir;
}

function tokenPath(options) {
    return resolvePaths(options).authToken;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function writeToken(token, options) {
    var paths = resolvePaths(options);
    var dir = paths.stateDir;
    var file = paths.authToken;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    var tmp = path.join(dir, 'auth-token.' + process.pid + '.' + Date.now() + '.tmp');
    fs.writeFileSync(tmp, token, 'utf8');
    try {
        // POSIX: restrict to owner read/write. No-op effect on Windows.
        fs.chmodSync(tmp, 0o600);
    } catch (e) {
        // chmod can fail on some filesystems; the token is still written.
    }
    fs.renameSync(tmp, file);
    return token;
}

// Ensure the token file exists, generating a fresh 32-byte hex secret if not.
// Best-effort 0600 perms on POSIX; on Windows the chmod is a no-op so we just
// write the file. Returns the token string.
function ensureToken(options) {
    var paths = resolvePaths(options);
    var dir = paths.stateDir;
    var file = paths.authToken;
    if (fs.existsSync(file)) {
        var existing = fs.readFileSync(file, 'utf8').trim();
        if (existing.length > 0) {
            return existing;
        }
        // Empty/corrupt file: fall through and regenerate.
    }
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return writeToken(generateToken(), { statePaths: paths });
}

function regenerate(options) {
    return writeToken(generateToken(), options);
}

// Constant-time comparison that first guards against length mismatch (which
// timingSafeEqual would otherwise throw on for unequal-length buffers).
function tokenMatches(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') {
        return false;
    }
    var a = Buffer.from(provided, 'utf8');
    var b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

module.exports = {
    HEADER: 'x-ae-mcp-token',
    tokenDir: tokenDir,
    tokenPath: tokenPath,
    ensureToken: ensureToken,
    regenerate: regenerate,
    tokenMatches: tokenMatches,
};
