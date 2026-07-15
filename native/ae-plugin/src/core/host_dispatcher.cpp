#include "aemcp_native/host_dispatcher.hpp"

#include <algorithm>
#include <functional>
#include <limits>
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

bool valid_idempotency_key(std::string_view value) {
  if (value.size() < 16 || value.size() > 64) return false;
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

bool valid_bit_depth(std::int32_t value) {
  return value == 8 || value == 16 || value == 32;
}

bool valid_sha256(std::string_view value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char character) {
    return (character >= '0' && character <= '9')
        || (character >= 'a' && character <= 'f');
  });
}

bool valid_uuid(std::string_view value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-'
      || value[18] != '-' || value[23] != '-') {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    const char character = value[index];
    if (!((character >= '0' && character <= '9')
          || (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return value[14] >= '1' && value[14] <= '5'
      && (value[19] == '8' || value[19] == '9'
          || value[19] == 'a' || value[19] == 'b');
}

bool valid_locator(const ObjectLocator& locator) {
  return (locator.kind == "project" || locator.kind == "item"
          || locator.kind == "composition" || locator.kind == "layer"
          || locator.kind == "stream")
      && valid_uuid(locator.host_instance_id) && valid_uuid(locator.session_id)
      && valid_uuid(locator.project_id) && locator.generation > 0
      && valid_uuid(locator.object_id);
}

bool valid_route(std::string_view route_id, std::uint64_t session_generation) {
  // Empty/zero is the one legacy in-process route. The authenticated transport
  // supplies an opaque, bounded route; its syntax is deliberately not parsed.
  if (route_id.empty()) return session_generation == 0;
  return session_generation > 0 && route_id.size() <= 128
      && route_id.find('\0') == std::string_view::npos;
}

Completion failure_for(
    const Request& request,
    std::string code,
    std::string message,
    std::string field = {}) {
  Completion completion;
  completion.request_id = request.request_id;
  completion.capability_id = request.capability_id;
  completion.route_id = request.route_id;
  completion.session_generation = request.session_generation;
  completion.idempotency_key = request.idempotency_key;
  completion.error_code = std::move(code);
  completion.message = std::move(message);
  completion.error_field = std::move(field);
  return completion;
}

void hash_combine(std::size_t& seed, std::size_t value) noexcept {
  seed ^= value + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
}

}  // namespace

TimePoint SystemClock::now() const noexcept {
  return std::chrono::steady_clock::now();
}

std::size_t json_encoded_string_size(std::string_view value) noexcept {
  std::size_t result = 2;
  for (const unsigned char character : value) {
    const std::size_t additional = character == '"' || character == '\\'
            || character == '\b' || character == '\f' || character == '\n'
            || character == '\r' || character == '\t'
        ? 2U
        : (character < 0x20U ? 6U : 1U);
    if (result > std::numeric_limits<std::size_t>::max() - additional) {
      return std::numeric_limits<std::size_t>::max();
    }
    result += additional;
  }
  return result;
}

BoundedPageBudget::BoundedPageBudget(
    std::size_t initial_bytes, std::size_t maximum_bytes) noexcept
    : used_bytes_(initial_bytes), maximum_bytes_(maximum_bytes) {}

bool BoundedPageBudget::try_reserve(std::size_t bytes) noexcept {
  if (used_bytes_ > maximum_bytes_ || bytes > maximum_bytes_ - used_bytes_) {
    return false;
  }
  used_bytes_ += bytes;
  return true;
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

HostBitDepthReadResult HostBitDepthReadResult::success(ProjectBitDepth value) {
  HostBitDepthReadResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostBitDepthReadResult HostBitDepthReadResult::failure(
    std::string code, std::string detail) {
  HostBitDepthReadResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostBitDepthWriteResult HostBitDepthWriteResult::success(ProjectBitDepthChanged value) {
  HostBitDepthWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostBitDepthWriteResult HostBitDepthWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostBitDepthWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectItemsResult HostProjectItemsResult::success(ProjectItemsPage value) {
  HostProjectItemsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectItemsResult HostProjectItemsResult::failure(
    std::string code, std::string detail, std::string field) {
  HostProjectItemsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionLayersResult HostCompositionLayersResult::success(
    CompositionLayersPage value) {
  HostCompositionLayersResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionLayersResult HostCompositionLayersResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionLayersResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionTimeResult HostCompositionTimeResult::success(
    CompositionTimeRead value) {
  HostCompositionTimeResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionTimeResult HostCompositionTimeResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionTimeResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertiesResult HostLayerPropertiesResult::success(
    LayerPropertiesPage value) {
  HostLayerPropertiesResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertiesResult HostLayerPropertiesResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerPropertiesResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectGraphInvalidationResult HostProjectGraphInvalidationResult::success(
    ProjectGraphInvalidation value) {
  HostProjectGraphInvalidationResult result;
  result.ok = true;
  result.value = value;
  return result;
}

HostProjectGraphInvalidationResult HostProjectGraphInvalidationResult::failure(
    std::string code, std::string detail) {
  HostProjectGraphInvalidationResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostBitDepthReadResult HostApi::read_project_bit_depth(TimePoint) {
  return HostBitDepthReadResult::failure(
      "NATIVE_UNSUPPORTED", "project bit-depth reads are unavailable");
}

HostBitDepthWriteResult HostApi::set_project_bit_depth(std::int32_t, TimePoint) {
  return HostBitDepthWriteResult::failure(
      "NATIVE_UNSUPPORTED", "project bit-depth writes are unavailable");
}

HostProjectItemsResult HostApi::list_project_items(
    const ProjectItemsQuery&, TimePoint) {
  return HostProjectItemsResult::failure(
      "NATIVE_UNSUPPORTED", "project item reads are unavailable");
}

HostCompositionLayersResult HostApi::list_composition_layers(
    const CompositionLayersQuery&, TimePoint) {
  return HostCompositionLayersResult::failure(
      "NATIVE_UNSUPPORTED", "composition layer reads are unavailable");
}

HostCompositionLayersResult HostApi::list_selected_composition_layers(
    const CompositionLayersQuery&, TimePoint) {
  return HostCompositionLayersResult::failure(
      "NATIVE_UNSUPPORTED", "composition selected-layer reads are unavailable");
}

HostCompositionTimeResult HostApi::read_composition_time(
    const CompositionTimeQuery&, TimePoint) {
  return HostCompositionTimeResult::failure(
      "NATIVE_UNSUPPORTED", "composition time reads are unavailable");
}

HostLayerPropertiesResult HostApi::list_layer_properties(
    const LayerPropertiesQuery&, TimePoint) {
  return HostLayerPropertiesResult::failure(
      "NATIVE_UNSUPPORTED", "layer property reads are unavailable");
}

HostProjectGraphInvalidationResult HostApi::invalidate_project_graph(TimePoint) {
  return HostProjectGraphInvalidationResult::failure(
      "NATIVE_UNSUPPORTED", "project graph invalidation is unavailable");
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
      || config_.max_route_fences == 0 || config_.max_route_fences > 4096
      || config_.max_idempotency_entries == 0
      || config_.max_idempotency_entries > 4096) {
    throw std::invalid_argument("invalid native host dispatcher configuration");
  }
}

EnqueueResult HostDispatcher::enqueue(Request request) {
  if (!valid_request_id(request.request_id) || request.capability_id.empty()
      || !valid_route(request.route_id, request.session_generation)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_REQUEST"};
  }
  const bool project_summary = request.capability_id == kProjectSummaryCapability;
  const bool project_bit_depth_read =
      request.capability_id == kProjectBitDepthReadCapability;
  const bool project_bit_depth_set =
      request.capability_id == kProjectBitDepthSetCapability;
  const bool project_items_list = request.capability_id == kProjectItemsListCapability;
  const bool composition_layers_list =
      request.capability_id == kCompositionLayersListCapability;
  const bool composition_selected_layers_list =
      request.capability_id == kCompositionSelectedLayersListCapability;
  const bool composition_time_read =
      request.capability_id == kCompositionTimeReadCapability;
  const bool layer_properties_list =
      request.capability_id == kLayerPropertiesListCapability;
  const bool project_graph_invalidate =
      request.capability_id == kProjectGraphInvalidateControl;
  if (!project_summary && !project_bit_depth_read && !project_bit_depth_set
      && !project_items_list && !composition_layers_list
      && !composition_selected_layers_list && !composition_time_read
      && !layer_properties_list && !project_graph_invalidate) {
    return {EnqueueCode::kUnsupportedCapability, "NATIVE_UNSUPPORTED"};
  }
  if (project_graph_invalidate
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !request.host_instance_id.empty() || !request.session_id.empty()
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.layer_locator.has_value()
          || request.parent_property_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "project graph invalidation parameters are not closed",
        "params"};
  }
  if ((project_summary || project_bit_depth_read)
      && (request.target_depth != 0 || !request.idempotency_key.empty()
        || !request.arguments_fingerprint_sha256.empty())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native capability arguments failed closed validation",
        "params.arguments"};
  }
  if (project_bit_depth_set && !valid_bit_depth(request.target_depth)) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "targetDepth must be one of 8, 16, or 32",
        "params.arguments.targetDepth"};
  }
  if (project_bit_depth_set
      && (!valid_idempotency_key(request.idempotency_key)
        || !valid_sha256(request.arguments_fingerprint_sha256))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native capability arguments failed closed validation",
        "params.arguments"};
  }
  if ((project_items_list || composition_layers_list
          || composition_selected_layers_list || layer_properties_list)
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.limit < 1
          || request.limit > (layer_properties_list ? 25 : 50))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native project graph arguments failed closed validation",
        "params.arguments"};
  }
  if (composition_time_read
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value() || request.layer_locator.has_value()
          || request.parent_property_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native composition time arguments failed closed validation",
        "params.arguments"};
  }
  if (project_items_list
      && ((request.offset > 0 && !request.project_locator.has_value())
          || request.composition_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "projectLocator must be supplied for non-zero offsets",
        "params.arguments.projectLocator"};
  }
  if (project_items_list && request.project_locator.has_value()) {
    const ObjectLocator& locator = *request.project_locator;
    if (!valid_locator(locator) || locator.kind != "project") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "projectLocator must be a closed project locator",
          "params.arguments.projectLocator"};
    }
    if (locator.host_instance_id != request.host_instance_id
        || locator.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "projectLocator belongs to another host or native session",
          "params.arguments.projectLocator"};
    }
  }
  if ((composition_layers_list || composition_selected_layers_list
          || composition_time_read)
      && (request.project_locator.has_value() || !request.composition_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "compositionLocator is required for composition reads",
        "params.arguments.compositionLocator"};
  }
  if (composition_layers_list || composition_selected_layers_list
      || composition_time_read) {
    const ObjectLocator& locator = *request.composition_locator;
    if (!valid_locator(locator) || locator.kind != "composition") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "compositionLocator must be a closed composition locator",
          "params.arguments.compositionLocator"};
    }
    if (locator.host_instance_id != request.host_instance_id
        || locator.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "compositionLocator belongs to another host or native session",
          "params.arguments.compositionLocator"};
    }
  }
  if (layer_properties_list
      && (request.project_locator.has_value()
          || request.composition_locator.has_value()
          || !request.layer_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layerLocator is required for layer property reads",
        "params.arguments.layerLocator"};
  }
  if (layer_properties_list) {
    const ObjectLocator& layer = *request.layer_locator;
    if (!valid_locator(layer) || layer.kind != "layer") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "layerLocator must be a closed layer locator",
          "params.arguments.layerLocator"};
    }
    if (layer.host_instance_id != request.host_instance_id
        || layer.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "layerLocator belongs to another host or native session",
          "params.arguments.layerLocator"};
    }
    if (request.parent_property_locator.has_value()) {
      const ObjectLocator& parent = *request.parent_property_locator;
      if (!valid_locator(parent) || parent.kind != "stream") {
        return {
            EnqueueCode::kInvalidRequest,
            "INVALID_ARGUMENT",
            "parentPropertyLocator must be a closed stream locator",
            "params.arguments.parentPropertyLocator"};
      }
      if (parent.host_instance_id != request.host_instance_id
          || parent.session_id != request.session_id
          || parent.project_id != layer.project_id
          || parent.generation != layer.generation) {
        return {
            EnqueueCode::kInvalidRequest,
            "STALE_LOCATOR",
            "parentPropertyLocator belongs to another layer session",
            "params.arguments.parentPropertyLocator"};
      }
    }
  } else if (request.layer_locator.has_value()
      || request.parent_property_locator.has_value()) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layer property locators are not accepted by this capability",
        "params.arguments"};
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
  if (project_bit_depth_set) {
    const auto existing = idempotency_ledger_.find(request.idempotency_key);
    if (existing != idempotency_ledger_.end()) {
      const bool same_arguments = existing->second.arguments_fingerprint_sha256
          == request.arguments_fingerprint_sha256;
      return {
          EnqueueCode::kDuplicateRequest,
          "DUPLICATE_REQUEST",
          same_arguments
              ? "idempotency key already reserved or committed; inspect the original request"
              : "idempotency key is already bound to different arguments",
          "params.arguments.idempotencyKey"};
    }
  }
  if (queue_.size() >= config_.max_queue_depth
      || outbound_.size() + active_requests_.size() >= config_.max_outbound_depth) {
    return {EnqueueCode::kQueueFull, "QUEUE_FULL"};
  }
  if (project_bit_depth_set
      && idempotency_ledger_.size() >= config_.max_idempotency_entries) {
    return {
        EnqueueCode::kQueueFull,
        "QUEUE_FULL",
        "native idempotency ledger is full; restart After Effects and use a new key",
        "params.arguments.idempotencyKey"};
  }
  const auto [active, inserted] = active_requests_.insert(key);
  if (!inserted) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  bool idempotency_reserved = false;
  const std::string reserved_idempotency_key = request.idempotency_key;
  try {
    if (project_bit_depth_set) {
      const bool reserved = idempotency_ledger_.emplace(
          request.idempotency_key,
          IdempotencyEntry{
              request.arguments_fingerprint_sha256,
              IdempotencyState::kReserved}).second;
      if (!reserved) {
        active_requests_.erase(active);
        return {
            EnqueueCode::kDuplicateRequest,
            "DUPLICATE_REQUEST",
            "idempotency key was concurrently reserved",
            "params.arguments.idempotencyKey"};
      }
      idempotency_reserved = true;
    }
    queue_.push_back(std::move(request));
  } catch (...) {
    if (idempotency_reserved) idempotency_ledger_.erase(reserved_idempotency_key);
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
    finish_idempotency_locked(*queued, completion);
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
        if (request.capability_id == kProjectGraphInvalidateControl) {
          HostProjectGraphInvalidationResult host_result =
              host.invalidate_project_graph(std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty()
                    ? "native graph invalidation failed" : host_result.message);
          } else if (host_result.value.invalidated
              ? host_result.value.generation < 1
              : host_result.value.generation != 0) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native graph invalidation result was inconsistent");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.project_graph_invalidation_result = host_result.value;
          }
        } else if (request.capability_id == kProjectSummaryCapability) {
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
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.result = std::move(host_result.value);
          }
        } else if (request.capability_id == kProjectBitDepthReadCapability) {
          HostBitDepthReadResult host_result = host.read_project_bit_depth(
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
            completion.bit_depth_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kProjectItemsListCapability) {
          HostProjectItemsResult host_result = host.list_project_items(
              ProjectItemsQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit,
                  request.project_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.project_locator.host_instance_id
                != request.host_instance_id
              || host_result.value.project_locator.session_id != request.session_id
              || (request.project_locator.has_value()
                && host_result.value.project_locator != *request.project_locator)) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native project item page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.project_items_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionLayersListCapability) {
          HostCompositionLayersResult host_result = host.list_composition_layers(
              CompositionLayersQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit,
                  *request.composition_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.composition_locator != *request.composition_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native composition layer page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_layers_result = std::move(host_result.value);
          }
        } else if (request.capability_id
            == kCompositionSelectedLayersListCapability) {
          HostCompositionLayersResult host_result =
              host.list_selected_composition_layers(
                  CompositionLayersQuery{
                      request.host_instance_id,
                      request.session_id,
                      request.offset,
                      request.limit,
                      *request.composition_locator},
                  std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.composition_locator != *request.composition_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native selected composition layer page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_selected_layers_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionTimeReadCapability) {
          HostCompositionTimeResult host_result = host.read_composition_time(
              CompositionTimeQuery{
                  request.host_instance_id,
                  request.session_id,
                  *request.composition_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.composition_locator
              != *request.composition_locator
              || host_result.value.current_time.scale == 0
              || host_result.value.current_time.seconds_rational
                  != canonical_seconds_rational(
                      host_result.value.current_time.value,
                      host_result.value.current_time.scale)) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native composition time result was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_time_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kLayerPropertiesListCapability) {
          HostLayerPropertiesResult host_result = host.list_layer_properties(
              LayerPropertiesQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit,
                  *request.layer_locator,
                  request.parent_property_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.layer_locator != *request.layer_locator
              || host_result.value.parent_property_locator
                != request.parent_property_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native layer property page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.layer_properties_result = std::move(host_result.value);
          }
        } else {
          // The idle budget decides whether another task may start in this
          // batch. An AEGP write is synchronous and cannot be interrupted, so
          // its semantic deadline remains the caller's request deadline.
          HostBitDepthWriteResult host_result = host.set_project_bit_depth(
              request.target_depth, request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect project state");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || !valid_bit_depth(host_result.value.before_bits_per_channel)
              || !valid_bit_depth(host_result.value.after_bits_per_channel)
              || host_result.value.before_bits_per_channel
                == host_result.value.after_bits_per_channel
              || host_result.value.after_bits_per_channel != request.target_depth) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write result did not verify the requested project bit depth");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.bit_depth_change_result = std::move(host_result.value);
          }
        }
      } catch (...) {
        completion = failure_for(
            request,
            request.capability_id == kProjectBitDepthSetCapability
                ? "POSSIBLY_SIDE_EFFECTING_FAILURE" : "CAPABILITY_FAILED",
            "native host adapter raised an exception");
      }
    }
    {
      std::lock_guard lock(mutex_);
      finish_idempotency_locked(request, completion);
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

void HostDispatcher::mark_idempotency_ambiguous(std::string_view idempotency_key) {
  if (!valid_idempotency_key(idempotency_key)) return;
  std::lock_guard lock(mutex_);
  const auto entry = idempotency_ledger_.find(std::string(idempotency_key));
  if (entry != idempotency_ledger_.end()) {
    entry->second.state = IdempotencyState::kAmbiguous;
  }
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

void HostDispatcher::finish_idempotency_locked(
    const Request& request, const Completion& completion) {
  if (request.capability_id != kProjectBitDepthSetCapability
      || request.idempotency_key.empty()) {
    return;
  }
  const auto entry = idempotency_ledger_.find(request.idempotency_key);
  if (entry == idempotency_ledger_.end()) return;
  if (completion.ok) {
    entry->second.state = IdempotencyState::kSucceeded;
    return;
  }
  if (completion.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE") {
    entry->second.state = IdempotencyState::kAmbiguous;
    return;
  }
  // Safe pre-mutation failures and cancellation release the reservation so a
  // caller can retry with the same user-intent key. Successful or ambiguous
  // fences above are deliberately process-lifetime and never evicted.
  idempotency_ledger_.erase(entry);
}

}  // namespace aemcp::native
