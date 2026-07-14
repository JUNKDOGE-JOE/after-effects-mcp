#pragma once

#include "aemcp_native/peer_identity.hpp"

#include <cstdint>
#include <string>

namespace aemcp::native {

struct NativeEndpointDescriptor {
  std::uint32_t schema_version{1};
  std::string host_instance_id;
  ExpectedProcess host_process;
  std::string socket_name;
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
  // Empty selects confstr(_CS_DARWIN_USER_TEMP_DIR). Tests may inject a
  // private, already-created 0700 directory; product code must leave it empty.
  std::string runtime_root;
  std::string endpoint_nonce;
  int listen_backlog{2};
  std::size_t maximum_directory_entries{128};
};

// Owns one per-AE AF_UNIX listener and its untrusted discovery descriptor.
// Secrets are deliberately absent from the descriptor. All filesystem work is
// anchored to validated directory descriptors and cleanup is inode-checked.
class MacEndpointRegistry final {
 public:
  MacEndpointRegistry(PeerIdentityBackend& process_backend, EndpointRegistryConfig config);
  MacEndpointRegistry(const MacEndpointRegistry&) = delete;
  MacEndpointRegistry& operator=(const MacEndpointRegistry&) = delete;
  ~MacEndpointRegistry();

  [[nodiscard]] EndpointResult start(NativeEndpointDescriptor descriptor);
  [[nodiscard]] EndpointResult verify() const;
  void stop() noexcept;

  [[nodiscard]] int listener_fd() const noexcept { return listener_fd_; }
  [[nodiscard]] const NativeEndpointDescriptor& descriptor() const noexcept {
    return descriptor_;
  }
  [[nodiscard]] const std::string& descriptor_path() const noexcept {
    return descriptor_path_;
  }
  [[nodiscard]] const std::string& socket_path() const noexcept { return socket_path_; }

  [[nodiscard]] static bool parse_descriptor(
      const std::string& text,
      NativeEndpointDescriptor& output) noexcept;
  [[nodiscard]] static std::string serialize_descriptor(
      const NativeEndpointDescriptor& descriptor);

 private:
  struct PublishedEntry {
    std::string name;
    std::uint64_t device{0};
    std::uint64_t inode{0};
  };

  [[nodiscard]] EndpointResult open_directories();
  [[nodiscard]] EndpointResult cleanup_stale();
  [[nodiscard]] EndpointResult create_listener();
  [[nodiscard]] EndpointResult publish_descriptor();
  [[nodiscard]] bool safe_unlink(const PublishedEntry& entry, bool socket) const noexcept;

  PeerIdentityBackend& process_backend_;
  const EndpointRegistryConfig config_;
  NativeEndpointDescriptor descriptor_;
  int root_fd_{-1};
  int directory_fd_{-1};
  int listener_fd_{-1};
  std::string runtime_root_;
  std::string directory_path_;
  std::string descriptor_path_;
  std::string socket_path_;
  PublishedEntry descriptor_entry_;
  PublishedEntry socket_entry_;
  bool started_{false};
};

[[nodiscard]] const char* endpoint_code_name(EndpointCode code) noexcept;

}  // namespace aemcp::native
