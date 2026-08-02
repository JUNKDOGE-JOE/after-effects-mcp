#pragma once

// macOS implementation of the host platform seam. The shared dispatcher
// includes this file only on macOS so CoreFoundation, endpoint, IPC, peer,
// and randomness details stay outside the platform-neutral call surface.

#include "aemcp_native/endpoint_registry_macos.hpp"
#include "aemcp_native/host_platform.hpp"
#include "aemcp_native/mac_ipc_server.hpp"
#include "aemcp_native/peer_identity_macos.hpp"
#include "aemcp_native/secure_random_macos.hpp"

#include <CoreFoundation/CoreFoundation.h>

#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include "AEConfig.h"
#include "AE_GeneralPlug.h"

namespace aemcp::native {

using PlatformEndpointRegistry = MacEndpointRegistry;
using PlatformIpcServer = MacIpcServer;
using PlatformIpcServerConfig = MacIpcServerConfig;

[[nodiscard]] inline std::unique_ptr<PeerIdentityBackend>
create_host_peer_identity_backend() {
  return create_macos_peer_identity_backend();
}

[[nodiscard]] inline ExpectedProcess current_host_process(
    PeerIdentityBackend& backend) {
  return current_macos_process(backend);
}

[[nodiscard]] inline std::int32_t host_native_cpu_type() noexcept {
  return macos_native_cpu_type();
}

namespace detail {

[[nodiscard]] inline std::string cf_string(CFTypeRef value) {
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID())
    return {};
  const auto string = static_cast<CFStringRef>(value);
  const CFIndex length = CFStringGetLength(string);
  const CFIndex maximum =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  if (maximum <= 1 || maximum > 4096)
    return {};
  std::string output(static_cast<std::size_t>(maximum), '\0');
  if (!CFStringGetCString(string, output.data(), maximum,
                          kCFStringEncodingUTF8))
    return {};
  output.resize(std::char_traits<char>::length(output.c_str()));
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
  const CFIndex length =
      static_cast<CFIndex>(std::distance(buffer.begin(), terminator));
  if (length == 0)
    return std::string{};
  const auto convert =
      [&](CFStringEncoding encoding) -> std::optional<std::string> {
    CFStringRef value = CFStringCreateWithBytes(
        kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(buffer.data()),
        length, encoding, false);
    if (value == nullptr)
      return std::nullopt;
    std::string output = detail::cf_string(value);
    CFRelease(value);
    if (output.empty())
      return std::nullopt;
    return output;
  };
  if (auto utf8 = convert(kCFStringEncodingUTF8); utf8.has_value()) {
    return utf8;
  }
  if (!allow_legacy_encoding)
    return std::nullopt;
  if (auto system = convert(CFStringGetSystemEncoding()); system.has_value()) {
    return system;
  }
  return convert(kCFStringEncodingMacRoman);
}

[[nodiscard]] inline HostIdentity read_host_identity() {
  const CFBundleRef bundle = CFBundleGetMainBundle();
  if (bundle == nullptr)
    return {};
  HostIdentity identity;
  identity.version = detail::cf_string(CFBundleGetValueForInfoDictionaryKey(
      bundle, CFSTR("CFBundleShortVersionString")));
  identity.build = detail::cf_string(CFBundleGetValueForInfoDictionaryKey(
      bundle, CFSTR("Adobe Product Build")));
  identity.build_number = positive_integer(identity.build);
  return identity;
}

// Converts a validated UTF-16 unit sequence to UTF-8. Callers validate
// surrogate structure and bound the unit count before calling.
[[nodiscard]] inline std::optional<std::string> host_utf16_to_utf8(
    const void *characters, std::size_t length) {
  CFStringRef value = CFStringCreateWithCharacters(
      kCFAllocatorDefault, reinterpret_cast<const UniChar *>(characters),
      static_cast<CFIndex>(length));
  if (value == nullptr)
    return std::nullopt;
  const CFIndex maximum =
      CFStringGetMaximumSizeForEncoding(static_cast<CFIndex>(length),
                                        kCFStringEncodingUTF8) +
      1;
  if (maximum <= 0 || maximum > 8193) {
    CFRelease(value);
    return std::nullopt;
  }
  std::string output(static_cast<std::size_t>(maximum), '\0');
  if (!CFStringGetCString(value, output.data(), maximum,
                          kCFStringEncodingUTF8)) {
    CFRelease(value);
    return std::nullopt;
  }
  CFRelease(value);
  const std::size_t utf8_bytes =
      std::char_traits<char>::length(output.c_str());
  if (utf8_bytes > 4096)
    return std::nullopt;
  output.resize(utf8_bytes);
  return output;
}

class DiagnosticLog final {
public:
  DiagnosticLog() {
    const char *home = std::getenv("HOME");
    if (home == nullptr || *home == '\0')
      return;
    path_ = std::filesystem::path(home) / "Library" / "Logs" /
            "AfterEffectsMCP" / "native-plugin-v1.jsonl";
  }

  void append(std::string_view object) noexcept {
    try {
      if (path_.empty() || object.empty() ||
          object.size() > kMaximumRecordBytes || object.front() != '{' ||
          object.back() != '}')
        return;
      std::lock_guard lock(mutex_);
      if (!prepare_private_directory())
        return;
      const int descriptor =
          ::open(path_.c_str(),
                 O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (descriptor < 0)
        return;
      struct stat status{};
      if (::flock(descriptor, LOCK_EX | LOCK_NB) != 0 ||
          ::fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) ||
          status.st_uid != ::getuid() || status.st_nlink != 1 ||
          ::fchmod(descriptor, 0600) != 0) {
        ::close(descriptor);
        return;
      }
      if (status.st_size < 0 ||
          static_cast<std::uint64_t>(status.st_size) + object.size() + 1 >
              kMaximumLogBytes) {
        if (::ftruncate(descriptor, 0) != 0) {
          ::close(descriptor);
          return;
        }
      }
      const std::string record = std::string(object) + '\n';
      std::size_t written = 0;
      while (written < record.size()) {
        const ssize_t count = ::write(descriptor, record.data() + written,
                                      record.size() - written);
        if (count > 0) {
          written += static_cast<std::size_t>(count);
        } else if (count < 0 && errno == EINTR) {
          continue;
        } else {
          break;
        }
      }
      ::close(descriptor);
    } catch (...) {
      // Diagnostics must never affect After Effects lifecycle callbacks.
    }
  }

private:
  static constexpr std::size_t kMaximumRecordBytes = 8192;
  static constexpr std::uint64_t kMaximumLogBytes = 1024 * 1024;

  [[nodiscard]] bool prepare_private_directory() const noexcept {
    const std::filesystem::path directory = path_.parent_path();
    if (::mkdir(directory.c_str(), 0700) != 0 && errno != EEXIST)
      return false;
    struct stat status{};
    if (::lstat(directory.c_str(), &status) != 0 || !S_ISDIR(status.st_mode) ||
        status.st_uid != ::getuid()) {
      return false;
    }
    return ::chmod(directory.c_str(), 0700) == 0;
  }

  std::filesystem::path path_;
  std::mutex mutex_;
};

}  // namespace aemcp::native
