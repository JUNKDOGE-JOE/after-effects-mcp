#include "aemcp_native/secure_random_macos.hpp"

#include <Security/SecRandom.h>

#include <array>
#include <cstdint>
#include <stdexcept>

namespace aemcp::native {
namespace {

constexpr char kUpperHex[] = "0123456789ABCDEF";
constexpr char kLowerHex[] = "0123456789abcdef";

template <std::size_t Size>
void fill_random(std::array<std::uint8_t, Size>& bytes) {
  if (SecRandomCopyBytes(kSecRandomDefault, bytes.size(), bytes.data()) != errSecSuccess) {
    throw std::runtime_error("secure random generation failed");
  }
}

}  // namespace

PairingMaterial MacPairingMaterialSource::create() {
  PairingMaterial material;
  fill_random(material.capability);
  material.fingerprint.reserve(9);
  for (std::size_t index = 0; index < 4; ++index) {
    if (index == 2) material.fingerprint.push_back('-');
    material.fingerprint.push_back(kUpperHex[material.capability[index] >> 4]);
    material.fingerprint.push_back(kUpperHex[material.capability[index] & 0x0f]);
  }
  return material;
}

std::string secure_uuid_v4() {
  std::array<std::uint8_t, 16> bytes{};
  fill_random(bytes);
  bytes[6] = static_cast<std::uint8_t>((bytes[6] & 0x0f) | 0x40);
  bytes[8] = static_cast<std::uint8_t>((bytes[8] & 0x3f) | 0x80);
  std::string output;
  output.reserve(36);
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    if (index == 4 || index == 6 || index == 8 || index == 10) output.push_back('-');
    output.push_back(kLowerHex[bytes[index] >> 4]);
    output.push_back(kLowerHex[bytes[index] & 0x0f]);
  }
  return output;
}

}  // namespace aemcp::native
