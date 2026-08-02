#include "aemcp_native/win_ipc_server.hpp"

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <cctype>
#include <cerrno>

#include "aemcp_native/secure_random_windows.hpp"
#include "aemcp_native/transport_io.hpp"

namespace aemcp::native {
namespace {

TransportAuthDecisionCode decision_for_stop(bool stopping) {
  return stopping ? TransportAuthDecisionCode::kShuttingDown : TransportAuthDecisionCode::kRejected;
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

WindowsIpcServer::WindowsIpcServer(WindowsEndpointRegistry &endpoint,
                                   PeerIdentityBackend &peer_backend,
                                   AuthenticatedConnectionHandler &handler,
                                   NativeIpcObserver &observer, WindowsIpcServerConfig config)
    : endpoint_(endpoint),
      peer_backend_(peer_backend),
      handler_(handler),
      observer_(observer),
      config_(config) {}

WindowsIpcServer::~WindowsIpcServer() { stop(); }

HANDLE WindowsIpcServer::create_next_listener() noexcept {
  // Every instance carries the registry's same-user ACL so elevation does not
  // silently narrow access for the same interactive user.
  return endpoint_.create_pipe_instance();
}

bool WindowsIpcServer::start() {
  if (worker_.joinable() || running_.load() || !endpoint_.verify().ok() ||
      config_.handshake_timeout < std::chrono::seconds(1) ||
      config_.handshake_timeout > std::chrono::seconds(5)) {
    return false;
  }
  const HANDLE listener = endpoint_.take_listener_pipe();
  if (listener == nullptr) return false;
  stop_requested_.store(false);
  try {
    worker_ = std::thread(&WindowsIpcServer::run, this, listener);
  } catch (...) {
    CloseHandle(listener);
    endpoint_.stop();
    return false;
  }
  return true;
}

void WindowsIpcServer::stop() noexcept {
  stop_requested_.store(true);
  {
    std::lock_guard lock(pipe_mutex_);
    for (const HANDLE pipe : {waiting_pipe_, active_pipe_}) {
      if (pipe == nullptr) continue;
      (void)CancelIoEx(pipe, nullptr);
      (void)DisconnectNamedPipe(pipe);
    }
  }
  if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) {
    worker_.join();
  }
  endpoint_.stop();
  running_.store(false);
}

bool WindowsIpcServer::connect_pipe(HANDLE pipe, DWORD &error) noexcept {
  const HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (event == nullptr) {
    error = GetLastError();
    return false;
  }
  OVERLAPPED operation{};
  operation.hEvent = event;
  const BOOL connected = ConnectNamedPipe(pipe, &operation);
  error = connected != 0 ? ERROR_SUCCESS : GetLastError();
  if (connected != 0 || error == ERROR_PIPE_CONNECTED) {
    CloseHandle(event);
    error = ERROR_SUCCESS;
    return true;
  }
  if (error != ERROR_IO_PENDING) {
    CloseHandle(event);
    return false;
  }
  for (;;) {
    const DWORD waited = WaitForSingleObject(event, 50);
    if (waited == WAIT_OBJECT_0) break;
    if (waited != WAIT_TIMEOUT || stop_requested_.load()) {
      (void)CancelIoEx(pipe, &operation);
      (void)WaitForSingleObject(event, INFINITE);
      CloseHandle(event);
      error = waited == WAIT_FAILED ? GetLastError() : ERROR_OPERATION_ABORTED;
      return false;
    }
  }
  DWORD transferred = 0;
  if (GetOverlappedResult(pipe, &operation, &transferred, FALSE) == 0) {
    error = GetLastError();
    CloseHandle(event);
    return false;
  }
  CloseHandle(event);
  error = ERROR_SUCCESS;
  return true;
}

void WindowsIpcServer::set_waiting(HANDLE pipe) noexcept {
  std::lock_guard lock(pipe_mutex_);
  waiting_pipe_ = pipe;
}

void WindowsIpcServer::set_active(HANDLE pipe) noexcept {
  std::lock_guard lock(pipe_mutex_);
  if (waiting_pipe_ == pipe) waiting_pipe_ = nullptr;
  active_pipe_ = pipe;
}

void WindowsIpcServer::close_active(HANDLE pipe, int fd) noexcept {
  {
    std::lock_guard lock(pipe_mutex_);
    if (waiting_pipe_ == pipe) waiting_pipe_ = nullptr;
    if (active_pipe_ == pipe) active_pipe_ = nullptr;
  }
  (void)CancelIoEx(pipe, nullptr);
  (void)DisconnectNamedPipe(pipe);
  if (fd >= 0) {
    (void)_close(fd);
  } else {
    CloseHandle(pipe);
  }
}

void WindowsIpcServer::run(HANDLE initial_pipe) noexcept {
  running_.store(true);
  observer_.on_ipc_event("listener", "started");
  HANDLE pipe = initial_pipe;
  while (!stop_requested_.load()) {
    if (pipe == nullptr) {
      pipe = create_next_listener();
      if (pipe == nullptr) {
        observer_.on_ipc_event("listener", "pipe-create-failed");
        break;
      }
    }
    set_waiting(pipe);
    DWORD connect_error = ERROR_SUCCESS;
    if (!connect_pipe(pipe, connect_error) && connect_error == ERROR_NO_DATA) {
      set_active(pipe);
      // Client connected and disconnected immediately; recycle the instance.
      close_active(pipe, -1);
      pipe = nullptr;
      continue;
    } else if (connect_error != ERROR_SUCCESS) {
      set_active(pipe);
      close_active(pipe, -1);
      pipe = nullptr;
      if (stop_requested_.load() || connect_error == ERROR_OPERATION_ABORTED ||
          connect_error == ERROR_INVALID_HANDLE) {
        break;
      }
      observer_.on_ipc_event("listener", "connect-failed");
      continue;
    }
    set_active(pipe);
    if (stop_requested_.load()) {
      close_active(pipe, -1);
      pipe = nullptr;
      break;
    }
    const int fd = _open_osfhandle(reinterpret_cast<intptr_t>(pipe), _O_RDWR | _O_BINARY);
    if (fd < 0) {
      observer_.on_ipc_event("connection", "fd-wrap-failed");
      close_active(pipe, -1);
      pipe = nullptr;
      continue;
    }
    handle_connection(fd);
    close_active(pipe, fd);
    pipe = nullptr;
  }
  if (pipe != nullptr) {
    set_active(pipe);
    close_active(pipe, -1);
  }
  running_.store(false);
  observer_.on_ipc_event("listener", "stopped");
}

bool WindowsIpcServer::read_exact(int fd, std::uint8_t *output, std::size_t size,
                                  std::chrono::steady_clock::time_point deadline) noexcept {
  std::size_t received = 0;
  while (received < size && !stop_requested_.load()) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const int count =
        transport_recv(fd, output + received, size - received,
                       static_cast<int>(std::clamp<std::int64_t>(remaining.count(), 1, 50)));
    if (count > 0) {
      received += static_cast<std::size_t>(count);
    } else if (count < 0 && (errno == EINTR || errno == ETIMEDOUT)) {
      continue;
    } else {
      return false;
    }
  }
  return received == size;
}

bool WindowsIpcServer::write_exact(int fd, const std::uint8_t *input, std::size_t size,
                                   std::chrono::steady_clock::time_point deadline) noexcept {
  std::size_t sent = 0;
  while (sent < size && !stop_requested_.load()) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const int count =
        transport_send(fd, input + sent, size - sent,
                       static_cast<int>(std::clamp<std::int64_t>(remaining.count(), 1, 1000)));
    if (count > 0) {
      sent += static_cast<std::size_t>(count);
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      return false;
    }
  }
  return sent == size;
}

