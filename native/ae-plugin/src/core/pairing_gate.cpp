#include "aemcp_native/pairing_gate.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <utility>

namespace aemcp::native {

namespace {

void zeroize(std::array<std::uint8_t, 32>& bytes) noexcept {
  volatile std::uint8_t* output = bytes.data();
  for (std::size_t index = 0; index < bytes.size(); ++index) output[index] = 0;
}

}  // namespace

bool PeerBinding::valid() const noexcept {
  if (pid <= 1 || pid_version == 0 || connection_id.size() < 8
      || connection_id.size() > 64 || host_instance_id.size() != 36) {
    return false;
  }
  const auto safe_identifier = [](const std::string& value) {
    return std::all_of(value.begin(), value.end(), [](unsigned char character) {
      return std::isalnum(character) != 0 || character == '-';
    });
  };
  return safe_identifier(connection_id) && safe_identifier(host_instance_id);
}

PairingTimePoint SystemPairingGateClock::now() const noexcept {
  return std::chrono::steady_clock::now();
}

PairingGate::PairingGate(
    PairingGateClock& clock,
    PairingMaterialSource& material_source,
    PairingGateConfig config)
    : clock_(clock), material_source_(material_source), config_(config) {
  if (config_.pending_ttl < std::chrono::seconds(5)
      || config_.pending_ttl > std::chrono::minutes(2)) {
    throw std::invalid_argument("invalid pairing TTL");
  }
}

PairingGate::~PairingGate() {
  shutdown();
}

BeginPairingResult PairingGate::begin(const PeerBinding& binding) {
  if (!binding.valid()) return {BeginPairingCode::kInvalidBinding, {}, {}};
  const PairingTimePoint now = clock_.now();
  std::unique_lock lock(mutex_);
  expire_locked(now);
  if (shutting_down_) return {BeginPairingCode::kShuttingDown, {}, {}};
  if (entry_.has_value()
      && (entry_->state == State::kRejected || entry_->state == State::kRevoked)) {
    clear_locked();
  }
  if (entry_.has_value()) return {BeginPairingCode::kBusy, {}, {}};

  PairingMaterial material;
  try {
    // Material generation is deliberately serialized with admission: two
    // concurrent peers can never both become the pending connection.
    material = material_source_.create();
  } catch (...) {
    return {BeginPairingCode::kMaterialFailure, {}, {}};
  }
  if (!valid_fingerprint(material.fingerprint)
      || std::all_of(material.capability.begin(), material.capability.end(),
          [](std::uint8_t byte) { return byte == 0; })) {
    zeroize(material.capability);
    return {BeginPairingCode::kMaterialFailure, {}, {}};
  }

  Entry entry;
  entry.binding = binding;
  entry.capability = material.capability;
  entry.fingerprint = std::move(material.fingerprint);
  entry.expires_at = now + config_.pending_ttl;
  entry_ = std::move(entry);
  zeroize(material.capability);
  changed_.notify_all();
  return {
      BeginPairingCode::kPending,
      entry_->fingerprint,
      std::chrono::duration_cast<std::chrono::milliseconds>(entry_->expires_at - now),
  };
}

std::optional<PendingPairingSnapshot> PairingGate::pending() {
  const PairingTimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  expire_locked(now);
  if (!entry_.has_value() || entry_->state != State::kPending) return std::nullopt;
  return PendingPairingSnapshot{
      entry_->binding,
      entry_->fingerprint,
      std::chrono::duration_cast<std::chrono::milliseconds>(entry_->expires_at - now),
  };
}

bool PairingGate::confirm(
    const std::string& connection_id,
    const std::string& fingerprint) {
  std::lock_guard lock(mutex_);
  expire_locked(clock_.now());
  if (shutting_down_ || !entry_.has_value() || entry_->state != State::kPending
      || entry_->binding.connection_id != connection_id
      || entry_->fingerprint != fingerprint) {
    return false;
  }
  entry_->state = State::kAuthorized;
  // The capability's only purpose was to make this pending authorization
  // unguessable and single-use. Session material is generated independently.
  zeroize(entry_->capability);
  changed_.notify_all();
  return true;
}

bool PairingGate::reject(
    const std::string& connection_id,
    const std::string& fingerprint) {
  std::lock_guard lock(mutex_);
  expire_locked(clock_.now());
  if (!entry_.has_value() || entry_->state != State::kPending
      || entry_->binding.connection_id != connection_id
      || entry_->fingerprint != fingerprint) {
    return false;
  }
  entry_->state = State::kRejected;
  zeroize(entry_->capability);
  changed_.notify_all();
  return true;
}

PairingDecision PairingGate::wait_for_decision(
    const PeerBinding& binding,
    PairingTimePoint deadline) {
  std::unique_lock lock(mutex_);
  for (;;) {
    const PairingTimePoint now = clock_.now();
    expire_locked(now);
    if (shutting_down_) return PairingDecision::kShuttingDown;
    if (!entry_.has_value() || entry_->binding != binding) return PairingDecision::kUnknown;
    switch (entry_->state) {
      case State::kAuthorized: return PairingDecision::kAuthorized;
      case State::kRejected: return PairingDecision::kRejected;
      case State::kRevoked: return PairingDecision::kRevoked;
      case State::kPending: break;
    }
    if (now >= deadline || now >= entry_->expires_at) {
      clear_locked();
      changed_.notify_all();
      return PairingDecision::kExpired;
    }
    const PairingTimePoint wake_at = std::min(deadline, entry_->expires_at);
    changed_.wait_until(lock, wake_at);
  }
}

bool PairingGate::authorized(const PeerBinding& binding) {
  std::lock_guard lock(mutex_);
  expire_locked(clock_.now());
  return !shutting_down_ && entry_.has_value()
      && entry_->state == State::kAuthorized && entry_->binding == binding;
}

void PairingGate::revoke(const PeerBinding& binding) {
  std::lock_guard lock(mutex_);
  if (!entry_.has_value() || entry_->binding != binding) return;
  entry_->state = State::kRevoked;
  zeroize(entry_->capability);
  changed_.notify_all();
}

void PairingGate::revoke_connection(const std::string& connection_id) {
  std::lock_guard lock(mutex_);
  if (!entry_.has_value() || entry_->binding.connection_id != connection_id) return;
  entry_->state = State::kRevoked;
  zeroize(entry_->capability);
  changed_.notify_all();
}

void PairingGate::shutdown() {
  std::lock_guard lock(mutex_);
  if (shutting_down_) return;
  shutting_down_ = true;
  clear_locked();
  changed_.notify_all();
}

void PairingGate::expire_locked(PairingTimePoint now) {
  if (entry_.has_value() && entry_->state == State::kPending
      && now >= entry_->expires_at) {
    clear_locked();
    changed_.notify_all();
  }
}

void PairingGate::clear_locked() noexcept {
  if (entry_.has_value()) zeroize(entry_->capability);
  entry_.reset();
}

bool PairingGate::valid_fingerprint(const std::string& value) noexcept {
  if (value.size() != 9 || value[4] != '-') return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 4) continue;
    const unsigned char character = static_cast<unsigned char>(value[index]);
    if (!(std::isdigit(character) != 0
          || (character >= 'A' && character <= 'F'))) {
      return false;
    }
  }
  return true;
}

}  // namespace aemcp::native
