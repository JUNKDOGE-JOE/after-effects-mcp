#include <fcntl.h>
#include <io.h>

#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "aemcp_native/transport_auth.hpp"
#include "aemcp_native/transport_io.hpp"
#include "aemcp_native/win_ipc_server.hpp"

namespace {

using namespace std::chrono_literals;
using aemcp::native::AuthenticatedConnection;
using aemcp::native::AuthenticatedConnectionHandler;
using aemcp::native::EndpointRegistryConfig;
using aemcp::native::ExpectedProcess;
using aemcp::native::NativeEndpointDescriptor;
using aemcp::native::NativeIpcObserver;
using aemcp::native::PeerIdentityBackend;
using aemcp::native::ProcessSnapshot;
using aemcp::native::SocketPeerEvidence;
using aemcp::native::TransportAuthChallenge;
using aemcp::native::TransportAuthDecision;
using aemcp::native::TransportAuthDecisionCode;
using aemcp::native::TransportAuthPreface;
using aemcp::native::WindowsEndpointRegistry;
using aemcp::native::WindowsIpcServer;
using aemcp::native::WindowsIpcServerConfig;

[[noreturn]] void fail(const std::string &message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string &message) {
  if (!condition) fail(message);
}

class OwnedHandle final {
 public:
  explicit OwnedHandle(HANDLE value = nullptr) noexcept : value_(value) {}
  OwnedHandle(const OwnedHandle &) = delete;
  OwnedHandle &operator=(const OwnedHandle &) = delete;
  OwnedHandle(OwnedHandle &&other) noexcept : value_(other.release()) {}
  OwnedHandle &operator=(OwnedHandle &&other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  ~OwnedHandle() { reset(); }

  [[nodiscard]] HANDLE get() const noexcept { return value_; }
  [[nodiscard]] HANDLE release() noexcept {
    const HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) noexcept {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_{nullptr};
};

std::string unique_suffix() {
  static std::atomic<std::uint32_t> sequence{0};
  const std::uint64_t value = (static_cast<std::uint64_t>(GetCurrentProcessId()) << 24U) ^
                              GetTickCount64() ^ sequence.fetch_add(1);
  std::array<char, 13> text{};
  std::snprintf(text.data(), text.size(), "%012llx",
                static_cast<unsigned long long>(value & 0xffffffffffffULL));
  return std::string(text.data());
}

std::wstring widen(std::string_view value) { return std::wstring(value.begin(), value.end()); }

class TempRoot final {
 public:
  TempRoot() {
    std::error_code error;
    path = std::filesystem::temp_directory_path(error) / ("aemcp-win-ipc-test-" + unique_suffix());
    require(!error, "could not resolve the temporary directory");
    std::filesystem::create_directories(path, error);
    require(!error, "could not create the temporary endpoint root");
  }
  ~TempRoot() {
    std::error_code error;
    std::filesystem::remove_all(path, error);
  }

  std::filesystem::path path;
};

class FakeBackend final : public PeerIdentityBackend {
 public:
  bool socket_peer(int, SocketPeerEvidence &) override { return false; }
  bool process_snapshot(std::int32_t, ProcessSnapshot &) override { return false; }
};

class RecordingObserver final : public NativeIpcObserver {
 public:
  void on_ipc_event(std::string_view event, std::string_view decision) noexcept override {
    if (event == "listener" && decision == "stopped") stopped.store(true);
  }

  std::atomic<bool> stopped{false};
};

class IdleHandler final : public AuthenticatedConnectionHandler {
 public:
  IdleHandler() : entered_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    require(entered_.get() != nullptr, "could not create handler event");
  }

  void serve(const AuthenticatedConnection &connection) noexcept override {
    SetEvent(entered_.get());
    for (;;) {
      const int ready = aemcp::native::transport_wait_readable(connection.socket_fd, 50);
      if (ready < 0) break;
      if (ready == 0) continue;
      std::uint8_t byte = 0;
      const int received = aemcp::native::transport_recv(connection.socket_fd, &byte, 1, 50);
      if (received > 0) continue;
      if (received < 0 && errno == ETIMEDOUT) continue;
      break;
    }
    exited.store(true);
  }

  [[nodiscard]] bool wait_until_entered(DWORD timeout_ms) const noexcept {
    return WaitForSingleObject(entered_.get(), timeout_ms) == WAIT_OBJECT_0;
  }

  std::atomic<bool> exited{false};

 private:
  OwnedHandle entered_;
};

class NoopHandler final : public AuthenticatedConnectionHandler {
 public:
  void serve(const AuthenticatedConnection &) noexcept override {}
};

NativeEndpointDescriptor descriptor() {
  return {
      1,
      "11111111-1111-4111-8111-111111111111",
      ExpectedProcess{static_cast<std::int32_t>(GetCurrentProcessId()), {1, 0}},
      {},
      1,
      "0123456789abcdef0123456789abcdef01234567",
  };
}

bool bounded_file_io(HANDLE file, void *buffer, DWORD size, DWORD timeout_ms, bool reading,
                     DWORD &transferred) {
  OwnedHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (event.get() == nullptr) return false;
  OVERLAPPED operation{};
  operation.hEvent = event.get();
  const BOOL completed = reading ? ReadFile(file, buffer, size, &transferred, &operation)
                                 : WriteFile(file, buffer, size, &transferred, &operation);
  if (completed != 0) return true;
  if (GetLastError() != ERROR_IO_PENDING) return false;
  if (WaitForSingleObject(event.get(), timeout_ms) != WAIT_OBJECT_0) {
    (void)CancelIoEx(file, &operation);
    (void)WaitForSingleObject(event.get(), INFINITE);
    return false;
  }
  return GetOverlappedResult(file, &operation, &transferred, FALSE) != 0;
}

template <std::size_t Size>
bool write_all(HANDLE file, const std::array<std::uint8_t, Size> &bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD transferred = 0;
    if (!bounded_file_io(file, const_cast<std::uint8_t *>(bytes.data() + offset),
                         static_cast<DWORD>(bytes.size() - offset), 2000, false, transferred) ||
        transferred == 0) {
      return false;
    }
    offset += transferred;
  }
  return true;
}

template <std::size_t Size>
bool read_all(HANDLE file, std::array<std::uint8_t, Size> &bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD transferred = 0;
    if (!bounded_file_io(file, bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset),
                         2000, true, transferred) ||
        transferred == 0) {
      return false;
    }
    offset += transferred;
  }
  return true;
}

