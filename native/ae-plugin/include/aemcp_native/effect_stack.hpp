#pragma once

#include <cstddef>
#include <optional>
#include <span>

namespace aemcp::native {

// Locate one inserted stack value without relying on opaque AEGP handle
// addresses. Ambiguous transitions are rejected because installed-effect keys
// identify effect types rather than individual effect instances.
template <typename T>
[[nodiscard]] inline std::optional<std::size_t> locate_unique_insertion(
    std::span<const T> before,
    std::span<const T> after,
    const T& inserted_value) noexcept {
  if (after.size() != before.size() + 1U) return std::nullopt;
  std::optional<std::size_t> found;
  for (std::size_t candidate = 0; candidate < after.size(); ++candidate) {
    if (after[candidate] != inserted_value) continue;
    bool matches = true;
    for (std::size_t before_index = 0;
         matches && before_index < before.size();
         ++before_index) {
      const std::size_t after_index = before_index < candidate
          ? before_index : before_index + 1U;
      matches = before[before_index] == after[after_index];
    }
    if (!matches) continue;
    if (found.has_value()) return std::nullopt;
    found = candidate;
  }
  return found;
}

}  // namespace aemcp::native
