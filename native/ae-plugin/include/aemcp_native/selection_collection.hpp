#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <type_traits>
#include <unordered_set>
#include <utility>
#include <vector>

namespace aemcp::native {

// Owns the AEGP selection collection without exposing Adobe SDK types to the
// portable test target. Production injects CollectionSuite2; tests inject a
// fake suite with the same one-call ownership contract.
template <typename Handle, typename Disposer>
class OwnedSelectionCollection final {
 public:
  OwnedSelectionCollection(Handle handle, Disposer disposer)
      : handle_(handle), disposer_(std::move(disposer)) {
    static_assert(
        std::is_nothrow_invocable_v<Disposer&, Handle>,
        "selection collection disposal must not throw");
  }

  ~OwnedSelectionCollection() noexcept {
    if (handle_ != Handle{}) {
      const Handle owned = std::exchange(handle_, Handle{});
      disposer_(owned);
    }
  }

  OwnedSelectionCollection(const OwnedSelectionCollection&) = delete;
  OwnedSelectionCollection& operator=(const OwnedSelectionCollection&) = delete;
  OwnedSelectionCollection(OwnedSelectionCollection&&) = delete;
  OwnedSelectionCollection& operator=(OwnedSelectionCollection&&) = delete;

  [[nodiscard]] Handle get() const noexcept { return handle_; }

 private:
  Handle handle_{};
  Disposer disposer_;
};

template <typename Handle, typename Disposer>
OwnedSelectionCollection(Handle, Disposer)
    -> OwnedSelectionCollection<Handle, Disposer>;

enum class SelectionCollectionEntryKind {
  kLayer,
  kNonLayer,
};

// opaque_layer is an AEGP_LayerH converted to uintptr_t in production. This
// keeps the exact filter/order implementation testable without redistributing
// Adobe SDK headers in public CI.
struct SelectionCollectionEntry {
  SelectionCollectionEntryKind kind{SelectionCollectionEntryKind::kNonLayer};
  std::uintptr_t opaque_layer{0};
  std::int64_t layer_id{0};
  std::uint64_t stack_index{0};
};

struct NormalizedSelectedLayers {
  bool ok{false};
  std::string error;
  std::vector<SelectionCollectionEntry> layers;
};

[[nodiscard]] inline NormalizedSelectedLayers normalize_selected_layer_collection(
    std::vector<SelectionCollectionEntry> entries) {
  NormalizedSelectedLayers result;
  std::unordered_set<std::int64_t> layer_ids;
  std::size_t kept = 0;
  for (std::size_t index = 0; index < entries.size(); ++index) {
    const SelectionCollectionEntry entry = entries[index];
    if (entry.kind != SelectionCollectionEntryKind::kLayer) continue;
    if (entry.opaque_layer == 0 || entry.layer_id == 0 || entry.stack_index == 0) {
      result.error = "After Effects returned an invalid selected layer";
      return result;
    }
    if (!layer_ids.insert(entry.layer_id).second) continue;
    entries[kept++] = entry;
  }
  entries.resize(kept);
  std::sort(
      entries.begin(), entries.end(),
      [](const SelectionCollectionEntry& left, const SelectionCollectionEntry& right) {
        return left.stack_index < right.stack_index;
      });
  for (std::size_t index = 1; index < entries.size(); ++index) {
    if (entries[index - 1].stack_index == entries[index].stack_index) {
      result.error = "selected layers have conflicting stack indexes";
      return result;
    }
  }
  result.ok = true;
  result.layers = std::move(entries);
  return result;
}

}  // namespace aemcp::native
