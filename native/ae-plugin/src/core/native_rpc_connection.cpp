#include "aemcp_native/native_rpc_connection.hpp"
#include "aemcp_native/native_primitive_registry.generated.hpp"
#include "aemcp_native/transport_io.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace aemcp::native {
namespace {

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
  bool contains_write{false};
  std::string operation_key;
  std::string undo_group;
  std::vector<std::string> operations;
};

bool write_frame(int socket_fd, const std::vector<std::uint8_t> &frame) {
  const auto deadline = std::chrono::steady_clock::now() + kSocketWriteTimeout;
  std::size_t sent = 0;
  while (sent < frame.size()) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline)
      return false;
    const auto remaining =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const int polled = transport_wait_writable(
        socket_fd,
        static_cast<int>(std::clamp<std::int64_t>(remaining.count(), 1, 1000)));
    if (polled < 0 && errno == EINTR)
      continue;
    if (polled <= 0) {
      return false;
    }
    const int count =
        transport_send(socket_fd, frame.data() + sent, frame.size() - sent);
    if (count > 0) {
      sent += static_cast<std::size_t>(count);
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      return false;
    }
  }
  return true;
}

RpcErrorCode rpc_error_code(std::string_view code) {
  if (code == "NATIVE_UNAVAILABLE")
    return RpcErrorCode::kNativeUnavailable;
  if (code == "NATIVE_UNSUPPORTED")
    return RpcErrorCode::kNativeUnsupported;
  if (code == "WIRE_VERSION_MISMATCH") {
    return RpcErrorCode::kWireVersionMismatch;
  }
  if (code == "INVALID_ARGUMENT")
    return RpcErrorCode::kInvalidArgument;
  if (code == "DUPLICATE_REQUEST")
    return RpcErrorCode::kDuplicateRequest;
  if (code == "PRECONDITION_FAILED") {
    return RpcErrorCode::kPreconditionFailed;
  }
  if (code == "STALE_LOCATOR")
    return RpcErrorCode::kStaleLocator;
  if (code == "DEADLINE_EXCEEDED")
    return RpcErrorCode::kDeadlineExceeded;
  if (code == "CANCELLED")
    return RpcErrorCode::kCancelled;
  if (code == "QUEUE_FULL")
    return RpcErrorCode::kQueueFull;
  if (code == "AE_SHUTTING_DOWN")
    return RpcErrorCode::kAeShuttingDown;
  if (code == "SESSION_STALE")
    return RpcErrorCode::kSessionStale;
  if (code == "CAPABILITY_FAILED")
    return RpcErrorCode::kCapabilityFailed;
  if (code == "POSSIBLY_SIDE_EFFECTING_FAILURE") {
    return RpcErrorCode::kPossiblySideEffectingFailure;
  }
  return RpcErrorCode::kInvalidRequest;
}

std::string recovery_hint(RpcErrorCode code) {
  switch (code) {
  case RpcErrorCode::kNativeUnavailable:
    return "Reconnect to the native After Effects host.";
  case RpcErrorCode::kNativeUnsupported:
    return "Refresh capabilities before retrying.";
  case RpcErrorCode::kWireVersionMismatch:
    return "Reconnect with a supported wire version.";
  case RpcErrorCode::kInvalidArgument:
    return "Change the invalid request arguments.";
  case RpcErrorCode::kDuplicateRequest:
    return "Inspect the original request state.";
  case RpcErrorCode::kPreconditionFailed:
    return "Refresh native locators and inspect After Effects state.";
  case RpcErrorCode::kStaleLocator:
    return "Refresh the project graph locator before retrying.";
  case RpcErrorCode::kDeadlineExceeded:
    return "Retry only if the result is still needed.";
  case RpcErrorCode::kCancelled:
    return "Issue a new request only if the result is still needed.";
  case RpcErrorCode::kQueueFull:
    return "Retry after the bounded native queue drains.";
  case RpcErrorCode::kAeShuttingDown:
    return "Reconnect after After Effects restarts.";
  case RpcErrorCode::kSessionStale:
    return "Reconnect and establish a fresh session.";
  case RpcErrorCode::kCapabilityFailed:
    return "Inspect After Effects state before retrying.";
  case RpcErrorCode::kPossiblySideEffectingFailure:
    return "Inspect After Effects state and do not retry this operation key.";
  case RpcErrorCode::kInvalidRequest:
    return "Correct the request before retrying.";
  }
  return "Correct the request before retrying.";
}

