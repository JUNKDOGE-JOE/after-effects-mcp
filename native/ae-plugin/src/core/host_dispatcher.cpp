#include "aemcp_native/host_dispatcher.hpp"

#include <algorithm>
#include <functional>
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

bool valid_route(std::string_view route_id, std::uint64_t session_generation) {
  // Empty/zero is the one legacy in-process route. The authenticated transport
  // supplies an opaque, bounded route; its syntax is deliberately not parsed.
  if (route_id.empty()) return session_generation == 0;
  return session_generation > 0 && route_id.size() <= 128
      && route_id.find('\0') == std::string_view::npos;
}

Completion failure_for(const Request& request, std::string code, std::string message) {
  Completion completion;
  completion.request_id = request.request_id;
  completion.capability_id = request.capability_id;
  completion.route_id = request.route_id;
  completion.session_generation = request.session_generation;
  completion.error_code = std::move(code);
  completion.message = std::move(message);
  return completion;
}

void hash_combine(std::size_t& seed, std::size_t value) noexcept {
  seed ^= value + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
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

std::size_t HostDispatcher::RequestKeyHash::operator()(const RequestKey& key) const noexcept {
  std::size_t value = std::hash<std::string>{}(key.route_id);
  hash_combine(value, std::hash<std::uint64_t>{}(key.session_generation));
  hash_combine(value, std::hash<std::string>{}(key.request_id));
  return value;
}

HostDispatcher::HostDispatcher(
    std::thread::id owner_thread, Clock& clock, DispatcherConfig config)
    : owner_thread_(owner_thread), clock_(clock), config_(config) {
  if (owner_thread_ == std::thread::id{} || config_.max_queue_depth == 0
      || config_.max_queue_depth > 256 || config_.max_tasks_per_idle == 0
      || config_.max_tasks_per_idle > 64 || config_.idle_budget.count() <= 0
      || config_.idle_budget > std::chrono::milliseconds(16)
      || config_.max_outbound_depth == 0 || config_.max_outbound_depth > 512
      || config_.max_terminal_tombstones == 0
      || config_.max_terminal_tombstones > 4096
      || config_.terminal_ttl.count() <= 0
      || config_.terminal_ttl > std::chrono::milliseconds(300000)
      || config_.max_route_fences == 0 || config_.max_route_fences > 4096) {
    throw std::invalid_argument("invalid native host dispatcher configuration");
  }
}

EnqueueResult HostDispatcher::enqueue(Request request) {
  if (!valid_request_id(request.request_id) || request.capability_id.empty()
      || !valid_route(request.route_id, request.session_generation)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_REQUEST"};
  }
  if (request.capability_id != kProjectSummaryCapability) {
    return {EnqueueCode::kUnsupportedCapability, "NATIVE_UNSUPPORTED"};
  }
  const TimePoint now = clock_.now();
  if (request.deadline <= now) {
    return {EnqueueCode::kDeadlineExceeded, "DEADLINE_EXCEEDED"};
  }

  std::lock_guard lock(mutex_);
  if (state_ != State::kRunning) {
    return {EnqueueCode::kShuttingDown, "AE_SHUTTING_DOWN"};
  }
  purge_terminal_locked(now);
  const RequestKey key = key_for(request);
  if (route_stale_locked(key.route_id, key.session_generation)) {
    return {EnqueueCode::kStaleRoute, "SESSION_STALE"};
  }
  if (active_requests_.contains(key) || terminal_locked(key)
      || pending_outbound_locked(key)) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  if (queue_.size() >= config_.max_queue_depth
      || outbound_.size() + active_requests_.size() >= config_.max_outbound_depth) {
    return {EnqueueCode::kQueueFull, "QUEUE_FULL"};
  }
  const auto [active, inserted] = active_requests_.insert(key);
  if (!inserted) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  try {
    queue_.push_back(std::move(request));
  } catch (...) {
    active_requests_.erase(active);
    throw;
  }
  return {EnqueueCode::kAccepted, {}};
}

CancelResult HostDispatcher::cancel(
    std::string_view route_id,
    std::uint64_t session_generation,
    std::string_view target_request_id) {
  if (!valid_route(route_id, session_generation) || !valid_request_id(target_request_id)) {
    return {CancelCode::kInvalidRequest, false};
  }

  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  RequestKey key{std::string(route_id), session_generation, std::string(target_request_id)};
  if (terminal_locked(key) || pending_outbound_locked(key)) {
    return {CancelCode::kAlreadyTerminal, false};
  }
  if (route_revoked_locked(route_id, session_generation)) {
    return {CancelCode::kStaleRoute, false};
  }

  const auto queued = std::find_if(queue_.begin(), queue_.end(), [&](const Request& request) {
    return request.route_id == route_id && request.session_generation == session_generation
        && request.request_id == target_request_id;
  });
  if (queued != queue_.end()) {
    Completion completion = failure_for(
        *queued, "CANCELLED", "native request was cancelled before host dispatch");
    queue_.erase(queued);
    finish_request_locked(key, completion, now);
    return {CancelCode::kQueuedCancelled, true};
  }
  if (active_requests_.contains(key)) {
    return {CancelCode::kRunningNotCancellable, true};
  }
  if (route_stale_locked(route_id, session_generation)) {
    return {CancelCode::kStaleRoute, false};
  }
  return {CancelCode::kNotFound, false};
}

RouteRevocationResult HostDispatcher::revoke_route(
    std::string_view route_id, std::uint64_t session_generation) {
  RouteRevocationResult result;
  if (!valid_route(route_id, session_generation)) return result;

  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  result.fence_recorded = fence_route_locked(std::string(route_id), session_generation);
  result.fence_saturated = route_fences_saturated_;

  for (Completion& completion : outbound_) {
    if (completion.route_id == route_id
        && completion.session_generation <= session_generation
        && !completion.route_revoked) {
      completion.route_revoked = true;
      ++result.pending_outbound_marked;
    }
  }

  auto queued = queue_.begin();
  while (queued != queue_.end()) {
    if (queued->route_id != route_id || queued->session_generation > session_generation) {
      ++queued;
      continue;
    }
    const RequestKey key = key_for(*queued);
    Completion completion = failure_for(
        *queued, "CANCELLED", "native request route was revoked before host dispatch");
    completion.route_revoked = true;
    queued = queue_.erase(queued);
    finish_request_locked(key, completion, now);
    ++result.queued_cancelled;
  }

  for (const RequestKey& key : active_requests_) {
    if (key.route_id == route_id && key.session_generation <= session_generation) {
      if (detached_requests_.insert(key).second) ++result.running_detached;
    }
  }
  return result;
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
          completion.route_id = request.route_id;
          completion.session_generation = request.session_generation;
          completion.ok = true;
          completion.result = std::move(host_result.value);
        }
      } catch (...) {
        completion = failure_for(
            request, "CAPABILITY_FAILED", "native host adapter raised an exception");
      }
    }
    {
      std::lock_guard lock(mutex_);
      finish_request_locked(key_for(request), completion, clock_.now());
    }
    batch.completions.push_back(std::move(completion));
  }

  batch.remaining = queued();
  if (batch.remaining > 0 && batch.completions.size() >= config_.max_tasks_per_idle) {
    batch.budget_exhausted = true;
  }
  return batch;
}

