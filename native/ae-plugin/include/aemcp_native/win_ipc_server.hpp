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

// Named-pipe transport with a same-user ACL implementation constraint. The
// wire-v1 compatibility challenge preserves the macOS client byte contract.
// maximum_ancestor_depth and expected_cpu_type are accepted for config parity
// and deliberately unused on Windows.
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
  void run(HANDLE initial_pipe) noexcept;
  void handle_connection(int fd) noexcept;
  [[nodiscard]] bool connect_pipe(HANDLE pipe, DWORD& error) noexcept;
  void set_waiting(HANDLE pipe) noexcept;
  void set_active(HANDLE pipe) noexcept;
  void close_active(HANDLE pipe, int fd) noexcept;
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
  std::mutex pipe_mutex_;
  HANDLE waiting_pipe_{nullptr};
  HANDLE active_pipe_{nullptr};
  std::thread worker_;
  std::atomic<std::uint32_t> next_session_generation_{1};
};

}  // namespace aemcp::native
