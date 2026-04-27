# ae-mcp 发布检查 / Release Checklist

## 中文

### 打包 ZXP

安装 Adobe `ZXPSignCmd`，然后运行：

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
```

脚本会 staging CEP 面板、在 `plugin/host` 里运行 `npm ci --omit=dev`、按需创建 self-signed certificate，并输出 `release/ae-mcp-panel.zxp`。

### Smoke

1. 从干净 checkout 或 ZXP 安装。
2. 重启 After Effects。
3. 打开 `Window -> Extensions -> ae-mcp`。
4. 确认面板绿灯。
5. 配置 MCP client：`AE_MCP_BACKEND=ae-mcp`，端口与面板一致。
6. 运行 `ae.ping`。
7. 在新 comp 里运行 `ae.previewFrame`。
8. 运行 `ae.createRig`，`rig_type=transform_controller`。
9. 任何写表达式的改动，视觉检查前先运行 `ae.validateExpressions`。

### 已知发布前缺口

- `ae.previewFrame` 是快速 viewer capture，不是真实渲染，也不是精准 comp crop。
- `ae.createRig` 是 MVP，还没有内置 rig preset library。
- skill storage 可用，但还没有面板侧 skill 管理 UI。
- 公开 release 前还需要 clean-machine signed install smoke。

### 必跑验证

```powershell
uv run pytest
```

当前预期非 live 结果：`152 passed, 20 deselected`。

AE 打开且面板绿灯时：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

当前预期 live 结果：`20 passed`。

## English

### Package ZXP

Install Adobe `ZXPSignCmd`, then run:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
```

The script stages the CEP panel, runs `npm ci --omit=dev` for `plugin/host`, creates a self-signed certificate if needed, and writes `release/ae-mcp-panel.zxp`.

### Smoke

1. Install from a clean checkout or ZXP.
2. Restart After Effects.
3. Open `Window -> Extensions -> ae-mcp`.
4. Confirm the panel is green.
5. Configure the MCP client with `AE_MCP_BACKEND=ae-mcp` and the panel port.
6. Run `ae.ping`.
7. In a new comp, run `ae.previewFrame`.
8. Run `ae.createRig` with `rig_type=transform_controller`.
9. For any expression-bearing change, run `ae.validateExpressions` before visual review.

### Known Pre-Release Gaps

- `ae.previewFrame` is fast viewer capture, not a true render or precise comp crop.
- `ae.createRig` is an MVP and does not yet provide a bundled rig preset library.
- Skill storage is functional, but there is no panel UI for browsing/editing skills.
- A clean-machine signed install smoke is still required before public release.

### Required Verification

```powershell
uv run pytest
```

Current expected non-live result: `152 passed, 20 deselected`.

With AE open and panel green:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Current expected live result: `20 passed`.
