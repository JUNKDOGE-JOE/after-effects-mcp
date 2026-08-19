'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { textResult } = require('../tool-result');
const png = require('../png');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../../jsx/templates/preview_viewer.jsx'), 'utf8');
const PREVIEW_ROOT = path.join(os.tmpdir(), 'ae_mcp_previews');
const SESSION_ID = crypto.randomBytes(5).toString('hex');
const BASE_TIMEOUT_MS = 45000;
const PER_FRAME_TIMEOUT_MS = 35000;
const MAX_TIMEOUT_MS = 300000;

const definition = {
    name: 'ae_previewFrame',
    description: 'Return real composition pixels as PNG image content. The composition background appears with its RGB but alpha 0 where no layer covers the frame: After Effects paints that background in its viewport without compositing it into the exported alpha. A transparent preview pixel with the configured background RGB therefore does not mean the background setting write failed.',
    inputSchema: {
        type: 'object', properties: {
            comp_id: { type: 'string', minLength: 1, description: 'AE comp id. Omit for the active comp.' },
            time: { type: 'number', minimum: 0, description: 'Single frame time in seconds. Ignored when times is set.' },
            times: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 8, description: 'Render up to 8 frame times in seconds.' },
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

function frameRequests(args, outDir, captureId) {
    const times = args.times !== undefined ? args.times : (args.time !== undefined ? [args.time] : [null]);
    const comp = args.comp_id || 'active';
    return times.map(function (time, index) {
        const timePart = time === null ? 'current' : Number(time).toFixed(6);
        const stem = safeStem(comp + '_' + timePart + '_' + index + '_' + captureId.slice(0, 8));
        return { time: time, path: path.join(outDir, stem + '.png') };
    });
}

function previewTimeoutMs(count) { return Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + PER_FRAME_TIMEOUT_MS * (count - 1)); }

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
                        // We cannot resample formats outside the RGB/RGBA
                        // subset, but a complete PNG is still a useful frame.
                        // Confirm its compressed stream before returning only
                        // IHDR dimensions and marking downsampling as skipped.
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

async function call(args, context, deps) {
    args = args || {};
    if (Object.keys(args).some(function (key) {
        return ['comp_id', 'time', 'times', 'out_dir', 'include_base64', 'scale', 'repaint_delay_ms'].indexOf(key) === -1;
    })) return errorResult(new Error('ae_previewFrame received unknown arguments'));
    if (args.times !== undefined && (!Array.isArray(args.times) || args.times.length > 8 || args.times.some(function (value) { return !Number.isFinite(value) || value < 0; }))) return errorResult(new Error('`times` must contain at most 8 non-negative numbers'));
    if (args.time !== undefined && (!Number.isFinite(args.time) || args.time < 0)) return errorResult(new Error('`time` must be a non-negative number'));
    if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale <= 0 || args.scale > 4)) return errorResult(new Error('`scale` must be greater than 0 and at most 4'));
    if (args.include_base64 !== undefined && typeof args.include_base64 !== 'boolean') return errorResult(new Error('`include_base64` must be a boolean'));
    if (args.out_dir !== undefined && (typeof args.out_dir !== 'string' || !args.out_dir)) return errorResult(new Error('`out_dir` must be a non-empty string'));
    if (args.repaint_delay_ms !== undefined && (!Number.isInteger(args.repaint_delay_ms) || args.repaint_delay_ms < 0 || args.repaint_delay_ms > 5000)) return errorResult(new Error('`repaint_delay_ms` must be an integer between 0 and 5000'));
    let expression;
    try { expression = compExpr(args.comp_id); } catch (error) { return errorResult(error); }
    const outDir = args.out_dir || path.join(PREVIEW_ROOT, SESSION_ID);
    const captureId = crypto.randomBytes(16).toString('hex');
    const requests = frameRequests(args, outDir, captureId);
    const timeout = previewTimeoutMs(requests.length);
    const deadline = Date.now() + timeout;
    const scale = args.scale === undefined ? 1 : args.scale;
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (error) { return errorResult(error); }
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
            return errorResult(error);
        } finally { logBranch(deps, branch, started); }
    }
    const result = { ok: true, compId: compId, compName: compName, captureId: captureId, frames: frames };
    let content;
    try {
        content = frames.map(function (frame, index) {
            const bytes = fs.readFileSync(frame.path);
            const dimensions = png.readPngInfo(bytes);
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            if (dimensions.width !== frame.width || dimensions.height !== frame.height || digest !== frame.sha256) throw new Error('preview frame changed after capture');
            return { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png', _meta: { captureId: captureId, frameIndex: index, sha256: digest, width: dimensions.width, height: dimensions.height } };
        });
    } catch (error) {
        return errorResult(error);
    }
    content.push({ type: 'text', text: JSON.stringify(result) });
    return { result: { content: content, structuredContent: result } };
}

module.exports = { definition, call, renderTemplate, compExpr, frameRequests, previewTimeoutMs, awaitWrittenPng, nativeStatus };
