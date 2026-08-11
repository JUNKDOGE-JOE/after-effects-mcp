#pragma once

// Single platform seam for the shared AEGP entry translation unit. The
// selector below is the ONLY place the shared dispatch learns which platform
// adapter it binds to; shared logic never branches on _WIN32/__APPLE__.
//
// Each platform header provides the same surface in namespace aemcp::native:
//   - HostIdentity read_host_identity()
//   - class DiagnosticLog (append-only best-effort JSONL diagnostics)
//   - template <std::size_t Size> std::optional<std::string>
//     effect_text_utf8(const std::array<A_char, Size>&, bool)
//   - std::optional<std::string> host_utf16_to_utf8(const void*, std::size_t)
//   - using PlatformEndpointRegistry / PlatformIpcServer /
//     PlatformIpcServerConfig aliases and EndpointRegistryConfig
//   - create_host_peer_identity_backend(), current_host_process(),
//     host_native_cpu_type()
//   - secure_uuid_v4() (per-platform secure random source)
//
// AE_MCP_PLUGIN_EXPORT marks the single AEGP entry export so the shared
// dispatch keeps one portable extern "C" declaration.

#include <cstdint>
#include <string>
#include <string_view>

namespace aemcp::native {

struct HostIdentity {
  std::string version;
  std::string build;
  std::uint64_t build_number{0};
};

[[nodiscard]] inline std::uint64_t positive_integer(std::string_view value) {
  std::uint64_t parsed = 0;
  if (value.empty()) return 0;
  for (const char character : value) {
    if (character < '0' || character > '9') return 0;
    const std::uint64_t digit = static_cast<std::uint64_t>(character - '0');
    if (parsed > (UINT64_MAX - digit) / 10) return 0;
    parsed = parsed * 10 + digit;
  }
  return parsed > 0 ? parsed : 0;
}

}  // namespace aemcp::native

#if defined(_WIN32)
#define AE_MCP_PLUGIN_EXPORT __declspec(dllexport)
#include "aemcp_native/host_platform_windows.hpp"
#elif defined(__APPLE__)
#define AE_MCP_PLUGIN_EXPORT __attribute__((visibility("default")))
#include "aemcp_native/host_platform_macos.hpp"
#else
#error "aemcp host platform seam supports only Windows (_WIN32) and macOS (__APPLE__)"
#endif
