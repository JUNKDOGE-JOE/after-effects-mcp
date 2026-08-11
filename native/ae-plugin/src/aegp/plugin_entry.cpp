#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/host_platform.hpp"
#include "aemcp_native/native_rpc_connection.hpp"
#include "aemcp_native/project_epoch.hpp"
#include "aemcp_native/rpc_codec.hpp"
#include "aemcp_native/selection_collection.hpp"
#include "native_program_executor.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iomanip>
#include <iterator>
#include <limits>
#include <locale>
#include <memory>
#include <mutex>
#include <new>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "AEConfig.h"
#include "AE_GeneralPlug.h"
#include "SPBasic.h"

#ifndef AE_MCP_SOURCE_COMMIT
#error                                                                         \
    "AE_MCP_SOURCE_COMMIT must bind the native binary to a clean repository commit"
#endif

#ifndef AE_MCP_PRODUCT_VERSION
#error                                                                         \
    "AE_MCP_PRODUCT_VERSION must bind the native binary to the repository product version"
#endif

namespace {

using namespace std::chrono_literals;
using aemcp::native::BoundedPageBudget;
using aemcp::native::Completion;
using aemcp::native::CompositionCurrentTime;
using aemcp::native::CompositionPositiveRatio;
using aemcp::native::CompositionSettingKind;
using aemcp::native::CompositionSettings;
using aemcp::native::CompositionSettingsChanged;
using aemcp::native::DrainBatch;
using aemcp::native::HostActionResult;
using aemcp::native::HostApi;
using aemcp::native::HostCompositionLayersResult;
using aemcp::native::HostCompositionSettingsResult;
using aemcp::native::HostCompositionSettingsWriteResult;
using aemcp::native::HostCompositionTimeResult;
using aemcp::native::HostCompositionTimeWriteResult;
using aemcp::native::HostDispatcher;
using aemcp::native::HostLayerPropertiesResult;
using aemcp::native::HostLayerPropertyKeyframeDetailsResult;
using aemcp::native::HostLayerPropertyKeyframesResult;
using aemcp::native::HostLayerPropertyKeyframeWriteResult;
using aemcp::native::HostLayerPropertyWriteResult;
using aemcp::native::HostProjectGraphInvalidationResult;
using aemcp::native::HostProjectItemsResult;
using aemcp::native::kNativeProgramCapability;
using aemcp::native::kProjectGraphInvalidateControl;
using aemcp::native::LayerPropertyKeyframeChanged;
using aemcp::native::LayerPropertyKeyframeDetails;
using aemcp::native::LayerPropertySampleTime;
using aemcp::native::DiagnosticLog;
using aemcp::native::effect_text_utf8;
using aemcp::native::HostIdentity;
using aemcp::native::NativeEndpointDescriptor;
using aemcp::native::PlatformEndpointRegistry;
using aemcp::native::PlatformIpcServer;
using aemcp::native::PlatformIpcServerConfig;
using aemcp::native::positive_integer;
using aemcp::native::read_host_identity;using aemcp::native::NativeHandleResolveResult;
using aemcp::native::NativeIpcObserver;
using aemcp::native::NativeProgram;
using aemcp::native::NativeProgramDisposition;
using aemcp::native::NativeProgramHostResult;
using aemcp::native::NativeProgramPrimitiveHost;
using aemcp::native::NativeRpcConnectionHandler;
using aemcp::native::NativeRpcObserver;
using aemcp::native::NativeRpcRuntimeInfo;
using aemcp::native::ObjectLocator;
using aemcp::native::ProjectEpochTracker;
using aemcp::native::ProjectItemEntry;
using aemcp::native::ProjectObservation;
using aemcp::native::Request;
using aemcp::native::SystemClock;
using aemcp::native::TimePoint;

constexpr std::string_view kPluginVersion = AE_MCP_PRODUCT_VERSION;
constexpr std::string_view kSdkVersion = "25.6.61";
constexpr std::uint64_t kSdkBuild = 61;
constexpr std::string_view kSourceCommit = AE_MCP_SOURCE_COMMIT;
constexpr std::int64_t kMaximumProjectItems = 100000;
static_assert(kSourceCommit.size() == 40);

[[nodiscard]] std::optional<AEGP_LayerStream>
standard_layer_stream_for_match_name(std::string_view match_name) noexcept {
  if (match_name == "ADBE Anchor Point")
    return AEGP_LayerStream_ANCHORPOINT;
  if (match_name == "ADBE Position")
    return AEGP_LayerStream_POSITION;
  if (match_name == "ADBE Scale")
    return AEGP_LayerStream_SCALE;
  if (match_name == "ADBE Rotate Z")
    return AEGP_LayerStream_ROTATE_Z;
  if (match_name == "ADBE Opacity")
    return AEGP_LayerStream_OPACITY;
  if (match_name == "ADBE Orientation")
    return AEGP_LayerStream_ORIENTATION;
  return std::nullopt;
}

constexpr bool exact_nonnegative_fraction_leq(std::uint64_t left_numerator,
                                              std::uint64_t left_denominator,
                                              std::uint64_t right_numerator,
                                              std::uint64_t right_denominator) {
  bool reversed = false;
  for (;;) {
    const std::uint64_t left_quotient = left_numerator / left_denominator;
    const std::uint64_t right_quotient = right_numerator / right_denominator;
    if (left_quotient != right_quotient) {
      return reversed ? left_quotient > right_quotient
                      : left_quotient < right_quotient;
    }
    left_numerator %= left_denominator;
    right_numerator %= right_denominator;
    if (left_numerator == 0 || right_numerator == 0) {
      if (left_numerator == right_numerator)
        return true;
      return reversed ? left_numerator != 0 : left_numerator == 0;
    }
    std::swap(left_numerator, left_denominator);
    std::swap(right_numerator, right_denominator);
    reversed = !reversed;
  }
}

constexpr bool exact_nonnegative_time_sum_leq(std::int32_t left_value,
                                              std::uint32_t left_scale,
                                              std::int32_t right_value,
                                              std::uint32_t right_scale,
                                              std::int32_t limit_value,
                                              std::uint32_t limit_scale) {
  if (left_value < 0 || right_value < 0 || limit_value < 0 || left_scale == 0 ||
      right_scale == 0 || limit_scale == 0) {
    return false;
  }
  const std::uint64_t common = std::gcd(left_scale, right_scale);
  const std::uint64_t left_factor = right_scale / common;
  const std::uint64_t right_factor = left_scale / common;
  const std::uint64_t numerator =
      static_cast<std::uint64_t>(left_value) * left_factor +
      static_cast<std::uint64_t>(right_value) * right_factor;
  const std::uint64_t denominator =
      static_cast<std::uint64_t>(left_scale) * left_factor;
  return exact_nonnegative_fraction_leq(numerator, denominator,
                                        static_cast<std::uint64_t>(limit_value),
                                        limit_scale);
}

static_assert(exact_nonnegative_time_sum_leq(2147483646, 4294967295U, 1,
                                             4294967295U, 2147483647,
                                             4294967295U));
static_assert(!exact_nonnegative_time_sum_leq(2147483646, 4294967295U, 2,
                                              4294967295U, 2147483647,
                                              4294967295U));

std::string json_escape(std::string_view input) {
  std::ostringstream escaped;
  for (unsigned char value : input) {
    switch (value) {
    case '"':
      escaped << "\\\"";
      break;
    case '\\':
      escaped << "\\\\";
      break;
    case '\b':
      escaped << "\\b";
      break;
    case '\f':
      escaped << "\\f";
      break;
    case '\n':
      escaped << "\\n";
      break;
    case '\r':
      escaped << "\\r";
      break;
    case '\t':
      escaped << "\\t";
      break;
    default:
      if (value < 0x20) {
        escaped << "\\u00" << std::hex << std::setw(2) << std::setfill('0')
                << static_cast<unsigned int>(value) << std::dec;
      } else {
        escaped << static_cast<char>(value);
      }
    }
  }
  return escaped.str();
}

std::int64_t unix_time_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

template <typename Suite> class SuiteLease final {
public:
  SuiteLease(SPBasicSuite *basic, const char *name, std::int32_t version)
      : basic_(basic), name_(name), version_(version) {
    if (basic_ != nullptr &&
        basic_->AcquireSuite(name_, version_,
                             reinterpret_cast<const void **>(&suite_)) != 0) {
      suite_ = nullptr;
    }
  }

  ~SuiteLease() {
    if (suite_ != nullptr)
      basic_->ReleaseSuite(name_, version_);
  }

  SuiteLease(const SuiteLease &) = delete;
  SuiteLease &operator=(const SuiteLease &) = delete;

  [[nodiscard]] const Suite *get() const noexcept { return suite_; }
  [[nodiscard]] const Suite *operator->() const noexcept { return suite_; }

private:
  SPBasicSuite *basic_{nullptr};
  const char *name_{nullptr};
  std::int32_t version_{0};
  const Suite *suite_{nullptr};
};

class MemHandleOwner final {
public:
  MemHandleOwner(const AEGP_MemorySuite1 *suite, AEGP_MemHandle handle)
      : suite_(suite), handle_(handle) {}
  ~MemHandleOwner() {
    if (suite_ != nullptr && handle_ != nullptr) {
      if (locked_)
        (void)suite_->AEGP_UnlockMemHandle(handle_);
      (void)suite_->AEGP_FreeMemHandle(handle_);
    }
  }
  MemHandleOwner(const MemHandleOwner &) = delete;
  MemHandleOwner &operator=(const MemHandleOwner &) = delete;

  [[nodiscard]] std::optional<std::string> utf8() {
    if (suite_ == nullptr || handle_ == nullptr)
      return std::string{};
    AEGP_MemSize bytes = 0;
    if (suite_->AEGP_GetMemHandleSize(handle_, &bytes) != A_Err_NONE ||
        bytes == 0 || bytes > 8192 || bytes % sizeof(A_UTF16Char) != 0) {
      return std::nullopt;
    }
    void *raw = nullptr;
    if (suite_->AEGP_LockMemHandle(handle_, &raw) != A_Err_NONE ||
        raw == nullptr) {
      return std::nullopt;
    }
    locked_ = true;
    const auto *characters = static_cast<const A_UTF16Char *>(raw);
    const std::size_t capacity = bytes / sizeof(A_UTF16Char);
    std::size_t length = 0;
    while (length < capacity && characters[length] != 0)
      ++length;
    if (length == capacity)
      return std::nullopt;
    std::size_t scalars = 0;
    for (std::size_t index = 0; index < length;) {
      const std::uint16_t unit = characters[index++];
      if (unit >= 0xd800U && unit <= 0xdbffU) {
        if (index >= length)
          return std::nullopt;
        const std::uint16_t trailing = characters[index++];
        if (trailing < 0xdc00U || trailing > 0xdfffU)
          return std::nullopt;
      } else if (unit >= 0xdc00U && unit <= 0xdfffU) {
        return std::nullopt;
      }
      if (++scalars > 1024)
        return std::nullopt;
    }
    return aemcp::native::host_utf16_to_utf8(characters, length);
  }

private:
  const AEGP_MemorySuite1 *suite_{nullptr};
  AEGP_MemHandle handle_{nullptr};
  bool locked_{false};
};

[[nodiscard]] std::optional<std::string>
read_project_path(const AEGP_ProjSuite6 *project_suite,
                  const AEGP_MemorySuite1 *memory_suite,
                  AEGP_ProjectH project) {
  AEGP_MemHandle path_handle = nullptr;
  const A_Err path_error =
      project_suite->AEGP_GetProjectPath(project, &path_handle);
  MemHandleOwner path_owner(memory_suite, path_handle);
  if (path_error != A_Err_NONE)
    return std::nullopt;
  return path_owner.utf8();
}

[[nodiscard]] std::optional<std::string> read_effective_layer_name(
    const AEGP_LayerSuite9 *layer_suite, const AEGP_ItemSuite9 *item_suite,
    const AEGP_MemorySuite1 *memory_suite, AEGP_PluginID plugin_id,
    AEGP_LayerH layer, std::string &error) {
  AEGP_MemHandle layer_name_handle = nullptr;
  AEGP_MemHandle source_name_handle = nullptr;
  const A_Err name_error = layer_suite->AEGP_GetLayerName(
      plugin_id, layer, &layer_name_handle, &source_name_handle);
  MemHandleOwner source_name_owner(memory_suite, source_name_handle);
  MemHandleOwner layer_name_owner(memory_suite, layer_name_handle);
  if (name_error != A_Err_NONE) {
    error = "could not read layer and source names";
    return std::nullopt;
  }

  std::optional<std::string> layer_name;
  if (layer_name_handle != nullptr) {
    layer_name = layer_name_owner.utf8();
    if (!layer_name.has_value()) {
      error = "layer name is not bounded UTF-16 text";
      return std::nullopt;
    }
    if (!layer_name->empty())
      return layer_name;
  }
  std::optional<std::string> source_name;
  if (source_name_handle != nullptr) {
    source_name = source_name_owner.utf8();
    if (!source_name.has_value()) {
      error = "layer source name is not bounded UTF-16 text";
      return std::nullopt;
    }
    if (!source_name->empty())
      return source_name;
  }

  AEGP_ItemH source_item = nullptr;
  if (layer_suite->AEGP_GetLayerSourceItem(layer, &source_item) != A_Err_NONE) {
    error = "could not resolve the layer source item name fallback";
    return std::nullopt;
  }
  std::optional<std::string> source_item_name;
  if (source_item != nullptr) {
    AEGP_MemHandle source_item_name_handle = nullptr;
    const A_Err source_item_name_error = item_suite->AEGP_GetItemName(
        plugin_id, source_item, &source_item_name_handle);
    MemHandleOwner source_item_name_owner(memory_suite,
                                          source_item_name_handle);
    if (source_item_name_error != A_Err_NONE ||
        source_item_name_handle == nullptr) {
      error = "could not read the layer source item name fallback";
      return std::nullopt;
    }
    source_item_name = source_item_name_owner.utf8();
    if (!source_item_name.has_value()) {
      error = "layer source item name is not bounded UTF-16 text";
      return std::nullopt;
    }
  }

  const std::optional<std::string> effective_name =
      aemcp::native::select_effective_layer_name(layer_name, source_name,
                                                 source_item_name);
  if (!effective_name.has_value()) {
    error = "After Effects returned no layer or source name";
    return std::nullopt;
  }
  return effective_name;
}

class StreamRefOwner final {
public:
  StreamRefOwner(const AEGP_StreamSuite6 *suite, AEGP_StreamRefH stream)
      : suite_(suite), stream_(stream) {}
  ~StreamRefOwner() { reset(); }
  StreamRefOwner(const StreamRefOwner &) = delete;
  StreamRefOwner &operator=(const StreamRefOwner &) = delete;
  StreamRefOwner(StreamRefOwner &&other) noexcept
      : suite_(other.suite_), stream_(other.stream_) {
    other.stream_ = nullptr;
  }
  StreamRefOwner &operator=(StreamRefOwner &&other) noexcept {
    if (this != &other) {
      reset();
      suite_ = other.suite_;
      stream_ = other.stream_;
      other.stream_ = nullptr;
    }
    return *this;
  }
  [[nodiscard]] AEGP_StreamRefH get() const noexcept { return stream_; }

private:
  void reset() noexcept {
    if (suite_ != nullptr && stream_ != nullptr) {
      (void)suite_->AEGP_DisposeStream(stream_);
      stream_ = nullptr;
    }
  }
  const AEGP_StreamSuite6 *suite_{nullptr};
  AEGP_StreamRefH stream_{nullptr};
};

class EffectRefOwner final {
public:
  EffectRefOwner(const AEGP_EffectSuite5 *suite, AEGP_EffectRefH effect)
      : suite_(suite), effect_(effect) {}
  ~EffectRefOwner() {
    if (suite_ != nullptr && effect_ != nullptr) {
      (void)suite_->AEGP_DisposeEffect(effect_);
    }
  }
  EffectRefOwner(const EffectRefOwner &) = delete;
  EffectRefOwner &operator=(const EffectRefOwner &) = delete;
  [[nodiscard]] AEGP_EffectRefH get() const noexcept { return effect_; }

private:
  const AEGP_EffectSuite5 *suite_{nullptr};
  AEGP_EffectRefH effect_{nullptr};
};

class MaskRefOwner final {
public:
  MaskRefOwner(const AEGP_MaskSuite6 *suite, AEGP_MaskRefH mask)
      : suite_(suite), mask_(mask) {}
  ~MaskRefOwner() {
    if (suite_ != nullptr && mask_ != nullptr) {
      (void)suite_->AEGP_DisposeMask(mask_);
    }
  }
  MaskRefOwner(const MaskRefOwner &) = delete;
  MaskRefOwner &operator=(const MaskRefOwner &) = delete;
  MaskRefOwner(MaskRefOwner &&other) noexcept
      : suite_(other.suite_), mask_(other.mask_) {
    other.mask_ = nullptr;
  }
  MaskRefOwner &operator=(MaskRefOwner &&other) noexcept {
    if (this != &other) {
      if (suite_ != nullptr && mask_ != nullptr) {
        (void)suite_->AEGP_DisposeMask(mask_);
      }
      suite_ = other.suite_;
      mask_ = other.mask_;
      other.mask_ = nullptr;
    }
    return *this;
  }
  [[nodiscard]] AEGP_MaskRefH get() const noexcept { return mask_; }

private:
  const AEGP_MaskSuite6 *suite_{nullptr};
  AEGP_MaskRefH mask_{nullptr};
};

class FootageOwner final {
public:
  FootageOwner(const AEGP_FootageSuite5 *suite, AEGP_FootageH footage)
      : suite_(suite), footage_(footage) {}
  ~FootageOwner() {
    if (!adopted_ && suite_ != nullptr && footage_ != nullptr) {
      (void)suite_->AEGP_DisposeFootage(footage_);
    }
  }
  FootageOwner(const FootageOwner &) = delete;
  FootageOwner &operator=(const FootageOwner &) = delete;
  [[nodiscard]] AEGP_FootageH get() const noexcept { return footage_; }
  void adopted() noexcept { adopted_ = true; }

private:
  const AEGP_FootageSuite5 *suite_{nullptr};
  AEGP_FootageH footage_{nullptr};
  bool adopted_{false};
};

class StreamValueOwner final {
public:
  explicit StreamValueOwner(const AEGP_StreamSuite6 *suite) : suite_(suite) {}
  ~StreamValueOwner() {
    if (initialized_ && suite_ != nullptr) {
      (void)suite_->AEGP_DisposeStreamValue(&value_);
    }
  }
  StreamValueOwner(const StreamValueOwner &) = delete;
  StreamValueOwner &operator=(const StreamValueOwner &) = delete;
  [[nodiscard]] AEGP_StreamValue2 *out() noexcept { return &value_; }
  void mark_initialized() noexcept { initialized_ = true; }
  [[nodiscard]] const AEGP_StreamValue2 &value() const noexcept {
    return value_;
  }
  [[nodiscard]] AEGP_StreamValue2 &mutable_value() noexcept { return value_; }
  [[nodiscard]] const AEGP_StreamValue2 *borrow() const noexcept {
    return initialized_ ? &value_ : nullptr;
  }

private:
  const AEGP_StreamSuite6 *suite_{nullptr};
  AEGP_StreamValue2 value_{};
  bool initialized_{false};
};

class MarkerOwner final {
public:
  MarkerOwner(const AEGP_MarkerSuite3 *suite, AEGP_MarkerValP marker)
      : suite_(suite), marker_(marker) {}
  ~MarkerOwner() {
    if (suite_ != nullptr && marker_ != nullptr) {
      (void)suite_->AEGP_DisposeMarker(marker_);
    }
  }
  MarkerOwner(const MarkerOwner &) = delete;
  MarkerOwner &operator=(const MarkerOwner &) = delete;
  MarkerOwner(MarkerOwner &&other) noexcept
      : suite_(other.suite_), marker_(other.marker_) {
    other.marker_ = nullptr;
  }
  MarkerOwner &operator=(MarkerOwner &&other) noexcept {
    if (this != &other) {
      if (suite_ != nullptr && marker_ != nullptr) {
        (void)suite_->AEGP_DisposeMarker(marker_);
      }
      suite_ = other.suite_;
      marker_ = other.marker_;
      other.marker_ = nullptr;
    }
    return *this;
  }
  [[nodiscard]] AEGP_MarkerValP get() const noexcept { return marker_; }

private:
  const AEGP_MarkerSuite3 *suite_{nullptr};
  AEGP_MarkerValP marker_{nullptr};
};

class UndoGroupOwner final {
public:
  explicit UndoGroupOwner(const AEGP_UtilitySuite6 *suite) : suite_(suite) {}
  ~UndoGroupOwner() {
    if (active_ && suite_ != nullptr) {
      (void)suite_->AEGP_EndUndoGroup();
    }
  }
  UndoGroupOwner(const UndoGroupOwner &) = delete;
  UndoGroupOwner &operator=(const UndoGroupOwner &) = delete;
  void mark_started() noexcept { active_ = true; }
  [[nodiscard]] A_Err finish() noexcept {
    if (!active_ || suite_ == nullptr)
      return A_Err_NONE;
    active_ = false;
    return suite_->AEGP_EndUndoGroup();
  }

private:
  const AEGP_UtilitySuite6 *suite_{nullptr};
  bool active_{false};
};

class ProjectGraphRegistry final {
public:
  static_assert(ProjectEpochTracker::kMaxGeneration ==
                aemcp::native::rpc::kMaxSafeInteger);

  struct LayerAddress {
    A_long composition_item_id{0};
    AEGP_LayerIDVal layer_id{0};
  };

  struct StreamAddress {
    std::string layer_object_id;
    std::vector<A_long> child_indices;
    std::vector<std::int32_t> unique_ids;
  };

  void project_closed() {
    if (!epoch_.close())
      return;
    clear_objects();
  }

  [[nodiscard]] bool invalidate_project() {
    if (!epoch_.present())
      return false;

    // Prepare every potentially-throwing value before advancing the epoch so
    // callers never observe a new generation with the old locator registry.
    std::string next_project_id = aemcp::native::secure_uuid_v4();
    std::string next_project_object_id = aemcp::native::secure_uuid_v4();
    if (!epoch_.invalidate())
      return false;
    project_id_ = std::move(next_project_id);
    project_object_id_ = std::move(next_project_object_id);
    clear_objects();
    return true;
  }

