#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

namespace aemcp::native {

inline constexpr std::string_view kProjectSummaryCapability = "ae.project.summary";
inline constexpr std::string_view kProjectBitDepthReadCapability =
    "ae.project.bit-depth.read";
inline constexpr std::string_view kProjectBitDepthSetCapability =
    "ae.project.bit-depth.set";
inline constexpr std::string_view kProjectItemsListCapability =
    "ae.project.items.list";
inline constexpr std::string_view kCompositionLayersListCapability =
    "ae.composition.layers.list";
inline constexpr std::string_view kCompositionTimeReadCapability =
    "ae.composition.time.read";
inline constexpr std::string_view kLayerPropertiesListCapability =
    "ae.layer.properties.list";
inline constexpr std::size_t kNativePageValueBudgetBytes = 48U * 1024U;

// Selects the logical effective AEGP name: a non-empty layer override, then a
// non-empty GetLayerName source result, then the associated source Item name.
// This does not infer the current Layer Name/Source Name UI column toggle.
[[nodiscard]] inline std::optional<std::string> select_effective_layer_name(
    const std::optional<std::string>& layer_name,
    const std::optional<std::string>& source_name,
    const std::optional<std::string>& source_item_name) {
  if (layer_name.has_value() && !layer_name->empty()) return layer_name;
  if (source_name.has_value() && !source_name->empty()) return source_name;
  if (source_item_name.has_value() && !source_item_name->empty()) {
    return source_item_name;
  }
  if (layer_name.has_value()) return layer_name;
  if (source_name.has_value()) return source_name;
  return source_item_name;
}

// Returns the exact byte count used by the codec's JSON string serializer,
// including quotes and control-character escaping. It is intentionally
// independent of AE SDK types so bounded page assembly is portable-testable.
[[nodiscard]] std::size_t json_encoded_string_size(std::string_view value) noexcept;

class BoundedPageBudget final {
 public:
  explicit BoundedPageBudget(
      std::size_t initial_bytes,
      std::size_t maximum_bytes = kNativePageValueBudgetBytes) noexcept;

  [[nodiscard]] bool try_reserve(std::size_t bytes) noexcept;
  [[nodiscard]] std::size_t used_bytes() const noexcept { return used_bytes_; }
  [[nodiscard]] std::size_t maximum_bytes() const noexcept { return maximum_bytes_; }

 private:
  std::size_t used_bytes_{0};
  std::size_t maximum_bytes_{0};
};

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

struct ProjectBitDepth {
  std::int32_t bits_per_channel{0};
};

struct ProjectBitDepthChanged {
  bool changed{true};
  std::int32_t before_bits_per_channel{0};
  std::int32_t after_bits_per_channel{0};
};

struct ObjectLocator {
  std::string kind;
  std::string host_instance_id;
  std::string session_id;
  std::string project_id;
  std::uint64_t generation{0};
  std::string object_id;

