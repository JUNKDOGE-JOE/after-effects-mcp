#pragma once

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>

namespace aemcp::native {

using PairingTimePoint = std::chrono::steady_clock::time_point;

struct PeerBinding {
  std::int32_t pid{0};
  std::uint32_t pid_version{0};
  std::uint32_t uid{0};
  std::uint32_t audit_session{0};
  std::string connection_id;
  std::string host_instance_id;

  [[nodiscard]] bool valid() const noexcept;
  friend bool operator==(const PeerBinding&, const PeerBinding&) = default;
};

struct PairingMaterial {
  std::array<std::uint8_t, 32> capability{};
  std::string fingerprint;
};

class PairingMaterialSource {
 public:
  virtual ~PairingMaterialSource() = default;
  [[nodiscard]] virtual PairingMaterial create() = 0;
};

class PairingGateClock {
 public:
  virtual ~PairingGateClock() = default;
  [[nodiscard]] virtual PairingTimePoint now() const noexcept = 0;
};

class SystemPairingGateClock final : public PairingGateClock {
 public:
  [[nodiscard]] PairingTimePoint now() const noexcept override;
};

enum class BeginPairingCode {
  kPending,
  kBusy,
  kInvalidBinding,
  kMaterialFailure,
  kShuttingDown,
};

struct BeginPairingResult {
  BeginPairingCode code{BeginPairingCode::kInvalidBinding};
  std::string fingerprint;
  std::chrono::milliseconds expires_in{0};
};

enum class PairingDecision {
  kAuthorized,
  kRejected,
  kExpired,
  kRevoked,
  kUnknown,
  kShuttingDown,
};

struct PendingPairingSnapshot {
  PeerBinding binding;
  std::string fingerprint;
  std::chrono::milliseconds expires_in{0};
};

struct PairingGateConfig {
  std::chrono::milliseconds pending_ttl{30000};
};

// PairingGate is the in-memory user-presence boundary. A peer must already have
// passed OS/process authentication before begin() is called. The 256-bit
// capability never leaves this object; only its short display fingerprint is
// exposed. Authorization is bound to the exact PeerBinding and is revoked on
// disconnect, expiry, peer generation change, or shutdown.
class PairingGate final {
 public:
  PairingGate(
      PairingGateClock& clock,
      PairingMaterialSource& material_source,
      PairingGateConfig config = {});
  PairingGate(const PairingGate&) = delete;
  PairingGate& operator=(const PairingGate&) = delete;
  ~PairingGate();

  [[nodiscard]] BeginPairingResult begin(const PeerBinding& binding);
  [[nodiscard]] std::optional<PendingPairingSnapshot> pending();

  // Called only from the AEGP-owned menu/UI after the user has compared the
  // displayed fingerprint with the ae-mcp panel.
  [[nodiscard]] bool confirm(
      const std::string& connection_id,
      const std::string& fingerprint);
  [[nodiscard]] bool reject(
      const std::string& connection_id,
      const std::string& fingerprint);

  [[nodiscard]] PairingDecision wait_for_decision(
      const PeerBinding& binding,
      PairingTimePoint deadline);
  [[nodiscard]] bool authorized(const PeerBinding& binding);

  void revoke(const PeerBinding& binding);
  void revoke_connection(const std::string& connection_id);
  void shutdown();

 private:
  enum class State { kPending, kAuthorized, kRejected, kRevoked };

  struct Entry {
    PeerBinding binding;
    std::array<std::uint8_t, 32> capability{};
    std::string fingerprint;
    PairingTimePoint expires_at{};
    State state{State::kPending};
  };

  void expire_locked(PairingTimePoint now);
  void clear_locked() noexcept;
  [[nodiscard]] static bool valid_fingerprint(const std::string& value) noexcept;

  PairingGateClock& clock_;
  PairingMaterialSource& material_source_;
  const PairingGateConfig config_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::optional<Entry> entry_;
  bool shutting_down_{false};
};

}  // namespace aemcp::native
