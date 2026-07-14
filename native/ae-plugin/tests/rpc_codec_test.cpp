#include "aemcp_native/rpc_codec.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

namespace {

using aemcp::native::rpc::CapabilitiesParams;
using aemcp::native::rpc::CapabilitiesSuccess;
using aemcp::native::rpc::CapabilityDetail;
using aemcp::native::rpc::CancelState;
using aemcp::native::rpc::CancelSuccess;
using aemcp::native::rpc::CodecError;
using aemcp::native::rpc::ErrorDetails;
using aemcp::native::rpc::ErrorResponse;
using aemcp::native::rpc::FrameDecoder;
using aemcp::native::rpc::HelloParams;
using aemcp::native::rpc::HelloSuccess;
using aemcp::native::rpc::InvokeParams;
using aemcp::native::rpc::ParsedRequest;
using aemcp::native::rpc::ProgressEvent;
using aemcp::native::rpc::ProgressPhase;
using aemcp::native::rpc::ProjectSummarySuccess;
using aemcp::native::rpc::RpcErrorCode;
using aemcp::native::rpc::RpcMethod;
using aemcp::native::rpc::RpcSessionFrontDoor;
using aemcp::native::rpc::SessionClock;
using aemcp::native::rpc::SessionFrontDoorConfig;
using aemcp::native::rpc::SessionIngressCode;
using aemcp::native::rpc::decode_request_frame;
using aemcp::native::rpc::digest_capabilities_query;
using aemcp::native::rpc::digest_project_summary_postcondition;
using aemcp::native::rpc::encode_capabilities_success;
using aemcp::native::rpc::encode_cancel_success;
using aemcp::native::rpc::encode_error_response;
using aemcp::native::rpc::encode_hello_success;
using aemcp::native::rpc::encode_progress_event;
using aemcp::native::rpc::encode_project_summary_success;
using aemcp::native::rpc::kMaxFrameBytes;

constexpr std::string_view kSession = "11111111-1111-4111-8111-111111111111";
constexpr std::string_view kHost = "22222222-2222-4222-8222-222222222222";
constexpr std::string_view kClient = "33333333-3333-4333-8333-333333333333";
constexpr std::string_view kDigest = "778a01733fcf37510f56894a46ec5bd87c7429de2e06d2d5eafb4cdbbae88557";
constexpr std::string_view kContractDigest = "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a";

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

std::vector<std::uint8_t> frame(std::string_view json) {
  require(json.size() <= kMaxFrameBytes, "test frame exceeds protocol limit");
  std::vector<std::uint8_t> result(json.size() + 4);
  const auto size = static_cast<std::uint32_t>(json.size());
  result[0] = static_cast<std::uint8_t>(size >> 24U);
  result[1] = static_cast<std::uint8_t>(size >> 16U);
  result[2] = static_cast<std::uint8_t>(size >> 8U);
  result[3] = static_cast<std::uint8_t>(size);
  std::memcpy(result.data() + 4, json.data(), json.size());
  return result;
}

std::string body(const std::vector<std::uint8_t>& framed) {
  require(framed.size() >= 4, "encoded output has no prefix");
  const std::uint32_t size = (static_cast<std::uint32_t>(framed[0]) << 24U)
      | (static_cast<std::uint32_t>(framed[1]) << 16U)
      | (static_cast<std::uint32_t>(framed[2]) << 8U)
      | static_cast<std::uint32_t>(framed[3]);
  require(size == framed.size() - 4, "encoded output prefix does not match body");
  return std::string(reinterpret_cast<const char*>(framed.data() + 4), size);
}

template <typename Callable>
void expect_codec_error(Callable&& callable, std::string_view code, const std::string& label) {
  try {
    callable();
  } catch (const CodecError& error) {
    require(error.error_code() == code, label + " returned " + std::string(error.error_code()));
    return;
  }
  fail(label + " was accepted");
}

template <typename Callable>
void expect_argument_error(Callable&& callable, const std::string& label) {
  try {
    callable();
  } catch (const std::invalid_argument&) {
    return;
  } catch (const CodecError& error) {
    require(error.error_code() == "INVALID_ARGUMENT", label + " returned wrong codec error");
    return;
  }
  fail(label + " was accepted");
}

std::string hello_json(std::uint16_t minimum = 1, std::uint16_t maximum = 1) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"requestId\":\"hello-1\","
      "\"method\":\"hello\",\"params\":{\"supportedWireVersions\":{\"minimum\":"
      + std::to_string(minimum) + ",\"maximum\":" + std::to_string(maximum)
      + "},\"client\":{\"component\":\"core-broker\",\"version\":\"0.9.2\","
        "\"instanceId\":\"" + std::string(kClient)
      + "\"},\"nonce\":\"abcdefghijklmnopqrstuvwxyzABCDEF\"}}";
}

