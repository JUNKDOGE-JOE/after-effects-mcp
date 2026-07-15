#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/endpoint_registry_macos.hpp"
#include "aemcp_native/mac_ipc_server.hpp"
#include "aemcp_native/native_rpc_connection.hpp"
#include "aemcp_native/pairing_gate.hpp"
#include "aemcp_native/pairing_ui_macos.hpp"
#include "aemcp_native/peer_identity_macos.hpp"
#include "aemcp_native/project_epoch.hpp"
#include "aemcp_native/rpc_codec.hpp"
#include "aemcp_native/secure_random_macos.hpp"

#include <CoreFoundation/CoreFoundation.h>

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
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <unistd.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>

#include "AEConfig.h"
#include "AE_GeneralPlug.h"
#include "SPBasic.h"

#ifndef AE_MCP_SOURCE_COMMIT
#error "AE_MCP_SOURCE_COMMIT must bind the native binary to a clean repository commit"
#endif

#ifndef AE_MCP_PRODUCT_VERSION
#error "AE_MCP_PRODUCT_VERSION must bind the native binary to the repository product version"
#endif

namespace {

using namespace std::chrono_literals;
using aemcp::native::Completion;
using aemcp::native::DrainBatch;
using aemcp::native::HostApi;
using aemcp::native::HostBitDepthReadResult;
using aemcp::native::HostBitDepthWriteResult;
using aemcp::native::HostCompositionLayersResult;
using aemcp::native::HostCompositionTimeResult;
using aemcp::native::HostDispatcher;
using aemcp::native::HostReadResult;
using aemcp::native::HostProjectItemsResult;
using aemcp::native::HostLayerPropertiesResult;
using aemcp::native::MacEndpointRegistry;
using aemcp::native::MacIpcServer;
using aemcp::native::NativeEndpointDescriptor;
using aemcp::native::NativeIpcObserver;
using aemcp::native::NativeRpcConnectionHandler;
using aemcp::native::NativeRpcObserver;
using aemcp::native::NativeRpcRuntimeInfo;
using aemcp::native::PairingGate;
using aemcp::native::PairingUiDecision;
using aemcp::native::ProjectBitDepth;
using aemcp::native::ProjectBitDepthChanged;
using aemcp::native::ProjectEpochTracker;
using aemcp::native::ProjectObservation;
using aemcp::native::ProjectSummary;
using aemcp::native::ObjectLocator;
using aemcp::native::Request;
using aemcp::native::SystemClock;
using aemcp::native::TimePoint;
using aemcp::native::kProjectBitDepthReadCapability;
using aemcp::native::kProjectBitDepthSetCapability;
using aemcp::native::kProjectSummaryCapability;
using aemcp::native::kCompositionLayersListCapability;
using aemcp::native::kCompositionTimeReadCapability;
using aemcp::native::kProjectItemsListCapability;
using aemcp::native::kLayerPropertiesListCapability;

constexpr std::string_view kPluginVersion = AE_MCP_PRODUCT_VERSION;
constexpr std::string_view kSdkVersion = "25.6.61";
constexpr std::uint64_t kSdkBuild = 61;
constexpr std::string_view kSourceCommit = AE_MCP_SOURCE_COMMIT;
constexpr std::string_view kCapabilitiesDigest =
    "781a620eac1310fb85dc0ac74ae9655fdab0512d370e1039074cd0ff2fb4d7fb";
constexpr std::string_view kProjectSummaryContractDigest =
    "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a";
constexpr std::string_view kProjectBitDepthReadContractDigest =
    "936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e";
constexpr std::string_view kProjectBitDepthSetContractDigest =
    "d5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a";
constexpr std::string_view kProjectItemsListContractDigest =
    "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e";
constexpr std::string_view kCompositionLayersListContractDigest =
    "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75";
constexpr std::string_view kCompositionTimeReadContractDigest =
    "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd";
constexpr std::string_view kLayerPropertiesListContractDigest =
    "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba";
constexpr std::int64_t kMaximumProjectItems = 100000;
static_assert(kSourceCommit.size() == 40);

std::string json_escape(std::string_view input) {
  std::ostringstream escaped;
  for (unsigned char value : input) {
    switch (value) {
      case '"': escaped << "\\\""; break;
      case '\\': escaped << "\\\\"; break;
      case '\b': escaped << "\\b"; break;
      case '\f': escaped << "\\f"; break;
      case '\n': escaped << "\\n"; break;
      case '\r': escaped << "\\r"; break;
      case '\t': escaped << "\\t"; break;
      default:
        if (value < 0x20 || value >= 0x7f) {
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
      std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string cf_string(CFTypeRef value) {
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) return {};
  const auto string = static_cast<CFStringRef>(value);
  const CFIndex length = CFStringGetLength(string);
  const CFIndex maximum = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  if (maximum <= 1 || maximum > 4096) return {};
  std::string output(static_cast<std::size_t>(maximum), '\0');
  if (!CFStringGetCString(string, output.data(), maximum, kCFStringEncodingUTF8)) return {};
  output.resize(std::char_traits<char>::length(output.c_str()));
  return output;
}

struct HostIdentity {
  std::string version;
  std::string build;
  std::uint64_t build_number{0};
};

std::uint64_t positive_integer(std::string_view value) {
  std::uint64_t parsed = 0;
  const auto [end, error] = std::from_chars(
      value.data(), value.data() + value.size(), parsed);
  return error == std::errc{} && end == value.data() + value.size() && parsed > 0
      ? parsed : 0;
}

HostIdentity read_host_identity() {
  const CFBundleRef bundle = CFBundleGetMainBundle();
  if (bundle == nullptr) return {};
  HostIdentity identity;
  identity.version = cf_string(
      CFBundleGetValueForInfoDictionaryKey(bundle, CFSTR("CFBundleShortVersionString")));
  identity.build = cf_string(
      CFBundleGetValueForInfoDictionaryKey(bundle, CFSTR("Adobe Product Build")));
  identity.build_number = positive_integer(identity.build);
  return identity;
}

class DiagnosticLog final {
 public:
  DiagnosticLog() {
    const char* home = std::getenv("HOME");
    if (home == nullptr || *home == '\0') return;
    path_ = std::filesystem::path(home) / "Library" / "Logs" / "AfterEffectsMCP"
        / "native-plugin-v1.jsonl";
  }

  void append(std::string_view object) noexcept {
    try {
      if (path_.empty() || object.empty() || object.size() > kMaximumRecordBytes
          || object.front() != '{' || object.back() != '}') return;
      std::lock_guard lock(mutex_);
      if (!prepare_private_directory()) return;
      const int descriptor = ::open(
          path_.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (descriptor < 0) return;
      struct stat status {};
      if (::flock(descriptor, LOCK_EX | LOCK_NB) != 0
          || ::fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode)
          || status.st_uid != ::getuid() || status.st_nlink != 1
          || ::fchmod(descriptor, 0600) != 0) {
        ::close(descriptor);
        return;
      }
      if (status.st_size < 0
          || static_cast<std::uint64_t>(status.st_size) + object.size() + 1
              > kMaximumLogBytes) {
        if (::ftruncate(descriptor, 0) != 0) {
          ::close(descriptor);
          return;
        }
      }
      const std::string record = std::string(object) + '\n';
      std::size_t written = 0;
      while (written < record.size()) {
        const ssize_t count = ::write(
            descriptor, record.data() + written, record.size() - written);
        if (count > 0) {
          written += static_cast<std::size_t>(count);
        } else if (count < 0 && errno == EINTR) {
          continue;
        } else {
          break;
        }
      }
      ::close(descriptor);
    } catch (...) {
      // Diagnostics must never affect After Effects lifecycle callbacks.
    }
  }

 private:
  static constexpr std::size_t kMaximumRecordBytes = 8192;
  static constexpr std::uint64_t kMaximumLogBytes = 1024 * 1024;

  [[nodiscard]] bool prepare_private_directory() const noexcept {
    const std::filesystem::path directory = path_.parent_path();
    if (::mkdir(directory.c_str(), 0700) != 0 && errno != EEXIST) return false;
    struct stat status {};
    if (::lstat(directory.c_str(), &status) != 0 || !S_ISDIR(status.st_mode)
        || status.st_uid != ::getuid()) {
      return false;
    }
    return ::chmod(directory.c_str(), 0700) == 0;
  }

  std::filesystem::path path_;
  std::mutex mutex_;
};

template <typename Suite>
class SuiteLease final {
 public:
  SuiteLease(SPBasicSuite* basic, const char* name, std::int32_t version)
      : basic_(basic), name_(name), version_(version) {
    if (basic_ != nullptr
        && basic_->AcquireSuite(name_, version_, reinterpret_cast<const void**>(&suite_)) != 0) {
      suite_ = nullptr;
    }
  }

  ~SuiteLease() {
    if (suite_ != nullptr) basic_->ReleaseSuite(name_, version_);
  }

  SuiteLease(const SuiteLease&) = delete;
  SuiteLease& operator=(const SuiteLease&) = delete;

  [[nodiscard]] const Suite* get() const noexcept { return suite_; }
  [[nodiscard]] const Suite* operator->() const noexcept { return suite_; }

 private:
  SPBasicSuite* basic_{nullptr};
  const char* name_{nullptr};
  std::int32_t version_{0};
  const Suite* suite_{nullptr};
};

class MemHandleOwner final {
 public:
  MemHandleOwner(const AEGP_MemorySuite1* suite, AEGP_MemHandle handle)
      : suite_(suite), handle_(handle) {}
  ~MemHandleOwner() {
    if (suite_ != nullptr && handle_ != nullptr) {
      if (locked_) (void)suite_->AEGP_UnlockMemHandle(handle_);
      (void)suite_->AEGP_FreeMemHandle(handle_);
    }
  }
  MemHandleOwner(const MemHandleOwner&) = delete;
  MemHandleOwner& operator=(const MemHandleOwner&) = delete;

  [[nodiscard]] std::optional<std::string> utf8() {
    if (suite_ == nullptr || handle_ == nullptr) return std::string{};
    AEGP_MemSize bytes = 0;
    if (suite_->AEGP_GetMemHandleSize(handle_, &bytes) != A_Err_NONE
        || bytes == 0 || bytes > 8192 || bytes % sizeof(A_UTF16Char) != 0) {
      return std::nullopt;
    }
    void* raw = nullptr;
    if (suite_->AEGP_LockMemHandle(handle_, &raw) != A_Err_NONE || raw == nullptr) {
      return std::nullopt;
    }
    locked_ = true;
    const auto* characters = static_cast<const A_UTF16Char*>(raw);
    const std::size_t capacity = bytes / sizeof(A_UTF16Char);
    std::size_t length = 0;
    while (length < capacity && characters[length] != 0) ++length;
    if (length == capacity) return std::nullopt;
    std::size_t scalars = 0;
    for (std::size_t index = 0; index < length;) {
      const std::uint16_t unit = characters[index++];
      if (unit >= 0xd800U && unit <= 0xdbffU) {
        if (index >= length) return std::nullopt;
        const std::uint16_t trailing = characters[index++];
        if (trailing < 0xdc00U || trailing > 0xdfffU) return std::nullopt;
      } else if (unit >= 0xdc00U && unit <= 0xdfffU) {
        return std::nullopt;
      }
      if (++scalars > 1024) return std::nullopt;
    }
    CFStringRef value = CFStringCreateWithCharacters(
        kCFAllocatorDefault,
        reinterpret_cast<const UniChar*>(characters),
        static_cast<CFIndex>(length));
    if (value == nullptr) return std::nullopt;
    const CFIndex maximum =
        CFStringGetMaximumSizeForEncoding(
            static_cast<CFIndex>(length), kCFStringEncodingUTF8) + 1;
    if (maximum <= 0 || maximum > 8193) {
      CFRelease(value);
      return std::nullopt;
    }
    std::string output(static_cast<std::size_t>(maximum), '\0');
    if (!CFStringGetCString(value, output.data(), maximum, kCFStringEncodingUTF8)) {
      CFRelease(value);
      return std::nullopt;
    }
    CFRelease(value);
    const std::size_t utf8_bytes = std::char_traits<char>::length(output.c_str());
    if (utf8_bytes > 4096) return std::nullopt;
    output.resize(utf8_bytes);
    return output;
  }

 private:
  const AEGP_MemorySuite1* suite_{nullptr};
  AEGP_MemHandle handle_{nullptr};
  bool locked_{false};
};

[[nodiscard]] std::optional<std::string> read_project_path(
    const AEGP_ProjSuite6* project_suite,
    const AEGP_MemorySuite1* memory_suite,
    AEGP_ProjectH project) {
  AEGP_MemHandle path_handle = nullptr;
  const A_Err path_error = project_suite->AEGP_GetProjectPath(
      project, &path_handle);
  MemHandleOwner path_owner(memory_suite, path_handle);
  if (path_error != A_Err_NONE) return std::nullopt;
  return path_owner.utf8();
}

[[nodiscard]] std::optional<std::string> read_effective_layer_name(
    const AEGP_LayerSuite9* layer_suite,
    const AEGP_ItemSuite9* item_suite,
    const AEGP_MemorySuite1* memory_suite,
    AEGP_PluginID plugin_id,
    AEGP_LayerH layer,
    std::string& error) {
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
    if (!layer_name->empty()) return layer_name;
  }
  std::optional<std::string> source_name;
  if (source_name_handle != nullptr) {
    source_name = source_name_owner.utf8();
    if (!source_name.has_value()) {
      error = "layer source name is not bounded UTF-16 text";
      return std::nullopt;
    }
    if (!source_name->empty()) return source_name;
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
    MemHandleOwner source_item_name_owner(memory_suite, source_item_name_handle);
    if (source_item_name_error != A_Err_NONE
        || source_item_name_handle == nullptr) {
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
      aemcp::native::select_effective_layer_name(
          layer_name, source_name, source_item_name);
  if (!effective_name.has_value()) {
    error = "After Effects returned no layer or source name";
    return std::nullopt;
  }
  return effective_name;
}

class StreamRefOwner final {
 public:
  StreamRefOwner(const AEGP_StreamSuite6* suite, AEGP_StreamRefH stream)
      : suite_(suite), stream_(stream) {}
  ~StreamRefOwner() { reset(); }
  StreamRefOwner(const StreamRefOwner&) = delete;
  StreamRefOwner& operator=(const StreamRefOwner&) = delete;
  StreamRefOwner(StreamRefOwner&& other) noexcept
      : suite_(other.suite_), stream_(other.stream_) {
    other.stream_ = nullptr;
  }
  StreamRefOwner& operator=(StreamRefOwner&& other) noexcept {
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
  const AEGP_StreamSuite6* suite_{nullptr};
  AEGP_StreamRefH stream_{nullptr};
};

class StreamValueOwner final {
 public:
  explicit StreamValueOwner(const AEGP_StreamSuite6* suite) : suite_(suite) {}
  ~StreamValueOwner() {
    if (initialized_ && suite_ != nullptr) {
      (void)suite_->AEGP_DisposeStreamValue(&value_);
    }
  }
  StreamValueOwner(const StreamValueOwner&) = delete;
  StreamValueOwner& operator=(const StreamValueOwner&) = delete;
  [[nodiscard]] AEGP_StreamValue2* out() noexcept { return &value_; }
  void mark_initialized() noexcept { initialized_ = true; }
  [[nodiscard]] const AEGP_StreamValue2& value() const noexcept { return value_; }

 private:
  const AEGP_StreamSuite6* suite_{nullptr};
  AEGP_StreamValue2 value_{};
  bool initialized_{false};
};

class ProjectGraphRegistry final {
 public:
  static_assert(
      ProjectEpochTracker::kMaxGeneration == aemcp::native::rpc::kMaxSafeInteger);

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
    if (!epoch_.close()) return;
    clear_objects();
  }

  void observe_project(
      std::uintptr_t identity,
      std::uintptr_t root_item_identity,
      A_long root_item_id,
      std::string project_path) {
    if (!epoch_.observe(ProjectObservation{
            identity,
            root_item_identity,
            static_cast<std::int64_t>(root_item_id),
            std::move(project_path)})) {
      return;
    }
    project_id_ = aemcp::native::secure_uuid_v4();
    project_object_id_ = aemcp::native::secure_uuid_v4();
    clear_objects();
  }

  [[nodiscard]] ObjectLocator project_locator(
      std::string_view host, std::string_view session) const {
    return make_locator("project", project_object_id_, host, session);
  }

  [[nodiscard]] ObjectLocator item_locator(
      A_long item_id,
      bool composition,
      std::string_view host,
      std::string_view session) {
    auto found = item_object_ids_.find(item_id);
    if (found == item_object_ids_.end()) {
      const std::string object_id = aemcp::native::secure_uuid_v4();
      found = item_object_ids_.emplace(item_id, object_id).first;
      item_ids_by_object_.emplace(object_id, item_id);
    }
    return make_locator(composition ? "composition" : "item", found->second, host, session);
  }

  [[nodiscard]] ObjectLocator layer_locator(
      A_long composition_item_id,
      AEGP_LayerIDVal layer_id,
      std::string_view host,
      std::string_view session) {
    const std::string key = std::to_string(composition_item_id) + ":"
        + std::to_string(static_cast<A_long>(layer_id));
    auto found = layer_object_ids_.find(key);
    if (found == layer_object_ids_.end()) {
      found = layer_object_ids_.emplace(key, aemcp::native::secure_uuid_v4()).first;
      layers_by_object_.emplace(
          found->second, LayerAddress{composition_item_id, layer_id});
    }
    return make_locator("layer", found->second, host, session);
  }

  [[nodiscard]] std::optional<LayerAddress> resolve_layer(
      const ObjectLocator& locator,
      std::string_view host,
      std::string_view session) const {
    if (locator.kind != "layer" || locator.host_instance_id != host
        || locator.session_id != session || locator.project_id != project_id_
        || locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = layers_by_object_.find(locator.object_id);
    return found == layers_by_object_.end()
        ? std::nullopt : std::optional<LayerAddress>(found->second);
  }

  [[nodiscard]] ObjectLocator stream_locator(
      const ObjectLocator& layer_locator_value,
      std::vector<A_long> child_indices,
      std::vector<std::int32_t> unique_ids,
      std::string_view host,
      std::string_view session) {
    if (child_indices.empty() || child_indices.size() != unique_ids.size()
        || child_indices.size() > 32) {
      throw std::runtime_error("stream locator registry bound exceeded");
    }
    std::string key = layer_locator_value.object_id;
    for (std::size_t index = 0; index < child_indices.size(); ++index) {
      key += ":" + std::to_string(child_indices[index])
          + "@" + std::to_string(unique_ids[index]);
    }
    auto found = stream_object_ids_.find(key);
    if (found == stream_object_ids_.end()) {
      if (stream_addresses_.size() >= 16'384) {
        throw std::runtime_error("stream locator registry bound exceeded");
      }
      const std::string object_id = aemcp::native::secure_uuid_v4();
      found = stream_object_ids_.emplace(key, object_id).first;
      stream_addresses_.emplace(
          object_id,
          StreamAddress{
              layer_locator_value.object_id,
              std::move(child_indices),
              std::move(unique_ids)});
    }
    return make_locator("stream", found->second, host, session);
  }

  [[nodiscard]] std::optional<StreamAddress> resolve_stream(
      const ObjectLocator& locator,
      const ObjectLocator& layer_locator_value,
      std::string_view host,
      std::string_view session) const {
    if (locator.kind != "stream" || locator.host_instance_id != host
        || locator.session_id != session || locator.project_id != project_id_
        || locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = stream_addresses_.find(locator.object_id);
    if (found == stream_addresses_.end()
        || found->second.layer_object_id != layer_locator_value.object_id) {
      return std::nullopt;
    }
    return found->second;
  }

  [[nodiscard]] bool matches_project(
      const ObjectLocator& locator,
      std::string_view host,
      std::string_view session) const {
    return locator.kind == "project" && locator.host_instance_id == host
        && locator.session_id == session && locator.project_id == project_id_
        && locator.generation == epoch_.generation()
        && locator.object_id == project_object_id_;
  }

  [[nodiscard]] std::optional<A_long> resolve_composition(
      const ObjectLocator& locator,
      std::string_view host,
      std::string_view session) const {
    if (locator.kind != "composition" || locator.host_instance_id != host
        || locator.session_id != session || locator.project_id != project_id_
        || locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = item_ids_by_object_.find(locator.object_id);
    return found == item_ids_by_object_.end()
        ? std::nullopt : std::optional<A_long>(found->second);
  }

 private:
  [[nodiscard]] ObjectLocator make_locator(
      std::string kind,
      std::string object_id,
      std::string_view host,
      std::string_view session) const {
    return {
        std::move(kind),
        std::string(host),
        std::string(session),
        project_id_,
        epoch_.generation(),
        std::move(object_id)};
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

[[nodiscard]] std::optional<AEGP_ProjBitDepth> sdk_bit_depth(
    std::int32_t bits_per_channel) {
  switch (bits_per_channel) {
    case 8: return static_cast<AEGP_ProjBitDepth>(AEGP_ProjBitDepth_8);
    case 16: return static_cast<AEGP_ProjBitDepth>(AEGP_ProjBitDepth_16);
    case 32: return static_cast<AEGP_ProjBitDepth>(AEGP_ProjBitDepth_32);
    default: return std::nullopt;
  }
}

[[nodiscard]] std::optional<std::int32_t> bits_per_channel(
    AEGP_ProjBitDepth depth) {
  if (depth == static_cast<AEGP_ProjBitDepth>(AEGP_ProjBitDepth_8)) return 8;
  if (depth == static_cast<AEGP_ProjBitDepth>(AEGP_ProjBitDepth_16)) return 16;
  if (depth == static_cast<AEGP_ProjBitDepth>(AEGP_ProjBitDepth_32)) return 32;
  return std::nullopt;
}

[[nodiscard]] std::string project_item_type(AEGP_ItemType type) {
  if (type == AEGP_ItemType_FOLDER) return "folder";
  if (type == AEGP_ItemType_COMP) return "composition";
  if (type == AEGP_ItemType_FOOTAGE || type == AEGP_ItemType_SOLID_defunct) {
    return "footage";
  }
  return "unknown";
}

[[nodiscard]] std::string layer_type(
    AEGP_ObjectType object_type, AEGP_LayerFlags flags) {
  if ((flags & AEGP_LayerFlag_ADJUSTMENT_LAYER) != 0) return "adjustment";
  if ((flags & AEGP_LayerFlag_NULL_LAYER) != 0) return "null";
  if (object_type == AEGP_ObjectType_AV) return "av";
  if (object_type == AEGP_ObjectType_LIGHT) return "light";
  if (object_type == AEGP_ObjectType_CAMERA) return "camera";
  if (object_type == AEGP_ObjectType_TEXT) return "text";
  if (object_type == AEGP_ObjectType_VECTOR) return "shape";
  if (object_type == AEGP_ObjectType_3D_MODEL) return "model3d";
  return "unknown";
}

[[nodiscard]] std::optional<std::string> decimal_string(A_FpLong value) {
  if (!std::isfinite(value)) return std::nullopt;
  if (value == 0) return std::string("0");
  std::array<char, 64> buffer{};
  const auto [end, error] = std::to_chars(
      buffer.data(),
      buffer.data() + buffer.size(),
      value,
      std::chars_format::general,
      std::numeric_limits<A_FpLong>::max_digits10);
  if (error != std::errc{}) return std::nullopt;
  std::string result(buffer.data(), end);
  if (result.empty() || result.size() > 32) return std::nullopt;
  return result;
}

[[nodiscard]] std::string stream_type_name(AEGP_StreamType type) {
  switch (type) {
    case AEGP_StreamType_NO_DATA: return "none";
    case AEGP_StreamType_OneD: return "one-d";
    case AEGP_StreamType_TwoD: return "two-d";
    case AEGP_StreamType_TwoD_SPATIAL: return "two-d-spatial";
    case AEGP_StreamType_ThreeD: return "three-d";
    case AEGP_StreamType_ThreeD_SPATIAL: return "three-d-spatial";
    case AEGP_StreamType_COLOR: return "color";
    case AEGP_StreamType_ARB: return "arb";
    case AEGP_StreamType_MARKER: return "marker";
    case AEGP_StreamType_LAYER_ID: return "layer-id";
    case AEGP_StreamType_MASK_ID: return "mask-id";
    case AEGP_StreamType_MASK: return "mask";
    case AEGP_StreamType_TEXT_DOCUMENT: return "text-document";
    default: return "unknown";
  }
}

template <std::size_t Size>
constexpr std::size_t literal_size(const char (&)[Size]) noexcept {
  return Size - 1;
}

[[nodiscard]] std::size_t locator_json_size(const ObjectLocator& locator) {
  return literal_size("{\"generation\":")
      + std::to_string(locator.generation).size()
      + literal_size(",\"hostInstanceId\":")
      + aemcp::native::json_encoded_string_size(locator.host_instance_id)
      + literal_size(",\"kind\":")
      + aemcp::native::json_encoded_string_size(locator.kind)
      + literal_size(",\"objectId\":")
      + aemcp::native::json_encoded_string_size(locator.object_id)
      + literal_size(",\"projectId\":")
      + aemcp::native::json_encoded_string_size(locator.project_id)
      + literal_size(",\"sessionId\":")
      + aemcp::native::json_encoded_string_size(locator.session_id)
      + literal_size("}");
}

[[nodiscard]] std::size_t nullable_locator_json_size(
    const std::optional<ObjectLocator>& locator) {
  return locator.has_value() ? locator_json_size(*locator) : literal_size("null");
}

[[nodiscard]] std::size_t project_item_json_size(
    const aemcp::native::ProjectItemEntry& item) {
  return literal_size("{\"locator\":") + locator_json_size(item.locator)
      + literal_size(",\"name\":")
      + aemcp::native::json_encoded_string_size(item.name)
      + literal_size(",\"parentLocator\":")
      + nullable_locator_json_size(item.parent_locator)
      + literal_size(",\"type\":")
      + aemcp::native::json_encoded_string_size(item.type)
      + literal_size("}");
}

[[nodiscard]] std::size_t composition_layer_json_size(
    const aemcp::native::CompositionLayerEntry& layer) {
  return literal_size("{\"isThreeD\":") + literal_size("false")
      + literal_size(",\"locator\":") + locator_json_size(layer.locator)
      + literal_size(",\"locked\":") + literal_size("false")
      + literal_size(",\"name\":")
      + aemcp::native::json_encoded_string_size(layer.name)
      + literal_size(",\"parentLocator\":")
      + nullable_locator_json_size(layer.parent_locator)
      + literal_size(",\"sourceItemLocator\":")
      + nullable_locator_json_size(layer.source_item_locator)
      + literal_size(",\"stackIndex\":")
      + std::to_string(layer.stack_index).size()
      + literal_size(",\"type\":")
      + aemcp::native::json_encoded_string_size(layer.type)
      + literal_size(",\"videoEnabled\":") + literal_size("false")
      + literal_size("}");
}

[[nodiscard]] std::size_t layer_property_json_size(
    const aemcp::native::LayerPropertyEntry& property) {
  std::size_t value_size = literal_size("null");
  if (const auto* scalar =
          std::get_if<aemcp::native::LayerPropertyScalarValue>(&property.value)) {
    value_size = 32U + aemcp::native::json_encoded_string_size(scalar->value);
  } else if (const auto* vector =
                 std::get_if<aemcp::native::LayerPropertyVectorValue>(&property.value)) {
    value_size = 32U;
    for (const std::string& component : vector->components) {
      value_size += aemcp::native::json_encoded_string_size(component) + 1U;
    }
  } else if (const auto* color =
                 std::get_if<aemcp::native::LayerPropertyColorValue>(&property.value)) {
    value_size = 64U + aemcp::native::json_encoded_string_size(color->alpha)
        + aemcp::native::json_encoded_string_size(color->red)
        + aemcp::native::json_encoded_string_size(color->green)
        + aemcp::native::json_encoded_string_size(color->blue);
  }
  return 512U + locator_json_size(property.property_locator)
      + aemcp::native::json_encoded_string_size(property.name)
      + aemcp::native::json_encoded_string_size(property.match_name)
      + value_size;
}

class AegpHostApi final : public HostApi {
 public:
  AegpHostApi(
      SPBasicSuite* basic, AEGP_PluginID plugin_id, ProjectGraphRegistry& graph)
      : basic_(basic), plugin_id_(plugin_id), graph_(graph) {}

  [[nodiscard]] HostReadResult read_project_summary(TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr) {
      return HostReadResult::failure("NATIVE_UNSUPPORTED", "required project suites unavailable");
    }

    A_long project_count = 0;
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostReadResult::failure("CAPABILITY_FAILED", "could not read project count");
    }
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    if (project_count <= 0) return HostReadResult::success({false, {}, 0});

    AEGP_ProjectH project = nullptr;
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE || project == nullptr) {
      return HostReadResult::failure("CAPABILITY_FAILED", "could not resolve active project");
    }

    std::array<A_char, AEGP_MAX_PROJ_NAME_SIZE> name{};
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    if (project_suite->AEGP_GetProjectName(project, name.data()) != A_Err_NONE) {
      return HostReadResult::failure("CAPABILITY_FAILED", "could not read project name");
    }

    AEGP_ItemH root = nullptr;
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    if (project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE || root == nullptr) {
      return HostReadResult::failure("CAPABILITY_FAILED", "could not resolve project root");
    }
    AEGP_ItemH item = nullptr;
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project summary budget elapsed");
    }
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostReadResult::failure("CAPABILITY_FAILED", "could not begin project traversal");
    }
    std::int64_t item_count = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostReadResult::failure("DEADLINE_EXCEEDED", "project traversal budget elapsed");
      }
      ++item_count;
      if (item_count > kMaximumProjectItems) {
        return HostReadResult::failure("CAPABILITY_FAILED", "project item bound exceeded");
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return HostReadResult::failure("CAPABILITY_FAILED", "project traversal failed");
      }
      item = next;
    }
    if (budget_expired()) {
      return HostReadResult::failure("DEADLINE_EXCEEDED", "project traversal budget elapsed");
    }
    const auto name_end = std::find(name.begin(), name.end(), '\0');
    return HostReadResult::success({
        true, std::string(name.begin(), name_end), item_count});
  }

  [[nodiscard]] HostBitDepthReadResult read_project_bit_depth(
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    if (budget_expired()) {
      return HostBitDepthReadResult::failure(
          "DEADLINE_EXCEEDED", "project bit-depth read budget elapsed");
    }

    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    if (project_suite.get() == nullptr) {
      return HostBitDepthReadResult::failure(
          "NATIVE_UNSUPPORTED", "required project suite unavailable");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostBitDepthReadResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      return HostBitDepthReadResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }

    AEGP_ProjectH project = nullptr;
    if (budget_expired()) {
      return HostBitDepthReadResult::failure(
          "DEADLINE_EXCEEDED", "project bit-depth read budget elapsed");
    }
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr) {
      return HostBitDepthReadResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project");
    }

    AEGP_ProjBitDepth observed = static_cast<AEGP_ProjBitDepth>(-1);
    if (project_suite->AEGP_GetProjectBitDepth(project, &observed) != A_Err_NONE) {
      return HostBitDepthReadResult::failure(
          "CAPABILITY_FAILED", "could not read project bits per channel");
    }
    const auto mapped = bits_per_channel(observed);
    if (!mapped.has_value()) {
      return HostBitDepthReadResult::failure(
          "CAPABILITY_FAILED", "project returned an unsupported bit-depth enum");
    }
    if (budget_expired()) {
      return HostBitDepthReadResult::failure(
          "DEADLINE_EXCEEDED", "project bit-depth read budget elapsed");
    }
    return HostBitDepthReadResult::success(ProjectBitDepth{*mapped});
  }

  [[nodiscard]] HostBitDepthWriteResult set_project_bit_depth(
      std::int32_t target_depth,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    const auto target = sdk_bit_depth(target_depth);
    if (!target.has_value()) {
      return HostBitDepthWriteResult::failure(
          "INVALID_ARGUMENT",
          "targetDepth must be one of 8, 16, or 32",
          "params.arguments.targetDepth");
    }
    if (budget_expired()) {
      return HostBitDepthWriteResult::failure(
          "DEADLINE_EXCEEDED", "project bit-depth set budget elapsed");
    }

    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || utility_suite.get() == nullptr) {
      return HostBitDepthWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required project mutation suites unavailable");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostBitDepthWriteResult::failure(
          "CAPABILITY_FAILED", "could not read project count before mutation");
    }
    if (project_count <= 0) {
      return HostBitDepthWriteResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }

    AEGP_ProjectH project = nullptr;
    if (budget_expired()) {
      return HostBitDepthWriteResult::failure(
          "DEADLINE_EXCEEDED", "project bit-depth set budget elapsed");
    }
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr) {
      return HostBitDepthWriteResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project");
    }

