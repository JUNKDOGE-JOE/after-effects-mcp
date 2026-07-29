#include "aemcp_native/rpc_codec.hpp"
#include "aemcp_native/native_primitive_registry.generated.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <utility>

namespace aemcp::native::rpc {
namespace {

using Bytes = std::span<const std::uint8_t>;

[[noreturn]] void invalid_request(std::string message) {
  throw CodecError(CodecErrorKind::kInvalidRequest, std::move(message));
}

[[noreturn]] void invalid_argument(std::string message) {
  throw CodecError(CodecErrorKind::kInvalidArgument, std::move(message));
}

const JsonValue *member(const JsonObject &object, std::string_view name) {
  const auto found =
      std::find_if(object.begin(), object.end(),
                   [&](const auto &entry) { return entry.first == name; });
  return found == object.end() ? nullptr : &found->second;
}

const JsonObject *object_of(const JsonValue &value) {
  return std::get_if<JsonObject>(&value.value);
}

const JsonValue::Array *array_of(const JsonValue &value) {
  return std::get_if<JsonValue::Array>(&value.value);
}

const std::string *string_of(const JsonValue &value) {
  return std::get_if<std::string>(&value.value);
}

const JsonNumber *number_of(const JsonValue &value) {
  return std::get_if<JsonNumber>(&value.value);
}

bool exact_keys(const JsonObject &object,
                std::initializer_list<std::string_view> allowed,
                std::initializer_list<std::string_view> required) {
  for (const auto &entry : object) {
    if (std::find(allowed.begin(), allowed.end(), entry.first) ==
        allowed.end()) {
      return false;
    }
  }
  return std::all_of(
      required.begin(), required.end(),
      [&](std::string_view name) { return member(object, name) != nullptr; });
}

std::string required_string(const JsonObject &object, std::string_view name) {
  const JsonValue *value = member(object, name);
  const std::string *text = value == nullptr ? nullptr : string_of(*value);
  if (text == nullptr || text->empty()) {
    invalid_request("missing or invalid " + std::string(name));
  }
  return *text;
}

std::uint64_t required_integer(const JsonObject &object, std::string_view name,
                               std::uint64_t minimum, std::uint64_t maximum) {
  const JsonValue *value = member(object, name);
  const JsonNumber *number = value == nullptr ? nullptr : number_of(*value);
  if (number == nullptr || !std::isfinite(number->value) ||
      std::trunc(number->value) != number->value ||
      number->value < static_cast<double>(minimum) ||
      number->value > static_cast<double>(maximum)) {
    invalid_request("missing or invalid " + std::string(name));
  }
  return static_cast<std::uint64_t>(number->value);
}

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

bool valid_uuid(std::string_view value) {
  if (value.size() != 36)
    return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-')
        return false;
    } else if (!((value[index] >= '0' && value[index] <= '9') ||
                 (value[index] >= 'a' && value[index] <= 'f'))) {
      return false;
    }
  }
  return value[14] >= '1' && value[14] <= '5' &&
         (value[19] == '8' || value[19] == '9' || value[19] == 'a' ||
          value[19] == 'b');
}

