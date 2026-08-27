'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    CANDIDATE_TTL_MS,
    candidateGuidance,
    captureSuccessfulScript,
    pruneCandidates,
} = require('./candidate-artifacts');
const { ToolLibrary, computeContentHash } = require('./tool-library');

function fixture(t, initialNow) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-candidates-'));
    let current = initialNow === undefined ? 1000 : initialNow;
    t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
    return {
        library: new ToolLibrary({
            toolRoot: path.join(root, 'tools'),
            skillRoot: path.join(root, 'skills'),
            bundledRoot: path.join(__dirname, 'skills_bundled'),
            now: function () { return current; },
        }),
        setNow: function (value) { current = value; },
    };
}

function context(conversationId) {
    return { session: { clientName: 'candidate-test', conversationId } };
}

function candidate(index, updatedAt, conversationId, overrides) {
    const suffix = index.toString(16).padStart(12, '0');
    const content = 'candidate-code-' + index;
    const value = {
        schemaVersion: 1,
        id: 'user:00000000-0000-4000-8000-' + suffix,
        name: 'Candidate ' + index,
        description: 'Captured from a successful MCP exec call.',
        kind: 'jsx',
        category: 'workflow',
        tags: [],
        compatibility: {},
        declaredRisk: 'write',
        source: {
            type: 'chat-tool-call',
            ref: 'ae_exec',
            client: 'candidate-test',
            productVersion: null,
            provenance: { capturedAt: updatedAt, conversationId, tool: 'ae_exec' },
        },
        status: 'candidate',
        verified: false,
        verification: null,
        content,
        argsSchema: {},
        revision: 1,
        createdAt: updatedAt,
        updatedAt,
        lastUsedAt: null,
    };
    Object.assign(value, overrides || {});
    value.contentHash = computeContentHash(value.kind, value.content, value.argsSchema);
    return value;
}

test('successful scripts capture the artifact contract and all name inference branches', (t) => {
    const f = fixture(t);
    const deps = { getToolLibrary: function () { return f.library; } };
    const undoId = captureSuccessfulScript(
        'app.project.activeItem;',
        { undo_group_name: 'Build title' },
        context('conversation-a'),
        deps,
        'ae_exec',
    );
    const undo = f.library.getArtifact(undoId);
    assert.equal(undo.name, 'Build title');
    assert.equal(undo.description, 'Captured from a successful MCP exec call.');
    assert.equal(undo.status, 'candidate');
    assert.equal(undo.verified, false);
    assert.equal(undo.verification, null);
    assert.deepEqual(undo.argsSchema, {});
    assert.equal(undo.category, 'workflow');
    assert.deepEqual(undo.tags, []);
    assert.deepEqual(undo.compatibility, {});
    assert.equal(undo.declaredRisk, 'write');
    assert.equal(undo.content, 'app.project.activeItem;');
    assert.equal(undo.source.type, 'chat-tool-call');
    assert.equal(undo.source.client, 'candidate-test');
    assert.deepEqual(undo.source.provenance, {
        capturedAt: 1000,
        conversationId: 'conversation-a',
        tool: 'ae_exec',
    });

    const longLine = 'x'.repeat(70);
    const lineId = captureSuccessfulScript('\n   \n  ' + longLine + '\nsecond;', {}, context('conversation-a'), deps, 'ae_exec');
    assert.equal(f.library.getArtifact(lineId).name, 'x'.repeat(60));

    const blankCode = '\n  \r\n';
    const blankId = captureSuccessfulScript(blankCode, {}, context('conversation-a'), deps, 'ae_exec');
    const hash = crypto.createHash('sha256').update(blankCode, 'utf8').digest('hex');
    assert.equal(f.library.getArtifact(blankId).name, 'ae_exec ' + hash.slice(0, 8));
});

test('content hash deduplication only touches updatedAt and reuses the artifact id', (t) => {
    const f = fixture(t, 1000);
    const deps = { getToolLibrary: function () { return f.library; } };
    const firstId = captureSuccessfulScript('same-code', { undo_group_name: 'Original' },
        context('conversation-a'), deps, 'ae_exec');
    const before = f.library.getArtifact(firstId);
    f.setNow(2000);
    const secondId = captureSuccessfulScript('same-code', { undo_group_name: 'Replacement' },
        context('conversation-b'), deps, 'ae_execRecover');
    const after = f.library.getArtifact(secondId);
    assert.equal(secondId, firstId);
    assert.equal(f.library.list({ statuses: ['candidate'] }).length, 1);
    assert.deepEqual(Object.assign({}, after, { updatedAt: before.updatedAt }), before);
    assert.equal(after.updatedAt, 2000);
});

