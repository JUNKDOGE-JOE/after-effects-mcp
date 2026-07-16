#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace aemcp::native {

// AEGP_EffectRefH is an opaque pointer-to-pointer handle. Separate handles for
// the same applied effect can have different outer addresses while their
// pointees identify the same live effect instance. Keep that identity local to
// one main-thread call and require exactly one matching stack entry.
[[nodiscard]] inline std::optional<std::size_t> locate_unique_effect_identity(
    std::uintptr_t applied_identity,
    std::span<const std::uintptr_t> stack_identities) noexcept {
  if (applied_identity == 0) return std::nullopt;
  std::optional<std::size_t> found;
  for (std::size_t index = 0; index < stack_identities.size(); ++index) {
    if (stack_identities[index] != applied_identity) continue;
    if (found.has_value()) return std::nullopt;
    found = index;
  }
  return found;
}

}  // namespace aemcp::native
