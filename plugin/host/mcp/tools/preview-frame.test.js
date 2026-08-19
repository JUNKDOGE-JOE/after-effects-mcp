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
            const frame = setting.bytes || fixturePng(setting.width || 4, setting.height || 2, calls.length);
            if (setting.partial) {
                fs.writeFileSync(outputPath, frame.subarray(0, Math.floor(frame.length / 2)));
                setTimeout(function () { fs.writeFileSync(outputPath, frame); }, 60);
            } else fs.writeFileSync(outputPath, frame);
            return { payload: { ok: true, result: JSON.stringify({ ok: true, compId: 42, compName: 'Comp', time: calls.length - 1, compWidth: setting.compWidth || 4, compHeight: setting.compHeight || 2, resolutionFactor: [1, 1], path: outputPath, source: 'comp', method: 'saveFrameToPng' }) } };
        },
    };
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
