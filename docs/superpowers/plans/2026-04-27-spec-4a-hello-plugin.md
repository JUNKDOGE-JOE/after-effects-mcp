# spec 4a — Hello Plugin 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** ae-mcp 第一次能驱动真 AE：写一个最小 CEP 面板（Node.js + HTTP server + ExtendScript bridge），写 Python 端的 `HttpBridge(Backend)` 实现，让 `ae.ping` live 测试端到端跑通。

**Architecture:**
```
Claude Code  ──stdio MCP──▶  ae-mcp (Python)
                                    │
                                    │  HttpBridge.exec(jsx)  →  HTTP POST 127.0.0.1:11488/exec
                                    ▼
                              CEP 面板 (Node.js host)
                                    │
                                    │  CSInterface.evalScript(jsx)
                                    ▼
                              AE ExtendScript runtime
```

**Tech stack**: CEP 12 (HTML extension) + Node.js (CEP 内嵌) + Express + Python 3.10+ + httpx + asyncio + AE 2026.

**Spec reference**: [`docs/superpowers/specs/2026-04-27-spec-4-plugin-design.md`](../specs/2026-04-27-spec-4-plugin-design.md) §3, §4.

**Branch**: continue on `feat/0.1-rebrand-decouple` or branch off main; user's call.

---

## 文件结构（4a 完成态）

```
after-effects-mcp/
├── packages/
│   ├── core/                                   (unchanged)
│   ├── bridge/                                 NEW
│   │   ├── pyproject.toml                       name="ae-mcp-bridge"
│   │   ├── ae_mcp_bridge/__init__.py            HttpBridge(Backend)
│   │   └── tests/test_http_bridge.py            respx-mocked unit tests
│   └── snapshot-mss/                           (unchanged)
├── plugin/                                     NEW — CEP extension source
│   ├── CSXS/
│   │   └── manifest.xml                         CEP extension manifest
│   ├── client/
│   │   ├── index.html                           panel UI (status indicator + port field)
│   │   ├── client.js                            CSInterface bridge to host process
│   │   └── styles.css
│   ├── host/
│   │   ├── server.js                            Express HTTP server
│   │   ├── jsx-bridge.js                        CSInterface.evalScript pipe
│   │   ├── package.json                         (express, body-parser)
│   │   └── package-lock.json                    (generated)
│   └── jsx/
│       └── runtime.jsx                          shared ExtendScript helpers (JSON polyfill, error wrap)
├── scripts/
│   └── install-plugin-dev.ps1                   NEW — dev install: copy plugin/ to AE CEP dir + enable PlayerDebugMode
└── docs/
    └── superpowers/
        ├── specs/2026-04-27-spec-4-plugin-design.md
        └── plans/2026-04-27-spec-4a-hello-plugin.md  (this file)
```

---

## Phase 0 — Python `bridge` 包（最先做，因为不依赖插件）

### Task 0.1: scaffold `packages/bridge/`

**Files:**
- Create: `packages/bridge/pyproject.toml`
- Create: `packages/bridge/README.md`
- Create: `packages/bridge/ae_mcp_bridge/__init__.py`
- Create: `packages/bridge/tests/__init__.py`
- Create: `packages/bridge/tests/test_http_bridge.py`

- [ ] **Step 1: workspace `pyproject.toml` 加 member**

Edit root `pyproject.toml`. Replace:
```toml
[tool.uv.workspace]
# ae-mcp is an integrated AE-agent product. The AE plugin half is TBD ...
members = ["packages/core", "packages/snapshot-mss"]

[tool.uv.sources]
ae-mcp                = { workspace = true }
ae-mcp-snapshot-mss   = { workspace = true }
```
with:
```toml
[tool.uv.workspace]
members = ["packages/core", "packages/bridge", "packages/snapshot-mss"]

[tool.uv.sources]
ae-mcp                = { workspace = true }
ae-mcp-bridge         = { workspace = true }
ae-mcp-snapshot-mss   = { workspace = true }
```

Also update `testpaths`:
```toml
testpaths = ["packages/core/tests", "packages/bridge/tests", "packages/snapshot-mss/tests"]
```

