#include "aemcp_native/native_rpc_connection.hpp"

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace std::chrono_literals;
using aemcp::native::AuthenticatedConnection;
using aemcp::native::Clock;
using aemcp::native::Completion;
using aemcp::native::EnqueueCode;
using aemcp::native::HostApi;
using aemcp::native::HostDispatcher;
using aemcp::native::HostReadResult;
using aemcp::native::HostWriteResult;
using aemcp::native::NativeRpcConnectionHandler;
using aemcp::native::NativeRpcObserver;
using aemcp::native::NativeRpcRuntimeInfo;
using aemcp::native::ProjectSummary;
using aemcp::native::Request;
using aemcp::native::TimePoint;
using aemcp::native::kProjectSummaryCapability;
using aemcp::native::kProjectFolderCreateCapability;
using aemcp::native::rpc::SessionClock;

constexpr std::string_view kSession = "11111111-1111-4111-8111-111111111111";
constexpr std::string_view kHost = "22222222-2222-4222-8222-222222222222";
constexpr std::string_view kClient = "33333333-3333-4333-8333-333333333333";
constexpr std::string_view kZeroDigest =
    "0000000000000000000000000000000000000000000000000000000000000000";

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

class FakeDispatcherClock final : public Clock {
 public:
  [[nodiscard]] TimePoint now() const noexcept override {
    return TimePoint{} + std::chrono::milliseconds(now_ms_.load());
  }

 private:
  std::atomic<std::int64_t> now_ms_{3'600'000};
};

class FakeSessionClock final : public SessionClock {
 public:
  [[nodiscard]] std::uint64_t now_unix_ms() const noexcept override {
    return now_ms_.load();
  }

 private:
  std::atomic<std::uint64_t> now_ms_{1'900'000'000'000ULL};
};

class FakeHost final : public HostApi {
 public:
  [[nodiscard]] HostReadResult read_project_summary(TimePoint) override {
    ++read_calls;
    return HostReadResult::success(summary);
  }

  [[nodiscard]] HostWriteResult create_project_folder(
      std::string_view name, TimePoint) override {
    ++write_calls;
    observed_folder_name = std::string(name);
    if (!write_error_code.empty()) {
      return HostWriteResult::failure(write_error_code, "fake write error");
    }
    auto result = folder_result;
    result.folder_name = std::string(name);
    return HostWriteResult::success(std::move(result));
  }

  ProjectSummary summary{true, "fixture.aep", 3};
  aemcp::native::ProjectFolderCreated folder_result{true, 101, "AI Assets", 0, 3, 4};
  std::string write_error_code;
  std::string observed_folder_name;
  int read_calls{0};
  int write_calls{0};
};

struct EventRecord {
  std::string event;
  std::string request_id;
  std::string decision;
};

struct TerminalRecord {
  std::string request_id;
  bool ok{false};
  std::string error_code;
  std::string request_digest;
  std::string postcondition_digest;
};

class RecordingObserver final : public NativeRpcObserver {
 public:
  void on_rpc_event(
      std::string_view event,
      std::string_view request_id,
      std::string_view decision) noexcept override {
    try {
      std::lock_guard lock(mutex_);
      events_.push_back({std::string(event), std::string(request_id), std::string(decision)});
    } catch (...) {
    }
  }

  void on_rpc_terminal(
      const Completion& completion,
      std::string_view request_digest,
      std::string_view postcondition_digest,
      std::uint64_t,
      std::uint64_t) noexcept override {
    try {
      std::lock_guard lock(mutex_);
      terminals_.push_back({
          completion.request_id,
          completion.ok,
          completion.error_code,
          std::string(request_digest),
          std::string(postcondition_digest),
      });
    } catch (...) {
    }
  }

  [[nodiscard]] bool has_event(
      std::string_view event,
      std::string_view request_id,
      std::string_view decision) const {
    std::lock_guard lock(mutex_);
    for (const EventRecord& item : events_) {
      if (item.event == event && item.request_id == request_id && item.decision == decision) {
        return true;
      }
    }
    return false;
  }

