#include "aemcp_native/peer_identity.hpp"
#include "aemcp_native/transport_auth.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <map>
#include <string>

namespace {

using namespace std::chrono_literals;
using aemcp::native::TransportAuthDecision;
using aemcp::native::TransportAuthDecisionCode;
using aemcp::native::TransportAuthChallenge;
using aemcp::native::TransportAuthPreface;
using aemcp::native::PeerAdmissionConfig;
using aemcp::native::PeerIdentityBackend;
using aemcp::native::ProcessGeneration;
using aemcp::native::ProcessSnapshot;
using aemcp::native::SocketPeerEvidence;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

class FakeBackend final : public PeerIdentityBackend {
 public:
  bool socket_peer(int, SocketPeerEvidence& output) override {
    output = peer;
    socket_reads += 1;
    if (change_socket_on_second_read && socket_reads > 1) output.pid_version += 1;
    return true;
  }

  bool process_snapshot(std::int32_t pid, ProcessSnapshot& output) override {
    const auto found = processes.find(pid);
    if (found == processes.end()) return false;
    output = found->second;
    process_reads[pid] += 1;
    if (change_process_on_second_read && process_reads[pid] > 1) output.exiting = true;
    return true;
  }

  SocketPeerEvidence peer{2200, 501, 20, 77, 9};
  std::map<std::int32_t, ProcessSnapshot> processes{
      {2200, {2200, 2100, 501, ProcessGeneration{30, 4}, 16, false, false}},
      {2100, {2100, 2000, 501, ProcessGeneration{20, 3}, 16, false, false}},
      {2000, {2000, 1, 501, ProcessGeneration{10, 2}, 16, false, false}},
  };
  std::map<std::int32_t, int> process_reads;
  int socket_reads{0};
  bool change_socket_on_second_read{false};
  bool change_process_on_second_read{false};
};

PeerAdmissionConfig admission_config() {
  return {
      501,
      8,
      16,
      {2000, ProcessGeneration{10, 2}},
      "11111111-1111-4111-8111-111111111111",
  };
}

void peer_admission_is_exact_and_rechecked() {
  FakeBackend backend;
  const auto admitted = aemcp::native::admit_local_ae_peer(
      backend, 7, "connection-1", admission_config());
  require(admitted.has_value(), "valid same-UID current-AE ancestry was rejected");
  require(backend.socket_reads == 2, "socket evidence was not read before and after");
  require(backend.process_reads[2200] == 2 && backend.process_reads[2100] == 2
          && backend.process_reads[2000] == 2,
      "process ancestry was not snapshotted before and after");
  require(aemcp::native::same_peer(backend, 7, *admitted),
      "unchanged admitted peer failed same_peer");

  FakeBackend process_changed;
  process_changed.change_process_on_second_read = true;
  require(!aemcp::native::admit_local_ae_peer(
              process_changed, 7, "connection-2", admission_config()).has_value(),
      "changed process snapshot was admitted");

  FakeBackend socket_changed;
  socket_changed.change_socket_on_second_read = true;
  require(!aemcp::native::admit_local_ae_peer(
              socket_changed, 7, "connection-3", admission_config()).has_value(),
      "changed socket peer was admitted");

  FakeBackend wrong_uid;
  wrong_uid.peer.euid = 502;
  require(!aemcp::native::admit_local_ae_peer(
              wrong_uid, 7, "connection-4", admission_config()).has_value(),
      "different UID was admitted");

  FakeBackend stale_host;
  stale_host.processes[2000].generation.start_seconds += 1;
  require(!aemcp::native::admit_local_ae_peer(
              stale_host, 7, "connection-5", admission_config()).has_value(),
      "stale AE generation was admitted");
}

}  // namespace

int main() {
  peer_admission_is_exact_and_rechecked();
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

  TransportAuthChallenge challenge{
      "A1B2-C3D4", 30000ms, "11111111-1111-4111-8111-111111111111"};
  const auto challenge_bytes = aemcp::native::serialize_auth_challenge(challenge);
  static_assert(challenge_bytes.size() == 57);
  TransportAuthChallenge parsed_challenge;
  require(aemcp::native::parse_auth_challenge(challenge_bytes, parsed_challenge)
          && parsed_challenge.challenge_id == challenge.challenge_id
          && parsed_challenge.expires_in == challenge.expires_in,
      "compatibility challenge did not round trip");
  auto bad_challenge = challenge_bytes;
  bad_challenge[8] = 'z';
  require(!aemcp::native::parse_auth_challenge(bad_challenge, parsed_challenge),
      "bad compatibility challenge was accepted");

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
