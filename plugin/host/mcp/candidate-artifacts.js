'use strict';

const crypto = require('crypto');
const { computeContentHash } = require('./tool-library');

const CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_LIMIT = 20;
const GLOBAL_LIMIT = 200;

function firstCharacters(value, limit) {
    return Array.from(String(value || '')).slice(0, limit).join('');
}

function inferredName(code, args) {
    const undoName = args && typeof args.undo_group_name === 'string'
        ? args.undo_group_name.trim() : '';
    if (undoName) return firstCharacters(undoName, 128);
    const lines = String(code).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line) return firstCharacters(line, 60);
    }
    const digest = crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
    return 'ae_exec ' + digest.slice(0, 8);
}

function capturedCandidates(library) {
    return library.list({ statuses: ['candidate'] }).map(function (summary) {
        try { return library.getArtifact(summary.id); } catch (error) { return null; }
    }).filter(function (artifact) {
        return artifact && artifact.status === 'candidate'
            && artifact.source.type === 'chat-tool-call';
    });
}

function pruneCandidates(library, now) {
    const removed = new Set();
    let candidates = capturedCandidates(library);
    candidates.filter(function (artifact) {
        return artifact.updatedAt < now - CANDIDATE_TTL_MS;
    }).forEach(function (artifact) {
        library.removeArtifact(artifact.id);
        removed.add(artifact.id);
    });
    candidates = candidates.filter(function (artifact) { return !removed.has(artifact.id); });

    const byConversation = new Map();
    candidates.forEach(function (artifact) {
        const conversationId = artifact.source.provenance.conversationId;
        if (conversationId === null || conversationId === undefined) return;
        const rows = byConversation.get(conversationId) || [];
        rows.push(artifact);
        byConversation.set(conversationId, rows);
    });
    byConversation.forEach(function (rows) {
        rows.sort(function (left, right) { return right.updatedAt - left.updatedAt; });
        rows.slice(SESSION_LIMIT).forEach(function (artifact) {
            library.removeArtifact(artifact.id);
            removed.add(artifact.id);
        });
    });
    candidates = candidates.filter(function (artifact) { return !removed.has(artifact.id); })
        .sort(function (left, right) { return right.updatedAt - left.updatedAt; });
    candidates.slice(GLOBAL_LIMIT).forEach(function (artifact) {
        library.removeArtifact(artifact.id);
    });
}

function pruneAfterCapture(library, now) {
    try { pruneCandidates(library, now); } catch (error) { void error; }
}

function captureSuccessfulScript(code, args, context, deps, tool) {
    try {
        if (!deps || typeof deps.getToolLibrary !== 'function') return null;
        const library = deps.getToolLibrary();
        const capturedAt = Math.max(0, Math.floor(library.now()));
        const argsSchema = {};
        const contentHash = computeContentHash('jsx', code, argsSchema);
        const matches = library.findByContentHash('jsx', contentHash);
        const match = matches.find(function (summary) {
            return summary.status === 'candidate';
        });
        const persisted = matches.find(function (summary) {
            return summary.status === 'saved' || summary.status === 'pinned';
        });
        if (!match && persisted) {
            pruneAfterCapture(library, capturedAt);
            return persisted.id;
        }
        let artifact;
        if (match) {
            artifact = Object.assign({}, library.getArtifact(match.id), { updatedAt: capturedAt });
        } else {
            const session = context && context.session ? context.session : {};
            artifact = {
                schemaVersion: 1,
                id: 'user:' + crypto.randomUUID(),
                name: inferredName(code, args),
                description: 'Captured from a successful MCP exec call.',
                kind: 'jsx',
                category: 'workflow',
                tags: [],
                compatibility: {},
                declaredRisk: 'write',
                source: {
                    type: 'chat-tool-call',
                    ref: tool,
                    client: typeof session.clientName === 'string' ? session.clientName : null,
                    productVersion: null,
                    provenance: {
                        capturedAt,
                        conversationId: session.conversationId === undefined
                            ? null : session.conversationId,
                        tool,
                    },
                },
                status: 'candidate',
                verified: false,
                verification: null,
                content: code,
                argsSchema,
                contentHash,
                revision: 1,
                createdAt: capturedAt,
                updatedAt: capturedAt,
                lastUsedAt: null,
            };
        }
        artifact = library.saveArtifact(artifact);
        pruneAfterCapture(library, capturedAt);
        return artifact.id;
    } catch (error) {
        return null;
    }
}

function candidateGuidance(message, context, deps) {
    try {
        if (!deps || typeof deps.getToolLibrary !== 'function') return message;
        const candidates = capturedCandidates(deps.getToolLibrary());
        const session = context && context.session ? context.session : {};
        const conversationId = session.conversationId === undefined ? null : session.conversationId;
        const matching = candidates.filter(function (artifact) {
            return artifact.source.provenance.conversationId === conversationId;
        });
        const recent = (matching.length ? matching : candidates).slice(0, 5);
        if (!recent.length) return message;
        const rows = recent.map(function (artifact) {
            const value = artifact.source.provenance.capturedAt;
            const capturedAt = Number.isFinite(value) ? value : artifact.updatedAt;
            return '- artifactId=' + artifact.id
                + ', chars=' + Array.from(artifact.content).length
                + ', capturedAt=' + new Date(capturedAt).toISOString()
                + ', content=' + JSON.stringify(firstCharacters(artifact.content, 60));
        });
        return message + '\n\nRecent successful scripts you can rerun:\n' + rows.join('\n')
            + '\nRerun one verbatim with ae_toolUse {"name":"<artifactId>"}.';
    } catch (error) {
        return message;
    }
}

module.exports = {
    CANDIDATE_TTL_MS,
    GLOBAL_LIMIT,
    SESSION_LIMIT,
    candidateGuidance,
    captureSuccessfulScript,
    inferredName,
    pruneCandidates,
};
