'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { READONLY_DENIED } = require('../approval-gate');
const { computeContentHash, ToolLibrary } = require('../tool-library');
const { buildTools, noTopLevelCombinator } = require('../tools');
const toolSave = require('./tool-save');

function makeLibrary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-tool-save-'));
    t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
    return new ToolLibrary({
        toolRoot: path.join(root, 'tools'),
        skillRoot: path.join(root, 'skills'),
        bundledRoot: path.join(__dirname, '..', 'skills_bundled'),
        now: function () { return 2000; },
    });
}

function artifact(overrides) {
    const value = {
        schemaVersion: 1,
        id: 'user:11111111-1111-4111-8111-111111111111',
        name: 'Captured script',
        description: 'Captured from ae_exec.',
        kind: 'jsx',
        category: 'workflow',
        tags: [],
        compatibility: {},
        declaredRisk: 'write',
        source: {
            type: 'chat-tool-call',
            ref: 'ae_exec',
            client: 'tool-save-test',
            productVersion: null,
            provenance: { capturedAt: 1000, conversationId: 'conversation-test', tool: 'ae_exec' },
        },
        status: 'candidate',
        verified: false,
        verification: null,
        content: 'app.project.activeItem;',
        argsSchema: {},
        revision: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastUsedAt: null,
        useCount: 0,
    };
    Object.assign(value, overrides || {});
    value.contentHash = computeContentHash(value.kind, value.content, value.argsSchema);
    return value;
}

function context(tier) {
    return {
        session: {
            id: 'session-test',
            clientName: 'tool-save-test',
            conversationId: 'conversation-test',
        },
        policy: { approvalTier: tier === undefined ? 'none' : tier },
        port: 11488,
    };
}

function value(output) {
    return output.result.structuredContent;
}

test('candidate promotion persists metadata and makes the artifact visible to default search', async (t) => {
    const library = makeLibrary(t);
    const candidate = library.saveArtifact(artifact());
    const registry = buildTools({ toolLibrary: library });
    const promoted = value(await registry.call({
        name: 'ae_toolSave',
        arguments: {
            name: candidate.id,
            newName: 'Reusable script',
            description: 'Saved for later use.',
            tags: ['saved', 'workflow'],
        },
    }, context()));

    assert.equal(promoted.ok, true);
    assert.equal(promoted.artifact.status, 'saved');
    assert.equal(promoted.artifact.name, 'Reusable script');
    assert.equal(promoted.artifact.revision, 2);
    const listed = value(await registry.call({
        name: 'ae_toolSearch', arguments: {},
    }, context()));
    assert.ok(listed.artifacts.some(function (item) { return item.id === candidate.id; }));
});

test('create saves JSX and prompt-skill user artifacts and prompt-skill remains inspectable by id',
    async (t) => {
        const library = makeLibrary(t);
        const registry = buildTools({ toolLibrary: library });
        const jsx = value(await registry.call({
            name: 'ae_toolSave',
            arguments: {
                create: {
                    name: 'Add marker',
                    description: 'Adds a marker.',
                    kind: 'jsx',
                    content: 'app.project.activeItem.markerProperty.setValueAtTime(0, new MarkerValue("saved"));',
                },
            },
        }, context()));
        assert.equal(jsx.ok, true);
        assert.match(jsx.artifact.id, /^user:/);
        assert.equal(jsx.artifact.sourceType, 'user');
        assert.equal(jsx.artifact.status, 'saved');
        assert.equal(jsx.artifact.revision, 1);

        const prompt = value(await registry.call({
            name: 'ae_toolSave',
            arguments: {
                create: {
                    name: 'review-comp',
                    description: 'Reviews a composition plan.',
                    kind: 'prompt-skill',
                    content: 'Review ${topic}.',
                    argsSchema: {
                        type: 'object',
                        properties: {
                            topic: { type: 'string', description: 'Review topic.' },
                        },
                        required: ['topic'],
                        additionalProperties: false,
                    },
                },
                status: 'pinned',
            },
        }, context()));
        assert.equal(prompt.artifact.kind, 'prompt-skill');
        assert.equal(prompt.artifact.status, 'pinned');
        const inspected = value(await registry.call({
            name: 'ae_toolSearch', arguments: { name: prompt.artifact.id },
        }, context()));
        assert.equal(inspected.artifact.id, prompt.artifact.id);
        assert.equal(inspected.artifact.kind, 'prompt-skill');
        assert.equal(inspected.artifact.source.type, 'user');
    });

