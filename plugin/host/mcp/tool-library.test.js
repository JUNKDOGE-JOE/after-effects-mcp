'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildTools } = require('./tools');
const skillUse = require('./tools/skill-use');
const toolUse = require('./tools/tool-use');
const { skillPlan, assertSkillPlanCurrent } = skillUse;
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
        useCount: 0,
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

test('touchUsage increments lastUsedAt and useCount without changing artifact revision', (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact());
    library.now = function () { return 2500; };
    const first = library.touchUsage(saved.id);
    library.now = function () { return 3000; };
    const second = library.touchUsage(saved.id);

    assert.equal(first.lastUsedAt, 2500);
    assert.equal(first.useCount, 1);
    assert.equal(second.lastUsedAt, 3000);
    assert.equal(second.useCount, 2);
    assert.equal(second.revision, saved.revision);
    assert.equal(library.list()[0].useCount, 2);
    assert.equal(JSON.parse(fs.readFileSync(library.artifactPath(saved.id), 'utf8')).useCount, 2);
});

test('saveArtifact writes a default useCount and rejects invalid usage counts', (t) => {
    const library = makeLibrary(t);
    const missing = artifact();
    delete missing.useCount;
    const saved = library.saveArtifact(missing);
    assert.equal(saved.useCount, 0);
    assert.equal(JSON.parse(fs.readFileSync(library.artifactPath(saved.id), 'utf8')).useCount, 0);
    assert.throws(function () {
        library.saveArtifact(artifact({ useCount: -1 }));
    }, /artifact useCount/);
});

