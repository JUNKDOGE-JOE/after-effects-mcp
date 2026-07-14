#include "aemcp_native/pairing_gate.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;
using aemcp::native::BeginPairingCode;
using aemcp::native::PairingDecision;
using aemcp::native::PairingGate;
using aemcp::native::PairingMaterial;
using aemcp::native::PairingMaterialSource;
using aemcp::native::PairingTimePoint;
using aemcp::native::PeerBinding;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

class FakeClock final : public aemcp::native::PairingGateClock {
 public:
  [[nodiscard]] PairingTimePoint now() const noexcept override { return now_; }
  void advance(std::chrono::milliseconds amount) { now_ += amount; }

 private:
  PairingTimePoint now_{PairingTimePoint{} + 1h};
};

class FakeMaterial final : public PairingMaterialSource {
 public:
  [[nodiscard]] PairingMaterial create() override {
    PairingMaterial material;
    material.capability.fill(static_cast<std::uint8_t>(++issued));
    material.fingerprint = issued == 1 ? "A1B2-C3D4" : "1122-3344";
    return material;
  }
  int issued{0};
};

PeerBinding binding(std::string connection = "connection-1", std::uint32_t generation = 7) {
  return {
      1234,
      generation,
      501,
      100001,
      std::move(connection),
      "11111111-1111-4111-8111-111111111111",
  };
}

void authorization_is_exact_and_single_pending() {
  FakeClock clock;
  FakeMaterial material;
  PairingGate gate(clock, material, {30s});
  const PeerBinding first = binding();
  const auto pending = gate.begin(first);
  require(pending.code == BeginPairingCode::kPending, "valid peer did not become pending");
  require(pending.fingerprint == "A1B2-C3D4", "fingerprint changed");
  require(gate.begin(binding("connection-2")).code == BeginPairingCode::kBusy,
      "second connection replaced pending peer");
  require(!gate.confirm("connection-2", pending.fingerprint),
      "wrong connection confirmed pending peer");
  require(!gate.confirm(first.connection_id, "FFFF-FFFF"),
      "wrong fingerprint confirmed pending peer");
  require(gate.confirm(first.connection_id, pending.fingerprint),
      "AEGP-owned confirmation failed");
  require(gate.authorized(first), "confirmed exact peer was not authorized");
  require(!gate.authorized(binding(first.connection_id, 8)),
      "changed process generation inherited authorization");
  require(gate.wait_for_decision(first, clock.now() + 1s) == PairingDecision::kAuthorized,
      "authorized waiter did not observe decision");
}

void expiry_revoke_and_shutdown_are_fail_closed() {
  FakeClock clock;
  FakeMaterial material;
  PairingGate gate(clock, material, {5s});
  const PeerBinding first = binding();
  require(gate.begin(first).code == BeginPairingCode::kPending, "expiry setup failed");
  clock.advance(6s);
  require(!gate.pending().has_value(), "expired pairing remained visible");
  require(!gate.authorized(first), "expired pairing remained authorized");

  const PeerBinding second = binding("connection-2");
  const auto next = gate.begin(second);
  require(next.code == BeginPairingCode::kPending, "new peer could not pair after expiry");
  require(gate.reject(second.connection_id, next.fingerprint), "reject failed");
  require(gate.wait_for_decision(second, clock.now() + 1s) == PairingDecision::kRejected,
      "rejection was not observable");
  gate.revoke(second);
  require(gate.wait_for_decision(second, clock.now() + 1s) == PairingDecision::kRevoked,
      "revocation was not observable");
  require(gate.begin(binding("connection-3")).code == BeginPairingCode::kPending,
      "revoked connection permanently blocked new pairing");
  gate.shutdown();
  require(gate.begin(binding("connection-4")).code == BeginPairingCode::kShuttingDown,
      "shutdown admitted a new peer");
}

void waiting_wakes_on_user_confirmation() {
  FakeClock clock;
  FakeMaterial material;
  PairingGate gate(clock, material, {30s});
  const PeerBinding peer = binding();
  const auto pending = gate.begin(peer);
  PairingDecision decision = PairingDecision::kUnknown;
  std::thread waiter([&] {
    decision = gate.wait_for_decision(peer, clock.now() + 20s);
  });
  require(gate.confirm(peer.connection_id, pending.fingerprint),
      "concurrent confirmation failed");
  waiter.join();
  require(decision == PairingDecision::kAuthorized, "waiter did not wake authorized");
}

}  // namespace

int main() {
  authorization_is_exact_and_single_pending();
  expiry_revoke_and_shutdown_are_fail_closed();
  waiting_wakes_on_user_confirmation();
  std::cout << "pairing_gate_test: PASS\n";
  return 0;
}
