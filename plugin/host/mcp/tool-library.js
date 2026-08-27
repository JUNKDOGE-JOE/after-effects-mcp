'use strict';

// Persistent Tool Library compatible with the Python-era ~/.ae-mcp layout.
// Execution is intentionally small: stored JSX is validated, rendered,
// approval-bound, and submitted through the host's existing JSX bridge.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStatePaths } = require('../state-paths');
const { canonicalJson } = require('./canonical-json');

const ARTIFACT_KEYS = [
    'schemaVersion', 'id', 'name', 'description', 'kind', 'category', 'tags',
    'compatibility', 'declaredRisk', 'source', 'status', 'verified',
    'verification', 'content', 'argsSchema', 'contentHash', 'revision',
    'createdAt', 'updatedAt', 'lastUsedAt',
];
const ARTIFACT_KINDS = new Set([
    'jsx', 'expression', 'prompt-skill', 'recipe', 'diagnostic', 'system-command',
]);
const ARTIFACT_STATUSES = new Set(['candidate', 'saved', 'pinned', 'archived', 'deprecated']);
const ARTIFACT_RISKS = new Set(['read', 'write', 'destructive', 'external']);
const SOURCE_TYPES = new Set(['user', 'legacy', 'bundled', 'chat-tool-call', 'imported']);
const ARGS_ROOT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties']);
const ARGS_VALUE_KEYS = new Set([
    'type', 'enum', 'default', 'description', 'minimum', 'maximum', 'minLength', 'maxLength',
]);
const ARGS_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const USER_ID = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

const ENVIRONMENT = {};
Object.defineProperties(ENVIRONMENT, {
    home: { enumerable: true, get: function () { return createStatePaths().stateDir; } },
    toolRoot: { enumerable: true, get: function () { return createStatePaths().tools; } },
    skillRoot: { enumerable: true, get: function () { return createStatePaths().skills; } },
});
Object.freeze(ENVIRONMENT);

function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finiteJson(value, label) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error((label || 'value') + ' JSON numbers must be finite');
        return value;
    }
    if (Array.isArray(value)) return value.map(function (item) { return finiteJson(item, label); });
    if (!isObject(value)) throw new Error((label || 'value') + ' is not a JSON value');
    const result = {};
    Object.keys(value).forEach(function (key) {
        result[key] = finiteJson(value[key], label);
    });
    return result;
}

