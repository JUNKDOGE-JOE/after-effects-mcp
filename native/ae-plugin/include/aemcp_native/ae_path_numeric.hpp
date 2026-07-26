#pragma once

#include <cmath>

namespace aemcp::native {

// AE 26.3 can quantize a negative relative PF_PathVertex tangent by exactly
// one 16.16 fixed-point quantum between AEGP_SetMaskOutlineVertexInfo and
// AEGP_GetMaskOutlineVertexInfo. Treat only that host-resolution difference
// as equivalent when validating an immediate path write readback.
inline constexpr double kAePathReadbackQuantum = 1.0 / 65536.0;

[[nodiscard]] inline bool ae_path_values_equal(
    double left, double right) noexcept {
  return std::isfinite(left) && std::isfinite(right)
      && std::abs(left - right) <= kAePathReadbackQuantum;
}

}  // namespace aemcp::native
