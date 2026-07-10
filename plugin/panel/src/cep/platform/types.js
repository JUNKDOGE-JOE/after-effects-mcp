/**
 * @typedef {'macos-arm64'|'windows-x64'} PlatformId
 * @typedef {'ae-mcp'|'node'|'claude'|'codex'|'zcode'|'uv'|'npm'|'opencode'|'brew'|'winget'|'powershell'} ExecutableId
 * @typedef {'override'|'runtime'|'path'|'login-shell'|'standard'} ExecutableSource
 * @typedef {{ok:true,id:ExecutableId,path:string,argsPrefix:string[],source:ExecutableSource,version:string|null,arch:'arm64'|'x64'|null}} SuccessfulExecutableResolution
 * @typedef {{ok:false,id:ExecutableId,code:'NOT_FOUND'|'VERSION_TOO_OLD'|'ARCH_MISMATCH'|'PROBE_FAILED',attempts:Array<{path:string,source:ExecutableSource,detail:string}>}} FailedExecutableResolution
 * @typedef {SuccessfulExecutableResolution|FailedExecutableResolution} ExecutableResolution
 *
 * This module intentionally contains declarations only.  Keeping the public
 * contract in one dependency-free file lets CEP business modules consume the
 * adapter without importing Node's platform-specific modules.
 */

export const PLATFORM_TYPES_VERSION = 1;
