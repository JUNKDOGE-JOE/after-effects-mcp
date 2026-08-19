'use strict';

// ae_read — structured, read-only reflection through the persistent AE JSX
// engine. The host validates the closed request shape and the result envelope;
// the JSX template owns traversal, filtering, ordering, and pagination.

const fs = require('fs');
const path = require('path');
const { textResult } = require('../tool-result');

const TEMPLATE_DIR = path.join(__dirname, '../../../jsx/templates');
const TARGETS = ['project', 'comps', 'layers', 'properties', 'keyframes', 'compSettings'];
const SORTS = {
    project: ['name', 'type', 'id'],
    comps: ['name', 'type', 'id'],
    layers: ['stackIndex', 'name', 'inPoint', 'outPoint'],
    properties: ['propertyIndex', 'name', 'matchName'],
    keyframes: ['time'],
    compSettings: [],
};
const FILTERS = {
    project: ['nameContains', 'type'],
    comps: ['nameContains', 'type'],
    layers: ['nameContains', 'type', 'enabledOnly'],
    properties: ['nameContains', 'type', 'timeVaryingOnly', 'matchNamePrefix'],
    keyframes: [],
    compSettings: [],
};
const RESULT_ARRAYS = {
    project: 'items',
    comps: 'items',
    layers: 'layers',
    properties: 'properties',
    keyframes: 'keyframes',
};

const definition = {
    name: 'ae_read',
    description: 'Read one After Effects project, composition, layer, property tree, keyframe list, or composition settings view. Reads are paginated, sortable, filterable, and never create checkpoints, undo groups, or mutations.',
    inputSchema: {
        type: 'object',
        properties: {
            target: {
                type: 'string',
                enum: TARGETS,
                description: 'Target view. comp/layer/property selectors and depth/sampleTime are valid only for the target branches that use them.',
            },
            comp: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    index: { type: 'integer', minimum: 1 },
                },
                additionalProperties: false,
            },
            layer: {
                type: 'object',
                properties: {
                    index: { type: 'integer', minimum: 1 },
                    id: { type: 'string' },
                    name: { type: 'string' },
                },
                additionalProperties: false,
            },
            property: {
                type: 'object',
                properties: { matchPath: { type: 'string' } },
                additionalProperties: false,
            },
            page: {
                type: 'object',
                properties: {
                    offset: { type: 'integer', minimum: 0, default: 0 },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                },
                additionalProperties: false,
            },
            sort: {
                type: 'object',
                properties: {
                    by: { type: 'string' },
                    order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
                },
                additionalProperties: false,
            },
            filter: {
                type: 'object',
                properties: {
                    nameContains: { type: 'string' },
                    type: { type: 'string' },
                    enabledOnly: { type: 'boolean' },
                    timeVaryingOnly: { type: 'boolean' },
                    matchNamePrefix: { type: 'string' },
                },
                additionalProperties: false,
            },
            depth: { type: 'integer', minimum: 1, maximum: 8, default: 2 },
            sampleTime: { type: 'number', description: 'Seconds; valid only for properties.' },
            timeout_sec: { type: 'number', minimum: 1, maximum: 120, default: 30 },
        },
        required: ['target'],
        additionalProperties: false,
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
};

function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(error) {
    return { result: textResult({ ok: false, error: error }, true) };
}

function validateClosedObject(value, name, allowed) {
    if (!isObject(value)) return '`' + name + '` must be an object';
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
        if (allowed.indexOf(keys[i]) === -1) return '`' + name + '.' + keys[i] + '` is not supported';
    }
    return null;
}

function validateSelector(value, name, allowed) {
    if (value === undefined) return null;
    const closed = validateClosedObject(value, name, allowed);
    if (closed) return closed;
    if (value.id !== undefined && (typeof value.id !== 'string' || value.id.length === 0)) {
        return '`' + name + '.id` must be a non-empty string';
    }
    if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0)) {
        return '`' + name + '.name` must be a non-empty string';
    }
    if (value.index !== undefined && (!Number.isSafeInteger(value.index) || value.index < 1)) {
        return '`' + name + '.index` must be a positive integer';
    }
    return null;
}

