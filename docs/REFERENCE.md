# ae-mcp Reference

## 中文

### 快速信息

| 项目 | 当前契约 |
|---|---|
| 公开工具数 | 16，按最终公开 surface 注册 |
| Preview 输出 | 默认位于操作系统临时目录的 `ae_mcp_previews/<session>/...png`，可用 `out_dir` 覆盖 |
| Checkpoint 存储 | 操作系统临时目录下的 `ae_mcp_checkpoints/<basename>/<id>.aep + .json` |

### v0.9.3 平台与分发契约

v0.9.3 是 Windows x64 版本。固定发布资产为
`ae-mcp-panel-v0.9.3-windows-x64.zxp`、
`AeMcpNative-v0.9.3-windows-x64.aex` 与 `SHA256SUMS-v0.9.3.txt`。
AEX 需手动复制到所选 AE 插件目录；现有外部 runtime/launcher 仍是前置条件。
本版不提供一体化安装器、Windows RuntimeManager 或零环境首跑。

Claude Code CLI、Codex CLI 与 ZCode CLI/app-server 都只是对应 AI 通道的
**可选**依赖，不是 Core 或两个执行入口的前置条件。

### 最终公开工具面

| 类别 | 工具 |
|---|---|
| 执行 | `ae_exec`、`ae_nativeExec` |
| 画面与表达式验证 | `ae_previewFrame`、`ae_validateExpressions` |
| Undo 与恢复 | `ae_checkpoint`、`ae_revert`、`ae_snapshot` |
| Skill 库 | `ae_skillList`、`ae_skillUse` |
| Tool 库 | `ae_toolIndex`、`ae_toolSearch`、`ae_toolInspect`、`ae_toolUse` |
| 诊断 | `ae_ping`、`ae_status`、`ae_diagnose` |

`ae_toolUse` staged actions: `render`, `prepare`, `grant`, `execute`, `start`,
`status`, `cancel`, `history`, and `save`.

`ae_toolUse` action 参数：

| action | required | optional | 说明 |
|---|---|---|---|
| `render` | `action`, `artifact_id` | `args`, `operation` | 只渲染 |
| `prepare` | `action`, `artifact_id`, `operation` | `args`, `target` | 生成绑定内容的计划 |
| `grant` | `action`, `plan_hash`, `grant_scope` | 无 | 授权计划 |
| `execute` | `action`, `plan_hash`, `grant_id`, `operation_id` | 无 | 同步执行 |
| `start` | `action`, `plan_hash`, `grant_id`, `operation_id` | 无 | 异步开始 |
| `status` | `action`, `execution_id` | 无 | 读取状态 |
| `cancel` | `action`, `execution_id` | 无 | 请求取消 |
| `history` | `action`, `artifact_id` | `limit` | 读取历史 |
| `save` | `action`, `save` | 无 | 明确创建 JSX artifact 或按精确版本晋升 candidate |

取消结果为 `cancelled-before-dispatch`、`not-cancellable-after-dispatch`、
`owned-by-another-core` 或 `already-terminal`。这些结果仅在 execution record 或 reservation 仍被保留时成立。
若当前 Core 尚未观察该 reservation，应先查询；跨 Core 缓存可能仍停留在旧 reservation。
Inspect 返回包含完整 `content`；status/history 可暴露非终态 `reservations`（`queued`/`running`）。

公开执行入口只有两条。AE scripting object model 能完成的操作使用
`ae_exec`；只有统一 primitive catalog 中明确提供的 AEGP-only 语义使用
`ae_nativeExec`。不要寻找或调用 operation-specific convenience tool。

### 默认执行 Skill

在选择路径或组合非平凡请求前加载：

```text
builtin:skill:ae-execution-guide
```

该 Skill 给出 ExtendScript、native program、readback、Undo、不确定写入核对和
画面验证的完整规则，并包含从统一 registry 生成的 primitive reference。

### `ae_exec`

`ae_exec` 接受完整 JSX：

```json
{
  "code": "JSON.stringify({ok:true});",
  "undo_group_name": "Describe the edit",
  "timeout_sec": 30
}
```

`ae_exec` 只执行本次请求，不创建或更新 Tool Library artifact。若用户要求模型
保存 JSX，模型必须另外调用 `ae_toolUse`、设置 `action="save"`；用户请求可创建
`status="saved"` 或 `status="candidate"`。若模型自行判断 JSX 以后可能有用，
也必须另发一次调用，并且只能用 `intent="model-curated"` 创建不可执行的
`candidate`，不能在每次执行后自动保存。

创建请求使用完整 draft，不能混入已有 artifact identity：

```json
{
  "action": "save",
  "save": {
    "mode": "create",
    "intent": "user-requested",
    "status": "saved",
    "artifact": {
      "name": "Reusable JSX",
      "description": "What the script does",
      "kind": "jsx",
      "category": "workflow",
      "tags": [],
      "compatibility": {},
      "declared_risk": "write",
      "content": "JSON.stringify({ok:true});",
      "args_schema": {}
    }
  }
}
```

