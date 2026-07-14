#include "aemcp_native/host_dispatcher.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace std::chrono_literals;
using aemcp::native::CancelCode;
using aemcp::native::CancelResult;
using aemcp::native::DispatcherConfig;
using aemcp::native::EnqueueCode;
using aemcp::native::HostApi;
using aemcp::native::HostDispatcher;
using aemcp::native::HostReadResult;
using aemcp::native::Request;
using aemcp::native::RouteRevocationResult;
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
  [[nodiscard]] TimePoint now() const noexcept override {
    return TimePoint{} + std::chrono::milliseconds(current_ms_.load());
  }
  void advance(std::chrono::milliseconds amount) { current_ms_.fetch_add(amount.count()); }

 private:
  std::atomic<std::int64_t> current_ms_{3600000};
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

class BlockingHost final : public HostApi {
 public:
  explicit BlockingHost(std::thread::id expected_thread)
      : expected_thread_(expected_thread) {}

  [[nodiscard]] HostReadResult read_project_summary(TimePoint) override {
    require(std::this_thread::get_id() == expected_thread_, "blocking host ran off owner thread");
    std::unique_lock lock(mutex_);
    entered_ = true;
    condition_.notify_all();
    require(condition_.wait_for(lock, 2s, [&] { return released_; }),
        "blocking host timed out waiting for worker");
    return HostReadResult::success({true, "running.aep", 7});
  }

  void wait_until_entered() {
    std::unique_lock lock(mutex_);
    require(condition_.wait_for(lock, 2s, [&] { return entered_; }),
        "worker timed out waiting for blocking host");
  }

  void release() {
    std::lock_guard lock(mutex_);
    released_ = true;
    condition_.notify_all();
  }

 private:
  std::thread::id expected_thread_;
  std::mutex mutex_;
  std::condition_variable condition_;
  bool entered_{false};
  bool released_{false};
};

Request request(
    FakeClock& clock,
    std::string id,
    std::chrono::milliseconds ttl = 100ms,
    std::string route_id = {},
    std::uint64_t session_generation = 0) {
  return {
      std::move(id),
      std::string(kProjectSummaryCapability),
      clock.now() + ttl,
      std::move(route_id),
      session_generation,
  };
}

DispatcherConfig config(
    std::size_t queue,
    std::size_t tasks,
    std::chrono::milliseconds budget,
    std::size_t outbound = 64,
    std::size_t tombstones = 128,
    std::chrono::milliseconds tombstone_ttl = 60s,
    std::size_t route_fences = 128) {
  return {queue, tasks, budget, outbound, tombstones, tombstone_ttl, route_fences};
}

void worker_to_owner_dispatch_and_outbound_transfer() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  EnqueueCode result = EnqueueCode::kInvalidRequest;
  std::thread worker([&] {
    result = dispatcher.enqueue(request(clock, "worker-1", 100ms, "route-a", 7)).code;
  });
  worker.join();
  require(result == EnqueueCode::kAccepted, "worker enqueue was rejected");
  const auto batch = dispatcher.drain(host);
  require(!batch.wrong_thread && batch.completions.size() == 1, "owner drain failed");
  require(batch.completions[0].ok, "project summary did not succeed");
  require(batch.completions[0].result.item_count == 3, "project summary was changed");
  require(batch.completions[0].route_id == "route-a"
          && batch.completions[0].session_generation == 7,
      "drain completion lost its route generation");
  require(host.calls == 1, "host call count mismatch");
  require(host.observed_deadline == clock.now() - host.delay + 4ms,
      "host did not receive the idle work deadline");

  std::vector<aemcp::native::Completion> outbound;
  std::thread outbound_worker([&] { outbound = dispatcher.take_outbound(); });
  outbound_worker.join();
  require(outbound.size() == 1 && outbound[0].route_id == "route-a"
          && outbound[0].session_generation == 7 && outbound[0].ok,
      "worker did not receive typed routed outbound completion");
  require(dispatcher.outbound() == 0, "outbound transfer did not consume its item");
}