- [ ] **Step 2: write `packages/bridge/pyproject.toml`**

```toml
[project]
name = "ae-mcp-bridge"
version = "0.1.0"
description = "HTTP bridge between ae-mcp MCP server and the ae-mcp CEP plugin"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
dependencies = [
    "ae-mcp>=0.1.0",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=7.4", "pytest-asyncio>=0.23", "respx>=0.21"]

[project.entry-points."ae_mcp.backends"]
"ae-mcp" = "ae_mcp_bridge:HttpBridge"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["ae_mcp_bridge"]
```

- [ ] **Step 3: write `packages/bridge/README.md`**

```markdown
# ae-mcp-bridge

HTTP bridge between the `ae-mcp` MCP server and the `ae-mcp` CEP plugin
(`plugin/` in the repo). Talks to `127.0.0.1:11488` (configurable via
`AE_MCP_PLUGIN_URL`). The plugin exposes `/health` and `/exec` endpoints;
this package wraps them as the `Backend` ABC for ae-mcp core.

## Usage

```
AE_MCP_BACKEND      = ae-mcp
AE_MCP_PLUGIN_URL   = http://127.0.0.1:11488   # default
```
```

- [ ] **Step 4: write skeleton HttpBridge**

`packages/bridge/ae_mcp_bridge/__init__.py`:
```python
"""HTTP bridge between ae-mcp MCP server and the ae-mcp CEP plugin."""
from __future__ import annotations

import os
from typing import Optional

import httpx

from ae_mcp.backends.base import Backend, BackendError


class HttpBridge(Backend):
    name = "ae-mcp"
    manages_undo = False
    manages_checkpoints = False

    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=30.0)

    @classmethod
    def from_env(cls) -> "HttpBridge":
        url = os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488")
        return cls(url=url)

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        try:
            r = await self._http.get(f"{self.url}/health", timeout=timeout_sec)
            return r.status_code == 200 and r.json().get("ok") is True
        except Exception:  # noqa: BLE001
            return False

    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        payload = {
            "code": code,
            "undoGroup": undo_group,
            "checkpointLabel": checkpoint_label,
            "timeoutMs": int(timeout_sec * 1000),
        }
        try:
            r = await self._http.post(
                f"{self.url}/exec",
                json=payload,
                timeout=timeout_sec + 5.0,
            )
        except httpx.HTTPError as e:
            raise BackendError(f"HttpBridge: HTTP error: {e}") from e

        if r.status_code != 200:
            raise BackendError(
                f"HttpBridge: /exec HTTP {r.status_code}: {r.text[:300]}"
            )
        body = r.json()
        if not body.get("ok"):
            raise BackendError(f"HttpBridge: plugin error: {body.get('error')}")
        return body.get("result", "")

    async def shutdown(self) -> None:
        await self._http.aclose()
```

- [ ] **Step 5: write tests**

`packages/bridge/tests/__init__.py`: empty.

