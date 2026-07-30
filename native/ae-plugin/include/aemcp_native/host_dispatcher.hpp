#pragma once

#include "aemcp_native/native_program.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
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

inline constexpr std::string_view kNativeProgramCapability = "ae.native.exec";
// Authenticated broker control-plane operation. This is deliberately omitted
// from model-facing capability discovery and can only fence native locator
// cache state; it never changes the After Effects project.
inline constexpr std::string_view kProjectGraphInvalidateControl =
    "internal.project-graph.invalidate";
inline constexpr std::size_t kNativePageValueBudgetBytes = 48U * 1024U;

// Selects the logical effective AEGP name: a non-empty layer override, then a
// non-empty GetLayerName source result, then the associated source Item name.
// This does not infer the current Layer Name/Source Name UI column toggle.
[[nodiscard]] inline std::optional<std::string> select_effective_layer_name(
    const std::optional<std::string> &layer_name,
    const std::optional<std::string> &source_name,
    const std::optional<std::string> &source_item_name) {
  if (layer_name.has_value() && !layer_name->empty())
    return layer_name;
  if (source_name.has_value() && !source_name->empty())
    return source_name;
  if (source_item_name.has_value() && !source_item_name->empty()) {
    return source_item_name;
  }
  if (layer_name.has_value())
    return layer_name;
  if (source_name.has_value())
    return source_name;
  return source_item_name;
}

// Returns the exact byte count used by the codec's JSON string serializer,
// including quotes and control-character escaping. It is intentionally
// independent of AE SDK types so bounded page assembly is portable-testable.
[[nodiscard]] std::size_t
json_encoded_string_size(std::string_view value) noexcept;

class BoundedPageBudget final {
public:
  explicit BoundedPageBudget(
      std::size_t initial_bytes,
      std::size_t maximum_bytes = kNativePageValueBudgetBytes) noexcept;

  [[nodiscard]] bool try_reserve(std::size_t bytes) noexcept;
  [[nodiscard]] std::size_t used_bytes() const noexcept { return used_bytes_; }
  [[nodiscard]] std::size_t maximum_bytes() const noexcept {
    return maximum_bytes_;
  }

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

struct ProjectGraphInvalidation {
  bool invalidated{false};
  std::uint64_t generation{0};
};

struct ObjectLocator {
  std::string kind;
  std::string host_instance_id;
  std::string session_id;
  std::string project_id;
  std::uint64_t generation{0};
  std::string object_id;

  [[nodiscard]] bool operator==(const ObjectLocator &) const = default;
};

// Host-only resolution evidence. Neither token is part of the locator wire
// shape or any completion. composition_owner is the invariant that lets the
// dispatcher reject two current same-project layers owned by different
// compositions before opening an Undo group.
struct HostResolvedLayer {
  ObjectLocator locator;
  std::uintptr_t host_layer{0};
  std::uintptr_t composition_owner{0};
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

  [[nodiscard]] bool operator==(const CompositionCurrentTime &) const = default;
};

struct CompositionTimeRead {
  ObjectLocator composition_locator;
  CompositionCurrentTime current_time;
};

struct CompositionTimeChanged {
  bool changed{true};
  ObjectLocator composition_locator;
  CompositionCurrentTime before_time;
  CompositionCurrentTime after_time;
};

struct CompositionPositiveRatio {
  std::int32_t numerator{1};
  std::int32_t denominator{1};
  std::string rational{"1"};

  [[nodiscard]] bool
  operator==(const CompositionPositiveRatio &) const = default;
};

struct CompositionColor {
  std::uint8_t red{0};
  std::uint8_t green{0};
  std::uint8_t blue{0};
  std::uint8_t alpha{255};

  [[nodiscard]] bool operator==(const CompositionColor &) const = default;
};

struct CompositionSettings {
  ObjectLocator composition_locator;
  std::string name;
  std::uint32_t width{0};
  std::uint32_t height{0};
  CompositionCurrentTime duration;
  CompositionCurrentTime frame_duration;
  CompositionPositiveRatio frame_rate;
  CompositionPositiveRatio pixel_aspect_ratio;
  CompositionColor background_color;
  CompositionCurrentTime work_area_start;
  CompositionCurrentTime work_area_duration;
  CompositionCurrentTime display_start_time;
  std::uint64_t layer_count{0};

