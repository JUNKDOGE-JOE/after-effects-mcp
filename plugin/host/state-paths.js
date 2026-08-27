'use strict';

const os = require('os');
const path = require('path');

function present(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

function createStatePaths(options) {
    const input = options || {};
    const environment = input.env || process.env;
    const injectedRoot = present(input.stateDir);
    const environmentRoot = present(environment.AE_MCP_STATE_DIR)
        || present(environment.AE_MCP_HOME);
    const home = injectedRoot || environmentRoot
        ? null
        : present(input.home) || (input.homedir || os.homedir)();
    const stateDir = path.resolve(injectedRoot || environmentRoot || path.join(home, '.ae-mcp'));

    return Object.freeze({
        stateDir,
        authToken: path.join(stateDir, 'auth-token'),
        blockedClients: path.join(stateDir, 'blocked-clients.json'),
        checkpoints: path.join(stateDir, 'checkpoints'),
        logs: path.resolve(present(input.logDir) || present(environment.AE_MCP_LOG_DIR)
            || path.join(stateDir, 'logs')),
        tools: path.resolve(present(input.toolDir) || present(environment.AE_MCP_TOOL_DIR)
            || path.join(stateDir, 'tools')),
        skills: path.resolve(present(input.skillDir) || present(environment.AE_MCP_SKILL_DIR)
            || path.join(stateDir, 'skills')),
    });
}

module.exports = { createStatePaths };