bool valid_digest(std::string_view value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

void require_request_id(std::string_view value) {
  if (!valid_request_id(value))
    invalid_argument("invalid request ID");
}

void require_uuid(std::string_view value, std::string_view field) {
  if (!valid_uuid(value)) {
    invalid_argument("invalid " + std::string(field));
  }
}

void require_digest(std::string_view value, std::string_view field) {
  if (!valid_digest(value)) {
    invalid_argument("invalid " + std::string(field));
  }
}

std::string json_string(std::string_view value) {
  return canonicalize_json(JsonValue{std::string(value)});
}

std::string method_name(RpcMethod method) {
  switch (method) {
  case RpcMethod::kHello:
    return "hello";
  case RpcMethod::kCapabilities:
    return "capabilities";
  case RpcMethod::kInvoke:
    return "invoke";
  case RpcMethod::kCancel:
    return "cancel";
  case RpcMethod::kInvalidateGraph:
    return "invalidateGraph";
  }
  invalid_argument("invalid RPC method");
}

std::uint32_t read_be32(Bytes bytes) {
  if (bytes.size() != 4)
    invalid_request("invalid frame prefix");
  return (static_cast<std::uint32_t>(bytes[0]) << 24U) |
         (static_cast<std::uint32_t>(bytes[1]) << 16U) |
         (static_cast<std::uint32_t>(bytes[2]) << 8U) |
         static_cast<std::uint32_t>(bytes[3]);
}

std::vector<std::uint8_t> frame_output(std::string json) {
  if (json.empty() || json.size() > kMaxFrameBytes) {
    invalid_argument("encoded response exceeds frame limit");
  }
  const std::uint32_t size = static_cast<std::uint32_t>(json.size());
  std::vector<std::uint8_t> result{
      static_cast<std::uint8_t>(size >> 24U),
      static_cast<std::uint8_t>(size >> 16U),
      static_cast<std::uint8_t>(size >> 8U),
      static_cast<std::uint8_t>(size),
  };
  result.insert(result.end(), json.begin(), json.end());
  return result;
}

ParsedRequest classify_request(const JsonValue &root) {
  const JsonObject *envelope = object_of(root);
  if (envelope == nullptr ||
      !exact_keys(*envelope,
                  {"wireVersion", "kind", "sessionId", "requestId", "method",
                   "deadlineUnixMs", "params"},
                  {"wireVersion", "kind", "requestId", "method", "params"})) {
    invalid_request("request envelope is not closed");
  }
  if (required_integer(*envelope, "wireVersion", 1, 1) != 1 ||
      required_string(*envelope, "kind") != "request") {
    invalid_request("unsupported request envelope");
  }

  ParsedRequest result;
  result.request_id = required_string(*envelope, "requestId");
  if (!valid_request_id(result.request_id))
    invalid_request("invalid request ID");
  if (const JsonValue *session = member(*envelope, "sessionId")) {
    const std::string *value = string_of(*session);
    if (value == nullptr || !valid_uuid(*value))
      invalid_request("invalid session ID");
    result.session_id = *value;
  }
  if (member(*envelope, "deadlineUnixMs") != nullptr) {
    result.deadline_unix_ms =
        required_integer(*envelope, "deadlineUnixMs", 1, kMaxSafeInteger);
  }
  const JsonValue *params_value = member(*envelope, "params");
  const JsonObject *params =
      params_value == nullptr ? nullptr : object_of(*params_value);
  if (params == nullptr)
    invalid_request("params must be an object");

  const std::string method = required_string(*envelope, "method");
  if (method == "hello") {
    result.method = RpcMethod::kHello;
    if (result.session_id.has_value() || result.deadline_unix_ms.has_value() ||
        !exact_keys(*params, {"supportedWireVersions", "client", "nonce"},
                    {"supportedWireVersions", "client", "nonce"})) {
      invalid_request("invalid hello params");
    }
    const JsonObject *versions =
        object_of(*member(*params, "supportedWireVersions"));
    const JsonObject *client = object_of(*member(*params, "client"));
    if (versions == nullptr || client == nullptr ||
        !exact_keys(*versions, {"minimum", "maximum"},
                    {"minimum", "maximum"}) ||
        !exact_keys(*client, {"component", "version", "instanceId"},
                    {"component", "version", "instanceId"})) {
      invalid_request("invalid hello params");
    }
    HelloParams hello;
    hello.minimum_wire_version = static_cast<std::uint16_t>(
        required_integer(*versions, "minimum", 1, 65'535));
    hello.maximum_wire_version = static_cast<std::uint16_t>(
        required_integer(*versions, "maximum", 1, 65'535));
    const std::string component = required_string(*client, "component");
    if (component == "core-broker") {
      hello.component = ClientComponent::kCoreBroker;
    } else if (component == "development-smoke") {
      hello.component = ClientComponent::kDevelopmentSmoke;
    } else {
      invalid_request("invalid client component");
    }
    hello.client_version = required_string(*client, "version");
    hello.client_instance_id = required_string(*client, "instanceId");
    hello.nonce = required_string(*params, "nonce");
    if (!valid_uuid(hello.client_instance_id) ||
        hello.client_version.size() > 128 || hello.nonce.size() < 32 ||
        hello.nonce.size() > 128) {
      invalid_request("invalid hello identity");
    }
    result.params = std::move(hello);
  } else if (method == "capabilities") {
    result.method = RpcMethod::kCapabilities;
    if (!exact_keys(*params, {"ids", "detail", "limit"}, {})) {
      invalid_request("invalid capabilities params");
    }
    CapabilitiesParams capabilities;
    if (const JsonValue *detail = member(*params, "detail")) {
      const std::string *value = string_of(*detail);
      if (value == nullptr || (*value != "summary" && *value != "full")) {
        invalid_request("invalid capabilities detail");
      }
      capabilities.detail = *value == "full" ? CapabilityDetail::kFull
                                             : CapabilityDetail::kSummary;
      capabilities.detail_was_provided = true;
    }
    if (member(*params, "limit") != nullptr) {
      capabilities.limit = static_cast<std::uint16_t>(
          required_integer(*params, "limit", 1, 100));
      capabilities.limit_was_provided = true;
    }
    if (const JsonValue *ids_value = member(*params, "ids")) {
      const JsonValue::Array *ids = array_of(*ids_value);
      if (ids == nullptr || ids->empty() || ids->size() > 32) {
        invalid_request("invalid capabilities IDs");
      }
      capabilities.ids = std::vector<std::string>{};
      for (const JsonValue &item : *ids) {
        const std::string *id = string_of(item);
        if (id == nullptr || *id != kNativeProgramCapability ||
            std::find(capabilities.ids->begin(), capabilities.ids->end(),
                      *id) != capabilities.ids->end()) {
          invalid_request("invalid capabilities IDs");
        }
        capabilities.ids->push_back(*id);
      }
    }
    result.params = std::move(capabilities);
  } else if (method == "invoke") {
    result.method = RpcMethod::kInvoke;
    if (!exact_keys(*params, {"capabilityId", "capabilityVersion", "arguments"},
                    {"capabilityId", "capabilityVersion", "arguments"}) ||
        required_string(*params, "capabilityId") != kNativeProgramCapability ||
        required_integer(*params, "capabilityVersion", 1, 1) != 1) {
      invalid_argument("invoke must target ae.native.exec version 1");
    }
    const JsonValue *arguments_value = member(*params, "arguments");
    const JsonObject *arguments =
        arguments_value == nullptr ? nullptr : object_of(*arguments_value);
    if (arguments == nullptr)
      invalid_argument("program arguments must be an object");
    try {
      NativeProgramParams native;
      native.program = parse_native_program(*arguments);
      native.admission =
          validate_native_program(native.program, native_primitive_registry());
      result.params = std::move(native);
    } catch (const std::exception &error) {
      invalid_argument(error.what());
    }
  } else if (method == "cancel") {
    result.method = RpcMethod::kCancel;
    if (!exact_keys(*params, {"targetRequestId"}, {"targetRequestId"})) {
      invalid_request("invalid cancel params");
    }
    CancelParams cancel{required_string(*params, "targetRequestId")};
    if (!valid_request_id(cancel.target_request_id)) {
      invalid_request("invalid cancel target");
    }
    result.params = std::move(cancel);
  } else if (method == "invalidateGraph") {
    result.method = RpcMethod::kInvalidateGraph;
    if (!exact_keys(*params, {"reason"}, {"reason"}) ||
        required_string(*params, "reason") != "cep-jsx") {
      invalid_request("invalid graph invalidation params");
    }
    result.params = InvalidateGraphParams{};
  } else {
    invalid_request("unsupported method");
  }
  result.request_fingerprint_sha256 =
      sha256_hex_digest(canonicalize_json(root));
  return result;
}

std::string progress_phase(ProgressPhase phase) {
  switch (phase) {
  case ProgressPhase::kQueued:
    return "queued";
  case ProgressPhase::kDispatched:
    return "dispatched";
  case ProgressPhase::kRunning:
    return "running";
  case ProgressPhase::kValidating:
    return "validating";
  }
  invalid_argument("invalid progress phase");
}

std::string operation_summaries_json(
    const std::vector<NativeProgramOperationSummary> &operations) {
  std::string result{"["};
  for (std::size_t index = 0; index < operations.size(); ++index) {
    if (index != 0)
      result.push_back(',');
    const auto &operation = operations[index];
    result += "{\"index\":" + std::to_string(operation.index) +
              ",\"op\":" + json_string(operation.primitive_id) +
              ",\"status\":" + json_string(operation.status) + "}";
  }
  return result + "]";
}

std::string disposition_name(NativeProgramDisposition disposition) {
  switch (disposition) {
  case NativeProgramDisposition::kNotStarted:
    return "not-started";
  case NativeProgramDisposition::kCompleted:
    return "completed";
  case NativeProgramDisposition::kPossiblySideEffecting:
    return "possibly-side-effecting";
  }
  invalid_argument("invalid native program disposition");
}

struct ErrorPolicy {
  const char *code;
  bool retryable;
  const char *side_effect;
  const char *recovery;
};

ErrorPolicy error_policy(RpcErrorCode code) {
  switch (code) {
  case RpcErrorCode::kNativeUnavailable:
    return {"NATIVE_UNAVAILABLE", true, "not-started", "reconnect"};
  case RpcErrorCode::kNativeUnsupported:
    return {"NATIVE_UNSUPPORTED", false, "not-started", "refresh-capabilities"};
  case RpcErrorCode::kWireVersionMismatch:
    return {"WIRE_VERSION_MISMATCH", false, "not-started", "reconnect"};
  case RpcErrorCode::kInvalidRequest:
    return {"INVALID_REQUEST", false, "not-started", "none"};
  case RpcErrorCode::kInvalidArgument:
    return {"INVALID_ARGUMENT", false, "not-started", "change-arguments"};
  case RpcErrorCode::kDuplicateRequest:
    return {"DUPLICATE_REQUEST", false, "not-started", "inspect-state"};
  case RpcErrorCode::kPreconditionFailed:
    return {"PRECONDITION_FAILED", false, "not-started", "open-project"};
  case RpcErrorCode::kStaleLocator:
    return {"STALE_LOCATOR", true, "not-started", "refresh-locator"};
  case RpcErrorCode::kDeadlineExceeded:
    return {"DEADLINE_EXCEEDED", true, "not-started", "retry"};
  case RpcErrorCode::kCancelled:
    return {"CANCELLED", false, "not-started", "none"};
  case RpcErrorCode::kQueueFull:
    return {"QUEUE_FULL", true, "not-started", "retry"};
  case RpcErrorCode::kAeShuttingDown:
    return {"AE_SHUTTING_DOWN", true, "not-started", "reconnect"};
  case RpcErrorCode::kSessionStale:
    return {"SESSION_STALE", true, "not-started", "reconnect"};
  case RpcErrorCode::kCapabilityFailed:
    return {"CAPABILITY_FAILED", false, "not-started", "inspect-state"};
  case RpcErrorCode::kPossiblySideEffectingFailure:
    return {"POSSIBLY_SIDE_EFFECTING_FAILURE", false, "may-have-occurred",
            "inspect-state"};
  }
  return {"INVALID_REQUEST", false, "not-started", "none"};
}

} // namespace

CodecError::CodecError(CodecErrorKind kind, std::string message)
    : std::runtime_error(std::move(message)), kind_(kind) {}

std::string_view CodecError::error_code() const noexcept {
  switch (kind_) {
  case CodecErrorKind::kInvalidRequest:
    return "INVALID_REQUEST";
  case CodecErrorKind::kInvalidArgument:
    return "INVALID_ARGUMENT";
  case CodecErrorKind::kSessionStale:
    return "SESSION_STALE";
  }
  return "INVALID_REQUEST";
}

ParsedRequest decode_request_frame(std::span<const std::uint8_t> frame) {
  if (frame.size() < kFramePrefixBytes)
    invalid_request("incomplete frame prefix");
  const std::uint32_t size = read_be32(frame.first<4>());
  if (size == 0 || size > kMaxFrameBytes)
    invalid_request("frame size rejected");
  if (frame.size() != static_cast<std::size_t>(size) + kFramePrefixBytes) {
    invalid_request("incomplete or trailing frame bytes");
  }
  try {
    const char *body =
        reinterpret_cast<const char *>(frame.data() + kFramePrefixBytes);
    return classify_request(parse_json(std::string_view(body, size)));
  } catch (const CodecError &) {
    throw;
  } catch (const std::exception &error) {
    invalid_request(error.what());
  }
}

std::string digest_capabilities_query(std::string_view session_id,
                                      const CapabilitiesParams &params) {
  if (!valid_uuid(session_id) || params.limit < 1 || params.limit > 100) {
    invalid_argument("invalid capabilities query");
  }
  std::string ids{"null"};
  if (params.ids.has_value()) {
    if (params.ids->size() != 1 ||
        params.ids->front() != kNativeProgramCapability) {
      invalid_argument("invalid capabilities query IDs");
    }
    ids = "[\"ae.native.exec\"]";
  }
  const std::string canonical =
      "{\"detail\":" +
      json_string(params.detail == CapabilityDetail::kFull ? "full"
                                                           : "summary") +
      ",\"ids\":" + ids + ",\"limit\":" + std::to_string(params.limit) +
      ",\"sessionId\":" + json_string(session_id) + "}";
  return sha256_hex_digest(canonical);
}

std::vector<ParsedRequest>
FrameDecoder::push(std::span<const std::uint8_t> chunk) {
  if (failed_)
    invalid_request("frame decoder is poisoned");
  if (chunk.size() > kMaxFrameBytes + kFramePrefixBytes) {
    failed_ = true;
    invalid_request("transport chunk exceeds decoder bound");
  }
  try {
    pending_.insert(pending_.end(), chunk.begin(), chunk.end());
    std::vector<ParsedRequest> result;
    while (pending_.size() >= kFramePrefixBytes) {
      const std::uint32_t size = read_be32(Bytes(pending_.data(), 4));
      if (size == 0 || size > kMaxFrameBytes)
        invalid_request("frame size rejected");
      const std::size_t total = size + kFramePrefixBytes;
      if (pending_.size() < total)
        break;
      result.push_back(decode_request_frame(Bytes(pending_.data(), total)));
      pending_.erase(pending_.begin(),
                     pending_.begin() + static_cast<std::ptrdiff_t>(total));
    }
    return result;
  } catch (...) {
    failed_ = true;
    pending_.clear();
    throw;
  }
}

void FrameDecoder::finalize() {
  if (failed_)
    invalid_request("frame decoder is poisoned");
  if (!pending_.empty()) {
    failed_ = true;
    pending_.clear();
    invalid_request("incomplete frame at end of stream");
  }
}

std::uint64_t SystemSessionClock::now_unix_ms() const noexcept {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
}

RpcSessionFrontDoor::RpcSessionFrontDoor(std::string connection_id,
                                         std::string host_instance_id,
                                         std::string session_id,
                                         SessionClock &clock,
                                         SessionFrontDoorConfig config)
    : connection_id_(std::move(connection_id)),
      host_instance_id_(std::move(host_instance_id)),
      session_id_(std::move(session_id)), clock_(clock), config_(config) {
  if (connection_id_.empty() || connection_id_.size() > 1'024 ||
      !valid_uuid(host_instance_id_) || !valid_uuid(session_id_) ||
      config_.max_active_requests == 0 || config_.max_active_requests > 64 ||
      config_.max_terminal_tombstones == 0 ||
      config_.max_terminal_tombstones > 4'096 ||
      config_.tombstone_ttl_ms < 1'000 || config_.tombstone_ttl_ms > 300'000 ||
      config_.default_deadline_ms == 0 || config_.maximum_deadline_ms < 100 ||
      config_.maximum_deadline_ms > 30'000 ||
      config_.default_deadline_ms > config_.maximum_deadline_ms) {
    throw std::invalid_argument("invalid RPC session front-door configuration");
  }
}

SessionIngressResult RpcSessionFrontDoor::admit(const ParsedRequest &request) {
  if (closed_) {
    return {SessionIngressCode::kClosed, "SESSION_STALE", std::nullopt, false};
  }
  if (!valid_request_id(request.request_id) ||
      !valid_digest(request.request_fingerprint_sha256)) {
    return {SessionIngressCode::kInvalidRequest, "INVALID_REQUEST",
            std::nullopt, false};
  }
  const bool params_match =
      (request.method == RpcMethod::kHello &&
       std::holds_alternative<HelloParams>(request.params)) ||
      (request.method == RpcMethod::kCapabilities &&
       std::holds_alternative<CapabilitiesParams>(request.params)) ||
      (request.method == RpcMethod::kInvoke &&
       std::holds_alternative<NativeProgramParams>(request.params)) ||
      (request.method == RpcMethod::kCancel &&
       std::holds_alternative<CancelParams>(request.params)) ||
      (request.method == RpcMethod::kInvalidateGraph &&
       std::holds_alternative<InvalidateGraphParams>(request.params));
  if (!params_match) {
    return {SessionIngressCode::kInvalidRequest, "INVALID_REQUEST",
            std::nullopt, false};
  }
  if (request.method == RpcMethod::kHello) {
    const auto *hello = std::get_if<HelloParams>(&request.params);
    if (hello == nullptr || request.session_id.has_value()) {
      return {SessionIngressCode::kInvalidRequest, "INVALID_REQUEST",
              std::nullopt, false};
    }
    if (hello_complete_) {
      return {SessionIngressCode::kSessionStale, "SESSION_STALE", std::nullopt,
              false};
    }
    if (hello->minimum_wire_version > 1 || hello->maximum_wire_version < 1) {
      return {SessionIngressCode::kWireVersionMismatch, "WIRE_VERSION_MISMATCH",
              std::nullopt, false};
    }
    hello_complete_ = true;
    return {SessionIngressCode::kAcceptedHello, {}, std::nullopt, false};
  }
  if (!hello_complete_) {
    return {SessionIngressCode::kHelloRequired, "SESSION_STALE", std::nullopt,
            false};
  }
  if (!request.session_id.has_value() || *request.session_id != session_id_) {
    return {SessionIngressCode::kSessionStale, "SESSION_STALE", std::nullopt,
            false};
  }
  const std::uint64_t now = clock_.now_unix_ms();
  cleanup(now);
  const std::uint64_t deadline = request.deadline_unix_ms.value_or(
      now <= kMaxSafeInteger - config_.default_deadline_ms
          ? now + config_.default_deadline_ms
          : 0);
  if (deadline <= now) {
    return {SessionIngressCode::kDeadlineExceeded, "DEADLINE_EXCEEDED",
            std::nullopt, false};
  }
  if (now > kMaxSafeInteger - config_.maximum_deadline_ms ||
      deadline > now + config_.maximum_deadline_ms) {
    return {SessionIngressCode::kInvalidDeadline, "INVALID_ARGUMENT",
            std::nullopt, false};
  }
  if (const auto found = active_.find(request.request_id);
      found != active_.end()) {
    return {SessionIngressCode::kDuplicateRequest, "DUPLICATE_REQUEST",
            std::nullopt,
            found->second.fingerprint == request.request_fingerprint_sha256};
  }
  const auto terminal = std::find_if(
      tombstones_.begin(), tombstones_.end(), [&](const Tombstone &item) {
        return item.request_id == request.request_id;
      });
  if (terminal != tombstones_.end()) {
    return {SessionIngressCode::kDuplicateRequest, "DUPLICATE_REQUEST",
            std::nullopt,
            terminal->fingerprint == request.request_fingerprint_sha256};
  }
  if (active_.size() >= config_.max_active_requests) {
    return {SessionIngressCode::kLedgerFull, "QUEUE_FULL", std::nullopt, false};
  }
  active_.emplace(request.request_id,
                  ActiveEntry{request.request_fingerprint_sha256, deadline});
  return {SessionIngressCode::kAcceptedRequest, {}, deadline, false};
}

bool RpcSessionFrontDoor::complete_request(std::string_view request_id) {
  const auto found = active_.find(std::string(request_id));
  if (found == active_.end())
    return false;
  std::string id = found->first;
  std::string fingerprint = found->second.fingerprint;
  active_.erase(found);
  add_tombstone(std::move(id), std::move(fingerprint), clock_.now_unix_ms());
  return true;
}

void RpcSessionFrontDoor::close() noexcept {
  closed_ = true;
  hello_complete_ = false;
  active_.clear();
  tombstones_.clear();
}

void RpcSessionFrontDoor::cleanup(std::uint64_t now) {
  while (!tombstones_.empty() &&
         tombstones_.front().expires_at_unix_ms <= now) {
    tombstones_.pop_front();
  }
  std::vector<std::pair<std::string, std::string>> expired;
  for (const auto &[id, entry] : active_) {
    if (entry.effective_deadline_unix_ms <= now) {
      expired.emplace_back(id, entry.fingerprint);
    }
  }
  for (auto &[id, fingerprint] : expired) {
    active_.erase(id);
    add_tombstone(std::move(id), std::move(fingerprint), now);
  }
}

void RpcSessionFrontDoor::add_tombstone(std::string request_id,
                                        std::string fingerprint,
                                        std::uint64_t now) {
  while (tombstones_.size() >= config_.max_terminal_tombstones) {
    tombstones_.pop_front();
  }
  const std::uint64_t expiry = now > kMaxSafeInteger - config_.tombstone_ttl_ms
                                   ? kMaxSafeInteger
                                   : now + config_.tombstone_ttl_ms;
  tombstones_.push_back(
      {std::move(request_id), std::move(fingerprint), expiry});
}

std::vector<std::uint8_t> encode_hello_success(const HelloSuccess &response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.capabilities_digest, "capabilities digest");
  std::string json =
      "{\"kind\":\"response\",\"method\":\"hello\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" +
      json_string(response.request_id) +
      ",\"result\":{\"capabilitiesDigest\":" +
      json_string(response.capabilities_digest) +
      ",\"clientNonce\":" + json_string(response.client_nonce) +
      ",\"compiledSdk\":{\"architecture\":" +
      json_string(response.architecture) +
      ",\"build\":" + std::to_string(response.compiled_sdk_build) +
      ",\"version\":" + json_string(response.compiled_sdk_version) +
      "},\"host\":{\"application\":\"after-effects\",\"build\":" +
      std::to_string(response.host_build) +
      ",\"instanceId\":" + json_string(response.host_instance_id) +
      ",\"platform\":" + json_string(response.platform) +
      ",\"version\":" + json_string(response.host_version) +
      "},\"limits\":{\"maxBurst\":" +
      std::to_string(response.limits.max_burst) + ",\"maxControlBurst\":" +
      std::to_string(response.limits.max_control_burst) +
      ",\"maxControlInFlight\":" +
      std::to_string(response.limits.max_control_in_flight) +
      ",\"maxControlRequestsPerSecond\":" +
      std::to_string(response.limits.max_control_requests_per_second) +
      ",\"maxDeadlineMs\":" + std::to_string(response.limits.max_deadline_ms) +
      ",\"maxFrameBytes\":" + std::to_string(response.limits.max_frame_bytes) +
      ",\"maxInFlight\":" + std::to_string(response.limits.max_in_flight) +
      ",\"maxQueueDepth\":" + std::to_string(response.limits.max_queue_depth) +
      ",\"maxRequestsPerSecond\":" +
      std::to_string(response.limits.max_requests_per_second) +
      ",\"maxTerminalCacheEntries\":" +
      std::to_string(response.limits.max_terminal_cache_entries) +
      ",\"terminalCacheTtlMs\":" +
      std::to_string(response.limits.terminal_cache_ttl_ms) +
      "},\"pluginVersion\":" + json_string(response.plugin_version) +
      ",\"selectedWireVersion\":1,\"sessionGeneration\":" +
      std::to_string(response.session_generation) +
      ",\"sessionId\":" + json_string(response.session_id) +
      "},\"sessionId\":" + json_string(response.session_id) +
      ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t>
encode_capabilities_success(const CapabilitiesSuccess &response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_digest(response.query_digest, "query digest");
  if (response.selected_primitive_indices.size() > 1 ||
      (!response.selected_primitive_indices.empty() &&
       response.selected_primitive_indices.front() != 0)) {
    invalid_argument("capabilities selection is not the sole native route");
  }
  const std::string_view detail =
      response.detail == CapabilityDetail::kFull ? "full" : "summary";
  const std::string_view descriptor = response.detail == CapabilityDetail::kFull
                                          ? kNativeExecFullJson
                                          : kNativeExecSummaryJson;
  const std::string items = response.selected_primitive_indices.empty()
                                ? "[]"
                                : "[" + std::string(descriptor) + "]";
  std::string json =
      "{\"kind\":\"response\",\"method\":\"capabilities\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" +
      json_string(response.request_id) +
      ",\"result\":{\"capabilitiesDigest\":" +
      json_string(kNativeExecRegistryDigest) +
      ",\"detail\":" + json_string(detail) + ",\"items\":" + items +
      ",\"nextCursor\":null,\"queryDigest\":" +
      json_string(response.query_digest) +
      "},\"sessionId\":" + json_string(response.session_id) +
      ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_progress_event(const ProgressEvent &event) {
  require_request_id(event.request_id);
  require_uuid(event.session_id, "session ID");
  if (!std::isfinite(event.fraction) || event.fraction < 0.0 ||
      event.fraction > 1.0) {
    invalid_argument("invalid progress fraction");
  }
  std::string json =
      "{\"event\":\"progress\",\"kind\":\"event\",\"progress\":{\"fraction\":" +
      canonicalize_json(JsonValue{JsonNumber{event.fraction}}) +
      ",\"message\":" + json_string(event.message) +
      ",\"phase\":" + json_string(progress_phase(event.phase)) +
      "},\"requestId\":" + json_string(event.request_id) +
      ",\"sequence\":" + std::to_string(event.sequence) +
      ",\"sessionId\":" + json_string(event.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::string digest_native_program_postcondition(
    const JsonObject &outputs,
    const std::vector<NativeProgramOperationSummary> &completed_operations) {
  const std::string canonical =
      "{\"operations\":" + operation_summaries_json(completed_operations) +
      ",\"outputs\":" + canonicalize_json(JsonValue{outputs}) + "}";
  return sha256_hex_digest(canonical);
}

std::vector<std::uint8_t>
encode_native_program_success(const NativeProgramSuccess &response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  if (response.operations.empty() ||
      response.completed_at_unix_ms < response.started_at_unix_ms ||
      response.postcondition_digest !=
          digest_native_program_postcondition(response.outputs,
                                              response.operations)) {
    invalid_argument("invalid native program success evidence");
  }
  const bool write = response.undo_group.has_value();
  if (write != !response.operation_key.empty() ||
      response.undo_available != write) {
    invalid_argument("invalid native program success write envelope");
  }
  const std::string undo = write ? "{\"available\":true,\"groupLabel\":" +
                                       json_string(*response.undo_group) +
                                       ",\"verified\":false}"
                                 : "{\"available\":false,\"verified\":false}";
  std::string result =
      "{\"capabilityId\":\"ae.native.exec\",\"evidence\":{"
      "\"capabilityId\":\"ae.native.exec\",\"capabilityVersion\":1,"
      "\"completedAtUnixMs\":" +
      std::to_string(response.completed_at_unix_ms) +
      ",\"effect\":" + json_string(write ? "committed" : "none") +
      ",\"engine\":\"native-aegp\",\"hostInstanceId\":" +
      json_string(response.host_instance_id) +
      ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\","
      "\"digest\":" +
      json_string(response.postcondition_digest) +
      ",\"kind\":\"native-program\",\"verified\":true},"
      "\"requestDigest\":" +
      json_string(response.request_digest) +
      ",\"requestId\":" + json_string(response.request_id) +
      ",\"sessionId\":" + json_string(response.session_id) +
      ",\"startedAtUnixMs\":" + std::to_string(response.started_at_unix_ms) +
      "},\"operations\":" + operation_summaries_json(response.operations);
  if (write) {
    result += ",\"operationKey\":" + json_string(response.operation_key);
  }
  result += ",\"outputs\":" + canonicalize_json(JsonValue{response.outputs}) +
            ",\"undo\":" + undo + "}";
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
                     "\"replayed\":" +
                     std::string(response.replayed ? "true" : "false") +
                     ",\"requestId\":" + json_string(response.request_id) +
                     ",\"result\":" + result +
                     ",\"sessionId\":" + json_string(response.session_id) +
                     ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t>
encode_native_program_failure(const NativeProgramFailure &response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const ErrorPolicy policy = error_policy(response.code);
  const bool write = !response.operation_key.empty();
  if (response.undo_available != response.undo_group.has_value() ||
      (!write && (response.undo_available || response.write_started))) {
    invalid_argument("invalid native program failure write envelope");
  }
  const char *side_effect = "not-started";
  if (response.disposition == NativeProgramDisposition::kCompleted) {
    side_effect = "completed";
  } else if (response.disposition ==
             NativeProgramDisposition::kPossiblySideEffecting) {
    side_effect = "may-have-occurred";
  }
  std::string details =
      "{\"capabilityId\":\"ae.native.exec\","
      "\"completedOperations\":" +
      operation_summaries_json(response.completed_operations) +
      ",\"disposition\":" +
      json_string(disposition_name(response.disposition)) +
      ",\"evidence\":{\"capabilityId\":\"ae.native.exec\","
      "\"capabilityVersion\":1,\"completedAtUnixMs\":" +
      std::to_string(response.completed_at_unix_ms) + ",\"effect\":" +
      json_string(response.disposition ==
                          NativeProgramDisposition::kPossiblySideEffecting
                      ? "may-have-occurred"
                      : "none") +
      ",\"engine\":\"native-aegp\",\"hostInstanceId\":" +
      json_string(response.host_instance_id) +
      ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\","
      "\"digest\":" +
      json_string(response.postcondition_digest) +
      ",\"kind\":\"native-program\",\"verified\":false},"
      "\"requestDigest\":" +
      json_string(response.request_digest) +
      ",\"requestId\":" + json_string(response.request_id) +
      ",\"sessionId\":" + json_string(response.session_id) +
      ",\"startedAtUnixMs\":" + std::to_string(response.started_at_unix_ms) +
      "},\"outputs\":" + canonicalize_json(JsonValue{response.outputs});
  if (response.failed_operation.has_value()) {
    const std::vector<NativeProgramOperationSummary> failed{
        *response.failed_operation};
    const std::string encoded = operation_summaries_json(failed);
    details += ",\"failedOperation\":" + encoded.substr(1, encoded.size() - 2);
  }
  if (write) {
    details += ",\"operationKey\":" + json_string(response.operation_key);
  }
  details += ",\"undo\":{\"available\":" +
             std::string(response.undo_available ? "true" : "false");
  if (response.undo_group.has_value()) {
    details += ",\"groupLabel\":" + json_string(*response.undo_group);
  }
  details += ",\"verified\":false}}";
  std::string json =
      "{\"error\":{\"code\":" + json_string(policy.code) +
      ",\"details\":" + details +
      ",\"message\":" + json_string(response.message) +
      ",\"recovery\":{\"action\":" + json_string(policy.recovery) +
      ",\"hint\":\"Inspect After Effects state before retrying.\"},"
      "\"retryable\":" +
      (policy.retryable ? "true" : "false") +
      ",\"sideEffect\":" + json_string(side_effect) +
      "},\"kind\":\"response\",\"method\":\"invoke\",\"ok\":false,"
      "\"replayed\":" +
      (response.replayed ? "true" : "false") +
      ",\"requestId\":" + json_string(response.request_id) +
      ",\"sessionId\":" + json_string(response.session_id) +
      ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_cancel_success(const CancelSuccess &response) {
  require_request_id(response.request_id);
  require_request_id(response.target_request_id);
  require_uuid(response.session_id, "session ID");
  std::string state;
  switch (response.state) {
  case CancelState::kQueuedCancelled:
    state = "queued-cancelled";
    break;
  case CancelState::kRunningCancelRequested:
    state = "running-cancel-requested";
    break;
  case CancelState::kRunningNotCancellable:
    state = "running-not-cancellable";
    break;
  case CancelState::kAlreadyTerminal:
    state = "already-terminal";
    break;
  case CancelState::kNotFound:
    state = "not-found";
    break;
  }
  std::string json =
      "{\"kind\":\"response\",\"method\":\"cancel\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" +
      json_string(response.request_id) +
      ",\"result\":{\"state\":" + json_string(state) +
      ",\"targetRequestId\":" + json_string(response.target_request_id) +
      ",\"terminalResponseExpected\":" +
      (response.terminal_response_expected ? "true" : "false") +
      "},\"sessionId\":" + json_string(response.session_id) +
      ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_project_graph_invalidate_success(
    const ProjectGraphInvalidateSuccess &response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  std::string json =
      "{\"kind\":\"response\",\"method\":\"invalidateGraph\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" +
      json_string(response.request_id) +
      ",\"result\":{\"generation\":" + std::to_string(response.generation) +
      ",\"invalidated\":" + (response.invalidated ? "true" : "false") +
      "},\"sessionId\":" + json_string(response.session_id) +
      ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_error_response(const ErrorResponse &response) {
  require_request_id(response.request_id);
  const ErrorPolicy policy = error_policy(response.code);
  std::string details;
  if (response.details.has_value()) {
    std::vector<std::string> members;
    if (response.details->field.has_value()) {
      members.push_back("\"field\":" + json_string(*response.details->field));
    }
    if (response.details->capability_id.has_value()) {
      if (*response.details->capability_id != kNativeProgramCapability) {
        invalid_argument("error details target a retired capability");
      }
      members.push_back("\"capabilityId\":" +
                        json_string(*response.details->capability_id));
    }
    if (response.details->idempotency_key.has_value()) {
      members.push_back("\"idempotencyKey\":" +
                        json_string(*response.details->idempotency_key));
    }
    if (response.details->supported_wire_minimum.has_value() &&
        response.details->supported_wire_maximum.has_value()) {
      members.push_back(
          "\"supportedWireVersions\":{\"maximum\":" +
          std::to_string(*response.details->supported_wire_maximum) +
          ",\"minimum\":" +
          std::to_string(*response.details->supported_wire_minimum) + "}");
    }
    if (response.details->current_generation.has_value()) {
      members.push_back("\"currentGeneration\":" +
                        std::to_string(*response.details->current_generation));
    }
    std::sort(members.begin(), members.end());
    details = ",\"details\":{";
    for (std::size_t index = 0; index < members.size(); ++index) {
      if (index != 0)
        details.push_back(',');
      details += members[index];
    }
    details.push_back('}');
  }
  std::string recovery =
      "{\"action\":" +
      json_string(response.recovery_action.value_or(policy.recovery)) +
      ",\"hint\":" + json_string(response.recovery_hint);
  if (response.retry_after_ms.has_value()) {
    recovery += ",\"retryAfterMs\":" + std::to_string(*response.retry_after_ms);
  }
  recovery.push_back('}');
  std::string json = "{\"error\":{\"code\":" + json_string(policy.code) +
                     details + ",\"message\":" + json_string(response.message) +
                     ",\"recovery\":" + recovery +
                     ",\"retryable\":" + (policy.retryable ? "true" : "false") +
                     ",\"sideEffect\":" + json_string(policy.side_effect) +
                     "},\"kind\":\"response\",\"method\":" +
                     json_string(method_name(response.method)) +
                     ",\"ok\":false,\"replayed\":false,\"requestId\":" +
                     json_string(response.request_id);
  if (response.session_id.has_value()) {
    require_uuid(*response.session_id, "session ID");
    json += ",\"sessionId\":" + json_string(*response.session_id);
  }
  json += ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

} // namespace aemcp::native::rpc
