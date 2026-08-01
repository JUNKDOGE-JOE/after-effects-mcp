#pragma once

// Windows named-pipe endpoint registry, mirroring the macOS Unix-socket
// registry semantics: one pipe per AE host instance under the shared
// aemcp-n1- naming scheme, a bounded untrusted discovery descriptor, stale
// endpoint cleanup on start, and restart invalidation.
//
// Pipe names have the form \\.\pipe\aemcp-n1-<12 lowercase hex chars> derived
// from the host instance UUID. The pipe is created with a same-user ACL that
// grants access only to the creating OS user (and SYSTEM); that OS boundary
// is the ENTIRE transport boundary. Issue #88 (mutual transport
// authentication) was closed NOT_PLANNED on 2026-07-28: this adapter
// deliberately performs no peer verification beyond the same-user ACL, and
// reviewers must not "fix" that absence. Secrets never appear in the
// published descriptor.

#include "aemcp_native/peer_identity.hpp"

#include <cstdint>
#include <string>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace aemcp::native {

struct NativeEndpointDescriptor {
  std::uint32_t schema_version{1};
  std::string host_instance_id;
  ExpectedProcess host_process;
  std::string socket_name;  // Full pipe path: \\.\pipe\aemcp-n1-<nonce>
  std::uint32_t wire_version{1};
  std::string source_commit;
};

enum class EndpointCode {
  kOk,
  kInvalidArgument,
  kRuntimeRootUnavailable,
  kRuntimeRootUnsafe,
  kDirectoryLimitExceeded,
  kStaleEntryUnsafe,
  kSocketCreateFailed,
  kSocketPublishFailed,
  kDescriptorPublishFailed,
  kEndpointReplaced,
  kAlreadyStarted,
};

struct EndpointResult {
  EndpointCode code{EndpointCode::kInvalidArgument};
  std::string diagnostic;

  [[nodiscard]] bool ok() const noexcept { return code == EndpointCode::kOk; }
};

struct EndpointRegistryConfig {
  // Empty selects %LOCALAPPDATA%\AfterEffectsMCP. Tests may inject a private,
  // already-created directory; product code must leave it empty.
  std::string runtime_root;
  std::string endpoint_nonce;
  int listen_backlog{2};
  std::size_t maximum_directory_entries{128};
};

// Owns one per-AE named-pipe listener and its untrusted discovery descriptor.
class WindowsEndpointRegistry final {
 public:
  WindowsEndpointRegistry(PeerIdentityBackend& process_backend, EndpointRegistryConfig config);
  WindowsEndpointRegistry(const WindowsEndpointRegistry&) = delete;
  WindowsEndpointRegistry& operator=(const WindowsEndpointRegistry&) = delete;
  ~WindowsEndpointRegistry();

  [[nodiscard]] EndpointResult start(NativeEndpointDescriptor descriptor);
  [[nodiscard]] EndpointResult verify() const;
  void stop() noexcept;

  [[nodiscard]] HANDLE listener_pipe() const noexcept { return listener_pipe_; }
  [[nodiscard]] const NativeEndpointDescriptor& descriptor() const noexcept {
    return descriptor_;
  }
  [[nodiscard]] const std::string& descriptor_path() const noexcept {
    return descriptor_path_;
  }
  [[nodiscard]] const std::string& pipe_name() const noexcept { return pipe_name_; }

  // Descriptor text is the same AEMCP_NATIVE_ENDPOINT_V1 line format the
  // macOS registry publishes; socket= carries the full pipe path on Windows.
  [[nodiscard]] static bool parse_descriptor(
      const std::string& text,
      NativeEndpointDescriptor& output) noexcept;
  [[nodiscard]] static std::string serialize_descriptor(
      const NativeEndpointDescriptor& descriptor);

 private:
  [[nodiscard]] EndpointResult open_directories();
  [[nodiscard]] EndpointResult cleanup_stale();
  [[nodiscard]] EndpointResult create_listener();
  [[nodiscard]] EndpointResult publish_descriptor();
  [[nodiscard]] bool host_descriptor_alive(const NativeEndpointDescriptor& candidate) noexcept;

  PeerIdentityBackend& process_backend_;
  const EndpointRegistryConfig config_;
  NativeEndpointDescriptor descriptor_;
  HANDLE listener_pipe_{nullptr};
  std::string runtime_root_;
  std::string directory_path_;
  std::string descriptor_path_;
  std::string pipe_name_;
  bool started_{false};
};

[[nodiscard]] const char* endpoint_code_name(EndpointCode code) noexcept;

}  // namespace aemcp::native