  [[nodiscard]] bool operator==(const CompositionSettings &) const = default;
};

enum class CompositionSettingKind {
  kDuration,
  kFrameRate,
  kPixelAspectRatio,
  kDisplayStartTime,
};

struct CompositionSettingsChanged {
  bool changed{true};
  ObjectLocator composition_locator;
  CompositionSettings before;
  CompositionSettings after;
};

// Canonical reduced representation of value / scale. This deliberately
// promotes signed SDK values before magnitude conversion so INT32_MIN is safe.
[[nodiscard]] inline std::string
canonical_seconds_rational(std::int64_t value, std::uint64_t scale) {
  if (scale == 0) {
    throw std::invalid_argument("composition time scale must be positive");
  }
  if (value == 0)
    return "0";
  const std::uint64_t magnitude =
      value < 0 ? static_cast<std::uint64_t>(-(value + 1)) + 1U
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

  [[nodiscard]] bool
  operator==(const LayerPropertySampleTime &) const = default;
};

struct LayerPropertyScalarValue {
  std::string value;
  [[nodiscard]] bool
  operator==(const LayerPropertyScalarValue &) const = default;
};

struct LayerPropertyVectorValue {
  std::vector<std::string> components;
  [[nodiscard]] bool
  operator==(const LayerPropertyVectorValue &) const = default;
};

struct LayerPropertyColorValue {
  std::string alpha;
  std::string red;
  std::string green;
  std::string blue;
  [[nodiscard]] bool
  operator==(const LayerPropertyColorValue &) const = default;
};

using LayerPropertyValue =
    std::variant<std::monostate, LayerPropertyScalarValue,
                 LayerPropertyVectorValue, LayerPropertyColorValue>;

struct LayerPropertyChanged {
  bool changed{true};
  ObjectLocator layer_locator;
  ObjectLocator property_locator;
  std::string value_type;
  LayerPropertyValue before_value;
  LayerPropertyValue after_value;
};

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

struct LayerPropertyKeyframeEntry {
  std::uint64_t keyframe_index{0};
  LayerPropertySampleTime time;
  LayerPropertyValue value;
  std::string in_interpolation;
  std::string out_interpolation;
};

struct LayerPropertyKeyframesPage {
  ObjectLocator property_locator;
  std::string value_type;
  std::uint64_t total{0};
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  bool has_more{false};
  std::optional<std::uint64_t> next_offset;
  std::vector<LayerPropertyKeyframeEntry> keyframes;
};

struct LayerPropertyKeyframeEase {
  std::string speed;
  std::string influence;

  [[nodiscard]] bool
  operator==(const LayerPropertyKeyframeEase &) const = default;
};

struct LayerPropertyKeyframeDimensionEase {
  std::uint16_t dimension{0};
  LayerPropertyKeyframeEase in_ease;
  LayerPropertyKeyframeEase out_ease;

  [[nodiscard]] bool
  operator==(const LayerPropertyKeyframeDimensionEase &) const = default;
};

struct LayerPropertyKeyframeBehavior {
  bool temporal_continuous{false};
  bool temporal_auto_bezier{false};
  bool spatial_continuous{false};
  bool spatial_auto_bezier{false};
  bool roving{false};

  [[nodiscard]] bool
  operator==(const LayerPropertyKeyframeBehavior &) const = default;
};

struct LayerPropertyKeyframeDetails {
  ObjectLocator property_locator;
  LayerPropertySampleTime time;
  std::string value_type;
  LayerPropertyValue value;
  std::uint16_t temporal_dimensionality{0};
  std::string in_interpolation;
  std::string out_interpolation;
  std::vector<LayerPropertyKeyframeDimensionEase> temporal_ease;
  LayerPropertyKeyframeBehavior behavior;

