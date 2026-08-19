'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const png = require('./png');

test('PNG subset round-trips RGBA and validates chunks', () => {
    const source = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 255, 255, 255, 0]);
    const encoded = png.encodePng(source, 2, 2);
    assert.deepEqual(png.readPngInfo(encoded).width, 2);
    assert.deepEqual(png.decodeRgba(encoded), { rgba: source, width: 2, height: 2 });
    assert.throws(function () { png.readPngInfo(encoded.subarray(0, -12)); }, /truncated|IEND/);
});

test('boxDownscale uses rounded dimensions and averages source pixels', () => {
    const source = Buffer.alloc(4 * 4 * 4, 0xff);
    const resized = png.boxDownscale(source, 4, 4, 0.5);
    assert.equal(resized.width, 2);
    assert.equal(resized.height, 2);
    assert.equal(resized.rgba.length, 16);
});
