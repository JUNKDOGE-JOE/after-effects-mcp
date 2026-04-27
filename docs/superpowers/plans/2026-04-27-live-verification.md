# Live verification plan — `ae-mcp` v0.1.0 真机端到端

**Why this exists**: spec 3a 期间所有"测试通过"的报告都是 Python unit tests（mock_backend，从不接触 AE）。"v0.1.0 ready" 这个判断**没有真机端到端证据**支撑。本计划补这个缺口：把 22 个 verb 全部在真 AE 上跑一遍，失败的修到通过为止。同时把"我自己把 AE 搞崩了"那一类测试卫生问题制度化避免。

**Scope**: 实施过程中可能会回头改 core 代码（如果发现 bug），但目的不是加新功能；只是把现有 22 verb 的真机表现摸清楚、修通。

**Success criteria**:
1. AE + AEBM 插件 + ae-mcp + 重新激活的 backend-aebm 全链路可用
2. 22 个 verb 每个至少有一个 live test 通过
3. 整个 live 套件 `pytest -m live` 在 AE 前台、project 已存盘的标准条件下 100% 绿
4. 测试 fixture 不再会把 AE 搞崩（bridge 文件清理走 graceful drain，不再 `rm -f`）
5. v0.1.0 tag 移到"live verified"的 commit 上；当前指向的纯 unit-pass commit 重命名为 `v0.1.0-rc1`

---

## Phase 0 — AE recovery（当前 AE 挂死在 fatal error dialog）

1. PowerShell `Stop-Process -Name AfterFX -Force`
2. 验证进程退出
3. 用 `_launch_ae_user.ps1` 重启 AE
4. 等 60s 让 AE 完成启动 + 加载 AEBM 插件
5. 提示用户：手动确认 AE 主窗口可见 + AEBM 面板加载 + 新建一个 1080p comp + `File → Save As` 到 `E:/tmp/probe.aep`（让 checkpoint 测试有 fsName 可拷）

## Phase 1 — backend-aebm 重新激活

backend-aebm 已归档但代码完整。开发期最简方案：editable install 让它进 venv 但**不进**仓库：

```bash
python -m uv pip install -e E:/Code/_archive/2026-04-27_ae-mcp-backend-aebm
```

验证：
```bash
python -m uv run python -c "import importlib.metadata as m; print(sorted([e.name for e in m.entry_points(group='ae_mcp.backends')]))"
# 期望: ['aebm']
```

⚠️ 注意：归档目录的 `pyproject.toml` 可能需要小调整以支持 editable install（目前它用 hatchling，应该 OK）。如果失败，临时方案：把整个目录复制到 `packages/_dev_only_backend_aebm/` 加进 workspace（注释明确"开发期临时挂载，发版前移除"）。

## Phase 2 — verb coverage 审计

现有 10 个 live test 覆盖：

| 文件 | 覆盖 verb | 数量 |
|---|---|---|
| test_smoke.py | ping, exec, snapshot | 3 |
| test_read_verbs.py | getProperties, scanPropertyTree, inspectPropertyCapabilities, getExpressions, getKeyframes, searchProject | 6 |
| test_checkpoint_cycle.py | checkpoint(create+list), revert, exec | 3 (复用 exec) |

**实际覆盖**: 10 个 verb（ping, exec, snapshot, 6 个新读 verb, checkpoint, revert）

**未覆盖（12 个）**: init, overview, layers, readProps, applyEffect, createLayer, setProperty, moveLayer, selectLayers, setTime, getTime + （isolateToggle/toastQuery 已删除，不算）

## Phase 3 — 补 12 个缺失 verb 的 live test

新建 `tests/live/test_write_verbs.py`：覆盖 createLayer / setProperty / moveLayer / selectLayers / setTime / getTime / applyEffect。每个测试一个最小修改 + 一个 read-back 验证。

新建 `tests/live/test_proj_verbs.py`：覆盖 init / overview / layers / readProps。这些是只读 verb，不需要 mutation。

每个 test 函数命名 `test_<verb>_<scenario>`，单一断言路径（不堆 setup）。

## Phase 4 — 防御性 fixture（防止再把 AE 搞崩）

`tests/live/conftest.py` 加：

```python
@pytest.fixture(scope="session", autouse=True)
def _drain_bridge_before_session():
    """确保 bridge in/ 在 session 开始时是空的——但只通过 ae_ping 等 AE 自然消化，
    NEVER `rm -f` 文件（会让 plugin 拿到空指针）。"""
    in_dir = Path(os.environ.get("TEMP", "/tmp")) / "aebm_bridge" / "in"
    if in_dir.exists() and any(in_dir.iterdir()):
        # 等 AE 自己消化最多 30s；如果还有，session 直接 fail
        for _ in range(30):
            if not any(in_dir.iterdir()):
                break
            time.sleep(1)
        else:
            pytest.fail(f"bridge in/ has stuck files; cannot start clean: {list(in_dir.iterdir())}")
```

每个 mutation test 后**绝不动**底层 bridge 文件——只通过 `live_backend.exec()` 走正常路径。

## Phase 5 — smoke 跑通

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "aebm"
$env:AE_BRIDGE_ROOT = "E:/Code/AEBMethod"
python -m uv run pytest -m live_smoke -v
```

期望 3/3。如果 `test_snapshot_writes_png` 又拿到 0x0 size，提示用户在 AE 里打开 viewer + 让 comp 有内容（这是 AE 启动后 layout 没完成的老问题，不是 ae-mcp 的 bug）。

## Phase 6 — full live + 12 个新 verb test 一起跑

```powershell
python -m uv run pytest -m live -v
```

期望全绿。预计耗时 3-5 分钟（每个 verb ~10-30s，22 个 verb + 多场景）。

## Phase 7 — debug loop

每个 fail 处理流程：
1. 看 test 输出的 traceback
2. 看 `tests/live/_artifacts/<test_name>/` 里 fixture 落的 bridge stderr / out json / 最后一张 snapshot
3. 看 `%APPDATA%/AEBlenderMode/logs/session_*.log` 最后 50 行（plugin 端的 trace）
4. 分类：
   - 是 ae-mcp Python 层 bug → 改代码、添加单测、commit、重跑
   - 是 backend-aebm 层 bug → 改归档目录里的代码、commit（在那个目录的 git 里，如果还没 init 就 init），重新 editable install、重跑
   - 是 AEBMethod 插件 bug → 不在本仓库职责，记到 issue 列表，对应 verb 跳过 / 标 xfail
   - 是测试本身写错了 → 改 test、重跑

## Phase 8 — tag 操作

完成 Phase 6 全绿后：
```bash
git tag -d v0.1.0
git tag -a v0.1.0-rc1 <旧 hash> -m "internal unit tests green; live verification pending"
git tag -a v0.1.0 -m "v0.1.0 — live verified end-to-end on real AE"
```

如果过程中改了 core 代码并 commit，新 v0.1.0 自然指向最新 commit。

---

## 不在本计划内（明确）

- **修 AEBMethod 插件 unhandled exception 的根因**（今天的崩溃）：那是 C++ 层 bug，独立 task
- **解决 AE 后台节流**：是 AEGP idle hook 限制，需要 plugin 层重写（spec 3 之外）
- **加新 verb**：本计划只跑现有 22 verb
- **CI 集成 live tests**：hosted runner 跑不了 GUI Adobe app，永远本地

---

**计划结束**。下面就开始 Phase 0。
