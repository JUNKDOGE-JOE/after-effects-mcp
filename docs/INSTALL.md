# ae-mcp 安装 / Install

## 中文

### v0.9.6 状态与支持矩阵

v0.9.6 是 Windows x64 修复版本。ZXP 内含 CEP 面板与 Windows Platform Helper；原生 AEX 作为独立签名资产手动安装。外部 runtime/launcher 可以由面板首跑向导联网安装；本版不内置离线 Python，也不是只装 ZXP 即用的安装包。

支持范围固定为：

- Windows 11 24H2 或更高版本，x64；不支持 Windows ARM。
- After Effects 2025 是本次打包验收宿主；CEP manifest 仍允许 `[25.0,26.9]`。

### 普通用户：安装签名资产并准备 runtime

v0.9.6 的发布资产是：

| 用途 | 发布资产 |
|---|---|
| CEP 面板 + Windows Platform Helper | `ae-mcp-panel-v0.9.6-windows-x64.zxp` |
| 原生 AEGP 插件 | `AeMcpNative-v0.9.6-windows-x64.aex` |
| 完整性校验 | `SHA256SUMS-v0.9.6.txt` |

不要用源码归档、本地重建包或公共 PyPI 同名包替代这些固定发布资产。

1. 下载 ZXP、AEX 与 `SHA256SUMS-v0.9.6.txt`，先校验两个二进制。
2. 使用受支持的 ZXP installer 安装 ZXP。
3. 关闭全部 After Effects 实例。以管理员权限把 AEX 复制为所选宿主的 `Support Files\Plug-ins\Extensions\AeMcpNative.aex`。
4. 重启 AE 并打开面板。若缺少 `uv` 或 `ae-mcp`，使用首跑向导联网安装；Windows 向导通过 winget（失败时使用 uv 官方 PowerShell 安装脚本）安装 `uv`，再执行固定到 `v0.9.6` tag 的 `uv tool install --force --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.6#subdirectory=packages/core ...`。已有兼容 runtime/launcher 会被复用。
5. 重启 After Effects，打开 `Window -> Extensions -> ae-mcp`，先运行 `ae_ping` / `ae_status`，再在测试工程执行只读 smoke。

在 Windows 上，平台 Helper 由 Panel 打开时自动启动，不由安装器预先常驻启动。关闭并重开 Panel 时，同一个 AE 会话可以重新连接现有 Helper；AE 正常退出或闪退后，Helper 随已认证的 AE 进程退出。启动、握手或凭据库失败时 Provider 凭据保持 fail-closed，不回退读取明文配置。

内置/离线 Python、一体化安装器、自动 AEX 部署、Windows RuntimeManager、升级/修复/回滚/卸载生命周期不属于 v0.9.6 Windows 发布范围。

### macOS arm64 补传资产（2026-08-12）

v0.9.5 发布后按 v0.9.4 先例（#214）补传了 macOS arm64 资产：`ae-mcp-platform-bundle-v0.9.5-macos-arm64-unsigned.zip`（完整平台包，未签名，通过 `verify-platform-bundle` 校验）、`AeMcpNative-v0.9.5-macos-arm64.plugin.zip`（原生 AEGP 插件，ad-hoc 签名）与 `SHA256SUMS-v0.9.5-macos-arm64.txt`，均构建自干净 `636d6f6`。本次补传不含 macOS ZXP；自签名 ZXP 待签名环境可用后补传。原生插件安装方式与 v0.9.4 相同：校验 SHA-256 → 完全退出 AE → 解压后把完整的 `AeMcpNative.plugin` 放到 `~/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/ae-mcp/AeMcpNative.plugin` → 重启 AE。平台包面向测试与手动部署（开发者/进阶用户），未经 AE 真机验收，使用前先核对 SHA-256。

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

macOS 请把 `<USER>` 替换为实际账户名。Windows 默认 `uv tool install` 的 launcher 位于 `%USERPROFILE%\.local\bin\ae-mcp.exe`；若设置了 `UV_TOOL_BIN_DIR`，请直接复制面板生成的实际路径。Panel 端口若有修改，也要同步修改 `AE_MCP_PLUGIN_URL`。