  void observe_project(std::uintptr_t identity,
                       std::uintptr_t root_item_identity, A_long root_item_id,
                       std::string project_path) {
    if (!epoch_.observe(
            ProjectObservation{identity, root_item_identity,
                               static_cast<std::int64_t>(root_item_id),
                               std::move(project_path)})) {
      return;
    }
    project_id_ = aemcp::native::secure_uuid_v4();
    project_object_id_ = aemcp::native::secure_uuid_v4();
    clear_objects();
  }

  [[nodiscard]] ObjectLocator project_locator(std::string_view host,
                                              std::string_view session) const {
    return make_locator("project", project_object_id_, host, session);
  }

  [[nodiscard]] ObjectLocator item_locator(A_long item_id, bool composition,
                                           std::string_view host,
                                           std::string_view session) {
    auto found = item_object_ids_.find(item_id);
    if (found == item_object_ids_.end()) {
      const std::string object_id = aemcp::native::secure_uuid_v4();
      found = item_object_ids_.emplace(item_id, object_id).first;
      item_ids_by_object_.emplace(object_id, item_id);
    }
    return make_locator(composition ? "composition" : "item", found->second,
                        host, session);
  }

  [[nodiscard]] ObjectLocator
  layer_locator(A_long composition_item_id, AEGP_LayerIDVal layer_id,
                std::string_view host, std::string_view session,
                std::string_view preserved_object_id = {}) {
    const std::string key = std::to_string(composition_item_id) + ":" +
                            std::to_string(static_cast<A_long>(layer_id));
    auto found = layer_object_ids_.find(key);
    if (found == layer_object_ids_.end()) {
      const std::string object_id = preserved_object_id.empty()
                                        ? aemcp::native::secure_uuid_v4()
                                        : std::string(preserved_object_id);
      if (layers_by_object_.contains(object_id)) {
        throw std::runtime_error(
            "layer locator object identity is already bound");
      }
      found = layer_object_ids_.emplace(key, object_id).first;
      layers_by_object_.emplace(found->second,
                                LayerAddress{composition_item_id, layer_id});
    } else if (!preserved_object_id.empty() &&
               found->second != preserved_object_id) {
      throw std::runtime_error("layer locator object identity does not match");
    }
    return make_locator("layer", found->second, host, session);
  }

