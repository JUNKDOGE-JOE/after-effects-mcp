#pragma once

#include "aemcp_native/endpoint_registry_macos.hpp"
#include "aemcp_native/ipc_server_types.hpp"
#include "aemcp_native/peer_identity.hpp"
#include "aemcp_native/transport_auth.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

namespace aemcp::native {

struct MacIpcServerConfig {
  std::chrono::milliseconds handshake_timeout{1500};
  std::size_t maximum_ancestor_depth{16};
  std::int32_t expected_cpu_type{0};
};

// Minimum P0 authenticated transport. It deliberately does not claim the
// strict Adobe signing/client-attestation hardening tracked in #89. Admission
// requires same UID, exact current AE ancestry, stable peer identity, endpoint
// re-verification, and the wire-v1 compatibility challenge before the handler
// sees the connection.
class MacIpcServer final {
 public:
  MacIpcServer(
      MacEndpointRegistry& endpoint,
      PeerIdentityBackend& peer_backend,
      AuthenticatedConnectionHandler& handler,
      NativeIpcObserver& observer,
      MacIpcServerConfig config);
  MacIpcServer(const MacIpcServer&) = delete;
  MacIpcServer& operator=(const MacIpcServer&) = delete;
  ~MacIpcServer();

  [[nodiscard]] bool start();
  void stop() noexcept;

  [[nodiscard]] bool running() const noexcept { return running_.load(); }

 private:
  void run() noexcept;
  void handle_connection(int socket_fd) noexcept;
  [[nodiscard]] bool read_exact(
      int socket_fd,
      std::uint8_t* output,
      std::size_t size,
      std::chrono::steady_clock::time_point deadline) noexcept;
  [[nodiscard]] bool write_exact(
      int socket_fd,
      const std::uint8_t* input,
      std::size_t size,
      std::chrono::steady_clock::time_point deadline) noexcept;
  void close_active(int socket_fd) noexcept;

  MacEndpointRegistry& endpoint_;
  PeerIdentityBackend& peer_backend_;
  AuthenticatedConnectionHandler& handler_;
  NativeIpcObserver& observer_;
  const MacIpcServerConfig config_;
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> running_{false};
  std::thread worker_;
  std::mutex active_mutex_;
  int active_fd_{-1};
  std::atomic<std::uint32_t> next_session_generation_{1};
};

}  // namespace aemcp::native
