'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const read = require('./read');
const { noTopLevelCombinator } = require('../tool-result');

function listValue(key, items, total, offset, limit) {
    const end = Math.min(total, offset + limit);
    return {
        ok: true,
        total,
        offset,
        limit,
        returned: items.length,
        hasMore: end < total,
        nextOffset: end < total ? end : null,
        [key]: items,
    };
}

function fixture(target) {
    if (target === 'project' || target === 'comps') {
        return listValue('items', [{ locatorKind: 'jsx', itemId: '7', name: 'Main', type: 'composition', parentLocator: null }], 1, 0, 50);
    }
    if (target === 'layers') {
        return Object.assign({ compositionLocator: {}, compositionName: 'Main' }, listValue('layers', [{
            locatorKind: 'jsx', locator: {}, layerIndex: 1, layerId: '11', stackIndex: 1, name: 'Hero', type: 'text',
            videoEnabled: true, isThreeD: false, locked: false, parentLocator: null, sourceItemLocator: null,
        }], 1, 0, 50));
    }
    if (target === 'properties') {
        return Object.assign({ layerLocator: {}, parentPropertyLocator: null, layerName: 'Hero', sampleTime: 0 }, listValue('properties', [{
            locatorKind: 'jsx', propertyLocator: {}, matchPath: 'ADBE Transform Group/ADBE Position', propertyIndex: 1,
            name: 'Position', matchName: 'ADBE Position', groupingType: 'leaf', childCount: 0, hidden: false,
            disabled: false, modified: false, canVaryOverTime: true, timeVarying: true, valueType: 'two-d',
            valueStatus: 'sampled', value: [0, 0],
        }], 1, 0, 50));
    }
    if (target === 'keyframes') {
        return Object.assign({ propertyLocator: {}, matchPath: 'ADBE Position', valueType: 'two-d' }, listValue('keyframes', [{
            locatorKind: 'jsx', keyframeIndex: 1, time: 0, value: [0, 0], inInterpolation: 'linear', outInterpolation: 'linear',
        }], 1, 0, 50));
    }
    return {
        ok: true, compositionLocator: {}, name: 'Main', width: 1920, height: 1080, duration: 10,
        frameDuration: 1 / 24, frameRate: 24, pixelAspectRatio: 1, backgroundColor: [0, 0, 0, 1],
        workArea: { start: 0, duration: 10 }, displayStartTime: 0, layerCount: 1,
    };
}

function harness(response) {
    const requests = [];
    return {
        requests,
        deps: {
            executeJsx: async function (request) {
                requests.push(request);
                return { payload: { ok: true, result: JSON.stringify(response) } };
            },
        },
    };
}

function successArgs(target) {
    const args = { target };
    if (['layers', 'properties', 'keyframes', 'compSettings'].indexOf(target) !== -1) args.comp = { name: 'Main' };
    if (['properties', 'keyframes'].indexOf(target) !== -1) args.layer = { index: 1 };
    if (target === 'keyframes') args.property = { matchPath: 'ADBE Transform Group/ADBE Position' };
    return args;
}

for (const target of read.TARGETS) {
    test('ae_read ' + target + ' success returns structured content', async () => {
        const h = harness(fixture(target));
        const output = await read.call(successArgs(target), { session: { clientName: 'read-test' } }, h.deps);
        assert.equal(output.result.isError, undefined);
        assert.equal(output.result.structuredContent.ok, undefined);
        assert.ok(output.result.structuredContent[ target === 'layers' ? 'layers' : target === 'properties' ? 'properties' : target === 'keyframes' ? 'keyframes' : target === 'compSettings' ? 'name' : 'items' ]);
        assert.equal(h.requests.length, 1);
    });

    test('ae_read ' + target + ' returns a clear JSX lookup failure', async () => {
        const h = harness({ ok: false, error: 'Composition not found for {"name":"Missing"}' });
        const args = successArgs(target);
        if (args.comp) args.comp = { name: 'Missing' };
        const output = await read.call(args, { session: { clientName: 'read-test' } }, h.deps);
        assert.equal(output.result.isError, true);
        assert.match(output.result.structuredContent.error, /Composition not found/);
    });
}

