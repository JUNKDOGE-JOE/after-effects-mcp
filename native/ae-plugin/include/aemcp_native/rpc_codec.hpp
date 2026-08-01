#pragma once

#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/native_program.hpp"

#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

namespace aemcp::native::rpc {

inline constexpr std::size_t kFramePrefixBytes = 4;
inline constexpr std::size_t kMaxFrameBytes = 524'288;
inline constexpr std::size_t kMaxJsonDepth = 32;
inline constexpr std::size_t kMaxJsonNodes = 32'768;
inline constexpr std::size_t kMaxStringScalars = 8'192;
inline constexpr std::uint64_t kMaxSafeInteger = 9'007'199'254'740'991ULL;

enum class CodecErrorKind {
  kInvalidRequest,
  kInvalidArgument,
  kSessionStale,
};

class CodecError final : public std::runtime_error {
public:
  CodecError(CodecErrorKind kind, std::string message);
  [[nodiscard]] CodecErrorKind kind() const noexcept { return kind_; }
  [[nodiscard]] std::string_view error_code() const noexcept;

private:
  CodecErrorKind kind_;
};

enum class RpcMethod {
  kHello,
  kCapabilities,
  kInvoke,
  kCancel,
  kInvalidateGraph
};
enum class ClientComponent { kCoreBroker, kDevelopmentSmoke };
enum class CapabilityDetail { kSummary, kFull };

struct HelloParams {
  std::uint16_t minimum_wire_version{0};
  std::uint16_t maximum_wire_version{0};
  ClientComponent component{ClientComponent::kCoreBroker};
  std::string client_version;
  std::string client_instance_id;
  std::string nonce;
};

struct CapabilitiesParams {
  std::optional<std::vector<std::string>> ids;
  CapabilityDetail detail{CapabilityDetail::kSummary};
  bool detail_was_provided{false};
  std::uint16_t limit{50};
  bool limit_was_provided{false};
};

struct NativeProgramParams {
  NativeProgram program;
  ProgramAdmission admission;
};

struct CancelParams {
  std::string target_request_id;
};

struct InvalidateGraphParams {
  // Closed v1 reason allowlist. Kept typed so future lifecycle sources cannot
  // silently acquire this authenticated main-thread fence.
  enum class Reason { kCepJsx } reason{Reason::kCepJsx};
};

using RequestParams =
    std::variant<HelloParams, CapabilitiesParams, NativeProgramParams,
                 CancelParams, InvalidateGraphParams>;

struct ParsedRequest {
  RpcMethod method{RpcMethod::kHello};
  std::string request_id;
  std::optional<std::string> session_id;
  std::optional<std::uint64_t> deadline_unix_ms;
  RequestParams params{HelloParams{}};

  // Set when the frame decoded cleanly but semantic classification failed
  // (including native program admission): the session front door rejects the
  // request with a typed error instead of poisoning the connection.
  bool malformed{false};
  std::string malformed_code;
  std::string malformed_error;

