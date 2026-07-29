#include "aemcp_native/native_rpc_connection.hpp"
#include "aemcp_native/native_primitive_registry.generated.hpp"
#include "aemcp_native/text_shape_marker_capabilities.generated.hpp"

#include <poll.h>
#include <sys/socket.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace aemcp::native {
namespace {

using namespace std::chrono_literals;
using rpc::CancelState;
using rpc::ParsedRequest;
using rpc::RpcErrorCode;
using rpc::RpcMethod;

constexpr std::chrono::milliseconds kSocketWriteTimeout{1500};

struct ActiveEvidence {
  RpcMethod method{RpcMethod::kInvoke};
  std::string request_digest;
  std::uint64_t started_at_unix_ms{0};
  bool native_program{false};
  bool native_program_contains_write{false};
  std::string operation_key;
  std::string undo_group;
  std::vector<std::string> native_program_operations;
};

bool write_frame(int socket_fd, const std::vector<std::uint8_t>& frame) {
  const auto deadline = std::chrono::steady_clock::now() + kSocketWriteTimeout;
  std::size_t sent = 0;
  while (sent < frame.size()) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    pollfd item{socket_fd, POLLOUT, 0};
    const int polled = ::poll(
        &item, 1, static_cast<int>(std::clamp<std::int64_t>(remaining.count(), 1, 1000)));
    if (polled < 0 && errno == EINTR) continue;
    if (polled <= 0 || (item.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0
        || (item.revents & POLLOUT) == 0) {
      return false;
    }
    const ssize_t count = ::send(socket_fd, frame.data() + sent, frame.size() - sent, 0);
    if (count > 0) sent += static_cast<std::size_t>(count);
    else if (count < 0 && errno == EINTR) continue;
    else return false;
  }
  return true;
}

RpcErrorCode rpc_error_code(std::string_view code) {
  if (code == "NATIVE_UNAVAILABLE") return RpcErrorCode::kNativeUnavailable;
  if (code == "NATIVE_UNSUPPORTED") return RpcErrorCode::kNativeUnsupported;
  if (code == "WIRE_VERSION_MISMATCH") return RpcErrorCode::kWireVersionMismatch;
  if (code == "INVALID_ARGUMENT") return RpcErrorCode::kInvalidArgument;
  if (code == "TRACK_MATTE_COMPOSITION_MISMATCH") {
    return RpcErrorCode::kTrackMatteCompositionMismatch;
  }
  if (code == "LAYER_HAS_NO_AUDIO") return RpcErrorCode::kLayerHasNoAudio;
  if (code == "LAYER_HAS_NO_VIDEO") return RpcErrorCode::kLayerHasNoVideo;
  if (code == "DUPLICATE_REQUEST") return RpcErrorCode::kDuplicateRequest;
  if (code == "PRECONDITION_FAILED") return RpcErrorCode::kPreconditionFailed;
  if (code == "STALE_LOCATOR") return RpcErrorCode::kStaleLocator;
  if (code == "DEADLINE_EXCEEDED") return RpcErrorCode::kDeadlineExceeded;
  if (code == "CANCELLED") return RpcErrorCode::kCancelled;
  if (code == "QUEUE_FULL") return RpcErrorCode::kQueueFull;
  if (code == "AE_SHUTTING_DOWN") return RpcErrorCode::kAeShuttingDown;
  if (code == "SESSION_STALE") return RpcErrorCode::kSessionStale;
  if (code == "CAPABILITY_FAILED") return RpcErrorCode::kCapabilityFailed;
  if (code == "POSSIBLY_SIDE_EFFECTING_FAILURE") {
    return RpcErrorCode::kPossiblySideEffectingFailure;
  }
  return RpcErrorCode::kInvalidRequest;
}

std::string recovery_hint(RpcErrorCode code) {
  switch (code) {
    case RpcErrorCode::kNativeUnavailable: return "Reconnect to the native After Effects host.";
    case RpcErrorCode::kNativeUnsupported: return "Refresh capabilities before retrying.";
    case RpcErrorCode::kWireVersionMismatch: return "Reconnect with a supported wire version.";
    case RpcErrorCode::kInvalidArgument: return "Change the invalid request arguments.";
    case RpcErrorCode::kTrackMatteCompositionMismatch:
      return "Choose a distinct current Matte layer from the target composition.";
    case RpcErrorCode::kLayerHasNoAudio:
      return "Choose a source with audio capability or keep audio disabled.";
    case RpcErrorCode::kLayerHasNoVideo:
      return "Choose a source with video capability or keep video disabled.";
    case RpcErrorCode::kDuplicateRequest: return "Inspect the original request state.";
    case RpcErrorCode::kPreconditionFailed: return "Open an After Effects project first.";
    case RpcErrorCode::kStaleLocator:
      return "Refresh the project graph locator before retrying.";
    case RpcErrorCode::kDeadlineExceeded: return "Retry only if the result is still needed.";
    case RpcErrorCode::kCancelled: return "Issue a new request only if the result is still needed.";
    case RpcErrorCode::kQueueFull: return "Retry after the bounded native queue drains.";
    case RpcErrorCode::kAeShuttingDown: return "Reconnect after After Effects restarts.";
    case RpcErrorCode::kSessionStale: return "Reconnect and establish a fresh session.";
    case RpcErrorCode::kCapabilityFailed: return "Inspect After Effects state before retrying.";
    case RpcErrorCode::kPossiblySideEffectingFailure:
      return "Inspect After Effects state and do not retry this idempotency key.";
    default: return "Correct the request before retrying.";
  }
}

bool keyframe_property_capability(std::string_view capability_id) {
  return capability_id == kLayerPropertyKeyframesListCapability
      || capability_id == kLayerPropertyKeyframeDetailsReadCapability
      || capability_id == kLayerPropertyKeyframeAddCapability
      || capability_id == kLayerPropertyKeyframeValueSetCapability
      || capability_id == kLayerPropertyKeyframeInterpolationSetCapability
      || capability_id == kLayerPropertyKeyframeTemporalEaseSetCapability
      || capability_id == kLayerPropertyKeyframeBehaviorSetCapability
      || capability_id == kLayerPropertyKeyframeDeleteCapability;
}

rpc::ErrorResponse error_for(
    const ParsedRequest& request,
    const std::string& session_id,
    std::string code,
    std::string message,
    std::string capability_id = {},
    std::string field = {},
    std::string idempotency_key = {}) {
  RpcErrorCode mapped = rpc_error_code(code);
  // A repeated hello is a malformed handshake, not a session-scoped failure.
  // Keep the response inside the closed hello error union instead of letting
  // the serializer throw and silently tear down the connection.
  if (request.method == RpcMethod::kHello
      && mapped != RpcErrorCode::kNativeUnavailable
      && mapped != RpcErrorCode::kWireVersionMismatch
      && mapped != RpcErrorCode::kInvalidRequest
      && mapped != RpcErrorCode::kInvalidArgument) {
    mapped = RpcErrorCode::kInvalidRequest;
  }
  rpc::ErrorResponse response;
  response.method = request.method;
  response.request_id = request.request_id;
  if (request.method != RpcMethod::kHello) response.session_id = session_id;
  if (capability_id.empty() && request.method == RpcMethod::kInvoke) {
    if (const auto* invoke = std::get_if<rpc::InvokeParams>(&request.params)) {
      capability_id = invoke->capability_id;
    }
  }
  const bool set_property_precondition = mapped == RpcErrorCode::kPreconditionFailed
      && capability_id == kLayerPropertySetCapability
      && field == "params.arguments.propertyLocator";
  const bool keyframe_property_precondition =
      mapped == RpcErrorCode::kPreconditionFailed
      && keyframe_property_capability(capability_id)
      && field == "params.arguments.propertyLocator";
  const bool property_precondition =
      set_property_precondition || keyframe_property_precondition;
  response.code = mapped;
  response.message = std::move(message);
  response.recovery_hint = keyframe_property_precondition
      ? "Copy a keyframeable primitive scalar, vector, or color leaf locator from ae_listLayerProperties."
      : set_property_precondition
          ? "Choose a non-keyframed supported primitive property and retry with fresh locators."
          : recovery_hint(mapped);
  if (property_precondition) response.recovery_action = "change-arguments";
  if (mapped == RpcErrorCode::kQueueFull) response.retry_after_ms = 50;
  if (mapped == RpcErrorCode::kWireVersionMismatch) {
    response.details = rpc::ErrorDetails{};
    response.details->supported_wire_minimum = 1;
    response.details->supported_wire_maximum = 1;
  }
  if ((mapped == RpcErrorCode::kInvalidArgument && !capability_id.empty())
      || mapped == RpcErrorCode::kNativeUnsupported
      || mapped == RpcErrorCode::kPreconditionFailed
      || mapped == RpcErrorCode::kStaleLocator
      || mapped == RpcErrorCode::kCapabilityFailed
      || mapped == RpcErrorCode::kPossiblySideEffectingFailure) {
    response.details = rpc::ErrorDetails{};
    response.details->capability_id = capability_id.empty()
        ? std::string(kProjectSummaryCapability) : capability_id;
  }
  if (!field.empty()) {
    if (!response.details.has_value()) response.details = rpc::ErrorDetails{};
    response.details->field = std::move(field);
  }
  if (mapped == RpcErrorCode::kPossiblySideEffectingFailure) {
    if (!response.details.has_value()) response.details = rpc::ErrorDetails{};
    response.details->idempotency_key = std::move(idempotency_key);
  }
  return response;
}

CancelState cancel_state(CancelCode code) {
  switch (code) {
    case CancelCode::kQueuedCancelled: return CancelState::kQueuedCancelled;
    case CancelCode::kRunningNotCancellable: return CancelState::kRunningNotCancellable;
    case CancelCode::kAlreadyTerminal: return CancelState::kAlreadyTerminal;
    case CancelCode::kNotFound: return CancelState::kNotFound;
    case CancelCode::kInvalidRequest: return CancelState::kNotFound;
    case CancelCode::kStaleRoute: return CancelState::kNotFound;
  }
  return CancelState::kNotFound;
}

bool valid_digest(std::string_view value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char character) {
    return (character >= '0' && character <= '9')
        || (character >= 'a' && character <= 'f');
  });
}