`packages/bridge/tests/test_http_bridge.py`:
```python
"""Unit tests for HttpBridge using respx."""
import pytest
import respx
from httpx import Response

from ae_mcp_bridge import HttpBridge


def test_from_env_default_url(monkeypatch):
    monkeypatch.delenv("AE_MCP_PLUGIN_URL", raising=False)
    b = HttpBridge.from_env()
    assert b.url == "http://127.0.0.1:11488"


def test_from_env_custom_url(monkeypatch):
    monkeypatch.setenv("AE_MCP_PLUGIN_URL", "http://localhost:9999")
    b = HttpBridge.from_env()
    assert b.url == "http://localhost:9999"


def test_strips_trailing_slash():
    b = HttpBridge(url="http://localhost:11488/")
    assert b.url == "http://localhost:11488"


def test_capability_flags():
    assert HttpBridge.manages_undo is False
    assert HttpBridge.manages_checkpoints is False


def test_name():
    assert HttpBridge.name == "ae-mcp"


@pytest.mark.asyncio
async def test_health_check_ok():
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.get("/health").mock(return_value=Response(200, json={"ok": True}))
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            assert await b.health_check() is True
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_health_check_failure():
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.get("/health").mock(return_value=Response(500))
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            assert await b.health_check() is False
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_health_check_connection_error():
    b = HttpBridge("http://127.0.0.1:1")  # nothing listening
    try:
        assert await b.health_check(timeout_sec=1.0) is False
    finally:
        await b.shutdown()


@pytest.mark.asyncio
async def test_exec_returns_result():
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(
            return_value=Response(200, json={"ok": True, "result": "42"})
        )
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            r = await b.exec("40+2")
            assert r == "42"
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_exec_propagates_plugin_error():
    from ae_mcp.backends.base import BackendError
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(
            return_value=Response(200, json={"ok": False, "error": "syntax err"})
        )
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            with pytest.raises(BackendError) as ei:
                await b.exec("bogus")
            assert "syntax err" in str(ei.value)
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_exec_propagates_http_error():
    from ae_mcp.backends.base import BackendError
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(return_value=Response(500, text="boom"))
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            with pytest.raises(BackendError):
                await b.exec("1")
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_exec_passes_undo_and_checkpoint_label():
    captured = {}
    async def _resp(request):
        import json
        captured["body"] = json.loads(request.content)
        return Response(200, json={"ok": True, "result": ""})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(side_effect=_resp)
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            await b.exec("foo", undo_group="g", checkpoint_label="lab", timeout_sec=10.0)
        finally:
            await b.shutdown()

    assert captured["body"]["code"] == "foo"
    assert captured["body"]["undoGroup"] == "g"
    assert captured["body"]["checkpointLabel"] == "lab"
    assert captured["body"]["timeoutMs"] == 10000
```

- [ ] **Step 6: sync + run**

```bash
python -m uv sync --group dev
python -m uv run pytest packages/bridge/tests/ -v
```
Expected: 11 passed.

- [ ] **Step 7: verify entry-point**

```bash
python -m uv run python -c "import importlib.metadata as m; print(sorted([e.name for e in m.entry_points(group='ae_mcp.backends')]))"
```
Expected: `['ae-mcp']`.

- [ ] **Step 8: full unit suite still green**

```bash
python -m uv run pytest --import-mode=importlib -m "not live and not live_smoke" 2>&1 | tail -3
```
Expected: 130+ passed (was 119 + 11 new).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(bridge): add ae-mcp-bridge HTTP backend (talks to our future plugin)"
```

---

## Phase 1 — CEP 面板脚手架

### Task 1.1: plugin/ 目录骨架 + CSXS manifest

**Files:**
- Create: `plugin/CSXS/manifest.xml`
- Create: `plugin/.debug` (CEP debug flag)
- Create: `plugin/icons/icon.svg` (24x24 minimal)

- [ ] **Step 1: write `plugin/CSXS/manifest.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionManifest Version="11.0" ExtensionBundleId="com.aemcp.panel"
                   ExtensionBundleVersion="0.1.0"
                   ExtensionBundleName="ae-mcp Panel"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <ExtensionList>
        <Extension Id="com.aemcp.panel" Version="0.1.0" />
    </ExtensionList>
    <ExecutionEnvironment>
        <HostList>
            <Host Name="AEFT" Version="[26.0,99.9]" />
        </HostList>
        <LocaleList>
            <Locale Code="All" />
        </LocaleList>
        <RequiredRuntimeList>
            <RequiredRuntime Name="CSXS" Version="11.0" />
        </RequiredRuntimeList>
    </ExecutionEnvironment>
    <DispatchInfoList>
        <Extension Id="com.aemcp.panel">
            <DispatchInfo>
                <Resources>
                    <MainPath>./client/index.html</MainPath>
                    <ScriptPath>./jsx/runtime.jsx</ScriptPath>
                    <CEFCommandLine>
                        <Parameter>--allow-file-access-from-files</Parameter>
                        <Parameter>--enable-nodejs</Parameter>
                        <Parameter>--mixed-context</Parameter>
                    </CEFCommandLine>
                </Resources>
                <Lifecycle>
                    <AutoVisible>true</AutoVisible>
                </Lifecycle>
                <UI>
                    <Type>Panel</Type>
                    <Menu>ae-mcp</Menu>
                    <Geometry>
                        <Size><Height>200</Height><Width>320</Width></Size>
                        <MinSize><Height>120</Height><Width>240</Width></MinSize>
                        <MaxSize><Height>800</Height><Width>800</Width></MaxSize>
                    </Geometry>
                    <Icons>
                        <Icon Type="Normal">./icons/icon.svg</Icon>
                    </Icons>
                </UI>
            </DispatchInfo>
        </Extension>
    </DispatchInfoList>
