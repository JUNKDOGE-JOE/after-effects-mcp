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
using aemcp::native::HostBitDepthReadResult;
using aemcp::native::HostBitDepthWriteResult;
using aemcp::native::HostCompositionLayersResult;
using aemcp::native::HostCompositionTimeResult;
using aemcp::native::HostDispatcher;
using aemcp::native::HostLayerPropertiesResult;
using aemcp::native::HostReadResult;
using aemcp::native::HostProjectItemsResult;
using aemcp::native::NativeRpcConnectionHandler;
using aemcp::native::NativeRpcObserver;
using aemcp::native::NativeRpcRuntimeInfo;
using aemcp::native::ProjectBitDepthChanged;
using aemcp::native::ProjectSummary;
using aemcp::native::Request;
using aemcp::native::TimePoint;
using aemcp::native::kProjectBitDepthSetCapability;
using aemcp::native::kProjectSummaryCapability;
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

  [[nodiscard]] HostBitDepthReadResult read_project_bit_depth(TimePoint) override {
    ++bit_depth_read_calls;
    if (!bit_depth_read_error_code.empty()) {
      return HostBitDepthReadResult::failure(
          bit_depth_read_error_code, "fake bit-depth read error");
    }
    return HostBitDepthReadResult::success({bits_per_channel});
  }

  [[nodiscard]] HostBitDepthWriteResult set_project_bit_depth(
      std::int32_t target_depth, TimePoint) override {
    ++write_calls;
    observed_target_depth = target_depth;
    if (!write_error_code.empty()) {
      return HostBitDepthWriteResult::failure(
          write_error_code, "fake write error", write_error_field);
    }
    return HostBitDepthWriteResult::success(bit_depth_change);
  }

  [[nodiscard]] HostProjectItemsResult list_project_items(
      const aemcp::native::ProjectItemsQuery& query, TimePoint) override {
    ++project_items_calls;
    aemcp::native::ProjectItemsPage page;
    page.project_locator = locator(
        "project", "77777777-7777-4777-8777-777777777777", query);
    page.total = 1;
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset == 0) {
      page.items.push_back({
          locator("composition", "66666666-6666-4666-8666-666666666666", query),
          "Fixture Comp",
          "composition",
          page.project_locator});
    }
    return HostProjectItemsResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionLayersResult list_composition_layers(
      const aemcp::native::CompositionLayersQuery& query, TimePoint) override {
    ++composition_layers_calls;
    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = "Fixture Comp";
    page.total = 1;
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset == 0) {
      page.layers.push_back({
          {"layer", query.host_instance_id, query.session_id,
              query.composition_locator.project_id,
              query.composition_locator.generation,
              "88888888-8888-4888-8888-888888888888"},
          1,
          "Fixture Text",
          "text",
          true,
          false,
          true,
          std::nullopt,
          std::nullopt});
    }
    return HostCompositionLayersResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionTimeResult read_composition_time(
      const aemcp::native::CompositionTimeQuery& query, TimePoint) override {
    ++composition_time_calls;
    aemcp::native::CompositionTimeRead result;
    result.composition_locator = query.composition_locator;
    result.current_time = {3003, 1000, "3003/1000"};
    return HostCompositionTimeResult::success(std::move(result));
  }

  [[nodiscard]] HostLayerPropertiesResult list_layer_properties(
      const aemcp::native::LayerPropertiesQuery& query, TimePoint) override {
    ++layer_properties_calls;
    aemcp::native::LayerPropertiesPage page;
    page.layer_locator = query.layer_locator;
    page.parent_property_locator = query.parent_property_locator;
    page.layer_name = "Fixture Text";
    page.sample_time = {0, 1};
    page.total = 1;
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset == 0) {
      aemcp::native::LayerPropertyEntry opacity;
      opacity.property_locator = {
          "stream", query.host_instance_id, query.session_id,
          query.layer_locator.project_id, query.layer_locator.generation,
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
      opacity.property_index = 1;
      opacity.name = "Opacity";
      opacity.match_name = "ADBE Opacity";
      opacity.grouping_type = "leaf";
      opacity.can_vary_over_time = true;
      opacity.time_varying = false;
      opacity.value_type = "one-d";
      opacity.value_status = "sampled";
      opacity.value = aemcp::native::LayerPropertyScalarValue{"73.5"};
      page.properties.push_back(std::move(opacity));
    }
    return HostLayerPropertiesResult::success(std::move(page));
  }

  [[nodiscard]] static aemcp::native::ObjectLocator locator(
      std::string kind,
      std::string object_id,
      const aemcp::native::ProjectItemsQuery& query) {
    return {
        std::move(kind),
        query.host_instance_id,
        query.session_id,
        "44444444-4444-4444-8444-444444444444",
        8,
        std::move(object_id)};
  }

  ProjectSummary summary{true, "fixture.aep", 3};
  ProjectBitDepthChanged bit_depth_change{true, 8, 16};
  std::int32_t bits_per_channel{8};
  std::string bit_depth_read_error_code;
  std::string write_error_code;
  std::string write_error_field;
  std::int32_t observed_target_depth{0};
  int read_calls{0};
  int bit_depth_read_calls{0};
  int write_calls{0};
  int project_items_calls{0};
  int composition_layers_calls{0};
  int composition_time_calls{0};
  int layer_properties_calls{0};
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
      "781a620eac1310fb85dc0ac74ae9655fdab0512d370e1039074cd0ff2fb4d7fb",
      "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a",
      "936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e",
      "d5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a",
      "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e",
      "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75",
      "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd",
      "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba",
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

