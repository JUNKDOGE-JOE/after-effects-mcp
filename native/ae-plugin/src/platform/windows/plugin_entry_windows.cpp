// Windows module entry for the AeMcpNative AEGP plug-in. This file owns only
// the DLL loader callbacks; the AEGP entry export AeMcpNativeMain lives in
// the shared src/aegp/plugin_entry.cpp dispatch and is marked with
// AE_MCP_PLUGIN_EXPORT (__declspec(dllexport) on this platform), so both
// platforms resolve the PiPL entry point to the same dispatch table.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID reserved) {
  switch (reason) {
    case DLL_PROCESS_ATTACH:
      (void)DisableThreadLibraryCalls(module);
      break;
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
    case DLL_PROCESS_DETACH:
      break;
    default:
      break;
  }
  (void)reserved;
  return TRUE;
}
