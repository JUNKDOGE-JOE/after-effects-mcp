#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <vector>

namespace aemcp::native {

inline constexpr std::string_view kProjectSummaryCapability = "ae.project.summary";

using TimePoint = std::chrono::steady_clock::time_point;

class Clock {
 public:
  virtual ~Clock() = default;
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
};

enum class EnqueueCode {
  kAccepted,
  kInvalidRequest,
  kUnsupportedCapability,
  kDuplicateRequest,
  kDeadlineExceeded,
  kQueueFull,
  kShuttingDown,
};

struct EnqueueResult {
  EnqueueCode code{EnqueueCode::kInvalidRequest};
  std::string error_code;
};

struct Completion {
  std::string request_id;
  std::string capability_id;
  bool ok{false};
  ProjectSummary result;
  std::string error_code;
  std::string message;
  bool late_result_discarded{false};
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
};

class HostDispatcher final {
 public:
  HostDispatcher(std::thread::id owner_thread, Clock& clock, DispatcherConfig config = {});
  HostDispatcher(const HostDispatcher&) = delete;
  HostDispatcher& operator=(const HostDispatcher&) = delete;

  [[nodiscard]] EnqueueResult enqueue(Request request);
  [[nodiscard]] DrainBatch drain(HostApi& host);
  [[nodiscard]] std::vector<Completion> shutdown();
  [[nodiscard]] std::size_t queued() const;
  [[nodiscard]] bool running() const;

 private:
  enum class State { kRunning, kStopping, kStopped };

  [[nodiscard]] Completion expired(const Request& request, bool late) const;
  void finish_request(const std::string& request_id);

  const std::thread::id owner_thread_;
  Clock& clock_;
  const DispatcherConfig config_;
  mutable std::mutex mutex_;
  State state_{State::kRunning};
  std::deque<Request> queue_;
  std::unordered_set<std::string> active_request_ids_;
};

}  // namespace aemcp::native
