import { execFileSync } from 'node:child_process';
const msvcRoot = String.raw`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207`;
const sdkRoot = String.raw`C:\Program Files (x86)\Windows Kits\10`;
const sdkVer = '10.0.26100.0';
const bin = msvcRoot + String.raw`\bin\Hostx64\x64`;
const env = {
  ...process.env,
  PATH: [bin, sdkRoot + '\\bin\\' + sdkVer + '\\x64', process.env.PATH].join(';'),
  INCLUDE: [msvcRoot + '\\include', sdkRoot + '\\Include\\' + sdkVer + '\\ucrt', sdkRoot + '\\Include\\' + sdkVer + '\\um', sdkRoot + '\\Include\\' + sdkVer + '\\shared', sdkRoot + '\\Include\\' + sdkVer + '\\winrt'].join(';'),
  LIB: [msvcRoot + '\\lib\\x64', sdkRoot + '\\Lib\\' + sdkVer + '\\ucrt\\x64', sdkRoot + '\\Lib\\' + sdkVer + '\\um\\x64'].join(';'),
};
const out = process.env.TEMP + '\\aemcp-codec-test.exe';
try {
  execFileSync(bin + '\\cl.exe', [
    '/nologo','/std:c++20','/EHsc','/W4','/WX','/utf-8','/Od','/MD','/D_CRT_SECURE_NO_WARNINGS',
    '/I','native/ae-plugin/include',
    'native/ae-plugin/src/core/native_program.cpp',
    'native/ae-plugin/src/core/rpc_codec.cpp',
    'native/ae-plugin/tests/rpc_codec_test.cpp',
    '/Fe:' + out,
  ], { env, stdio: 'inherit' });
  execFileSync(out, [], { stdio: 'inherit' });
} catch (e) { process.exit(1); }