test('old artifacts and index entries without useCount survive read, use, touch, and save', async (t) => {
    const library = makeLibrary(t);
    const currentWire = artifact({
        status: 'candidate',
        argsSchema: {},
        content: 'app.project.activeItem;',
    });
    const oldWire = Object.assign({}, currentWire);
    delete oldWire.useCount;
    const oldSummary = library.summaryFromArtifact(currentWire);
    delete oldSummary.useCount;
    fs.writeFileSync(library.artifactPath(currentWire.id), canonicalJson(oldWire) + '\n', 'utf8');
    fs.writeFileSync(library.indexPath, canonicalJson({
        schemaVersion: 1,
        revision: 1,
        artifacts: [oldSummary],
    }) + '\n', 'utf8');

    assert.equal(library.getArtifact(currentWire.id).useCount, 0);
    assert.equal(library.list()[0].useCount, 0);
    const activity = [];
    const registry = buildTools({
        toolLibrary: library,
        executeJsx: async function () {
            return { payload: { ok: true, result: '{"ok":true}' } };
        },
        recordMcpActivity: function (event) { activity.push(event); },
    });
    const used = await registry.call({
        name: 'ae_toolUse', arguments: { name: currentWire.id },
    }, toolContext());
    assert.equal(used.result.structuredContent.ok, true);
    assert.equal(library.getArtifact(currentWire.id).useCount, 1);

    const promoted = await registry.call({
        name: 'ae_toolSave', arguments: {
            name: currentWire.id,
            description: 'Promoted old-format artifact.',
        },
    }, toolContext());
    assert.equal(promoted.result.structuredContent.ok, true);
    assert.equal(promoted.result.structuredContent.artifact.revision, 2);
    assert.equal(promoted.result.structuredContent.artifact.useCount, 1);
    assert.ok(activity.some(function (event) {
        return event.tool === 'ae_toolUse' && event.artifactId === currentWire.id
            && event.operation === 'use' && event.ok === true;
    }));
    assert.ok(activity.some(function (event) {
        return event.tool === 'ae_toolSave' && event.artifactId === currentWire.id
            && event.operation === 'promote' && event.ok === true;
    }));
    assert.equal(JSON.parse(fs.readFileSync(library.artifactPath(currentWire.id), 'utf8')).useCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(library.indexPath, 'utf8')).artifacts[0].useCount, 1);
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

test('toolUse touches successful artifacts, records use activity, and fails open on touch errors', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(artifact());
    const activity = [];
    const deps = {
        toolLibrary: library,
        executeJsx: async function () {
            return { payload: { ok: true, result: '{"ok":true}' } };
        },
        recordMcpActivity: function (event) { activity.push(event); },
    };
    const first = await toolUse.call({ name: saved.id, args: { text: 'Hello' } }, toolContext(), deps);
    assert.equal(first.result.structuredContent.ok, true);
    const touched = library.getArtifact(saved.id);
    assert.equal(touched.lastUsedAt, 1000);
    assert.equal(touched.useCount, 1);
    assert.equal(touched.revision, saved.revision);
    assert.deepEqual(activity[0], {
        tool: 'ae_toolUse',
        artifactId: saved.id,
        operation: 'use',
        ok: true,
        transport: 'mcp',
        client: 'tool-library-test',
    });

    library.touchUsage = function () { throw new Error('usage storage unavailable'); };
    const second = await toolUse.call({ name: saved.id, args: { text: 'Again' } }, toolContext(), deps);
    assert.equal(second.result.structuredContent.ok, true);
    assert.equal(activity.length, 2);
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

test('skillUse touches and records a named library render, including include_templates requests', async (t) => {
    const library = makeLibrary(t);
    const saved = library.saveArtifact(promptSkillArtifact());
    const activity = [];
    const deps = {
        toolLibrary: library,
        recordMcpActivity: function (event) { activity.push(event); },
    };
    const output = await skillUse.call({
        name: saved.id,
        args: { topic: 'timing' },
        include_templates: true,
    }, toolContext(), deps);
    assert.equal(output.result.structuredContent.ok, true);
    assert.equal(library.getArtifact(saved.id).useCount, 1);
    assert.deepEqual(activity[0], {
        tool: 'ae_skillUse',
        artifactId: saved.id,
        operation: 'render',
        ok: true,
        transport: 'mcp',
        client: 'tool-library-test',
    });

    library.touchUsage = function () { throw new Error('usage storage unavailable'); };
    const failOpen = await skillUse.call({
        name: saved.id, args: { topic: 'spacing' },
    }, toolContext(), deps);
    assert.equal(failOpen.result.structuredContent.ok, true);
});

test('bundled and legacy skill usage persists in the state tools directory', async (t) => {
    const library = makeLibrary(t);
    library.writeSkill({
        name: 'legacy-review',
        description: 'Legacy review prompt.',
        template_type: 'prompt',
        template: 'Review the current composition.',
        args_schema: {},
    });
    const deps = { toolLibrary: library };
    for (let index = 0; index < 2; index += 1) {
        const rendered = await skillUse.call({
            name: 'builtin:skill:ae-execution-guide',
        }, toolContext(), deps);
        assert.equal(rendered.result.structuredContent.ok, true);
    }
    const legacyRendered = await skillUse.call({
        name: 'legacy-review',
    }, toolContext(), deps);
    assert.equal(legacyRendered.result.structuredContent.ok, true);

    const listed = await skillUse.call({}, toolContext(), deps);
    const bundledMeta = listed.result.structuredContent.skills.find(function (item) {
        return item.name === 'ae-execution-guide';
    });
    const legacyMeta = listed.result.structuredContent.skills.find(function (item) {
        return item.name === 'legacy-review';
    });
    assert.deepEqual(
        { useCount: bundledMeta.useCount, lastUsedAt: bundledMeta.lastUsedAt },
        { useCount: 2, lastUsedAt: 1000 },
    );
    assert.deepEqual(
        { useCount: legacyMeta.useCount, lastUsedAt: legacyMeta.lastUsedAt },
        { useCount: 1, lastUsedAt: 1000 },
    );
    const usage = JSON.parse(fs.readFileSync(library.skillUsagePath, 'utf8'));
    assert.equal(usage['builtin:skill:ae-execution-guide'].useCount, 2);

    const restarted = new ToolLibrary({
        toolRoot: library.toolRoot,
        skillRoot: library.skillRoot,
        bundledRoot: library.bundledRoot,
        now: function () { return 2000; },
    });
    const afterRestart = restarted.skillMeta(restarted.resolveSkill('ae-execution-guide'));
    assert.equal(afterRestart.useCount, 2);
    assert.equal(afterRestart.lastUsedAt, 1000);
});

test('corrupt bundled and legacy skill usage is treated as empty', (t) => {
    const library = makeLibrary(t);
    fs.writeFileSync(library.skillUsagePath, '{not-json', 'utf8');
    const record = library.resolveSkill('ae-execution-guide');
    assert.deepEqual(library.skillUsage(record), { useCount: 0, lastUsedAt: null });
    assert.deepEqual(library.touchSkillUsage(record), { useCount: 1, lastUsedAt: 1000 });
});

test('skillUse touches and records a successful library skill execution', async () => {
    const stored = artifact({
        id: 'user:33333333-3333-4333-8333-333333333333',
        name: 'run-library-skill',
        argsSchema: {},
        content: 'app.project.activeItem;',
    });
    const record = {
        skill: {
            name: stored.name,
            description: stored.description,
            template_type: 'jsx',
            template: stored.content,
            args_schema: stored.argsSchema,
        },
        source: 'library',
        path: 'library',
        artifact: stored,
    };
    const touches = [];
    const activity = [];
    const store = {
        resolveSkill: function () { return record; },
        touchUsage: function (id) { touches.push(id); },
    };
    const output = await skillUse.call({
        name: stored.id, execute: true, args: {},
    }, toolContext(), {
        toolLibrary: store,
        executeJsx: async function () {
            return { payload: { ok: true, result: '{"ok":true}' } };
        },
        recordMcpActivity: function (event) { activity.push(event); },
    });
    assert.equal(output.result.structuredContent.ok, true);
    assert.deepEqual(touches, [stored.id]);
    assert.equal(activity[0].tool, 'ae_skillUse');
    assert.equal(activity[0].artifactId, stored.id);
    assert.equal(activity[0].operation, 'use');
    assert.equal(activity[0].ok, true);
});

test('bundled and legacy synthetic artifacts never receive usage touches', async (t) => {
    const library = makeLibrary(t);
    library.writeSkill({
        name: 'legacy-runner',
        description: 'Legacy JSX fixture.',
        template_type: 'jsx',
        template: 'app.project.activeItem;',
        args_schema: {},
    });
    const legacy = library.allSummaries().find(function (item) {
        return item.name === 'legacy-runner';
    });
    const touches = [];
    library.touchUsage = function (id) { touches.push(id); };
    const deps = {
        toolLibrary: library,
        executeJsx: async function () {
            return { payload: { ok: true, result: '{"ok":true}' } };
        },
    };
    const bundled = await skillUse.call({
        name: 'builtin:skill:ae-execution-guide', include_templates: true,
    }, toolContext(), deps);
    const legacySkill = await skillUse.call({
        name: legacy.id, execute: true,
    }, toolContext(), deps);
    const legacyTool = await toolUse.call({ name: legacy.id }, toolContext(), deps);
    assert.equal(bundled.result.structuredContent.ok, true);
    assert.equal(legacySkill.result.structuredContent.ok, true);
    assert.equal(legacyTool.result.structuredContent.ok, true);
    assert.deepEqual(touches, []);
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

test('bundled execution guide advertises the Tool Library workflow and matches its manifest hash', (t) => {
    const bundledRoot = path.join(__dirname, 'skills_bundled');
    const guidePath = path.join(bundledRoot, 'ae-execution-guide.json');
    const guideBytes = fs.readFileSync(guidePath);
    const guide = JSON.parse(guideBytes.toString('utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(bundledRoot, 'manifest.json'), 'utf8'));
    const entry = manifest.artifacts.find(function (item) {
        return item.path === 'ae-execution-guide.json';
    });
    assert.match(guide.template, /ae_toolSearch.*ae_toolUse/s);
    assert.match(guide.template, /ae_toolSave/);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(guideBytes).digest('hex'));
    assert.equal(makeLibrary(t).getArtifact('builtin:skill:ae-execution-guide').verified, true);
});

test('all bundled skill descriptions use the three-sentence trigger template', () => {
    const requiredKeywords = {
        'ae-execution-guide': 'execution route',
        'ease-and-timing': 'ease pair',
        'extendscript-cookbook': 'extendscript traps',
        'glow-recipes': 'glow',
        'grade-stack': 'grade-stack',
        'kinetic-typography': 'kinetic typography',
        'project-organization': 'project organization',
        'render-order': 'render order',
    };
    Object.keys(requiredKeywords).forEach(function (name) {
        const skill = JSON.parse(fs.readFileSync(
            path.join(__dirname, 'skills_bundled', name + '.json'), 'utf8',
        ));
        const description = skill.description.toLowerCase();
        assert.ok(description.length <= 220, name + ' description is too long');
        assert.match(skill.description, /^Use when .+\. Gives .+\. Needs .+\.$/);
        assert.match(description, new RegExp(requiredKeywords[name]));
    });
});

test('bundled skill manifest matches every bundled skill file', () => {
    const bundledRoot = path.join(__dirname, 'skills_bundled');
    const manifest = JSON.parse(fs.readFileSync(path.join(bundledRoot, 'manifest.json'), 'utf8'));
    const files = fs.readdirSync(bundledRoot).filter(function (name) {
        return name.endsWith('.json') && name !== 'manifest.json';
    }).sort();
    const entries = manifest.artifacts.slice().sort(function (left, right) {
        return left.path.localeCompare(right.path);
    });
    assert.deepEqual(entries.map(function (entry) { return entry.path; }), files);
    entries.forEach(function (entry) {
        const digest = crypto.createHash('sha256').update(
            fs.readFileSync(path.join(bundledRoot, entry.path)),
        ).digest('hex');
        assert.equal(entry.sha256, digest, entry.path);
    });
});

test('new ExtendScript cookbook entries keep the Symptom/Cause/Fix shape', () => {
    const cookbook = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'skills_bundled', 'extendscript-cookbook.json'), 'utf8',
    ));
    const titles = [
        'Error object where a number/array/property was expected',
        'Text animator skeleton: use match names',
        'Project bit depth and previews',
        'Reading ExtendScript errors',
        'Replay candidates instead of resending scripts',
    ];
    titles.forEach(function (title) {
        const start = cookbook.template.indexOf('=== ' + title + ' ===');
        const next = cookbook.template.indexOf('\n\n===', start + title.length + 8);
        const section = cookbook.template.slice(start, next < 0 ? undefined : next);
        assert.ok(start >= 0, title + ' is missing');
        assert.ok(section.split('\n').length <= 12, title + ' is too long');
        assert.match(section, /\nSymptom:/);
        assert.match(section, /\nCause:/);
        assert.match(section, /\nFix:/);
    });
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