晋升请求不接受 replacement draft，并要求用户明确请求以及精确的
revision/content-hash compare-and-swap：

```json
{
  "action": "save",
  "save": {
    "mode": "promote",
    "intent": "user-requested",
    "status": "saved",
    "artifact_id": "chat-tool-call:candidate-id",
    "expected_revision": 1,
    "expected_content_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Candidate 默认不出现在 saved/pinned discovery 中，也不能通过 `ae_toolUse`
render 或 execute。它会一直保留，直到面板明确删除，或用户要求以上述精确
CAS 晋升；没有自动过期或清理。已有 candidates 保持不变。

读操作应以 `JSON.stringify(...)` 结尾。写操作应提供可识别的 Undo label，
随后使用独立读取验证状态。需要画面判断时再调用 `ae_previewFrame`；写入表达式
后先调用 `ae_validateExpressions`。

### `ae_nativeExec`

原生入口接受一个最多 64 个 operation 的线性 program：

```json
{
  "operationKey": "required-for-write-programs",
  "undoGroup": "One real AE Undo group",
  "operations": [
    {
      "op": "composition.resolve",
      "args": {"locator": {"kind": "composition"}},
      "saveAs": "composition"
    },
    {
      "op": "composition.time.read",
      "args": {"composition": {"ref": "composition"}},
      "returnAs": "time"
    }
  ]
}
```

实际 locator 必须从真实读取结果原样复制；示例中的缩略 locator 只说明 envelope，
不能直接提交。resolver 保存的是带类型、仅在本次请求内有效的 handle。引用只能
指向前面已命名的值，handle 不会序列化，也不会跨请求、重连或 host 重启存活。

只读 program 不携带 `operationKey` 与 `undoGroup`。只要包含一个写 primitive，
两者都必填；同一 key 只能绑定规范化后完全相同的 program。一个写 program 使用
一个真实 AE Undo group，但不承诺原子性，也不会在部分失败后静默回滚。

### Readback、失败与 Undo

- 写入前读取基线，写入后用新的独立请求读取结果。
- 图结构变化或 Undo 后重新解析 locator。
- typed terminal、AE 状态、postcondition 和 audit 必须一致。
- timeout 或断连发生在 dispatch 之后时，结果可能已经产生副作用；先读 AE 状态并
  核对 audit，再考虑重放。
- `undo.available=true` 只说明 Undo 边界存在，不说明 Undo 已执行或已验证。
- 真正执行 Undo 后，再用独立读取证明基线恢复。

### Primitive catalog

唯一手工维护的 primitive catalog：

```text
native/ae-plugin/protocol/native-primitives.json
```

检查所有生成投影：

```bash
uv run python scripts/generate_native_exec.py --check
```

不要维护第二份 primitive ID、schema 或文档表。

## English

### Quick facts

| Item | Current contract |
|---|---|
| Public tool count | 16 on the final public surface |
| Preview output | `ae_mcp_previews/<session>/...png` in the operating-system temporary directory unless `out_dir` is set |
| Checkpoint store | `ae_mcp_checkpoints/<basename>/<id>.aep + .json` under the operating-system temporary directory |

### v0.9.3 platform and distribution contract

v0.9.3 is a Windows x64 release. Its fixed assets are
`ae-mcp-panel-v0.9.3-windows-x64.zxp`,
`AeMcpNative-v0.9.3-windows-x64.aex`, and `SHA256SUMS-v0.9.3.txt`.
Install the AEX manually in the selected AE plug-in directory and retain the
existing external runtime/launcher. This release has no integrated installer,
Windows RuntimeManager, or zero-environment onboarding.

Claude Code CLI, Codex CLI, and the ZCode CLI/app-server are **optional**
dependencies for their corresponding AI channels, not prerequisites for Core
or either execution route.

### Final public tool surface

| Category | Tools |
|---|---|
| Execution | `ae_exec`, `ae_nativeExec` |
| Visual and expression verification | `ae_previewFrame`, `ae_validateExpressions` |
| Undo and recovery | `ae_checkpoint`, `ae_revert`, `ae_snapshot` |
| Skill library | `ae_skillList`, `ae_skillUse` |
| Tool library | `ae_toolIndex`, `ae_toolSearch`, `ae_toolInspect`, `ae_toolUse` |
| Diagnostics | `ae_ping`, `ae_status`, `ae_diagnose` |

`ae_toolUse` staged actions are `render`, `prepare`, `grant`, `execute`, `start`,
`status`, `cancel`, `history`, and `save`.

`ae_toolUse` action fields:

| action | required | optional | purpose |
|---|---|---|---|
| `render` | `action`, `artifact_id` | `args`, `operation` | render only |
| `prepare` | `action`, `artifact_id`, `operation` | `args`, `target` | build a content-bound plan |
| `grant` | `action`, `plan_hash`, `grant_scope` | none | grant the plan |
| `execute` | `action`, `plan_hash`, `grant_id`, `operation_id` | none | execute synchronously |
| `start` | `action`, `plan_hash`, `grant_id`, `operation_id` | none | start asynchronously |
| `status` | `action`, `execution_id` | none | read status |
| `cancel` | `action`, `execution_id` | none | request cancellation |
| `history` | `action`, `artifact_id` | `limit` | read history |
| `save` | `action`, `save` | none | explicitly create a JSX artifact or promote a candidate with exact version data |

Cancellation reports `cancelled-before-dispatch`,
`not-cancellable-after-dispatch`, `owned-by-another-core`, or
`already-terminal`. These outcomes apply only while the execution record or reservation is retained.
Before this Core has observed any shared reservation, query first; cross-Core caches can still hold an older reservation.
The executor receives the artifact's full `content` from Inspect, while status/history may expose nonterminal `reservations` (`queued`/`running`).

There are exactly two public execution routes. Use `ae_exec` when the
maintained AE scripting object model can perform the operation. Use
`ae_nativeExec` only for AEGP-only semantics present in the generated
primitive catalog. Do not look for operation-specific convenience tools.

### Default execution skill

Load `builtin:skill:ae-execution-guide` before choosing a route or composing
a non-trivial request. It contains the complete ExtendScript and native-program
workflow plus the generated primitive reference.

### `ae_exec`

```json
{
  "code": "JSON.stringify({ok:true});",
  "undo_group_name": "Describe the edit",
  "timeout_sec": 30
}
```

`ae_exec` is request-only: it does not create or update a Tool Library
artifact. When the user asks the model to save JSX, the model makes a separate
`ae_toolUse` call with `action="save"` and may create either `status="saved"`
or `status="candidate"`. When the model independently judges that JSX may be
useful later, it also makes a separate call and may only create a
non-executable candidate with `intent="model-curated"`; it must not save after
every execution.

Create requires a complete draft and forbids existing artifact identity:

```json
{
  "action": "save",
  "save": {
    "mode": "create",
    "intent": "user-requested",
    "status": "saved",
    "artifact": {
      "name": "Reusable JSX",
      "description": "What the script does",
      "kind": "jsx",
      "category": "workflow",
      "tags": [],
      "compatibility": {},
      "declared_risk": "write",
      "content": "JSON.stringify({ok:true});",
      "args_schema": {}
    }
  }
}
```

Promotion forbids a replacement draft and requires a user request plus exact
revision/content-hash compare-and-swap fields:

```json
{
  "action": "save",
  "save": {
    "mode": "promote",
    "intent": "user-requested",
    "status": "saved",
    "artifact_id": "chat-tool-call:candidate-id",
    "expected_revision": 1,
    "expected_content_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Candidates are excluded from default saved/pinned discovery and cannot be
rendered or executed through `ae_toolUse`. They remain until explicit panel
deletion or user-requested promotion with that exact CAS; there is no automatic
expiration or cleanup. Existing candidates are unchanged.

End reads with `JSON.stringify(...)`. Give writes a recognizable Undo label
and verify them with an independent read. Use `ae_previewFrame` when visual
correctness matters, and validate expressions before preview.

### `ae_nativeExec`

```json
{
  "operationKey": "required-for-write-programs",
  "undoGroup": "One real AE Undo group",
  "operations": [
    {
      "op": "composition.resolve",
      "args": {"locator": {"kind": "composition"}},
      "saveAs": "composition"
    },
    {
      "op": "composition.time.read",
      "args": {"composition": {"ref": "composition"}},
      "returnAs": "time"
    }
  ]
}
```

Copy real locators verbatim from real read results; the abbreviated locator
above documents only the envelope. Resolver values are typed request-local
handles. References may point only backward. Handles never serialize or
survive a request, reconnect, or host restart.

Read programs omit `operationKey` and `undoGroup`. A program containing any
write requires both; one key binds one canonical program. A write program uses
one real AE Undo group, is not atomic, and never silently rolls back partial
execution.

### Readback, failures, and Undo

- Read a baseline before writing and use a fresh independent request afterward.
- Re-resolve locators after graph changes or Undo.
- Require agreement among the typed terminal, AE state, postcondition, and audit.
- After a post-dispatch timeout or disconnect, reconcile AE state and audit
  before considering a replay.
- `undo.available=true` does not mean Undo ran or was verified.
- After real Undo, read again and prove the baseline was restored.

### Primitive catalog

The sole hand-maintained catalog is
`native/ae-plugin/protocol/native-primitives.json`. Check every generated
projection with:

```bash
uv run python scripts/generate_native_exec.py --check
```