rpc::ErrorResponse error_for(const ParsedRequest &request,
                             const std::string &session_id, std::string code,
                             std::string message, std::string field = {},
                             std::string idempotency_key = {}) {
  RpcErrorCode mapped = rpc_error_code(code);
  if (request.method == RpcMethod::kHello &&
      mapped != RpcErrorCode::kNativeUnavailable &&
      mapped != RpcErrorCode::kWireVersionMismatch &&
      mapped != RpcErrorCode::kInvalidRequest &&
      mapped != RpcErrorCode::kInvalidArgument) {
    mapped = RpcErrorCode::kInvalidRequest;
  }
  rpc::ErrorResponse response;
  response.method = request.method;
  response.request_id = request.request_id;
  if (request.method != RpcMethod::kHello)
    response.session_id = session_id;
  response.code = mapped;
  response.message = std::move(message);
  response.recovery_hint = recovery_hint(mapped);
  if (mapped == RpcErrorCode::kQueueFull)
    response.retry_after_ms = 50;
  if (mapped == RpcErrorCode::kWireVersionMismatch) {
    response.details = rpc::ErrorDetails{};
    response.details->supported_wire_minimum = 1;
    response.details->supported_wire_maximum = 1;
  }
  if (request.method == RpcMethod::kInvoke &&
      (mapped == RpcErrorCode::kInvalidArgument ||
       mapped == RpcErrorCode::kNativeUnsupported ||
       mapped == RpcErrorCode::kPreconditionFailed ||
       mapped == RpcErrorCode::kStaleLocator ||
       mapped == RpcErrorCode::kCapabilityFailed ||
       mapped == RpcErrorCode::kPossiblySideEffectingFailure)) {
    if (!response.details.has_value())
      response.details = rpc::ErrorDetails{};
    response.details->capability_id = std::string(kNativeProgramCapability);
  }
  if (!field.empty()) {
    if (!response.details.has_value())
      response.details = rpc::ErrorDetails{};
    response.details->field = std::move(field);
  }
  if (mapped == RpcErrorCode::kPossiblySideEffectingFailure &&
      !idempotency_key.empty()) {
    if (!response.details.has_value())
      response.details = rpc::ErrorDetails{};
    response.details->idempotency_key = std::move(idempotency_key);
  }
  return response;
}

CancelState cancel_state(CancelCode code) {
  switch (code) {
  case CancelCode::kQueuedCancelled:
    return CancelState::kQueuedCancelled;
  case CancelCode::kRunningNotCancellable:
    return CancelState::kRunningNotCancellable;
  case CancelCode::kAlreadyTerminal:
    return CancelState::kAlreadyTerminal;
  case CancelCode::kNotFound:
  case CancelCode::kInvalidRequest:
  case CancelCode::kStaleRoute:
    return CancelState::kNotFound;
  }
  return CancelState::kNotFound;
}

