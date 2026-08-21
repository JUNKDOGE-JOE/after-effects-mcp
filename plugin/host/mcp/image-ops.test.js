'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const imageOps = require('./image-ops');

function image(width, height, color) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let at = 0; at < rgba.length; at += 4) {
        rgba[at] = color[0]; rgba[at + 1] = color[1]; rgba[at + 2] = color[2]; rgba[at + 3] = color[3] === undefined ? 255 : color[3];
    }
    return { rgba: rgba, width: width, height: height };
}

function pixel(value, x, y) {
    const at = (y * value.width + x) * 4;
    return Array.from(value.rgba.subarray(at, at + 4));
}

function hasWhitePixel(value, x, y, width, height) {
    for (let targetY = y; targetY < Math.min(value.height, y + height); targetY += 1) {
        for (let targetX = x; targetX < Math.min(value.width, x + width); targetX += 1) {
            if (pixel(value, targetX, targetY).join(',') === '255,255,255,255') return true;
        }
    }
    return false;
}

test('composeGrid centers mixed dimensions and returns final cell geometry', () => {
    const composed = imageOps.composeGrid([
        { image: image(4, 3, [200, 0, 0]), label: '#0 0.000s' },
        { image: image(2, 2, [0, 200, 0]), label: '#1 1.000s' },
        { image: image(4, 4, [0, 0, 200]), label: '#2 2.000s' },
    ], { columns: 2 });
    assert.equal(composed.columns, 2);
    assert.equal(composed.rows, 2);
    assert.equal(composed.cellWidth, 4);
    assert.equal(composed.cellHeight, 4);
    assert.deepEqual(composed.cells, [
        { index: 0, x: 0, y: 0, w: 4, h: 4 },
        { index: 1, x: 8, y: 0, w: 4, h: 4 },
        { index: 2, x: 0, y: 8, w: 4, h: 4 },
    ]);
    assert.notDeepEqual(pixel(composed.image, 0, 0), [32, 32, 32, 255]);
});

test('composeGrid scales frames before composition and draws labels at final size', () => {
    const entries = [0, 1, 2, 3].map(function (index) {
        return { image: image(400, 300, [40 + index, 50, 60]), label: '#' + index + ' 1.000s' };
    });
    const composed = imageOps.composeGrid(entries, { columns: 2, maxSide: 256 });
    assert.equal(composed.scaled, true);
    assert.ok(composed.image.width <= 256);
    assert.ok(composed.image.height <= 256);
    assert.equal(composed.cells[1].x - composed.cells[0].x, composed.cellWidth + 4);
    assert.equal(composed.cells[2].y - composed.cells[0].y, composed.cellHeight + 4);
    assert.ok(composed.cells[3].x + composed.cells[3].w <= composed.image.width);
    assert.ok(composed.cells[3].y + composed.cells[3].h <= composed.image.height);
    composed.cells.forEach(function (cell) {
        assert.equal(hasWhitePixel(composed.image, cell.x, cell.y, 10, 14), true);
    });
});

test('composeGrid makes only the label block opaque over transparent frames', () => {
    const composed = imageOps.composeGrid([
        { image: image(30, 20, [20, 30, 40, 0]), label: '#0' },
    ], { columns: 1, maxSide: 256 });
    assert.equal(pixel(composed.image, 0, 0)[3], 255);
    assert.equal(hasWhitePixel(composed.image, 0, 0, 10, 14), true);
    assert.equal(pixel(composed.image, 29, 19)[3], 0);
});

test('drawText renders the expected 0 and 1 bitmap pixels', () => {
    const output = image(12, 7, [0, 0, 0]);
    imageOps.drawText(output, 0, 0, '01', 1);
    assert.deepEqual(pixel(output, 1, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixel(output, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(output, 8, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixel(output, 6, 0), [0, 0, 0, 255]);
});

test('diffImages reports identical, bounded, and thresholded changes', () => {
    const before = image(4, 4, [80, 80, 80]);
    const identical = imageOps.diffImages(before, image(4, 4, [80, 80, 80]));
    assert.equal(identical.metrics.changedRatio, 0);
    assert.equal(identical.metrics.changedPixels, 0);
    assert.equal(identical.metrics.bbox, null);
    assert.deepEqual(pixel(identical.image, 0, 0), [20, 20, 20, 255]);

    const after = image(4, 4, [80, 80, 80]);
    for (let y = 1; y <= 2; y += 1) for (let x = 1; x <= 2; x += 1) {
        const at = (y * after.width + x) * 4;
        after.rgba[at] = 255;
    }
    const changed = imageOps.diffImages(before, after, { threshold: 8 });
    assert.equal(changed.metrics.changedPixels, 4);
    assert.equal(changed.metrics.changedRatio, 0.25);
    assert.deepEqual(changed.metrics.bbox, { x: 1, y: 1, w: 2, h: 2 });
    assert.equal(pixel(changed.image, 1, 1)[0], 255);
    assert.ok(pixel(changed.image, 1, 1)[1] >= 0 && pixel(changed.image, 1, 1)[1] < 200);
    assert.deepEqual(pixel(changed.image, 0, 0), [20, 20, 20, 255]);

    const small = image(1, 1, [80, 80, 80]);
    small.rgba[0] = 85;
    assert.equal(imageOps.diffImages(image(1, 1, [80, 80, 80]), small, { threshold: 8 }).metrics.changedPixels, 0);
});

test('resampleTo, fitWithin, and composeSideBySide preserve bounded dimensions', () => {
    const resized = imageOps.resampleTo(image(2, 2, [10, 20, 30]), 4, 3);
    assert.equal(resized.width, 4);
    assert.equal(resized.height, 3);
    const unchanged = imageOps.fitWithin(resized, 4);
    assert.equal(unchanged.scaled, false);
    const fitted = imageOps.fitWithin(image(8, 4, [10, 20, 30]), 4);
    assert.equal(fitted.scaled, true);
    assert.equal(fitted.image.width, 4);
    assert.equal(fitted.image.height, 2);
    const sideBySide = imageOps.composeSideBySide(image(3, 2, [1, 2, 3]), image(5, 4, [4, 5, 6]), 7);
    assert.equal(sideBySide.image.width, 15);
    assert.equal(sideBySide.image.height, 4);
    const boundedSideBySide = imageOps.composeSideBySide(image(3, 2, [1, 2, 3]), image(5, 4, [4, 5, 6]), 7, ['A', 'B'], 10);
    assert.equal(boundedSideBySide.scaled, true);
    assert.ok(boundedSideBySide.image.width <= 10);
});
