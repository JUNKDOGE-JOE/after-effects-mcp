# AtomMCP 后端能力对标设计 (B 路线)

**Date**: 2026-04-27
**Status**: Draft — pending user review
**Owner**: after-effects-mcp
**Predecessor**: v0.6.2 (17 verbs: 15 main + 2 diagnostic)
**Target**: v0.7.0 (24 verbs: 21 main + 3 diagnostic [既有 isolateToggle/toastQuery + 新 ping]; checkpoint/revert 升级为真实现)

---

## 1. 目标与非目标

### 1.1 目标

把当前 17-verb 的 MCP server 升级到能"完整覆盖 Atom MCP 18 个工具中所有能驱动 AE 的关键路径功能"，并补齐被显式 deferred 的 6 个读 verb 和 2 个 stub。

具体交付：

- **6 个新 typed 读 verb**：`ae.getProperties`、`ae.scanPropertyTree`、`ae.inspectPropertyCapabilities`、`ae.getExpressions`、`ae.getKeyframes`、`ae.searchProject`。
- **2 个 stub 升级为真实现**：`ae.checkpoint`（list-only stub → action=create/list）、`ae.revert`（NotImplemented → 真 revert）。
- **1 个新诊断 verb**：`ae.ping`（live 测试 handshake smoke）。
- **1 个既有 verb 行为激活**：`ae.exec` 的 `checkpoint_label` 字段从 forward-compat 占位变为"非空时先 create checkpoint 再跑"。
- **第三层 live 测试套件**：`tests/live/`，opt-in，验证端到端 MCP↔bridge↔AE 真接通。

### 1.2 非目标（明确不做）

| 项 | 不做的原因 |
|---|---|
| Atom 的 9 个非关键路径 tool（`create_skill / edit_skill / use_skill / generate_image / create_rig`） | 强依赖 Atom 云端 + skill marketplace + 模型 inference，纯 AE 本地复刻无意义 |
| AE 内嵌 CEP/UXP 面板（"前端"） | 已确认拆为独立 spec 2，依赖本 spec 落地后再开 |
| HTTP/SSE transport | 单客户端 stdio 够用 |
| macOS snapshot | Win32 BitBlt 已够，macOS 留 v0.7+ |
| 在 CI 中跑 live 测试 | hosted runner 跑不了 GUI + 商业软件 + 登录态 AE |

---

## 2. 架构与边界

```
Claude Code
    |  MCP stdio JSON-RPC 2.0
    v
after_effects_mcp.server (Python, asyncio)
    |
    +-- handlers/core.py     critical-path verbs (含升级后的 checkpoint/revert/ping)
    +-- handlers/typed.py    typed sugar verbs (含 6 个新读 verb)
    |
    v
bridge.py (现有，零改动)
    |  pwsh 子进程
    v
AEBMethod/scripts/backend_interface.ps1 (零改动)
    |
    v
%TEMP%/aebm_bridge/{in,out,done}/   (file-polling protocol)
    |
    v
FileQueue.cpp (AE 插件，零改动)
    |
    v
AEGP_ExecuteScript -> AE
```

**关键设计约束**：

1. **AEBMethod 插件仓库零改动**。`backend_interface.ps1` 不加新动词；`FileQueue.cpp` 不加新 case。所有新能力在本仓库内通过"Python 渲染 JSX 模板 → `ae.exec` 派发"实现，与现有 6 个 typed verb 同构。
2. **`ae.readProps` 保留作为 escape hatch**。新 `ae.getProperties` 是结构化的、可枚举的、可分页的；`ae.readProps` 保留任意只读 JSX 入口。
3. **checkpoint 完全在 Python + JSX 层实现**。落盘走 `app.project.save(File(...))`；revert 走 `app.open(File(...))`。不进 file-polling queue 之外的任何新通道。
4. **每个 schema 仍然 `extra="forbid"`**。

---

## 3. 命名约定

保持现仓库 camelCase：`ae.scanPropertyTree`、`ae.getProperties`、`ae.inspectPropertyCapabilities`、`ae.getExpressions`、`ae.getKeyframes`、`ae.searchProject`、`ae.ping`。**不**照搬 Atom 的 snake_case。