    AEGP_ProjBitDepth before_sdk = static_cast<AEGP_ProjBitDepth>(-1);
    if (project_suite->AEGP_GetProjectBitDepth(project, &before_sdk) != A_Err_NONE) {
      return HostBitDepthWriteResult::failure(
          "CAPABILITY_FAILED", "could not read project bit depth before mutation");
    }
    const auto before = bits_per_channel(before_sdk);
    if (!before.has_value()) {
      return HostBitDepthWriteResult::failure(
          "CAPABILITY_FAILED", "project returned an unsupported bit-depth enum");
    }
    if (*before == target_depth) {
      return HostBitDepthWriteResult::failure(
          "INVALID_ARGUMENT",
          "targetDepth already matches the project's current bits per channel",
          "params.arguments.targetDepth");
    }
    if (budget_expired()) {
      return HostBitDepthWriteResult::failure(
          "DEADLINE_EXCEEDED", "project bit-depth set budget elapsed");
    }

    static constexpr char kUndoLabel[] = "ae-mcp: Set project bit depth";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostBitDepthWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }

    const A_Err set_error = project_suite->AEGP_SetProjectBitDepth(project, *target);
    // A successful StartUndoGroup is always balanced. Once SetProjectBitDepth
    // has been called, every failure is possibly side-effecting regardless of
    // the SDK return code. Readback is still attempted to aid exact validation.
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    AEGP_ProjBitDepth after_sdk = static_cast<AEGP_ProjBitDepth>(-1);
    const A_Err readback_error = project_suite->AEGP_GetProjectBitDepth(
        project, &after_sdk);
    const auto after = readback_error == A_Err_NONE
        ? bits_per_channel(after_sdk) : std::nullopt;

    if (set_error != A_Err_NONE) {
      return HostBitDepthWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project bit depth may have changed despite an SDK error; inspect project state");
    }
    if (end_error != A_Err_NONE) {
      return HostBitDepthWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project bit depth changed but its undo group did not close cleanly");
    }
    if (!after.has_value() || *after != target_depth || *after == *before) {
      return HostBitDepthWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project bit-depth readback did not verify the requested state transition");
    }
    if (budget_expired()) {
      return HostBitDepthWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project bit depth changed after the validation budget elapsed");
    }
    return HostBitDepthWriteResult::success(ProjectBitDepthChanged{
        true, *before, *after});
  }

  [[nodiscard]] HostProjectItemsResult list_project_items(
      const aemcp::native::ProjectItemsQuery& query,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || memory_suite.get() == nullptr) {
      return HostProjectItemsResult::failure(
          "NATIVE_UNSUPPORTED", "required project item suites are unavailable");
    }
    if (budget_expired()) {
      return HostProjectItemsResult::failure(
          "DEADLINE_EXCEEDED", "project item list budget elapsed");
    }
    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostProjectItemsResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE
        || root == nullptr
        || item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostProjectItemsResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    if (query.project_locator.has_value()
        && !graph_.matches_project(*query.project_locator, query.host_instance_id, query.session_id)) {
      return HostProjectItemsResult::failure(
          "STALE_LOCATOR",
          "projectLocator does not identify the currently open project",
          "params.arguments.projectLocator");
    }

    aemcp::native::ProjectItemsPage page;
    page.project_locator = graph_.project_locator(query.host_instance_id, query.session_id);
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
        return HostProjectItemsResult::failure(
            "CAPABILITY_FAILED", "project item bound exceeded");
      }
      if (position >= query.offset && page.items.size() < query.limit
          && !response_budget_exhausted) {
        AEGP_ItemType sdk_type = AEGP_ItemType_NONE;
        A_long item_id = 0;
        AEGP_ItemH parent = nullptr;
        if (item_suite->AEGP_GetItemType(item, &sdk_type) != A_Err_NONE
            || item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE
            || item_suite->AEGP_GetItemParentFolder(item, &parent) != A_Err_NONE) {
          return HostProjectItemsResult::failure(
              "CAPABILITY_FAILED", "could not read project item identity");
        }
        AEGP_MemHandle name_handle = nullptr;
        const A_Err name_error = item_suite->AEGP_GetItemName(
            plugin_id_, item, &name_handle);
        MemHandleOwner name_owner(memory_suite.get(), name_handle);
        if (name_error != A_Err_NONE || name_handle == nullptr) {
          return HostProjectItemsResult::failure(
              "CAPABILITY_FAILED", "could not read project item name");
        }
        const std::optional<std::string> name = name_owner.utf8();
        if (!name.has_value()) {
          return HostProjectItemsResult::failure(
              "CAPABILITY_FAILED", "project item name is not bounded UTF-16 text");
        }
        const std::string type = project_item_type(sdk_type);
        aemcp::native::ProjectItemEntry entry;
        entry.locator = graph_.item_locator(
            item_id, sdk_type == AEGP_ItemType_COMP,
            query.host_instance_id, query.session_id);
        entry.name = *name;
        entry.type = type;
        if (parent == nullptr || parent == root) {
          entry.parent_locator = page.project_locator;
        } else {
          A_long parent_id = 0;
          if (item_suite->AEGP_GetItemID(parent, &parent_id) != A_Err_NONE) {
            return HostProjectItemsResult::failure(
                "CAPABILITY_FAILED", "could not read project item parent identity");
          }
          entry.parent_locator = graph_.item_locator(
              parent_id, false, query.host_instance_id, query.session_id);
        }
        const std::size_t entry_bytes = project_item_json_size(entry)
            + (page.items.empty() ? 0U : 1U);
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return HostProjectItemsResult::failure(
            "CAPABILITY_FAILED", "project item traversal failed");
      }
      item = next;
    }
    page.total = position;
    if (query.offset > page.total) {
      return HostProjectItemsResult::failure(
          "INVALID_ARGUMENT",
          "offset exceeds the current project item total",
          "params.arguments.offset");
    }
    page.has_more = query.offset + page.items.size() < page.total;
    if (page.has_more) page.next_offset = query.offset + page.items.size();
    return HostProjectItemsResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionLayersResult list_composition_layers(
      const aemcp::native::CompositionLayersQuery& query,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr) {
      return HostCompositionLayersResult::failure(
          "NATIVE_UNSUPPORTED", "required composition layer suites are unavailable");
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
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE
        || root == nullptr
        || item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root),
          root_id,
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
          "compositionLocator does not identify an item in the currently open project",
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
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
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
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) != A_Err_NONE) {
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
    MemHandleOwner composition_name_owner(
        memory_suite.get(), composition_name_handle);
    if (composition_name_error != A_Err_NONE || composition_name_handle == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not read composition name");
    }
    const std::optional<std::string> composition_name = composition_name_owner.utf8();
    if (!composition_name.has_value()) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "composition name is not bounded UTF-16 text");
    }
    AEGP_CompH composition = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) != A_Err_NONE
        || composition == nullptr) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", "could not resolve composition handle");
    }
    A_long layer_count = 0;
    if (layer_suite->AEGP_GetCompNumLayers(composition, &layer_count) != A_Err_NONE
        || layer_count < 0) {
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
        1024U + locator_json_size(page.composition_locator)
            + aemcp::native::json_encoded_string_size(page.composition_name));
    const std::uint64_t end = query.offset >= page.total
        ? query.offset
        : std::min(page.total, query.offset + query.limit);
    for (std::uint64_t position = query.offset; position < end; ++position) {
      if (budget_expired()) {
        return HostCompositionLayersResult::failure(
            "DEADLINE_EXCEEDED", "composition layer page budget elapsed");
      }
      AEGP_LayerH layer = nullptr;
      if (layer_suite->AEGP_GetCompLayerByIndex(
              composition, static_cast<A_long>(position), &layer) != A_Err_NONE
          || layer == nullptr) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not resolve composition layer");
      }
      AEGP_LayerIDVal layer_id = 0;
      AEGP_LayerFlags flags = 0;
      AEGP_ObjectType object_type = AEGP_ObjectType_NONE;
      if (layer_suite->AEGP_GetLayerID(layer, &layer_id) != A_Err_NONE
          || layer_suite->AEGP_GetLayerFlags(layer, &flags) != A_Err_NONE
          || layer_suite->AEGP_GetLayerObjectType(layer, &object_type) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read composition layer identity");
      }
      std::string layer_name_error;
      const std::optional<std::string> layer_name = read_effective_layer_name(
          layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_, layer,
          layer_name_error);
      if (!layer_name.has_value()) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", layer_name_error);
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
        entry.parent_locator = graph_.layer_locator(
            *composition_id, parent_id, query.host_instance_id, query.session_id);
      }

      AEGP_ItemH source_item = nullptr;
      if (layer_suite->AEGP_GetLayerSourceItem(layer, &source_item) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read layer source item");
      }
      if (source_item != nullptr) {
        A_long source_id = 0;
        AEGP_ItemType source_type = AEGP_ItemType_NONE;
        if (item_suite->AEGP_GetItemID(source_item, &source_id) != A_Err_NONE
            || item_suite->AEGP_GetItemType(source_item, &source_type) != A_Err_NONE) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED", "could not read layer source item identity");
        }
        entry.source_item_locator = graph_.item_locator(
            source_id,
            source_type == AEGP_ItemType_COMP,
            query.host_instance_id,
            query.session_id);
      }
      const std::size_t entry_bytes = composition_layer_json_size(entry)
          + (page.layers.empty() ? 0U : 1U);
      if (!page_budget.try_reserve(entry_bytes)) {
        if (page.layers.empty()) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED",
              "one composition layer exceeds the bounded native response budget");
        }
        break;
      }
      page.layers.push_back(std::move(entry));
    }
    page.has_more = query.offset + page.layers.size() < page.total;
    if (page.has_more) page.next_offset = query.offset + page.layers.size();
    return HostCompositionLayersResult::success(std::move(page));
  }

  [[nodiscard]] HostCompositionTimeResult read_composition_time(
      const aemcp::native::CompositionTimeQuery& query,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || memory_suite.get() == nullptr) {
      return HostCompositionTimeResult::failure(
          "NATIVE_UNSUPPORTED", "required composition time suites are unavailable");
    }
    if (budget_expired()) {
      return HostCompositionTimeResult::failure(
          "DEADLINE_EXCEEDED", "composition time read budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
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
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE
        || root == nullptr
        || item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root),
          root_id,
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
          "compositionLocator does not identify an item in the currently open project",
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
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
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
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) != A_Err_NONE) {
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
    if (item_suite->AEGP_GetItemCurrentTime(composition_item, &current_time)
            != A_Err_NONE) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "could not read composition current time");
    }
    if (budget_expired()) {
      return HostCompositionTimeResult::failure(
          "DEADLINE_EXCEEDED", "composition time read budget elapsed");
    }
    if (current_time.scale == 0) {
      return HostCompositionTimeResult::failure(
          "CAPABILITY_FAILED", "After Effects returned a zero composition time scale");
    }
    aemcp::native::CompositionTimeRead result;
    result.composition_locator = query.composition_locator;
    result.current_time.value = static_cast<std::int32_t>(current_time.value);
    result.current_time.scale = static_cast<std::uint32_t>(current_time.scale);
    result.current_time.seconds_rational = aemcp::native::canonical_seconds_rational(
        static_cast<std::int64_t>(result.current_time.value),
        static_cast<std::uint64_t>(result.current_time.scale));
    return HostCompositionTimeResult::success(std::move(result));
  }

  [[nodiscard]] HostLayerPropertiesResult list_layer_properties(
      const aemcp::native::LayerPropertiesQuery& query,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_StreamSuite6> stream_suite(
        basic_, kAEGPStreamSuite, kAEGPStreamSuiteVersion6);
    SuiteLease<AEGP_DynamicStreamSuite4> dynamic_suite(
        basic_, kAEGPDynamicStreamSuite, kAEGPDynamicStreamSuiteVersion4);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || stream_suite.get() == nullptr
        || dynamic_suite.get() == nullptr) {
      return HostLayerPropertiesResult::failure(
          "NATIVE_UNSUPPORTED", "required layer property suites are unavailable");
    }
    if (budget_expired()) {
      return HostLayerPropertiesResult::failure(
          "DEADLINE_EXCEEDED", "layer property list budget elapsed");
    }
    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostLayerPropertiesResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root_item = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root_item) != A_Err_NONE
        || root_item == nullptr
        || item_suite->AEGP_GetItemID(root_item, &root_id) != A_Err_NONE) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root_item),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto layer_address = graph_.resolve_layer(
        query.layer_locator, query.host_instance_id, query.session_id);
    if (!layer_address.has_value()) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR",
          "layerLocator does not identify a layer in the currently open project",
          "params.arguments.layerLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) != A_Err_NONE) {
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
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
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
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) != A_Err_NONE
        || composition == nullptr) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR", "layer composition can no longer be resolved",
          "params.arguments.layerLocator");
    }
    AEGP_LayerH layer = nullptr;
    if (layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE
        || layer == nullptr) {
      return HostLayerPropertiesResult::failure(
          "STALE_LOCATOR", "layer no longer exists in its composition",
          "params.arguments.layerLocator");
    }
    std::string layer_name_error;
    const std::optional<std::string> layer_name = read_effective_layer_name(
        layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_, layer,
        layer_name_error);
    if (!layer_name.has_value()) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", layer_name_error);
    }
    A_Time sample_time{};
    if (layer_suite->AEGP_GetLayerCurrentTime(
            layer, AEGP_LTimeMode_CompTime, &sample_time) != A_Err_NONE
        || sample_time.scale <= 0) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not read a bounded composition sample time");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE
        || root_stream == nullptr) {
      return HostLayerPropertiesResult::failure(
          "CAPABILITY_FAILED", "could not resolve the layer property root");
    }
    StreamRefOwner parent_stream(stream_suite.get(), root_stream);
    std::vector<A_long> parent_indices;
    std::vector<std::int32_t> parent_unique_ids;
    if (query.parent_property_locator.has_value()) {
      const auto address = graph_.resolve_stream(
          *query.parent_property_locator,
          query.layer_locator,
          query.host_instance_id,
          query.session_id);
      if (!address.has_value()) {
        return HostLayerPropertiesResult::failure(
            "STALE_LOCATOR",
            "parentPropertyLocator does not identify a property on this layer",
            "params.arguments.parentPropertyLocator");
      }
      for (std::size_t depth = 0; depth < address->child_indices.size(); ++depth) {
        AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
        A_long child_count = 0;
        if (dynamic_suite->AEGP_GetStreamGroupingType(
                parent_stream.get(), &grouping) != A_Err_NONE
            || grouping == AEGP_StreamGroupingType_LEAF
            || dynamic_suite->AEGP_GetNumStreamsInGroup(
                parent_stream.get(), &child_count) != A_Err_NONE
            || address->child_indices[depth] < 0
            || address->child_indices[depth] >= child_count) {
          return HostLayerPropertiesResult::failure(
              "STALE_LOCATOR", "parent property path no longer exists",
              "params.arguments.parentPropertyLocator");
        }
        AEGP_StreamRefH next_stream = nullptr;
        if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
                plugin_id_, parent_stream.get(), address->child_indices[depth],
                &next_stream) != A_Err_NONE
            || next_stream == nullptr) {
          return HostLayerPropertiesResult::failure(
              "STALE_LOCATOR", "parent property path could not be reacquired",
              "params.arguments.parentPropertyLocator");
        }
        StreamRefOwner next_owner(stream_suite.get(), next_stream);
        std::int32_t unique_id = 0;
        if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id)
                != A_Err_NONE
            || unique_id != address->unique_ids[depth]) {
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
          "CAPABILITY_FAILED", "could not inspect the parent property grouping");
    }
    if (parent_grouping == AEGP_StreamGroupingType_LEAF) {
      return HostLayerPropertiesResult::failure(
          "INVALID_ARGUMENT", "parentPropertyLocator identifies a leaf property",
          "params.arguments.parentPropertyLocator");
    }
    A_long child_count = 0;
    if (dynamic_suite->AEGP_GetNumStreamsInGroup(
            parent_stream.get(), &child_count) != A_Err_NONE
        || child_count < 0) {
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
          "INVALID_ARGUMENT", "offset exceeds the current direct property total",
          "params.arguments.offset");
    }
    aemcp::native::BoundedPageBudget page_budget(
        2048U + locator_json_size(page.layer_locator)
            + nullable_locator_json_size(page.parent_property_locator)
            + aemcp::native::json_encoded_string_size(page.layer_name));
    const std::uint64_t end = query.offset >= page.total
        ? query.offset : std::min(page.total, query.offset + query.limit);
    for (std::uint64_t position = query.offset; position < end; ++position) {
      if (budget_expired()) {
        return HostLayerPropertiesResult::failure(
            "DEADLINE_EXCEEDED", "layer property page budget elapsed");
      }
      AEGP_StreamRefH child_stream = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, parent_stream.get(), static_cast<A_long>(position),
              &child_stream) != A_Err_NONE
          || child_stream == nullptr) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not resolve a direct layer property");
      }
      StreamRefOwner child_owner(stream_suite.get(), child_stream);
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      AEGP_DynStreamFlags flags = 0;
      A_Boolean modified = FALSE;
      std::int32_t unique_id = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(child_owner.get(), &grouping)
              != A_Err_NONE
          || dynamic_suite->AEGP_GetDynamicStreamFlags(child_owner.get(), &flags)
              != A_Err_NONE
          || dynamic_suite->AEGP_GetStreamIsModified(child_owner.get(), &modified)
              != A_Err_NONE
          || stream_suite->AEGP_GetUniqueStreamID(child_owner.get(), &unique_id)
              != A_Err_NONE) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not inspect a direct layer property");
      }
      std::array<A_char, AEGP_MAX_STREAM_MATCH_NAME_SIZE> match_name{};
      if (dynamic_suite->AEGP_GetMatchName(child_owner.get(), match_name.data())
              != A_Err_NONE
          || std::find(match_name.begin(), match_name.end(), '\0') == match_name.end()) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not read bounded property match name");
      }
      AEGP_MemHandle property_name_handle = nullptr;
      const A_Err property_name_error = stream_suite->AEGP_GetStreamName(
          plugin_id_, child_owner.get(), FALSE, &property_name_handle);
      MemHandleOwner property_name_owner(memory_suite.get(), property_name_handle);
      if (property_name_error != A_Err_NONE || property_name_handle == nullptr) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not read property name");
      }
      const std::optional<std::string> property_name = property_name_owner.utf8();
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
        entry.property_locator = graph_.stream_locator(
            query.layer_locator,
            std::move(child_indices),
            std::move(child_unique_ids),
            query.host_instance_id,
            query.session_id);
      } catch (...) {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "could not allocate a bounded stream locator");
      }
      if (grouping == AEGP_StreamGroupingType_NAMED_GROUP
          || grouping == AEGP_StreamGroupingType_INDEXED_GROUP) {
        entry.grouping_type = grouping == AEGP_StreamGroupingType_NAMED_GROUP
            ? "named-group" : "indexed-group";
        A_long grandchildren = 0;
        if (dynamic_suite->AEGP_GetNumStreamsInGroup(
                child_owner.get(), &grandchildren) != A_Err_NONE
            || grandchildren < 0) {
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
        if (stream_suite->AEGP_CanVaryOverTime(child_owner.get(), &can_vary)
                != A_Err_NONE
            || stream_suite->AEGP_IsStreamTimevarying(
                child_owner.get(), &time_varying) != A_Err_NONE
            || stream_suite->AEGP_GetStreamType(child_owner.get(), &type) != A_Err_NONE) {
          return HostLayerPropertiesResult::failure(
              "CAPABILITY_FAILED", "could not inspect leaf property value type");
        }
        entry.can_vary_over_time = can_vary != FALSE;
        entry.time_varying = time_varying != FALSE;
        entry.value_type = stream_type_name(type);
        if (type == AEGP_StreamType_NO_DATA) {
          entry.value_status = "no-data";
        } else if (type == AEGP_StreamType_OneD
            || type == AEGP_StreamType_TwoD
            || type == AEGP_StreamType_TwoD_SPATIAL
            || type == AEGP_StreamType_ThreeD
            || type == AEGP_StreamType_ThreeD_SPATIAL
            || type == AEGP_StreamType_COLOR) {
          StreamValueOwner sampled(stream_suite.get());
          if (stream_suite->AEGP_GetNewStreamValue(
                  plugin_id_, child_owner.get(), AEGP_LTimeMode_CompTime,
                  &sample_time, FALSE, sampled.out()) != A_Err_NONE) {
            return HostLayerPropertiesResult::failure(
                "CAPABILITY_FAILED", "could not sample primitive property value");
          }
          sampled.mark_initialized();
          entry.value_status = "sampled";
          if (type == AEGP_StreamType_OneD) {
            const auto value = decimal_string(sampled.value().val.one_d);
            if (!value.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED", "sampled scalar is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyScalarValue{*value};
          } else if (type == AEGP_StreamType_TwoD
              || type == AEGP_StreamType_TwoD_SPATIAL) {
            const auto x = decimal_string(sampled.value().val.two_d.x);
            const auto y = decimal_string(sampled.value().val.two_d.y);
            if (!x.has_value() || !y.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED", "sampled vector is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyVectorValue{{*x, *y}};
          } else if (type == AEGP_StreamType_ThreeD
              || type == AEGP_StreamType_ThreeD_SPATIAL) {
            const auto x = decimal_string(sampled.value().val.three_d.x);
            const auto y = decimal_string(sampled.value().val.three_d.y);
            const auto z = decimal_string(sampled.value().val.three_d.z);
            if (!x.has_value() || !y.has_value() || !z.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED", "sampled vector is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyVectorValue{{*x, *y, *z}};
          } else {
            const AEGP_ColorVal& color = sampled.value().val.color;
            const auto alpha = decimal_string(color.alphaF);
            const auto red = decimal_string(color.redF);
            const auto green = decimal_string(color.greenF);
            const auto blue = decimal_string(color.blueF);
            if (!alpha.has_value() || !red.has_value()
                || !green.has_value() || !blue.has_value()) {
              return HostLayerPropertiesResult::failure(
                  "CAPABILITY_FAILED", "sampled color is not finite decimal data");
            }
            entry.value = aemcp::native::LayerPropertyColorValue{
                *alpha, *red, *green, *blue};
          }
        } else {
          entry.value_status = "unsupported";
        }
      } else {
        return HostLayerPropertiesResult::failure(
            "CAPABILITY_FAILED", "property grouping type is unsupported");
      }
      const std::size_t entry_bytes = layer_property_json_size(entry)
          + (page.properties.empty() ? 0U : 1U);
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
    if (page.has_more) page.next_offset = query.offset + page.properties.size();
    return HostLayerPropertiesResult::success(std::move(page));
  }

 private:
  SPBasicSuite* basic_{nullptr};
  AEGP_PluginID plugin_id_{0};
  ProjectGraphRegistry& graph_;
};

struct PluginState final : NativeIpcObserver, NativeRpcObserver {
  PluginState(SPBasicSuite* basic_suite, AEGP_PluginID plugin_id_value,
      A_long driver_major_value, A_long driver_minor_value)
      : basic(basic_suite),
        plugin_id(plugin_id_value),
        driver_major(driver_major_value),
        driver_minor(driver_minor_value),
        dispatcher(std::this_thread::get_id(), clock),
        pairing_gate(pairing_clock, pairing_material) {
    instance_id = aemcp::native::secure_uuid_v4();
    peer_backend = aemcp::native::create_macos_peer_identity_backend();
    const auto host_process = aemcp::native::current_macos_process(*peer_backend);
    if (!host_process.valid()) throw std::runtime_error("native host identity unavailable");
    std::string endpoint_nonce;
    for (const char character : instance_id) {
      if (character != '-' && endpoint_nonce.size() < 12) endpoint_nonce.push_back(character);
    }
    endpoint = std::make_unique<MacEndpointRegistry>(
        *peer_backend,
        aemcp::native::EndpointRegistryConfig{{}, endpoint_nonce, 2, 128});
    rpc_handler = std::make_unique<NativeRpcConnectionHandler>(
        dispatcher,
        clock,
        session_clock,
        NativeRpcRuntimeInfo{
            std::string(kPluginVersion),
            std::string(kSdkVersion),
            kSdkBuild,
            host_identity.version,
            host_identity.build_number,
            instance_id,
            std::string(kCapabilitiesDigest),
            std::string(kProjectSummaryContractDigest),
            std::string(kProjectBitDepthReadContractDigest),
            std::string(kProjectBitDepthSetContractDigest),
            std::string(kProjectItemsListContractDigest),
            std::string(kCompositionLayersListContractDigest),
            std::string(kCompositionTimeReadContractDigest),
            std::string(kLayerPropertiesListContractDigest),
        },
        *this);
    ipc_server = std::make_unique<MacIpcServer>(
        *endpoint,
        *peer_backend,
        pairing_gate,
        *rpc_handler,
        *this,
        aemcp::native::MacIpcServerConfig{
            1500ms, 100ms, 16, aemcp::native::macos_native_cpu_type()});
  }

  [[nodiscard]] bool start_ipc() noexcept;
  void stop_ipc() noexcept;
  void on_ipc_event(
      std::string_view event, std::string_view decision) noexcept override;
  void on_rpc_event(
      std::string_view event,
      std::string_view request_id,
      std::string_view decision) noexcept override;
  void on_rpc_terminal(
      const Completion& completion,
      std::string_view request_digest,
      std::string_view postcondition_digest,
      std::uint64_t started_at_unix_ms,
      std::uint64_t completed_at_unix_ms) noexcept override;

  SPBasicSuite* basic;
  AEGP_PluginID plugin_id;
  A_long driver_major;
  A_long driver_minor;
  std::string instance_id;
  HostIdentity host_identity{read_host_identity()};
  DiagnosticLog log;
  SystemClock clock;
  ProjectGraphRegistry project_graph;
  HostDispatcher dispatcher;
  aemcp::native::rpc::SystemSessionClock session_clock;
  aemcp::native::SystemPairingGateClock pairing_clock;
  aemcp::native::MacPairingMaterialSource pairing_material;
  PairingGate pairing_gate;
  std::unique_ptr<aemcp::native::PeerIdentityBackend> peer_backend;
  std::unique_ptr<MacEndpointRegistry> endpoint;
  std::unique_ptr<NativeRpcConnectionHandler> rpc_handler;
  std::unique_ptr<MacIpcServer> ipc_server;
  AEGP_Command pairing_command{0};
};

std::string event_prefix(const PluginState& state, std::string_view event) {
  std::ostringstream output;
  output << "{\"schemaVersion\":1,\"event\":\"" << json_escape(event)
         << "\",\"timeUnixMs\":" << unix_time_ms()
         << ",\"provenance\":\"native-aegp\",\"instanceId\":\""
         << json_escape(state.instance_id) << "\"";
  return output.str();
}

void log_load(PluginState& state) {
  std::ostringstream output;
  output << event_prefix(state, "load")
         << ",\"pluginVersion\":\"" << kPluginVersion
         << "\",\"compiledSdkVersion\":\"" << kSdkVersion
         << "\",\"sourceCommit\":\"" << kSourceCommit
         << "\",\"driverApi\":{\"major\":" << state.driver_major
         << ",\"minor\":" << state.driver_minor << "}"
         << ",\"host\":{\"version\":\"" << json_escape(state.host_identity.version)
         << "\",\"build\":\"" << json_escape(state.host_identity.build) << "\"}"
         << ",\"capabilities\":[\"" << kProjectSummaryCapability << "\",\""
         << kProjectBitDepthReadCapability << "\",\""
         << kProjectBitDepthSetCapability << "\",\""
         << kProjectItemsListCapability << "\",\""
         << kCompositionLayersListCapability << "\",\""
         << kCompositionTimeReadCapability << "\",\""
         << kLayerPropertiesListCapability << "\"]}"
         ;
  state.log.append(output.str());
}

void log_completion(
    PluginState& state,
    const Completion& completion,
    std::string_view request_digest = {},
    std::string_view postcondition_digest = {},
    std::uint64_t started_at_unix_ms = 0,
    std::uint64_t completed_at_unix_ms = 0) {
  std::ostringstream output;
  output << event_prefix(state, "invoke.terminal")
         << ",\"requestId\":\"" << json_escape(completion.request_id)
         << "\",\"capabilityId\":\"" << json_escape(completion.capability_id)
         << "\",\"ok\":" << (completion.ok ? "true" : "false")
         << ",\"routeRevoked\":" << (completion.route_revoked ? "true" : "false");
  if (!request_digest.empty()) {
    output << ",\"requestDigest\":\"" << json_escape(request_digest) << "\"";
  }
  if (started_at_unix_ms > 0 && completed_at_unix_ms >= started_at_unix_ms) {
    output << ",\"startedAtUnixMs\":" << started_at_unix_ms
           << ",\"completedAtUnixMs\":" << completed_at_unix_ms;
  }
  if (completion.ok) {
    if (completion.capability_id == kProjectBitDepthSetCapability) {
      output << ",\"result\":{\"changed\":"
             << (completion.bit_depth_change_result.changed ? "true" : "false")
             << ",\"beforeBitsPerChannel\":"
             << completion.bit_depth_change_result.before_bits_per_channel
             << ",\"afterBitsPerChannel\":"
             << completion.bit_depth_change_result.after_bits_per_channel;
    } else if (completion.capability_id == kProjectBitDepthReadCapability) {
      output << ",\"result\":{\"bitsPerChannel\":"
             << completion.bit_depth_result.bits_per_channel;
    } else if (completion.capability_id == kProjectItemsListCapability) {
      output << ",\"result\":{\"total\":"
             << completion.project_items_result.total
             << ",\"offset\":" << completion.project_items_result.offset
             << ",\"returned\":" << completion.project_items_result.items.size()
             << ",\"hasMore\":"
             << (completion.project_items_result.has_more ? "true" : "false")
             << ",\"projectGeneration\":"
             << completion.project_items_result.project_locator.generation;
    } else if (completion.capability_id == kCompositionLayersListCapability) {
      output << ",\"result\":{\"total\":"
             << completion.composition_layers_result.total
             << ",\"offset\":" << completion.composition_layers_result.offset
             << ",\"returned\":" << completion.composition_layers_result.layers.size()
             << ",\"hasMore\":"
             << (completion.composition_layers_result.has_more ? "true" : "false")
             << ",\"projectGeneration\":"
             << completion.composition_layers_result.composition_locator.generation;
    } else if (completion.capability_id == kCompositionTimeReadCapability) {
      output << ",\"result\":{\"value\":"
             << completion.composition_time_result.current_time.value
             << ",\"scale\":"
             << completion.composition_time_result.current_time.scale
             << ",\"secondsRational\":\""
             << json_escape(
                    completion.composition_time_result.current_time.seconds_rational)
             << "\",\"projectGeneration\":"
             << completion.composition_time_result.composition_locator.generation;
    } else if (completion.capability_id == kLayerPropertiesListCapability) {
      output << ",\"result\":{\"total\":"
             << completion.layer_properties_result.total
             << ",\"offset\":" << completion.layer_properties_result.offset
             << ",\"returned\":" << completion.layer_properties_result.properties.size()
             << ",\"hasMore\":"
             << (completion.layer_properties_result.has_more ? "true" : "false")
             << ",\"projectGeneration\":"
             << completion.layer_properties_result.layer_locator.generation;
    } else {
      output << ",\"result\":{\"projectOpen\":"
             << (completion.result.project_open ? "true" : "false")
             << ",\"projectNameRedacted\":"
             << (completion.result.project_name.empty() ? "false" : "true")
             << ",\"itemCount\":" << completion.result.item_count;
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
           << (completion.late_result_discarded ? "true" : "false") << "}";
  }
  output << "}";
  state.log.append(output.str());
}

bool PluginState::start_ipc() noexcept {
  try {
    const auto host_process = aemcp::native::current_macos_process(*peer_backend);
    const auto result = endpoint->start(NativeEndpointDescriptor{
        1,
        instance_id,
        host_process,
        {},
        1,
        std::string(kSourceCommit),
    });
    if (!result.ok()) {
      log.append(event_prefix(*this, "ipc.start-failed")
          + ",\"decision\":\"" + json_escape(result.diagnostic) + "\"}");
      return false;
    }
    if (!ipc_server->start()) {
      endpoint->stop();
      log.append(event_prefix(*this, "ipc.start-failed")
          + ",\"decision\":\"worker-start-failed\"}");
      return false;
    }
    return true;
  } catch (...) {
    if (endpoint) endpoint->stop();
    return false;
  }
}

void PluginState::stop_ipc() noexcept {
  if (ipc_server) ipc_server->stop();
}

void PluginState::on_ipc_event(
    std::string_view event, std::string_view decision) noexcept {
  log.append(event_prefix(*this, std::string("ipc.") + std::string(event))
      + ",\"decision\":\"" + json_escape(decision) + "\"}");
}

void PluginState::on_rpc_event(
    std::string_view event,
    std::string_view request_id,
    std::string_view decision) noexcept {
  log.append(event_prefix(*this, std::string("rpc.") + std::string(event))
      + ",\"requestId\":\"" + json_escape(request_id)
      + "\",\"decision\":\"" + json_escape(decision) + "\"}");
}

void PluginState::on_rpc_terminal(
    const Completion& completion,
    std::string_view request_digest,
    std::string_view postcondition_digest,
    std::uint64_t started_at_unix_ms,
    std::uint64_t completed_at_unix_ms) noexcept {
  log_completion(
      *this,
      completion,
      request_digest,
      postcondition_digest,
      started_at_unix_ms,
      completed_at_unix_ms);
}

A_Err death_hook(
    AEGP_GlobalRefcon global_refcon, AEGP_DeathRefcon death_refcon) noexcept {
  try {
    auto* state = reinterpret_cast<PluginState*>(death_refcon);
    if (state == nullptr) state = reinterpret_cast<PluginState*>(global_refcon);
    if (state == nullptr) return A_Err_GENERIC;
    std::unique_ptr<PluginState> state_owner(state);
    state->stop_ipc();
    for (const Completion& completion : state->dispatcher.shutdown()) {
      log_completion(*state, completion);
    }
    state->log.append(event_prefix(*state, "death") + "}");
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

A_Err idle_hook(
    AEGP_GlobalRefcon global_refcon, AEGP_IdleRefcon idle_refcon, A_long* max_sleep) noexcept {
  try {
    auto* state = reinterpret_cast<PluginState*>(idle_refcon);
    if (state == nullptr) state = reinterpret_cast<PluginState*>(global_refcon);
    if (state == nullptr) return A_Err_GENERIC;
    AegpHostApi host(state->basic, state->plugin_id, state->project_graph);
    const DrainBatch batch = state->dispatcher.drain(host);
    if (batch.wrong_thread) {
      state->log.append(event_prefix(*state, "dispatch.wrong-thread") + "}");
      return A_Err_GENERIC;
    }
    if (max_sleep != nullptr && batch.remaining > 0) *max_sleep = 1;
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

A_Err command_hook(
    AEGP_GlobalRefcon global_refcon,
    AEGP_CommandRefcon,
    AEGP_Command command,
    AEGP_HookPriority,
    A_Boolean,
    A_Boolean* handled) noexcept {
  try {
    auto* state = reinterpret_cast<PluginState*>(global_refcon);
    if (state == nullptr || handled == nullptr || command != state->pairing_command) {
      return A_Err_NONE;
    }
    *handled = TRUE;
    const auto pending = state->ipc_server
        ? state->ipc_server->pending_pairing() : std::nullopt;
    if (!pending.has_value()) {
      aemcp::native::show_no_pending_pairing();
      return A_Err_NONE;
    }
    const PairingUiDecision decision = aemcp::native::show_pairing_confirmation(
        pending->fingerprint, pending->expires_in);
    bool applied = false;
    if (decision == PairingUiDecision::kAuthorize) {
      applied = state->ipc_server->confirm_pending(
          pending->binding.connection_id, pending->fingerprint);
    } else {
      applied = state->ipc_server->reject_pending(
          pending->binding.connection_id, pending->fingerprint);
    }
    state->log.append(event_prefix(*state, "pairing.user-decision")
        + ",\"decision\":\""
        + (decision == PairingUiDecision::kAuthorize ? "authorize" : "reject")
        + "\",\"applied\":" + (applied ? "true" : "false") + "}");
    return A_Err_NONE;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

A_Err update_menu_hook(
    AEGP_GlobalRefcon global_refcon,
    AEGP_UpdateMenuRefcon,
    AEGP_WindowType) noexcept {
  try {
    auto* state = reinterpret_cast<PluginState*>(global_refcon);
    if (state == nullptr || state->pairing_command == 0) return A_Err_GENERIC;

    const AEGP_CommandSuite1* command_suite = nullptr;
    const SPErr acquire_error = state->basic->AcquireSuite(
        kAEGPCommandSuite,
        kAEGPCommandSuiteVersion1,
        reinterpret_cast<const void**>(&command_suite));
    if (acquire_error != 0 || command_suite == nullptr) return A_Err_GENERIC;

    const A_Err enable_error = command_suite->AEGP_EnableCommand(
        state->pairing_command);
    const SPErr release_error = state->basic->ReleaseSuite(
        kAEGPCommandSuite, kAEGPCommandSuiteVersion1);
    return enable_error == A_Err_NONE && release_error == 0
        ? A_Err_NONE
        : A_Err_GENERIC;
  } catch (...) {
    return A_Err_GENERIC;
  }
}

}  // namespace

extern "C" __attribute__((visibility("default"))) A_Err AeMcpNativeMain(
    SPBasicSuite* pica_basic,
    A_long driver_major,
    A_long driver_minor,
    AEGP_PluginID plugin_id,
    AEGP_GlobalRefcon* global_refcon) noexcept {
  try {
    if (pica_basic == nullptr || global_refcon == nullptr
        || driver_major < AEGP_INITFUNC_MAJOR_VERSION
        || (driver_major == AEGP_INITFUNC_MAJOR_VERSION
            && driver_minor < AEGP_INITFUNC_MINOR_VERSION)) {
      return A_Err_GENERIC;
    }
    auto state = std::unique_ptr<PluginState>(new (std::nothrow) PluginState(
        pica_basic, plugin_id, driver_major, driver_minor));
    if (!state) return A_Err_GENERIC;
    *global_refcon = reinterpret_cast<AEGP_GlobalRefcon>(state.get());

    const AEGP_RegisterSuite5* register_suite = nullptr;
    if (pica_basic->AcquireSuite(
            kAEGPRegisterSuite,
            kAEGPRegisterSuiteVersion5,
            reinterpret_cast<const void**>(&register_suite)) != 0
        || register_suite == nullptr) {
      *global_refcon = nullptr;
      return A_Err_GENERIC;
    }
    const A_Err death_error = register_suite->AEGP_RegisterDeathHook(
        plugin_id, death_hook, reinterpret_cast<AEGP_DeathRefcon>(state.get()));
    PluginState* lifecycle_state = state.get();
    if (death_error == A_Err_NONE) {
      // From this point onward AE's DeathHook owns the state. Any later exception
      // must leave the registered hook refcons alive rather than deleting them.
      lifecycle_state = state.release();
    }
    const A_Err idle_error = death_error == A_Err_NONE
        ? register_suite->AEGP_RegisterIdleHook(
            plugin_id, idle_hook, reinterpret_cast<AEGP_IdleRefcon>(lifecycle_state))
        : death_error;

    A_Err menu_error = A_Err_GENERIC;
    const AEGP_CommandSuite1* command_suite = nullptr;
    const SPErr command_acquire_error = idle_error == A_Err_NONE
        ? pica_basic->AcquireSuite(
            kAEGPCommandSuite,
            kAEGPCommandSuiteVersion1,
            reinterpret_cast<const void**>(&command_suite))
        : A_Err_GENERIC;
    if (command_acquire_error == 0 && command_suite != nullptr) {
      menu_error = command_suite->AEGP_GetUniqueCommand(
          &lifecycle_state->pairing_command);
      if (menu_error == A_Err_NONE) {
        menu_error = command_suite->AEGP_InsertMenuCommand(
            lifecycle_state->pairing_command,
            "AE MCP: Pair native connection...",
            AEGP_Menu_WINDOW,
            AEGP_MENU_INSERT_SORTED);
      }
      if (menu_error == A_Err_NONE) {
        menu_error = register_suite->AEGP_RegisterCommandHook(
            plugin_id,
            AEGP_HP_BeforeAE,
            AEGP_Command_ALL,
            command_hook,
            0);
      }
      if (menu_error == A_Err_NONE) {
        menu_error = register_suite->AEGP_RegisterUpdateMenuHook(
            plugin_id, update_menu_hook, 0);
      }
      const SPErr command_release_error = pica_basic->ReleaseSuite(
          kAEGPCommandSuite, kAEGPCommandSuiteVersion1);
      if (command_release_error != 0 && menu_error == A_Err_NONE) {
        menu_error = A_Err_GENERIC;
      }
    }
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
      if (menu_error != A_Err_NONE) {
        lifecycle_state->log.append(
            event_prefix(*lifecycle_state, "pairing.menu-unavailable") + "}");
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