void admission_is_closed_and_bounded() {
  FakeClock clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), clock, config(1, 1, 4ms));
  require(dispatcher.enqueue({
      "bad id", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "invalid request id was accepted");
  require(dispatcher.enqueue({
      "-leading", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "leading punctuation in request id was accepted");
  require(dispatcher.enqueue({
      "é", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "non-ASCII request id was accepted");
  require(dispatcher.enqueue({"unknown", "native.raw", clock.now() + 1s}).code
      == EnqueueCode::kUnsupportedCapability, "unknown capability was accepted");
  require(dispatcher.enqueue(request(clock, "bad-route", 1s, {}, 1)).code
      == EnqueueCode::kInvalidRequest, "ambiguous legacy route was accepted");
  require(dispatcher.enqueue(request(clock, "bad-generation", 1s, "route", 0)).code
      == EnqueueCode::kInvalidRequest, "authenticated zero generation was accepted");
  require(dispatcher.enqueue(request(clock, "first")).code == EnqueueCode::kAccepted,
      "valid request was rejected");
  require(dispatcher.enqueue(request(clock, "first")).code
      == EnqueueCode::kDuplicateRequest, "duplicate request was accepted");
  require(dispatcher.enqueue(request(clock, "second")).code == EnqueueCode::kQueueFull,
      "queue bound was not enforced");
}

void request_identity_is_route_scoped_and_tombstones_expire() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 8, 8, 10ms));
  FakeHost host(clock, owner);

  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "first routed identity was rejected");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-b", 1)).code
      == EnqueueCode::kAccepted, "request id collided across routes");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 2)).code
      == EnqueueCode::kAccepted, "request id collided across route generations");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kDuplicateRequest, "exact active route identity was replayed");

  require(dispatcher.drain(host).completions.size() == 3, "routed requests did not drain");
  require(dispatcher.has_terminal("route-a", 1, "same"), "terminal tombstone missing");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kDuplicateRequest, "terminal request was replayed");
  require(dispatcher.take_outbound().size() == 3, "routed outbound count mismatch");
  clock.advance(11ms);
  require(!dispatcher.has_terminal("route-a", 1, "same"), "terminal TTL did not expire");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "expired and observed tombstone still blocked admission");
  require(dispatcher.shutdown().size() == 1, "TTL test cleanup did not terminate request");
}

void terminal_tombstones_are_fifo_bounded() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(2, 1, 4ms, 4, 2, 1s));
  FakeHost host(clock, owner);
  for (const std::string id : {"one", "two", "three"}) {
    require(dispatcher.enqueue(request(clock, id, 1s, "route", 1)).code
        == EnqueueCode::kAccepted, "bounded tombstone setup enqueue failed");
    require(dispatcher.drain(host).completions.size() == 1,
        "bounded tombstone setup drain failed");
    require(dispatcher.take_outbound().size() == 1,
        "bounded tombstone setup outbound failed");
  }
  require(dispatcher.terminal_count() == 2, "terminal tombstone capacity was not enforced");
  require(!dispatcher.has_terminal("route", 1, "one")
          && dispatcher.has_terminal("route", 1, "two")
          && dispatcher.has_terminal("route", 1, "three"),
      "terminal tombstones were not evicted in deterministic FIFO order");
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
  bool shutdown_rejected = false;
  std::thread shutdown_worker([&] {
    try {
      static_cast<void>(dispatcher.shutdown());
    } catch (const std::logic_error&) {
      shutdown_rejected = true;
    }
  });
  shutdown_worker.join();
  require(shutdown_rejected && dispatcher.running() && dispatcher.queued() == 1,
      "wrong-thread shutdown violated owner lifecycle discipline");
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
  const auto outbound = dispatcher.take_outbound();
  require(outbound.size() == 2 && outbound[1].late_result_discarded,
      "deadline terminal evidence did not reach outbound");
}