  [[nodiscard]] bool operator==(const ObjectLocator&) const = default;
};

struct ProjectItemEntry {
  ObjectLocator locator;
  std::string name;
  std::string type;
  std::optional<ObjectLocator> parent_locator;
};

struct ProjectItemsPage {
  ObjectLocator project_locator;
  std::uint64_t total{0};
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  bool has_more{false};
  std::optional<std::uint64_t> next_offset;
  std::vector<ProjectItemEntry> items;
};

struct CompositionLayerEntry {
  ObjectLocator locator;
  std::uint64_t stack_index{0};
  std::string name;
  std::string type;
  bool video_enabled{false};
  bool is_three_d{false};
  bool locked{false};
  std::optional<ObjectLocator> parent_locator;
  std::optional<ObjectLocator> source_item_locator;
};

struct CompositionLayersPage {
  ObjectLocator composition_locator;
  std::string composition_name;
  std::uint64_t total{0};
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  bool has_more{false};
  std::optional<std::uint64_t> next_offset;
  std::vector<CompositionLayerEntry> layers;
};

struct CompositionCurrentTime {
  std::int32_t value{0};
  std::uint32_t scale{1};
  std::string seconds_rational{"0"};
};

struct CompositionTimeRead {
  ObjectLocator composition_locator;
  CompositionCurrentTime current_time;
};

// Canonical reduced representation of value / scale. This deliberately
// promotes signed SDK values before magnitude conversion so INT32_MIN is safe.
[[nodiscard]] inline std::string canonical_seconds_rational(
    std::int64_t value, std::uint64_t scale) {
  if (scale == 0) {
    throw std::invalid_argument("composition time scale must be positive");
  }
  if (value == 0) return "0";
  const std::uint64_t magnitude = value < 0
      ? static_cast<std::uint64_t>(-(value + 1)) + 1U
      : static_cast<std::uint64_t>(value);
  const std::uint64_t divisor = std::gcd(magnitude, scale);
  std::string result = value < 0 ? "-" : "";
  result += std::to_string(magnitude / divisor);
  const std::uint64_t denominator = scale / divisor;
  if (denominator != 1) {
    result.push_back('/');
    result += std::to_string(denominator);
  }
  return result;
}

struct LayerPropertySampleTime {
  std::int64_t value{0};
  std::uint64_t scale{1};
};

struct LayerPropertyScalarValue {
  std::string value;
};

struct LayerPropertyVectorValue {
  std::vector<std::string> components;
};

struct LayerPropertyColorValue {
  std::string alpha;
  std::string red;
  std::string green;
  std::string blue;
};

using LayerPropertyValue = std::variant<
    std::monostate,
    LayerPropertyScalarValue,
    LayerPropertyVectorValue,
    LayerPropertyColorValue>;

struct LayerPropertyEntry {
  ObjectLocator property_locator;
  std::uint64_t property_index{0};
  std::string name;
  std::string match_name;
  std::string grouping_type;
  std::uint64_t child_count{0};
  bool hidden{false};
  bool disabled{false};
  bool modified{false};
  std::optional<bool> can_vary_over_time;
  std::optional<bool> time_varying;
  std::string value_type;
  std::string value_status;
  LayerPropertyValue value;
};

struct LayerPropertiesPage {
  ObjectLocator layer_locator;
  std::optional<ObjectLocator> parent_property_locator;
  std::string layer_name;
  LayerPropertySampleTime sample_time;
  std::uint64_t total{0};
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  bool has_more{false};
  std::optional<std::uint64_t> next_offset;
  std::vector<LayerPropertyEntry> properties;
};

struct ProjectItemsQuery {
  std::string host_instance_id;
  std::string session_id;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  std::optional<ObjectLocator> project_locator;
};

struct CompositionLayersQuery {
  std::string host_instance_id;
  std::string session_id;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  ObjectLocator composition_locator;
};

struct CompositionTimeQuery {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator composition_locator;
};

struct LayerPropertiesQuery {
  std::string host_instance_id;
  std::string session_id;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  ObjectLocator layer_locator;
  std::optional<ObjectLocator> parent_property_locator;
};

struct HostReadResult {
  bool ok{false};
  ProjectSummary value;
  std::string error_code;
  std::string message;

  [[nodiscard]] static HostReadResult success(ProjectSummary summary);
  [[nodiscard]] static HostReadResult failure(std::string code, std::string detail);
};

struct HostBitDepthReadResult {
  bool ok{false};
  ProjectBitDepth value;
  std::string error_code;
  std::string message;

