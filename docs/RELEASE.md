# v0.9.3 Windows 最小发布 / Minimal Windows Release

## 中文

### 固定资产

v0.9.3 只发布以下三个文件：

```text
ae-mcp-panel-v0.9.3-windows-x64.zxp
AeMcpNative-v0.9.3-windows-x64.aex
SHA256SUMS-v0.9.3.txt
```

ZXP 安装 CEP 面板；AEX 由用户在关闭全部 AE 实例后，手动复制为所选宿主的
`Support Files\Plug-ins\Extensions\AeMcpNative.aex`。After Effects 2025 的典型完整路径是：

```text
C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex
```

此 Release 仅适用于已经配置好受支持外部 `ae-mcp` runtime/launcher 的 Windows 环境。
三个发布文件不包含外部 runtime 的 bootstrap；清洁环境仅安装这些文件不能完整使用产品。

### 构建与发布顺序

1. 将 0.9.3 版本、范围和安装说明合并到受保护 `main`。
2. 只从最终干净 `main` 提交构建 Windows x64 ZXP 与 AEX；不得把旧 0.9.2 二进制改名。
3. 使用锁定 Adobe SDK 输入构建 AEX，并验证 PE x64、`AeMcpNativeMain`、版本和源码提交。
4. 为本次发布新建自签名身份，分别签名并复验 ZXP 与 AEX；AEX 使用 RFC 3161 时间戳。
5. 生成 `SHA256SUMS-v0.9.3.txt`，绑定两个最终签名二进制。
6. 在 After Effects 2025 上安装最终资产并通过公开 MCP 路径运行只读实机 smoke。
7. 创建 `v0.9.3` tag 与 GitHub Release，上传已验证的原始字节；发布阶段不重新构建。

### 明确非目标

本版不是零环境安装，不新增一体化安装器、自动 AEX 部署、Windows RuntimeManager、
新 CI/runner 拓扑、私有制品服务、升级/修复/回滚/卸载生命周期、macOS 资产或 Windows ARM。
ZXP installer 不会把 AEX 安装到 AE 原生插件目录。

ZXP 与 AEX 的自签名可证明签名后字节未变化，但不建立操作系统默认信任的公开发布者；
安装时可能显示未知或不受信任发布者提示。

校验示例：

```powershell
Get-FileHash .\ae-mcp-panel-v0.9.3-windows-x64.zxp -Algorithm SHA256
Get-FileHash .\AeMcpNative-v0.9.3-windows-x64.aex -Algorithm SHA256
```

## English

### Fixed assets

v0.9.3 publishes exactly these files:

```text
ae-mcp-panel-v0.9.3-windows-x64.zxp
AeMcpNative-v0.9.3-windows-x64.aex
SHA256SUMS-v0.9.3.txt
```

The ZXP installs the CEP panel. With every AE instance closed, copy the AEX manually to the
selected host as `Support Files\Plug-ins\Extensions\AeMcpNative.aex`. A typical complete
After Effects 2025 path is:

```text
C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex
```

This Release applies only to Windows environments that already have a supported external
`ae-mcp` runtime/launcher configured. The three assets do not bootstrap that external runtime;
a clean environment cannot obtain full product operation by installing only these files.

### Build and publication order

1. Merge the 0.9.3 version, scope, and installation documentation into protected `main`.
2. Build the Windows x64 ZXP and AEX only from the final clean `main` commit; never rename a 0.9.2 binary.
3. Build the AEX from locked Adobe SDK inputs and verify PE x64, `AeMcpNativeMain`, version, and source commit.
4. Create new self-signed identities for this release, then sign and reverify the ZXP and AEX separately; use an RFC 3161 timestamp for the AEX.
5. Generate `SHA256SUMS-v0.9.3.txt` over the two final signed binaries.
6. Install the final assets in After Effects 2025 and run a read-only smoke through the public MCP surface.
7. Create the `v0.9.3` tag and GitHub Release and upload the verified bytes without rebuilding.

### Explicit non-goals

This is not a zero-environment release. It adds no integrated installer, automatic AEX deployment,
Windows RuntimeManager, new CI/runner topology, private artifact service, upgrade/repair/rollback/uninstall
lifecycle, macOS asset, or Windows ARM support. A ZXP installer does not install the AEX in AE's native
plug-in directory.

The self-signed ZXP and AEX signatures prove that the bytes have not changed since signing, but they
do not establish a publicly trusted publisher. Installation may show an unknown or untrusted publisher warning.

Verification example:

```powershell
Get-FileHash .\ae-mcp-panel-v0.9.3-windows-x64.zxp -Algorithm SHA256
Get-FileHash .\AeMcpNative-v0.9.3-windows-x64.aex -Algorithm SHA256
```