std::vector<Completion> HostDispatcher::take_outbound(std::size_t max_items) {
  std::vector<Completion> completions;
  if (max_items == 0) return completions;
  std::lock_guard lock(mutex_);
  const std::size_t count = std::min(max_items, outbound_.size());
  completions.reserve(count);
  for (std::size_t index = 0; index < count; ++index) {
    completions.push_back(std::move(outbound_.front()));
    outbound_.pop_front();
  }
  return completions;
}

std::vector<Completion> HostDispatcher::shutdown() {
  if (std::this_thread::get_id() != owner_thread_) {
    throw std::logic_error("native host dispatcher shutdown must run on its owner thread");
  }
  std::vector<Completion> completions;
  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  if (state_ == State::kStopped) return completions;
  state_ = State::kStopping;
  completions.reserve(queue_.size());
  while (!queue_.empty()) {
    Request request = std::move(queue_.front());
    queue_.pop_front();
    Completion completion = failure_for(
        request, "AE_SHUTTING_DOWN", "After Effects is shutting down");
    finish_request_locked(key_for(request), completion, now);
    completions.push_back(std::move(completion));
  }
  state_ = State::kStopped;
  return completions;
}

std::size_t HostDispatcher::queued() const {
  std::lock_guard lock(mutex_);
  return queue_.size();
}