Windows v0.9.6 继续使用 ZXP 外部的 runtime/launcher，但首跑向导会在缺失时联网安装它；ZXP 本身不携带 Python runtime。

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
- launcher 不存在：重新运行面板首跑向导，联网安装 `uv` 与固定到 v0.9.6 tag 的 `ae-mcp` runtime；若自定义了 `UV_TOOL_BIN_DIR`，复制面板生成的实际路径。
- CLI 通道不可用：检查对应的 Claude Code、Codex 或 ZCode CLI/app-server；这不应影响 core。
- macOS 截图权限不足：按系统提示授权签名 helper 的 Screen Recording；`ae_previewFrame` 的 AE 原生路径应独立诊断。
- 需要回退发布资产：本版没有自动回滚状态；关闭 AE 后仅恢复用户自己保留且校验过的上一版 ZXP/AEX。
- provider 配置、凭据与 Tool Library 属于用户数据；卸载或回滚不得静默删除它们。

## English

### v0.9.6 Status and Support Matrix

v0.9.6 is the corrective Windows x64 release. The ZXP contains the CEP panel and Windows Platform Helper; the separately signed native AEX remains a manual install. The Panel's first-run wizard can install the external runtime/launcher online. Python is not bundled, and installing only the ZXP is not sufficient.

The supported matrix is fixed to:

- Windows 11 24H2 or newer on x64; no Windows ARM support.
- After Effects 2025 is the packaged acceptance host; the CEP manifest remains `[25.0,26.9]`.

### Normal Users: Install Signed Assets and Prepare the Runtime

The v0.9.6 release assets are:

| Role | Release asset |
|---|---|
| CEP panel + Windows Platform Helper | `ae-mcp-panel-v0.9.6-windows-x64.zxp` |
| Native AEGP plug-in | `AeMcpNative-v0.9.6-windows-x64.aex` |
| Integrity | `SHA256SUMS-v0.9.6.txt` |

Do not substitute a source archive, locally rebuilt package, or public PyPI namesake for these fixed assets.

