'use strict';

const png = require('./png');

const DEFAULT_MAX_SIDE = 2048;
const GRID_BACKGROUND = [32, 32, 32, 255];
const FONT = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
    ':': ['00000', '00110', '00110', '00000', '00110', '00110', '00000'],
    's': ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
    '#': ['01010', '11111', '01010', '01010', '11111', '01010', '01010'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    'x': ['00000', '10001', '01010', '00100', '01010', '10001', '00000'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function checkImage(image) {
    if (!image || !Number.isInteger(image.width) || image.width < 1
        || !Number.isInteger(image.height) || image.height < 1
        || !(Buffer.isBuffer(image.rgba) || image.rgba instanceof Uint8Array)
        || image.rgba.length !== image.width * image.height * 4) {
        throw new Error('invalid RGBA image');
    }
}

function checkMaxSide(maxSide) {
    const value = maxSide === undefined ? DEFAULT_MAX_SIDE : maxSide;
    if (!Number.isInteger(value) || value < 1) throw new Error('maxSide must be a positive integer');
    return value;
}

function fitWithin(image, maxSide) {
    checkImage(image);
    const limit = checkMaxSide(maxSide);
    const longest = Math.max(image.width, image.height);
    if (longest <= limit) return { image: image, scaled: false };
    return { image: png.boxDownscale(image.rgba, image.width, image.height, limit / longest), scaled: true };
}

function resampleTo(image, width, height) {
    checkImage(image);
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
        throw new Error('target dimensions must be positive integers');
    }
    if (image.width === width && image.height === height) return image;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
            const source = (sourceY * image.width + sourceX) * 4;
            const target = (y * width + x) * 4;
            for (let channel = 0; channel < 4; channel += 1) rgba[target + channel] = image.rgba[source + channel];
        }
    }
    return { rgba: rgba, width: width, height: height };
}

function fill(width, height, color) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let at = 0; at < rgba.length; at += 4) {
        rgba[at] = color[0]; rgba[at + 1] = color[1]; rgba[at + 2] = color[2]; rgba[at + 3] = color[3];
    }
    return { rgba: rgba, width: width, height: height };
}

function copyInto(target, source, x, y) {
    for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
        for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
            const from = (sourceY * source.width + sourceX) * 4;
            const to = ((y + sourceY) * target.width + x + sourceX) * 4;
            for (let channel = 0; channel < 4; channel += 1) target.rgba[to + channel] = source.rgba[from + channel];
        }
    }
}

function drawText(image, x, y, text, scale) {
    checkImage(image);
    const factor = scale === undefined ? 2 : scale;
    if (!Number.isInteger(factor) || factor < 1) throw new Error('text scale must be a positive integer');
    const value = String(text);
    for (let index = 0; index < value.length; index += 1) {
        const glyph = FONT[value[index]] || FONT[' '];
        const originX = x + index * 6 * factor;
        for (let row = 0; row < 7; row += 1) for (let column = 0; column < 5; column += 1) {
            if (glyph[row][column] !== '1') continue;
            for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) {
                const targetX = originX + column * factor + dx;
                const targetY = y + row * factor + dy;
                if (targetX < 0 || targetY < 0 || targetX >= image.width || targetY >= image.height) continue;
                const at = (targetY * image.width + targetX) * 4;
                image.rgba[at] = 255; image.rgba[at + 1] = 255; image.rgba[at + 2] = 255; image.rgba[at + 3] = 255;
            }
        }
    }
    return image;
}

function darkenRect(image, x, y, width, height) {
    const right = Math.min(image.width, x + width);
    const bottom = Math.min(image.height, y + height);
    for (let targetY = Math.max(0, y); targetY < bottom; targetY += 1) for (let targetX = Math.max(0, x); targetX < right; targetX += 1) {
        const at = (targetY * image.width + targetX) * 4;
        image.rgba[at] = Math.round(image.rgba[at] * 0.4);
        image.rgba[at + 1] = Math.round(image.rgba[at + 1] * 0.4);
        image.rgba[at + 2] = Math.round(image.rgba[at + 2] * 0.4);
        image.rgba[at + 3] = 255;
    }
}

function drawLabel(image, x, y, label) {
    const scale = 2;
    const width = Math.max(1, String(label).length * 6 * scale + 2);
    const height = 7 * scale + 2;
    darkenRect(image, x, y, width, height);
    drawText(image, x + 1, y + 1, label, scale);
}