function hash(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function computeContentHash(kind, content, argsSchema) {
    if (!ARTIFACT_KINDS.has(kind)) throw new Error('unsupported artifact kind: ' + String(kind));
    return hash({
        kind,
        content: finiteJson(content, 'content'),
        argsSchema: finiteJson(argsSchema, 'argsSchema'),
    });
}

function exactKeys(value, expected, label) {
    if (!isObject(value)) throw new Error(label + ' must be an object');
    const keys = Object.keys(value);
    const unknown = keys.filter(function (key) { return expected.indexOf(key) === -1; }).sort();
    const missing = expected.filter(function (key) { return !own(value, key); }).sort();
    if (unknown.length) throw new Error(label + ' contains unknown keys: ' + unknown.join(', '));
    if (missing.length) throw new Error(label + ' is missing keys: ' + missing.join(', '));
}

function boundedString(value, label, maximum, nonEmpty) {
    if (typeof value !== 'string') throw new Error(label + ' must be a string');
    const normalized = value.normalize('NFC');
    if (nonEmpty && !normalized) throw new Error(label + ' must not be empty');
    if (Array.from(normalized).length > maximum) {
        throw new Error(label + ' exceeds ' + maximum + ' characters');
    }
    return normalized;
}

function nonNegativeInteger(value, label, minimum) {
    if (!Number.isInteger(value) || value < (minimum || 0)) {
        throw new Error(label + ' must be an integer >= ' + String(minimum || 0));
    }
    return value;
}

function validateArgsSchema(value) {
    const schema = finiteJson(value, 'argsSchema');
    if (!isObject(schema)) throw new Error('argsSchema must be an object');
    const canonical = own(schema, 'properties') || own(schema, 'required')
        || own(schema, 'additionalProperties') || schema.type === 'object';
    const properties = canonical ? (schema.properties === undefined ? {} : schema.properties) : schema;
    if (canonical) {
        const unknown = Object.keys(schema).filter(function (key) {
            return !ARGS_ROOT_KEYS.has(key);
        }).sort();
        if (unknown.length) {
            throw new Error('argsSchema contains unsupported keywords: ' + unknown.join(', '));
        }
        if (schema.type !== undefined && schema.type !== 'object') {
            throw new Error('argsSchema root type must be object');
        }
        if (!isObject(properties)) throw new Error('argsSchema properties must be an object');
        if (schema.required !== undefined && (!Array.isArray(schema.required)
            || schema.required.some(function (item) { return typeof item !== 'string'; })
            || new Set(schema.required).size !== schema.required.length)) {
            throw new Error('argsSchema required must be an array of unique strings');
        }
        if (schema.required && schema.required.some(function (item) { return !own(properties, item); })) {
            throw new Error('argsSchema required references unknown properties');
        }
        if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
            throw new Error('argsSchema additionalProperties must be a boolean');
        }
    }
    Object.keys(properties).forEach(function (name) {
        const rule = properties[name];
        if (!name) throw new Error('argsSchema property names must be non-empty strings');
        if (!isObject(rule)) throw new Error('argsSchema property ' + name + ' must be an object');
        const unknown = Object.keys(rule).filter(function (key) { return !ARGS_VALUE_KEYS.has(key); }).sort();
        if (unknown.length) throw new Error(
            'argsSchema property ' + name + ' contains unsupported keywords: ' + unknown.join(', '),
        );
        if (own(rule, 'description')) boundedString(rule.description, 'argsSchema property ' + name, 1024);
        if (own(rule, 'type') && !ARGS_TYPES.has(rule.type)) {
            throw new Error('argsSchema property ' + name + ' has unsupported type');
        }
        if (own(rule, 'enum') && (!Array.isArray(rule.enum) || !rule.enum.length)) {
            throw new Error('argsSchema property ' + name + ' enum must be non-empty');
        }
        if (own(rule, 'enum')) finiteJson(rule.enum, 'argsSchema property ' + name + ' enum');
        if (own(rule, 'default')) finiteJson(rule.default, 'argsSchema property ' + name + ' default');
        ['minimum', 'maximum'].forEach(function (key) {
            if (own(rule, key) && (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]))) {
                throw new Error('argsSchema property ' + name + ' ' + key + ' must be a number');
            }
        });
        ['minLength', 'maxLength'].forEach(function (key) {
            if (own(rule, key) && (!Number.isInteger(rule[key]) || rule[key] < 0)) {
                throw new Error(
                    'argsSchema property ' + name + ' ' + key + ' must be a non-negative integer',
                );
            }
        });
        if (own(rule, 'minimum') && own(rule, 'maximum') && rule.minimum > rule.maximum) {
            throw new Error('argsSchema property ' + name + ' has inverted numeric bounds');
        }
        if (own(rule, 'minLength') && own(rule, 'maxLength') && rule.minLength > rule.maxLength) {
            throw new Error('argsSchema property ' + name + ' has inverted length bounds');
        }
    });
    return schema;
}

function validateContent(kind, value) {
    if (['jsx', 'expression', 'prompt-skill', 'system-command'].indexOf(kind) >= 0) {
        if (typeof value !== 'string') throw new Error(kind + ' content must be a string');
        return value;
    }
    if (!isObject(value)) throw new Error(kind + ' content must be an object');
    if (kind === 'diagnostic') {
        exactKeys(value, ['capability', 'args'], 'diagnostic content');
        boundedString(value.capability, 'diagnostic capability', 256, true);
        if (!isObject(value.args)) throw new Error('diagnostic args must be an object');
        return finiteJson(value, 'diagnostic content');
    }
    exactKeys(value, ['steps'], 'recipe content');
    if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 64) {
        throw new Error('recipe steps must contain between 1 and 64 entries');
    }
    value.steps.forEach(function (step, index) {
        exactKeys(step, ['refType', 'ref', 'operation', 'args', 'target'], 'recipe step ' + index);
        if (step.refType !== 'artifact' && step.refType !== 'tool') {
            throw new Error('recipe step refType is unsupported');
        }
        boundedString(step.ref, 'recipe step ' + index + ' ref', 512, true);
        if (!isObject(step.args) || !isObject(step.target)) {
            throw new Error('recipe step args and target must be objects');
        }
        if (step.refType === 'artifact' && ['render', 'execute', 'apply'].indexOf(step.operation) < 0) {
            throw new Error('recipe artifact step operation is unsupported');
        }
        if (step.refType === 'tool' && step.operation !== 'call') {
            throw new Error('recipe tool step operation must be call');
        }
        if (step.refType === 'tool' && (step.ref === 'ae.exec' || step.ref === 'ae.skillUse'
            || /^ae\.tool/i.test(step.ref))) {
            throw new Error('recipe recursive tool reference is forbidden: ' + step.ref);
        }
    });
    return finiteJson(value, 'recipe content');
}

