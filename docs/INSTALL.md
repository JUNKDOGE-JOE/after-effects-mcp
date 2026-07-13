# ae-mcp 安装 / Install

## 中文

### v0.9.2 状态与支持矩阵

v0.9.2 当前是未发布候选契约。Provider、Tool Library 与 Platform Helper 已完成实现，并通过 Windows AE 2025 实机验证；仓库里的版本号与文件名仍不代表签名、公证、包内 RuntimeManager 或完整四格 AE 实机验收已经完成。只有 [发布门禁](RELEASE.md)全部通过后，下面的资产才会公开。

支持范围固定为：

- macOS 14 Sonoma 或更高版本，Apple Silicon arm64；不支持 Intel Mac 或 Rosetta。
- Windows 11 24H2 或更高版本，x64；不支持 Windows ARM。
- After Effects 25.x 与 26.x；正式发布前必须完成 Mac/Windows × AE 25/26 四格 smoke。

### 普通用户：安装离线发布资产

v0.9.2 的平台资产是：

| 平台 | 安装资产 | 同组审计资产 |
|---|---|---|
| macOS arm64 | `ae-mcp-panel-v0.9.2-macos-arm64.dmg` | `ae-mcp-panel-v0.9.2-macos-arm64.zxp` |
| Windows x64 | `ae-mcp-panel-v0.9.2-windows-x64.zxp` | 同一个 ZXP |

两个平台的精确文件都由 `artifact-manifest-v0.9.2.json` 绑定到同一个 protected `main` candidate SHA。不要用源码归档、本地重建包、公共 PyPI 同名包或在线依赖安装替代它们。

macOS DMG 只封装 manifest 绑定的签名 ZXP，不包含也不冒充第三方安装器。受支持的 ZXP installer 必须为两个平台另行提供；同一个安装器契约也用于 Mac/Windows RC verifier。

1. 从同一个 GitHub Release 下载当前平台资产和 `artifact-manifest-v0.9.2.json`。
2. 按 manifest 校验文件名、平台、candidate SHA 与 SHA-256。
3. macOS 挂载 DMG，并用受支持的 ZXP installer 安装其中唯一的 ZXP；Windows 用受支持的 ZXP installer 安装下载的 ZXP。
4. 重启 After Effects，打开 `Window -> Extensions -> ae-mcp`。
5. Panel 从包内离线安装并校验 runtime，随后将稳定 launcher 暴露为展开后的平台绝对路径（macOS 为 `/Users/<USER>/.ae-mcp/bin/ae-mcp`，Windows 为 `%USERPROFILE%\.ae-mcp\bin\ae-mcp.exe` 展开后的路径）。普通用户不需要系统 Python、系统 Node、`uv`、pip 或 npm。
6. 先运行 `ae_ping` / `ae_status`，再在测试工程执行只读与预览 smoke。

在 Windows 上，平台 Helper 由 Panel 打开时自动启动，不由安装器预先常驻启动。关闭并重开 Panel 时，同一个 AE 会话可以重新连接现有 Helper；AE 正常退出或闪退后，Helper 随已认证的 AE 进程退出。启动、握手或凭据库失败时 Provider 凭据保持 fail-closed，不回退读取明文配置。

升级会先把新 runtime 安装到独立版本目录并完成校验，成功后才原子切换 `current` pointer。失败时继续使用旧 runtime；回滚只切回已验证的 `previous` pointer，不在线重装依赖。

### 可选 AI 通道依赖

核心 MCP/AE 能力不依赖 AI CLI。只有选择相应面板通道时，才需要以下可选依赖：

- Claude 订阅通道：Claude Code CLI（`claude`）及其登录态。
- Codex 官方账号或配置继承通道：Codex CLI 及 `codex login`。
- ZCode 通道：受支持 ZCode 安装提供的 ZCode CLI/app-server。
- API-direct provider 通道使用各自的 API key；provider 配置和凭据不可导出。

