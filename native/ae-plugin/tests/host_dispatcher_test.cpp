#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/project_epoch.hpp"
#include "aemcp_native/selection_collection.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace std::chrono_literals;
using aemcp::native::CancelCode;
using aemcp::native::CancelResult;
using aemcp::native::BoundedPageBudget;
using aemcp::native::DispatcherConfig;
using aemcp::native::EnqueueCode;
using aemcp::native::HostApi;
using aemcp::native::HostBitDepthReadResult;
using aemcp::native::HostBitDepthWriteResult;
using aemcp::native::HostCompositionLayersResult;
using aemcp::native::HostCompositionTimeResult;
using aemcp::native::HostCompositionTimeWriteResult;
using aemcp::native::HostDispatcher;
using aemcp::native::HostLayerPropertyWriteResult;
using aemcp::native::HostProjectItemsResult;
using aemcp::native::HostReadResult;
using aemcp::native::ObjectLocator;
using aemcp::native::ProjectEpochTracker;
using aemcp::native::ProjectObservation;
using aemcp::native::Request;
using aemcp::native::RouteRevocationResult;
using aemcp::native::TimePoint;
using aemcp::native::kProjectBitDepthReadCapability;
using aemcp::native::kProjectBitDepthSetCapability;
using aemcp::native::kCompositionLayersListCapability;
using aemcp::native::kCompositionSelectedLayersListCapability;
using aemcp::native::kCompositionTimeReadCapability;
using aemcp::native::kCompositionTimeSetCapability;
using aemcp::native::kProjectItemsListCapability;
using aemcp::native::kProjectSummaryCapability;
using aemcp::native::kLayerPropertySetCapability;
using aemcp::native::json_encoded_string_size;
using aemcp::native::canonical_seconds_rational;
using aemcp::native::normalize_selected_layer_collection;
using aemcp::native::NormalizedSelectedLayers;
using aemcp::native::OwnedSelectionCollection;
using aemcp::native::SelectionCollectionEntryKind;
using aemcp::native::select_effective_layer_name;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

void bounded_page_budget_counts_codec_escaping_and_stops_before_overflow() {
  const std::string escaped = std::string("A\"\n") + static_cast<char>(1);
  require(json_encoded_string_size(escaped) == 13,
      "page budget did not mirror JSON string escaping");

  BoundedPageBudget budget(10, 20);
  require(budget.try_reserve(6) && budget.used_bytes() == 16,
      "page budget rejected a fitting entry");
  require(!budget.try_reserve(5) && budget.used_bytes() == 16,
      "page budget overflow changed its committed size");
  require(budget.try_reserve(4) && budget.used_bytes() == 20
          && !budget.try_reserve(1),
      "page budget boundary was not exact");

  BoundedPageBudget invalid_initial(21, 20);
  require(!invalid_initial.try_reserve(0),
      "page budget accepted an already oversized envelope");
}

void effective_layer_name_uses_sdk_source_fallback() {
  require(select_effective_layer_name("Custom Layer", "Source Handle", "Source Item")
              == std::optional<std::string>{"Custom Layer"},
      "custom layer name did not take precedence over the source name");
  require(select_effective_layer_name("", "Source Handle", "Source Item")
              == std::optional<std::string>{"Source Handle"},
      "empty layer override did not fall back to the source handle name");
  require(select_effective_layer_name("", "", "SOLID")
              == std::optional<std::string>{"SOLID"},
      "empty layer and source handles suppressed the source Item name fallback");
  require(select_effective_layer_name(std::nullopt, std::nullopt, "Source Item")
              == std::optional<std::string>{"Source Item"},
      "absent GetLayerName handles did not fall back to the source Item name");
  require(select_effective_layer_name("", std::nullopt, std::nullopt)
              == std::optional<std::string>{""},
      "valid empty layer name was confused with a missing handle");
  require(!select_effective_layer_name(
              std::nullopt, std::nullopt, std::nullopt).has_value(),
      "missing layer, source, and source Item handles produced a name");
}

void selected_collection_ownership_and_mixed_filter_are_portable_tested() {
  struct FakeCollectionSuite {
    std::uintptr_t expected{0};
    int dispose_calls{0};

    void dispose(std::uintptr_t collection) noexcept {
      if (collection == expected) ++dispose_calls;
    }
  } suite;
  suite.expected = 17;
  const auto run_scope = [&](bool fail_early) {
    OwnedSelectionCollection owner(
        suite.expected,
        [&suite](std::uintptr_t collection) noexcept { suite.dispose(collection); });
    require(owner.get() == suite.expected, "owned selection collection lost its handle");
    if (fail_early) return false;
    return true;
  };
  require(run_scope(false) && suite.dispose_calls == 1,
      "selection collection was not disposed on the success path");
  require(!run_scope(true) && suite.dispose_calls == 2,
      "selection collection was not disposed on an early failure path");
  {
    OwnedSelectionCollection empty(
        std::uintptr_t{0},
        [&suite](std::uintptr_t collection) noexcept { suite.dispose(collection); });
    require(empty.get() == 0, "empty selection collection acquired a handle");
  }
  require(suite.dispose_calls == 2,
      "empty selection collection called the fake suite disposer");

  NormalizedSelectedLayers mixed = normalize_selected_layer_collection({
      {SelectionCollectionEntryKind::kNonLayer, 91, 7, 4},
      {SelectionCollectionEntryKind::kLayer, 11, 101, 3},
      {SelectionCollectionEntryKind::kNonLayer, 92, 101, 3},
      {SelectionCollectionEntryKind::kLayer, 12, 102, 1},
      {SelectionCollectionEntryKind::kLayer, 13, 101, 9},
  });
  require(mixed.ok && mixed.layers.size() == 2
          && mixed.layers[0].opaque_layer == 12 && mixed.layers[0].stack_index == 1
          && mixed.layers[1].opaque_layer == 11 && mixed.layers[1].stack_index == 3,
      "mixed selection entries were not filtered, deduplicated, and stack-sorted");

  NormalizedSelectedLayers conflicting = normalize_selected_layer_collection({
      {SelectionCollectionEntryKind::kLayer, 11, 101, 2},
      {SelectionCollectionEntryKind::kLayer, 12, 102, 2},
  });
  require(!conflicting.ok && conflicting.layers.empty()
          && conflicting.error == "selected layers have conflicting stack indexes",
      "selection normalization accepted conflicting stack indexes");
}

void composition_time_rational_is_exact_and_overflow_safe() {
  require(canonical_seconds_rational(3003, 1000) == "3003/1000",
      "composition time rational changed an already reduced value");
  require(canonical_seconds_rational(-6, 4) == "-3/2"
          && canonical_seconds_rational(12, 4) == "3"
          && canonical_seconds_rational(0, std::numeric_limits<std::uint32_t>::max())
              == "0",
      "composition time rational was not canonical");
  require(canonical_seconds_rational(
              std::numeric_limits<std::int32_t>::min(), 2)
          == "-1073741824",
      "INT32_MIN composition time overflowed during reduction");
  bool rejected_zero_scale = false;
  try {
    (void)canonical_seconds_rational(1, 0);
  } catch (const std::invalid_argument&) {
    rejected_zero_scale = true;
  }
  require(rejected_zero_scale, "zero composition time scale was accepted");
}