std::size_t HostDispatcher::outbound() const {
  std::lock_guard lock(mutex_);
  return outbound_.size();
}

std::size_t HostDispatcher::terminal_count() {
  std::lock_guard lock(mutex_);
  purge_terminal_locked(clock_.now());
  return terminal_tombstones_.size();
}

bool HostDispatcher::has_terminal(
    std::string_view route_id,
    std::uint64_t session_generation,
    std::string_view request_id) {
  if (!valid_route(route_id, session_generation) || !valid_request_id(request_id)) return false;
  std::lock_guard lock(mutex_);
  purge_terminal_locked(clock_.now());
  return terminal_locked(
      {std::string(route_id), session_generation, std::string(request_id)});
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

HostDispatcher::RequestKey HostDispatcher::key_for(const Request& request) {
  return {request.route_id, request.session_generation, request.request_id};
}

bool HostDispatcher::route_revoked_locked(
    std::string_view route_id, std::uint64_t session_generation) const {
  const auto fence = route_fences_.find(std::string(route_id));
  return fence != route_fences_.end() && session_generation <= fence->second;
}

bool HostDispatcher::route_stale_locked(
    std::string_view route_id, std::uint64_t session_generation) const {
  if (route_revoked_locked(route_id, session_generation)) return true;
  // Fences are never evicted. Once their bounded registry is exhausted, an
  // unseen authenticated route fails closed until the AE plug-in restarts.
  return !route_id.empty() && route_fences_saturated_
      && route_fences_.find(std::string(route_id)) == route_fences_.end();
}

bool HostDispatcher::pending_outbound_locked(const RequestKey& key) const {
  return std::any_of(outbound_.begin(), outbound_.end(), [&](const Completion& completion) {
    return completion.route_id == key.route_id
        && completion.session_generation == key.session_generation
        && completion.request_id == key.request_id;
  });
}

bool HostDispatcher::terminal_locked(const RequestKey& key) const {
  return std::any_of(
      terminal_tombstones_.begin(), terminal_tombstones_.end(),
      [&](const TerminalTombstone& tombstone) { return tombstone.key == key; });
}

void HostDispatcher::purge_terminal_locked(TimePoint now) {
  std::erase_if(terminal_tombstones_, [&](const TerminalTombstone& tombstone) {
    return tombstone.expires_at <= now;
  });
}

void HostDispatcher::remember_terminal_locked(RequestKey key, TimePoint now) {
  // Active admission excludes an existing tombstone for this key, so append
  // before eviction. Allocation failure then preserves every older fence.
  terminal_tombstones_.push_back({std::move(key), now + config_.terminal_ttl});
  while (terminal_tombstones_.size() > config_.max_terminal_tombstones) {
    terminal_tombstones_.pop_front();
  }
}

bool HostDispatcher::fence_route_locked(
    std::string route_id, std::uint64_t session_generation) {
  const auto existing = route_fences_.find(route_id);
  if (existing != route_fences_.end()) {
    existing->second = std::max(existing->second, session_generation);
    return true;
  }
  if (route_fences_.size() >= config_.max_route_fences) {
    route_fences_saturated_ = true;
    return false;
  }
  route_fences_.emplace(std::move(route_id), session_generation);
  return true;
}

void HostDispatcher::finish_request_locked(
    const RequestKey& key, Completion& completion, TimePoint now) {
  if (route_revoked_locked(key.route_id, key.session_generation)
      || detached_requests_.contains(key)) {
    completion.route_revoked = true;
  }
  outbound_.push_back(completion);
  remember_terminal_locked(key, now);
  active_requests_.erase(key);
  detached_requests_.erase(key);
}

}  // namespace aemcp::native