void outbound_capacity_applies_backpressure_until_worker_takes() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 2));
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "one", 1s, "route", 1)).code
      == EnqueueCode::kAccepted, "first outbound setup failed");
  require(dispatcher.enqueue(request(clock, "two", 1s, "route", 1)).code
      == EnqueueCode::kAccepted, "second outbound setup failed");
  require(dispatcher.drain(host).completions.size() == 2, "outbound setup did not drain");
  require(dispatcher.outbound() == 2, "outbound queue was not populated");
  require(dispatcher.enqueue(request(clock, "three", 1s, "route", 1)).code
      == EnqueueCode::kQueueFull, "outbound saturation admitted hanging work");

  std::vector<aemcp::native::Completion> taken;
  std::thread worker([&] { taken = dispatcher.take_outbound(1); });
  worker.join();
  require(taken.size() == 1, "worker could not take bounded outbound item");
  require(dispatcher.enqueue(request(clock, "three", 1s, "route", 1)).code
      == EnqueueCode::kAccepted, "worker take did not release outbound capacity");
  require(dispatcher.drain(host).completions.size() == 1,
      "post-backpressure request did not drain");
  require(dispatcher.outbound() == 2, "outbound capacity accounting drifted");
}

void queued_and_running_cancellation_are_distinct() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 8));
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "target", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "queued cancel target setup failed");
  require(dispatcher.enqueue(request(clock, "target", 1s, "route-b", 1)).code
      == EnqueueCode::kAccepted, "cross-route cancel control setup failed");
  const CancelResult queued = dispatcher.cancel("route-a", 1, "target");
  require(queued.code == CancelCode::kQueuedCancelled && queued.terminal_response_expected,
      "queued request did not cancel atomically");
  require(dispatcher.cancel("route-a", 1, "target").code == CancelCode::kAlreadyTerminal,
      "repeated queued cancel did not observe terminal state");
  require(dispatcher.queued() == 1, "queued cancel crossed its route boundary");
  const auto cancelled = dispatcher.take_outbound();
  require(cancelled.size() == 1 && cancelled[0].error_code == "CANCELLED"
          && cancelled[0].route_id == "route-a" && !cancelled[0].route_revoked,
      "queued cancellation did not produce routed terminal evidence");
  require(dispatcher.drain(host).completions.size() == 1,
      "other route did not survive targeted cancellation");

  require(dispatcher.enqueue(request(clock, "running", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "running cancel target setup failed");
  BlockingHost blocking(owner);
  CancelResult running;
  std::thread cancel_worker([&] {
    blocking.wait_until_entered();
    running = dispatcher.cancel("route-a", 1, "running");
    blocking.release();
  });
  const auto batch = dispatcher.drain(blocking);
  cancel_worker.join();
  require(running.code == CancelCode::kRunningNotCancellable
          && running.terminal_response_expected,
      "running before-dispatch capability did not report running-not-cancellable");
  require(batch.completions.size() == 1 && batch.completions[0].ok,
      "running request was incorrectly cancelled after dispatch");
}

void route_revocation_fences_generations_and_detaches_results() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(6, 6, 4ms, 12, 128, 60s, 1));
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "old-a", 1s, "shared", 1)).code
      == EnqueueCode::kAccepted, "old route request A setup failed");
  require(dispatcher.enqueue(request(clock, "old-b", 1s, "shared", 1)).code
      == EnqueueCode::kAccepted, "old route request B setup failed");
  require(dispatcher.enqueue(request(clock, "old-a", 1s, "shared", 2)).code
      == EnqueueCode::kAccepted, "new generation request setup failed");

  const RouteRevocationResult queued = dispatcher.revoke_route("shared", 1);
  require(queued.fence_recorded && !queued.fence_saturated
          && queued.queued_cancelled == 2 && queued.running_detached == 0,
      "route revoke did not cancel only its queued generation");
  require(dispatcher.queued() == 1, "route revoke cancelled the newer generation");
  const auto cancelled = dispatcher.take_outbound();
  require(cancelled.size() == 2 && cancelled[0].route_revoked
          && cancelled[1].route_revoked && cancelled[0].error_code == "CANCELLED",
      "revoked queued requests did not preserve detached terminal evidence");
  require(dispatcher.enqueue(request(clock, "stale", 1s, "shared", 1)).code
      == EnqueueCode::kStaleRoute, "revoked generation bypassed its fence");
  auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].session_generation == 2
          && !batch.completions[0].route_revoked,
      "newer route generation was detached by an older fence");
  require(dispatcher.revoke_route("shared", 1).pending_outbound_marked == 0,
      "late old-generation revoke marked a new-generation result");
  require(dispatcher.take_outbound().size() == 1,
      "new-generation outbound result was not independently observable");

  require(dispatcher.enqueue(request(clock, "mutation-shaped", 1s, "shared", 3)).code
      == EnqueueCode::kAccepted, "running revoke target setup failed");
  BlockingHost blocking(owner);
  RouteRevocationResult running;
  RouteRevocationResult repeated;
  std::thread revoke_worker([&] {
    blocking.wait_until_entered();
    running = dispatcher.revoke_route("shared", 3);
    repeated = dispatcher.revoke_route("shared", 3);
    blocking.release();
  });
  batch = dispatcher.drain(blocking);
  revoke_worker.join();
  require(running.running_detached == 1 && running.queued_cancelled == 0,
      "running request was not generation-detached");
  require(repeated.running_detached == 0 && repeated.fence_recorded,
      "repeated route revoke was not idempotent");
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && batch.completions[0].route_revoked,
      "post-disconnect running result lost detached terminal evidence");
  require(dispatcher.has_terminal("shared", 3, "mutation-shaped"),
      "post-disconnect terminal tombstone was not retained");

  require(dispatcher.enqueue(request(clock, "mutation-shaped", 1s, "shared", 4)).code
      == EnqueueCode::kAccepted, "new connection generation inherited stale request state");
  require(dispatcher.drain(host).completions.size() == 1,
      "new connection generation did not execute independently");
  const auto outbound = dispatcher.take_outbound();
  require(outbound.size() == 2
          && outbound[0].session_generation == 3 && outbound[0].route_revoked
          && outbound[1].session_generation == 4 && !outbound[1].route_revoked,
      "old terminal evidence could be confused with the new connection");
}