缺少其中一个 CLI 只会让对应通道不可用，不应阻断 core、其他 provider 或外部 MCP 客户端。

### MCP 客户端配置

使用安装后的稳定 launcher：

```json
{
  "mcpServers": {
    "ae": {
      "command": "/Users/<USER>/.ae-mcp/bin/ae-mcp",
      "env": {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
      }
    }
  }
}
```

macOS 请把 `<USER>` 替换为实际账户名。Windows 请把 `command` 改成 `%USERPROFILE%\.ae-mcp\bin\ae-mcp.exe` 展开后的绝对路径。Panel 端口若有修改，也要同步修改 `AE_MCP_PLUGIN_URL`。

上例是 v0.9.2 最终稳定 launcher 契约。当前 Panel 配置生成器仍输出裸 PATH `ae-mcp`；RuntimeManager 未获明确批准和实现前不得偷偷改写该生成器，原生/产品验收 build guard 会在这项差异未闭环时阻止正式候选。

### 开发安装

开发 checkout 才需要 `uv`、Node/npm 和本地编译/签名工具。它不是普通用户安装路径。运行脚本前必须关闭全部 After Effects / AfterFX 进程。脚本会先预检必须文件，在目标同一 CEP 父目录建立唯一 staging，完成整树复制与复验后再原子 rename；旧安装保留为唯一 backup，任何交换失败都会自动恢复，成功时会打印绝对恢复命令。

```bash
uv sync --all-packages --group dev
(cd plugin/host && npm ci)
(cd plugin/sidecar && npm ci)
(cd plugin/panel && npm ci && npm run build)
./scripts/install-plugin-dev-macos.sh
```

Windows 开发机在完成相同依赖同步后运行：

```powershell
.\scripts\install-plugin-dev.ps1
```

开发安装启用 CEP debug 并部署工作区文件，不具有正式 ZXP/DMG 的签名、公证或不可变 artifact 身份，不能用于 release attestation。

### Tool Library 首次升级与回滚

首次 Tool Library 初始化时，当前 migrator 会先扫描全部现有数据，再在默认的 `~/.ae-mcp/tools/backups/migration-<timestamp>-<nonce>/` 建立带 SHA-256 manifest 的备份；设置 `AE_MCP_TOOL_DIR` 时，位置相应改为 `<tool-root>/backups/...`。最后才提交新 index 和 `migration-v1.json` marker。备份包含 native index/artifacts 和 legacy metadata；`~/.ae-mcp/skills/*.json` 仍是原来的规范副本，不会复制进 native artifact 目录。崩溃后的下一次初始化会复用 prepared backup 并幂等完成 marker，不会把半迁移状态当成成功。

默认保留最新 3 份且处于 30 天保留窗口内的迁移备份；清理只处理校验过的 backup 目录。需要回退 Tool Library schema 时，使用当前安装版本的 `ToolDataMigrator.rollback(backup_id)`，让它先校验 manifest 再原子恢复；不要手工拼接 index 与 artifact 文件。普通 runtime/panel 回滚和卸载不会删除 `~/.ae-mcp/tools` 或 legacy skills。

`.aemcptools` 导入先进入隔离 preview；commit 后仍是 candidate，不会自动提升或执行。处理冲突后应先 Inspect，再调用 `ae_toolEdit` 并传 `{"changes":{"status":"saved"}}`；只有 saved/pinned 制品可执行。

### 排障与恢复