function validateArtifact(value) {
    exactKeys(value, ARTIFACT_KEYS, 'artifact');
    if (value.schemaVersion !== 1) throw new Error('unsupported artifact schemaVersion');
    if (!ARTIFACT_KINDS.has(value.kind)) throw new Error('artifact kind is unsupported');
    if (!ARTIFACT_STATUSES.has(value.status)) throw new Error('artifact status is unsupported');
    if (!ARTIFACT_RISKS.has(value.declaredRisk)) throw new Error('artifact declaredRisk is unsupported');
    if (value.kind === 'system-command' && value.declaredRisk !== 'external') {
        throw new Error('system-command artifacts must declare external risk');
    }
    boundedString(value.id, 'artifact id', 256, true);
    boundedString(value.name, 'artifact name', 128, true);
    boundedString(value.description, 'artifact description', 4096);
    boundedString(value.category, 'artifact category', 128, true);
    if (!Array.isArray(value.tags) || value.tags.length > 32) {
        throw new Error('artifact tags must be an array');
    }
    value.tags.forEach(function (tag) { boundedString(tag, 'artifact tag', 64, true); });
    if (new Set(value.tags).size !== value.tags.length) throw new Error('artifact tags must be unique');
    if (!isObject(value.compatibility)) throw new Error('compatibility must be an object');
    finiteJson(value.compatibility, 'compatibility');
    exactKeys(value.source, ['type', 'ref', 'client', 'productVersion', 'provenance'], 'source');
    if (!SOURCE_TYPES.has(value.source.type)) throw new Error('source type is unsupported');
    boundedString(value.source.ref, 'source.ref', 4096, true);
    if (value.source.client !== null) boundedString(value.source.client, 'source.client', 256);
    if (value.source.productVersion !== null) {
        boundedString(value.source.productVersion, 'source.productVersion', 128);
    }
    if (!isObject(value.source.provenance)) throw new Error('source.provenance must be an object');
    if (typeof value.verified !== 'boolean') throw new Error('artifact verified must be a boolean');
    if ((value.verified && value.verification === null) || (!value.verified && value.verification !== null)) {
        throw new Error('artifact verification state is invalid');
    }
    if (value.verification !== null) {
        exactKeys(value.verification, ['method', 'verifiedAt', 'evidenceHash'], 'verification');
        if (['signed-manifest', 'content-hash', 'user-reviewed'].indexOf(value.verification.method) < 0) {
            throw new Error('verification method is unsupported');
        }
        nonNegativeInteger(value.verification.verifiedAt, 'verification.verifiedAt');
        if (value.verification.evidenceHash !== null && !SHA256.test(value.verification.evidenceHash)) {
            throw new Error('verification evidenceHash must be a SHA-256 hex digest or null');
        }
    }
    validateContent(value.kind, value.content);
    validateArgsSchema(value.argsSchema);
    if (typeof value.contentHash !== 'string' || !SHA256.test(value.contentHash)) {
        throw new Error('artifact contentHash must be a lowercase SHA-256 digest');
    }
    if (value.contentHash !== computeContentHash(value.kind, value.content, value.argsSchema)) {
        throw new Error('artifact contentHash does not match content and argsSchema');
    }
    nonNegativeInteger(value.revision, 'artifact revision', 1);
    nonNegativeInteger(value.createdAt, 'artifact createdAt');
    nonNegativeInteger(value.updatedAt, 'artifact updatedAt');
    if (value.lastUsedAt !== null) nonNegativeInteger(value.lastUsedAt, 'artifact lastUsedAt');
    return finiteJson(value, 'artifact');
}