void saturated_route_fences_fail_closed_without_losing_running_evidence() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 8, 8, 1s, 1));
  require(dispatcher.revoke_route("recorded", 1).fence_recorded,
      "route fence capacity setup failed");
  require(dispatcher.enqueue(request(clock, "running", 1s, "unseen", 1)).code
      == EnqueueCode::kAccepted, "pre-saturation running route setup failed");

  BlockingHost blocking(owner);
  RouteRevocationResult revocation;
  std::thread worker([&] {
    blocking.wait_until_entered();
    revocation = dispatcher.revoke_route("unseen", 1);
    blocking.release();
  });
  const auto batch = dispatcher.drain(blocking);
  worker.join();
  require(!revocation.fence_recorded && revocation.fence_saturated
          && revocation.running_detached == 1,
      "saturated fence registry did not detach the active unknown route");
  require(batch.completions.size() == 1 && batch.completions[0].route_revoked,
      "saturated fence path lost detached running terminal evidence");
  require(dispatcher.enqueue(request(clock, "future", 1s, "unseen", 2)).code
      == EnqueueCode::kStaleRoute,
      "saturated fence registry evicted history instead of failing closed");
}

void idle_budget_and_shutdown_are_bounded() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 2ms));
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
  require(dispatcher.outbound() == 2,
      "shutdown did not place every terminal completion on outbound");
  require(dispatcher.has_terminal({}, 0, "budget-1")
          && dispatcher.has_terminal({}, 0, "budget-2"),
      "shutdown terminal tombstones are incomplete");
  require(dispatcher.enqueue(request(clock, "after-stop", 1s)).code
      == EnqueueCode::kShuttingDown, "request was admitted after shutdown");
  require(dispatcher.shutdown().empty(), "shutdown was not idempotent");
}

}  // namespace

int main() {
  worker_to_owner_dispatch_and_outbound_transfer();
  admission_is_closed_and_bounded();
  request_identity_is_route_scoped_and_tombstones_expire();
  terminal_tombstones_are_fifo_bounded();
  wrong_thread_is_state_preserving();
  deadlines_and_late_results_are_safe();
  outbound_capacity_applies_backpressure_until_worker_takes();
  queued_and_running_cancellation_are_distinct();
  route_revocation_fences_generations_and_detaches_results();
  saturated_route_fences_fail_closed_without_losing_running_evidence();
  idle_budget_and_shutdown_are_bounded();
  std::cout << "host_dispatcher_test: PASS\n";
  return 0;
}
