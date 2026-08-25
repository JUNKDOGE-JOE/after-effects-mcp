'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { textResult } = require('../tool-result');
const imageOps = require('../image-ops');
const png = require('../png');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../../jsx/templates/preview_viewer.jsx'), 'utf8');
const PREVIEW_ROOT = path.join(os.tmpdir(), 'ae_mcp_previews');
const SESSION_ID = crypto.randomBytes(5).toString('hex');
const BASE_TIMEOUT_MS = 45000;
const PER_FRAME_TIMEOUT_MS = 35000;
const MAX_TIMEOUT_MS = 300000;
const CAPTURE_HISTORY_LIMIT = 50;
const captureHistory = new Map();

const compareSelectorSchema = {
    type: 'object',
    properties: {
        time: { type: 'number', minimum: 0, description: 'Capture this frame time in seconds.' },
        capture_id: { type: 'string', minLength: 1, description: 'Prior in-process capture id.' },
        index: { type: 'integer', minimum: 0, description: 'Frame index within the prior capture.' },
    },
    additionalProperties: false,
};

const definition = {
    name: 'ae_previewFrame',
    description: 'Read real composition pixels after a write, use compare to prove only the intended region changed, or use range with grid to inspect an animation interval. Transparent pixels retain the composition background RGB even though After Effects does not composite that background into exported alpha.',
    inputSchema: {
        type: 'object', properties: {
            comp_id: { type: 'string', minLength: 1, description: 'AE comp id. Omit for the active comp.' },
            time: { type: 'number', minimum: 0, description: 'Single frame time in seconds. Ignored when times is set.' },
            times: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 16, description: 'Frame times in seconds; up to 8 for separate output or 16 with layout grid.' },
            range: {
                type: 'object',
                properties: {
                    start: { type: 'number', minimum: 0, description: 'First sampled time in seconds.' },
                    end: { type: 'number', minimum: 0, description: 'Last sampled time in seconds.' },
                    count: { type: 'integer', minimum: 2, maximum: 16, description: 'Number of evenly spaced samples, including both endpoints.' },
                },
                required: ['start', 'end', 'count'], additionalProperties: false,
                description: 'Evenly sample 2 to 16 times; mutually exclusive with time and times.',
            },
            layout: { type: 'string', enum: ['separate', 'grid'], default: 'separate', description: 'Return each frame separately or one labeled contact sheet.' },
            grid_max_side: { type: 'integer', minimum: 256, maximum: 2048, default: 1280, description: 'Maximum width or height of a grid PNG.' },
            compare: {
                type: 'object',
                properties: {
                    a: compareSelectorSchema,
                    b: compareSelectorSchema,
                    mode: { type: 'string', enum: ['diff', 'side-by-side', 'both'], default: 'both', description: 'Return a heatmap, a side-by-side image, or both.' },
                    threshold: { type: 'integer', minimum: 0, maximum: 255, default: 8, description: 'Maximum per-pixel channel difference treated as unchanged.' },
                },
                required: ['a', 'b'], additionalProperties: false,
                description: 'Compare two captured times or prior capture frames; mutually exclusive with ordinary frame output arguments.',
            },
            out_dir: { type: 'string', minLength: 1, description: 'Output directory. Default: temp ae_mcp_previews session directory.' },
            include_base64: { type: 'boolean', default: false, description: 'Also include PNG base64 in each JSON frame. Image content is always returned.' },
            scale: { type: 'number', exclusiveMinimum: 0, maximum: 4, default: 1, description: 'Output scale factor (0 < scale <= 4), applied after capture.' },
            repaint_delay_ms: { type: 'integer', minimum: 0, maximum: 5000, default: 300, description: 'Retained for compatibility; has no effect because viewer screenshot fallback is not supported.' },
        }, additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function renderTemplate(text, vars) {
    return text.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, function (match, braced, plain) {
        if (match === '$$') return '$';
        const key = braced || plain;
        if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new Error('missing template variable: ' + key);
        return String(vars[key]);
    });
}

function compExpr(compId) {
    if (compId !== undefined && compId !== null && compId !== '') {
        if (!/^\d+$/.test(String(compId))) throw new Error('`comp_id` must be a positive integer string');
        return 'AEMCP.compById(' + String(Number(compId)) + ')';
    }
    return 'AEMCP.activeComp()';
}

