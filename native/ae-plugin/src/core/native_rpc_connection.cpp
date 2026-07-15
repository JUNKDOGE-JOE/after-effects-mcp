#include "aemcp_native/native_rpc_connection.hpp"

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
  std::string request_digest;
  std::uint64_t started_at_unix_ms{0};
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

rpc::ErrorResponse error_for(
    const ParsedRequest& request,
    const std::string& session_id,
    std::string code,
    std::string message,
    std::string capability_id = {},
    std::string field = {}) {
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
  response.code = mapped;
  response.message = std::move(message);
  response.recovery_hint = recovery_hint(mapped);
  if (mapped == RpcErrorCode::kQueueFull) response.retry_after_ms = 50;
  if (mapped == RpcErrorCode::kWireVersionMismatch) {
    response.details = rpc::ErrorDetails{};
    response.details->supported_wire_minimum = 1;
    response.details->supported_wire_maximum = 1;
  }
  if (capability_id.empty() && request.method == RpcMethod::kInvoke) {
    if (const auto* invoke = std::get_if<rpc::InvokeParams>(&request.params)) {
      capability_id = invoke->capability_id;
    }
  }
  if (mapped == RpcErrorCode::kNativeUnsupported
      || mapped == RpcErrorCode::kPreconditionFailed
      || mapped == RpcErrorCode::kStaleLocator
      || mapped == RpcErrorCode::kCapabilityFailed
      || mapped == RpcErrorCode::kPossiblySideEffectingFailure) {
    response.details = rpc::ErrorDetails{};
    response.details->capability_id = capability_id.empty()
        ? std::string(kProjectSummaryCapability) : std::move(capability_id);
  }
  if (!field.empty()) {
    if (!response.details.has_value()) response.details = rpc::ErrorDetails{};
    response.details->field = std::move(field);
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

bool valid_timing_evidence(
    const ActiveEvidence& evidence, std::uint64_t completed_at_unix_ms) {
  return valid_digest(evidence.request_digest)
      && evidence.started_at_unix_ms >= 1
      && evidence.started_at_unix_ms <= rpc::kMaxSafeInteger
      && completed_at_unix_ms >= evidence.started_at_unix_ms
      && completed_at_unix_ms <= rpc::kMaxSafeInteger;
}

}  // namespace

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
  if (runtime_.plugin_version.empty() || runtime_.compiled_sdk_version.empty()
      || runtime_.compiled_sdk_build == 0 || runtime_.host_version.empty()
      || runtime_.host_build == 0 || runtime_.host_instance_id.empty()
      || runtime_.capabilities_digest.size() != 64
      || runtime_.project_summary_contract_digest.size() != 64
      || runtime_.project_bit_depth_read_contract_digest.size() != 64
      || runtime_.project_bit_depth_set_contract_digest.size() != 64
      || runtime_.project_items_list_contract_digest.size() != 64
      || runtime_.composition_layers_list_contract_digest.size() != 64
      || runtime_.composition_selected_layers_list_contract_digest.size() != 64
      || runtime_.composition_time_read_contract_digest.size() != 64
      || runtime_.layer_properties_list_contract_digest.size() != 64) {
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
    if (!front_door.authorize_pairing()) {
      throw std::runtime_error("paired RPC session could not be authorized");
    }
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
        std::string postcondition_digest;
        bool evidence_valid = valid_timing_evidence(evidence->second, completed_at);
        if (completion.ok && evidence_valid) {
          try {
            if (completion.capability_id == kProjectSummaryCapability) {
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
            } else if (completion.capability_id == kLayerPropertiesListCapability) {
              postcondition_digest = rpc::digest_layer_properties_postcondition(
                  completion.layer_properties_result);
            } else {
              evidence_valid = false;
            }
          } catch (...) {
            evidence_valid = false;
          }
        }
        if (!evidence_valid) {
          completion.ok = false;
          const bool mutating = completion.capability_id == kProjectBitDepthSetCapability;
          completion.error_code = mutating
              ? "POSSIBLY_SIDE_EFFECTING_FAILURE" : "CAPABILITY_FAILED";
          completion.message = "native result evidence failed validation";
          postcondition_digest.clear();
          if (mutating) {
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
          if (completion.capability_id == kProjectSummaryCapability) {
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
          } else {
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
          }
        } else {
          ParsedRequest synthetic;
          synthetic.method = RpcMethod::kInvoke;
          synthetic.request_id = completion.request_id;
          response = rpc::encode_error_response(error_for(
              synthetic,
              connection.session_id,
              completion.error_code,
              completion.message.empty() ? "native request failed" : completion.message,
              completion.capability_id,
              completion.error_field));
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
          if (ingress.error_code == "AUTH_REQUIRED") {
            connected = false;
            break;
          }
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
                  runtime_.capabilities_digest,
              }))) {
            connected = false;
            break;
          }
          observer_.on_rpc_event("hello", request.request_id, "ok");
          continue;
        }

        if (request.method == RpcMethod::kCapabilities) {
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
          const bool include_layer_properties = !query.ids.has_value() || std::find(
              query.ids->begin(), query.ids->end(), "ae.layer.properties.list")
                  != query.ids->end();
          const std::size_t selected = static_cast<std::size_t>(include_summary)
              + static_cast<std::size_t>(include_bit_depth_read)
              + static_cast<std::size_t>(include_bit_depth_set)
              + static_cast<std::size_t>(include_project_items)
              + static_cast<std::size_t>(include_composition_layers)
              + static_cast<std::size_t>(include_composition_selected_layers)
              + static_cast<std::size_t>(include_composition_time)
              + static_cast<std::size_t>(include_layer_properties);
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
                  include_layer_properties,
                  rpc::digest_capabilities_query(connection.session_id, query),
                  runtime_.capabilities_digest,
                  runtime_.project_summary_contract_digest,
                  runtime_.project_bit_depth_read_contract_digest,
                  runtime_.project_bit_depth_set_contract_digest,
                  runtime_.project_items_list_contract_digest,
                  runtime_.composition_layers_list_contract_digest,
                  runtime_.composition_time_read_contract_digest,
                  runtime_.layer_properties_list_contract_digest,
                  include_composition_selected_layers,
                  runtime_.composition_selected_layers_list_contract_digest,
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
        const auto& invoke = std::get<rpc::InvokeParams>(request.params);
        const EnqueueResult enqueued = dispatcher_.enqueue({
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
        });
        if (enqueued.code != EnqueueCode::kAccepted) {
          if (!write_frame(connection.socket_fd, rpc::encode_error_response(error_for(
                  request,
                  connection.session_id,
                  enqueued.error_code,
                  enqueued.message.empty()
                      ? "native dispatcher rejected the request" : enqueued.message,
                  invoke.capability_id,
                  enqueued.error_field)))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          continue;
        }
        active.emplace(request.request_id, ActiveEvidence{
            request.request_fingerprint_sha256,
            now_unix,
        });
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
        observer_.on_rpc_event("invoke", request.request_id, "queued");
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
