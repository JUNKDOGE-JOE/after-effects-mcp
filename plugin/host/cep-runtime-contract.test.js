'use strict';

// Contract tests for code that executes inside CEP's embedded engines on
// AE 2023/2024 (CEP 11: Node 15.x / V8 8.8). Two failure classes:
//   1. `node:`-prefixed specifiers do not RESOLVE there (load-time failure) —
//      banned outright in every CEP-executed file.
//   2. Missing runtime APIs (Object.hasOwn, Array.prototype.at, ...) — closed
//      by cep-runtime-compat.js, which server.js must load before anything
//      else and the panel bundle injects at build time.
// The manifest is explicit rather than a directory glob: plugin/host also
// holds *.test.js files that legitimately use node: prefixes under dev Node,
// and a name-based exclusion would let a future CEP-loaded file slip through.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Every file the CEP host process loads (server.js entry + its transitive
// requires). A new require in server.js or its children MUST be added here.
const CEP_EXECUTED_FILES = [
    'cep-runtime-compat.js',
    'server.js',
    'jsx-bridge.js',
    'auth-token.js',
    'activity.js',
    'host-log.js',
    'native-aegp-client.js',
    'mcp/index.js',
    'mcp/jsonrpc.js',
    'mcp/session.js',
    'mcp/client-blocklist.js',
    'mcp/sse.js',
    'mcp/conversations.js',
    'mcp/approvals.js',
    'mcp/annotations.js',
    'mcp/approval-gate.js',
    'mcp/canonical-json.js',
    'mcp/checkpoint-store.js',
    'mcp/checkpoint-ops.js',
    'mcp/instructions.js',
    'mcp/json-schema-lite.js',
    'mcp/native-program.js',
    'mcp/error-hints.js',
    'mcp/jsx-result.js',
    'mcp/template.js',
    'mcp/tool-library.js',
    'mcp/tools.js',
    'mcp/tool-result.js',
    // One file per /mcp tool (see mcp/tools.js). Every new tool module must be
    // listed here so the node:-specifier and require-graph guards cover it.
    'mcp/tools/status.js',
    'mcp/tools/exec.js',
    'mcp/tools/preview-frame.js',
    'mcp/png.js',
    'mcp/tools/read.js',
    'mcp/tools/checkpoint.js',
    'mcp/tools/revert.js',
    'mcp/tools/validate-expressions.js',
    'mcp/tools/native-exec.js',
    'mcp/tools/tool-search.js',
    'mcp/tools/tool-use.js',
    'mcp/tools/skill-use.js',
    // Generated twins the host requires at runtime. They live under plugin/host because
    // only plugin/ ships to the CEP extension directory (native/ does not).
    'mcp/generated/native_exec.generated.json',
    'mcp/generated/aegp-rpc.schema.json',
    // Bundled Tool Library skills are runtime data loaded through fs, not
    // require(). Keep them explicit so CEP payload changes remain audited.
    'mcp/skills_bundled/ae-execution-guide.json',
    'mcp/skills_bundled/ease-and-timing.json',
    'mcp/skills_bundled/extendscript-cookbook.json',
    'mcp/skills_bundled/glow-recipes.json',
    'mcp/skills_bundled/grade-stack.json',
    'mcp/skills_bundled/kinetic-typography.json',
    'mcp/skills_bundled/manifest.json',
    'mcp/skills_bundled/project-organization.json',
    'mcp/skills_bundled/render-order.json',
];

// require('node:x'), require( `node:x` ), import('node:x'), from 'node:x',
// and process.getBuiltinModule('node:x') — any quote style, any whitespace.
const NODE_SPECIFIER = /(?:require|import|getBuiltinModule)\s*\(\s*['"`]node:|from\s*['"`]node:/;

// Scan executable code only: a `node:` mention inside a comment is not an
// import (the original single-file guard false-matched on comment text). Strip
// block and line comments before testing. String literals are kept — the
// specifier we ban lives inside one (require('node:fs')).
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
}

function read(name) {
    return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function readCode(name) {
    return stripComments(read(name));
}

test('every CEP-executed host file avoids node:-prefixed specifiers', () => {
    for (const name of CEP_EXECUTED_FILES) {
        assert.doesNotMatch(readCode(name), NODE_SPECIFIER, name);
    }
});

test('the CEP manifest stays in sync with what the host actually requires', () => {
    // Fail closed when a new local require appears in a CEP-executed file
    // without being added to the manifest above.
    const local = /require\s*\(\s*['"`](\.\.?\/[\w/.-]+?)(?:\.js)?['"`]\s*\)/g;
    const known = new Set(CEP_EXECUTED_FILES);
    for (const name of CEP_EXECUTED_FILES) {
        const source = readCode(name);
        for (const match of source.matchAll(local)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
            if (target === 'package' || target === 'package.json') continue;
            // The deployed extension contains plugin/ only: a require that escapes
            // plugin/host (for example into native/) loads in the repo and dies on the
            // real machine (2026-08-20 batch-2 live acceptance: the host never started).
            assert.ok(
                !target.startsWith('..'),
                `${name} requires ${match[1]} which resolves outside plugin/host`,
            );
            const candidates = [target + '.js', target + '/index.js', target];
            assert.ok(
                candidates.some((candidate) => known.has(candidate)),
                `${name} requires ${match[1]} which is missing from CEP_EXECUTED_FILES`,
            );
        }
    }
});

test('server.js loads the CEP runtime polyfills before any other module', () => {
    const source = read('server.js');
    const compat = source.indexOf("require('./cep-runtime-compat')");
    assert.ok(compat >= 0, 'server.js must require ./cep-runtime-compat');
    const firstOtherRequire = source.search(/require\(\s*['"](?!\.\/cep-runtime-compat)/);
    assert.ok(
        firstOtherRequire === -1 || compat < firstOtherRequire,
        'cep-runtime-compat must be the first require in server.js',
    );
});

test('the polyfill shim stays legal on the oldest CEP runtime', () => {
    const source = readCode('cep-runtime-compat.js');
    assert.doesNotMatch(source, NODE_SPECIFIER);
    // The shim cannot rely on the APIs it exists to provide.
    assert.doesNotMatch(source, /Object\.hasOwn\s*\(/);
    assert.doesNotMatch(source, /\.at\s*\(/);
});