test('update refreshes revision, hash, timestamp, content, schema, and metadata', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact({ status: 'saved' }));
    const priorHash = saved.contentHash;
    const output = value(await toolSave.call({
        name: saved.id,
        newName: 'Updated script',
        description: 'Updated description.',
        tags: ['updated'],
        content: 'app.project.activeItem.layers.addNull();',
        status: 'pinned',
        argsSchema: {
            type: 'object',
            properties: { enabled: { type: 'boolean', description: 'Whether to run.' } },
            additionalProperties: false,
        },
    }, context(), { toolLibrary: library }));

    assert.equal(output.ok, true);
    const updated = library.getArtifact(saved.id);
    assert.equal(updated.name, 'Updated script');
    assert.equal(updated.description, 'Updated description.');
    assert.deepEqual(updated.tags, ['updated']);
    assert.equal(updated.status, 'pinned');
    assert.equal(updated.revision, 2);
    assert.ok(updated.updatedAt > saved.updatedAt);
    assert.notEqual(updated.contentHash, priorHash);
    assert.equal(updated.content, 'app.project.activeItem.layers.addNull();');
    assert.equal(updated.argsSchema.properties.enabled.type, 'boolean');
});

test('status management archives an existing user artifact', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact({ status: 'saved' }));
    const output = value(await toolSave.call({
        name: saved.id, status: 'archived',
    }, context(), { toolLibrary: library }));
    assert.equal(output.ok, true);
    assert.equal(output.artifact.status, 'archived');
    assert.equal(output.artifact.revision, 2);
    assert.equal(library.getArtifact(saved.id).status, 'archived');
});

test('promotion rejects non-candidates and status cannot return to candidate', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact({ status: 'saved' }));
    const notCandidate = value(await toolSave.call({
        name: saved.id,
    }, context(), { toolLibrary: library }));
    assert.equal(notCandidate.ok, false);
    assert.match(notCandidate.error, /Only candidate artifacts can be promoted/);

    const candidateStatus = value(await toolSave.call({
        name: saved.id, status: 'candidate',
    }, context(), { toolLibrary: library }));
    assert.equal(candidateStatus.ok, false);
    assert.match(candidateStatus.error, /cannot be changed back to `candidate`/);
});

test('bundled and legacy artifacts reject updates with actionable read-only errors', async (t) => {
    const library = makeLibrary(t);
    const bundled = value(await toolSave.call({
        name: 'builtin:skill:ease-and-timing', description: 'changed',
    }, context(), { toolLibrary: library }));
    assert.equal(bundled.ok, false);
    assert.match(bundled.error, /Bundled artifacts are read-only/);

    library.writeSkill({
        name: 'legacy-test',
        description: 'Legacy fixture.',
        template_type: 'jsx',
        template: 'app.project.activeItem;',
        args_schema: {},
    });
    const legacy = library.allSummaries().find(function (item) {
        return item.name === 'legacy-test';
    });
    const rejected = value(await toolSave.call({
        name: legacy.id, content: 'changed',
    }, context(), { toolLibrary: library }));
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Legacy artifacts are read-only/);
});

