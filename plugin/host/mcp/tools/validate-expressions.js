'use strict';

const fs = require('fs');
const path = require('path');
const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { parseJsxResult } = require('../jsx-result');
const { renderTemplate } = require('../template');
const { requireSuccessfulExecution } = require('../checkpoint-ops');

const TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, '../../../jsx/templates/validate_expressions.jsx'),
    'utf8',
);
const definition = {
    name: 'ae_validateExpressions',
    description: 'Force-evaluate expressions and report errors.',
    inputSchema: {
        type: 'object',
        properties: {
            comp_id: { type: 'string', description: 'AE comp id. Omit for active comp.' },
            layer_ids: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Restrict to these layers.',
            },
            prop: { type: 'string', description: 'matchName/name substring filter.' },
            sample_times: {
                type: 'array',
                items: { type: 'number', minimum: 0 },
                description: 'Times to evaluate. Default: current comp time.',
            },
            max_results: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
        },
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_validateExpressions,
};

function invalid(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}
function compExpr(id) {
    return id === undefined ? 'AEMCP.activeComp()' : 'AEMCP.compById(' + Number(id) + ')';
}
async function call(args, context, deps) {
    if (args.comp_id !== undefined && !/^\d+$/.test(args.comp_id))
        return invalid('`comp_id` must be a numeric string');
    if (
        args.layer_ids !== undefined &&
        (!Array.isArray(args.layer_ids) ||
            args.layer_ids.some(function (id) {
                return !Number.isInteger(id);
            }))
    )
        return invalid('`layer_ids` must be an array of integers');
    if (args.prop !== undefined && typeof args.prop !== 'string') return invalid('`prop` must be a string');
    if (
        args.sample_times !== undefined &&
        (!Array.isArray(args.sample_times) ||
            args.sample_times.some(function (time) {
                return !Number.isFinite(time) || time < 0;
            }))
    )
        return invalid('`sample_times` must be an array of non-negative numbers');
    const maxResults = args.max_results === undefined ? 500 : args.max_results;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2000)
        return invalid('`max_results` must be between 1 and 2000');
    try {
        const code = renderTemplate(TEMPLATE, {
            comp_expr: compExpr(args.comp_id),
            layer_ids_js: JSON.stringify(args.layer_ids === undefined ? null : args.layer_ids),
            prop_filter_js: JSON.stringify(args.prop === undefined ? null : args.prop),
            sample_times_js: JSON.stringify(args.sample_times === undefined ? null : args.sample_times),
            max_results: maxResults,
        });
        const execution = await deps.executeJsx({
            code,
            timeoutMs: 30000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'preserve',
        });
        const parsed = parseJsxResult(requireSuccessfulExecution(execution));
        return { result: textResult(parsed, parsed && parsed.ok === false) };
    } catch (error) {
        return invalid(error && error.message ? error.message : String(error));
    }
}
module.exports = { definition, call, compExpr };