std::string bit_depth_capabilities_json(
    std::string_view request_id, std::string_view capability_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession)
      + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"capabilities\",\"params\":{\"ids\":[\""
      + std::string(capability_id) + "\"],\"detail\":\"full\","
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

std::string bit_depth_read_invoke_json(std::string_view request_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.bit-depth.read\","
        "\"capabilityVersion\":1,\"arguments\":{}}}";
}

std::string bit_depth_set_invoke_json(
    std::string_view request_id,
    std::string_view key = "bit-depth-intent-001",
    std::int32_t target_depth = 16) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.bit-depth.set\","
        "\"capabilityVersion\":1,\"arguments\":{\"targetDepth\":"
      + std::to_string(target_depth) + ",\"idempotencyKey\":\""
      + std::string(key) + "\"}}}";
}

std::string graph_locator_json(std::string_view kind, std::string_view object_id) {
  return "{\"kind\":\"" + std::string(kind)
      + "\",\"hostInstanceId\":\"" + std::string(kHost)
      + "\",\"sessionId\":\"" + std::string(kSession)
      + "\",\"projectId\":\"44444444-4444-4444-8444-444444444444\""
        ",\"generation\":8,\"objectId\":\"" + std::string(object_id) + "\"}";
}

std::string project_items_invoke_json(std::string_view request_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.items.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"offset\":0,\"limit\":25}}}";
}

std::string composition_layers_invoke_json(std::string_view request_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.layers.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + graph_locator_json("composition", "66666666-6666-4666-8666-666666666666")
      + ",\"offset\":0,\"limit\":25}}}";
}

std::string composition_time_invoke_json(std::string_view request_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.time.read\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + graph_locator_json("composition", "66666666-6666-4666-8666-666666666666")
      + "}}}";
}