  [[nodiscard]] TerminalRecord terminal(std::string_view request_id) const {
    std::lock_guard lock(mutex_);
    for (const TerminalRecord& item : terminals_) {
      if (item.request_id == request_id) return item;
    }
    return {};
  }

 private:
  mutable std::mutex mutex_;
  std::vector<EventRecord> events_;
  std::vector<TerminalRecord> terminals_;
};

NativeRpcRuntimeInfo runtime() {
  return {
      "0.0.0-test",
      "25.6",
      61,
      "26.3.0",
      87,
      std::string(kHost),
      "33afff4311c76b6671101c9f2a15d2bbfe328c43dd7b539c0825b24ffa416be8",
      "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a",
      "d9defb50a560e02ee4ca2e46abccf903136b2f65f51a74fd24baaafc8bedcb0f",
  };
}

AuthenticatedConnection connection(int socket_fd, std::string route, std::uint32_t generation) {
  AuthenticatedConnection value;
  value.socket_fd = socket_fd;
  value.peer.pid = 100;
  value.peer.pid_version = 1;
  value.peer.uid = 501;
  value.peer.audit_session = 7;
  value.peer.connection_id = std::move(route);
  value.peer.host_instance_id = std::string(kHost);
  value.session_id = std::string(kSession);
  value.session_generation = generation;
  return value;
}

std::vector<std::uint8_t> frame(std::string_view json) {
  require(!json.empty() && json.size() <= 65'536, "test JSON frame size is invalid");
  std::vector<std::uint8_t> output(json.size() + 4);
  const auto size = static_cast<std::uint32_t>(json.size());
  output[0] = static_cast<std::uint8_t>(size >> 24U);
  output[1] = static_cast<std::uint8_t>(size >> 16U);
  output[2] = static_cast<std::uint8_t>(size >> 8U);
  output[3] = static_cast<std::uint8_t>(size);
  std::memcpy(output.data() + 4, json.data(), json.size());
  return output;
}

void write_all(int socket_fd, const std::vector<std::uint8_t>& bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t sent = ::send(socket_fd, bytes.data() + offset, bytes.size() - offset, 0);
    if (sent < 0 && errno == EINTR) continue;
    require(sent > 0, "test client could not write a request frame");
    offset += static_cast<std::size_t>(sent);
  }
}

void send_json(int socket_fd, std::string_view json) {
  write_all(socket_fd, frame(json));
}

bool wait_readable(int socket_fd, std::chrono::milliseconds timeout) {
  pollfd item{socket_fd, POLLIN, 0};
  int result = 0;
  do {
    result = ::poll(&item, 1, static_cast<int>(timeout.count()));
  } while (result < 0 && errno == EINTR);
  return result > 0 && (item.revents & POLLIN) != 0;
}

void read_exact(int socket_fd, std::uint8_t* output, std::size_t size) {
  std::size_t offset = 0;
  while (offset < size) {
    require(wait_readable(socket_fd, 2s), "timed out waiting for response bytes");
    const ssize_t received = ::recv(socket_fd, output + offset, size - offset, 0);
    if (received < 0 && errno == EINTR) continue;
    require(received > 0, "test server closed before a complete response");
    offset += static_cast<std::size_t>(received);
  }
}

