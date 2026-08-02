#pragma once

// Windows half of the host platform seam (included only via
// host_platform.hpp). Provides the same surface as host_platform_macos.hpp:
// text conversion, host identity, append-only diagnostics, secure random,
// peer identity probes, and the registry/IPC server aliases.

#include "aemcp_native/host_platform.hpp"
#include "aemcp_native/peer_identity_windows.hpp"
#include "aemcp_native/secure_random_windows.hpp"
#include "aemcp_native/win_ipc_server.hpp"
#include "endpoint_registry_windows.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iterator>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "AEConfig.h"
#include "AE_GeneralPlug.h"

namespace aemcp::native {

using PlatformEndpointRegistry = WindowsEndpointRegistry;
using PlatformIpcServer = WindowsIpcServer;
using PlatformIpcServerConfig = WindowsIpcServerConfig;

[[nodiscard]] inline std::unique_ptr<PeerIdentityBackend>
create_host_peer_identity_backend() {
  return create_windows_peer_identity_backend();
}

[[nodiscard]] inline ExpectedProcess current_host_process(
    PeerIdentityBackend& backend) {
  return current_windows_process(backend);
}

[[nodiscard]] inline std::int32_t host_native_cpu_type() noexcept {
  return windows_native_cpu_type();
}

namespace detail {

// Validates strict UTF-8 (rejecting overlong forms, surrogates, and values
// above U+10FFFF) and converts to UTF-16 for lossless round-tripping.
[[nodiscard]] inline bool utf8_valid(std::string_view bytes) noexcept {
  std::size_t index = 0;
  while (index < bytes.size()) {
    const auto lead = static_cast<std::uint8_t>(bytes[index]);
    std::size_t continuation = 0;
    std::uint32_t scalar = 0;
    std::uint32_t minimum = 0;
    if (lead <= 0x7fU) {
      ++index;
      continue;
    }
    if (lead >= 0xc2U && lead <= 0xdfU) {
      continuation = 1;
      scalar = lead & 0x1fU;
      minimum = 0x80U;
    } else if (lead >= 0xe0U && lead <= 0xefU) {
      continuation = 2;
      scalar = lead & 0x0fU;
      minimum = 0x800U;
    } else if (lead >= 0xf0U && lead <= 0xf4U) {
      continuation = 3;
      scalar = lead & 0x07U;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (index + continuation >= bytes.size()) return false;
    for (std::size_t offset = 1; offset <= continuation; ++offset) {
      const auto trail = static_cast<std::uint8_t>(bytes[index + offset]);
      if ((trail & 0xc0U) != 0x80U) return false;
      scalar = (scalar << 6U) | (trail & 0x3fU);
    }
    if (scalar < minimum || (scalar >= 0xd800U && scalar <= 0xdfffU)) {
      return false;
    }
    index += continuation + 1;
  }
  return true;
}

[[nodiscard]] inline std::string utf16_units_to_utf8(
    const wchar_t* units, std::size_t length) {
  if (length == 0) return {};
  const int bytes = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, units, static_cast<int>(length),
      nullptr, 0, nullptr, nullptr);
  if (bytes <= 0 || bytes > 8192) return {};
  std::string output(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(
          CP_UTF8, WC_ERR_INVALID_CHARS, units, static_cast<int>(length),
          output.data(), bytes, nullptr, nullptr) != bytes) {
    return {};
  }
  return output;
}

[[nodiscard]] inline std::optional<std::string> ansi_to_utf8(
    std::string_view bytes) {
  if (bytes.empty()) return std::string{};
  const int units = MultiByteToWideChar(
      CP_ACP, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()),
      nullptr, 0);
  if (units <= 0 || units > 4096) return std::nullopt;
  std::wstring wide(static_cast<std::size_t>(units), L'\0');
  if (MultiByteToWideChar(
          CP_ACP, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()),
          wide.data(), units) != units) {
    return std::nullopt;
  }
  std::string output = utf16_units_to_utf8(wide.data(), wide.size());
  if (output.empty()) return std::nullopt;
  return output;
}

}  // namespace detail

template <std::size_t Size>
[[nodiscard]] std::optional<std::string>
effect_text_utf8(const std::array<A_char, Size> &buffer,
                 bool allow_legacy_encoding) {
  const auto terminator = std::find(buffer.begin(), buffer.end(), '\0');
  if (terminator == buffer.end())
    return std::nullopt;
  const std::size_t length =
      static_cast<std::size_t>(std::distance(buffer.begin(), terminator));
  if (length == 0)
    return std::string{};
  const std::string_view bytes(buffer.data(), length);
  if (detail::utf8_valid(bytes)) {
    return std::string(bytes);
  }
  if (!allow_legacy_encoding)
    return std::nullopt;
  // Windows legacy fallback is the host ANSI code page; the macOS MacRoman
  // fallback has no Windows counterpart.
  return detail::ansi_to_utf8(bytes);
}

