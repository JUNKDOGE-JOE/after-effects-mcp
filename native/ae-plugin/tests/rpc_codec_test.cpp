#include "aemcp_native/rpc_codec.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using namespace aemcp::native;
using namespace aemcp::native::rpc;

constexpr std::string_view kRequest = "11111111-1111-4111-8111-111111111111";
constexpr std::string_view kSession = "22222222-2222-4222-8222-222222222222";
constexpr std::string_view kHost = "33333333-3333-4333-8333-333333333333";
constexpr std::string_view kDigest =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

void require(bool condition, std::string_view message) {
  if (!condition)
    throw std::runtime_error(std::string(message));
}

std::vector<std::uint8_t> frame(std::string_view json) {
  std::vector<std::uint8_t> result(4 + json.size());
  const auto size = static_cast<std::uint32_t>(json.size());
  result[0] = static_cast<std::uint8_t>(size >> 24U);
  result[1] = static_cast<std::uint8_t>(size >> 16U);
  result[2] = static_cast<std::uint8_t>(size >> 8U);
  result[3] = static_cast<std::uint8_t>(size);
  std::copy(json.begin(), json.end(), result.begin() + 4);
  return result;
}

std::string payload(const std::vector<std::uint8_t> &encoded) {
  return std::string(encoded.begin() + 4, encoded.end());
}

template <typename Action>
void rejects(Action &&action, std::string_view label) {
  try {
    action();
  } catch (const CodecError &) {
    return;
  }
  throw std::runtime_error(std::string(label) + " was accepted");
}

void decodes_only_program_and_control_requests() {
  const auto hello = decode_request_frame(frame(
      R"({"wireVersion":1,"kind":"request","requestId":"11111111-1111-4111-8111-111111111111","method":"hello","params":{"supportedWireVersions":{"minimum":1,"maximum":1},"client":{"component":"core-broker","version":"1.0.0","instanceId":"44444444-4444-4444-8444-444444444444"},"nonce":"abcdefghijklmnopqrstuvwxyzABCDEF"}})"));
  require(hello.method == RpcMethod::kHello, "hello method was not decoded");

  const auto invoke = decode_request_frame(frame(
      R"({"wireVersion":1,"kind":"request","requestId":"11111111-1111-4111-8111-111111111112","sessionId":"22222222-2222-4222-8222-222222222222","method":"invoke","params":{"capabilityId":"ae.native.exec","capabilityVersion":1,"arguments":{"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]}}})"));
  require(invoke.method == RpcMethod::kInvoke, "invoke method was not decoded");
  const auto *native = std::get_if<NativeProgramParams>(&invoke.params);
  require(native != nullptr && native->program.operations.size() == 1,
          "native program was not admitted");

  rejects(
      [] {
        (void)decode_request_frame(frame(
            R"({"wireVersion":1,"kind":"request","requestId":"11111111-1111-4111-8111-111111111113","sessionId":"22222222-2222-4222-8222-222222222222","method":"invoke","params":{"capabilityId":"ae.retired.direct","capabilityVersion":1,"arguments":{}}})"));
      },
      "legacy direct capability");
}

void capabilities_expose_one_top_level_descriptor() {
  CapabilitiesSuccess response;
  response.request_id = kRequest;
  response.session_id = kSession;
  response.detail = CapabilityDetail::kFull;
  response.selected_primitive_indices = {0};
  response.query_digest = std::string(kDigest);
  const std::string json = payload(encode_capabilities_success(response));
  require(json.find("\"id\":\"ae.native.exec\"") != std::string::npos,
          "native program capability descriptor is missing");
  require(json.find("\"primitiveCount\":23") != std::string::npos,
          "full descriptor omitted its primitive catalog");
  const auto capability = json.find("\"id\":\"ae.native.exec\"");
  require(capability != std::string::npos &&
              json.find("\"id\":\"ae.native.exec\"", capability + 1) ==
                  std::string::npos,
          "capabilities response did not contain exactly one top-level route");
}