function safeStem(value) { return String(value).replace(/[^A-Za-z0-9_-]/g, '_'); }

function expandRange(range) {
    if (range.count === 2) return [range.start, range.end];
    const step = (range.end - range.start) / (range.count - 1);
    return Array.from({ length: range.count }, function (_, index) {
        if (index === range.count - 1) return range.end;
        return range.start + step * index;
    });
}

function requestedTimes(args) {
    if (args.range !== undefined) return expandRange(args.range);
    if (args.times !== undefined) return args.times;
    return args.time !== undefined ? [args.time] : [null];
}

function requestsForTimes(times, args, outDir, captureId) {
    const comp = args.comp_id || 'active';
    return times.map(function (time, index) {
        const timePart = time === null ? 'current' : Number(time).toFixed(6);
        const stem = safeStem(comp + '_' + timePart + '_' + index + '_' + captureId.slice(0, 8));
        return { time: time, path: path.join(outDir, stem + '.png') };
    });
}

function frameRequests(args, outDir, captureId) {
    return requestsForTimes(requestedTimes(args), args, outDir, captureId);
}

function previewTimeoutMs(count) {
    return Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + PER_FRAME_TIMEOUT_MS * (Math.max(1, count) - 1));
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function awaitWrittenPng(file, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let previousSize = -1;
    while (true) {
        try {
            const size = fs.statSync(file).size;
            if (size >= 20 && size === previousSize) {
                const bytes = fs.readFileSync(file);
                if (bytes.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]))) {
                    try {
                        const decoded = png.decodeRgba(bytes);
                        return { width: decoded.width, height: decoded.height };
                    } catch (error) {
                        // AE can emit complete PNG variants outside the pixel subset
                        // this dependency-free path can safely resample.
                        if (!error || error.message !== 'unsupported png') throw error;
                        const info = png.readPngInfo(bytes);
                        zlib.inflateSync(Buffer.concat(info.idat));
                        return { width: info.width, height: info.height, unsupported: true };
                    }
                }
            }
            previousSize = size;
        } catch (error) { previousSize = -1; }
        if (Date.now() >= deadline) return null;
        await sleep(50);
    }
}

function nativeStatus(status) {
    const state = status && status.state;
    return { available: state === 'connected', adapter: state === 'connected' ? 'native-aegp' : null, engine: state === 'connected' ? 'native-aegp' : null };
}

function logBranch(deps, branch, started) {
    const logger = deps.hostLog;
    if (!logger || typeof logger.record !== 'function') return;
    try {
        logger.record({
            message: 'previewFrame.branch', source: branch.source, method: branch.method, ok: branch.ok,
            fallbackReason: branch.fallbackReason, compId: branch.compId, durationMs: Math.max(0, Date.now() - started),
            error: branch.error,
        });
    } catch (_) {}
}

function errorResult(error) {
    return { result: textResult({ ok: false, error: error && error.message ? error.message : String(error) }, true) };
}

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

function validateExactKeys(value, allowed, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('`' + name + '` must be an object');
    if (Object.keys(value).some(function (key) { return allowed.indexOf(key) === -1; })) throw new Error('`' + name + '` received unknown arguments');
}

function validateSelector(selector, name) {
    validateExactKeys(selector, ['time', 'capture_id', 'index'], name);
    const hasTime = own(selector, 'time');
    const hasCaptureId = own(selector, 'capture_id');
    const hasIndex = own(selector, 'index');
    if (hasTime === (hasCaptureId || hasIndex) || hasCaptureId !== hasIndex) {
        throw new Error('`' + name + '` must contain either `time` or both `capture_id` and `index`');
    }
    if (hasTime && (!Number.isFinite(selector.time) || selector.time < 0)) throw new Error('`' + name + '.time` must be a non-negative number');
    if (hasCaptureId && (typeof selector.capture_id !== 'string' || !selector.capture_id)) throw new Error('`' + name + '.capture_id` must be a non-empty string');
    if (hasIndex && (!Number.isInteger(selector.index) || selector.index < 0)) throw new Error('`' + name + '.index` must be a non-negative integer');
}

