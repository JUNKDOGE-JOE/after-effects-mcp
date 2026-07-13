#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <delayimp.h>
#include <string.h>

namespace {

FARPROC WINAPI ResolveNodeHost(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe") != 0) {
    return nullptr;
  }
  HMODULE host = GetModuleHandleW(L"node.dll");
  if (host == nullptr) host = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(host);
}

}  // namespace

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = ResolveNodeHost;
