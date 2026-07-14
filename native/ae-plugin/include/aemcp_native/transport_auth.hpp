#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <string>

namespace aemcp::native {

inline constexpr std::size_t kTransportAuthPrefaceBytes = 24;
inline constexpr std::size_t kTransportAuthPendingBytes = 57;
inline constexpr std::size_t kTransportAuthDecisionBytes = 49;

struct TransportAuthPreface {
  std::array<std::uint8_t, 16> client_nonce{};
};

struct TransportAuthPending {
  std::string fingerprint;
  std::chrono::milliseconds expires_in{0};
  std::string host_instance_id;
};

enum class TransportAuthDecisionCode : std::uint8_t {
  kAuthorized = 1,
  kRejected = 2,
  kExpired = 3,
  kRevoked = 4,
  kShuttingDown = 5,
};

struct TransportAuthDecision {
  TransportAuthDecisionCode code{TransportAuthDecisionCode::kRejected};
  std::string session_id;
  std::uint32_t session_generation{0};
};

[[nodiscard]] std::array<std::uint8_t, kTransportAuthPrefaceBytes>
serialize_auth_preface(const TransportAuthPreface& value);
[[nodiscard]] bool parse_auth_preface(
    const std::array<std::uint8_t, kTransportAuthPrefaceBytes>& bytes,
    TransportAuthPreface& output) noexcept;

[[nodiscard]] std::array<std::uint8_t, kTransportAuthPendingBytes>
serialize_auth_pending(const TransportAuthPending& value);
[[nodiscard]] bool parse_auth_pending(
    const std::array<std::uint8_t, kTransportAuthPendingBytes>& bytes,
    TransportAuthPending& output) noexcept;

[[nodiscard]] std::array<std::uint8_t, kTransportAuthDecisionBytes>
serialize_auth_decision(const TransportAuthDecision& value);
[[nodiscard]] bool parse_auth_decision(
    const std::array<std::uint8_t, kTransportAuthDecisionBytes>& bytes,
    TransportAuthDecision& output) noexcept;

}  // namespace aemcp::native
