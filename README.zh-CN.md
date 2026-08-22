# ae-mcp

[English](README.md) | 简体中文

**一行安装提示词——复制给 Claude Code 或其它 AI agent：**

```text
请从 v0.10.0 发布页安装 ae-mcp 的 ZXP 和对应平台的原生插件，在 After Effects
中打开
Window > Extensions > ae-mcp，然后用 `claude mcp add --transport http ae
http://127.0.0.1:11488/mcp` 接入 Claude Code；Claude Desktop 则使用系统 Node
执行扩展目录里的 `host/stdio-shim.js`，并在测试 `ae_ping` 前提醒我重新启动
客户端会话。
```

ae-mcp 通过本机 MCP 把 After Effects CEP 面板连接到 AI 客户端。面板在
`http://127.0.0.1:11488/mcp` 提供服务；宿主是使用 Express 的 Node 进程，
After Effects 状态通过 ExtendScript 和冻结的原生 AEGP 平面访问。

## 安装和首次启动

1. 在 After Effects 中安装签名 ZXP。
2. 把同一版本的原生插件装到该 After Effects 宿主使用的插件目录——Windows 用
   `.aex`，macOS 用 `AeMcpNative.plugin` 包。ZXP 不含任何平台二进制，两个系统
   通用；只有原生插件按平台分别构建，`ae_nativeExec` 是唯一需要它的工具。
   两个平台的确切安装位置见[安装文档](docs/INSTALL.md)；macOS 的包还需要先去掉
   下载隔离属性，After Effects 才会加载它。
3. 启动 After Effects，打开 **Window > Extensions > ae-mcp**。外部客户端
   使用 MCP 时保持面板打开。
4. 按下面两种接入方式之一配置客户端。

面板本身就是 MCP 服务，不需要单独启动仓库服务器。外部客户端默认通过
loopback 访问，所以必须和 After Effects 在同一台机器上运行。

## 客户端接入

Claude Code 使用 URL transport：

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

Claude Desktop 使用安装扩展中自带的无依赖 stdio shim。`command` 填系统
Node 可执行文件，`args` 指向扩展目录中的 `host/stdio-shim.js`：

```json
{
  "mcpServers": {
    "ae": {
      "command": "node",
      "args": ["<已安装扩展目录>/host/stdio-shim.js"],
      "env": {
        "AE_MCP_HTTP_URL": "http://127.0.0.1:11488/mcp"
      }
    }
  }
}
```

因此 Claude Desktop 需要系统 Node。shim 会保持一条 stdio 请求队列，把
MCP 响应转发给面板宿主。

## 面板能力

- `ae_exec`：执行维护中的 ExtendScript 操作。
- `ae_nativeExec`：执行冻结的原生 AEGP primitive。
- `ae_previewFrame`、`ae_validateExpressions`、`ae_snapshot` 和检查点。
- 内置 skills 与本地 JSX Tool Library。
- 审批模式、活动记录、诊断和日志导出。
- 在本机 CLI 已登录时，可使用 Claude、Codex、OpenCode 内嵌通道。

公开 MCP 工具由 CEP 宿主提供。写入后应独立读取验证；可能产生副作用的
失败必须先核对再重试，Undo 的可用性和实际执行后的验证是两件事。

## 开发

安装两个 Node workspace 并构建面板：

```bash
(cd plugin/host && npm ci)
(cd plugin/panel && npm ci && npm run build)
```

构建完成后，用平台脚本进行本地 CEP 部署：

```powershell
.\scripts\install-plugin-dev.ps1
```

```bash
./scripts/install-plugin-dev-macos.sh
```

Adobe After Effects C/C++ Plug-in SDK 由开发者自行提供，必须放在仓库外。
构建原生插件前先校验：

```bash
node scripts/package/ae-sdk-input.mjs verify-input --platform macos-arm64
```

冻结的原生平面应构建到仓库外的新目录。安装器把事务状态保存在
`native-plugin-dev-v1` 下；安装后保留输出的事务 ID：

```bash
AE_SDK_ARCHIVE=/absolute/path/AfterEffectsSDK.zip
AE_SDK_ROOT=/absolute/path/AfterEffectsSDK
BUILD_DIR=/private/tmp/ae-mcp-native-dev
TRANSACTION_ID="粘贴安装输出的事务 ID"
node native/ae-plugin/build-macos.mjs \
  --sdk-archive "$AE_SDK_ARCHIVE" \
  --sdk-root "$AE_SDK_ROOT" \
  --output "$BUILD_DIR"
# 安装状态根目录为 native-plugin-dev-v1。
node native/ae-plugin/install-dev-macos.mjs install --artifact-dir "$BUILD_DIR"
node native/ae-plugin/install-dev-macos.mjs rollback \
  --transaction "$TRANSACTION_ID"
```

原生平面已经冻结；AEGP 协议生成文件随仓库保存，普通开发不再运行能力包
代码生成流水线。

## 测试和打包

本地可先运行纯 Node 契约测试：

```powershell
node --test scripts/package/test/verify-windows-zxp-stage.test.mjs
node --test scripts/package/test/zxp-payload-audit.test.mjs
```

Windows ZXP 暂存只复制面板、宿主、JSX、shared、图标和宿主生成资产；它
精确校验宿主 Express `4.22.2`，并在一次签名步骤中完成 ZXP 签名：

```powershell
.\scripts\package-zxp.ps1 -SkipSigning
```

签名 ZXP 不得包含嵌套原生二进制；原有机制明确处理的 `.aex` 除外，且
产物必须小于 20 MB。

详见[安装文档](docs/INSTALL.md)、[参考](docs/REFERENCE.md)和
[发布文档](docs/RELEASE.md)。

## 许可证

ae-mcp 使用 MIT License，见 [LICENSE](LICENSE)。Adobe 的 `CSInterface.js`
保留其上游许可声明。