std::string invoke_json(
    std::string_view request_id = "invoke-summary-1",
    std::uint64_t deadline = 1'900'000'005'000ULL,
    std::string_view arguments = "{}") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":" + std::to_string(deadline)
      + ",\"params\":{\"capabilityId\":\"ae.project.summary\","
        "\"capabilityVersion\":1,\"arguments\":" + std::string(arguments) + "}}";
}

void golden_requests_are_typed_and_closed() {
  const ParsedRequest hello = decode_request_frame(frame(hello_json()));
  require(hello.method == RpcMethod::kHello && !hello.session_id.has_value(), "hello classification failed");
  const auto& hello_params = std::get<HelloParams>(hello.params);
  require(hello_params.minimum_wire_version == 1 && hello_params.maximum_wire_version == 1,
      "hello wire range changed");
  require(hello_params.client_instance_id == kClient && hello_params.nonce.size() == 32,
      "hello identity changed");
  require(hello.request_fingerprint_sha256
      == "a8b609ec240f4b730c6b4b5b17a68be4aa94ba568562b74036b55aa83ab5f336",
      "hello normalized SHA-256 changed");
  require(decode_request_frame(frame(" \n" + hello_json() + "\t")).request_fingerprint_sha256
      == hello.request_fingerprint_sha256,
      "insignificant JSON whitespace changed the request digest");

  const std::string capabilities_json = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"capabilities-1\",\"method\":\"capabilities\","
        "\"params\":{\"ids\":[\"ae.project.summary\"],\"detail\":\"full\",\"limit\":1}}";
  const ParsedRequest capabilities = decode_request_frame(frame(capabilities_json));
  const auto& capabilities_params = std::get<CapabilitiesParams>(capabilities.params);
  require(capabilities.method == RpcMethod::kCapabilities
      && capabilities_params.detail == CapabilityDetail::kFull
      && capabilities_params.detail_was_provided && capabilities_params.limit == 1
      && capabilities_params.limit_was_provided && capabilities_params.ids->size() == 1,
      "capabilities golden vector changed");
  require(digest_capabilities_query(*capabilities.session_id, capabilities_params)
      == "aa3c66bc21e50b6a35db9c3cb12fcb1627694cd8f9fc411f21f7e3de46b3e56a",
      "capabilities query digest diverged from the protocol fixture");

  const std::string omitted_defaults = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cap-default\",\"method\":\"capabilities\",\"params\":{}}";
  const std::string explicit_defaults = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cap-default\",\"method\":\"capabilities\","
        "\"params\":{\"detail\":\"summary\",\"limit\":50}}";
  const ParsedRequest omitted = decode_request_frame(frame(omitted_defaults));
  const ParsedRequest explicit_value = decode_request_frame(frame(explicit_defaults));
  require(omitted.request_fingerprint_sha256 != explicit_value.request_fingerprint_sha256,
      "request digest collapsed explicit defaults into omission");

  const ParsedRequest invoke = decode_request_frame(frame(invoke_json()));
  require(invoke.method == RpcMethod::kInvoke && invoke.session_id == kSession
      && invoke.deadline_unix_ms == 1'900'000'005'000ULL,
      "invoke golden vector changed");
  require(invoke.request_fingerprint_sha256
      == "9df120d0b016b1313035b94329245474a0dc31bad5c0383a9ecde11db5fbdc8f",
      "invoke RFC 8785 request digest changed");
  require(std::get<InvokeParams>(invoke.params).capability_id == "ae.project.summary",
      "invoke capability changed");

  const std::string cancel_json = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cancel-1\",\"method\":\"cancel\","
        "\"params\":{\"targetRequestId\":\"invoke-summary-1\"}}";
  const ParsedRequest cancel = decode_request_frame(frame(cancel_json));
  require(cancel.method == RpcMethod::kCancel, "cancel golden vector changed");

  expect_codec_error([&] {
    (void)decode_request_frame(frame(hello_json().substr(0, hello_json().size() - 1) + ",\"extra\":1}"));
  }, "INVALID_REQUEST", "unknown envelope field");
  expect_codec_error([&] { (void)decode_request_frame(frame(invoke_json("raw", 1'900'000'005'000ULL,
    "{\"jsx\":\"alert(1)\"}"))); }, "INVALID_ARGUMENT", "raw JSX argument");
  const std::string hello_with_session = hello_json().substr(0, hello_json().size() - 1)
      + ",\"sessionId\":\"not-a-uuid\"}";
  expect_codec_error([&] { (void)decode_request_frame(frame(hello_with_session)); },
      "INVALID_REQUEST", "hello with forbidden session");
}