  [[nodiscard]] std::optional<LayerAddress>
  resolve_layer(const ObjectLocator &locator, std::string_view host,
                std::string_view session) const {
    if (locator.kind != "layer" || locator.host_instance_id != host ||
        locator.session_id != session || locator.project_id != project_id_ ||
        locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = layers_by_object_.find(locator.object_id);
    return found == layers_by_object_.end()
               ? std::nullopt
               : std::optional<LayerAddress>(found->second);
  }

  [[nodiscard]] ObjectLocator
  stream_locator(const ObjectLocator &layer_locator_value,
                 std::vector<A_long> child_indices,
                 std::vector<std::int32_t> unique_ids, std::string_view host,
                 std::string_view session) {
    if (child_indices.empty() || child_indices.size() != unique_ids.size() ||
        child_indices.size() > 32) {
      throw std::runtime_error("stream locator registry bound exceeded");
    }
    std::string key = layer_locator_value.object_id;
    for (std::size_t index = 0; index < child_indices.size(); ++index) {
      key += ":" + std::to_string(child_indices[index]) + "@" +
             std::to_string(unique_ids[index]);
    }
    auto found = stream_object_ids_.find(key);
    if (found == stream_object_ids_.end()) {
      if (stream_addresses_.size() >= 16'384) {
        throw std::runtime_error("stream locator registry bound exceeded");
      }
      const std::string object_id = aemcp::native::secure_uuid_v4();
      found = stream_object_ids_.emplace(key, object_id).first;
      stream_addresses_.emplace(object_id,
                                StreamAddress{layer_locator_value.object_id,
                                              std::move(child_indices),
                                              std::move(unique_ids)});
    }
    return make_locator("stream", found->second, host, session);
  }

  [[nodiscard]] std::optional<StreamAddress>
  resolve_stream(const ObjectLocator &locator,
                 const ObjectLocator &layer_locator_value,
                 std::string_view host, std::string_view session) const {
    if (locator.kind != "stream" || locator.host_instance_id != host ||
        locator.session_id != session || locator.project_id != project_id_ ||
        locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = stream_addresses_.find(locator.object_id);
    if (found == stream_addresses_.end() ||
        found->second.layer_object_id != layer_locator_value.object_id) {
      return std::nullopt;
    }
    return found->second;
  }

  [[nodiscard]] std::optional<StreamAddress>
  resolve_stream(const ObjectLocator &locator, std::string_view host,
                 std::string_view session) const {
    if (locator.kind != "stream" || locator.host_instance_id != host ||
        locator.session_id != session || locator.project_id != project_id_ ||
        locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = stream_addresses_.find(locator.object_id);
    return found == stream_addresses_.end()
               ? std::nullopt
               : std::optional<StreamAddress>(found->second);
  }

  [[nodiscard]] std::optional<LayerAddress>
  resolve_layer_object(std::string_view object_id) const {
    const auto found = layers_by_object_.find(std::string(object_id));
    return found == layers_by_object_.end()
               ? std::nullopt
               : std::optional<LayerAddress>(found->second);
  }

  [[nodiscard]] bool matches_project(const ObjectLocator &locator,
                                     std::string_view host,
                                     std::string_view session) const {
    return locator.kind == "project" && locator.host_instance_id == host &&
           locator.session_id == session && locator.project_id == project_id_ &&
           locator.generation == epoch_.generation() &&
           locator.object_id == project_object_id_;
  }

  [[nodiscard]] std::uint64_t generation() const noexcept {
    return epoch_.generation();
  }

  [[nodiscard]] std::optional<A_long>
  resolve_composition(const ObjectLocator &locator, std::string_view host,
                      std::string_view session) const {
    if (locator.kind != "composition" || locator.host_instance_id != host ||
        locator.session_id != session || locator.project_id != project_id_ ||
        locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = item_ids_by_object_.find(locator.object_id);
    return found == item_ids_by_object_.end()
               ? std::nullopt
               : std::optional<A_long>(found->second);
  }

  [[nodiscard]] std::optional<A_long>
  resolve_project_item(const ObjectLocator &locator, std::string_view host,
                       std::string_view session) const {
    if ((locator.kind != "item" && locator.kind != "composition") ||
        locator.host_instance_id != host || locator.session_id != session ||
        locator.project_id != project_id_ ||
        locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = item_ids_by_object_.find(locator.object_id);
    return found == item_ids_by_object_.end()
               ? std::nullopt
               : std::optional<A_long>(found->second);
  }

private:
  [[nodiscard]] ObjectLocator make_locator(std::string kind,
                                           std::string object_id,
                                           std::string_view host,
                                           std::string_view session) const {
    return {std::move(kind), std::string(host),   std::string(session),
            project_id_,     epoch_.generation(), std::move(object_id)};
  }

  void clear_objects() {
    item_object_ids_.clear();
    item_ids_by_object_.clear();
    layer_object_ids_.clear();
    layers_by_object_.clear();
    stream_object_ids_.clear();
    stream_addresses_.clear();
  }

  ProjectEpochTracker epoch_;
  std::string project_id_;
  std::string project_object_id_;
  std::unordered_map<A_long, std::string> item_object_ids_;
  std::unordered_map<std::string, A_long> item_ids_by_object_;
  std::unordered_map<std::string, std::string> layer_object_ids_;
  std::unordered_map<std::string, LayerAddress> layers_by_object_;
  std::unordered_map<std::string, std::string> stream_object_ids_;
  std::unordered_map<std::string, StreamAddress> stream_addresses_;
};

[[nodiscard]] std::string project_item_type(AEGP_ItemType type) {
  if (type == AEGP_ItemType_FOLDER)
    return "folder";
  if (type == AEGP_ItemType_COMP)
    return "composition";
  if (type == AEGP_ItemType_FOOTAGE || type == AEGP_ItemType_SOLID_defunct) {
    return "footage";
  }
  return "unknown";
}

[[nodiscard]] std::string layer_type(AEGP_ObjectType object_type,
                                     AEGP_LayerFlags flags) {
  if ((flags & AEGP_LayerFlag_ADJUSTMENT_LAYER) != 0)
    return "adjustment";
  if ((flags & AEGP_LayerFlag_NULL_LAYER) != 0)
    return "null";
  if (object_type == AEGP_ObjectType_AV)
    return "av";
  if (object_type == AEGP_ObjectType_LIGHT)
    return "light";
  if (object_type == AEGP_ObjectType_CAMERA)
    return "camera";
  if (object_type == AEGP_ObjectType_TEXT)
    return "text";
  if (object_type == AEGP_ObjectType_VECTOR)
    return "shape";
  if (object_type == AEGP_ObjectType_3D_MODEL)
    return "model3d";
  return "unknown";
}

[[nodiscard]] std::optional<std::string> decimal_string(A_FpLong value) {
  if (!std::isfinite(value))
    return std::nullopt;
  if (value == 0)
    return std::string("0");
  std::array<char, 64> buffer{};
  const auto [end, error] = std::to_chars(
      buffer.data(), buffer.data() + buffer.size(), value,
      std::chars_format::general, std::numeric_limits<A_FpLong>::max_digits10);
  if (error != std::errc{})
    return std::nullopt;
  std::string result(buffer.data(), end);
  if (result.empty() || result.size() > 32)
    return std::nullopt;
  return result;
}

[[nodiscard]] std::optional<A_FpLong> decimal_value(std::string_view value) {
  std::istringstream input{std::string(value)};
  input.imbue(std::locale::classic());
  A_FpLong parsed = 0;
  input >> std::noskipws >> parsed;
  if (!input || !input.eof() || !std::isfinite(parsed)) {
    return std::nullopt;
  }
  return parsed;
}

[[nodiscard]] bool decimal_values_equal(std::string_view left,
                                        std::string_view right) {
  const auto left_value = decimal_value(left);
  const auto right_value = decimal_value(right);
  if (!left_value.has_value() || !right_value.has_value()) return false;
  // Percent-scaled and unit-converted streams accumulate sub-1e-14 binary
  // conversion noise across the write/read round trip (55 -> 0.55 -> 55.000…7),
  // so exact double equality misreports successful writes as side-effecting
  // failures. The tolerance stays far below any meaningful user-visible delta.
  const A_FpLong magnitude = std::max<A_FpLong>(
      {static_cast<A_FpLong>(1), std::fabs(*left_value),
       std::fabs(*right_value)});
  return std::fabs(*left_value - *right_value) <= magnitude * 1e-9;
}

[[nodiscard]] bool
layer_property_values_equal(const aemcp::native::LayerPropertyValue &left,
                            const aemcp::native::LayerPropertyValue &right) {
  if (left.index() != right.index())
    return false;
  if (const auto *scalar =
          std::get_if<aemcp::native::LayerPropertyScalarValue>(&left)) {
    return decimal_values_equal(
        scalar->value,
        std::get<aemcp::native::LayerPropertyScalarValue>(right).value);
  }
  if (const auto *vector =
          std::get_if<aemcp::native::LayerPropertyVectorValue>(&left)) {
    const auto &other =
        std::get<aemcp::native::LayerPropertyVectorValue>(right).components;
    if (vector->components.size() != other.size())
      return false;
    for (std::size_t index = 0; index < other.size(); ++index) {
      if (!decimal_values_equal(vector->components[index], other[index]))
        return false;
    }
    return true;
  }
  if (const auto *color =
          std::get_if<aemcp::native::LayerPropertyColorValue>(&left)) {
    const auto &other = std::get<aemcp::native::LayerPropertyColorValue>(right);
    return decimal_values_equal(color->alpha, other.alpha) &&
           decimal_values_equal(color->red, other.red) &&
           decimal_values_equal(color->green, other.green) &&
           decimal_values_equal(color->blue, other.blue);
  }
  return std::holds_alternative<std::monostate>(left);
}

[[nodiscard]] bool
keyframe_ease_equal(const aemcp::native::LayerPropertyKeyframeEase &left,
                    const aemcp::native::LayerPropertyKeyframeEase &right) {
  const auto left_speed = decimal_value(left.speed);
  const auto right_speed = decimal_value(right.speed);
  const auto left_influence = decimal_value(left.influence);
  const auto right_influence = decimal_value(right.influence);
  const auto close = [](A_FpLong first, A_FpLong second) {
    return std::abs(first - second) <=
           std::max({1.0, std::abs(first), std::abs(second)}) * 1e-9;
  };
  return left_speed.has_value() && right_speed.has_value() &&
         left_influence.has_value() && right_influence.has_value() &&
         close(*left_speed, *right_speed) &&
         close(*left_influence, *right_influence);
}

[[nodiscard]] bool keyframe_dimension_ease_equal(
    const aemcp::native::LayerPropertyKeyframeDimensionEase &left,
    const aemcp::native::LayerPropertyKeyframeDimensionEase &right) {
  return left.dimension == right.dimension &&
         keyframe_ease_equal(left.in_ease, right.in_ease) &&
         keyframe_ease_equal(left.out_ease, right.out_ease);
}

[[nodiscard]] std::optional<aemcp::native::LayerPropertyValue>
primitive_stream_value(AEGP_StreamType type, const AEGP_StreamValue2 &sampled) {
  if (type == AEGP_StreamType_OneD) {
    const auto value = decimal_string(sampled.val.one_d);
    if (value.has_value()) {
      return aemcp::native::LayerPropertyScalarValue{*value};
    }
  } else if (type == AEGP_StreamType_TwoD ||
             type == AEGP_StreamType_TwoD_SPATIAL) {
    const auto x = decimal_string(sampled.val.two_d.x);
    const auto y = decimal_string(sampled.val.two_d.y);
    if (x.has_value() && y.has_value()) {
      return aemcp::native::LayerPropertyVectorValue{{*x, *y}};
    }
  } else if (type == AEGP_StreamType_ThreeD ||
             type == AEGP_StreamType_ThreeD_SPATIAL) {
    const auto x = decimal_string(sampled.val.three_d.x);
    const auto y = decimal_string(sampled.val.three_d.y);
    const auto z = decimal_string(sampled.val.three_d.z);
    if (x.has_value() && y.has_value() && z.has_value()) {
      return aemcp::native::LayerPropertyVectorValue{{*x, *y, *z}};
    }
  } else if (type == AEGP_StreamType_COLOR) {
    const auto alpha = decimal_string(sampled.val.color.alphaF);
    const auto red = decimal_string(sampled.val.color.redF);
    const auto green = decimal_string(sampled.val.color.greenF);
    const auto blue = decimal_string(sampled.val.color.blueF);
    if (alpha.has_value() && red.has_value() && green.has_value() &&
        blue.has_value()) {
      return aemcp::native::LayerPropertyColorValue{*alpha, *red, *green,
                                                    *blue};
    }
  }
  return std::nullopt;
}

[[nodiscard]] bool assign_primitive_stream_value(
    AEGP_StreamType type, const aemcp::native::LayerPropertyValue &requested,
    AEGP_StreamValue2 &output) {
  if (type == AEGP_StreamType_OneD) {
    const auto *scalar =
        std::get_if<aemcp::native::LayerPropertyScalarValue>(&requested);
    const auto value =
        scalar == nullptr ? std::nullopt : decimal_value(scalar->value);
    if (!value.has_value())
      return false;
    output.val.one_d = *value;
    return true;
  }
  if (type == AEGP_StreamType_TwoD || type == AEGP_StreamType_TwoD_SPATIAL) {
    const auto *vector =
        std::get_if<aemcp::native::LayerPropertyVectorValue>(&requested);
    if (vector == nullptr || vector->components.size() != 2)
      return false;
    const auto x = decimal_value(vector->components[0]);
    const auto y = decimal_value(vector->components[1]);
    if (!x.has_value() || !y.has_value())
      return false;
    output.val.two_d = {*x, *y};
    return true;
  }
  if (type == AEGP_StreamType_ThreeD ||
      type == AEGP_StreamType_ThreeD_SPATIAL) {
    const auto *vector =
        std::get_if<aemcp::native::LayerPropertyVectorValue>(&requested);
    if (vector == nullptr || vector->components.size() != 3)
      return false;
    const auto x = decimal_value(vector->components[0]);
    const auto y = decimal_value(vector->components[1]);
    const auto z = decimal_value(vector->components[2]);
    if (!x.has_value() || !y.has_value() || !z.has_value())
      return false;
    output.val.three_d = {*x, *y, *z};
    return true;
  }
  if (type == AEGP_StreamType_COLOR) {
    const auto *color =
        std::get_if<aemcp::native::LayerPropertyColorValue>(&requested);
    if (color == nullptr)
      return false;
    const auto alpha = decimal_value(color->alpha);
    const auto red = decimal_value(color->red);
    const auto green = decimal_value(color->green);
    const auto blue = decimal_value(color->blue);
    if (!alpha.has_value() || !red.has_value() || !green.has_value() ||
        !blue.has_value()) {
      return false;
    }
    output.val.color = {*alpha, *red, *green, *blue};
    return true;
  }
  return false;
}

[[nodiscard]] bool
primitive_stream_values_equal(AEGP_StreamType type,
                              const AEGP_StreamValue2 &left,
                              const AEGP_StreamValue2 &right) {
  if (type == AEGP_StreamType_OneD)
    return left.val.one_d == right.val.one_d;
  if (type == AEGP_StreamType_TwoD || type == AEGP_StreamType_TwoD_SPATIAL) {
    return left.val.two_d.x == right.val.two_d.x &&
           left.val.two_d.y == right.val.two_d.y;
  }
  if (type == AEGP_StreamType_ThreeD ||
      type == AEGP_StreamType_ThreeD_SPATIAL) {
    return left.val.three_d.x == right.val.three_d.x &&
           left.val.three_d.y == right.val.three_d.y &&
           left.val.three_d.z == right.val.three_d.z;
  }
  if (type == AEGP_StreamType_COLOR) {
    return left.val.color.alphaF == right.val.color.alphaF &&
           left.val.color.redF == right.val.color.redF &&
           left.val.color.greenF == right.val.color.greenF &&
           left.val.color.blueF == right.val.color.blueF;
  }
  return false;
}

[[nodiscard]] std::string stream_type_name(AEGP_StreamType type) {
  switch (type) {
  case AEGP_StreamType_NO_DATA:
    return "none";
  case AEGP_StreamType_OneD:
    return "one-d";
  case AEGP_StreamType_TwoD:
    return "two-d";
  case AEGP_StreamType_TwoD_SPATIAL:
    return "two-d-spatial";
  case AEGP_StreamType_ThreeD:
    return "three-d";
  case AEGP_StreamType_ThreeD_SPATIAL:
    return "three-d-spatial";
  case AEGP_StreamType_COLOR:
    return "color";
  case AEGP_StreamType_ARB:
    return "arb";
  case AEGP_StreamType_MARKER:
    return "marker";
  case AEGP_StreamType_LAYER_ID:
    return "layer-id";
  case AEGP_StreamType_MASK_ID:
    return "mask-id";
  case AEGP_StreamType_MASK:
    return "mask";
  case AEGP_StreamType_TEXT_DOCUMENT:
    return "text-document";
  default:
    return "unknown";
  }
}

[[nodiscard]] std::optional<std::string>
keyframe_interpolation_name(AEGP_KeyframeInterpolationType type) {
  switch (type) {
  case AEGP_KeyInterp_NONE:
    return "none";
  case AEGP_KeyInterp_LINEAR:
    return "linear";
  case AEGP_KeyInterp_BEZIER:
    return "bezier";
  case AEGP_KeyInterp_HOLD:
    return "hold";
  default:
    return std::nullopt;
  }
}

template <std::size_t Size>
constexpr std::size_t literal_size(const char (&)[Size]) noexcept {
  return Size - 1;
}

[[nodiscard]] std::size_t locator_json_size(const ObjectLocator &locator) {
  return literal_size("{\"generation\":") +
         std::to_string(locator.generation).size() +
         literal_size(",\"hostInstanceId\":") +
         aemcp::native::json_encoded_string_size(locator.host_instance_id) +
         literal_size(",\"kind\":") +
         aemcp::native::json_encoded_string_size(locator.kind) +
         literal_size(",\"objectId\":") +
         aemcp::native::json_encoded_string_size(locator.object_id) +
         literal_size(",\"projectId\":") +
         aemcp::native::json_encoded_string_size(locator.project_id) +
         literal_size(",\"sessionId\":") +
         aemcp::native::json_encoded_string_size(locator.session_id) +
         literal_size("}");
}

[[nodiscard]] std::size_t
nullable_locator_json_size(const std::optional<ObjectLocator> &locator) {
  return locator.has_value() ? locator_json_size(*locator)
                             : literal_size("null");
}

[[nodiscard]] std::size_t
project_item_json_size(const aemcp::native::ProjectItemEntry &item) {
  return literal_size("{\"locator\":") + locator_json_size(item.locator) +
         literal_size(",\"name\":") +
         aemcp::native::json_encoded_string_size(item.name) +
         literal_size(",\"parentLocator\":") +
         nullable_locator_json_size(item.parent_locator) +
         literal_size(",\"type\":") +
         aemcp::native::json_encoded_string_size(item.type) + literal_size("}");
}

[[nodiscard]] std::size_t
composition_layer_json_size(const aemcp::native::CompositionLayerEntry &layer) {
  return literal_size("{\"isThreeD\":") + literal_size("false") +
         literal_size(",\"locator\":") + locator_json_size(layer.locator) +
         literal_size(",\"locked\":") + literal_size("false") +
         literal_size(",\"name\":") +
         aemcp::native::json_encoded_string_size(layer.name) +
         literal_size(",\"parentLocator\":") +
         nullable_locator_json_size(layer.parent_locator) +
         literal_size(",\"sourceItemLocator\":") +
         nullable_locator_json_size(layer.source_item_locator) +
         literal_size(",\"stackIndex\":") +
         std::to_string(layer.stack_index).size() + literal_size(",\"type\":") +
         aemcp::native::json_encoded_string_size(layer.type) +
         literal_size(",\"videoEnabled\":") + literal_size("false") +
         literal_size("}");
}

[[nodiscard]] std::size_t
layer_property_json_size(const aemcp::native::LayerPropertyEntry &property) {
  std::size_t value_size = literal_size("null");
  if (const auto *scalar = std::get_if<aemcp::native::LayerPropertyScalarValue>(
          &property.value)) {
    value_size = 32U + aemcp::native::json_encoded_string_size(scalar->value);
  } else if (const auto *vector =
                 std::get_if<aemcp::native::LayerPropertyVectorValue>(
                     &property.value)) {
    value_size = 32U;
    for (const std::string &component : vector->components) {
      value_size += aemcp::native::json_encoded_string_size(component) + 1U;
    }
  } else if (const auto *color =
                 std::get_if<aemcp::native::LayerPropertyColorValue>(
                     &property.value)) {
    value_size = 64U + aemcp::native::json_encoded_string_size(color->alpha) +
                 aemcp::native::json_encoded_string_size(color->red) +
                 aemcp::native::json_encoded_string_size(color->green) +
                 aemcp::native::json_encoded_string_size(color->blue);
  }
  return 512U + locator_json_size(property.property_locator) +
         aemcp::native::json_encoded_string_size(property.name) +
         aemcp::native::json_encoded_string_size(property.match_name) +
         value_size;
}

[[nodiscard]] std::size_t layer_property_keyframe_json_size(
    const aemcp::native::LayerPropertyKeyframeEntry &keyframe) {
  std::size_t value_size = 64U;
  if (const auto *scalar = std::get_if<aemcp::native::LayerPropertyScalarValue>(
          &keyframe.value)) {
    value_size += aemcp::native::json_encoded_string_size(scalar->value);
  } else if (const auto *vector =
                 std::get_if<aemcp::native::LayerPropertyVectorValue>(
                     &keyframe.value)) {
    for (const std::string &component : vector->components) {
      value_size += aemcp::native::json_encoded_string_size(component) + 1U;
    }
  } else if (const auto *color =
                 std::get_if<aemcp::native::LayerPropertyColorValue>(
                     &keyframe.value)) {
    value_size += aemcp::native::json_encoded_string_size(color->alpha) +
                  aemcp::native::json_encoded_string_size(color->red) +
                  aemcp::native::json_encoded_string_size(color->green) +
                  aemcp::native::json_encoded_string_size(color->blue);
  }
  return 320U + value_size +
         aemcp::native::json_encoded_string_size(keyframe.in_interpolation) +
         aemcp::native::json_encoded_string_size(keyframe.out_interpolation);
}

class AegpHostApi final : public NativeProgramPrimitiveHost {
public:
  AegpHostApi(SPBasicSuite *basic, AEGP_PluginID plugin_id,
              ProjectGraphRegistry &graph,
              const AEGP_UtilitySuite6 *utility_suite)
      : basic_(basic), plugin_id_(plugin_id), graph_(graph),
        utility_suite_(utility_suite) {}

  ~AegpHostApi() override {
    if (undo_open_ && utility_suite_ != nullptr) {
      (void)utility_suite_->AEGP_EndUndoGroup();
    }
  }

  [[nodiscard]] NativeProgramHostResult execute_native_program(
      const NativeProgram &program, std::string_view host_instance_id,
      std::string_view session_id, TimePoint work_deadline) override {
    return aemcp::native::execute_native_program(
        *this, program, host_instance_id, session_id, work_deadline);
  }

  [[nodiscard]] NativeHandleResolveResult
  resolve_native_handle(aemcp::native::HandleKind kind,
                        const ObjectLocator &locator,
                        const std::optional<ObjectLocator> &owner_locator,
                        TimePoint work_deadline) override {
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return NativeHandleResolveResult::failure(
          "DEADLINE_EXCEEDED", "native handle resolution budget elapsed");
    }
    if (kind == aemcp::native::HandleKind::kLayer) {
      if (!owner_locator.has_value() || owner_locator->kind != "composition") {
        return NativeHandleResolveResult::failure(
            "INVALID_ARGUMENT",
            "layer resolution requires a composition handle",
            "params.arguments.composition");
      }
      const auto layer_address = graph_.resolve_layer(
          locator, locator.host_instance_id, locator.session_id);
      const auto composition_id = graph_.resolve_composition(
          *owner_locator, owner_locator->host_instance_id,
          owner_locator->session_id);
      if (!layer_address.has_value() || !composition_id.has_value() ||
          layer_address->composition_item_id != *composition_id) {
        return NativeHandleResolveResult::failure(
            "STALE_LOCATOR",
            "layer locator does not belong to the resolved composition",
            "params.arguments.locator");
      }
      return resolve_program_layer_handle(locator, work_deadline);
    }
    if (kind == aemcp::native::HandleKind::kProperty) {
      if (!owner_locator.has_value() || owner_locator->kind != "layer" ||
          !graph_
               .resolve_stream(locator, *owner_locator,
                               locator.host_instance_id, locator.session_id)
               .has_value()) {
        return NativeHandleResolveResult::failure(
            "STALE_LOCATOR",
            "property locator does not belong to the resolved layer",
            "params.arguments.locator");
      }
      return NativeHandleResolveResult::success(
          aemcp::native::ScopedPropertyHandle{locator, *owner_locator, 0});
    }
    if (owner_locator.has_value()) {
      return NativeHandleResolveResult::failure(
          "INVALID_ARGUMENT",
          "composition resolution does not accept an owner handle",
          "params.arguments");
    }
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return NativeHandleResolveResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition resolver suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto composition_id = graph_.resolve_composition(
        locator, locator.host_instance_id, locator.session_id);
    const auto item =
        open.has_value() && composition_id.has_value()
            ? find_project_item(item_suite.get(), open->project, open->root,
                                *composition_id, work_deadline)
            : std::nullopt;
    AEGP_CompH composition = nullptr;
    if (!item.has_value() ||
        comp_suite->AEGP_GetCompFromItem(*item, &composition) != A_Err_NONE ||
        composition == nullptr) {
      return NativeHandleResolveResult::failure(
          "STALE_LOCATOR",
          "composition locator does not identify an open composition",
          "params.arguments.locator");
    }
    return NativeHandleResolveResult::success(
        aemcp::native::ScopedCompositionHandle{
            locator, reinterpret_cast<std::uintptr_t>(composition)});
  }

  [[nodiscard]] HostProjectGraphInvalidationResult
  invalidate_project_graph(TimePoint work_deadline) override {
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostProjectGraphInvalidationResult::failure(
          "DEADLINE_EXCEEDED", "project graph invalidation budget elapsed");
    }
    try {
      const bool invalidated = graph_.invalidate_project();
      return HostProjectGraphInvalidationResult::success({
          invalidated,
          invalidated ? graph_.generation() : 0,
      });
    } catch (...) {
      return HostProjectGraphInvalidationResult::failure(
          "NATIVE_UNAVAILABLE",
          "could not invalidate the native project graph");
    }
  }

  [[nodiscard]] HostProjectItemsResult
  list_project_items(const aemcp::native::ProjectItemsQuery &query,
                     TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        memory_suite.get() == nullptr) {
      return HostProjectItemsResult::failure(
          "NATIVE_UNSUPPORTED", "required project item suites are unavailable");
    }
    if (budget_expired()) {
      return HostProjectItemsResult::failure(
          "DEADLINE_EXCEEDED", "project item list budget elapsed");
    }
    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostProjectItemsResult::failure("CAPABILITY_FAILED",
                                             "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostProjectItemsResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root) !=
            A_Err_NONE ||
        root == nullptr ||
        item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root), root_id,
                             std::move(*project_path));
    } catch (...) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    if (query.project_locator.has_value() &&
        !graph_.matches_project(*query.project_locator, query.host_instance_id,
                                query.session_id)) {
      return HostProjectItemsResult::failure(
          "STALE_LOCATOR",
          "projectLocator does not identify the currently open project",
          "params.arguments.projectLocator");
    }

    aemcp::native::ProjectItemsPage page;
    page.project_locator =
        graph_.project_locator(query.host_instance_id, query.session_id);
    page.offset = query.offset;
    page.limit = query.limit;
    aemcp::native::BoundedPageBudget page_budget(
        1024U + locator_json_size(page.project_locator));
    bool response_budget_exhausted = false;
    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED", "could not begin project item traversal");
    }
    std::uint64_t position = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostProjectItemsResult::failure(
            "DEADLINE_EXCEEDED", "project item traversal budget elapsed");
      }
      if (position >= static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostProjectItemsResult::failure("CAPABILITY_FAILED",
                                               "project item bound exceeded");
      }
      if (position >= query.offset && page.items.size() < query.limit &&
          !response_budget_exhausted) {
        AEGP_ItemType sdk_type = AEGP_ItemType_NONE;
        A_long item_id = 0;
        AEGP_ItemH parent = nullptr;
        if (item_suite->AEGP_GetItemType(item, &sdk_type) != A_Err_NONE ||
            item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE ||
            item_suite->AEGP_GetItemParentFolder(item, &parent) != A_Err_NONE) {
          return HostProjectItemsResult::failure(
              "CAPABILITY_FAILED", "could not read project item identity");
        }
        AEGP_MemHandle name_handle = nullptr;
        const A_Err name_error =
            item_suite->AEGP_GetItemName(plugin_id_, item, &name_handle);
        MemHandleOwner name_owner(memory_suite.get(), name_handle);
        if (name_error != A_Err_NONE || name_handle == nullptr) {
          return HostProjectItemsResult::failure(
              "CAPABILITY_FAILED", "could not read project item name");
        }
        const std::optional<std::string> name = name_owner.utf8();
        if (!name.has_value()) {
          return HostProjectItemsResult::failure(
              "CAPABILITY_FAILED",
              "project item name is not bounded UTF-16 text");
        }
        const std::string type = project_item_type(sdk_type);
        aemcp::native::ProjectItemEntry entry;
        entry.locator =
            graph_.item_locator(item_id, sdk_type == AEGP_ItemType_COMP,
                                query.host_instance_id, query.session_id);
        entry.name = *name;
        entry.type = type;
        if (parent == nullptr || parent == root) {
          entry.parent_locator = page.project_locator;
        } else {
          A_long parent_id = 0;
          if (item_suite->AEGP_GetItemID(parent, &parent_id) != A_Err_NONE) {
            return HostProjectItemsResult::failure(
                "CAPABILITY_FAILED",
                "could not read project item parent identity");
          }
          entry.parent_locator = graph_.item_locator(
              parent_id, false, query.host_instance_id, query.session_id);
        }
        const std::size_t entry_bytes =
            project_item_json_size(entry) + (page.items.empty() ? 0U : 1U);
        if (!page_budget.try_reserve(entry_bytes)) {
          if (page.items.empty()) {
            return HostProjectItemsResult::failure(
                "CAPABILITY_FAILED",
                "one project item exceeds the bounded native response budget");
          }
          response_budget_exhausted = true;
        } else {
          page.items.push_back(std::move(entry));
        }
      }
      ++position;
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostProjectItemsResult::failure("CAPABILITY_FAILED",
                                               "project item traversal failed");
      }
      item = next;
    }
    page.total = position;
    if (query.offset > page.total) {
      return HostProjectItemsResult::failure(
          "INVALID_ARGUMENT", "offset exceeds the current project item total",
          "params.arguments.offset");
    }
    page.has_more = query.offset + page.items.size() < page.total;
    if (page.has_more)
      page.next_offset = query.offset + page.items.size();
    return HostProjectItemsResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionSettingsResult read_composition_settings(
      const aemcp::native::CompositionSettingsQuery &query,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr) {
      return HostCompositionSettingsResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition settings suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_composition(
        query.composition_locator, query.host_instance_id, query.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostCompositionSettingsResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an open-project composition",
          "params.arguments.compositionLocator");
    }
    const auto item = find_project_item(item_suite.get(), open->project,
                                        open->root, *item_id, work_deadline);
    AEGP_CompH comp = nullptr;
    if (!item.has_value() ||
        comp_suite->AEGP_GetCompFromItem(*item, &comp) != A_Err_NONE ||
        comp == nullptr) {
      return HostCompositionSettingsResult::failure(
          "STALE_LOCATOR", "composition identity could not be reacquired",
          "params.arguments.compositionLocator");
    }
    auto settings = composition_settings(
        item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), *item, comp, query.composition_locator);
    if (!settings.has_value()) {
      return HostCompositionSettingsResult::failure(
          "CAPABILITY_FAILED", "could not read composition settings");
    }
    return HostCompositionSettingsResult::success(std::move(*settings));
  }

  [[nodiscard]] HostCompositionSettingsWriteResult set_composition_setting(
      const aemcp::native::CompositionSettingsSetCommand &command,
      TimePoint work_deadline) override {
    const auto expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(basic_, kAEGPUtilitySuite,
                                                 kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostCompositionSettingsWriteResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition settings mutation suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_composition(command.composition_locator,
                                                    command.host_instance_id,
                                                    command.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostCompositionSettingsWriteResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify the open composition",
          "params.arguments.compositionLocator");
    }
    const auto item = find_project_item(item_suite.get(), open->project,
                                        open->root, *item_id, work_deadline);
    AEGP_CompH comp = nullptr;
    if (!item.has_value() ||
        comp_suite->AEGP_GetCompFromItem(*item, &comp) != A_Err_NONE ||
        comp == nullptr) {
      return HostCompositionSettingsWriteResult::failure(
          "STALE_LOCATOR", "composition identity could not be reacquired",
          "params.arguments.compositionLocator");
    }
    auto before = composition_settings(
        item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), *item, comp, command.composition_locator);
    if (!before.has_value()) {
      return HostCompositionSettingsWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not read composition settings before mutation");
    }
    const auto time_equal = [](const CompositionCurrentTime &left,
                               const CompositionCurrentTime &right) {
      return static_cast<std::int64_t>(left.value) * right.scale ==
             static_cast<std::int64_t>(right.value) * left.scale;
    };
    const bool same_target =
        (command.kind == CompositionSettingKind::kDuration &&
         time_equal(before->duration, command.time)) ||
        (command.kind == CompositionSettingKind::kFrameRate &&
         before->frame_rate == command.ratio) ||
        (command.kind == CompositionSettingKind::kPixelAspectRatio &&
         before->pixel_aspect_ratio == command.ratio) ||
        (command.kind == CompositionSettingKind::kDisplayStartTime &&
         time_equal(before->display_start_time, command.time));
    if (same_target) {
      return HostCompositionSettingsWriteResult::failure(
          "INVALID_ARGUMENT",
          "composition setting already matches the requested value",
          "params.arguments");
    }
    if ((command.kind == CompositionSettingKind::kDuration ||
         command.kind == CompositionSettingKind::kDisplayStartTime) &&
        (static_cast<std::int64_t>(command.time.value) *
         before->frame_duration.scale) %
                (static_cast<std::int64_t>(command.time.scale) *
                 before->frame_duration.value) !=
            0) {
      return HostCompositionSettingsWriteResult::failure(
          "INVALID_ARGUMENT", "composition time must be exactly frame-aligned",
          "params.arguments");
    }
    if (command.kind == CompositionSettingKind::kDuration &&
        !exact_nonnegative_time_sum_leq(
            before->work_area_start.value, before->work_area_start.scale,
            before->work_area_duration.value, before->work_area_duration.scale,
            command.time.value, command.time.scale)) {
      return HostCompositionSettingsWriteResult::failure(
          "INVALID_ARGUMENT", "duration must not end before the work-area end",
          "params.arguments.duration");
    }
    if (expired()) {
      return HostCompositionSettingsWriteResult::failure(
          "DEADLINE_EXCEEDED", "composition setting mutation budget elapsed");
    }
    const bool undoable =
        command.kind != CompositionSettingKind::kDisplayStartTime;
    const bool owns_undo = undoable && !undo_open_;
    static constexpr char kLabels[][48] = {
        "ae-mcp: Set composition duration",
        "ae-mcp: Set composition frame rate",
        "ae-mcp: Set composition pixel aspect ratio",
        "ae-mcp: Set composition display start time"};
    const std::size_t kind_index = static_cast<std::size_t>(command.kind);
    if (owns_undo &&
        utility_suite->AEGP_StartUndoGroup(kLabels[kind_index]) != A_Err_NONE) {
      return HostCompositionSettingsWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    A_Err set_error = A_Err_NONE;
    const A_Time time{static_cast<A_long>(command.time.value),
                      static_cast<A_u_long>(command.time.scale)};
    const A_Ratio ratio{static_cast<A_long>(command.ratio.numerator),
                        static_cast<A_u_long>(command.ratio.denominator)};
    switch (command.kind) {
    case CompositionSettingKind::kDuration:
      set_error = comp_suite->AEGP_SetCompDuration(comp, &time);
      break;
    case CompositionSettingKind::kFrameRate: {
      const A_FpLong frame_rate =
          static_cast<A_FpLong>(command.ratio.numerator) /
          static_cast<A_FpLong>(command.ratio.denominator);
      set_error = comp_suite->AEGP_SetCompFrameRate(comp, &frame_rate);
      break;
    }
    case CompositionSettingKind::kPixelAspectRatio:
      set_error = comp_suite->AEGP_SetCompPixelAspectRatio(comp, &ratio);
      break;
    case CompositionSettingKind::kDisplayStartTime:
      set_error = comp_suite->AEGP_SetCompDisplayStartTime(comp, &time);
      break;
    }
    const A_Err end_error =
        owns_undo ? utility_suite->AEGP_EndUndoGroup() : A_Err_NONE;
    auto after = composition_settings(item_suite.get(), comp_suite.get(),
                                      layer_suite.get(), memory_suite.get(),
                                      *item, comp, command.composition_locator);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE ||
        !after.has_value() || expired()) {
      return HostCompositionSettingsWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition setting may have changed but exact readback failed");
    }
    CompositionSettingsChanged changed;
    changed.composition_locator = command.composition_locator;
    changed.before = std::move(*before);
    changed.after = std::move(*after);
    return HostCompositionSettingsWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostCompositionLayersResult
  list_composition_layers(const aemcp::native::CompositionLayersQuery &query,
                          TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr) {
      return HostCompositionLayersResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition layer suites are unavailable");
    }
    A_long project_count = 0;
    if (budget_expired()) {
      return HostCompositionLayersResult::failure(
          "DEADLINE_EXCEEDED", "composition layer list budget elapsed");
    }
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostCompositionLayersResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root) !=
            A_Err_NONE ||
        root == nullptr ||
        item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root), root_id,
                             std::move(*project_path));
    } catch (...) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const std::optional<A_long> composition_id = graph_.resolve_composition(
        query.composition_locator, query.host_instance_id, query.session_id);
    if (!composition_id.has_value()) {
      return HostCompositionLayersResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an item in the currently open "
          "project",
          "params.arguments.compositionLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostCompositionLayersResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == *composition_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostCompositionLayersResult::failure(
          "STALE_LOCATOR",
          "composition item no longer exists in the open project",
          "params.arguments.compositionLocator");
    }
    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) !=
        A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not verify composition item type");
    }
    if (item_type != AEGP_ItemType_COMP) {
      return HostCompositionLayersResult::failure(
          "PRECONDITION_FAILED",
          "compositionLocator no longer identifies a composition",
          "params.arguments.compositionLocator");
    }
    AEGP_MemHandle composition_name_handle = nullptr;
    const A_Err composition_name_error = item_suite->AEGP_GetItemName(
        plugin_id_, composition_item, &composition_name_handle);
    MemHandleOwner composition_name_owner(memory_suite.get(),
                                          composition_name_handle);
    if (composition_name_error != A_Err_NONE ||
        composition_name_handle == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read composition name");
    }
    const std::optional<std::string> composition_name =
        composition_name_owner.utf8();
    if (!composition_name.has_value()) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "composition name is not bounded UTF-16 text");
    }
    AEGP_CompH composition = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) !=
            A_Err_NONE ||
        composition == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not resolve composition handle");
    }
    A_long layer_count = 0;
    if (layer_suite->AEGP_GetCompNumLayers(composition, &layer_count) !=
            A_Err_NONE ||
        layer_count < 0) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read composition layer count");
    }

    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = *composition_name;
    page.total = static_cast<std::uint64_t>(layer_count);
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset > page.total) {
      return HostCompositionLayersResult::failure(
          "INVALID_ARGUMENT",
          "offset exceeds the current composition layer total",
          "params.arguments.offset");
    }
    aemcp::native::BoundedPageBudget page_budget(
        1024U + locator_json_size(page.composition_locator) +
        aemcp::native::json_encoded_string_size(page.composition_name));
    const std::uint64_t end =
        query.offset >= page.total
            ? query.offset
            : std::min(page.total, query.offset + query.limit);
    for (std::uint64_t position = query.offset; position < end; ++position) {
      if (budget_expired()) {
        return HostCompositionLayersResult::failure(
            "DEADLINE_EXCEEDED", "composition layer page budget elapsed");
      }
      AEGP_LayerH layer = nullptr;
      if (layer_suite->AEGP_GetCompLayerByIndex(composition,
                                                static_cast<A_long>(position),
                                                &layer) != A_Err_NONE ||
          layer == nullptr) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not resolve composition layer");
      }
      AEGP_LayerIDVal layer_id = 0;
      AEGP_LayerFlags flags = 0;
      AEGP_ObjectType object_type = AEGP_ObjectType_NONE;
      if (layer_suite->AEGP_GetLayerID(layer, &layer_id) != A_Err_NONE ||
          layer_suite->AEGP_GetLayerFlags(layer, &flags) != A_Err_NONE ||
          layer_suite->AEGP_GetLayerObjectType(layer, &object_type) !=
              A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read composition layer identity");
      }
      std::string layer_name_error;
      const std::optional<std::string> layer_name = read_effective_layer_name(
          layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_,
          layer, layer_name_error);
      if (!layer_name.has_value()) {
        return HostCompositionLayersResult::failure("CAPABILITY_FAILED",
                                                    layer_name_error);
      }
      aemcp::native::CompositionLayerEntry entry;
      entry.locator = graph_.layer_locator(
          *composition_id, layer_id, query.host_instance_id, query.session_id);
      entry.stack_index = position + 1;
      entry.name = *layer_name;
      entry.type = layer_type(object_type, flags);
      entry.video_enabled = (flags & AEGP_LayerFlag_VIDEO_ACTIVE) != 0;
      entry.is_three_d = (flags & AEGP_LayerFlag_LAYER_IS_3D) != 0;
      entry.locked = (flags & AEGP_LayerFlag_LOCKED) != 0;

      AEGP_LayerH parent = nullptr;
      if (layer_suite->AEGP_GetLayerParent(layer, &parent) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read parent layer");
      }
      if (parent != nullptr) {
        AEGP_LayerIDVal parent_id = 0;
        if (layer_suite->AEGP_GetLayerID(parent, &parent_id) != A_Err_NONE) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED", "could not read parent layer identity");
        }
        entry.parent_locator =
            graph_.layer_locator(*composition_id, parent_id,
                                 query.host_instance_id, query.session_id);
      }

      AEGP_ItemH source_item = nullptr;
      if (layer_suite->AEGP_GetLayerSourceItem(layer, &source_item) !=
          A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read layer source item");
      }
      if (source_item != nullptr) {
        A_long source_id = 0;
        AEGP_ItemType source_type = AEGP_ItemType_NONE;
        if (item_suite->AEGP_GetItemID(source_item, &source_id) != A_Err_NONE ||
            item_suite->AEGP_GetItemType(source_item, &source_type) !=
                A_Err_NONE) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED", "could not read layer source item identity");
        }
        entry.source_item_locator =
            graph_.item_locator(source_id, source_type == AEGP_ItemType_COMP,
                                query.host_instance_id, query.session_id);
      }
      const std::size_t entry_bytes =
          composition_layer_json_size(entry) + (page.layers.empty() ? 0U : 1U);
      if (!page_budget.try_reserve(entry_bytes)) {
        if (page.layers.empty()) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED", "one composition layer exceeds the bounded "
                                   "native response budget");
        }
        break;
      }
      page.layers.push_back(std::move(entry));
    }
    page.has_more = query.offset + page.layers.size() < page.total;
    if (page.has_more)
      page.next_offset = query.offset + page.layers.size();
    return HostCompositionLayersResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionLayersResult list_selected_composition_layers(
      const aemcp::native::CompositionLayersQuery &query,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_CollectionSuite2> collection_suite(
        basic_, kAEGPCollectionSuite, kAEGPCollectionSuiteVersion2);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        collection_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostCompositionLayersResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition selection suites are unavailable");
    }
    if (budget_expired()) {
      return HostCompositionLayersResult::failure(
          "DEADLINE_EXCEEDED", "selected layer list budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostCompositionLayersResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }

    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root) !=
            A_Err_NONE ||
        root == nullptr ||
        item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root), root_id,
                             std::move(*project_path));
    } catch (...) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const std::optional<A_long> composition_id = graph_.resolve_composition(
        query.composition_locator, query.host_instance_id, query.session_id);
    if (!composition_id.has_value()) {
      return HostCompositionLayersResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an item in the currently open "
          "project",
          "params.arguments.compositionLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostCompositionLayersResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == *composition_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostCompositionLayersResult::failure(
          "STALE_LOCATOR",
          "composition item no longer exists in the open project",
          "params.arguments.compositionLocator");
    }
    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) !=
        A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not verify composition item type");
    }
    if (item_type != AEGP_ItemType_COMP) {
      return HostCompositionLayersResult::failure(
          "PRECONDITION_FAILED",
          "compositionLocator no longer identifies a composition",
          "params.arguments.compositionLocator");
    }
    AEGP_MemHandle composition_name_handle = nullptr;
    const A_Err composition_name_error = item_suite->AEGP_GetItemName(
        plugin_id_, composition_item, &composition_name_handle);
    MemHandleOwner composition_name_owner(memory_suite.get(),
                                          composition_name_handle);
    if (composition_name_error != A_Err_NONE ||
        composition_name_handle == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read composition name");
    }
    const std::optional<std::string> composition_name =
        composition_name_owner.utf8();
    if (!composition_name.has_value()) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "composition name is not bounded UTF-16 text");
    }
    AEGP_CompH composition = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) !=
            A_Err_NONE ||
        composition == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not resolve composition handle");
    }
    if (budget_expired()) {
      return HostCompositionLayersResult::failure(
          "DEADLINE_EXCEEDED", "selected layer list budget elapsed");
    }

    AEGP_Collection2H collection = nullptr;
    const A_Err collection_error =
        comp_suite->AEGP_GetNewCollectionFromCompSelection(
            plugin_id_, composition, &collection);
    aemcp::native::OwnedSelectionCollection collection_owner(
        collection,
        [suite = collection_suite.get()](AEGP_Collection2H owned) noexcept {
          (void)suite->AEGP_DisposeCollection(owned);
        });
    if (collection_error != A_Err_NONE || collection == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read the composition selection");
    }
    A_u_long collection_size = 0;
    if (collection_suite->AEGP_GetCollectionNumItems(
            collection_owner.get(), &collection_size) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read the composition selection size");
    }
    if (collection_size > static_cast<A_u_long>(kMaximumProjectItems)) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "composition selection bound exceeded");
    }

    std::vector<aemcp::native::SelectionCollectionEntry> collection_entries;
    collection_entries.reserve(static_cast<std::size_t>(collection_size));
    for (A_u_long index = 0; index < collection_size; ++index) {
      if (budget_expired()) {
        return HostCompositionLayersResult::failure(
            "DEADLINE_EXCEEDED",
            "composition selection traversal budget elapsed");
      }
      AEGP_CollectionItemV2 selection_item{};
      if (collection_suite->AEGP_GetCollectionItemByIndex(
              collection_owner.get(), index, &selection_item) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read a composition selection item");
      }
      if (selection_item.type != AEGP_CollectionItemType_LAYER) {
        collection_entries.push_back(
            {aemcp::native::SelectionCollectionEntryKind::kNonLayer, 0, 0, 0});
        continue;
      }
      AEGP_LayerH layer = selection_item.u.layer.layerH;
      if (layer == nullptr) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED",
            "After Effects returned an empty selected layer");
      }
      AEGP_CompH parent_composition = nullptr;
      A_long layer_index = -1;
      AEGP_LayerIDVal layer_id = 0;
      if (layer_suite->AEGP_GetLayerParentComp(layer, &parent_composition) !=
              A_Err_NONE ||
          parent_composition != composition ||
          layer_suite->AEGP_GetLayerIndex(layer, &layer_index) != A_Err_NONE ||
          layer_index < 0 ||
          layer_suite->AEGP_GetLayerID(layer, &layer_id) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED",
            "selected layer does not belong to the requested composition");
      }
      collection_entries.push_back(
          {aemcp::native::SelectionCollectionEntryKind::kLayer,
           reinterpret_cast<std::uintptr_t>(layer),
           static_cast<std::int64_t>(layer_id),
           static_cast<std::uint64_t>(layer_index) + 1U});
    }
    aemcp::native::NormalizedSelectedLayers normalized =
        aemcp::native::normalize_selected_layer_collection(
            std::move(collection_entries));
    if (!normalized.ok) {
      return HostCompositionLayersResult::failure("CAPABILITY_FAILED",
                                                  std::move(normalized.error));
    }
    const auto &selected = normalized.layers;

    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = *composition_name;
    page.total = selected.size();
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset > page.total) {
      return HostCompositionLayersResult::failure(
          "INVALID_ARGUMENT", "offset exceeds the current selected layer total",
          "params.arguments.offset");
    }
    aemcp::native::BoundedPageBudget page_budget(
        1024U + locator_json_size(page.composition_locator) +
        aemcp::native::json_encoded_string_size(page.composition_name));
    const std::uint64_t end =
        query.offset >= page.total
            ? query.offset
            : std::min(page.total, query.offset + query.limit);
    for (std::uint64_t position = query.offset; position < end; ++position) {
      if (budget_expired()) {
        return HostCompositionLayersResult::failure(
            "DEADLINE_EXCEEDED", "selected layer page budget elapsed");
      }
      const aemcp::native::SelectionCollectionEntry &candidate =
          selected[position];
      AEGP_LayerH layer = reinterpret_cast<AEGP_LayerH>(candidate.opaque_layer);
      AEGP_LayerFlags flags = 0;
      AEGP_ObjectType object_type = AEGP_ObjectType_NONE;
      if (layer_suite->AEGP_GetLayerFlags(layer, &flags) != A_Err_NONE ||
          layer_suite->AEGP_GetLayerObjectType(layer, &object_type) !=
              A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read selected layer attributes");
      }
      std::string layer_name_error;
      const std::optional<std::string> layer_name = read_effective_layer_name(
          layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_,
          layer, layer_name_error);
      if (!layer_name.has_value()) {
        return HostCompositionLayersResult::failure("CAPABILITY_FAILED",
                                                    layer_name_error);
      }

      aemcp::native::CompositionLayerEntry entry;
      entry.locator = graph_.layer_locator(
          *composition_id, static_cast<AEGP_LayerIDVal>(candidate.layer_id),
          query.host_instance_id, query.session_id);
      entry.stack_index = candidate.stack_index;
      entry.name = *layer_name;
      entry.type = layer_type(object_type, flags);
      entry.video_enabled = (flags & AEGP_LayerFlag_VIDEO_ACTIVE) != 0;
      entry.is_three_d = (flags & AEGP_LayerFlag_LAYER_IS_3D) != 0;
      entry.locked = (flags & AEGP_LayerFlag_LOCKED) != 0;

      AEGP_LayerH parent = nullptr;
      if (layer_suite->AEGP_GetLayerParent(layer, &parent) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read selected layer parent");
      }
      if (parent != nullptr) {
        AEGP_LayerIDVal parent_id = 0;
        if (layer_suite->AEGP_GetLayerID(parent, &parent_id) != A_Err_NONE) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED", "could not read parent layer identity");
        }
        entry.parent_locator =
            graph_.layer_locator(*composition_id, parent_id,
                                 query.host_instance_id, query.session_id);
      }

      AEGP_ItemH source_item = nullptr;
      if (layer_suite->AEGP_GetLayerSourceItem(layer, &source_item) !=
          A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read selected layer source item");
      }
      if (source_item != nullptr) {
        A_long source_id = 0;
        AEGP_ItemType source_type = AEGP_ItemType_NONE;
        if (item_suite->AEGP_GetItemID(source_item, &source_id) != A_Err_NONE ||
            item_suite->AEGP_GetItemType(source_item, &source_type) !=
                A_Err_NONE) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED",
              "could not read selected layer source identity");
        }
        entry.source_item_locator =
            graph_.item_locator(source_id, source_type == AEGP_ItemType_COMP,
                                query.host_instance_id, query.session_id);
      }
      const std::size_t entry_bytes =
          composition_layer_json_size(entry) + (page.layers.empty() ? 0U : 1U);
      if (!page_budget.try_reserve(entry_bytes)) {
        if (page.layers.empty()) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED",
              "one selected layer exceeds the bounded native response budget");
        }
        break;
      }
      page.layers.push_back(std::move(entry));
    }
    page.has_more = query.offset + page.layers.size() < page.total;
    if (page.has_more)
      page.next_offset = query.offset + page.layers.size();
    return HostCompositionLayersResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionTimeResult
  read_composition_time(const aemcp::native::CompositionTimeQuery &query,
                        TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        memory_suite.get() == nullptr) {
      return HostCompositionTimeResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition time suites are unavailable");
    }
    if (budget_expired()) {
      return HostCompositionTimeResult::failure(
          "DEADLINE_EXCEEDED", "composition time read budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionTimeResult::failure("CAPABILITY_FAILED",
                                                "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostCompositionTimeResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }

    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (budget_expired()) {
      return HostCompositionTimeResult::failure(
          "DEADLINE_EXCEEDED", "composition time read budget elapsed");
    }
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root) !=
            A_Err_NONE ||
        root == nullptr ||
        item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root), root_id,
                             std::move(*project_path));
    } catch (...) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const std::optional<A_long> composition_id = graph_.resolve_composition(
        query.composition_locator, query.host_instance_id, query.session_id);
    if (!composition_id.has_value()) {
      return HostCompositionTimeResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an item in the currently open "
          "project",
          "params.arguments.compositionLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostCompositionTimeResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostCompositionTimeResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostCompositionTimeResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == *composition_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostCompositionTimeResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostCompositionTimeResult::failure(
          "STALE_LOCATOR",
          "composition item no longer exists in the open project",
          "params.arguments.compositionLocator");
    }

    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) !=
        A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not verify composition item type");
    }
    if (item_type != AEGP_ItemType_COMP) {
      return HostCompositionTimeResult::failure(
          "PRECONDITION_FAILED",
          "compositionLocator no longer identifies a composition",
          "params.arguments.compositionLocator");
    }
    if (budget_expired()) {
      return HostCompositionTimeResult::failure(
          "DEADLINE_EXCEEDED", "composition time read budget elapsed");
    }

    A_Time current_time{};
    if (item_suite->AEGP_GetItemCurrentTime(composition_item, &current_time) !=
        A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not read composition current time");
    }
    if (budget_expired()) {
      return HostCompositionTimeResult::failure(
          "DEADLINE_EXCEEDED", "composition time read budget elapsed");
    }
    if (current_time.scale == 0) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED",
          "After Effects returned a zero composition time scale");
    }
    aemcp::native::CompositionTimeRead result;
    result.composition_locator = query.composition_locator;
    result.current_time.value = static_cast<std::int32_t>(current_time.value);
    result.current_time.scale = static_cast<std::uint32_t>(current_time.scale);
    result.current_time.seconds_rational =
        aemcp::native::canonical_seconds_rational(
            static_cast<std::int64_t>(result.current_time.value),
            static_cast<std::uint64_t>(result.current_time.scale));
    return HostCompositionTimeResult::success(std::move(result));
  }

  [[nodiscard]] HostCompositionTimeWriteResult
  set_composition_time(const aemcp::native::CompositionTimeSetCommand &command,
                       TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(basic_, kAEGPUtilitySuite,
                                                 kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        memory_suite.get() == nullptr || utility_suite.get() == nullptr) {
      return HostCompositionTimeWriteResult::failure(
          "NATIVE_UNSUPPORTED",
          "required composition time mutation suites are unavailable");
    }
    if (command.target_time.scale == 0 ||
        command.target_time.seconds_rational !=
            aemcp::native::canonical_seconds_rational(
                command.target_time.value, command.target_time.scale)) {
      return HostCompositionTimeWriteResult::failure(
          "INVALID_ARGUMENT", "targetTime must be a valid exact rational time",
          "params.arguments.targetTime");
    }
    if (budget_expired()) {
      return HostCompositionTimeWriteResult::failure(
          "DEADLINE_EXCEEDED", "composition time mutation budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not read project count before mutation");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostCompositionTimeWriteResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }

    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root) !=
            A_Err_NONE ||
        root == nullptr ||
        item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root), root_id,
                             std::move(*project_path));
    } catch (...) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const std::optional<A_long> composition_id = graph_.resolve_composition(
        command.composition_locator, command.host_instance_id,
        command.session_id);
    if (!composition_id.has_value()) {
      return HostCompositionTimeWriteResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an item in the currently open "
          "project",
          "params.arguments.compositionLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostCompositionTimeWriteResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostCompositionTimeWriteResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostCompositionTimeWriteResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == *composition_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostCompositionTimeWriteResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostCompositionTimeWriteResult::failure(
          "STALE_LOCATOR",
          "composition item no longer exists in the open project",
          "params.arguments.compositionLocator");
    }
    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) !=
        A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not verify composition item type");
    }
    if (item_type != AEGP_ItemType_COMP) {
      return HostCompositionTimeWriteResult::failure(
          "PRECONDITION_FAILED",
          "compositionLocator no longer identifies a composition",
          "params.arguments.compositionLocator");
    }

    A_Time before_sdk{};
    if (item_suite->AEGP_GetItemCurrentTime(composition_item, &before_sdk) !=
            A_Err_NONE ||
        before_sdk.scale <= 0) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not read composition time before mutation");
    }
    aemcp::native::CompositionCurrentTime before;
    before.value = static_cast<std::int32_t>(before_sdk.value);
    before.scale = static_cast<std::uint32_t>(before_sdk.scale);
    before.seconds_rational =
        aemcp::native::canonical_seconds_rational(before.value, before.scale);
    const auto same_time =
        [](const aemcp::native::CompositionCurrentTime &left,
           const aemcp::native::CompositionCurrentTime &right) {
          return static_cast<std::int64_t>(left.value) *
                     static_cast<std::int64_t>(right.scale) ==
                 static_cast<std::int64_t>(right.value) *
                     static_cast<std::int64_t>(left.scale);
        };
    if (same_time(before, command.target_time)) {
      return HostCompositionTimeWriteResult::failure(
          "INVALID_ARGUMENT",
          "targetTime already matches the composition's current time",
          "params.arguments.targetTime");
    }
    if (budget_expired()) {
      return HostCompositionTimeWriteResult::failure(
          "DEADLINE_EXCEEDED", "composition time mutation budget elapsed");
    }

    A_Time desired{};
    desired.value = static_cast<A_long>(command.target_time.value);
    desired.scale = static_cast<A_u_long>(command.target_time.scale);
    static constexpr char kUndoLabel[] = "ae-mcp: Set composition current time";
    const bool owns_undo = !undo_open_;
    if (owns_undo &&
        utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error =
        item_suite->AEGP_SetItemCurrentTime(composition_item, &desired);
    const A_Err end_error =
        owns_undo ? utility_suite->AEGP_EndUndoGroup() : A_Err_NONE;
    A_Time after_sdk{};
    const A_Err readback_error =
        item_suite->AEGP_GetItemCurrentTime(composition_item, &after_sdk);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE ||
        readback_error != A_Err_NONE || after_sdk.scale <= 0) {
      return HostCompositionTimeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition time may have changed but native readback or Undo "
          "validation failed");
    }
    aemcp::native::CompositionCurrentTime after;
    after.value = static_cast<std::int32_t>(after_sdk.value);
    after.scale = static_cast<std::uint32_t>(after_sdk.scale);
    after.seconds_rational =
        aemcp::native::canonical_seconds_rational(after.value, after.scale);
    bool transition_verified = same_time(after, command.target_time);
    if (!transition_verified) {
      // After Effects quantizes composition time to whole frames; accept the
      // landed state when it is exactly the frame-aligned quantization of
      // the requested target (e.g. 2.5 s at 25 fps lands on frame 63).
      AEGP_CompH comp_for_rate = nullptr;
      A_FpLong fps = 0.0;
      if (comp_suite.get() != nullptr &&
          comp_suite->AEGP_GetCompFromItem(composition_item, &comp_for_rate) ==
              A_Err_NONE &&
          comp_for_rate != nullptr &&
          comp_suite->AEGP_GetCompFramerate(comp_for_rate, &fps) == A_Err_NONE &&
          fps > 0.0) {
        const auto frame_index = [fps](std::int64_t value, std::uint64_t scale) {
          return std::llround((static_cast<double>(value) /
                               static_cast<double>(scale)) *
                              static_cast<double>(fps));
        };
        transition_verified =
            frame_index(command.target_time.value, command.target_time.scale) ==
            frame_index(after.value, after.scale);
      }
    }
    if (same_time(before, after) || !transition_verified) {
      return HostCompositionTimeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition time readback did not verify the requested state "
          "transition");
    }
    if (budget_expired()) {
      return HostCompositionTimeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition time changed after the validation budget elapsed");
    }
    aemcp::native::CompositionTimeChanged changed;
    changed.changed = true;
    changed.composition_locator = command.composition_locator;
    changed.before_time = std::move(before);
    changed.after_time = std::move(after);
    return HostCompositionTimeWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostLayerPropertiesResult
  list_layer_properties(const aemcp::native::LayerPropertiesQuery &query,
                        TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_StreamSuite6> stream_suite(basic_, kAEGPStreamSuite,
                                               kAEGPStreamSuiteVersion6);
    SuiteLease<AEGP_DynamicStreamSuite4> dynamic_suite(
        basic_, kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr || stream_suite.get() == nullptr ||
        dynamic_suite.get() == nullptr) {
      return HostLayerPropertiesResult::failure(
          "NATIVE_UNSUPPORTED",
          "required layer property suites are unavailable");
    }
    if (budget_expired()) {
      return HostLayerPropertiesResult::failure(
          "DEADLINE_EXCEEDED", "layer property list budget elapsed");
    }
    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostLayerPropertiesResult::failure("CAPABILITY_FAILED",
                                                "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostLayerPropertiesResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root_item = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root_item) !=
            A_Err_NONE ||
        root_item == nullptr ||
        item_suite->AEGP_GetItemID(root_item, &root_id) != A_Err_NONE) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root_item),
                             root_id, std::move(*project_path));
    } catch (...) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto layer_address = graph_.resolve_layer(
        query.layer_locator, query.host_instance_id, query.session_id);
    if (!layer_address.has_value()) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR",
          "layerLocator does not identify a layer in the currently open "
          "project",
          "params.arguments.layerLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) !=
        A_Err_NONE) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostLayerPropertiesResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == layer_address->composition_item_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR", "layer composition no longer exists",
          "params.arguments.layerLocator");
    }
    AEGP_CompH composition = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) !=
            A_Err_NONE ||
        composition == nullptr) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR", "layer composition can no longer be resolved",
          "params.arguments.layerLocator");
    }
    AEGP_LayerH layer = nullptr;
    if (layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE ||
        layer == nullptr) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR", "layer no longer exists in its composition",
          "params.arguments.layerLocator");
    }
    std::string layer_name_error;
    const std::optional<std::string> layer_name = read_effective_layer_name(
        layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_,
        layer, layer_name_error);
    if (!layer_name.has_value()) {
      return HostLayerPropertiesResult::failure("CAPABILITY_FAILED",
                                                layer_name_error);
    }
    A_Time sample_time{};
    if (layer_suite->AEGP_GetLayerCurrentTime(layer, AEGP_LTimeMode_CompTime,
                                              &sample_time) != A_Err_NONE ||
        sample_time.scale <= 0) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED",
          "could not read a bounded composition sample time");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE ||
        root_stream == nullptr) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not resolve the layer property root");
    }
    StreamRefOwner parent_stream(stream_suite.get(), root_stream);
    std::vector<A_long> parent_indices;
    std::vector<std::int32_t> parent_unique_ids;
    if (query.parent_property_locator.has_value()) {
      const auto address = graph_.resolve_stream(
          *query.parent_property_locator, query.layer_locator,
          query.host_instance_id, query.session_id);
      if (!address.has_value()) {
        return HostLayerPropertiesResult::failure(
            "STALE_LOCATOR",
            "parentPropertyLocator does not identify a property on this layer",
            "params.arguments.parentPropertyLocator");
      }
      for (std::size_t depth = 0; depth < address->child_indices.size();
           ++depth) {
        AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
        A_long child_count = 0;
        if (dynamic_suite->AEGP_GetStreamGroupingType(
                parent_stream.get(), &grouping) != A_Err_NONE ||
            grouping == AEGP_StreamGroupingType_LEAF ||
            dynamic_suite->AEGP_GetNumStreamsInGroup(
                parent_stream.get(), &child_count) != A_Err_NONE ||
            address->child_indices[depth] < 0 ||
            address->child_indices[depth] >= child_count) {
          return HostLayerPropertiesResult::failure(
              "STALE_LOCATOR", "parent property path no longer exists",
              "params.arguments.parentPropertyLocator");
        }
        AEGP_StreamRefH next_stream = nullptr;
        if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
                plugin_id_, parent_stream.get(), address->child_indices[depth],
                &next_stream) != A_Err_NONE ||
            next_stream == nullptr) {
          return HostLayerPropertiesResult::failure(
              "STALE_LOCATOR", "parent property path could not be reacquired",
              "params.arguments.parentPropertyLocator");
        }
        StreamRefOwner next_owner(stream_suite.get(), next_stream);
        std::int32_t unique_id = 0;
        if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(),
                                                 &unique_id) != A_Err_NONE ||
            unique_id != address->unique_ids[depth]) {
          return HostLayerPropertiesResult::failure(
              "STALE_LOCATOR", "parent property identity changed",
              "params.arguments.parentPropertyLocator");
        }
        parent_stream = std::move(next_owner);
      }
      parent_indices = address->child_indices;
      parent_unique_ids = address->unique_ids;
    }
    AEGP_StreamGroupingType parent_grouping = AEGP_StreamGroupingType_NONE;
    if (dynamic_suite->AEGP_GetStreamGroupingType(
            parent_stream.get(), &parent_grouping) != A_Err_NONE) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED",
          "could not inspect the parent property grouping");
    }
    if (parent_grouping == AEGP_StreamGroupingType_LEAF) {
      return HostLayerPropertiesResult::failure(
          "INVALID_ARGUMENT",
          "parentPropertyLocator identifies a leaf property",
          "params.arguments.parentPropertyLocator");
    }
    A_long child_count = 0;
    if (dynamic_suite->AEGP_GetNumStreamsInGroup(parent_stream.get(),
                                                 &child_count) != A_Err_NONE ||
        child_count < 0) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not read direct property count");
    }

    aemcp::native::LayerPropertiesPage page;
    page.layer_locator = query.layer_locator;
    page.parent_property_locator = query.parent_property_locator;
    page.layer_name = *layer_name;
    page.sample_time.value = sample_time.value;
    page.sample_time.scale = static_cast<std::uint64_t>(sample_time.scale);
    page.total = static_cast<std::uint64_t>(child_count);
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset > page.total) {
      return HostLayerPropertiesResult::failure(
          "INVALID_ARGUMENT",
          "offset exceeds the current direct property total",
          "params.arguments.offset");
    }
    aemcp::native::BoundedPageBudget page_budget(
        2048U + locator_json_size(page.layer_locator) +
        nullable_locator_json_size(page.parent_property_locator) +
        aemcp::native::json_encoded_string_size(page.layer_name));
    const std::uint64_t end =
        query.offset >= page.total
            ? query.offset
            : std::min(page.total, query.offset + query.limit);
    for (std::uint64_t position = query.offset; position < end; ++position) {
      if (budget_expired()) {
        return HostLayerPropertiesResult::failure(
            "DEADLINE_EXCEEDED", "layer property page budget elapsed");
      }
      AEGP_StreamRefH child_stream = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, parent_stream.get(), static_cast<A_long>(position),
              &child_stream) != A_Err_NONE ||
          child_stream == nullptr) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not resolve a direct layer property");
      }
      StreamRefOwner child_owner(stream_suite.get(), child_stream);
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      AEGP_DynStreamFlags flags = 0;
      A_Boolean modified = FALSE;
      std::int32_t unique_id = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(child_owner.get(),
                                                    &grouping) != A_Err_NONE ||
          dynamic_suite->AEGP_GetDynamicStreamFlags(child_owner.get(),
                                                    &flags) != A_Err_NONE ||
          dynamic_suite->AEGP_GetStreamIsModified(child_owner.get(),
                                                  &modified) != A_Err_NONE ||
          stream_suite->AEGP_GetUniqueStreamID(child_owner.get(), &unique_id) !=
              A_Err_NONE) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not inspect a direct layer property");
      }
      std::array<A_char, AEGP_MAX_STREAM_MATCH_NAME_SIZE> match_name{};
      if (dynamic_suite->AEGP_GetMatchName(child_owner.get(),
                                           match_name.data()) != A_Err_NONE ||
          std::find(match_name.begin(), match_name.end(), '\0') ==
              match_name.end()) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not read bounded property match name");
      }
      AEGP_MemHandle property_name_handle = nullptr;
      const A_Err property_name_error = stream_suite->AEGP_GetStreamName(
          plugin_id_, child_owner.get(), FALSE, &property_name_handle);
      MemHandleOwner property_name_owner(memory_suite.get(),
                                         property_name_handle);
      if (property_name_error != A_Err_NONE ||
          property_name_handle == nullptr) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not read property name");
      }
      const std::optional<std::string> property_name =
          property_name_owner.utf8();
      if (!property_name.has_value()) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "property name is not bounded UTF-16 text");
      }
      aemcp::native::LayerPropertyEntry entry;
      entry.property_index = position + 1;
      entry.name = *property_name;
      entry.match_name.assign(match_name.data());
      entry.hidden = (flags & AEGP_DynStreamFlag_HIDDEN) != 0;
      entry.disabled = (flags & AEGP_DynStreamFlag_DISABLED) != 0;
      entry.modified = modified != FALSE;
      std::vector<A_long> child_indices = parent_indices;
      child_indices.push_back(static_cast<A_long>(position));
      std::vector<std::int32_t> child_unique_ids = parent_unique_ids;
      child_unique_ids.push_back(unique_id);
      try {
        entry.property_locator =
            graph_.stream_locator(query.layer_locator, std::move(child_indices),
                                  std::move(child_unique_ids),
                                  query.host_instance_id, query.session_id);
      } catch (...) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not allocate a bounded stream locator");
      }
      if (grouping == AEGP_StreamGroupingType_NAMED_GROUP ||
          grouping == AEGP_StreamGroupingType_INDEXED_GROUP) {
        entry.grouping_type = grouping == AEGP_StreamGroupingType_NAMED_GROUP
                                  ? "named-group"
                                  : "indexed-group";
        A_long grandchildren = 0;
        if (dynamic_suite->AEGP_GetNumStreamsInGroup(
                child_owner.get(), &grandchildren) != A_Err_NONE ||
            grandchildren < 0) {
          return HostLayerPropertiesResult::failure(
              "CAPABILITY_FAILED", "could not read property group child count");
        }
        entry.child_count = static_cast<std::uint64_t>(grandchildren);
        entry.value_type = "none";
        entry.value_status = "group";
      } else if (grouping == AEGP_StreamGroupingType_LEAF) {
        entry.grouping_type = "leaf";
        A_Boolean can_vary = FALSE;
        A_Boolean time_varying = FALSE;
        AEGP_StreamType type = AEGP_StreamType_NO_DATA;
        if (stream_suite->AEGP_CanVaryOverTime(child_owner.get(), &can_vary) !=
                A_Err_NONE ||
            stream_suite->AEGP_IsStreamTimevarying(
                child_owner.get(), &time_varying) != A_Err_NONE ||
            stream_suite->AEGP_GetStreamType(child_owner.get(), &type) !=
                A_Err_NONE) {
          return HostLayerPropertiesResult::failure(
              "CAPABILITY_FAILED",
              "could not inspect leaf property value type");
        }
        entry.can_vary_over_time = can_vary != FALSE;
        entry.time_varying = time_varying != FALSE;
        entry.value_type = stream_type_name(type);
        if (type == AEGP_StreamType_NO_DATA) {
          entry.value_status = "no-data";
        } else if (type == AEGP_StreamType_OneD ||
                   type == AEGP_StreamType_TwoD ||
                   type == AEGP_StreamType_TwoD_SPATIAL ||
                   type == AEGP_StreamType_ThreeD ||
                   type == AEGP_StreamType_ThreeD_SPATIAL ||
                   type == AEGP_StreamType_COLOR) {
          StreamValueOwner sampled(stream_suite.get());
          if (stream_suite->AEGP_GetNewStreamValue(
                  plugin_id_, child_owner.get(), AEGP_LTimeMode_CompTime,
                  &sample_time, FALSE, sampled.out()) != A_Err_NONE) {
            return HostLayerPropertiesResult::failure(
                "CAPABILITY_FAILED",
                "could not sample primitive property value");
          }
          sampled.mark_initialized();
          entry.value_status = "sampled";
          if (type == AEGP_StreamType_OneD) {
            const auto value = decimal_string(sampled.value().val.one_d);
            if (!value.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED",
                  "sampled scalar is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyScalarValue{*value};
          } else if (type == AEGP_StreamType_TwoD ||
                     type == AEGP_StreamType_TwoD_SPATIAL) {
            const auto x = decimal_string(sampled.value().val.two_d.x);
            const auto y = decimal_string(sampled.value().val.two_d.y);
            if (!x.has_value() || !y.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED",
                  "sampled vector is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyVectorValue{{*x, *y}};
          } else if (type == AEGP_StreamType_ThreeD ||
                     type == AEGP_StreamType_ThreeD_SPATIAL) {
            const auto x = decimal_string(sampled.value().val.three_d.x);
            const auto y = decimal_string(sampled.value().val.three_d.y);
            const auto z = decimal_string(sampled.value().val.three_d.z);
            if (!x.has_value() || !y.has_value() || !z.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED",
                  "sampled vector is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyVectorValue{{*x, *y, *z}};
          } else {
            const AEGP_ColorVal &color = sampled.value().val.color;
            const auto alpha = decimal_string(color.alphaF);
            const auto red = decimal_string(color.redF);
            const auto green = decimal_string(color.greenF);
            const auto blue = decimal_string(color.blueF);
            if (!alpha.has_value() || !red.has_value() || !green.has_value() ||
                !blue.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED",
                  "sampled color is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyColorValue{*alpha, *red,
                                                                 *green, *blue};
          }
        } else {
          entry.value_status = "unsupported";
        }
      } else {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "property grouping type is unsupported");
      }
      const std::size_t entry_bytes =
          layer_property_json_size(entry) + (page.properties.empty() ? 0U : 1U);
      if (!page_budget.try_reserve(entry_bytes)) {
        if (page.properties.empty()) {
          return HostLayerPropertiesResult::failure(
              "CAPABILITY_FAILED",
              "one layer property exceeds the bounded native response budget");
        }
        break;
      }
      page.properties.push_back(std::move(entry));
    }
    page.has_more = query.offset + page.properties.size() < page.total;
    if (page.has_more)
      page.next_offset = query.offset + page.properties.size();
    return HostLayerPropertiesResult::success(std::move(page));
  }

  [[nodiscard]] HostLayerPropertyKeyframesResult list_layer_property_keyframes(
      const aemcp::native::LayerPropertyKeyframesQuery &query,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_StreamSuite6> stream_suite(basic_, kAEGPStreamSuite,
                                               kAEGPStreamSuiteVersion6);
    SuiteLease<AEGP_DynamicStreamSuite4> dynamic_suite(
        basic_, kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4);
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(basic_, kAEGPKeyframeSuite,
                                                   kAEGPKeyframeSuiteVersion5);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr || stream_suite.get() == nullptr ||
        dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "NATIVE_UNSUPPORTED",
          "required layer keyframe suites are unavailable");
    }
    if (budget_expired()) {
      return HostLayerPropertyKeyframesResult::failure(
          "DEADLINE_EXCEEDED", "layer keyframe list budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostLayerPropertyKeyframesResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root_item = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root_item) !=
            A_Err_NONE ||
        root_item == nullptr ||
        item_suite->AEGP_GetItemID(root_item, &root_id) != A_Err_NONE) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root_item),
                             root_id, std::move(*project_path));
    } catch (...) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto stream_address = graph_.resolve_stream(
        query.property_locator, query.host_instance_id, query.session_id);
    if (!stream_address.has_value()) {
      return HostLayerPropertyKeyframesResult::failure(
          "STALE_LOCATOR",
          "propertyLocator does not identify a property in the current project",
          "params.arguments.propertyLocator");
    }
    const auto layer_address =
        graph_.resolve_layer_object(stream_address->layer_object_id);
    if (!layer_address.has_value()) {
      return HostLayerPropertyKeyframesResult::failure(
          "STALE_LOCATOR", "property layer no longer exists",
          "params.arguments.propertyLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) !=
        A_Err_NONE) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostLayerPropertyKeyframesResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == layer_address->composition_item_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "STALE_LOCATOR", "property composition no longer exists",
          "params.arguments.propertyLocator");
    }
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) !=
            A_Err_NONE ||
        composition == nullptr ||
        layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE ||
        layer == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "STALE_LOCATOR", "property layer can no longer be resolved",
          "params.arguments.propertyLocator");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE ||
        root_stream == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not resolve the layer property root");
    }
    StreamRefOwner property_stream(stream_suite.get(), root_stream);
    for (std::size_t depth = 0; depth < stream_address->child_indices.size();
         ++depth) {
      if (budget_expired()) {
        return HostLayerPropertyKeyframesResult::failure(
            "DEADLINE_EXCEEDED", "property traversal budget elapsed");
      }
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      A_long child_count = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(property_stream.get(),
                                                    &grouping) != A_Err_NONE ||
          grouping == AEGP_StreamGroupingType_LEAF ||
          dynamic_suite->AEGP_GetNumStreamsInGroup(
              property_stream.get(), &child_count) != A_Err_NONE ||
          stream_address->child_indices[depth] < 0 ||
          stream_address->child_indices[depth] >= child_count) {
        return HostLayerPropertyKeyframesResult::failure(
            "STALE_LOCATOR", "property path no longer exists",
            "params.arguments.propertyLocator");
      }
      AEGP_StreamRefH next_stream = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, property_stream.get(),
              stream_address->child_indices[depth],
              &next_stream) != A_Err_NONE ||
          next_stream == nullptr) {
        return HostLayerPropertyKeyframesResult::failure(
            "STALE_LOCATOR", "property path could not be reacquired",
            "params.arguments.propertyLocator");
      }
      StreamRefOwner next_owner(stream_suite.get(), next_stream);
      std::int32_t unique_id = 0;
      if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id) !=
              A_Err_NONE ||
          unique_id != stream_address->unique_ids[depth]) {
        return HostLayerPropertyKeyframesResult::failure(
            "STALE_LOCATOR", "property identity changed",
            "params.arguments.propertyLocator");
      }
      property_stream = std::move(next_owner);
    }

    AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
    AEGP_StreamType type = AEGP_StreamType_NO_DATA;
    A_Boolean can_vary = FALSE;
    A_long keyframe_count = 0;
    if (dynamic_suite->AEGP_GetStreamGroupingType(property_stream.get(),
                                                  &grouping) != A_Err_NONE ||
        stream_suite->AEGP_GetStreamType(property_stream.get(), &type) !=
            A_Err_NONE ||
        stream_suite->AEGP_CanVaryOverTime(property_stream.get(), &can_vary) !=
            A_Err_NONE ||
        keyframe_suite->AEGP_GetStreamNumKFs(property_stream.get(),
                                             &keyframe_count) != A_Err_NONE) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED",
          "could not inspect the target property's keyframes");
    }
    const bool primitive =
        type == AEGP_StreamType_OneD || type == AEGP_StreamType_TwoD ||
        type == AEGP_StreamType_TwoD_SPATIAL ||
        type == AEGP_StreamType_ThreeD ||
        type == AEGP_StreamType_ThreeD_SPATIAL || type == AEGP_StreamType_COLOR;
    if (grouping != AEGP_StreamGroupingType_LEAF || can_vary == FALSE ||
        keyframe_count == AEGP_NumKF_NO_DATA || !primitive) {
      return HostLayerPropertyKeyframesResult::failure(
          "PRECONDITION_FAILED",
          "property must be a keyframeable primitive scalar, vector, or color "
          "leaf stream",
          "params.arguments.propertyLocator");
    }
    if (keyframe_count < 0) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED",
          "After Effects returned an invalid keyframe count");
    }
    const std::uint64_t total = static_cast<std::uint64_t>(keyframe_count);
    if (query.offset > total) {
      return HostLayerPropertyKeyframesResult::failure(
          "INVALID_ARGUMENT", "offset exceeds the property's keyframe count",
          "params.arguments.offset");
    }

    aemcp::native::LayerPropertyKeyframesPage page;
    page.property_locator = query.property_locator;
    page.value_type = stream_type_name(type);
    page.total = total;
    page.offset = query.offset;
    page.limit = query.limit;
    aemcp::native::BoundedPageBudget page_budget(
        512U + locator_json_size(query.property_locator));
    const std::uint64_t end = std::min<std::uint64_t>(
        total, query.offset + static_cast<std::uint64_t>(query.limit));
    for (std::uint64_t index = query.offset; index < end; ++index) {
      if (budget_expired()) {
        return HostLayerPropertyKeyframesResult::failure(
            "DEADLINE_EXCEEDED", "layer keyframe page budget elapsed");
      }
      A_Time key_time{};
      StreamValueOwner key_value(stream_suite.get());
      AEGP_KeyframeInterpolationType in_interpolation = AEGP_KeyInterp_NONE;
      AEGP_KeyframeInterpolationType out_interpolation = AEGP_KeyInterp_NONE;
      const auto sdk_index = static_cast<AEGP_KeyframeIndex>(index);
      if (keyframe_suite->AEGP_GetKeyframeTime(property_stream.get(), sdk_index,
                                               AEGP_LTimeMode_CompTime,
                                               &key_time) != A_Err_NONE ||
          key_time.scale <= 0 ||
          keyframe_suite->AEGP_GetNewKeyframeValue(
              plugin_id_, property_stream.get(), sdk_index, key_value.out()) !=
              A_Err_NONE) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED",
            "could not read a keyframe's exact time and value");
      }
      key_value.mark_initialized();
      if (keyframe_suite->AEGP_GetKeyframeInterpolation(
              property_stream.get(), sdk_index, &in_interpolation,
              &out_interpolation) != A_Err_NONE) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED",
            "could not read keyframe interpolation metadata");
      }
      const auto value = primitive_stream_value(type, key_value.value());
      const auto in_name = keyframe_interpolation_name(in_interpolation);
      const auto out_name = keyframe_interpolation_name(out_interpolation);
      if (!value.has_value() || !in_name.has_value() || !out_name.has_value()) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED",
            "keyframe value or interpolation was not representable");
      }
      aemcp::native::LayerPropertyKeyframeEntry entry;
      entry.keyframe_index = index + 1U;
      entry.time = {static_cast<std::int64_t>(key_time.value),
                    static_cast<std::uint64_t>(key_time.scale)};
      entry.value = *value;
      entry.in_interpolation = *in_name;
      entry.out_interpolation = *out_name;
      const std::size_t entry_bytes = layer_property_keyframe_json_size(entry) +
                                      (page.keyframes.empty() ? 0U : 1U);
      if (!page_budget.try_reserve(entry_bytes)) {
        if (page.keyframes.empty()) {
          return HostLayerPropertyKeyframesResult::failure(
              "CAPABILITY_FAILED",
              "one keyframe exceeds the bounded native response budget");
        }
        break;
      }
      page.keyframes.push_back(std::move(entry));
    }
    page.has_more = query.offset + page.keyframes.size() < page.total;
    if (page.has_more)
      page.next_offset = query.offset + page.keyframes.size();
    return HostLayerPropertyKeyframesResult::success(std::move(page));
  }

  [[nodiscard]] HostLayerPropertyKeyframeDetailsResult
  read_layer_property_keyframe_details(
      const aemcp::native::LayerPropertyKeyframeDetailsQuery &query,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_StreamSuite6> stream_suite(basic_, kAEGPStreamSuite,
                                               kAEGPStreamSuiteVersion6);
    SuiteLease<AEGP_DynamicStreamSuite4> dynamic_suite(
        basic_, kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4);
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(basic_, kAEGPKeyframeSuite,
                                                   kAEGPKeyframeSuiteVersion5);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr || stream_suite.get() == nullptr ||
        dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "NATIVE_UNSUPPORTED",
          "required keyframe detail suites are unavailable");
    }
    if (query.time.scale == 0 ||
        query.time.value < std::numeric_limits<std::int32_t>::min() ||
        query.time.value > std::numeric_limits<std::int32_t>::max()) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "INVALID_ARGUMENT", "time must be an exact bounded comp time",
          "params.arguments.time");
    }
    const auto resolved = resolve_keyframe_property(
        project_suite.get(), item_suite.get(), comp_suite.get(),
        layer_suite.get(), memory_suite.get(), stream_suite.get(),
        dynamic_suite.get(), keyframe_suite.get(), query.property_locator,
        std::nullopt, query.host_instance_id, query.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "PRECONDITION_FAILED",
          "propertyLocator must identify a current keyframeable primitive "
          "property",
          "params.arguments.propertyLocator");
    }
    const auto index = find_keyframe_at_time(
        keyframe_suite.get(), resolved->stream.get(), resolved->keyframe_count,
        query.time, work_deadline);
    if (!index.has_value()) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "PRECONDITION_FAILED", "no keyframe exists at the exact comp time",
          "params.arguments.time");
    }
    const auto details =
        read_keyframe_details_value(stream_suite.get(), keyframe_suite.get(),
                                    *resolved, *index, query.property_locator);
    if (!details.has_value() ||
        !keyframe_time_equal(details->time, query.time)) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "CAPABILITY_FAILED", "could not read complete keyframe details");
    }
    return HostLayerPropertyKeyframeDetailsResult::success(*details);
  }

  [[nodiscard]] HostLayerPropertyKeyframeWriteResult
  mutate_layer_property_keyframe(
      const aemcp::native::LayerPropertyKeyframeMutationCommand &command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_StreamSuite6> stream_suite(basic_, kAEGPStreamSuite,
                                               kAEGPStreamSuiteVersion6);
    SuiteLease<AEGP_DynamicStreamSuite4> dynamic_suite(
        basic_, kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4);
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(basic_, kAEGPKeyframeSuite,
                                                   kAEGPKeyframeSuiteVersion5);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(basic_, kAEGPUtilitySuite,
                                                 kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr || stream_suite.get() == nullptr ||
        dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr ||
        utility_suite.get() == nullptr) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "NATIVE_UNSUPPORTED",
          "required keyframe mutation suites are unavailable");
    }
    if (command.time.scale == 0 ||
        command.time.value < std::numeric_limits<std::int32_t>::min() ||
        command.time.value > std::numeric_limits<std::int32_t>::max()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "INVALID_ARGUMENT", "time must be an exact bounded comp time",
          "params.arguments.time");
    }
    auto resolved = resolve_keyframe_property(
        project_suite.get(), item_suite.get(), comp_suite.get(),
        layer_suite.get(), memory_suite.get(), stream_suite.get(),
        dynamic_suite.get(), keyframe_suite.get(), command.property_locator,
        command.layer_locator, command.host_instance_id, command.session_id,
        work_deadline);
    if (!resolved.has_value()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "PRECONDITION_FAILED",
          "locators must identify one current keyframeable primitive property",
          "params.arguments.propertyLocator");
    }
    const A_long count_before = resolved->keyframe_count;
    const auto before_index =
        find_keyframe_at_time(keyframe_suite.get(), resolved->stream.get(),
                              count_before, command.time, work_deadline);
    const bool adding =
        command.kind == aemcp::native::LayerPropertyKeyframeMutationKind::kAdd;
    if (adding && before_index.has_value()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "PRECONDITION_FAILED",
          "a keyframe already exists at the exact comp time",
          "params.arguments.time");
    }
    if (!adding && !before_index.has_value()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "PRECONDITION_FAILED", "no keyframe exists at the exact comp time",
          "params.arguments.time");
    }
    std::optional<LayerPropertyKeyframeDetails> before;
    if (before_index.has_value()) {
      before = read_keyframe_details_value(
          stream_suite.get(), keyframe_suite.get(), *resolved, *before_index,
          command.property_locator);
      if (!before.has_value()) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "CAPABILITY_FAILED",
            "could not read keyframe state before mutation");
      }
    }

    // Keep the SDK-owned seed alive until every AEGP_SetKeyframeValue call has
    // returned. AEGP_StreamValue2 is a shallow SDK value containing streamH;
    // copying it does not extend the lifetime ended by DisposeStreamValue.
    StreamValueOwner desired_value_owner(stream_suite.get());
    AEGP_KeyframeInterpolationType desired_in = AEGP_KeyInterp_NONE;
    AEGP_KeyframeInterpolationType desired_out = AEGP_KeyInterp_NONE;
    std::vector<
        std::pair<A_long, std::pair<AEGP_KeyframeEase, AEGP_KeyframeEase>>>
        desired_ease;
    AEGP_KeyframeFlags desired_flag = AEGP_KeyframeFlag_NONE;
    const auto interpolation_value = [](std::string_view value)
        -> std::optional<AEGP_KeyframeInterpolationType> {
      if (value == "linear")
        return AEGP_KeyInterp_LINEAR;
      if (value == "bezier")
        return AEGP_KeyInterp_BEZIER;
      if (value == "hold")
        return AEGP_KeyInterp_HOLD;
      return std::nullopt;
    };
    const auto behavior_flag =
        [](std::string_view behavior) -> std::optional<AEGP_KeyframeFlags> {
      if (behavior == "temporal-continuous") {
        return AEGP_KeyframeFlag_TEMPORAL_CONTINUOUS;
      }
      if (behavior == "temporal-auto-bezier") {
        return AEGP_KeyframeFlag_TEMPORAL_AUTOBEZIER;
      }
      if (behavior == "spatial-continuous") {
        return AEGP_KeyframeFlag_SPATIAL_CONTINUOUS;
      }
      if (behavior == "spatial-auto-bezier") {
        return AEGP_KeyframeFlag_SPATIAL_AUTOBEZIER;
      }
      if (behavior == "roving")
        return AEGP_KeyframeFlag_ROVING;
      return std::nullopt;
    };
    if (adding ||
        command.kind ==
            aemcp::native::LayerPropertyKeyframeMutationKind::kSetValue) {
      A_Time sample_time{static_cast<A_long>(command.time.value),
                         static_cast<A_u_long>(command.time.scale)};
      if (stream_suite->AEGP_GetNewStreamValue(
              plugin_id_, resolved->stream.get(), AEGP_LTimeMode_CompTime,
              &sample_time, FALSE, desired_value_owner.out()) != A_Err_NONE) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "CAPABILITY_FAILED", "could not prepare a typed keyframe value");
      }
      desired_value_owner.mark_initialized();
      if (!assign_primitive_stream_value(resolved->type, command.value,
                                         desired_value_owner.mutable_value())) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "value does not match the property type",
            "params.arguments.value");
      }
      if (!adding && before.has_value() &&
          layer_property_values_equal(command.value, before->value)) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "value already matches the keyframe",
            "params.arguments.value");
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetInterpolation) {
      const auto in_value = interpolation_value(command.in_interpolation);
      const auto out_value = interpolation_value(command.out_interpolation);
      AEGP_KeyInterpolationMask valid = AEGP_KeyInterpMask_NONE;
      if (!in_value.has_value() || !out_value.has_value() ||
          stream_suite->AEGP_GetValidInterpolations(resolved->stream.get(),
                                                    &valid) != A_Err_NONE) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "unsupported keyframe interpolation",
            "params.arguments.inInterpolation");
      }
      const auto allowed = [valid](AEGP_KeyframeInterpolationType value) {
        const AEGP_KeyInterpolationMask mask =
            value == AEGP_KeyInterp_LINEAR   ? AEGP_KeyInterpMask_LINEAR
            : value == AEGP_KeyInterp_BEZIER ? AEGP_KeyInterpMask_BEZIER
                                             : AEGP_KeyInterpMask_HOLD;
        return (valid & mask) != 0;
      };
      if (!allowed(*in_value) || !allowed(*out_value)) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "PRECONDITION_FAILED",
            "the property does not support the requested interpolation",
            "params.arguments.inInterpolation");
      }
      desired_in = *in_value;
      desired_out = *out_value;
      if (before->in_interpolation == command.in_interpolation &&
          before->out_interpolation == command.out_interpolation) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "interpolation already matches the keyframe",
            "params.arguments.inInterpolation");
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetTemporalEase) {
      if (command.temporal_ease.size() !=
          static_cast<std::size_t>(resolved->temporal_dimensions)) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT",
            "dimensions must cover the temporal dimensionality",
            "params.arguments.dimensions");
      }
      std::array<bool, 4> seen{};
      bool differs = false;
      std::uint16_t expected_dimension = 0;
      for (const auto &dimension : command.temporal_ease) {
        if (dimension.dimension >= resolved->temporal_dimensions ||
            seen[dimension.dimension] ||
            dimension.dimension != expected_dimension) {
          return HostLayerPropertyKeyframeWriteResult::failure(
              "INVALID_ARGUMENT",
              "temporal ease dimensions must be unique and in range",
              "params.arguments.dimensions");
        }
        seen[dimension.dimension] = true;
        ++expected_dimension;
        const auto in_speed = decimal_value(dimension.in_ease.speed);
        const auto in_influence = decimal_value(dimension.in_ease.influence);
        const auto out_speed = decimal_value(dimension.out_ease.speed);
        const auto out_influence = decimal_value(dimension.out_ease.influence);
        if (!in_speed.has_value() || !in_influence.has_value() ||
            !out_speed.has_value() || !out_influence.has_value() ||
            *in_influence < 0.0 || *in_influence > 100.0 ||
            *out_influence < 0.0 || *out_influence > 100.0) {
          return HostLayerPropertyKeyframeWriteResult::failure(
              "INVALID_ARGUMENT", "ease influence must be from 0 through 100",
              "params.arguments.dimensions");
        }
        desired_ease.push_back({static_cast<A_long>(dimension.dimension),
                                {{*in_speed, *in_influence / 100.0},
                                 {*out_speed, *out_influence / 100.0}}});
        differs = differs ||
                  !keyframe_dimension_ease_equal(
                      before->temporal_ease[dimension.dimension], dimension);
      }
      if (!differs) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "temporal ease already matches the keyframe",
            "params.arguments.dimensions");
      }
      if (before->in_interpolation != "bezier" ||
          before->out_interpolation != "bezier") {
        AEGP_KeyInterpolationMask valid = AEGP_KeyInterpMask_NONE;
        if (stream_suite->AEGP_GetValidInterpolations(resolved->stream.get(),
                                                      &valid) != A_Err_NONE ||
            (valid & AEGP_KeyInterpMask_BEZIER) == 0) {
          return HostLayerPropertyKeyframeWriteResult::failure(
              "PRECONDITION_FAILED",
              "the property does not support bezier temporal ease",
              "params.arguments.dimensions");
        }
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::kSetBehavior) {
      const auto flag = behavior_flag(command.behavior);
      const bool spatial = resolved->type == AEGP_StreamType_TwoD_SPATIAL ||
                           resolved->type == AEGP_StreamType_ThreeD_SPATIAL;
      const bool spatial_behavior = command.behavior == "spatial-continuous" ||
                                    command.behavior == "spatial-auto-bezier" ||
                                    command.behavior == "roving";
      if (!flag.has_value() || (spatial_behavior && !spatial)) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "PRECONDITION_FAILED",
            "the property does not support the requested keyframe behavior",
            "params.arguments.behavior");
      }
      desired_flag = *flag;
      const bool current = command.behavior == "temporal-continuous"
                               ? before->behavior.temporal_continuous
                           : command.behavior == "temporal-auto-bezier"
                               ? before->behavior.temporal_auto_bezier
                           : command.behavior == "spatial-continuous"
                               ? before->behavior.spatial_continuous
                           : command.behavior == "spatial-auto-bezier"
                               ? before->behavior.spatial_auto_bezier
                               : before->behavior.roving;
      if (current == command.enabled) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "behavior already matches the keyframe",
            "params.arguments.enabled");
      }
    }

    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "DEADLINE_EXCEEDED", "keyframe mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Edit property keyframe";
    const bool owns_undo = !undo_open_;
    if (owns_undo &&
        utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    A_Err mutation_error = A_Err_NONE;
    if (adding) {
      const A_Time time{static_cast<A_long>(command.time.value),
                        static_cast<A_u_long>(command.time.scale)};
      AEGP_KeyframeIndex inserted = 0;
      mutation_error = keyframe_suite->AEGP_InsertKeyframe(
          resolved->stream.get(), AEGP_LTimeMode_CompTime, &time, &inserted);
      if (mutation_error == A_Err_NONE) {
        mutation_error = keyframe_suite->AEGP_SetKeyframeValue(
            resolved->stream.get(), inserted, desired_value_owner.borrow());
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::kSetValue) {
      mutation_error = keyframe_suite->AEGP_SetKeyframeValue(
          resolved->stream.get(), *before_index, desired_value_owner.borrow());
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetInterpolation) {
      mutation_error = keyframe_suite->AEGP_SetKeyframeInterpolation(
          resolved->stream.get(), *before_index, desired_in, desired_out);
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetTemporalEase) {
      // After Effects only retains per-keyframe temporal ease when both sides
      // use bezier interpolation; the same ease call on a linear keyframe
      // leaves no observable state. Promote non-bezier sides inside this Undo
      // group, mirroring Easy Ease, so the readback can prove the request.
      if (before->in_interpolation != "bezier" ||
          before->out_interpolation != "bezier") {
        mutation_error = keyframe_suite->AEGP_SetKeyframeInterpolation(
            resolved->stream.get(), *before_index, AEGP_KeyInterp_BEZIER,
            AEGP_KeyInterp_BEZIER);
      }
      for (const auto &[dimension, ease] : desired_ease) {
        if (mutation_error != A_Err_NONE)
          break;
        mutation_error = keyframe_suite->AEGP_SetKeyframeTemporalEase(
            resolved->stream.get(), *before_index, dimension, &ease.first,
            &ease.second);
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::kSetBehavior) {
      mutation_error = keyframe_suite->AEGP_SetKeyframeFlag(
          resolved->stream.get(), *before_index, desired_flag,
          command.enabled ? TRUE : FALSE);
    } else {
      mutation_error = keyframe_suite->AEGP_DeleteKeyframe(
          resolved->stream.get(), *before_index);
    }
    const A_Err end_error =
        owns_undo ? utility_suite->AEGP_EndUndoGroup() : A_Err_NONE;

    A_long count_after = -1;
    if (keyframe_suite->AEGP_GetStreamNumKFs(resolved->stream.get(),
                                             &count_after) != A_Err_NONE ||
        count_after < 0)
      count_after = -1;
    const auto after_index =
        count_after >= 0
            ? find_keyframe_at_time(keyframe_suite.get(),
                                    resolved->stream.get(), count_after,
                                    command.time, work_deadline)
            : std::nullopt;
    std::optional<LayerPropertyKeyframeDetails> after;
    if (after_index.has_value()) {
      after = read_keyframe_details_value(
          stream_suite.get(), keyframe_suite.get(), *resolved, *after_index,
          command.property_locator);
    }
    const bool deleting =
        command.kind ==
        aemcp::native::LayerPropertyKeyframeMutationKind::kDelete;
    const bool count_valid = adding     ? count_after == count_before + 1
                             : deleting ? count_after + 1 == count_before
                                        : count_after == count_before;
    const char *state_failure = nullptr;
    if (deleting) {
      if (after_index.has_value()) {
        state_failure = "deleted keyframe is still present at the requested time";
      }
    } else if (!after_index.has_value() || !after.has_value()) {
      state_failure = "readback could not find the mutated keyframe";
    } else if (!keyframe_time_equal(after->time, command.time)) {
      state_failure = "mutated keyframe landed at an unexpected time";
    } else if (adding ||
               command.kind ==
                   aemcp::native::LayerPropertyKeyframeMutationKind::kSetValue) {
      if (!layer_property_values_equal(after->value, command.value)) {
        state_failure = "keyframe value did not match the requested value";
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetInterpolation) {
      if (after->in_interpolation != command.in_interpolation ||
          after->out_interpolation != command.out_interpolation) {
        state_failure = "keyframe interpolation did not match the request";
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetTemporalEase) {
      bool ease_valid = after->in_interpolation == "bezier" &&
                        after->out_interpolation == "bezier";
      for (const auto &dimension : command.temporal_ease) {
        ease_valid = ease_valid &&
                     keyframe_dimension_ease_equal(
                         after->temporal_ease[dimension.dimension], dimension);
      }
      if (!ease_valid) {
        state_failure = "keyframe temporal ease did not match the request";
      }
    } else if (command.kind ==
               aemcp::native::LayerPropertyKeyframeMutationKind::
                   kSetBehavior) {
      const bool actual = command.behavior == "temporal-continuous"
                              ? after->behavior.temporal_continuous
                          : command.behavior == "temporal-auto-bezier"
                              ? after->behavior.temporal_auto_bezier
                          : command.behavior == "spatial-continuous"
                              ? after->behavior.spatial_continuous
                          : command.behavior == "spatial-auto-bezier"
                              ? after->behavior.spatial_auto_bezier
                              : after->behavior.roving;
      if (actual != command.enabled) {
        state_failure = "keyframe behavior did not match the request";
      }
    }
    const bool requested_state_valid = state_failure == nullptr;
    if (mutation_error != A_Err_NONE || end_error != A_Err_NONE) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "keyframe may have changed but the mutation call or its Undo group "
          "closure failed");
    }
    if (!count_valid) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "keyframe count after the mutation (" +
              std::to_string(count_after) + ") does not match the expected "
              "transition from " + std::to_string(count_before));
    }
    if (!requested_state_valid) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE", state_failure);
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "keyframe may have changed but the validation budget elapsed");
    }
    LayerPropertyKeyframeChanged changed;
    changed.layer_locator = command.layer_locator;
    changed.property_locator = command.property_locator;
    changed.time = command.time;
    changed.keyframe_count_before = static_cast<std::uint64_t>(count_before);
    changed.keyframe_count_after = static_cast<std::uint64_t>(count_after);
    changed.before = std::move(before);
    changed.after = std::move(after);
    return HostLayerPropertyKeyframeWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostLayerPropertyWriteResult
  set_layer_property(const aemcp::native::LayerPropertySetCommand &command,
                     TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_StreamSuite6> stream_suite(basic_, kAEGPStreamSuite,
                                               kAEGPStreamSuiteVersion6);
    SuiteLease<AEGP_DynamicStreamSuite4> dynamic_suite(
        basic_, kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4);
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(basic_, kAEGPKeyframeSuite,
                                                   kAEGPKeyframeSuiteVersion5);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(basic_, kAEGPUtilitySuite,
                                                 kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr || stream_suite.get() == nullptr ||
        dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr ||
        utility_suite.get() == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "NATIVE_UNSUPPORTED",
          "required layer property mutation suites are unavailable");
    }
    if (budget_expired()) {
      return HostLayerPropertyWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer property mutation budget elapsed");
    }
    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root_item = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root_item) !=
            A_Err_NONE ||
        root_item == nullptr ||
        item_suite->AEGP_GetItemID(root_item, &root_id) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path =
        read_project_path(project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                             reinterpret_cast<std::uintptr_t>(root_item),
                             root_id, std::move(*project_path));
    } catch (...) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto layer_address = graph_.resolve_layer(
        command.layer_locator, command.host_instance_id, command.session_id);
    if (!layer_address.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR",
          "layerLocator does not identify a layer in the currently open "
          "project",
          "params.arguments.layerLocator");
    }
    const auto stream_address =
        graph_.resolve_stream(command.property_locator, command.layer_locator,
                              command.host_instance_id, command.session_id);
    if (!stream_address.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR",
          "propertyLocator does not identify a property on this layer",
          "params.arguments.propertyLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) !=
        A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostLayerPropertyWriteResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostLayerPropertyWriteResult::failure(
            "CAPABILITY_FAILED",
            "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostLayerPropertyWriteResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == layer_address->composition_item_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return HostLayerPropertyWriteResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR", "layer composition no longer exists",
          "params.arguments.layerLocator");
    }
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) !=
            A_Err_NONE ||
        composition == nullptr ||
        layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE ||
        layer == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR", "layer can no longer be resolved",
          "params.arguments.layerLocator");
    }
    A_Time sample_time{};
    if (layer_suite->AEGP_GetLayerCurrentTime(layer, AEGP_LTimeMode_CompTime,
                                              &sample_time) != A_Err_NONE ||
        sample_time.scale <= 0) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED",
          "could not read a bounded composition sample time");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE ||
        root_stream == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not resolve the layer property root");
    }
    StreamRefOwner property_stream(stream_suite.get(), root_stream);
    for (std::size_t depth = 0; depth < stream_address->child_indices.size();
         ++depth) {
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      A_long child_count = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(property_stream.get(),
                                                    &grouping) != A_Err_NONE ||
          grouping == AEGP_StreamGroupingType_LEAF ||
          dynamic_suite->AEGP_GetNumStreamsInGroup(
              property_stream.get(), &child_count) != A_Err_NONE ||
          stream_address->child_indices[depth] < 0 ||
          stream_address->child_indices[depth] >= child_count) {
        return HostLayerPropertyWriteResult::failure(
            "STALE_LOCATOR", "property path no longer exists",
            "params.arguments.propertyLocator");
      }
      AEGP_StreamRefH next_stream = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, property_stream.get(),
              stream_address->child_indices[depth],
              &next_stream) != A_Err_NONE ||
          next_stream == nullptr) {
        return HostLayerPropertyWriteResult::failure(
            "STALE_LOCATOR", "property path could not be reacquired",
            "params.arguments.propertyLocator");
      }
      StreamRefOwner next_owner(stream_suite.get(), next_stream);
      std::int32_t unique_id = 0;
      if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id) !=
              A_Err_NONE ||
          unique_id != stream_address->unique_ids[depth]) {
        return HostLayerPropertyWriteResult::failure(
            "STALE_LOCATOR", "property identity changed",
            "params.arguments.propertyLocator");
      }
      property_stream = std::move(next_owner);
    }
    std::array<A_char, AEGP_MAX_STREAM_MATCH_NAME_SIZE> match_name{};
    if (dynamic_suite->AEGP_GetMatchName(property_stream.get(),
                                         match_name.data()) != A_Err_NONE ||
        std::find(match_name.begin(), match_name.end(), '\0') ==
            match_name.end()) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not read bounded property match name");
    }
    const auto direct_layer_stream = standard_layer_stream_for_match_name(
        std::string_view(match_name.data()));
    AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
    AEGP_StreamType type = AEGP_StreamType_NO_DATA;
    A_long keyframe_count = 0;
    A_Boolean time_varying = FALSE;
    if (dynamic_suite->AEGP_GetStreamGroupingType(property_stream.get(),
                                                  &grouping) != A_Err_NONE ||
        stream_suite->AEGP_GetStreamType(property_stream.get(), &type) !=
            A_Err_NONE ||
        keyframe_suite->AEGP_GetStreamNumKFs(property_stream.get(),
                                             &keyframe_count) != A_Err_NONE ||
        stream_suite->AEGP_IsStreamTimevarying(property_stream.get(),
                                               &time_varying) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not inspect the target property");
    }
    if (grouping != AEGP_StreamGroupingType_LEAF || keyframe_count != 0 ||
        time_varying != FALSE) {
      return HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED",
          "property must be a non-keyframed, non-time-varying leaf stream",
          "params.arguments.propertyLocator");
    }
    if (type != AEGP_StreamType_OneD && type != AEGP_StreamType_TwoD &&
        type != AEGP_StreamType_TwoD_SPATIAL &&
        type != AEGP_StreamType_ThreeD &&
        type != AEGP_StreamType_ThreeD_SPATIAL &&
        type != AEGP_StreamType_COLOR) {
      return HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED",
          "property is not a supported primitive scalar, vector, or color "
          "stream",
          "params.arguments.propertyLocator");
    }
    if (budget_expired()) {
      return HostLayerPropertyWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer property mutation budget elapsed");
    }

    static constexpr char kUndoLabel[] = "ae-mcp: Set layer property value";
    const bool owns_undo = !undo_open_;
    if (owns_undo &&
        utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    UndoGroupOwner undo_group(utility_suite.get());
    if (owns_undo)
      undo_group.mark_started();

    std::optional<aemcp::native::LayerPropertyValue> before_value;
    std::optional<aemcp::native::LayerPropertyValue> after_value;
    AEGP_StreamValue2 desired{};
    A_Err start_add_error = A_Err_NONE;
    A_Err add_error = A_Err_NONE;
    A_Err set_error = A_Err_NONE;
    A_Err end_add_error = A_Err_NONE;
    A_Err delete_error = A_Err_NONE;
    A_Err invariant_error = A_Err_NONE;
    A_Err readback_error = A_Err_NONE;
    A_long keyframe_count_after = AEGP_NumKF_NO_DATA;
    A_Boolean time_varying_after = TRUE;
    {
      AEGP_StreamRefH direct_stream = nullptr;
      StreamRefOwner direct_owner(stream_suite.get(), nullptr);
      AEGP_StreamRefH mutation_stream = property_stream.get();
      if (direct_layer_stream.has_value()) {
        if (stream_suite->AEGP_GetNewLayerStream(
                plugin_id_, layer, *direct_layer_stream, &direct_stream) !=
                A_Err_NONE ||
            direct_stream == nullptr) {
          return HostLayerPropertyWriteResult::failure(
              "CAPABILITY_FAILED",
              "could not reacquire the standard layer property");
        }
        direct_owner = StreamRefOwner(stream_suite.get(), direct_stream);
        std::int32_t direct_unique_id = 0;
        if (stream_address->unique_ids.empty() ||
            stream_suite->AEGP_GetUniqueStreamID(
                direct_owner.get(), &direct_unique_id) != A_Err_NONE ||
            direct_unique_id != stream_address->unique_ids.back()) {
          return HostLayerPropertyWriteResult::failure(
              "STALE_LOCATOR", "standard layer property identity changed",
              "params.arguments.propertyLocator");
        }
        mutation_stream = direct_owner.get();
      }

      StreamValueOwner before_owner(stream_suite.get());
      if (stream_suite->AEGP_GetNewStreamValue(
              plugin_id_, mutation_stream, AEGP_LTimeMode_CompTime,
              &sample_time, FALSE, before_owner.out()) != A_Err_NONE) {
        return HostLayerPropertyWriteResult::failure(
            "CAPABILITY_FAILED",
            "could not sample the property before mutation");
      }
      before_owner.mark_initialized();
      before_value = primitive_stream_value(type, before_owner.value());
      desired = before_owner.value();
      if (!before_value.has_value() ||
          !assign_primitive_stream_value(type, command.value, desired)) {
        return HostLayerPropertyWriteResult::failure(
            "INVALID_ARGUMENT",
            "value does not match the target property's primitive type",
            "params.arguments.value");
      }
      if (primitive_stream_values_equal(type, before_owner.value(), desired)) {
        return HostLayerPropertyWriteResult::failure(
            "INVALID_ARGUMENT",
            "value already matches the property's sampled value",
            "params.arguments.value");
      }
      // AEGP_SetStreamValue changes the value but does not create an AE host
      // Undo item when invoked from the idle dispatcher. A direct
      // Insert/Set/Delete sequence is also folded by AE into a static value
      // with no visible Undo item. Commit the temporary value through the
      // SDK's bulk keyframe transaction, whose EndAddKeyframes operation is
      // explicitly UNDOABLE, before deleting the sole keyframe in this same
      // Undo group. The final stream must still be static and keyframe-free.
      AEGP_AddKeyframesInfoH add_info = nullptr;
      A_long staged_keyframe = 0;
      start_add_error =
          keyframe_suite->AEGP_StartAddKeyframes(mutation_stream, &add_info);
      if (start_add_error == A_Err_NONE && add_info != nullptr) {
        add_error = keyframe_suite->AEGP_AddKeyframes(
            add_info, AEGP_LTimeMode_CompTime, &sample_time, &staged_keyframe);
        if (add_error == A_Err_NONE) {
          set_error = keyframe_suite->AEGP_SetAddKeyframe(
              add_info, staged_keyframe, &desired);
        }
        const bool commit = add_error == A_Err_NONE && set_error == A_Err_NONE;
        end_add_error = keyframe_suite->AEGP_EndAddKeyframes(
            commit ? TRUE : FALSE, add_info);
        add_info = nullptr;
        if (commit && end_add_error == A_Err_NONE) {
          delete_error =
              keyframe_suite->AEGP_DeleteKeyframe(mutation_stream, 0);
        }
      } else if (start_add_error == A_Err_NONE) {
        start_add_error = A_Err_GENERIC;
      }
      if (start_add_error == A_Err_NONE && add_error == A_Err_NONE &&
          set_error == A_Err_NONE && end_add_error == A_Err_NONE &&
          delete_error == A_Err_NONE) {
        if (keyframe_suite->AEGP_GetStreamNumKFs(
                mutation_stream, &keyframe_count_after) != A_Err_NONE ||
            stream_suite->AEGP_IsStreamTimevarying(
                mutation_stream, &time_varying_after) != A_Err_NONE) {
          invariant_error = A_Err_GENERIC;
        }
      }

      StreamValueOwner after_owner(stream_suite.get());
      readback_error = stream_suite->AEGP_GetNewStreamValue(
          plugin_id_, mutation_stream, AEGP_LTimeMode_CompTime, &sample_time,
          FALSE, after_owner.out());
      if (readback_error == A_Err_NONE)
        after_owner.mark_initialized();
      after_value = readback_error == A_Err_NONE
                        ? primitive_stream_value(type, after_owner.value())
                        : std::nullopt;
      if (readback_error == A_Err_NONE &&
          !primitive_stream_values_equal(type, desired, after_owner.value())) {
        after_value.reset();
      }
    }
    const A_Err end_error = owns_undo ? undo_group.finish() : A_Err_NONE;
    if (start_add_error != A_Err_NONE || add_error != A_Err_NONE ||
        set_error != A_Err_NONE || end_add_error != A_Err_NONE ||
        delete_error != A_Err_NONE || invariant_error != A_Err_NONE ||
        keyframe_count_after != 0 || time_varying_after != FALSE ||
        end_error != A_Err_NONE || readback_error != A_Err_NONE ||
        !before_value.has_value() || !after_value.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "property may have changed but static-value, keyframe, or Undo "
          "validation failed");
    }
    aemcp::native::LayerPropertyChanged changed;
    changed.changed = true;
    changed.layer_locator = command.layer_locator;
    changed.property_locator = command.property_locator;
    changed.value_type = stream_type_name(type);
    changed.before_value = *before_value;
    changed.after_value = *after_value;
    return HostLayerPropertyWriteResult::success(std::move(changed));
  }
  [[nodiscard]] NativeHandleResolveResult
  resolve_program_layer_handle(const ObjectLocator &locator,
                               TimePoint work_deadline) {
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return NativeHandleResolveResult::failure(
          "DEADLINE_EXCEEDED", "layer resolution budget elapsed");
    }
    SuiteLease<AEGP_ProjSuite6> project_suite(basic_, kAEGPProjSuite,
                                              kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(basic_, kAEGPItemSuite,
                                           kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(basic_, kAEGPCompSuite,
                                            kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(basic_, kAEGPLayerSuite,
                                             kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(basic_, kAEGPMemorySuite,
                                               kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr ||
        comp_suite.get() == nullptr || layer_suite.get() == nullptr ||
        memory_suite.get() == nullptr) {
      return NativeHandleResolveResult::failure(
          "NATIVE_UNSUPPORTED", "required layer resolution suites unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(),
        layer_suite.get(), memory_suite.get(), locator,
        locator.host_instance_id, locator.session_id, work_deadline);
    if (!resolved.has_value()) {
      return NativeHandleResolveResult::failure(
          "STALE_LOCATOR", "layer locator is no longer current");
    }
    return NativeHandleResolveResult::success(aemcp::native::ScopedLayerHandle{{
        locator,
        reinterpret_cast<std::uintptr_t>(resolved->layer),
        reinterpret_cast<std::uintptr_t>(resolved->composition),
    }});
  }

  [[nodiscard]] HostActionResult
  begin_undo_group(std::string_view label, TimePoint work_deadline) override {
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostActionResult::failure("DEADLINE_EXCEEDED",
                                       "layer Undo begin budget elapsed");
    }
    if (utility_suite_ == nullptr || undo_open_ || label.empty()) {
      return HostActionResult::failure("CAPABILITY_FAILED",
                                       "program Undo group is unavailable");
    }
    const std::string null_terminated_label(label);
    if (utility_suite_->AEGP_StartUndoGroup(null_terminated_label.c_str()) !=
        A_Err_NONE) {
      return HostActionResult::failure(
          "CAPABILITY_FAILED", "could not start the program Undo group");
    }
    undo_open_ = true;
    return HostActionResult::success();
  }

  [[nodiscard]] HostActionResult end_undo_group(TimePoint) override {
    if (utility_suite_ == nullptr || !undo_open_) {
      return HostActionResult::failure("CAPABILITY_FAILED",
                                       "program Undo group is not open");
    }
    undo_open_ = false;
    if (utility_suite_->AEGP_EndUndoGroup() != A_Err_NONE) {
      return HostActionResult::failure("CAPABILITY_FAILED",
                                       "could not end the program Undo group");
    }
    return HostActionResult::success();
  }

private:
  struct OpenProject {
    AEGP_ProjectH project{nullptr};
    AEGP_ItemH root{nullptr};
  };

  struct ResolvedLayer {
    OpenProject open;
    A_long composition_item_id{0};
    AEGP_LayerIDVal layer_id{0};
    AEGP_ItemH composition_item{nullptr};
    AEGP_CompH composition{nullptr};
    AEGP_LayerH layer{nullptr};
  };

  struct ResolvedProperty {
    ResolvedLayer layer;
    StreamRefOwner stream;
    AEGP_StreamType type{AEGP_StreamType_NO_DATA};
    A_short temporal_dimensions{0};
    A_long keyframe_count{0};

    ResolvedProperty(ResolvedLayer resolved_layer,
                     StreamRefOwner resolved_stream,
                     AEGP_StreamType stream_type, A_short dimensions,
                     A_long count)
        : layer(std::move(resolved_layer)), stream(std::move(resolved_stream)),
          type(stream_type), temporal_dimensions(dimensions),
          keyframe_count(count) {}
  };

  [[nodiscard]] std::optional<OpenProject>
  observe_open_project(const AEGP_ProjSuite6 *project_suite,
                       const AEGP_ItemSuite9 *item_suite,
                       const AEGP_MemorySuite1 *memory_suite) {
    if (project_suite == nullptr || item_suite == nullptr ||
        memory_suite == nullptr) {
      return std::nullopt;
    }
    A_long project_count = 0;
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE ||
        project_count <= 0 ||
        project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE ||
        project == nullptr ||
        project_suite->AEGP_GetProjectRootFolder(project, &root) !=
            A_Err_NONE ||
        root == nullptr ||
        item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      if (project_count <= 0)
        graph_.project_closed();
      return std::nullopt;
    }
    std::optional<std::string> path =
        read_project_path(project_suite, memory_suite, project);
    if (!path.has_value())
      return std::nullopt;
    graph_.observe_project(reinterpret_cast<std::uintptr_t>(project),
                           reinterpret_cast<std::uintptr_t>(root), root_id,
                           std::move(*path));
    return OpenProject{project, root};
  }

  [[nodiscard]] static std::optional<AEGP_ItemH>
  find_project_item(const AEGP_ItemSuite9 *item_suite, AEGP_ProjectH project,
                    AEGP_ItemH root, A_long wanted_id, TimePoint deadline) {
    AEGP_ItemH item = nullptr;
    if (item_suite == nullptr ||
        item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return std::nullopt;
    }
    std::size_t visited = 0;
    while (item != nullptr) {
      if (std::chrono::steady_clock::now() >= deadline ||
          ++visited > static_cast<std::size_t>(kMaximumProjectItems)) {
        return std::nullopt;
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return std::nullopt;
      }
      if (item_id == wanted_id)
        return item;
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) !=
          A_Err_NONE) {
        return std::nullopt;
      }
      item = next;
    }
    return std::nullopt;
  }

  [[nodiscard]] std::optional<ResolvedLayer> resolve_layer(
      const AEGP_ProjSuite6 *project_suite, const AEGP_ItemSuite9 *item_suite,
      const AEGP_CompSuite12 *comp_suite, const AEGP_LayerSuite9 *layer_suite,
      const AEGP_MemorySuite1 *memory_suite, const ObjectLocator &locator,
      std::string_view host, std::string_view session, TimePoint deadline) {
    const auto open =
        observe_open_project(project_suite, item_suite, memory_suite);
    const auto address = graph_.resolve_layer(locator, host, session);
    if (!open.has_value() || !address.has_value())
      return std::nullopt;
    const auto item = find_project_item(item_suite, open->project, open->root,
                                        address->composition_item_id, deadline);
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (!item.has_value() ||
        comp_suite->AEGP_GetCompFromItem(*item, &composition) != A_Err_NONE ||
        composition == nullptr ||
        layer_suite->AEGP_GetLayerFromLayerID(composition, address->layer_id,
                                              &layer) != A_Err_NONE ||
        layer == nullptr) {
      return std::nullopt;
    }
    return ResolvedLayer{*open,
                         address->composition_item_id,
                         address->layer_id,
                         *item,
                         composition,
                         layer};
  }

  [[nodiscard]] std::optional<ResolvedProperty> resolve_keyframe_property(
      const AEGP_ProjSuite6 *project_suite, const AEGP_ItemSuite9 *item_suite,
      const AEGP_CompSuite12 *comp_suite, const AEGP_LayerSuite9 *layer_suite,
      const AEGP_MemorySuite1 *memory_suite,
      const AEGP_StreamSuite6 *stream_suite,
      const AEGP_DynamicStreamSuite4 *dynamic_suite,
      const AEGP_KeyframeSuite5 *keyframe_suite,
      const ObjectLocator &property_locator,
      const std::optional<ObjectLocator> &expected_layer_locator,
      std::string_view host, std::string_view session, TimePoint deadline) {
    if (stream_suite == nullptr || dynamic_suite == nullptr ||
        keyframe_suite == nullptr)
      return std::nullopt;
    const auto open =
        observe_open_project(project_suite, item_suite, memory_suite);
    const auto stream_address =
        graph_.resolve_stream(property_locator, host, session);
    if (!open.has_value() || !stream_address.has_value())
      return std::nullopt;
    const auto layer_address =
        graph_.resolve_layer_object(stream_address->layer_object_id);
    if (!layer_address.has_value())
      return std::nullopt;
    const auto composition_item =
        find_project_item(item_suite, open->project, open->root,
                          layer_address->composition_item_id, deadline);
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (!composition_item.has_value() ||
        comp_suite->AEGP_GetCompFromItem(*composition_item, &composition) !=
            A_Err_NONE ||
        composition == nullptr ||
        layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE ||
        layer == nullptr) {
      return std::nullopt;
    }
    const ObjectLocator actual_layer_locator =
        graph_.layer_locator(layer_address->composition_item_id,
                             layer_address->layer_id, host, session);
    if (expected_layer_locator.has_value() &&
        *expected_layer_locator != actual_layer_locator)
      return std::nullopt;

    AEGP_StreamRefH root = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(plugin_id_, layer, &root) !=
            A_Err_NONE ||
        root == nullptr)
      return std::nullopt;
    StreamRefOwner stream(stream_suite, root);
    for (std::size_t depth = 0; depth < stream_address->child_indices.size();
         ++depth) {
      if (std::chrono::steady_clock::now() >= deadline)
        return std::nullopt;
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      A_long child_count = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(stream.get(), &grouping) !=
              A_Err_NONE ||
          grouping == AEGP_StreamGroupingType_LEAF ||
          dynamic_suite->AEGP_GetNumStreamsInGroup(
              stream.get(), &child_count) != A_Err_NONE ||
          stream_address->child_indices[depth] < 0 ||
          stream_address->child_indices[depth] >= child_count) {
        return std::nullopt;
      }
      AEGP_StreamRefH next = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, stream.get(), stream_address->child_indices[depth],
              &next) != A_Err_NONE ||
          next == nullptr)
        return std::nullopt;
      StreamRefOwner next_owner(stream_suite, next);
      std::int32_t unique_id = 0;
      if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id) !=
              A_Err_NONE ||
          unique_id != stream_address->unique_ids[depth])
        return std::nullopt;
      stream = std::move(next_owner);
    }

    AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
    AEGP_StreamType type = AEGP_StreamType_NO_DATA;
    A_Boolean can_vary = FALSE;
    A_short temporal_dimensions = 0;
    A_long keyframe_count = 0;
    if (dynamic_suite->AEGP_GetStreamGroupingType(stream.get(), &grouping) !=
            A_Err_NONE ||
        stream_suite->AEGP_GetStreamType(stream.get(), &type) != A_Err_NONE ||
        stream_suite->AEGP_CanVaryOverTime(stream.get(), &can_vary) !=
            A_Err_NONE ||
        keyframe_suite->AEGP_GetStreamTemporalDimensionality(
            stream.get(), &temporal_dimensions) != A_Err_NONE ||
        keyframe_suite->AEGP_GetStreamNumKFs(stream.get(), &keyframe_count) !=
            A_Err_NONE) {
      return std::nullopt;
    }
    const bool primitive =
        type == AEGP_StreamType_OneD || type == AEGP_StreamType_TwoD ||
        type == AEGP_StreamType_TwoD_SPATIAL ||
        type == AEGP_StreamType_ThreeD ||
        type == AEGP_StreamType_ThreeD_SPATIAL || type == AEGP_StreamType_COLOR;
    if (grouping != AEGP_StreamGroupingType_LEAF || can_vary == FALSE ||
        !primitive || temporal_dimensions < 1 || temporal_dimensions > 4 ||
        keyframe_count == AEGP_NumKF_NO_DATA || keyframe_count < 0) {
      return std::nullopt;
    }
    return ResolvedProperty{
        ResolvedLayer{*open, layer_address->composition_item_id,
                      layer_address->layer_id, *composition_item, composition,
                      layer},
        std::move(stream), type, temporal_dimensions, keyframe_count};
  }

  [[nodiscard]] static bool
  keyframe_time_equal(const A_Time &actual,
                      const LayerPropertySampleTime &requested) noexcept {
    if (actual.scale <= 0 || requested.scale == 0)
      return false;
    // AE's A_Time fields and validated wire times are bounded to 32-bit
    // values/scales, so their signed cross-products fit exactly in int64.
    return static_cast<std::int64_t>(actual.value) *
               static_cast<std::int64_t>(requested.scale) ==
           static_cast<std::int64_t>(requested.value) *
               static_cast<std::int64_t>(actual.scale);
  }

  [[nodiscard]] static bool
  keyframe_time_equal(const LayerPropertySampleTime &actual,
                      const LayerPropertySampleTime &requested) noexcept {
    if (actual.scale == 0 || requested.scale == 0)
      return false;
    return static_cast<std::int64_t>(actual.value) *
               static_cast<std::int64_t>(requested.scale) ==
           static_cast<std::int64_t>(requested.value) *
               static_cast<std::int64_t>(actual.scale);
  }

  [[nodiscard]] static std::optional<AEGP_KeyframeIndex>
  find_keyframe_at_time(const AEGP_KeyframeSuite5 *keyframe_suite,
                        AEGP_StreamRefH stream, A_long keyframe_count,
                        const LayerPropertySampleTime &requested,
                        TimePoint deadline) {
    if (keyframe_suite == nullptr || stream == nullptr ||
        requested.scale == 0 ||
        requested.value < std::numeric_limits<std::int32_t>::min() ||
        requested.value > std::numeric_limits<std::int32_t>::max()) {
      return std::nullopt;
    }
    for (A_long index = 0; index < keyframe_count; ++index) {
      if (std::chrono::steady_clock::now() >= deadline)
        return std::nullopt;
      A_Time time{};
      if (keyframe_suite->AEGP_GetKeyframeTime(
              stream, index, AEGP_LTimeMode_CompTime, &time) != A_Err_NONE) {
        return std::nullopt;
      }
      if (keyframe_time_equal(time, requested))
        return index;
    }
    return std::nullopt;
  }

  [[nodiscard]] std::optional<LayerPropertyKeyframeDetails>
  read_keyframe_details_value(const AEGP_StreamSuite6 *stream_suite,
                              const AEGP_KeyframeSuite5 *keyframe_suite,
                              const ResolvedProperty &resolved,
                              AEGP_KeyframeIndex index,
                              const ObjectLocator &property_locator) const {
    A_Time time{};
    StreamValueOwner value_owner(stream_suite);
    AEGP_KeyframeInterpolationType in_interpolation = AEGP_KeyInterp_NONE;
    AEGP_KeyframeInterpolationType out_interpolation = AEGP_KeyInterp_NONE;
    AEGP_KeyframeFlags flags = AEGP_KeyframeFlag_NONE;
    if (keyframe_suite->AEGP_GetKeyframeTime(resolved.stream.get(), index,
                                             AEGP_LTimeMode_CompTime,
                                             &time) != A_Err_NONE ||
        time.scale <= 0 ||
        keyframe_suite->AEGP_GetNewKeyframeValue(
            plugin_id_, resolved.stream.get(), index, value_owner.out()) !=
            A_Err_NONE)
      return std::nullopt;
    value_owner.mark_initialized();
    if (keyframe_suite->AEGP_GetKeyframeInterpolation(
            resolved.stream.get(), index, &in_interpolation,
            &out_interpolation) != A_Err_NONE ||
        keyframe_suite->AEGP_GetKeyframeFlags(resolved.stream.get(), index,
                                              &flags) != A_Err_NONE) {
      return std::nullopt;
    }
    const auto value =
        primitive_stream_value(resolved.type, value_owner.value());
    const auto in_name = keyframe_interpolation_name(in_interpolation);
    const auto out_name = keyframe_interpolation_name(out_interpolation);
    if (!value.has_value() || !in_name.has_value() || !out_name.has_value()) {
      return std::nullopt;
    }
    LayerPropertyKeyframeDetails details;
    details.property_locator = property_locator;
    details.time = {static_cast<std::int64_t>(time.value),
                    static_cast<std::uint64_t>(time.scale)};
    details.value_type = stream_type_name(resolved.type);
    details.value = *value;
    details.temporal_dimensionality =
        static_cast<std::uint16_t>(resolved.temporal_dimensions);
    details.in_interpolation = *in_name;
    details.out_interpolation = *out_name;
    details.temporal_ease.reserve(
        static_cast<std::size_t>(resolved.temporal_dimensions));
    for (A_long dimension = 0; dimension < resolved.temporal_dimensions;
         ++dimension) {
      AEGP_KeyframeEase in_ease{};
      AEGP_KeyframeEase out_ease{};
      if (keyframe_suite->AEGP_GetKeyframeTemporalEase(
              resolved.stream.get(), index, dimension, &in_ease, &out_ease) !=
          A_Err_NONE)
        return std::nullopt;
      const auto in_speed = decimal_string(in_ease.speedF);
      const auto in_influence = decimal_string(in_ease.influenceF * 100.0);
      const auto out_speed = decimal_string(out_ease.speedF);
      const auto out_influence = decimal_string(out_ease.influenceF * 100.0);
      if (!in_speed.has_value() || !in_influence.has_value() ||
          !out_speed.has_value() || !out_influence.has_value()) {
        return std::nullopt;
      }
      details.temporal_ease.push_back({static_cast<std::uint16_t>(dimension),
                                       {*in_speed, *in_influence},
                                       {*out_speed, *out_influence}});
    }
    details.behavior = {(flags & AEGP_KeyframeFlag_TEMPORAL_CONTINUOUS) != 0,
                        (flags & AEGP_KeyframeFlag_TEMPORAL_AUTOBEZIER) != 0,
                        (flags & AEGP_KeyframeFlag_SPATIAL_CONTINUOUS) != 0,
                        (flags & AEGP_KeyframeFlag_SPATIAL_AUTOBEZIER) != 0,
                        (flags & AEGP_KeyframeFlag_ROVING) != 0};
    return details;
  }

  [[nodiscard]] std::optional<std::string>
  read_item_name(const AEGP_ItemSuite9 *item_suite,
                 const AEGP_MemorySuite1 *memory_suite, AEGP_ItemH item) const {
    AEGP_MemHandle handle = nullptr;
    if (item_suite->AEGP_GetItemName(plugin_id_, item, &handle) != A_Err_NONE ||
        handle == nullptr) {
      return std::nullopt;
    }
    MemHandleOwner owner(memory_suite, handle);
    return owner.utf8();
  }

  [[nodiscard]] std::optional<CompositionSettings>
  composition_settings(const AEGP_ItemSuite9 *item_suite,
                       const AEGP_CompSuite12 *comp_suite,
                       const AEGP_LayerSuite9 *layer_suite,
                       const AEGP_MemorySuite1 *memory_suite, AEGP_ItemH item,
                       AEGP_CompH comp, ObjectLocator locator) const {
    const std::optional<std::string> name =
        read_item_name(item_suite, memory_suite, item);
    A_long width = 0;
    A_long height = 0;
    A_long layer_count = 0;
    A_Time duration{};
    A_Time frame_duration{};
    A_Time work_start{};
    A_Time work_duration{};
    A_Time display_start{};
    A_Ratio pixel_aspect{};
    AEGP_ColorVal background{};
    if (!name.has_value() ||
        item_suite->AEGP_GetItemDimensions(item, &width, &height) !=
            A_Err_NONE ||
        item_suite->AEGP_GetItemDuration(item, &duration) != A_Err_NONE ||
        item_suite->AEGP_GetItemPixelAspectRatio(item, &pixel_aspect) !=
            A_Err_NONE ||
        comp_suite->AEGP_GetCompFrameDuration(comp, &frame_duration) !=
            A_Err_NONE ||
        comp_suite->AEGP_GetCompWorkAreaStart(comp, &work_start) !=
            A_Err_NONE ||
        comp_suite->AEGP_GetCompWorkAreaDuration(comp, &work_duration) !=
            A_Err_NONE ||
        comp_suite->AEGP_GetCompDisplayStartTime(comp, &display_start) !=
            A_Err_NONE ||
        comp_suite->AEGP_GetCompBGColor(comp, &background) != A_Err_NONE ||
        layer_suite->AEGP_GetCompNumLayers(comp, &layer_count) != A_Err_NONE ||
        width < 1 || width > 30000 || height < 1 || height > 30000 ||
        layer_count < 0 || duration.scale <= 0 || duration.value <= 0 ||
        frame_duration.scale <= 0 || frame_duration.value <= 0 ||
        work_start.scale <= 0 || work_start.value < 0 ||
        work_duration.scale <= 0 || work_duration.value <= 0 ||
        display_start.scale <= 0 || pixel_aspect.num <= 0 ||
        pixel_aspect.den <= 0) {
      return std::nullopt;
    }
    const auto exact_time = [](const A_Time &value) {
      return CompositionCurrentTime{
          static_cast<std::int32_t>(value.value),
          static_cast<std::uint32_t>(value.scale),
          aemcp::native::canonical_seconds_rational(value.value, value.scale)};
    };
    const std::uint64_t rate_divisor =
        std::gcd(static_cast<std::uint64_t>(frame_duration.scale),
                 static_cast<std::uint64_t>(frame_duration.value));
    CompositionSettings settings;
    settings.composition_locator = std::move(locator);
    settings.name = *name;
    settings.width = static_cast<std::uint32_t>(width);
    settings.height = static_cast<std::uint32_t>(height);
    settings.duration = exact_time(duration);
    settings.frame_duration = exact_time(frame_duration);
    settings.frame_rate = {
        static_cast<std::int32_t>(frame_duration.scale / rate_divisor),
        static_cast<std::int32_t>(frame_duration.value / rate_divisor),
        aemcp::native::canonical_seconds_rational(
            frame_duration.scale / rate_divisor,
            static_cast<std::uint32_t>(frame_duration.value / rate_divisor))};
    settings.pixel_aspect_ratio = {
        static_cast<std::int32_t>(pixel_aspect.num),
        static_cast<std::int32_t>(pixel_aspect.den),
        aemcp::native::canonical_seconds_rational(
            pixel_aspect.num, static_cast<std::uint32_t>(pixel_aspect.den))};
    const auto rgba8 = [](A_FpLong channel) {
      const A_FpLong bounded =
          std::clamp(channel, A_FpLong{0.0}, A_FpLong{1.0});
      return static_cast<std::uint8_t>(std::lround(bounded * 255.0));
    };
    settings.background_color = {
        rgba8(background.redF), rgba8(background.greenF),
        rgba8(background.blueF), rgba8(background.alphaF)};
    settings.work_area_start = exact_time(work_start);
    settings.work_area_duration = exact_time(work_duration);
    settings.display_start_time = exact_time(display_start);
    settings.layer_count = static_cast<std::uint64_t>(layer_count);
    return settings;
  }

  SPBasicSuite *basic_{nullptr};
  AEGP_PluginID plugin_id_{0};
  ProjectGraphRegistry &graph_;
  const AEGP_UtilitySuite6 *utility_suite_{nullptr};
  bool undo_open_{false};
};

