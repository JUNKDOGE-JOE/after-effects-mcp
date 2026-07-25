#include "aemcp_native/mac_ipc_server.hpp"

#include "aemcp_native/secure_random_macos.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <utility>

namespace aemcp::native {
namespace {

using namespace std::chrono_literals;

bool poll_ready(int descriptor, short events, std::chrono::steady_clock::time_point deadline) {
  for (;;) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const int timeout = static_cast<int>(std::clamp<std::int64_t>(remaining.count(), 1, 1000));
    pollfd item{descriptor, events, 0};
    const int result = ::poll(&item, 1, timeout);
    if (result > 0) {
      if ((item.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) return false;
      return (item.revents & events) != 0;
    }
    if (result == 0) continue;
    if (errno != EINTR) return false;
  }
}

TransportAuthDecisionCode decision_for_stop(bool stopping) {
  return stopping
      ? TransportAuthDecisionCode::kShuttingDown
      : TransportAuthDecisionCode::kRejected;
}

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

MacIpcServer::MacIpcServer(
    MacEndpointRegistry& endpoint,
    PeerIdentityBackend& peer_backend,
    AuthenticatedConnectionHandler& handler,
    NativeIpcObserver& observer,
    MacIpcServerConfig config)
    : endpoint_(endpoint),
      peer_backend_(peer_backend),
      handler_(handler),
      observer_(observer),
      config_(config) {}

MacIpcServer::~MacIpcServer() {
  stop();
}

bool MacIpcServer::start() {
  if (worker_.joinable() || running_.load() || endpoint_.listener_fd() < 0
      || !endpoint_.verify().ok() || config_.handshake_timeout < 1s
      || config_.handshake_timeout > 5s
      || config_.maximum_ancestor_depth < 2 || config_.maximum_ancestor_depth > 64
      || config_.expected_cpu_type == 0) {
    return false;
  }
  stop_requested_.store(false);
  try {
    worker_ = std::thread([this] { run(); });
  } catch (...) {
    return false;
  }
  return true;
}

void MacIpcServer::stop() noexcept {
  stop_requested_.store(true);
  {
    std::lock_guard lock(active_mutex_);
    if (active_fd_ >= 0) ::shutdown(active_fd_, SHUT_RDWR);
  }
  if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) {
    worker_.join();
  }
  // The worker reads endpoint descriptors and the listener fd. Keep the
  // registry alive until it has observed stop_requested_ and fully exited;
  // otherwise AE unload races endpoint teardown and fd reuse.
  endpoint_.stop();
  running_.store(false);
}

void MacIpcServer::run() noexcept {
  running_.store(true);
  observer_.on_ipc_event("listener", "started");
  while (!stop_requested_.load()) {
    if (!endpoint_.verify().ok()) {
      observer_.on_ipc_event("listener", "endpoint-invalid");
      break;
    }
    pollfd listener{endpoint_.listener_fd(), POLLIN, 0};
    const int polled = ::poll(&listener, 1, 250);
    if (polled < 0 && errno == EINTR) continue;
    if (polled < 0 || (polled > 0 && (listener.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0)) {
      if (!stop_requested_.load()) observer_.on_ipc_event("listener", "poll-failed");
      break;
    }
    if (polled == 0 || (listener.revents & POLLIN) == 0) continue;
    const int connection = ::accept(endpoint_.listener_fd(), nullptr, nullptr);
    if (connection < 0) {
      if (errno == EINTR) continue;
      if (!stop_requested_.load()) observer_.on_ipc_event("connection", "accept-failed");
      continue;
    }
    if (::fcntl(connection, F_SETFD, FD_CLOEXEC) != 0) {
      ::close(connection);
      continue;
    }
    int no_sigpipe = 1;
    if (::setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) {
      ::close(connection);
      continue;
    }
    {
      std::lock_guard lock(active_mutex_);
      active_fd_ = connection;
    }
    handle_connection(connection);
    close_active(connection);
  }
  running_.store(false);
  observer_.on_ipc_event("listener", "stopped");
}

void MacIpcServer::handle_connection(int socket_fd) noexcept {
  try {
    const std::string connection_id = secure_uuid_v4();
    const NativeEndpointDescriptor descriptor = endpoint_.descriptor();
    std::optional<PeerBinding> peer = admit_local_ae_peer(
        peer_backend_,
        socket_fd,
        connection_id,
        PeerAdmissionConfig{
            static_cast<std::uint32_t>(::getuid()),
            config_.maximum_ancestor_depth,
            config_.expected_cpu_type,
            descriptor.host_process,
            descriptor.host_instance_id,
        });
    if (!peer.has_value()) {
      observer_.on_ipc_event("connection", "peer-rejected");
      return;
    }
    const auto handshake_deadline = std::chrono::steady_clock::now() + config_.handshake_timeout;
    std::array<std::uint8_t, kTransportAuthPrefaceBytes> preface_bytes{};
    if (!read_exact(
            socket_fd, preface_bytes.data(), preface_bytes.size(), handshake_deadline)) {
      observer_.on_ipc_event("connection", "preface-timeout");
      return;
    }
    TransportAuthPreface preface;
    if (!parse_auth_preface(preface_bytes, preface)) {
      observer_.on_ipc_event("connection", "preface-invalid");
      return;
    }
    if (!same_peer(peer_backend_, socket_fd, *peer) || !endpoint_.verify().ok()) {
      observer_.on_ipc_event("connection", "identity-changed");
      return;
    }
    const auto challenge_bytes = serialize_auth_challenge({
        compatibility_challenge_id(),
        config_.handshake_timeout,
        descriptor.host_instance_id,
    });
    if (!write_exact(
            socket_fd, challenge_bytes.data(), challenge_bytes.size(),
            handshake_deadline)) {
      observer_.on_ipc_event("connection", "challenge-write-failed");
      return;
    }
    observer_.on_ipc_event("connection", "challenge-sent");
    if (stop_requested_.load()
        || !same_peer(peer_backend_, socket_fd, *peer)
        || !endpoint_.verify().ok()) {
      const TransportAuthDecisionCode code = decision_for_stop(stop_requested_.load());
      const auto decision = serialize_auth_decision({code, {}, 0});
      const bool sent = write_exact(
          socket_fd, decision.data(), decision.size(),
          handshake_deadline);
      (void)sent;
      observer_.on_ipc_event("connection", "identity-changed");
      return;
    }

    const std::uint32_t generation = next_session_generation_.fetch_add(1);
    if (generation == 0 || generation == std::numeric_limits<std::uint32_t>::max()) {
      observer_.on_ipc_event("session", "generation-exhausted");
      stop_requested_.store(true);
      return;
    }
    AuthenticatedConnection authenticated{
        socket_fd,
        *peer,
        preface.client_nonce,
        secure_uuid_v4(),
        generation,
    };
    const auto authorized_bytes = serialize_auth_decision({
        TransportAuthDecisionCode::kAuthorized,
        authenticated.session_id,
        authenticated.session_generation,
    });
    if (!write_exact(
            socket_fd, authorized_bytes.data(), authorized_bytes.size(),
            handshake_deadline)) {
      observer_.on_ipc_event("session", "decision-write-failed");
      return;
    }
    observer_.on_ipc_event("session", "authorized");
    handler_.serve(authenticated);
    observer_.on_ipc_event("session", "closed");
  } catch (...) {
    observer_.on_ipc_event("connection", "internal-failure");
  }
}

bool MacIpcServer::read_exact(
    int socket_fd,
    std::uint8_t* output,
    std::size_t size,
    std::chrono::steady_clock::time_point deadline) noexcept {
  std::size_t received = 0;
  while (received < size && !stop_requested_.load()) {
    if (!poll_ready(socket_fd, POLLIN, deadline)) return false;
    const ssize_t count = ::recv(socket_fd, output + received, size - received, 0);
    if (count > 0) received += static_cast<std::size_t>(count);
    else if (count < 0 && errno == EINTR) continue;
    else return false;
  }
  return received == size;
}

bool MacIpcServer::write_exact(
    int socket_fd,
    const std::uint8_t* input,
    std::size_t size,
    std::chrono::steady_clock::time_point deadline) noexcept {
  std::size_t sent = 0;
  while (sent < size && !stop_requested_.load()) {
    if (!poll_ready(socket_fd, POLLOUT, deadline)) return false;
    const ssize_t count = ::send(socket_fd, input + sent, size - sent, 0);
    if (count > 0) sent += static_cast<std::size_t>(count);
    else if (count < 0 && errno == EINTR) continue;
    else return false;
  }
  return sent == size;
}

void MacIpcServer::close_active(int socket_fd) noexcept {
  {
    std::lock_guard lock(active_mutex_);
    if (active_fd_ == socket_fd) active_fd_ = -1;
  }
  ::shutdown(socket_fd, SHUT_RDWR);
  ::close(socket_fd);
}

}  // namespace aemcp::native