OwnedHandle connect_client(const std::string &pipe_name) {
  const std::wstring wide_name = widen(pipe_name);
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  for (;;) {
    OwnedHandle client(CreateFileW(wide_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                   OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
    if (client.get() != INVALID_HANDLE_VALUE) return client;
    (void)client.release();
    const DWORD error = GetLastError();
    if (error != ERROR_PIPE_BUSY || std::chrono::steady_clock::now() >= deadline) {
      return OwnedHandle{};
    }
    (void)WaitNamedPipeW(wide_name.c_str(), 50);
  }
}

void complete_handshake(HANDLE client) {
  TransportAuthPreface preface;
  preface.client_nonce.fill(7);
  require(write_all(client, aemcp::native::serialize_auth_preface(preface)),
          "client could not write the auth preface");
  std::array<std::uint8_t, aemcp::native::kTransportAuthChallengeBytes> challenge_bytes{};
  require(read_all(client, challenge_bytes), "client did not receive the challenge");
  TransportAuthChallenge challenge;
  require(aemcp::native::parse_auth_challenge(challenge_bytes, challenge),
          "server challenge was invalid");
  std::array<std::uint8_t, aemcp::native::kTransportAuthDecisionBytes> decision_bytes{};
  require(read_all(client, decision_bytes), "client did not receive the decision");
  TransportAuthDecision decision;
  require(aemcp::native::parse_auth_decision(decision_bytes, decision) &&
              decision.code == TransportAuthDecisionCode::kAuthorized,
          "server did not authorize the same-user client");
}

void waiting_listener_shutdown_is_bounded() {
  TempRoot root;
  FakeBackend backend;
  NoopHandler handler;
  RecordingObserver observer;
  WindowsEndpointRegistry endpoint(
      backend, EndpointRegistryConfig{root.path.string(), unique_suffix(), 2, 32});
  require(endpoint.start(descriptor()).ok(), "waiting endpoint did not start");
  WindowsIpcServer server(endpoint, backend, handler, observer,
                          WindowsIpcServerConfig{1500ms, 16, 0x8664});
  require(server.start(), "waiting server did not start");
  require(endpoint.listener_pipe() == nullptr && endpoint.verify().ok(),
          "listener ownership did not transfer to the server");
  const auto started = std::chrono::steady_clock::now();
  server.stop();
  const auto elapsed = std::chrono::steady_clock::now() - started;
  require(elapsed < 1s, "waiting ConnectNamedPipe prevented bounded shutdown");
  require(observer.stopped.load(), "waiting server did not report stopped");
}

void idle_authenticated_client_shutdown_is_bounded() {
  TempRoot root;
  FakeBackend backend;
  IdleHandler handler;
  RecordingObserver observer;
  WindowsEndpointRegistry endpoint(
      backend, EndpointRegistryConfig{root.path.string(), unique_suffix(), 2, 32});
  require(endpoint.start(descriptor()).ok(), "active endpoint did not start");
  const std::string descriptor_path = endpoint.descriptor_path();
  WindowsIpcServer server(endpoint, backend, handler, observer,
                          WindowsIpcServerConfig{1500ms, 16, 0x8664});
  require(server.start(), "active server did not start");
  OwnedHandle client = connect_client(endpoint.pipe_name());
  require(client.get() != nullptr, "client could not connect to the server pipe");
  complete_handshake(client.get());
  require(handler.wait_until_entered(2000), "authenticated handler was not entered");
  const auto started = std::chrono::steady_clock::now();
  server.stop();
  const auto elapsed = std::chrono::steady_clock::now() - started;
  require(elapsed < 1s, "idle authenticated client prevented bounded shutdown");
  require(handler.exited.load(), "active handler did not observe pipe cancellation");
  require(observer.stopped.load(), "active server did not report stopped");
  std::error_code error;
  require(!std::filesystem::exists(descriptor_path, error),
          "server stop left its discovery descriptor published");
}

struct ConnectedPipePair {
  OwnedHandle server;
  OwnedHandle client;
};

ConnectedPipePair create_connected_pipe_pair() {
  const std::string pipe_name = "\\\\.\\pipe\\aemcp-transport-test-" + unique_suffix();
  OwnedHandle server(
      CreateNamedPipeW(widen(pipe_name).c_str(),
                       PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                       PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, nullptr));
  require(server.get() != INVALID_HANDLE_VALUE, "could not create backpressure pipe");
  OwnedHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  require(event.get() != nullptr, "could not create connect event");
  OVERLAPPED operation{};
  operation.hEvent = event.get();
  const BOOL connected = ConnectNamedPipe(server.get(), &operation);
  const DWORD connect_error = connected != 0 ? ERROR_SUCCESS : GetLastError();
  require(connected != 0 || connect_error == ERROR_IO_PENDING,
          "backpressure pipe did not begin connecting");
  OwnedHandle client = connect_client(pipe_name);
  require(client.get() != nullptr, "backpressure client could not connect");
  if (connect_error == ERROR_IO_PENDING) {
    require(WaitForSingleObject(event.get(), 2000) == WAIT_OBJECT_0,
            "backpressure pipe connect timed out");
    DWORD transferred = 0;
    require(GetOverlappedResult(server.get(), &operation, &transferred, FALSE) != 0,
            "backpressure pipe connect failed");
  }
  return {std::move(server), std::move(client)};
}

void non_reading_client_write_times_out() {
  ConnectedPipePair pair = create_connected_pipe_pair();
  const HANDLE server_handle = pair.server.release();
  const int fd = _open_osfhandle(reinterpret_cast<intptr_t>(server_handle), _O_RDWR | _O_BINARY);
  require(fd >= 0, "could not wrap the backpressure server HANDLE");
  std::vector<std::uint8_t> payload(16U * 1024U * 1024U, 0x5aU);
  errno = 0;
  const auto started = std::chrono::steady_clock::now();
  const int sent = aemcp::native::transport_send(fd, payload.data(), payload.size(), 100);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  const int send_errno = errno;
  (void)_close(fd);
  require(sent < 0 && send_errno == ETIMEDOUT, "backpressure did not time out");
  require(elapsed < 1s, "backpressure write exceeded its bounded timeout");
}

}  // namespace

int main() {
  waiting_listener_shutdown_is_bounded();
  idle_authenticated_client_shutdown_is_bounded();
  non_reading_client_write_times_out();
  std::cout << "win_ipc_server_windows_test: PASS\n";
  return 0;
}
