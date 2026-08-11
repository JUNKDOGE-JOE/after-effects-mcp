#pragma once

// Platform-neutral IPC server surface shared by the macOS and Windows
// adapters and by the RPC connection core. Transport-specific admission
// lives in each platform adapter; these types only describe an admitted
// connection and its observers.

#include "aemcp_native/peer_identity.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

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
  // must not log endpoint paths, identities, nonces, or payloads.
  virtual void on_ipc_event(
      std::string_view event,
      std::string_view decision) noexcept = 0;
};

}  // namespace aemcp::native
