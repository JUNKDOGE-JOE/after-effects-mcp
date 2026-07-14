#pragma once

#include "aemcp_native/pairing_gate.hpp"

#include <string>

namespace aemcp::native {

class MacPairingMaterialSource final : public PairingMaterialSource {
 public:
  [[nodiscard]] PairingMaterial create() override;
};

// Returns a lower-case RFC 4122 version-4 UUID using SecRandomCopyBytes.
// Failure throws; callers must fail closed rather than substituting time/PID.
[[nodiscard]] std::string secure_uuid_v4();

}  // namespace aemcp::native