bool keyframe_write_capability(std::string_view capability_id) {
  return capability_id == kLayerPropertyKeyframeAddCapability
      || capability_id == kLayerPropertyKeyframeValueSetCapability
      || capability_id == kLayerPropertyKeyframeInterpolationSetCapability
      || capability_id == kLayerPropertyKeyframeTemporalEaseSetCapability
      || capability_id == kLayerPropertyKeyframeBehaviorSetCapability
      || capability_id == kLayerPropertyKeyframeDeleteCapability;
}

bool layer_source_matte_av_write_capability(std::string_view capability_id) {
  return capability_id == kLayerTrackMatteSetCapability
      || capability_id == kLayerTrackMatteClearCapability
      || capability_id == kLayerAudioEnabledSetCapability
      || capability_id == kLayerVideoEnabledSetCapability;
}

rpc::LayerSourceType rpc_layer_source_type(LayerSourceType value) {
  switch (value) {
    case LayerSourceType::kNone: return rpc::LayerSourceType::kNone;
    case LayerSourceType::kFootage: return rpc::LayerSourceType::kFootage;
    case LayerSourceType::kComposition:
      return rpc::LayerSourceType::kComposition;
  }
  throw std::invalid_argument("invalid layer source type");
}

rpc::LayerTrackMatteMode rpc_track_matte_mode(LayerTrackMatteMode value) {
  switch (value) {
    case LayerTrackMatteMode::kNone:
      return rpc::LayerTrackMatteMode::kNone;
    case LayerTrackMatteMode::kAlpha:
      return rpc::LayerTrackMatteMode::kAlpha;
    case LayerTrackMatteMode::kInvertedAlpha:
      return rpc::LayerTrackMatteMode::kInvertedAlpha;
    case LayerTrackMatteMode::kLuma:
      return rpc::LayerTrackMatteMode::kLuma;
    case LayerTrackMatteMode::kInvertedLuma:
      return rpc::LayerTrackMatteMode::kInvertedLuma;
  }
  throw std::invalid_argument("invalid layer Track Matte mode");
}

LayerTrackMatteMode dispatcher_track_matte_mode(
    rpc::LayerTrackMatteMode value) {
  switch (value) {
    case rpc::LayerTrackMatteMode::kAlpha:
      return LayerTrackMatteMode::kAlpha;
    case rpc::LayerTrackMatteMode::kInvertedAlpha:
      return LayerTrackMatteMode::kInvertedAlpha;
    case rpc::LayerTrackMatteMode::kLuma:
      return LayerTrackMatteMode::kLuma;
    case rpc::LayerTrackMatteMode::kInvertedLuma:
      return LayerTrackMatteMode::kInvertedLuma;
    case rpc::LayerTrackMatteMode::kNone:
      break;
  }
  throw std::invalid_argument("invalid settable layer Track Matte mode");
}

rpc::LayerSourceValue rpc_layer_source_value(const LayerSourceValue& value) {
  return {
      value.layer_locator,
      value.source_item_locator,
      rpc_layer_source_type(value.source_type),
      value.source_name,
  };
}

rpc::LayerTrackMatteValue rpc_layer_track_matte_value(
    const LayerTrackMatteValue& value) {
  return {
      value.layer_locator,
      value.active,
      value.matte_layer_locator,
      rpc_track_matte_mode(value.mode),
  };
}

rpc::LayerTrackMatteSetValue rpc_layer_track_matte_set_value(
    const LayerTrackMatteSetValue& value) {
  return {
      value.changed,
      value.layer_locator,
      value.before_matte_layer_locator,
      rpc_track_matte_mode(value.before_mode),
      value.after_matte_layer_locator,
      rpc_track_matte_mode(value.after_mode),
  };
}

rpc::LayerTrackMatteClearValue rpc_layer_track_matte_clear_value(
    const LayerTrackMatteClearValue& value) {
  return {
      value.changed,
      value.layer_locator,
      value.before_matte_layer_locator,
      rpc_track_matte_mode(value.before_mode),
      value.after_matte_layer_locator,
      rpc_track_matte_mode(value.after_mode),
  };
}

rpc::LayerAVStateValue rpc_layer_av_state_value(
    const LayerAVStateValue& value) {
  return {
      value.layer_locator,
      value.has_audio,
      value.audio_enabled,
      value.has_video,
      value.video_enabled,
  };
}

rpc::LayerAVSwitchSetValue rpc_layer_av_switch_set_value(
    const LayerAVSwitchSetValue& value) {
  return {
      value.changed,
      value.layer_locator,
      rpc_layer_av_state_value(value.before),
      rpc_layer_av_state_value(value.after),
  };
}

bool valid_timing_evidence(
    const ActiveEvidence& evidence, std::uint64_t completed_at_unix_ms) {
  return valid_digest(evidence.request_digest)
      && evidence.started_at_unix_ms >= 1
      && evidence.started_at_unix_ms <= rpc::kMaxSafeInteger
      && completed_at_unix_ms >= evidence.started_at_unix_ms
      && completed_at_unix_ms <= rpc::kMaxSafeInteger;
}

}  // namespace

std::string_view post_dispatch_evidence_failure_code(
    std::string_view capability_id,
    bool graph_invalidation) noexcept {
  const bool mutating = capability_id == kProjectBitDepthSetCapability
      || capability_id == kCompositionTimeSetCapability
      || capability_id == kCompositionCreateCapability
      || capability_id == kCompositionLayerCreateCapability
      || capability_id == kLayerEffectApplyCapability
      || capability_id == kLayerPropertySetCapability
      || keyframe_write_capability(capability_id)
      || capability_id == kCompositionWorkAreaSetCapability
      || capability_id == kCompositionDimensionsSetCapability
      || capability_id == kCompositionDurationSetCapability
      || capability_id == kCompositionFrameRateSetCapability
      || capability_id == kCompositionPixelAspectRatioSetCapability
      || capability_id == kCompositionBackgroundColorSetCapability
      || capability_id == kCompositionDisplayStartTimeSetCapability
      || capability_id == kProjectItemNameSetCapability
      || capability_id == kProjectItemCommentSetCapability
      || capability_id == kProjectItemLabelSetCapability
      || capability_id == kCompositionDuplicateCapability
      || capability_id == kLayerNameSetCapability
      || capability_id == kLayerRangeSetCapability
      || capability_id == kLayerStartTimeSetCapability
      || capability_id == kLayerStretchSetCapability
      || capability_id == kLayerOrderSetCapability
      || capability_id == kLayerParentSetCapability
      || capability_id == kLayerDuplicateCapability
      || capability_id == kLayerSwitchSetCapability
      || capability_id == kLayerQualitySetCapability
      || capability_id == kLayerBlendingModeSetCapability
      || capability_id == kNativeMediaWriteCapability
      || layer_source_matte_av_write_capability(capability_id)
      || is_text_shape_marker_write_capability(capability_id);
  return mutating
      ? "POSSIBLY_SIDE_EFFECTING_FAILURE"
      : graph_invalidation ? "NATIVE_UNAVAILABLE" : "CAPABILITY_FAILED";
}