void project_epoch_fences_reused_aegp_handles() {
  ProjectEpochTracker tracker;
  const ProjectObservation saved{
      0x1000U, 0x2000U, 1, "/private/tmp/fixture.aep"};
  require(tracker.observe(saved) && tracker.generation() == 1,
      "first project observation did not establish generation one");
  require(!tracker.observe(saved) && tracker.generation() == 1,
      "an unchanged project observation rotated its generation");

  require(tracker.present() && tracker.invalidate() && tracker.generation() == 2,
      "a command invalidation did not rotate the active project generation");
  require(!tracker.observe(saved) && tracker.generation() == 2,
      "command invalidation discarded the current project observation");
  require(tracker.invalidate() && tracker.generation() == 3,
      "a second command invalidation did not remain monotonic");

  const ProjectObservation empty{
      saved.project_identity, saved.root_item_identity, saved.root_item_id, {}};
  require(tracker.observe(empty) && tracker.generation() == 4,
      "saved-to-empty project path transition was hidden by reused AEGP handles");
  require(tracker.observe(saved) && tracker.generation() == 5,
      "empty-to-reopened project path transition did not rotate its generation");

  const ProjectObservation replaced_root{
      saved.project_identity, 0x3000U, saved.root_item_id, saved.project_path};
  require(tracker.observe(replaced_root) && tracker.generation() == 6,
      "a replaced root AEGP handle did not rotate the project generation");
  require(tracker.close() && !tracker.close(),
      "project close observation was not idempotent");
  require(!tracker.present() && !tracker.invalidate() && tracker.generation() == 6,
      "a command invalidation rotated an absent project generation");
  require(tracker.observe(replaced_root) && tracker.generation() == 7,
      "reopening the same observed handles after close reused the old generation");
}

class FakeClock final : public aemcp::native::Clock {
 public:
  [[nodiscard]] TimePoint now() const noexcept override {
    return TimePoint{} + std::chrono::milliseconds(current_ms_.load());
  }
  void advance(std::chrono::milliseconds amount) { current_ms_.fetch_add(amount.count()); }

 private:
  std::atomic<std::int64_t> current_ms_{3600000};
};

class FakeHost final : public HostApi {
 public:
  FakeHost(FakeClock& clock, std::thread::id expected_thread)
      : clock_(clock), expected_thread_(expected_thread) {}