  [[nodiscard]] bool
  operator==(const LayerPropertyKeyframeDetails &) const = default;
};

struct LayerPropertyKeyframeChanged {
  bool changed{true};
  ObjectLocator layer_locator;
  ObjectLocator property_locator;
  LayerPropertySampleTime time;
  std::uint64_t keyframe_count_before{0};
  std::uint64_t keyframe_count_after{0};
  std::optional<LayerPropertyKeyframeDetails> before;
  std::optional<LayerPropertyKeyframeDetails> after;
};

enum class LayerPropertyKeyframeMutationKind {
  kAdd,
  kSetValue,
  kSetInterpolation,
  kSetTemporalEase,
  kSetBehavior,
  kDelete,
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

struct CompositionTimeSetCommand {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator composition_locator;
  CompositionCurrentTime target_time;
};

// Text/Shape/Marker keeps the proven native-media JSON result/evidence bridge,
// but carries frozen typed arguments to the main-thread host implementation.
// Shape paths deliberately reuse NativeMediaMaskVertex instead of defining a
// second Bezier representation.

struct LayerPropertiesQuery {
  std::string host_instance_id;
  std::string session_id;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  ObjectLocator layer_locator;
  std::optional<ObjectLocator> parent_property_locator;
};

struct LayerPropertyKeyframesQuery {
  std::string host_instance_id;
  std::string session_id;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  ObjectLocator property_locator;
};

struct LayerPropertySetCommand {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator layer_locator;
  ObjectLocator property_locator;
  LayerPropertyValue value;
};

struct LayerPropertyKeyframeDetailsQuery {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator property_locator;
  LayerPropertySampleTime time;
};

struct LayerPropertyKeyframeMutationCommand {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator layer_locator;
  ObjectLocator property_locator;
  LayerPropertySampleTime time;
  LayerPropertyKeyframeMutationKind kind{
      LayerPropertyKeyframeMutationKind::kAdd};
  LayerPropertyValue value;
  std::string in_interpolation;
  std::string out_interpolation;
  std::vector<LayerPropertyKeyframeDimensionEase> temporal_ease;
  std::string behavior;
  bool enabled{false};
};

struct CompositionSettingsQuery {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator composition_locator;
};

struct CompositionSettingsSetCommand {
  std::string host_instance_id;
  std::string session_id;
  ObjectLocator composition_locator;
  CompositionSettingKind kind{CompositionSettingKind::kDuration};
  CompositionCurrentTime time;
  CompositionPositiveRatio ratio;
};

struct HostProjectItemsResult {
  bool ok{false};
  ProjectItemsPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostProjectItemsResult success(ProjectItemsPage page);
  [[nodiscard]] static HostProjectItemsResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostCompositionSettingsResult {
  bool ok{false};
  CompositionSettings value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionSettingsResult
  success(CompositionSettings value);
  [[nodiscard]] static HostCompositionSettingsResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostCompositionSettingsWriteResult {
  bool ok{false};
  CompositionSettingsChanged value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionSettingsWriteResult
  success(CompositionSettingsChanged value);
  [[nodiscard]] static HostCompositionSettingsWriteResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostCompositionLayersResult {
  bool ok{false};
  CompositionLayersPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionLayersResult
  success(CompositionLayersPage page);
  [[nodiscard]] static HostCompositionLayersResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostCompositionTimeResult {
  bool ok{false};
  CompositionTimeRead value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionTimeResult
  success(CompositionTimeRead value);
  [[nodiscard]] static HostCompositionTimeResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostCompositionTimeWriteResult {
  bool ok{false};
  CompositionTimeChanged value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostCompositionTimeWriteResult
  success(CompositionTimeChanged value);
  [[nodiscard]] static HostCompositionTimeWriteResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostLayerPropertiesResult {
  bool ok{false};
  LayerPropertiesPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostLayerPropertiesResult
  success(LayerPropertiesPage page);
  [[nodiscard]] static HostLayerPropertiesResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostLayerPropertyKeyframesResult {
  bool ok{false};
  LayerPropertyKeyframesPage value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostLayerPropertyKeyframesResult
  success(LayerPropertyKeyframesPage page);
  [[nodiscard]] static HostLayerPropertyKeyframesResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostLayerPropertyWriteResult {
  bool ok{false};
  LayerPropertyChanged value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostLayerPropertyWriteResult
  success(LayerPropertyChanged value);
  [[nodiscard]] static HostLayerPropertyWriteResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostLayerPropertyKeyframeDetailsResult {
  bool ok{false};
  LayerPropertyKeyframeDetails value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostLayerPropertyKeyframeDetailsResult
  success(LayerPropertyKeyframeDetails value);
  [[nodiscard]] static HostLayerPropertyKeyframeDetailsResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostLayerPropertyKeyframeWriteResult {
  bool ok{false};
  LayerPropertyKeyframeChanged value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostLayerPropertyKeyframeWriteResult
  success(LayerPropertyKeyframeChanged value);
  [[nodiscard]] static HostLayerPropertyKeyframeWriteResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostActionResult {
  bool ok{false};
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static HostActionResult success();
  [[nodiscard]] static HostActionResult
  failure(std::string code, std::string detail, std::string field = {});
};

struct HostProjectGraphInvalidationResult {
  bool ok{false};
  ProjectGraphInvalidation value;
  std::string error_code;
  std::string message;

  [[nodiscard]] static HostProjectGraphInvalidationResult
  success(ProjectGraphInvalidation result);
  [[nodiscard]] static HostProjectGraphInvalidationResult
  failure(std::string code, std::string detail);
};

enum class NativeProgramDisposition {
  kNotStarted,
  kCompleted,
  kPossiblySideEffecting,
};

struct NativeProgramOperationOutcome {
  std::size_t index{0};
  std::string primitive_id;
  JsonValue value;
};

struct NativeProgramHostResult {
  bool ok{false};
  std::vector<NativeProgramOperationOutcome> operations;
  JsonObject outputs;
  std::vector<std::size_t> completed_operation_indices;
  std::optional<std::size_t> failed_operation_index;
  bool write_started{false};
  bool undo_available{false};
  NativeProgramDisposition disposition{NativeProgramDisposition::kNotStarted};
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static NativeProgramHostResult
  success(std::vector<NativeProgramOperationOutcome> operations,
          JsonObject outputs);
  [[nodiscard]] static NativeProgramHostResult
  failure(std::string code, std::string detail, std::string field,
          std::vector<std::size_t> completed_indices,
          std::optional<std::size_t> failed_index, bool write_started,
          NativeProgramDisposition disposition,
          std::vector<NativeProgramOperationOutcome> operations = {},
          JsonObject outputs = {});
};

class HostApi {
public:
  virtual ~HostApi() = default;
  [[nodiscard]] virtual NativeProgramHostResult
  execute_native_program(const NativeProgram &program,
                         std::string_view host_instance_id,
                         std::string_view session_id, TimePoint work_deadline);
  [[nodiscard]] virtual HostProjectItemsResult
  list_project_items(const ProjectItemsQuery &query, TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionSettingsResult
  read_composition_settings(const CompositionSettingsQuery &query,
                            TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionSettingsWriteResult
  set_composition_setting(const CompositionSettingsSetCommand &command,
                          TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionLayersResult
  list_composition_layers(const CompositionLayersQuery &query,
                          TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionLayersResult
  list_selected_composition_layers(const CompositionLayersQuery &query,
                                   TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionTimeResult
  read_composition_time(const CompositionTimeQuery &query,
                        TimePoint work_deadline);
  [[nodiscard]] virtual HostCompositionTimeWriteResult
  set_composition_time(const CompositionTimeSetCommand &command,
                       TimePoint work_deadline);
  [[nodiscard]] virtual HostLayerPropertiesResult
  list_layer_properties(const LayerPropertiesQuery &query,
                        TimePoint work_deadline);
  [[nodiscard]] virtual HostLayerPropertyKeyframesResult
  list_layer_property_keyframes(const LayerPropertyKeyframesQuery &query,
                                TimePoint work_deadline);
  [[nodiscard]] virtual HostLayerPropertyWriteResult
  set_layer_property(const LayerPropertySetCommand &command,
                     TimePoint work_deadline);
  [[nodiscard]] virtual HostLayerPropertyKeyframeDetailsResult
  read_layer_property_keyframe_details(
      const LayerPropertyKeyframeDetailsQuery &query, TimePoint work_deadline);
  [[nodiscard]] virtual HostLayerPropertyKeyframeWriteResult
  mutate_layer_property_keyframe(
      const LayerPropertyKeyframeMutationCommand &command,
      TimePoint work_deadline);
  [[nodiscard]] virtual HostActionResult
  begin_undo_group(std::string_view label, TimePoint work_deadline);
  [[nodiscard]] virtual HostActionResult
  end_undo_group(TimePoint work_deadline);
  [[nodiscard]] virtual HostProjectGraphInvalidationResult
  invalidate_project_graph(TimePoint work_deadline);
};

struct Request {
  std::string request_id;
  std::string capability_id{std::string(kNativeProgramCapability)};
  TimePoint deadline;
  std::string route_id;
  std::uint64_t session_generation{0};
  std::string idempotency_key;
  std::string arguments_fingerprint_sha256;
  std::string host_instance_id;
  std::string session_id;
  std::optional<NativeProgram> native_program;
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
  EnqueueResult(EnqueueCode code_value, std::string error_code_value = {},
                std::string message_value = {},
                std::string error_field_value = {})
      : code(code_value), error_code(std::move(error_code_value)),
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
  NativeProgramHostResult native_program_result;
  ProjectGraphInvalidation project_graph_invalidation_result;
  std::string idempotency_key;
  std::string error_code;
  std::string message;
  std::string error_field;
  bool late_result_discarded{false};
  bool replayed{false};
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
  HostDispatcher(std::thread::id owner_thread, Clock &clock,
                 DispatcherConfig config = {});
  HostDispatcher(const HostDispatcher &) = delete;
  HostDispatcher &operator=(const HostDispatcher &) = delete;

  [[nodiscard]] EnqueueResult enqueue(Request request);
  [[nodiscard]] CancelResult cancel(std::string_view route_id,
                                    std::uint64_t session_generation,
                                    std::string_view target_request_id);
  [[nodiscard]] RouteRevocationResult
  revoke_route(std::string_view route_id, std::uint64_t session_generation);
  [[nodiscard]] DrainBatch drain(HostApi &host);
  // Worker-side transfer only. Host suite calls and socket I/O intentionally
  // live on opposite sides of this bounded queue. Returned generations remain
  // immutable, but the transport owns the final synchronized send decision.
  [[nodiscard]] std::vector<Completion>
  take_outbound(std::size_t max_items = 64);
  // Lifecycle shutdown is owner-thread-only, keeping destruction serialized
  // with drain/HostApi execution. Wrong-thread calls throw std::logic_error.
  [[nodiscard]] std::vector<Completion> shutdown();
  [[nodiscard]] std::size_t queued() const;
  [[nodiscard]] std::size_t outbound() const;
  [[nodiscard]] std::size_t terminal_count();
  [[nodiscard]] bool has_terminal(std::string_view route_id,
                                  std::uint64_t session_generation,
                                  std::string_view request_id);
  void mark_idempotency_ambiguous(std::string_view idempotency_key);
  void invalidate_composition_creation_replays();
  [[nodiscard]] bool running() const;

private:
  enum class State { kRunning, kStopping, kStopped };

  struct RequestKey {
    std::string route_id;
    std::uint64_t session_generation{0};
    std::string request_id;

    [[nodiscard]] bool operator==(const RequestKey &) const = default;
  };

  struct RequestKeyHash {
    [[nodiscard]] std::size_t operator()(const RequestKey &key) const noexcept;
  };

  struct TerminalTombstone {
    RequestKey key;
    TimePoint expires_at;
  };

  enum class IdempotencyState { kReserved, kSucceeded, kAmbiguous };

  struct IdempotencyEntry {
    std::string arguments_fingerprint_sha256;
    IdempotencyState state{IdempotencyState::kReserved};
    std::optional<Completion> replay_completion;
  };

  [[nodiscard]] Completion expired(const Request &request, bool late) const;
  [[nodiscard]] static RequestKey key_for(const Request &request);
  [[nodiscard]] bool
  route_revoked_locked(std::string_view route_id,
                       std::uint64_t session_generation) const;
  [[nodiscard]] bool route_stale_locked(std::string_view route_id,
                                        std::uint64_t session_generation) const;
  [[nodiscard]] bool pending_outbound_locked(const RequestKey &key) const;
  [[nodiscard]] bool terminal_locked(const RequestKey &key) const;
  void purge_terminal_locked(TimePoint now);
  void remember_terminal_locked(RequestKey key, TimePoint now);
  void invalidate_composition_creation_replays_locked();
  [[nodiscard]] bool fence_route_locked(std::string route_id,
                                        std::uint64_t session_generation);
  void finish_request_locked(const RequestKey &key, Completion &completion,
                             TimePoint now);
  void finish_idempotency_locked(const Request &request,
                                 const Completion &completion);

  const std::thread::id owner_thread_;
  Clock &clock_;
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

} // namespace aemcp::native
