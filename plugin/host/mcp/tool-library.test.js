'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildTools } = require('./tools');
const { skillPlan, assertSkillPlanCurrent } = require('./tools/skill-use');
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

function promptSkillArtifact(overrides) {
    return artifact(Object.assign({
        id: 'user:22222222-2222-4222-8222-222222222222',
        name: 'review-comp',
        description: 'Review a composition.',
        kind: 'prompt-skill',
        declaredRisk: 'read',
        content: 'Review ${topic} with a ${tone} tone.',
        argsSchema: {
            type: 'object',
            properties: {
                topic: { type: 'string' },
                tone: { type: 'string', default: 'concise' },
            },
            required: ['topic'],
            additionalProperties: false,
        },
    }, overrides || {}));
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

test('removeArtifact deletes both records and rolls back the file when the index update fails', (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact());
    const originalRename = fs.renameSync;
    let rejected = false;
    fs.renameSync = function (source, destination) {
        if (!rejected && destination === library.indexPath) {
            rejected = true;
            throw new Error('index write failed');
        }
        return originalRename(source, destination);
    };
    try {
        assert.throws(function () { library.removeArtifact(saved.id); }, /index write failed/);
    } finally {
        fs.renameSync = originalRename;
    }
    assert.equal(library.getArtifact(saved.id).id, saved.id);
    assert.equal(library.removeArtifact(saved.id), true);
    assert.equal(library.removeArtifact(saved.id), false);
    assert.throws(function () { library.getArtifact(saved.id); }, /tool not found/);
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

test('library export only permits saved and pinned user artifacts', (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact());
    const pinned = library.saveArtifact(artifact({
        id: 'user:22222222-2222-4222-8222-222222222222',
        status: 'pinned',
        content: 'app.project.activeItem.layers.addText("pinned");',
        argsSchema: {},
    }));
    const candidate = library.saveArtifact(artifact({
        id: 'user:33333333-3333-4333-8333-333333333333',
        status: 'candidate',
        content: 'app.project.activeItem.layers.addText("candidate");',
        argsSchema: {},
    }));
    const exported = library.exportArtifact(saved.id);

    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.exportedAt, 1000);
    assert.deepEqual(exported.artifact, saved);
    assert.equal(library.exportArtifact(pinned.id).artifact.id, pinned.id);
    assert.throws(function () { library.exportArtifact(candidate.id); }, /saved or pinned/i);
    assert.throws(function () {
        library.exportArtifact(library.legacyArtifacts()[0].id);
    }, /product-provided artifacts/i);
});

test('library import verifies content, rejects duplicates, and records imported provenance', (t) => {
    const source = makeLibrary(t);
    const original = source.saveArtifact(artifact());
    const exported = source.exportArtifact(original.id);
    const target = makeLibrary(t);
    const imported = target.importArtifact(exported);

    assert.equal(imported.imported, true);
    assert.match(imported.artifact.id, /^user:/);
    assert.notEqual(imported.artifact.id, original.id);
    assert.equal(imported.artifact.status, 'saved');
    assert.equal(imported.artifact.verified, false);
    assert.equal(imported.artifact.source.type, 'imported');
    assert.equal(imported.artifact.source.ref, original.id);
    assert.deepEqual(imported.artifact.source.provenance, {
        importedAt: 1000,
        originalId: original.id,
        originalSource: original.source,
    });
    assert.equal(target.importArtifact(exported).imported, false);
    assert.equal(target.importArtifact(exported).existingId, imported.artifact.id);

    const tampered = JSON.parse(JSON.stringify(exported));
    tampered.artifact.content = 'app.project.activeItem.layers.addText("tampered");';
    assert.throws(function () { target.importArtifact(tampered); }, /contentHash does not match/i);

    const secret = JSON.parse(JSON.stringify(exported));
    secret.artifact.content = 'var apiKey = "not-allowed";';
    secret.artifact.contentHash = computeContentHash(
        secret.artifact.kind,
        secret.artifact.content,
        secret.artifact.argsSchema,
    );
    assert.throws(function () { target.importArtifact(secret); }, /secret-shaped/i);
});