class AegpHostIdleSignal final : public aemcp::native::HostIdleSignal {
public:
  explicit AegpHostIdleSignal(const AEGP_UtilitySuite6 *utility_suite) noexcept
      : utility_suite_(utility_suite) {}

  [[nodiscard]] bool request_idle() noexcept override {
    return utility_suite_ != nullptr &&
           utility_suite_->AEGP_CauseIdleRoutinesToBeCalled != nullptr &&
           utility_suite_->AEGP_CauseIdleRoutinesToBeCalled() == A_Err_NONE;
  }

private:
  const AEGP_UtilitySuite6 *utility_suite_{nullptr};
};

struct PluginState final : NativeIpcObserver, NativeRpcObserver {
  PluginState(SPBasicSuite *basic_suite, AEGP_PluginID plugin_id_value,
              A_long driver_major_value, A_long driver_minor_value)
      : basic(basic_suite), plugin_id(plugin_id_value),
        driver_major(driver_major_value), driver_minor(driver_minor_value),
        utility_suite(basic_suite, kAEGPUtilitySuite,
                      kAEGPUtilitySuiteVersion6),
        idle_signal(utility_suite.get()),
        dispatcher(std::this_thread::get_id(), clock) {
    if (utility_suite.get() == nullptr) {
      throw std::runtime_error("AEGP utility suite unavailable");
    }
    instance_id = aemcp::native::secure_uuid_v4();
    peer_backend = aemcp::native::create_host_peer_identity_backend();
    const auto host_process =
        aemcp::native::current_host_process(*peer_backend);
    if (!host_process.valid())
      throw std::runtime_error("native host identity unavailable");
    std::string endpoint_nonce;
    for (const char character : instance_id) {
      if (character != '-' && endpoint_nonce.size() < 12)
        endpoint_nonce.push_back(character);
    }
    endpoint = std::make_unique<PlatformEndpointRegistry>(
        *peer_backend,
        aemcp::native::EndpointRegistryConfig{{}, endpoint_nonce, 2, 128});
    rpc_handler = std::make_unique<NativeRpcConnectionHandler>(
        dispatcher, clock, session_clock,
        NativeRpcRuntimeInfo{
            std::string(kPluginVersion),
            std::string(kSdkVersion),
            kSdkBuild,
            host_identity.version,
            host_identity.build_number,
            instance_id,
        },
        *this, idle_signal);
    ipc_server = std::make_unique<PlatformIpcServer>(
        *endpoint, *peer_backend, *rpc_handler, *this,
        aemcp::native::PlatformIpcServerConfig{
            1500ms, 16, aemcp::native::host_native_cpu_type()});
  }

