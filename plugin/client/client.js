// CEP panel front-end. Loads after index.html. Spawns Node.js host process.
(function () {
    var cs = new CSInterface();
    var statusLight = document.getElementById('status-light');
    var statusText = document.getElementById('status-text');
    var portInput = document.getElementById('port-input');
    var applyBtn = document.getElementById('apply-port');
    var logEl = document.getElementById('log');
    var lastErrorEl = document.getElementById('last-error');
    var mcpConfigEl = document.getElementById('mcp-config');
    var copyConfigBtn = document.getElementById('copy-config');

    function log(msg) {
        var ts = new Date().toLocaleTimeString();
        logEl.textContent += '[' + ts + '] ' + msg + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(state, text) {
        statusLight.className = 'light ' + state;
        statusText.textContent = text;
    }

    function setError(message) {
        lastErrorEl.textContent = message || 'none';
    }

    function updateMcpConfig(port) {
        var config = {
            mcpServers: {
                ae: {
                    command: 'ae-mcp',
                    env: {
                        AE_MCP_BACKEND: 'ae-mcp',
                        AE_MCP_PLUGIN_URL: 'http://127.0.0.1:' + port
                    }
                }
            }
        };
        mcpConfigEl.textContent = JSON.stringify(config, null, 2);
    }

    function normalizeCepPath(value) {
        var normalized = String(value || '');
        normalized = normalized.replace(/^file:\\+/i, '');
        normalized = normalized.replace(/^file:\/\/\//i, '');
        normalized = normalized.replace(/^file:\/\//i, '');
        normalized = decodeURIComponent(normalized);
        if (/^\/[A-Za-z]:/.test(normalized)) {
            normalized = normalized.slice(1);
        }
        return normalized;
    }

    setStatus('starting', 'Starting host...');
    setError('');
    updateMcpConfig(parseInt(portInput.value, 10));
    log('Panel loaded.');

    var host = null;
    try {
        var cepNode = (require('process').versions && require('process').versions['cep-node']) || 'unknown';
        log('CEP Node: ' + cepNode);

        var path = require('path');
        var extRoot = normalizeCepPath(cs.getSystemPath('extension'));
        var hostPath = path.join(extRoot, 'host', 'server.js');
        log('host: ' + hostPath);

        var server = require(hostPath);
        host = server;
        host.setCSInterface(cs);
        var port = parseInt(portInput.value, 10);
        host.start(port, function (err) {
            if (err) {
                setStatus('error', 'Failed: ' + err.message);
                setError(err.message);
                log('Error: ' + err.message);
            } else {
                setStatus('ok', 'Listening on 127.0.0.1:' + port);
                setError('');
                updateMcpConfig(port);
                log('Host ready.');
            }
        });
    } catch (e) {
        setStatus('error', 'Host crash: ' + e.message);
        setError(e.message);
        log('Host crash: ' + e.message);
    }

    applyBtn.addEventListener('click', function () {
        var newPort = parseInt(portInput.value, 10);
        if (!Number.isFinite(newPort) || newPort < 1024 || newPort > 65535) {
            log('Invalid port');
            setError('Invalid port');
            return;
        }
        updateMcpConfig(newPort);
        if (host && host.restart) {
            setStatus('starting', 'Restarting on ' + newPort + '...');
            host.restart(newPort, function (err) {
                if (err) {
                    setStatus('error', 'Restart failed: ' + err.message);
                    setError(err.message);
                } else {
                    setStatus('ok', 'Listening on 127.0.0.1:' + newPort);
                    setError('');
                    log('Restarted on ' + newPort);
                }
            });
        }
    });

    copyConfigBtn.addEventListener('click', function () {
        var range = document.createRange();
        range.selectNodeContents(mcpConfigEl);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        try {
            document.execCommand('copy');
            log('MCP config copied.');
        } catch (e) {
            setError('Copy failed: ' + e.message);
        }
        selection.removeAllRanges();
    });
})();
