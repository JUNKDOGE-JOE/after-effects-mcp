'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildTools } = require('./tools');
const {
    ENVIRONMENT,
    ToolLibrary,
    canonicalJson,
    computeContentHash,
    validateArgsSchema,
} = require('./tool-library');
const { createStatePaths } = require('../state-paths');

function tempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-tool-library-'));
    t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
    return root;
}

function artifact(overrides) {
    const value = {
        schemaVersion: 1,
        id: 'user:11111111-1111-4111-8111-111111111111',
        name: 'Create title',
        description: 'Create a title layer.',
        kind: 'jsx',
        category: 'compositing',
        tags: ['title', 'text'],
        compatibility: {},
        declaredRisk: 'write',
        source: {
            type: 'user',
            ref: 'test',
            client: null,
            productVersion: null,
            provenance: {},
        },
        status: 'saved',
        verified: false,
        verification: null,
        content: 'app.project.activeItem.layers.addText(${text});',
        argsSchema: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    minLength: 1,
                    description: 'Text for the new title.',
                },
            },
            required: ['text'],
            additionalProperties: false,
        },
        revision: 1,
        createdAt: 1000,
        updatedAt: 1000,
        lastUsedAt: null,
    };
    Object.assign(value, overrides || {});
    value.contentHash = computeContentHash(value.kind, value.content, value.argsSchema);
    return value;
}

function makeLibrary(t) {
    const root = tempRoot(t);
    return new ToolLibrary({
        toolRoot: path.join(root, 'tools'),
        skillRoot: path.join(root, 'skills'),
        bundledRoot: path.join(__dirname, 'skills_bundled'),
        now: function () { return 1000; },
    });
}

function toolContext() {
    return {
        session: {
            id: 'session-test',
            clientName: 'tool-library-test',
            conversationId: 'conversation-test',
        },
        policy: { approvalTier: 'none' },
        port: 11488,
    };
}

test('ToolLibrary accepts shared state paths while preserving fine directory overrides', (t) => {
    const root = tempRoot(t);
    const statePaths = createStatePaths({ stateDir: root });
    const customSkills = path.join(root, 'custom-skills');
    const library = new ToolLibrary({ statePaths, skillRoot: customSkills });
    assert.equal(library.toolRoot, path.join(root, 'tools'));
    assert.equal(library.skillRoot, customSkills);
    assert.equal(Object.isFrozen(ENVIRONMENT), true);
});

test('canonical content addressing is order-independent and atomic writes leave no temp file', (t) => {
    const library = makeLibrary(t);
    const first = artifact();
    const second = artifact({
        id: 'user:22222222-2222-4222-8222-222222222222',
        compatibility: { ae: '25', platform: 'win32' },
    });
    second.compatibility = { platform: 'win32', ae: '25' };
    second.contentHash = computeContentHash(second.kind, second.content, second.argsSchema);

    assert.equal(
        canonicalJson({ a: [2, 1], b: { y: true, x: false } }),
        canonicalJson({ b: { x: false, y: true }, a: [2, 1] }),
    );
    assert.equal(first.contentHash, library.saveArtifact(first).contentHash);
    assert.equal(second.contentHash, library.saveArtifact(second).contentHash);
    assert.deepEqual(
        fs.readdirSync(path.join(library.toolRoot, 'artifacts')).filter(function (name) {
            return name.indexOf('.tmp') >= 0;
        }),
        [],
    );
    assert.equal(library.findByContentHash('jsx', first.contentHash).length, 2);
});

test('secret-shaped artifact content is rejected before it reaches disk', (t) => {
    const library = makeLibrary(t);
    const secret = artifact({ content: 'var key = "sk-secretvalue";' });
    secret.contentHash = computeContentHash(secret.kind, secret.content, secret.argsSchema);
    assert.throws(function () { library.saveArtifact(secret); }, /secret-shaped content/i);
    assert.equal(fs.existsSync(path.join(library.toolRoot, 'index.json')), false);
});

test('argsSchema accepts descriptions and fails closed on unsupported keys', () => {
    assert.deepEqual(validateArgsSchema({
        type: 'object',
        properties: { value: { type: 'string', description: 'A bounded description.' } },
        required: ['value'],
        additionalProperties: false,
    }).required, ['value']);
    assert.throws(function () {
        validateArgsSchema({ value: { type: 'string', pattern: '.*' } });
    }, /unsupported keywords/i);
});

