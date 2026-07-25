#pragma once

#include <string>

namespace aemcp::native {

// Returns a lower-case RFC 4122 version-4 UUID using SecRandomCopyBytes.
// Failure throws; callers must fail closed rather than substituting time/PID.
[[nodiscard]] std::string secure_uuid_v4();

}  // namespace aemcp::native
