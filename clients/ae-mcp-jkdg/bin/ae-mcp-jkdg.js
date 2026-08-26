#!/usr/bin/env node
'use strict';

const http = require('http');
const packageJson = require('../package.json');
const shim = require('../vendor/stdio-shim.js');

const HELP = [
    'Usage: ae-mcp-jkdg [--url=<http url>] [--help] [--version]',
    '',
    'Options:',
    '  --url=<http url>  MCP endpoint (default: AE_MCP_HTTP_URL or ' + shim.DEFAULT_URL + ')',
    '  --help            Show this help',
    '  --version         Show the connector version',
].join('\n');

function parseArguments(argv) {
    let targetUrl = null;
    for (let i = 0; i < argv.length; i += 1) {
        const argument = argv[i];
        if (argument === '--help') return { action: 'help', targetUrl: null };
        if (argument === '--version') return { action: 'version', targetUrl: null };
        if (argument.slice(0, 6) === '--url=') {
            targetUrl = argument.slice(6);
            if (!targetUrl) throw new Error('--url requires an HTTP URL');
            continue;
        }
        throw new Error('Unknown argument: ' + argument);
    }
    return { action: 'run', targetUrl };
}

function probeHealth(targetUrl, errorOutput) {
    let reported = false;

    function reportFailure() {
        if (reported) return;
        reported = true;
        errorOutput.write(
            'ae-mcp-jkdg: After Effects panel is not reachable at ' + targetUrl
            + ' — install the ae-mcp ZXP from GitHub Releases and keep '
            + 'Window > Extensions > ae-mcp open. / After Effects 面板不可达——'
            + '请从 GitHub Releases 安装 ae-mcp ZXP，并保持 '
            + 'Window > Extensions > ae-mcp 打开。\n',
        );
    }

    let healthUrl;
    try {
        const target = new URL(targetUrl);
        if (target.protocol !== 'http:') throw new Error('unsupported protocol');
        healthUrl = new URL('/health', target.origin);
    } catch (error) {
        reportFailure();
        return;
    }

    const request = http.get(healthUrl, function (response) {
        if (response.statusCode < 200 || response.statusCode >= 400) reportFailure();
        response.resume();
    });
    request.setTimeout(1500, function () {
        request.destroy(new Error('health probe timed out'));
    });
    request.on('error', reportFailure);
}

let parsed;
try {
    parsed = parseArguments(process.argv.slice(2));
} catch (error) {
    process.stderr.write('ae-mcp-jkdg: ' + error.message + '\n' + HELP + '\n');
    process.exitCode = 1;
}

if (parsed && parsed.action === 'help') {
    process.stdout.write(HELP + '\n');
} else if (parsed && parsed.action === 'version') {
    process.stdout.write(packageJson.version + '\n');
} else if (parsed) {
    const targetUrl = parsed.targetUrl || process.env.AE_MCP_HTTP_URL || shim.DEFAULT_URL;
    probeHealth(targetUrl, process.stderr);
    shim.run(process.stdin, process.stdout, process.stderr, targetUrl);
}
