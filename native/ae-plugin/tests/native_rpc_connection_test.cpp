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
  enum class ProgramMode {
    kSuccess,
    kCompletedSafeFailure,
    kInvalidEvidence,
  };

  [[nodiscard]] NativeProgramHostResult
  execute_native_program(const NativeProgram &program, std::string_view,
                         std::string_view, TimePoint) override {
    ++programs;
    if (program_mode == ProgramMode::kInvalidEvidence) {
      return NativeProgramHostResult::success({}, {});
    }
    std::vector<NativeProgramOperationOutcome> operations;
    if (program_mode == ProgramMode::kCompletedSafeFailure) {
      operations.push_back({
          0,
          program.operations[0].primitive_id,
          JsonValue{nullptr},
      });
      return NativeProgramHostResult::failure(
          "PRECONDITION_FAILED", "write precondition was not satisfied", {},
          {0}, 1, false, NativeProgramDisposition::kCompleted,
          std::move(operations), {});
    }
    for (std::size_t index = 0; index < program.operations.size(); ++index) {
      operations.push_back({
          index,
          program.operations[index].primitive_id,
          JsonValue{nullptr},
      });
    }
    return NativeProgramHostResult::success(std::move(operations), {});
  }

  [[nodiscard]] HostActionResult
  begin_undo_group(std::string_view, TimePoint) override {
    ++undo_begins;
    return undo_begin_ok
               ? HostActionResult::success()
               : HostActionResult::failure(
                     "CAPABILITY_FAILED", "Undo group could not be opened");
  }

  [[nodiscard]] HostActionResult end_undo_group(TimePoint) override {
    ++undo_ends;
    return undo_end_ok
               ? HostActionResult::success()
               : HostActionResult::failure(
                     "POSSIBLY_SIDE_EFFECTING_FAILURE",
                     "Undo group could not be closed");
  }

  [[nodiscard]] HostProjectGraphInvalidationResult
  invalidate_project_graph(TimePoint) override {
    ++invalidations;
    return HostProjectGraphInvalidationResult::success({true, 9});
  }

  std::size_t programs{0};
  std::size_t invalidations{0};
  std::size_t undo_begins{0};
  std::size_t undo_ends{0};
  ProgramMode program_mode{ProgramMode::kSuccess};
  bool undo_begin_ok{true};
  bool undo_end_ok{true};
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

std::string write_program_request(std::string_view request_id,
                                  std::string_view operation_key) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\"" +
         std::string(kSession) + "\",\"requestId\":\"" +
         std::string(request_id) +
         "\",\"method\":\"invoke\",\"params\":{\"capabilityId\":"
         "\"ae.native.exec\",\"capabilityVersion\":1,\"arguments\":{"
         "\"operationKey\":\"" +
         std::string(operation_key) +
         "\",\"undoGroup\":\"Set duration\",\"operations\":[{"
         "\"op\":\"composition.resolve\",\"args\":{\"locator\":{"
         "\"kind\":\"composition\",\"hostInstanceId\":\"" +
         std::string(kHost) +
         "\",\"sessionId\":\"" + std::string(kSession) +
         "\",\"projectId\":\"33333333-3333-4333-8333-333333333333\","
         "\"generation\":1,\"objectId\":"
         "\"44444444-4444-4444-8444-444444444444\"}},"
         "\"saveAs\":\"composition\"},{\"op\":\"composition.duration.set\","
         "\"args\":{\"composition\":{\"ref\":\"composition\"},"
         "\"duration\":{\"value\":10,\"scale\":1}}}]}}}";
}

void handshake(int socket_fd) {
  write_all(
      socket_fd,
      frame(
          R"({"wireVersion":1,"kind":"request","requestId":"hello-write","method":"hello","params":{"supportedWireVersions":{"minimum":1,"maximum":1},"client":{"component":"core-broker","version":"1.0.0","instanceId":"33333333-3333-4333-8333-333333333333"},"nonce":"abcdefghijklmnopqrstuvwxyzABCDEF"}})"));
  const std::string hello = read_frame(socket_fd);
  require(hello.find("\"method\":\"hello\"") != std::string::npos &&
              hello.find("\"ok\":true") != std::string::npos,
          "write-session hello did not complete");
}

