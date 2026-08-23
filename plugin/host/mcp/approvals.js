'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function publicItem(item) {
    return {
        id: item.id,
        conversationId: item.conversationId,
        sessionId: item.sessionId,
        tool: item.tool,
        risk: item.risk,
        summary: Object.assign({}, item.summary),
        plan: item.plan ? Object.assign({}, item.plan) : null,
        createdAt: item.createdAt,
    };
}

class ApprovalQueue extends EventEmitter {
    constructor(options) {
        super();
        const input = options || {};
        this.timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs >= 0
            ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
        this.now = typeof input.now === 'function' ? input.now : Date.now;
        this.pending = new Map();
    }

    request(details) {
        const self = this;
        const item = {
            id: crypto.randomBytes(16).toString('hex'),
            conversationId: details.conversationId,
            sessionId: details.sessionId,
            tool: details.tool,
            risk: details.risk,
            summary: Object.assign({}, details.summary),
            plan: details.plan ? Object.assign({}, details.plan) : null,
            createdAt: new Date(this.now()).toISOString(),
            timer: null,
            settle: null,
        };
        const promise = new Promise(function (resolve) { item.settle = resolve; });
        item.timer = setTimeout(function () { self.resolve(item.id, 'timeout'); }, this.timeoutMs);
        if (item.timer && typeof item.timer.unref === 'function') item.timer.unref();
        this.pending.set(item.id, item);
        try {
            this.emit('request', publicItem(item));
        } catch (error) {
            // A panel listener must not break the approval gate. The pending
            // request remains visible and will be resolved or time out.
        }
        return promise;
    }

    resolve(id, decision) {
        if (!['accept', 'decline', 'cancel', 'unavailable', 'timeout'].includes(decision)) return false;
        const item = typeof id === 'string' ? this.pending.get(id) : null;
        if (!item) return false;
        clearTimeout(item.timer);
        this.pending.delete(item.id);
        item.settle(decision);
        return true;
    }

    list() {
        const output = [];
        this.pending.forEach(function (item) { output.push(publicItem(item)); });
        output.sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });
        return output;
    }
}

module.exports = { ApprovalQueue, DEFAULT_TIMEOUT_MS };