bool valid_digest(std::string_view value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

bool valid_timing_evidence(const ActiveEvidence &evidence,
                           std::uint64_t completed_at_unix_ms) {
  return valid_digest(evidence.request_digest) &&
         evidence.started_at_unix_ms >= 1 &&
         evidence.started_at_unix_ms <= rpc::kMaxSafeInteger &&
         completed_at_unix_ms >= evidence.started_at_unix_ms &&
         completed_at_unix_ms <= rpc::kMaxSafeInteger;
}

bool collect_program_evidence(
    const ActiveEvidence &evidence, const NativeProgramHostResult &result,
    bool completion_ok,
    std::vector<rpc::NativeProgramOperationSummary> &completed,
    std::optional<rpc::NativeProgramOperationSummary> &failed) {
  if (!evidence.native_program ||
      result.operations.size() != result.completed_operation_indices.size()) {
    return false;
  }
  completed.reserve(result.operations.size());
  for (std::size_t index = 0; index < result.operations.size(); ++index) {
    const NativeProgramOperationOutcome &operation = result.operations[index];
    if (operation.index >= evidence.operations.size() ||
        operation.index != result.completed_operation_indices[index] ||
        operation.primitive_id != evidence.operations[operation.index]) {
      return false;
    }
    completed.push_back({operation.index, operation.primitive_id, "completed"});
  }
  if (result.failed_operation_index.has_value()) {
    const std::size_t index = *result.failed_operation_index;
    if (index >= evidence.operations.size())
      return false;
    failed = rpc::NativeProgramOperationSummary{
        index, evidence.operations[index], "failed"};
  }
  if (completion_ok) {
    return result.disposition == NativeProgramDisposition::kCompleted &&
           completed.size() == evidence.operations.size() &&
           !failed.has_value();
  }
  return true;
}

} // namespace

std::string_view
post_dispatch_evidence_failure_code(bool native_program_contains_write,
                                    bool graph_invalidation) noexcept {
  if (native_program_contains_write) {
    return "POSSIBLY_SIDE_EFFECTING_FAILURE";
  }
  return graph_invalidation ? "NATIVE_UNAVAILABLE" : "CAPABILITY_FAILED";
}

NativeRpcConnectionHandler::NativeRpcConnectionHandler(
    HostDispatcher &dispatcher, Clock &dispatcher_clock,
    rpc::SessionClock &session_clock, NativeRpcRuntimeInfo runtime,
    NativeRpcObserver &observer, HostIdleSignal &idle_signal)
    : dispatcher_(dispatcher), dispatcher_clock_(dispatcher_clock),
      session_clock_(session_clock), runtime_(std::move(runtime)),
      observer_(observer), idle_signal_(idle_signal) {
  if (runtime_.plugin_version.empty() ||
      runtime_.compiled_sdk_version.empty() ||
      runtime_.compiled_sdk_build == 0 || runtime_.host_version.empty() ||
      runtime_.host_build == 0 || runtime_.host_instance_id.empty() ||
      native_primitive_registry().size() != kNativePrimitiveCount) {
    throw std::invalid_argument("invalid native RPC runtime identity");
  }
}