test('approval denial leaves storage unchanged and accepted cards contain the bounded save summary',
    async (t) => {
        const library = makeLibrary(t);
        const denied = value(await toolSave.call({
            create: {
                name: 'Denied tool', description: 'Must not persist.', kind: 'jsx', content: '1 + 1',
            },
        }, context('readonly'), { toolLibrary: library }));
        assert.deepEqual(denied, { ok: false, error: READONLY_DENIED });
        assert.equal(library.list().length, 0);

        const content = 'x'.repeat(205);
        let approval;
        const accepted = value(await toolSave.call({
            create: {
                name: 'Approved tool', description: 'Persists after approval.', kind: 'jsx', content,
            },
            status: 'pinned',
        }, context('manual'), {
            toolLibrary: library,
            approvals: {
                request: async function (item) {
                    approval = item;
                    return 'accept';
                },
            },
        }));
        assert.equal(accepted.ok, true);
        assert.equal(approval.tool, 'ae_toolSave');
        assert.equal(approval.risk, 'non-destructive write');
        assert.match(approval.summary.id, /^user:/);
        assert.equal(approval.summary.name, 'Approved tool');
        assert.equal(approval.summary.operation, 'create');
        assert.equal(approval.summary.kind, 'jsx');
        assert.equal(approval.summary.content_chars, 205);
        assert.equal(approval.summary.status, 'pinned');
        assert.equal(approval.summary.content, 'x'.repeat(200));
        assert.deepEqual(approval.plan.normalizedArgs, approval.summary);
    });

test('registry chain captures exec, promotes, lists, and executes the saved artifact', async (t) => {
    const library = makeLibrary(t);
    let executions = 0;
    const registry = buildTools({
        getToolLibrary: function () { return library; },
        executeJsx: async function () {
            executions += 1;
            return { payload: { ok: true, resultType: 'string', result: '{"ok":true}' } };
        },
    });
    const captured = value(await registry.call({
        name: 'ae_exec', arguments: { code: 'app.project.activeItem;' },
    }, context()));
    assert.match(captured.artifactId, /^user:/);

    const promoted = value(await registry.call({
        name: 'ae_toolSave', arguments: { name: captured.artifactId },
    }, context()));
    assert.equal(promoted.artifact.status, 'saved');
    const listed = value(await registry.call({
        name: 'ae_toolSearch', arguments: {},
    }, context()));
    assert.ok(listed.artifacts.some(function (item) { return item.id === captured.artifactId; }));
    const used = value(await registry.call({
        name: 'ae_toolUse', arguments: { name: captured.artifactId },
    }, context()));
    assert.deepEqual(used, { ok: true });
    assert.equal(executions, 2);
});

test('toolSave records create, promote, update, and status funnel operations', async (t) => {
    const library = makeLibrary(t);
    const candidate = library.saveArtifact(artifact());
    const activity = [];
    const deps = {
        toolLibrary: library,
        recordMcpActivity: function (event) { activity.push(event); },
    };
    await toolSave.call({ name: candidate.id }, context(), deps);
    const created = value(await toolSave.call({
        create: {
            name: 'Reusable prompt',
            description: 'Created for funnel telemetry.',
            kind: 'prompt-skill',
            content: 'Review ${topic}.',
            argsSchema: { topic: { type: 'string' } },
        },
    }, context(), deps));
    await toolSave.call({
        name: created.artifact.id,
        description: 'Updated for funnel telemetry.',
    }, context(), deps);
    await toolSave.call({
        name: created.artifact.id,
        status: 'archived',
    }, context(), deps);

    assert.deepEqual(activity.map(function (event) { return event.operation; }), [
        'promote', 'create', 'update', 'status',
    ]);
    activity.forEach(function (event) {
        assert.equal(event.tool, 'ae_toolSave');
        assert.match(event.artifactId, /^user:/);
        assert.equal(event.ok, true);
    });
});

test('advertised save schema has no top-level combinator and rejects candidate status by construction', () => {
    assert.equal(noTopLevelCombinator(toolSave.definition.inputSchema), true);
    assert.equal(Object.keys(toolSave.definition.inputSchema).some(function (key) {
        return ['oneOf', 'anyOf', 'allOf'].indexOf(key) >= 0;
    }), false);
    assert.deepEqual(toolSave.definition.inputSchema.properties.status.enum, [
        'saved', 'pinned', 'archived', 'deprecated',
    ]);
});
