#pragma once

#include "aemcp_native/host_dispatcher.hpp"

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
inline constexpr std::size_t kMaxFrameBytes = 65'536;
inline constexpr std::size_t kMaxJsonDepth = 16;
inline constexpr std::size_t kMaxJsonNodes = 2'048;
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

enum class RpcMethod { kHello, kCapabilities, kInvoke, kCancel };
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

struct InvokeParams {
  std::string capability_id{"ae.project.summary"};
  std::uint16_t capability_version{1};
  std::int32_t target_depth{0};
  std::string idempotency_key;
  // SHA-256 over the JCS-canonical capability arguments only. This is the
  // mutation fence identity and is deliberately distinct from the complete
  // transport request fingerprint.
  std::string arguments_fingerprint_sha256;
  std::uint64_t offset{0};
  std::uint16_t limit{0};
  std::optional<ObjectLocator> project_locator;
  std::optional<ObjectLocator> composition_locator;
};

struct CancelParams {
  std::string target_request_id;
};

using RequestParams = std::variant<HelloParams, CapabilitiesParams, InvokeParams, CancelParams>;

struct ParsedRequest {
  RpcMethod method{RpcMethod::kHello};
  std::string request_id;
  std::optional<std::string> session_id;
  std::optional<std::uint64_t> deadline_unix_ms;
  RequestParams params{HelloParams{}};

  // SHA-256 over the normalized, closed request envelope. Raw untrusted JSON is
  // deliberately not retained by the public API.
  std::string request_fingerprint_sha256;
};

[[nodiscard]] ParsedRequest decode_request_frame(std::span<const std::uint8_t> frame);
[[nodiscard]] std::string digest_capabilities_query(
    std::string_view session_id,
    const CapabilitiesParams& params);
[[nodiscard]] std::string digest_project_summary_postcondition(
    bool project_open,
    std::string_view project_name,
    std::uint64_t item_count);
[[nodiscard]] std::string digest_project_bit_depth_read_postcondition(
    std::int32_t bits_per_channel);
[[nodiscard]] std::string digest_project_bit_depth_set_arguments(
    std::int32_t target_depth,
    std::string_view idempotency_key);
[[nodiscard]] std::string digest_project_bit_depth_set_postcondition(
    bool changed,
    std::int32_t before_bits_per_channel,
    std::int32_t after_bits_per_channel);
[[nodiscard]] std::string digest_project_items_postcondition(
    const ProjectItemsPage& page);
[[nodiscard]] std::string digest_composition_layers_postcondition(
    const CompositionLayersPage& page);

class FrameDecoder final {
 public:
  // A transport adapter must pass chunks no larger than one maximum frame and
  // its prefix. One push can still yield multiple small frames.
  [[nodiscard]] std::vector<ParsedRequest> push(std::span<const std::uint8_t> chunk);
  void finalize();
  [[nodiscard]] bool failed() const noexcept { return failed_; }
  [[nodiscard]] std::size_t pending_bytes() const noexcept { return pending_.size(); }

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
  kPairingRequired,
  kAuthorizationRequired,
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
    return code == SessionIngressCode::kAcceptedHello
        || code == SessionIngressCode::kAcceptedRequest;
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
  RpcSessionFrontDoor(
      std::string connection_id,
      std::string host_instance_id,
      std::string session_id,
      SessionClock& clock,
      SessionFrontDoorConfig config = {});

  [[nodiscard]] bool authorize_pairing() noexcept;
  void revoke_pairing() noexcept;
  [[nodiscard]] SessionIngressResult admit(const ParsedRequest& request);
  [[nodiscard]] bool complete_request(std::string_view request_id);
  void close() noexcept;

  [[nodiscard]] bool paired() const noexcept { return paired_; }
  [[nodiscard]] bool hello_complete() const noexcept { return hello_complete_; }
  [[nodiscard]] bool closed() const noexcept { return closed_; }
  [[nodiscard]] std::string_view connection_id() const noexcept { return connection_id_; }
  [[nodiscard]] std::string_view host_instance_id() const noexcept { return host_instance_id_; }
  [[nodiscard]] std::string_view session_id() const noexcept { return session_id_; }
  [[nodiscard]] std::size_t active_request_count() const noexcept { return active_.size(); }
  [[nodiscard]] std::size_t tombstone_count() const noexcept { return tombstones_.size(); }

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
  void add_tombstone(
      std::string request_id, std::string fingerprint, std::uint64_t now);

  std::string connection_id_;
  std::string host_instance_id_;
  std::string session_id_;
  SessionClock& clock_;
  SessionFrontDoorConfig config_;
  bool paired_{false};
  bool hello_complete_{false};
  bool closed_{false};
  std::unordered_map<std::string, ActiveEntry> active_;
  std::deque<Tombstone> tombstones_;
};

struct NegotiatedLimits {
  std::uint32_t max_frame_bytes{65'536};
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
  bool include_project_summary{true};
  bool include_project_bit_depth_read{true};
  bool include_project_bit_depth_set{true};
  bool include_project_items_list{true};
  bool include_composition_layers_list{true};
  std::string query_digest;
  std::string capabilities_digest;
  // Required only for detail=full when the descriptor is included.
  std::string project_summary_contract_digest;
  std::string project_bit_depth_read_contract_digest;
  std::string project_bit_depth_set_contract_digest;
  std::string project_items_list_contract_digest;
  std::string composition_layers_list_contract_digest;
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

struct ProjectSummarySuccess {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  bool project_open{false};
  std::string project_name;
  std::uint64_t item_count{0};
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
  bool replayed{false};
};

struct ProjectBitDepthReadSuccess {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  std::int32_t bits_per_channel{0};
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
  bool replayed{false};
};

struct ProjectBitDepthSetSuccess {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  bool changed{true};
  std::int32_t before_bits_per_channel{0};
  std::int32_t after_bits_per_channel{0};
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
  bool replayed{false};
};

struct ProjectItemsSuccess {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  ProjectItemsPage value;
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
  bool replayed{false};
};

struct CompositionLayersSuccess {
  std::string request_id;
  std::string session_id;
  std::string host_instance_id;
  CompositionLayersPage value;
  std::uint64_t started_at_unix_ms{0};
  std::uint64_t completed_at_unix_ms{0};
  std::string request_digest;
  std::string postcondition_digest;
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

struct ErrorDetails {
  std::optional<std::string> field;
  std::optional<std::string> capability_id;
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
  std::optional<std::uint32_t> retry_after_ms;
  std::optional<ErrorDetails> details;
};

[[nodiscard]] std::vector<std::uint8_t> encode_hello_success(const HelloSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_capabilities_success(
    const CapabilitiesSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_progress_event(const ProgressEvent& event);
[[nodiscard]] std::vector<std::uint8_t> encode_project_summary_success(
    const ProjectSummarySuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_project_bit_depth_read_success(
    const ProjectBitDepthReadSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_project_bit_depth_set_success(
    const ProjectBitDepthSetSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_project_items_success(
    const ProjectItemsSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_composition_layers_success(
    const CompositionLayersSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_cancel_success(
    const CancelSuccess& response);
[[nodiscard]] std::vector<std::uint8_t> encode_error_response(const ErrorResponse& response);

}  // namespace aemcp::native::rpc