std::string layer_properties_invoke_json(std::string_view request_id) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.properties.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"layerLocator\":"
      + graph_locator_json("layer", "88888888-8888-4888-8888-888888888888")
      + ",\"parentPropertyLocator\":"
      + graph_locator_json("stream", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      + ",\"offset\":0,\"limit\":25}}}";
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

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-bit-depth-read", "ae.project.bit-depth.read"));
  const std::string bit_depth_read_capabilities = read_body(sockets[0]);
  require_contains(bit_depth_read_capabilities,
      "\"id\":\"ae.project.bit-depth.read\"", "bit-depth read capabilities response");
  require_contains(bit_depth_read_capabilities,
      "\"idempotency\":\"idempotent\"", "bit-depth read capabilities response");
  require_contains(bit_depth_read_capabilities,
      "\"contractDigest\":\"936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e\"",
      "bit-depth read capabilities response");
  require_contains(bit_depth_read_capabilities,
      "\"bitsPerChannel\":{\"enum\":[8,16,32]",
      "bit-depth read capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-bit-depth-set", "ae.project.bit-depth.set"));
  const std::string bit_depth_set_capabilities = read_body(sockets[0]);
  require_contains(bit_depth_set_capabilities,
      "\"id\":\"ae.project.bit-depth.set\"", "bit-depth set capabilities response");
  require_contains(bit_depth_set_capabilities,
      "\"idempotency\":\"idempotency-key\"", "bit-depth set capabilities response");
  require_contains(bit_depth_set_capabilities,
      "\"contractDigest\":\"d5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a\"",
      "bit-depth set capabilities response");
  require_contains(bit_depth_set_capabilities,
      "\"targetDepth\":{\"enum\":[8,16,32]",
      "bit-depth set capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-project-items", "ae.project.items.list"));
  const std::string project_items_capabilities = read_body(sockets[0]);
  require_contains(project_items_capabilities,
      "\"id\":\"ae.project.items.list\"", "project-items capabilities response");
  require_contains(project_items_capabilities,
      "\"contractDigest\":\"64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e\"",
      "project-items capabilities response");
  require_contains(project_items_capabilities,
      "\"projectLocator\"", "project-items capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-composition-layers", "ae.composition.layers.list"));
  const std::string composition_layers_capabilities = read_body(sockets[0]);
  require_contains(composition_layers_capabilities,
      "\"id\":\"ae.composition.layers.list\"",
      "composition-layers capabilities response");
  require_contains(composition_layers_capabilities,
      "\"contractDigest\":\"3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75\"",
      "composition-layers capabilities response");
  require_contains(composition_layers_capabilities,
      "\"compositionLocator\"", "composition-layers capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-composition-time", "ae.composition.time.read"));
  const std::string composition_time_capabilities = read_body(sockets[0]);
  require_contains(composition_time_capabilities,
      "\"id\":\"ae.composition.time.read\"",
      "composition-time capabilities response");
  require_contains(composition_time_capabilities,
      "\"contractDigest\":\"fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd\"",
      "composition-time capabilities response");
  require_contains(composition_time_capabilities,
      "\"secondsRational\"", "composition-time capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-layer-properties", "ae.layer.properties.list"));
  const std::string layer_properties_capabilities = read_body(sockets[0]);
  require_contains(layer_properties_capabilities,
      "\"id\":\"ae.layer.properties.list\"",
      "layer-properties capabilities response");
  require_contains(layer_properties_capabilities,
      "\"contractDigest\":\"a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba\"",
      "layer-properties capabilities response");
  require_contains(layer_properties_capabilities,
      "\"parentPropertyLocator\"", "layer-properties capabilities response");

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

  send_json(sockets[0], bit_depth_read_invoke_json("invoke-bit-depth-read"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "bit-depth read progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued bit-depth read invoke");
  const auto bit_depth_read_batch = dispatcher.drain(host);
  require(bit_depth_read_batch.completions.size() == 1
          && bit_depth_read_batch.completions[0].ok,
      "owner dispatcher did not produce the bit-depth read result");
  const std::string bit_depth_read = read_body(sockets[0]);
  require_contains(bit_depth_read,
      "\"capabilityId\":\"ae.project.bit-depth.read\"", "bit-depth read response");
  require_contains(bit_depth_read, "\"effect\":\"none\"", "bit-depth read response");
  require_contains(bit_depth_read,
      "\"bitsPerChannel\":8", "bit-depth read response");
  require_contains(bit_depth_read,
      "\"kind\":\"project-bit-depth-read\"", "bit-depth read response");
  wait_until([&] {
    return !observer.terminal("invoke-bit-depth-read").request_id.empty();
  }, "bit-depth read terminal audit");
  const TerminalRecord bit_depth_read_terminal =
      observer.terminal("invoke-bit-depth-read");
  require(bit_depth_read_terminal.ok
      && bit_depth_read_terminal.request_digest.size() == 64
      && bit_depth_read_terminal.postcondition_digest
          == aemcp::native::rpc::digest_project_bit_depth_read_postcondition(8)
      && host.bit_depth_read_calls == 1,
      "bit-depth read terminal evidence was not deterministic and verified");

  send_json(sockets[0], project_items_invoke_json("invoke-project-items"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "project-items progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued project-items invoke");
  const auto project_items_batch = dispatcher.drain(host);
  require(project_items_batch.completions.size() == 1
          && project_items_batch.completions[0].ok,
      "owner dispatcher did not produce the project-items result");
  const std::string project_items = read_body(sockets[0]);
  require_contains(project_items,
      "\"capabilityId\":\"ae.project.items.list\"", "project-items response");
  require_contains(project_items,
      "\"kind\":\"project-items-list\"", "project-items response");
  require_contains(project_items,
      "\"returned\":1", "project-items response");
  require_contains(project_items,
      "\"type\":\"composition\"", "project-items response");
  wait_until([&] {
    return !observer.terminal("invoke-project-items").request_id.empty();
  }, "project-items terminal audit");
  const TerminalRecord project_items_terminal =
      observer.terminal("invoke-project-items");
  require(project_items_terminal.ok
          && project_items_terminal.request_digest.size() == 64
          && project_items_terminal.postcondition_digest.size() == 64
          && host.project_items_calls == 1,
      "project-items terminal evidence was not verified");

  send_json(sockets[0], composition_layers_invoke_json("invoke-composition-layers"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition-layers progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition-layers invoke");
  const auto composition_layers_batch = dispatcher.drain(host);
  require(composition_layers_batch.completions.size() == 1
          && composition_layers_batch.completions[0].ok,
      "owner dispatcher did not produce the composition-layers result");
  const std::string composition_layers = read_body(sockets[0]);
  require_contains(composition_layers,
      "\"capabilityId\":\"ae.composition.layers.list\"",
      "composition-layers response");
  require_contains(composition_layers,
      "\"kind\":\"composition-layers-list\"", "composition-layers response");
  require_contains(composition_layers,
      "\"locked\":true", "composition-layers response");
  require_contains(composition_layers,
      "\"stackIndex\":1", "composition-layers response");
  wait_until([&] {
    return !observer.terminal("invoke-composition-layers").request_id.empty();
  }, "composition-layers terminal audit");
  const TerminalRecord composition_layers_terminal =
      observer.terminal("invoke-composition-layers");
  require(composition_layers_terminal.ok
          && composition_layers_terminal.request_digest.size() == 64
          && composition_layers_terminal.postcondition_digest.size() == 64
          && host.composition_layers_calls == 1,
      "composition-layers terminal evidence was not verified");

  send_json(sockets[0], composition_time_invoke_json("invoke-composition-time"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition-time progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition-time invoke");
  const auto composition_time_batch = dispatcher.drain(host);
  require(composition_time_batch.completions.size() == 1
          && composition_time_batch.completions[0].ok,
      "owner dispatcher did not produce the composition-time result");
  const std::string composition_time = read_body(sockets[0]);
  require_contains(composition_time,
      "\"capabilityId\":\"ae.composition.time.read\"",
      "composition-time response");
  require_contains(composition_time,
      "\"kind\":\"composition-time-read\"", "composition-time response");
  require_contains(composition_time,
      "\"currentTime\":{\"scale\":1000,\"secondsRational\":\"3003/1000\","
      "\"value\":3003}",
      "composition-time response");
  wait_until([&] {
    return !observer.terminal("invoke-composition-time").request_id.empty();
  }, "composition-time terminal audit");
  const TerminalRecord composition_time_terminal =
      observer.terminal("invoke-composition-time");
  require(composition_time_terminal.ok
          && composition_time_terminal.request_digest.size() == 64
          && composition_time_terminal.postcondition_digest
              == "809ed0109922812d59208d5f366714f6005abb600f6a1ef5f71d4bc5adc55cef"
          && host.composition_time_calls == 1,
      "composition-time terminal evidence was not deterministic and verified");

  send_json(sockets[0], layer_properties_invoke_json("invoke-layer-properties"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-properties progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-properties invoke");
  const auto layer_properties_batch = dispatcher.drain(host);
  require(layer_properties_batch.completions.size() == 1
          && layer_properties_batch.completions[0].ok,
      "owner dispatcher did not produce the layer-properties result");
  const std::string layer_properties = read_body(sockets[0]);
  require_contains(layer_properties,
      "\"capabilityId\":\"ae.layer.properties.list\"",
      "layer-properties response");
  require_contains(layer_properties,
      "\"kind\":\"layer-properties-list\"", "layer-properties response");
  require_contains(layer_properties,
      "\"value\":\"73.5\"", "layer-properties response");
  require_contains(layer_properties,
      "\"parentPropertyLocator\":{", "layer-properties response");
  wait_until([&] {
    return !observer.terminal("invoke-layer-properties").request_id.empty();
  }, "layer-properties terminal audit");
  const TerminalRecord layer_properties_terminal =
      observer.terminal("invoke-layer-properties");
  require(layer_properties_terminal.ok
          && layer_properties_terminal.request_digest.size() == 64
          && layer_properties_terminal.postcondition_digest.size() == 64
          && host.layer_properties_calls == 1,
      "layer-properties terminal evidence was not verified");

  send_json(sockets[0], bit_depth_set_invoke_json("invoke-bit-depth-set"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "bit-depth set progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued bit-depth set invoke");
  const auto bit_depth_set_batch = dispatcher.drain(host);
  require(bit_depth_set_batch.completions.size() == 1
          && bit_depth_set_batch.completions[0].ok,
      "owner dispatcher did not produce the bit-depth set result");
  const std::string bit_depth_set = read_body(sockets[0]);
  require_contains(bit_depth_set,
      "\"capabilityId\":\"ae.project.bit-depth.set\"", "bit-depth set response");
  require_contains(bit_depth_set,
      "\"effect\":\"committed\"", "bit-depth set response");
  require_contains(bit_depth_set,
      "\"undo\":{\"available\":true,\"verified\":false}",
      "bit-depth set response");
  require_contains(bit_depth_set,
      "\"kind\":\"project-bit-depth-set\"", "bit-depth set response");
  require_contains(bit_depth_set,
      "\"afterBitsPerChannel\":16,\"beforeBitsPerChannel\":8,\"changed\":true",
      "bit-depth set response");
  require(bit_depth_set.find("groupId") == std::string::npos,
      "bit-depth set response fabricated an SDK undo token");
  wait_until([&] {
    return !observer.terminal("invoke-bit-depth-set").request_id.empty();
  }, "bit-depth set terminal audit");
  const TerminalRecord bit_depth_set_terminal =
      observer.terminal("invoke-bit-depth-set");
  require(bit_depth_set_terminal.ok
      && bit_depth_set_terminal.request_digest.size() == 64
      && bit_depth_set_terminal.postcondition_digest
          == aemcp::native::rpc::digest_project_bit_depth_set_postcondition(true, 8, 16)
      && host.write_calls == 1 && host.observed_target_depth == 16,
      "bit-depth set terminal evidence was not deterministic and verified");

  send_json(sockets[0], bit_depth_set_invoke_json("invoke-bit-depth-set-duplicate"));
  const std::string duplicate = read_body(sockets[0]);
  require_contains(duplicate, "\"code\":\"DUPLICATE_REQUEST\"",
      "same-key bit-depth duplicate");
  require_contains(duplicate, "\"sideEffect\":\"not-started\"",
      "same-key bit-depth duplicate");
  require_contains(duplicate, "\"field\":\"params.arguments.idempotencyKey\"",
      "same-key bit-depth duplicate");
  require(host.write_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key duplicate generated progress or a second host mutation");

  send_json(sockets[0], bit_depth_set_invoke_json(
      "invoke-bit-depth-set-conflict", "bit-depth-intent-001", 32));
  const std::string conflict = read_body(sockets[0]);
  require_contains(conflict, "\"code\":\"DUPLICATE_REQUEST\"",
      "different-args bit-depth duplicate");
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
      "bit-depth-after-disconnect",
      std::string(kProjectBitDepthSetCapability),
      dispatcher_clock.now() + 1s,
      "route-e2e",
      8,
      16,
      "bit-depth-intent-001",
      aemcp::native::rpc::digest_project_bit_depth_set_arguments(
          16, "bit-depth-intent-001"),
  }).code == EnqueueCode::kDuplicateRequest,
      "successful bit-depth business fence was lost across broker disconnect");
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

  send_json(sockets[0], bit_depth_set_invoke_json(
      "invalid-bit-depth-result", "bit-depth-intent-901", 16));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "invalid bit-depth evidence progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "invalid bit-depth evidence invoke");
  // The HostApi reports a structurally valid transition to the wrong target.
  // The dispatcher must bind the postcondition to the requested target=16 and
  // treat this post-dispatch mismatch as possibly side effecting.
  host.bit_depth_change.after_bits_per_channel = 32;
  require(dispatcher.drain(host).completions.size() == 1,
      "invalid bit-depth result did not reach transport validation");
  const std::string bit_depth_failure = read_body(sockets[0]);
  require_contains(bit_depth_failure,
      "\"code\":\"POSSIBLY_SIDE_EFFECTING_FAILURE\"",
      "invalid bit-depth evidence failure");
  require_contains(bit_depth_failure, "\"sideEffect\":\"may-have-occurred\"",
      "invalid bit-depth evidence failure");
  require_contains(bit_depth_failure,
      "\"capabilityId\":\"ae.project.bit-depth.set\"",
      "invalid bit-depth evidence failure");
  wait_until([&] {
    return !observer.terminal("invalid-bit-depth-result").request_id.empty();
  }, "invalid bit-depth terminal audit");
  const TerminalRecord bit_depth_terminal =
      observer.terminal("invalid-bit-depth-result");
  require(!bit_depth_terminal.ok
      && bit_depth_terminal.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
      && bit_depth_terminal.postcondition_digest.empty() && host.write_calls == 1,
      "invalid bit-depth evidence was mislabeled as a safe failure");

  send_json(sockets[0], bit_depth_set_invoke_json(
      "invalid-bit-depth-retry", "bit-depth-intent-901", 16));
  const std::string fenced = read_body(sockets[0]);
  require_contains(fenced, "\"code\":\"DUPLICATE_REQUEST\"",
      "ambiguous bit-depth retry fence");
  require(host.write_calls == 1,
      "ambiguous bit-depth evidence allowed a second host mutation");

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