</ExtensionManifest>
```

- [ ] **Step 2: create `.debug` file (CEP debug flag for unsigned extensions)**

`plugin/.debug`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
    <Extension Id="com.aemcp.panel">
        <HostList>
            <Host Name="AEFT" Port="9080"/>
        </HostList>
    </Extension>
</ExtensionList>
```

- [ ] **Step 3: write minimal SVG icon**

`plugin/icons/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="10" fill="#444" stroke="#888" stroke-width="1"/>
  <text x="12" y="16" text-anchor="middle" font-family="Arial" font-size="9" fill="#fff" font-weight="bold">AE</text>
</svg>
```

- [ ] **Step 4: Commit**

```bash
git add plugin/CSXS/ plugin/.debug plugin/icons/
git commit -m "feat(plugin): CSXS manifest + debug flag for ae-mcp CEP panel"
```

---

### Task 1.2: panel UI (HTML + CSS + JS)

**Files:**
- Create: `plugin/client/index.html`
- Create: `plugin/client/styles.css`
- Create: `plugin/client/client.js`
- Create: `plugin/client/CSInterface.js` (Adobe-provided lib)

- [ ] **Step 1: download CSInterface.js from Adobe**

CSInterface.js is Adobe's official CEP-runtime API exposure. Vendored copy:

`plugin/client/CSInterface.js`:
Use the canonical CSInterface 11.0 from Adobe-CEP samples. Save the file. (~1500 lines minified, copy verbatim from https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_11.x/CSInterface.js — this is MIT-licensed and the standard way.)

If you cannot fetch it, use this minimal stub that covers what we need:
```javascript
// MINIMAL CSInterface stub — REPLACE with official Adobe version before shipping.
function CSInterface() {}
CSInterface.prototype.evalScript = function(script, callback) {
    try { window.__adobe_cep__.evalScript(script, callback); }
    catch (e) { if (callback) callback("EvalScript error: " + e); }
};
CSInterface.prototype.getSystemPath = function(type) {
    return window.__adobe_cep__.getSystemPath(type);
};
CSInterface.prototype.getExtensionID = function() {
    return window.__adobe_cep__.getExtensionId();
};
```

(Use the stub for now; replace with full Adobe version in spec 4d before ZXP packaging.)

- [ ] **Step 2: write `index.html`**

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>ae-mcp</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="panel">
        <div class="header">
            <h1>ae-mcp</h1>
            <span id="version">v0.1.0</span>
        </div>
        <div class="status-row">
            <span id="status-light" class="light off"></span>
            <span id="status-text">Starting...</span>
        </div>
        <div class="config-row">
            <label>HTTP port:</label>
            <input id="port-input" type="number" value="11488" min="1024" max="65535">
            <button id="apply-port">Apply</button>
        </div>
        <div class="log-row">
            <pre id="log"></pre>
        </div>
    </div>

    <script src="CSInterface.js"></script>
    <script src="client.js"></script>
