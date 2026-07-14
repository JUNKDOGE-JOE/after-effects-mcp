#include "aemcp_native/transport_auth.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <stdexcept>
#include <string_view>

namespace aemcp::native {
namespace {

constexpr std::array<std::uint8_t, 8> kPrefaceMagic{
    'A', 'E', 'M', 'C', 'P', '-', 'A', '1'};
constexpr std::array<std::uint8_t, 8> kPendingMagic{
    'A', 'E', 'M', 'C', 'P', '-', 'P', '1'};
constexpr std::array<std::uint8_t, 8> kDecisionMagic{
    'A', 'E', 'M', 'C', 'P', '-', 'D', '1'};
constexpr std::string_view kNilUuid = "00000000-0000-0000-0000-000000000000";

bool uuid_v4(std::string_view value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-'
      || value[18] != '-' || value[23] != '-' || value[14] != '4'
      || !(value[19] == '8' || value[19] == '9'
          || value[19] == 'a' || value[19] == 'b')) {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    const unsigned char character = static_cast<unsigned char>(value[index]);
    if (!((character >= '0' && character <= '9')
          || (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return true;
}

bool fingerprint(std::string_view value) {
  if (value.size() != 9 || value[4] != '-') return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 4) continue;
    const unsigned char character = static_cast<unsigned char>(value[index]);
    if (!((character >= '0' && character <= '9')
          || (character >= 'A' && character <= 'F'))) {
      return false;
    }
  }
  return true;
}

void write_u32(std::uint8_t* output, std::uint32_t value) {
  output[0] = static_cast<std::uint8_t>(value >> 24);
  output[1] = static_cast<std::uint8_t>(value >> 16);
  output[2] = static_cast<std::uint8_t>(value >> 8);
  output[3] = static_cast<std::uint8_t>(value);
}

std::uint32_t read_u32(const std::uint8_t* input) {
  return (static_cast<std::uint32_t>(input[0]) << 24)
      | (static_cast<std::uint32_t>(input[1]) << 16)
      | (static_cast<std::uint32_t>(input[2]) << 8)
      | static_cast<std::uint32_t>(input[3]);
}

template <std::size_t Size>
bool starts_with(
    const std::array<std::uint8_t, Size>& bytes,
    const std::array<std::uint8_t, 8>& magic) {
  return std::equal(magic.begin(), magic.end(), bytes.begin());
}

}  // namespace

std::array<std::uint8_t, kTransportAuthPrefaceBytes> serialize_auth_preface(
    const TransportAuthPreface& value) {
  if (std::all_of(value.client_nonce.begin(), value.client_nonce.end(),
          [](std::uint8_t byte) { return byte == 0; })) {
    throw std::invalid_argument("transport client nonce cannot be all zero");
  }
  std::array<std::uint8_t, kTransportAuthPrefaceBytes> output{};
  std::copy(kPrefaceMagic.begin(), kPrefaceMagic.end(), output.begin());
  std::copy(value.client_nonce.begin(), value.client_nonce.end(), output.begin() + 8);
  return output;
}

bool parse_auth_preface(
    const std::array<std::uint8_t, kTransportAuthPrefaceBytes>& bytes,
    TransportAuthPreface& output) noexcept {
  if (!starts_with(bytes, kPrefaceMagic)) return false;
  TransportAuthPreface parsed;
  std::copy(bytes.begin() + 8, bytes.end(), parsed.client_nonce.begin());
  if (std::all_of(parsed.client_nonce.begin(), parsed.client_nonce.end(),
          [](std::uint8_t byte) { return byte == 0; })) {
    return false;
  }
  output = parsed;
  return true;
}

std::array<std::uint8_t, kTransportAuthPendingBytes> serialize_auth_pending(
    const TransportAuthPending& value) {
  if (!fingerprint(value.fingerprint) || !uuid_v4(value.host_instance_id)
      || value.expires_in < std::chrono::seconds(1)
      || value.expires_in > std::chrono::minutes(2)) {
    throw std::invalid_argument("invalid transport pending message");
  }
  std::array<std::uint8_t, kTransportAuthPendingBytes> output{};
  std::copy(kPendingMagic.begin(), kPendingMagic.end(), output.begin());
  std::copy(value.fingerprint.begin(), value.fingerprint.end(), output.begin() + 8);
  write_u32(output.data() + 17, static_cast<std::uint32_t>(value.expires_in.count()));
  std::copy(value.host_instance_id.begin(), value.host_instance_id.end(), output.begin() + 21);
  return output;
}

bool parse_auth_pending(
    const std::array<std::uint8_t, kTransportAuthPendingBytes>& bytes,
    TransportAuthPending& output) noexcept {
  if (!starts_with(bytes, kPendingMagic)) return false;
  TransportAuthPending parsed;
  parsed.fingerprint.assign(reinterpret_cast<const char*>(bytes.data() + 8), 9);
  parsed.expires_in = std::chrono::milliseconds(read_u32(bytes.data() + 17));
  parsed.host_instance_id.assign(reinterpret_cast<const char*>(bytes.data() + 21), 36);
  if (!fingerprint(parsed.fingerprint) || !uuid_v4(parsed.host_instance_id)
      || parsed.expires_in < std::chrono::seconds(1)
      || parsed.expires_in > std::chrono::minutes(2)) {
    return false;
  }
  output = std::move(parsed);
  return true;
}

std::array<std::uint8_t, kTransportAuthDecisionBytes> serialize_auth_decision(
    const TransportAuthDecision& value) {
  const bool authorized = value.code == TransportAuthDecisionCode::kAuthorized;
  if ((authorized && (!uuid_v4(value.session_id) || value.session_generation == 0))
      || (!authorized && (!value.session_id.empty() || value.session_generation != 0))) {
    throw std::invalid_argument("invalid transport auth decision");
  }
  const auto raw_code = static_cast<std::uint8_t>(value.code);
  if (raw_code < static_cast<std::uint8_t>(TransportAuthDecisionCode::kAuthorized)
      || raw_code > static_cast<std::uint8_t>(TransportAuthDecisionCode::kShuttingDown)) {
    throw std::invalid_argument("unknown transport auth decision");
  }
  std::array<std::uint8_t, kTransportAuthDecisionBytes> output{};
  std::copy(kDecisionMagic.begin(), kDecisionMagic.end(), output.begin());
  output[8] = raw_code;
  const std::string_view session = authorized ? std::string_view(value.session_id) : kNilUuid;
  std::copy(session.begin(), session.end(), output.begin() + 9);
  write_u32(output.data() + 45, value.session_generation);
  return output;
}

bool parse_auth_decision(
    const std::array<std::uint8_t, kTransportAuthDecisionBytes>& bytes,
    TransportAuthDecision& output) noexcept {
  if (!starts_with(bytes, kDecisionMagic)) return false;
  const std::uint8_t raw_code = bytes[8];
  if (raw_code < static_cast<std::uint8_t>(TransportAuthDecisionCode::kAuthorized)
      || raw_code > static_cast<std::uint8_t>(TransportAuthDecisionCode::kShuttingDown)) {
    return false;
  }
  const std::string session(reinterpret_cast<const char*>(bytes.data() + 9), 36);
  const std::uint32_t generation = read_u32(bytes.data() + 45);
  const auto code = static_cast<TransportAuthDecisionCode>(raw_code);
  if (code == TransportAuthDecisionCode::kAuthorized) {
    if (!uuid_v4(session) || generation == 0) return false;
    output = {code, session, generation};
  } else {
    if (session != kNilUuid || generation != 0) return false;
    output = {code, {}, 0};
  }
  return true;
}

}  // namespace aemcp::native