function sensitiveName(value) {
    const raw = String(value || '').trim();
    const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (compact === 'idempotencykey' || compact === 'operationkey' || compact === 'sessionid') return false;
    if (['apikey', 'auth', 'authentication', 'authorization', 'cookie', 'credential', 'credentials',
        'key', 'oauth', 'passwd', 'password', 'secret', 'session', 'signature',
        'token'].indexOf(compact) >= 0) {
        return true;
    }
    if (/(apikey|auth|cookie|credential|oauth|passwd|password|secret|session|signature|token)/
        .test(compact)) {
        return true;
    }
    const allowedPrefix = /(?:api|access|client|credential|private|provider|public|secret|x)$/;
    return compact.endsWith('key') && allowedPrefix.test(compact.slice(0, -3));
}

function containsCredential(value) {
    if (typeof value === 'string') return Boolean(value);
    if (Array.isArray(value)) return value.some(containsCredential);
    if (isObject(value)) {
        return Object.keys(value).some(function (key) { return containsCredential(value[key]); });
    }
    return value !== null;
}

function assertSecretFree(value, name) {
    const text = typeof value === 'string' ? value : canonicalJson(value);
    if (Buffer.byteLength(text, 'utf8') > MAX_SCAN_BYTES) throw new Error('secret scanner failed closed');
    const patterns = [
        /(?:^|\n)[ \t]*authorization[ \t]*:[ \t]*(?:bearer|basic)[ \t]+[^\s]+/i,
        /(?:^|\n)[ \t]*(?:x[-_]api[-_]key|api[-_]key)[ \t]*:[ \t]*[^\s]+/i,
        /(?:^|\n)[ \t]*(?:cookie|set-cookie)[ \t]*:[ \t]*[^\r\n]+/i,
        /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/,
        /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
        /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/,
    ];
    const credentialAssignment = new RegExp([
        "(?<![A-Za-z0-9_.-])['\"]?([A-Za-z][A-Za-z0-9_.-]*)['\"]?[ \\t]*[:=][ \\t]*",
        "(?:['\"][^'\"\\r\\n]+['\"]|[^'\"\\s,;&{}\\[\\]]+)",
    ].join(''), 'gm');
    function hasCredentialAssignment(current) {
        credentialAssignment.lastIndex = 0;
        let match = credentialAssignment.exec(current);
        while (match) {
            if (sensitiveName(match[1])) return true;
            match = credentialAssignment.exec(current);
        }
        return false;
    }
    if (patterns.some(function (pattern) { return pattern.test(text); })) {
        throw new Error('secret-shaped content detected in ' + name);
    }
    if (hasCredentialAssignment(text)) throw new Error('secret-shaped content detected in ' + name);
    function visit(current) {
        if (typeof current === 'string') {
            if (patterns.some(function (pattern) { return pattern.test(current); })
                || hasCredentialAssignment(current)) {
                throw new Error('secret-shaped content detected in ' + name);
            }
        } else if (isObject(current)) {
            Object.keys(current).forEach(function (key) {
                if (sensitiveName(key) && containsCredential(current[key])) {
                    throw new Error('secret-shaped content detected in ' + name);
                }
                visit(current[key]);
            });
        } else if (Array.isArray(current)) current.forEach(visit);
    }
    if (typeof value !== 'string') visit(value);
}

function atomicWrite(filePath, text) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, '.' + path.basename(filePath) + '.' + process.pid + '.'
        + crypto.randomBytes(8).toString('hex') + '.tmp');
    try {
        fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filePath);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function normalizeArgs(schema, supplied) {
    if (!isObject(supplied)) throw new Error('args must be an object');
    const validated = validateArgsSchema(schema);
    const canonical = own(validated, 'properties') || own(validated, 'required')
        || own(validated, 'additionalProperties') || validated.type === 'object';
    const properties = canonical ? (validated.properties || {}) : validated;
    const required = canonical ? new Set(validated.required || []) : new Set();
    const additional = canonical ? validated.additionalProperties !== false : true;
    const unknown = Object.keys(supplied).filter(function (key) { return !own(properties, key); });
    if (unknown.length && !additional) throw new Error('Unknown arguments: ' + unknown.sort().join(', '));
    const result = finiteJson(supplied, 'args');
    Object.keys(properties).forEach(function (name) {
        const rule = properties[name];
        if (!own(result, name) && own(rule, 'default')) result[name] = finiteJson(rule.default, name);
        if (!own(result, name)) return;
        const item = result[name];
        const type = rule.type;
        const matches = type === undefined || (type === 'null' && item === null)
            || (type === 'array' && Array.isArray(item)) || (type === 'object' && isObject(item))
            || (type === 'integer' && Number.isInteger(item))
            || (type === 'number' && typeof item === 'number' && Number.isFinite(item))
            || (type === 'boolean' && typeof item === 'boolean')
            || (type === 'string' && typeof item === 'string');
        if (!matches) throw new Error('Argument ' + name + ' has the wrong type.');
        if (rule.enum && !rule.enum.some(function (choice) {
            return canonicalJson(choice) === canonicalJson(item);
        })) {
            throw new Error('Argument ' + name + ' is outside its enum.');
        }
        if (typeof item === 'number' && own(rule, 'minimum') && item < rule.minimum) {
            throw new Error('Argument ' + name + ' is below its minimum.');
        }
        if (typeof item === 'number' && own(rule, 'maximum') && item > rule.maximum) {
            throw new Error('Argument ' + name + ' exceeds its maximum.');
        }
        if (typeof item === 'string' && own(rule, 'minLength') && Array.from(item).length < rule.minLength) {
            throw new Error('Argument ' + name + ' is too short.');
        }
        if (typeof item === 'string' && own(rule, 'maxLength') && Array.from(item).length > rule.maxLength) {
            throw new Error('Argument ' + name + ' is too long.');
        }
    });
    const missing = Array.from(required).filter(function (name) { return !own(result, name); }).sort();
    if (missing.length) throw new Error('Missing required arguments: ' + missing.join(', '));
    return finiteJson(result, 'args');
}