  [[nodiscard]] HostReadResult read_project_summary(TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_, "HostApi ran off owner thread");
    observed_deadline = work_deadline;
    ++calls;
    clock_.advance(delay);
    if (clock_.now() >= work_deadline) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "fake host budget elapsed");
    }
    if (!error_code.empty()) return HostReadResult::failure(error_code, "fake host error");
    return HostReadResult::success({true, "fixture.aep", 3});
  }

  [[nodiscard]] HostBitDepthReadResult read_project_bit_depth(
      TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_, "read HostApi ran off owner thread");
    observed_deadline = work_deadline;
    ++bit_depth_read_calls;
    clock_.advance(delay);
    if (clock_.now() >= work_deadline) {
      return HostBitDepthReadResult::failure(
          "DEADLINE_EXCEEDED", "fake read budget elapsed");
    }
    if (!bit_depth_read_error_code.empty()) {
      return HostBitDepthReadResult::failure(
          bit_depth_read_error_code, "fake bit-depth read error");
    }
    return HostBitDepthReadResult::success({current_bits_per_channel});
  }

  [[nodiscard]] HostBitDepthWriteResult set_project_bit_depth(
      std::int32_t target_depth, TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_, "write HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_target_depth = target_depth;
    ++write_calls;
    clock_.advance(delay);
    if (clock_.now() >= work_deadline) {
      return HostBitDepthWriteResult::failure(
          "DEADLINE_EXCEEDED", "fake write budget elapsed");
    }
    if (!write_error_code.empty()) {
      return HostBitDepthWriteResult::failure(
          write_error_code, "fake write error", write_error_field);
    }
    const std::int32_t before = current_bits_per_channel;
    current_bits_per_channel = target_depth;
    return HostBitDepthWriteResult::success({true, before, target_depth});
  }

  [[nodiscard]] HostProjectItemsResult list_project_items(
      const aemcp::native::ProjectItemsQuery& query, TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_, "items HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_items_query = query;
    ++project_items_calls;
    aemcp::native::ProjectItemsPage page;
    page.project_locator = locator("project", "77777777-7777-4777-8777-777777777777");
    page.total = 1;
    page.offset = query.offset;
    page.limit = query.limit;
    if (mismatch_project_page) ++page.offset;
    if (query.offset == 0) {
      page.items.push_back({
          locator("composition", "66666666-6666-4666-8666-666666666666"),
          "Fixture Comp",
          "composition",
          page.project_locator});
    }
    return HostProjectItemsResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionLayersResult list_composition_layers(
      const aemcp::native::CompositionLayersQuery& query,
      TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_, "layers HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_layers_query = query;
    ++composition_layers_calls;
    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = "Fixture Comp";
    page.total = 1;
    page.offset = query.offset;
    page.limit = query.limit;
    if (mismatch_composition_page) {
      page.composition_locator.object_id =
          "99999999-9999-4999-8999-999999999999";
    }
    if (query.offset == 0) {
      page.layers.push_back({
          locator("layer", "88888888-8888-4888-8888-888888888888"),
          1,
          "Fixture Layer",
          "text",
          true,
          false,
          true,
          std::nullopt,
          std::nullopt});
    }
    return HostCompositionLayersResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionLayersResult list_selected_composition_layers(
      const aemcp::native::CompositionLayersQuery& query,
      TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_,
        "selected layers HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_selected_layers_query = query;
    ++composition_selected_layers_calls;
    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = "Fixture Comp";
    page.total = 2;
    page.offset = query.offset;
    page.limit = query.limit;
    if (mismatch_selected_composition_page) {
      page.composition_locator.object_id =
          "99999999-9999-4999-8999-999999999999";
    }
    if (query.offset == 0) {
      page.layers.push_back({
          locator("layer", "88888888-8888-4888-8888-888888888888"),
          1,
          "First Selected Layer",
          "text",
          true,
          false,
          true,
          std::nullopt,
          std::nullopt});
      page.layers.push_back({
          locator("layer", "99999999-9999-4999-8999-999999999999"),
          3,
          "Third Selected Layer",
          "shape",
          true,
          false,
          false,
          std::nullopt,
          std::nullopt});
    }
    return HostCompositionLayersResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionTimeResult read_composition_time(
      const aemcp::native::CompositionTimeQuery& query,
      TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_,
        "composition time HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_time_query = query;
    ++composition_time_calls;
    if (!composition_time_error_code.empty()) {
      return HostCompositionTimeResult::failure(
          composition_time_error_code,
          "fake composition time error",
          composition_time_error_field);
    }
    aemcp::native::CompositionTimeRead result;
    result.composition_locator = query.composition_locator;
    result.current_time.value = composition_time_value;
    result.current_time.scale = composition_time_scale;
    result.current_time.seconds_rational = canonical_seconds_rational(
        result.current_time.value, result.current_time.scale);
    if (mismatch_composition_time) {
      result.current_time.seconds_rational = "1/2";
    }
    return HostCompositionTimeResult::success(std::move(result));
  }

  [[nodiscard]] HostCompositionTimeWriteResult set_composition_time(
      const aemcp::native::CompositionTimeSetCommand& command,
      TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_,
        "composition time write HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_time_set_command = command;
    ++composition_time_write_calls;
    if (!composition_time_write_error_code.empty()) {
      return HostCompositionTimeWriteResult::failure(
          composition_time_write_error_code,
          "fake composition time write error",
          composition_time_write_error_field);
    }
    aemcp::native::CompositionTimeChanged changed;
    changed.composition_locator = command.composition_locator;
    changed.before_time = {
        composition_time_value,
        composition_time_scale,
        canonical_seconds_rational(composition_time_value, composition_time_scale)};
    changed.after_time = command.target_time;
    if (mismatch_composition_time_write) {
      changed.after_time = {2, 1, "2"};
    }
    composition_time_value = changed.after_time.value;
    composition_time_scale = changed.after_time.scale;
    return HostCompositionTimeWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostLayerPropertyWriteResult set_layer_property(
      const aemcp::native::LayerPropertySetCommand& command,
      TimePoint work_deadline) override {
    require(std::this_thread::get_id() == expected_thread_,
        "layer property write HostApi ran off owner thread");
    observed_deadline = work_deadline;
    observed_property_command = command;
    ++layer_property_write_calls;
    if (!layer_property_write_error_code.empty()) {
      return HostLayerPropertyWriteResult::failure(
          layer_property_write_error_code,
          "fake layer property write error",
          "params.arguments.value");
    }
    aemcp::native::LayerPropertyChanged changed;
    changed.layer_locator = command.layer_locator;
    changed.property_locator = command.property_locator;
    changed.value_type = "one-d";
    changed.before_value = aemcp::native::LayerPropertyScalarValue{"25"};
    changed.after_value = command.value;
    if (const auto* requested =
            std::get_if<aemcp::native::LayerPropertyScalarValue>(&command.value);
        requested != nullptr && requested->value == "4e1") {
      changed.after_value = aemcp::native::LayerPropertyScalarValue{"40"};
    }
    return HostLayerPropertyWriteResult::success(std::move(changed));
  }

  [[nodiscard]] static ObjectLocator locator(std::string kind, std::string object_id) {
    return {
        std::move(kind),
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
        "44444444-4444-4444-8444-444444444444",
        8,
        std::move(object_id)};
  }

  FakeClock& clock_;
  std::thread::id expected_thread_;
  std::chrono::milliseconds delay{0};
  TimePoint observed_deadline{};
  std::string error_code;
  std::string bit_depth_read_error_code;
  std::string write_error_code;
  std::string write_error_field;
  std::string composition_time_error_code;
  std::string composition_time_error_field;
  std::string composition_time_write_error_code;
  std::string composition_time_write_error_field;
  std::string layer_property_write_error_code;
  std::int32_t current_bits_per_channel{8};
  std::int32_t observed_target_depth{0};
  int calls{0};
  int bit_depth_read_calls{0};
  int write_calls{0};
  int project_items_calls{0};
  int composition_layers_calls{0};
  int composition_selected_layers_calls{0};
  int composition_time_calls{0};
  int composition_time_write_calls{0};
  int layer_property_write_calls{0};
  std::int32_t composition_time_value{3003};
  std::uint32_t composition_time_scale{1000};
  bool mismatch_project_page{false};
  bool mismatch_composition_page{false};
  bool mismatch_selected_composition_page{false};
  bool mismatch_composition_time{false};
  bool mismatch_composition_time_write{false};
  aemcp::native::ProjectItemsQuery observed_items_query;
  aemcp::native::CompositionLayersQuery observed_layers_query;
  aemcp::native::CompositionLayersQuery observed_selected_layers_query;
  aemcp::native::CompositionTimeQuery observed_time_query;
  aemcp::native::CompositionTimeSetCommand observed_time_set_command;
  aemcp::native::LayerPropertySetCommand observed_property_command;
};

class BlockingHost final : public HostApi {
 public:
  explicit BlockingHost(std::thread::id expected_thread)
      : expected_thread_(expected_thread) {}

  [[nodiscard]] HostReadResult read_project_summary(TimePoint) override {
    require(std::this_thread::get_id() == expected_thread_, "blocking host ran off owner thread");
    std::unique_lock lock(mutex_);
    entered_ = true;
    condition_.notify_all();
    require(condition_.wait_for(lock, 2s, [&] { return released_; }),
        "blocking host timed out waiting for worker");
    return HostReadResult::success({true, "running.aep", 7});
  }

  void wait_until_entered() {
    std::unique_lock lock(mutex_);
    require(condition_.wait_for(lock, 2s, [&] { return entered_; }),
        "worker timed out waiting for blocking host");
  }

  void release() {
    std::lock_guard lock(mutex_);
    released_ = true;
    condition_.notify_all();
  }

 private:
  std::thread::id expected_thread_;
  std::mutex mutex_;
  std::condition_variable condition_;
  bool entered_{false};
  bool released_{false};
};

Request request(
    FakeClock& clock,
    std::string id,
    std::chrono::milliseconds ttl = 100ms,
    std::string route_id = {},
    std::uint64_t session_generation = 0) {
  return {
      std::move(id),
      std::string(kProjectSummaryCapability),
      clock.now() + ttl,
      std::move(route_id),
      session_generation,
  };
}

Request bit_depth_read_request(
    FakeClock& clock,
    std::string id,
    std::chrono::milliseconds ttl = 100ms,
    std::string route_id = {},
    std::uint64_t session_generation = 0) {
  return {
      std::move(id),
      std::string(kProjectBitDepthReadCapability),
      clock.now() + ttl,
      std::move(route_id),
      session_generation,
  };
}

Request bit_depth_set_request(
    FakeClock& clock,
    std::string id,
    std::string key = "bit-depth-intent-001",
    std::int32_t target_depth = 16,
    std::string fingerprint = std::string(64, 'a'),
    std::chrono::milliseconds ttl = 100ms,
    std::string route_id = {},
    std::uint64_t session_generation = 0) {
  return {
      std::move(id),
      std::string(kProjectBitDepthSetCapability),
      clock.now() + ttl,
      std::move(route_id),
      session_generation,
      target_depth,
      std::move(key),
      std::move(fingerprint),
  };
}

Request layer_property_set_request(
    FakeClock& clock,
    std::string id,
    std::string key = "layer-property-intent-001",
    std::string fingerprint = std::string(64, 'e'),
    std::string value = "40") {
  Request result;
  result.request_id = std::move(id);
  result.capability_id = std::string(kLayerPropertySetCapability);
  result.deadline = clock.now() + 100ms;
  result.idempotency_key = std::move(key);
  result.arguments_fingerprint_sha256 = std::move(fingerprint);
  result.host_instance_id = "22222222-2222-4222-8222-222222222222";
  result.session_id = "11111111-1111-4111-8111-111111111111";
  result.layer_locator = FakeHost::locator(
      "layer", "88888888-8888-4888-8888-888888888888");
  result.property_locator = FakeHost::locator(
      "stream", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  result.property_value = aemcp::native::LayerPropertyScalarValue{std::move(value)};
  return result;
}

Request project_items_request(
    FakeClock& clock,
    std::string id,
    std::uint64_t offset = 0,
    std::uint16_t limit = 25,
    std::optional<ObjectLocator> project_locator = std::nullopt) {
  return {
      std::move(id),
      std::string(kProjectItemsListCapability),
      clock.now() + 100ms,
      "route-items",
      7,
      0,
      {},
      {},
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      offset,
      limit,
      std::move(project_locator)};
}

Request composition_layers_request(
    FakeClock& clock,
    std::string id,
    ObjectLocator composition_locator,
    std::uint64_t offset = 0,
    std::uint16_t limit = 25) {
  return {
      std::move(id),
      std::string(kCompositionLayersListCapability),
      clock.now() + 100ms,
      "route-layers",
      7,
      0,
      {},
      {},
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      offset,
      limit,
      std::nullopt,
      std::move(composition_locator)};
}

Request composition_selected_layers_request(
    FakeClock& clock,
    std::string id,
    ObjectLocator composition_locator,
    std::uint64_t offset = 0,
    std::uint16_t limit = 25) {
  return {
      std::move(id),
      std::string(kCompositionSelectedLayersListCapability),
      clock.now() + 100ms,
      "route-selected-layers",
      7,
      0,
      {},
      {},
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      offset,
      limit,
      std::nullopt,
      std::move(composition_locator)};
}

Request composition_time_request(
    FakeClock& clock,
    std::string id,
    ObjectLocator composition_locator) {
  return {
      std::move(id),
      std::string(kCompositionTimeReadCapability),
      clock.now() + 100ms,
      "route-time",
      7,
      0,
      {},
      {},
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      0,
      0,
      std::nullopt,
      std::move(composition_locator)};
}

Request composition_time_set_request(
    FakeClock& clock,
    std::string id,
    ObjectLocator composition_locator,
    std::string key = "composition-time-intent-001",
    std::string fingerprint = std::string(64, 'f'),
    aemcp::native::CompositionCurrentTime target = {1, 1, "1"}) {
  Request result;
  result.request_id = std::move(id);
  result.capability_id = std::string(kCompositionTimeSetCapability);
  result.deadline = clock.now() + 100ms;
  result.route_id = "route-time-set";
  result.session_generation = 7;
  result.idempotency_key = std::move(key);
  result.arguments_fingerprint_sha256 = std::move(fingerprint);
  result.host_instance_id = "22222222-2222-4222-8222-222222222222";
  result.session_id = "11111111-1111-4111-8111-111111111111";
  result.composition_locator = std::move(composition_locator);
  result.target_time = std::move(target);
  return result;
}

DispatcherConfig config(
    std::size_t queue,
    std::size_t tasks,
    std::chrono::milliseconds budget,
    std::size_t outbound = 64,
    std::size_t tombstones = 128,
    std::chrono::milliseconds tombstone_ttl = 60s,
    std::size_t route_fences = 128,
    std::size_t idempotency_entries = 128) {
  return {
      queue,
      tasks,
      budget,
      outbound,
      tombstones,
      tombstone_ttl,
      route_fences,
      idempotency_entries,
  };
}

void project_graph_reads_validate_arguments_and_dispatch_on_owner_thread() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms));
  FakeHost host(clock, owner);
  const ObjectLocator project = FakeHost::locator(
      "project", "77777777-7777-4777-8777-777777777777");
  const ObjectLocator composition = FakeHost::locator(
      "composition", "66666666-6666-4666-8666-666666666666");

  require(dispatcher.enqueue(project_items_request(clock, "items-first"))
          .code == EnqueueCode::kAccepted,
      "first project-items page was rejected");
  require(dispatcher.enqueue(project_items_request(clock, "items-next", 1, 25, project))
          .code == EnqueueCode::kAccepted,
      "continued project-items page was rejected");
  require(dispatcher.enqueue(project_items_request(clock, "items-refresh", 0, 25, project))
          .code == EnqueueCode::kAccepted,
      "offset-zero project-items refresh rejected its optional locator");
  require(dispatcher.enqueue(composition_layers_request(
          clock, "layers-first", composition, 0, 50)).code == EnqueueCode::kAccepted,
      "composition-layers page was rejected");

  const auto missing_project = dispatcher.enqueue(
      project_items_request(clock, "items-missing-locator", 1));
  require(missing_project.code == EnqueueCode::kInvalidRequest
          && missing_project.error_code == "INVALID_ARGUMENT",
      "non-zero project offset did not require its project locator");
  const auto excessive_limit = dispatcher.enqueue(
      composition_layers_request(clock, "layers-limit", composition, 0, 51));
  require(excessive_limit.code == EnqueueCode::kInvalidRequest,
      "composition layers accepted a limit above 50");
  ObjectLocator wrong_session = composition;
  wrong_session.session_id = "33333333-3333-4333-8333-333333333333";
  const auto stale_session = dispatcher.enqueue(
      composition_layers_request(clock, "layers-session", wrong_session));
  require(stale_session.code == EnqueueCode::kInvalidRequest
          && stale_session.error_code == "STALE_LOCATOR",
      "dispatcher did not reject a locator from another session");

  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 4
          && batch.completions[0].ok && batch.completions[1].ok
          && batch.completions[2].ok && batch.completions[3].ok,
      "project graph reads did not complete");
  require(host.project_items_calls == 3 && host.composition_layers_calls == 1,
      "project graph reads did not enter their exact host adapter methods");
  require(batch.completions[0].project_items_result.items.size() == 1
          && batch.completions[0].project_items_result.items[0].type == "composition",
      "project item result was not preserved");
  require(batch.completions[3].composition_layers_result.layers.size() == 1
          && batch.completions[3].composition_layers_result.layers[0].locked,
      "composition layer flags were not preserved");

  host.mismatch_project_page = true;
  host.mismatch_composition_page = true;
  require(dispatcher.enqueue(project_items_request(clock, "items-mismatch"))
          .code == EnqueueCode::kAccepted,
      "mismatched project page setup was rejected before the host call");
  require(dispatcher.enqueue(composition_layers_request(
          clock, "layers-mismatch", composition)).code == EnqueueCode::kAccepted,
      "mismatched composition page setup was rejected before the host call");
  const auto mismatched = dispatcher.drain(host);
  require(mismatched.completions.size() == 2
          && !mismatched.completions[0].ok
          && mismatched.completions[0].error_code == "CAPABILITY_FAILED"
          && !mismatched.completions[1].ok
          && mismatched.completions[1].error_code == "CAPABILITY_FAILED",
      "dispatcher signed a host page that was not bound to its invoke arguments");
}

