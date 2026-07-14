# ae-mcp 安装 / Install

## 中文

### v0.9.2 状态与支持矩阵

v0.9.2 是 Windows x64 正式版本。Provider、Tool Library 与 Platform Helper 已完成实现，并通过 Windows AE 2025 实机验证。macOS、包内 RuntimeManager、正式跨平台签名链和完整 AE 25/26 实机矩阵转入 v0.9.3。

支持范围固定为：

- Windows 11 24H2 或更高版本，x64；不支持 Windows ARM。
- After Effects 25.x 已完成实机验证；AE 26 完整验收转入 v0.9.3。

### 普通用户：安装离线发布资产

v0.9.2 的平台资产是：

| 平台 | 安装资产 | 同组审计资产 |
|---|---|---|
| Windows x64 | `ae-mcp-panel-v0.9.2-windows-x64.zxp` | 同一个 ZXP |

GitHub Release 同时给出 Windows ZXP 的 SHA-256。不要用源码归档、本地重建包、公共 PyPI 同名包或在线依赖安装替代它。

1. 从 GitHub Release 下载 Windows ZXP，并对照发布说明校验 SHA-256。
2. 使用受支持的 ZXP installer 安装下载的 ZXP。
3. 重启 After Effects，打开 `Window -> Extensions -> ae-mcp`。
4. 继续使用现有外部 runtime/launcher 配置；包内离线 RuntimeManager 转入 v0.9.3。
5. 先运行 `ae_ping` / `ae_status`，再在测试工程执行只读与预览 smoke。

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

开发 checkout 才需要 `uv`、Node/npm 和本地编译/签名工具。它不是普通用户安装路径。运行脚本前必须关闭全部 After Effects / AfterFX 进程。macOS 脚本会先预检必须文件，并把旧版安装器遗留且名称严格匹配的 transaction artifact 非破坏性迁出 Adobe CEP 扫描根；随后在私有 `~/Library/Application Support/AfterEffectsMCP/cep-panel-dev-v1/` 中建立唯一 staging，完成整树复制与复验后再原子 rename。扫描根中只保留生效的 `com.aemcp.panel`。旧安装作为唯一 backup 保存在同一私有状态目录中，任何交换失败都会自动恢复，成功时会打印绝对恢复命令。Windows 脚本仍使用目标旁的事务目录和同样的回滚契约。

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

v0.9.2 is the Windows x64 release. Provider, Tool Library, and Platform Helper implementation is complete and has passed Windows AE 2025 hardware validation. macOS, bundled RuntimeManager, the production cross-platform signing chain, and the complete AE 25/26 hardware matrix move to v0.9.3.

The supported matrix is fixed to:

- Windows 11 24H2 or newer on x64; no Windows ARM support.
- After Effects 25.x is hardware-validated; complete AE 26 acceptance moves to v0.9.3.

### Normal Users: Install an Offline Release Asset

The v0.9.2 platform assets are:

| Platform | Install asset | Same-set audit asset |
|---|---|---|
| Windows x64 | `ae-mcp-panel-v0.9.2-windows-x64.zxp` | the same ZXP |

The GitHub Release lists the Windows ZXP SHA-256. Do not substitute a source archive, locally rebuilt package, public PyPI namesake, or online dependency install.

1. Download the Windows ZXP and verify its SHA-256 against the GitHub Release notes.
2. Install it with a supported ZXP installer.
3. Restart After Effects and open `Window -> Extensions -> ae-mcp`.
4. Continue using the existing external runtime/launcher setup; bundled offline RuntimeManager moves to v0.9.3.
5. Run `ae_ping` / `ae_status` first, followed by read-only and preview smoke in a test project.

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

Only a development checkout requires `uv`, Node/npm, and local build/signing tools. This is not the normal-user install path. Close every After Effects / AfterFX process first. On macOS, the script preflights required source files and non-destructively moves strictly named transaction artifacts left by older installers out of Adobe's CEP scan root. It then creates its unique staging tree in the private off-scan state directory `~/Library/Application Support/AfterEffectsMCP/cep-panel-dev-v1/`. After copying and verifying the complete tree, it atomically renames the candidate into place; the scan root retains only the active `com.aemcp.panel`. The old panel remains as the unique backup in that private state directory, is restored automatically on swap failure, and is named in an absolute restore command after success. The Windows script continues to use transaction directories beside its target with the same rollback contract.

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