NativeRpcConnectionHandler::NativeRpcConnectionHandler(
    HostDispatcher& dispatcher,
    Clock& dispatcher_clock,
    rpc::SessionClock& session_clock,
    NativeRpcRuntimeInfo runtime,
    NativeRpcObserver& observer,
    HostIdleSignal& idle_signal)
    : dispatcher_(dispatcher),
      dispatcher_clock_(dispatcher_clock),
      session_clock_(session_clock),
      runtime_(std::move(runtime)),
      observer_(observer),
      idle_signal_(idle_signal) {
  #if 0  // Individual capability identity carriers were replaced by the registry.
  static_assert(
      std::tuple_size_v<decltype(runtime_.composition_setting_contract_digests)>
      == rpc::kCompositionSettingCapabilityCount);
  bool composition_setting_contracts_valid = true;
  for (std::size_t index = 0;
      index < runtime_.composition_setting_contract_digests.size();
      ++index) {
    const std::string& digest =
        runtime_.composition_setting_contract_digests[index];
    composition_setting_contracts_valid =
        composition_setting_contracts_valid
        && digest.size() == 64
        && digest
            == rpc::kCompositionSettingCapabilities[index].contract_digest;
  }
  const std::array<std::string_view, 7> layer_source_matte_av_contracts{{
      runtime_.layer_source_read_contract_digest,
      runtime_.layer_track_matte_read_contract_digest,
      runtime_.layer_track_matte_set_contract_digest,
      runtime_.layer_track_matte_clear_contract_digest,
      runtime_.layer_av_state_read_contract_digest,
      runtime_.layer_audio_enabled_set_contract_digest,
      runtime_.layer_video_enabled_set_contract_digest,
  }};
  bool layer_source_matte_av_contracts_valid = true;
  for (std::size_t index = 0;
       index < layer_source_matte_av_contracts.size();
       ++index) {
    layer_source_matte_av_contracts_valid =
        layer_source_matte_av_contracts_valid
        && layer_source_matte_av_contracts[index]
            == kLayerSourceMatteAvContractDigests[index];
  }
  if (runtime_.plugin_version.empty() || runtime_.compiled_sdk_version.empty()
      || runtime_.compiled_sdk_build == 0 || runtime_.host_version.empty()
      || runtime_.host_build == 0 || runtime_.host_instance_id.empty()
      || runtime_.capabilities_digest != rpc::kCapabilitiesRegistryDigest
      || runtime_.project_summary_contract_digest.size() != 64
      || runtime_.project_bit_depth_read_contract_digest.size() != 64
      || runtime_.project_bit_depth_set_contract_digest.size() != 64
      || runtime_.project_items_list_contract_digest.size() != 64
      || runtime_.composition_layers_list_contract_digest.size() != 64
      || runtime_.composition_selected_layers_list_contract_digest.size() != 64
      || runtime_.composition_time_read_contract_digest.size() != 64
      || runtime_.composition_time_set_contract_digest.size() != 64
      || runtime_.project_context_read_contract_digest.size() != 64
      || runtime_.project_item_metadata_read_contract_digest.size() != 64
      || runtime_.composition_settings_read_contract_digest.size() != 64
      || runtime_.composition_work_area_set_contract_digest.size() != 64
      || runtime_.project_item_name_set_contract_digest.size() != 64
      || runtime_.project_item_comment_set_contract_digest.size() != 64
      || runtime_.project_item_label_set_contract_digest.size() != 64
      || runtime_.composition_duplicate_contract_digest.size() != 64
      || runtime_.layer_details_read_contract_digest.size() != 64
      || runtime_.layer_name_set_contract_digest.size() != 64
      || runtime_.layer_range_set_contract_digest.size() != 64
      || runtime_.layer_start_time_set_contract_digest.size() != 64
      || runtime_.layer_stretch_set_contract_digest.size() != 64
      || runtime_.layer_order_set_contract_digest.size() != 64
      || runtime_.layer_parent_set_contract_digest.size() != 64
      || runtime_.layer_duplicate_contract_digest.size() != 64
      || runtime_.layer_compositing_read_contract_digest.size() != 64
      || runtime_.layer_switch_set_contract_digest.size() != 64
      || runtime_.layer_quality_set_contract_digest.size() != 64
      || runtime_.layer_blending_mode_set_contract_digest.size() != 64
      || runtime_.layer_effect_apply_contract_digest.size() != 64
      || runtime_.layer_properties_list_contract_digest.size() != 64
      || runtime_.layer_property_keyframes_list_contract_digest.size() != 64
      || runtime_.layer_property_set_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_details_read_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_add_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_value_set_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_interpolation_set_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_temporal_ease_set_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_behavior_set_contract_digest.size() != 64
      || runtime_.layer_property_keyframe_delete_contract_digest.size() != 64
      || runtime_.native_media_read_contract_digest.size() != 64
      || runtime_.native_media_write_contract_digest.size() != 64
      || !layer_source_matte_av_contracts_valid
      || !composition_setting_contracts_valid) {
    throw std::invalid_argument("invalid native RPC runtime identity");
  }
  #endif
  if (runtime_.plugin_version.empty() || runtime_.compiled_sdk_version.empty()
      || runtime_.compiled_sdk_build == 0 || runtime_.host_version.empty()
      || runtime_.host_build == 0 || runtime_.host_instance_id.empty()
      || native_primitive_registry().size() != kNativePrimitiveCount) {
    throw std::invalid_argument("invalid native RPC runtime identity");
  }
}

