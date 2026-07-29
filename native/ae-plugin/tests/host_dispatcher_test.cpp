#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/native_program.hpp"

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

using namespace aemcp::native;

constexpr std::string_view kHost = "11111111-1111-4111-8111-111111111111";
constexpr std::string_view kSession = "22222222-2222-4222-8222-222222222222";

void require(bool condition, std::string_view message) {
  if (!condition)
    throw std::runtime_error(std::string(message));
}

class TestClock final : public Clock {
public:
  [[nodiscard]] TimePoint now() const noexcept override { return now_; }
  void advance(std::chrono::milliseconds duration) { now_ += duration; }

private:
  TimePoint now_{std::chrono::steady_clock::time_point{}};
};

class TestHost final : public HostApi {
public:
  NativeProgramHostResult next = NativeProgramHostResult::success({}, {});
  std::size_t programs{0};
  std::size_t undo_begins{0};
  std::size_t undo_ends{0};
  std::size_t invalidations{0};

  [[nodiscard]] NativeProgramHostResult
  execute_native_program(const NativeProgram &, std::string_view,
                         std::string_view, TimePoint) override {
    ++programs;
    return next;
  }

  [[nodiscard]] HostActionResult begin_undo_group(std::string_view,
                                                  TimePoint) override {
    ++undo_begins;
    return HostActionResult::success();
  }

  [[nodiscard]] HostActionResult end_undo_group(TimePoint) override {
    ++undo_ends;
    return HostActionResult::success();
  }

  [[nodiscard]] HostProjectGraphInvalidationResult
  invalidate_project_graph(TimePoint) override {
    ++invalidations;
    return HostProjectGraphInvalidationResult::success({true, 7});
  }
};

NativeProgram parse_program(std::string_view json) {
  return parse_native_program(parse_json_object(json));
}

Request request(TestClock &clock, std::string request_id, NativeProgram program,
                std::string route = "route-a", std::uint64_t generation = 1) {
  Request value;
  value.request_id = std::move(request_id);
  value.deadline = clock.now() + std::chrono::seconds(1);
  value.route_id = std::move(route);
  value.session_generation = generation;
  value.host_instance_id = kHost;
  value.session_id = kSession;
  value.native_program = std::move(program);
  return value;
}

void native_program_is_the_only_public_dispatch_route() {
  TestClock clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), clock);

  Request legacy = request(
      clock, "11111111-1111-4111-8111-111111111112",
      parse_program(
          R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]})"));
  legacy.capability_id = "ae.retired.direct";
  require(dispatcher.enqueue(std::move(legacy)).code ==
              EnqueueCode::kUnsupportedCapability,
          "legacy direct capability was admitted");

  Request native = request(
      clock, "11111111-1111-4111-8111-111111111113",
      parse_program(
          R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]})"));
  const EnqueueResult admitted = dispatcher.enqueue(std::move(native));
  require(admitted.code == EnqueueCode::kAccepted,
          std::string("native program was rejected: ") + admitted.error_code +
              " " + admitted.message);

  TestHost host;
  const DrainBatch batch = dispatcher.drain(host);
  require(batch.completions.size() == 1, "native completion missing");
  require(batch.completions[0].ok, "native read program failed");
  require(host.programs == 1, "native program was not dispatched once");
  require(host.undo_begins == 0 && host.undo_ends == 0,
          "read program opened an Undo group");
}

void write_program_has_one_undo_group_and_replays_idempotently() {
  TestClock clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), clock);
  TestHost host;
  const std::string program_json =
      R"({"operationKey":"native-write-key-0001","undoGroup":"Set composition duration","operations":[{"op":"composition.resolve","args":{"locator":{"kind":"composition","hostInstanceId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","projectId":"33333333-3333-4333-8333-333333333333","generation":1,"objectId":"44444444-4444-4444-8444-444444444444"}},"saveAs":"composition"},{"op":"composition.duration.set","args":{"composition":{"ref":"composition"},"duration":{"value":10,"scale":1}}}]})";

  const EnqueueResult write_admitted =
      dispatcher.enqueue(request(clock, "11111111-1111-4111-8111-111111111114",
                                 parse_program(program_json)));
  require(write_admitted.code == EnqueueCode::kAccepted,
          std::string("write program was rejected: ") +
              write_admitted.error_code + " " + write_admitted.message);
  const DrainBatch first = dispatcher.drain(host);
  require(first.completions.size() == 1 && first.completions[0].ok,
          "write program did not complete");
  require(first.completions[0].native_program_result.undo_available,
          "write completion did not report Undo availability");
  require(host.programs == 1 && host.undo_begins == 1 && host.undo_ends == 1,
          "write program did not use exactly one Undo group");
  require(dispatcher.take_outbound().size() == 1,
          "first write completion was not published");

  require(
      dispatcher
              .enqueue(request(clock, "11111111-1111-4111-8111-111111111115",
                               parse_program(program_json)))
              .code == EnqueueCode::kAccepted,
      "same-key replay was rejected");
  require(dispatcher.drain(host).completions.empty(),
          "idempotent replay unexpectedly reached the host");
  const auto replay = dispatcher.take_outbound();
  require(replay.size() == 1 && replay[0].replayed && replay[0].ok,
          "idempotent completion was not replayed");
  require(!replay[0].native_program_result.undo_available,
          "replay incorrectly advertised a new Undo action");
  require(host.programs == 1, "idempotent replay executed twice");
}

void control_invalidation_and_cancel_remain_internal() {
  TestClock clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), clock);
  TestHost host;

  Request graph;
  graph.request_id = "11111111-1111-4111-8111-111111111116";
  graph.capability_id = std::string(kProjectGraphInvalidateControl);
  graph.deadline = clock.now() + std::chrono::seconds(1);
  graph.route_id = "route-a";
  graph.session_generation = 1;
  require(dispatcher.enqueue(std::move(graph)).code == EnqueueCode::kAccepted,
          "graph invalidation control was rejected");
  const DrainBatch invalidated = dispatcher.drain(host);
  require(invalidated.completions.size() == 1 &&
              invalidated.completions[0].ok &&
              invalidated.completions[0]
                      .project_graph_invalidation_result.generation == 7,
          "graph invalidation control did not complete");
  require(dispatcher.take_outbound().size() == 1,
          "graph invalidation completion was not published");

  require(
      dispatcher
              .enqueue(request(
                  clock, "11111111-1111-4111-8111-111111111117",
                  parse_program(
                      R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]})")))
              .code == EnqueueCode::kAccepted,
      "queued program was rejected");
  require(
      dispatcher.cancel("route-a", 1, "11111111-1111-4111-8111-111111111117")
              .code == CancelCode::kQueuedCancelled,
      "queued program was not cancelled");
  const auto outbound = dispatcher.take_outbound();
  require(outbound.size() == 1 && !outbound[0].ok &&
              outbound[0].error_code == "CANCELLED",
          "cancel did not publish its terminal completion");
}

} // namespace

int main() {
  try {
    native_program_is_the_only_public_dispatch_route();
    write_program_has_one_undo_group_and_replays_idempotently();
    control_invalidation_and_cancel_remain_internal();
  } catch (const std::exception &error) {
    std::cerr << "host_dispatcher_test failed: " << error.what() << '\n';
    return 1;
  }
  std::cout << "host_dispatcher_test passed\n";
  return 0;
}