test('disk-format fixture round-trips exactly through the host store', (t) => {
    const library = makeLibrary(t);
    const wire = artifact();
    const artifactPath = path.join(
        library.toolRoot,
        'artifacts',
        '11111111-1111-4111-8111-111111111111.json',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, canonicalJson(wire) + '\n', 'utf8');
    fs.writeFileSync(library.indexPath, canonicalJson({
        schemaVersion: 1,
        revision: 1,
        artifacts: [library.summaryFromArtifact(wire)],
    }) + '\n', 'utf8');

    assert.deepEqual(library.getArtifact(wire.id), wire);
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), canonicalJson(wire) + '\n');
});

test('toolSearch combines index, query, and inspect modes', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact());
    const registry = buildTools({ toolLibrary: library });
    const context = toolContext();

    const indexed = await registry.call({ name: 'ae_toolSearch', arguments: {} }, context);
    assert.equal(indexed.result.structuredContent.artifacts.length, 9);
    const searched = await registry.call({
        name: 'ae_toolSearch', arguments: { query: 'TITLE' },
    }, context);
    assert.ok(searched.result.structuredContent.artifacts.some(function (item) {
        return item.id === saved.id;
    }));
    const inspected = await registry.call({
        name: 'ae_toolSearch', arguments: { name: saved.id },
    }, context);
    assert.deepEqual(inspected.result.structuredContent.artifact, saved);
});

test('toolUse rejects a changed artifact at approval consumption and before execution', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact());
    const plan = library.plan(saved.id, { text: 'Hello' });
    const changed = Object.assign({}, saved, {
        content: 'app.project.activeItem.layers.addText("changed");',
    });
    changed.contentHash = computeContentHash(changed.kind, changed.content, changed.argsSchema);
    changed.revision = 2;
    changed.updatedAt = 1001;
    library.saveArtifact(changed);
    assert.throws(function () { library.consumePlan(plan); }, /changed after approval/i);

    const fresh = library.plan(saved.id, { text: 'Hello' });
    library.consumePlan(fresh);
    const editedAgain = Object.assign({}, changed, {
        content: 'app.project.activeItem.layers.addText("again");',
    });
    editedAgain.contentHash = computeContentHash(
        editedAgain.kind,
        editedAgain.content,
        editedAgain.argsSchema,
    );
    editedAgain.revision = 3;
    editedAgain.updatedAt = 1002;
    library.saveArtifact(editedAgain);
    assert.throws(function () { library.assertPlanCurrent(fresh); }, /changed after approval/i);
});

test('skillUse lists bundled skills, preserves render-only payload, and passes execute result through',
    async (t) => {
    const library = makeLibrary(t);
    const registry = buildTools({
        toolLibrary: library,
        executeJsx: async function (request) {
            assert.equal(request.undoGroup, 'Tool Library: run-script');
            return { payload: { ok: true, result: '{"ok":true,"layerId":42}' } };
        },
    });
    const context = toolContext();
    const listed = await registry.call({ name: 'ae_skillUse', arguments: {} }, context);
    assert.equal(listed.result.structuredContent.skills.length, 8);
    library.writeSkill({
        name: 'run-script',
        description: 'Test JSX skill.',
        template_type: 'jsx',
        template: 'app.project.activeItem;',
        args_schema: {},
    });
    const rendered = await registry.call({
        name: 'ae_skillUse', arguments: { name: 'ease-and-timing', execute: false, args: {} },
    }, context);
    assert.equal(rendered.result.structuredContent.ok, true);
    assert.equal(typeof rendered.result.structuredContent.rendered, 'string');
    const executed = await registry.call({
        name: 'ae_skillUse', arguments: { name: 'run-script', execute: true, args: {} },
    }, context);
    assert.deepEqual(executed.result.structuredContent, { ok: true, layerId: 42 });
});

test('content hash remains compatible with SHA-256 canonical JSON', () => {
    const value = { kind: 'jsx', content: 'x', argsSchema: {} };
    assert.equal(
        computeContentHash(value.kind, value.content, value.argsSchema),
        crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'),
    );
});