  [[nodiscard]] static HostBitDepthReadResult success(ProjectBitDepth result);
  [[nodiscard]] static HostBitDepthReadResult failure(
      std::string code, std::string detail);
};

struct HostBitDepthWriteResult {
  bool ok{false};
  ProjectBitDepthChanged value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostBitDepthWriteResult success(ProjectBitDepthChanged result);
  [[nodiscard]] static HostBitDepthWriteResult failure(
      std::string code, std::string detail, std::string field = {});
};

struct HostProjectItemsResult {
  bool ok{false};
  ProjectItemsPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostProjectItemsResult success(ProjectItemsPage page);
  [[nodiscard]] static HostProjectItemsResult failure(
      std::string code, std::string detail, std::string field = {});
};

struct HostCompositionLayersResult {
  bool ok{false};
  CompositionLayersPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionLayersResult success(CompositionLayersPage page);
  [[nodiscard]] static HostCompositionLayersResult failure(
      std::string code, std::string detail, std::string field = {});
};

struct HostCompositionTimeResult {
  bool ok{false};
  CompositionTimeRead value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionTimeResult success(CompositionTimeRead value);
  [[nodiscard]] static HostCompositionTimeResult failure(
      std::string code, std::string detail, std::string field = {});
};

struct HostLayerPropertiesResult {
  bool ok{false};
  LayerPropertiesPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostLayerPropertiesResult success(LayerPropertiesPage page);
  [[nodiscard]] static HostLayerPropertiesResult failure(
      std::string code, std::string detail, std::string field = {});
};

class HostApi {
 public:
  virtual ~HostApi() = default;
  [[nodiscard]] virtual HostReadResult read_project_summary(TimePoint work_deadline) = 0;
  [[nodiscard]] virtual HostBitDepthReadResult read_project_bit_depth(
      TimePoint work_deadline);
  [[nodiscard]] virtual HostBitDepthWriteResult set_project_bit_depth(
      std::int32_t target_depth, TimePoint work_deadline);
  [[nodiscard]] virtual HostProjectItemsResult list_project_items(
      const ProjectItemsQuery& query, TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionLayersResult list_composition_layers(
      const CompositionLayersQuery& query, TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionTimeResult read_composition_time(
      const CompositionTimeQuery& query, TimePoint work_deadline);
  [[nodiscard]] virtual HostLayerPropertiesResult list_layer_properties(
      const LayerPropertiesQuery& query, TimePoint work_deadline);
};

struct Request {
  Request() = default;
  Request(
      std::string request_id_value,
      std::string capability_id_value,
      TimePoint deadline_value,
      std::string route_id_value = {},
      std::uint64_t session_generation_value = 0,
      std::int32_t target_depth_value = 0,
      std::string idempotency_key_value = {},
      std::string arguments_fingerprint_value = {},
      std::string host_instance_id_value = {},
      std::string session_id_value = {},
      std::uint64_t offset_value = 0,
      std::uint16_t limit_value = 0,
      std::optional<ObjectLocator> project_locator_value = std::nullopt,
      std::optional<ObjectLocator> composition_locator_value = std::nullopt,
      std::optional<ObjectLocator> layer_locator_value = std::nullopt,
      std::optional<ObjectLocator> parent_property_locator_value = std::nullopt)
      : request_id(std::move(request_id_value)),
        capability_id(std::move(capability_id_value)),
        deadline(deadline_value),
        route_id(std::move(route_id_value)),
        session_generation(session_generation_value),
        target_depth(target_depth_value),
        idempotency_key(std::move(idempotency_key_value)),
        arguments_fingerprint_sha256(std::move(arguments_fingerprint_value)),
        host_instance_id(std::move(host_instance_id_value)),
        session_id(std::move(session_id_value)),
        offset(offset_value),
        limit(limit_value),
        project_locator(std::move(project_locator_value)),
        composition_locator(std::move(composition_locator_value)),
        layer_locator(std::move(layer_locator_value)),
        parent_property_locator(std::move(parent_property_locator_value)) {}

  std::string request_id;
  std::string capability_id;
  TimePoint deadline;
  // Opaque transport ownership. Authenticated IPC callers must supply a
  // non-empty route and monotonically increase the generation whenever that
  // route is re-bound.
  std::string route_id{};
  std::uint64_t session_generation{0};
  std::int32_t target_depth{0};
  std::string idempotency_key;
  std::string arguments_fingerprint_sha256;
  std::string host_instance_id;
  std::string session_id;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  std::optional<ObjectLocator> project_locator;
  std::optional<ObjectLocator> composition_locator;
  std::optional<ObjectLocator> layer_locator;
  std::optional<ObjectLocator> parent_property_locator;
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
  EnqueueResult() = default;
  EnqueueResult(
      EnqueueCode code_value,
      std::string error_code_value = {},
      std::string message_value = {},
      std::string error_field_value = {})
      : code(code_value),
        error_code(std::move(error_code_value)),
        message(std::move(message_value)),
        error_field(std::move(error_field_value)) {}

  EnqueueCode code{EnqueueCode::kInvalidRequest};
  std::string error_code;
  std::string message;
  std::string error_field;
};

struct Completion {
  std::string request_id;
  std::string capability_id;
  std::string route_id;
  std::uint64_t session_generation{0};
  bool ok{false};
  ProjectSummary result;
  ProjectBitDepth bit_depth_result;
  ProjectBitDepthChanged bit_depth_change_result;
  ProjectItemsPage project_items_result;
  CompositionLayersPage composition_layers_result;
  CompositionTimeRead composition_time_result;
  LayerPropertiesPage layer_properties_result;
  // Internal fence correlation only; never serialized or logged.
  std::string idempotency_key;
  std::string error_code;
  std::string message;
  std::string error_field;
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
  // Idempotency fences are process-lifetime safety state. Successful or
  // ambiguous entries are never evicted; saturation fails closed before any
  // host mutation and an AE restart starts a fresh ledger.
  std::size_t max_idempotency_entries{128};
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
  void mark_idempotency_ambiguous(std::string_view idempotency_key);
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

  enum class IdempotencyState { kReserved, kSucceeded, kAmbiguous };

  struct IdempotencyEntry {
    std::string arguments_fingerprint_sha256;
    IdempotencyState state{IdempotencyState::kReserved};
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
  void finish_idempotency_locked(const Request& request, const Completion& completion);

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
  std::unordered_map<std::string, IdempotencyEntry> idempotency_ledger_;
  bool route_fences_saturated_{false};
};

}  // namespace aemcp::native