---

## 4. 新增 / 升级 verb 详细 schema

所有 verb 出参约定：成功 `{"ok": true, ...}`，失败 `{"ok": false, "error": "<msg>"}`。

### 4.1 `ae.ping` (新增, 诊断)

**目的**：live 测试 session 起手 handshake；快速判断"AE 在跑 + 插件加载 + bridge 通"。

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `expect` | str | 否，默认 `"pong"` | 期望返回的字符串 |

**实现**：JSX 直接 `JSON.stringify({pong: "<expect>"})`，时延 < 200ms 视为健康。

**出参**：`{ok: bool, pong: str, latencyMs: int, aeVersion: str}`。

---

### 4.2 `ae.getProperties` (新增, typed read)

**目的**：结构化"按名搜属性"，等价于 Atom 的 `get_properties`。

| 入参 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `comp_id` | str | 否 | active comp | AE item id |
| `layer_ids` | int[] | **是** | — | 1-based layer 索引列表 |
| `query` | str | **是** | — | 多词 AND；用 `\|` 分隔即 OR |
| `offset` | int (≥0) | 否 | 0 | 分页 |
| `limit` | int (1-500) | 否 | 50 | 分页 |

**JSX 模板** (`jsx_templates/get_properties.jsx`)：

- 解析 `query`：以 `\|` split 为 OR groups，每组以空白 split 为 AND tokens。
- 对每个 layer 递归遍历 `propertyGroup`，对每个 `Property` 节点：
  - `name` 与 `matchName` 都参与匹配（小写化 + token 全包含）。
  - 命中时记录 `{layerId, propPath, value, hasExpression, hasKeyframes, propType}`。
- 排序：Transform 子树 > 直接 name 命中 > matchName 命中。
- 应用 `offset/limit`，返回 `total` (未截断前总数) 用于分页。

**出参**：

```json
{
  "ok": true,
  "total": 42,
  "results": [
    {
      "layerId": 1,
      "propPath": "Transform/Position",
      "propType": "ThreeD_SPATIAL",
      "value": [960, 540, 0],
      "hasExpression": false,
      "hasKeyframes": true
    }
  ]
}
```

---

### 4.3 `ae.scanPropertyTree` (新增, typed read)

**目的**：单 layer 的深度属性树 dump，等价于 Atom 的 `scan_property_tree`。

| 入参 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `comp_id` | str | 否 | active comp | — |
| `layer_id` | int (≥1) | **是** | — | — |
| `max_depth` | int (1-10) | 否 | 4 | 防 mask/effects 嵌套树爆炸 |
| `include_values` | bool | 否 | true | 仅要 schema 时关掉省传输量 |

**JSX 模板** (`jsx_templates/scan_property_tree.jsx`)：

DFS 遍历 `layer.property("ADBE Root")` 起的整棵树（实际上 ExtendScript 没暴露 ADBE Root，用 `for (i=1; i<=layer.numProperties; i++)` 入口），到 `max_depth` 层截断。每节点：

```json
{
  "name": "Transform",
  "matchName": "ADBE Transform Group",
  "kind": "PropertyGroup" | "Property",
  "propType": "ThreeD_SPATIAL",
  "value": [...] | null,
  "hasExpression": false,
  "numKeyframes": 0,
  "children": [...]
}
```

**出参**：`{ok, layerId, layerName, tree: <node>, truncatedAt: int|null}`。

---

### 4.4 `ae.inspectPropertyCapabilities` (新增, typed read)

**目的**：写入前问"这条 path 上能干什么"，等价于 Atom 的 `inspect_property_capabilities`。

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `comp_id` | str | 否 | active comp |
| `layer_id` | int | **是** | — |
| `path` | str | **是** | 复用 `ae.setProperty` 的 `Transform/Position` 风格 |

**JSX 模板** (`jsx_templates/inspect_property_capabilities.jsx`)：

walk path → 拿到 `Property` 实例 → 读 `canSetExpression / propertyValueType / numKeyframes / minValue / maxValue / unitsText / hasMin / hasMax / isTimeVarying`。