[[nodiscard]] inline HostIdentity read_host_identity() {
  HostIdentity identity;
  std::array<wchar_t, 32768> module_path{};
  const DWORD path_length = GetModuleFileNameW(
      nullptr, module_path.data(), static_cast<DWORD>(module_path.size()));
  if (path_length == 0 || path_length >= module_path.size()) return identity;
  DWORD version_handle = 0;
  const DWORD info_size = GetFileVersionInfoSizeW(module_path.data(), &version_handle);
  if (info_size == 0 || info_size > 16 * 1024 * 1024) return identity;
  std::vector<std::uint8_t> info(info_size);
  if (GetFileVersionInfoW(
          module_path.data(), version_handle, info_size, info.data()) == 0) {
    return identity;
  }
  const auto query_string = [&](const wchar_t* name) -> std::string {
    wchar_t* value = nullptr;
    UINT value_length = 0;
    const std::wstring block =
        std::wstring(L"\\StringFileInfo\\040904E4\\") + name;
    if (VerQueryValueW(
            info.data(), block.c_str(), reinterpret_cast<void**>(&value),
            &value_length) == 0
        || value == nullptr || value_length == 0) {
      return {};
    }
    return detail::utf16_units_to_utf8(value, value_length - 1);
  };
  identity.version = query_string(L"ProductVersion");
  identity.build = query_string(L"PrivateBuild");
  // Windows AfterFX carries the build counter in PrivateBuild, e.g.
  // "25.6.6x4" -> 4 (the macOS "Adobe Product Build" integer counterpart).
  identity.build_number = [&identity]() -> std::uint64_t {
    const std::size_t cross = identity.build.find_last_of("xX");
    if (cross != std::string::npos && cross + 1 < identity.build.size()) {
      const std::uint64_t parsed = positive_integer(
          std::string_view(identity.build).substr(cross + 1));
      if (parsed != 0) return parsed;
    }
    return positive_integer(identity.build);
  }();
  return identity;
}

// Converts a validated UTF-16 unit sequence to UTF-8. Callers validate
// surrogate structure and bound the unit count before calling.
[[nodiscard]] inline std::optional<std::string> host_utf16_to_utf8(
    const void *characters, std::size_t length) {
  std::string output = detail::utf16_units_to_utf8(
      static_cast<const wchar_t*>(characters), length);
  if (output.empty() && length != 0) return std::nullopt;
  if (output.size() > 4096) return std::nullopt;
  return output;
}

class DiagnosticLog final {
public:
  DiagnosticLog() {
    const char *base = std::getenv("LOCALAPPDATA");
    if (base == nullptr || *base == '\0')
      return;
    path_ = std::filesystem::path(base) / "AfterEffectsMCP" / "Logs" /
            "native-plugin-v1.jsonl";
  }

  void append(std::string_view object) noexcept {
    try {
      if (path_.empty() || object.empty() ||
          object.size() > kMaximumRecordBytes || object.front() != '{' ||
          object.back() != '}')
        return;
      std::lock_guard lock(mutex_);
      std::error_code error;
      std::filesystem::create_directories(path_.parent_path(), error);
      if (error)
        return;
      // Same-user boundary: the file lives in the per-user profile and is
      // opened without sharing, mirroring the macOS exclusive flock.
      const HANDLE file = CreateFileW(
          path_.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
          OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (file == INVALID_HANDLE_VALUE)
        return;
      OVERLAPPED region{};
      region.Offset = 0;
      region.OffsetHigh = 0;
      if (LockFile(file, 0, 0, 0xFFFFFFFFU, 0xFFFFFFFFU) == 0) {
        CloseHandle(file);
        return;
      }
      LARGE_INTEGER size{};
      if (GetFileSizeEx(file, &size) == 0 || size.QuadPart < 0) {
        (void)UnlockFile(file, 0, 0, 0xFFFFFFFFU, 0xFFFFFFFFU);
        CloseHandle(file);
        return;
      }
      if (static_cast<std::uint64_t>(size.QuadPart) + object.size() + 1 >
          kMaximumLogBytes) {
        if (SetFilePointer(file, 0, nullptr, FILE_BEGIN) == INVALID_SET_FILE_POINTER
            || SetEndOfFile(file) == 0) {
          (void)UnlockFile(file, 0, 0, 0xFFFFFFFFU, 0xFFFFFFFFU);
          CloseHandle(file);
          return;
        }
      }
      (void)SetFilePointer(file, 0, nullptr, FILE_END);
      const std::string record = std::string(object) + '\n';
      std::size_t written = 0;
      while (written < record.size()) {
        DWORD count = 0;
        if (WriteFile(
                file, record.data() + written,
                static_cast<DWORD>(record.size() - written), &count,
                nullptr) == 0) {
          break;
        }
        if (count == 0) break;
        written += count;
      }
      (void)UnlockFile(file, 0, 0, 0xFFFFFFFFU, 0xFFFFFFFFU);
      CloseHandle(file);
    } catch (...) {
      // Diagnostics must never affect After Effects lifecycle callbacks.
    }
  }

private:
  static constexpr std::size_t kMaximumRecordBytes = 8192;
  static constexpr std::uint64_t kMaximumLogBytes = 1024 * 1024;

  std::filesystem::path path_;
  std::mutex mutex_;
};

}  // namespace aemcp::native