void framing_fragmentation_and_multiple_frames_work() {
  const auto first = frame(hello_json());
  const auto second = frame("{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"cap-default\","
        "\"method\":\"capabilities\",\"params\":{}}");
  FrameDecoder decoder;
  std::vector<ParsedRequest> all;
  for (std::size_t offset = 0; offset < first.size();) {
    const std::size_t size = std::min<std::size_t>((offset % 7) + 1, first.size() - offset);
    auto parsed = decoder.push(std::span(first).subspan(offset, size));
    all.insert(all.end(), parsed.begin(), parsed.end());
    offset += size;
  }
  require(all.size() == 1 && decoder.pending_bytes() == 0, "fragmented frame was not decoded once");
  std::vector<std::uint8_t> joined(first);
  joined.insert(joined.end(), second.begin(), second.end());
  require(joined.size() <= kMaxFrameBytes + 4, "test multiframe chunk violates adapter bound");
  FrameDecoder multi;
  auto parsed = multi.push(joined);
  require(parsed.size() == 2 && parsed[1].method == RpcMethod::kCapabilities,
      "multiple frames in one chunk failed");
  multi.finalize();

  FrameDecoder unfinished;
  (void)unfinished.push(std::span(first).first(first.size() - 1));
  expect_codec_error([&] { unfinished.finalize(); }, "INVALID_REQUEST", "unfinished stream");
  require(unfinished.failed(), "unfinished decoder was not poisoned");
}

