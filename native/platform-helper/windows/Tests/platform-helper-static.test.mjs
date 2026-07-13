import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(windowsRoot, 'src', 'main.cpp'), 'utf8');
const addon = fs.readFileSync(
  path.join(windowsRoot, '..', 'client-addon', 'src', 'addon_windows.cpp'),
  'utf8',
);
const delayLoadHook = fs.readFileSync(
  path.join(windowsRoot, '..', 'client-addon', 'src', 'win_delay_load_hook.cpp'),
  'utf8',
);
const addonCmake = fs.readFileSync(
  path.join(windowsRoot, '..', 'client-addon', 'CMakeLists.txt'),
  'utf8',
);
const repoRoot = path.resolve(windowsRoot, '..', '..', '..');
const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'install-plugin-dev.ps1'), 'utf8');
const starter = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'start-platform-helper-dev.ps1'),
  'utf8',
);
const hostTransport = fs.readFileSync(
  path.join(repoRoot, 'plugin', 'host', 'platform-helper-transport.js'),
  'utf8',
);

test('named pipe is local-user-only and remote clients are rejected', () => {
  assert.match(service, /ConvertStringSecurityDescriptorToSecurityDescriptorW/);
  assert.match(service, /D:P\(A;;GA;;;/);
  assert.match(service, /PIPE_REJECT_REMOTE_CLIENTS/);
  assert.match(service, /GetNamedPipeClientProcessId/);
  assert.match(service, /FILE_FLAG_FIRST_PIPE_INSTANCE/);
});

test('addon authenticates the pipe server before any request bytes are written', () => {
  assert.match(addon, /GetNamedPipeServerProcessId/);
  assert.match(addon, /OpenProcess\([\s\S]*PROCESS_QUERY_LIMITED_INFORMATION[\s\S]*SYNCHRONIZE/);
  assert.match(addon, /GetProcessTimes/);
  assert.match(addon, /QueryFullProcessImageNameW/);
  assert.match(addon, /GetFinalPathNameByHandleW/);
  assert.match(addon, /BCryptFinishHash/);
  assert.match(addonCmake, /\bbcrypt\b/i);
  const constructor = addon.slice(
    addon.indexOf('explicit WindowsTransport'),
    addon.indexOf('~WindowsTransport'),
  );
  assert.ok(constructor.indexOf('AuthenticateServer(handle_, options)') >= 0);
  assert.doesNotMatch(constructor, /WriteExact|WriteFile/);
});

test('caller authorization binds user, architecture, Adobe signatures, ancestry, and generation', () => {
  assert.match(service, /IsWow64Process2/);
  assert.match(service, /WinVerifyTrust/);
  assert.match(service, /SignerOrganization\(process\.imagePath\) != L"Adobe Inc\."/);
  assert.match(service, /RequireAdobeProcess\(process, L"CEPHtmlEngine\.exe"\)/);
  assert.match(service, /RequireAdobeProcess\(process, L"AfterFX\.exe"\)/);
  assert.match(service, /major != 25 && major != 26/);
  assert.match(service, /InspectProcess\(expected\.processId\) == expected/);
});

test('authorization completes before dispatch can access Credential Manager', () => {
  const handler = service.slice(
    service.indexOf('void HandleClient'),
    service.indexOf('PSECURITY_DESCRIPTOR PipeSecurityDescriptor'),
  );
  assert.ok(handler.indexOf('RegisterAfterEffectsOwner(AuthorizeCaller(pipe))')
    < handler.indexOf('Dispatch(request)'));
  assert.doesNotMatch(
    handler.slice(0, handler.indexOf('RegisterAfterEffectsOwner(AuthorizeCaller(pipe))')),
    /Cred(?:Read|Write|Delete)W/,
  );
});

test('Helper binds startup and authenticated clients to verified AE owners', () => {
  assert.match(service, /AuthorizeAdobeAncestry\(launcherProcessId\)/);
  assert.match(service, /RegisterAfterEffectsOwner\(AuthorizeAdobeAncestry\(launcherProcessId\)\)/);
  assert.match(service, /RegisterAfterEffectsOwner\(AuthorizeCaller\(pipe\)\)/);
  assert.match(service, /OpenProcess\(SYNCHRONIZE, FALSE, owner\.processId\)/);
  assert.match(service, /WaitForSingleObject\(process\.get\(\), INFINITE\)/);
  assert.match(service, /ownerProcessIds\.empty\(\)[\s\S]*ExitProcess\(0\)/);
});

test('secret backend is non-enumerating, revisioned, and verifies mutations', () => {
  assert.match(service, /CredReadW/);
  assert.match(service, /CredWriteW/);
  assert.match(service, /CredDeleteW/);
  assert.doesNotMatch(service, /CredEnumerateW/);
  assert.match(service, /SECRET_CONFLICT/);
  assert.match(service, /credential write verification failed/);
  assert.match(service, /credential delete verification failed/);
  assert.doesNotMatch(service, /Reg(?:Get|Set)Value|WriteFile\([^\n]*value/);
});

test('addon uses bounded overlapped named-pipe IPC without launching a helper', () => {
  assert.match(addon, /FILE_FLAG_OVERLAPPED/);
  assert.match(addon, /CancelIoEx/);
  assert.match(addon, /kRequestTimeoutMs\s*=\s*10000/);
  assert.match(addon, /json_utf8\.size\(\) > kMaxMessageBytes/);
  assert.doesNotMatch(addon, /CreateProcess|ShellExecute|system\s*\(/);
});

test('Windows addon resolves Node imports in both CEP and node.exe hosts', () => {
  assert.match(addonCmake, /\/DELAYLOAD:node\.exe/);
  assert.match(addonCmake, /\bdelayimp\b/);
  assert.match(delayLoadHook, /GetModuleHandleW\(L"node\.dll"\)/);
  assert.match(delayLoadHook, /GetModuleHandleW\(nullptr\)/);
  assert.match(delayLoadHook, /__pfnDliNotifyHook2\s*=\s*ResolveNodeHost/);
});

test('panel owns Helper startup while development deployment only verifies payloads', () => {
  assert.match(starter, /Get-FileHash[^\n]+SHA256/);
  assert.match(starter, /helperId -cne 'com\.junkdoge\.ae-mcp\.platform-helper'/);
  assert.doesNotMatch(starter, /Start-Process|Start-Job|&\s*\$helperPath/);
  assert.match(installer, /Stop-Process -Id \$process\.Id -Force/);
  assert.doesNotMatch(installer, /start-platform-helper-dev\.ps1/);
  assert.match(installer, /panel starts Platform Helper automatically/);
  assert.match(hostTransport, /verifyWindowsPayload/);
  assert.match(hostTransport, /require\('child_process'\)\.spawn/);
  assert.match(hostTransport, /windowsHide:\s*true/);
  assert.match(hostTransport, /detached:\s*true/);
});
