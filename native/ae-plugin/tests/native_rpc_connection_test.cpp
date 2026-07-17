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
using aemcp::native::HostCompositionCreateResult;
using aemcp::native::HostCompositionLayerCreateResult;
using aemcp::native::HostCompositionTimeResult;
using aemcp::native::HostCompositionTimeWriteResult;
using aemcp::native::HostDispatcher;
using aemcp::native::HostIdleSignal;
using aemcp::native::HostLayerEffectApplyResult;
using aemcp::native::HostLayerPropertiesResult;
using aemcp::native::HostLayerPropertyKeyframesResult;
using aemcp::native::HostProjectGraphInvalidationResult;
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
using aemcp::native::kProjectGraphInvalidateControl;
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

class RecordingIdleSignal final : public HostIdleSignal {
 public:
  [[nodiscard]] bool request_idle() noexcept override {
    ++calls_;
    return succeeds_.load();
  }

  [[nodiscard]] int calls() const noexcept { return calls_.load(); }
  void set_succeeds(bool succeeds) noexcept { succeeds_.store(succeeds); }

 private:
  std::atomic<int> calls_{0};
  std::atomic<bool> succeeds_{true};
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

  [[nodiscard]] HostCompositionLayersResult list_selected_composition_layers(
      const aemcp::native::CompositionLayersQuery& query, TimePoint) override {
    ++composition_selected_layers_calls;
    if (query.offset > 2) {
      return HostCompositionLayersResult::failure(
          "INVALID_ARGUMENT",
          "offset exceeds the current selected layer total",
          "params.arguments.offset");
    }
    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = "Fixture Comp";
    page.total = 2;
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
      page.layers.push_back({
          {"layer", query.host_instance_id, query.session_id,
              query.composition_locator.project_id,
              query.composition_locator.generation,
              "99999999-9999-4999-8999-999999999999"},
          3,
          "Fixture Shape",
          "shape",
          true,
          false,
          false,
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

  [[nodiscard]] HostCompositionTimeWriteResult set_composition_time(
      const aemcp::native::CompositionTimeSetCommand& command, TimePoint) override {
    ++composition_time_write_calls;
    observed_time_set_command = command;
    aemcp::native::CompositionTimeChanged changed;
    changed.composition_locator = command.composition_locator;
    changed.before_time = {3003, 1000, "3003/1000"};
    changed.after_time = command.target_time;
    return HostCompositionTimeWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostCompositionLayerCreateResult create_composition_layer(
      const aemcp::native::CompositionLayerCreateCommand& command,
      TimePoint) override {
    ++composition_layer_create_calls;
    observed_layer_create_command = command;
    aemcp::native::CompositionLayerCreated created;
    created.changed = true;
    created.kind = command.kind;
    created.name = command.name;
    created.stack_index = 1;
    created.composition_locator = {
        "composition", command.host_instance_id, command.session_id,
        "55555555-5555-4555-8555-555555555555", 9,
        command.composition_locator.object_id};
    created.layer_locator = {
        "layer", command.host_instance_id, command.session_id,
        "55555555-5555-4555-8555-555555555555", 9,
        "99999999-9999-4999-8999-999999999999"};
    created.source_item_locator = aemcp::native::ObjectLocator{
        "item", command.host_instance_id, command.session_id,
        "55555555-5555-4555-8555-555555555555", 9,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
    created.layer_count_before = 0;
    created.layer_count_after = 1;
    created.project_item_count_before = 2;
    created.project_item_count_after = 3;
    created.solid = aemcp::native::CompositionLayerSolidSpec{
        command.color.value(),
        command.width.value(),
        command.height.value(),
        {command.duration->value, command.duration->scale, "5"}};
    return HostCompositionLayerCreateResult::success(std::move(created));
  }

  [[nodiscard]] HostLayerEffectApplyResult apply_layer_effect(
      const aemcp::native::LayerEffectApplyCommand& command,
      TimePoint) override {
    ++layer_effect_apply_calls;
    observed_layer_effect_apply_command = command;
    aemcp::native::LayerEffectApplied applied;
    applied.changed = true;
    applied.layer_locator = {
        "layer", command.host_instance_id, command.session_id,
        "55555555-5555-4555-8555-555555555555", 9,
        command.layer_locator.object_id};
    applied.name = "Slider Control";
    applied.match_name = command.effect_match_name;
    applied.effect_index = 1;
    applied.effect_count_before = 0;
    applied.effect_count_after = 1;
    applied.matching_effect_count_before = 0;
    applied.matching_effect_count_after = 1;
    return HostLayerEffectApplyResult::success(std::move(applied));
  }

  [[nodiscard]] HostCompositionCreateResult create_composition(
      const aemcp::native::CompositionCreateCommand& command,
      TimePoint) override {
    ++composition_create_calls;
    observed_composition_create_command = command;
    aemcp::native::CompositionCreated created;
    created.name = command.name;
    created.composition_locator = {
        "composition", command.host_instance_id, command.session_id,
        "55555555-5555-4555-8555-555555555555", 9,
        "77777777-7777-4777-8777-777777777777"};
    created.project_item_count_before = 1;
    created.project_item_count_after = 2;
    created.layer_count = 0;
    created.width = command.width;
    created.height = command.height;
    created.duration = command.duration;
    created.frame_rate = command.frame_rate;
    created.pixel_aspect_ratio = command.pixel_aspect_ratio;
    return HostCompositionCreateResult::success(std::move(created));
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

  [[nodiscard]] HostLayerPropertyKeyframesResult list_layer_property_keyframes(
      const aemcp::native::LayerPropertyKeyframesQuery& query, TimePoint) override {
    ++layer_property_keyframes_calls;
    if (query.offset == 1) {
      return HostLayerPropertyKeyframesResult::failure(
          "PRECONDITION_FAILED",
          "property must be a keyframeable primitive scalar, vector, or color leaf stream",
          "params.arguments.propertyLocator");
    }
    if (query.offset == 2) {
      return HostLayerPropertyKeyframesResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    aemcp::native::LayerPropertyKeyframesPage page;
    page.property_locator = query.property_locator;
    page.value_type = "one-d";
    page.total = 3;
    page.offset = query.offset;
    page.limit = query.limit;
    page.has_more = true;
    page.next_offset = 2;
    page.keyframes.push_back({
        1, {0, 1}, aemcp::native::LayerPropertyScalarValue{"10"},
        "linear", "linear"});
    page.keyframes.push_back({
        2, {5, 2}, aemcp::native::LayerPropertyScalarValue{"20.5"},
        "bezier", "hold"});
    return HostLayerPropertyKeyframesResult::success(std::move(page));
  }

  [[nodiscard]] aemcp::native::HostLayerPropertyWriteResult set_layer_property(
      const aemcp::native::LayerPropertySetCommand& command, TimePoint) override {
    ++layer_property_write_calls;
    observed_property_command = command;
    if (const auto* scalar =
            std::get_if<aemcp::native::LayerPropertyScalarValue>(&command.value);
        scalar != nullptr && scalar->value == "41") {
      return aemcp::native::HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED",
          "property must be non-keyframed",
          "params.arguments.propertyLocator");
    }
    if (const auto* scalar =
            std::get_if<aemcp::native::LayerPropertyScalarValue>(&command.value);
        scalar != nullptr && scalar->value == "42") {
      return aemcp::native::HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    aemcp::native::LayerPropertyChanged changed;
    changed.layer_locator = command.layer_locator;
    changed.property_locator = command.property_locator;
    changed.value_type = "one-d";
    changed.before_value = aemcp::native::LayerPropertyScalarValue{"25"};
    changed.after_value = command.value;
    return aemcp::native::HostLayerPropertyWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostProjectGraphInvalidationResult invalidate_project_graph(
      TimePoint) override {
    ++project_graph_invalidation_calls;
    project_graph_invalidation_thread = std::this_thread::get_id();
    return HostProjectGraphInvalidationResult::success({true, 9});
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
  int composition_selected_layers_calls{0};
  int composition_time_calls{0};
  int composition_time_write_calls{0};
  int composition_create_calls{0};
  int composition_layer_create_calls{0};
  int layer_effect_apply_calls{0};
  int layer_properties_calls{0};
  int layer_property_keyframes_calls{0};
  int layer_property_write_calls{0};
  int project_graph_invalidation_calls{0};
  std::thread::id project_graph_invalidation_thread;
  aemcp::native::LayerPropertySetCommand observed_property_command;
  aemcp::native::CompositionTimeSetCommand observed_time_set_command;
  aemcp::native::CompositionCreateCommand observed_composition_create_command;
  aemcp::native::CompositionLayerCreateCommand observed_layer_create_command;
  aemcp::native::LayerEffectApplyCommand observed_layer_effect_apply_command;
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
      "f2dfe6b726efb02a371ee45cfa814050e87122e81dd282a6b7797862c2a4638a",
      "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a",
      "936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e",
      "d5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a",
      "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e",
      "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75",
      "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd",
      "724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308",
      "a5e0ccfc15086d1b10987246048e539cf6332a4e24114ac81783f4a9758ab6f6",
      "d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee",
      "5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77",
      "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba",
      "f089d4cd1d35f492df660cbd83667968b2add70b5353172253691e33758e42bb",
      "5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c",
      "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75",
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
  require(!json.empty() && json.size() <= 131'072, "test JSON frame size is invalid");
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
  require(size > 0 && size <= 131'072, "response frame prefix is invalid");
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

std::string invalidate_graph_json(
    std::string_view request_id = "invalidate-graph-1") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invalidateGraph\","
        "\"params\":{\"reason\":\"cep-jsx\"}}";
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

std::string graph_locator_json(std::string_view kind, std::string_view object_id);

std::string layer_property_set_invoke_json(
    std::string_view request_id,
    std::string_view key = "layer-property-intent-001",
    std::string_view value = "40") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.property.set\","
        "\"capabilityVersion\":1,\"arguments\":{\"layerLocator\":"
      + graph_locator_json("layer", "88888888-8888-4888-8888-888888888888")
      + ",\"propertyLocator\":"
      + graph_locator_json("stream", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      + ",\"value\":{\"kind\":\"scalar\",\"value\":\"" + std::string(value)
      + "\"},\"idempotencyKey\":\"" + std::string(key) + "\"}}}";
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

std::string composition_selected_layers_invoke_json(
    std::string_view request_id, std::uint64_t offset = 0) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.selected-layers.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + graph_locator_json("composition", "66666666-6666-4666-8666-666666666666")
      + ",\"offset\":" + std::to_string(offset) + ",\"limit\":25}}}";
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

std::string composition_time_set_invoke_json(
    std::string_view request_id,
    std::string_view key = "composition-time-intent-001") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.time.set\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + graph_locator_json("composition", "66666666-6666-4666-8666-666666666666")
      + ",\"targetTime\":{\"value\":1,\"scale\":1},\"idempotencyKey\":\""
      + std::string(key) + "\"}}}";
}

std::string composition_layer_create_invoke_json(
    std::string_view request_id,
    std::string_view key = "composition-layer-intent-001",
    std::string_view name = "Fixture Solid") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.layer.create\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + graph_locator_json("composition", "66666666-6666-4666-8666-666666666666")
      + ",\"kind\":\"solid\",\"name\":\"" + std::string(name)
      + "\",\"color\":{\"red\":12,\"green\":34,\"blue\":56,\"alpha\":255},"
        "\"width\":640,\"height\":360,\"duration\":{\"value\":5,\"scale\":1},"
        "\"idempotencyKey\":\"" + std::string(key) + "\"}}}";
}

std::string layer_effect_apply_invoke_json(
    std::string_view request_id,
    std::string_view key = "layer-effect-apply-intent-001",
    std::string_view match_name = "ADBE Slider Control") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.effect.apply\","
        "\"capabilityVersion\":1,\"arguments\":{\"layerLocator\":"
      + graph_locator_json("layer", "88888888-8888-4888-8888-888888888888")
      + ",\"effectMatchName\":\"" + std::string(match_name)
      + "\",\"idempotencyKey\":\"" + std::string(key) + "\"}}}";
}

std::string composition_create_invoke_json(
    std::string_view request_id,
    std::string_view key = "composition-create-intent-001") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.create\","
        "\"capabilityVersion\":1,\"arguments\":{\"name\":\"Fixture Comp Created\","
        "\"width\":1920,\"height\":1080,\"duration\":{\"value\":5,\"scale\":1},"
        "\"frameRate\":{\"numerator\":24,\"denominator\":1},"
        "\"pixelAspectRatio\":{\"numerator\":1,\"denominator\":1},"
        "\"idempotencyKey\":\"" + std::string(key) + "\"}}}";
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

std::string layer_property_keyframes_invoke_json(
    std::string_view request_id, std::size_t offset = 0) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.property.keyframes.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"propertyLocator\":"
      + graph_locator_json("stream", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      + ",\"offset\":" + std::to_string(offset) + ",\"limit\":2}}}";
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
  RecordingIdleSignal idle_signal;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer, idle_signal);
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
  require(idle_signal.calls() == 0,
      "hello or capabilities unexpectedly scheduled an idle wake");

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
      "capabilities-layer-property-set", "ae.layer.property.set"));
  const std::string property_set_capabilities = read_body(sockets[0]);
  require_contains(property_set_capabilities,
      "\"id\":\"ae.layer.property.set\"",
      "layer-property set capabilities response");
  require_contains(property_set_capabilities,
      "\"contractDigest\":\"5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c\"",
      "layer-property set capabilities response");
  require_contains(property_set_capabilities,
      "aemcp.requirement.native.layer-property-set",
      "layer-property set capabilities response");

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
      "capabilities-composition-selected-layers",
      "ae.composition.selected-layers.list"));
  const std::string composition_selected_layers_capabilities = read_body(sockets[0]);
  require_contains(composition_selected_layers_capabilities,
      "\"id\":\"ae.composition.selected-layers.list\"",
      "composition-selected-layers capabilities response");
  require_contains(composition_selected_layers_capabilities,
      "\"contractDigest\":\"3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75\"",
      "composition-selected-layers capabilities response");
  require_contains(composition_selected_layers_capabilities,
      "aemcp.requirement.native.composition-selected-layers-list",
      "composition-selected-layers capabilities response");
  require_contains(composition_selected_layers_capabilities,
      "List a bounded page of selected layers in one After Effects composition.",
      "composition-selected-layers capabilities response");

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
      "capabilities-composition-time-set", "ae.composition.time.set"));
  const std::string composition_time_set_capabilities = read_body(sockets[0]);
  require_contains(composition_time_set_capabilities,
      "\"id\":\"ae.composition.time.set\"",
      "composition-time set capabilities response");
  require_contains(composition_time_set_capabilities,
      "\"contractDigest\":\"724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308\"",
      "composition-time set capabilities response");
  require_contains(composition_time_set_capabilities,
      "aemcp.requirement.native.composition-time-set",
      "composition-time set capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-composition-create", "ae.composition.create"));
  const std::string composition_create_capabilities = read_body(sockets[0]);
  require_contains(composition_create_capabilities,
      "\"id\":\"ae.composition.create\"",
      "composition create capabilities response");
  require_contains(composition_create_capabilities,
      "\"contractDigest\":\"a5e0ccfc15086d1b10987246048e539cf6332a4e24114ac81783f4a9758ab6f6\"",
      "composition create capabilities response");
  require_contains(composition_create_capabilities,
      "aemcp.requirement.native.composition-create",
      "composition create capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-composition-layer-create", "ae.composition.layer.create"));
  const std::string composition_layer_create_capabilities = read_body(sockets[0]);
  require_contains(composition_layer_create_capabilities,
      "\"id\":\"ae.composition.layer.create\"",
      "composition-layer create capabilities response");
  require_contains(composition_layer_create_capabilities,
      "\"contractDigest\":\"d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee\"",
      "composition-layer create capabilities response");
  require_contains(composition_layer_create_capabilities,
      "aemcp.requirement.native.composition-layer-create",
      "composition-layer create capabilities response");

  send_json(sockets[0], bit_depth_capabilities_json(
      "capabilities-layer-effect-apply", "ae.layer.effect.apply"));
  const std::string layer_effect_apply_capabilities = read_body(sockets[0]);
  require_contains(layer_effect_apply_capabilities,
      "\"id\":\"ae.layer.effect.apply\"",
      "layer-effect apply capabilities response");
  require_contains(layer_effect_apply_capabilities,
      "\"contractDigest\":\"5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77\"",
      "layer-effect apply capabilities response");
  require_contains(layer_effect_apply_capabilities,
      "aemcp.requirement.native.layer-effect-apply",
      "layer-effect apply capabilities response");

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
  wait_until([&] { return idle_signal.calls() == 1; }, "first invoke idle wake");
  wait_until([&] {
    return observer.has_event("dispatch.wake", "invoke-read", "scheduled");
  }, "scheduled idle wake audit");
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

  send_json(sockets[0], composition_selected_layers_invoke_json(
      "invoke-composition-selected-layers"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition-selected-layers progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition-selected-layers invoke");
  const auto composition_selected_layers_batch = dispatcher.drain(host);
  require(composition_selected_layers_batch.completions.size() == 1
          && composition_selected_layers_batch.completions[0].ok,
      "owner dispatcher did not produce the composition-selected-layers result");
  const std::string composition_selected_layers = read_body(sockets[0]);
  require_contains(composition_selected_layers,
      "\"capabilityId\":\"ae.composition.selected-layers.list\"",
      "composition-selected-layers response");
  require_contains(composition_selected_layers,
      "\"kind\":\"composition-selected-layers-list\"",
      "composition-selected-layers response");
  require_contains(composition_selected_layers,
      "\"stackIndex\":1", "composition-selected-layers response");
  require_contains(composition_selected_layers,
      "\"stackIndex\":3", "composition-selected-layers response");
  wait_until([&] {
    return !observer.terminal(
        "invoke-composition-selected-layers").request_id.empty();
  }, "composition-selected-layers terminal audit");
  const TerminalRecord composition_selected_layers_terminal =
      observer.terminal("invoke-composition-selected-layers");
  require(composition_selected_layers_terminal.ok
          && composition_selected_layers_terminal.request_digest.size() == 64
          && composition_selected_layers_terminal.postcondition_digest.size() == 64
          && host.composition_selected_layers_calls == 1,
      "composition-selected-layers terminal evidence was not verified");

  send_json(sockets[0], composition_selected_layers_invoke_json(
      "invoke-composition-selected-layers-invalid-offset", 3));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition-selected-layers invalid offset progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition-selected-layers invalid offset invoke");
  const auto invalid_selected_layers_batch = dispatcher.drain(host);
  require(invalid_selected_layers_batch.completions.size() == 1
          && !invalid_selected_layers_batch.completions[0].ok,
      "owner dispatcher did not preserve the selected-layer offset failure");
  const std::string invalid_selected_layers = read_body(sockets[0]);
  require_contains(invalid_selected_layers, "\"code\":\"INVALID_ARGUMENT\"",
      "composition-selected-layers invalid offset response");
  require_contains(invalid_selected_layers, "\"retryable\":false",
      "composition-selected-layers invalid offset response");
  require_contains(invalid_selected_layers, "\"sideEffect\":\"not-started\"",
      "composition-selected-layers invalid offset response");
  require_contains(invalid_selected_layers, "\"action\":\"change-arguments\"",
      "composition-selected-layers invalid offset response");
  require_contains(invalid_selected_layers,
      "\"capabilityId\":\"ae.composition.selected-layers.list\"",
      "composition-selected-layers invalid offset response");
  require_contains(invalid_selected_layers,
      "\"field\":\"params.arguments.offset\"",
      "composition-selected-layers invalid offset response");
  wait_until([&] {
    return !observer.terminal(
        "invoke-composition-selected-layers-invalid-offset").request_id.empty();
  }, "composition-selected-layers invalid offset terminal audit");
  const TerminalRecord invalid_selected_layers_terminal = observer.terminal(
      "invoke-composition-selected-layers-invalid-offset");
  require(!invalid_selected_layers_terminal.ok
          && invalid_selected_layers_terminal.error_code == "INVALID_ARGUMENT"
          && invalid_selected_layers_terminal.request_digest.size() == 64
          && invalid_selected_layers_terminal.postcondition_digest.empty()
          && host.composition_selected_layers_calls == 2,
      "composition-selected-layers invalid offset was not audited as a failure");

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

  send_json(sockets[0], composition_time_set_invoke_json(
      "invoke-composition-time-set"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition-time set progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition-time set invoke");
  const auto composition_time_set_batch = dispatcher.drain(host);
  require(composition_time_set_batch.completions.size() == 1
          && composition_time_set_batch.completions[0].ok,
      "owner dispatcher did not produce the composition-time set result");
  const std::string composition_time_set = read_body(sockets[0]);
  require_contains(composition_time_set,
      "\"capabilityId\":\"ae.composition.time.set\"",
      "composition-time set response");
  require_contains(composition_time_set,
      "\"effect\":\"committed\"", "composition-time set response");
  require_contains(composition_time_set,
      "\"undo\":{\"available\":true,\"verified\":false}",
      "composition-time set response");
  require_contains(composition_time_set,
      "\"afterTime\":{\"scale\":1,\"secondsRational\":\"1\",\"value\":1}",
      "composition-time set response");
  wait_until([&] {
    return !observer.terminal("invoke-composition-time-set").request_id.empty();
  }, "composition-time set terminal audit");
  const TerminalRecord composition_time_set_terminal =
      observer.terminal("invoke-composition-time-set");
  require(composition_time_set_terminal.ok
          && composition_time_set_terminal.request_digest.size() == 64
          && composition_time_set_terminal.postcondition_digest.size() == 64
          && host.composition_time_write_calls == 1
          && host.observed_time_set_command.target_time.value == 1
          && host.observed_time_set_command.target_time.scale == 1,
      "composition-time set terminal evidence was not deterministic and verified");

  send_json(sockets[0], composition_time_set_invoke_json(
      "invoke-composition-time-set-duplicate"));
  const std::string composition_time_set_duplicate = read_body(sockets[0]);
  require_contains(composition_time_set_duplicate, "\"code\":\"DUPLICATE_REQUEST\"",
      "same-key composition-time duplicate");
  require(host.composition_time_write_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key composition-time duplicate reached HostApi");

  send_json(sockets[0], composition_create_invoke_json(
      "invoke-composition-create"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition create progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition create invoke");
  const auto composition_create_batch = dispatcher.drain(host);
  require(composition_create_batch.completions.size() == 1
          && composition_create_batch.completions[0].ok,
      "owner dispatcher did not produce the composition create result");
  const std::string composition_create = read_body(sockets[0]);
  require_contains(composition_create,
      "\"capabilityId\":\"ae.composition.create\"",
      "composition create response");
  require_contains(composition_create,
      "\"effect\":\"committed\"", "composition create response");
  require_contains(composition_create,
      "\"undo\":{\"available\":true,\"verified\":false}",
      "composition create response");
  require_contains(composition_create,
      "\"name\":\"Fixture Comp Created\"", "composition create response");
  require_contains(composition_create,
      "\"projectItemCountAfter\":2,\"projectItemCountBefore\":1",
      "composition create response");
  wait_until([&] {
    return !observer.terminal("invoke-composition-create").request_id.empty();
  }, "composition create terminal audit");
  const TerminalRecord composition_create_terminal =
      observer.terminal("invoke-composition-create");
  require(composition_create_terminal.ok
          && composition_create_terminal.request_digest.size() == 64
          && composition_create_terminal.postcondition_digest.size() == 64
          && host.composition_create_calls == 1
          && host.observed_composition_create_command.name == "Fixture Comp Created"
          && host.observed_composition_create_command.frame_rate.numerator == 24,
      "composition create terminal evidence was not verified");

  send_json(sockets[0], composition_create_invoke_json(
      "invoke-composition-create-replay"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "same-key composition create replay progress");
  const std::string composition_create_replay = read_body(sockets[0]);
  require_contains(composition_create_replay, "\"replayed\":true",
      "same-key composition create replay");
  require(host.composition_create_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key composition create replay reached HostApi or emitted extra output");

  send_json(sockets[0], composition_layer_create_invoke_json(
      "invoke-composition-layer-create"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "composition-layer create progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued composition-layer create invoke");
  const auto composition_layer_create_batch = dispatcher.drain(host);
  require(composition_layer_create_batch.completions.size() == 1
          && composition_layer_create_batch.completions[0].ok,
      "owner dispatcher did not produce the composition-layer create result");
  const std::string composition_layer_create = read_body(sockets[0]);
  require_contains(composition_layer_create,
      "\"capabilityId\":\"ae.composition.layer.create\"",
      "composition-layer create response");
  require_contains(composition_layer_create,
      "\"effect\":\"committed\"", "composition-layer create response");
  require_contains(composition_layer_create,
      "\"undo\":{\"available\":true,\"verified\":false}",
      "composition-layer create response");
  require_contains(composition_layer_create,
      "\"kind\":\"solid\"", "composition-layer create response");
  require_contains(composition_layer_create,
      "\"color\":{\"alpha\":255,\"blue\":56,\"green\":34,\"red\":12}",
      "composition-layer create response");
  require_contains(composition_layer_create,
      "\"layerCountAfter\":1,\"layerCountBefore\":0",
      "composition-layer create response");
  wait_until([&] {
    return !observer.terminal("invoke-composition-layer-create").request_id.empty();
  }, "composition-layer create terminal audit");
  const TerminalRecord composition_layer_create_terminal =
      observer.terminal("invoke-composition-layer-create");
  require(composition_layer_create_terminal.ok
          && composition_layer_create_terminal.request_digest.size() == 64
          && composition_layer_create_terminal.postcondition_digest.size() == 64
          && host.composition_layer_create_calls == 1
          && host.observed_layer_create_command.kind == "solid"
          && host.observed_layer_create_command.name == "Fixture Solid",
      "composition-layer create terminal evidence was not verified");

  send_json(sockets[0], composition_layer_create_invoke_json(
      "invoke-composition-layer-create-replay"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "same-key composition-layer replay progress");
  const std::string composition_layer_create_replay = read_body(sockets[0]);
  require_contains(composition_layer_create_replay, "\"replayed\":true",
      "same-key composition-layer replay");
  require_contains(composition_layer_create_replay,
      "\"capabilityId\":\"ae.composition.layer.create\"",
      "same-key composition-layer replay");
  require(host.composition_layer_create_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key composition-layer replay reached HostApi or emitted extra output");

  send_json(sockets[0], layer_effect_apply_invoke_json(
      "invoke-layer-effect-apply"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-effect apply progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-effect apply invoke");
  const auto layer_effect_apply_batch = dispatcher.drain(host);
  require(layer_effect_apply_batch.completions.size() == 1
          && layer_effect_apply_batch.completions[0].ok,
      "owner dispatcher did not produce the layer-effect apply result");
  const std::string layer_effect_apply = read_body(sockets[0]);
  require_contains(layer_effect_apply,
      "\"capabilityId\":\"ae.layer.effect.apply\"",
      "layer-effect apply response");
  require_contains(layer_effect_apply,
      "\"matchName\":\"ADBE Slider Control\"",
      "layer-effect apply response");
  require_contains(layer_effect_apply,
      "\"effectCountAfter\":1,\"effectCountBefore\":0",
      "layer-effect apply response");
  require_contains(layer_effect_apply,
      "\"undo\":{\"available\":true,\"verified\":false}",
      "layer-effect apply response");
  wait_until([&] {
    return !observer.terminal("invoke-layer-effect-apply").request_id.empty();
  }, "layer-effect apply terminal audit");
  const TerminalRecord layer_effect_apply_terminal =
      observer.terminal("invoke-layer-effect-apply");
  require(layer_effect_apply_terminal.ok
          && layer_effect_apply_terminal.request_digest.size() == 64
          && layer_effect_apply_terminal.postcondition_digest.size() == 64
          && host.layer_effect_apply_calls == 1
          && host.observed_layer_effect_apply_command.effect_match_name
              == "ADBE Slider Control",
      "layer-effect apply terminal evidence was not verified");

  send_json(sockets[0], layer_effect_apply_invoke_json(
      "invoke-layer-effect-apply-replay"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "same-key layer-effect replay progress");
  const std::string layer_effect_apply_replay = read_body(sockets[0]);
  require_contains(layer_effect_apply_replay, "\"replayed\":true",
      "same-key layer-effect replay");
  require(host.layer_effect_apply_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key layer-effect replay reached HostApi or emitted extra output");

  send_json(sockets[0], invalidate_graph_json("invalidate-after-layer-create"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "post-create graph invalidation progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued post-create graph invalidation");
  const auto post_create_invalidation = dispatcher.drain(host);
  require(post_create_invalidation.completions.size() == 1
          && post_create_invalidation.completions[0].ok
          && post_create_invalidation.completions[0]
              .project_graph_invalidation_result.invalidated,
      "post-create graph invalidation did not complete");
  require_contains(read_body(sockets[0]), "\"method\":\"invalidateGraph\"",
      "post-create graph invalidation response");

  send_json(sockets[0], composition_layer_create_invoke_json(
      "invoke-composition-layer-create-after-invalidation"));
  const std::string composition_layer_create_after_invalidation = read_body(sockets[0]);
  require_contains(composition_layer_create_after_invalidation,
      "\"code\":\"DUPLICATE_REQUEST\"",
      "same-key composition-layer replay after graph invalidation");
  require_contains(composition_layer_create_after_invalidation,
      "current-state inspection",
      "same-key composition-layer replay recovery hint");
  require(composition_layer_create_after_invalidation.find("\"replayed\":true")
          == std::string::npos
          && composition_layer_create_after_invalidation.find("\"verified\":true")
              == std::string::npos
          && host.composition_layer_create_calls == 1,
      "graph invalidation emitted stale verified create replay evidence");

  send_json(sockets[0], layer_effect_apply_invoke_json(
      "invoke-layer-effect-apply-after-invalidation"));
  const std::string layer_effect_apply_after_invalidation = read_body(sockets[0]);
  require_contains(layer_effect_apply_after_invalidation,
      "\"code\":\"DUPLICATE_REQUEST\"",
      "same-key layer-effect replay after graph invalidation");
  require(host.layer_effect_apply_calls == 1,
      "graph invalidation allowed a duplicate layer-effect mutation");

  send_json(sockets[0], composition_layer_create_invoke_json(
      "invoke-composition-layer-create-conflict",
      "composition-layer-intent-001", "Different Solid"));
  const std::string composition_layer_create_conflict = read_body(sockets[0]);
  require_contains(composition_layer_create_conflict,
      "\"code\":\"DUPLICATE_REQUEST\"",
      "different-args composition-layer duplicate");
  require(host.composition_layer_create_calls == 1,
      "different-args composition-layer duplicate reached HostApi");

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

  send_json(sockets[0], layer_property_keyframes_invoke_json(
      "invoke-layer-property-keyframes"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-property keyframes progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-property keyframes invoke");
  const auto layer_property_keyframes_batch = dispatcher.drain(host);
  require(layer_property_keyframes_batch.completions.size() == 1
          && layer_property_keyframes_batch.completions[0].ok,
      "owner dispatcher did not produce the layer-property keyframes result");
  const std::string layer_property_keyframes = read_body(sockets[0]);
  require_contains(layer_property_keyframes,
      "\"capabilityId\":\"ae.layer.property.keyframes.list\"",
      "layer-property keyframes response");
  require_contains(layer_property_keyframes,
      "\"kind\":\"layer-property-keyframes-list\"",
      "layer-property keyframes response");
  require_contains(layer_property_keyframes,
      "\"time\":{\"mode\":\"comp-time\",\"scale\":2,\"value\":5}",
      "layer-property keyframes response");
  require_contains(layer_property_keyframes,
      "\"outInterpolation\":\"hold\"",
      "layer-property keyframes response");
  wait_until([&] {
    return !observer.terminal(
        "invoke-layer-property-keyframes").request_id.empty();
  }, "layer-property keyframes terminal audit");
  const TerminalRecord layer_property_keyframes_terminal =
      observer.terminal("invoke-layer-property-keyframes");
  require(layer_property_keyframes_terminal.ok
          && layer_property_keyframes_terminal.request_digest.size() == 64
          && layer_property_keyframes_terminal.postcondition_digest.size() == 64
          && host.layer_property_keyframes_calls == 1,
      "layer-property keyframes terminal evidence was not verified");

  send_json(sockets[0], layer_property_keyframes_invoke_json(
      "invoke-layer-property-keyframes-precondition", 1));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-property keyframes precondition progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-property keyframes precondition invoke");
  const auto keyframes_precondition_batch = dispatcher.drain(host);
  require(keyframes_precondition_batch.completions.size() == 1
          && !keyframes_precondition_batch.completions[0].ok,
      "owner dispatcher did not preserve keyframe property precondition failure");
  const std::string keyframes_precondition = read_body(sockets[0]);
  require_contains(keyframes_precondition, "\"code\":\"PRECONDITION_FAILED\"",
      "layer-property keyframes precondition response");
  require_contains(keyframes_precondition, "\"action\":\"change-arguments\"",
      "layer-property keyframes precondition recovery");
  require_contains(keyframes_precondition,
      "Copy a keyframeable primitive scalar, vector, or color leaf locator from ae_listLayerProperties.",
      "layer-property keyframes precondition hint");
  require_contains(keyframes_precondition,
      "\"field\":\"params.arguments.propertyLocator\"",
      "layer-property keyframes precondition field");

  send_json(sockets[0], layer_property_keyframes_invoke_json(
      "invoke-layer-property-keyframes-no-project", 2));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-property keyframes no-project progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-property keyframes no-project invoke");
  const auto keyframes_no_project_batch = dispatcher.drain(host);
  require(keyframes_no_project_batch.completions.size() == 1
          && !keyframes_no_project_batch.completions[0].ok,
      "owner dispatcher did not preserve keyframe no-project failure");
  const std::string keyframes_no_project = read_body(sockets[0]);
  require_contains(keyframes_no_project, "\"code\":\"PRECONDITION_FAILED\"",
      "layer-property keyframes no-project response");
  require_contains(keyframes_no_project, "\"action\":\"open-project\"",
      "layer-property keyframes no-project recovery");

  send_json(sockets[0], layer_property_set_invoke_json("invoke-layer-property-set"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-property set progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-property set invoke");
  const auto layer_property_set_batch = dispatcher.drain(host);
  require(layer_property_set_batch.completions.size() == 1
          && layer_property_set_batch.completions[0].ok,
      "owner dispatcher did not produce the layer-property set result");
  const std::string layer_property_set = read_body(sockets[0]);
  require_contains(layer_property_set,
      "\"capabilityId\":\"ae.layer.property.set\"",
      "layer-property set response");
  require_contains(layer_property_set,
      "\"effect\":\"committed\"", "layer-property set response");
  require_contains(layer_property_set,
      "\"undo\":{\"available\":true,\"verified\":false}",
      "layer-property set response");
  require_contains(layer_property_set,
      "\"afterValue\":{\"kind\":\"scalar\",\"value\":\"40\"}",
      "layer-property set response");
  wait_until([&] {
    return !observer.terminal("invoke-layer-property-set").request_id.empty();
  }, "layer-property set terminal audit");
  const TerminalRecord property_set_terminal =
      observer.terminal("invoke-layer-property-set");
  require(property_set_terminal.ok
          && property_set_terminal.request_digest.size() == 64
          && property_set_terminal.postcondition_digest.size() == 64
          && host.layer_property_write_calls == 1,
      "layer-property set terminal evidence was not verified");

  send_json(sockets[0], layer_property_set_invoke_json(
      "invoke-layer-property-set-duplicate"));
  const std::string property_duplicate = read_body(sockets[0]);
  require_contains(property_duplicate, "\"code\":\"DUPLICATE_REQUEST\"",
      "same-key layer-property duplicate");
  require(host.layer_property_write_calls == 1 && !wait_readable(sockets[0], 100ms),
      "same-key layer-property duplicate reached HostApi");

  send_json(sockets[0], layer_property_set_invoke_json(
      "invoke-layer-property-precondition", "layer-property-intent-002", "41"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-property precondition progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-property precondition invoke");
  const auto property_precondition_batch = dispatcher.drain(host);
  require(property_precondition_batch.completions.size() == 1
          && !property_precondition_batch.completions[0].ok,
      "owner dispatcher did not preserve property precondition failure");
  const std::string property_precondition = read_body(sockets[0]);
  require_contains(property_precondition, "\"code\":\"PRECONDITION_FAILED\"",
      "layer-property precondition response");
  require_contains(property_precondition, "\"action\":\"change-arguments\"",
      "layer-property precondition recovery");
  require_contains(property_precondition,
      "\"field\":\"params.arguments.propertyLocator\"",
      "layer-property precondition field");

  send_json(sockets[0], layer_property_set_invoke_json(
      "invoke-layer-property-no-project", "layer-property-intent-003", "42"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"",
      "layer-property no-project progress");
  wait_until([&] { return dispatcher.queued() == 1; },
      "queued layer-property no-project invoke");
  const auto property_no_project_batch = dispatcher.drain(host);
  require(property_no_project_batch.completions.size() == 1
          && !property_no_project_batch.completions[0].ok,
      "owner dispatcher did not preserve no-project precondition failure");
  const std::string property_no_project = read_body(sockets[0]);
  require_contains(property_no_project, "\"code\":\"PRECONDITION_FAILED\"",
      "layer-property no-project response");
  require_contains(property_no_project, "\"action\":\"open-project\"",
      "layer-property no-project recovery");

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
  require(idle_signal.calls() == 24,
      "accepted invokes did not each schedule exactly one idle wake; observed "
          + std::to_string(idle_signal.calls()));

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

void invalidate_graph_runs_only_on_owner_dispatcher_and_is_fenced() {
  FakeDispatcherClock dispatcher_clock;
  FakeSessionClock session_clock;
  const std::thread::id owner_thread = std::this_thread::get_id();
  HostDispatcher dispatcher(owner_thread, dispatcher_clock);
  RecordingObserver observer;
  RecordingIdleSignal idle_signal;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer, idle_signal);
  std::array<int, 2> sockets{};
  require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) == 0,
      "invalidateGraph socketpair failed");
  const AuthenticatedConnection authenticated =
      connection(sockets[1], "route-invalidate", 11);
  std::thread worker([&] { handler.serve(authenticated); });

  send_json(sockets[0], hello_json());
  require_contains(read_body(sockets[0]), "\"ok\":true", "invalidateGraph hello");

  FakeHost host;
  const std::string request = invalidate_graph_json();
  send_json(sockets[0], request);
  const std::string progress = read_body(sockets[0]);
  require_contains(progress, "\"event\":\"progress\"", "invalidateGraph progress");
  require_contains(progress, "\"phase\":\"queued\"", "invalidateGraph progress");
  wait_until([&] { return dispatcher.queued() == 1; }, "queued invalidateGraph request");
  wait_until([&] { return idle_signal.calls() == 1; }, "invalidateGraph idle wake");
  require(host.project_graph_invalidation_calls == 0,
      "invalidateGraph reached HostApi before dispatcher drain");
  require(observer.has_event("invalidateGraph", "invalidate-graph-1", "queued")
          && observer.has_event(
              "dispatch.wake", "invalidate-graph-1", "scheduled"),
      "invalidateGraph did not emit its queued and wake audit events");

  bool wrong_thread = false;
  std::size_t wrong_thread_completions = 0;
  std::thread non_owner([&] {
    const auto batch = dispatcher.drain(host);
    wrong_thread = batch.wrong_thread;
    wrong_thread_completions = batch.completions.size();
  });
  non_owner.join();
  require(wrong_thread && wrong_thread_completions == 0
          && host.project_graph_invalidation_calls == 0
          && dispatcher.queued() == 1,
      "non-owner dispatcher drain reached invalidateGraph HostApi");

  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1
          && batch.completions[0].ok
          && batch.completions[0].capability_id == kProjectGraphInvalidateControl
          && batch.completions[0].project_graph_invalidation_result.invalidated
          && batch.completions[0].project_graph_invalidation_result.generation == 9,
      "owner dispatcher did not produce the typed invalidateGraph completion");
  require(host.project_graph_invalidation_calls == 1
          && host.project_graph_invalidation_thread == owner_thread,
      "invalidateGraph HostApi call did not run exactly once on the owner thread");

  const std::string acknowledgement = read_body(sockets[0]);
  require_contains(
      acknowledgement, "\"method\":\"invalidateGraph\"", "invalidateGraph response");
  require_contains(acknowledgement, "\"ok\":true", "invalidateGraph response");
  require_contains(acknowledgement,
      "\"result\":{\"generation\":9,\"invalidated\":true}",
      "invalidateGraph response");
  require(acknowledgement.find("\"capabilityId\"") == std::string::npos,
      "invalidateGraph response exposed its internal dispatcher capability");

  wait_until([&] {
    return !observer.terminal("invalidate-graph-1").request_id.empty();
  }, "invalidateGraph terminal audit");
  const TerminalRecord terminal = observer.terminal("invalidate-graph-1");
  require(terminal.ok
          && terminal.request_digest
              == "0be932440057b1f2509aee30f414f8fb45d6a637d3327c76cc75d9ca84222bd3"
          && terminal.request_digest.size() == 64
          && terminal.postcondition_digest.empty(),
      "invalidateGraph terminal audit did not preserve its request-only evidence");

  send_json(sockets[0], request);
  const std::string duplicate = read_body(sockets[0]);
  require_contains(
      duplicate, "\"method\":\"invalidateGraph\"", "duplicate invalidateGraph");
  require_contains(
      duplicate, "\"code\":\"DUPLICATE_REQUEST\"", "duplicate invalidateGraph");
  require_contains(duplicate,
      "\"sideEffect\":\"not-started\"", "duplicate invalidateGraph");
  require(host.project_graph_invalidation_calls == 1
          && dispatcher.queued() == 0
          && idle_signal.calls() == 1
          && !wait_readable(sockets[0], 100ms),
      "duplicate invalidateGraph reached HostApi or emitted extra work");

  finish_connection(sockets[0], sockets[1], worker);
  (void)dispatcher.shutdown();
}

void invalid_postcondition_becomes_structured_failure() {
  FakeDispatcherClock dispatcher_clock;
  FakeSessionClock session_clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), dispatcher_clock);
  RecordingObserver observer;
  RecordingIdleSignal idle_signal;
  idle_signal.set_succeeds(false);
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer, idle_signal);
  std::array<int, 2> sockets{};
  require(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) == 0, "socketpair failed");
  const AuthenticatedConnection authenticated = connection(sockets[1], "route-invalid", 3);
  std::thread worker([&] { handler.serve(authenticated); });

  send_json(sockets[0], hello_json());
  require_contains(read_body(sockets[0]), "\"ok\":true", "invalid evidence hello");
  send_json(sockets[0], invoke_json("invalid-result"));
  require_contains(read_body(sockets[0]), "\"event\":\"progress\"", "invalid evidence progress");
  wait_until([&] {
    return observer.has_event("dispatch.wake", "invalid-result", "failed");
  }, "failed idle wake audit");
  idle_signal.set_succeeds(true);
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
  require(idle_signal.calls() == 2,
      "rejected retry scheduled an idle wake or an accepted invoke missed one");

  finish_connection(sockets[0], sockets[1], worker);
  (void)dispatcher.shutdown();
}

void construction_failure_is_contained_by_noexcept_boundary() {
  FakeDispatcherClock dispatcher_clock;
  FakeSessionClock session_clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), dispatcher_clock);
  RecordingObserver observer;
  RecordingIdleSignal idle_signal;
  NativeRpcConnectionHandler handler(
      dispatcher, dispatcher_clock, session_clock, runtime(), observer, idle_signal);
  AuthenticatedConnection invalid = connection(-1, std::string(1'025, 'x'), 1);
  handler.serve(invalid);
  require(observer.has_event(
      "connection", "none", "codec-or-transport-failure"),
      "front-door construction exception escaped the noexcept serve boundary");
  require(dispatcher.running(), "construction failure changed dispatcher lifecycle state");
  require(idle_signal.calls() == 0,
      "invalid connection unexpectedly scheduled an idle wake");
  (void)dispatcher.shutdown();
}

}  // namespace

int main() {
  hello_capabilities_invoke_cancel_and_fencing_work();
  invalidate_graph_runs_only_on_owner_dispatcher_and_is_fenced();
  invalid_postcondition_becomes_structured_failure();
  construction_failure_is_contained_by_noexcept_boundary();
  std::cout << "native_rpc_connection_test: PASS\n";
  return 0;
}
