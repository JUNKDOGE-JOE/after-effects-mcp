#include "aemcp_native/native_rpc_connection.hpp"

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

using namespace std::chrono_literals;
using namespace aemcp::native;

constexpr std::string_view kSession = "11111111-1111-4111-8111-111111111111";
constexpr std::string_view kHost = "22222222-2222-4222-8222-222222222222";

void require(bool condition, std::string_view message) {
  if (!condition)
    throw std::runtime_error(std::string(message));
}

class TestDispatcherClock final : public Clock {
public:
  [[nodiscard]] TimePoint now() const noexcept override {
    return TimePoint{} + 1h;
  }
};

class TestSessionClock final : public rpc::SessionClock {
public:
  [[nodiscard]] std::uint64_t now_unix_ms() const noexcept override {
    return now_.fetch_add(1);
  }

private:
  mutable std::atomic<std::uint64_t> now_{1'900'000'000'000ULL};
};

class TestIdleSignal final : public HostIdleSignal {
public:
  [[nodiscard]] bool request_idle() noexcept override {
    ++calls;
    return true;
  }
  std::atomic<std::size_t> calls{0};
};

class TestObserver final : public NativeRpcObserver {
public:
  void on_rpc_event(std::string_view, std::string_view,
                    std::string_view) noexcept override {}

  void on_rpc_terminal(const Completion &, std::string_view request_digest,
                       std::string_view postcondition_digest, std::uint64_t,
                       std::uint64_t) noexcept override {
    std::lock_guard lock(mutex);
    ++terminals;
    last_request_digest = request_digest;
    last_postcondition_digest = postcondition_digest;
  }

  std::mutex mutex;
  std::size_t terminals{0};
  std::string last_request_digest;
  std::string last_postcondition_digest;
};

class TestHost final : public HostApi {
public:
  [[nodiscard]] NativeProgramHostResult
  execute_native_program(const NativeProgram &program, std::string_view,
                         std::string_view, TimePoint) override {
    ++programs;
    std::vector<NativeProgramOperationOutcome> operations;
    for (std::size_t index = 0; index < program.operations.size(); ++index) {
      operations.push_back({
          index,
          program.operations[index].primitive_id,
          JsonValue{nullptr},
      });
    }
    return NativeProgramHostResult::success(std::move(operations), {});
  }

  [[nodiscard]] HostProjectGraphInvalidationResult
  invalidate_project_graph(TimePoint) override {
    ++invalidations;
    return HostProjectGraphInvalidationResult::success({true, 9});
  }

  std::size_t programs{0};
  std::size_t invalidations{0};
};

std::vector<std::uint8_t> frame(std::string_view json) {
  std::vector<std::uint8_t> result(4 + json.size());
  const auto size = static_cast<std::uint32_t>(json.size());
  result[0] = static_cast<std::uint8_t>(size >> 24U);
  result[1] = static_cast<std::uint8_t>(size >> 16U);
  result[2] = static_cast<std::uint8_t>(size >> 8U);
  result[3] = static_cast<std::uint8_t>(size);
  std::copy(json.begin(), json.end(), result.begin() + 4);
  return result;
}

void write_all(int socket_fd, const std::vector<std::uint8_t> &bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count =
        ::send(socket_fd, bytes.data() + offset, bytes.size() - offset, 0);
    if (count <= 0)
      throw std::runtime_error("socket write failed");
    offset += static_cast<std::size_t>(count);
  }
}

void read_exact(int socket_fd, std::uint8_t *output, std::size_t size) {
  std::size_t offset = 0;
  while (offset < size) {
    pollfd socket{socket_fd, POLLIN, 0};
    const int polled = ::poll(&socket, 1, 2000);
    if (polled <= 0 || (socket.revents & POLLIN) == 0) {
      throw std::runtime_error("socket read timed out");
    }
    const ssize_t count = ::recv(socket_fd, output + offset, size - offset, 0);
    if (count <= 0)
      throw std::runtime_error("socket read failed");
    offset += static_cast<std::size_t>(count);
  }
}

std::string read_frame(int socket_fd) {
  std::uint8_t prefix[4]{};
  read_exact(socket_fd, prefix, 4);
  const std::uint32_t size = (static_cast<std::uint32_t>(prefix[0]) << 24U) |
                             (static_cast<std::uint32_t>(prefix[1]) << 16U) |
                             (static_cast<std::uint32_t>(prefix[2]) << 8U) |
                             static_cast<std::uint32_t>(prefix[3]);
  std::string body(size, '\0');
  read_exact(socket_fd, reinterpret_cast<std::uint8_t *>(body.data()),
             body.size());
  return body;
}