test('library management transitions and deletion respect artifact lifecycle', (t) => {
    const library = makeLibrary(t);
    const candidate = library.saveArtifact(artifact({
        id: 'user:33333333-3333-4333-8333-333333333333',
        status: 'candidate',
        content: 'app.project.activeItem.layers.addText("candidate");',
        argsSchema: {},
    }));
    const saved = library.promoteArtifact(candidate.id);
    const pinned = library.pinArtifact(saved.id);
    const archived = library.archiveArtifact(pinned.id);

    assert.equal(saved.status, 'saved');
    assert.equal(pinned.status, 'pinned');
    assert.equal(archived.status, 'archived');
    assert.equal(library.restoreArtifact(archived.id).status, 'saved');
    assert.throws(function () { library.deleteManagedArtifact(saved.id); }, /candidate or archived/i);
    assert.equal(library.archiveArtifact(saved.id).status, 'archived');
    assert.equal(library.deleteManagedArtifact(saved.id), true);

    const secondCandidate = library.saveArtifact(artifact({
        id: 'user:44444444-4444-4444-8444-444444444444',
        status: 'candidate',
        content: 'app.project.activeItem.layers.addText("candidate two");',
        argsSchema: {},
    }));
    assert.equal(library.managementList().candidates[0].contentCharacters > 0, true);
    assert.deepEqual(library.clearCandidates(), { removedIds: [secondCandidate.id], count: 1 });
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

test('candidate artifacts stay out of default search but remain inspectable and executable by id', async (t) => {
    const library = makeLibrary(t);
    const captured = artifact({
        status: 'candidate',
        argsSchema: {},
        content: 'app.project.activeItem;',
        source: {
            type: 'chat-tool-call',
            ref: 'ae_exec',
            client: 'test-client',
            productVersion: null,
            provenance: { capturedAt: 1000, conversationId: 'conversation-test', tool: 'ae_exec' },
        },
    });
    library.saveArtifact(captured);
    const registry = buildTools({
        toolLibrary: library,
        executeJsx: async function (request) {
            assert.equal(request.code, captured.content);
            return { payload: { ok: true, result: '{"ok":true}' } };
        },
    });
    const listed = await registry.call({ name: 'ae_toolSearch', arguments: {} }, toolContext());
    assert.equal(listed.result.structuredContent.artifacts.some(function (item) {
        return item.id === captured.id;
    }), false);
    const inspected = await registry.call({
        name: 'ae_toolSearch', arguments: { name: captured.id },
    }, toolContext());
    assert.equal(inspected.result.structuredContent.artifact.id, captured.id);
    const used = await registry.call({
        name: 'ae_toolUse', arguments: { name: captured.id },
    }, toolContext());
    assert.deepEqual(used.result.structuredContent, { ok: true });
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

test('toolSave prompt-skill creation feeds skillUse listing, rendering, and normalized arguments',
    async (t) => {
        const library = makeLibrary(t);
        const registry = buildTools({ toolLibrary: library });
        const context = toolContext();
        const created = await registry.call({
            name: 'ae_toolSave',
            arguments: {
                create: {
                    name: 'review-comp',
                    description: 'Review a composition.',
                    kind: 'prompt-skill',
                    content: 'Review ${topic} with a ${tone} tone.',
                    argsSchema: promptSkillArtifact().argsSchema,
                },
            },
        }, context);
        const artifactId = created.result.structuredContent.artifact.id;
        const listed = await registry.call({
            name: 'ae_skillUse', arguments: { include_templates: true },
        }, context);
        const skill = listed.result.structuredContent.skills.find(function (item) {
            return item.name === 'review-comp';
        });
        assert.deepEqual(skill.args, ['tone', 'topic']);
        assert.equal(skill.source, 'library');
        assert.equal(skill.template, 'Review ${topic} with a ${tone} tone.');
        assert.deepEqual(skill.args_schema, promptSkillArtifact().argsSchema);

        const rendered = await registry.call({
            name: 'ae_skillUse', arguments: { name: artifactId, args: { topic: 'timing' } },
        }, context);
        assert.deepEqual(rendered.result.structuredContent, {
            ok: true,
            name: 'review-comp',
            template_type: 'prompt',
            rendered: 'Review timing with a concise tone.',
        });
        const rejected = await registry.call({
            name: 'ae_skillUse', arguments: { name: artifactId, args: { topic: 'timing' }, execute: true },
        }, context);
        assert.equal(rejected.result.structuredContent.ok, false);
        assert.match(rejected.result.structuredContent.error, /prompt skills are render-only/i);
    });

test('skillUse exposes only saved and pinned prompt-skill library artifacts', async (t) => {
    const library = makeLibrary(t);
    ['saved', 'pinned', 'candidate', 'archived', 'deprecated'].forEach(function (status, index) {
        const digit = String(index + 3);
        library.saveArtifact(promptSkillArtifact({
            id: 'user:' + digit.repeat(8) + '-' + digit.repeat(4) + '-4' + digit.repeat(3)
                + '-8' + digit.repeat(3) + '-' + digit.repeat(12),
            name: 'lifecycle-' + status,
            status,
        }));
    });
    const listed = await buildTools({ toolLibrary: library }).call({
        name: 'ae_skillUse', arguments: {},
    }, toolContext());
    const names = listed.result.structuredContent.skills.map(function (item) { return item.name; });
    assert.equal(names.includes('lifecycle-saved'), true);
    assert.equal(names.includes('lifecycle-pinned'), true);
    assert.equal(names.includes('lifecycle-candidate'), false);
    assert.equal(names.includes('lifecycle-archived'), false);
    assert.equal(names.includes('lifecycle-deprecated'), false);
});

test('skill name collisions prefer library over legacy over bundled', (t) => {
    const library = makeLibrary(t);
    assert.equal(library.resolveSkill('ease-and-timing').source, 'bundled');
    library.writeSkill({
        name: 'ease-and-timing',
        description: 'Legacy override.',
        template_type: 'prompt',
        template: 'legacy',
        args_schema: {},
    });
    assert.equal(library.resolveSkill('ease-and-timing').source, 'user');
    assert.equal(library.resolveSkill('ease-and-timing').skill.template, 'legacy');
    const current = library.saveArtifact(promptSkillArtifact({
        name: 'ease-and-timing',
        content: 'library',
        argsSchema: {},
    }));
    assert.equal(library.resolveSkill('ease-and-timing').source, 'library');
    assert.equal(library.resolveSkill('ease-and-timing').skill.template, 'library');
    assert.equal(library.resolveSkill(current.id).artifact.id, current.id);
});

test('library prompt-skill updates invalidate previously derived approval plans', (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(promptSkillArtifact());
    const plan = skillPlan(library.resolveSkill(saved.id), { topic: 'timing' });
    const updated = Object.assign({}, saved, {
        content: 'Re-review ${topic} with a ${tone} tone.',
        revision: saved.revision + 1,
        updatedAt: saved.updatedAt + 1,
    });
    updated.contentHash = computeContentHash(updated.kind, updated.content, updated.argsSchema);
    library.saveArtifact(updated);
    assert.throws(function () {
        assertSkillPlanCurrent(library, plan);
    }, /skill changed after approval/i);
});

test('content hash remains compatible with SHA-256 canonical JSON', () => {
    const value = { kind: 'jsx', content: 'x', argsSchema: {} };
    assert.equal(
        computeContentHash(value.kind, value.content, value.argsSchema),
        crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'),
    );
});
