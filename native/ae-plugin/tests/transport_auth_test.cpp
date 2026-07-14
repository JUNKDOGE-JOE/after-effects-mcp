#include "aemcp_native/transport_auth.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>

namespace {

using namespace std::chrono_literals;
using aemcp::native::TransportAuthDecision;
using aemcp::native::TransportAuthDecisionCode;
using aemcp::native::TransportAuthPending;
using aemcp::native::TransportAuthPreface;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

}  // namespace

int main() {
  TransportAuthPreface preface;
  preface.client_nonce.fill(7);
  const auto preface_bytes = aemcp::native::serialize_auth_preface(preface);
  TransportAuthPreface parsed_preface;
  require(aemcp::native::parse_auth_preface(preface_bytes, parsed_preface)
          && parsed_preface.client_nonce == preface.client_nonce,
      "auth preface did not round trip");
  auto bad_preface = preface_bytes;
  bad_preface[0] ^= 1;
  require(!aemcp::native::parse_auth_preface(bad_preface, parsed_preface),
      "bad auth magic was accepted");

  TransportAuthPending pending{
      "A1B2-C3D4", 30000ms, "11111111-1111-4111-8111-111111111111"};
  const auto pending_bytes = aemcp::native::serialize_auth_pending(pending);
  TransportAuthPending parsed_pending;
  require(aemcp::native::parse_auth_pending(pending_bytes, parsed_pending)
          && parsed_pending.fingerprint == pending.fingerprint
          && parsed_pending.expires_in == pending.expires_in,
      "pending auth message did not round trip");
  auto bad_pending = pending_bytes;
  bad_pending[8] = 'z';
  require(!aemcp::native::parse_auth_pending(bad_pending, parsed_pending),
      "bad fingerprint was accepted");

  TransportAuthDecision authorized{
      TransportAuthDecisionCode::kAuthorized,
      "22222222-2222-4222-8222-222222222222",
      9,
  };
  const auto decision_bytes = aemcp::native::serialize_auth_decision(authorized);
  TransportAuthDecision parsed_decision;
  require(aemcp::native::parse_auth_decision(decision_bytes, parsed_decision)
          && parsed_decision.code == TransportAuthDecisionCode::kAuthorized
          && parsed_decision.session_id == authorized.session_id
          && parsed_decision.session_generation == 9,
      "authorized decision did not round trip");
  const auto rejected_bytes = aemcp::native::serialize_auth_decision(
      {TransportAuthDecisionCode::kRejected, {}, 0});
  require(aemcp::native::parse_auth_decision(rejected_bytes, parsed_decision)
          && parsed_decision.code == TransportAuthDecisionCode::kRejected
          && parsed_decision.session_id.empty(),
      "rejected decision did not round trip");
  auto forged = rejected_bytes;
  forged[45] = 1;
  require(!aemcp::native::parse_auth_decision(forged, parsed_decision),
      "unauthorized decision carried a generation");

  std::cout << "transport_auth_test: PASS\n";
  return 0;
}
