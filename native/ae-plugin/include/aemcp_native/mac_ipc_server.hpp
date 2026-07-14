#pragma once

#include "aemcp_native/endpoint_registry_macos.hpp"
#include "aemcp_native/pairing_gate.hpp"
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

struct AuthenticatedConnection {
  int socket_fd{-1};
  PeerBinding peer;
  std::array<std::uint8_t, 16> client_nonce{};
  std::string session_id;
  std::uint32_t session_generation{0};
};

class AuthenticatedConnectionHandler {
 public:
  virtual ~AuthenticatedConnectionHandler() = default;
  // Runs on the single IPC worker. The server retains fd ownership and closes
  // it after serve() returns. AE suite calls are forbidden here.
  virtual void serve(const AuthenticatedConnection& connection) noexcept = 0;
};

class NativeIpcObserver {
 public:
  virtual ~NativeIpcObserver() = default;
  // event and decision are closed, non-sensitive identifiers. Implementations
  // must not log endpoint paths, fingerprints, nonces, tokens, or payloads.
  virtual void on_ipc_event(
      std::string_view event,
      std::string_view decision) noexcept = 0;
};

struct MacIpcServerConfig {
  std::chrono::milliseconds handshake_timeout{1500};
  std::chrono::milliseconds pairing_poll_interval{100};
  std::size_t maximum_ancestor_depth{16};
  std::int32_t expected_cpu_type{0};
};

// Minimum P0 authenticated transport. It deliberately does not claim the
// strict Adobe signing/client-attestation hardening tracked in #89. Admission
// requires same UID, exact current AE ancestry, and an AEGP-owned explicit
// pairing decision before the handler sees the connection.
class MacIpcServer final {
 public:
  MacIpcServer(
      MacEndpointRegistry& endpoint,
      PeerIdentityBackend& peer_backend,
      PairingGate& pairing_gate,
      AuthenticatedConnectionHandler& handler,
      NativeIpcObserver& observer,
      MacIpcServerConfig config);
  MacIpcServer(const MacIpcServer&) = delete;
  MacIpcServer& operator=(const MacIpcServer&) = delete;
  ~MacIpcServer();

  [[nodiscard]] bool start();
  void stop() noexcept;

  [[nodiscard]] std::optional<PendingPairingSnapshot> pending_pairing();
  [[nodiscard]] bool confirm_pending(
      const std::string& connection_id,
      const std::string& fingerprint);
  [[nodiscard]] bool reject_pending(
      const std::string& connection_id,
      const std::string& fingerprint);
  [[nodiscard]] bool running() const noexcept { return running_.load(); }

 private:
  void run() noexcept;
  void handle_connection(int socket_fd) noexcept;
  [[nodiscard]] std::optional<PeerBinding> admit_peer(
      int socket_fd,
      const std::string& connection_id) noexcept;
  [[nodiscard]] bool same_peer(
      int socket_fd,
      const PeerBinding& binding) noexcept;
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
  PairingGate& pairing_gate_;
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