  // SHA-256 over the normalized, closed request envelope. Raw untrusted JSON is
  // deliberately not retained by the public API.
  std::string request_fingerprint_sha256;
};

[[nodiscard]] ParsedRequest
decode_request_frame(std::span<const std::uint8_t> frame);
[[nodiscard]] std::string
digest_capabilities_query(std::string_view session_id,
                          const CapabilitiesParams &params);

class FrameDecoder final {
public:
  // A transport adapter must pass chunks no larger than one maximum frame and
  // its prefix. One push can still yield multiple small frames.
  [[nodiscard]] std::vector<ParsedRequest>
  push(std::span<const std::uint8_t> chunk);
  void finalize();
  [[nodiscard]] bool failed() const noexcept { return failed_; }
  [[nodiscard]] std::size_t pending_bytes() const noexcept {
    return pending_.size();
  }

private:
  std::vector<std::uint8_t> pending_;
  bool failed_{false};
};

class SessionClock {
public:
  virtual ~SessionClock() = default;
  [[nodiscard]] virtual std::uint64_t now_unix_ms() const noexcept = 0;
};

class SystemSessionClock final : public SessionClock {
public:
  [[nodiscard]] std::uint64_t now_unix_ms() const noexcept override;
};

struct SessionFrontDoorConfig {
  std::size_t max_active_requests{64};
  std::size_t max_terminal_tombstones{128};
  std::uint64_t tombstone_ttl_ms{60'000};
  std::uint64_t default_deadline_ms{5'000};
  std::uint64_t maximum_deadline_ms{30'000};
};

enum class SessionIngressCode {
  kAcceptedHello,
  kAcceptedRequest,
  kHelloRequired,
  kWireVersionMismatch,
  kInvalidRequest,
  kSessionStale,
  kDuplicateRequest,
  kDeadlineExceeded,
  kInvalidDeadline,
  kLedgerFull,
  kClosed,
};

struct SessionIngressResult {
  SessionIngressCode code{SessionIngressCode::kClosed};
  std::string error_code;
  std::optional<std::uint64_t> effective_deadline_unix_ms;
  bool duplicate_content_matches{false};

  [[nodiscard]] bool accepted() const noexcept {
    return code == SessionIngressCode::kAcceptedHello ||
           code == SessionIngressCode::kAcceptedRequest;
  }
  [[nodiscard]] bool dispatchable() const noexcept {
    return code == SessionIngressCode::kAcceptedRequest;
  }
};

// Transport authentication happens outside this class. The front door binds
// the resulting connection to trusted host/session identifiers and cannot mint
// identifiers or inspect OS identity itself. It is intentionally single-owner:
// every method (including complete_request) must run on one connection worker.
// The AE owner thread publishes dispatcher completions to an outbound queue and
// never calls this object. Concurrent use is unsupported.
class RpcSessionFrontDoor final {
public:
  RpcSessionFrontDoor(std::string connection_id, std::string host_instance_id,
                      std::string session_id, SessionClock &clock,
                      SessionFrontDoorConfig config = {});

  [[nodiscard]] SessionIngressResult admit(const ParsedRequest &request);
  [[nodiscard]] bool complete_request(std::string_view request_id);
  void close() noexcept;

  [[nodiscard]] bool hello_complete() const noexcept { return hello_complete_; }
  [[nodiscard]] bool closed() const noexcept { return closed_; }
  [[nodiscard]] std::string_view connection_id() const noexcept {
    return connection_id_;
  }
  [[nodiscard]] std::string_view host_instance_id() const noexcept {
    return host_instance_id_;
  }
  [[nodiscard]] std::string_view session_id() const noexcept {
    return session_id_;
  }
  [[nodiscard]] std::size_t active_request_count() const noexcept {
    return active_.size();
  }
  [[nodiscard]] std::size_t tombstone_count() const noexcept {
    return tombstones_.size();
  }

private:
  struct ActiveEntry {
    std::string fingerprint;
    std::uint64_t effective_deadline_unix_ms{0};
  };
  struct Tombstone {
    std::string request_id;
    std::string fingerprint;
    std::uint64_t expires_at_unix_ms{0};
  };

  void cleanup(std::uint64_t now);
  void add_tombstone(std::string request_id, std::string fingerprint,
                     std::uint64_t now);

  std::string connection_id_;
  std::string host_instance_id_;
  std::string session_id_;
  SessionClock &clock_;
  SessionFrontDoorConfig config_;
  bool hello_complete_{false};
  bool closed_{false};
  std::unordered_map<std::string, ActiveEntry> active_;
  std::deque<Tombstone> tombstones_;
};

struct NegotiatedLimits {
  std::uint32_t max_frame_bytes{kMaxFrameBytes};
  std::uint16_t max_in_flight{8};
  std::uint16_t max_queue_depth{32};
  std::uint32_t max_deadline_ms{30'000};
  std::uint16_t max_requests_per_second{10};
  std::uint16_t max_burst{4};
  std::uint16_t max_control_in_flight{1};
  std::uint16_t max_control_requests_per_second{20};
  std::uint16_t max_control_burst{4};
  std::uint16_t max_terminal_cache_entries{128};
  std::uint32_t terminal_cache_ttl_ms{60'000};
};

struct HelloSuccess {
  std::string request_id;
  std::string session_id;
  std::string client_nonce;
  std::string plugin_version;
  std::string compiled_sdk_version;
  std::uint64_t compiled_sdk_build{0};
  std::string architecture;
  std::string host_version;
  std::uint64_t host_build{0};
  std::string platform;
  std::string host_instance_id;
  std::uint64_t session_generation{0};
  NegotiatedLimits limits;
  std::string capabilities_digest;
};

struct CapabilitiesSuccess {
  std::string request_id;
  std::string session_id;
  CapabilityDetail detail{CapabilityDetail::kSummary};
  std::vector<std::size_t> selected_primitive_indices;
  std::string query_digest;
};

enum class ProgressPhase { kQueued, kDispatched, kRunning, kValidating };

struct ProgressEvent {
  std::string request_id;
  std::string session_id;
  std::uint64_t sequence{0};
  ProgressPhase phase{ProgressPhase::kQueued};
  double fraction{0.0};
  std::string message;
};

struct NativeProgramOperationSummary {
  std::size_t index{0};
  std::string primitive_id;
  std::string status;
};

struct NativeProgramSuccess {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  std::string operation_key;
  JsonObject outputs;
  std::vector<NativeProgramOperationSummary> operations;
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
  bool undo_available{false};
  std::optional<std::string> undo_group;
  bool replayed{false};
};

enum class CancelState {
  kQueuedCancelled,
  kRunningCancelRequested,
  kRunningNotCancellable,
  kAlreadyTerminal,
  kNotFound,
};

struct CancelSuccess {
  std::string request_id;
  std::string session_id;
  std::string target_request_id;
  CancelState state{CancelState::kNotFound};
  bool terminal_response_expected{false};
};

struct ProjectGraphInvalidateSuccess {
  std::string request_id;
  std::string session_id;
  bool invalidated{false};
  std::uint64_t generation{0};
};

enum class RpcErrorCode {
  kNativeUnavailable,
  kNativeUnsupported,
  kWireVersionMismatch,
  kInvalidRequest,
  kInvalidArgument,
  kDuplicateRequest,
  kPreconditionFailed,
  kStaleLocator,
  kDeadlineExceeded,
  kCancelled,
  kQueueFull,
  kAeShuttingDown,
  kSessionStale,
  kCapabilityFailed,
  kPossiblySideEffectingFailure,
};

struct NativeProgramFailure {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  RpcErrorCode code{RpcErrorCode::kCapabilityFailed};
  std::string message;
  NativeProgramDisposition disposition{NativeProgramDisposition::kNotStarted};
  std::vector<NativeProgramOperationSummary> completed_operations;
  std::optional<NativeProgramOperationSummary> failed_operation;
  JsonObject outputs;
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
  std::string operation_key;
  std::optional<std::string> undo_group;
  bool write_started{false};
  bool undo_available{false};
  bool replayed{false};
};

struct ErrorDetails {
  std::optional<std::string> field;
  std::optional<std::string> capability_id;
  std::optional<std::string> idempotency_key;
  std::optional<std::uint16_t> supported_wire_minimum;
  std::optional<std::uint16_t> supported_wire_maximum;
  std::optional<std::uint64_t> current_generation;
};

struct ErrorResponse {
  RpcMethod method{RpcMethod::kHello};
  std::string request_id;
  std::optional<std::string> session_id;
  RpcErrorCode code{RpcErrorCode::kInvalidRequest};
  std::string message;
  std::string recovery_hint;
  std::optional<std::string> recovery_action;
  std::optional<std::uint32_t> retry_after_ms;
  std::optional<ErrorDetails> details;
};

[[nodiscard]] std::vector<std::uint8_t>
encode_hello_success(const HelloSuccess &response);
[[nodiscard]] std::vector<std::uint8_t>
encode_capabilities_success(const CapabilitiesSuccess &response);
[[nodiscard]] std::vector<std::uint8_t>
encode_progress_event(const ProgressEvent &event);
[[nodiscard]] std::string digest_native_program_postcondition(
    const JsonObject &outputs,
    const std::vector<NativeProgramOperationSummary> &completed_operations);
[[nodiscard]] std::vector<std::uint8_t>
encode_native_program_success(const NativeProgramSuccess &response);
[[nodiscard]] std::vector<std::uint8_t>
encode_native_program_failure(const NativeProgramFailure &response);
[[nodiscard]] std::vector<std::uint8_t>
encode_cancel_success(const CancelSuccess &response);
[[nodiscard]] std::vector<std::uint8_t> encode_project_graph_invalidate_success(
    const ProjectGraphInvalidateSuccess &response);
[[nodiscard]] std::vector<std::uint8_t>
encode_error_response(const ErrorResponse &response);

} // namespace aemcp::native::rpc
