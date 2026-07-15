#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>

namespace aemcp::native {

struct ProjectObservation final {
  // AE may reuse both opaque handles and numeric root IDs across close/open.
  // The path is an internal discriminator for observed saved/untitled changes;
  // none of these values are exposed through a locator.
  std::uintptr_t project_identity{0};
  std::uintptr_t root_item_identity{0};
  std::int64_t root_item_id{0};
  std::string project_path;

  bool operator==(const ProjectObservation&) const = default;
};

class ProjectEpochTracker final {
 public:
  static constexpr std::uint64_t kMaxGeneration = 9'007'199'254'740'991ULL;

  [[nodiscard]] bool observe(ProjectObservation observation) {
    if (observation.project_identity == 0 || observation.root_item_identity == 0) {
      throw std::invalid_argument("project identity is unavailable");
    }
    if (present_ && observation == observation_) return false;
    if (generation_ >= kMaxGeneration) {
      throw std::runtime_error("project locator generation exhausted");
    }
    present_ = true;
    observation_ = std::move(observation);
    ++generation_;
    return true;
  }

  [[nodiscard]] bool close() noexcept {
    if (!present_) return false;
    present_ = false;
    observation_ = {};
    return true;
  }

  [[nodiscard]] std::uint64_t generation() const noexcept { return generation_; }

 private:
  bool present_{false};
  ProjectObservation observation_;
  std::uint64_t generation_{0};
};

}  // namespace aemcp::native