**出参**：

```json
{
  "ok": true,
  "exists": true,
  "canSetValue": true,
  "canSetExpression": true,
  "canAddKeyframe": true,
  "propType": "ThreeD_SPATIAL",
  "valueDimension": 3,
  "hasMin": false,
  "hasMax": false,
  "minValue": null,
  "maxValue": null,
  "unitsText": "pixels",
  "numKeyframes": 2,
  "hasExpression": false
}
```

---

### 4.5 `ae.getExpressions` (新增, typed read)

**目的**：读 comp 内所有表达式源码，等价于 Atom 的 `get_expressions`。

| 入参 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `comp_id` | str | **是** | — | — |
| `layer_ids` | int[] | 否 | 全 comp | 限制扫描范围 |
| `prop` | str | 否 | — | matchName 子串过滤 |
| `max_results` | int (1-1000) | 否 | 200 | 防大工程爆炸 |

**JSX 模板** (`jsx_templates/get_expressions.jsx`)：

遍历 layer × property tree，对 `canSetExpression && expression !== ""` 的 property 收集 `{layerId, propPath, expression, enabled: !expressionDisabled}`。表达式源码做 SHA-1 截断 (8 字符) 作为 `hash`，相同 hash 进 `grouped`。超过 `max_results` 时 `truncated: true`。

**出参**：

```json
{
  "ok": true,
  "expressions": [
    {"layerId": 1, "propPath": "Transform/Position", "expression": "wiggle(2,30)", "enabled": true, "hash": "a3f2..."}
  ],
  "grouped": {"a3f2...": [{"layerId":1,"propPath":"Transform/Position"}, {"layerId":2,"propPath":"Transform/Position"}]},
  "truncated": false
}
```

---

### 4.6 `ae.getKeyframes` (新增, typed read)

**目的**：读单 property 的关键帧，等价于 Atom 的 `get_keyframes`。

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `comp_id` | str | 否 | active comp |
| `layer_id` | int | **是** | — |
| `path` | str | **是** | property path |

**JSX 模板** (`jsx_templates/get_keyframes.jsx`)：

walk path → 对 `i in 1..numKeyframes` 读 `keyTime / keyValue / keyInInterpolationType / keyOutInterpolationType / keyInTemporalEase / keyOutTemporalEase / keyInSpatialTangent / keyOutSpatialTangent`。

**出参**：

```json
{
  "ok": true,
  "numKeyframes": 3,
  "keyframes": [
    {
      "index": 1,
      "time": 0.0,
      "value": [960, 540, 0],
      "interpIn": "LINEAR",
      "interpOut": "BEZIER",
      "easeIn": [{"speed": 0, "influence": 16.67}],
      "easeOut": [{"speed": 0, "influence": 16.67}],
      "spatialIn": [0, 0, 0],
      "spatialOut": [0, 0, 0]
    }
  ]
}
```

---

### 4.7 `ae.searchProject` (新增, typed read)

**目的**：跨工程模糊搜索，等价于 Atom 的 `search_project`。

| 入参 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | str | **是** | — | 多词 AND；`\|` OR |
| `scope` | str[] | 否 | 全开 | `["layers","expressions","effects","comps","items"]` 子集 |
| `limit` | int (1-500) | 否 | 100 | — |

**JSX 模板** (`jsx_templates/search_project.jsx`)：

- `comps` / `items`: `app.project.items` → 过滤 `name`。
- `layers`: 遍历每个 CompItem 的 layers。
- `effects`: 遍历每个 layer 的 `Effects` group → 过滤 effect `name`/`matchName`。
- `expressions`: 遍历每个 layer 的 property tree → expression 文本里 substring。

返回带 `score` 的命中数组（综合：name 命中 > matchName 命中 > expression substring；comps/items > layers > effects > expressions）。

**出参**：

```json
{
  "ok": true,
  "hits": [
    {"kind": "layer", "compId": "12", "layerId": 3, "name": "BG", "snippet": "BG", "score": 0.9},
    {"kind": "expression", "compId": "12", "layerId": 5, "propPath": "Transform/Rotation", "snippet": "...wiggle(2,30)...", "score": 0.5}
  ],
  "truncated": false
}
```