  [[nodiscard]] bool start_ipc() noexcept;
  void stop_ipc() noexcept;
  void on_ipc_event(std::string_view event,
                    std::string_view decision) noexcept override;
  void on_rpc_event(std::string_view event, std::string_view request_id,
                    std::string_view decision) noexcept override;
  void on_rpc_terminal(const Completion &completion,
                       std::string_view request_digest,
                       std::string_view postcondition_digest,
                       std::uint64_t started_at_unix_ms,
                       std::uint64_t completed_at_unix_ms) noexcept override;

  SPBasicSuite *basic;
  AEGP_PluginID plugin_id;
  A_long driver_major;
  A_long driver_minor;
  std::string instance_id;
  HostIdentity host_identity{read_host_identity()};
  DiagnosticLog log;
  SystemClock clock;
  SuiteLease<AEGP_UtilitySuite6> utility_suite;
  AegpHostIdleSignal idle_signal;
  ProjectGraphRegistry project_graph;
  HostDispatcher dispatcher;
  aemcp::native::rpc::SystemSessionClock session_clock;
  std::unique_ptr<aemcp::native::PeerIdentityBackend> peer_backend;
  std::unique_ptr<PlatformEndpointRegistry> endpoint;
  std::unique_ptr<NativeRpcConnectionHandler> rpc_handler;
  std::unique_ptr<PlatformIpcServer> ipc_server;
};

