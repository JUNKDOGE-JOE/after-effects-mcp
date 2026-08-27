'use strict';

const crypto = require('crypto');
const path = require('path');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { executionFailure } = require('../checkpoint-ops');
const { parseJsxResult } = require('../jsx-result');
const { textResult } = require('../tool-result');
const {
    canonicalJson,
    computeContentHash,
    defaultLibrary,
    normalizeArgs,
    renderText,
} = require('../tool-library');

const definition = {
    name: 'ae_skillUse',
    description: 'List, render, or execute a bundled or user skill.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Skill name; omit to list skills.' },
            args: { type: 'object', default: {}, description: 'Skill template arguments.' },
            execute: { type: 'boolean', default: false, description: 'Execute a JSX skill.' },
            include_templates: { type: 'boolean', default: false },
        },
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_skillUse,
};

function library(deps) {
    if (deps && typeof deps.getToolLibrary === 'function') return deps.getToolLibrary();
    return (deps && deps.toolLibrary) || defaultLibrary();
}

function invalid(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}

function skillPlan(record, args) {
    const skill = record.skill;
    const normalizedArgs = normalizeArgs(skill.args_schema, args);
    const contentHash = record.artifact ? record.artifact.contentHash : computeContentHash(
        skill.template_type === 'jsx' ? 'jsx' : 'prompt-skill', skill.template, skill.args_schema,
    );
    const artifactId = record.artifact ? record.artifact.id : record.source === 'bundled'
        ? 'builtin:skill:' + skill.name
        : 'legacy:' + crypto.createHash('sha256').update(pathText(record.path), 'utf8')
            .digest('hex').slice(0, 24);
    const payload = {
        artifactId,
        contentHash,
        operation: 'execute',
        normalizedArgs,
        normalizedTarget: {},
        dependencyHashes: [],
        risk: 'destructive',
    };
    const plan = Object.assign({ name: skill.name }, payload);
    plan.planHash = crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
    return plan;
}

function pathText(filePath) {
    return path.resolve(filePath).normalize('NFC');
}

function assertSkillPlanCurrent(store, plan) {
    const current = skillPlan(store.resolveSkill(plan.artifactId), plan.normalizedArgs);
    if (current.planHash !== plan.planHash || current.contentHash !== plan.contentHash) {
        throw new Error('skill changed after approval');
    }
    return current;
}

async function call(args, context, deps) {
    if (args.name === undefined) {
        if (args.execute === true) return invalid('`name` is required when `execute` is true');
        try {
            const includeTemplates = args.include_templates === true;
            return {
                result: textResult({
                    ok: true,
                    skills: library(deps).listSkills().map(function (record) {
                        return library(deps).skillMeta(record, includeTemplates);
                    }),
                }),
            };
        } catch (error) {
            return invalid(error && error.message ? error.message : String(error));
        }
    }
    if (typeof args.name !== 'string' || !args.name) return invalid('`name` must be a non-empty string');
    if (args.args !== undefined && (args.args === null || typeof args.args !== 'object'
        || Array.isArray(args.args))) {
        return invalid('`args` must be an object');
    }
    if (args.execute !== undefined && typeof args.execute !== 'boolean') {
        return invalid('`execute` must be a boolean');
    }
    try {
        const store = library(deps);
        const record = store.resolveSkill(args.name);
        const normalizedArgs = normalizeArgs(record.skill.args_schema, args.args || {});
        const rendered = renderText(
            record.skill.template,
            normalizedArgs,
            record.skill.template_type === 'prompt',
        );
        if (args.execute !== true) {
            return {
                result: textResult({
                    ok: true,
                    name: record.skill.name,
                    template_type: record.skill.template_type,
                    rendered,
                }),
            };
        }
        if (record.skill.template_type !== 'jsx') {
            return invalid('prompt skills are render-only; only jsx skills can be executed');
        }
        if (!deps || typeof deps.executeJsx !== 'function') return invalid('JSX execution is unavailable');
        const plan = skillPlan(record, normalizedArgs);
        const denied = await enforce('ae_skillUse', Object.assign({}, context, {
            arguments: { name: record.skill.name, args: plan.normalizedArgs, plan_hash: plan.planHash },
        }), deps);
        if (denied) return { result: textResult(denied, true) };
        const current = assertSkillPlanCurrent(store, plan);
        const fresh = store.resolveSkill(current.name);
        const execution = await deps.executeJsx({
            code: renderText(fresh.skill.template, current.normalizedArgs, false),
            undoGroup: 'Tool Library: ' + fresh.skill.name,
            timeoutMs: 60000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'invalidate',
        });
        if (!execution || !execution.payload || execution.payload.ok !== true) {
            return { result: textResult(executionFailure(execution), true) };
        }
        const parsed = parseJsxResult(execution.payload.result);
        return { result: textResult(parsed, parsed && parsed.ok === false) };
    } catch (error) {
        return invalid(error && error.message ? error.message : String(error));
    }
}

module.exports = { definition, call, skillPlan, assertSkillPlanCurrent };
