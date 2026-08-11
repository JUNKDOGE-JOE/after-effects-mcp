# v0.9.5 提问表单与 AE 23-26 兼容发布 / Question Form and AE 23-26 Compatibility Release

## 中文

### 固定资产

v0.9.5 只发布以下三个文件：

```text
ae-mcp-panel-v0.9.5-windows-x64.zxp
AeMcpNative-v0.9.5-windows-x64.aex
SHA256SUMS-v0.9.5.txt
```

ZXP 包含 CEP 面板、生产 Host 依赖与现有 Windows Platform Helper。Helper 负责 Provider
凭据的 Windows Credential Manager 通道和相关平台能力；签名前必须校验
`platform/windows-x64/helper-manifest.json`、三个声明文件及其 SHA-256。ZXP 不包含
Python、`node.exe`、Windows RuntimeManager 或 AEX。

AEX 由用户在关闭全部 AE 实例后，手动复制为所选宿主的
`Support Files\Plug-ins\Extensions\AeMcpNative.aex`。After Effects 2025 的典型完整路径是：

```text
C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex
```

### Runtime 安装边界

MCP Python runtime/launcher 位于 ZXP 外部。清洁 Windows 环境不要求预先安装它：面板首跑
向导会联网安装 `uv`，再执行固定到 `v0.9.5` tag 的 `uv tool install`，安装 core、bridge
与 snapshot-mss。已有兼容 runtime 会被复用。由于这个流程需要网络且 AEX 仍需单独安装，
v0.9.5 不是离线、零依赖或只装 ZXP 即用的发布。

### 构建与发布顺序

1. 将 0.9.5 版本、提问表单双后端桥接、渠道显式启用、AE 2023 套件基线与部署完整性门闸合并到受保护 `main`。
2. 只从最终干净 `main` 提交构建 Windows x64 Helper、ZXP 与 AEX；不得修改或替换 v0.9.3 tag/资产。
3. ZXP 签名前运行 Windows 最小载荷校验：Helper 清单/哈希、Provider 路径、在线 runtime 向导存在；bundled Python/Node、RuntimeManager manifest 与 AEX 不存在。
4. 使用锁定 Adobe SDK 输入构建 AEX，并验证 PE x64、`AeMcpNativeMain`、版本和源码提交。
5. 使用本版新签名身份分别签名并复验 ZXP 与 AEX；生成 `SHA256SUMS-v0.9.5.txt`。
6. 在 After Effects 2025 上安装最终资产，验证 Helper capabilities、一次性 Provider 凭据写入/读取/删除，以及公开 MCP 只读实机路径。
7. 所有必需 CI 与实机证据通过后创建 `v0.9.5` tag 和 GitHub Release；上传已验证字节，发布阶段不重新构建。

### 明确非目标

本版不新增 bundled/offline runtime、Windows RuntimeManager、一体化安装器、自动 AEX 部署、
升级/修复/回滚/卸载生命周期、macOS 资产或 Windows ARM。ZXP installer 不会把 AEX
安装到 AE 原生插件目录。自签名只能证明签名后的字节未变化，不建立系统默认信任的公开发布者。

## English

### Fixed assets

v0.9.5 publishes exactly these files:

```text
ae-mcp-panel-v0.9.5-windows-x64.zxp
AeMcpNative-v0.9.5-windows-x64.aex
SHA256SUMS-v0.9.5.txt
```

The ZXP contains the CEP Panel, production Host dependencies, and the existing Windows Platform
Helper. The Helper provides the Windows Credential Manager channel used by Provider Manager and
related platform capabilities. Before signing, packaging verifies
`platform/windows-x64/helper-manifest.json`, its three declared files, and their SHA-256 values.
The ZXP contains no Python, `node.exe`, Windows RuntimeManager, or AEX.

With every AE instance closed, users copy the AEX manually to the selected host as
`Support Files\Plug-ins\Extensions\AeMcpNative.aex`. A typical After Effects 2025 path is:

```text
C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Plug-ins\Extensions\AeMcpNative.aex
```

### Runtime installation boundary

The MCP Python runtime/launcher remains outside the ZXP. A clean Windows environment does not need
it preinstalled: the Panel's first-run wizard installs `uv` online and runs a `uv tool install`
pinned to the `v0.9.5` tag for core, bridge, and snapshot-mss. An existing compatible runtime is
reused. Because this flow needs network access and the AEX is still separate, v0.9.5 is not an
offline, zero-dependency, or ZXP-only installation.

### Build and publication order

1. Merge the 0.9.5 version, the dual-backend question form bridges, explicit user-enabled channels, the AE 2023 suite baseline, and the deployment integrity gates into protected `main`.
2. Build the Windows x64 Helper, ZXP, and AEX only from the final clean `main` commit. Do not mutate or replace the v0.9.3 tag or assets.
3. Before ZXP signing, verify the minimal Windows payload: Helper manifest/hashes, Provider path, and online runtime wizard are present; bundled Python/Node, RuntimeManager manifests, and AEX are absent.
4. Build the AEX from locked Adobe SDK inputs and verify PE x64, `AeMcpNativeMain`, version, and source commit.
5. Sign and reverify the ZXP and AEX with new identities for this release, then generate `SHA256SUMS-v0.9.5.txt`.
6. Install the final assets in After Effects 2025 and verify Helper capabilities, a disposable Provider credential set/get/delete round trip, and a read-only public MCP smoke.
7. After required CI and hardware evidence pass, create the `v0.9.5` tag and GitHub Release and upload the verified bytes without rebuilding.

### Explicit non-goals

This release adds no bundled/offline runtime, Windows RuntimeManager, integrated installer,
automatic AEX deployment, upgrade/repair/rollback/uninstall lifecycle, macOS asset, or Windows ARM
support. A ZXP installer does not install the AEX in AE's native plug-in directory. Self-signing
does not establish a publicly trusted publisher.
