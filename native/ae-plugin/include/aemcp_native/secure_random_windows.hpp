#pragma once

#include <string>

namespace aemcp::native {

// Returns a lower-case RFC 4122 version-4 UUID using BCryptGenRandom
// (BCRYPT_USE_SYSTEM_PREFERRED_RNG). Failure throws; callers must fail closed
// rather than substituting time/PID material.
[[nodiscard]] std::string secure_uuid_v4();

}  // namespace aemcp::native