- Panel 不在菜单中：确认安装的是正确平台资产，重启 AE；开发模式才重新运行开发安装脚本。
- Panel 未监听：检查 Panel 日志及 `127.0.0.1:11488` 端口占用。
- launcher 不存在：记为 RuntimeManager/release blocker，不要改用公共 PyPI 或临时系统 Python 旁路；repair UI 必须在明确批准后实现并通过门禁。
- CLI 通道不可用：检查对应的 Claude Code、Codex 或 ZCode CLI/app-server；这不应影响 core。
- macOS 截图权限不足：按系统提示授权签名 helper 的 Screen Recording；`ae_previewFrame` 的 AE 原生路径应独立诊断。
- 升级失败：保持旧 `current`，保存校验报告与日志，再回滚到 `previous`。
- provider 配置、凭据与 Tool Library 属于用户数据；卸载或回滚不得静默删除它们。

## English

### v0.9.2 Status and Support Matrix

v0.9.2 is currently an unreleased candidate contract. Provider, Tool Library, and Platform Helper implementation is complete and has passed Windows AE 2025 hardware validation; repository versions and filenames still do not assert that signing, notarization, bundled RuntimeManager, or the full four-cell AE hardware matrix is complete. The assets below become public only after every [release gate](RELEASE.md) passes.

The supported matrix is fixed to:

- macOS 14 Sonoma or newer on Apple Silicon arm64; no Intel Mac or Rosetta support.
- Windows 11 24H2 or newer on x64; no Windows ARM support.
- After Effects 25.x and 26.x; Mac/Windows × AE 25/26 smoke is mandatory before publication.

### Normal Users: Install an Offline Release Asset

The v0.9.2 platform assets are:

| Platform | Install asset | Same-set audit asset |
|---|---|---|
| macOS arm64 | `ae-mcp-panel-v0.9.2-macos-arm64.dmg` | `ae-mcp-panel-v0.9.2-macos-arm64.zxp` |
| Windows x64 | `ae-mcp-panel-v0.9.2-windows-x64.zxp` | the same ZXP |

`artifact-manifest-v0.9.2.json` binds the exact files for both platforms to one protected `main` candidate SHA. Do not substitute a source archive, locally rebuilt package, public PyPI namesake, or online dependency install.

The macOS DMG contains only the manifest-bound signed ZXP; it neither contains nor impersonates a third-party installer. A separately supplied supported ZXP installer is required on both platforms, and the Mac/Windows RC verifiers use the same installer contract.

1. Download the platform asset and `artifact-manifest-v0.9.2.json` from the same GitHub Release.
2. Verify filename, platform, candidate SHA, and SHA-256 against the manifest.
3. On macOS, mount the DMG and use the supported ZXP installer for its sole ZXP; on Windows, use the supported ZXP installer for the downloaded ZXP.
4. Restart After Effects and open `Window -> Extensions -> ae-mcp`.
5. The Panel installs and verifies the bundled runtime offline, then exposes an expanded platform-absolute stable launcher (macOS: `/Users/<USER>/.ae-mcp/bin/ae-mcp`; Windows: the expanded path for `%USERPROFILE%\.ae-mcp\bin\ae-mcp.exe`). Normal users do not need system Python, system Node, `uv`, pip, or npm.
6. Run `ae_ping` / `ae_status` first, followed by read-only and preview smoke in a test project.

On Windows, the Panel starts Platform Helper when it opens; the installer does not prestart a resident Helper. Closing and reopening the Panel reconnects within the same AE session. Platform Helper exits when its authenticated AE process exits or crashes. Startup, handshake, or credential-store failures remain fail-closed and never fall back to plaintext provider configuration.

An upgrade installs the new runtime into a separate version directory and verifies it before atomically switching the `current` pointer. Failure leaves the old runtime active; rollback switches to the verified `previous` pointer without downloading dependencies.

### Optional AI Channel Dependencies

Core MCP/AE operation does not depend on an AI CLI. Install these only for the matching optional Panel channel:

- Claude subscription channel: Claude Code CLI (`claude`) and its login.
- Codex official-account or config-inheritance channel: Codex CLI and `codex login`.
- ZCode channel: the ZCode CLI/app-server supplied by a supported ZCode installation.
- API-direct provider channels use their own API keys; provider configuration and credentials are not exportable.