test('saved and pinned content is reused without creating or touching a candidate', (t) => {
    const f = fixture(t, 2000);
    const deps = { getToolLibrary: function () { return f.library; } };
    ['saved', 'pinned'].forEach(function (status, index) {
        const persisted = candidate(40 + index, 1000 + index, 'conversation-a', { status });
        f.library.saveArtifact(persisted);
        const before = f.library.getArtifact(persisted.id);
        const artifactId = captureSuccessfulScript(
            persisted.content,
            {},
            context('conversation-b'),
            deps,
            'ae_exec',
        );
        assert.equal(artifactId, persisted.id);
        assert.deepEqual(f.library.getArtifact(artifactId), before);
    });
    assert.equal(f.library.list({ statuses: ['candidate'] }).length, 0);
});

test('capture failures are silent', (t) => {
    const f = fixture(t);
    assert.equal(captureSuccessfulScript('code', {}, context('conversation'), {
        getToolLibrary: function () { throw new Error('unavailable'); },
    }, 'ae_exec'), null);
    assert.equal(f.library.list({ statuses: ['candidate'] }).length, 0);
});

test('candidate pruning enforces TTL without touching saved or pinned artifacts', (t) => {
    const f = fixture(t);
    const oldCandidate = candidate(1, 0, 'conversation');
    const saved = candidate(2, 0, 'conversation', { status: 'saved' });
    const pinned = candidate(3, 0, 'conversation', { status: 'pinned' });
    [oldCandidate, saved, pinned].forEach(function (artifact) { f.library.saveArtifact(artifact); });
    pruneCandidates(f.library, CANDIDATE_TTL_MS + 1);
    assert.throws(function () { f.library.getArtifact(oldCandidate.id); }, /tool not found/);
    assert.equal(f.library.getArtifact(saved.id).status, 'saved');
    assert.equal(f.library.getArtifact(pinned.id).status, 'pinned');
});

test('candidate pruning retains the newest 20 entries per conversation', (t) => {
    const f = fixture(t);
    for (let i = 1; i <= 21; i += 1) f.library.saveArtifact(candidate(i, i, 'conversation-a'));
    const other = candidate(30, 30, 'conversation-b');
    f.library.saveArtifact(other);
    pruneCandidates(f.library, 31);
    const ids = f.library.list({ statuses: ['candidate'] }).map(function (item) { return item.id; });
    assert.equal(ids.length, 21);
    assert.equal(ids.includes(candidate(1, 1, 'conversation-a').id), false);
    assert.equal(ids.includes(other.id), true);
});

test('candidate pruning retains the newest 200 entries globally', (t) => {
    const f = fixture(t);
    for (let i = 1; i <= 201; i += 1) f.library.saveArtifact(candidate(i, i, null));
    pruneCandidates(f.library, 202);
    const ids = f.library.list({ statuses: ['candidate'] }).map(function (item) { return item.id; });
    assert.equal(ids.length, 200);
    assert.equal(ids.includes(candidate(1, 1, null).id), false);
});

test('placeholder guidance prefers the current conversation, falls back globally, and preserves empty text', (t) => {
    const f = fixture(t);
    for (let i = 1; i <= 6; i += 1) f.library.saveArtifact(candidate(i, i, 'current'));
    const other = candidate(20, 20, 'other');
    f.library.saveArtifact(other);
    const deps = { getToolLibrary: function () { return f.library; } };
    const local = candidateGuidance('base error', context('current'), deps);
    assert.match(local, /Recent successful scripts you can rerun:/);
    assert.match(local, /artifactId=user:/);
    assert.match(local, /chars=16/);
    assert.match(local, /capturedAt=1970-01-01T00:00:00\.00[2-6]Z/);
    assert.match(local, /content="candidate-code-/);
    assert.match(local, /Rerun one verbatim with ae_toolUse \{"name":"<artifactId>"\}\./);
    assert.equal(local.includes(other.id), false);
    assert.equal(local.includes(candidate(1, 1, 'current').id), false);

    const global = candidateGuidance('base error', context('missing'), deps);
    assert.equal(global.includes(other.id), true);
    const empty = fixture(t);
    assert.equal(candidateGuidance('base error', context('missing'), {
        getToolLibrary: function () { return empty.library; },
    }), 'base error');
});