void selected_layers_read_is_closed_main_thread_bound_and_request_verified() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms));
  FakeHost host(clock, owner);
  const ObjectLocator composition = FakeHost::locator(
      "composition", "66666666-6666-4666-8666-666666666666");

  require(dispatcher.enqueue(composition_selected_layers_request(
          clock, "selected-layers", composition, 0, 25)).code
          == EnqueueCode::kAccepted,
      "valid selected-layer page was rejected");
  ObjectLocator wrong_kind = composition;
  wrong_kind.kind = "item";
  const auto invalid_kind = dispatcher.enqueue(composition_selected_layers_request(
      clock, "selected-kind", wrong_kind));
  require(invalid_kind.code == EnqueueCode::kInvalidRequest
          && invalid_kind.error_field == "params.arguments.compositionLocator",
      "selected-layer read accepted a non-composition locator");
  const auto excessive_limit = dispatcher.enqueue(composition_selected_layers_request(
      clock, "selected-limit", composition, 0, 51));
  require(excessive_limit.code == EnqueueCode::kInvalidRequest,
      "selected-layer read accepted a limit above 50");

  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && host.composition_selected_layers_calls == 1,
      "selected-layer read did not dispatch exactly once on the owner thread");
  const auto& result = batch.completions[0].composition_selected_layers_result;
  require(result.composition_locator == composition && result.layers.size() == 2
          && result.layers[0].stack_index == 1
          && result.layers[1].stack_index == 3
          && host.observed_selected_layers_query.composition_locator == composition,
      "selected-layer read lost its locator or non-contiguous stack order");

  host.mismatch_selected_composition_page = true;
  require(dispatcher.enqueue(composition_selected_layers_request(
          clock, "selected-mismatch", composition)).code == EnqueueCode::kAccepted,
      "selected-layer mismatch setup was rejected before the host call");
  const auto mismatched = dispatcher.drain(host);
  require(mismatched.completions.size() == 1
          && !mismatched.completions[0].ok
          && mismatched.completions[0].error_code == "CAPABILITY_FAILED",
      "dispatcher signed a selected-layer page not bound to its request");
}

void composition_time_read_is_closed_main_thread_bound_and_verified() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms));
  FakeHost host(clock, owner);
  const ObjectLocator composition = FakeHost::locator(
      "composition", "66666666-6666-4666-8666-666666666666");

  require(dispatcher.enqueue(composition_time_request(
          clock, "time-read", composition)).code == EnqueueCode::kAccepted,
      "valid composition time read was rejected");

  ObjectLocator wrong_session = composition;
  wrong_session.session_id = "33333333-3333-4333-8333-333333333333";
  const auto stale = dispatcher.enqueue(composition_time_request(
      clock, "time-stale", wrong_session));
  require(stale.code == EnqueueCode::kInvalidRequest
          && stale.error_code == "STALE_LOCATOR"
          && stale.error_field == "params.arguments.compositionLocator",
      "composition time did not fail closed on a cross-session locator");

  ObjectLocator wrong_kind = composition;
  wrong_kind.kind = "item";
  const auto invalid_kind = dispatcher.enqueue(composition_time_request(
      clock, "time-kind", wrong_kind));
  require(invalid_kind.code == EnqueueCode::kInvalidRequest
          && invalid_kind.error_code == "INVALID_ARGUMENT"
          && invalid_kind.error_field == "params.arguments.compositionLocator",
      "composition time accepted a non-composition locator");

  Request unexpected_page = composition_time_request(clock, "time-page", composition);
  unexpected_page.limit = 1;
  const auto invalid_page = dispatcher.enqueue(std::move(unexpected_page));
  require(invalid_page.code == EnqueueCode::kInvalidRequest
          && invalid_page.error_field == "params.arguments",
      "composition time accepted pagination arguments outside its contract");

  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && host.composition_time_calls == 1,
      "composition time did not dispatch exactly once on the owner thread");
  const auto& result = batch.completions[0].composition_time_result;
  require(result.composition_locator == composition
          && result.current_time.value == 3003
          && result.current_time.scale == 1000
          && result.current_time.seconds_rational == "3003/1000"
          && host.observed_time_query.composition_locator == composition,
      "composition time lost its locator or exact rational result");

  host.mismatch_composition_time = true;
  require(dispatcher.enqueue(composition_time_request(
          clock, "time-mismatch", composition)).code == EnqueueCode::kAccepted,
      "composition time mismatch setup was rejected");
  const auto mismatch = dispatcher.drain(host);
  require(mismatch.completions.size() == 1
          && !mismatch.completions[0].ok
          && mismatch.completions[0].error_code == "CAPABILITY_FAILED",
      "dispatcher signed a non-canonical composition time result");

  host.mismatch_composition_time = false;
  host.composition_time_error_code = "STALE_LOCATOR";
  host.composition_time_error_field = "params.arguments.compositionLocator";
  require(dispatcher.enqueue(composition_time_request(
          clock, "time-host-stale", composition)).code == EnqueueCode::kAccepted,
      "composition time host error setup was rejected");
  const auto failed = dispatcher.drain(host);
  require(failed.completions.size() == 1
          && failed.completions[0].error_code == "STALE_LOCATOR"
          && failed.completions[0].error_field
              == "params.arguments.compositionLocator",
      "composition time host error lost its typed locator field");
}

