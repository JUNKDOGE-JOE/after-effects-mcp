# ae-mcp 发布检查 / Release Checklist

## 中文

这份 checklist 对齐 v0.7.0：Python 三件套、CEP 面板、React bundle、Claude sidecar、Codex app-server 集成、ZXP 包和部署同步都要一起处理。

## 1. 版本位点

发布前同步 16 个版本位点：

1. `packages/core/pyproject.toml`
2. `packages/bridge/pyproject.toml`
3. `packages/snapshot-mss/pyproject.toml`
4. `plugin/host/package.json`
5. `plugin/host/package-lock.json`
6. `plugin/panel/package.json`
7. `plugin/panel/package-lock.json`
8. `plugin/sidecar/package.json`
9. `plugin/sidecar/package-lock.json`
10. `plugin/CSXS/manifest.xml` 的 `ExtensionBundleVersion`
11. `plugin/CSXS/manifest.xml` 的 `<Extension Version=...>`
12. `plugin/host/server.js` 暴露给 `/health` 的插件版本
13. `plugin/client/dist/app.js` 中由 panel build 写入/携带的版本相关 bundle 内容
14. `README.md` 的 tag 安装示例
15. `docs/RELEASE.md` 的当前版本示例
16. 中英 CHANGELOG 入口（由发版步骤处理，不在本文档维护任务中编辑）

如果某个位点在代码中被重构，发布 PR 需要在描述里说明替代来源，不要静默减少检查面。

## 2. 重建 bundle

面板源码在 `plugin/panel`，发布包使用 `plugin/client/dist/app.js`。修改 panel UI 或版本后必须重建：

```powershell
cd plugin\panel
npm ci
npm run build
cd ..\..
```

发布 ZXP 前还要确认 `plugin/client/dist/app.js` 已进入 diff。不要只改 React 源码而忘记 bundle。

## 3. Python 安装 smoke

ae-mcp 当前不在 PyPI。开发 checkout 安装命令：

```powershell
uv tool install --force --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

发布 tag 安装命令：

```powershell
uv tool install --force --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/core ae-mcp --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/bridge --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/snapshot-mss
```

安装后确认 launcher 可被外部客户端找到。不要把公共 PyPI 同名包写成用户安装路径。

## 4. 必跑验证

非 live：

```powershell
uv run pytest
```

AE 打开且面板运行时：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

两后端 × 模型 smoke：

```powershell
node scripts/live-model-matrix.mjs
```

`scripts/live-model-matrix.mjs` 会跑 Claude sidecar 和 Codex `app-server`，每个模型一轮极小对话。它需要本机已登录 `claude` 和 `codex`。

## 5. 打包 ZXP

安装 Adobe `ZXPSignCmd`，然后运行：

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

可选参数：

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw> -CertPath release\ae-mcp.p12 -OutputPath release\ae-mcp-panel.zxp
```

脚本会：

- staging `plugin/`
- 移除 `host/node_modules`、`sidecar/node_modules`、`sidecar/test`、`panel` 源目录和 `.debug`
- 在 staged `host` 中运行 `npm ci --omit=dev`
- 在 staged `sidecar` 中运行 `npm ci --omit=dev`
- 按需创建 self-signed certificate
- 使用 TSA 时间戳签名
- 输出 `release/ae-mcp-panel.zxp`

## 6. 发布 smoke

1. 用 aescripts ZXP Installer 或 ExMan Cmd 安装 ZXP。
2. 重启 After Effects。
3. 打开 `Window -> Extensions -> ae-mcp`。
4. 确认 host 监听 `127.0.0.1:11488`。
5. 跑面板连接诊断：host、token、Python signal、AE project、ExtendScript ping、`uv` / `node` / `claude`。
6. 内嵌 Claude 订阅：用已登录 `claude` 发起一轮只读请求。
7. Claude API 直连通道：用 Anthropic API key 发起一轮只读请求。
8. Codex：用已登录 `codex` 发起一轮只读请求。
9. 外部 MCP 客户端：复制 MCP config，运行 `ae_ping` 和 `ae_overview`。
10. 在简单 comp 中运行 `ae_previewFrame`、`ae_createRig`、`ae_validateExpressions`。
11. 验证活动流记录工具调用，kill switch 能停止 AI 操作。

OpenCode 在 v0.7.0 只作为外部 MCP 客户端 smoke；不要把它写入内嵌后端发布声明。

## 7. 发布步骤