std::string event_prefix(const PluginState &state, std::string_view event) {
  std::ostringstream output;
  output << "{\"schemaVersion\":1,\"event\":\"" << json_escape(event)
         << "\",\"timeUnixMs\":" << unix_time_ms()
         << ",\"provenance\":\"native-aegp\",\"instanceId\":\""
         << json_escape(state.instance_id) << "\"";
  return output.str();
}

void log_load(PluginState &state) {
  std::ostringstream output;
  output << event_prefix(state, "load") << ",\"pluginVersion\":\""
         << kPluginVersion << "\",\"compiledSdkVersion\":\"" << kSdkVersion
         << "\",\"sourceCommit\":\"" << kSourceCommit
         << "\",\"driverApi\":{\"major\":" << state.driver_major
         << ",\"minor\":" << state.driver_minor << "}"
         << ",\"host\":{\"version\":\""
         << json_escape(state.host_identity.version) << "\",\"build\":\""
         << json_escape(state.host_identity.build) << "\"}"
         << ",\"capabilities\":[\"ae.native.exec\"]}";
  state.log.append(output.str());
}

void log_completion(PluginState &state, const Completion &completion,
                    std::string_view request_digest = {},
                    std::string_view postcondition_digest = {},
                    std::uint64_t started_at_unix_ms = 0,
                    std::uint64_t completed_at_unix_ms = 0) {
  std::ostringstream output;
  output << event_prefix(state, "invoke.terminal") << ",\"requestId\":\""
         << json_escape(completion.request_id) << "\",\"capabilityId\":\""
         << json_escape(completion.capability_id)
         << "\",\"ok\":" << (completion.ok ? "true" : "false")
         << ",\"routeRevoked\":"
         << (completion.route_revoked ? "true" : "false");
  if (!request_digest.empty()) {
    output << ",\"requestDigest\":\"" << json_escape(request_digest) << "\"";
  }
  if (started_at_unix_ms > 0 && completed_at_unix_ms >= started_at_unix_ms) {
    output << ",\"startedAtUnixMs\":" << started_at_unix_ms
           << ",\"completedAtUnixMs\":" << completed_at_unix_ms;
  }
  if (completion.ok) {
    if (completion.capability_id == kProjectGraphInvalidateControl) {
      output << ",\"result\":{\"invalidated\":"
             << (completion.project_graph_invalidation_result.invalidated
                     ? "true"
                     : "false")
             << ",\"generation\":"
             << completion.project_graph_invalidation_result.generation;
    } else if (completion.capability_id == kNativeProgramCapability) {
      const NativeProgramHostResult &value = completion.native_program_result;
      output << ",\"result\":{\"completedOperationCount\":"
             << value.completed_operation_indices.size()
             << ",\"outputCount\":" << value.outputs.size()
             << ",\"writeStarted\":" << (value.write_started ? "true" : "false")
             << ",\"undoAvailable\":"
             << (value.undo_available ? "true" : "false")
             << ",\"replayed\":" << (completion.replayed ? "true" : "false");
    } else {
      output << ",\"result\":{\"unrecognizedCapability\":true";
    }
    if (!postcondition_digest.empty()) {
      output << ",\"postconditionDigest\":\""
             << json_escape(postcondition_digest) << "\"";
    }
    output << "}";
  } else {
    output << ",\"error\":{\"code\":\"" << json_escape(completion.error_code)
           << "\",\"message\":\"" << json_escape(completion.message)
           << "\",\"lateResultDiscarded\":"
           << (completion.late_result_discarded ? "true" : "false");
    if (completion.capability_id == kNativeProgramCapability) {
      const NativeProgramHostResult &value = completion.native_program_result;
      const char *disposition = "not-started";
      if (value.disposition == NativeProgramDisposition::kCompleted) {
        disposition = "completed";
      } else if (value.disposition ==
                 NativeProgramDisposition::kPossiblySideEffecting) {
        disposition = "possibly-side-effecting";
      }
      output << ",\"nativeProgram\":{\"completedOperationCount\":"
             << value.completed_operation_indices.size()
             << ",\"outputCount\":" << value.outputs.size()
             << ",\"disposition\":\"" << disposition << "\",\"writeStarted\":"
             << (value.write_started ? "true" : "false")
             << ",\"undoAvailable\":"
             << (value.undo_available ? "true" : "false")
             << ",\"replayed\":" << (completion.replayed ? "true" : "false");
      if (value.failed_operation_index.has_value()) {
        output << ",\"failedOperationIndex\":" << *value.failed_operation_index;
      }
      output << "}";
    }
    output << "}";
  }
  output << "}";
  state.log.append(output.str());
}

