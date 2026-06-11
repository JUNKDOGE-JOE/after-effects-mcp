// Shared-secret auth for /exec. The token lives at a per-user, cross-platform
// path (~/.ae-mcp/auth-token) so the Node host (panel) and the Python bridge
// agree without any handshake. Loopback binding limits reach to local
// processes; the token defeats the "any local process can call /exec" threat.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ~/.ae-mcp/auth-token — must match the path used by the Python bridge.
function tokenDir() {
    return path.join(os.homedir(), '.ae-mcp');
}

function tokenPath() {
    return path.join(tokenDir(), 'auth-token');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function writeToken(token) {
    var dir = tokenDir();
    var file = tokenPath();
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
function ensureToken() {
    var dir = tokenDir();
    var file = tokenPath();
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
    return writeToken(generateToken());
}

function regenerate() {
    return writeToken(generateToken());
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