1. 更新 16 个版本位点。
2. 重建 `plugin/client/dist/app.js`。
3. 更新 CN/EN CHANGELOG。
4. 跑非 live、live、model matrix smoke。
5. 打 tag。
6. 创建 GitHub Release。
7. 重打包并上传 ZXP。
8. 做部署同步。
9. 用发布 tag 执行 `uv tool install --force ...` 重装 smoke。

## English

This checklist matches v0.7.0: the Python trio, CEP panel, React bundle, Claude sidecar, Codex app-server integration, ZXP package, and deployment sync are released together.

## 1. Version Locations

Before release, sync 16 version locations:

1. `packages/core/pyproject.toml`
2. `packages/bridge/pyproject.toml`
3. `packages/snapshot-mss/pyproject.toml`
4. `plugin/host/package.json`
5. `plugin/host/package-lock.json`
6. `plugin/panel/package.json`
7. `plugin/panel/package-lock.json`
8. `plugin/sidecar/package.json`
9. `plugin/sidecar/package-lock.json`
10. `plugin/CSXS/manifest.xml` `ExtensionBundleVersion`
11. `plugin/CSXS/manifest.xml` `<Extension Version=...>`
12. the plugin version exposed by `plugin/host/server.js` `/health`
13. version-related bundle content written/carried by `plugin/client/dist/app.js`
14. the tag install example in `README.md`
15. the current-version examples in `docs/RELEASE.md`
16. CN/EN CHANGELOG entries, handled by the release step rather than this docs-maintenance task

If a location is refactored away, the release PR should explain the replacement source instead of silently shrinking the checklist.

## 2. Rebuild Bundle

Panel source lives in `plugin/panel`; the release package uses `plugin/client/dist/app.js`. After panel UI or version changes, rebuild it:

```powershell
cd plugin\panel
npm ci
npm run build
cd ..\..
```

Before ZXP packaging, confirm `plugin/client/dist/app.js` is in the diff. Do not edit React source and forget the bundle.

## 3. Python Install Smoke

ae-mcp is not on PyPI. Development checkout install:

```powershell
uv tool install --force --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

Release-tag install:

```powershell
uv tool install --force --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/core ae-mcp --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/bridge --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/snapshot-mss
```

After install, confirm the launcher is visible to external clients. Do not document the public PyPI name as the user install path.

## 4. Required Verification

Non-live:

```powershell
uv run pytest
```

With AE open and the panel running:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Two-backend × model smoke:

```powershell
node scripts/live-model-matrix.mjs
```

`scripts/live-model-matrix.mjs` runs Claude sidecar and Codex `app-server`, one tiny chat turn per model. It needs local `claude` and `codex` logins.

## 5. Package ZXP

Install Adobe `ZXPSignCmd`, then run:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

Optional:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw> -CertPath release\ae-mcp.p12 -OutputPath release\ae-mcp-panel.zxp
```

The script:

- stages `plugin/`
- removes `host/node_modules`, `sidecar/node_modules`, `sidecar/test`, the `panel` source directory, and `.debug`
- runs `npm ci --omit=dev` in staged `host`
- runs `npm ci --omit=dev` in staged `sidecar`
- creates a self-signed certificate when needed
- signs with a TSA timestamp
- writes `release/ae-mcp-panel.zxp`

## 6. Release Smoke

1. Install the ZXP with aescripts ZXP Installer or ExMan Cmd.
2. Restart After Effects.
3. Open `Window -> Extensions -> ae-mcp`.
4. Confirm the host listens on `127.0.0.1:11488`.
5. Run panel diagnostics: host, token, Python signal, AE project, ExtendScript ping, `uv` / `node` / `claude`.
6. Built-in Claude subscription: send one read-only request with logged-in `claude`.
7. Claude API direct channel: send one read-only request with an Anthropic API key.
8. Codex: send one read-only request with logged-in `codex`.
9. External MCP client: copy MCP config and run `ae_ping` plus `ae_overview`.
10. In a simple comp, run `ae_previewFrame`, `ae_createRig`, and `ae_validateExpressions`.
11. Confirm the activity stream records tool calls and the kill switch stops AI operations.

OpenCode is only an external MCP client smoke in v0.7.0; do not list it as an embedded backend in release notes.

## 7. Release Steps

1. Update the 16 version locations.
2. Rebuild `plugin/client/dist/app.js`.
3. Update CN/EN CHANGELOG.
4. Run non-live, live, and model-matrix smoke.
5. Create the tag.
6. Create the GitHub Release.
7. Repackage and upload the ZXP.
8. Sync deployment.
9. Reinstall from the release tag with `uv tool install --force ...` and smoke it.
