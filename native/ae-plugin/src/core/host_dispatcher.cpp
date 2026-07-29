#include "aemcp_native/host_dispatcher.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace aemcp::native {
namespace {

bool valid_request_id(std::string_view value) {
  if (value.empty() || value.size() > 64)
    return false;
  const auto allowed = [](unsigned char character) {
    return (character >= 'A' && character <= 'Z') ||
           (character >= 'a' && character <= 'z') ||
           (character >= '0' && character <= '9') || character == '.' ||
           character == '_' || character == ':' || character == '-';
  };
  return allowed(static_cast<unsigned char>(value.front())) &&
         std::all_of(value.begin() + 1, value.end(), allowed);
}

bool valid_idempotency_key(std::string_view value) {
  return value.size() >= 16 && value.size() <= 64 && valid_request_id(value);
}

bool valid_sha256(std::string_view value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

bool valid_route(std::string_view route_id, std::uint64_t generation) {
  if (route_id.empty())
    return generation == 0;
  return generation > 0 && route_id.size() <= 128 &&
         route_id.find('\0') == std::string_view::npos;
}

Completion failure_for(const Request &request, std::string code,
                       std::string message, std::string field = {}) {
  Completion completion;
  completion.request_id = request.request_id;
  completion.capability_id = request.capability_id;
  completion.route_id = request.route_id;
  completion.session_generation = request.session_generation;
  completion.idempotency_key = request.idempotency_key;
  completion.error_code = std::move(code);
  completion.message = std::move(message);
  completion.error_field = std::move(field);
  if (request.capability_id == kNativeProgramCapability) {
    completion.native_program_result = NativeProgramHostResult::failure(
        completion.error_code, completion.message, completion.error_field, {},
        std::nullopt, false, NativeProgramDisposition::kNotStarted);
  }
  return completion;
}

void hash_combine(std::size_t &seed, std::size_t value) noexcept {
  seed ^= value + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
}

} // namespace

TimePoint SystemClock::now() const noexcept {
  return std::chrono::steady_clock::now();
}

std::size_t json_encoded_string_size(std::string_view value) noexcept {
  std::size_t result = 2;
  for (const unsigned char character : value) {
    const std::size_t additional =
        character == '"' || character == '\\' || character == '\b' ||
                character == '\f' || character == '\n' || character == '\r' ||
                character == '\t'
            ? 2U
            : (character < 0x20U ? 6U : 1U);
    if (result > std::numeric_limits<std::size_t>::max() - additional) {
      return std::numeric_limits<std::size_t>::max();
    }
    result += additional;
  }
  return result;
}

BoundedPageBudget::BoundedPageBudget(std::size_t initial_bytes,
                                     std::size_t maximum_bytes) noexcept
    : used_bytes_(initial_bytes), maximum_bytes_(maximum_bytes) {}

bool BoundedPageBudget::try_reserve(std::size_t bytes) noexcept {
  if (used_bytes_ > maximum_bytes_ || bytes > maximum_bytes_ - used_bytes_) {
    return false;
  }
  used_bytes_ += bytes;
  return true;
}

HostProjectItemsResult HostProjectItemsResult::success(ProjectItemsPage value) {
  HostProjectItemsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectItemsResult HostProjectItemsResult::failure(std::string code,
                                                       std::string detail,
                                                       std::string field) {
  HostProjectItemsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionSettingsResult
HostCompositionSettingsResult::success(CompositionSettings value) {
  HostCompositionSettingsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionSettingsResult
HostCompositionSettingsResult::failure(std::string code, std::string detail,
                                       std::string field) {
  HostCompositionSettingsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionSettingsWriteResult
HostCompositionSettingsWriteResult::success(CompositionSettingsChanged value) {
  HostCompositionSettingsWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionSettingsWriteResult HostCompositionSettingsWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionSettingsWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionLayersResult
HostCompositionLayersResult::success(CompositionLayersPage value) {
  HostCompositionLayersResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionLayersResult
HostCompositionLayersResult::failure(std::string code, std::string detail,
                                     std::string field) {
  HostCompositionLayersResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionTimeResult
HostCompositionTimeResult::success(CompositionTimeRead value) {
  HostCompositionTimeResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionTimeResult
HostCompositionTimeResult::failure(std::string code, std::string detail,
                                   std::string field) {
  HostCompositionTimeResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionTimeWriteResult
HostCompositionTimeWriteResult::success(CompositionTimeChanged value) {
  HostCompositionTimeWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionTimeWriteResult
HostCompositionTimeWriteResult::failure(std::string code, std::string detail,
                                        std::string field) {
  HostCompositionTimeWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertiesResult
HostLayerPropertiesResult::success(LayerPropertiesPage value) {
  HostLayerPropertiesResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertiesResult
HostLayerPropertiesResult::failure(std::string code, std::string detail,
                                   std::string field) {
  HostLayerPropertiesResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyKeyframesResult
HostLayerPropertyKeyframesResult::success(LayerPropertyKeyframesPage value) {
  HostLayerPropertyKeyframesResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyKeyframesResult
HostLayerPropertyKeyframesResult::failure(std::string code, std::string detail,
                                          std::string field) {
  HostLayerPropertyKeyframesResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyWriteResult
HostLayerPropertyWriteResult::success(LayerPropertyChanged value) {
  HostLayerPropertyWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyWriteResult
HostLayerPropertyWriteResult::failure(std::string code, std::string detail,
                                      std::string field) {
  HostLayerPropertyWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyKeyframeDetailsResult
HostLayerPropertyKeyframeDetailsResult::success(
    LayerPropertyKeyframeDetails value) {
  HostLayerPropertyKeyframeDetailsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyKeyframeDetailsResult
HostLayerPropertyKeyframeDetailsResult::failure(std::string code,
                                                std::string detail,
                                                std::string field) {
  HostLayerPropertyKeyframeDetailsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyKeyframeWriteResult
HostLayerPropertyKeyframeWriteResult::success(
    LayerPropertyKeyframeChanged value) {
  HostLayerPropertyKeyframeWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyKeyframeWriteResult
HostLayerPropertyKeyframeWriteResult::failure(std::string code,
                                              std::string detail,
                                              std::string field) {
  HostLayerPropertyKeyframeWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostActionResult HostActionResult::success() {
  HostActionResult result;
  result.ok = true;
  return result;
}

HostActionResult HostActionResult::failure(std::string code, std::string detail,
                                           std::string field) {
  HostActionResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectGraphInvalidationResult
HostProjectGraphInvalidationResult::success(ProjectGraphInvalidation value) {
  HostProjectGraphInvalidationResult result;
  result.ok = true;
  result.value = value;
  return result;
}

HostProjectGraphInvalidationResult
HostProjectGraphInvalidationResult::failure(std::string code,
                                            std::string detail) {
  HostProjectGraphInvalidationResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostProjectItemsResult HostApi::list_project_items(const ProjectItemsQuery &,
                                                   TimePoint) {
  return HostProjectItemsResult::failure("NATIVE_UNSUPPORTED",
                                         "project item reads are unavailable");
}

HostCompositionSettingsResult
HostApi::read_composition_settings(const CompositionSettingsQuery &,
                                   TimePoint) {
  return HostCompositionSettingsResult::failure(
      "NATIVE_UNSUPPORTED", "composition settings reads are unavailable");
}

HostCompositionSettingsWriteResult
HostApi::set_composition_setting(const CompositionSettingsSetCommand &,
                                 TimePoint) {
  return HostCompositionSettingsWriteResult::failure(
      "NATIVE_UNSUPPORTED",
      "composition settings writes are not implemented by this host");
}

HostCompositionLayersResult
HostApi::list_composition_layers(const CompositionLayersQuery &, TimePoint) {
  return HostCompositionLayersResult::failure(
      "NATIVE_UNSUPPORTED", "composition layer reads are unavailable");
}

HostCompositionLayersResult
HostApi::list_selected_composition_layers(const CompositionLayersQuery &,
                                          TimePoint) {
  return HostCompositionLayersResult::failure(
      "NATIVE_UNSUPPORTED", "composition selected-layer reads are unavailable");
}

HostCompositionTimeResult
HostApi::read_composition_time(const CompositionTimeQuery &, TimePoint) {
  return HostCompositionTimeResult::failure(
      "NATIVE_UNSUPPORTED", "composition time reads are unavailable");
}

HostCompositionTimeWriteResult
HostApi::set_composition_time(const CompositionTimeSetCommand &, TimePoint) {
  return HostCompositionTimeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "composition time writes are unavailable");
}

HostLayerPropertiesResult
HostApi::list_layer_properties(const LayerPropertiesQuery &, TimePoint) {
  return HostLayerPropertiesResult::failure(
      "NATIVE_UNSUPPORTED", "layer property reads are unavailable");
}

HostLayerPropertyKeyframesResult
HostApi::list_layer_property_keyframes(const LayerPropertyKeyframesQuery &,
                                       TimePoint) {
  return HostLayerPropertyKeyframesResult::failure(
      "NATIVE_UNSUPPORTED", "layer property keyframe reads are unavailable");
}

HostLayerPropertyWriteResult
HostApi::set_layer_property(const LayerPropertySetCommand &, TimePoint) {
  return HostLayerPropertyWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer property writes are unavailable");
}

HostLayerPropertyKeyframeDetailsResult
HostApi::read_layer_property_keyframe_details(
    const LayerPropertyKeyframeDetailsQuery &, TimePoint) {
  return HostLayerPropertyKeyframeDetailsResult::failure(
      "NATIVE_UNSUPPORTED",
      "layer property keyframe detail reads are unavailable");
}

HostLayerPropertyKeyframeWriteResult HostApi::mutate_layer_property_keyframe(
    const LayerPropertyKeyframeMutationCommand &, TimePoint) {
  return HostLayerPropertyKeyframeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer property keyframe writes are unavailable");
}

NativeProgramHostResult NativeProgramHostResult::success(
    std::vector<NativeProgramOperationOutcome> operation_results,
    JsonObject named_outputs) {
  NativeProgramHostResult result;
  result.ok = true;
  result.operations = std::move(operation_results);
  result.outputs = std::move(named_outputs);
  result.completed_operation_indices.reserve(result.operations.size());
  for (const NativeProgramOperationOutcome &operation : result.operations) {
    result.completed_operation_indices.push_back(operation.index);
  }
  result.disposition = NativeProgramDisposition::kCompleted;
  return result;
}

NativeProgramHostResult NativeProgramHostResult::failure(
    std::string code, std::string detail, std::string field,
    std::vector<std::size_t> completed_indices,
    std::optional<std::size_t> failed_index, bool began_write,
    NativeProgramDisposition failure_disposition,
    std::vector<NativeProgramOperationOutcome> operation_results,
    JsonObject named_outputs) {
  NativeProgramHostResult result;
  result.operations = std::move(operation_results);
  result.outputs = std::move(named_outputs);
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  result.completed_operation_indices = std::move(completed_indices);
  result.failed_operation_index = failed_index;
  result.write_started = began_write;
  result.disposition = failure_disposition;
  return result;
}

NativeProgramHostResult HostApi::execute_native_program(const NativeProgram &,
                                                        std::string_view,
                                                        std::string_view,
                                                        TimePoint) {
  return NativeProgramHostResult::failure(
      "NATIVE_UNSUPPORTED", "native program execution is unavailable", {}, {},
      std::nullopt, false, NativeProgramDisposition::kNotStarted);
}

HostActionResult HostApi::begin_undo_group(std::string_view, TimePoint) {
  return HostActionResult::failure("NATIVE_UNSUPPORTED",
                                   "Undo groups are unavailable");
}

HostActionResult HostApi::end_undo_group(TimePoint) {
  return HostActionResult::failure("NATIVE_UNSUPPORTED",
                                   "Undo groups are unavailable");
}

HostProjectGraphInvalidationResult
HostApi::invalidate_project_graph(TimePoint) {
  return HostProjectGraphInvalidationResult::failure(
      "NATIVE_UNSUPPORTED", "project graph invalidation is unavailable");
}

std::size_t HostDispatcher::RequestKeyHash::operator()(
    const RequestKey &key) const noexcept {
  std::size_t value = std::hash<std::string>{}(key.route_id);
  hash_combine(value, std::hash<std::uint64_t>{}(key.session_generation));
  hash_combine(value, std::hash<std::string>{}(key.request_id));
  return value;
}

HostDispatcher::HostDispatcher(std::thread::id owner_thread, Clock &clock,
                               DispatcherConfig config)
    : owner_thread_(owner_thread), clock_(clock), config_(config) {
  if (owner_thread_ == std::thread::id{} || config_.max_queue_depth == 0 ||
      config_.max_queue_depth > 256 || config_.max_tasks_per_idle == 0 ||
      config_.max_tasks_per_idle > 64 || config_.idle_budget.count() <= 0 ||
      config_.idle_budget > std::chrono::milliseconds(16) ||
      config_.max_outbound_depth == 0 || config_.max_outbound_depth > 512 ||
      config_.max_terminal_tombstones == 0 ||
      config_.max_terminal_tombstones > 4096 ||
      config_.terminal_ttl.count() <= 0 ||
      config_.terminal_ttl > std::chrono::milliseconds(300000) ||
      config_.max_route_fences == 0 || config_.max_route_fences > 4096 ||
      config_.max_idempotency_entries == 0 ||
      config_.max_idempotency_entries > 4096) {
    throw std::invalid_argument("invalid native host dispatcher configuration");
  }
}

EnqueueResult HostDispatcher::enqueue(Request request) {
  if (!valid_request_id(request.request_id) ||
      !valid_route(request.route_id, request.session_generation)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_REQUEST"};
  }
  const bool native_program = request.capability_id == kNativeProgramCapability;
  const bool graph_invalidation =
      request.capability_id == kProjectGraphInvalidateControl;
  if (!native_program && !graph_invalidation) {
    return {EnqueueCode::kUnsupportedCapability, "NATIVE_UNSUPPORTED"};
  }

  std::optional<ProgramAdmission> admission;
  if (native_program) {
    if (!request.native_program.has_value()) {
      return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
              "native program request is missing its admitted program",
              "params.arguments"};
    }
    try {
      admission = validate_native_program(*request.native_program,
                                          native_primitive_registry());
    } catch (const std::runtime_error &error) {
      return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT", error.what(),
              "params.arguments"};
    }
    request.idempotency_key = request.native_program->operation_key;
    request.arguments_fingerprint_sha256 = admission->program_digest;
    if (!valid_sha256(request.arguments_fingerprint_sha256) ||
        (admission->contains_write
             ? !valid_idempotency_key(request.idempotency_key)
             : !request.idempotency_key.empty())) {
      return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
              "native program write envelope is inconsistent",
              "params.arguments.operationKey"};
    }
  } else if (request.native_program.has_value() ||
             !request.idempotency_key.empty() ||
             !request.arguments_fingerprint_sha256.empty()) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT"};
  }

  const TimePoint now = clock_.now();
  if (request.deadline <= now) {
    return {EnqueueCode::kDeadlineExceeded, "DEADLINE_EXCEEDED"};
  }

  const RequestKey key = key_for(request);
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  if (state_ != State::kRunning) {
    return {EnqueueCode::kShuttingDown, "AE_SHUTTING_DOWN"};
  }
  if (route_stale_locked(request.route_id, request.session_generation)) {
    return {EnqueueCode::kStaleRoute, "SESSION_STALE"};
  }
  if (active_requests_.contains(key) || pending_outbound_locked(key) ||
      terminal_locked(key)) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }

  if (native_program && admission->contains_write) {
    const auto existing = idempotency_ledger_.find(request.idempotency_key);
    if (existing != idempotency_ledger_.end()) {
      if (existing->second.arguments_fingerprint_sha256 !=
          request.arguments_fingerprint_sha256) {
        return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST",
                "operation key was already used with different arguments"};
      }
      if (existing->second.replay_completion.has_value()) {
        Completion replay = *existing->second.replay_completion;
        replay.request_id = request.request_id;
        replay.route_id = request.route_id;
        replay.session_generation = request.session_generation;
        replay.replayed = true;
        replay.native_program_result.undo_available = false;
        outbound_.push_back(replay);
        remember_terminal_locked(key, now);
        return {EnqueueCode::kAccepted};
      }
      return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
    }
    if (idempotency_ledger_.size() >= config_.max_idempotency_entries) {
      return {EnqueueCode::kQueueFull, "QUEUE_FULL",
              "native operation ledger is full"};
    }
    idempotency_ledger_.emplace(
        request.idempotency_key,
        IdempotencyEntry{request.arguments_fingerprint_sha256,
                         IdempotencyState::kReserved, std::nullopt});
  }

  if (queue_.size() >= config_.max_queue_depth) {
    if (native_program && admission->contains_write) {
      idempotency_ledger_.erase(request.idempotency_key);
    }
    return {EnqueueCode::kQueueFull, "QUEUE_FULL"};
  }
  active_requests_.insert(key);
  queue_.push_back(std::move(request));
  return {EnqueueCode::kAccepted};
}

CancelResult HostDispatcher::cancel(std::string_view route_id,
                                    std::uint64_t session_generation,
                                    std::string_view target_request_id) {
  if (!valid_route(route_id, session_generation) ||
      !valid_request_id(target_request_id)) {
    return {CancelCode::kInvalidRequest, false};
  }

  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  RequestKey key{std::string(route_id), session_generation,
                 std::string(target_request_id)};
  if (terminal_locked(key) || pending_outbound_locked(key)) {
    return {CancelCode::kAlreadyTerminal, false};
  }
  if (route_revoked_locked(route_id, session_generation)) {
    return {CancelCode::kStaleRoute, false};
  }

  const auto queued =
      std::find_if(queue_.begin(), queue_.end(), [&](const Request &request) {
        return request.route_id == route_id &&
               request.session_generation == session_generation &&
               request.request_id == target_request_id;
      });
  if (queued != queue_.end()) {
    Completion completion =
        failure_for(*queued, "CANCELLED",
                    "native request was cancelled before host dispatch");
    finish_idempotency_locked(*queued, completion);
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

RouteRevocationResult
HostDispatcher::revoke_route(std::string_view route_id,
                             std::uint64_t session_generation) {
  RouteRevocationResult result;
  if (!valid_route(route_id, session_generation))
    return result;

  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  result.fence_recorded =
      fence_route_locked(std::string(route_id), session_generation);
  result.fence_saturated = route_fences_saturated_;

  for (Completion &completion : outbound_) {
    if (completion.route_id == route_id &&
        completion.session_generation <= session_generation &&
        !completion.route_revoked) {
      completion.route_revoked = true;
      ++result.pending_outbound_marked;
    }
  }

  auto queued = queue_.begin();
  while (queued != queue_.end()) {
    if (queued->route_id != route_id ||
        queued->session_generation > session_generation) {
      ++queued;
      continue;
    }
    const RequestKey key = key_for(*queued);
    Completion completion =
        failure_for(*queued, "CANCELLED",
                    "native request route was revoked before host dispatch");
    completion.route_revoked = true;
    finish_idempotency_locked(*queued, completion);
    queued = queue_.erase(queued);
    finish_request_locked(key, completion, now);
    ++result.queued_cancelled;
  }

  for (const RequestKey &key : active_requests_) {
    if (key.route_id == route_id &&
        key.session_generation <= session_generation) {
      if (detached_requests_.insert(key).second)
        ++result.running_detached;
    }
  }
  return result;
}

DrainBatch HostDispatcher::drain(HostApi &host) {
  DrainBatch batch;
  if (std::this_thread::get_id() != owner_thread_) {
    batch.wrong_thread = true;
    batch.remaining = queued();
    return batch;
  }

  const TimePoint started = clock_.now();
  const TimePoint idle_deadline = started + config_.idle_budget;
  while (batch.completions.size() < config_.max_tasks_per_idle) {
    if (!batch.completions.empty() &&
        clock_.now() - started >= config_.idle_budget) {
      batch.budget_exhausted = true;
      break;
    }

    Request request;
    {
      std::lock_guard lock(mutex_);
      if (state_ != State::kRunning || queue_.empty())
        break;
      request = std::move(queue_.front());
      queue_.pop_front();
    }

    Completion completion;
    if (request.deadline <= clock_.now()) {
      completion = expired(request, false);
    } else {
      try {
        if (request.capability_id == kProjectGraphInvalidateControl) {
          HostProjectGraphInvalidationResult result =
              host.invalidate_project_graph(
                  std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!result.ok) {
            completion = failure_for(
                request,
                result.error_code.empty() ? "CAPABILITY_FAILED"
                                          : result.error_code,
                result.message.empty() ? "native graph invalidation failed"
                                       : result.message);
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.project_graph_invalidation_result = result.value;
          }
        } else {
          const ProgramAdmission admission = validate_native_program(
              *request.native_program, native_primitive_registry());
          NativeProgramHostResult result;
          HostActionResult undo_begin = HostActionResult::success();
          HostActionResult undo_end = HostActionResult::success();
          if (admission.contains_write) {
            undo_begin = host.begin_undo_group(
                request.native_program->undo_group, request.deadline);
          }
          if (!undo_begin.ok) {
            result = NativeProgramHostResult::failure(
                undo_begin.error_code.empty() ? "CAPABILITY_FAILED"
                                              : undo_begin.error_code,
                undo_begin.message.empty()
                    ? "native program Undo group could not be opened"
                    : undo_begin.message,
                undo_begin.error_field, {}, std::nullopt, false,
                NativeProgramDisposition::kNotStarted);
          } else {
            try {
              result = host.execute_native_program(
                  *request.native_program, request.host_instance_id,
                  request.session_id, request.deadline);
            } catch (...) {
              result = NativeProgramHostResult::failure(
                  admission.contains_write ? "POSSIBLY_SIDE_EFFECTING_FAILURE"
                                           : "CAPABILITY_FAILED",
                  "native program host adapter raised an exception", {}, {},
                  std::nullopt, admission.contains_write,
                  admission.contains_write
                      ? NativeProgramDisposition::kPossiblySideEffecting
                      : NativeProgramDisposition::kCompleted);
            }
            if (admission.contains_write) {
              try {
                undo_end = host.end_undo_group(request.deadline);
              } catch (...) {
                undo_end = HostActionResult::failure(
                    "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "native program Undo close raised an exception");
              }
            }
          }
          if (!undo_end.ok) {
            result.ok = false;
            result.undo_available = false;
            result.write_started = true;
            result.disposition =
                NativeProgramDisposition::kPossiblySideEffecting;
            result.error_code = "POSSIBLY_SIDE_EFFECTING_FAILURE";
            result.message =
                undo_end.message.empty()
                    ? "native program Undo group could not be closed"
                    : undo_end.message;
            result.error_field = undo_end.error_field;
          } else {
            result.undo_available = admission.contains_write && undo_begin.ok;
          }
          if (undo_end.ok && clock_.now() > request.deadline) {
            result.ok = false;
            if (admission.contains_write) {
              result.write_started = true;
              result.disposition =
                  NativeProgramDisposition::kPossiblySideEffecting;
              result.error_code = "POSSIBLY_SIDE_EFFECTING_FAILURE";
              result.message =
                  "native program completed after its dispatcher deadline";
            } else {
              result.error_code = "DEADLINE_EXCEEDED";
              result.message =
                  "native read program completed after its dispatcher deadline";
            }
          } else if (!result.ok && result.write_started) {
            result.disposition =
                NativeProgramDisposition::kPossiblySideEffecting;
            result.error_code = "POSSIBLY_SIDE_EFFECTING_FAILURE";
          }
          completion.request_id = request.request_id;
          completion.capability_id = request.capability_id;
          completion.route_id = request.route_id;
          completion.session_generation = request.session_generation;
          completion.idempotency_key = request.idempotency_key;
          completion.ok = result.ok;
          completion.error_code = result.error_code;
          completion.message = result.message;
          completion.error_field = result.error_field;
          completion.native_program_result = std::move(result);
        }
      } catch (...) {
        bool write = false;
        if (request.native_program.has_value()) {
          try {
            write = validate_native_program(*request.native_program,
                                            native_primitive_registry())
                        .contains_write;
          } catch (...) {
          }
        }
        completion = failure_for(request,
                                 write ? "POSSIBLY_SIDE_EFFECTING_FAILURE"
                                       : "CAPABILITY_FAILED",
                                 "native host adapter raised an exception");
      }
    }
    {
      std::lock_guard lock(mutex_);
      if (request.capability_id == kProjectGraphInvalidateControl &&
          completion.ok) {
        invalidate_composition_creation_replays_locked();
      }
      finish_idempotency_locked(request, completion);
      finish_request_locked(key_for(request), completion, clock_.now());
    }
    batch.completions.push_back(std::move(completion));
  }

  batch.remaining = queued();
  if (batch.remaining > 0 &&
      batch.completions.size() >= config_.max_tasks_per_idle) {
    batch.budget_exhausted = true;
  }
  return batch;
}

std::vector<Completion> HostDispatcher::take_outbound(std::size_t max_items) {
  std::vector<Completion> completions;
  if (max_items == 0)
    return completions;
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
    throw std::logic_error(
        "native host dispatcher shutdown must run on its owner thread");
  }
  std::vector<Completion> completions;
  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  if (state_ == State::kStopped)
    return completions;
  state_ = State::kStopping;
  completions.reserve(queue_.size());
  while (!queue_.empty()) {
    Request request = std::move(queue_.front());
    queue_.pop_front();
    Completion completion = failure_for(request, "AE_SHUTTING_DOWN",
                                        "After Effects is shutting down");
    finish_idempotency_locked(request, completion);
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

bool HostDispatcher::has_terminal(std::string_view route_id,
                                  std::uint64_t session_generation,
                                  std::string_view request_id) {
  if (!valid_route(route_id, session_generation) ||
      !valid_request_id(request_id))
    return false;
  std::lock_guard lock(mutex_);
  purge_terminal_locked(clock_.now());
  return terminal_locked(
      {std::string(route_id), session_generation, std::string(request_id)});
}

void HostDispatcher::mark_idempotency_ambiguous(
    std::string_view idempotency_key) {
  if (!valid_idempotency_key(idempotency_key))
    return;
  std::lock_guard lock(mutex_);
  const auto entry = idempotency_ledger_.find(std::string(idempotency_key));
  if (entry != idempotency_ledger_.end()) {
    entry->second.state = IdempotencyState::kAmbiguous;
  }
}

void HostDispatcher::invalidate_composition_creation_replays() {
  std::lock_guard lock(mutex_);
  invalidate_composition_creation_replays_locked();
}

bool HostDispatcher::running() const {
  std::lock_guard lock(mutex_);
  return state_ == State::kRunning;
}

Completion HostDispatcher::expired(const Request &request, bool late) const {
  Completion completion = failure_for(request, "DEADLINE_EXCEEDED",
                                      "native request deadline elapsed");
  completion.late_result_discarded = late;
  return completion;
}

HostDispatcher::RequestKey HostDispatcher::key_for(const Request &request) {
  return {request.route_id, request.session_generation, request.request_id};
}

bool HostDispatcher::route_revoked_locked(
    std::string_view route_id, std::uint64_t session_generation) const {
  const auto fence = route_fences_.find(std::string(route_id));
  return fence != route_fences_.end() && session_generation <= fence->second;
}

bool HostDispatcher::route_stale_locked(
    std::string_view route_id, std::uint64_t session_generation) const {
  if (route_revoked_locked(route_id, session_generation))
    return true;
  // Fences are never evicted. Once their bounded registry is exhausted, an
  // unseen authenticated route fails closed until the AE plug-in restarts.
  return !route_id.empty() && route_fences_saturated_ &&
         route_fences_.find(std::string(route_id)) == route_fences_.end();
}

bool HostDispatcher::pending_outbound_locked(const RequestKey &key) const {
  return std::any_of(
      outbound_.begin(), outbound_.end(), [&](const Completion &completion) {
        return completion.route_id == key.route_id &&
               completion.session_generation == key.session_generation &&
               completion.request_id == key.request_id;
      });
}

bool HostDispatcher::terminal_locked(const RequestKey &key) const {
  return std::any_of(
      terminal_tombstones_.begin(), terminal_tombstones_.end(),
      [&](const TerminalTombstone &tombstone) { return tombstone.key == key; });
}

void HostDispatcher::purge_terminal_locked(TimePoint now) {
  std::erase_if(terminal_tombstones_, [&](const TerminalTombstone &tombstone) {
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

void HostDispatcher::invalidate_composition_creation_replays_locked() {
  for (auto &[idempotency_key, entry] : idempotency_ledger_) {
    (void)idempotency_key;
    if (entry.replay_completion.has_value()) {
      entry.state = IdempotencyState::kAmbiguous;
      entry.replay_completion.reset();
    }
  }
}

bool HostDispatcher::fence_route_locked(std::string route_id,
                                        std::uint64_t session_generation) {
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

void HostDispatcher::finish_request_locked(const RequestKey &key,
                                           Completion &completion,
                                           TimePoint now) {
  if (route_revoked_locked(key.route_id, key.session_generation) ||
      detached_requests_.contains(key)) {
    completion.route_revoked = true;
  }
  outbound_.push_back(completion);
  remember_terminal_locked(key, now);
  active_requests_.erase(key);
  detached_requests_.erase(key);
}

void HostDispatcher::finish_idempotency_locked(const Request &request,
                                               const Completion &completion) {
  if (request.capability_id != kNativeProgramCapability ||
      request.idempotency_key.empty()) {
    return;
  }
  const auto entry = idempotency_ledger_.find(request.idempotency_key);
  if (entry == idempotency_ledger_.end())
    return;
  if (completion.ok) {
    entry->second.state = IdempotencyState::kSucceeded;
    entry->second.replay_completion = completion;
    return;
  }
  if (completion.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE") {
    entry->second.state = IdempotencyState::kAmbiguous;
    entry->second.replay_completion = completion;
    return;
  }
  entry->second.state = IdempotencyState::kSucceeded;
  entry->second.replay_completion = completion;
}

} // namespace aemcp::native
