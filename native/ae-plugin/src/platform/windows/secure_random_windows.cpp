#include "aemcp_native/secure_random_windows.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <array>
#include <cstdio>
#include <stdexcept>

namespace aemcp::native {

std::string secure_uuid_v4() {
  std::array<std::uint8_t, 16> bytes{};
  const NTSTATUS status = BCryptGenRandom(
      nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (!BCRYPT_SUCCESS(status)) {
    throw std::runtime_error("BCryptGenRandom failed for endpoint uuid");
  }
  bytes[6] = static_cast<std::uint8_t>((bytes[6] & 0x0fU) | 0x40U);
  bytes[8] = static_cast<std::uint8_t>((bytes[8] & 0x3fU) | 0x80U);
  std::array<char, 37> text{};
  std::snprintf(
      text.data(), text.size(),
      "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6],
      bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13],
      bytes[14], bytes[15]);
  return std::string(text.data(), text.size() - 1);
}

}  // namespace aemcp::native