void NativeRpcConnectionHandler::serve(
    const AuthenticatedConnection &connection) noexcept {
  try {
    rpc::RpcSessionFrontDoor front_door(connection.peer.connection_id,
                                        runtime_.host_instance_id,
                                        connection.session_id, session_clock_);
    rpc::FrameDecoder decoder;
    std::unordered_map<std::string, ActiveEvidence> active;
    std::array<std::uint8_t, 16384> input{};
    bool connected = true;
    while (connected) {
      for (Completion &completion : dispatcher_.take_outbound()) {
        if (completion.route_id != connection.peer.connection_id ||
            completion.session_generation != connection.session_generation) {
          observer_.on_rpc_event("terminal.detached", completion.request_id,
                                 "route-mismatch");
          continue;
        }
        const auto evidence = active.find(completion.request_id);
        if (evidence == active.end()) {
          observer_.on_rpc_event("terminal.detached", completion.request_id,
                                 "missing-request-evidence");
          continue;
        }

        const bool graph_invalidation =
            completion.capability_id == kProjectGraphInvalidateControl;
        const bool native_program =
            completion.capability_id == kNativeProgramCapability;
        const std::uint64_t completed_at = session_clock_.now_unix_ms();
        const std::uint64_t started_at = evidence->second.started_at_unix_ms;
        const std::string &request_digest = evidence->second.request_digest;
        std::vector<rpc::NativeProgramOperationSummary> completed_operations;
        std::optional<rpc::NativeProgramOperationSummary> failed_operation;
        std::string postcondition_digest;
        bool evidence_valid =
            valid_timing_evidence(evidence->second, completed_at) &&
            (native_program || graph_invalidation);

        if (native_program && evidence_valid) {
          try {
            evidence_valid = collect_program_evidence(
                evidence->second, completion.native_program_result,
                completion.ok, completed_operations, failed_operation);
            if (evidence_valid) {
              postcondition_digest = rpc::digest_native_program_postcondition(
                  completion.native_program_result.outputs,
                  completed_operations);
            }
          } catch (...) {
            evidence_valid = false;
          }
        } else if (graph_invalidation && evidence_valid && completion.ok) {
          const ProjectGraphInvalidation &result =
              completion.project_graph_invalidation_result;
          evidence_valid = result.invalidated
                               ? result.generation >= 1 &&
                                     result.generation <= rpc::kMaxSafeInteger
                               : result.generation == 0;
        }

        if (!evidence_valid) {
          completion.ok = false;
          completion.error_code = post_dispatch_evidence_failure_code(
              native_program && evidence->second.contains_write,
              graph_invalidation);
          completion.message = "native result evidence failed validation";
          if (native_program) {
            NativeProgramHostResult &result = completion.native_program_result;
            result.ok = false;
            result.operations.clear();
            result.outputs.clear();
            result.completed_operation_indices.clear();
            result.failed_operation_index.reset();
            result.write_started = evidence->second.contains_write;
            result.undo_available = false;
            result.disposition =
                evidence->second.contains_write
                    ? NativeProgramDisposition::kPossiblySideEffecting
                    : NativeProgramDisposition::kCompleted;
            result.error_code = completion.error_code;
            result.message = completion.message;
            completed_operations.clear();
            failed_operation.reset();
            postcondition_digest =
                rpc::digest_native_program_postcondition({}, {});
          }
          if (completion.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE" &&
              !completion.idempotency_key.empty()) {
            dispatcher_.mark_idempotency_ambiguous(completion.idempotency_key);
          }
          observer_.on_rpc_event("terminal.validation", completion.request_id,
                                 "invalid-evidence");
        }

        observer_.on_rpc_terminal(
            completion,
            valid_digest(request_digest) ? std::string_view(request_digest)
                                         : std::string_view{},
            postcondition_digest, started_at, completed_at);
        if (completion.route_revoked) {
          active.erase(completion.request_id);
          continue;
        }

        std::vector<std::uint8_t> response;
        if (native_program && completion.ok) {
          const NativeProgramHostResult &result =
              completion.native_program_result;
          response = rpc::encode_native_program_success({
              completion.request_id,
              connection.session_id,
              runtime_.host_instance_id,
              evidence->second.operation_key,
              result.outputs,
              completed_operations,
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
        } else if (native_program) {
          const NativeProgramHostResult &result =
              completion.native_program_result;
          response = rpc::encode_native_program_failure({
              completion.request_id,
              connection.session_id,
              runtime_.host_instance_id,
              rpc_error_code(completion.error_code),
              completion.message.empty() ? "native program failed"
                                         : completion.message,
              result.disposition,
              completed_operations,
              failed_operation,
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
        } else if (graph_invalidation && completion.ok) {
          response = rpc::encode_project_graph_invalidate_success({
              completion.request_id,
              connection.session_id,
              completion.project_graph_invalidation_result.invalidated,
              completion.project_graph_invalidation_result.generation,
          });
        } else {
          ParsedRequest synthetic;
          synthetic.method = evidence->second.method;
          synthetic.request_id = completion.request_id;
          response = rpc::encode_error_response(error_for(
              synthetic, connection.session_id,
              graph_invalidation && completion.error_code == "CAPABILITY_FAILED"
                  ? "NATIVE_UNAVAILABLE"
                  : completion.error_code,
              completion.message.empty() ? "native request failed"
                                         : completion.message,
              completion.error_field, completion.idempotency_key));
        }
        if (!write_frame(connection.socket_fd, response)) {
          connected = false;
          break;
        }
        (void)front_door.complete_request(completion.request_id);
        active.erase(completion.request_id);
      }
      if (!connected)
        break;

      const int polled = transport_wait_readable(connection.socket_fd, 20);
      if (polled < 0 && errno == EINTR)
        continue;
      if (polled < 0) {
        break;
      }
      if (polled == 0)
        continue;
      const int received =
          transport_recv(connection.socket_fd, input.data(), input.size());
      if (received == 0)
        break;
      if (received < 0) {
        if (errno == EINTR)
          continue;
        break;
      }

      for (ParsedRequest &request : decoder.push(std::span<const std::uint8_t>(
               input.data(), static_cast<std::size_t>(received)))) {
        const rpc::SessionIngressResult ingress = front_door.admit(request);
        if (!ingress.accepted()) {
          const std::string message = request.malformed
              ? (request.malformed_error.empty() ? "native request was rejected"
                                                 : request.malformed_error)
              : (ingress.error_code.empty() ? "native request admission failed"
                                            : "native request was rejected");
          if (!write_frame(connection.socket_fd,
                           rpc::encode_error_response(
                               error_for(request, connection.session_id,
                                         ingress.error_code, message)))) {
            connected = false;
            break;
          }
          continue;
        }

        if (request.method == RpcMethod::kHello) {
          const auto &hello = std::get<rpc::HelloParams>(request.params);
          if (!write_frame(connection.socket_fd,
                           rpc::encode_hello_success({
                               request.request_id,
                               connection.session_id,
                               hello.nonce,
                               runtime_.plugin_version,
                               runtime_.compiled_sdk_version,
                               runtime_.compiled_sdk_build,
                               kHostArchId,
                               runtime_.host_version,
                               runtime_.host_build,
                               kHostPlatformId,
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
          const auto &query = std::get<rpc::CapabilitiesParams>(request.params);
          const bool selected =
              !query.ids.has_value() ||
              std::find(query.ids->begin(), query.ids->end(),
                        kNativeProgramCapability) != query.ids->end();
          if (selected && query.limit < 1) {
            if (!write_frame(connection.socket_fd,
                             rpc::encode_error_response(
                                 error_for(request, connection.session_id,
                                           "INVALID_ARGUMENT",
                                           "capability limit is smaller than "
                                           "the selected set")))) {
              connected = false;
              break;
            }
            (void)front_door.complete_request(request.request_id);
            continue;
          }
          std::vector<std::size_t> selected_indices;
          if (selected)
            selected_indices.push_back(0);
          if (!write_frame(connection.socket_fd,
                           rpc::encode_capabilities_success({
                               request.request_id,
                               connection.session_id,
                               query.detail,
                               std::move(selected_indices),
                               rpc::digest_capabilities_query(
                                   connection.session_id, query),
                           }))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          observer_.on_rpc_event("capabilities", request.request_id, "ok");
          continue;
        }

        if (request.method == RpcMethod::kCancel) {
          const auto &cancel = std::get<rpc::CancelParams>(request.params);
          const CancelResult result = dispatcher_.cancel(
              connection.peer.connection_id, connection.session_generation,
              cancel.target_request_id);
          if (result.code == CancelCode::kInvalidRequest ||
              result.code == CancelCode::kStaleRoute) {
            const std::string code = result.code == CancelCode::kStaleRoute
                                         ? "SESSION_STALE"
                                         : "INVALID_ARGUMENT";
            if (!write_frame(connection.socket_fd,
                             rpc::encode_error_response(
                                 error_for(request, connection.session_id, code,
                                           "cancel request was rejected")))) {
              connected = false;
              break;
            }
          } else if (!write_frame(connection.socket_fd,
                                  rpc::encode_cancel_success({
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
        const std::uint64_t effective_deadline =
            *ingress.effective_deadline_unix_ms;
        const std::uint64_t ttl =
            effective_deadline > now_unix ? effective_deadline - now_unix : 0;
        Request dispatch_request;
        if (request.method == RpcMethod::kInvalidateGraph) {
          dispatch_request.request_id = request.request_id;
          dispatch_request.capability_id =
              std::string(kProjectGraphInvalidateControl);
          dispatch_request.deadline =
              dispatcher_clock_.now() + std::chrono::milliseconds(ttl);
          dispatch_request.route_id = connection.peer.connection_id;
          dispatch_request.session_generation = connection.session_generation;
        } else {
          const auto &native =
              std::get<rpc::NativeProgramParams>(request.params);
          dispatch_request.request_id = request.request_id;
          dispatch_request.capability_id =
              std::string(kNativeProgramCapability);
          dispatch_request.deadline =
              dispatcher_clock_.now() + std::chrono::milliseconds(ttl);
          dispatch_request.route_id = connection.peer.connection_id;
          dispatch_request.session_generation = connection.session_generation;
          dispatch_request.host_instance_id = runtime_.host_instance_id;
          dispatch_request.session_id = connection.session_id;
          dispatch_request.native_program = native.program;
        }

        const EnqueueResult enqueued =
            dispatcher_.enqueue(std::move(dispatch_request));
        if (enqueued.code != EnqueueCode::kAccepted) {
          if (!write_frame(
                  connection.socket_fd,
                  rpc::encode_error_response(error_for(
                      request, connection.session_id, enqueued.error_code,
                      enqueued.message.empty()
                          ? "native dispatcher rejected the request"
                          : enqueued.message,
                      enqueued.error_field)))) {
            connected = false;
            break;
          }
          (void)front_door.complete_request(request.request_id);
          continue;
        }

        ActiveEvidence active_evidence;
        active_evidence.method = request.method;
        active_evidence.request_digest = request.request_fingerprint_sha256;
        active_evidence.started_at_unix_ms = now_unix;
        if (const auto *native =
                std::get_if<rpc::NativeProgramParams>(&request.params)) {
          active_evidence.native_program = true;
          active_evidence.contains_write = native->admission.contains_write;
          active_evidence.operation_key = native->program.operation_key;
          active_evidence.undo_group = native->program.undo_group;
          active_evidence.operations.reserve(native->program.operations.size());
          for (const NativeProgramOperation &operation :
               native->program.operations) {
            active_evidence.operations.push_back(operation.primitive_id);
          }
        }
        active.emplace(request.request_id, std::move(active_evidence));
        if (!write_frame(connection.socket_fd,
                         rpc::encode_progress_event({
                             request.request_id,
                             connection.session_id,
                             1,
                             rpc::ProgressPhase::kQueued,
                             0.0,
                             "Queued for the bounded After Effects main-thread "
                             "dispatcher.",
                         }))) {
          connected = false;
          break;
        }
        observer_.on_rpc_event(request.method == RpcMethod::kInvalidateGraph
                                   ? "invalidateGraph"
                                   : "invoke",
                               request.request_id, "queued");
        observer_.on_rpc_event("dispatch.wake", request.request_id,
                               idle_signal_.request_idle() ? "scheduled"
                                                           : "failed");
      }
    }
    front_door.close();
  } catch (...) {
    observer_.on_rpc_event("connection", "none", "codec-or-transport-failure");
  }
  try {
    (void)dispatcher_.revoke_route(connection.peer.connection_id,
                                   connection.session_generation);
  } catch (...) {
    observer_.on_rpc_event("connection", "none", "route-revoke-failure");
  }
}

} // namespace aemcp::native