function composeGrid(images, options) {
    if (!Array.isArray(images) || images.length < 1) throw new Error('composeGrid requires at least one image');
    const setting = options || {};
    const columns = setting.columns === undefined ? Math.ceil(Math.sqrt(images.length)) : setting.columns;
    if (!Number.isInteger(columns) || columns < 1) throw new Error('columns must be a positive integer');
    const gap = setting.gap === undefined ? 4 : setting.gap;
    if (!Number.isInteger(gap) || gap < 0) throw new Error('gap must be a non-negative integer');
    let cellWidth = 0;
    let cellHeight = 0;
    images.forEach(function (entry) {
        checkImage(entry && entry.image);
        cellWidth = Math.max(cellWidth, entry.image.width);
        cellHeight = Math.max(cellHeight, entry.image.height);
    });
    const rows = Math.ceil(images.length / columns);
    const maxSide = checkMaxSide(setting.maxSide);
    const horizontalGaps = (columns - 1) * gap;
    const verticalGaps = (rows - 1) * gap;
    if (maxSide - horizontalGaps < columns || maxSide - verticalGaps < rows) throw new Error('maxSide is too small for grid gaps');
    let cellScale = Math.min(
        1,
        (maxSide - horizontalGaps) / (columns * cellWidth),
        (maxSide - verticalGaps) / (rows * cellHeight),
    );
    cellScale = Math.min(
        cellScale,
        Math.floor((maxSide - horizontalGaps) / columns) / cellWidth,
        Math.floor((maxSide - verticalGaps) / rows) / cellHeight,
    );
    const outputCellWidth = Math.max(1, Math.round(cellWidth * cellScale));
    const outputCellHeight = Math.max(1, Math.round(cellHeight * cellScale));
    const outputWidth = columns * outputCellWidth + horizontalGaps;
    const outputHeight = rows * outputCellHeight + verticalGaps;
    const output = fill(outputWidth, outputHeight, GRID_BACKGROUND);
    const cells = [];
    images.forEach(function (entry, index) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const cellX = column * (outputCellWidth + gap);
        const cellY = row * (outputCellHeight + gap);
        const frame = cellScale < 1
            ? png.boxDownscale(entry.image.rgba, entry.image.width, entry.image.height, cellScale)
            : entry.image;
        const imageX = cellX + Math.floor((outputCellWidth - frame.width) / 2);
        const imageY = cellY + Math.floor((outputCellHeight - frame.height) / 2);
        copyInto(output, frame, imageX, imageY);
        cells.push({ index: index, x: cellX, y: cellY, w: outputCellWidth, h: outputCellHeight });
    });
    images.forEach(function (entry, index) { drawLabel(output, cells[index].x, cells[index].y, entry.label || ''); });
    return {
        image: output, columns: columns, rows: rows,
        cellWidth: outputCellWidth, cellHeight: outputCellHeight,
        cells: cells, scaled: cellScale < 1,
    };
}

function diffImages(a, b, options) {
    checkImage(a); checkImage(b);
    if (a.width !== b.width || a.height !== b.height) throw new Error('diff images must have matching dimensions');
    const setting = options || {};
    const threshold = setting.threshold === undefined ? 8 : setting.threshold;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Error('threshold must be an integer between 0 and 255');
    const rgba = Buffer.alloc(a.width * a.height * 4);
    let changedPixels = 0;
    let sum = 0;
    let maxAbsDiff = 0;
    let minX = a.width; let minY = a.height; let maxX = -1; let maxY = -1;
    for (let pixel = 0; pixel < a.width * a.height; pixel += 1) {
        const at = pixel * 4;
        let difference = 0;
        for (let channel = 0; channel < 4; channel += 1) {
            difference = Math.max(difference, Math.abs(a.rgba[at + channel] - b.rgba[at + channel]));
        }
        sum += difference;
        maxAbsDiff = Math.max(maxAbsDiff, difference);
        if (difference > threshold) {
            changedPixels += 1;
            const x = pixel % a.width;
            const y = Math.floor(pixel / a.width);
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            rgba[at] = 255;
            rgba[at + 1] = Math.round(200 * (1 - difference / 255));
            rgba[at + 2] = 0;
        } else {
            const gray = Math.round((a.rgba[at] + a.rgba[at + 1] + a.rgba[at + 2]) / 3 * 0.25);
            rgba[at] = gray; rgba[at + 1] = gray; rgba[at + 2] = gray;
        }
        rgba[at + 3] = 255;
    }
    const totalPixels = a.width * a.height;
    const fitted = fitWithin({ rgba: rgba, width: a.width, height: a.height }, setting.maxSide);
    return {
        image: fitted.image,
        metrics: {
            changedRatio: Number((changedPixels / totalPixels).toFixed(4)),
            changedPixels: changedPixels, totalPixels: totalPixels,
            meanAbsDiff: Number((sum / totalPixels).toFixed(4)), maxAbsDiff: maxAbsDiff,
            bbox: changedPixels ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
            threshold: threshold,
        },
        scaled: fitted.scaled,
    };
}

function sideBySideFits(a, b, gap, maxSide, scale) {
    const width = Math.max(1, Math.round(a.width * scale)) + gap + Math.max(1, Math.round(b.width * scale));
    const height = Math.max(1, Math.round(Math.max(a.height, b.height) * scale));
    return width <= maxSide && height <= maxSide;
}

function composeSideBySide(a, b, gap, labels, maxSide) {
    checkImage(a); checkImage(b);
    const space = gap === undefined ? 8 : gap;
    if (!Number.isInteger(space) || space < 0) throw new Error('gap must be a non-negative integer');
    const names = labels || ['A', 'B'];
    const limit = checkMaxSide(maxSide);
    if (limit - space < 2) throw new Error('maxSide must leave room for both side-by-side frames');
    let scale = Math.min(1, (limit - space) / (a.width + b.width), limit / Math.max(a.height, b.height));
    if (!sideBySideFits(a, b, space, limit, scale)) {
        let low = 0;
        let high = scale;
        for (let iteration = 0; iteration < 32; iteration += 1) {
            const middle = (low + high) / 2;
            if (sideBySideFits(a, b, space, limit, middle)) low = middle;
            else high = middle;
        }
        scale = low;
    }
    const left = scale < 1 ? png.boxDownscale(a.rgba, a.width, a.height, scale) : a;
    const right = scale < 1 ? png.boxDownscale(b.rgba, b.width, b.height, scale) : b;
    const width = left.width + space + right.width;
    const height = Math.max(left.height, right.height);
    const output = fill(width, height, GRID_BACKGROUND);
    const aY = Math.floor((height - left.height) / 2);
    const bY = Math.floor((height - right.height) / 2);
    copyInto(output, left, 0, aY);
    copyInto(output, right, left.width + space, bY);
    drawLabel(output, 0, aY, names[0] || '');
    drawLabel(output, left.width + space, bY, names[1] || '');
    return { image: output, scaled: scale < 1 };
}

module.exports = { fitWithin, resampleTo, composeGrid, drawText, diffImages, composeSideBySide };