void NativeRpcConnectionHandler::serve(
    const AuthenticatedConnection& connection) noexcept {
  try {
    rpc::RpcSessionFrontDoor front_door(
        connection.peer.connection_id,
        runtime_.host_instance_id,
        connection.session_id,
        session_clock_);
    rpc::FrameDecoder decoder;
    std::unordered_map<std::string, ActiveEvidence> active;
    std::array<std::uint8_t, 16384> input{};
    bool connected = true;
    while (connected) {
      for (Completion& completion : dispatcher_.take_outbound()) {
        if (completion.route_id != connection.peer.connection_id
            || completion.session_generation != connection.session_generation) {
          observer_.on_rpc_event("terminal.detached", completion.request_id, "route-mismatch");
          continue;
        }
        const auto evidence = active.find(completion.request_id);
        if (evidence == active.end()) {
          observer_.on_rpc_event(
              "terminal.detached", completion.request_id, "missing-request-evidence");
          continue;
        }
        const std::uint64_t completed_at = session_clock_.now_unix_ms();
        const std::string& request_digest = evidence->second.request_digest;
        const std::uint64_t started_at = evidence->second.started_at_unix_ms;
        const bool graph_invalidation =
            completion.capability_id == kProjectGraphInvalidateControl;
        const bool native_program =
            completion.capability_id == kNativeProgramCapability;
        std::vector<rpc::NativeProgramOperationSummary>
            native_program_completed;
        std::optional<rpc::NativeProgramOperationSummary>
            native_program_failed;
        std::string postcondition_digest;
        bool evidence_valid = valid_timing_evidence(evidence->second, completed_at);
        if (native_program && evidence_valid) {
          try {
            const NativeProgramHostResult& result =
                completion.native_program_result;
            if (!evidence->second.native_program
                || result.operations.size()
                    != result.completed_operation_indices.size()) {
              evidence_valid = false;
            } else {
              native_program_completed.reserve(result.operations.size());
              for (std::size_t index = 0;
                   index < result.operations.size(); ++index) {
                const NativeProgramOperationOutcome& operation =
                    result.operations[index];
                if (operation.index
                        >= evidence->second.native_program_operations.size()
                    || operation.index
                        != result.completed_operation_indices[index]
                    || operation.primitive_id
                        != evidence->second.native_program_operations[
                            operation.index]) {
                  evidence_valid = false;
                  break;
                }
                native_program_completed.push_back({
                    operation.index,
                    operation.primitive_id,
                    "completed",
                });
              }
            }
            if (evidence_valid && result.failed_operation_index.has_value()) {
              const std::size_t failed = *result.failed_operation_index;
              if (failed >= evidence->second.native_program_operations.size()) {
                evidence_valid = false;
              } else {
                native_program_failed = rpc::NativeProgramOperationSummary{
                    failed,
                    evidence->second.native_program_operations[failed],
                    "failed",
                };
              }
            }
            if (evidence_valid && completion.ok
                && (result.disposition != NativeProgramDisposition::kCompleted
                    || native_program_completed.size()
                        != evidence->second.native_program_operations.size()
                    || native_program_failed.has_value())) {
              evidence_valid = false;
            }
            if (evidence_valid) {
              postcondition_digest = rpc::digest_native_program_postcondition(
                  result.outputs, native_program_completed);
            }
          } catch (...) {
            evidence_valid = false;
          }
        }
        if (completion.ok && evidence_valid && !native_program) {
          try {
            if (graph_invalidation) {
              evidence_valid = completion.project_graph_invalidation_result.invalidated
                  ? completion.project_graph_invalidation_result.generation >= 1
                    && completion.project_graph_invalidation_result.generation
                      <= rpc::kMaxSafeInteger
                  : completion.project_graph_invalidation_result.generation == 0;
            } else if (completion.capability_id == kProjectSummaryCapability) {
              if (completion.result.item_count < 0
                  || static_cast<std::uint64_t>(completion.result.item_count)
                      > rpc::kMaxSafeInteger) {
                evidence_valid = false;
              } else {
              postcondition_digest = rpc::digest_project_summary_postcondition(
                  completion.result.project_open,
                  completion.result.project_name,
                  static_cast<std::uint64_t>(completion.result.item_count));
              }
            } else if (completion.capability_id == kProjectBitDepthReadCapability) {
              postcondition_digest = rpc::digest_project_bit_depth_read_postcondition(
                  completion.bit_depth_result.bits_per_channel);
            } else if (completion.capability_id == kProjectBitDepthSetCapability) {
              postcondition_digest = rpc::digest_project_bit_depth_set_postcondition(
                  completion.bit_depth_change_result.changed,
                  completion.bit_depth_change_result.before_bits_per_channel,
                  completion.bit_depth_change_result.after_bits_per_channel);
            } else if (completion.capability_id == kProjectItemsListCapability) {
              postcondition_digest = rpc::digest_project_items_postcondition(
                  completion.project_items_result);
            } else if (completion.capability_id == kCompositionLayersListCapability) {
              postcondition_digest = rpc::digest_composition_layers_postcondition(
                  completion.composition_layers_result);
            } else if (completion.capability_id
                == kCompositionSelectedLayersListCapability) {
              postcondition_digest =
                  rpc::digest_composition_selected_layers_postcondition(
                      completion.composition_selected_layers_result);
            } else if (completion.capability_id == kCompositionTimeReadCapability) {
              postcondition_digest = rpc::digest_composition_time_postcondition(
                  completion.composition_time_result);
            } else if (completion.capability_id == kCompositionTimeSetCapability) {
              postcondition_digest = rpc::digest_composition_time_set_postcondition(
                  completion.composition_time_change_result);
            } else if (completion.capability_id == kProjectContextReadCapability) {
              postcondition_digest = rpc::digest_project_context_postcondition(
                  completion.project_context_result);
            } else if (completion.capability_id == kProjectItemMetadataReadCapability) {
              postcondition_digest = rpc::digest_project_item_metadata_postcondition(
                  completion.project_item_metadata_result);
            } else if (completion.capability_id == kCompositionSettingsReadCapability) {
              postcondition_digest = rpc::digest_composition_settings_postcondition(
                  completion.composition_settings_result);
            } else if (completion.capability_id == kCompositionWorkAreaSetCapability) {
              postcondition_digest = rpc::digest_composition_work_area_set_postcondition(
                  completion.composition_work_area_change_result);
            } else if (completion.capability_id == kCompositionDimensionsSetCapability
                || completion.capability_id == kCompositionDurationSetCapability
                || completion.capability_id == kCompositionFrameRateSetCapability
                || completion.capability_id == kCompositionPixelAspectRatioSetCapability
                || completion.capability_id == kCompositionBackgroundColorSetCapability
                || completion.capability_id == kCompositionDisplayStartTimeSetCapability) {
              postcondition_digest =
                  rpc::digest_composition_settings_set_postcondition(
                      completion.capability_id,
                      completion.composition_settings_change_result);
            } else if (completion.capability_id == kProjectItemNameSetCapability
                || completion.capability_id == kProjectItemCommentSetCapability) {
              postcondition_digest = rpc::digest_project_item_text_set_postcondition(
                  completion.capability_id,
                  completion.project_item_text_change_result);
            } else if (completion.capability_id == kProjectItemLabelSetCapability) {
              postcondition_digest = rpc::digest_project_item_label_set_postcondition(
                  completion.project_item_label_change_result);
            } else if (completion.capability_id == kCompositionDuplicateCapability) {
              postcondition_digest = rpc::digest_composition_duplicate_postcondition(
                  completion.composition_duplicate_result);
            } else if (completion.capability_id == kLayerDetailsReadCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerDetails>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_details_postcondition(
                    std::get<LayerDetails>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerNameSetCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerNameChanged>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_name_set_postcondition(
                    std::get<LayerNameChanged>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerRangeSetCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerRangeChanged>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_range_set_postcondition(
                    std::get<LayerRangeChanged>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerStartTimeSetCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerStartTimeChanged>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_start_time_set_postcondition(
                    std::get<LayerStartTimeChanged>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerStretchSetCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerStretchChanged>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_stretch_set_postcondition(
                    std::get<LayerStretchChanged>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerOrderSetCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerOrderChanged>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_order_set_postcondition(
                    std::get<LayerOrderChanged>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerParentSetCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerParentChanged>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_parent_set_postcondition(
                    std::get<LayerParentChanged>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerDuplicateCapability) {
              if (completion.layer_timeline_result == nullptr
                  || !std::holds_alternative<LayerDuplicated>(
                      *completion.layer_timeline_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_duplicate_postcondition(
                    std::get<LayerDuplicated>(*completion.layer_timeline_result));
              }
            } else if (completion.capability_id == kLayerSourceReadCapability) {
              const auto* value = std::get_if<LayerSourceValue>(
                  &completion.layer_source_matte_av_result);
              if (value == nullptr) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_source_postcondition(
                    rpc_layer_source_value(*value));
              }
            } else if (
                completion.capability_id == kLayerTrackMatteReadCapability) {
              const auto* value = std::get_if<LayerTrackMatteValue>(
                  &completion.layer_source_matte_av_result);
              if (value == nullptr) {
                evidence_valid = false;
              } else {
                postcondition_digest =
                    rpc::digest_layer_track_matte_read_postcondition(
                        rpc_layer_track_matte_value(*value));
              }
            } else if (
                completion.capability_id == kLayerTrackMatteSetCapability) {
              const auto* value = std::get_if<LayerTrackMatteSetValue>(
                  &completion.layer_source_matte_av_result);
              if (value == nullptr) {
                evidence_valid = false;
              } else {
                postcondition_digest =
                    rpc::digest_layer_track_matte_set_postcondition(
                        rpc_layer_track_matte_set_value(*value));
              }
            } else if (
                completion.capability_id == kLayerTrackMatteClearCapability) {
              const auto* value = std::get_if<LayerTrackMatteClearValue>(
                  &completion.layer_source_matte_av_result);
              if (value == nullptr) {
                evidence_valid = false;
              } else {
                postcondition_digest =
                    rpc::digest_layer_track_matte_clear_postcondition(
                        rpc_layer_track_matte_clear_value(*value));
              }
            } else if (completion.capability_id == kLayerAVStateReadCapability) {
              const auto* value = std::get_if<LayerAVStateValue>(
                  &completion.layer_source_matte_av_result);
              if (value == nullptr) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_av_state_postcondition(
                    rpc_layer_av_state_value(*value));
              }
            } else if (
                completion.capability_id == kLayerAudioEnabledSetCapability
                || completion.capability_id
                    == kLayerVideoEnabledSetCapability) {
              const auto* value = std::get_if<LayerAVSwitchSetValue>(
                  &completion.layer_source_matte_av_result);
              if (value == nullptr) {
                evidence_valid = false;
              } else if (
                  completion.capability_id
                  == kLayerAudioEnabledSetCapability) {
                postcondition_digest =
                    rpc::digest_layer_audio_enabled_set_postcondition(
                        rpc_layer_av_switch_set_value(*value));
              } else {
                postcondition_digest =
                    rpc::digest_layer_video_enabled_set_postcondition(
                        rpc_layer_av_switch_set_value(*value));
              }
            } else if (completion.capability_id == kLayerCompositingReadCapability) {
              if (completion.layer_compositing_result == nullptr
                  || !std::holds_alternative<LayerCompositingState>(
                      *completion.layer_compositing_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_compositing_postcondition(
                    std::get<LayerCompositingState>(
                        *completion.layer_compositing_result));
              }
            } else if (completion.capability_id == kLayerSwitchSetCapability) {
              if (completion.layer_compositing_result == nullptr
                  || !std::holds_alternative<LayerSwitchChanged>(
                      *completion.layer_compositing_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_switch_set_postcondition(
                    std::get<LayerSwitchChanged>(
                        *completion.layer_compositing_result));
              }
            } else if (completion.capability_id == kLayerQualitySetCapability) {
              if (completion.layer_compositing_result == nullptr
                  || !std::holds_alternative<LayerQualityChanged>(
                      *completion.layer_compositing_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_quality_set_postcondition(
                    std::get<LayerQualityChanged>(
                        *completion.layer_compositing_result));
              }
            } else if (completion.capability_id == kLayerBlendingModeSetCapability) {
              if (completion.layer_compositing_result == nullptr
                  || !std::holds_alternative<LayerBlendingModeChanged>(
                      *completion.layer_compositing_result)) {
                evidence_valid = false;
              } else {
                postcondition_digest = rpc::digest_layer_blending_mode_set_postcondition(
                    std::get<LayerBlendingModeChanged>(
                        *completion.layer_compositing_result));
              }
            } else if (completion.capability_id == kCompositionCreateCapability) {
              postcondition_digest = rpc::digest_composition_create_postcondition(
                  completion.composition_create_result);
            } else if (completion.capability_id
                == kCompositionLayerCreateCapability) {
              postcondition_digest =
                  rpc::digest_composition_layer_create_postcondition(
                      completion.composition_layer_create_result);
            } else if (completion.capability_id == kLayerEffectApplyCapability) {
              postcondition_digest = rpc::digest_layer_effect_apply_postcondition(
                  completion.layer_effect_apply_result);
            } else if (completion.capability_id == kNativeMediaReadCapability
                || completion.capability_id == kNativeMediaWriteCapability
                || is_text_shape_marker_capability(completion.capability_id)) {
              completion.native_media_result_json =
                  rpc::canonicalize_native_media_value(
                      completion.native_media_result_json);
              postcondition_digest = rpc::digest_native_media_postcondition(
                  completion.capability_id,
                  completion.native_media_result_json);
            } else if (completion.capability_id == kLayerPropertiesListCapability) {
              postcondition_digest = rpc::digest_layer_properties_postcondition(
                  completion.layer_properties_result);
            } else if (completion.capability_id
                == kLayerPropertyKeyframesListCapability) {
              postcondition_digest =
                  rpc::digest_layer_property_keyframes_postcondition(
                      completion.layer_property_keyframes_result);
            } else if (completion.capability_id == kLayerPropertySetCapability) {
              postcondition_digest = rpc::digest_layer_property_set_postcondition(
                  completion.layer_property_change_result);
            } else if (completion.capability_id
                == kLayerPropertyKeyframeDetailsReadCapability) {
              postcondition_digest =
                  rpc::digest_layer_property_keyframe_details_postcondition(
                      completion.layer_property_keyframe_details_result);
            } else if (keyframe_write_capability(completion.capability_id)) {
              postcondition_digest =
                  rpc::digest_layer_property_keyframe_write_postcondition(
                      completion.capability_id,
                      completion.layer_property_keyframe_change_result);
            } else {
              evidence_valid = false;
            }
          } catch (...) {
            evidence_valid = false;
          }
        }
        if (!evidence_valid) {
          completion.ok = false;
          completion.error_code = native_program
              && evidence->second.native_program_contains_write
              ? "POSSIBLY_SIDE_EFFECTING_FAILURE"
              : post_dispatch_evidence_failure_code(
                  completion.capability_id, graph_invalidation);
          completion.message = "native result evidence failed validation";
          if (native_program) {
            NativeProgramHostResult& result =
                completion.native_program_result;
            result.ok = false;
            result.operations.clear();
            result.outputs.clear();
            result.completed_operation_indices.clear();
            result.failed_operation_index.reset();
            result.write_started =
                evidence->second.native_program_contains_write;
            result.undo_available = false;
            result.disposition =
                evidence->second.native_program_contains_write
                ? NativeProgramDisposition::kPossiblySideEffecting
                : NativeProgramDisposition::kCompleted;
            result.error_code = completion.error_code;
            result.message = completion.message;
            native_program_completed.clear();
            native_program_failed.reset();
            postcondition_digest =
                rpc::digest_native_program_postcondition({}, {});
          } else {
            postcondition_digest.clear();
          }
          if (completion.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE") {
            dispatcher_.mark_idempotency_ambiguous(completion.idempotency_key);
          }
          observer_.on_rpc_event(
              "terminal.validation", completion.request_id, "invalid-evidence");
        }
        observer_.on_rpc_terminal(
            completion,
            valid_digest(request_digest) ? request_digest : std::string_view{},
            postcondition_digest,
            started_at,
            completed_at);
        if (completion.route_revoked) {
          active.erase(completion.request_id);
          continue;
        }
        std::vector<std::uint8_t> response;
        if (completion.ok) {
          if (native_program) {
            const NativeProgramHostResult& result =
                completion.native_program_result;
            response = rpc::encode_native_program_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                result.outputs,
                native_program_completed,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                result.undo_available,
                result.undo_available
                    ? std::optional<std::string>{evidence->second.undo_group}
                    : std::nullopt,
                completion.replayed,
            });
          } else if (graph_invalidation) {
            response = rpc::encode_project_graph_invalidate_success({
                completion.request_id,
                connection.session_id,
                completion.project_graph_invalidation_result.invalidated,
                completion.project_graph_invalidation_result.generation,
            });
          } else if (completion.capability_id == kProjectSummaryCapability) {
            response = rpc::encode_project_summary_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.result.project_open,
                completion.result.project_name,
                static_cast<std::uint64_t>(completion.result.item_count),
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id == kProjectBitDepthReadCapability) {
            response = rpc::encode_project_bit_depth_read_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.bit_depth_result.bits_per_channel,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id == kProjectBitDepthSetCapability) {
            response = rpc::encode_project_bit_depth_set_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.bit_depth_change_result.changed,
                completion.bit_depth_change_result.before_bits_per_channel,
                completion.bit_depth_change_result.after_bits_per_channel,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id == kProjectItemsListCapability) {
            response = rpc::encode_project_items_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.project_items_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id == kCompositionLayersListCapability) {
            response = rpc::encode_composition_layers_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.composition_layers_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id
              == kCompositionSelectedLayersListCapability) {
            response = rpc::encode_composition_selected_layers_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.composition_selected_layers_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id == kCompositionTimeReadCapability) {
            response = rpc::encode_composition_time_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.composition_time_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id == kCompositionTimeSetCapability) {
            response = rpc::encode_composition_time_set_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.composition_time_change_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                completion.replayed,
            });
          } else if (completion.capability_id == kProjectContextReadCapability) {
            response = rpc::encode_project_context_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.project_context_result, started_at, completed_at,
                request_digest, postcondition_digest, false});
          } else if (completion.capability_id == kProjectItemMetadataReadCapability) {
            response = rpc::encode_project_item_metadata_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.project_item_metadata_result, started_at, completed_at,
                request_digest, postcondition_digest, false});
          } else if (completion.capability_id == kCompositionSettingsReadCapability) {
            response = rpc::encode_composition_settings_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.composition_settings_result, started_at, completed_at,
                request_digest, postcondition_digest, false});
          } else if (completion.capability_id == kCompositionWorkAreaSetCapability) {
            response = rpc::encode_composition_work_area_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.composition_work_area_change_result, started_at, completed_at,
                request_digest, postcondition_digest, completion.replayed});
          } else if (completion.capability_id == kCompositionDimensionsSetCapability
              || completion.capability_id == kCompositionDurationSetCapability
              || completion.capability_id == kCompositionFrameRateSetCapability
              || completion.capability_id == kCompositionPixelAspectRatioSetCapability
              || completion.capability_id == kCompositionBackgroundColorSetCapability
              || completion.capability_id == kCompositionDisplayStartTimeSetCapability) {
            response = rpc::encode_composition_settings_set_success(
                completion.capability_id,
                {completion.request_id, connection.session_id,
                    runtime_.host_instance_id,
                    completion.composition_settings_change_result,
                    started_at, completed_at, request_digest,
                    postcondition_digest, completion.replayed});
          } else if (completion.capability_id == kProjectItemNameSetCapability) {
            response = rpc::encode_project_item_name_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.project_item_text_change_result, started_at, completed_at,
                request_digest, postcondition_digest, completion.replayed});
          } else if (completion.capability_id == kProjectItemCommentSetCapability) {
            response = rpc::encode_project_item_comment_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.project_item_text_change_result, started_at, completed_at,
                request_digest, postcondition_digest, completion.replayed});
          } else if (completion.capability_id == kProjectItemLabelSetCapability) {
            response = rpc::encode_project_item_label_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.project_item_label_change_result, started_at, completed_at,
                request_digest, postcondition_digest, completion.replayed});
          } else if (completion.capability_id == kCompositionDuplicateCapability) {
            response = rpc::encode_composition_duplicate_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                completion.composition_duplicate_result, started_at, completed_at,
                request_digest, postcondition_digest, completion.replayed});
          } else if (completion.capability_id == kLayerDetailsReadCapability) {
            response = rpc::encode_layer_details_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerDetails>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest, false});
          } else if (completion.capability_id == kLayerNameSetCapability) {
            response = rpc::encode_layer_name_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerNameChanged>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerRangeSetCapability) {
            response = rpc::encode_layer_range_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerRangeChanged>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerStartTimeSetCapability) {
            response = rpc::encode_layer_start_time_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerStartTimeChanged>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerStretchSetCapability) {
            response = rpc::encode_layer_stretch_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerStretchChanged>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerOrderSetCapability) {
            response = rpc::encode_layer_order_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerOrderChanged>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerParentSetCapability) {
            response = rpc::encode_layer_parent_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerParentChanged>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerDuplicateCapability) {
            response = rpc::encode_layer_duplicate_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerDuplicated>(*completion.layer_timeline_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerSourceReadCapability) {
            response = rpc::encode_layer_source_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_source_value(std::get<LayerSourceValue>(
                    completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                false});
          } else if (
              completion.capability_id == kLayerTrackMatteReadCapability) {
            response = rpc::encode_layer_track_matte_read_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_track_matte_value(std::get<LayerTrackMatteValue>(
                    completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                false});
          } else if (
              completion.capability_id == kLayerTrackMatteSetCapability) {
            response = rpc::encode_layer_track_matte_set_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_track_matte_set_value(
                    std::get<LayerTrackMatteSetValue>(
                        completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (
              completion.capability_id == kLayerTrackMatteClearCapability) {
            response = rpc::encode_layer_track_matte_clear_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_track_matte_clear_value(
                    std::get<LayerTrackMatteClearValue>(
                        completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerAVStateReadCapability) {
            response = rpc::encode_layer_av_state_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_av_state_value(std::get<LayerAVStateValue>(
                    completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                false});
          } else if (
              completion.capability_id == kLayerAudioEnabledSetCapability) {
            response = rpc::encode_layer_audio_enabled_set_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_av_switch_set_value(
                    std::get<LayerAVSwitchSetValue>(
                        completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (
              completion.capability_id == kLayerVideoEnabledSetCapability) {
            response = rpc::encode_layer_video_enabled_set_success({
                completion.request_id, connection.session_id,
                runtime_.host_instance_id,
                rpc_layer_av_switch_set_value(
                    std::get<LayerAVSwitchSetValue>(
                        completion.layer_source_matte_av_result)),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerCompositingReadCapability) {
            response = rpc::encode_layer_compositing_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerCompositingState>(*completion.layer_compositing_result),
                started_at, completed_at, request_digest, postcondition_digest, false});
          } else if (completion.capability_id == kLayerSwitchSetCapability) {
            response = rpc::encode_layer_switch_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerSwitchChanged>(*completion.layer_compositing_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerQualitySetCapability) {
            response = rpc::encode_layer_quality_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerQualityChanged>(*completion.layer_compositing_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kLayerBlendingModeSetCapability) {
            response = rpc::encode_layer_blending_mode_set_success({
                completion.request_id, connection.session_id, runtime_.host_instance_id,
                std::get<LayerBlendingModeChanged>(*completion.layer_compositing_result),
                started_at, completed_at, request_digest, postcondition_digest,
                completion.replayed});
          } else if (completion.capability_id == kCompositionCreateCapability) {
            response = rpc::encode_composition_create_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.composition_create_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                completion.replayed,
            });
          } else if (completion.capability_id
              == kCompositionLayerCreateCapability) {
            response = rpc::encode_composition_layer_create_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.composition_layer_create_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                completion.replayed,
            });
          } else if (completion.capability_id == kLayerEffectApplyCapability) {
            response = rpc::encode_layer_effect_apply_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.layer_effect_apply_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                completion.replayed,
            });
          } else if (completion.capability_id == kNativeMediaReadCapability
              || completion.capability_id == kNativeMediaWriteCapability
              || is_text_shape_marker_capability(completion.capability_id)) {
            response = rpc::encode_native_media_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.capability_id,
                completion.native_media_result_json,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                completion.replayed,
            });
          } else if (completion.capability_id == kLayerPropertiesListCapability) {
            response = rpc::encode_layer_properties_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.layer_properties_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id
              == kLayerPropertyKeyframesListCapability) {
            response = rpc::encode_layer_property_keyframes_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.layer_property_keyframes_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (completion.capability_id
              == kLayerPropertyKeyframeDetailsReadCapability) {
            response = rpc::encode_layer_property_keyframe_details_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.layer_property_keyframe_details_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          } else if (keyframe_write_capability(completion.capability_id)) {
            response = rpc::encode_layer_property_keyframe_write_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.capability_id,
                completion.layer_property_keyframe_change_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                completion.replayed,
            });
          } else {
            response = rpc::encode_layer_property_set_success({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                completion.layer_property_change_result,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                false,
            });
          }
        } else {
          if (native_program) {
            const NativeProgramHostResult& result =
                completion.native_program_result;
            response = rpc::encode_native_program_failure({
                completion.request_id,
                connection.session_id,
                runtime_.host_instance_id,
                rpc_error_code(completion.error_code),
                completion.message.empty()
                    ? "native program failed" : completion.message,
                result.disposition,
                native_program_completed,
                native_program_failed,
                result.outputs,
                started_at,
                completed_at,
                request_digest,
                postcondition_digest,
                evidence->second.operation_key,
                result.undo_available
                    ? std::optional<std::string>{evidence->second.undo_group}
                    : std::nullopt,
                result.write_started,
                result.undo_available,
                completion.replayed,
            });
          } else {
            ParsedRequest synthetic;
            synthetic.method = evidence->second.method;
            synthetic.request_id = completion.request_id;
            const std::string capability = graph_invalidation
                ? std::string{} : completion.capability_id;
            response = rpc::encode_error_response(error_for(
                synthetic,
                connection.session_id,
                graph_invalidation && completion.error_code == "CAPABILITY_FAILED"
                    ? "NATIVE_UNAVAILABLE" : completion.error_code,
                completion.message.empty() ? "native request failed" : completion.message,
                capability,
                completion.error_field,
                completion.idempotency_key));
          }
        }
        if (!write_frame(connection.socket_fd, response)) {
          connected = false;
          break;
        }
        (void)front_door.complete_request(completion.request_id);
        active.erase(completion.request_id);
      }
      if (!connected) break;

      pollfd socket{connection.socket_fd, POLLIN, 0};
      const int polled = ::poll(&socket, 1, 20);
      if (polled < 0 && errno == EINTR) continue;
      if (polled < 0 || (polled > 0 && (socket.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0)) {
        break;
      }
      if (polled == 0 || (socket.revents & POLLIN) == 0) continue;
      const ssize_t received = ::recv(connection.socket_fd, input.data(), input.size(), 0);
      if (received == 0) break;
      if (received < 0) {
        if (errno == EINTR) continue;
        break;
      }
      for (ParsedRequest& request : decoder.push(
              std::span<const std::uint8_t>(input.data(), static_cast<std::size_t>(received)))) {
        const rpc::SessionIngressResult ingress = front_door.admit(request);
        if (!ingress.accepted()) {
          const std::string message = ingress.error_code.empty()
              ? "native request admission failed" : "native request was rejected";
          if (!write_frame(connection.socket_fd, rpc::encode_error_response(error_for(
                  request, connection.session_id, ingress.error_code, message)))) {
            connected = false;
            break;
          }
          continue;
        }

        if (request.method == RpcMethod::kHello) {
          const auto& hello = std::get<rpc::HelloParams>(request.params);
          if (!write_frame(connection.socket_fd, rpc::encode_hello_success({
                  request.request_id,
                  connection.session_id,
                  hello.nonce,
                  runtime_.plugin_version,
                  runtime_.compiled_sdk_version,
                  runtime_.compiled_sdk_build,
                  "arm64",
                  runtime_.host_version,
                  runtime_.host_build,
                  "macos-arm64",
                  runtime_.host_instance_id,
                  connection.session_generation,
                  {},
                  std::string(kNativeExecRegistryDigest),
              }))) {
            connected = false;
            break;
          }
          observer_.on_rpc_event("hello", request.request_id, "ok");
          continue;
        }

        if (request.method == RpcMethod::kCapabilities) {
          #if 0  // Legacy capability discovery is superseded by primitive discovery.
          const auto& query = std::get<rpc::CapabilitiesParams>(request.params);
          const bool include_summary = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.project.summary") != query.ids->end();
          const bool include_bit_depth_read = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.project.bit-depth.read")
                  != query.ids->end();
          const bool include_bit_depth_set = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.project.bit-depth.set")
                  != query.ids->end();
          const bool include_project_items = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.project.items.list")
                  != query.ids->end();
          const bool include_composition_layers = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.composition.layers.list")
                  != query.ids->end();
          const bool include_composition_selected_layers = !query.ids.has_value()
              || std::find(
                  query.ids->begin(), query.ids->end(),
                  "ae.composition.selected-layers.list") != query.ids->end();
          const bool include_composition_time = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.composition.time.read")
                  != query.ids->end();
          const bool include_composition_time_set = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.composition.time.set")
                  != query.ids->end();
          const bool include_composition_create = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.composition.create")
                  != query.ids->end();
          const bool include_composition_layer_create = !query.ids.has_value()
              || std::find(
                  query.ids->begin(), query.ids->end(),
                  "ae.composition.layer.create") != query.ids->end();
          const bool include_layer_effect_apply = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.layer.effect.apply")
                  != query.ids->end();
          const bool include_layer_properties = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.layer.properties.list")
                  != query.ids->end();
          const bool include_layer_property_keyframes = !query.ids.has_value()
              || std::find(
                  query.ids->begin(), query.ids->end(),
                  "ae.layer.property.keyframes.list") != query.ids->end();
          const bool include_layer_property_set = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.layer.property.set")
                  != query.ids->end();
          const auto includes = [&](std::string_view id) {
            return !query.ids.has_value()
                || std::find(query.ids->begin(), query.ids->end(), id) != query.ids->end();
          };
          const bool include_project_context = includes("ae.project.context.read");
          const bool include_project_item_metadata =
              includes("ae.project.item.metadata.read");
          const bool include_composition_settings =
              includes("ae.composition.settings.read");
          const bool include_composition_work_area =
              includes("ae.composition.work-area.set");
          const bool include_project_item_name =
              includes("ae.project.item.name.set");
          const bool include_project_item_comment =
              includes("ae.project.item.comment.set");
          const bool include_project_item_label =
              includes("ae.project.item.label.set");
          const bool include_composition_duplicate =
              includes("ae.composition.duplicate");
          const bool include_layer_details = includes("ae.layer.details.read");
          const bool include_layer_name = includes("ae.layer.name.set");
          const bool include_layer_range = includes("ae.layer.range.set");
          const bool include_layer_start_time = includes("ae.layer.start-time.set");
          const bool include_layer_stretch = includes("ae.layer.stretch.set");
          const bool include_layer_order = includes("ae.layer.order.set");
          const bool include_layer_parent = includes("ae.layer.parent.set");
          const bool include_layer_duplicate = includes("ae.layer.duplicate");
          std::array<bool, 7> include_layer_source_matte_av{};
          for (std::size_t index = 0;
               index < include_layer_source_matte_av.size();
               ++index) {
            include_layer_source_matte_av[index] =
                includes(kLayerSourceMatteAvCapabilities[index]);
          }
          const bool include_layer_compositing =
              includes(kLayerCompositingReadCapability);
          const bool include_layer_switch = includes(kLayerSwitchSetCapability);
          const bool include_layer_quality = includes(kLayerQualitySetCapability);
          const bool include_layer_blending_mode =
              includes(kLayerBlendingModeSetCapability);
          const bool include_keyframe_details =
              includes(kLayerPropertyKeyframeDetailsReadCapability);
          const bool include_keyframe_add =
              includes(kLayerPropertyKeyframeAddCapability);
          const bool include_keyframe_value_set =
              includes(kLayerPropertyKeyframeValueSetCapability);
          const bool include_keyframe_interpolation_set =
              includes(kLayerPropertyKeyframeInterpolationSetCapability);
          const bool include_keyframe_temporal_ease_set =
              includes(kLayerPropertyKeyframeTemporalEaseSetCapability);
          const bool include_keyframe_behavior_set =
              includes(kLayerPropertyKeyframeBehaviorSetCapability);
          const bool include_keyframe_delete =
              includes(kLayerPropertyKeyframeDeleteCapability);
          const bool include_native_media_read =
              includes(kNativeMediaReadCapability);
          const bool include_native_media_write =
              includes(kNativeMediaWriteCapability);
          const std::array<bool, 11> include_text_shape_marker{{
              includes(kShapeLayerCreateCapability),
              includes(kShapeGroupsListCapability),
              includes(kShapeGroupCreateCapability),
              includes(kShapePathSetCapability),
              includes(kShapeFillStyleSetCapability),
              includes(kShapeStrokeStyleSetCapability),
              includes(kShapeGroupReorderCapability),
              includes(kMarkerListCapability),
              includes(kMarkerCreateCapability),
              includes(kMarkerSetCapability),
              includes(kMarkerDeleteCapability),
          }};
          const std::array<bool, 6> include_composition_settings_writes{{
              includes(kCompositionDimensionsSetCapability),
              includes(kCompositionDurationSetCapability),
              includes(kCompositionFrameRateSetCapability),
              includes(kCompositionPixelAspectRatioSetCapability),
              includes(kCompositionBackgroundColorSetCapability),
              includes(kCompositionDisplayStartTimeSetCapability),
          }};
          const std::size_t selected = static_cast<std::size_t>(include_summary)
              + static_cast<std::size_t>(include_bit_depth_read)
              + static_cast<std::size_t>(include_bit_depth_set)
              + static_cast<std::size_t>(include_project_items)
              + static_cast<std::size_t>(include_composition_layers)
              + static_cast<std::size_t>(include_composition_selected_layers)
              + static_cast<std::size_t>(include_composition_time)
              + static_cast<std::size_t>(include_composition_time_set)
              + static_cast<std::size_t>(include_composition_create)
              + static_cast<std::size_t>(include_composition_layer_create)
              + static_cast<std::size_t>(include_layer_effect_apply)
              + static_cast<std::size_t>(include_layer_properties)
              + static_cast<std::size_t>(include_layer_property_keyframes)
              + static_cast<std::size_t>(include_layer_property_set)
              + static_cast<std::size_t>(include_project_context)
              + static_cast<std::size_t>(include_project_item_metadata)
              + static_cast<std::size_t>(include_composition_settings)
              + static_cast<std::size_t>(include_composition_work_area)
              + static_cast<std::size_t>(include_project_item_name)
              + static_cast<std::size_t>(include_project_item_comment)
              + static_cast<std::size_t>(include_project_item_label)
              + static_cast<std::size_t>(include_composition_duplicate)
              + static_cast<std::size_t>(include_layer_details)
              + static_cast<std::size_t>(include_layer_name)
              + static_cast<std::size_t>(include_layer_range)
              + static_cast<std::size_t>(include_layer_start_time)
              + static_cast<std::size_t>(include_layer_stretch)
              + static_cast<std::size_t>(include_layer_order)
              + static_cast<std::size_t>(include_layer_parent)
              + static_cast<std::size_t>(include_layer_duplicate)
              + static_cast<std::size_t>(std::count(
                  include_layer_source_matte_av.begin(),
                  include_layer_source_matte_av.end(),
                  true))
              + static_cast<std::size_t>(include_layer_compositing)
              + static_cast<std::size_t>(include_layer_switch)
              + static_cast<std::size_t>(include_layer_quality)
              + static_cast<std::size_t>(include_layer_blending_mode)
              + static_cast<std::size_t>(include_keyframe_details)
              + static_cast<std::size_t>(include_keyframe_add)
              + static_cast<std::size_t>(include_keyframe_value_set)
              + static_cast<std::size_t>(include_keyframe_interpolation_set)
              + static_cast<std::size_t>(include_keyframe_temporal_ease_set)
              + static_cast<std::size_t>(include_keyframe_behavior_set)
              + static_cast<std::size_t>(include_keyframe_delete)
              + static_cast<std::size_t>(include_native_media_read)
              + static_cast<std::size_t>(include_native_media_write)
              + static_cast<std::size_t>(std::count(
                  include_text_shape_marker.begin(),
                  include_text_shape_marker.end(),
                  true))
              + static_cast<std::size_t>(std::count(
                  include_composition_settings_writes.begin(),
                  include_composition_settings_writes.end(),
                  true));
          if (selected > query.limit) {
            if (!write_frame(connection.socket_fd, rpc::encode_error_response(error_for(
                    request,
                    connection.session_id,
                    "INVALID_ARGUMENT",
                    "capability limit is smaller than the selected descriptor set")))) {
              connected = false;
              break;
            }
            (void)front_door.complete_request(request.request_id);
            continue;
          }
          if (!write_frame(connection.socket_fd, rpc::encode_capabilities_success({
                  request.request_id,
                  connection.session_id,
                  query.detail,
                  include_summary,
                  include_bit_depth_read,
                  include_bit_depth_set,
                  include_project_items,
                  include_composition_layers,
                  include_composition_time,
                  include_composition_time_set,
                  include_composition_create,
                  include_composition_layer_create,
                  include_layer_properties,
                  include_layer_property_keyframes,
                  include_layer_property_set,
                  rpc::digest_capabilities_query(connection.session_id, query),
                  runtime_.capabilities_digest,
                  runtime_.project_summary_contract_digest,
                  runtime_.project_bit_depth_read_contract_digest,
                  runtime_.project_bit_depth_set_contract_digest,
                  runtime_.project_items_list_contract_digest,
                  runtime_.composition_layers_list_contract_digest,
                  runtime_.composition_time_read_contract_digest,
                  runtime_.composition_time_set_contract_digest,
                  runtime_.composition_create_contract_digest,
                  runtime_.composition_layer_create_contract_digest,
                  runtime_.layer_properties_list_contract_digest,
                  runtime_.layer_property_keyframes_list_contract_digest,
                  runtime_.layer_property_set_contract_digest,
                  include_composition_selected_layers,
                  runtime_.composition_selected_layers_list_contract_digest,
                  include_layer_effect_apply,
                  runtime_.layer_effect_apply_contract_digest,
                  include_project_context,
                  include_project_item_metadata,
                  include_composition_settings,
                  include_composition_work_area,
                  include_project_item_name,
                  include_project_item_comment,
                  include_project_item_label,
                  include_composition_duplicate,
                  include_layer_details,
                  include_layer_name,
                  include_layer_range,
                  include_layer_start_time,
                  include_layer_stretch,
                  include_layer_order,
                  include_layer_parent,
                  include_layer_duplicate,
                  include_layer_source_matte_av,
                  include_layer_compositing,
                  include_layer_switch,
                  include_layer_quality,
                  include_layer_blending_mode,
                  include_keyframe_details,
                  include_keyframe_add,
                  include_keyframe_value_set,
                  include_keyframe_interpolation_set,
                  include_keyframe_temporal_ease_set,
                  include_keyframe_behavior_set,
                  include_keyframe_delete,
                  runtime_.project_context_read_contract_digest,
                  runtime_.project_item_metadata_read_contract_digest,
                  runtime_.composition_settings_read_contract_digest,
                  runtime_.composition_work_area_set_contract_digest,
                  runtime_.project_item_name_set_contract_digest,
                  runtime_.project_item_comment_set_contract_digest,
                  runtime_.project_item_label_set_contract_digest,
                  runtime_.composition_duplicate_contract_digest,
                  runtime_.layer_details_read_contract_digest,
                  runtime_.layer_name_set_contract_digest,
                  runtime_.layer_range_set_contract_digest,
                  runtime_.layer_start_time_set_contract_digest,
                  runtime_.layer_stretch_set_contract_digest,
                  runtime_.layer_order_set_contract_digest,
                  runtime_.layer_parent_set_contract_digest,
                  runtime_.layer_duplicate_contract_digest,
                  {
                      runtime_.layer_source_read_contract_digest,
                      runtime_.layer_track_matte_read_contract_digest,
                      runtime_.layer_track_matte_set_contract_digest,
                      runtime_.layer_track_matte_clear_contract_digest,
                      runtime_.layer_av_state_read_contract_digest,
                      runtime_.layer_audio_enabled_set_contract_digest,
                      runtime_.layer_video_enabled_set_contract_digest,
                  },
                  runtime_.layer_compositing_read_contract_digest,
                  runtime_.layer_switch_set_contract_digest,
                  runtime_.layer_quality_set_contract_digest,
                  runtime_.layer_blending_mode_set_contract_digest,
                  runtime_.layer_property_keyframe_details_read_contract_digest,
                  runtime_.layer_property_keyframe_add_contract_digest,
                  runtime_.layer_property_keyframe_value_set_contract_digest,
                  runtime_.layer_property_keyframe_interpolation_set_contract_digest,
                  runtime_.layer_property_keyframe_temporal_ease_set_contract_digest,
                  runtime_.layer_property_keyframe_behavior_set_contract_digest,
                  runtime_.layer_property_keyframe_delete_contract_digest,
                  include_native_media_read,
                  include_native_media_write,
                  runtime_.native_media_read_contract_digest,
                  runtime_.native_media_write_contract_digest,
                  include_text_shape_marker,
                  include_composition_settings_writes,
              }))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          observer_.on_rpc_event("capabilities", request.request_id, "ok");
          continue;
          #endif
          const auto& query = std::get<rpc::CapabilitiesParams>(request.params);
          std::vector<std::size_t> selected_indices;
          const auto registry = native_primitive_registry();
          for (std::size_t index = 0; index < registry.size(); ++index) {
            if (!query.ids.has_value()
                || std::find(query.ids->begin(), query.ids->end(), registry[index].id)
                    != query.ids->end()) {
              selected_indices.push_back(index);
            }
          }
          if (selected_indices.size() > query.limit) {
            if (!write_frame(connection.socket_fd, rpc::encode_error_response(error_for(
                    request,
                    connection.session_id,
                    "INVALID_ARGUMENT",
                    "capability limit is smaller than the selected primitive set")))) {
              connected = false;
              break;
            }
            (void)front_door.complete_request(request.request_id);
            continue;
          }
          if (!write_frame(connection.socket_fd, rpc::encode_capabilities_success({
                  request.request_id,
                  connection.session_id,
                  query.detail,
                  std::move(selected_indices),
                  rpc::digest_capabilities_query(connection.session_id, query),
              }))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          observer_.on_rpc_event("capabilities", request.request_id, "ok");
          continue;
        }

        if (request.method == RpcMethod::kCancel) {
          const auto& cancel = std::get<rpc::CancelParams>(request.params);
          const CancelResult result = dispatcher_.cancel(
              connection.peer.connection_id,
              connection.session_generation,
              cancel.target_request_id);
          if (result.code == CancelCode::kInvalidRequest
              || result.code == CancelCode::kStaleRoute) {
            const std::string code = result.code == CancelCode::kStaleRoute
                ? "SESSION_STALE" : "INVALID_ARGUMENT";
            if (!write_frame(connection.socket_fd, rpc::encode_error_response(error_for(
                    request, connection.session_id, code, "cancel request was rejected")))) {
              connected = false;
              break;
            }
          } else if (!write_frame(connection.socket_fd, rpc::encode_cancel_success({
                  request.request_id,
                  connection.session_id,
                  cancel.target_request_id,
                  cancel_state(result.code),
                  result.terminal_response_expected,
              }))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          observer_.on_rpc_event("cancel", request.request_id, "handled");
          continue;
        }

        const std::uint64_t now_unix = session_clock_.now_unix_ms();
        const std::uint64_t effective_deadline = *ingress.effective_deadline_unix_ms;
        const std::uint64_t ttl = effective_deadline > now_unix
            ? effective_deadline - now_unix : 0;
        Request dispatch_request;
        if (request.method == RpcMethod::kInvalidateGraph) {
          dispatch_request = {
              request.request_id,
              std::string(kProjectGraphInvalidateControl),
              dispatcher_clock_.now() + std::chrono::milliseconds(ttl),
              connection.peer.connection_id,
              connection.session_generation,
          };
        } else if (const auto* native_program =
                std::get_if<rpc::NativeProgramParams>(&request.params)) {
          dispatch_request.request_id = request.request_id;
          dispatch_request.capability_id = std::string(kNativeProgramCapability);
          dispatch_request.deadline =
              dispatcher_clock_.now() + std::chrono::milliseconds(ttl);
          dispatch_request.route_id = connection.peer.connection_id;
          dispatch_request.session_generation = connection.session_generation;
          dispatch_request.host_instance_id = runtime_.host_instance_id;
          dispatch_request.session_id = connection.session_id;
          dispatch_request.native_program = native_program->program;
        } else {
          const auto& invoke = std::get<rpc::InvokeParams>(request.params);
          dispatch_request = {
              request.request_id,
              invoke.capability_id,
              dispatcher_clock_.now() + std::chrono::milliseconds(ttl),
              connection.peer.connection_id,
              connection.session_generation,
              invoke.target_depth,
              invoke.idempotency_key,
              invoke.arguments_fingerprint_sha256,
              runtime_.host_instance_id,
              connection.session_id,
              invoke.offset,
              invoke.limit,
              invoke.project_locator,
              invoke.composition_locator,
              invoke.layer_locator,
              invoke.parent_property_locator,
              invoke.property_locator,
              invoke.property_value,
              invoke.target_time,
              invoke.layer_create_kind,
              invoke.layer_create_name,
              invoke.layer_create_color,
              invoke.layer_create_width,
              invoke.layer_create_height,
              invoke.layer_create_duration,
              invoke.composition_create_name,
              invoke.composition_create_width,
              invoke.composition_create_height,
              invoke.composition_create_duration,
              invoke.composition_create_frame_rate,
              invoke.composition_create_pixel_aspect_ratio,
              invoke.layer_effect_match_name,
              invoke.item_locator,
              invoke.work_area_start,
              invoke.work_area_duration,
              invoke.item_text,
              invoke.item_label_id,
              invoke.duplicate_new_name,
              invoke.layer_parent_locator,
              invoke.layer_in_point,
              invoke.layer_duration,
              invoke.layer_start_time,
              invoke.layer_stretch,
              invoke.target_stack_index,
              invoke.layer_new_name,
              invoke.keyframe_time,
              invoke.keyframe_in_interpolation,
              invoke.keyframe_out_interpolation,
              invoke.keyframe_temporal_ease,
              invoke.keyframe_behavior,
              invoke.keyframe_behavior_enabled,
              invoke.layer_switch_name,
              invoke.layer_switch_enabled,
              invoke.layer_quality,
              invoke.layer_blending_mode,
          };
          if (invoke.capability_id == kLayerSourceReadCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerSourceReadRequest{*invoke.layer_locator};
          } else if (
              invoke.capability_id == kLayerTrackMatteReadCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerTrackMatteReadRequest{*invoke.layer_locator};
          } else if (
              invoke.capability_id == kLayerTrackMatteSetCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerTrackMatteSetRequest{
                    *invoke.layer_locator,
                    *invoke.matte_layer_locator,
                    dispatcher_track_matte_mode(invoke.track_matte_mode)};
          } else if (
              invoke.capability_id == kLayerTrackMatteClearCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerTrackMatteClearRequest{*invoke.layer_locator};
          } else if (invoke.capability_id == kLayerAVStateReadCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerAVStateReadRequest{*invoke.layer_locator};
          } else if (
              invoke.capability_id == kLayerAudioEnabledSetCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerAudioEnabledSetRequest{
                    *invoke.layer_locator, *invoke.av_enabled};
          } else if (
              invoke.capability_id == kLayerVideoEnabledSetCapability) {
            dispatch_request.layer_source_matte_av_request =
                LayerVideoEnabledSetRequest{
                    *invoke.layer_locator, *invoke.av_enabled};
          } else if (invoke.capability_id == kNativeMediaReadCapability
              || invoke.capability_id == kNativeMediaWriteCapability
              || is_text_shape_marker_capability(invoke.capability_id)) {
            dispatch_request.native_media = invoke.native_media;
            dispatch_request.native_media.host_instance_id =
                runtime_.host_instance_id;
            dispatch_request.native_media.session_id = connection.session_id;
          }
          if (!std::holds_alternative<std::monostate>(
                  dispatch_request.layer_source_matte_av_request)) {
            dispatch_request.layer_locator.reset();
          }
        }
        const std::string dispatched_capability = dispatch_request.capability_id;
        const EnqueueResult enqueued = dispatcher_.enqueue(std::move(dispatch_request));
        if (enqueued.code != EnqueueCode::kAccepted) {
          const std::string capability = request.method == RpcMethod::kInvoke
              ? dispatched_capability : std::string{};
          if (!write_frame(connection.socket_fd, rpc::encode_error_response(error_for(
                  request,
                  connection.session_id,
                  enqueued.error_code,
                  enqueued.message.empty()
                      ? "native dispatcher rejected the request" : enqueued.message,
                  capability,
                  enqueued.error_field)))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          continue;
        }
        ActiveEvidence active_evidence;
        active_evidence.method = request.method;
        active_evidence.request_digest =
            request.request_fingerprint_sha256;
        active_evidence.started_at_unix_ms = now_unix;
        if (const auto* native_program =
                std::get_if<rpc::NativeProgramParams>(&request.params)) {
          active_evidence.native_program = true;
          active_evidence.native_program_contains_write =
              native_program->admission.contains_write;
          active_evidence.operation_key =
              native_program->program.operation_key;
          active_evidence.undo_group = native_program->program.undo_group;
          active_evidence.native_program_operations.reserve(
              native_program->program.operations.size());
          for (const NativeProgramOperation& operation :
              native_program->program.operations) {
            active_evidence.native_program_operations.push_back(
                operation.primitive_id);
          }
        }
        active.emplace(request.request_id, std::move(active_evidence));
        if (!write_frame(connection.socket_fd, rpc::encode_progress_event({
                request.request_id,
                connection.session_id,
                1,
                rpc::ProgressPhase::kQueued,
                0.0,
                "Queued for the bounded After Effects main-thread dispatcher.",
            }))) {
          connected = false;
          break;
        }
        observer_.on_rpc_event(
            request.method == RpcMethod::kInvalidateGraph ? "invalidateGraph" : "invoke",
            request.request_id,
            "queued");
        observer_.on_rpc_event(
            "dispatch.wake",
            request.request_id,
            idle_signal_.request_idle() ? "scheduled" : "failed");
      }
    }
    front_door.close();
  } catch (...) {
    observer_.on_rpc_event("connection", "none", "codec-or-transport-failure");
  }
  try {
    (void)dispatcher_.revoke_route(
        connection.peer.connection_id,
        connection.session_generation);
  } catch (...) {
    observer_.on_rpc_event("connection", "none", "route-revoke-failure");
  }
}

}  // namespace aemcp::native