void program_and_control_round_trip() {
  TestDispatcherClock dispatcher_clock;
  TestSessionClock session_clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), dispatcher_clock);
  TestObserver observer;
  TestIdleSignal idle_signal;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock,
      NativeRpcRuntimeInfo{"1.0.0", "25.6.61", 61, "26.0", 1,
                           std::string(kHost)},
      observer, idle_signal);

  int sockets[2]{-1, -1};
  require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0,
          "socketpair failed");
  AuthenticatedConnection connection;
  connection.socket_fd = sockets[0];
  connection.peer.connection_id = "connection-1";
  connection.peer.host_instance_id = kHost;
  connection.session_id = kSession;
  connection.session_generation = 1;
  std::thread worker([&] { handler.serve(connection); });

  write_all(
      sockets[1],
      frame(
          R"({"wireVersion":1,"kind":"request","requestId":"hello-1","method":"hello","params":{"supportedWireVersions":{"minimum":1,"maximum":1},"client":{"component":"core-broker","version":"1.0.0","instanceId":"33333333-3333-4333-8333-333333333333"},"nonce":"abcdefghijklmnopqrstuvwxyzABCDEF"}})"));
  const std::string hello = read_frame(sockets[1]);
  require(hello.find("\"method\":\"hello\"") != std::string::npos &&
              hello.find("\"ok\":true") != std::string::npos,
          "hello did not complete");

  write_all(
      sockets[1],
      frame(
          R"({"wireVersion":1,"kind":"request","sessionId":"11111111-1111-4111-8111-111111111111","requestId":"capabilities-1","method":"capabilities","params":{"detail":"full","limit":1}})"));
  const std::string capabilities = read_frame(sockets[1]);
  require(capabilities.find("\"id\":\"ae.native.exec\"") != std::string::npos,
          "capabilities omitted the sole native route");
  require(capabilities.find("\"primitiveCount\":23") != std::string::npos,
          "capabilities omitted the primitive catalog");

  write_all(
      sockets[1],
      frame(
          R"({"wireVersion":1,"kind":"request","sessionId":"11111111-1111-4111-8111-111111111111","requestId":"invoke-1","method":"invoke","params":{"capabilityId":"ae.native.exec","capabilityVersion":1,"arguments":{"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]}}})"));
  const std::string progress = read_frame(sockets[1]);
  require(progress.find("\"kind\":\"progress\"") != std::string::npos,
          "invoke did not publish queued progress");

  TestHost host;
  const DrainBatch program = dispatcher.drain(host);
  require(program.completions.size() == 1 && program.completions[0].ok,
          "native program did not drain");
  const std::string terminal = read_frame(sockets[1]);
  require(terminal.find("\"method\":\"invoke\"") != std::string::npos &&
              terminal.find("\"capabilityId\":\"ae.native.exec\"") !=
                  std::string::npos &&
              terminal.find("\"engine\":\"native-aegp\"") != std::string::npos,
          "native program terminal lost provenance");
  require(host.programs == 1, "native program did not execute exactly once");

  write_all(
      sockets[1],
      frame(
          R"({"wireVersion":1,"kind":"request","sessionId":"11111111-1111-4111-8111-111111111111","requestId":"invalidate-1","method":"invalidateGraph","params":{"reason":"cep-jsx"}})"));
  const std::string invalidation_progress = read_frame(sockets[1]);
  require(invalidation_progress.find("\"kind\":\"progress\"") !=
              std::string::npos,
          "graph invalidation did not publish queued progress");
  const DrainBatch graph = dispatcher.drain(host);
  require(graph.completions.size() == 1 && graph.completions[0].ok,
          "graph invalidation did not drain");
  const std::string invalidated = read_frame(sockets[1]);
  require(invalidated.find("\"method\":\"invalidateGraph\"") !=
                  std::string::npos &&
              invalidated.find("\"generation\":9") != std::string::npos,
          "graph invalidation terminal was incorrect");
  require(host.invalidations == 1, "graph invalidation did not execute once");
  require(idle_signal.calls == 2, "idle scheduling count was incorrect");

  {
    std::lock_guard lock(observer.mutex);
    require(observer.terminals == 2, "observer terminal count was incorrect");
    require(observer.last_request_digest.size() == 64,
            "observer request digest was missing");
  }

  (void)::shutdown(sockets[1], SHUT_RDWR);
  (void)::close(sockets[1]);
  worker.join();
  (void)::close(sockets[0]);
}

void evidence_failure_classification_is_program_level() {
  require(post_dispatch_evidence_failure_code(true) ==
              "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "write program evidence failure was not ambiguous");
  require(post_dispatch_evidence_failure_code(false) == "CAPABILITY_FAILED",
          "read program evidence failure was not safe");
  require(post_dispatch_evidence_failure_code(false, true) ==
              "NATIVE_UNAVAILABLE",
          "graph evidence failure was not classified as control-plane failure");
}

} // namespace

int main() {
  try {
    evidence_failure_classification_is_program_level();
    program_and_control_round_trip();
  } catch (const std::exception &error) {
    std::cerr << "native_rpc_connection_test failed: " << error.what() << '\n';
    return 1;
  }
  std::cout << "native_rpc_connection_test passed\n";
  return 0;
}