---

### 4.8 `ae.checkpoint` (升级, stub → 真实现)

| 入参 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | `"create" \| "list"` | 否 | `"list"` | 默认 list 保留 v0.6 兼容 |
| `label` | str | 否 (create 时建议给) | `""` | 人类可读标签 |
| `limit` | int (1-200) | 否 | 20 | list 时分页上限 |

**create 行为**（JSX 在 `ae.exec` 内或独立 JSX 渲染）：

1. 计算 checkpoint id：`<unix_ms>_<hex8>` (random)。
2. 路径：`%TEMP%/aebm_checkpoints/<project_basename_or_untitled>/<id>.aep`。
3. JSX 序列（避开 `app.project.save(File)` 的 fsName 副作用）：
   ```javascript
   if (app.project.file === null) {
     // untitled 项目：静默跳过，不报错不写盘
     return JSON.stringify({ok: true, skipped: true, reason: "untitled-project"});
   }
   app.project.save();                                 // 落盘到原路径（无副作用）
   var src = app.project.file;
   var dst = new File("...<id>.aep");
   src.copy(dst.fsName);                               // 拷贝整个 .aep
   ```

   关键点：**绝不能用 `app.project.save(File(checkpointPath))`**——这会把当前 project 的 fsName 切到 checkpoint 路径，污染用户工作流。先 `save()` 到原路径再 `File.copy()` 是无副作用的。

   **untitled project 静默跳过**：`app.project.file === null` 时不报错不写盘，返回 `{ok: true, skipped: true, reason: "untitled-project", id: null}`。理由：用户随时可能 New Project 后立刻让 Claude 跑一段 `ae.exec(..., checkpoint_label="x")`，硬报错会让 Claude 进入"我得先让用户存盘"的循环；静默跳过则保留 verb 的写动作仍然执行，只是无 rollback 能力。用户存盘后下次调用自然恢复。这与 Atom 行为对齐（Atom 在 unsaved 项目上 checkpoint 也是降级，见 ATOM_INTEGRATION.md "checkpoint: unavailable"）。
4. 写元数据 `<id>.json`：`{id, label, ts: ISO8601, sourceProjectPath, activeCompId, currentTime, sizeBytes}`。
5. 触发 retention：按 ts 降序保留 `AEBM_CHECKPOINT_KEEP` (默认 50) 个，多余的删 `.aep` + `.json`。

**list 行为**：

读 `%TEMP%/aebm_checkpoints/<project_basename>/*.json`，按 ts 降序，取 `limit` 条。无对应 `.aep` 文件的孤儿 `.json` 跳过并清理。

**出参**：

```json
// action: "create" (saved project)
{"ok": true, "id": "1714180800000_a3f2bc91", "label": "before risky write", "path": "C:/.../1714180800000_a3f2bc91.aep", "sizeBytes": 12345678}

// action: "create" (untitled project — silent skip)
{"ok": true, "skipped": true, "reason": "untitled-project", "id": null}

// action: "list"
{"ok": true, "checkpoints": [{"id": "...", "label": "...", "ts": "2026-04-27T...", "sizeBytes": 12345678, "activeCompId": "12"}], "total": 17}
```

---

### 4.9 `ae.revert` (升级, NotImplemented → 真实现)

| 入参 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `checkpoint_id` | str | **是** | — | 来自 `ae.checkpoint list` |
| `branch_before_revert` | bool | 否 | true | revert 前先 create 一个 "before-revert" checkpoint |

**行为**：

1. 解析 `<project_basename>` 同步 list：找到 `<id>.aep`。不存在 → `{ok: false, error: "checkpoint not found"}`。
2. 若 `branch_before_revert`：先调内部 `_create_checkpoint(label="before-revert-<short-id>")`。
3. JSX：
   ```javascript
   app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
   app.open(new File("...<id>.aep"));
   ```
4. 出参：`{ok, reverted: true, openedPath, branchedFromId?: str}`。

