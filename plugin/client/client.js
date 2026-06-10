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

    // Persist the chosen port across panel restarts. Without this the input
    // resets to the index.html default (11488) every launch, silently breaking
    // AE_MCP_PLUGIN_URL for users who changed it to dodge a port conflict.
    var PORT_STORAGE_KEY = 'ae_mcp_panel_port';

    function isValidPort(p) {
        return isFinite(p) && p >= 1024 && p <= 65535;
    }

    function loadSavedPort() {
        try {
            var raw = window.localStorage.getItem(PORT_STORAGE_KEY);
            var p = parseInt(raw, 10);
            if (isValidPort(p)) {
                return p;
            }
        } catch (e) {
            // localStorage may be unavailable in some CEP hosts; ignore.
        }
        return null;
    }

    function savePort(port) {
        try {
            window.localStorage.setItem(PORT_STORAGE_KEY, String(port));
        } catch (e) {
            // Non-fatal: persistence is best-effort.
        }
    }

    // Restore the saved port (overrides the index.html default) before any
    // code reads portInput.value below.
    var savedPort = loadSavedPort();
    if (savedPort !== null) {
        portInput.value = savedPort;
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
                savePort(port);
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
        if (!isValidPort(newPort)) {
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
                    savePort(newPort);
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