function validateArgs(args) {
    const allowed = ['comp_id', 'time', 'times', 'range', 'layout', 'grid_max_side', 'compare', 'out_dir', 'include_base64', 'scale', 'repaint_delay_ms'];
    if (Object.keys(args).some(function (key) { return allowed.indexOf(key) === -1; })) throw new Error('ae_previewFrame received unknown arguments');
    const layout = args.layout === undefined ? 'separate' : args.layout;
    if (layout !== 'separate' && layout !== 'grid') throw new Error('`layout` must be `separate` or `grid`');
    const timesLimit = layout === 'grid' ? 16 : 8;
    if (args.times !== undefined && (!Array.isArray(args.times) || args.times.length > timesLimit || args.times.some(function (value) { return !Number.isFinite(value) || value < 0; }))) {
        throw new Error('`times` must contain at most ' + timesLimit + ' non-negative numbers');
    }
    if (args.time !== undefined && (!Number.isFinite(args.time) || args.time < 0)) throw new Error('`time` must be a non-negative number');
    if (args.range !== undefined) {
        validateExactKeys(args.range, ['start', 'end', 'count'], 'range');
        if (args.time !== undefined || args.times !== undefined) throw new Error('`range` cannot be combined with `time` or `times` — pass exactly one of: {time: 1.5} | {times: [0, 1, 2]} | {range: {start: 0, end: 2, count: 5}}');
        if (!Number.isFinite(args.range.start) || args.range.start < 0 || !Number.isFinite(args.range.end) || args.range.end < 0) throw new Error('`range.start` and `range.end` must be non-negative numbers');
        if (!Number.isInteger(args.range.count) || args.range.count < 2 || args.range.count > 16) throw new Error('`range.count` must be an integer between 2 and 16');
        if (args.range.count > timesLimit) throw new Error('`range.count` must be at most ' + timesLimit + ' with layout `' + layout + '`');
    }
    if (args.grid_max_side !== undefined && (!Number.isInteger(args.grid_max_side) || args.grid_max_side < 256 || args.grid_max_side > 2048)) throw new Error('`grid_max_side` must be an integer between 256 and 2048');
    if (args.compare !== undefined) {
        validateExactKeys(args.compare, ['a', 'b', 'mode', 'threshold'], 'compare');
        if (args.time !== undefined || args.times !== undefined || args.range !== undefined || args.layout !== undefined) throw new Error('`compare` cannot be combined with `time`, `times`, `range`, or `layout` — compare takes exactly {compare: {a: <selector>, b: <selector>}} plus optional mode/threshold');
        validateSelector(args.compare.a, 'compare.a');
        validateSelector(args.compare.b, 'compare.b');
        const mode = args.compare.mode === undefined ? 'both' : args.compare.mode;
        if (['diff', 'side-by-side', 'both'].indexOf(mode) === -1) throw new Error('`compare.mode` must be `diff`, `side-by-side`, or `both`');
        if (args.compare.threshold !== undefined && (!Number.isInteger(args.compare.threshold) || args.compare.threshold < 0 || args.compare.threshold > 255)) throw new Error('`compare.threshold` must be an integer between 0 and 255');
    }
    if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale <= 0 || args.scale > 4)) throw new Error('`scale` must be greater than 0 and at most 4');
    if (args.include_base64 !== undefined && typeof args.include_base64 !== 'boolean') throw new Error('`include_base64` must be a boolean');
    if (args.out_dir !== undefined && (typeof args.out_dir !== 'string' || !args.out_dir)) throw new Error('`out_dir` must be a non-empty string');
    if (args.repaint_delay_ms !== undefined && (!Number.isInteger(args.repaint_delay_ms) || args.repaint_delay_ms < 0 || args.repaint_delay_ms > 5000)) throw new Error('`repaint_delay_ms` must be an integer between 0 and 5000');
}

