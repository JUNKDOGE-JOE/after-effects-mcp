#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

namespace aemcp::native {

struct ProcessGeneration {
  std::uint64_t start_seconds{0};
  std::uint64_t start_microseconds{0};

  [[nodiscard]] bool valid() const noexcept { return start_seconds != 0; }
  friend bool operator==(const ProcessGeneration&, const ProcessGeneration&) = default;
};

struct ExpectedProcess {
  std::int32_t pid{0};
  ProcessGeneration generation;

  [[nodiscard]] bool valid() const noexcept { return pid > 1 && generation.valid(); }
};

struct SocketPeerEvidence {
  std::int32_t pid{0};
  std::uint32_t euid{0};
  std::uint32_t egid{0};
  std::uint32_t audit_session{0};
  std::uint32_t pid_version{0};

  friend bool operator==(const SocketPeerEvidence&, const SocketPeerEvidence&) = default;
};

struct ProcessSnapshot {
  std::int32_t pid{0};
  std::int32_t parent_pid{0};
  std::uint32_t uid{0};
  ProcessGeneration generation;
  std::int32_t cpu_type{0};
  bool traced{false};
  bool exiting{false};

  friend bool operator==(const ProcessSnapshot&, const ProcessSnapshot&) = default;
};

class PeerIdentityBackend {
 public:
  virtual ~PeerIdentityBackend() = default;
  [[nodiscard]] virtual bool socket_peer(int socket_fd, SocketPeerEvidence& output) = 0;
  [[nodiscard]] virtual bool process_snapshot(std::int32_t pid, ProcessSnapshot& output) = 0;
};

struct PeerBinding {
  std::int32_t pid{0};
  std::uint32_t pid_version{0};
  std::uint32_t uid{0};
  std::uint32_t audit_session{0};
  std::string connection_id;
  std::string host_instance_id;

  [[nodiscard]] bool valid() const noexcept {
    return pid > 1 && pid_version != 0 && !connection_id.empty()
        && !host_instance_id.empty();
  }

  friend bool operator==(const PeerBinding&, const PeerBinding&) = default;
};

struct PeerAdmissionConfig {
  std::uint32_t expected_uid{0};
  std::size_t maximum_ancestor_depth{16};
  std::int32_t expected_cpu_type{0};
  ExpectedProcess host_process;
  std::string host_instance_id;
};

[[nodiscard]] std::optional<PeerBinding> admit_local_ae_peer(
    PeerIdentityBackend& backend,
    int socket_fd,
    std::string connection_id,
    const PeerAdmissionConfig& config) noexcept;

[[nodiscard]] bool same_peer(
    PeerIdentityBackend& backend,
    int socket_fd,
    const PeerBinding& binding) noexcept;

}  // namespace aemcp::native