bool PluginState::start_ipc() noexcept {
  try {
    const auto host_process =
        aemcp::native::current_host_process(*peer_backend);
    const auto result = endpoint->start(NativeEndpointDescriptor{
        1,
        instance_id,
        host_process,
        {},
        1,
        std::string(kSourceCommit),
    });
    if (!result.ok()) {
      log.append(event_prefix(*this, "ipc.start-failed") + ",\"decision\":\"" +
                 json_escape(result.diagnostic) + "\"}");
      return false;
    }
    if (!ipc_server->start()) {
      endpoint->stop();
      log.append(event_prefix(*this, "ipc.start-failed") +
                 ",\"decision\":\"worker-start-failed\"}");
      return false;
    }
    return true;
  } catch (...) {
    if (endpoint)
      endpoint->stop();
    return false;
  }
}

void PluginState::stop_ipc() noexcept {
  if (ipc_server)
    ipc_server->stop();
}

void PluginState::on_ipc_event(std::string_view event,
                               std::string_view decision) noexcept {
  log.append(event_prefix(*this, std::string("ipc.") + std::string(event)) +
             ",\"decision\":\"" + json_escape(decision) + "\"}");
}

void PluginState::on_rpc_event(std::string_view event,
                               std::string_view request_id,
                               std::string_view decision) noexcept {
  log.append(event_prefix(*this, std::string("rpc.") + std::string(event)) +
             ",\"requestId\":\"" + json_escape(request_id) +
             "\",\"decision\":\"" + json_escape(decision) + "\"}");
}