void WindowsIpcServer::handle_connection(int fd) noexcept {
  try {
    const auto handshake_deadline = std::chrono::steady_clock::now() + config_.handshake_timeout;
    observer_.on_ipc_event("connection", "accepted");

    std::array<std::uint8_t, kTransportAuthPrefaceBytes> preface_bytes{};
    if (!read_exact(fd, preface_bytes.data(), preface_bytes.size(), handshake_deadline)) {
      observer_.on_ipc_event("connection", "preface-read-failed");
      return;
    }
    TransportAuthPreface preface;
    if (!parse_auth_preface(preface_bytes, preface)) {
      observer_.on_ipc_event("connection", "preface-invalid");
      return;
    }
    // Re-verify discovery metadata before authorizing this local connection;
    // the same-user ACL remains an implementation constraint on each pipe.
    if (!endpoint_.verify().ok()) {
      observer_.on_ipc_event("connection", "identity-changed");
      return;
    }
    const auto challenge_bytes = serialize_auth_challenge({
        compatibility_challenge_id(),
        config_.handshake_timeout,
        endpoint_.descriptor().host_instance_id,
    });
    if (!write_exact(fd, challenge_bytes.data(), challenge_bytes.size(), handshake_deadline)) {
      observer_.on_ipc_event("connection", "challenge-write-failed");
      return;
    }
    observer_.on_ipc_event("connection", "challenge-sent");
    if (stop_requested_.load()) {
      const auto stopping = serialize_auth_decision({
          decision_for_stop(true),
          {},
          0,
      });
      (void)write_exact(fd, stopping.data(), stopping.size(), handshake_deadline);
      return;
    }
    const std::uint32_t generation = next_session_generation_.fetch_add(1);
    SocketPeerEvidence evidence{};
    PeerBinding peer{};
    if (peer_backend_.socket_peer(fd, evidence)) {
      // OS-reported client identity is observability evidence, not an
      // additional admission gate on the same-user pipe.
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
        fd, peer, preface.client_nonce, secure_uuid_v4(), generation,
    };
    const auto authorized_bytes = serialize_auth_decision({
        TransportAuthDecisionCode::kAuthorized,
        authenticated.session_id,
        authenticated.session_generation,
    });
    if (!write_exact(fd, authorized_bytes.data(), authorized_bytes.size(), handshake_deadline)) {
      observer_.on_ipc_event("session", "decision-write-failed");
      return;
    }
    observer_.on_ipc_event("session", "authorized");
    handler_.serve(authenticated);
  } catch (...) {
    observer_.on_ipc_event("connection", "handshake-failed");
  }
}

}  // namespace aemcp::native
