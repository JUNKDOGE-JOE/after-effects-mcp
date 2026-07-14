#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace aemcp::native {

inline constexpr std::string_view kProjectSummaryCapability = "ae.project.summary";

using TimePoint = std::chrono::steady_clock::time_point;

class Clock {
 public:
  virtual ~Clock() = default;
  // Dispatch admission and transport workers may call this concurrently.
  // Implementations must be thread-safe and monotonic.
  [[nodiscard]] virtual TimePoint now() const noexcept = 0;
};

class SystemClock final : public Clock {
 public:
  [[nodiscard]] TimePoint now() const noexcept override;
};

struct ProjectSummary {
  bool project_open{false};
  std::string project_name;
  std::int64_t item_count{0};
};

struct HostReadResult {
  bool ok{false};
  ProjectSummary value;
  std::string error_code;
  std::string message;

  [[nodiscard]] static HostReadResult success(ProjectSummary summary);
  [[nodiscard]] static HostReadResult failure(std::string code, std::string detail);
};

class HostApi {
 public:
  virtual ~HostApi() = default;
  [[nodiscard]] virtual HostReadResult read_project_summary(TimePoint work_deadline) = 0;
};

struct Request {
  std::string request_id;
  std::string capability_id;
  TimePoint deadline;
  // Opaque transport ownership. Authenticated IPC callers must supply a
  // non-empty route and monotonically increase the generation whenever that
  // route is re-bound.
  std::string route_id{};
  std::uint64_t session_generation{0};
};

enum class EnqueueCode {
  kAccepted,
  kInvalidRequest,
  kUnsupportedCapability,
  kDuplicateRequest,
  kDeadlineExceeded,
  kQueueFull,
  kStaleRoute,
  kShuttingDown,
};

struct EnqueueResult {
  EnqueueCode code{EnqueueCode::kInvalidRequest};
  std::string error_code;
};

struct Completion {
  std::string request_id;
  std::string capability_id;
  std::string route_id;
  std::uint64_t session_generation{0};
  bool ok{false};
  ProjectSummary result;
  std::string error_code;
  std::string message;
  bool late_result_discarded{false};
  // This is a snapshot for audit/filtering, not a send authorization. A
  // transport must exact-match route+generation under the same connection lock
  // used by close/revoke immediately before writing to a socket.
  bool route_revoked{false};
};

enum class CancelCode {
  kQueuedCancelled,
  kRunningNotCancellable,
  kAlreadyTerminal,
  kNotFound,
  kInvalidRequest,
  kStaleRoute,
};

struct CancelResult {
  CancelCode code{CancelCode::kInvalidRequest};
  bool terminal_response_expected{false};
};

struct RouteRevocationResult {
  bool fence_recorded{false};
  bool fence_saturated{false};
  std::size_t queued_cancelled{0};
  std::size_t running_detached{0};
  std::size_t pending_outbound_marked{0};
};

struct DrainBatch {
  bool wrong_thread{false};
  bool budget_exhausted{false};
  std::size_t remaining{0};
  std::vector<Completion> completions;
};

struct DispatcherConfig {
  std::size_t max_queue_depth{32};
  std::size_t max_tasks_per_idle{4};
  std::chrono::milliseconds idle_budget{4};
  std::size_t max_outbound_depth{64};
  std::size_t max_terminal_tombstones{128};
  std::chrono::milliseconds terminal_ttl{60000};
  std::size_t max_route_fences{128};
};

class HostDispatcher final {
 public:
  HostDispatcher(std::thread::id owner_thread, Clock& clock, DispatcherConfig config = {});
  HostDispatcher(const HostDispatcher&) = delete;
  HostDispatcher& operator=(const HostDispatcher&) = delete;

  [[nodiscard]] EnqueueResult enqueue(Request request);
  [[nodiscard]] CancelResult cancel(
      std::string_view route_id,
      std::uint64_t session_generation,
      std::string_view target_request_id);
  [[nodiscard]] RouteRevocationResult revoke_route(
      std::string_view route_id, std::uint64_t session_generation);
  [[nodiscard]] DrainBatch drain(HostApi& host);
  // Worker-side transfer only. Host suite calls and socket I/O intentionally
  // live on opposite sides of this bounded queue. Returned generations remain
  // immutable, but the transport owns the final synchronized send decision.
  [[nodiscard]] std::vector<Completion> take_outbound(std::size_t max_items = 64);
  // Lifecycle shutdown is owner-thread-only, keeping destruction serialized
  // with drain/HostApi execution. Wrong-thread calls throw std::logic_error.
  [[nodiscard]] std::vector<Completion> shutdown();
  [[nodiscard]] std::size_t queued() const;
  [[nodiscard]] std::size_t outbound() const;
  [[nodiscard]] std::size_t terminal_count();
  [[nodiscard]] bool has_terminal(
      std::string_view route_id,
      std::uint64_t session_generation,
      std::string_view request_id);
  [[nodiscard]] bool running() const;

 private:
  enum class State { kRunning, kStopping, kStopped };

  struct RequestKey {
    std::string route_id;
    std::uint64_t session_generation{0};
    std::string request_id;

    [[nodiscard]] bool operator==(const RequestKey&) const = default;
  };

  struct RequestKeyHash {
    [[nodiscard]] std::size_t operator()(const RequestKey& key) const noexcept;
  };

  struct TerminalTombstone {
    RequestKey key;
    TimePoint expires_at;
  };

  [[nodiscard]] Completion expired(const Request& request, bool late) const;
  [[nodiscard]] static RequestKey key_for(const Request& request);
  [[nodiscard]] bool route_revoked_locked(
      std::string_view route_id, std::uint64_t session_generation) const;
  [[nodiscard]] bool route_stale_locked(
      std::string_view route_id, std::uint64_t session_generation) const;
  [[nodiscard]] bool pending_outbound_locked(const RequestKey& key) const;
  [[nodiscard]] bool terminal_locked(const RequestKey& key) const;
  void purge_terminal_locked(TimePoint now);
  void remember_terminal_locked(RequestKey key, TimePoint now);
  [[nodiscard]] bool fence_route_locked(
      std::string route_id, std::uint64_t session_generation);
  void finish_request_locked(const RequestKey& key, Completion& completion, TimePoint now);

  const std::thread::id owner_thread_;
  Clock& clock_;
  const DispatcherConfig config_;
  mutable std::mutex mutex_;
  State state_{State::kRunning};
  std::deque<Request> queue_;
  std::deque<Completion> outbound_;
  std::deque<TerminalTombstone> terminal_tombstones_;
  std::unordered_set<RequestKey, RequestKeyHash> active_requests_;
  std::unordered_set<RequestKey, RequestKeyHash> detached_requests_;
  std::unordered_map<std::string, std::uint64_t> route_fences_;
  bool route_fences_saturated_{false};
};

}  // namespace aemcp::native