void native_program_success_and_failure_are_structured() {
  NativeProgramSuccess success;
  success.request_id = kRequest;
  success.session_id = kSession;
  success.host_instance_id = kHost;
  success.outputs = {{"items", JsonValue{JsonValue::Array{}}}};
  success.operations = {{0, "project.items.list", "completed"}};
  success.started_at_unix_ms = 1;
  success.completed_at_unix_ms = 2;
  success.request_digest = kDigest;
  success.postcondition_digest =
      digest_native_program_postcondition(success.outputs, success.operations);
  const std::string success_json =
      payload(encode_native_program_success(success));
  require(success_json.find("\"capabilityId\":\"ae.native.exec\"") !=
              std::string::npos,
          "program success omitted capability provenance");
  require(success_json.find("\"engine\":\"native-aegp\"") != std::string::npos,
          "program success omitted native provenance");

  NativeProgramFailure failure;
  failure.request_id = kRequest;
  failure.session_id = kSession;
  failure.host_instance_id = kHost;
  failure.code = RpcErrorCode::kPossiblySideEffectingFailure;
  failure.message = "write outcome requires reconciliation";
  failure.disposition = NativeProgramDisposition::kPossiblySideEffecting;
  failure.failed_operation =
      NativeProgramOperationSummary{0, "project.bitDepth.set", "failed"};
  failure.started_at_unix_ms = 1;
  failure.completed_at_unix_ms = 2;
  failure.request_digest = kDigest;
  failure.postcondition_digest = kDigest;
  failure.operation_key = "native-write-key-0001";
  failure.undo_group = "Set depth";
  failure.write_started = true;
  const std::string failure_json =
      payload(encode_native_program_failure(failure));
  require(failure_json.find("POSSIBLY_SIDE_EFFECTING_FAILURE") !=
              std::string::npos,
          "program failure lost uncertain-write classification");
  require(failure_json.find("\"failedOperation\"") != std::string::npos,
          "program failure omitted failed operation");
}

class TestClock final : public SessionClock {
public:
  [[nodiscard]] std::uint64_t now_unix_ms() const noexcept override {
    return now;
  }
  std::uint64_t now{1000};
};

void framing_and_session_front_door_remain_bounded() {
  const auto encoded = frame(
      R"({"wireVersion":1,"kind":"request","requestId":"11111111-1111-4111-8111-111111111111","method":"hello","params":{"supportedWireVersions":{"minimum":1,"maximum":1},"client":{"component":"core-broker","version":"1.0.0","instanceId":"44444444-4444-4444-8444-444444444444"},"nonce":"abcdefghijklmnopqrstuvwxyzABCDEF"}})");
  FrameDecoder decoder;
  require(decoder.push(std::span<const std::uint8_t>(encoded).first(3)).empty(),
          "partial prefix emitted a request");
  const auto decoded =
      decoder.push(std::span<const std::uint8_t>(encoded).subspan(3));
  require(decoded.size() == 1, "chunked frame did not decode");
  decoder.finalize();

  TestClock clock;
  RpcSessionFrontDoor front("connection-1", std::string(kHost),
                            std::string(kSession), clock);
  const auto hello = front.admit(decoded[0]);
  require(hello.code == SessionIngressCode::kAcceptedHello,
          "front door rejected hello");
  ParsedRequest invoke = decode_request_frame(frame(
      R"({"wireVersion":1,"kind":"request","requestId":"11111111-1111-4111-8111-111111111112","sessionId":"22222222-2222-4222-8222-222222222222","method":"invoke","params":{"capabilityId":"ae.native.exec","capabilityVersion":1,"arguments":{"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]}}})"));
  const auto admitted = front.admit(invoke);
  require(admitted.code == SessionIngressCode::kAcceptedRequest &&
              admitted.effective_deadline_unix_ms.has_value(),
          "front door rejected native program");
  require(front.complete_request(invoke.request_id),
          "front door did not complete active request");
}

} // namespace

int main() {
  try {
    decodes_only_program_and_control_requests();
    capabilities_expose_one_top_level_descriptor();
    native_program_success_and_failure_are_structured();
    framing_and_session_front_door_remain_bounded();
  } catch (const std::exception &error) {
    std::cerr << "rpc_codec_test failed: " << error.what() << '\n';
    return 1;
  }
  std::cout << "rpc_codec_test passed\n";
  return 0;
}