void composition_time_write_is_typed_main_thread_bound_and_idempotent() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms));
  FakeHost host(clock, owner);
  const ObjectLocator composition = FakeHost::locator(
      "composition", "66666666-6666-4666-8666-666666666666");

  Request invalid_time = composition_time_set_request(
      clock, "time-set-invalid", composition, "composition-time-intent-invalid");
  invalid_time.target_time.seconds_rational = "2";
  const auto invalid = dispatcher.enqueue(std::move(invalid_time));
  require(invalid.code == EnqueueCode::kInvalidRequest
          && invalid.error_field == "params.arguments",
      "non-canonical composition target reached HostApi");

  ObjectLocator wrong_session = composition;
  wrong_session.session_id = "33333333-3333-4333-8333-333333333333";
  const auto stale = dispatcher.enqueue(composition_time_set_request(
      clock, "time-set-stale", wrong_session, "composition-time-intent-stale"));
  require(stale.code == EnqueueCode::kInvalidRequest
          && stale.error_code == "STALE_LOCATOR"
          && stale.error_field == "params.arguments.compositionLocator",
      "cross-session composition time write reached HostApi");

  require(dispatcher.enqueue(composition_time_set_request(
      clock, "time-set-1", composition)).code == EnqueueCode::kAccepted,
      "valid composition time write was rejected");
  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && host.composition_time_write_calls == 1,
      "composition time write did not run exactly once on the owner thread");
  const auto& changed = batch.completions[0].composition_time_change_result;
  require(changed.changed && changed.composition_locator == composition
          && changed.before_time.value == 3003
          && changed.before_time.scale == 1000
          && changed.before_time.seconds_rational == "3003/1000"
          && changed.after_time.value == 1 && changed.after_time.scale == 1
          && changed.after_time.seconds_rational == "1"
          && host.observed_time_set_command.composition_locator == composition,
      "composition time write lost exact before/after or locator evidence");

  const auto duplicate = dispatcher.enqueue(composition_time_set_request(
      clock, "time-set-duplicate", composition));
  require(duplicate.code == EnqueueCode::kDuplicateRequest
          && duplicate.error_field == "params.arguments.idempotencyKey"
          && host.composition_time_write_calls == 1,
      "successful composition time intent was allowed to mutate twice");

  host.mismatch_composition_time_write = true;
  require(dispatcher.enqueue(composition_time_set_request(
      clock,
      "time-set-mismatch",
      composition,
      "composition-time-intent-002",
      std::string(64, 'a'),
      {3, 1, "3"})).code == EnqueueCode::kAccepted,
      "composition time mismatch setup was rejected before HostApi");
  const auto mismatch = dispatcher.drain(host);
  require(mismatch.completions.size() == 1
          && mismatch.completions[0].error_code
              == "POSSIBLY_SIDE_EFFECTING_FAILURE",
      "unverified composition time write was mislabeled side-effect free");
}

void bit_depth_read_and_write_are_main_thread_bound_and_write_is_idempotent() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms, 16, 16, 10ms));
  FakeHost host(clock, owner);

  require(dispatcher.enqueue(bit_depth_read_request(
      clock, "read-1", 1s, "route-a", 1)).code == EnqueueCode::kAccepted,
      "valid project bit-depth read was rejected");
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "set-1", "bit-depth-intent-001", 16, std::string(64, 'a'),
      1s, "route-a", 1)).code == EnqueueCode::kAccepted,
      "valid project bit-depth write was rejected");
  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 2 && batch.completions[0].ok
          && batch.completions[1].ok,
      "project bit-depth operations did not complete");
  require(batch.completions[0].bit_depth_result.bits_per_channel == 8,
      "project bit-depth read lost its typed result");
  const auto& result = batch.completions[1].bit_depth_change_result;
  require(result.changed && result.before_bits_per_channel == 8
          && result.after_bits_per_channel == 16,
      "project bit-depth write lost its verified before/after result");
  require(host.calls == 0 && host.bit_depth_read_calls == 1
          && host.write_calls == 1 && host.observed_target_depth == 16,
      "project bit-depth operations used the wrong HostApi path");

  const auto same = dispatcher.enqueue(bit_depth_set_request(
      clock, "set-2", "bit-depth-intent-001", 16, std::string(64, 'a'),
      1s, "route-b", 1));
  require(same.code == EnqueueCode::kDuplicateRequest
          && same.error_field == "params.arguments.idempotencyKey",
      "same business intent crossed its process-lifetime fence");
  const auto different = dispatcher.enqueue(bit_depth_set_request(
      clock, "set-3", "bit-depth-intent-001", 32, std::string(64, 'b')));
  require(different.code == EnqueueCode::kDuplicateRequest
          && different.message.find("different arguments") != std::string::npos,
      "idempotency key was rebound to different arguments");
  require(host.write_calls == 1, "duplicate business intent reached HostApi");

  require(dispatcher.take_outbound().size() == 2,
      "project bit-depth results were not observable");
  clock.advance(11ms);
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "set-4", "bit-depth-intent-001", 16, std::string(64, 'a'),
      1s, "route-c", 9)).code == EnqueueCode::kDuplicateRequest,
      "terminal TTL or connection change evicted a successful business fence");
}

void bit_depth_write_releases_only_safe_failures_and_fails_closed_when_full() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms, 16, 16, 60s, 16, 2));
  FakeHost host(clock, owner);

  host.write_error_code = "PRECONDITION_FAILED";
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "safe-1", "bit-depth-intent-101", 16, std::string(64, 'a'))).code
      == EnqueueCode::kAccepted, "safe failure setup was rejected");
  auto batch = dispatcher.drain(host);
  require(batch.completions[0].error_code == "PRECONDITION_FAILED",
      "safe precondition failure changed type");
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "safe-2", "bit-depth-intent-101", 16, std::string(64, 'a'))).code
      == EnqueueCode::kAccepted, "safe failure did not release its business key");
  require(dispatcher.cancel({}, 0, "safe-2").code == CancelCode::kQueuedCancelled,
      "queued write cancellation failed");
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "safe-3", "bit-depth-intent-101", 16, std::string(64, 'a'))).code
      == EnqueueCode::kAccepted, "queued cancellation did not release its business key");
  require(dispatcher.cancel({}, 0, "safe-3").code == CancelCode::kQueuedCancelled,
      "second queued write cancellation failed");

  host.write_error_code = "POSSIBLY_SIDE_EFFECTING_FAILURE";
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "ambiguous-1", "bit-depth-intent-102", 32, std::string(64, 'b'))).code
      == EnqueueCode::kAccepted, "ambiguous write setup was rejected");
  batch = dispatcher.drain(host);
  require(batch.completions[0].error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE",
      "ambiguous write failure changed type");
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "ambiguous-2", "bit-depth-intent-102", 32, std::string(64, 'b'))).code
      == EnqueueCode::kDuplicateRequest,
      "ambiguous write key was allowed to mutate again");

  // Only the ambiguous fence consumes permanent capacity; commit one more and
  // prove a third key fails before HostApi rather than evicting either fence.
  host.write_error_code.clear();
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "success-1", "bit-depth-intent-103", 16, std::string(64, 'c'))).code
      == EnqueueCode::kAccepted, "second permanent fence setup failed");
  require(dispatcher.drain(host).completions[0].ok, "second permanent fence did not commit");
  const int calls_before_full = host.write_calls;
  const auto full = dispatcher.enqueue(bit_depth_set_request(
      clock, "full-1", "bit-depth-intent-104", 32, std::string(64, 'd')));
  require(full.code == EnqueueCode::kQueueFull
          && full.error_field == "params.arguments.idempotencyKey"
          && host.write_calls == calls_before_full,
      "full idempotency ledger did not fail closed before mutation");
}