void PluginState::on_rpc_terminal(const Completion &completion,
                                  std::string_view request_digest,
                                  std::string_view postcondition_digest,
                                  std::uint64_t started_at_unix_ms,
                                  std::uint64_t completed_at_unix_ms) noexcept {
  log_completion(*this, completion, request_digest, postcondition_digest,
                 started_at_unix_ms, completed_at_unix_ms);
}

A_Err death_hook(AEGP_GlobalRefcon global_refcon,
                 AEGP_DeathRefcon death_refcon) noexcept {
  try {
    auto *state = reinterpret_cast<PluginState *>(death_refcon);
    if (state == nullptr)
      state = reinterpret_cast<PluginState *>(global_refcon);
    if (state == nullptr)
      return A_Err_GENERIC;
    std::unique_ptr<PluginState> state_owner(state);
    state->stop_ipc();
    for (const Completion &completion : state->dispatcher.shutdown()) {
      log_completion(*state, completion);
    }
    state->log.append(event_prefix(*state, "death") + "}");
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

A_Err idle_hook(AEGP_GlobalRefcon global_refcon, AEGP_IdleRefcon idle_refcon,
                A_long *max_sleep) noexcept {
  try {
    auto *state = reinterpret_cast<PluginState *>(idle_refcon);
    if (state == nullptr)
      state = reinterpret_cast<PluginState *>(global_refcon);
    if (state == nullptr)
      return A_Err_GENERIC;
    AegpHostApi host(state->basic, state->plugin_id, state->project_graph,
                     state->utility_suite.get());
    const DrainBatch batch = state->dispatcher.drain(host);
    if (batch.wrong_thread) {
      state->log.append(event_prefix(*state, "dispatch.wrong-thread") + "}");
      return A_Err_GENERIC;
    }
    if (max_sleep != nullptr && batch.remaining > 0)
      *max_sleep = 1;
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

A_Err command_hook(AEGP_GlobalRefcon global_refcon, AEGP_CommandRefcon,
                   AEGP_Command command, AEGP_HookPriority, A_Boolean,
                   A_Boolean *) noexcept {
  try {
    auto *state = reinterpret_cast<PluginState *>(global_refcon);
    if (state == nullptr)
      return A_Err_GENERIC;
    const bool invalidated = state->project_graph.invalidate_project();
    state->dispatcher.invalidate_composition_creation_replays();
    state->log.append(event_prefix(*state, "project.command-invalidation") +
                      ",\"command\":" + std::to_string(command) +
                      ",\"phase\":\"before-ae\",\"invalidated\":" +
                      (invalidated ? "true" : "false") + ",\"generation\":" +
                      std::to_string(state->project_graph.generation()) + "}");
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

} // namespace

extern "C" AE_MCP_PLUGIN_EXPORT A_Err AeMcpNativeMain(
    SPBasicSuite *pica_basic, A_long driver_major, A_long driver_minor,
    AEGP_PluginID plugin_id, AEGP_GlobalRefcon *global_refcon) noexcept {
  try {
    if (pica_basic == nullptr || global_refcon == nullptr ||
        driver_major < AEGP_INITFUNC_MAJOR_VERSION ||
        (driver_major == AEGP_INITFUNC_MAJOR_VERSION &&
         driver_minor < AEGP_INITFUNC_MINOR_VERSION)) {
      return A_Err_GENERIC;
    }
    auto state = std::unique_ptr<PluginState>(new (std::nothrow) PluginState(
        pica_basic, plugin_id, driver_major, driver_minor));
    if (!state)
      return A_Err_GENERIC;
    *global_refcon = reinterpret_cast<AEGP_GlobalRefcon>(state.get());

    const AEGP_RegisterSuite5 *register_suite = nullptr;
    if (pica_basic->AcquireSuite(
            kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5,
            reinterpret_cast<const void **>(&register_suite)) != 0 ||
        register_suite == nullptr) {
      *global_refcon = nullptr;
      return A_Err_GENERIC;
    }
    const A_Err death_error = register_suite->AEGP_RegisterDeathHook(
        plugin_id, death_hook, reinterpret_cast<AEGP_DeathRefcon>(state.get()));
    PluginState *lifecycle_state = state.get();
    if (death_error == A_Err_NONE) {
      // From this point onward AE's DeathHook owns the state. Any later
      // exception must leave the registered hook refcons alive rather than
      // deleting them.
      lifecycle_state = state.release();
    }
    const A_Err idle_error =
        death_error == A_Err_NONE
            ? register_suite->AEGP_RegisterIdleHook(
                  plugin_id, idle_hook,
                  reinterpret_cast<AEGP_IdleRefcon>(lifecycle_state))
            : death_error;

    const A_Err command_error = idle_error == A_Err_NONE
                                    ? register_suite->AEGP_RegisterCommandHook(
                                          plugin_id, AEGP_HP_BeforeAE,
                                          AEGP_Command_ALL, command_hook, 0)
                                    : idle_error;
    const SPErr release_error = pica_basic->ReleaseSuite(
        kAEGPRegisterSuite, kAEGPRegisterSuiteVersion5);

    if (death_error != A_Err_NONE) {
      *global_refcon = nullptr;
      return death_error;
    }
    if (idle_error != A_Err_NONE || release_error != 0) {
      return idle_error != A_Err_NONE ? idle_error : A_Err_GENERIC;
    }

    try {
      log_load(*lifecycle_state);
      if (command_error != A_Err_NONE) {
        lifecycle_state->log.append(
            event_prefix(*lifecycle_state, "project.command-hook-unavailable") +
            "}");
      } else {
        (void)lifecycle_state->start_ipc();
      }
    } catch (...) {
      // Hook registration is authoritative; optional boot diagnostics cannot
      // turn a live AE-owned state into a failed initialization.
    }
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}