A missing CLI disables only its channel; it must not block core operation, another provider, or an external MCP client.

### MCP Client Configuration

Use the installed stable launcher:

```json
{
  "mcpServers": {
    "ae": {
      "command": "/Users/<USER>/.ae-mcp/bin/ae-mcp",
      "env": {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
      }
    }
  }
}
```

On macOS, replace `<USER>` with the actual account name. On Windows, replace `command` with the expanded absolute path to `%USERPROFILE%\.ae-mcp\bin\ae-mcp.exe`. If the Panel port changes, update `AE_MCP_PLUGIN_URL` too.

This is the final v0.9.2 stable-launcher contract. The current Panel config generator still emits bare PATH `ae-mcp`; it must not be silently changed before explicit RuntimeManager approval and implementation, and the native/product-acceptance build guard blocks a formal candidate while this gap remains.

### Developer Install

Only a development checkout requires `uv`, Node/npm, and local build/signing tools. This is not the normal-user install path. Close every After Effects / AfterFX process first. Each script preflights required source files, copies and verifies a unique staging tree beside the target, then performs same-parent atomic renames. It retains the old panel as a unique backup, restores it automatically on swap failure, and prints an absolute restore command after success.

```bash
uv sync --all-packages --group dev
(cd plugin/host && npm ci)
(cd plugin/sidecar && npm ci)
(cd plugin/panel && npm ci && npm run build)
./scripts/install-plugin-dev-macos.sh
```

After the same dependency synchronization on Windows, run:

```powershell
.\scripts\install-plugin-dev.ps1
```

Development install enables CEP debug and deploys workspace files. It does not carry the signed/notarized, immutable artifact identity required for release attestation.

### First Tool Library Upgrade and Rollback

On the first Tool Library initialization, the current migrator scans all existing data before creating a SHA-256-manifested backup under the default `~/.ae-mcp/tools/backups/migration-<timestamp>-<nonce>/`; when `AE_MCP_TOOL_DIR` is set, the location becomes `<tool-root>/backups/...`. Only then does it commit the new index and `migration-v1.json` marker. The backup contains the native index/artifacts and legacy metadata. Existing `~/.ae-mcp/skills/*.json` files remain the canonical copies and are not duplicated into the native artifact directory. After a crash, the next initialization reuses the prepared backup and completes the marker idempotently; a partial migration is never accepted as success.

Retention keeps the newest three migration backups within the 30-day policy window, and pruning touches only validated backup directories. To roll back the Tool Library schema, use the currently installed version's `ToolDataMigrator.rollback(backup_id)` so the manifest is verified before atomic restoration; do not hand-assemble index and artifact files. Ordinary runtime/panel rollback and uninstall do not remove `~/.ae-mcp/tools` or legacy skills.

`.aemcptools` imports first enter a quarantined preview. Committed artifacts remain candidates and are never auto-promoted or executed. After resolving conflicts, Inspect them and call `ae_toolEdit` with `{"changes":{"status":"saved"}}`; only saved/pinned artifacts can execute.

### Troubleshooting and Recovery

- Panel missing: confirm the correct platform asset was installed and restart AE; rerun a dev installer only in development mode.
- Panel not listening: inspect Panel logs and the process using `127.0.0.1:11488`.
- Launcher missing: treat it as a RuntimeManager/release blocker; do not bypass it with a public PyPI package or ad-hoc system Python. The repair UI requires explicit approval and gated implementation.
- Optional channel unavailable: inspect the corresponding Claude Code, Codex, or ZCode CLI/app-server; core should remain usable.
- macOS capture permission missing: grant Screen Recording to the signed helper when prompted; diagnose the AE-native `ae_previewFrame` path separately.
- Upgrade failure: keep the old `current`, retain verification evidence and logs, then roll back to `previous`.
- Provider settings, credentials, and Tool Library data are user data; uninstall or rollback must not silently delete them.