function renderText(content, args, prompt) {
    const placeholders = new Set();
    String(content).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (_all, name) {
        placeholders.add(name);
        return _all;
    });
    const missing = Array.from(placeholders).filter(function (name) { return !own(args, name); }).sort();
    if (missing.length) throw new Error('Missing template arguments: ' + missing.join(', '));
    return String(content).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (_all, name) {
        return prompt ? String(args[name]) : canonicalJson(args[name]);
    });
}

function skillFromWire(wire) {
    if (!isObject(wire) || !SKILL_NAME.test(String(wire.name || '')) || typeof wire.template !== 'string') {
        throw new Error('invalid skill');
    }
    return {
        name: wire.name,
        description: typeof wire.description === 'string' ? wire.description : '',
        template_type: typeof wire.template_type === 'string' ? wire.template_type : 'jsx',
        template: wire.template,
        args_schema: isObject(wire.args_schema) ? wire.args_schema : {},
    };
}

function skillRecordFromArtifact(artifact) {
    const source = artifact.source.type === 'bundled' ? 'bundled'
        : artifact.source.type === 'legacy' ? 'user' : 'library';
    return {
        skill: {
            name: artifact.name,
            description: artifact.description,
            template_type: artifact.kind === 'jsx' ? 'jsx' : 'prompt',
            template: artifact.content,
            args_schema: artifact.argsSchema,
        },
        source,
        path: artifact.source.ref,
        artifact,
    };
}

function skillArgs(schema) {
    const canonical = own(schema, 'properties') || own(schema, 'required')
        || own(schema, 'additionalProperties') || schema.type === 'object';
    return Object.keys(canonical ? (schema.properties || {}) : schema).sort();
}

class ToolLibrary {
    constructor(options) {
        const input = options || {};
        const statePaths = input.statePaths || createStatePaths({
            stateDir: input.stateDir,
            env: input.env,
            home: input.home,
            homedir: input.homedir,
            toolDir: input.toolRoot,
            skillDir: input.skillRoot,
        });
        this.toolRoot = path.resolve(input.toolRoot || statePaths.tools);
        this.skillRoot = path.resolve(input.skillRoot || statePaths.skills);
        this.bundledRoot = input.bundledRoot || path.join(__dirname, 'skills_bundled');
        this.indexPath = path.join(this.toolRoot, 'index.json');
        this.artifactsRoot = path.join(this.toolRoot, 'artifacts');
        this.now = input.now || function () { return Date.now(); };
        fs.mkdirSync(this.artifactsRoot, { recursive: true, mode: 0o700 });
        fs.mkdirSync(this.skillRoot, { recursive: true, mode: 0o700 });
    }

    artifactPath(id) {
        const match = USER_ID.exec(id || '');
        if (!match) throw new Error('tool not found');
        return path.join(this.artifactsRoot, match[1] + '.json');
    }

