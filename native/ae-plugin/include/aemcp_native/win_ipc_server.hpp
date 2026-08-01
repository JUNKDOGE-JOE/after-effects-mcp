#pragma once

#include "endpoint_registry_windows.hpp"
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

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace aemcp::native {

struct WindowsIpcServerConfig {
  std::chrono::milliseconds handshake_timeout{1500};
  std::size_t maximum_ancestor_depth{16};
  std::int32_t expected_cpu_type{0};
};

// Same-user named-pipe transport. Per the #88 NOT_PLANNED disposition there
// is NO peer authentication here: admission is the OS same-user pipe ACL plus
// the wire-v1 compatibility challenge (preface, challenge, decision) so the
// client speaks exactly the bytes it speaks on macOS. maximum_ancestor_depth
// and expected_cpu_type are accepted for config parity and deliberately
// unused on Windows.
class WindowsIpcServer final {
 public:
  WindowsIpcServer(
      WindowsEndpointRegistry& endpoint,
      PeerIdentityBackend& peer_backend,
      AuthenticatedConnectionHandler& handler,
      NativeIpcObserver& observer,
      WindowsIpcServerConfig config);
  WindowsIpcServer(const WindowsIpcServer&) = delete;
  WindowsIpcServer& operator=(const WindowsIpcServer&) = delete;
  ~WindowsIpcServer();

  [[nodiscard]] bool start();
  void stop() noexcept;

  [[nodiscard]] bool running() const noexcept { return running_.load(); }

 private:
  void run() noexcept;
  void handle_connection(HANDLE pipe) noexcept;
  [[nodiscard]] bool read_exact(
      int fd,
      std::uint8_t* output,
      std::size_t size,
      std::chrono::steady_clock::time_point deadline) noexcept;
  [[nodiscard]] bool write_exact(
      int fd,
      const std::uint8_t* input,
      std::size_t size,
      std::chrono::steady_clock::time_point deadline) noexcept;
  [[nodiscard]] HANDLE create_next_listener() noexcept;

  WindowsEndpointRegistry& endpoint_;
  PeerIdentityBackend& peer_backend_;
  AuthenticatedConnectionHandler& handler_;
  NativeIpcObserver& observer_;
  const WindowsIpcServerConfig config_;
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> running_{false};
  std::atomic<HANDLE> waiting_pipe_{nullptr};
  std::thread worker_;
  HANDLE listener_{nullptr};
  std::atomic<std::uint32_t> next_session_generation_{1};
};

}  // namespace aemcp::native
