'use strict';

const crypto = require('crypto');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { textResult } = require('../tool-result');
const {
    assertSecretFree,
    canonicalJson,
    computeContentHash,
    defaultLibrary,
    validateArtifact,
} = require('../tool-library');

const WRITABLE_STATUSES = ['saved', 'pinned', 'archived', 'deprecated'];
const CREATE_KINDS = ['jsx', 'prompt-skill'];
const TOP_LEVEL_KEYS = [
    'name', 'create', 'newName', 'description', 'tags', 'content', 'argsSchema', 'status',
];
const CREATE_KEYS = ['name', 'description', 'kind', 'content', 'argsSchema', 'tags'];
const UPDATE_KEYS = ['newName', 'description', 'tags', 'content', 'argsSchema'];

const definition = {
    name: 'ae_toolSave',
    description: 'Create, promote, update, or change the status of a Tool Library artifact.',
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                minLength: 1,
                description: 'Existing artifact id from ae_toolSearch.',
            },
            create: {
                type: 'object',
                description: 'New user artifact. Cannot be combined with name or update fields.',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 128 },
                    description: { type: 'string', maxLength: 4096 },
                    kind: { type: 'string', enum: CREATE_KINDS },
                    content: { type: 'string' },
                    argsSchema: { type: 'object', default: {} },
                    tags: {
                        type: 'array',
                        items: { type: 'string', minLength: 1, maxLength: 64 },
                        maxItems: 32,
                        default: [],
                    },
                },
                required: ['name', 'description', 'kind', 'content'],
                additionalProperties: false,
            },
            newName: { type: 'string', minLength: 1, maxLength: 128 },
            description: { type: 'string', maxLength: 4096 },
            tags: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 64 },
                maxItems: 32,
            },
            content: { type: 'string' },
            argsSchema: { type: 'object' },
            status: {
                type: 'string',
                enum: WRITABLE_STATUSES,
                description: 'Target status. Artifacts cannot be changed back to candidate.',
            },
        },
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_toolSave,
};

function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function library(deps) {
    if (deps && typeof deps.getToolLibrary === 'function') return deps.getToolLibrary();
    return (deps && deps.toolLibrary) || defaultLibrary();
}

function invalid(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}

function assertKnownKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter(function (key) {
        return allowed.indexOf(key) === -1;
    }).sort();
    if (unknown.length) throw new Error(label + ' contains unknown fields: ' + unknown.join(', '));
}

function timestamp(store, previous) {
    const now = Math.max(0, Math.floor(store.now()));
    return previous === undefined ? now : Math.max(now, previous + 1);
}

function createArtifact(input, context, store) {
    if (!isObject(input.create)) throw new Error('`create` must be an object');
    if (own(input, 'name')) throw new Error('`create` cannot be combined with `name`');
    if (UPDATE_KEYS.some(function (key) { return own(input, key); })) {
        throw new Error('`create` cannot be combined with update fields');
    }
    assertKnownKeys(input.create, CREATE_KEYS, '`create`');
    const missing = ['name', 'description', 'kind', 'content'].filter(function (key) {
        return !own(input.create, key);
    });
    if (missing.length) throw new Error('`create` is missing required fields: ' + missing.join(', '));
    if (CREATE_KINDS.indexOf(input.create.kind) === -1) {
        throw new Error('`create.kind` must be `jsx` or `prompt-skill`');
    }
    const createdAt = timestamp(store);
    const session = context && context.session ? context.session : {};
    const artifact = {
        schemaVersion: 1,
        id: 'user:' + crypto.randomUUID(),
        name: input.create.name,
        description: input.create.description,
        kind: input.create.kind,
        category: 'workflow',
        tags: own(input.create, 'tags') ? input.create.tags : [],
        compatibility: {},
        declaredRisk: input.create.kind === 'jsx' ? 'write' : 'read',
        source: {
            type: 'user',
            ref: 'ae_toolSave',
            client: typeof session.clientName === 'string' ? session.clientName : null,
            productVersion: null,
            provenance: {},
        },
        status: own(input, 'status') ? input.status : 'saved',
        verified: false,
        verification: null,
        content: input.create.content,
        argsSchema: own(input.create, 'argsSchema') ? input.create.argsSchema : {},
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        lastUsedAt: null,
    };
    artifact.contentHash = computeContentHash(artifact.kind, artifact.content, artifact.argsSchema);
    return { artifact: validateArtifact(artifact), operation: 'create', original: null };
}

