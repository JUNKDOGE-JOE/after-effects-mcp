#pragma once

#include <algorithm>
#include <cstddef>
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

struct AePathVertexMutationPlan {
  bool open_before_resize{false};
  std::size_t retained_vertices{0};
  std::size_t delete_count{0};
  std::size_t create_count{0};
  bool close_after_resize{false};
};

// A vector shape cannot be reduced through an empty closed outline on AE 26.3.
// Preserve the common prefix, resize only the difference, and change topology
// on the side of the resize that keeps every intermediate outline valid.
[[nodiscard]] inline AePathVertexMutationPlan plan_ae_path_vertex_mutation(
    std::size_t current_vertices,
    bool current_open,
    std::size_t target_vertices,
    bool target_closed) noexcept {
  const std::size_t retained = std::min(current_vertices, target_vertices);
  return AePathVertexMutationPlan{
      !current_open && !target_closed,
      retained,
      current_vertices - retained,
      target_vertices - retained,
      current_open && target_closed,
  };
}

}  // namespace aemcp::native