void bit_depth_write_validates_before_dispatch_and_late_results_are_ambiguous() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);

  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "bad-key", "short", 16, std::string(64, 'a'))).code
      == EnqueueCode::kInvalidRequest, "short idempotency key reached dispatch");
  const auto invalid_target = dispatcher.enqueue(bit_depth_set_request(
      clock, "bad-target", "bit-depth-intent-201", 12, std::string(64, 'b')));
  require(invalid_target.code == EnqueueCode::kInvalidRequest
          && invalid_target.error_field == "params.arguments.targetDepth",
      "unsupported project bit depth reached dispatch");
  Request read_with_arguments = bit_depth_read_request(clock, "bad-read-args");
  read_with_arguments.target_depth = 8;
  require(dispatcher.enqueue(std::move(read_with_arguments)).code
      == EnqueueCode::kInvalidRequest,
      "project bit-depth read accepted write arguments");
  require(host.bit_depth_read_calls == 0 && host.write_calls == 0,
      "invalid project bit-depth arguments reached HostApi");

  host.write_error_code = "INVALID_ARGUMENT";
  host.write_error_field = "params.arguments.targetDepth";
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "no-op", "bit-depth-intent-202", 16, std::string(64, 'c'))).code
      == EnqueueCode::kAccepted, "host no-op setup was rejected");
  auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1
          && batch.completions[0].error_code == "INVALID_ARGUMENT"
          && batch.completions[0].error_field == "params.arguments.targetDepth",
      "host no-op validation did not preserve its typed targetDepth field");
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "no-op-retry", "bit-depth-intent-202", 16, std::string(64, 'c'))).code
      == EnqueueCode::kAccepted,
      "safe no-op rejection did not release its business key");
  require(dispatcher.cancel({}, 0, "no-op-retry").code
      == CancelCode::kQueuedCancelled, "no-op retry cleanup failed");

  host.write_error_code.clear();
  host.write_error_field.clear();
  host.delay = 3ms;
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "late-write", "bit-depth-intent-203", 32, std::string(64, 'd'),
      2ms)).code == EnqueueCode::kAccepted, "late write setup was rejected");
  batch = dispatcher.drain(host);
  require(batch.completions.size() == 1
          && batch.completions[0].error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
          && batch.completions[0].late_result_discarded,
      "late write was mislabeled as side-effect-free");
  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "late-write-2", "bit-depth-intent-203", 32, std::string(64, 'd'))).code
      == EnqueueCode::kDuplicateRequest,
      "late write key was allowed to mutate again");
}

void bit_depth_write_uses_request_deadline_and_stops_an_overrun_idle_batch() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(8, 8, 4ms));
  FakeHost host(clock, owner);
  host.delay = 5ms;

  require(dispatcher.enqueue(bit_depth_set_request(
      clock, "budgeted-write", "bit-depth-intent-301", 16,
      std::string(64, 'e'), 1s)).code == EnqueueCode::kAccepted,
      "over-budget atomic write setup was rejected");
  require(dispatcher.enqueue(bit_depth_read_request(
      clock, "after-budgeted-write", 1s)).code == EnqueueCode::kAccepted,
      "post-write queued read setup was rejected");

  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && batch.completions[0].bit_depth_change_result.changed
          && batch.completions[0].bit_depth_change_result.before_bits_per_channel == 8
          && batch.completions[0].bit_depth_change_result.after_bits_per_channel == 16,
      "idle budget mislabeled a verified atomic write as failed");
  require(batch.budget_exhausted && batch.remaining == 1
          && host.write_calls == 1 && host.bit_depth_read_calls == 0,
      "idle budget started another task after the atomic write completed");
  require(host.observed_deadline == clock.now() - host.delay + 1s,
      "atomic write did not receive the caller's request deadline");

  const auto stopped = dispatcher.shutdown();
  require(stopped.size() == 1 && stopped[0].error_code == "AE_SHUTTING_DOWN",
      "overrun idle batch cleanup lost the queued request");
}

void layer_property_write_is_typed_context_bound_and_idempotent() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms));
  FakeHost host(clock, owner);

  Request stale = layer_property_set_request(clock, "property-stale");
  stale.property_locator->generation += 1;
  const auto rejected = dispatcher.enqueue(std::move(stale));
  require(rejected.code == EnqueueCode::kInvalidRequest
          && rejected.error_code == "STALE_LOCATOR"
          && rejected.error_field == "params.arguments.propertyLocator",
      "cross-context property locator reached HostApi");

  require(dispatcher.enqueue(layer_property_set_request(
      clock, "property-set-1", "layer-property-intent-001",
      std::string(64, 'e'), "4e1")).code == EnqueueCode::kAccepted,
      "valid layer property mutation was rejected");
  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && host.layer_property_write_calls == 1,
      "layer property mutation did not run exactly once on the owner thread");
  const auto& changed = batch.completions[0].layer_property_change_result;
  require(changed.changed && changed.value_type == "one-d"
          && changed.after_value
              == aemcp::native::LayerPropertyValue{
                  aemcp::native::LayerPropertyScalarValue{"40"}}
          && host.observed_property_command.property_locator
              == *layer_property_set_request(clock, "ignored").property_locator,
      "layer property mutation lost its typed locator or before/after evidence");

  const auto duplicate = dispatcher.enqueue(layer_property_set_request(
      clock, "property-set-2"));
  require(duplicate.code == EnqueueCode::kDuplicateRequest
          && duplicate.error_field == "params.arguments.idempotencyKey",
      "successful layer property idempotency key was allowed to mutate again");
}

void worker_to_owner_dispatch_and_outbound_transfer() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  EnqueueCode result = EnqueueCode::kInvalidRequest;
  std::thread worker([&] {
    result = dispatcher.enqueue(request(clock, "worker-1", 100ms, "route-a", 7)).code;
  });
  worker.join();
  require(result == EnqueueCode::kAccepted, "worker enqueue was rejected");
  const auto batch = dispatcher.drain(host);
  require(!batch.wrong_thread && batch.completions.size() == 1, "owner drain failed");
  require(batch.completions[0].ok, "project summary did not succeed");
  require(batch.completions[0].result.item_count == 3, "project summary was changed");
  require(batch.completions[0].route_id == "route-a"
          && batch.completions[0].session_generation == 7,
      "drain completion lost its route generation");
  require(host.calls == 1, "host call count mismatch");
  require(host.observed_deadline == clock.now() - host.delay + 4ms,
      "host did not receive the idle work deadline");

  std::vector<aemcp::native::Completion> outbound;
  std::thread outbound_worker([&] { outbound = dispatcher.take_outbound(); });
  outbound_worker.join();
  require(outbound.size() == 1 && outbound[0].route_id == "route-a"
          && outbound[0].session_generation == 7 && outbound[0].ok,
      "worker did not receive typed routed outbound completion");
  require(dispatcher.outbound() == 0, "outbound transfer did not consume its item");
}

