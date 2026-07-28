# macOS RuntimeManager / macOS 运行时管理器

The v0.9.3 macOS panel uses the runtime already contained in the installed extension. It does not install core with Homebrew, `uv`, pip, npm, a public package registry, or a command discovered through PATH.

v0.9.3 macOS 面板只使用已安装扩展中自带的 runtime，不会通过 Homebrew、`uv`、pip、npm、公共包仓库或 PATH 中发现的命令安装 core。

RuntimeManager protects normal installation correctness; it is not a crash-continuity or hostile
local-process security boundary. Atomic pointer changes, bounded rollback, and repair of an observed
invalid current generation remain supported. Power-loss continuation, stale-process forensics,
cross-restart task resumption, and adversarial lock/ABA resistance are explicit non-goals.

RuntimeManager 保护普通安装流程的正确性，不是断电续跑或抵御本机恶意进程的安全边界。
原子指针切换、有界回滚，以及对已观察到的无效 current generation 进行修复仍属于支持范围；
断电续跑、陈旧进程取证、跨重启任务恢复和对抗性 lock/ABA 防护明确不做。

## Layout / 目录

```text
~/.ae-mcp/
  bin/ae-mcp                         stable absolute launcher / 稳定绝对入口
  runtime/current                    active relative runtime pointer / 当前相对指针
  runtime/previous                   verified rollback pointer / 已校验回滚指针
  runtime/<version>-<source-sha>/
    install-record.json
    ae-mcp-launcher                    launcher bound to this generation / 与该版本绑定的入口
    macos-arm64/                     verified packaged runtime / 已校验包内运行时
```

`current` and `previous` are ordinary text files. RuntimeManager writes each pointer through a sibling temporary file and an atomic rename. A process-safe exclusive lock serializes panel instances while they verify, install, activate, repair, roll back, or uninstall a runtime. Each generation retains its verified launcher bytes so rollback and fallback select a matching launcher. The stable launcher reads only `current` and invokes the selected packaged Python with `-I -m ae_mcp`.

`current` 与 `previous` 都是普通文本文件。RuntimeManager 通过同目录临时文件和原子 rename 写入每个指针；进程级互斥锁会串行化多个 Panel 实例的校验、安装、激活、修复、回滚和卸载操作。每个 generation 会保留自身经过校验的 launcher 字节，确保回滚和 fallback 使用匹配入口。稳定 launcher 只读取 `current`，再以 `-I -m ae_mcp` 启动所选包内 Python。

## State transitions / 状态转换

- **Install:** verify `bundle-manifest.json`, the runtime manifest, every runtime file, and the stable launcher; copy to a fresh version directory; then publish `current`.
- **Upgrade / downgrade:** keep a healthy active runtime in `previous`, install the packaged identity separately, then atomically switch `current`.
- **Corrupt current:** if `previous` is healthy, activate it once, remove the consumed `previous` pointer, and emit `RUNTIME_CURRENT_INVALID_FALLBACK`. A later repair may reinstall the packaged identity in a fresh generation; there is no fallback retry loop.
- **Repair:** create and verify a new packaged-runtime generation before activation. Never repair by downloading dependencies.
- **Rollback:** verify `previous`, switch `current`, and retain the old healthy current as the next rollback target.
- **Uninstall:** remove active pointers and the stable launcher before deleting directories that carry RuntimeManager install records. Provider configuration, credentials, Tool Library data, and unknown directories are retained.

- **安装：** 校验 `bundle-manifest.json`、runtime manifest、全部 runtime 文件和稳定 launcher；复制到全新的版本目录后才发布 `current`。
- **升级 / 降级：** 把健康的当前版本保存到 `previous`，单独安装包内版本，再原子切换 `current`。
- **当前版本损坏：** 若 `previous` 健康，则只回退一次、消费并移除该 `previous` 指针，同时返回 `RUNTIME_CURRENT_INVALID_FALLBACK`。后续修复可将包内版本安装为新 generation，不会形成无限回退重试。
- **修复：** 先建立并校验新的包内 runtime generation，再激活；绝不联网下载依赖。
- **回滚：** 先校验 `previous`，再切换 `current`，并把原来的健康 current 留作下一次回滚目标。
- **卸载：** 先移除 active 指针与稳定 launcher，再删除带 RuntimeManager 安装记录的目录；Provider、凭据、Tool Library 数据和未知目录会保留。

## Diagnostics / 诊断

The Connection diagnostics report the selected version, full source commit, absolute launcher path, current/previous health, and structured failure codes. `RUNTIME_HASH_MISMATCH`, `RUNTIME_INCOMPLETE`, and `RUNTIME_POINTER_INVALID` require offline repair or rollback. `RUNTIME_MANAGER_LOCKED` means another panel is changing runtime state; retry after that bounded operation finishes.

连接诊断会报告所选版本、完整 source commit、绝对 launcher 路径、current/previous 健康状态和结构化错误码。`RUNTIME_HASH_MISMATCH`、`RUNTIME_INCOMPLETE`、`RUNTIME_POINTER_INVALID` 需要离线修复或回滚；`RUNTIME_MANAGER_LOCKED` 表示另一 Panel 正在修改 runtime 状态，应在该有界操作结束后重试。

### Development checkout override / 开发 checkout 覆盖

For a development-installed CEP extension only (the existing `.debug` marker is
present and `bundle-manifest.json` is absent), setting `AE_MCP_DEV_RUNTIME` to
an absolute source-checkout path starts that checkout's `.venv/bin/python3`
with `-B -I -c` and a closed bootstrap that prepends only the checkout's
`packages/core` before running `ae_mcp` as `__main__`, using the canonical
checkout as the child working directory. This explicit path is required
because isolated Python does not use the working directory or editable-install
path files for module discovery. This bypasses RuntimeManager installation and takes no
RuntimeManager lock; it never reads, writes, or repairs `current` or `previous`.
The checkout must contain `pyproject.toml`, `packages/core/ae_mcp/__main__.py`,
and an executable `.venv/bin/python3` or selection fails closed with
`RUNTIME_DEVELOPMENT_RUNTIME_INVALID`.

Daily doctor, launch, component sync, and HDEV use only this development
boundary and never package a portable runtime or align the checkout to a
RuntimeManager generation manifest. HDEV evidence is always non-candidate.
Packaged release T5/T6 retain exact source/artifact identity, complete payload
hashing, RuntimeManager manifest alignment, and the existing strict release
gates; the development override does not weaken that boundary.

Connection diagnostics label this state `DEVELOPMENT CHECKOUT`, report both the
checkout and resolved interpreter paths, and include
`RUNTIME_DEVELOPMENT_RUNTIME_SELECTED`. A packaged release extension rejects
the variable with `RUNTIME_DEVELOPMENT_RUNTIME_RELEASE_REFUSED`; it never
falls back to the production runtime manager.

Initial support is Apple Silicon on macOS 14 or newer. Intel/Rosetta, signing/notarization, the formal installer, and Windows RuntimeManager changes are separate work.

首期支持范围是 macOS 14 或更高版本的 Apple Silicon。Intel/Rosetta、签名与公证、正式安装器以及 Windows RuntimeManager 改动属于独立工作。
