'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const zlib = require('zlib');
const preview = require('./preview-frame');
const png = require('../png');

function fixturePng(width, height, value) {
    const rgba = Buffer.alloc(width * height * 4, value);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return png.encodePng(rgba, width, height);
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-preview-test-')); }

function pngChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0); head.write(type, 4, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(png.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
}

function grayscalePng() {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
    return Buffer.concat([png.SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 40, 200]))), pngChunk('IEND', Buffer.alloc(0))]);
}

function makeDeps(calls, logs, options) {
    const setting = options || {};
    return {
        hostLog: { record: function (entry) { logs.push(entry); } },
        executeJsx: async function (request) {
            calls.push(request);
            const match = /new File\(("(?:[^"\\]|\\.)*")\)/.exec(request.code);
            assert.ok(match, 'rendered JSX contains output File path');
            const outputPath = JSON.parse(match[1]);
            const timeMatch = /var requestedTime = ([^;]+);/.exec(request.code);
            const requestedTime = timeMatch ? JSON.parse(timeMatch[1]) : null;
            const frame = setting.frameForTime
                ? setting.frameForTime(requestedTime, calls.length - 1)
                : (setting.bytes || fixturePng(setting.width || 4, setting.height || 2, calls.length));
            if (setting.partial) {
                fs.writeFileSync(outputPath, frame.subarray(0, Math.floor(frame.length / 2)));
                setTimeout(function () { fs.writeFileSync(outputPath, frame); }, 60);
            } else fs.writeFileSync(outputPath, frame);
            return { payload: { ok: true, result: JSON.stringify({ ok: true, compId: 42, compName: 'Comp', time: requestedTime === null ? calls.length - 1 : requestedTime, compWidth: setting.compWidth || 4, compHeight: setting.compHeight || 2, resolutionFactor: [1, 1], path: outputPath, source: 'comp', method: 'saveFrameToPng' }) } };
        },
    };
}

function boxFixture(changed) {
    const rgba = Buffer.alloc(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1) {
        const at = pixel * 4;
        rgba[at] = 40; rgba[at + 1] = 40; rgba[at + 2] = 40; rgba[at + 3] = 255;
    }
    if (changed) for (let y = 1; y <= 2; y += 1) for (let x = 1; x <= 2; x += 1) {
        const at = (y * 4 + x) * 4;
        rgba[at] = 240;
    }
    return png.encodePng(rgba, 4, 4);
}

const context = { session: { clientName: 'preview-test' }, port: 1 };

test('ae_previewFrame renders template, polls a partial PNG, and returns MCP images', async () => {
    const calls = []; const logs = []; const outDir = tempDir();
    const output = await preview.call({ comp_id: '42', times: [0, 1], out_dir: outDir, include_base64: true }, context, makeDeps(calls, logs, { partial: true }));
    const value = output.result.structuredContent;
    assert.equal(value.ok, true);
    assert.equal(value.frames.length, 2);
    assert.match(calls[0].code, /AEMCP\.compById\(42\)/);
    assert.match(calls[0].code, /var requestedTime = 0/);
    assert.equal(calls[0].nativeProjectGraphEffect, 'preserve');
    assert.equal(output.result.content.filter(function (item) { return item.type === 'image'; }).length, 2);
    assert.equal(output.result.content[0]._meta.frameIndex, 0);
    assert.equal(output.result.content[1]._meta.frameIndex, 1);
    assert.equal(value.frames[0].base64, fs.readFileSync(value.frames[0].path).toString('base64'));
    assert.equal(value.frames[0].sha256, crypto.createHash('sha256').update(fs.readFileSync(value.frames[0].path)).digest('hex'));
    assert.equal(logs.length, 2);
    assert.deepEqual(logs.map(function (entry) { return [entry.message, entry.source, entry.method, entry.ok]; }), [['previewFrame.branch', 'comp', 'saveFrameToPng', true], ['previewFrame.branch', 'comp', 'saveFrameToPng', true]]);
});

