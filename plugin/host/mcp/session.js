'use strict';

const crypto = require('crypto');

const MAX_SESSIONS = 64;

function createSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

class SessionStore {
    constructor(options) {
        const input = options || {};
        this.sessions = new Map();
        this.logger = typeof input.logger === 'function' ? input.logger : null;
    }

    evictInactiveSessions() {
        while (this.sessions.size >= MAX_SESSIONS) {
            let oldest = null;
            this.sessions.forEach(function (session) {
                if (session.writers.size > 0) return;
                if (!oldest || session.lastActivityAt < oldest.lastActivityAt) oldest = session;
            });
            if (!oldest) {
                if (this.logger) {
                    this.logger({
                        level: 'warn',
                        source: 'mcp-session-store',
                        message: 'MCP session limit reached with active writers',
                        maxSessions: MAX_SESSIONS,
                    });
                }
                return;
            }
            this.delete(oldest.id);
        }
    }

    create(protocolVersion, clientName, conversationId) {
        this.evictInactiveSessions();
        const id = createSessionId();
        const session = {
            id,
            protocolVersion,
            clientName,
            clientInfo: null,
            conversationId: conversationId || null,
            conversationToken: null,
            initialized: false,
            lastActivityAt: Date.now(),
            writers: new Set(),
        };
        this.sessions.set(id, session);
        return session;
    }

    get(id) {
        return typeof id === 'string' ? this.sessions.get(id) || null : null;
    }

    delete(id) {
        const session = this.get(id);
        if (!session) return false;
        session.writers.forEach(function (writer) { writer.close(); });
        this.sessions.delete(id);
        return true;
    }

    deleteByConversationId(conversationId) {
        const removed = [];
        this.sessions.forEach(function (session) {
            if (session.conversationId === conversationId) removed.push(session.id);
        });
        for (let i = 0; i < removed.length; i += 1) this.delete(removed[i]);
        return removed.length;
    }

    addWriter(session, writer) {
        session.writers.add(writer);
        writer.onClose(function () { session.writers.delete(writer); });
    }

    publish(session, message) {
        session.writers.forEach(function (writer) { writer.send(message); });
    }

    list() {
        return Array.from(this.sessions.values()).map(function (session) {
            return {
                sessionId: session.id,
                clientInfo: session.clientInfo ? Object.assign({}, session.clientInfo) : null,
                clientName: session.clientName,
                conversationId: session.conversationId,
                conversationToken: session.conversationToken,
                initialized: session.initialized,
                lastActivityAt: session.lastActivityAt || null,
                source: session.conversationId ? 'panel' : 'external',
            };
        }).sort(function (a, b) {
            return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
        });
    }

    get size() {
        return this.sessions.size;
    }
}

module.exports = { SessionStore, createSessionId, MAX_SESSIONS };