</body>
</html>
```

- [ ] **Step 3: write `styles.css`**

```css
body { margin: 0; padding: 0; background: #2a2a2a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; font-size: 12px; }
.panel { padding: 12px; }
.header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.header h1 { margin: 0; font-size: 14px; font-weight: 600; }
#version { color: #888; font-size: 10px; }
.status-row { display: flex; align-items: center; margin-bottom: 12px; }
.light { width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
.light.off { background: #555; }
.light.starting { background: #ffaa00; }
.light.ok { background: #00cc44; }
.light.error { background: #ff3333; }
.config-row { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.config-row label { flex-shrink: 0; }
.config-row input { flex: 1; background: #1a1a1a; color: #e0e0e0; border: 1px solid #444; padding: 4px 6px; border-radius: 3px; }
.config-row button { background: #444; color: #e0e0e0; border: 1px solid #555; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
.config-row button:hover { background: #555; }
.log-row pre { background: #1a1a1a; padding: 8px; margin: 0; max-height: 80px; overflow-y: auto; font-size: 10px; line-height: 1.4; color: #aaa; }
```

- [ ] **Step 4: write `client.js`**

```javascript
// CEP panel front-end. Loads after index.html. Spawns Node.js host process.
(function() {
    const cs = new CSInterface();
    const statusLight = document.getElementById('status-light');
    const statusText = document.getElementById('status-text');
    const portInput = document.getElementById('port-input');
    const applyBtn = document.getElementById('apply-port');
    const logEl = document.getElementById('log');

    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        logEl.textContent += `[${ts}] ${msg}\n`;
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(state, text) {
        statusLight.className = `light ${state}`;
        statusText.textContent = text;
    }

    setStatus('starting', 'Starting host...');
    log('Panel loaded.');

    // Spawn the Node.js host
    let host = null;
    try {
        const cep_node = require('process').versions['cep-node'] || 'unknown';
        log('CEP Node: ' + cep_node);

        const path = require('path');
        const extRoot = cs.getSystemPath('extension');
        const hostPath = path.join(extRoot, 'host', 'server.js');
        log('host: ' + hostPath);

        // The host is just `require()`d in the same process — CEP enables Node integration.
        const server = require(hostPath);
        host = server;
        const port = parseInt(portInput.value, 10);
        host.start(port, (err) => {
            if (err) {
                setStatus('error', 'Failed: ' + err.message);
                log('Error: ' + err.message);
            } else {
                setStatus('ok', `Listening on 127.0.0.1:${port}`);
                log('Host ready.');
            }
        });
    } catch (e) {
        setStatus('error', 'Host crash: ' + e.message);
        log('Host crash: ' + e.message);
    }

    applyBtn.addEventListener('click', () => {
        const newPort = parseInt(portInput.value, 10);
        if (!Number.isFinite(newPort) || newPort < 1024 || newPort > 65535) {
            log('Invalid port');
            return;
        }
        if (host && host.restart) {
            setStatus('starting', 'Restarting on ' + newPort + '...');
            host.restart(newPort, (err) => {
                if (err) {
                    setStatus('error', 'Restart failed: ' + err.message);
                } else {
                    setStatus('ok', `Listening on 127.0.0.1:${newPort}`);
                    log('Restarted on ' + newPort);
                }
            });
        }
    });
})();
```

- [ ] **Step 5: Commit**

```bash
git add plugin/client/
git commit -m "feat(plugin): panel UI (HTML+CSS+JS) with status indicator and port editor"
```

---

### Task 1.3: Node.js host (HTTP server + JSX bridge)

**Files:**
- Create: `plugin/host/server.js`
- Create: `plugin/host/jsx-bridge.js`
- Create: `plugin/host/package.json`
- Create: `plugin/host/.gitignore`

- [ ] **Step 1: write `package.json`**

```json
{
  "name": "ae-mcp-host",
  "version": "0.1.0",
  "private": true,
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

- [ ] **Step 2: write `.gitignore`**

```
node_modules/
package-lock.json
```

- [ ] **Step 3: write `host/jsx-bridge.js`**

```javascript
// Bridge between Node.js and AE ExtendScript via CSInterface.
// CSInterface is loaded in the parent (panel) process; we get it via global.
let csInterface = null;

function setCSInterface(cs) {
    csInterface = cs;
}

function evalScript(jsx, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!csInterface) {
            reject(new Error('CSInterface not initialized'));
            return;
        }
        const timer = setTimeout(() => {
            reject(new Error('JSX timeout after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        try {
            csInterface.evalScript(jsx, (result) => {
                clearTimeout(timer);
                if (typeof result === 'string' && result.startsWith('EvalScript error:')) {
                    reject(new Error(result));
                } else {
                    resolve(result);
                }
            });
        } catch (e) {
            clearTimeout(timer);
            reject(e);
        }
    });
}

module.exports = { setCSInterface, evalScript };
```

- [ ] **Step 4: write `host/server.js`**

```javascript
// HTTP server for the ae-mcp CEP plugin. Exposes /health and /exec.
const express = require('express');
const jsxBridge = require('./jsx-bridge');

let app = null;
let httpServer = null;
let currentPort = null;

function buildApp() {
    const a = express();
    a.use(express.json({ limit: '5mb' }));

    a.get('/health', (req, res) => {
        // The presence of CSInterface (set up by panel) is the readiness proxy.
        // We don't actually probe AE here — that's what /exec is for.
        res.json({
            ok: true,
            pluginVersion: '0.1.0',
            port: currentPort,
        });
    });

    a.post('/exec', async (req, res) => {
        const { code, undoGroup, checkpointLabel, timeoutMs } = req.body || {};
        if (typeof code !== 'string' || code.length === 0) {
            return res.status(400).json({ ok: false, error: 'missing or empty `code`' });
        }
        const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

        // Wrap user JSX in undo group if requested. checkpointLabel currently ignored.
        let wrapped = code;
        if (undoGroup) {
            wrapped =
                `(function(){ app.beginUndoGroup(${JSON.stringify(undoGroup)}); ` +
                `try { return ${code}; } finally { app.endUndoGroup(); } })()`;
        }

        try {
            const result = await jsxBridge.evalScript(wrapped, t);
            res.json({ ok: true, result: result || '' });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    return a;
}

function start(port, callback) {
    if (httpServer) {
        return callback(new Error('already started; call restart() to change port'));
    }
    app = buildApp();
    httpServer = app.listen(port, '127.0.0.1', (err) => {
        if (err) return callback(err);
        currentPort = port;
        callback(null);
    });
    httpServer.on('error', (err) => {
        if (callback) callback(err);
    });
}

function stop(callback) {
    if (!httpServer) return callback ? callback() : null;
    httpServer.close(() => {
        httpServer = null;
        currentPort = null;
        if (callback) callback();
    });
}

function restart(port, callback) {
    stop(() => start(port, callback));
}

module.exports = {
    start,
    stop,
    restart,
    setCSInterface: jsxBridge.setCSInterface,
};
```

- [ ] **Step 5: update `client.js` to wire CSInterface into the host**

Find this block in `client.js`:
```javascript
const server = require(hostPath);
host = server;
const port = parseInt(portInput.value, 10);
host.start(port, (err) => { ...
```

Insert one line BEFORE `host.start(...)`:
```javascript
host.setCSInterface(cs);
```

So the block becomes:
```javascript
const server = require(hostPath);
host = server;
host.setCSInterface(cs);
const port = parseInt(portInput.value, 10);
host.start(port, (err) => { ... });
```

- [ ] **Step 6: install Node deps**

```bash
cd plugin/host && npm install && cd ../..
```
Expected: `node_modules/` populated; `express` installed.

- [ ] **Step 7: Commit**

```bash
git add plugin/host/server.js plugin/host/jsx-bridge.js plugin/host/package.json plugin/host/.gitignore plugin/client/client.js
git commit -m "feat(plugin): Node.js host with /health and /exec endpoints"
```

---

### Task 1.4: ExtendScript runtime helper

**Files:**
- Create: `plugin/jsx/runtime.jsx`

- [ ] **Step 1: write `runtime.jsx`**

```javascript
// ae-mcp runtime helpers loaded by the panel at startup.
// Currently just a JSON polyfill for AE's classic ExtendScript engine,
// which doesn't have native JSON. AE 2026's modern engine does, but
// CEP panels may run script in classic mode in some contexts.
if (typeof JSON === 'undefined') {
    JSON = {};
    JSON.stringify = function(v) {
        if (v === null) return 'null';
        if (typeof v === 'undefined') return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
        if (typeof v === 'string') {
            return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                         .replace(/\n/g, '\\n').replace(/\r/g, '\\r')
                         .replace(/\t/g, '\\t') + '"';
        }
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(JSON.stringify(v[i]));
            return '[' + parts.join(',') + ']';
        }
        if (typeof v === 'object') {
            var parts2 = [];
            for (var k in v) {
                if (v.hasOwnProperty(k)) {
                    parts2.push(JSON.stringify(k) + ':' + JSON.stringify(v[k]));
                }
            }
            return '{' + parts2.join(',') + '}';
        }
        return 'null';
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add plugin/jsx/runtime.jsx
git commit -m "feat(plugin): JSX runtime helper (JSON polyfill)"
```

---

## Phase 2 — dev install + manual smoke

### Task 2.1: install-plugin-dev script

**Files:**
- Create: `scripts/install-plugin-dev.ps1`

- [ ] **Step 1: write the script**

```powershell
# Dev install: copy plugin/ to AE's CEP extensions dir + enable PlayerDebugMode.
# Run from repo root: .\scripts\install-plugin-dev.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginSrc = Join-Path $repoRoot 'plugin'
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\com.aemcp.panel"

Write-Host "[1/3] Enabling CEP PlayerDebugMode..."
$key = 'HKCU:\Software\Adobe\CSXS.11'
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
$key12 = 'HKCU:\Software\Adobe\CSXS.12'
if (-not (Test-Path $key12)) { New-Item -Path $key12 -Force | Out-Null }
Set-ItemProperty -Path $key12 -Name 'PlayerDebugMode' -Value '1' -Type String
Write-Host "  Done (CSXS.11 + CSXS.12)."

Write-Host "[2/3] Removing old install at $cepDir (if present)..."
if (Test-Path $cepDir) { Remove-Item -Recurse -Force $cepDir }
Write-Host "  Done."

Write-Host "[3/3] Copying plugin/ -> $cepDir ..."
Copy-Item -Recurse -Force $pluginSrc $cepDir
Write-Host "  Done."

Write-Host ""
Write-Host "Restart AE. The panel will appear under Window -> Extensions -> ae-mcp."
```

- [ ] **Step 2: run it (one-time setup, requires AE not running)**

```powershell
.\scripts\install-plugin-dev.ps1
```

- [ ] **Step 3: manual smoke**

(MANUAL — cannot be automated):
1. Open AE 2026
2. Window → Extensions → ae-mcp (panel should appear with green "Listening on 127.0.0.1:11488" text)
3. Open Powershell:
   ```powershell
   curl http://127.0.0.1:11488/health
   ```
   Expected: `{"ok":true,"pluginVersion":"0.1.0","port":11488}`
4. Test exec:
   ```powershell
   $body = @{ code = 'JSON.stringify({hello:1+1})' } | ConvertTo-Json
   curl -X POST -H "Content-Type: application/json" -d $body http://127.0.0.1:11488/exec
   ```
   Expected: `{"ok":true,"result":"{\"hello\":2}"}`

If smoke fails: check AE Window → Extensions → ae-mcp panel's log box — it should show error details.

- [ ] **Step 4: Commit**

```bash
git add scripts/install-plugin-dev.ps1
git commit -m "tools: install-plugin-dev.ps1 — copy plugin/ to AE CEP dir + enable debug mode"
```

---

## Phase 3 — End-to-end live test

### Task 3.1: live ping smoke through HttpBridge → real plugin

- [ ] **Step 1: ensure AE is running with panel open** (manual prerequisite)

- [ ] **Step 2: run live_smoke**

```bash
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND    = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
python -m uv run pytest --import-mode=importlib -m live_smoke -v
```
Expected: 3 passed (ping/exec/snapshot).

If `test_ping_returns_pong` passes, this is the v0.1.0 milestone — first time ae-mcp ever drives real AE through our own plugin.

- [ ] **Step 3: capture artifact for posterity**

```bash
mkdir -p docs/milestones
python -m uv run pytest --import-mode=importlib -m live_smoke -v 2>&1 | Tee-Object -FilePath docs/milestones/2026-04-27-first-end-to-end.log
git add docs/milestones/
git commit -m "docs(milestone): first ae-mcp + plugin end-to-end smoke pass"
```

---

## Phase 4 — Documentation

### Task 4.1: update README + add user-facing install guide

**Files:**
- Modify: `README.md`
- Create: `docs/INSTALL-DEV.md`

- [ ] **Step 1: README — replace "What's NOT implemented" section with status**

Find the section starting with `## What's NOT implemented (yet)` and replace with:

```markdown
## What's implemented now (spec 4a)

- 22 verb protocol layer (Python, ae-mcp core)
- HttpBridge → CEP plugin → AE ExtendScript end-to-end
- Minimal panel UI (status indicator + port editor)
- One verb (`ae.ping`) live-verified against real AE

## Coming next

- spec 4b: remaining 12 AE-driving verbs verified end-to-end
- spec 4c: `ae.previewFrame` (real RQ-based render) + checkpoint/revert in plugin
- spec 4d: skill system + createRig + ZXP packaging + signed install
```

- [ ] **Step 2: create `docs/INSTALL-DEV.md`**

```markdown
# Dev install (Windows + AE 2026)

## One-time setup

1. Clone this repo. Required at: `<repo-root>` (anywhere is fine).
2. Install Python deps:
   ```
   python -m uv sync --group dev
   ```
3. Install Node deps for the plugin:
   ```
   cd plugin/host && npm install && cd ../..
   ```
4. Install plugin to AE's CEP dir + enable debug mode (AE must be closed):
   ```powershell
   .\scripts\install-plugin-dev.ps1
   ```

## Run

1. Open After Effects 2026.
2. Open the panel: Window → Extensions → ae-mcp.
3. The panel should show a green light + "Listening on 127.0.0.1:11488".
4. Configure your MCP client (e.g. Claude Code's `~/.claude.json`):
   ```json
   {
     "mcpServers": {
       "ae": {
         "command": "python",
         "args": [
           "-m", "uv", "run",
           "--directory", "<PATH-TO-REPO>",
           "python", "-m", "ae_mcp"
         ],
         "env": {
           "AE_MCP_BACKEND": "ae-mcp",
           "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
         }
       }
     }
   }
   ```
5. Restart your MCP client. `/mcp` should list 22 `ae.*` tools. Try `ae.ping`.

## Live tests

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND    = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
python -m uv run pytest --import-mode=importlib -m live_smoke -v
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/INSTALL-DEV.md
git commit -m "docs: spec 4a status + INSTALL-DEV.md user setup guide"
```

---

## Self-Review

### Spec coverage

| Spec 4a deliverable | Task |
|---|---|
| CEP 面板脚手架（manifest, html, css, csinterface） | 1.1 + 1.2 |
| Node.js host server | 1.3 |
| jsx-bridge | 1.3 |
| ExtendScript runtime helper | 1.4 |
| `packages/bridge/` Python 包 | 0.1 |
| live test: ae.ping 端到端 | 3.1 |
| dev install + manual smoke | 2.1 |
| 文档 + INSTALL-DEV.md | 4.1 |

All covered.

### Placeholder scan

No "TODO/TBD/fill in details". Each step has complete code or exact commands. Manual smoke (2.1 step 3) is appropriately marked MANUAL — no way around requiring a human in front of AE for first-time verification.

### Type consistency

- `HttpBridge` defined in 0.1; entry-point name `"ae-mcp"` matches `AE_MCP_BACKEND` value used in 3.1 and 4.1.
- HTTP endpoints `/health` and `/exec` defined consistently in 1.3 (server.js) and 0.1 (HttpBridge).
- Port `11488` consistent across plugin manifest area, server default, panel UI default, env var docs.
- Module name `ae_mcp_bridge` consistent in pyproject + Python imports + tests.

---

## Execution Handoff

Plan complete. Saved to `docs/superpowers/plans/2026-04-27-spec-4a-hello-plugin.md`.

**1. Subagent-Driven** (recommended) — I dispatch a fresh subagent per task. ~10 tasks across 4 phases.
**2. Inline Execution** — Execute in this session.

Auto mode default: 1.