async function captureFrames(args, context, deps, expression, requests, deadline) {
    const scale = args.scale === undefined ? 1 : args.scale;
    const frames = [];
    let compId = null;
    let compName = null;
    for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        const started = Date.now();
        const branch = { source: 'none', method: '-', ok: false, fallbackReason: '-', compId: '-' };
        try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('ae_previewFrame timed out before frame ' + index);
            const code = renderTemplate(TEMPLATE, { comp_expr: expression, time: JSON.stringify(request.time), path: JSON.stringify(request.path) });
            const execution = await deps.executeJsx({ code: code, timeoutMs: Math.min(15000, remaining), client: context.session.clientName, nativeProjectGraphEffect: 'preserve' });
            const payload = execution && execution.payload;
            const raw = payload && payload.result;
            let prepared;
            try { prepared = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { throw new Error('frame preparation returned invalid JSON'); }
            if (!prepared || prepared.ok !== true) throw new Error(prepared && prepared.error ? prepared.error : 'frame preparation failed');
            compId = prepared.compId === undefined || prepared.compId === null ? null : String(prepared.compId);
            compName = prepared.compName === undefined ? null : prepared.compName;
            branch.compId = compId || '-';
            if (prepared.source !== 'comp' && prepared.method !== 'saveFrameToPng') {
                branch.fallbackReason = prepared.fallbackReason || 'saveFrameToPng unavailable';
                throw new Error('saveFrameToPng did not produce a composition frame: ' + branch.fallbackReason);
            }
            branch.source = 'comp'; branch.method = 'saveFrameToPng';
            const outputPath = prepared.path || request.path;
            const dimensions = await awaitWrittenPng(outputPath, Math.max(0, deadline - Date.now()));
            if (!dimensions) throw new Error('saveFrameToPng did not finish writing a decodable PNG');
            let bytes = fs.readFileSync(outputPath);
            let width = dimensions.width;
            let height = dimensions.height;
            let downsampleSkipped = dimensions.unsupported ? 'unsupported-png-format' : undefined;
            if (Math.abs(scale - 1) > 1e-9) {
                try {
                    const decoded = png.decodeRgba(bytes);
                    const resized = png.boxDownscale(decoded.rgba, decoded.width, decoded.height, scale);
                    if (resized.width !== decoded.width || resized.height !== decoded.height) {
                        bytes = png.encodePng(resized.rgba, resized.width, resized.height);
                        fs.writeFileSync(outputPath, bytes);
                        width = resized.width; height = resized.height;
                    }
                } catch (error) {
                    if (error && error.message === 'unsupported png') downsampleSkipped = 'unsupported-png-format';
                    else throw error;
                }
            }
            bytes = fs.readFileSync(outputPath);
            const verified = png.readPngInfo(bytes);
            width = verified.width; height = verified.height;
            const frame = {
                time: prepared.time, path: outputPath, width: width, height: height, sizeBytes: bytes.length,
                sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source: 'comp', method: 'saveFrameToPng', compId: compId,
            };
            if (Number.isInteger(prepared.compWidth) && Number.isInteger(prepared.compHeight)) {
                frame.compWidth = prepared.compWidth; frame.compHeight = prepared.compHeight;
                if (prepared.compWidth !== dimensions.width || prepared.compHeight !== dimensions.height) frame.downsampled = true;
            }
            if (Array.isArray(prepared.resolutionFactor)) frame.resolutionFactor = prepared.resolutionFactor;
            if (Math.abs(scale - 1) > 1e-9 && !downsampleSkipped && (width !== dimensions.width || height !== dimensions.height)) frame.downsampled = true;
            if (downsampleSkipped) frame.downsampleSkipped = downsampleSkipped;
            if (args.include_base64 === true) frame.base64 = bytes.toString('base64');
            branch.ok = true;
            frames.push(frame);
        } catch (error) {
            branch.error = error && error.message ? error.message : String(error);
            throw error;
        } finally { logBranch(deps, branch, started); }
    }
    return { compId: compId, compName: compName, frames: frames };
}

function verifiedFrame(frame, changedMessage, decodePixels) {
    let bytes;
    try { bytes = fs.readFileSync(frame.path); } catch (_) { throw new Error(changedMessage); }
    const dimensions = png.readPngInfo(bytes);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (dimensions.width !== frame.width || dimensions.height !== frame.height || digest !== frame.sha256) throw new Error(changedMessage);
    return { bytes: bytes, image: decodePixels === false ? null : png.decodeRgba(bytes), digest: digest };
}

