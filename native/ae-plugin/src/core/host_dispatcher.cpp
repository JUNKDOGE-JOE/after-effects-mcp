#include "aemcp_native/host_dispatcher.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace aemcp::native {
namespace {

bool valid_request_id(std::string_view value) {
  if (value.empty() || value.size() > 64) return false;
  const auto ascii_alphanumeric = [](unsigned char character) {
    return (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9');
  };
  if (!ascii_alphanumeric(static_cast<unsigned char>(value.front()))) return false;
  return std::all_of(value.begin() + 1, value.end(), [&](unsigned char character) {
    return ascii_alphanumeric(character) || character == '.' || character == '_'
        || character == ':' || character == '-';
  });
}

Completion failure_for(const Request& request, std::string code, std::string message) {
  Completion completion;
  completion.request_id = request.request_id;
  completion.capability_id = request.capability_id;
  completion.error_code = std::move(code);
  completion.message = std::move(message);
  return completion;
}

}  // namespace

TimePoint SystemClock::now() const noexcept {
  return std::chrono::steady_clock::now();
}

HostReadResult HostReadResult::success(ProjectSummary summary) {
  HostReadResult result;
  result.ok = true;
  result.value = std::move(summary);
  return result;
}

HostReadResult HostReadResult::failure(std::string code, std::string detail) {
  HostReadResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostDispatcher::HostDispatcher(
    std::thread::id owner_thread, Clock& clock, DispatcherConfig config)
    : owner_thread_(owner_thread), clock_(clock), config_(config) {
  if (owner_thread_ == std::thread::id{} || config_.max_queue_depth == 0
      || config_.max_queue_depth > 256 || config_.max_tasks_per_idle == 0
      || config_.max_tasks_per_idle > 64 || config_.idle_budget.count() <= 0
      || config_.idle_budget > std::chrono::milliseconds(16)) {
    throw std::invalid_argument("invalid native host dispatcher configuration");
  }
}

EnqueueResult HostDispatcher::enqueue(Request request) {
  if (!valid_request_id(request.request_id) || request.capability_id.empty()) {
    return {EnqueueCode::kInvalidRequest, "INVALID_REQUEST"};
  }
  if (request.capability_id != kProjectSummaryCapability) {
    return {EnqueueCode::kUnsupportedCapability, "NATIVE_UNSUPPORTED"};
  }
  if (request.deadline <= clock_.now()) {
    return {EnqueueCode::kDeadlineExceeded, "DEADLINE_EXCEEDED"};
  }

  std::lock_guard lock(mutex_);
  if (state_ != State::kRunning) {
    return {EnqueueCode::kShuttingDown, "AE_SHUTTING_DOWN"};
  }
  if (active_request_ids_.contains(request.request_id)) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  if (queue_.size() >= config_.max_queue_depth) {
    return {EnqueueCode::kQueueFull, "QUEUE_FULL"};
  }
  const auto [active, inserted] = active_request_ids_.insert(request.request_id);
  if (!inserted) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  try {
    queue_.push_back(std::move(request));
  } catch (...) {
    active_request_ids_.erase(active);
    throw;
  }
  return {EnqueueCode::kAccepted, {}};
}

DrainBatch HostDispatcher::drain(HostApi& host) {
  DrainBatch batch;
  if (std::this_thread::get_id() != owner_thread_) {
    batch.wrong_thread = true;
    batch.remaining = queued();
    return batch;
  }

  const TimePoint started = clock_.now();
  const TimePoint idle_deadline = started + config_.idle_budget;
  while (batch.completions.size() < config_.max_tasks_per_idle) {
    if (!batch.completions.empty() && clock_.now() - started >= config_.idle_budget) {
      batch.budget_exhausted = true;
      break;
    }

    Request request;
    {
      std::lock_guard lock(mutex_);
      if (state_ != State::kRunning || queue_.empty()) break;
      request = std::move(queue_.front());
      queue_.pop_front();
    }

    Completion completion;
    if (request.deadline <= clock_.now()) {
      completion = expired(request, false);
    } else {
      try {
        HostReadResult host_result = host.read_project_summary(
            std::min(request.deadline, idle_deadline));
        if (clock_.now() > request.deadline) {
          completion = expired(request, true);
        } else if (!host_result.ok) {
          completion = failure_for(
              request,
              host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
              host_result.message.empty() ? "native capability failed" : host_result.message);
        } else {
          completion.request_id = request.request_id;
          completion.capability_id = request.capability_id;
          completion.ok = true;
          completion.result = std::move(host_result.value);
        }
      } catch (...) {
        completion = failure_for(
            request, "CAPABILITY_FAILED", "native host adapter raised an exception");
      }
    }
    finish_request(request.request_id);
    batch.completions.push_back(std::move(completion));
  }

  batch.remaining = queued();
  if (batch.remaining > 0 && batch.completions.size() >= config_.max_tasks_per_idle) {
    batch.budget_exhausted = true;
  }
  return batch;
}

std::vector<Completion> HostDispatcher::shutdown() {
  std::vector<Completion> completions;
  std::lock_guard lock(mutex_);
  if (state_ == State::kStopped) return completions;
  state_ = State::kStopping;
  completions.reserve(queue_.size());
  while (!queue_.empty()) {
    const Request& request = queue_.front();
    completions.push_back(failure_for(
        request, "AE_SHUTTING_DOWN", "After Effects is shutting down"));
    active_request_ids_.erase(request.request_id);
    queue_.pop_front();
  }
  state_ = State::kStopped;
  return completions;
}

std::size_t HostDispatcher::queued() const {
  std::lock_guard lock(mutex_);
  return queue_.size();
}

bool HostDispatcher::running() const {
  std::lock_guard lock(mutex_);
  return state_ == State::kRunning;
}

Completion HostDispatcher::expired(const Request& request, bool late) const {
  Completion completion = failure_for(
      request, "DEADLINE_EXCEEDED", "native request deadline elapsed");
  completion.late_result_discarded = late;
  return completion;
}

void HostDispatcher::finish_request(const std::string& request_id) {
  std::lock_guard lock(mutex_);
  active_request_ids_.erase(request_id);
}

}  // namespace aemcp::native
