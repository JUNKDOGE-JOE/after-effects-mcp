#include "aemcp_native/win_ipc_server.hpp"

#include "aemcp_native/secure_random_windows.hpp"
#include "aemcp_native/transport_io.hpp"

#include <cctype>
#include <cerrno>

#include <fcntl.h>
#include <io.h>

namespace aemcp::native {
namespace {

TransportAuthDecisionCode decision_for_stop(bool stopping) {
  return stopping
      ? TransportAuthDecisionCode::kShuttingDown
      : TransportAuthDecisionCode::kRejected;
}

// Same wire-v1 compatibility challenge shape as the macOS server: four
// upper-case hex characters, a dash, four more, derived from a fresh UUID.
std::string compatibility_challenge_id() {
  const std::string uuid = secure_uuid_v4();
  std::string value;
  value.reserve(9);
  for (const unsigned char character : uuid) {
    if (character == '-') continue;
    value.push_back(static_cast<char>(std::toupper(character)));
    if (value.size() == 4) value.push_back('-');
    if (value.size() == 9) break;
  }
  return value;
}

}  // namespace

WindowsIpcServer::WindowsIpcServer(
    WindowsEndpointRegistry& endpoint,
    PeerIdentityBackend& peer_backend,
    AuthenticatedConnectionHandler& handler,
    NativeIpcObserver& observer,
    WindowsIpcServerConfig config)
    : endpoint_(endpoint),
      peer_backend_(peer_backend),
      handler_(handler),
      observer_(observer),
      config_(config) {}

WindowsIpcServer::~WindowsIpcServer() {
  stop();
}

HANDLE WindowsIpcServer::create_next_listener() noexcept {
  // Every instance carries the registry's same-user ACL; a default-DACL
  // instance created by an elevated host would deny non-elevated same-user
  // clients (#88 NOT_PLANNED: the ACL is the entire boundary).
  return endpoint_.create_pipe_instance();
}

bool WindowsIpcServer::start() {
  if (running_.load()) return false;
  listener_ = endpoint_.listener_pipe();
  if (listener_ == nullptr) return false;
  stop_requested_.store(false);
  try {
    worker_ = std::thread(&WindowsIpcServer::run, this);
  } catch (...) {
    return false;
  }
  return true;
}

void WindowsIpcServer::stop() noexcept {
  stop_requested_.store(true);
  const HANDLE waiting = waiting_pipe_.load();
  if (waiting != nullptr) {
    // Unblock a pending ConnectNamedPipe so the worker can observe the stop.
    (void)CancelIoEx(waiting, nullptr);
    (void)DisconnectNamedPipe(waiting);
  }
  if (worker_.joinable()) worker_.join();
  running_.store(false);
  listener_ = nullptr;
}

void WindowsIpcServer::run() noexcept {
  running_.store(true);
  HANDLE pipe = listener_;
  while (!stop_requested_.load()) {
    if (pipe == nullptr) {
      pipe = create_next_listener();
      if (pipe == nullptr) {
        observer_.on_ipc_event("listener", "pipe-create-failed");
        break;
      }
    }
    waiting_pipe_.store(pipe);
    const BOOL connected = ConnectNamedPipe(pipe, nullptr);
    waiting_pipe_.store(nullptr);
    const DWORD connect_error = connected == 0 ? GetLastError() : ERROR_SUCCESS;
    if (connected == 0 && connect_error == ERROR_PIPE_CONNECTED) {
      // Client already connected before the call; the pipe is usable.
    } else if (connected == 0 && connect_error == ERROR_NO_DATA) {
      // Client connected and disconnected immediately; recycle the instance.
      (void)DisconnectNamedPipe(pipe);
      continue;
    } else if (connected == 0) {
      CloseHandle(pipe);
      pipe = nullptr;
      if (stop_requested_.load() || connect_error == ERROR_OPERATION_ABORTED
          || connect_error == ERROR_INVALID_HANDLE) {
        break;
      }
      observer_.on_ipc_event("listener", "connect-failed");
      continue;
    }
    if (stop_requested_.load()) {
      CloseHandle(pipe);
      break;
    }
    handle_connection(pipe);
    pipe = nullptr;
  }
  running_.store(false);
}

bool WindowsIpcServer::read_exact(
    int fd,
    std::uint8_t* output,
    std::size_t size,
    std::chrono::steady_clock::time_point deadline) noexcept {
  std::size_t received = 0;
  while (received < size) {
    if (std::chrono::steady_clock::now() >= deadline) return false;
    const int polled = transport_wait_readable(fd, 50);
    if (polled <= 0) continue;
    const int count = transport_recv(fd, output + received, size - received);
    if (count > 0) {
      received += static_cast<std::size_t>(count);
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      return false;
    }
  }
  return true;
}

bool WindowsIpcServer::write_exact(
    int fd,
    const std::uint8_t* input,
    std::size_t size,
    std::chrono::steady_clock::time_point deadline) noexcept {
  std::size_t sent = 0;
  while (sent < size) {
    if (std::chrono::steady_clock::now() >= deadline) return false;
    const int count = transport_send(fd, input + sent, size - sent);
    if (count > 0) {
      sent += static_cast<std::size_t>(count);
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      return false;
    }
  }
  return true;
}

void WindowsIpcServer::handle_connection(HANDLE pipe) noexcept {
  const int fd = _open_osfhandle(
      reinterpret_cast<intptr_t>(pipe), _O_RDWR | _O_BINARY);
  if (fd < 0) {
    CloseHandle(pipe);
    observer_.on_ipc_event("connection", "fd-wrap-failed");
    return;
  }
  const auto handshake_deadline =
      std::chrono::steady_clock::now() + config_.handshake_timeout;
  observer_.on_ipc_event("connection", "accepted");

  std::array<std::uint8_t, kTransportAuthPrefaceBytes> preface_bytes{};
  if (!read_exact(fd, preface_bytes.data(), preface_bytes.size(), handshake_deadline)) {
    observer_.on_ipc_event("connection", "preface-read-failed");
    _close(fd);
    return;
  }
  TransportAuthPreface preface;
  if (!parse_auth_preface(preface_bytes, preface)) {
    observer_.on_ipc_event("connection", "preface-invalid");
    _close(fd);
    return;
  }
  // No admit_local_ae_peer on Windows: the same-user pipe ACL is the entire
  // admission boundary (#88 NOT_PLANNED). The endpoint re-verification below
  // guards only against our own descriptor being replaced mid-handshake.
  if (!endpoint_.verify().ok()) {
    observer_.on_ipc_event("connection", "identity-changed");
    _close(fd);
    return;
  }
  const auto challenge_bytes = serialize_auth_challenge({
      compatibility_challenge_id(),
      config_.handshake_timeout,
      endpoint_.descriptor().host_instance_id,
  });
  if (!write_exact(fd, challenge_bytes.data(), challenge_bytes.size(), handshake_deadline)) {
    observer_.on_ipc_event("connection", "challenge-write-failed");
    _close(fd);
    return;
  }
  observer_.on_ipc_event("connection", "challenge-sent");
  if (stop_requested_.load()) {
    const auto stopping = serialize_auth_decision({
        decision_for_stop(true), {}, 0,
    });
    (void)write_exact(fd, stopping.data(), stopping.size(), handshake_deadline);
    _close(fd);
    return;
  }
  const std::uint32_t generation = next_session_generation_.fetch_add(1);
  SocketPeerEvidence evidence{};
  PeerBinding peer{};
  if (peer_backend_.socket_peer(fd, evidence)) {
    // OS-reported client identity, recorded for observability only; never
    // used to gate admission on the Windows path (#88 NOT_PLANNED).
    peer.pid = evidence.pid;
    peer.pid_version = evidence.pid_version;
    peer.uid = evidence.euid;
    peer.audit_session = evidence.audit_session;
  } else {
    peer.pid = static_cast<std::int32_t>(GetCurrentProcessId());
    peer.pid_version = 1;
  }
  peer.connection_id = secure_uuid_v4();
  peer.host_instance_id = endpoint_.descriptor().host_instance_id;
  AuthenticatedConnection authenticated{
      fd,
      peer,
      preface.client_nonce,
      secure_uuid_v4(),
      generation,
  };
  const auto authorized_bytes = serialize_auth_decision({
      TransportAuthDecisionCode::kAuthorized,
      authenticated.session_id,
      authenticated.session_generation,
  });
  if (!write_exact(fd, authorized_bytes.data(), authorized_bytes.size(), handshake_deadline)) {
    observer_.on_ipc_event("session", "decision-write-failed");
    _close(fd);
    return;
  }
  observer_.on_ipc_event("session", "authorized");
  handler_.serve(authenticated);
  _close(fd);
}

}  // namespace aemcp::native
