'use strict';

// Dependency-free PNG subset used by ae_previewFrame. AE's saveFrameToPng
// produces 8-bit, non-interlaced RGB/RGBA PNGs, which is intentionally the
// only pixel format we decode and resample here.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let crcTable = null;

function table() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
        crcTable[n] = value >>> 0;
    }
    return crcTable;
}

function crc32(buffer) {
    let value = 0xffffffff;
    const values = table();
    for (let i = 0; i < buffer.length; i += 1) value = values[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function readPngInfo(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < SIGNATURE.length || !buffer.subarray(0, 8).equals(SIGNATURE)) {
        throw new Error('invalid PNG signature');
    }
    let offset = 8;
    let info = null;
    let sawIend = false;
    const idat = [];
    while (offset < buffer.length) {
        if (offset + 12 > buffer.length) throw new Error('truncated PNG chunk');
        const length = buffer.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > buffer.length) throw new Error('truncated PNG chunk');
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        const expected = buffer.readUInt32BE(offset + 8 + length);
        if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expected) throw new Error('PNG CRC mismatch');
        if (type === 'IHDR') {
            if (info || length !== 13) throw new Error('invalid PNG IHDR');
            info = {
                width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8],
                colorType: data[9], compression: data[10], filter: data[11], interlace: data[12], idat: idat,
            };
            if (info.width === 0 || info.height === 0) throw new Error('invalid PNG dimensions');
        } else if (type === 'IDAT') {
            if (!info || sawIend) throw new Error('invalid PNG IDAT');
            idat.push(data);
        } else if (type === 'IEND') {
            if (length !== 0 || !info) throw new Error('invalid PNG IEND');
            sawIend = true;
            if (end !== buffer.length) throw new Error('PNG bytes after IEND');
        }
        offset = end;
    }
    if (!info || !sawIend) throw new Error('PNG missing IEND');
    return info;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

function decodeRgba(buffer) {
    const info = readPngInfo(buffer);
    if (info.bitDepth !== 8 || info.interlace !== 0 || (info.colorType !== 2 && info.colorType !== 6)) {
        throw new Error('unsupported png');
    }
    const channels = info.colorType === 6 ? 4 : 3;
    const stride = info.width * channels;
    const raw = zlib.inflateSync(Buffer.concat(info.idat));
    if (raw.length !== info.height * (stride + 1)) throw new Error('invalid PNG pixel data');
    const rows = Buffer.alloc(info.height * stride);
    let input = 0;
    for (let y = 0; y < info.height; y += 1) {
        const filter = raw[input++];
        const row = y * stride;
        const prior = row - stride;
        for (let x = 0; x < stride; x += 1) {
            const source = raw[input++];
            const left = x >= channels ? rows[row + x - channels] : 0;
            const up = y ? rows[prior + x] : 0;
            const upLeft = y && x >= channels ? rows[prior + x - channels] : 0;
            if (filter === 0) rows[row + x] = source;
            else if (filter === 1) rows[row + x] = (source + left) & 0xff;
            else if (filter === 2) rows[row + x] = (source + up) & 0xff;
            else if (filter === 3) rows[row + x] = (source + Math.floor((left + up) / 2)) & 0xff;
            else if (filter === 4) rows[row + x] = (source + paeth(left, up, upLeft)) & 0xff;
            else throw new Error('invalid PNG filter');
        }
    }
    const rgba = Buffer.alloc(info.width * info.height * 4);
    for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
        rgba[pixel * 4] = rows[pixel * channels];
        rgba[pixel * 4 + 1] = rows[pixel * channels + 1];
        rgba[pixel * 4 + 2] = rows[pixel * channels + 2];
        rgba[pixel * 4 + 3] = channels === 4 ? rows[pixel * channels + 3] : 255;
    }
    return { rgba: rgba, width: info.width, height: info.height };
}

function boxDownscale(rgba, width, height, scale) {
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));
    const out = Buffer.alloc(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y += 1) {
        const y0 = Math.floor(y * height / outHeight);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / outHeight));
        for (let x = 0; x < outWidth; x += 1) {
            const x0 = Math.floor(x * width / outWidth);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / outWidth));
            const sums = [0, 0, 0, 0];
            let count = 0;
            for (let sourceY = y0; sourceY < y1; sourceY += 1) for (let sourceX = x0; sourceX < x1; sourceX += 1) {
                const at = (sourceY * width + sourceX) * 4;
                for (let channel = 0; channel < 4; channel += 1) sums[channel] += rgba[at + channel];
                count += 1;
            }
            const at = (y * outWidth + x) * 4;
            for (let channel = 0; channel < 4; channel += 1) out[at + channel] = Math.round(sums[channel] / count);
        }
    }
    return { rgba: out, width: outWidth, height: outHeight };
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 4, 'ascii');
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, data, tail]);
}

function encodePng(rgba, width, height) {
    if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4 || width < 1 || height < 1) throw new Error('invalid RGBA image');
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { SIGNATURE, crc32, readPngInfo, decodeRgba, boxDownscale, encodePng };