std::string read_body(int socket_fd) {
  std::array<std::uint8_t, 4> prefix{};
  read_exact(socket_fd, prefix.data(), prefix.size());
  const std::uint32_t size = (static_cast<std::uint32_t>(prefix[0]) << 24U)
      | (static_cast<std::uint32_t>(prefix[1]) << 16U)
      | (static_cast<std::uint32_t>(prefix[2]) << 8U)
      | static_cast<std::uint32_t>(prefix[3]);
  require(size > 0 && size <= 65'536, "response frame prefix is invalid");
  std::vector<std::uint8_t> body(size);
  read_exact(socket_fd, body.data(), body.size());
  return std::string(reinterpret_cast<const char*>(body.data()), body.size());
}

template <typename Predicate>
void wait_until(Predicate&& predicate, const std::string& label) {
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (!predicate()) {
    if (std::chrono::steady_clock::now() >= deadline) fail("timed out waiting for " + label);
    std::this_thread::sleep_for(2ms);
  }
}

std::string hello_json() {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"requestId\":\"hello-1\","
      "\"method\":\"hello\",\"params\":{\"supportedWireVersions\":{\"minimum\":1,"
      "\"maximum\":1},\"client\":{\"component\":\"core-broker\",\"version\":\"0.9.2\","
      "\"instanceId\":\"" + std::string(kClient)
      + "\"},\"nonce\":\"abcdefghijklmnopqrstuvwxyzABCDEF\"}}";
}

std::string capabilities_json() {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession)
      + "\",\"requestId\":\"capabilities-1\",\"method\":\"capabilities\","
        "\"params\":{\"ids\":[\"ae.project.summary\"],\"detail\":\"full\",\"limit\":1}}";
}

std::string folder_capabilities_json() {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession)
      + "\",\"requestId\":\"capabilities-folder\",\"method\":\"capabilities\","
        "\"params\":{\"ids\":[\"ae.project.folder.create\"],\"detail\":\"full\","
        "\"limit\":1}}";
}

std::string invoke_json(
    std::string_view request_id,
    std::string_view session_id = kSession) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(session_id) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.summary\","
        "\"capabilityVersion\":1,\"arguments\":{}}}";
}

std::string folder_invoke_json(
    std::string_view request_id,
    std::string_view key = "folder-intent-001",
    std::string_view name = "AI Assets") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.folder.create\","
        "\"capabilityVersion\":1,\"arguments\":{\"name\":\""
      + std::string(name) + "\",\"idempotencyKey\":\"" + std::string(key) + "\"}}}";
}

std::string cancel_json(std::string_view request_id, std::string_view target_request_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"cancel\",\"params\":{\"targetRequestId\":\""
      + std::string(target_request_id) + "\"}}";
}

void require_contains(
    const std::string& value, std::string_view expected, const std::string& label) {
  require(value.find(expected) != std::string::npos, label + " omitted " + std::string(expected));
}

void finish_connection(int client_fd, int server_fd, std::thread& worker) {
  (void)::shutdown(client_fd, SHUT_RDWR);
  (void)::close(client_fd);
  worker.join();
  (void)::close(server_fd);
}