void admission_is_closed_and_bounded() {
  FakeClock clock;
  HostDispatcher dispatcher(std::this_thread::get_id(), clock, config(1, 1, 4ms));
  require(dispatcher.enqueue({
      "bad id", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "invalid request id was accepted");
  require(dispatcher.enqueue({
      "-leading", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "leading punctuation in request id was accepted");
  require(dispatcher.enqueue({
      "é", std::string(kProjectSummaryCapability), clock.now() + 1s}).code
      == EnqueueCode::kInvalidRequest, "non-ASCII request id was accepted");
  require(dispatcher.enqueue({"unknown", "native.raw", clock.now() + 1s}).code
      == EnqueueCode::kUnsupportedCapability, "unknown capability was accepted");
  require(dispatcher.enqueue(request(clock, "bad-route", 1s, {}, 1)).code
      == EnqueueCode::kInvalidRequest, "ambiguous legacy route was accepted");
  require(dispatcher.enqueue(request(clock, "bad-generation", 1s, "route", 0)).code
      == EnqueueCode::kInvalidRequest, "authenticated zero generation was accepted");
  require(dispatcher.enqueue(request(clock, "first")).code == EnqueueCode::kAccepted,
      "valid request was rejected");
  require(dispatcher.enqueue(request(clock, "first")).code
      == EnqueueCode::kDuplicateRequest, "duplicate request was accepted");
  require(dispatcher.enqueue(request(clock, "second")).code == EnqueueCode::kQueueFull,
      "queue bound was not enforced");
}

void request_identity_is_route_scoped_and_tombstones_expire() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 8, 8, 10ms));
  FakeHost host(clock, owner);

  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "first routed identity was rejected");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-b", 1)).code
      == EnqueueCode::kAccepted, "request id collided across routes");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 2)).code
      == EnqueueCode::kAccepted, "request id collided across route generations");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kDuplicateRequest, "exact active route identity was replayed");

  require(dispatcher.drain(host).completions.size() == 3, "routed requests did not drain");
  require(dispatcher.has_terminal("route-a", 1, "same"), "terminal tombstone missing");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kDuplicateRequest, "terminal request was replayed");
  require(dispatcher.take_outbound().size() == 3, "routed outbound count mismatch");
  clock.advance(11ms);
  require(!dispatcher.has_terminal("route-a", 1, "same"), "terminal TTL did not expire");
  require(dispatcher.enqueue(request(clock, "same", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "expired and observed tombstone still blocked admission");
  require(dispatcher.shutdown().size() == 1, "TTL test cleanup did not terminate request");
}

void terminal_tombstones_are_fifo_bounded() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(2, 1, 4ms, 4, 2, 1s));
  FakeHost host(clock, owner);
  for (const std::string id : {"one", "two", "three"}) {
    require(dispatcher.enqueue(request(clock, id, 1s, "route", 1)).code
        == EnqueueCode::kAccepted, "bounded tombstone setup enqueue failed");
    require(dispatcher.drain(host).completions.size() == 1,
        "bounded tombstone setup drain failed");
    require(dispatcher.take_outbound().size() == 1,
        "bounded tombstone setup outbound failed");
  }
  require(dispatcher.terminal_count() == 2, "terminal tombstone capacity was not enforced");
  require(!dispatcher.has_terminal("route", 1, "one")
          && dispatcher.has_terminal("route", 1, "two")
          && dispatcher.has_terminal("route", 1, "three"),
      "terminal tombstones were not evicted in deterministic FIFO order");
}

void wrong_thread_is_state_preserving() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "queued")).code == EnqueueCode::kAccepted,
      "setup enqueue failed");
  aemcp::native::DrainBatch worker_batch;
  std::thread worker([&] { worker_batch = dispatcher.drain(host); });
  worker.join();
  require(worker_batch.wrong_thread, "worker drain was not rejected");
  require(dispatcher.queued() == 1 && host.calls == 0, "wrong-thread drain changed state");
  bool shutdown_rejected = false;
  std::thread shutdown_worker([&] {
    try {
      static_cast<void>(dispatcher.shutdown());
    } catch (const std::logic_error&) {
      shutdown_rejected = true;
    }
  });
  shutdown_worker.join();
  require(shutdown_rejected && dispatcher.running() && dispatcher.queued() == 1,
      "wrong-thread shutdown violated owner lifecycle discipline");
  require(dispatcher.drain(host).completions.size() == 1, "owner could not recover request");
}

void deadlines_and_late_results_are_safe() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock);
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "expired", 1ms)).code == EnqueueCode::kAccepted,
      "expiring request setup failed");
  clock.advance(2ms);
  auto batch = dispatcher.drain(host);
  require(batch.completions[0].error_code == "DEADLINE_EXCEEDED" && host.calls == 0,
      "expired request reached HostApi");

  require(dispatcher.enqueue(request(clock, "late", 2ms)).code == EnqueueCode::kAccepted,
      "late request setup failed");
  host.delay = 3ms;
  batch = dispatcher.drain(host);
  require(batch.completions[0].error_code == "DEADLINE_EXCEEDED"
          && batch.completions[0].late_result_discarded,
      "late host result was not discarded");
  const auto outbound = dispatcher.take_outbound();
  require(outbound.size() == 2 && outbound[1].late_result_discarded,
      "deadline terminal evidence did not reach outbound");
}

void outbound_capacity_applies_backpressure_until_worker_takes() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 2));
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "one", 1s, "route", 1)).code
      == EnqueueCode::kAccepted, "first outbound setup failed");
  require(dispatcher.enqueue(request(clock, "two", 1s, "route", 1)).code
      == EnqueueCode::kAccepted, "second outbound setup failed");
  require(dispatcher.drain(host).completions.size() == 2, "outbound setup did not drain");
  require(dispatcher.outbound() == 2, "outbound queue was not populated");
  require(dispatcher.enqueue(request(clock, "three", 1s, "route", 1)).code
      == EnqueueCode::kQueueFull, "outbound saturation admitted hanging work");

  std::vector<aemcp::native::Completion> taken;
  std::thread worker([&] { taken = dispatcher.take_outbound(1); });
  worker.join();
  require(taken.size() == 1, "worker could not take bounded outbound item");
  require(dispatcher.enqueue(request(clock, "three", 1s, "route", 1)).code
      == EnqueueCode::kAccepted, "worker take did not release outbound capacity");
  require(dispatcher.drain(host).completions.size() == 1,
      "post-backpressure request did not drain");
  require(dispatcher.outbound() == 2, "outbound capacity accounting drifted");
}

void queued_and_running_cancellation_are_distinct() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 8));
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "target", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "queued cancel target setup failed");
  require(dispatcher.enqueue(request(clock, "target", 1s, "route-b", 1)).code
      == EnqueueCode::kAccepted, "cross-route cancel control setup failed");
  const CancelResult queued = dispatcher.cancel("route-a", 1, "target");
  require(queued.code == CancelCode::kQueuedCancelled && queued.terminal_response_expected,
      "queued request did not cancel atomically");
  require(dispatcher.cancel("route-a", 1, "target").code == CancelCode::kAlreadyTerminal,
      "repeated queued cancel did not observe terminal state");
  require(dispatcher.queued() == 1, "queued cancel crossed its route boundary");
  const auto cancelled = dispatcher.take_outbound();
  require(cancelled.size() == 1 && cancelled[0].error_code == "CANCELLED"
          && cancelled[0].route_id == "route-a" && !cancelled[0].route_revoked,
      "queued cancellation did not produce routed terminal evidence");
  require(dispatcher.drain(host).completions.size() == 1,
      "other route did not survive targeted cancellation");

  require(dispatcher.enqueue(request(clock, "running", 1s, "route-a", 1)).code
      == EnqueueCode::kAccepted, "running cancel target setup failed");
  BlockingHost blocking(owner);
  CancelResult running;
  std::thread cancel_worker([&] {
    blocking.wait_until_entered();
    running = dispatcher.cancel("route-a", 1, "running");
    blocking.release();
  });
  const auto batch = dispatcher.drain(blocking);
  cancel_worker.join();
  require(running.code == CancelCode::kRunningNotCancellable
          && running.terminal_response_expected,
      "running before-dispatch capability did not report running-not-cancellable");
  require(batch.completions.size() == 1 && batch.completions[0].ok,
      "running request was incorrectly cancelled after dispatch");
}

