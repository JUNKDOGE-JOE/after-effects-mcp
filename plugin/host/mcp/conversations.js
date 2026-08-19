'use strict';

const crypto = require('crypto');

const VALID_TIERS = ['readonly', 'manual', 'auto', 'none'];

function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function normalizeLabel(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError('conversation label must be a non-empty string');
    }
    return value.trim();
}

function normalizeTier(value) {
    if (value === null) return null;
    if (VALID_TIERS.indexOf(value) === -1) {
        throw new TypeError('approvalTier must be readonly, manual, auto, none, or null');
    }
    return value;
}

function normalizeExpertGuidance(value) {
    if (typeof value !== 'boolean') {
        throw new TypeError('expertGuidance must be a boolean');
    }
    return value;
}

function normalizePolicy(label, policy) {
    const input = policy || {};
    return {
        approvalTier: normalizeTier(input.approvalTier === undefined ? null : input.approvalTier),
        expertGuidance: normalizeExpertGuidance(
            input.expertGuidance === undefined ? true : input.expertGuidance,
        ),
        label: normalizeLabel(input.label === undefined ? label : input.label),
    };
}

function publicConversation(record) {
    if (!record) return null;
    return {
        id: record.id,
        token: record.token,
        path: record.path,
        policy: Object.assign({}, record.policy),
    };
}

class ConversationStore {
    constructor(sessions) {
        this.sessions = sessions;
        this.byToken = new Map();
        this.byId = new Map();
    }

    create(options) {
        const input = options || {};
        const label = normalizeLabel(input.label);
        const record = {
            id: randomHex(16),
            token: randomHex(24),
            path: null,
            policy: normalizePolicy(label, input.policy),
        };
        record.path = '/mcp/c/' + record.token;
        this.byToken.set(record.token, record);
        this.byId.set(record.id, record);
        return publicConversation(record);
    }

    get(token) {
        return typeof token === 'string'
            ? publicConversation(this.byToken.get(token) || null) : null;
    }

    getById(id) {
        return typeof id === 'string'
            ? publicConversation(this.byId.get(id) || null) : null;
    }

    update(id, policyPatch) {
        const record = typeof id === 'string' ? this.byId.get(id) : null;
        if (!record) return null;
        const patch = policyPatch || {};
        const next = Object.assign({}, record.policy);
        if (Object.prototype.hasOwnProperty.call(patch, 'approvalTier')) {
            next.approvalTier = normalizeTier(patch.approvalTier);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'expertGuidance')) {
            next.expertGuidance = normalizeExpertGuidance(patch.expertGuidance);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
            next.label = normalizeLabel(patch.label);
        }
        record.policy = next;
        return publicConversation(record);
    }

    close(id) {
        const record = typeof id === 'string' ? this.byId.get(id) : null;
        if (!record) return false;
        if (this.sessions && typeof this.sessions.deleteByConversationId === 'function') {
            this.sessions.deleteByConversationId(record.id);
        }
        this.byId.delete(record.id);
        this.byToken.delete(record.token);
        return true;
    }

    list() {
        const output = [];
        this.byId.forEach(function (record) { output.push(publicConversation(record)); });
        return output;
    }
}

module.exports = { ConversationStore, VALID_TIERS };