void hello_capabilities_invoke_cancel_and_fencing_work() {
  FakeDispatcherClock dispatcher_clock;
  FakeSessionClock session_clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), dispatcher_clock);
  RecordingObserver observer;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer);
  std::array<int, 2> sockets{};
  require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) == 0, "socketpair failed");
  const AuthenticatedConnection authenticated = connection(sockets[1], "route-e2e", 7);
  std::thread worker([&] { handler.serve(authenticated); });

  send_json(sockets[0], hello_json());
  const std::string hello = read_body(sockets[0]);
  require_contains(hello, "\"method\":\"hello\"", "hello response");
  require_contains(hello, "\"sessionGeneration\":7", "hello response");
  require_contains(hello, "\"ok\":true", "hello response");

  send_json(sockets[0], hello_json());
  const std::string repeated_hello = read_body(sockets[0]);
  require_contains(repeated_hello, "\"code\":\"INVALID_REQUEST\"", "repeated hello");
  require_contains(repeated_hello, "\"method\":\"hello\"", "repeated hello");

  send_json(sockets[0], invoke_json(
      "wrong-session", "44444444-4444-4444-8444-444444444444"));
  const std::string stale = read_body(sockets[0]);
  require_contains(stale, "\"code\":\"SESSION_STALE\"", "stale session response");
  require_contains(stale, "\"ok\":false", "stale session response");

  send_json(sockets[0], capabilities_json());
  const std::string capabilities = read_body(sockets[0]);
  require_contains(capabilities, "\"method\":\"capabilities\"", "capabilities response");
  require_contains(capabilities, "\"id\":\"ae.project.summary\"", "capabilities response");
  require_contains(capabilities,
      "\"queryDigest\":\"aa3c66bc21e50b6a35db9c3cb12fcb1627694cd8f9fc411f21f7e3de46b3e56a\"",
      "capabilities response");

  send_json(sockets[0], folder_capabilities_json());
  const std::string folder_capabilities = read_body(sockets[0]);
  require_contains(folder_capabilities, "\"id\":\"ae.project.folder.create\"",
      "folder capabilities response");
  require_contains(folder_capabilities, "\"idempotency\":\"idempotency-key\"",
      "folder capabilities response");
  require_contains(folder_capabilities,
      "\"contractDigest\":\"d9defb50a560e02ee4ca2e46abccf903136b2f65f51a74fd24baaafc8bedcb0f\"",
      "folder capabilities response");

  send_json(sockets[0], invoke_json("invoke-read"));
  const std::string progress = read_body(sockets[0]);
  require_contains(progress, "\"event\":\"progress\"", "invoke progress");
  require_contains(progress, "\"phase\":\"queued\"", "invoke progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued invoke");
  FakeHost host;
  const auto read_batch = dispatcher.drain(host);
  require(read_batch.completions.size() == 1 && read_batch.completions[0].ok,
      "owner dispatcher did not produce the read result");
  const std::string summary = read_body(sockets[0]);
  require_contains(summary, "\"engine\":\"native-aegp\"", "summary response");
  require_contains(summary, "\"projectName\":\"fixture.aep\"", "summary response");
  require(summary.find(kZeroDigest) == std::string::npos,
      "summary response forged a zero evidence digest");
  wait_until([&] { return !observer.terminal("invoke-read").request_id.empty(); },
      "read terminal audit");
  const TerminalRecord read_terminal = observer.terminal("invoke-read");
  require(read_terminal.ok && read_terminal.request_digest.size() == 64
      && read_terminal.postcondition_digest
          == "0e82d012b2b7f26e310703c35b1d82e744809137f1ea5e6d1920aa29c0baca77",
      "read terminal evidence was not deterministic and verified");

  send_json(sockets[0], folder_invoke_json("invoke-folder"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"", "folder progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued folder invoke");
  const auto folder_batch = dispatcher.drain(host);
  require(folder_batch.completions.size() == 1 && folder_batch.completions[0].ok,
      "owner dispatcher did not produce the folder result");
  const std::string folder = read_body(sockets[0]);
  require_contains(folder, "\"capabilityId\":\"ae.project.folder.create\"",
      "folder response");
  require_contains(folder, "\"effect\":\"committed\"", "folder response");
  require_contains(folder, "\"undo\":{\"available\":true,\"verified\":true}",
      "folder response");
  require_contains(folder, "\"folderItemId\":101", "folder response");
  require_contains(folder, "\"parentItemId\":0", "folder response");
  require(folder.find("groupId") == std::string::npos,
      "folder response fabricated an SDK undo token");
  wait_until([&] { return !observer.terminal("invoke-folder").request_id.empty(); },
      "folder terminal audit");
  const TerminalRecord folder_terminal = observer.terminal("invoke-folder");
  require(folder_terminal.ok && folder_terminal.request_digest.size() == 64
      && folder_terminal.postcondition_digest
          == "92e14ba749b30d80db977fed12c075e208c353aa7159213944475a2e007ab7cd"
      && host.write_calls == 1 && host.observed_folder_name == "AI Assets",
      "folder terminal evidence was not deterministic and verified");

  send_json(sockets[0], folder_invoke_json("invoke-folder-duplicate"));
  const std::string duplicate = read_body(sockets[0]);
  require_contains(duplicate, "\"code\":\"DUPLICATE_REQUEST\"",
      "same-key folder duplicate");
  require_contains(duplicate, "\"sideEffect\":\"not-started\"",
      "same-key folder duplicate");
  require_contains(duplicate, "\"field\":\"params.arguments.idempotencyKey\"",
      "same-key folder duplicate");
  require(host.write_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key duplicate generated progress or a second host mutation");

  send_json(sockets[0], folder_invoke_json(
      "invoke-folder-conflict", "folder-intent-001", "Other"));
  const std::string conflict = read_body(sockets[0]);
  require_contains(conflict, "\"code\":\"DUPLICATE_REQUEST\"",
      "different-args folder duplicate");
  require(host.write_calls == 1, "different-args idempotency conflict reached HostApi");

  send_json(sockets[0], invoke_json("invoke-cancel"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"", "cancel setup progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued cancel target");
  send_json(sockets[0], cancel_json("cancel-1", "invoke-cancel"));
  const std::string cancel = read_body(sockets[0]);
  require_contains(cancel, "\"state\":\"queued-cancelled\"", "cancel response");
  require_contains(cancel, "\"terminalResponseExpected\":true", "cancel response");
  const std::string cancelled_terminal = read_body(sockets[0]);
  require_contains(cancelled_terminal, "\"code\":\"CANCELLED\"", "cancel terminal");

  require(dispatcher.enqueue(Request{
      "wrong-generation",
      std::string(kProjectSummaryCapability),
      dispatcher_clock.now() + 1s,
      "route-e2e",
      8,
  }).code == EnqueueCode::kAccepted, "generation fence setup enqueue failed");
  require(dispatcher.enqueue(Request{
      "missing-evidence",
      std::string(kProjectSummaryCapability),
      dispatcher_clock.now() + 1s,
      "route-e2e",
      7,
  }).code == EnqueueCode::kAccepted, "missing evidence setup enqueue failed");
  require(dispatcher.drain(host).completions.size() == 2,
      "fencing setup completions did not drain");
  wait_until([&] {
    return observer.has_event("terminal.detached", "wrong-generation", "route-mismatch")
        && observer.has_event(
            "terminal.detached", "missing-evidence", "missing-request-evidence");
  }, "exact route and evidence fencing");
  require(!wait_readable(sockets[0], 150ms),
      "detached completion leaked a response onto the active connection");

  finish_connection(sockets[0], sockets[1], worker);
  require(dispatcher.enqueue(Request{
      "folder-after-disconnect",
      std::string(kProjectFolderCreateCapability),
      dispatcher_clock.now() + 1s,
      "route-e2e",
      8,
      "AI Assets",
      "folder-intent-001",
      "6e324ac691906ea2f87cfe960f0f5a51d38facb597e8b3499a93a76144727177",
  }).code == EnqueueCode::kDuplicateRequest,
      "successful folder business fence was lost across broker disconnect");
  require(dispatcher.enqueue(Request{
      "old-generation",
      std::string(kProjectSummaryCapability),
      dispatcher_clock.now() + 1s,
      "route-e2e",
      7,
  }).code == EnqueueCode::kStaleRoute, "closed session generation was not fenced");
  require(dispatcher.enqueue(Request{
      "new-generation",
      std::string(kProjectSummaryCapability),
      dispatcher_clock.now() + 1s,
      "route-e2e",
      8,
  }).code == EnqueueCode::kAccepted, "new session generation was incorrectly fenced");
  (void)dispatcher.shutdown();
}

void invalid_postcondition_becomes_structured_failure() {
  FakeDispatcherClock dispatcher_clock;
  FakeSessionClock session_clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), dispatcher_clock);
  RecordingObserver observer;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer);
  std::array<int, 2> sockets{};
  require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) == 0, "socketpair failed");
  const AuthenticatedConnection authenticated = connection(sockets[1], "route-invalid", 3);
  std::thread worker([&] { handler.serve(authenticated); });

  send_json(sockets[0], hello_json());
  require_contains(read_body(sockets[0]), "\"ok\":true", "invalid evidence hello");
  send_json(sockets[0], invoke_json("invalid-result"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"", "invalid evidence progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "invalid evidence invoke");
  FakeHost host;
  host.summary.item_count = -1;
  require(dispatcher.drain(host).completions.size() == 1,
      "invalid host result did not reach transport validation");
  const std::string failure = read_body(sockets[0]);
  require_contains(failure, "\"code\":\"CAPABILITY_FAILED\"", "invalid evidence failure");
  require_contains(failure, "\"capabilityId\":\"ae.project.summary\"", "invalid evidence failure");
  require(failure.find(kZeroDigest) == std::string::npos,
      "invalid evidence failure forged a zero digest");
  wait_until([&] { return !observer.terminal("invalid-result").request_id.empty(); },
      "invalid evidence terminal audit");
  const TerminalRecord terminal = observer.terminal("invalid-result");
  require(!terminal.ok && terminal.error_code == "CAPABILITY_FAILED"
      && terminal.request_digest.size() == 64 && terminal.postcondition_digest.empty(),
      "invalid postcondition was audited as a verified success");
  require(observer.has_event("terminal.validation", "invalid-result", "invalid-evidence"),
      "invalid postcondition did not emit a validation decision");

  send_json(sockets[0], folder_invoke_json(
      "invalid-folder-result", "folder-intent-901", "AI Assets"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "invalid folder evidence progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "invalid folder evidence invoke");
  host.folder_result.item_count_after = 5;
  require(dispatcher.drain(host).completions.size() == 1,
      "invalid folder result did not reach transport validation");
  const std::string folder_failure = read_body(sockets[0]);
  require_contains(folder_failure, "\"code\":\"POSSIBLY_SIDE_EFFECTING_FAILURE\"",
      "invalid folder evidence failure");
  require_contains(folder_failure, "\"sideEffect\":\"may-have-occurred\"",
      "invalid folder evidence failure");
  require_contains(folder_failure, "\"capabilityId\":\"ae.project.folder.create\"",
      "invalid folder evidence failure");
  wait_until([&] {
    return !observer.terminal("invalid-folder-result").request_id.empty();
  }, "invalid folder terminal audit");
  const TerminalRecord folder_terminal = observer.terminal("invalid-folder-result");
  require(!folder_terminal.ok
      && folder_terminal.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
      && folder_terminal.postcondition_digest.empty() && host.write_calls == 1,
      "invalid folder evidence was mislabeled as a safe failure");

  send_json(sockets[0], folder_invoke_json(
      "invalid-folder-retry", "folder-intent-901", "AI Assets"));
  const std::string fenced = read_body(sockets[0]);
  require_contains(fenced, "\"code\":\"DUPLICATE_REQUEST\"",
      "ambiguous folder retry fence");
  require(host.write_calls == 1,
      "ambiguous folder evidence allowed a second host mutation");

  finish_connection(sockets[0], sockets[1], worker);
  (void)dispatcher.shutdown();
}

void construction_failure_is_contained_by_noexcept_boundary() {
  FakeDispatcherClock dispatcher_clock;
  FakeSessionClock session_clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), dispatcher_clock);
  RecordingObserver observer;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer);
  AuthenticatedConnection invalid = connection(-1, std::string(1'025, 'x'), 1);
  handler.serve(invalid);
  require(observer.has_event(
      "connection", "none", "codec-or-transport-failure"),
      "front-door construction exception escaped the noexcept serve boundary");
  require(dispatcher.running(), "construction failure changed dispatcher lifecycle state");
  (void)dispatcher.shutdown();
}

}  // namespace

int main() {
  hello_capabilities_invoke_cancel_and_fencing_work();
  invalid_postcondition_becomes_structured_failure();
  construction_failure_is_contained_by_noexcept_boundary();
  std::cout << "native_rpc_connection_test: PASS\n";
  return 0;
}