function validateArgs(args) {
    if (!isObject(args)) return 'arguments must be an object';
    const allowed = ['target', 'comp', 'layer', 'property', 'page', 'sort', 'filter', 'depth', 'sampleTime', 'timeout_sec'];
    const closed = validateClosedObject(args, 'arguments', allowed);
    if (closed) return closed;
    if (TARGETS.indexOf(args.target) === -1) return '`target` must be one of: ' + TARGETS.join(', ');
    const target = args.target;

    let error = validateSelector(args.comp, 'comp', ['id', 'name', 'index']);
    if (error) return error;
    error = validateSelector(args.layer, 'layer', ['index', 'id', 'name']);
    if (error) return error;
    if (args.property !== undefined) {
        error = validateClosedObject(args.property, 'property', ['matchPath']);
        if (error) return error;
        if (args.property.matchPath !== undefined
            && (typeof args.property.matchPath !== 'string' || args.property.matchPath.length === 0)) {
            return '`property.matchPath` must be a non-empty string';
        }
    }

    const compTargets = ['layers', 'properties', 'keyframes', 'compSettings'];
    if (args.comp !== undefined && ['project', 'comps'].indexOf(target) !== -1) {
        return '`comp` is not valid for target `' + target + '`';
    }
    if (args.layer !== undefined && ['properties', 'keyframes'].indexOf(target) === -1) {
        return '`layer` is only valid for target `properties` or `keyframes`';
    }
    if (args.property !== undefined && ['properties', 'keyframes'].indexOf(target) === -1) {
        return '`property` is only valid for target `properties` or `keyframes`';
    }
    if (['properties', 'keyframes'].indexOf(target) !== -1 && args.layer === undefined) {
        return '`layer` is required for target `' + target + '`';
    }
    if (target === 'keyframes' && (!args.property || !args.property.matchPath)) {
        return '`property.matchPath` is required for target `keyframes`';
    }
    if (target === 'properties' && args.property && !args.property.matchPath) {
        return '`property.matchPath` must be a non-empty string';
    }
    if (args.depth !== undefined && (target !== 'properties' || !Number.isSafeInteger(args.depth) || args.depth < 1 || args.depth > 8)) {
        return target !== 'properties' ? '`depth` is only valid for target `properties`' : '`depth` must be an integer from 1 to 8';
    }
    if (args.sampleTime !== undefined && (target !== 'properties' || typeof args.sampleTime !== 'number' || !Number.isFinite(args.sampleTime))) {
        return target !== 'properties' ? '`sampleTime` is only valid for target `properties`' : '`sampleTime` must be a finite number';
    }
    if (args.timeout_sec !== undefined
        && (typeof args.timeout_sec !== 'number' || !Number.isFinite(args.timeout_sec) || args.timeout_sec < 1 || args.timeout_sec > 120)) {
        return '`timeout_sec` must be between 1 and 120';
    }

    const page = args.page === undefined ? {} : args.page;
    error = validateClosedObject(page, 'page', ['offset', 'limit']);
    if (error) return error;
    if (page.offset !== undefined && (!Number.isSafeInteger(page.offset) || page.offset < 0)) {
        return '`page.offset` must be a non-negative integer';
    }
    if (page.limit !== undefined && (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 200)) {
        return '`page.limit` must be between 1 and 200';
    }
    const sort = args.sort === undefined ? {} : args.sort;
    error = validateClosedObject(sort, 'sort', ['by', 'order']);
    if (error) return error;
    if (sort.by !== undefined && SORTS[target].indexOf(sort.by) === -1) {
        return '`sort.by` `' + String(sort.by) + '` is not valid for target `' + target + '`; allowed: '
            + (SORTS[target].length ? SORTS[target].join(', ') : 'none');
    }
    if (sort.order !== undefined && ['asc', 'desc'].indexOf(sort.order) === -1) {
        return '`sort.order` must be `asc` or `desc`';
    }
    if (sort.order !== undefined && sort.by === undefined) return '`sort.order` requires `sort.by`';

    const filter = args.filter === undefined ? {} : args.filter;
    error = validateClosedObject(filter, 'filter', FILTERS[target]);
    if (error) return error;
    if (filter.nameContains !== undefined && typeof filter.nameContains !== 'string') return '`filter.nameContains` must be a string';
    if (filter.type !== undefined && typeof filter.type !== 'string') return '`filter.type` must be a string';
    if (filter.matchNamePrefix !== undefined && typeof filter.matchNamePrefix !== 'string') return '`filter.matchNamePrefix` must be a string';
    if (filter.enabledOnly !== undefined && typeof filter.enabledOnly !== 'boolean') return '`filter.enabledOnly` must be a boolean';
    if (filter.timeVaryingOnly !== undefined && typeof filter.timeVaryingOnly !== 'boolean') return '`filter.timeVaryingOnly` must be a boolean';

    if (target === 'compSettings' && args.page !== undefined) return '`page` is not valid for target `compSettings`';
    if (target === 'compSettings' && args.sort !== undefined) return '`sort` is not valid for target `compSettings`';
    if (target === 'compSettings' && args.filter !== undefined) return '`filter` is not valid for target `compSettings`';
    if (target === 'project' && args.depth !== undefined) return '`depth` is only valid for target `properties`';
    if (target === 'comps' && args.depth !== undefined) return '`depth` is only valid for target `properties`';
    if (compTargets.indexOf(target) === -1 && args.comp !== undefined) return '`comp` is not valid for target `' + target + '`';
    return null;
}