    readJson(filePath, label) {
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            throw new Error('tool store is corrupt');
        }
        assertSecretFree(text, label);
        let value;
        try { value = JSON.parse(text); } catch (error) { throw new Error('tool store is corrupt'); }
        assertSecretFree(value, label);
        return value;
    }

    readIndex() {
        if (!fs.existsSync(this.indexPath)) return { schemaVersion: 1, revision: 0, artifacts: [] };
        const index = this.readJson(this.indexPath, 'index.json');
        if (!isObject(index) || index.schemaVersion !== 1 || !Number.isInteger(index.revision)
            || index.revision < 0 || !Array.isArray(index.artifacts)) {
            throw new Error('tool store is corrupt');
        }
        index.artifacts.forEach(function (entry) {
            if (!isObject(entry)) throw new Error('tool store is corrupt');
        });
        return index;
    }

    summaryFromArtifact(artifact) {
        return {
            id: artifact.id,
            name: artifact.name,
            description: artifact.description,
            kind: artifact.kind,
            category: artifact.category,
            tags: artifact.tags.slice(),
            status: artifact.status,
            verified: artifact.verified,
            declaredRisk: artifact.declaredRisk,
            contentHash: artifact.contentHash,
            revision: artifact.revision,
            updatedAt: artifact.updatedAt,
            lastUsedAt: artifact.lastUsedAt,
            sourceType: artifact.source.type,
        };
    }

    saveArtifact(wire) {
        const artifact = validateArtifact(wire);
        assertSecretFree(artifact, 'artifact.json');
        const artifactPath = this.artifactPath(artifact.id);
        const index = this.readIndex();
        const artifacts = index.artifacts.filter(function (entry) { return entry.id !== artifact.id; });
        artifacts.push(this.summaryFromArtifact(artifact));
        const next = { schemaVersion: 1, revision: index.revision + 1, artifacts };
        assertSecretFree(next, 'index.json');
        const before = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf8') : null;
        try {
            atomicWrite(artifactPath, canonicalJson(artifact) + '\n');
            atomicWrite(this.indexPath, canonicalJson(next) + '\n');
        } catch (error) {
            if (before === null) {
                if (fs.existsSync(artifactPath)) fs.unlinkSync(artifactPath);
            } else atomicWrite(artifactPath, before);
            throw error;
        }
        return artifact;
    }

    removeArtifact(id) {
        const artifactPath = this.artifactPath(id);
        const index = this.readIndex();
        const entry = index.artifacts.find(function (item) { return item.id === id; });
        if (!entry) return false;
        let before;
        try { before = fs.readFileSync(artifactPath, 'utf8'); } catch (error) {
            throw new Error('tool store is corrupt');
        }
        const next = {
            schemaVersion: 1,
            revision: index.revision + 1,
            artifacts: index.artifacts.filter(function (item) { return item.id !== id; }),
        };
        assertSecretFree(next, 'index.json');
        fs.unlinkSync(artifactPath);
        try {
            atomicWrite(this.indexPath, canonicalJson(next) + '\n');
        } catch (error) {
            atomicWrite(artifactPath, before);
            throw error;
        }
        return true;
    }

    getArtifact(id) {
        const index = this.readIndex();
        const entry = index.artifacts.find(function (item) { return item.id === id; });
        if (!entry) {
            const legacy = this.legacyArtifacts().find(function (artifact) {
                return artifact.id === id;
            });
            if (!legacy) throw new Error('tool not found');
            return legacy;
        }
        const artifact = validateArtifact(this.readJson(this.artifactPath(id), 'artifact.json'));
        if (canonicalJson(this.summaryFromArtifact(artifact)) !== canonicalJson(entry)) {
            throw new Error('tool store is corrupt');
        }
        return artifact;
    }

    resolveArtifact(name) {
        try {
            return this.getArtifact(name);
        } catch (error) {
            const matches = this.allSummaries().filter(function (item) { return item.name === name; });
            if (matches.length !== 1) throw error;
            return this.getArtifact(matches[0].id);
        }
    }

    list(options) {
        const input = options || {};
        const statuses = input.statuses || null;
        return this.readIndex().artifacts.filter(function (item) {
            return !statuses || statuses.indexOf(item.status) >= 0;
        }).sort(function (left, right) {
            return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
        });
    }

    search(query, options) {
        const input = options || {};
        const needle = String(query || '').trim().toLocaleLowerCase();
        const rows = this.list({ statuses: input.statuses || null }).filter(function (item) {
            const haystack = [item.name, item.description, item.category].concat(item.tags)
                .join(' ').toLowerCase();
            return !needle || haystack.indexOf(needle) >= 0;
        });
        const offset = input.offset || 0;
        const limit = input.limit || 50;
        return { artifacts: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
    }

    findByContentHash(kind, contentHash) {
        return this.allSummaries().filter(function (item) {
            return item.kind === kind && item.contentHash === contentHash;
        });
    }

    readSkillDirectory(root, source) {
        if (!fs.existsSync(root)) return [];
        return fs.readdirSync(root).filter(function (name) {
            return name.endsWith('.json') && !(source === 'bundled' && name === 'manifest.json');
        }).sort().map(function (name) {
            try {
                const skill = skillFromWire(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
                return { skill, source, path: path.join(root, name) };
            } catch (error) { return null; }
        }).filter(Boolean);
    }

    listSkills() {
        const merged = new Map();
        // Apply sources from least to most authoritative so collisions always
        // resolve library prompt-skill > legacy user directory > bundled skill.
        this.readSkillDirectory(this.bundledRoot, 'bundled').forEach(function (record) {
            merged.set(record.skill.name, record);
        });
        this.readSkillDirectory(this.skillRoot, 'user').forEach(function (record) {
            merged.set(record.skill.name, record);
        });
        this.list({ statuses: ['saved', 'pinned'] }).filter(function (summary) {
            return summary.kind === 'prompt-skill';
        }).reverse().forEach(function (summary) {
            const artifact = this.getArtifact(summary.id);
            merged.set(artifact.name, skillRecordFromArtifact(artifact));
        }, this);
        return Array.from(merged.values()).sort(function (left, right) {
            return left.skill.name.localeCompare(right.skill.name);
        });
    }

    allSkillRecords() {
        return this.readSkillDirectory(this.bundledRoot, 'bundled').concat(
            this.readSkillDirectory(this.skillRoot, 'user'),
        );
    }

    bundledManifest() {
        const manifestPath = path.join(this.bundledRoot, 'manifest.json');
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (!isObject(manifest) || manifest.schemaVersion !== 1
                || typeof manifest.productVersion !== 'string' || !Array.isArray(manifest.artifacts)) {
                throw new Error('invalid bundled skill manifest');
            }
            return manifest;
        } catch (error) {
            throw new Error('bundled skill manifest is invalid');
        }
    }

    legacyArtifacts() {
        const manifest = this.bundledManifest();
        const hashes = new Map(manifest.artifacts.map(function (item) {
            return [item.path, item.sha256];
        }));
        return this.allSkillRecords().map(function (record) {
            const skill = record.skill;
            const kind = skill.template_type === 'jsx' ? 'jsx' : 'prompt-skill';
            if (skill.template_type !== 'jsx' && skill.template_type !== 'prompt') {
                throw new Error('legacy skill template type is unsupported');
            }
            const contentHash = computeContentHash(kind, skill.template, skill.args_schema);
            const info = fs.statSync(record.path);
            const createdAt = Math.max(0, Math.floor(info.birthtimeMs));
            const updatedAt = Math.max(0, Math.floor(info.mtimeMs));
            const bundled = record.source === 'bundled';
            const digest = bundled ? hashes.get(path.basename(record.path)) : null;
            if (bundled && (!SHA256.test(digest || '') || crypto.createHash('sha256')
                .update(fs.readFileSync(record.path)).digest('hex') !== digest)) {
                throw new Error('bundled skill manifest is invalid');
            }
            const artifact = {
                schemaVersion: 1,
                id: bundled ? 'builtin:skill:' + skill.name : 'legacy:'
                    + crypto.createHash('sha256').update(path.resolve(record.path).normalize('NFC'), 'utf8')
                        .digest('hex').slice(0, 24),
                name: skill.name,
                description: skill.description,
                kind,
                category: 'workflow',
                tags: [],
                compatibility: {},
                declaredRisk: kind === 'jsx' ? 'write' : 'read',
                source: {
                    type: bundled ? 'bundled' : 'legacy',
                    ref: path.resolve(record.path),
                    client: null,
                    productVersion: bundled ? manifest.productVersion : null,
                    provenance: bundled ? { manifestSha256: digest } : { contentHash },
                },
                status: 'saved',
                verified: bundled,
                verification: bundled ? {
                    method: 'signed-manifest',
                    verifiedAt: 0,
                    evidenceHash: digest,
                } : null,
                content: skill.template,
                argsSchema: skill.args_schema,
                contentHash,
                revision: 1,
                createdAt,
                updatedAt,
                lastUsedAt: null,
            };
            assertSecretFree(artifact, 'legacy-artifact.json');
            return validateArtifact(artifact);
        });
    }

    allSummaries() {
        const native = this.list();
        const legacy = this.legacyArtifacts().map(this.summaryFromArtifact.bind(this));
        return native.concat(legacy).sort(function (left, right) {
            return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
        });
    }

    searchAll(query, options) {
        const input = options || {};
        const needle = String(query || '').trim().toLowerCase();
        const rows = this.allSummaries().filter(function (item) {
            const haystack = [item.name, item.description, item.category].concat(item.tags)
                .join(' ').toLowerCase();
            return (!needle || haystack.indexOf(needle) >= 0)
                && (!input.statuses || input.statuses.indexOf(item.status) >= 0);
        });
        const offset = input.offset || 0;
        const limit = input.limit || 50;
        return { artifacts: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
    }

    resolveSkill(name) {
        const identifier = String(name || '');
        if (/^(?:user|legacy|builtin:skill):/.test(identifier)) {
            const artifact = this.getArtifact(identifier);
            const active = artifact.status === 'saved' || artifact.status === 'pinned';
            const libraryPrompt = artifact.source.type === 'user' && artifact.kind === 'prompt-skill';
            const directorySkill = (artifact.source.type === 'bundled' || artifact.source.type === 'legacy')
                && (artifact.kind === 'jsx' || artifact.kind === 'prompt-skill');
            if (!active || (!libraryPrompt && !directorySkill)) {
                throw new Error('skill not found: ' + identifier);
            }
            return skillRecordFromArtifact(artifact);
        }
        const normalized = identifier.replace(/^builtin:skill:/, '');
        if (!normalized) throw new Error('invalid skill name');
        const record = this.listSkills().find(function (item) { return item.skill.name === normalized; });
        if (!record) {
            if (!SKILL_NAME.test(normalized)) throw new Error('invalid skill name');
            throw new Error('skill not found: ' + normalized);
        }
        return record;
    }

    writeSkill(wire) {
        const skill = skillFromWire(wire);
        atomicWrite(path.join(this.skillRoot, skill.name + '.json'), JSON.stringify(skill, null, 2) + '\n');
        return skill;
    }

    skillMeta(record, includeTemplate) {
        const meta = {
            name: record.skill.name,
            description: record.skill.description,
            template_type: record.skill.template_type,
            args: skillArgs(record.skill.args_schema),
            source: record.source,
        };
        if (includeTemplate) {
            meta.template = record.skill.template;
            meta.args_schema = record.skill.args_schema;
        }
        return meta;
    }

    plan(id, args) {
        const artifact = this.resolveArtifact(id);
        if (artifact.kind !== 'jsx') throw new Error('only JSX tools can execute in the CEP host');
        const normalizedArgs = normalizeArgs(artifact.argsSchema, args || {});
        const plan = {
            artifactId: artifact.id,
            contentHash: artifact.contentHash,
            operation: 'execute',
            normalizedArgs,
            normalizedTarget: {},
            dependencyHashes: [],
            risk: artifact.declaredRisk,
        };
        plan.planHash = hash(plan);
        return plan;
    }

    assertPlanCurrent(plan) {
        const current = this.plan(plan.artifactId, plan.normalizedArgs);
        if (current.planHash !== plan.planHash || current.contentHash !== plan.contentHash) {
            throw new Error('tool changed after approval');
        }
        return current;
    }

    consumePlan(plan) {
        // First binding check: approval consumption sees the disk state that is
        // current after the awaitable approval UI has returned.
        return this.assertPlanCurrent(plan);
    }

    renderPlan(plan) {
        const current = this.assertPlanCurrent(plan);
        const artifact = this.getArtifact(current.artifactId);
        return renderText(artifact.content, current.normalizedArgs, false);
    }
}

let singleton;
function defaultLibrary(options) {
    if (!singleton) singleton = new ToolLibrary(options);
    return singleton;
}

module.exports = {
    ENVIRONMENT,
    ToolLibrary,
    assertSecretFree,
    canonicalJson,
    computeContentHash,
    defaultLibrary,
    normalizeArgs,
    renderText,
    validateArgsSchema,
    validateArtifact,
};