**已知限制**：revert 后 AE 当前 project 路径切到 checkpoint .aep。后续 `ae.checkpoint create` 会把 source 记为这个路径。这是符合 Atom 行为的（revert 等价于"从那个状态重新出发"），但用户得在 README 提一句。

---

### 4.10 `ae.exec` `checkpoint_label` 行为激活

现有 schema 字段：`checkpoint_label: str | None = None`。

**新行为**：非空时，`run_fn` 在调 JSX 之前先调 `_create_checkpoint(label=checkpoint_label)`。失败（如 untitled project）下游 `ae.exec` 仍正常跑，但出参带 `checkpointSkipped: "<reason>"`。

**与 Atom 对齐**：Atom 是"before each change 自动 hidden checkpoint"。我们做"用户/Claude 显式给 label 才创建"，更克制：避免一边在 `ae.readProps` 流量里也疯狂落 .aep。Claude prompt 文档（REFERENCE.md）会教模型：`ae.exec` + 写操作 → 一律带 `checkpoint_label`。

---

## 5. 实现拆分

### 5.1 文件改动清单

| 文件 | 改动 |
|---|---|
| `after_effects_mcp/schemas.py` | +7 个 pydantic model（含 `PingArgs`、`GetPropertiesArgs`、`ScanPropertyTreeArgs`、`InspectPropertyCapabilitiesArgs`、`GetExpressionsArgs`、`GetKeyframesArgs`、`SearchProjectArgs`）；升级 `CheckpointArgs`（加 `action/label`）、`RevertArgs`（无变化，但改 docstring） |
| `after_effects_mcp/handlers/typed.py` | +6 个 handler（一一对应新 schema），全部 = "渲染模板 → `bridge.invoke_ae_eval` 或经 `ae.exec` 走" |
| `after_effects_mcp/handlers/core.py` | 升级 `checkpoint_handler`、`revert_handler`、`exec_handler`（激活 `checkpoint_label`）；新增 `ping_handler` |
| `after_effects_mcp/checkpoint_store.py` | **新文件**：纯 Python，管 `%TEMP%/aebm_checkpoints/<basename>/` 的 list/prune/lookup |
| `after_effects_mcp/jsx_templates/*.jsx` | +7 个模板（含 `checkpoint_create.jsx`、`revert.jsx`、6 个读 verb 模板） |
| `after_effects_mcp/server.py` | 注册 +7 个 verb 到 `tools/list` 和 `tools/call` 路由 |
| `tests/test_schemas.py` | +7 schema 测试组 |
| `tests/test_handlers_typed.py` | +6 handler/render 测试 |
| `tests/test_handlers_core.py` | +ping、+checkpoint create/list 行为、+revert 行为（mock_bridge） |
| `tests/test_checkpoint_store.py` | **新文件**：纯文件系统单测，不依赖 bridge |
| `tests/live/__init__.py` | **新目录**：opt-in live 测试 |
| `tests/live/conftest.py` | **新文件**：`live_bridge` fixture + `AEBM_LIVE_TESTS` 门控 |
| `tests/live/test_*.py` | **新文件**：每个 verb 一个端到端 case |
| `pyproject.toml` | +`markers = ["live: requires real AE"; "live_smoke: 3-verb handshake subset"]`，+`addopts = "-m 'not live'"` |
| `docs/REFERENCE.md` | 动词表从 17 → 24；删 "Not doing" 表里的 6 行；新增 §"checkpoint store"、§"live test layer" 章节 |
| `README.md` | verb 计数、Quick reference 表、`AEBM_CHECKPOINT_KEEP` 环境变量 |

### 5.2 复杂度评估

| 单元 | 估时 |
|---|---|
| 6 个新读 verb 的 schema + handler + JSX 模板 | 2-3 天（最大不确定性在 `scanPropertyTree` 的递归 + value 序列化和 `searchProject` 的 scope 取舍） |
| checkpoint_store + checkpoint/revert handler 升级 | 1.5 天（File.copy 行为、untitled 项目降级、retention 边界都得测到） |
| `ae.ping` + `ae.exec` checkpoint_label 激活 | 0.5 天 |
| live 测试套件 (~24 个 case) | 1.5 天 |
| 文档更新 + Cleanup | 0.5 天 |
| **合计** | **~6 工作日** |