void strict_json_and_frame_limits_fail_closed() {
  const std::array<std::pair<std::string, std::string>, 10> cases = {{
    {"duplicate key", "{\"wireVersion\":1,\"wireVersion\":1}"},
    {"trailing bytes", hello_json() + "x"},
    {"invalid escape", "{\"x\":\"\\q\"}"},
    {"lone high surrogate", "{\"x\":\"\\ud800\"}"},
    {"lone low surrogate", "{\"x\":\"\\udc00\"}"},
    {"unsafe integer", invoke_json("unsafe", 9'007'199'254'740'991ULL).replace(
      invoke_json("unsafe", 9'007'199'254'740'991ULL).find("9007199254740991"), 16,
      "9007199254740992")},
    {"non-finite", "{\"wireVersion\":1e999,\"kind\":\"request\"}"},
    {"trailing comma", "{\"wireVersion\":1,}"},
    {"leading zero", "{\"wireVersion\":01}"},
    {"bad literal", "{\"wireVersion\":tru}"},
  }};
  for (const auto& [name, json] : cases) {
    expect_codec_error([&] { (void)decode_request_frame(frame(json)); }, "INVALID_REQUEST", name);
  }

  std::string nested = "0";
  for (int level = 0; level < 17; ++level) nested = "[" + nested + "]";
  expect_codec_error([&] { (void)decode_request_frame(frame(nested)); }, "INVALID_REQUEST", "depth 17");

  std::string nodes = "[";
  for (int index = 0; index < 2'048; ++index) {
    if (index != 0) nodes.push_back(',');
    nodes += "null";
  }
  nodes.push_back(']');
  expect_codec_error([&] { (void)decode_request_frame(frame(nodes)); }, "INVALID_REQUEST", "node 2049");

  std::string long_nonce(8'193, 'a');
  expect_codec_error([&] { (void)decode_request_frame(frame("{\"x\":\"" + long_nonce + "\"}")); },
      "INVALID_REQUEST", "string scalar 8193");

  std::vector<std::uint8_t> invalid_utf8 = {0, 0, 0, 2, 0xc3, 0x28};
  expect_codec_error([&] { (void)decode_request_frame(invalid_utf8); }, "INVALID_REQUEST", "invalid UTF-8");
  expect_codec_error([&] { (void)decode_request_frame(std::array<std::uint8_t, 4>{0, 0, 0, 0}); },
      "INVALID_REQUEST", "zero frame");
  expect_codec_error([&] { (void)decode_request_frame(std::array<std::uint8_t, 4>{0, 1, 0, 1}); },
      "INVALID_REQUEST", "oversize frame");

  std::string maximum_body = hello_json();
  maximum_body.append(kMaxFrameBytes - maximum_body.size(), ' ');
  require(decode_request_frame(frame(maximum_body)).method == RpcMethod::kHello,
      "maximum-size frame was rejected");

  std::string at_depth = "0";
  for (int level = 0; level < 12; ++level) at_depth = "[" + at_depth + "]";
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invoke_json("depth-16", 1'900'000'005'000ULL,
      "{\"x\":" + at_depth + "}")));
  }, "INVALID_ARGUMENT", "depth 16 closed-argument rejection");
  at_depth = "[" + at_depth + "]";
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invoke_json("depth-17", 1'900'000'005'000ULL,
      "{\"x\":" + at_depth + "}")));
  }, "INVALID_REQUEST", "depth 17 parser rejection");
}

void negative_contract_vectors_are_classified() {
  const std::vector<std::tuple<std::string, std::string, std::string>> cases = {
    {"unknown method", "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"bad-1\",\"method\":\"execute\","
        "\"params\":{}}", "INVALID_REQUEST"},
    {"invoke missing session", "{\"wireVersion\":1,\"kind\":\"request\","
      "\"requestId\":\"bad-2\",\"method\":\"invoke\",\"params\":{"
      "\"capabilityId\":\"ae.project.summary\",\"capabilityVersion\":1,"
      "\"arguments\":{}}}", "SESSION_STALE"},
    {"wrong detail enum", "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"bad-3\","
        "\"method\":\"capabilities\",\"params\":{\"detail\":\"everything\"}}",
      "INVALID_ARGUMENT"},
    {"missing capability version", "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession) + "\",\"requestId\":\"bad-5\","
      "\"method\":\"invoke\",\"params\":{\"capabilityId\":\"ae.project.summary\","
      "\"arguments\":{}}}", "INVALID_ARGUMENT"},
    {"nested executable alias", invoke_json("bad-7", 1'900'000'005'000ULL,
      "{\"payload\":{\"code\":\"synthetic executable input\"}}"), "INVALID_ARGUMENT"},
  };
  for (const auto& [name, json, expected] : cases) {
    expect_codec_error([&] { (void)decode_request_frame(frame(json)); }, expected, name);
  }

  const std::vector<std::uint8_t> overlong = {0, 0, 0, 2, 0xc0, 0xaf};
  expect_codec_error([&] { (void)decode_request_frame(overlong); },
      "INVALID_REQUEST", "overlong UTF-8");
  const std::vector<std::uint8_t> encoded_surrogate = {0, 0, 0, 3, 0xed, 0xa0, 0x80};
  expect_codec_error([&] { (void)decode_request_frame(encoded_surrogate); },
      "INVALID_REQUEST", "UTF-8 encoded surrogate");
}

class FakeClock final : public SessionClock {
 public:
  [[nodiscard]] std::uint64_t now_unix_ms() const noexcept override { return now; }
  std::uint64_t now{1'900'000'000'000ULL};
};

