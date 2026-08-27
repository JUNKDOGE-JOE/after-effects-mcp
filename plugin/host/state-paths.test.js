'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const authToken = require('./auth-token');
const hostLog = require('./host-log');
const { CheckpointStore } = require('./mcp/checkpoint-store');
const { createClientBlocklist } = require('./mcp/client-blocklist');
const { ToolLibrary } = require('./mcp/tool-library');
const { createStatePaths } = require('./state-paths');

test('state paths derive all persistent locations from AE_MCP_STATE_DIR', () => {
    const root = path.resolve('injected-state');
    const paths = createStatePaths({
        env: { AE_MCP_STATE_DIR: root },
        homedir: function () { throw new Error('real home must not be resolved'); },
    });
    assert.deepEqual(paths, {
        stateDir: root,
        authToken: path.join(root, 'auth-token'),
        blockedClients: path.join(root, 'blocked-clients.json'),
        checkpoints: path.join(root, 'checkpoints'),
        logs: path.join(root, 'logs'),
        tools: path.join(root, 'tools'),
        skills: path.join(root, 'skills'),
    });
});

test('injected paths outrank environment roots and fine overrides outrank the shared root', () => {
    const root = path.resolve('injected-state');
    const paths = createStatePaths({
        stateDir: root,
        logDir: path.resolve('injected-logs'),
        env: {
            AE_MCP_STATE_DIR: path.resolve('environment-state'),
            AE_MCP_HOME: path.resolve('legacy-state'),
            AE_MCP_LOG_DIR: path.resolve('environment-logs'),
            AE_MCP_TOOL_DIR: path.resolve('environment-tools'),
            AE_MCP_SKILL_DIR: path.resolve('environment-skills'),
        },
    });
    assert.equal(paths.stateDir, root);
    assert.equal(paths.logs, path.resolve('injected-logs'));
    assert.equal(paths.tools, path.resolve('environment-tools'));
    assert.equal(paths.skills, path.resolve('environment-skills'));
});

test('AE_MCP_HOME remains a compatibility fallback below AE_MCP_STATE_DIR', () => {
    const legacy = path.resolve('legacy-state');
    assert.equal(createStatePaths({ env: { AE_MCP_HOME: legacy } }).stateDir, legacy);
    const current = path.resolve('current-state');
    assert.equal(createStatePaths({
        env: { AE_MCP_HOME: legacy, AE_MCP_STATE_DIR: current },
    }).stateDir, current);
});

test('every state writer accepts one injected root without resolving the user home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-all-state-'));
    let homedirCalls = 0;
    const statePaths = createStatePaths({
        stateDir: root,
        homedir: function () {
            homedirCalls += 1;
            throw new Error('real home must remain unused');
        },
    });
    try {
        authToken.ensureToken({ statePaths });
        hostLog.init({ statePaths });
        hostLog.record({ message: 'state isolation probe' });
        createClientBlocklist({ statePaths }).set('state-isolation-test', true);
        const checkpointStore = new CheckpointStore({ statePaths });
        const library = new ToolLibrary({ statePaths });

        assert.equal(homedirCalls, 0);
        assert.equal(fs.existsSync(statePaths.authToken), true);
        assert.equal(fs.existsSync(statePaths.blockedClients), true);
        assert.equal(checkpointStore.root, statePaths.checkpoints);
        assert.equal(library.toolRoot, statePaths.tools);
        assert.equal(library.skillRoot, statePaths.skills);
        assert.equal(fs.readdirSync(statePaths.logs).length, 1);
    } finally {
        hostLog._reset();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
