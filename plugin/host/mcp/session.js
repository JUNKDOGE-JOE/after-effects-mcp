'use strict';

const crypto = require('crypto');

function createSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

class SessionStore {
    constructor() {
        this.sessions = new Map();
    }

    create(protocolVersion, clientName) {
        const id = createSessionId();
        const session = {
            id,
            protocolVersion,
            clientName,
            initialized: false,
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

    addWriter(session, writer) {
        session.writers.add(writer);
        writer.onClose(function () { session.writers.delete(writer); });
    }

    publish(session, message) {
        session.writers.forEach(function (writer) { writer.send(message); });
    }

    get size() {
        return this.sessions.size;
    }
}

module.exports = { SessionStore, createSessionId };