function renderTemplate(text, vars) {
    let rendered = text;
    const keys = Object.keys(vars);
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const encoded = JSON.stringify(vars[key]);
        const pattern = new RegExp('\\$' + key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'g');
        rendered = rendered.replace(pattern, encoded === undefined ? 'null' : encoded);
    }
    return rendered;
}

function readTemplate(target) {
    return fs.readFileSync(path.join(TEMPLATE_DIR, 'read_' + target + '.jsx'), 'utf8');
}

function resultError(target, message) {
    return 'ae_read `' + target + '` returned invalid result: ' + message;
}

function validateResult(target, value) {
    if (!isObject(value)) return 'result is not an object';
    const listKey = RESULT_ARRAYS[target];
    if (!listKey) {
        const required = ['compositionLocator', 'name', 'width', 'height', 'duration', 'frameDuration', 'frameRate', 'pixelAspectRatio', 'backgroundColor', 'workArea', 'displayStartTime', 'layerCount'];
        for (let i = 0; i < required.length; i += 1) if (!has(value, required[i])) return 'missing `' + required[i] + '`';
        return null;
    }
    const required = ['total', 'offset', 'limit', 'returned', 'hasMore', 'nextOffset', listKey];
    for (let i = 0; i < required.length; i += 1) if (!has(value, required[i])) return 'missing `' + required[i] + '`';
    if (!Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.offset)
        || !Number.isSafeInteger(value.limit) || !Number.isSafeInteger(value.returned)) return 'pagination values must be integers';
    if (!Array.isArray(value[listKey])) return '`' + listKey + '` must be an array';
    if (value.returned !== value[listKey].length) return '`returned` must equal `' + listKey + '.length`';
    if (value.hasMore !== (value.offset + value.returned < value.total)) return '`hasMore` is inconsistent with pagination';
    const expectedNext = value.hasMore ? value.offset + value.returned : null;
    if (value.nextOffset !== expectedNext) return '`nextOffset` is inconsistent with pagination';
    return null;
}

async function call(args, context, deps) {
    const validation = validateArgs(args);
    if (validation) return fail(validation);
    const target = args.target;
    const options = {
        target: target,
        comp: args.comp || null,
        layer: args.layer || null,
        property: args.property || null,
        page: { offset: args.page && args.page.offset !== undefined ? args.page.offset : 0, limit: args.page && args.page.limit !== undefined ? args.page.limit : 50 },
        sort: { by: args.sort ? (args.sort.by || null) : null, order: args.sort && args.sort.order ? args.sort.order : 'asc' },
        filter: args.filter || {},
        depth: args.depth === undefined ? 2 : args.depth,
        sampleTime: args.sampleTime === undefined ? null : args.sampleTime,
    };
    let code;
    try {
        code = renderTemplate(readTemplate(target), { options: options });
    } catch (error) {
        return fail('could not load ae_read template for `' + target + '`: ' + (error && error.message ? error.message : String(error)));
    }
    try {
        const request = {
            code: code,
            timeoutMs: (args.timeout_sec === undefined ? 30 : args.timeout_sec) * 1000,
            client: context && context.session ? context.session.clientName : 'mcp:ae_read',
            nativeProjectGraphEffect: 'preserve',
        };
        const execution = await deps.executeJsx(request);
        const payload = execution && execution.payload;
        if (!payload || payload.ok !== true || typeof payload.result !== 'string') {
            const failed = payload && typeof payload === 'object' ? Object.assign({}, payload) : { ok: false, error: 'missing execution payload' };
            if (execution && execution.disposition && !failed.disposition) failed.disposition = execution.disposition;
            return { result: textResult(failed, true) };
        }
        let value;
        try {
            value = JSON.parse(payload.result);
        } catch (error) {
            return fail(resultError(target, 'JSON parse failed'));
        }
        if (value && value.ok === false) return fail(value.error || 'ExtendScript read failed');
        if (!value || value.ok !== true) return fail(resultError(target, 'missing ok=true envelope'));
        delete value.ok;
        const shapeError = validateResult(target, value);
        if (shapeError) return fail(resultError(target, shapeError));
        return { result: textResult(value, false) };
    } catch (error) {
        const value = { ok: false, error: error && error.message ? error.message : String(error) };
        if (error && typeof error.disposition === 'string') value.disposition = error.disposition;
        return { result: textResult(value, true) };
    }
}

module.exports = { definition, call, renderTemplate, validateArgs, readTemplate, TARGETS };