test('ae_previewFrame applies scale, honors out_dir, and rejects excessive times', async () => {
    const calls = []; const logs = []; const outDir = tempDir();
    const scaled = await preview.call({ out_dir: outDir, scale: 0.5 }, context, makeDeps(calls, logs, { width: 4, height: 2 }));
    const frame = scaled.result.structuredContent.frames[0];
    assert.equal(frame.width, 2);
    assert.equal(frame.height, 1);
    assert.equal(frame.downsampled, true);
    assert.equal(path.dirname(frame.path), outDir);
    const rejected = await preview.call({ times: [0, 1, 2, 3, 4, 5, 6, 7, 8] }, context, makeDeps([], [], {}));
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.structuredContent.error, /at most 8/);
});

test('ae_previewFrame keeps a complete unsupported PNG and records skipped downsampling', async () => {
    const output = await preview.call({ out_dir: tempDir(), scale: 0.5 }, context, makeDeps([], [], { bytes: grayscalePng(), compWidth: 2, compHeight: 1 }));
    const frame = output.result.structuredContent.frames[0];
    assert.equal(frame.width, 2);
    assert.equal(frame.height, 1);
    assert.equal(frame.downsampleSkipped, 'unsupported-png-format');
});

test('ae_previewFrame turns a changed frame during image assembly into a tool error', async () => {
    const calls = []; const logs = []; const deps = makeDeps(calls, logs, {});
    let outputPath = null;
    const execute = deps.executeJsx;
    deps.executeJsx = async function (request) {
        const output = await execute(request);
        outputPath = JSON.parse(/new File\(("(?:[^"\\]|\\.)*")\)/.exec(request.code)[1]);
        return output;
    };
    deps.hostLog.record = function (entry) {
        logs.push(entry);
        if (entry.ok === true && outputPath) fs.writeFileSync(outputPath, fixturePng(4, 2, 99));
    };
    const output = await preview.call({ out_dir: tempDir() }, context, deps);
    assert.equal(output.result.isError, true);
    assert.match(output.result.structuredContent.error, /preview frame changed after capture/);
});

test('preview helpers implement Template dollar escapes and increasing frame budgets', () => {
    assert.equal(preview.renderTemplate('$$ $name ${name}', { name: 'ok' }), '$ ok ok');
    assert.equal(preview.previewTimeoutMs(1), 45000);
    assert.equal(preview.previewTimeoutMs(8), 290000);
});

test('ae_previewFrame expands ranges and enforces range exclusivity and bounds', async () => {
    const calls = [];
    const output = await preview.call({ range: { start: 0, end: 2, count: 5 }, out_dir: tempDir() }, context, makeDeps(calls, [], {}));
    assert.deepEqual(output.result.structuredContent.frames.map(function (frame) { return frame.time; }), [0, 0.5, 1, 1.5, 2]);
    assert.deepEqual(calls.map(function (request) {
        return Number(/var requestedTime = ([^;]+);/.exec(request.code)[1]);
    }), [0, 0.5, 1, 1.5, 2]);
    const mixed = await preview.call({ range: { start: 0, end: 1, count: 2 }, times: [0] }, context, makeDeps([], [], {}));
    assert.equal(mixed.result.isError, true);
    assert.match(mixed.result.structuredContent.error, /cannot be combined/);
    const bounded = await preview.call({ range: { start: 0, end: 1, count: 17 } }, context, makeDeps([], [], {}));
    assert.equal(bounded.result.isError, true);
    assert.match(bounded.result.structuredContent.error, /between 2 and 16/);
    const separateLimit = await preview.call({ range: { start: 0, end: 1, count: 9 } }, context, makeDeps([], [], {}));
    assert.equal(separateLimit.result.isError, true);
    assert.match(separateLimit.result.structuredContent.error, /at most 8/);
});

test('ae_previewFrame returns one bounded grid image while preserving frame records', async () => {
    const output = await preview.call({ times: [0, 0.5, 1, 1.5], layout: 'grid', grid_max_side: 256, out_dir: tempDir() }, context, makeDeps([], [], { width: 80, height: 60 }));
    const value = output.result.structuredContent;
    assert.equal(value.frames.length, 4);
    assert.equal(value.grid.cells.length, 4);
    assert.ok(value.grid.width <= 256);
    assert.ok(value.grid.height <= 256);
    assert.deepEqual(output.result.content.map(function (item) { return item.type; }), ['image', 'text']);
    assert.equal(output.result.content[0]._meta.kind, 'grid');
});

test('ae_previewFrame compares captured times and reports diff geometry', async () => {
    const same = await preview.call({
        compare: { a: { time: 1 }, b: { time: 1 }, mode: 'both' }, out_dir: tempDir(),
    }, context, makeDeps([], [], { width: 4, height: 4, compWidth: 4, compHeight: 4, frameForTime: function () { return boxFixture(false); } }));
    assert.equal(same.result.structuredContent.compare.metrics.changedRatio, 0);
    assert.deepEqual(same.result.content.map(function (item) { return item.type; }), ['image', 'image', 'text']);
    assert.deepEqual(same.result.content.slice(0, 2).map(function (item) { return item._meta.kind; }), ['diff', 'side-by-side']);

    const changed = await preview.call({
        compare: { a: { time: 0 }, b: { time: 1 }, mode: 'diff', threshold: 8 }, out_dir: tempDir(),
    }, context, makeDeps([], [], {
        width: 4, height: 4, compWidth: 4, compHeight: 4,
        frameForTime: function (time) { return boxFixture(time === 1); },
    }));
    assert.equal(changed.result.structuredContent.compare.metrics.changedPixels, 4);
    assert.deepEqual(changed.result.structuredContent.compare.metrics.bbox, { x: 1, y: 1, w: 2, h: 2 });
});

test('ae_previewFrame resolves registered frames and rejects unknown or changed files', async () => {
    const deps = makeDeps([], [], { width: 4, height: 4, compWidth: 4, compHeight: 4, frameForTime: function () { return boxFixture(false); } });
    const prior = await preview.call({ time: 1, out_dir: tempDir() }, context, deps);
    const priorValue = prior.result.structuredContent;
    const referenced = await preview.call({
        compare: { a: { capture_id: priorValue.captureId, index: 0 }, b: { time: 1 }, mode: 'diff' }, out_dir: tempDir(),
    }, context, deps);
    assert.equal(referenced.result.structuredContent.compare.metrics.changedRatio, 0);
    assert.equal(referenced.result.structuredContent.compare.a.captureId, priorValue.captureId);

    const registeredOnly = await preview.call({
        compare: {
            a: { capture_id: priorValue.captureId, index: 0 },
            b: { capture_id: priorValue.captureId, index: 0 },
            mode: 'diff',
        },
    }, context, deps);
    assert.equal(registeredOnly.result.structuredContent.compId, priorValue.compId);
    assert.equal(registeredOnly.result.structuredContent.compName, priorValue.compName);

    const unknown = await preview.call({
        compare: { a: { capture_id: 'missing', index: 0 }, b: { capture_id: 'missing', index: 0 }, mode: 'diff' },
    }, context, deps);
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.structuredContent.error, /unknown capture_id\/index/);

    fs.writeFileSync(priorValue.frames[0].path, boxFixture(true));
    const changed = await preview.call({
        compare: { a: { capture_id: priorValue.captureId, index: 0 }, b: { capture_id: priorValue.captureId, index: 0 }, mode: 'diff' },
    }, context, deps);
    assert.equal(changed.result.isError, true);
    assert.match(changed.result.structuredContent.error, /frame file missing or changed since capture/);
});

test('ae_previewFrame rejects compare mixed with ordinary frame arguments', async () => {
    const output = await preview.call({ compare: { a: { time: 0 }, b: { time: 1 } }, times: [0, 1] }, context, makeDeps([], [], {}));
    assert.equal(output.result.isError, true);
    assert.match(output.result.structuredContent.error, /cannot be combined/);
});
