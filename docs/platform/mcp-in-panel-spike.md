# MCP in CEP Node spike

Issue #261 的 Phase 0 spike 将一个手写、零依赖的 Streamable HTTP MCP endpoint 挂在现有 CEP Node Express 宿主的 `/mcp`。它不是 Python server 的迁移完成，也没有改变 `/exec` 的共享密钥边界。

## 已实现的最小闭环

- `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`；会话为内存态，面板重载即失效，客户端应重新 initialize。
- 两个 experimental 工具：`ae_status` 读取宿主进程内状态，`ae_exec` 复用 `/exec` 的暂停/客户端阻断、Undo group、ExtendScript 传输封装、native graph 失效与 activity 记录路径。
- `GET /mcp` 是会话绑定的 SSE stream，15 秒 keepalive；带 `_meta.progressToken` 的 `ae_exec` POST 以 SSE 返回，5 秒一次 `notifications/progress`，最后发送 JSON-RPC response。没有 progress token 的调用返回普通 JSON，但 HTTP 请求会持续到工具完成。
- `/mcp` 不用 `/exec` token。无 `Origin` 的本机 CLI 放行；有 `Origin` 时仅允许当前端口的 `http://127.0.0.1`、`http://localhost` 或 `null`，`Host` 同样必须是这两个 loopback 名称和当前端口。
- 已解析的 JSON-RPC 协议错误仍返回 HTTP 200：官方 MCP SDK 会把非 2xx 当作传输失败而丢弃 JSON-RPC error body；只有解析失败、会话缺失/未知和 HTTP 安全边界错误使用非 2xx。

## Node 15 结论与已知坑

CI 在 Node 24 安装 lockfile v3 的 `node_modules`，再切换到 Node 15.14.0 执行真实 31 秒 `ae_exec` 集成脚本。原因是 Node 15 自带 npm 7 不保证能读取该 lockfile。host 代码保持 CommonJS、ES2020、无新依赖和无 `node:` specifier；随机 session id 使用 `crypto.randomBytes`，不用较晚才提供的 `randomUUID`。本次 CI 级 Node 15 运行未发现额外运行时 API 坑。

CI 不能证明的真机事项（须 AE 2023/2024 众测）：

- CEF 面板隐藏、停靠、最小化或失焦时，SSE/HTTP 长连接是否被节流或提前断开。
- AE 主线程繁忙、模态对话框、项目切换和 CEP reload 下，31 秒以上 `evalScript` 的回调与连接恢复表现。
- Windows/macOS 本机 Origin/Host 头在 Claude Code、Cursor 等 MCP 客户端中的实际形状。
- 面板关闭后的 session 断连与客户端重新 initialize 体验。

## Phase 1 的下一步

在这个注册表、会话表和 SSE writer 之上，先把每会话配置和既有 approval gate 接入 `ae_exec`，再按方向文档顺序迁移 `ae.previewFrame`、结构化 `ae.read`、checkpoint/revert、表达式校验和独立的 `ae.nativeExec`。本 spike 故意未实现 approval、checkpoint、elicitation、会话持久化或其余工具。
