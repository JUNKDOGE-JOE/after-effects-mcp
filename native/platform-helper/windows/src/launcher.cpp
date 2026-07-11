#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {

std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  unsigned backslashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(character);
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

bool SafeRelativeRuntime(const std::wstring& value) {
  if (value.empty() || std::filesystem::path(value).is_absolute()) return false;
  for (const auto& part : std::filesystem::path(value)) {
    if (part == L".." || part == L".") return false;
  }
  return true;
}

int Run() {
  wchar_t profile[32768]{};
  const DWORD length = GetEnvironmentVariableW(L"USERPROFILE", profile, 32768);
  if (length == 0 || length >= 32768) return 78;

  const std::filesystem::path root = std::filesystem::path(profile) / L".ae-mcp" / L"runtime";
  std::wifstream current(root / L"current");
  std::wstring relative;
  std::getline(current, relative);
  if (!current || !SafeRelativeRuntime(relative)) return 78;

  const std::filesystem::path python = root / relative / L"python" / L"python.exe";
  if (!std::filesystem::is_regular_file(python)) return 78;

  std::wstring command = Quote(python.wstring()) + L" -I -m ae_mcp";
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments == nullptr) return 78;
  for (int index = 1; index < argumentCount; ++index) {
    command.push_back(L' ');
    command.append(Quote(arguments[index]));
  }
  LocalFree(arguments);

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  if (!CreateProcessW(
          python.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
          CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup, &process)) {
    return 78;
  }
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 78;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hProcess);
  return static_cast<int>(exitCode);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  try {
    return Run();
  } catch (...) {
    return 78;
  }
}