void authorization_session_and_replay_gate_are_bounded() {
  FakeClock clock;
  RpcSessionFrontDoor door(
      "opaque-connection-7", std::string(kHost), std::string(kSession), clock,
      SessionFrontDoorConfig{1, 2, 1'000, 5'000, 30'000});
  const ParsedRequest hello = decode_request_frame(frame(hello_json()));
  require(door.admit(hello).code == SessionIngressCode::kPairingRequired,
      "unauthorized hello was not kept pending");
  const ParsedRequest invoke = decode_request_frame(frame(invoke_json(
      "invoke-1", clock.now + 5'000)));
  require(door.admit(invoke).code == SessionIngressCode::kAuthorizationRequired,
      "unauthorized invoke passed the gate");
  require(door.authorize_pairing(), "pairing authorization failed");
  require(door.admit(invoke).code == SessionIngressCode::kHelloRequired,
      "request was accepted before hello");
  require(door.admit(hello).code == SessionIngressCode::kAcceptedHello && door.hello_complete(),
      "authorized hello did not establish session");
  const auto admitted = door.admit(invoke);
  require(admitted.dispatchable() && admitted.effective_deadline_unix_ms == clock.now + 5'000,
      "valid request was not dispatchable");
  const auto active_duplicate = door.admit(invoke);
  require(active_duplicate.code == SessionIngressCode::kDuplicateRequest
      && active_duplicate.duplicate_content_matches, "active replay was not recognized");

  ParsedRequest mismatched = invoke;
  mismatched.request_fingerprint_sha256[0] = mismatched.request_fingerprint_sha256[0] == 'a' ? 'b' : 'a';
  const auto content_mismatch = door.admit(mismatched);
  require(content_mismatch.code == SessionIngressCode::kDuplicateRequest
      && !content_mismatch.duplicate_content_matches, "content-mismatched replay was not distinguished");

  const ParsedRequest second = decode_request_frame(frame(invoke_json("invoke-2", clock.now + 5'000)));
  require(door.admit(second).code == SessionIngressCode::kLedgerFull,
      "active ledger capacity was not enforced");
  require(door.complete_request("invoke-1") && door.tombstone_count() == 1,
      "terminal tombstone was not recorded");
  require(door.admit(invoke).code == SessionIngressCode::kDuplicateRequest,
      "terminal replay was accepted");
  clock.now += 1'001;
  require(door.admit(second).code == SessionIngressCode::kAcceptedRequest,
      "expired tombstone did not release the request ID ledger");
  door.revoke_pairing();
  require(!door.paired() && door.active_request_count() == 0
      && door.admit(second).code == SessionIngressCode::kAuthorizationRequired,
      "revocation did not purge and close the dispatch gate");
  door.close();
  require(door.admit(hello).code == SessionIngressCode::kClosed && !door.authorize_pairing(),
      "closed session could be reopened");

  RpcSessionFrontDoor mismatch("conn", std::string(kHost), std::string(kSession), clock);
  require(mismatch.authorize_pairing(), "mismatch pairing setup failed");
  const ParsedRequest future = decode_request_frame(frame(hello_json(2, 3)));
  require(mismatch.admit(future).code == SessionIngressCode::kWireVersionMismatch
      && !mismatch.hello_complete(), "wire mismatch established a session");

  RpcSessionFrontDoor deadlines("deadline-conn", std::string(kHost), std::string(kSession), clock);
  require(deadlines.authorize_pairing()
      && deadlines.admit(hello).code == SessionIngressCode::kAcceptedHello,
      "deadline session setup failed");
  const std::string capabilities_without_deadline = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cap-deadline\",\"method\":\"capabilities\",\"params\":{}}";
  const auto defaulted = deadlines.admit(decode_request_frame(frame(capabilities_without_deadline)));
  require(defaulted.effective_deadline_unix_ms == clock.now + 5'000,
      "omitted deadline did not materialize to five seconds");
  require(deadlines.complete_request("cap-deadline"), "defaulted request did not complete");
  require(deadlines.admit(decode_request_frame(frame(invoke_json("expired", clock.now)))).code
      == SessionIngressCode::kDeadlineExceeded, "expired request entered dispatch");
  require(deadlines.admit(decode_request_frame(frame(invoke_json("too-far", clock.now + 30'001)))).code
      == SessionIngressCode::kInvalidDeadline, "over-maximum deadline entered dispatch");
  std::string wrong_session_json = invoke_json("wrong-session", clock.now + 5'000);
  wrong_session_json.replace(wrong_session_json.find(kSession), kSession.size(),
      "44444444-4444-4444-8444-444444444444");
  require(deadlines.admit(decode_request_frame(frame(wrong_session_json))).code
      == SessionIngressCode::kSessionStale, "cross-session request entered dispatch");
}

void response_helpers_are_bounded_and_typed() {
  HelloSuccess hello;
  hello.request_id = "hello-1";
  hello.session_id = std::string(kSession);
  hello.client_nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
  hello.plugin_version = "0.0.0-test";
  hello.compiled_sdk_version = "25.6";
  hello.compiled_sdk_build = 61;
  hello.architecture = "arm64";
  hello.host_version = "26.3.0";
  hello.host_build = 87;
  hello.platform = "macos-arm64";
  hello.host_instance_id = std::string(kHost);
  hello.session_generation = 1;
  hello.capabilities_digest = std::string(kDigest);
  const std::string hello_body = body(encode_hello_success(hello));
  require(hello_body.find("\"selectedWireVersion\":1") != std::string::npos
      && hello_body.find("\"clientNonce\":\"abcdefghijklmnopqrstuvwxyzABCDEF\"") != std::string::npos,
      "hello serializer omitted negotiated bindings");

  CapabilitiesSuccess capabilities;
  capabilities.request_id = "capabilities-1";
  capabilities.session_id = std::string(kSession);
  capabilities.detail = CapabilityDetail::kFull;
  capabilities.query_digest = std::string(kDigest);
  capabilities.capabilities_digest = std::string(kDigest);
  capabilities.project_summary_contract_digest = std::string(kContractDigest);
  const std::string capabilities_body = body(encode_capabilities_success(capabilities));
  require(capabilities_body.find("\"additionalProperties\":false") != std::string::npos
      && capabilities_body.find("aemcp.requirement.native.project-read") != std::string::npos,
      "full capability serializer omitted the closed contract");

  const std::string progress_body = body(encode_progress_event(ProgressEvent{
    "invoke-1", std::string(kSession), 1, ProgressPhase::kQueued, 0.25, "Queued safely."}));
  require(progress_body.find("\"fraction\":0.25") != std::string::npos,
      "progress serializer changed the fraction");

  ProjectSummarySuccess summary;
  summary.request_id = "invoke-1";
  summary.session_id = std::string(kSession);
  summary.host_instance_id = std::string(kHost);
  summary.project_open = true;
  summary.project_name = "测试 🎬.aep";
  summary.item_count = 3;
  summary.started_at_unix_ms = 1'900'000'000'000ULL;
  summary.completed_at_unix_ms = 1'900'000'000'025ULL;
  summary.request_digest = std::string(kDigest);
  summary.postcondition_digest = std::string(kDigest);
  const std::string summary_body = body(encode_project_summary_success(summary));
  require(summary_body.find("\"engine\":\"native-aegp\"") != std::string::npos
      && summary_body.find("\"itemCount\":3") != std::string::npos,
      "project summary serializer omitted typed provenance");
  require(digest_project_summary_postcondition(true, "fixture.aep", 3)
      == "0e82d012b2b7f26e310703c35b1d82e744809137f1ea5e6d1920aa29c0baca77",
      "project summary postcondition digest changed its canonical contract");
  expect_argument_error([&] {
    (void)digest_project_summary_postcondition(
        true, "fixture.aep", aemcp::native::rpc::kMaxSafeInteger + 1);
  }, "unsafe postcondition item count");

  CancelSuccess cancel;
  cancel.request_id = "cancel-1";
  cancel.session_id = std::string(kSession);
  cancel.target_request_id = "invoke-1";
  cancel.state = CancelState::kQueuedCancelled;
  cancel.terminal_response_expected = true;
  const std::string cancel_body = body(encode_cancel_success(cancel));
  require(cancel_body.find("\"state\":\"queued-cancelled\"") != std::string::npos
      && cancel_body.find("\"terminalResponseExpected\":true") != std::string::npos,
      "cancel serializer omitted its typed terminal contract");
  cancel.terminal_response_expected = false;
  expect_argument_error([&] { (void)encode_cancel_success(cancel); },
      "cancel terminal expectation mismatch");

  ErrorResponse error;
  error.method = RpcMethod::kInvoke;
  error.request_id = "invoke-1";
  error.session_id = std::string(kSession);
  error.code = RpcErrorCode::kQueueFull;
  error.message = "The bounded native queue is full.";
  error.recovery_hint = "Retry after the bounded delay.";
  error.retry_after_ms = 250;
  const std::string error_body = body(encode_error_response(error));
  require(error_body.find("\"code\":\"QUEUE_FULL\"") != std::string::npos
      && error_body.find("\"retryAfterMs\":250") != std::string::npos,
      "error serializer violated the bound policy tuple");

  error.code = RpcErrorCode::kWireVersionMismatch;
  error.method = RpcMethod::kHello;
  error.session_id.reset();
  error.retry_after_ms.reset();
  error.details = ErrorDetails{};
  expect_argument_error([&] { (void)encode_error_response(error); }, "mismatch without supported range");
  summary.project_name = std::string(1'025, 'x');
  expect_argument_error([&] { (void)encode_project_summary_success(summary); }, "oversized project name");
  summary.project_name = "fixture.aep";
  summary.replayed = true;
  expect_argument_error([&] { (void)encode_project_summary_success(summary); },
      "unvalidated replay response");
  summary.replayed = false;
  summary.project_name = std::string("\xc3\x28", 2);
  expect_argument_error([&] { (void)encode_project_summary_success(summary); },
      "invalid UTF-8 project name");
}

void fixed_seed_mutation_fuzz_is_bounded() {
  const auto golden = frame(invoke_json("fuzz-1", 1'900'000'005'000ULL));
  std::uint32_t state = 0x5eed1234U;
  std::size_t accepted = 0;
  std::size_t rejected = 0;
  for (int iteration = 0; iteration < 512; ++iteration) {
    auto candidate = golden;
    state = state * 1'664'525U + 1'013'904'223U;
    const std::size_t mutations = 1 + (state % 4U);
    for (std::size_t count = 0; count < mutations; ++count) {
      state = state * 1'664'525U + 1'013'904'223U;
      const std::size_t index = 4 + (state % (candidate.size() - 4));
      state = state * 1'664'525U + 1'013'904'223U;
      candidate[index] ^= static_cast<std::uint8_t>(1U << (state % 8U));
    }
    try {
      FrameDecoder decoder;
      std::vector<ParsedRequest> parsed;
      std::size_t offset = 0;
      while (offset < candidate.size()) {
        state = state * 1'664'525U + 1'013'904'223U;
        const std::size_t chunk = std::min<std::size_t>(1 + state % 31U, candidate.size() - offset);
        auto values = decoder.push(std::span(candidate).subspan(offset, chunk));
        parsed.insert(parsed.end(), values.begin(), values.end());
        offset += chunk;
      }
      decoder.finalize();
      require(parsed.size() == 1, "accepted fuzz input did not yield exactly one request");
      ++accepted;
    } catch (const CodecError&) {
      ++rejected;
    }
  }
  require(accepted > 0 && rejected > 400, "fixed-seed fuzz did not exercise both paths");
}

}  // namespace

int main() {
  golden_requests_are_typed_and_closed();
  framing_fragmentation_and_multiple_frames_work();
  strict_json_and_frame_limits_fail_closed();
  negative_contract_vectors_are_classified();
  authorization_session_and_replay_gate_are_bounded();
  response_helpers_are_bounded_and_typed();
  fixed_seed_mutation_fuzz_is_bounded();
  std::cout << "rpc_codec_test: PASS\n";
  return 0;
}