test('ae_read validates pagination for offset+limit < total, = total, and > total', async () => {
    const cases = [
        listValue('items', [{ itemId: '2' }, { itemId: '3' }], 5, 1, 2),
        listValue('items', [{ itemId: '2' }, { itemId: '3' }, { itemId: '4' }], 3, 0, 3),
        listValue('items', [], 3, 5, 2),
    ];
    for (const response of cases) {
        const h = harness(response);
        const offset = response.offset;
        const output = await read.call({ target: 'project', page: { offset, limit: response.limit } }, {}, h.deps);
        assert.equal(output.result.isError, undefined);
        assert.equal(output.result.structuredContent.total, response.total);
        assert.equal(output.result.structuredContent.nextOffset, response.nextOffset);
    }
});

test('ae_read rejects an illegal sort key, non-target filter, page limit, and depth branch', async () => {
    const h = harness(fixture('layers'));
    for (const args of [
        { target: 'layers', sort: { by: 'time' } },
        { target: 'layers', filter: { matchNamePrefix: 'ADBE' } },
        { target: 'project', page: { limit: 201 } },
        { target: 'layers', depth: 2 },
    ]) {
        const output = await read.call(args, {}, h.deps);
        assert.equal(output.result.isError, true);
        assert.match(output.result.structuredContent.error, /sort\.by|filter\.matchNamePrefix|page\.limit|depth/);
    }
    assert.equal(h.requests.length, 0);
});

test('ae_read JSON-encodes injected selector values and preserves read-only bridge options', async () => {
    const h = harness(fixture('comps'));
    const name = 'quote " and slash \\';
    const output = await read.call({ target: 'comps', filter: { nameContains: name } }, { session: { clientName: 'read-test' } }, h.deps);
    assert.equal(output.result.isError, undefined);
    assert.match(h.requests[0].code, /quote \\" and slash \\\\/);
    assert.equal(h.requests[0].nativeProjectGraphEffect, 'preserve');
    assert.equal(Object.prototype.hasOwnProperty.call(h.requests[0], 'undoGroup'), false);
});

test('ae_read definition is closed at the top level and advertises read-only idempotence', () => {
    assert.equal(noTopLevelCombinator(read.definition.inputSchema), true);
    assert.equal(read.definition.annotations.readOnlyHint, true);
    assert.equal(read.definition.annotations.destructiveHint, false);
    assert.equal(read.definition.annotations.idempotentHint, true);
});

test('ae_read structured item keys retain the native read vocabulary plus JSX locators', () => {
    const layer = fixture('layers').layers[0];
    const property = fixture('properties').properties[0];
    const keyframe = fixture('keyframes').keyframes[0];
    for (const key of ['stackIndex', 'name', 'type', 'videoEnabled', 'isThreeD', 'locked', 'parentLocator', 'sourceItemLocator']) assert.ok(Object.prototype.hasOwnProperty.call(layer, key), key);
    for (const key of ['propertyIndex', 'name', 'matchName', 'groupingType', 'childCount', 'hidden', 'disabled', 'modified', 'canVaryOverTime', 'timeVarying', 'valueType', 'valueStatus', 'value']) assert.ok(Object.prototype.hasOwnProperty.call(property, key), key);
    for (const key of ['keyframeIndex', 'time', 'value', 'inInterpolation', 'outInterpolation']) assert.ok(Object.prototype.hasOwnProperty.call(keyframe, key), key);
    assert.equal(layer.locatorKind, 'jsx');
    assert.equal(property.locatorKind, 'jsx');
    assert.equal(keyframe.locatorKind, 'jsx');
});

test('all read JSX templates and the performance fixture compile as JavaScript after rendering', () => {
    const options = {
        target: 'project', comp: { name: 'quote " and slash \\' }, layer: { index: 1 },
        property: { matchPath: 'ADBE Position' }, page: { offset: 0, limit: 50 },
        sort: { by: null, order: 'asc' }, filter: {}, depth: 2, sampleTime: null,
    };
    for (const target of read.TARGETS) {
        const source = read.renderTemplate(read.readTemplate(target), { options });
        assert.doesNotThrow(() => new Function(source), target);
    }
    const perf = fs.readFileSync(path.join(__dirname, 'read.perf.jsx'), 'utf8');
    assert.doesNotThrow(() => new Function(perf), 'read.perf.jsx');
});
