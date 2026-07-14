#include "aemcp_native/host_dispatcher.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace std::chrono_literals;
using aemcp::native::DispatcherConfig;
using aemcp::native::EnqueueCode;
using aemcp::native::HostApi;
using aemcp::native::HostDispatcher;
using aemcp::native::HostReadResult;
using aemcp::native::ProjectSummary;
using aemcp::native::Request;
using aemcp::native::TimePoint;
using aemcp::native::kProjectSummaryCapability;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

class FakeClock final : public aemcp::native::Clock {
 public:
  [[nodiscard]] TimePoint now() const noexcept override { return current_; }
  void advance(std::chrono::milliseconds amount) { current_ += amount; }

 private:
  TimePoint current_{TimePoint{} + 1h};
};

class FakeHost final : public HostApi {
 public:
  FakeHost(FakeClock& clock, std::thread::id expected_thread)
      : clock_(clock), expected_thread_(expected_thread) {}

  [[nodiscard]] HostReadResult read_project_summary(TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_, "HostApi ran off owner thread");
    observed_deadline = work_deadline;
    ++calls;
    clock_.advance(delay);
    if (clock_.now() >= work_deadline) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "fake host budget elapsed");
    }
    if (!error_code.empty()) return HostReadResult::failure(error_code, "fake host error");
    return HostReadResult::success({true, "fixture.aep", 3});
  }

  FakeClock& clock_;
  std::thread::id expected_thread_;
  std::chrono::milliseconds delay{0};
  TimePoint observed_deadline{};
  std::string error_code;
  int calls{0};
};

Request request(FakeClock& clock, std::string id, std::chrono::milliseconds ttl = 100ms) {
  return {std::move(id), std::string(kProjectSummaryCapability), clock.now() + ttl};
}

void worker_to_owner_dispatch() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  EnqueueCode result = EnqueueCode::kInvalidRequest;
  std::thread worker([&] { result = dispatcher.enqueue(request(clock, "worker-1")).code; });
  worker.join();
  require(result == EnqueueCode::kAccepted, "worker enqueue was rejected");
  const auto batch = dispatcher.drain(host);
  require(!batch.wrong_thread && batch.completions.size() == 1, "owner drain failed");
  require(batch.completions[0].ok, "project summary did not succeed");
  require(batch.completions[0].result.item_count == 3, "project summary was changed");
  require(host.calls == 1, "host call count mismatch");
  require(host.observed_deadline == clock.now() - host.delay + 4ms,
      "host did not receive the idle work deadline");
}

void admission_is_closed_and_bounded() {
  FakeClock clock;
  HostDispatcher dispatcher(
      std::this_thread::get_id(), clock, DispatcherConfig{1, 1, 4ms});
  require(dispatcher.enqueue({"bad id", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "invalid request id was accepted");
  require(dispatcher.enqueue({"-leading", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "leading punctuation in request id was accepted");
  require(dispatcher.enqueue({"é", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "non-ASCII request id was accepted");
  require(dispatcher.enqueue({"unknown", "native.raw", clock.now() + 1s}).code
      == EnqueueCode::kUnsupportedCapability, "unknown capability was accepted");
  require(dispatcher.enqueue(request(clock, "first")).code == EnqueueCode::kAccepted,
      "valid request was rejected");
  require(dispatcher.enqueue(request(clock, "first")).code == EnqueueCode::kDuplicateRequest,
      "duplicate request was accepted");
  require(dispatcher.enqueue(request(clock, "second")).code == EnqueueCode::kQueueFull,
      "queue bound was not enforced");
}

void wrong_thread_is_state_preserving() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "queued")).code == EnqueueCode::kAccepted,
      "setup enqueue failed");
  aemcp::native::DrainBatch worker_batch;
  std::thread worker([&] { worker_batch = dispatcher.drain(host); });
  worker.join();
  require(worker_batch.wrong_thread, "worker drain was not rejected");
  require(dispatcher.queued() == 1 && host.calls == 0, "wrong-thread drain changed state");
  require(dispatcher.drain(host).completions.size() == 1, "owner could not recover request");
}

void deadlines_and_late_results_are_safe() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "expired", 1ms)).code == EnqueueCode::kAccepted,
      "expiring request setup failed");
  clock.advance(2ms);
  auto batch = dispatcher.drain(host);
  require(batch.completions[0].error_code == "DEADLINE_EXCEEDED" && host.calls == 0,
      "expired request reached HostApi");

  require(dispatcher.enqueue(request(clock, "late", 2ms)).code == EnqueueCode::kAccepted,
      "late request setup failed");
  host.delay = 3ms;
  batch = dispatcher.drain(host);
  require(batch.completions[0].error_code == "DEADLINE_EXCEEDED"
          && batch.completions[0].late_result_discarded,
      "late host result was not discarded");
}

void idle_budget_and_shutdown_are_bounded() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, DispatcherConfig{4, 4, 2ms});
  FakeHost host(clock, owner);
  host.delay = 2ms;
  require(dispatcher.enqueue(request(clock, "budget-1", 1s)).code == EnqueueCode::kAccepted,
      "first budget request failed");
  require(dispatcher.enqueue(request(clock, "budget-2", 1s)).code == EnqueueCode::kAccepted,
      "second budget request failed");
  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.remaining == 1 && batch.budget_exhausted,
      "idle budget did not preserve remaining work");
  const auto stopped = dispatcher.shutdown();
  require(stopped.size() == 1 && stopped[0].error_code == "AE_SHUTTING_DOWN",
      "shutdown did not terminate queued request");
  require(dispatcher.enqueue(request(clock, "after-stop", 1s)).code
      == EnqueueCode::kShuttingDown, "request was admitted after shutdown");
  require(dispatcher.shutdown().empty(), "shutdown was not idempotent");
}

}  // namespace

int main() {
  worker_to_owner_dispatch();
  admission_is_closed_and_bounded();
  wrong_thread_is_state_preserving();
  deadlines_and_late_results_are_safe();
  idle_budget_and_shutdown_are_bounded();
  std::cout << "host_dispatcher_test: PASS\n";
  return 0;
}
