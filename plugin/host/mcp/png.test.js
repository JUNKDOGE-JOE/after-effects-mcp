'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const png = require('./png');

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(png.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

function png16(width, height, colorType, samples, filters) {
    const channels = colorType === 6 ? 4 : 3;
    const bytesPerPixel = channels * 2;
    const stride = width * bytesPerPixel;
    const rows = Buffer.alloc(height * stride);
    samples.forEach(function (sample, index) { rows.writeUInt16BE(sample, index * 2); });
    const filtered = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y += 1) {
        const filter = filters[y];
        filtered[y * (stride + 1)] = filter;
        for (let x = 0; x < stride; x += 1) {
            const source = rows[y * stride + x];
            const left = x >= bytesPerPixel ? rows[y * stride + x - bytesPerPixel] : 0;
            const up = y ? rows[(y - 1) * stride + x] : 0;
            const upLeft = y && x >= bytesPerPixel ? rows[(y - 1) * stride + x - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) / 2);
            else if (filter === 4) predictor = paeth(left, up, upLeft);
            filtered[y * (stride + 1) + x + 1] = (source - predictor) & 0xff;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 16;
    ihdr[9] = colorType;
    return Buffer.concat([
        png.SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filtered)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

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

test('decodeRgba converts filtered 16-bit RGBA samples to their high bytes', () => {
    const encoded = png16(2, 2, 6, [
        0x1234, 0x5678, 0x9abc, 0xdef0, 0xff01, 0x8002, 0x4003, 0x2004,
        0x0105, 0x0206, 0x0307, 0x0408, 0xa109, 0xb20a, 0xc30b, 0xd40c,
    ], [1, 4]);
    assert.deepEqual(png.decodeRgba(encoded), {
        rgba: Buffer.from([
            0x12, 0x56, 0x9a, 0xde, 0xff, 0x80, 0x40, 0x20,
            0x01, 0x02, 0x03, 0x04, 0xa1, 0xb2, 0xc3, 0xd4,
        ]),
        width: 2,
        height: 2,
    });
});

test('decodeRgba converts 16-bit RGB to opaque 8-bit RGBA and keeps corruption errors', () => {
    const encoded = png16(2, 1, 2, [0x1020, 0x3040, 0x5060, 0xa0b0, 0xc0d0, 0xe0f0], [3]);
    assert.deepEqual(png.decodeRgba(encoded), {
        rgba: Buffer.from([0x10, 0x30, 0x50, 0xff, 0xa0, 0xc0, 0xe0, 0xff]),
        width: 2,
        height: 1,
    });
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 5] ^= 0xff;
    assert.throws(function () { png.decodeRgba(corrupt); }, /CRC mismatch/);
});