---

## 6. 测试策略

### 6.1 三层测试金字塔

| 层 | 数量 | 依赖 | CI | 命令 |
|---|---|---|---|---|
| schema 单测 | ~30 (现 15 + 7 新 + checkpoint/revert/exec 升级) | 无 | ✅ | `pytest tests/test_schemas.py` |
| handler/render 单测 | ~25 | mock_bridge | ✅ | `pytest tests/test_handlers_*.py` |
| checkpoint_store 单测 | ~10 | tmp_path 文件系统 | ✅ | `pytest tests/test_checkpoint_store.py` |
| **live 集成** | **~24** | **真 AE + 插件** | ❌ opt-in only | `AEBM_LIVE_TESTS=1 pytest -m live` |
| **live_smoke** | **3** (ping + exec + snapshot) | 真 AE | ❌ opt-in | `AEBM_LIVE_TESTS=1 pytest -m live_smoke` |

### 6.2 live 测试 fixture 链

```python
# tests/live/conftest.py 伪代码
@pytest.fixture(scope="session")
def live_bridge():
    if os.environ.get("AEBM_LIVE_TESTS") != "1":
        pytest.skip("live tests are opt-in: set AEBM_LIVE_TESTS=1")
    # handshake
    res = bridge.invoke_ae_ping()
    if not res.get("ok"):
        pytest.fail(f"AE not reachable: {res.get('error')}")
    yield bridge

@pytest.fixture
def clean_project(live_bridge):
    live_bridge.invoke_ae_exec("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); JSON.stringify({ok:true});")
    yield live_bridge
    live_bridge.invoke_ae_exec("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); JSON.stringify({ok:true});")
```

### 6.3 失败诊断

live 测试失败时，conftest 在 `tests/live/_artifacts/<test_name>/` 落：
- bridge 最近一次 stderr
- `%TEMP%/aebm_bridge/out/<id>.json` 内容
- 失败时刻 `ae.snapshot` 一张图
- pytest 完整 traceback

### 6.4 CI 策略

`.github/workflows/ci.yml`（现有）保持不变：Linux + Windows，跑 unit 三层（schema / handler / checkpoint_store），完全 AE-free。

**不新增** live CI workflow——hosted runner 跑不了真 AE。Live 套件的执行被写入 `docs/REFERENCE.md` "Release checklist"，发版前由维护者本地跑一遍。

---

## 7. 风险与回退

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `app.project.save()` 副作用切换 fsName | 高 | checkpoint 把用户工程文件路径改了 | 用 `File.copy()` 而非 save(File)；untitled project 静默跳过 (`skipped: true`) 不写盘 |
| `scanPropertyTree` 在大 comp 爆栈/超时 | 中 | bridge timeout | `max_depth` 默认 4，文档明确"超过 4 层非常罕见"；`ae.exec` `timeout_sec` 提到 60s |
| `getExpressions` 输出超大（千行表达式工程） | 中 | MCP 消息体超 stdio buffer | `max_results` 默 200 + truncated 标记 |
| `searchProject` 跨 scope 性能 | 低 | 单次 5s+ | 默认 limit 100；scope 可裁 |
| live 测试 flaky（AE focus 抢占 / dialog） | 中 | 误报 fail | 复用 AEBMethod 的 sim_gesture ESC 自清；conftest 在 setup 阶段调一次 |
| Atom 协议 drift 导致语义偏离 | 低 | Atom 改了我们没跟进 | 我们和 Atom 现在已经是平行实现，不消费 Atom server，drift 不影响功能；只是 docs 类比可能过期 |

**回退策略**：本设计每个新 verb 都是叠加，不破坏 v0.6.2 已有 17 verb 的任何行为。即使 6 个新 verb 全坏，旧 verb 仍可用。`checkpoint/revert` 升级前后的 schema 是兼容的（`action` 默认 `"list"` 时表现等价于 v0.6.2 的 list-stub，只是返回真实数据而非空列表；这本身就是"修复"而非"破坏"）。