1. Download the ZXP, AEX, and `SHA256SUMS-v0.9.6.txt`; verify both binaries first.
2. Install the ZXP with a supported ZXP installer.
3. Close every After Effects instance. With administrator permission, copy the AEX to the selected host as `Support Files\Plug-ins\Extensions\AeMcpNative.aex`.
4. Restart AE and open the Panel. If `uv` or `ae-mcp` is missing, use the first-run wizard. On Windows it installs `uv` through winget (falling back to uv's official PowerShell installer), then runs a tag-pinned `uv tool install --force --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.6#subdirectory=packages/core ...`. An existing compatible runtime/launcher is reused.
5. Restart After Effects, open `Window -> Extensions -> ae-mcp`, and run `ae_ping` / `ae_status` followed by a read-only smoke in a test project.

On Windows, the Panel starts Platform Helper when it opens; the installer does not prestart a resident Helper. Closing and reopening the Panel reconnects within the same AE session. Platform Helper exits when its authenticated AE process exits or crashes. Startup, handshake, or credential-store failures remain fail-closed and never fall back to plaintext provider configuration.

Bundled/offline Python, an integrated installer, automatic AEX deployment, Windows RuntimeManager, and upgrade/repair/rollback/uninstall lifecycle are outside the v0.9.6 Windows release.

### macOS arm64 Supplemental Assets (2026-08-12)

Following the v0.9.4 precedent (#214), macOS arm64 assets were added to the v0.9.5 release after publication: `ae-mcp-platform-bundle-v0.9.5-macos-arm64-unsigned.zip` (full platform bundle, unsigned, `verify-platform-bundle` verified), `AeMcpNative-v0.9.5-macos-arm64.plugin.zip` (native AEGP plug-in, ad-hoc signed), and `SHA256SUMS-v0.9.5-macos-arm64.txt`, all built from clean `636d6f6`. No macOS ZXP is included yet; a self-signed ZXP will follow once the signing environment is available. The native plug-in installs as in v0.9.4: verify the SHA-256, quit AE completely, unzip, place the complete `AeMcpNative.plugin` at `~/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/ae-mcp/AeMcpNative.plugin`, and restart AE. The platform bundle targets testing and manual deployment (developers/advanced users), has not passed on-host AE acceptance, and should be checksum-verified before use.

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

On macOS, replace `<USER>` with the actual account name. The default Windows `uv tool install` launcher is `%USERPROFILE%\.local\bin\ae-mcp.exe`; when `UV_TOOL_BIN_DIR` is set, copy the actual path generated by the Panel. If the Panel port changes, update `AE_MCP_PLUGIN_URL` too.

Windows v0.9.6 continues to use a runtime/launcher outside the ZXP, but the first-run wizard installs it online when missing. The ZXP itself does not carry a Python runtime.

### Developer Install

Only a development checkout requires `uv`, Node/npm, and local build/signing tools. This is not the normal-user install path. Dependency installation is an explicit, one-time bootstrap; daily commands never run `uv sync`, `npm ci`, portable-runtime packaging, or a release installer. For a full bootstrap, set `AE_MCP_SDK_ARCHIVE` and `AE_MCP_SDK_ROOT` (or pass the matching CLI options), close every After Effects / AfterFX process, then run:

```bash
node scripts/dev/ae-mcp-dev.mjs bootstrap --component all \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

After bootstrap, inspect or update only the component being changed:

```bash
node scripts/dev/ae-mcp-dev.mjs doctor --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
node scripts/dev/ae-mcp-dev.mjs sync --component core --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
node scripts/dev/ae-mcp-dev.mjs launch-ae --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
node scripts/dev/ae-mcp-dev.mjs smoke --component core \
  --scenario native-exec-ir@1 \
  --repo-root "$PWD" \
  --fixture-path "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/active/hdev-core-native.aep" \
  --recovery-archive-root "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/recovery" \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/evidence/hdev-core-native" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

Core sync performs no copy and asks the caller to restart the MCP session. CEP sync rebuilds the panel and uses the existing off-scan, atomic development installer. Native sync keeps the existing clean-commit, stopped-AE, SDK, installer, and formal-restart requirements. If a required dependency is absent, a daily command fails with a bootstrap recovery code instead of installing it.

HDEV is ordinary development proof only. Its seven-call evidence always says
`candidateRun=false` and `candidateEvidence=false`; it must never be promoted
or copied into packaged release T5/T6 evidence. Packaged release candidates
continue to use the strict release-audit identity and installation workflows.

On macOS, the CEP installer preflights required source files and non-destructively moves strictly named transaction artifacts left by older installers out of Adobe's CEP scan root. It then creates its unique staging tree in the private off-scan state directory `~/Library/Application Support/AfterEffectsMCP/cep-panel-dev-v1/`. After copying and verifying the complete tree, it atomically renames the candidate into place; the scan root retains only the active `com.aemcp.panel`. The old panel remains as the unique backup in that private state directory, is restored automatically on swap failure, and is named in an absolute restore command after success.

Windows still uses the existing manual development path after dependency synchronization:

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
- Launcher missing: rerun the Panel's first-run wizard to install `uv` and the v0.9.6-tagged `ae-mcp` runtime online. If `UV_TOOL_BIN_DIR` is customized, copy the actual path generated by the Panel.
- Optional channel unavailable: inspect the corresponding Claude Code, Codex, or ZCode CLI/app-server; core should remain usable.
- macOS capture permission missing: grant Screen Recording to the signed helper when prompted; diagnose the AE-native `ae_previewFrame` path separately.
- To revert release assets: this release has no automatic rollback state. Close AE and restore only a user-retained, checksum-verified previous ZXP/AEX.
- Provider settings, credentials, and Tool Library data are user data; uninstall or rollback must not silently delete them.