function assertWritable(artifact) {
    if (artifact.id.indexOf('builtin:skill:') === 0 || artifact.source.type === 'bundled') {
        throw new Error('Bundled artifacts are read-only; create a user artifact instead.');
    }
    if (artifact.id.indexOf('legacy:') === 0 || artifact.source.type === 'legacy') {
        throw new Error('Legacy artifacts are read-only; create a user artifact instead.');
    }
}

function updateArtifact(input, store) {
    if (typeof input.name !== 'string' || !input.name) {
        throw new Error('`name` must be a non-empty artifact id');
    }
    const current = store.resolveArtifact(input.name);
    assertWritable(current);
    const candidate = current.status === 'candidate';
    const updateFields = UPDATE_KEYS.filter(function (key) { return own(input, key); });
    if (candidate && (own(input, 'content') || own(input, 'argsSchema'))) {
        throw new Error('Candidate promotion accepts only `newName`, `description`, `tags`, and `status`.');
    }
    if (!candidate && updateFields.length === 0 && !own(input, 'status')) {
        throw new Error('Only candidate artifacts can be promoted with `name` alone; provide an update or status.');
    }
    const operation = candidate ? 'promote' : updateFields.length ? 'update' : 'status';
    const artifact = Object.assign({}, current, {
        name: own(input, 'newName') ? input.newName : current.name,
        description: own(input, 'description') ? input.description : current.description,
        tags: own(input, 'tags') ? input.tags : current.tags,
        content: own(input, 'content') ? input.content : current.content,
        argsSchema: own(input, 'argsSchema') ? input.argsSchema : current.argsSchema,
        status: own(input, 'status') ? input.status : candidate ? 'saved' : current.status,
        revision: current.revision + 1,
        updatedAt: timestamp(store, current.updatedAt),
    });
    artifact.contentHash = computeContentHash(artifact.kind, artifact.content, artifact.argsSchema);
    return { artifact: validateArtifact(artifact), operation, original: current };
}

function prepare(args, context, store) {
    const input = args || {};
    if (!isObject(input)) throw new Error('arguments must be an object');
    assertKnownKeys(input, TOP_LEVEL_KEYS, 'arguments');
    if (own(input, 'status') && WRITABLE_STATUSES.indexOf(input.status) === -1) {
        if (input.status === 'candidate') {
            throw new Error('`status` cannot be changed back to `candidate`');
        }
        throw new Error('`status` must be saved, pinned, archived, or deprecated');
    }
    if (own(input, 'create')) return createArtifact(input, context, store);
    return updateArtifact(input, store);
}

function approvalArguments(prepared) {
    return Object.assign({ operation: prepared.operation }, prepared.artifact);
}

async function call(args, context, deps) {
    try {
        const store = library(deps);
        const prepared = prepare(args, context, store);
        assertSecretFree(prepared.artifact, 'artifact.json');
        const denied = await enforce('ae_toolSave', Object.assign({}, context, {
            arguments: approvalArguments(prepared),
        }), deps);
        if (denied) return { result: textResult(denied, true) };
        if (prepared.original) {
            const current = store.getArtifact(prepared.original.id);
            if (canonicalJson(current) !== canonicalJson(prepared.original)) {
                throw new Error('Artifact changed during approval; inspect it and retry.');
            }
        }
        const saved = store.saveArtifact(prepared.artifact);
        return { result: textResult({ ok: true, artifact: store.summaryFromArtifact(saved) }) };
    } catch (error) {
        return invalid(error && error.message ? error.message : String(error));
    }
}

module.exports = { definition, call };