---

## 8. 文档同步

### 8.1 `docs/REFERENCE.md` 章节清单

- §"Quick facts" 表：handler count 15 → 21（9 core + 12 typed；不计诊断），新增 `Checkpoint store` 行。
- §"Verb reference" 新增 6 个读 verb + ping。
- §"Verb reference" 升级 `ae.checkpoint`、`ae.revert`、`ae.exec` 的描述。
- 新章节 §"Checkpoint store"：路径、保留策略、untitled 降级、`AEBM_CHECKPOINT_KEEP` 环境变量、`File.copy` vs `app.project.save` 的取舍。
- 新章节 §"Live test layer"：opt-in 流程、`AEBM_LIVE_TESTS=1`、smoke vs full、artifact 目录。
- §"Not doing" 表：删 `inspect_property_capabilities / get_expressions / get_keyframes / search_project / scan_property_tree` 5 行；保留 `create_skill / generate_image / create_rig / use_skill / edit_skill`，原因列改为"依赖 Atom 云端 / skill marketplace，本地 AE-only 无意义"。

### 8.2 `README.md`

- "Verb reference" 表 17 → 23 + ping。
- 新增"Live tests"小节。
- `.mcp.json.template` 不变。

---

## 9. 后续 spec（已划清边界，不在本 spec 内）

- **spec 2**: AE 内嵌 CEP 副驾面板（checkpoint timeline 可视化、verb 执行状态灯、bridge 健康监测）。依赖本 spec 的 checkpoint_store 已经稳定；预计 v0.8。
- **spec 3**: 真持久化 checkpoint diff store（替代当前整 .aep 拷贝）。依赖 spec 1 跑稳后再判断是否值得做。预计 v1.0+。

---

## 10. 验收标准

本 spec 完成定义为：

1. ✅ `python -m uv run pytest -m "not live"` 全绿（含 +25-30 个新 unit 测试）。
2. ✅ `AEBM_LIVE_TESTS=1 python -m uv run pytest -m live` 在维护者本地（AE 2026 retail + AEBMethod 插件已加载）全绿。
3. ✅ `tools/list` 在 Claude Code `/mcp` 里出现 24 个 `aebm.ae.*` 工具。
4. ✅ `docs/REFERENCE.md` 和 `README.md` 同步更新，verb 计数一致。
5. ✅ `ae.checkpoint create` → 改属性 → `ae.revert` → 验证属性回滚的 live 测试通过（这是真 vs stub 的核心证据）。
6. ✅ 现有 73 个测试 0 退化。

---

## 11. 决策记录

| 议题 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 对标范围 | A 全 18 / B 关键路径 / B+ 加 daily ops / C 仅修 stub | **B** | 用户拍板：skill/marketplace/generate_image 在 AE-local 语境下无意义；daily ops（duplicate/mask/...）留作未来 |
| checkpoint 实现 | 1 .aep 拷贝 / 2 JSON diff / 3 undo 包装 | **1** | Atom 官方 docs 明确说"full project state"，undo 包装与官方语义不符；JSON diff 工程量爆炸 |
| 5 个新读 verb 实现 | typed JSX 经 ae.exec / 新加 PowerShell 动词 | **typed JSX** | 与现有 6 个 typed verb 同构；AEBMethod 仓库零改动 |
| 命名风格 | snake_case 照搬 Atom / camelCase 跟现仓库 | **camelCase** | `ae.applyEffect` 等已有 11 个 camelCase verb，一致性优先 |
| 测试策略 | 仅扩 unit / unit+live 两层 | **三层 (unit + checkpoint_store + live)** | 用户指出 mock_bridge 不能证明真接通 AE；live 必须有但不能进 CI |
| 前端面板 | 同 spec 内做 / 拆独立 spec | **拆 spec 2** | 用户确认延后；先把后端做完 |

---

**文档结束**。本文档应在动手实现前由用户 review；review 通过后调用 writing-plans 技能产出实施计划（split 成多 commit 的 task 列表）。