function frameContent(frame, captureId, index) {
    const verified = verifiedFrame(frame, 'preview frame changed after capture', false);
    return {
        type: 'image', data: verified.bytes.toString('base64'), mimeType: 'image/png',
        _meta: { captureId: captureId, frameIndex: index, sha256: verified.digest, width: frame.width, height: frame.height },
    };
}

function writeImage(file, image) {
    const bytes = png.encodePng(image.rgba, image.width, image.height);
    fs.writeFileSync(file, bytes);
    return {
        path: file, width: image.width, height: image.height, sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
}

function artifactContent(artifact, captureId, kind) {
    const bytes = fs.readFileSync(artifact.path);
    const dimensions = png.readPngInfo(bytes);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (dimensions.width !== artifact.width || dimensions.height !== artifact.height || digest !== artifact.sha256) throw new Error('preview artifact changed after creation');
    return {
        type: 'image', data: bytes.toString('base64'), mimeType: 'image/png',
        _meta: { captureId: captureId, kind: kind, sha256: digest, width: artifact.width, height: artifact.height },
    };
}

function rememberCapture(captureId, frames, compId, compName) {
    captureHistory.set(captureId, {
        frames: frames.map(function (frame, index) {
            return { index: index, time: frame.time, path: frame.path, width: frame.width, height: frame.height, sha256: frame.sha256 };
        }),
        compId: compId, compName: compName, at: Date.now(),
    });
    while (captureHistory.size > CAPTURE_HISTORY_LIMIT) captureHistory.delete(captureHistory.keys().next().value);
}

function registeredFrame(selector) {
    const capture = captureHistory.get(selector.capture_id);
    const frame = capture && capture.frames[selector.index];
    if (!frame || frame.index !== selector.index) throw new Error('unknown capture_id/index');
    const verified = verifiedFrame(frame, 'frame file missing or changed since capture');
    return {
        image: verified.image,
        compId: capture.compId,
        compName: capture.compName,
        descriptor: {
            captureId: selector.capture_id, index: selector.index, time: frame.time,
            path: frame.path, width: frame.width, height: frame.height, sha256: frame.sha256,
        },
    };
}

function capturedFrame(frame) {
    const verified = verifiedFrame(frame, 'preview frame changed after capture');
    return {
        image: verified.image,
        descriptor: { time: frame.time, path: frame.path, width: frame.width, height: frame.height, sha256: frame.sha256 },
    };
}

function makeBaseResult(captureId, captured) {
    return { ok: true, compId: captured.compId, compName: captured.compName, captureId: captureId, frames: captured.frames };
}

function addWarnings(result, warnings) {
    if (warnings.length) result.warnings = warnings;
}

async function compareResult(args, context, deps, expression, outDir, captureId) {
    const selectors = [args.compare.a, args.compare.b];
    const captures = [];
    const selectorFrameIndex = [-1, -1];
    selectors.forEach(function (selector, index) {
        if (own(selector, 'time')) {
            selectorFrameIndex[index] = captures.length;
            captures.push(selector.time);
        }
    });
    const requests = requestsForTimes(captures, args, outDir, captureId);
    const deadline = Date.now() + previewTimeoutMs(requests.length);
    const captured = await captureFrames(args, context, deps, expression, requests, deadline);
    const sides = selectors.map(function (selector, index) {
        return own(selector, 'time') ? capturedFrame(captured.frames[selectorFrameIndex[index]]) : registeredFrame(selector);
    });
    if (captures.length === 0) {
        captured.compId = sides[0].compId;
        captured.compName = sides[0].compName;
    }
    let bImage = sides[1].image;
    const warnings = [];
    const resampled = sides[0].image.width !== bImage.width || sides[0].image.height !== bImage.height;
    if (resampled) {
        bImage = imageOps.resampleTo(bImage, sides[0].image.width, sides[0].image.height);
        warnings.push('Frame B was resampled to Frame A dimensions before comparison.');
    }
    const mode = args.compare.mode === undefined ? 'both' : args.compare.mode;
    const threshold = args.compare.threshold === undefined ? 8 : args.compare.threshold;
    const diff = imageOps.diffImages(sides[0].image, bImage, { threshold: threshold, maxSide: 2048 });
    if (resampled) diff.metrics.resampled = true;
    const result = makeBaseResult(captureId, captured);
    const content = [];
    let scaled = false;
    const comparison = { a: sides[0].descriptor, b: sides[1].descriptor, metrics: diff.metrics };
    if (mode === 'diff' || mode === 'both') {
        const artifact = writeImage(path.join(outDir, captureId + '-diff.png'), diff.image);
        comparison.diffPath = artifact.path;
        content.push(artifactContent(artifact, captureId, 'diff'));
        if (diff.scaled) {
            scaled = true;
            warnings.push('The diff heatmap was scaled to fit within 2048 pixels.');
        }
    }
    if (mode === 'side-by-side' || mode === 'both') {
        const sideBySide = imageOps.composeSideBySide(sides[0].image, bImage, 8, ['A', 'B'], 2048);
        const artifact = writeImage(path.join(outDir, captureId + '-sbs.png'), sideBySide.image);
        comparison.sideBySidePath = artifact.path;
        content.push(artifactContent(artifact, captureId, 'side-by-side'));
        if (sideBySide.scaled) {
            scaled = true;
            warnings.push('The side-by-side image was scaled to fit within 2048 pixels.');
        }
    }
    comparison.scaled = scaled;
    result.compare = comparison;
    addWarnings(result, warnings);
    content.push({ type: 'text', text: JSON.stringify(result) });
    rememberCapture(captureId, captured.frames, captured.compId, captured.compName);
    return { result: { content: content, structuredContent: result } };
}

async function ordinaryResult(args, context, deps, expression, outDir, captureId) {
    const requests = frameRequests(args, outDir, captureId);
    const deadline = Date.now() + previewTimeoutMs(requests.length);
    const captured = await captureFrames(args, context, deps, expression, requests, deadline);
    const result = makeBaseResult(captureId, captured);
    const warnings = [];
    let content;
    if ((args.layout || 'separate') === 'grid') {
        const entries = captured.frames.map(function (frame, index) {
            return { image: verifiedFrame(frame, 'preview frame changed after capture').image, label: '#' + index + ' ' + Number(frame.time).toFixed(3) + 's' };
        });
        const composed = imageOps.composeGrid(entries, { maxSide: args.grid_max_side === undefined ? 1280 : args.grid_max_side });
        const artifact = writeImage(path.join(outDir, captureId + '-grid.png'), composed.image);
        result.grid = {
            path: artifact.path, width: artifact.width, height: artifact.height, sha256: artifact.sha256,
            columns: composed.columns, rows: composed.rows, cellWidth: composed.cellWidth, cellHeight: composed.cellHeight,
            scaled: composed.scaled,
            cells: composed.cells.map(function (cell) {
                return { index: cell.index, time: captured.frames[cell.index].time, x: cell.x, y: cell.y, w: cell.w, h: cell.h };
            }),
        };
        if (composed.scaled) warnings.push('The grid image was scaled to fit within grid_max_side.');
        content = [artifactContent(artifact, captureId, 'grid')];
    } else {
        content = captured.frames.map(function (frame, index) { return frameContent(frame, captureId, index); });
    }
    addWarnings(result, warnings);
    content.push({ type: 'text', text: JSON.stringify(result) });
    rememberCapture(captureId, captured.frames, captured.compId, captured.compName);
    return { result: { content: content, structuredContent: result } };
}

async function call(args, context, deps) {
    args = args || {};
    try { validateArgs(args); } catch (error) { return errorResult(error); }
    let expression;
    try { expression = compExpr(args.comp_id); } catch (error) { return errorResult(error); }
    const outDir = args.out_dir || path.join(PREVIEW_ROOT, SESSION_ID);
    const captureId = crypto.randomBytes(16).toString('hex');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        if (args.compare !== undefined) return await compareResult(args, context, deps, expression, outDir, captureId);
        return await ordinaryResult(args, context, deps, expression, outDir, captureId);
    } catch (error) {
        return errorResult(error);
    }
}

module.exports = { definition, call, renderTemplate, compExpr, expandRange, frameRequests, previewTimeoutMs, awaitWrittenPng, nativeStatus };