std::string invoke_and_drain(int socket_fd, HostDispatcher &dispatcher,
                             TestHost &host, std::string_view request_id,
                             std::string_view operation_key,
                             bool drain_dispatcher = true) {
  write_all(socket_fd,
            frame(write_program_request(request_id, operation_key)));
  std::string progress;
  try {
    progress = read_frame(socket_fd);
  } catch (const std::exception &error) {
    throw std::runtime_error(std::string(request_id) +
                             " progress read failed: " + error.what());
  }
  require(progress.find("\"kind\":\"event\"") != std::string::npos &&
              progress.find("\"event\":\"progress\"") != std::string::npos &&
              progress.find("\"requestId\":\"" + std::string(request_id) +
                            "\"") != std::string::npos,
          "write request progress was not associated");
  if (drain_dispatcher) {
    const DrainBatch batch = dispatcher.drain(host);
    require(batch.completions.size() == 1,
            "write request did not produce one dispatcher completion");
  }
  try {
    return read_frame(socket_fd);
  } catch (const std::exception &error) {
    throw std::runtime_error(std::string(request_id) +
                             " terminal read failed: " + error.what());
  }
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
  const bool invoke_progress_valid =
      progress.find("\"kind\":\"event\"") != std::string::npos &&
      progress.find("\"event\":\"progress\"") != std::string::npos &&
      progress.find("\"requestId\":\"invoke-1\"") != std::string::npos;

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
  const bool invalidation_progress_valid =
      invalidation_progress.find("\"kind\":\"event\"") != std::string::npos &&
      invalidation_progress.find("\"event\":\"progress\"") !=
          std::string::npos &&
      invalidation_progress.find("\"requestId\":\"invalidate-1\"") !=
          std::string::npos;
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
  require(invoke_progress_valid,
          "invoke progress was not an associated protocol event");
  require(invalidation_progress_valid,
          "graph invalidation progress was not an associated protocol event");
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

void write_terminals_close_the_common_program_contract() {
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
          "write socketpair failed");
  AuthenticatedConnection connection;
  connection.socket_fd = sockets[0];
  connection.peer.connection_id = "connection-write";
  connection.peer.host_instance_id = kHost;
  connection.session_id = kSession;
  connection.session_generation = 1;
  std::thread worker([&] { handler.serve(connection); });

  try {
    handshake(sockets[1]);
    TestHost host;
    const std::string first =
        invoke_and_drain(sockets[1], dispatcher, host, "invoke-write-1",
                         "write-key-success-0001");
    require(first.find("\"ok\":true") != std::string::npos &&
                first.find("\"replayed\":false") != std::string::npos &&
                first.find("\"undo\":{\"available\":true,"
                           "\"groupLabel\":\"Set duration\","
                           "\"verified\":false}") != std::string::npos,
            "committed write terminal lost its Undo envelope");

    const std::string replay =
        invoke_and_drain(sockets[1], dispatcher, host, "invoke-write-2",
                         "write-key-success-0001", false);
    require(replay.find("\"ok\":true") != std::string::npos &&
                replay.find("\"replayed\":true") != std::string::npos &&
                replay.find("\"undo\":{\"available\":true,"
                            "\"groupLabel\":\"Set duration\","
                            "\"verified\":false}") != std::string::npos,
            "committed replay lost its recorded Undo envelope");
    require(host.programs == 1 && host.undo_begins == 1 && host.undo_ends == 1,
            "committed replay performed a second write or Undo group");

    host.undo_begin_ok = false;
    const std::string undo_open =
        invoke_and_drain(sockets[1], dispatcher, host, "invoke-write-3",
                         "write-key-openfail-01");
    require(undo_open.find("\"code\":\"CAPABILITY_FAILED\"") !=
                    std::string::npos &&
                undo_open.find("\"disposition\":\"not-started\"") !=
                    std::string::npos &&
                undo_open.find(
                    "\"operationKey\":\"write-key-openfail-01\"") !=
                    std::string::npos &&
                undo_open.find("\"sideEffect\":\"not-started\"") !=
                    std::string::npos &&
                undo_open.find(
                    "\"undo\":{\"available\":false,\"verified\":false}") !=
                    std::string::npos,
            "Undo-open failure was not a bound not-started write terminal");

    host.undo_begin_ok = true;
    host.undo_end_ok = false;
    const std::string undo_close =
        invoke_and_drain(sockets[1], dispatcher, host, "invoke-write-4",
                         "write-key-closefail-1");
    require(
        undo_close.find("\"code\":\"POSSIBLY_SIDE_EFFECTING_FAILURE\"") !=
                std::string::npos &&
            undo_close.find("\"disposition\":\"possibly-side-effecting\"") !=
                std::string::npos &&
            undo_close.find("\"operationKey\":\"write-key-closefail-1\"") !=
                std::string::npos &&
            undo_close.find("\"sideEffect\":\"may-have-occurred\"") !=
                std::string::npos,
        "Undo-close uncertainty was not bound to the write program");

    host.undo_end_ok = true;
    host.program_mode = TestHost::ProgramMode::kInvalidEvidence;
    const std::string evidence =
        invoke_and_drain(sockets[1], dispatcher, host, "invoke-write-5",
                         "write-key-evidence-001");
    require(
        evidence.find("\"code\":\"POSSIBLY_SIDE_EFFECTING_FAILURE\"") !=
                std::string::npos &&
            evidence.find("\"operationKey\":\"write-key-evidence-001\"") !=
                std::string::npos &&
            evidence.find("\"sideEffect\":\"may-have-occurred\"") !=
                std::string::npos,
        "evidence uncertainty lost its operation binding");

    host.program_mode = TestHost::ProgramMode::kCompletedSafeFailure;
    const std::string completed =
        invoke_and_drain(sockets[1], dispatcher, host, "invoke-write-6",
                         "write-key-safe-fail-01");
    require(completed.find("\"code\":\"PRECONDITION_FAILED\"") !=
                    std::string::npos &&
                completed.find("\"disposition\":\"completed\"") !=
                    std::string::npos &&
                completed.find(
                    "\"operationKey\":\"write-key-safe-fail-01\"") !=
                    std::string::npos &&
                completed.find("\"sideEffect\":\"completed\"") !=
                    std::string::npos,
            "completed safe failure used a generic not-started policy");
  } catch (...) {
    (void)::shutdown(sockets[1], SHUT_RDWR);
    (void)::close(sockets[1]);
    worker.join();
    (void)::close(sockets[0]);
    throw;
  }
  (void)::shutdown(sockets[1], SHUT_RDWR);
  (void)::close(sockets[1]);
  worker.join();
  (void)::close(sockets[0]);
}

} // namespace

int main() {
  try {
    evidence_failure_classification_is_program_level();
    program_and_control_round_trip();
    write_terminals_close_the_common_program_contract();
  } catch (const std::exception &error) {
    std::cerr << "native_rpc_connection_test failed: " << error.what() << '\n';
    return 1;
  }
  std::cout << "native_rpc_connection_test passed\n";
  return 0;
}