void route_revocation_fences_generations_and_detaches_results() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(6, 6, 4ms, 12, 128, 60s, 1));
  FakeHost host(clock, owner);
  require(dispatcher.enqueue(request(clock, "old-a", 1s, "shared", 1)).code
      == EnqueueCode::kAccepted, "old route request A setup failed");
  require(dispatcher.enqueue(request(clock, "old-b", 1s, "shared", 1)).code
      == EnqueueCode::kAccepted, "old route request B setup failed");
  require(dispatcher.enqueue(request(clock, "old-a", 1s, "shared", 2)).code
      == EnqueueCode::kAccepted, "new generation request setup failed");

  const RouteRevocationResult queued = dispatcher.revoke_route("shared", 1);
  require(queued.fence_recorded && !queued.fence_saturated
          && queued.queued_cancelled == 2 && queued.running_detached == 0,
      "route revoke did not cancel only its queued generation");
  require(dispatcher.queued() == 1, "route revoke cancelled the newer generation");
  const auto cancelled = dispatcher.take_outbound();
  require(cancelled.size() == 2 && cancelled[0].route_revoked
          && cancelled[1].route_revoked && cancelled[0].error_code == "CANCELLED",
      "revoked queued requests did not preserve detached terminal evidence");
  require(dispatcher.enqueue(request(clock, "stale", 1s, "shared", 1)).code
      == EnqueueCode::kStaleRoute, "revoked generation bypassed its fence");
  auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.completions[0].session_generation == 2
          && !batch.completions[0].route_revoked,
      "newer route generation was detached by an older fence");
  require(dispatcher.revoke_route("shared", 1).pending_outbound_marked == 0,
      "late old-generation revoke marked a new-generation result");
  require(dispatcher.take_outbound().size() == 1,
      "new-generation outbound result was not independently observable");

  require(dispatcher.enqueue(request(clock, "mutation-shaped", 1s, "shared", 3)).code
      == EnqueueCode::kAccepted, "running revoke target setup failed");
  BlockingHost blocking(owner);
  RouteRevocationResult running;
  RouteRevocationResult repeated;
  std::thread revoke_worker([&] {
    blocking.wait_until_entered();
    running = dispatcher.revoke_route("shared", 3);
    repeated = dispatcher.revoke_route("shared", 3);
    blocking.release();
  });
  batch = dispatcher.drain(blocking);
  revoke_worker.join();
  require(running.running_detached == 1 && running.queued_cancelled == 0,
      "running request was not generation-detached");
  require(repeated.running_detached == 0 && repeated.fence_recorded,
      "repeated route revoke was not idempotent");
  require(batch.completions.size() == 1 && batch.completions[0].ok
          && batch.completions[0].route_revoked,
      "post-disconnect running result lost detached terminal evidence");
  require(dispatcher.has_terminal("shared", 3, "mutation-shaped"),
      "post-disconnect terminal tombstone was not retained");

  require(dispatcher.enqueue(request(clock, "mutation-shaped", 1s, "shared", 4)).code
      == EnqueueCode::kAccepted, "new connection generation inherited stale request state");
  require(dispatcher.drain(host).completions.size() == 1,
      "new connection generation did not execute independently");
  const auto outbound = dispatcher.take_outbound();
  require(outbound.size() == 2
          && outbound[0].session_generation == 3 && outbound[0].route_revoked
          && outbound[1].session_generation == 4 && !outbound[1].route_revoked,
      "old terminal evidence could be confused with the new connection");
}

void saturated_route_fences_fail_closed_without_losing_running_evidence() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 4ms, 8, 8, 1s, 1));
  require(dispatcher.revoke_route("recorded", 1).fence_recorded,
      "route fence capacity setup failed");
  require(dispatcher.enqueue(request(clock, "running", 1s, "unseen", 1)).code
      == EnqueueCode::kAccepted, "pre-saturation running route setup failed");

  BlockingHost blocking(owner);
  RouteRevocationResult revocation;
  std::thread worker([&] {
    blocking.wait_until_entered();
    revocation = dispatcher.revoke_route("unseen", 1);
    blocking.release();
  });
  const auto batch = dispatcher.drain(blocking);
  worker.join();
  require(!revocation.fence_recorded && revocation.fence_saturated
          && revocation.running_detached == 1,
      "saturated fence registry did not detach the active unknown route");
  require(batch.completions.size() == 1 && batch.completions[0].route_revoked,
      "saturated fence path lost detached running terminal evidence");
  require(dispatcher.enqueue(request(clock, "future", 1s, "unseen", 2)).code
      == EnqueueCode::kStaleRoute,
      "saturated fence registry evicted history instead of failing closed");
}

void idle_budget_and_shutdown_are_bounded() {
  FakeClock clock;
  const auto owner = std::this_thread::get_id();
  HostDispatcher dispatcher(owner, clock, config(4, 4, 2ms));
  FakeHost host(clock, owner);
  host.delay = 2ms;
  require(dispatcher.enqueue(request(clock, "budget-1", 1s)).code == EnqueueCode::kAccepted,
      "first budget request failed");
  require(dispatcher.enqueue(request(clock, "budget-2", 1s)).code == EnqueueCode::kAccepted,
      "second budget request failed");
  const auto batch = dispatcher.drain(host);
  require(batch.completions.size() == 1 && batch.remaining == 1 && batch.budget_exhausted,
      "idle budget did not preserve remaining work");
  const auto stopped = dispatcher.shutdown();
  require(stopped.size() == 1 && stopped[0].error_code == "AE_SHUTTING_DOWN",
      "shutdown did not terminate queued request");
  require(dispatcher.outbound() == 2,
      "shutdown did not place every terminal completion on outbound");
  require(dispatcher.has_terminal({}, 0, "budget-1")
          && dispatcher.has_terminal({}, 0, "budget-2"),
      "shutdown terminal tombstones are incomplete");
  require(dispatcher.enqueue(request(clock, "after-stop", 1s)).code
      == EnqueueCode::kShuttingDown, "request was admitted after shutdown");
  require(dispatcher.shutdown().empty(), "shutdown was not idempotent");
}

}  // namespace

int main() {
  bounded_page_budget_counts_codec_escaping_and_stops_before_overflow();
  effective_layer_name_uses_sdk_source_fallback();
  selected_collection_ownership_and_mixed_filter_are_portable_tested();
  composition_time_rational_is_exact_and_overflow_safe();
  project_epoch_fences_reused_aegp_handles();
  project_graph_reads_validate_arguments_and_dispatch_on_owner_thread();
  selected_layers_read_is_closed_main_thread_bound_and_request_verified();
  composition_time_read_is_closed_main_thread_bound_and_verified();
  composition_time_write_is_typed_main_thread_bound_and_idempotent();
  bit_depth_read_and_write_are_main_thread_bound_and_write_is_idempotent();
  bit_depth_write_releases_only_safe_failures_and_fails_closed_when_full();
  bit_depth_write_validates_before_dispatch_and_late_results_are_ambiguous();
  bit_depth_write_uses_request_deadline_and_stops_an_overrun_idle_batch();
  layer_property_write_is_typed_context_bound_and_idempotent();
  worker_to_owner_dispatch_and_outbound_transfer();
  admission_is_closed_and_bounded();
  request_identity_is_route_scoped_and_tombstones_expire();
  terminal_tombstones_are_fifo_bounded();
  wrong_thread_is_state_preserving();
  deadlines_and_late_results_are_safe();
  outbound_capacity_applies_backpressure_until_worker_takes();
  queued_and_running_cancellation_are_distinct();
  route_revocation_fences_generations_and_detaches_results();
  saturated_route_fences_fail_closed_without_losing_running_evidence();
  idle_budget_and_shutdown_are_bounded();
  std::cout << "host_dispatcher_test: PASS\n";
  return 0;
}
