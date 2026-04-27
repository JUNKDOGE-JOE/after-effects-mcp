// CEP panel front-end. Loads after index.html. Spawns Node.js host process.
(function () {
    var cs = new CSInterface();
    var statusLight = document.getElementById('status-light');
    var statusText = document.getElementById('status-text');
    var portInput = document.getElementById('port-input');
    var applyBtn = document.getElementById('apply-port');
    var logEl = document.getElementById('log');

    function log(msg) {
        var ts = new Date().toLocaleTimeString();
        logEl.textContent += '[' + ts + '] ' + msg + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(state, text) {
        statusLight.className = 'light ' + state;
        statusText.textContent = text;
    }

    setStatus('starting', 'Starting host...');
    log('Panel loaded.');

    var host = null;
    try {
        var cepNode = (require('process').versions && require('process').versions['cep-node']) || 'unknown';
        log('CEP Node: ' + cepNode);

        var path = require('path');
        var extRoot = cs.getSystemPath('extension');
        var hostPath = path.join(extRoot, 'host', 'server.js');
        log('host: ' + hostPath);

        var server = require(hostPath);
        host = server;
        host.setCSInterface(cs);
        var port = parseInt(portInput.value, 10);
        host.start(port, function (err) {
            if (err) {
                setStatus('error', 'Failed: ' + err.message);
                log('Error: ' + err.message);
            } else {
                setStatus('ok', 'Listening on 127.0.0.1:' + port);
                log('Host ready.');
            }
        });
    } catch (e) {
        setStatus('error', 'Host crash: ' + e.message);
        log('Host crash: ' + e.message);
    }

    applyBtn.addEventListener('click', function () {
        var newPort = parseInt(portInput.value, 10);
        if (!Number.isFinite(newPort) || newPort < 1024 || newPort > 65535) {
            log('Invalid port');
            return;
        }
        if (host && host.restart) {
            setStatus('starting', 'Restarting on ' + newPort + '...');
            host.restart(newPort, function (err) {
                if (err) {
                    setStatus('error', 'Restart failed: ' + err.message);
                } else {
                    setStatus('ok', 'Listening on 127.0.0.1:' + newPort);
                    log('Restarted on ' + newPort);
                }
            });
        }
    });
})();
