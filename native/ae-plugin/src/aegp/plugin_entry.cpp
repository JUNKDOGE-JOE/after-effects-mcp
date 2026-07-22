#include "aemcp_native/effect_stack.hpp"
#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/endpoint_registry_macos.hpp"
#include "aemcp_native/mac_ipc_server.hpp"
#include "aemcp_native/native_rpc_connection.hpp"
#include "aemcp_native/pairing_gate.hpp"
#include "aemcp_native/pairing_ui_macos.hpp"
#include "aemcp_native/peer_identity_macos.hpp"
#include "aemcp_native/project_epoch.hpp"
#include "aemcp_native/rpc_codec.hpp"
#include "aemcp_native/selection_collection.hpp"
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
using aemcp::native::BoundedPageBudget;
using aemcp::native::Completion;
using aemcp::native::DrainBatch;
using aemcp::native::HostApi;
using aemcp::native::HostBitDepthReadResult;
using aemcp::native::HostBitDepthWriteResult;
using aemcp::native::HostCompositionLayersResult;
using aemcp::native::HostCompositionTimeResult;
using aemcp::native::HostCompositionTimeWriteResult;
using aemcp::native::HostCompositionCreateResult;
using aemcp::native::HostCompositionLayerCreateResult;
using aemcp::native::HostLayerEffectApplyResult;
using aemcp::native::HostDispatcher;
using aemcp::native::HostReadResult;
using aemcp::native::HostProjectItemsResult;
using aemcp::native::HostProjectContextResult;
using aemcp::native::HostProjectItemMetadataResult;
using aemcp::native::HostCompositionSettingsResult;
using aemcp::native::HostCompositionWorkAreaWriteResult;
using aemcp::native::HostProjectItemTextWriteResult;
using aemcp::native::HostProjectItemLabelWriteResult;
using aemcp::native::HostCompositionDuplicateResult;
using aemcp::native::HostProjectGraphInvalidationResult;
using aemcp::native::HostLayerPropertiesResult;
using aemcp::native::HostLayerPropertyKeyframesResult;
using aemcp::native::HostLayerPropertyWriteResult;
using aemcp::native::HostLayerPropertyKeyframeDetailsResult;
using aemcp::native::HostLayerPropertyKeyframeWriteResult;
using aemcp::native::HostLayerDetailsResult;
using aemcp::native::HostLayerNameWriteResult;
using aemcp::native::HostLayerRangeWriteResult;
using aemcp::native::HostLayerStartTimeWriteResult;
using aemcp::native::HostLayerStretchWriteResult;
using aemcp::native::HostLayerOrderWriteResult;
using aemcp::native::HostLayerParentWriteResult;
using aemcp::native::HostLayerDuplicateResult;
using aemcp::native::HostLayerCompositingReadResult;
using aemcp::native::HostLayerSwitchWriteResult;
using aemcp::native::HostLayerQualityWriteResult;
using aemcp::native::HostLayerBlendingModeWriteResult;
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
using aemcp::native::ProjectContext;
using aemcp::native::ProjectItemEntry;
using aemcp::native::ProjectItemMetadata;
using aemcp::native::CompositionCurrentTime;
using aemcp::native::CompositionPositiveRatio;
using aemcp::native::CompositionSettings;
using aemcp::native::CompositionWorkAreaChanged;
using aemcp::native::CompositionDuplicated;
using aemcp::native::LayerDetails;
using aemcp::native::LayerDuplicated;
using aemcp::native::LayerNameChanged;
using aemcp::native::LayerOrderChanged;
using aemcp::native::LayerParentChanged;
using aemcp::native::LayerRangeChanged;
using aemcp::native::LayerStartTimeChanged;
using aemcp::native::LayerStretchChanged;
using aemcp::native::LayerCompositingState;
using aemcp::native::LayerPropertyKeyframeDetails;
using aemcp::native::LayerPropertyKeyframeChanged;
using aemcp::native::LayerPropertySampleTime;
using aemcp::native::ObjectLocator;
using aemcp::native::Request;
using aemcp::native::SystemClock;
using aemcp::native::TimePoint;
using aemcp::native::kProjectBitDepthReadCapability;
using aemcp::native::kProjectBitDepthSetCapability;
using aemcp::native::kProjectSummaryCapability;
using aemcp::native::kCompositionLayersListCapability;
using aemcp::native::kCompositionSelectedLayersListCapability;
using aemcp::native::kCompositionTimeReadCapability;
using aemcp::native::kCompositionTimeSetCapability;
using aemcp::native::kCompositionCreateCapability;
using aemcp::native::kCompositionLayerCreateCapability;
using aemcp::native::kLayerEffectApplyCapability;
using aemcp::native::kProjectItemsListCapability;
using aemcp::native::kLayerPropertiesListCapability;
using aemcp::native::kLayerPropertyKeyframesListCapability;
using aemcp::native::kLayerPropertySetCapability;
using aemcp::native::kProjectContextReadCapability;
using aemcp::native::kProjectItemMetadataReadCapability;
using aemcp::native::kCompositionSettingsReadCapability;
using aemcp::native::kCompositionWorkAreaSetCapability;
using aemcp::native::kProjectItemNameSetCapability;
using aemcp::native::kProjectItemCommentSetCapability;
using aemcp::native::kProjectItemLabelSetCapability;
using aemcp::native::kCompositionDuplicateCapability;
using aemcp::native::kLayerDetailsReadCapability;
using aemcp::native::kLayerNameSetCapability;
using aemcp::native::kLayerRangeSetCapability;
using aemcp::native::kLayerStartTimeSetCapability;
using aemcp::native::kLayerStretchSetCapability;
using aemcp::native::kLayerOrderSetCapability;
using aemcp::native::kLayerParentSetCapability;
using aemcp::native::kLayerDuplicateCapability;
using aemcp::native::kLayerCompositingReadCapability;
using aemcp::native::kLayerSwitchSetCapability;
using aemcp::native::kLayerQualitySetCapability;
using aemcp::native::kLayerBlendingModeSetCapability;
using aemcp::native::kLayerPropertyKeyframeDetailsReadCapability;
using aemcp::native::kLayerPropertyKeyframeAddCapability;
using aemcp::native::kLayerPropertyKeyframeValueSetCapability;
using aemcp::native::kLayerPropertyKeyframeInterpolationSetCapability;
using aemcp::native::kLayerPropertyKeyframeTemporalEaseSetCapability;
using aemcp::native::kLayerPropertyKeyframeBehaviorSetCapability;
using aemcp::native::kLayerPropertyKeyframeDeleteCapability;
using aemcp::native::kProjectGraphInvalidateControl;
using aemcp::native::locate_unique_insertion;

constexpr std::string_view kPluginVersion = AE_MCP_PRODUCT_VERSION;
constexpr std::string_view kSdkVersion = "25.6.61";
constexpr std::uint64_t kSdkBuild = 61;
constexpr std::string_view kSourceCommit = AE_MCP_SOURCE_COMMIT;
constexpr std::string_view kCapabilitiesDigest =
    "7d2598ef2570828a4c1b616cf036b67fd966599aadad1530114e2d655b8646a4";
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
constexpr std::string_view kCompositionSelectedLayersListContractDigest =
    "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75";
constexpr std::string_view kCompositionTimeReadContractDigest =
    "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd";
constexpr std::string_view kCompositionTimeSetContractDigest =
    "724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308";
constexpr std::string_view kCompositionCreateContractDigest =
    "0e65175a0d85640eda3eb58b08d4cabc0aa9f085068225e1b44f9cf01467310d";
constexpr std::string_view kCompositionLayerCreateContractDigest =
    "d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee";
constexpr std::string_view kLayerEffectApplyContractDigest =
    "5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77";
constexpr std::string_view kLayerPropertiesListContractDigest =
    "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba";
constexpr std::string_view kLayerPropertyKeyframesListContractDigest =
    "f089d4cd1d35f492df660cbd83667968b2add70b5353172253691e33758e42bb";
constexpr std::string_view kLayerPropertySetContractDigest =
    "5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c";
constexpr std::string_view kProjectContextReadContractDigest =
    "ee6df463fe36f13a02a09b833b0f13a01ba1c2a5dc335d689c04ea834ad10dca";
constexpr std::string_view kProjectItemMetadataReadContractDigest =
    "b13139c0b2e8073f6606bfbead1e59eb7fea63ec10a164b500e19ff8babd0f69";
constexpr std::string_view kCompositionSettingsReadContractDigest =
    "a7ae9383b4a627bf6f3f42cb929eafa724cf7bc30a172b67ddbcaf9e754f5e9b";
constexpr std::string_view kCompositionWorkAreaSetContractDigest =
    "a4ffd90349164e1d7228e5d2374ef55c9f0dc1065db0dac9945a7f8eeb16b997";
constexpr std::string_view kProjectItemNameSetContractDigest =
    "b26f017991e74f009b15cb24fcfd4bb7f154d4ac506f65f150b29efcccb9f538";
constexpr std::string_view kProjectItemCommentSetContractDigest =
    "957985628474caa9c9cef3de76a2839e59691232b062b776ff800a79dd3cc35c";
constexpr std::string_view kProjectItemLabelSetContractDigest =
    "4463637f6a5298b27afb39cea68c593a93383e4ccc7926bc228d00e0cc3ba94f";
constexpr std::string_view kCompositionDuplicateContractDigest =
    "96e7a14f7e2b983fac41a918657b101f54638d5ae6acee6003757bc6458b3be3";
constexpr std::string_view kLayerDetailsReadContractDigest =
    "b1b7a5f313bbf72eb6b33ac4a0507f9f925ef6873d53fd07d93d861164ac15d9";
constexpr std::string_view kLayerNameSetContractDigest =
    "a68fb7f75f050faf4e77c81c3fa9f53ad501016af0eeb065493716ff94fd5929";
constexpr std::string_view kLayerRangeSetContractDigest =
    "0b90618916f0df612726017ef80795b72829f367cbf46cad23b33beb129230e2";
constexpr std::string_view kLayerStartTimeSetContractDigest =
    "c0c09292b98f5fecfb69a487f2014aed6ce2b67d47f07231beea36d916e07e27";
constexpr std::string_view kLayerStretchSetContractDigest =
    "0545a85e87d8907f94597ba36e3021fd3fa6dfe1262ff0e81eb30551f5e3bbb8";
constexpr std::string_view kLayerOrderSetContractDigest =
    "e977b89201314e2e4ee1b6e7a09efadd06f012b2b97e3087b0d9c4bd8102d162";
constexpr std::string_view kLayerParentSetContractDigest =
    "36414bc469a83ddeadbf9f722e934266b38f26a70352c24f5e4a57800f2bb06c";
constexpr std::string_view kLayerDuplicateContractDigest =
    "334a4371a4ac610f02d5dc1d525526ab54cfb1aea758a31434e1c0b196d76c75";
constexpr std::string_view kLayerCompositingReadContractDigest =
    "407554b3f18f8758a8eb997d2b407e74dcca8edbd394e07cb2168a9548a7d99d";
constexpr std::string_view kLayerSwitchSetContractDigest =
    "505c9f16f34ded8d154e844e3078fe214cff6e5ebd83e42fc454f5b69a830d77";
constexpr std::string_view kLayerQualitySetContractDigest =
    "ca09062a5ed2a07fd8277eaef9bbc030f752b4da7baf4448896f1d6daad2c465";
constexpr std::string_view kLayerBlendingModeSetContractDigest =
    "098113d1426d0124a678ac659fabe1d2a52610f1a6f78075e4389cc04ebfdbcf";
constexpr std::string_view kLayerPropertyKeyframeDetailsReadContractDigest =
    "254ec7933e9628b6c4fba4cc60e183331e4edc9f723c0ccb3f1e37619b7c5249";
constexpr std::string_view kLayerPropertyKeyframeAddContractDigest =
    "9eab679678002ba67260c70dcd46c3f93f0ed2dfbc8c272a17ec57c37451c68e";
constexpr std::string_view kLayerPropertyKeyframeValueSetContractDigest =
    "9eab679678002ba67260c70dcd46c3f93f0ed2dfbc8c272a17ec57c37451c68e";
constexpr std::string_view kLayerPropertyKeyframeInterpolationSetContractDigest =
    "42e8e12224bd1653fa8ca9f775c97553d61c0c2e60b3b2dcf76a8fc68deb2a20";
constexpr std::string_view kLayerPropertyKeyframeTemporalEaseSetContractDigest =
    "a73d70029c9a470b57d20fe54517cb36bb7fe249847c49da294f1db2d1c4bc8f";
constexpr std::string_view kLayerPropertyKeyframeBehaviorSetContractDigest =
    "e2ff59d765613db12468d2140d8c937fd1ceb5def9f632877b18b664b6d6bf5c";
constexpr std::string_view kLayerPropertyKeyframeDeleteContractDigest =
    "a84e5b0971c54eb238ff96652340a7f1b34ebfea56e8238ac73edd11f551fdf9";
constexpr std::int64_t kMaximumProjectItems = 100000;
constexpr A_long kMaximumLayerEffects = 4096;
static_assert(kSourceCommit.size() == 40);

constexpr bool exact_nonnegative_fraction_leq(
    std::uint64_t left_numerator,
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
      if (left_numerator == right_numerator) return true;
      return reversed ? left_numerator != 0 : left_numerator == 0;
    }
    std::swap(left_numerator, left_denominator);
    std::swap(right_numerator, right_denominator);
    reversed = !reversed;
  }
}

constexpr bool exact_nonnegative_time_sum_leq(
    std::int32_t left_value,
    std::uint32_t left_scale,
    std::int32_t right_value,
    std::uint32_t right_scale,
    std::int32_t limit_value,
    std::uint32_t limit_scale) {
  if (left_value < 0 || right_value < 0 || limit_value < 0
      || left_scale == 0 || right_scale == 0 || limit_scale == 0) {
    return false;
  }
  const std::uint64_t common = std::gcd(left_scale, right_scale);
  const std::uint64_t left_factor = right_scale / common;
  const std::uint64_t right_factor = left_scale / common;
  const std::uint64_t numerator =
      static_cast<std::uint64_t>(left_value) * left_factor
      + static_cast<std::uint64_t>(right_value) * right_factor;
  const std::uint64_t denominator =
      static_cast<std::uint64_t>(left_scale) * left_factor;
  return exact_nonnegative_fraction_leq(
      numerator, denominator,
      static_cast<std::uint64_t>(limit_value), limit_scale);
}

static_assert(exact_nonnegative_time_sum_leq(
    2147483646, 4294967295U, 1, 4294967295U,
    2147483647, 4294967295U));
static_assert(!exact_nonnegative_time_sum_leq(
    2147483646, 4294967295U, 2, 4294967295U,
    2147483647, 4294967295U));

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

[[nodiscard]] std::optional<std::vector<A_UTF16Char>> utf16_bounded_text(
    std::string_view input, std::size_t maximum_scalars, bool allow_empty) {
  if ((!allow_empty && input.empty()) || maximum_scalars == 0
      || maximum_scalars > 1024 || input.size() > maximum_scalars * 4) {
    return std::nullopt;
  }
  std::vector<A_UTF16Char> output;
  output.reserve(input.size() + 1);
  std::size_t scalars = 0;
  for (std::size_t index = 0; index < input.size();) {
    const std::uint8_t first = static_cast<std::uint8_t>(input[index++]);
    std::uint32_t scalar = 0;
    std::size_t trailing = 0;
    if (first <= 0x7fU) {
      scalar = first;
    } else if (first >= 0xc2U && first <= 0xdfU) {
      scalar = first & 0x1fU;
      trailing = 1;
    } else if (first >= 0xe0U && first <= 0xefU) {
      scalar = first & 0x0fU;
      trailing = 2;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      scalar = first & 0x07U;
      trailing = 3;
    } else {
      return std::nullopt;
    }
    if (index + trailing > input.size()) return std::nullopt;
    for (std::size_t offset = 0; offset < trailing; ++offset) {
      const std::uint8_t byte = static_cast<std::uint8_t>(input[index++]);
      if ((byte & 0xc0U) != 0x80U) return std::nullopt;
      scalar = (scalar << 6U) | (byte & 0x3fU);
    }
    if ((trailing == 2 && scalar < 0x800U)
        || (trailing == 3 && scalar < 0x10000U)
        || scalar == 0 || scalar > 0x10ffffU
        || (scalar >= 0xd800U && scalar <= 0xdfffU)
        || ++scalars > maximum_scalars) {
      return std::nullopt;
    }
    if (scalar <= 0xffffU) {
      output.push_back(static_cast<A_UTF16Char>(scalar));
    } else {
      scalar -= 0x10000U;
      output.push_back(static_cast<A_UTF16Char>(0xd800U + (scalar >> 10U)));
      output.push_back(static_cast<A_UTF16Char>(0xdc00U + (scalar & 0x3ffU)));
    }
  }
  output.push_back(0);
  return output;
}

[[nodiscard]] std::optional<std::vector<A_UTF16Char>> utf16_layer_name(
    std::string_view input) {
  return utf16_bounded_text(input, 255, false);
}

[[nodiscard]] std::optional<std::uint64_t> count_project_items(
    const AEGP_ItemSuite9* item_suite,
    AEGP_ProjectH project,
    AEGP_ItemH root) {
  AEGP_ItemH item = nullptr;
  if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
    return std::nullopt;
  }
  std::uint64_t count = 0;
  while (item != nullptr) {
    if (++count > static_cast<std::uint64_t>(kMaximumProjectItems)) {
      return std::nullopt;
    }
    AEGP_ItemH next = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
      return std::nullopt;
    }
    item = next;
  }
  return count;
}

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

class EffectRefOwner final {
 public:
  EffectRefOwner(const AEGP_EffectSuite5* suite, AEGP_EffectRefH effect)
      : suite_(suite), effect_(effect) {}
  ~EffectRefOwner() {
    if (suite_ != nullptr && effect_ != nullptr) {
      (void)suite_->AEGP_DisposeEffect(effect_);
    }
  }
  EffectRefOwner(const EffectRefOwner&) = delete;
  EffectRefOwner& operator=(const EffectRefOwner&) = delete;
  [[nodiscard]] AEGP_EffectRefH get() const noexcept { return effect_; }

 private:
  const AEGP_EffectSuite5* suite_{nullptr};
  AEGP_EffectRefH effect_{nullptr};
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
  [[nodiscard]] AEGP_StreamValue2& mutable_value() noexcept { return value_; }
  [[nodiscard]] const AEGP_StreamValue2* borrow() const noexcept {
    return initialized_ ? &value_ : nullptr;
  }

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

  [[nodiscard]] bool invalidate_project() {
    if (!epoch_.present()) return false;

    // Prepare every potentially-throwing value before advancing the epoch so
    // callers never observe a new generation with the old locator registry.
    std::string next_project_id = aemcp::native::secure_uuid_v4();
    std::string next_project_object_id = aemcp::native::secure_uuid_v4();
    if (!epoch_.invalidate()) return false;
    project_id_ = std::move(next_project_id);
    project_object_id_ = std::move(next_project_object_id);
    clear_objects();
    return true;
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
      std::string_view session,
      std::string_view preserved_object_id = {}) {
    const std::string key = std::to_string(composition_item_id) + ":"
        + std::to_string(static_cast<A_long>(layer_id));
    auto found = layer_object_ids_.find(key);
    if (found == layer_object_ids_.end()) {
      const std::string object_id = preserved_object_id.empty()
          ? aemcp::native::secure_uuid_v4()
          : std::string(preserved_object_id);
      if (layers_by_object_.contains(object_id)) {
        throw std::runtime_error("layer locator object identity is already bound");
      }
      found = layer_object_ids_.emplace(key, object_id).first;
      layers_by_object_.emplace(
          found->second, LayerAddress{composition_item_id, layer_id});
    } else if (!preserved_object_id.empty()
        && found->second != preserved_object_id) {
      throw std::runtime_error("layer locator object identity does not match");
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

  [[nodiscard]] std::optional<StreamAddress> resolve_stream(
      const ObjectLocator& locator,
      std::string_view host,
      std::string_view session) const {
    if (locator.kind != "stream" || locator.host_instance_id != host
        || locator.session_id != session || locator.project_id != project_id_
        || locator.generation != epoch_.generation()) {
      return std::nullopt;
    }
    const auto found = stream_addresses_.find(locator.object_id);
    return found == stream_addresses_.end()
        ? std::nullopt : std::optional<StreamAddress>(found->second);
  }

  [[nodiscard]] std::optional<LayerAddress> resolve_layer_object(
      std::string_view object_id) const {
    const auto found = layers_by_object_.find(std::string(object_id));
    return found == layers_by_object_.end()
        ? std::nullopt : std::optional<LayerAddress>(found->second);
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

  [[nodiscard]] std::uint64_t generation() const noexcept {
    return epoch_.generation();
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

  [[nodiscard]] std::optional<A_long> resolve_project_item(
      const ObjectLocator& locator,
      std::string_view host,
      std::string_view session) const {
    if ((locator.kind != "item" && locator.kind != "composition")
        || locator.host_instance_id != host || locator.session_id != session
        || locator.project_id != project_id_
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

[[nodiscard]] bool decimal_values_equal(
    std::string_view left, std::string_view right) {
  const auto left_value = decimal_value(left);
  const auto right_value = decimal_value(right);
  return left_value.has_value() && right_value.has_value()
      && *left_value == *right_value;
}

[[nodiscard]] bool layer_property_values_equal(
    const aemcp::native::LayerPropertyValue& left,
    const aemcp::native::LayerPropertyValue& right) {
  if (left.index() != right.index()) return false;
  if (const auto* scalar =
          std::get_if<aemcp::native::LayerPropertyScalarValue>(&left)) {
    return decimal_values_equal(
        scalar->value,
        std::get<aemcp::native::LayerPropertyScalarValue>(right).value);
  }
  if (const auto* vector =
          std::get_if<aemcp::native::LayerPropertyVectorValue>(&left)) {
    const auto& other =
        std::get<aemcp::native::LayerPropertyVectorValue>(right).components;
    if (vector->components.size() != other.size()) return false;
    for (std::size_t index = 0; index < other.size(); ++index) {
      if (!decimal_values_equal(vector->components[index], other[index])) return false;
    }
    return true;
  }
  if (const auto* color =
          std::get_if<aemcp::native::LayerPropertyColorValue>(&left)) {
    const auto& other = std::get<aemcp::native::LayerPropertyColorValue>(right);
    return decimal_values_equal(color->alpha, other.alpha)
        && decimal_values_equal(color->red, other.red)
        && decimal_values_equal(color->green, other.green)
        && decimal_values_equal(color->blue, other.blue);
  }
  return std::holds_alternative<std::monostate>(left);
}

[[nodiscard]] bool keyframe_ease_equal(
    const aemcp::native::LayerPropertyKeyframeEase& left,
    const aemcp::native::LayerPropertyKeyframeEase& right) {
  const auto left_speed = decimal_value(left.speed);
  const auto right_speed = decimal_value(right.speed);
  const auto left_influence = decimal_value(left.influence);
  const auto right_influence = decimal_value(right.influence);
  const auto close = [](A_FpLong first, A_FpLong second) {
    return std::abs(first - second)
        <= std::max({1.0, std::abs(first), std::abs(second)}) * 1e-9;
  };
  return left_speed.has_value() && right_speed.has_value()
      && left_influence.has_value() && right_influence.has_value()
      && close(*left_speed, *right_speed)
      && close(*left_influence, *right_influence);
}

[[nodiscard]] bool keyframe_dimension_ease_equal(
    const aemcp::native::LayerPropertyKeyframeDimensionEase& left,
    const aemcp::native::LayerPropertyKeyframeDimensionEase& right) {
  return left.dimension == right.dimension
      && keyframe_ease_equal(left.in_ease, right.in_ease)
      && keyframe_ease_equal(left.out_ease, right.out_ease);
}

[[nodiscard]] std::optional<aemcp::native::LayerPropertyValue> primitive_stream_value(
    AEGP_StreamType type, const AEGP_StreamValue2& sampled) {
  if (type == AEGP_StreamType_OneD) {
    const auto value = decimal_string(sampled.val.one_d);
    if (value.has_value()) {
      return aemcp::native::LayerPropertyScalarValue{*value};
    }
  } else if (type == AEGP_StreamType_TwoD
      || type == AEGP_StreamType_TwoD_SPATIAL) {
    const auto x = decimal_string(sampled.val.two_d.x);
    const auto y = decimal_string(sampled.val.two_d.y);
    if (x.has_value() && y.has_value()) {
      return aemcp::native::LayerPropertyVectorValue{{*x, *y}};
    }
  } else if (type == AEGP_StreamType_ThreeD
      || type == AEGP_StreamType_ThreeD_SPATIAL) {
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
    if (alpha.has_value() && red.has_value() && green.has_value() && blue.has_value()) {
      return aemcp::native::LayerPropertyColorValue{*alpha, *red, *green, *blue};
    }
  }
  return std::nullopt;
}

[[nodiscard]] bool assign_primitive_stream_value(
    AEGP_StreamType type,
    const aemcp::native::LayerPropertyValue& requested,
    AEGP_StreamValue2& output) {
  if (type == AEGP_StreamType_OneD) {
    const auto* scalar = std::get_if<aemcp::native::LayerPropertyScalarValue>(&requested);
    const auto value = scalar == nullptr ? std::nullopt : decimal_value(scalar->value);
    if (!value.has_value()) return false;
    output.val.one_d = *value;
    return true;
  }
  if (type == AEGP_StreamType_TwoD || type == AEGP_StreamType_TwoD_SPATIAL) {
    const auto* vector = std::get_if<aemcp::native::LayerPropertyVectorValue>(&requested);
    if (vector == nullptr || vector->components.size() != 2) return false;
    const auto x = decimal_value(vector->components[0]);
    const auto y = decimal_value(vector->components[1]);
    if (!x.has_value() || !y.has_value()) return false;
    output.val.two_d = {*x, *y};
    return true;
  }
  if (type == AEGP_StreamType_ThreeD || type == AEGP_StreamType_ThreeD_SPATIAL) {
    const auto* vector = std::get_if<aemcp::native::LayerPropertyVectorValue>(&requested);
    if (vector == nullptr || vector->components.size() != 3) return false;
    const auto x = decimal_value(vector->components[0]);
    const auto y = decimal_value(vector->components[1]);
    const auto z = decimal_value(vector->components[2]);
    if (!x.has_value() || !y.has_value() || !z.has_value()) return false;
    output.val.three_d = {*x, *y, *z};
    return true;
  }
  if (type == AEGP_StreamType_COLOR) {
    const auto* color = std::get_if<aemcp::native::LayerPropertyColorValue>(&requested);
    if (color == nullptr) return false;
    const auto alpha = decimal_value(color->alpha);
    const auto red = decimal_value(color->red);
    const auto green = decimal_value(color->green);
    const auto blue = decimal_value(color->blue);
    if (!alpha.has_value() || !red.has_value() || !green.has_value() || !blue.has_value()) {
      return false;
    }
    output.val.color = {*alpha, *red, *green, *blue};
    return true;
  }
  return false;
}

[[nodiscard]] bool primitive_stream_values_equal(
    AEGP_StreamType type,
    const AEGP_StreamValue2& left,
    const AEGP_StreamValue2& right) {
  if (type == AEGP_StreamType_OneD) return left.val.one_d == right.val.one_d;
  if (type == AEGP_StreamType_TwoD || type == AEGP_StreamType_TwoD_SPATIAL) {
    return left.val.two_d.x == right.val.two_d.x
        && left.val.two_d.y == right.val.two_d.y;
  }
  if (type == AEGP_StreamType_ThreeD || type == AEGP_StreamType_ThreeD_SPATIAL) {
    return left.val.three_d.x == right.val.three_d.x
        && left.val.three_d.y == right.val.three_d.y
        && left.val.three_d.z == right.val.three_d.z;
  }
  if (type == AEGP_StreamType_COLOR) {
    return left.val.color.alphaF == right.val.color.alphaF
        && left.val.color.redF == right.val.color.redF
        && left.val.color.greenF == right.val.color.greenF
        && left.val.color.blueF == right.val.color.blueF;
  }
  return false;
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

[[nodiscard]] std::optional<std::string> keyframe_interpolation_name(
    AEGP_KeyframeInterpolationType type) {
  switch (type) {
    case AEGP_KeyInterp_NONE: return "none";
    case AEGP_KeyInterp_LINEAR: return "linear";
    case AEGP_KeyInterp_BEZIER: return "bezier";
    case AEGP_KeyInterp_HOLD: return "hold";
    default: return std::nullopt;
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

[[nodiscard]] std::size_t layer_property_keyframe_json_size(
    const aemcp::native::LayerPropertyKeyframeEntry& keyframe) {
  std::size_t value_size = 64U;
  if (const auto* scalar =
          std::get_if<aemcp::native::LayerPropertyScalarValue>(&keyframe.value)) {
    value_size += aemcp::native::json_encoded_string_size(scalar->value);
  } else if (const auto* vector =
                 std::get_if<aemcp::native::LayerPropertyVectorValue>(&keyframe.value)) {
    for (const std::string& component : vector->components) {
      value_size += aemcp::native::json_encoded_string_size(component) + 1U;
    }
  } else if (const auto* color =
                 std::get_if<aemcp::native::LayerPropertyColorValue>(&keyframe.value)) {
    value_size += aemcp::native::json_encoded_string_size(color->alpha)
        + aemcp::native::json_encoded_string_size(color->red)
        + aemcp::native::json_encoded_string_size(color->green)
        + aemcp::native::json_encoded_string_size(color->blue);
  }
  return 320U + value_size
      + aemcp::native::json_encoded_string_size(keyframe.in_interpolation)
      + aemcp::native::json_encoded_string_size(keyframe.out_interpolation);
}

class AegpHostApi final : public HostApi {
 public:
  AegpHostApi(
      SPBasicSuite* basic, AEGP_PluginID plugin_id, ProjectGraphRegistry& graph)
      : basic_(basic), plugin_id_(plugin_id), graph_(graph) {}

  [[nodiscard]] HostProjectGraphInvalidationResult invalidate_project_graph(
      TimePoint work_deadline) override {
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
          "NATIVE_UNAVAILABLE", "could not invalidate the native project graph");
    }
  }

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

  [[nodiscard]] HostProjectContextResult read_project_context(
      const aemcp::native::ProjectContextQuery& query,
      TimePoint work_deadline) override {
    const auto expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostProjectContextResult::failure(
          "NATIVE_UNSUPPORTED", "required project context suites are unavailable");
    }
    if (expired()) {
      return HostProjectContextResult::failure(
          "DEADLINE_EXCEEDED", "project context budget elapsed");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    if (!open.has_value()) {
      return HostProjectContextResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }
    ProjectContext context;
    context.project_locator = graph_.project_locator(
        query.host_instance_id, query.session_id);
    context.selection_offset = query.selection_offset;
    context.selection_limit = query.selection_limit;

    AEGP_ItemH active = nullptr;
    if (item_suite->AEGP_GetActiveItem(&active) != A_Err_NONE) {
      return HostProjectContextResult::failure(
          "CAPABILITY_FAILED", "could not read the active Project-panel item");
    }
    if (active != nullptr) {
      context.active_item = project_item_entry(
          item_suite.get(), memory_suite.get(), active, open->root,
          query.host_instance_id, query.session_id);
      if (!context.active_item.has_value()) {
        return HostProjectContextResult::failure(
            "CAPABILITY_FAILED", "could not describe the active Project-panel item");
      }
    }

    AEGP_CompH recent_comp = nullptr;
    if (comp_suite->AEGP_GetMostRecentlyUsedComp(&recent_comp) != A_Err_NONE) {
      return HostProjectContextResult::failure(
          "CAPABILITY_FAILED", "could not read the most recently used composition");
    }
    if (recent_comp != nullptr) {
      AEGP_ItemH recent_item = nullptr;
      if (comp_suite->AEGP_GetItemFromComp(recent_comp, &recent_item) != A_Err_NONE
          || recent_item == nullptr) {
        return HostProjectContextResult::failure(
            "CAPABILITY_FAILED", "could not resolve the most recently used composition item");
      }
      context.most_recently_used_composition = project_item_entry(
          item_suite.get(), memory_suite.get(), recent_item, open->root,
          query.host_instance_id, query.session_id);
      if (!context.most_recently_used_composition.has_value()
          || context.most_recently_used_composition->type != "composition") {
        return HostProjectContextResult::failure(
            "CAPABILITY_FAILED", "most recently used composition identity was inconsistent");
      }
    }

    BoundedPageBudget page_budget(1536U + locator_json_size(context.project_locator));
    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(
            open->project, open->root, &item) != A_Err_NONE) {
      return HostProjectContextResult::failure(
          "CAPABILITY_FAILED", "could not begin selected project item traversal");
    }
    std::uint64_t selected_position = 0;
    std::size_t visited = 0;
    bool response_budget_exhausted = false;
    while (item != nullptr) {
      if (expired()) {
        return HostProjectContextResult::failure(
            "DEADLINE_EXCEEDED", "selected project item traversal budget elapsed");
      }
      if (++visited > static_cast<std::size_t>(kMaximumProjectItems)) {
        return HostProjectContextResult::failure(
            "CAPABILITY_FAILED", "project item bound exceeded");
      }
      A_Boolean selected = FALSE;
      if (item_suite->AEGP_IsItemSelected(item, &selected) != A_Err_NONE) {
        return HostProjectContextResult::failure(
            "CAPABILITY_FAILED", "could not read Project-panel selection state");
      }
      if (selected != FALSE) {
        if (selected_position >= query.selection_offset
            && context.selected_items.size() < query.selection_limit
            && !response_budget_exhausted) {
          auto entry = project_item_entry(
              item_suite.get(), memory_suite.get(), item, open->root,
              query.host_instance_id, query.session_id);
          if (!entry.has_value()) {
            return HostProjectContextResult::failure(
                "CAPABILITY_FAILED", "could not describe a selected project item");
          }
          const std::size_t entry_bytes = project_item_json_size(*entry)
              + (context.selected_items.empty() ? 0U : 1U);
          if (!page_budget.try_reserve(entry_bytes)) {
            if (context.selected_items.empty()) {
              return HostProjectContextResult::failure(
                  "CAPABILITY_FAILED",
                  "one selected project item exceeds the bounded response budget");
            }
            response_budget_exhausted = true;
          } else {
            context.selected_items.push_back(std::move(*entry));
          }
        }
        ++selected_position;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(
              open->project, item, &next) != A_Err_NONE) {
        return HostProjectContextResult::failure(
            "CAPABILITY_FAILED", "selected project item traversal failed");
      }
      item = next;
    }
    context.selection_total = selected_position;
    if (query.selection_offset > context.selection_total) {
      return HostProjectContextResult::failure(
          "INVALID_ARGUMENT", "selectionOffset exceeds the current selection total",
          "params.arguments.selectionOffset");
    }
    context.selection_has_more = query.selection_offset
        + context.selected_items.size() < context.selection_total;
    if (context.selection_has_more) {
      context.selection_next_offset = query.selection_offset
          + context.selected_items.size();
    }
    return HostProjectContextResult::success(std::move(context));
  }

  [[nodiscard]] HostProjectItemMetadataResult read_project_item_metadata(
      const aemcp::native::ProjectItemQuery& query,
      TimePoint work_deadline) override {
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
      return HostProjectItemMetadataResult::failure(
          "NATIVE_UNSUPPORTED", "required project item metadata suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_project_item(
        query.item_locator, query.host_instance_id, query.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostProjectItemMetadataResult::failure(
          "STALE_LOCATOR", "itemLocator does not identify an item in the open project",
          "params.arguments.itemLocator");
    }
    const auto item = find_project_item(
        item_suite.get(), open->project, open->root, *item_id, work_deadline);
    if (!item.has_value()) {
      return HostProjectItemMetadataResult::failure(
          "STALE_LOCATOR", "project item identity could not be reacquired",
          "params.arguments.itemLocator");
    }
    AEGP_ItemType sdk_type = AEGP_ItemType_NONE;
    AEGP_ItemH parent = nullptr;
    AEGP_LabelID sdk_label = 0;
    const auto name = read_item_name(item_suite.get(), memory_suite.get(), *item);
    const auto comment = read_item_comment(item_suite.get(), memory_suite.get(), *item);
    if (item_suite->AEGP_GetItemType(*item, &sdk_type) != A_Err_NONE
        || item_suite->AEGP_GetItemParentFolder(*item, &parent) != A_Err_NONE
        || item_suite->AEGP_GetItemLabel(*item, &sdk_label) != A_Err_NONE
        || !name.has_value() || !comment.has_value()) {
      return HostProjectItemMetadataResult::failure(
          "CAPABILITY_FAILED", "could not read project item metadata");
    }
    const auto unsigned_label = static_cast<unsigned char>(sdk_label);
    if (unsigned_label > 16) {
      return HostProjectItemMetadataResult::failure(
          "CAPABILITY_FAILED", "project item returned an unsupported label slot");
    }
    ProjectItemMetadata metadata;
    metadata.item_locator = query.item_locator;
    metadata.name = *name;
    metadata.type = project_item_type(sdk_type);
    metadata.comment = *comment;
    metadata.label_id = static_cast<std::uint8_t>(unsigned_label);
    if (parent == nullptr || parent == open->root) {
      metadata.parent_locator = graph_.project_locator(
          query.host_instance_id, query.session_id);
    } else {
      A_long parent_id = 0;
      if (item_suite->AEGP_GetItemID(parent, &parent_id) != A_Err_NONE) {
        return HostProjectItemMetadataResult::failure(
            "CAPABILITY_FAILED", "could not read project item parent identity");
      }
      metadata.parent_locator = graph_.item_locator(
          parent_id, false, query.host_instance_id, query.session_id);
    }
    if (sdk_type == AEGP_ItemType_COMP || sdk_type == AEGP_ItemType_FOOTAGE
        || sdk_type == AEGP_ItemType_SOLID_defunct) {
      A_long width = 0;
      A_long height = 0;
      A_Time duration{};
      A_Ratio pixel_aspect{};
      const A_Err dimensions_error = item_suite->AEGP_GetItemDimensions(
          *item, &width, &height);
      const A_Err duration_error = item_suite->AEGP_GetItemDuration(*item, &duration);
      const A_Err aspect_error = item_suite->AEGP_GetItemPixelAspectRatio(
          *item, &pixel_aspect);
      if (sdk_type == AEGP_ItemType_COMP
          && (dimensions_error != A_Err_NONE || duration_error != A_Err_NONE
            || aspect_error != A_Err_NONE || width < 1 || width > 30000
            || height < 1 || height > 30000 || duration.scale <= 0
            || duration.value <= 0 || pixel_aspect.num <= 0
            || pixel_aspect.den <= 0)) {
        return HostProjectItemMetadataResult::failure(
            "CAPABILITY_FAILED", "could not read bounded project item facts");
      }
      if (dimensions_error == A_Err_NONE && width >= 1 && width <= 30000) {
        metadata.width = static_cast<std::uint32_t>(width);
      }
      if (dimensions_error == A_Err_NONE && height >= 1 && height <= 30000) {
        metadata.height = static_cast<std::uint32_t>(height);
      }
      if (duration_error == A_Err_NONE && duration.scale > 0
          && duration.value >= 0) {
        metadata.duration = CompositionCurrentTime{
            static_cast<std::int32_t>(duration.value),
            static_cast<std::uint32_t>(duration.scale),
            aemcp::native::canonical_seconds_rational(
                duration.value, duration.scale)};
      }
      if (aspect_error == A_Err_NONE && pixel_aspect.num > 0
          && pixel_aspect.den > 0) {
        metadata.pixel_aspect_ratio = CompositionPositiveRatio{
            static_cast<std::int32_t>(pixel_aspect.num),
            static_cast<std::int32_t>(pixel_aspect.den),
            aemcp::native::canonical_seconds_rational(
                pixel_aspect.num, static_cast<std::uint32_t>(pixel_aspect.den))};
      }
    }
    if (sdk_type == AEGP_ItemType_COMP) {
      AEGP_CompH comp = nullptr;
      A_long layer_count = 0;
      if (comp_suite->AEGP_GetCompFromItem(*item, &comp) != A_Err_NONE
          || comp == nullptr
          || layer_suite->AEGP_GetCompNumLayers(comp, &layer_count) != A_Err_NONE
          || layer_count < 0) {
        return HostProjectItemMetadataResult::failure(
            "CAPABILITY_FAILED", "could not read composition layer count");
      }
      metadata.layer_count = static_cast<std::uint64_t>(layer_count);
    }
    return HostProjectItemMetadataResult::success(std::move(metadata));
  }

  [[nodiscard]] HostCompositionSettingsResult read_composition_settings(
      const aemcp::native::CompositionSettingsQuery& query,
      TimePoint work_deadline) override {
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
      return HostCompositionSettingsResult::failure(
          "NATIVE_UNSUPPORTED", "required composition settings suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_composition(
        query.composition_locator, query.host_instance_id, query.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostCompositionSettingsResult::failure(
          "STALE_LOCATOR", "compositionLocator does not identify an open-project composition",
          "params.arguments.compositionLocator");
    }
    const auto item = find_project_item(
        item_suite.get(), open->project, open->root, *item_id, work_deadline);
    AEGP_CompH comp = nullptr;
    if (!item.has_value()
        || comp_suite->AEGP_GetCompFromItem(*item, &comp) != A_Err_NONE
        || comp == nullptr) {
      return HostCompositionSettingsResult::failure(
          "STALE_LOCATOR", "composition identity could not be reacquired",
          "params.arguments.compositionLocator");
    }
    auto settings = composition_settings(
        item_suite.get(), comp_suite.get(), layer_suite.get(), memory_suite.get(),
        *item, comp, query.composition_locator);
    if (!settings.has_value()) {
      return HostCompositionSettingsResult::failure(
          "CAPABILITY_FAILED", "could not read composition settings");
    }
    return HostCompositionSettingsResult::success(std::move(*settings));
  }

  [[nodiscard]] HostCompositionWorkAreaWriteResult set_composition_work_area(
      const aemcp::native::CompositionWorkAreaSetCommand& command,
      TimePoint work_deadline) override {
    const auto expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || utility_suite.get() == nullptr
        || memory_suite.get() == nullptr) {
      return HostCompositionWorkAreaWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required work-area mutation suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_composition(
        command.composition_locator, command.host_instance_id, command.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostCompositionWorkAreaWriteResult::failure(
          "STALE_LOCATOR", "compositionLocator does not identify the open composition",
          "params.arguments.compositionLocator");
    }
    const auto item = find_project_item(
        item_suite.get(), open->project, open->root, *item_id, work_deadline);
    AEGP_CompH comp = nullptr;
    A_Time comp_duration{};
    A_Time before_start{};
    A_Time before_duration{};
    if (!item.has_value()
        || comp_suite->AEGP_GetCompFromItem(*item, &comp) != A_Err_NONE
        || comp == nullptr
        || item_suite->AEGP_GetItemDuration(*item, &comp_duration) != A_Err_NONE
        || comp_suite->AEGP_GetCompWorkAreaStart(comp, &before_start) != A_Err_NONE
        || comp_suite->AEGP_GetCompWorkAreaDuration(
            comp, &before_duration) != A_Err_NONE
        || comp_duration.scale <= 0 || before_start.scale <= 0
        || before_duration.scale <= 0) {
      return HostCompositionWorkAreaWriteResult::failure(
          "CAPABILITY_FAILED", "could not read work area before mutation");
    }
    if (!exact_nonnegative_time_sum_leq(
            command.start.value, command.start.scale,
            command.duration.value, command.duration.scale,
            static_cast<std::int32_t>(comp_duration.value),
            static_cast<std::uint32_t>(comp_duration.scale))) {
      return HostCompositionWorkAreaWriteResult::failure(
          "INVALID_ARGUMENT", "work area must end within the composition duration",
          "params.arguments.duration");
    }
    const auto to_exact = [](const A_Time& value) {
      return CompositionCurrentTime{
          static_cast<std::int32_t>(value.value),
          static_cast<std::uint32_t>(value.scale),
          aemcp::native::canonical_seconds_rational(value.value, value.scale)};
    };
    const CompositionCurrentTime before_start_value = to_exact(before_start);
    const CompositionCurrentTime before_duration_value = to_exact(before_duration);
    const auto equal_time = [](const CompositionCurrentTime& left,
                               const CompositionCurrentTime& right) {
      return static_cast<std::int64_t>(left.value) * right.scale
          == static_cast<std::int64_t>(right.value) * left.scale;
    };
    if (equal_time(before_start_value, command.start)
        && equal_time(before_duration_value, command.duration)) {
      return HostCompositionWorkAreaWriteResult::failure(
          "INVALID_ARGUMENT", "work area already matches the requested value",
          "params.arguments");
    }
    if (expired()) {
      return HostCompositionWorkAreaWriteResult::failure(
          "DEADLINE_EXCEEDED", "work-area mutation budget elapsed");
    }
    const A_Time target_start{
        static_cast<A_long>(command.start.value),
        static_cast<A_u_long>(command.start.scale)};
    const A_Time target_duration{
        static_cast<A_long>(command.duration.value),
        static_cast<A_u_long>(command.duration.scale)};
    static constexpr char kUndoLabel[] = "ae-mcp: Set composition work area";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostCompositionWorkAreaWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = comp_suite->AEGP_SetCompWorkAreaStartAndDuration(
        comp, &target_start, &target_duration);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    A_Time after_start{};
    A_Time after_duration{};
    const A_Err start_error = comp_suite->AEGP_GetCompWorkAreaStart(
        comp, &after_start);
    const A_Err duration_error = comp_suite->AEGP_GetCompWorkAreaDuration(
        comp, &after_duration);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || start_error != A_Err_NONE || duration_error != A_Err_NONE
        || after_start.scale <= 0 || after_duration.scale <= 0) {
      return HostCompositionWorkAreaWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "work area may have changed but native readback or Undo validation failed");
    }
    CompositionWorkAreaChanged changed;
    changed.composition_locator = command.composition_locator;
    changed.before_start = before_start_value;
    changed.before_duration = before_duration_value;
    changed.after_start = to_exact(after_start);
    changed.after_duration = to_exact(after_duration);
    if (!equal_time(changed.after_start, command.start)
        || !equal_time(changed.after_duration, command.duration)
        || expired()) {
      return HostCompositionWorkAreaWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "work area changed but exact readback did not match the request");
    }
    return HostCompositionWorkAreaWriteResult::success(std::move(changed));
  }

  [[nodiscard]] HostProjectItemTextWriteResult set_project_item_name(
      const aemcp::native::ProjectItemTextSetCommand& command,
      TimePoint work_deadline) override {
    return set_project_item_text(command, work_deadline, true);
  }

  [[nodiscard]] HostProjectItemTextWriteResult set_project_item_comment(
      const aemcp::native::ProjectItemTextSetCommand& command,
      TimePoint work_deadline) override {
    return set_project_item_text(command, work_deadline, false);
  }

  [[nodiscard]] HostProjectItemLabelWriteResult set_project_item_label(
      const aemcp::native::ProjectItemLabelSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostProjectItemLabelWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required item-label mutation suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_project_item(
        command.item_locator, command.host_instance_id, command.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostProjectItemLabelWriteResult::failure(
          "STALE_LOCATOR", "itemLocator does not identify an item in the open project",
          "params.arguments.itemLocator");
    }
    const auto item = find_project_item(
        item_suite.get(), open->project, open->root, *item_id, work_deadline);
    AEGP_LabelID before = 0;
    if (!item.has_value()
        || item_suite->AEGP_GetItemLabel(*item, &before) != A_Err_NONE) {
      return HostProjectItemLabelWriteResult::failure(
          "CAPABILITY_FAILED", "could not read item label before mutation");
    }
    const std::uint8_t before_id = static_cast<std::uint8_t>(
        static_cast<unsigned char>(before));
    if (before_id > 16) {
      return HostProjectItemLabelWriteResult::failure(
          "CAPABILITY_FAILED", "item returned an unsupported label slot");
    }
    if (before_id == command.label_id) {
      return HostProjectItemLabelWriteResult::failure(
          "INVALID_ARGUMENT", "labelId already matches the item label",
          "params.arguments.labelId");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostProjectItemLabelWriteResult::failure(
          "DEADLINE_EXCEEDED", "item label mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Set project item label";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostProjectItemLabelWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = item_suite->AEGP_SetItemLabel(
        *item, static_cast<AEGP_LabelID>(command.label_id));
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    AEGP_LabelID after = 0;
    const A_Err readback_error = item_suite->AEGP_GetItemLabel(*item, &after);
    const std::uint8_t after_id = static_cast<std::uint8_t>(
        static_cast<unsigned char>(after));
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || readback_error != A_Err_NONE || after_id != command.label_id
        || std::chrono::steady_clock::now() >= work_deadline) {
      return HostProjectItemLabelWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "item label may have changed but native readback or Undo validation failed");
    }
    return HostProjectItemLabelWriteResult::success({
        true, command.item_locator, before_id, after_id});
  }

  [[nodiscard]] HostCompositionDuplicateResult duplicate_composition(
      const aemcp::native::CompositionDuplicateCommand& command,
      TimePoint work_deadline) override {
    const auto expired = [work_deadline] {
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
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostCompositionDuplicateResult::failure(
          "NATIVE_UNSUPPORTED", "required composition duplicate suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto source_id = graph_.resolve_composition(
        command.composition_locator, command.host_instance_id, command.session_id);
    if (!open.has_value() || !source_id.has_value()) {
      return HostCompositionDuplicateResult::failure(
          "STALE_LOCATOR", "compositionLocator does not identify the open composition",
          "params.arguments.compositionLocator");
    }
    const auto source_item = find_project_item(
        item_suite.get(), open->project, open->root, *source_id, work_deadline);
    AEGP_CompH source_comp = nullptr;
    if (!source_item.has_value()
        || comp_suite->AEGP_GetCompFromItem(*source_item, &source_comp) != A_Err_NONE
        || source_comp == nullptr) {
      return HostCompositionDuplicateResult::failure(
          "STALE_LOCATOR", "source composition identity could not be reacquired",
          "params.arguments.compositionLocator");
    }
    const auto count_before = count_project_items(
        item_suite.get(), open->project, open->root);
    auto source_before = composition_settings(
        item_suite.get(), comp_suite.get(), layer_suite.get(), memory_suite.get(),
        *source_item, source_comp, command.composition_locator);
    const auto utf16_name = utf16_bounded_text(command.new_name, 255, false);
    if (!count_before.has_value() || !source_before.has_value()
        || !utf16_name.has_value()) {
      return HostCompositionDuplicateResult::failure(
          "CAPABILITY_FAILED", "could not validate composition duplicate inputs");
    }
    if (expired()) {
      return HostCompositionDuplicateResult::failure(
          "DEADLINE_EXCEEDED", "composition duplicate budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Duplicate composition";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostCompositionDuplicateResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    AEGP_CompH new_comp = nullptr;
    const A_Err duplicate_error = comp_suite->AEGP_DuplicateComp(
        source_comp, &new_comp);
    AEGP_ItemH new_item = nullptr;
    A_Err item_error = duplicate_error == A_Err_NONE && new_comp != nullptr
        ? comp_suite->AEGP_GetItemFromComp(new_comp, &new_item) : A_Err_GENERIC;
    const A_Err name_error = item_error == A_Err_NONE && new_item != nullptr
        ? item_suite->AEGP_SetItemName(new_item, utf16_name->data()) : A_Err_GENERIC;
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    if (duplicate_error != A_Err_NONE || new_comp == nullptr
        || item_error != A_Err_NONE || new_item == nullptr
        || name_error != A_Err_NONE || end_error != A_Err_NONE) {
      return HostCompositionDuplicateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition may have duplicated but creation, rename, or Undo close failed");
    }
    A_long new_item_id = 0;
    const auto count_after = count_project_items(
        item_suite.get(), open->project, open->root);
    auto source_after = composition_settings(
        item_suite.get(), comp_suite.get(), layer_suite.get(), memory_suite.get(),
        *source_item, source_comp, command.composition_locator);
    auto new_after = composition_settings(
        item_suite.get(), comp_suite.get(), layer_suite.get(), memory_suite.get(),
        new_item, new_comp, command.composition_locator);
    if (item_suite->AEGP_GetItemID(new_item, &new_item_id) != A_Err_NONE
        || new_item_id <= 0 || !count_after.has_value()
        || *count_after != *count_before + 1 || !source_after.has_value()
        || !new_after.has_value() || new_after->name != command.new_name
        || expired()) {
      return HostCompositionDuplicateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "duplicated composition did not pass native state readback");
    }
    bool invalidated = false;
    try {
      invalidated = graph_.invalidate_project();
    } catch (...) {
      invalidated = false;
    }
    if (!invalidated) {
      return HostCompositionDuplicateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition duplicated but fresh locator generation failed");
    }
    const ObjectLocator fresh_source = graph_.item_locator(
        *source_id, true, command.host_instance_id, command.session_id);
    const ObjectLocator fresh_new = graph_.item_locator(
        new_item_id, true, command.host_instance_id, command.session_id);
    source_after->composition_locator = fresh_source;
    new_after->composition_locator = fresh_new;
    CompositionDuplicated duplicated;
    duplicated.source_composition_locator = fresh_source;
    duplicated.new_composition_locator = fresh_new;
    duplicated.project_item_count_before = *count_before;
    duplicated.project_item_count_after = *count_after;
    duplicated.source_settings = std::move(*source_after);
    duplicated.new_settings = std::move(*new_after);
    return HostCompositionDuplicateResult::success(std::move(duplicated));
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

  [[nodiscard]] HostCompositionLayersResult list_selected_composition_layers(
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
    SuiteLease<AEGP_CollectionSuite2> collection_suite(
        basic_, kAEGPCollectionSuite, kAEGPCollectionSuiteVersion2);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || collection_suite.get() == nullptr || memory_suite.get() == nullptr) {
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
          "CAPABILITY_FAILED",
          "could not read the open project path for locator identity");
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
            "DEADLINE_EXCEEDED", "composition selection traversal budget elapsed");
      }
      AEGP_CollectionItemV2 selection_item{};
      if (collection_suite->AEGP_GetCollectionItemByIndex(
              collection_owner.get(), index, &selection_item) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read a composition selection item");
      }
      if (selection_item.type != AEGP_CollectionItemType_LAYER) {
        collection_entries.push_back({
            aemcp::native::SelectionCollectionEntryKind::kNonLayer, 0, 0, 0});
        continue;
      }
      AEGP_LayerH layer = selection_item.u.layer.layerH;
      if (layer == nullptr) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "After Effects returned an empty selected layer");
      }
      AEGP_CompH parent_composition = nullptr;
      A_long layer_index = -1;
      AEGP_LayerIDVal layer_id = 0;
      if (layer_suite->AEGP_GetLayerParentComp(layer, &parent_composition)
              != A_Err_NONE
          || parent_composition != composition
          || layer_suite->AEGP_GetLayerIndex(layer, &layer_index) != A_Err_NONE
          || layer_index < 0
          || layer_suite->AEGP_GetLayerID(layer, &layer_id) != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED",
            "selected layer does not belong to the requested composition");
      }
      collection_entries.push_back({
          aemcp::native::SelectionCollectionEntryKind::kLayer,
          reinterpret_cast<std::uintptr_t>(layer),
          static_cast<std::int64_t>(layer_id),
          static_cast<std::uint64_t>(layer_index) + 1U});
    }
    aemcp::native::NormalizedSelectedLayers normalized =
        aemcp::native::normalize_selected_layer_collection(
            std::move(collection_entries));
    if (!normalized.ok) {
      return HostCompositionLayersResult::failure(
          "CAPABILITY_FAILED", std::move(normalized.error));
    }
    const auto& selected = normalized.layers;

    aemcp::native::CompositionLayersPage page;
    page.composition_locator = query.composition_locator;
    page.composition_name = *composition_name;
    page.total = selected.size();
    page.offset = query.offset;
    page.limit = query.limit;
    if (query.offset > page.total) {
      return HostCompositionLayersResult::failure(
          "INVALID_ARGUMENT",
          "offset exceeds the current selected layer total",
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
            "DEADLINE_EXCEEDED", "selected layer page budget elapsed");
      }
      const aemcp::native::SelectionCollectionEntry& candidate = selected[position];
      AEGP_LayerH layer = reinterpret_cast<AEGP_LayerH>(candidate.opaque_layer);
      AEGP_LayerFlags flags = 0;
      AEGP_ObjectType object_type = AEGP_ObjectType_NONE;
      if (layer_suite->AEGP_GetLayerFlags(layer, &flags) != A_Err_NONE
          || layer_suite->AEGP_GetLayerObjectType(layer, &object_type)
              != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read selected layer attributes");
      }
      std::string layer_name_error;
      const std::optional<std::string> layer_name = read_effective_layer_name(
          layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_,
          layer, layer_name_error);
      if (!layer_name.has_value()) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", layer_name_error);
      }

      aemcp::native::CompositionLayerEntry entry;
      entry.locator = graph_.layer_locator(
          *composition_id,
          static_cast<AEGP_LayerIDVal>(candidate.layer_id),
          query.host_instance_id,
          query.session_id);
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
        entry.parent_locator = graph_.layer_locator(
            *composition_id, parent_id, query.host_instance_id, query.session_id);
      }

      AEGP_ItemH source_item = nullptr;
      if (layer_suite->AEGP_GetLayerSourceItem(layer, &source_item)
              != A_Err_NONE) {
        return HostCompositionLayersResult::failure(
            "CAPABILITY_FAILED", "could not read selected layer source item");
      }
      if (source_item != nullptr) {
        A_long source_id = 0;
        AEGP_ItemType source_type = AEGP_ItemType_NONE;
        if (item_suite->AEGP_GetItemID(source_item, &source_id) != A_Err_NONE
            || item_suite->AEGP_GetItemType(source_item, &source_type)
                != A_Err_NONE) {
          return HostCompositionLayersResult::failure(
              "CAPABILITY_FAILED", "could not read selected layer source identity");
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
              "one selected layer exceeds the bounded native response budget");
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

  [[nodiscard]] HostCompositionTimeWriteResult set_composition_time(
      const aemcp::native::CompositionTimeSetCommand& command,
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
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || memory_suite.get() == nullptr || utility_suite.get() == nullptr) {
      return HostCompositionTimeWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required composition time mutation suites are unavailable");
    }
    if (command.target_time.scale == 0
        || command.target_time.seconds_rational
            != aemcp::native::canonical_seconds_rational(
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
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE
        || root == nullptr
        || item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const std::optional<A_long> composition_id = graph_.resolve_composition(
        command.composition_locator, command.host_instance_id, command.session_id);
    if (!composition_id.has_value()) {
      return HostCompositionTimeWriteResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an item in the currently open project",
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
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return HostCompositionTimeWriteResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostCompositionTimeWriteResult::failure(
          "STALE_LOCATOR", "composition item no longer exists in the open project",
          "params.arguments.compositionLocator");
    }
    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not verify composition item type");
    }
    if (item_type != AEGP_ItemType_COMP) {
      return HostCompositionTimeWriteResult::failure(
          "PRECONDITION_FAILED", "compositionLocator no longer identifies a composition",
          "params.arguments.compositionLocator");
    }

    A_Time before_sdk{};
    if (item_suite->AEGP_GetItemCurrentTime(composition_item, &before_sdk)
            != A_Err_NONE
        || before_sdk.scale <= 0) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not read composition time before mutation");
    }
    aemcp::native::CompositionCurrentTime before;
    before.value = static_cast<std::int32_t>(before_sdk.value);
    before.scale = static_cast<std::uint32_t>(before_sdk.scale);
    before.seconds_rational = aemcp::native::canonical_seconds_rational(
        before.value, before.scale);
    const auto same_time = [](const aemcp::native::CompositionCurrentTime& left,
                              const aemcp::native::CompositionCurrentTime& right) {
      return static_cast<std::int64_t>(left.value)
              * static_cast<std::int64_t>(right.scale)
          == static_cast<std::int64_t>(right.value)
              * static_cast<std::int64_t>(left.scale);
    };
    if (same_time(before, command.target_time)) {
      return HostCompositionTimeWriteResult::failure(
          "INVALID_ARGUMENT", "targetTime already matches the composition's current time",
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
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostCompositionTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = item_suite->AEGP_SetItemCurrentTime(
        composition_item, &desired);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    A_Time after_sdk{};
    const A_Err readback_error = item_suite->AEGP_GetItemCurrentTime(
        composition_item, &after_sdk);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || readback_error != A_Err_NONE || after_sdk.scale <= 0) {
      return HostCompositionTimeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition time may have changed but native readback or Undo validation failed");
    }
    aemcp::native::CompositionCurrentTime after;
    after.value = static_cast<std::int32_t>(after_sdk.value);
    after.scale = static_cast<std::uint32_t>(after_sdk.scale);
    after.seconds_rational = aemcp::native::canonical_seconds_rational(
        after.value, after.scale);
    if (same_time(before, after) || !same_time(after, command.target_time)) {
      return HostCompositionTimeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition time readback did not verify the requested state transition");
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

  [[nodiscard]] HostCompositionCreateResult create_composition(
      const aemcp::native::CompositionCreateCommand& command,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    const auto utf16_name = utf16_layer_name(command.name);
    const auto valid_ratio = [](const aemcp::native::CompositionPositiveRatio& value) {
      return value.numerator > 0 && value.denominator > 0
          && value.rational == aemcp::native::canonical_seconds_rational(
              value.numerator, static_cast<std::uint32_t>(value.denominator));
    };
    if (!utf16_name.has_value() || command.width < 1 || command.width > 30000
        || command.height < 1 || command.height > 30000
        || command.duration.value < 1 || command.duration.scale == 0
        || command.duration.seconds_rational
            != aemcp::native::canonical_seconds_rational(
                command.duration.value, command.duration.scale)
        || !valid_ratio(command.frame_rate)
        || !valid_ratio(command.pixel_aspect_ratio)) {
      return HostCompositionCreateResult::failure(
          "INVALID_ARGUMENT", "invalid composition create arguments",
          "params.arguments");
    }

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
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || utility_suite.get() == nullptr) {
      return HostCompositionCreateResult::failure(
          "NATIVE_UNSUPPORTED", "required composition creation suites are unavailable");
    }
    if (budget_expired()) {
      return HostCompositionCreateResult::failure(
          "DEADLINE_EXCEEDED", "composition creation budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionCreateResult::failure(
          "CAPABILITY_FAILED", "could not read project count before composition creation");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostCompositionCreateResult::failure(
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
      return HostCompositionCreateResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionCreateResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostCompositionCreateResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto project_items_before = count_project_items(
        item_suite.get(), project, root);
    if (!project_items_before.has_value()) {
      return HostCompositionCreateResult::failure(
          "CAPABILITY_FAILED", "could not count project items before composition creation");
    }
    if (budget_expired()) {
      return HostCompositionCreateResult::failure(
          "DEADLINE_EXCEEDED", "composition creation budget elapsed");
    }

    A_Ratio pixel_aspect{
        static_cast<A_long>(command.pixel_aspect_ratio.numerator),
        static_cast<A_u_long>(command.pixel_aspect_ratio.denominator)};
    A_Time duration{
        static_cast<A_long>(command.duration.value),
        static_cast<A_u_long>(command.duration.scale)};
    A_Ratio frame_rate{
        static_cast<A_long>(command.frame_rate.numerator),
        static_cast<A_u_long>(command.frame_rate.denominator)};
    static constexpr char kUndoLabel[] = "ae-mcp: Create composition";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostCompositionCreateResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    AEGP_CompH created_comp = nullptr;
    const A_Err create_error = comp_suite->AEGP_CreateComp(
        nullptr,
        utf16_name->data(),
        static_cast<A_long>(command.width),
        static_cast<A_long>(command.height),
        &pixel_aspect,
        &duration,
        &frame_rate,
        &created_comp);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    if (create_error != A_Err_NONE || end_error != A_Err_NONE
        || created_comp == nullptr) {
      return HostCompositionCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition may have been created but mutation or Undo validation failed");
    }

    AEGP_ItemH created_item = nullptr;
    AEGP_ItemH parent_item = nullptr;
    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    A_long item_id = 0;
    A_long width = 0;
    A_long height = 0;
    A_long layer_count = -1;
    A_Time actual_duration{};
    A_Ratio actual_pixel_aspect{};
    A_FpLong actual_frame_rate = 0.0;
    AEGP_MemHandle name_handle = nullptr;
    const A_Err item_error = comp_suite->AEGP_GetItemFromComp(
        created_comp, &created_item);
    const A_Err name_error = item_error == A_Err_NONE && created_item != nullptr
        ? item_suite->AEGP_GetItemName(plugin_id_, created_item, &name_handle)
        : item_error;
    MemHandleOwner name_owner(memory_suite.get(), name_handle);
    const std::optional<std::string> actual_name = name_error == A_Err_NONE
        ? name_owner.utf8() : std::nullopt;
    const auto project_items_after = count_project_items(
        item_suite.get(), project, root);
    if (item_error != A_Err_NONE || created_item == nullptr
        || name_error != A_Err_NONE || !actual_name.has_value()
        || item_suite->AEGP_GetItemType(created_item, &item_type) != A_Err_NONE
        || item_type != AEGP_ItemType_COMP
        || item_suite->AEGP_GetItemID(created_item, &item_id) != A_Err_NONE
        || item_id == 0
        || item_suite->AEGP_GetItemParentFolder(created_item, &parent_item) != A_Err_NONE
        || parent_item != root
        || item_suite->AEGP_GetItemDimensions(created_item, &width, &height) != A_Err_NONE
        || item_suite->AEGP_GetItemDuration(created_item, &actual_duration) != A_Err_NONE
        || item_suite->AEGP_GetItemPixelAspectRatio(
            created_item, &actual_pixel_aspect) != A_Err_NONE
        || comp_suite->AEGP_GetCompFramerate(
            created_comp, &actual_frame_rate) != A_Err_NONE
        || layer_suite->AEGP_GetCompNumLayers(created_comp, &layer_count) != A_Err_NONE
        || !project_items_after.has_value()) {
      return HostCompositionCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created composition did not pass native identity and settings readback");
    }
    const auto time_equal = [](const A_Time& left,
                               const aemcp::native::CompositionCurrentTime& right) {
      return left.scale > 0
          && static_cast<std::int64_t>(left.value) * right.scale
              == static_cast<std::int64_t>(right.value) * left.scale;
    };
    const bool pixel_aspect_equal = actual_pixel_aspect.num > 0
        && actual_pixel_aspect.den > 0
        && static_cast<std::int64_t>(actual_pixel_aspect.num)
                * command.pixel_aspect_ratio.denominator
            == static_cast<std::int64_t>(command.pixel_aspect_ratio.numerator)
                * actual_pixel_aspect.den;
    const double expected_frame_rate =
        static_cast<double>(command.frame_rate.numerator)
        / static_cast<double>(command.frame_rate.denominator);
    const bool frame_rate_equal = std::isfinite(actual_frame_rate)
        && std::abs(static_cast<double>(actual_frame_rate) - expected_frame_rate)
            <= std::max(1.0, expected_frame_rate) * 1e-9;
    if (*actual_name != command.name
        || width != static_cast<A_long>(command.width)
        || height != static_cast<A_long>(command.height)
        || layer_count != 0
        || *project_items_after != *project_items_before + 1
        || !time_equal(actual_duration, command.duration)
        || !pixel_aspect_equal || !frame_rate_equal) {
      return HostCompositionCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created composition readback did not match the requested state");
    }
    if (budget_expired()) {
      return HostCompositionCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition was created after the validation budget elapsed");
    }

    bool invalidated = false;
    try {
      invalidated = graph_.invalidate_project();
    } catch (...) {
      invalidated = false;
    }
    if (!invalidated) {
      return HostCompositionCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition was created but fresh locator generation failed");
    }
    aemcp::native::CompositionCreated created;
    created.changed = true;
    created.name = *actual_name;
    created.composition_locator = graph_.item_locator(
        item_id, true, command.host_instance_id, command.session_id);
    created.project_item_count_before = *project_items_before;
    created.project_item_count_after = *project_items_after;
    created.layer_count = 0;
    created.width = static_cast<std::uint32_t>(width);
    created.height = static_cast<std::uint32_t>(height);
    created.duration = {
        static_cast<std::int32_t>(actual_duration.value),
        static_cast<std::uint32_t>(actual_duration.scale),
        aemcp::native::canonical_seconds_rational(
            actual_duration.value, actual_duration.scale)};
    created.frame_rate = command.frame_rate;
    created.pixel_aspect_ratio = {
        static_cast<std::int32_t>(actual_pixel_aspect.num),
        static_cast<std::int32_t>(actual_pixel_aspect.den),
        aemcp::native::canonical_seconds_rational(
            actual_pixel_aspect.num,
            static_cast<std::uint32_t>(actual_pixel_aspect.den))};
    return HostCompositionCreateResult::success(std::move(created));
  }

  [[nodiscard]] HostCompositionLayerCreateResult create_composition_layer(
      const aemcp::native::CompositionLayerCreateCommand& command,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    const bool solid = command.kind == "solid";
    if ((!solid && command.kind != "null") || command.name.empty()
        || (command.kind == "null"
            && (command.color.has_value() || command.width.has_value()
                || command.height.has_value() || command.duration.has_value()))) {
      return HostCompositionLayerCreateResult::failure(
          "INVALID_ARGUMENT", "invalid composition layer create shape",
          "params.arguments.kind");
    }
    const auto utf16_name = utf16_layer_name(command.name);
    if (!utf16_name.has_value()) {
      return HostCompositionLayerCreateResult::failure(
          "INVALID_ARGUMENT", "name must contain 1 to 255 valid Unicode scalars",
          "params.arguments.name");
    }

    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_FootageSuite5> footage_suite(
        basic_, kAEGPFootageSuite, kAEGPFootageSuiteVersion5);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || footage_suite.get() == nullptr || memory_suite.get() == nullptr
        || utility_suite.get() == nullptr) {
      return HostCompositionLayerCreateResult::failure(
          "NATIVE_UNSUPPORTED", "required composition layer creation suites are unavailable");
    }
    if (budget_expired()) {
      return HostCompositionLayerCreateResult::failure(
          "DEADLINE_EXCEEDED", "composition layer creation budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not read project count before layer creation");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostCompositionLayerCreateResult::failure(
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
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const std::optional<A_long> composition_id = graph_.resolve_composition(
        command.composition_locator, command.host_instance_id, command.session_id);
    if (!composition_id.has_value()) {
      return HostCompositionLayerCreateResult::failure(
          "STALE_LOCATOR",
          "compositionLocator does not identify an item in the currently open project",
          "params.arguments.compositionLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostCompositionLayerCreateResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostCompositionLayerCreateResult::failure(
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostCompositionLayerCreateResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == *composition_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return HostCompositionLayerCreateResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostCompositionLayerCreateResult::failure(
          "STALE_LOCATOR", "composition item no longer exists in the open project",
          "params.arguments.compositionLocator");
    }
    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    AEGP_CompH composition = nullptr;
    if (item_suite->AEGP_GetItemType(composition_item, &item_type) != A_Err_NONE
        || item_type != AEGP_ItemType_COMP
        || comp_suite->AEGP_GetCompFromItem(composition_item, &composition) != A_Err_NONE
        || composition == nullptr) {
      return HostCompositionLayerCreateResult::failure(
          "PRECONDITION_FAILED", "compositionLocator no longer identifies a composition",
          "params.arguments.compositionLocator");
    }

    A_long layer_count_before = 0;
    A_long comp_width = 0;
    A_long comp_height = 0;
    A_Time comp_duration{};
    const auto project_items_before = count_project_items(
        item_suite.get(), project, root);
    if (layer_suite->AEGP_GetCompNumLayers(composition, &layer_count_before)
            != A_Err_NONE
        || layer_count_before < 0
        || item_suite->AEGP_GetItemDimensions(
            composition_item, &comp_width, &comp_height) != A_Err_NONE
        || comp_width < 1 || comp_width > 30000
        || comp_height < 1 || comp_height > 30000
        || item_suite->AEGP_GetItemDuration(composition_item, &comp_duration)
            != A_Err_NONE
        || comp_duration.scale <= 0
        || !project_items_before.has_value()) {
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not read composition state before layer creation");
    }
    const std::uint32_t width = command.width.value_or(
        static_cast<std::uint32_t>(comp_width));
    const std::uint32_t height = command.height.value_or(
        static_cast<std::uint32_t>(comp_height));
    const aemcp::native::CompositionLayerCreateColor color =
        command.color.value_or(aemcp::native::CompositionLayerCreateColor{});
    aemcp::native::CompositionCurrentTime duration = command.duration.value_or(
        aemcp::native::CompositionCurrentTime{
            static_cast<std::int32_t>(comp_duration.value),
            static_cast<std::uint32_t>(comp_duration.scale),
            aemcp::native::canonical_seconds_rational(
                comp_duration.value, comp_duration.scale)});
    if (width < 1 || width > 30000 || height < 1 || height > 30000
        || color.red > 255 || color.green > 255
        || color.blue > 255 || color.alpha > 255
        || duration.scale == 0
        || duration.seconds_rational != aemcp::native::canonical_seconds_rational(
            duration.value, duration.scale)) {
      return HostCompositionLayerCreateResult::failure(
          "INVALID_ARGUMENT", "solid options are outside After Effects bounds",
          "params.arguments");
    }
    if (budget_expired()) {
      return HostCompositionLayerCreateResult::failure(
          "DEADLINE_EXCEEDED", "composition layer creation budget elapsed");
    }

    A_Time sdk_duration{
        static_cast<A_long>(duration.value),
        static_cast<A_u_long>(duration.scale)};
    AEGP_ColorVal sdk_color{
        static_cast<A_FpLong>(color.alpha) / 255.0,
        static_cast<A_FpLong>(color.red) / 255.0,
        static_cast<A_FpLong>(color.green) / 255.0,
        static_cast<A_FpLong>(color.blue) / 255.0};
    static constexpr char kUndoLabel[] = "ae-mcp: Create composition layer";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostCompositionLayerCreateResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    AEGP_LayerH created_layer = nullptr;
    const A_Err create_error = solid
        ? comp_suite->AEGP_CreateSolidInComp(
            utf16_name->data(), static_cast<A_long>(width),
            static_cast<A_long>(height), &sdk_color, composition,
            &sdk_duration, &created_layer)
        : comp_suite->AEGP_CreateNullInComp(
            utf16_name->data(), composition, &sdk_duration, &created_layer);
    const A_Err rename_error = create_error == A_Err_NONE && created_layer != nullptr
        ? layer_suite->AEGP_SetLayerName(created_layer, utf16_name->data())
        : create_error;
    A_Err duration_error = A_Err_NONE;
    if (create_error == A_Err_NONE && created_layer != nullptr && solid) {
      A_Time in_point{};
      duration_error = layer_suite->AEGP_GetLayerInPoint(
          created_layer, AEGP_LTimeMode_CompTime, &in_point);
      if (duration_error == A_Err_NONE) {
        duration_error = layer_suite->AEGP_SetLayerInPointAndDuration(
            created_layer, AEGP_LTimeMode_CompTime, &in_point, &sdk_duration);
      }
    }
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    if (create_error != A_Err_NONE || rename_error != A_Err_NONE
        || duration_error != A_Err_NONE || end_error != A_Err_NONE
        || created_layer == nullptr) {
      return HostCompositionLayerCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition layer may have been created but mutation or Undo validation failed");
    }

    AEGP_CompH parent_composition = nullptr;
    A_long layer_index = -1;
    A_long layer_count_after = 0;
    AEGP_LayerIDVal layer_id = 0;
    A_Time actual_duration{};
    AEGP_ItemH source_item = nullptr;
    const auto project_items_after = count_project_items(
        item_suite.get(), project, root);
    if (layer_suite->AEGP_GetLayerParentComp(created_layer, &parent_composition)
            != A_Err_NONE
        || parent_composition != composition
        || layer_suite->AEGP_GetLayerIndex(created_layer, &layer_index) != A_Err_NONE
        || layer_index < 0
        || layer_suite->AEGP_GetLayerID(created_layer, &layer_id) != A_Err_NONE
        || layer_id == 0
        || layer_suite->AEGP_GetCompNumLayers(composition, &layer_count_after)
            != A_Err_NONE
        || layer_count_after != layer_count_before + 1
        || layer_suite->AEGP_GetLayerDuration(
            created_layer, AEGP_LTimeMode_CompTime, &actual_duration) != A_Err_NONE
        || actual_duration.scale <= 0
        || layer_suite->AEGP_GetLayerSourceItem(created_layer, &source_item)
            != A_Err_NONE
        || !project_items_after.has_value()) {
      return HostCompositionLayerCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created layer did not pass native identity and count readback");
    }
    std::string layer_name_error;
    const std::optional<std::string> actual_name = read_effective_layer_name(
        layer_suite.get(), item_suite.get(), memory_suite.get(), plugin_id_,
        created_layer, layer_name_error);
    if (!actual_name.has_value() || *actual_name != command.name) {
      return HostCompositionLayerCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created layer name did not match the requested name");
    }

    std::optional<A_long> source_id;
    AEGP_ItemType source_type = AEGP_ItemType_NONE;
    aemcp::native::CompositionLayerSolidSpec solid_spec;
    if (source_item != nullptr) {
      A_long read_source_id = 0;
      if (item_suite->AEGP_GetItemID(source_item, &read_source_id) != A_Err_NONE
          || item_suite->AEGP_GetItemType(source_item, &source_type) != A_Err_NONE) {
        return HostCompositionLayerCreateResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "created layer source identity could not be verified");
      }
      source_id = read_source_id;
    }
    if (solid) {
      A_long actual_width = 0;
      A_long actual_height = 0;
      AEGP_ColorVal actual_color{};
      if (source_item == nullptr
          || item_suite->AEGP_GetItemDimensions(
              source_item, &actual_width, &actual_height) != A_Err_NONE
          || actual_width != static_cast<A_long>(width)
          || actual_height != static_cast<A_long>(height)
          || footage_suite->AEGP_GetSolidFootageColor(
              source_item, FALSE, &actual_color) != A_Err_NONE) {
        return HostCompositionLayerCreateResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "solid source dimensions or color could not be verified");
      }
      const auto channel = [](A_FpLong value) -> std::uint16_t {
        const double bounded = std::clamp(static_cast<double>(value), 0.0, 1.0);
        return static_cast<std::uint16_t>(std::lround(bounded * 255.0));
      };
      solid_spec.color = {
          channel(actual_color.redF),
          channel(actual_color.greenF),
          channel(actual_color.blueF),
          channel(actual_color.alphaF)};
      solid_spec.width = static_cast<std::uint32_t>(actual_width);
      solid_spec.height = static_cast<std::uint32_t>(actual_height);
      solid_spec.duration = {
          static_cast<std::int32_t>(actual_duration.value),
          static_cast<std::uint32_t>(actual_duration.scale),
          aemcp::native::canonical_seconds_rational(
              actual_duration.value, actual_duration.scale)};
      const auto same_time = [](const auto& left, const auto& right) {
        return static_cast<std::int64_t>(left.value)
                * static_cast<std::int64_t>(right.scale)
            == static_cast<std::int64_t>(right.value)
                * static_cast<std::int64_t>(left.scale);
      };
      if (solid_spec.color != color || !same_time(solid_spec.duration, duration)) {
        return HostCompositionLayerCreateResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "solid source readback did not match the requested color or duration");
      }
    }
    if (budget_expired()) {
      return HostCompositionLayerCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition layer was created after the validation budget elapsed");
    }

    bool invalidated = false;
    try {
      invalidated = graph_.invalidate_project();
    } catch (...) {
      invalidated = false;
    }
    if (!invalidated) {
      return HostCompositionLayerCreateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "composition layer was created but fresh locator generation failed");
    }
    aemcp::native::CompositionLayerCreated created;
    created.changed = true;
    created.kind = command.kind;
    created.name = *actual_name;
    created.stack_index = static_cast<std::uint64_t>(layer_index) + 1U;
    created.composition_locator = graph_.item_locator(
        *composition_id, true, command.host_instance_id, command.session_id);
    created.layer_locator = graph_.layer_locator(
        *composition_id, layer_id, command.host_instance_id, command.session_id);
    if (source_id.has_value()) {
      created.source_item_locator = graph_.item_locator(
          *source_id, source_type == AEGP_ItemType_COMP,
          command.host_instance_id, command.session_id);
    }
    created.layer_count_before = static_cast<std::uint64_t>(layer_count_before);
    created.layer_count_after = static_cast<std::uint64_t>(layer_count_after);
    created.project_item_count_before = *project_items_before;
    created.project_item_count_after = *project_items_after;
    if (solid) created.solid = solid_spec;
    return HostCompositionLayerCreateResult::success(std::move(created));
  }

  [[nodiscard]] HostLayerEffectApplyResult apply_layer_effect(
      const aemcp::native::LayerEffectApplyCommand& command,
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
    SuiteLease<AEGP_EffectSuite5> effect_suite(
        basic_, kAEGPEffectSuite, kAEGPEffectSuiteVersion5);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || stream_suite.get() == nullptr
        || dynamic_suite.get() == nullptr || effect_suite.get() == nullptr
        || utility_suite.get() == nullptr) {
      return HostLayerEffectApplyResult::failure(
          "NATIVE_UNSUPPORTED", "required layer effect suites are unavailable");
    }
    if (budget_expired()) {
      return HostLayerEffectApplyResult::failure(
          "DEADLINE_EXCEEDED", "layer effect application budget elapsed");
    }

    A_long project_count = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not read project count");
    }
    if (project_count <= 0) {
      graph_.project_closed();
      return HostLayerEffectApplyResult::failure(
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
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root_item),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto layer_address = graph_.resolve_layer(
        command.layer_locator, command.host_instance_id, command.session_id);
    if (!layer_address.has_value()) {
      return HostLayerEffectApplyResult::failure(
          "STALE_LOCATOR",
          "layerLocator does not identify a layer in the currently open project",
          "params.arguments.layerLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) != A_Err_NONE) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not begin composition lookup");
    }
    AEGP_ItemH composition_item = nullptr;
    std::uint64_t visited = 0;
    while (item != nullptr) {
      if (budget_expired()) {
        return HostLayerEffectApplyResult::failure(
            "DEADLINE_EXCEEDED", "composition lookup budget elapsed");
      }
      if (++visited > static_cast<std::uint64_t>(kMaximumProjectItems)) {
        return HostLayerEffectApplyResult::failure(
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return HostLayerEffectApplyResult::failure(
            "CAPABILITY_FAILED", "could not read project item identity");
      }
      if (item_id == layer_address->composition_item_id) {
        composition_item = item;
        break;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return HostLayerEffectApplyResult::failure(
            "CAPABILITY_FAILED", "composition lookup traversal failed");
      }
      item = next;
    }
    if (composition_item == nullptr) {
      return HostLayerEffectApplyResult::failure(
          "STALE_LOCATOR", "layer composition no longer exists",
          "params.arguments.layerLocator");
    }
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) != A_Err_NONE
        || composition == nullptr
        || layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE
        || layer == nullptr) {
      return HostLayerEffectApplyResult::failure(
          "STALE_LOCATOR", "layer can no longer be resolved",
          "params.arguments.layerLocator");
    }

    A_long installed_count = 0;
    if (effect_suite->AEGP_GetNumInstalledEffects(&installed_count) != A_Err_NONE
        || installed_count < 0 || installed_count > kMaximumLayerEffects) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "installed effect traversal bound was unavailable");
    }
    AEGP_InstalledEffectKey installed_key = AEGP_InstalledEffectKey_NONE;
    AEGP_InstalledEffectKey matched_key = AEGP_InstalledEffectKey_NONE;
    std::string matched_name;
    for (A_long index = 0; index < installed_count; ++index) {
      AEGP_InstalledEffectKey next_key = AEGP_InstalledEffectKey_NONE;
      if (effect_suite->AEGP_GetNextInstalledEffect(
              installed_key, &next_key) != A_Err_NONE
          || next_key == AEGP_InstalledEffectKey_NONE) {
        return HostLayerEffectApplyResult::failure(
            "CAPABILITY_FAILED", "installed effect traversal failed");
      }
      installed_key = next_key;
      std::array<A_char, AEGP_MAX_EFFECT_MATCH_NAME_SIZE> match_name{};
      if (effect_suite->AEGP_GetEffectMatchName(
              installed_key, match_name.data()) != A_Err_NONE
          || std::find(match_name.begin(), match_name.end(), '\0')
              == match_name.end()) {
        return HostLayerEffectApplyResult::failure(
            "CAPABILITY_FAILED", "installed effect match name was not bounded");
      }
      if (command.effect_match_name != std::string_view(match_name.data())) continue;
      if (matched_key != AEGP_InstalledEffectKey_NONE) {
        return HostLayerEffectApplyResult::failure(
            "PRECONDITION_FAILED", "effect match name is not unique in this host",
            "params.arguments.effectMatchName");
      }
      matched_key = installed_key;
    }
    if (matched_key == AEGP_InstalledEffectKey_NONE) {
      return HostLayerEffectApplyResult::failure(
          "PRECONDITION_FAILED", "effect match name is not installed in After Effects",
          "params.arguments.effectMatchName");
    }
    std::array<A_char, AEGP_MAX_EFFECT_MATCH_NAME_SIZE> verified_match_name{};
    if (effect_suite->AEGP_GetEffectMatchName(
            matched_key, verified_match_name.data()) != A_Err_NONE
        || std::find(verified_match_name.begin(), verified_match_name.end(), '\0')
            == verified_match_name.end()
        || std::string_view(verified_match_name.data()) != command.effect_match_name) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "installed effect metadata could not be verified");
    }

    const auto read_effect_keys = [&]() -> std::optional<std::vector<AEGP_InstalledEffectKey>> {
      A_long count = 0;
      if (effect_suite->AEGP_GetLayerNumEffects(layer, &count) != A_Err_NONE
          || count < 0 || count > kMaximumLayerEffects) {
        return std::nullopt;
      }
      std::vector<AEGP_InstalledEffectKey> keys;
      keys.reserve(static_cast<std::size_t>(count));
      for (A_long index = 0; index < count; ++index) {
        AEGP_EffectRefH effect_ref = nullptr;
        if (effect_suite->AEGP_GetLayerEffectByIndex(
                plugin_id_, layer, index, &effect_ref) != A_Err_NONE
            || effect_ref == nullptr) {
          return std::nullopt;
        }
        EffectRefOwner effect_owner(effect_suite.get(), effect_ref);
        AEGP_InstalledEffectKey key = AEGP_InstalledEffectKey_NONE;
        if (effect_suite->AEGP_GetInstalledKeyFromLayerEffect(
                effect_owner.get(), &key) != A_Err_NONE
            || key == AEGP_InstalledEffectKey_NONE) {
          return std::nullopt;
        }
        keys.push_back(key);
      }
      return keys;
    };
    const auto before_keys = read_effect_keys();
    if (!before_keys.has_value()) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not read layer effects before mutation");
    }
    const std::uint64_t matching_before = static_cast<std::uint64_t>(
        std::count(before_keys->begin(), before_keys->end(), matched_key));
    // AE 26.3 cannot return the implicit input-layer stream at parameter index
    // zero. A first zero-user-parameter effect is still identifiable by the
    // unique installed-key transition, but adding an indistinguishable second
    // instance cannot be proven after the mutation. Reject that case before
    // entering an Undo group instead of returning an uncertain side effect.
    if (matching_before > 0) {
      bool inspected_duplicate = false;
      for (std::size_t index = 0; index < before_keys->size(); ++index) {
        if ((*before_keys)[index] != matched_key) continue;
        AEGP_EffectRefH existing_ref = nullptr;
        if (effect_suite->AEGP_GetLayerEffectByIndex(
                plugin_id_, layer, static_cast<A_long>(index), &existing_ref)
                != A_Err_NONE
            || existing_ref == nullptr) {
          return HostLayerEffectApplyResult::failure(
              "CAPABILITY_FAILED", "could not inspect an existing matching effect");
        }
        EffectRefOwner existing_owner(effect_suite.get(), existing_ref);
        A_long existing_parameter_count = 0;
        if (stream_suite->AEGP_GetEffectNumParamStreams(
                existing_owner.get(), &existing_parameter_count) != A_Err_NONE
            || existing_parameter_count < 1 || existing_parameter_count > 4096) {
          return HostLayerEffectApplyResult::failure(
              "CAPABILITY_FAILED", "existing effect parameter metadata was invalid");
        }
        if (existing_parameter_count == 1) {
          return HostLayerEffectApplyResult::failure(
              "PRECONDITION_FAILED",
              "this host cannot safely identify a duplicate effect with no user parameters",
              "params.arguments.effectMatchName");
        }
        inspected_duplicate = true;
        break;
      }
      if (!inspected_duplicate) {
        return HostLayerEffectApplyResult::failure(
            "CAPABILITY_FAILED", "matching effect count could not be inspected");
      }
    }
    if (budget_expired()) {
      return HostLayerEffectApplyResult::failure(
          "DEADLINE_EXCEEDED", "layer effect application budget elapsed");
    }

    static constexpr char kUndoLabel[] = "ae-mcp: Apply layer effect";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerEffectApplyResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    AEGP_EffectRefH applied_ref = nullptr;
    const A_Err apply_error = effect_suite->AEGP_ApplyEffect(
        plugin_id_, layer, matched_key, &applied_ref);
    EffectRefOwner applied_owner(effect_suite.get(), applied_ref);
    AEGP_InstalledEffectKey applied_key = AEGP_InstalledEffectKey_NONE;
    const A_Err applied_key_error = applied_ref == nullptr
        ? A_Err_GENERIC
        : effect_suite->AEGP_GetInstalledKeyFromLayerEffect(
            applied_owner.get(), &applied_key);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after_keys = read_effect_keys();
    if (apply_error != A_Err_NONE || applied_ref == nullptr
        || applied_key_error != A_Err_NONE || applied_key != matched_key
        || end_error != A_Err_NONE || !after_keys.has_value()) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "effect may have been applied but exact instance readback or Undo validation failed");
    }
    const std::uint64_t matching_after = static_cast<std::uint64_t>(
        std::count(after_keys->begin(), after_keys->end(), matched_key));
    if (after_keys->size() != before_keys->size() + 1
        || matching_after != matching_before + 1) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "effect application did not produce one exact native effect");
    }

    A_long parameter_count = 0;
    if (stream_suite->AEGP_GetEffectNumParamStreams(
            applied_owner.get(), &parameter_count) != A_Err_NONE
        || parameter_count < 1 || parameter_count > 4096) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect parameter stream count was missing or invalid");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE
        || root_stream == nullptr) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect layer property root could not be resolved");
    }
    StreamRefOwner root_stream_owner(stream_suite.get(), root_stream);
    AEGP_StreamRefH effect_group_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefByMatchname(
            plugin_id_, root_stream_owner.get(), "ADBE Effect Parade",
            &effect_group_stream) != A_Err_NONE
        || effect_group_stream == nullptr) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect group could not be resolved");
    }
    StreamRefOwner effect_group_owner(stream_suite.get(), effect_group_stream);
    AEGP_StreamGroupingType effect_grouping = AEGP_StreamGroupingType_NONE;
    A_long effect_group_count = 0;
    if (dynamic_suite->AEGP_GetStreamGroupingType(
            effect_group_owner.get(), &effect_grouping) != A_Err_NONE
        || effect_grouping != AEGP_StreamGroupingType_INDEXED_GROUP
        || dynamic_suite->AEGP_GetNumStreamsInGroup(
            effect_group_owner.get(), &effect_group_count) != A_Err_NONE
        || effect_group_count < 0
        || static_cast<std::size_t>(effect_group_count) != after_keys->size()) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect group did not match the native effect stack");
    }

    A_long insertion_index = -1;
    AEGP_StreamRefH effect_stream = nullptr;
    if (parameter_count >= 2) {
      // Parameter stream 1 belongs to the exact EffectRef returned by
      // AEGP_ApplyEffect. Its dynamic parent is therefore the exact applied
      // effect even when adjacent instances share keys and display names.
      AEGP_StreamRefH parameter_stream = nullptr;
      if (stream_suite->AEGP_GetNewEffectStreamByIndex(
              plugin_id_, applied_owner.get(), 1, &parameter_stream) != A_Err_NONE
          || parameter_stream == nullptr) {
        return HostLayerEffectApplyResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "applied effect parameter stream could not be resolved");
      }
      StreamRefOwner parameter_stream_owner(stream_suite.get(), parameter_stream);
      if (dynamic_suite->AEGP_GetNewParentStreamRef(
              plugin_id_, parameter_stream_owner.get(), &effect_stream) != A_Err_NONE
          || effect_stream == nullptr) {
        return HostLayerEffectApplyResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "applied effect stream could not be resolved from its parameter");
      }
    } else {
      const auto located_index = locate_unique_insertion<AEGP_InstalledEffectKey>(
          std::span<const AEGP_InstalledEffectKey>(*before_keys),
          std::span<const AEGP_InstalledEffectKey>(*after_keys),
          matched_key);
      if (!located_index.has_value()) {
        return HostLayerEffectApplyResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "zero-parameter effect insertion was not uniquely identifiable");
      }
      insertion_index = static_cast<A_long>(located_index.value());
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, effect_group_owner.get(), insertion_index,
              &effect_stream) != A_Err_NONE
          || effect_stream == nullptr) {
        return HostLayerEffectApplyResult::failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "applied effect stream could not be resolved from the effect group");
      }
    }
    StreamRefOwner effect_stream_owner(stream_suite.get(), effect_stream);
    std::array<A_char, AEGP_MAX_STREAM_MATCH_NAME_SIZE> applied_match_name{};
    if (dynamic_suite->AEGP_GetMatchName(
            effect_stream_owner.get(), applied_match_name.data()) != A_Err_NONE
        || std::find(applied_match_name.begin(), applied_match_name.end(), '\0')
            == applied_match_name.end()
        || std::string_view(applied_match_name.data()) != command.effect_match_name) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect stream did not match the requested effect");
    }
    A_long verified_insertion_index = -1;
    if (dynamic_suite->AEGP_GetStreamIndexInParent(
            effect_stream_owner.get(), &verified_insertion_index) != A_Err_NONE
        || verified_insertion_index < 0
        || static_cast<std::size_t>(verified_insertion_index) >= after_keys->size()
        || (insertion_index >= 0 && verified_insertion_index != insertion_index)) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect index could not be verified from its native stream");
    }
    insertion_index = verified_insertion_index;
    bool preserved_existing_order =
        static_cast<std::size_t>(insertion_index) < after_keys->size()
        && (*after_keys)[static_cast<std::size_t>(insertion_index)] == matched_key;
    for (std::size_t before_index = 0;
         preserved_existing_order && before_index < before_keys->size();
         ++before_index) {
      const std::size_t after_index = before_index < static_cast<std::size_t>(insertion_index)
          ? before_index : before_index + 1U;
      preserved_existing_order = (*before_keys)[before_index] == (*after_keys)[after_index];
    }
    if (!preserved_existing_order) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect index did not preserve the existing native stack");
    }

    // AEGP_GetEffectName does not promise UTF-8, so localized hosts can return
    // bytes that strict JSON evidence must reject. Read the exact applied
    // stream's UTF-16 name instead and convert it through MemHandleOwner.
    AEGP_MemHandle effect_name_handle = nullptr;
    const A_Err effect_name_error = stream_suite->AEGP_GetStreamName(
        plugin_id_, effect_stream_owner.get(), FALSE, &effect_name_handle);
    MemHandleOwner effect_name_owner(memory_suite.get(), effect_name_handle);
    if (effect_name_error != A_Err_NONE || effect_name_handle == nullptr) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect UTF-16 name could not be read");
    }
    const auto applied_effect_name = effect_name_owner.utf8();
    if (!applied_effect_name.has_value() || applied_effect_name->empty()) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "applied effect UTF-16 name was missing or invalid");
    }
    matched_name = std::move(*applied_effect_name);
    if (budget_expired()) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "effect was applied after the validation budget elapsed");
    }

    bool invalidated = false;
    try {
      invalidated = graph_.invalidate_project();
    } catch (...) {
      invalidated = false;
    }
    if (!invalidated) {
      return HostLayerEffectApplyResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "effect was applied but fresh locator generation failed");
    }
    aemcp::native::LayerEffectApplied applied;
    applied.changed = true;
    applied.layer_locator = graph_.layer_locator(
        layer_address->composition_item_id,
        layer_address->layer_id,
        command.host_instance_id,
        command.session_id,
        command.layer_locator.object_id);
    applied.name = std::move(matched_name);
    applied.match_name = command.effect_match_name;
    applied.effect_index = static_cast<std::uint64_t>(insertion_index) + 1U;
    applied.effect_count_before = before_keys->size();
    applied.effect_count_after = after_keys->size();
    applied.matching_effect_count_before = matching_before;
    applied.matching_effect_count_after = matching_after;
    return HostLayerEffectApplyResult::success(std::move(applied));
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

  [[nodiscard]] HostLayerPropertyKeyframesResult list_layer_property_keyframes(
      const aemcp::native::LayerPropertyKeyframesQuery& query,
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
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(
        basic_, kAEGPKeyframeSuite, kAEGPKeyframeSuiteVersion5);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || stream_suite.get() == nullptr
        || dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "NATIVE_UNSUPPORTED", "required layer keyframe suites are unavailable");
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
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root_item) != A_Err_NONE
        || root_item == nullptr
        || item_suite->AEGP_GetItemID(root_item, &root_id) != A_Err_NONE) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root_item),
          root_id,
          std::move(*project_path));
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
    const auto layer_address = graph_.resolve_layer_object(
        stream_address->layer_object_id);
    if (!layer_address.has_value()) {
      return HostLayerPropertyKeyframesResult::failure(
          "STALE_LOCATOR", "property layer no longer exists",
          "params.arguments.propertyLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) != A_Err_NONE) {
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
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
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
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) != A_Err_NONE
        || composition == nullptr
        || layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE
        || layer == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "STALE_LOCATOR", "property layer can no longer be resolved",
          "params.arguments.propertyLocator");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE
        || root_stream == nullptr) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not resolve the layer property root");
    }
    StreamRefOwner property_stream(stream_suite.get(), root_stream);
    for (std::size_t depth = 0; depth < stream_address->child_indices.size(); ++depth) {
      if (budget_expired()) {
        return HostLayerPropertyKeyframesResult::failure(
            "DEADLINE_EXCEEDED", "property traversal budget elapsed");
      }
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      A_long child_count = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(
              property_stream.get(), &grouping) != A_Err_NONE
          || grouping == AEGP_StreamGroupingType_LEAF
          || dynamic_suite->AEGP_GetNumStreamsInGroup(
              property_stream.get(), &child_count) != A_Err_NONE
          || stream_address->child_indices[depth] < 0
          || stream_address->child_indices[depth] >= child_count) {
        return HostLayerPropertyKeyframesResult::failure(
            "STALE_LOCATOR", "property path no longer exists",
            "params.arguments.propertyLocator");
      }
      AEGP_StreamRefH next_stream = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, property_stream.get(), stream_address->child_indices[depth],
              &next_stream) != A_Err_NONE
          || next_stream == nullptr) {
        return HostLayerPropertyKeyframesResult::failure(
            "STALE_LOCATOR", "property path could not be reacquired",
            "params.arguments.propertyLocator");
      }
      StreamRefOwner next_owner(stream_suite.get(), next_stream);
      std::int32_t unique_id = 0;
      if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id)
              != A_Err_NONE
          || unique_id != stream_address->unique_ids[depth]) {
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
    if (dynamic_suite->AEGP_GetStreamGroupingType(property_stream.get(), &grouping)
            != A_Err_NONE
        || stream_suite->AEGP_GetStreamType(property_stream.get(), &type) != A_Err_NONE
        || stream_suite->AEGP_CanVaryOverTime(property_stream.get(), &can_vary)
            != A_Err_NONE
        || keyframe_suite->AEGP_GetStreamNumKFs(
            property_stream.get(), &keyframe_count) != A_Err_NONE) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "could not inspect the target property's keyframes");
    }
    const bool primitive = type == AEGP_StreamType_OneD
        || type == AEGP_StreamType_TwoD || type == AEGP_StreamType_TwoD_SPATIAL
        || type == AEGP_StreamType_ThreeD || type == AEGP_StreamType_ThreeD_SPATIAL
        || type == AEGP_StreamType_COLOR;
    if (grouping != AEGP_StreamGroupingType_LEAF || can_vary == FALSE
        || keyframe_count == AEGP_NumKF_NO_DATA || !primitive) {
      return HostLayerPropertyKeyframesResult::failure(
          "PRECONDITION_FAILED",
          "property must be a keyframeable primitive scalar, vector, or color leaf stream",
          "params.arguments.propertyLocator");
    }
    if (keyframe_count < 0) {
      return HostLayerPropertyKeyframesResult::failure(
          "CAPABILITY_FAILED", "After Effects returned an invalid keyframe count");
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
      if (keyframe_suite->AEGP_GetKeyframeTime(
              property_stream.get(), sdk_index, AEGP_LTimeMode_CompTime, &key_time)
              != A_Err_NONE
          || key_time.scale <= 0
          || keyframe_suite->AEGP_GetNewKeyframeValue(
              plugin_id_, property_stream.get(), sdk_index, key_value.out())
              != A_Err_NONE) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED", "could not read a keyframe's exact time and value");
      }
      key_value.mark_initialized();
      if (keyframe_suite->AEGP_GetKeyframeInterpolation(
              property_stream.get(), sdk_index,
              &in_interpolation, &out_interpolation) != A_Err_NONE) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED", "could not read keyframe interpolation metadata");
      }
      const auto value = primitive_stream_value(type, key_value.value());
      const auto in_name = keyframe_interpolation_name(in_interpolation);
      const auto out_name = keyframe_interpolation_name(out_interpolation);
      if (!value.has_value() || !in_name.has_value() || !out_name.has_value()) {
        return HostLayerPropertyKeyframesResult::failure(
            "CAPABILITY_FAILED", "keyframe value or interpolation was not representable");
      }
      aemcp::native::LayerPropertyKeyframeEntry entry;
      entry.keyframe_index = index + 1U;
      entry.time = {
          static_cast<std::int64_t>(key_time.value),
          static_cast<std::uint64_t>(key_time.scale)};
      entry.value = *value;
      entry.in_interpolation = *in_name;
      entry.out_interpolation = *out_name;
      const std::size_t entry_bytes = layer_property_keyframe_json_size(entry)
          + (page.keyframes.empty() ? 0U : 1U);
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
    if (page.has_more) page.next_offset = query.offset + page.keyframes.size();
    return HostLayerPropertyKeyframesResult::success(std::move(page));
  }

  [[nodiscard]] HostLayerPropertyKeyframeDetailsResult
      read_layer_property_keyframe_details(
          const aemcp::native::LayerPropertyKeyframeDetailsQuery& query,
          TimePoint work_deadline) override {
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
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(
        basic_, kAEGPKeyframeSuite, kAEGPKeyframeSuiteVersion5);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || stream_suite.get() == nullptr
        || dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "NATIVE_UNSUPPORTED", "required keyframe detail suites are unavailable");
    }
    if (query.time.scale == 0
        || query.time.value < std::numeric_limits<std::int32_t>::min()
        || query.time.value > std::numeric_limits<std::int32_t>::max()) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "INVALID_ARGUMENT", "time must be an exact bounded comp time",
          "params.arguments.time");
    }
    const auto resolved = resolve_keyframe_property(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), stream_suite.get(), dynamic_suite.get(),
        keyframe_suite.get(), query.property_locator, std::nullopt,
        query.host_instance_id, query.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "PRECONDITION_FAILED",
          "propertyLocator must identify a current keyframeable primitive property",
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
    const auto details = read_keyframe_details_value(
        stream_suite.get(), keyframe_suite.get(), *resolved, *index,
        query.property_locator);
    if (!details.has_value() || !keyframe_time_equal(details->time, query.time)) {
      return HostLayerPropertyKeyframeDetailsResult::failure(
          "CAPABILITY_FAILED", "could not read complete keyframe details");
    }
    return HostLayerPropertyKeyframeDetailsResult::success(*details);
  }

  [[nodiscard]] HostLayerPropertyKeyframeWriteResult
      mutate_layer_property_keyframe(
          const aemcp::native::LayerPropertyKeyframeMutationCommand& command,
          TimePoint work_deadline) override {
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
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(
        basic_, kAEGPKeyframeSuite, kAEGPKeyframeSuiteVersion5);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || stream_suite.get() == nullptr
        || dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr
        || utility_suite.get() == nullptr) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required keyframe mutation suites are unavailable");
    }
    if (command.time.scale == 0
        || command.time.value < std::numeric_limits<std::int32_t>::min()
        || command.time.value > std::numeric_limits<std::int32_t>::max()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "INVALID_ARGUMENT", "time must be an exact bounded comp time",
          "params.arguments.time");
    }
    auto resolved = resolve_keyframe_property(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), stream_suite.get(), dynamic_suite.get(),
        keyframe_suite.get(), command.property_locator, command.layer_locator,
        command.host_instance_id, command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "PRECONDITION_FAILED",
          "locators must identify one current keyframeable primitive property",
          "params.arguments.propertyLocator");
    }
    const A_long count_before = resolved->keyframe_count;
    const auto before_index = find_keyframe_at_time(
        keyframe_suite.get(), resolved->stream.get(), count_before,
        command.time, work_deadline);
    const bool adding = command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kAdd;
    if (adding && before_index.has_value()) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "PRECONDITION_FAILED", "a keyframe already exists at the exact comp time",
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
            "CAPABILITY_FAILED", "could not read keyframe state before mutation");
      }
    }

    // Keep the SDK-owned seed alive until every AEGP_SetKeyframeValue call has
    // returned. AEGP_StreamValue2 is a shallow SDK value containing streamH;
    // copying it does not extend the lifetime ended by DisposeStreamValue.
    StreamValueOwner desired_value_owner(stream_suite.get());
    AEGP_KeyframeInterpolationType desired_in = AEGP_KeyInterp_NONE;
    AEGP_KeyframeInterpolationType desired_out = AEGP_KeyInterp_NONE;
    std::vector<std::pair<A_long, std::pair<AEGP_KeyframeEase, AEGP_KeyframeEase>>>
        desired_ease;
    AEGP_KeyframeFlags desired_flag = AEGP_KeyframeFlag_NONE;
    const auto interpolation_value = [](std::string_view value)
        -> std::optional<AEGP_KeyframeInterpolationType> {
      if (value == "linear") return AEGP_KeyInterp_LINEAR;
      if (value == "bezier") return AEGP_KeyInterp_BEZIER;
      if (value == "hold") return AEGP_KeyInterp_HOLD;
      return std::nullopt;
    };
    const auto behavior_flag = [](std::string_view behavior)
        -> std::optional<AEGP_KeyframeFlags> {
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
      if (behavior == "roving") return AEGP_KeyframeFlag_ROVING;
      return std::nullopt;
    };
    if (adding || command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetValue) {
      A_Time sample_time{
          static_cast<A_long>(command.time.value),
          static_cast<A_u_long>(command.time.scale)};
      if (stream_suite->AEGP_GetNewStreamValue(
              plugin_id_, resolved->stream.get(), AEGP_LTimeMode_CompTime,
              &sample_time, FALSE, desired_value_owner.out()) != A_Err_NONE) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "CAPABILITY_FAILED", "could not prepare a typed keyframe value");
      }
      desired_value_owner.mark_initialized();
      if (!assign_primitive_stream_value(
              resolved->type, command.value,
              desired_value_owner.mutable_value())) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "value does not match the property type",
            "params.arguments.value");
      }
      if (!adding && before.has_value()
          && layer_property_values_equal(command.value, before->value)) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "value already matches the keyframe",
            "params.arguments.value");
      }
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetInterpolation) {
      const auto in_value = interpolation_value(command.in_interpolation);
      const auto out_value = interpolation_value(command.out_interpolation);
      AEGP_KeyInterpolationMask valid = AEGP_KeyInterpMask_NONE;
      if (!in_value.has_value() || !out_value.has_value()
          || stream_suite->AEGP_GetValidInterpolations(
              resolved->stream.get(), &valid) != A_Err_NONE) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "unsupported keyframe interpolation",
            "params.arguments.inInterpolation");
      }
      const auto allowed = [valid](AEGP_KeyframeInterpolationType value) {
        const AEGP_KeyInterpolationMask mask = value == AEGP_KeyInterp_LINEAR
            ? AEGP_KeyInterpMask_LINEAR
            : value == AEGP_KeyInterp_BEZIER
                ? AEGP_KeyInterpMask_BEZIER : AEGP_KeyInterpMask_HOLD;
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
      if (before->in_interpolation == command.in_interpolation
          && before->out_interpolation == command.out_interpolation) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "interpolation already matches the keyframe",
            "params.arguments.inInterpolation");
      }
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetTemporalEase) {
      if (command.temporal_ease.size()
          != static_cast<std::size_t>(resolved->temporal_dimensions)) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "dimensions must cover the temporal dimensionality",
            "params.arguments.dimensions");
      }
      std::array<bool, 4> seen{};
      bool differs = false;
      std::uint16_t expected_dimension = 0;
      for (const auto& dimension : command.temporal_ease) {
        if (dimension.dimension >= resolved->temporal_dimensions
            || seen[dimension.dimension]
            || dimension.dimension != expected_dimension) {
          return HostLayerPropertyKeyframeWriteResult::failure(
              "INVALID_ARGUMENT", "temporal ease dimensions must be unique and in range",
              "params.arguments.dimensions");
        }
        seen[dimension.dimension] = true;
        ++expected_dimension;
        const auto in_speed = decimal_value(dimension.in_ease.speed);
        const auto in_influence = decimal_value(dimension.in_ease.influence);
        const auto out_speed = decimal_value(dimension.out_ease.speed);
        const auto out_influence = decimal_value(dimension.out_ease.influence);
        if (!in_speed.has_value() || !in_influence.has_value()
            || !out_speed.has_value() || !out_influence.has_value()
            || *in_influence < 0.0 || *in_influence > 100.0
            || *out_influence < 0.0 || *out_influence > 100.0) {
          return HostLayerPropertyKeyframeWriteResult::failure(
              "INVALID_ARGUMENT", "ease influence must be from 0 through 100",
              "params.arguments.dimensions");
        }
        desired_ease.push_back({
            static_cast<A_long>(dimension.dimension),
            {{*in_speed, *in_influence / 100.0},
             {*out_speed, *out_influence / 100.0}}});
        differs = differs || !keyframe_dimension_ease_equal(
            before->temporal_ease[dimension.dimension], dimension);
      }
      if (!differs) {
        return HostLayerPropertyKeyframeWriteResult::failure(
            "INVALID_ARGUMENT", "temporal ease already matches the keyframe",
            "params.arguments.dimensions");
      }
      if (before->in_interpolation != "bezier"
          || before->out_interpolation != "bezier") {
        AEGP_KeyInterpolationMask valid = AEGP_KeyInterpMask_NONE;
        if (stream_suite->AEGP_GetValidInterpolations(
                resolved->stream.get(), &valid) != A_Err_NONE
            || (valid & AEGP_KeyInterpMask_BEZIER) == 0) {
          return HostLayerPropertyKeyframeWriteResult::failure(
              "PRECONDITION_FAILED",
              "the property does not support bezier temporal ease",
              "params.arguments.dimensions");
        }
      }
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetBehavior) {
      const auto flag = behavior_flag(command.behavior);
      const bool spatial = resolved->type == AEGP_StreamType_TwoD_SPATIAL
          || resolved->type == AEGP_StreamType_ThreeD_SPATIAL;
      const bool spatial_behavior = command.behavior == "spatial-continuous"
          || command.behavior == "spatial-auto-bezier"
          || command.behavior == "roving";
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
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
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
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetValue) {
      mutation_error = keyframe_suite->AEGP_SetKeyframeValue(
          resolved->stream.get(), *before_index, desired_value_owner.borrow());
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetInterpolation) {
      mutation_error = keyframe_suite->AEGP_SetKeyframeInterpolation(
          resolved->stream.get(), *before_index, desired_in, desired_out);
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetTemporalEase) {
      // After Effects only retains per-keyframe temporal ease when both sides
      // use bezier interpolation; the same ease call on a linear keyframe
      // leaves no observable state. Promote non-bezier sides inside this Undo
      // group, mirroring Easy Ease, so the readback can prove the request.
      if (before->in_interpolation != "bezier"
          || before->out_interpolation != "bezier") {
        mutation_error = keyframe_suite->AEGP_SetKeyframeInterpolation(
            resolved->stream.get(), *before_index, AEGP_KeyInterp_BEZIER,
            AEGP_KeyInterp_BEZIER);
      }
      for (const auto& [dimension, ease] : desired_ease) {
        if (mutation_error != A_Err_NONE) break;
        mutation_error = keyframe_suite->AEGP_SetKeyframeTemporalEase(
            resolved->stream.get(), *before_index, dimension,
            &ease.first, &ease.second);
      }
    } else if (command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kSetBehavior) {
      mutation_error = keyframe_suite->AEGP_SetKeyframeFlag(
          resolved->stream.get(), *before_index, desired_flag,
          command.enabled ? TRUE : FALSE);
    } else {
      mutation_error = keyframe_suite->AEGP_DeleteKeyframe(
          resolved->stream.get(), *before_index);
    }
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();

    A_long count_after = -1;
    if (keyframe_suite->AEGP_GetStreamNumKFs(
            resolved->stream.get(), &count_after) != A_Err_NONE
        || count_after < 0) count_after = -1;
    const auto after_index = count_after >= 0
        ? find_keyframe_at_time(
            keyframe_suite.get(), resolved->stream.get(), count_after,
            command.time, work_deadline)
        : std::nullopt;
    std::optional<LayerPropertyKeyframeDetails> after;
    if (after_index.has_value()) {
      after = read_keyframe_details_value(
          stream_suite.get(), keyframe_suite.get(), *resolved, *after_index,
          command.property_locator);
    }
    const bool deleting = command.kind
        == aemcp::native::LayerPropertyKeyframeMutationKind::kDelete;
    const bool count_valid = adding
        ? count_after == count_before + 1
        : deleting ? count_after + 1 == count_before : count_after == count_before;
    const bool state_valid = deleting
        ? !after_index.has_value()
        : after.has_value() && keyframe_time_equal(after->time, command.time);
    bool requested_state_valid = state_valid;
    if (requested_state_valid && after.has_value()) {
      if (adding || command.kind
          == aemcp::native::LayerPropertyKeyframeMutationKind::kSetValue) {
        requested_state_valid = layer_property_values_equal(
            after->value, command.value);
      } else if (command.kind
          == aemcp::native::LayerPropertyKeyframeMutationKind::kSetInterpolation) {
        requested_state_valid = after->in_interpolation == command.in_interpolation
            && after->out_interpolation == command.out_interpolation;
      } else if (command.kind
          == aemcp::native::LayerPropertyKeyframeMutationKind::kSetTemporalEase) {
        requested_state_valid = requested_state_valid
            && after->in_interpolation == "bezier"
            && after->out_interpolation == "bezier";
        for (const auto& dimension : command.temporal_ease) {
          requested_state_valid = requested_state_valid
              && keyframe_dimension_ease_equal(
                  after->temporal_ease[dimension.dimension], dimension);
        }
      } else if (command.kind
          == aemcp::native::LayerPropertyKeyframeMutationKind::kSetBehavior) {
        const bool actual = command.behavior == "temporal-continuous"
            ? after->behavior.temporal_continuous
            : command.behavior == "temporal-auto-bezier"
                ? after->behavior.temporal_auto_bezier
                : command.behavior == "spatial-continuous"
                    ? after->behavior.spatial_continuous
                    : command.behavior == "spatial-auto-bezier"
                        ? after->behavior.spatial_auto_bezier
                        : after->behavior.roving;
        requested_state_valid = actual == command.enabled;
      }
    }
    if (mutation_error != A_Err_NONE || end_error != A_Err_NONE
        || !count_valid || !requested_state_valid
        || std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerPropertyKeyframeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "keyframe may have changed but native readback or Undo validation failed");
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

  [[nodiscard]] HostLayerPropertyWriteResult set_layer_property(
      const aemcp::native::LayerPropertySetCommand& command,
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
    SuiteLease<AEGP_KeyframeSuite5> keyframe_suite(
        basic_, kAEGPKeyframeSuite, kAEGPKeyframeSuiteVersion5);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || memory_suite.get() == nullptr || stream_suite.get() == nullptr
        || dynamic_suite.get() == nullptr || keyframe_suite.get() == nullptr
        || utility_suite.get() == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer property mutation suites are unavailable");
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
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root_item) != A_Err_NONE
        || root_item == nullptr
        || item_suite->AEGP_GetItemID(root_item, &root_id) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project's root item");
    }
    std::optional<std::string> project_path = read_project_path(
        project_suite.get(), memory_suite.get(), project);
    if (!project_path.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not read the open project path for locator identity");
    }
    try {
      graph_.observe_project(
          reinterpret_cast<std::uintptr_t>(project),
          reinterpret_cast<std::uintptr_t>(root_item),
          root_id,
          std::move(*project_path));
    } catch (...) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not establish project locator identity");
    }
    const auto layer_address = graph_.resolve_layer(
        command.layer_locator, command.host_instance_id, command.session_id);
    if (!layer_address.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR",
          "layerLocator does not identify a layer in the currently open project",
          "params.arguments.layerLocator");
    }
    const auto stream_address = graph_.resolve_stream(
        command.property_locator,
        command.layer_locator,
        command.host_instance_id,
        command.session_id);
    if (!stream_address.has_value()) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR",
          "propertyLocator does not identify a property on this layer",
          "params.arguments.propertyLocator");
    }

    AEGP_ItemH item = nullptr;
    if (item_suite->AEGP_GetNextProjItem(project, root_item, &item) != A_Err_NONE) {
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
            "CAPABILITY_FAILED", "project item bound exceeded during composition lookup");
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
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
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
    if (comp_suite->AEGP_GetCompFromItem(composition_item, &composition) != A_Err_NONE
        || composition == nullptr
        || layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE
        || layer == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "STALE_LOCATOR", "layer can no longer be resolved",
          "params.arguments.layerLocator");
    }
    A_Time sample_time{};
    if (layer_suite->AEGP_GetLayerCurrentTime(
            layer, AEGP_LTimeMode_CompTime, &sample_time) != A_Err_NONE
        || sample_time.scale <= 0) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not read a bounded composition sample time");
    }

    AEGP_StreamRefH root_stream = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(
            plugin_id_, layer, &root_stream) != A_Err_NONE
        || root_stream == nullptr) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not resolve the layer property root");
    }
    StreamRefOwner property_stream(stream_suite.get(), root_stream);
    for (std::size_t depth = 0; depth < stream_address->child_indices.size(); ++depth) {
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      A_long child_count = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(
              property_stream.get(), &grouping) != A_Err_NONE
          || grouping == AEGP_StreamGroupingType_LEAF
          || dynamic_suite->AEGP_GetNumStreamsInGroup(
              property_stream.get(), &child_count) != A_Err_NONE
          || stream_address->child_indices[depth] < 0
          || stream_address->child_indices[depth] >= child_count) {
        return HostLayerPropertyWriteResult::failure(
            "STALE_LOCATOR", "property path no longer exists",
            "params.arguments.propertyLocator");
      }
      AEGP_StreamRefH next_stream = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, property_stream.get(), stream_address->child_indices[depth],
              &next_stream) != A_Err_NONE
          || next_stream == nullptr) {
        return HostLayerPropertyWriteResult::failure(
            "STALE_LOCATOR", "property path could not be reacquired",
            "params.arguments.propertyLocator");
      }
      StreamRefOwner next_owner(stream_suite.get(), next_stream);
      std::int32_t unique_id = 0;
      if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id)
              != A_Err_NONE
          || unique_id != stream_address->unique_ids[depth]) {
        return HostLayerPropertyWriteResult::failure(
            "STALE_LOCATOR", "property identity changed",
            "params.arguments.propertyLocator");
      }
      property_stream = std::move(next_owner);
    }
    AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
    AEGP_StreamType type = AEGP_StreamType_NO_DATA;
    A_long keyframe_count = 0;
    A_Boolean time_varying = FALSE;
    if (dynamic_suite->AEGP_GetStreamGroupingType(property_stream.get(), &grouping)
            != A_Err_NONE
        || stream_suite->AEGP_GetStreamType(property_stream.get(), &type) != A_Err_NONE
        || keyframe_suite->AEGP_GetStreamNumKFs(
            property_stream.get(), &keyframe_count) != A_Err_NONE
        || stream_suite->AEGP_IsStreamTimevarying(
            property_stream.get(), &time_varying) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not inspect the target property");
    }
    if (grouping != AEGP_StreamGroupingType_LEAF
        || keyframe_count != 0 || time_varying != FALSE) {
      return HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED",
          "property must be a non-keyframed, non-time-varying leaf stream",
          "params.arguments.propertyLocator");
    }
    if (type != AEGP_StreamType_OneD && type != AEGP_StreamType_TwoD
        && type != AEGP_StreamType_TwoD_SPATIAL && type != AEGP_StreamType_ThreeD
        && type != AEGP_StreamType_ThreeD_SPATIAL && type != AEGP_StreamType_COLOR) {
      return HostLayerPropertyWriteResult::failure(
          "PRECONDITION_FAILED",
          "property is not a supported primitive scalar, vector, or color stream",
          "params.arguments.propertyLocator");
    }
    StreamValueOwner before_owner(stream_suite.get());
    if (stream_suite->AEGP_GetNewStreamValue(
            plugin_id_, property_stream.get(), AEGP_LTimeMode_CompTime,
            &sample_time, FALSE, before_owner.out()) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not sample the property before mutation");
    }
    before_owner.mark_initialized();
    const auto before_value = primitive_stream_value(type, before_owner.value());
    AEGP_StreamValue2 desired = before_owner.value();
    if (!before_value.has_value()
        || !assign_primitive_stream_value(type, command.value, desired)) {
      return HostLayerPropertyWriteResult::failure(
          "INVALID_ARGUMENT", "value does not match the target property's primitive type",
          "params.arguments.value");
    }
    if (primitive_stream_values_equal(type, before_owner.value(), desired)) {
      return HostLayerPropertyWriteResult::failure(
          "INVALID_ARGUMENT", "value already matches the property's sampled value",
          "params.arguments.value");
    }
    if (budget_expired()) {
      return HostLayerPropertyWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer property mutation budget elapsed");
    }

    static constexpr char kUndoLabel[] = "ae-mcp: Set layer property value";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerPropertyWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = stream_suite->AEGP_SetStreamValue(
        plugin_id_, property_stream.get(), &desired);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    StreamValueOwner after_owner(stream_suite.get());
    const A_Err readback_error = stream_suite->AEGP_GetNewStreamValue(
        plugin_id_, property_stream.get(), AEGP_LTimeMode_CompTime,
        &sample_time, FALSE, after_owner.out());
    if (readback_error == A_Err_NONE) after_owner.mark_initialized();
    const auto after_value = readback_error == A_Err_NONE
        ? primitive_stream_value(type, after_owner.value())
        : std::nullopt;
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || readback_error != A_Err_NONE
        || !after_value.has_value()
        || !primitive_stream_values_equal(type, desired, after_owner.value())) {
      return HostLayerPropertyWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "property may have changed but native readback or Undo validation failed");
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

  [[nodiscard]] HostLayerDetailsResult read_layer_details(
      const aemcp::native::LayerDetailsQuery& query,
      TimePoint work_deadline) override {
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
      return HostLayerDetailsResult::failure(
          "NATIVE_UNSUPPORTED", "required layer detail suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), query.layer_locator, query.host_instance_id,
        query.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerDetailsResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto details = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        query.host_instance_id, query.session_id);
    if (!details.has_value() || details->layer_locator != query.layer_locator) {
      return HostLayerDetailsResult::failure(
          "CAPABILITY_FAILED", "could not read complete layer details");
    }
    return HostLayerDetailsResult::success(*details);
  }

  [[nodiscard]] HostLayerNameWriteResult set_layer_name(
      const aemcp::native::LayerNameSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerNameWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer name suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    const auto utf16_name = utf16_layer_name(command.name);
    if (!resolved.has_value()) {
      return HostLayerNameWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (!utf16_name.has_value() || !before.has_value()) {
      return HostLayerNameWriteResult::failure(
          "CAPABILITY_FAILED", "could not validate layer name mutation");
    }
    if (before->name == command.name) {
      return HostLayerNameWriteResult::failure(
          "INVALID_ARGUMENT", "layer name already matches the requested value",
          "params.arguments.name");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerNameWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer name mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer name";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerNameWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerName(
        resolved->layer, utf16_name->data());
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value() || after->name != command.name) {
      return HostLayerNameWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer name may have changed but readback or Undo close failed");
    }
    return HostLayerNameWriteResult::success({
        true, command.layer_locator, before->name, after->name});
  }

  [[nodiscard]] HostLayerRangeWriteResult set_layer_range(
      const aemcp::native::LayerRangeSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerRangeWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer range suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerRangeWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    const auto equal_time = [](const CompositionCurrentTime& left,
                               const CompositionCurrentTime& right) {
      return static_cast<std::int64_t>(left.value) * right.scale
          == static_cast<std::int64_t>(right.value) * left.scale;
    };
    if (!before.has_value()) {
      return HostLayerRangeWriteResult::failure(
          "CAPABILITY_FAILED", "could not read layer range before mutation");
    }
    if (equal_time(before->in_point, command.in_point)
        && equal_time(before->duration, command.duration)) {
      return HostLayerRangeWriteResult::failure(
          "INVALID_ARGUMENT", "layer range already matches the requested value",
          "params.arguments");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerRangeWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer range mutation budget elapsed");
    }
    const A_Time target_in{
        static_cast<A_long>(command.in_point.value),
        static_cast<A_u_long>(command.in_point.scale)};
    const A_Time target_duration{
        static_cast<A_long>(command.duration.value),
        static_cast<A_u_long>(command.duration.scale)};
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer range";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerRangeWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerInPointAndDuration(
        resolved->layer, AEGP_LTimeMode_CompTime, &target_in, &target_duration);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value() || !equal_time(after->in_point, command.in_point)
        || !equal_time(after->duration, command.duration)) {
      return HostLayerRangeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer range may have changed but readback or Undo close failed");
    }
    return HostLayerRangeWriteResult::success({
        true,
        command.layer_locator,
        before->in_point,
        before->duration,
        after->in_point,
        after->duration});
  }

  [[nodiscard]] HostLayerStartTimeWriteResult set_layer_start_time(
      const aemcp::native::LayerStartTimeSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerStartTimeWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer start-time suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerStartTimeWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    const auto equal_time = [](const CompositionCurrentTime& left,
                               const CompositionCurrentTime& right) {
      return static_cast<std::int64_t>(left.value) * right.scale
          == static_cast<std::int64_t>(right.value) * left.scale;
    };
    if (!before.has_value()) {
      return HostLayerStartTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not read layer start time before mutation");
    }
    if (equal_time(before->start_time, command.start_time)) {
      return HostLayerStartTimeWriteResult::failure(
          "INVALID_ARGUMENT", "layer start time already matches the requested value",
          "params.arguments.startTime");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerStartTimeWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer start-time mutation budget elapsed");
    }
    const A_Time target{
        static_cast<A_long>(command.start_time.value),
        static_cast<A_u_long>(command.start_time.scale)};
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer start time";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerStartTimeWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerOffset(
        resolved->layer, &target);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value() || !equal_time(after->start_time, command.start_time)) {
      return HostLayerStartTimeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer start time may have changed but readback or Undo close failed");
    }
    return HostLayerStartTimeWriteResult::success({
        true, command.layer_locator, before->start_time, after->start_time});
  }

  [[nodiscard]] HostLayerStretchWriteResult set_layer_stretch(
      const aemcp::native::LayerStretchSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerStretchWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer stretch suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerStretchWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (!before.has_value()) {
      return HostLayerStretchWriteResult::failure(
          "CAPABILITY_FAILED", "could not read layer stretch before mutation");
    }
    const auto ratio_equal = [](const aemcp::native::LayerStretchRatio& left,
                                const aemcp::native::LayerStretchRatio& right) {
      return static_cast<std::int64_t>(left.numerator) * right.denominator
          == static_cast<std::int64_t>(right.numerator) * left.denominator;
    };
    if (ratio_equal(before->stretch, command.stretch)) {
      return HostLayerStretchWriteResult::failure(
          "INVALID_ARGUMENT", "layer stretch already matches the requested ratio",
          "params.arguments.stretch");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerStretchWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer stretch mutation budget elapsed");
    }
    const A_Ratio target{
        static_cast<A_long>(command.stretch.numerator),
        static_cast<A_u_long>(command.stretch.denominator)};
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer stretch";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerStretchWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerStretch(
        resolved->layer, &target);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value() || !ratio_equal(after->stretch, command.stretch)) {
      return HostLayerStretchWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer stretch may have changed but readback or Undo close failed");
    }
    return HostLayerStretchWriteResult::success({
        true, command.layer_locator, before->stretch, after->stretch});
  }

  [[nodiscard]] HostLayerOrderWriteResult set_layer_order(
      const aemcp::native::LayerOrderSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerOrderWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer order suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerOrderWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    A_long layer_count = 0;
    if (!before.has_value()
        || layer_suite->AEGP_GetCompNumLayers(
            resolved->composition, &layer_count) != A_Err_NONE
        || layer_count < 1) {
      return HostLayerOrderWriteResult::failure(
          "CAPABILITY_FAILED", "could not read layer order before mutation");
    }
    if (command.target_stack_index > static_cast<std::uint64_t>(layer_count)) {
      return HostLayerOrderWriteResult::failure(
          "INVALID_ARGUMENT", "targetStackIndex exceeds the composition layer count",
          "params.arguments.targetStackIndex");
    }
    if (before->stack_index == command.target_stack_index) {
      return HostLayerOrderWriteResult::failure(
          "INVALID_ARGUMENT", "layer already occupies the requested stack index",
          "params.arguments.targetStackIndex");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerOrderWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer order mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Reorder layer";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerOrderWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_ReorderLayer(
        resolved->layer, static_cast<A_long>(command.target_stack_index - 1U));
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value()
        || after->stack_index != command.target_stack_index) {
      return HostLayerOrderWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer order may have changed but readback or Undo close failed");
    }
    return HostLayerOrderWriteResult::success({
        true, command.layer_locator, before->stack_index, after->stack_index});
  }

  [[nodiscard]] HostLayerParentWriteResult set_layer_parent(
      const aemcp::native::LayerParentSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerParentWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer parent suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerParentWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (!before.has_value()) {
      return HostLayerParentWriteResult::failure(
          "CAPABILITY_FAILED", "could not read layer parent before mutation");
    }
    if (before->parent_locator == command.parent_layer_locator) {
      return HostLayerParentWriteResult::failure(
          "INVALID_ARGUMENT", "layer parent already matches the requested value",
          "params.arguments.parentLayerLocator");
    }
    AEGP_LayerH target_parent = nullptr;
    if (command.parent_layer_locator.has_value()) {
      const auto parent = resolve_layer(
          project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
          memory_suite.get(), *command.parent_layer_locator,
          command.host_instance_id, command.session_id, work_deadline);
      if (!parent.has_value()) {
        return HostLayerParentWriteResult::failure(
            "STALE_LOCATOR", "parentLayerLocator does not identify a current layer",
            "params.arguments.parentLayerLocator");
      }
      if (parent->composition_item_id != resolved->composition_item_id) {
        return HostLayerParentWriteResult::failure(
            "PRECONDITION_FAILED",
            "parentLayerLocator must identify a layer in the same composition",
            "params.arguments.parentLayerLocator");
      }
      if (parent->layer == resolved->layer) {
        return HostLayerParentWriteResult::failure(
            "INVALID_ARGUMENT",
            "parentLayerLocator must identify a distinct layer",
            "params.arguments.parentLayerLocator");
      }
      target_parent = parent->layer;
      A_long layer_count = 0;
      if (layer_suite->AEGP_GetCompNumLayers(
              resolved->composition, &layer_count) != A_Err_NONE
          || layer_count < 1) {
        return HostLayerParentWriteResult::failure(
            "CAPABILITY_FAILED", "could not validate the parent chain");
      }
      AEGP_LayerH cursor = target_parent;
      for (A_long depth = 0; cursor != nullptr && depth <= layer_count; ++depth) {
        if (cursor == resolved->layer) {
          return HostLayerParentWriteResult::failure(
              "INVALID_ARGUMENT", "parent assignment would create a cycle",
              "params.arguments.parentLayerLocator");
        }
        AEGP_LayerH next = nullptr;
        if (layer_suite->AEGP_GetLayerParent(cursor, &next) != A_Err_NONE) {
          return HostLayerParentWriteResult::failure(
              "CAPABILITY_FAILED", "could not validate the parent chain");
        }
        cursor = next;
      }
      if (cursor != nullptr) {
        return HostLayerParentWriteResult::failure(
            "CAPABILITY_FAILED", "parent chain exceeded the composition layer bound");
      }
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerParentWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer parent mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer parent";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerParentWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerParent(
        resolved->layer, target_parent);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value()
        || after->parent_locator != command.parent_layer_locator) {
      return HostLayerParentWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer parent may have changed but readback or Undo close failed");
    }
    return HostLayerParentWriteResult::success({
        true,
        command.layer_locator,
        before->parent_locator,
        after->parent_locator});
  }

  [[nodiscard]] HostLayerDuplicateResult duplicate_layer(
      const aemcp::native::LayerDuplicateCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerDuplicateResult::failure(
          "NATIVE_UNSUPPORTED", "required layer duplicate suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    const auto utf16_name = utf16_layer_name(command.new_name);
    A_long count_before = 0;
    if (!resolved.has_value()) {
      return HostLayerDuplicateResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    if (!utf16_name.has_value()
        || layer_suite->AEGP_GetCompNumLayers(
            resolved->composition, &count_before) != A_Err_NONE
        || count_before < 1) {
      return HostLayerDuplicateResult::failure(
          "CAPABILITY_FAILED", "could not validate layer duplication inputs");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerDuplicateResult::failure(
          "DEADLINE_EXCEEDED", "layer duplication budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Duplicate layer";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerDuplicateResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    AEGP_LayerH duplicate = nullptr;
    const A_Err duplicate_error = layer_suite->AEGP_DuplicateLayer(
        resolved->layer, &duplicate);
    const A_Err name_error = duplicate_error == A_Err_NONE && duplicate != nullptr
        ? layer_suite->AEGP_SetLayerName(duplicate, utf16_name->data())
        : A_Err_GENERIC;
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    A_long count_after = 0;
    AEGP_LayerIDVal duplicate_id = 0;
    if (duplicate_error != A_Err_NONE || duplicate == nullptr
        || name_error != A_Err_NONE || end_error != A_Err_NONE
        || layer_suite->AEGP_GetLayerID(duplicate, &duplicate_id) != A_Err_NONE
        || layer_suite->AEGP_GetCompNumLayers(
            resolved->composition, &count_after) != A_Err_NONE
        || count_after != count_before + 1) {
      return HostLayerDuplicateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer may have duplicated but creation, rename, count, or Undo close failed");
    }
    bool invalidated = false;
    try {
      invalidated = graph_.invalidate_project();
    } catch (...) {
      invalidated = false;
    }
    if (!invalidated) {
      return HostLayerDuplicateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer duplicated but fresh locator generation failed");
    }
    const ObjectLocator fresh_source = graph_.layer_locator(
        resolved->composition_item_id, resolved->layer_id,
        command.host_instance_id, command.session_id,
        command.layer_locator.object_id);
    const ObjectLocator fresh_new = graph_.layer_locator(
        resolved->composition_item_id, duplicate_id,
        command.host_instance_id, command.session_id);
    const ObjectLocator fresh_composition = graph_.item_locator(
        resolved->composition_item_id, true,
        command.host_instance_id, command.session_id);
    const auto fresh_source_details = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), *resolved,
        command.host_instance_id, command.session_id);
    ResolvedLayer new_resolved = *resolved;
    new_resolved.layer_id = duplicate_id;
    new_resolved.layer = duplicate;
    const auto new_details = read_layer_details_value(
        item_suite.get(), layer_suite.get(), memory_suite.get(), new_resolved,
        command.host_instance_id, command.session_id);
    const auto stable_semantics_match = [](const LayerDetails& source,
                                           const LayerDetails& copied) {
      const auto time_equal = [](const CompositionCurrentTime& left,
                                 const CompositionCurrentTime& right) {
        return static_cast<std::int64_t>(left.value) * right.scale
            == static_cast<std::int64_t>(right.value) * left.scale;
      };
      const auto stretch_equal = [](const aemcp::native::LayerStretchRatio& left,
                                    const aemcp::native::LayerStretchRatio& right) {
        return static_cast<std::int64_t>(left.numerator) * right.denominator
            == static_cast<std::int64_t>(right.numerator) * left.denominator;
      };
      return source.composition_locator == copied.composition_locator
          && source.type == copied.type
          && source.video_enabled == copied.video_enabled
          && source.is_three_d == copied.is_three_d
          && source.locked == copied.locked
          && source.parent_locator == copied.parent_locator
          && source.source_item_locator == copied.source_item_locator
          && time_equal(source.in_point, copied.in_point)
          && time_equal(source.duration, copied.duration)
          && time_equal(source.start_time, copied.start_time)
          && stretch_equal(source.stretch, copied.stretch);
    };
    if (!fresh_source_details.has_value() || !new_details.has_value()
        || fresh_source_details->layer_locator != fresh_source
        || fresh_source_details->composition_locator != fresh_composition
        || new_details->name != command.new_name
        || new_details->layer_locator != fresh_new
        || new_details->composition_locator != fresh_composition
        || !stable_semantics_match(*fresh_source_details, *new_details)
        || std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerDuplicateResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "duplicated layer did not preserve fresh-source stable semantics");
    }
    LayerDuplicated result;
    result.source_layer_locator = fresh_source;
    result.new_layer_locator = fresh_new;
    result.composition_locator = fresh_composition;
    result.layer_count_before = static_cast<std::uint64_t>(count_before);
    result.layer_count_after = static_cast<std::uint64_t>(count_after);
    result.new_layer = *new_details;
    result.source_layer = *fresh_source_details;
    return HostLayerDuplicateResult::success(std::move(result));
  }

  [[nodiscard]] HostLayerCompositingReadResult read_layer_compositing(
      const aemcp::native::LayerDetailsQuery& query,
      TimePoint work_deadline) override {
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
      return HostLayerCompositingReadResult::failure(
          "NATIVE_UNSUPPORTED", "required layer compositing suites are unavailable");
    }
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), query.layer_locator, query.host_instance_id,
        query.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerCompositingReadResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    std::string diagnostic;
    const auto value = read_layer_compositing_value(
        layer_suite.get(), *resolved, query.host_instance_id, query.session_id,
        &diagnostic);
    if (!value.has_value() || value->layer_locator != query.layer_locator) {
      return HostLayerCompositingReadResult::failure(
          "CAPABILITY_FAILED",
          diagnostic.empty()
              ? "could not read complete layer compositing state"
              : "could not read complete layer compositing state: " + diagnostic);
    }
    return HostLayerCompositingReadResult::success(*value);
  }

  [[nodiscard]] HostLayerSwitchWriteResult set_layer_switch(
      const aemcp::native::LayerSwitchSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerSwitchWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer switch suites are unavailable");
    }
    const auto flag = layer_switch_flag(command.switch_name);
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerSwitchWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before_enabled = flag.has_value()
        ? read_layer_switch_value(layer_suite.get(), resolved->layer, *flag)
        : std::nullopt;
    if (!flag.has_value() || !before_enabled.has_value()) {
      return HostLayerSwitchWriteResult::failure(
          "CAPABILITY_FAILED", "could not validate layer switch mutation");
    }
    if (*before_enabled == command.enabled) {
      return HostLayerSwitchWriteResult::failure(
          "INVALID_ARGUMENT", "layer switch already matches the requested value",
          "params.arguments.enabled");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerSwitchWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer switch mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer switch";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerSwitchWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerFlag(
        resolved->layer, *flag, command.enabled ? TRUE : FALSE);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after_enabled = read_layer_switch_value(
        layer_suite.get(), resolved->layer, *flag);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after_enabled.has_value() || *after_enabled != command.enabled) {
      return HostLayerSwitchWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer switch may have changed but readback or Undo close failed");
    }
    return HostLayerSwitchWriteResult::success(
        {true, command.layer_locator, command.switch_name,
         *before_enabled, *after_enabled});
  }

  [[nodiscard]] HostLayerQualityWriteResult set_layer_quality(
      const aemcp::native::LayerQualitySetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerQualityWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer quality suites are unavailable");
    }
    const auto target = layer_quality_value(command.quality);
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerQualityWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    const auto before_quality = read_layer_quality_value(
        layer_suite.get(), resolved->layer);
    if (!target.has_value() || !before_quality.has_value()) {
      return HostLayerQualityWriteResult::failure(
          "CAPABILITY_FAILED", "could not validate layer quality mutation");
    }
    if (*before_quality == command.quality) {
      return HostLayerQualityWriteResult::failure(
          "INVALID_ARGUMENT", "layer quality already matches the requested value",
          "params.arguments.quality");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerQualityWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer quality mutation budget elapsed");
    }
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer quality";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerQualityWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerQuality(resolved->layer, *target);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after_quality = read_layer_quality_value(
        layer_suite.get(), resolved->layer);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after_quality.has_value() || *after_quality != command.quality) {
      return HostLayerQualityWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer quality may have changed but readback or Undo close failed");
    }
    return HostLayerQualityWriteResult::success(
        {true, command.layer_locator, *before_quality, *after_quality});
  }

  [[nodiscard]] HostLayerBlendingModeWriteResult set_layer_blending_mode(
      const aemcp::native::LayerBlendingModeSetCommand& command,
      TimePoint work_deadline) override {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_CompSuite12> comp_suite(
        basic_, kAEGPCompSuite, kAEGPCompSuiteVersion12);
    SuiteLease<AEGP_LayerSuite9> layer_suite(
        basic_, kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || comp_suite.get() == nullptr || layer_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostLayerBlendingModeWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required layer blending suites are unavailable");
    }
    const auto target = layer_blending_mode_value(command.mode);
    const auto resolved = resolve_layer(
        project_suite.get(), item_suite.get(), comp_suite.get(), layer_suite.get(),
        memory_suite.get(), command.layer_locator, command.host_instance_id,
        command.session_id, work_deadline);
    if (!resolved.has_value()) {
      return HostLayerBlendingModeWriteResult::failure(
          "STALE_LOCATOR", "layerLocator does not identify a current layer",
          "params.arguments.layerLocator");
    }
    AEGP_LayerTransferMode transfer{};
    if (!target.has_value()
        || layer_suite->AEGP_GetLayerTransferMode(resolved->layer, &transfer)
            != A_Err_NONE) {
      return HostLayerBlendingModeWriteResult::failure(
          "CAPABILITY_FAILED", "could not validate layer blending-mode mutation");
    }
    const auto before_mode = layer_blending_mode_name(transfer.mode);
    const auto before_matte = layer_track_matte_name(transfer.track_matte);
    const bool before_preserve_alpha =
        (transfer.flags & AEGP_TransferFlag_PRESERVE_ALPHA) != 0;
    if (!before_mode.has_value() || !before_matte.has_value()) {
      return HostLayerBlendingModeWriteResult::failure(
          "CAPABILITY_FAILED", "could not classify current layer transfer mode");
    }
    if (*before_mode == command.mode) {
      return HostLayerBlendingModeWriteResult::failure(
          "INVALID_ARGUMENT", "layer blending mode already matches the requested value",
          "params.arguments.mode");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostLayerBlendingModeWriteResult::failure(
          "DEADLINE_EXCEEDED", "layer blending-mode mutation budget elapsed");
    }
    transfer.mode = *target;
    static constexpr char kUndoLabel[] = "ae-mcp: Set layer blending mode";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostLayerBlendingModeWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = layer_suite->AEGP_SetLayerTransferMode(
        resolved->layer, &transfer);
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    AEGP_LayerTransferMode after_transfer{};
    const A_Err readback_error = layer_suite->AEGP_GetLayerTransferMode(
        resolved->layer, &after_transfer);
    const auto after_mode = readback_error == A_Err_NONE
        ? layer_blending_mode_name(after_transfer.mode) : std::nullopt;
    const auto after_matte = readback_error == A_Err_NONE
        ? layer_track_matte_name(after_transfer.track_matte) : std::nullopt;
    const bool after_preserve_alpha =
        (after_transfer.flags & AEGP_TransferFlag_PRESERVE_ALPHA) != 0;
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || readback_error != A_Err_NONE || !after_mode.has_value()
        || !after_matte.has_value() || *after_mode != command.mode
        || after_preserve_alpha != before_preserve_alpha
        || *after_matte != *before_matte) {
      return HostLayerBlendingModeWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "layer blending mode may have changed but readback, preserved fields, or Undo close failed");
    }
    return HostLayerBlendingModeWriteResult::success({
        true, command.layer_locator, *before_mode, *after_mode,
        after_preserve_alpha, *after_matte});
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

  [[nodiscard]] static std::optional<AEGP_LayerFlags> layer_switch_flag(
      std::string_view name) {
    if (name == "visibility") return AEGP_LayerFlag_VIDEO_ACTIVE;
    if (name == "solo") return AEGP_LayerFlag_SOLO;
    if (name == "locked") return AEGP_LayerFlag_LOCKED;
    if (name == "shy") return AEGP_LayerFlag_SHY;
    if (name == "motion-blur") return AEGP_LayerFlag_MOTION_BLUR;
    if (name == "three-d") return AEGP_LayerFlag_LAYER_IS_3D;
    if (name == "adjustment") return AEGP_LayerFlag_ADJUSTMENT_LAYER;
    return std::nullopt;
  }

  [[nodiscard]] static std::optional<bool> read_layer_switch_value(
      const AEGP_LayerSuite9* layer_suite,
      AEGP_LayerH layer,
      AEGP_LayerFlags flag) {
    if (layer_suite == nullptr || layer == nullptr) return std::nullopt;
    AEGP_LayerFlags flags = 0;
    if (layer_suite->AEGP_GetLayerFlags(layer, &flags) != A_Err_NONE) {
      return std::nullopt;
    }
    return (flags & flag) != 0;
  }

  [[nodiscard]] static std::optional<std::string> layer_quality_name(
      AEGP_LayerQuality quality) {
    if (quality == AEGP_LayerQual_WIREFRAME) return "wireframe";
    if (quality == AEGP_LayerQual_DRAFT) return "draft";
    if (quality == AEGP_LayerQual_BEST) return "best";
    return std::nullopt;
  }

  [[nodiscard]] static std::optional<AEGP_LayerQuality> layer_quality_value(
      std::string_view quality) {
    if (quality == "wireframe") return AEGP_LayerQual_WIREFRAME;
    if (quality == "draft") return AEGP_LayerQual_DRAFT;
    if (quality == "best") return AEGP_LayerQual_BEST;
    return std::nullopt;
  }

  [[nodiscard]] static std::optional<std::string> read_layer_quality_value(
      const AEGP_LayerSuite9* layer_suite,
      AEGP_LayerH layer) {
    if (layer_suite == nullptr || layer == nullptr) return std::nullopt;
    AEGP_LayerQuality quality = AEGP_LayerQual_NONE;
    if (layer_suite->AEGP_GetLayerQuality(layer, &quality) != A_Err_NONE) {
      return std::nullopt;
    }
    return layer_quality_name(quality);
  }

  [[nodiscard]] static std::optional<std::string> layer_blending_mode_name(
      PF_TransferMode mode) {
    switch (mode) {
      case PF_Xfer_COPY: return "normal";
      case PF_Xfer_DISSOLVE: return "dissolve";
      case PF_Xfer_ADD: return "add";
      case PF_Xfer_MULTIPLY: return "multiply";
      case PF_Xfer_SCREEN: return "screen";
      case PF_Xfer_OVERLAY: return "overlay";
      case PF_Xfer_SOFT_LIGHT: return "soft-light";
      case PF_Xfer_HARD_LIGHT: return "hard-light";
      case PF_Xfer_DARKEN: return "darken";
      case PF_Xfer_LIGHTEN: return "lighten";
      case PF_Xfer_DIFFERENCE2: return "difference";
      case PF_Xfer_HUE: return "hue";
      case PF_Xfer_SATURATION: return "saturation";
      case PF_Xfer_COLOR: return "color";
      case PF_Xfer_LUMINOSITY: return "luminosity";
      case PF_Xfer_COLOR_DODGE2: return "color-dodge";
      case PF_Xfer_COLOR_BURN2: return "color-burn";
      case PF_Xfer_EXCLUSION: return "exclusion";
      case PF_Xfer_LINEAR_DODGE: return "linear-dodge";
      case PF_Xfer_LINEAR_BURN: return "linear-burn";
      case PF_Xfer_LINEAR_LIGHT: return "linear-light";
      case PF_Xfer_VIVID_LIGHT: return "vivid-light";
      case PF_Xfer_PIN_LIGHT: return "pin-light";
      case PF_Xfer_HARD_MIX: return "hard-mix";
      case PF_Xfer_LIGHTER_COLOR: return "lighter-color";
      case PF_Xfer_DARKER_COLOR: return "darker-color";
      case PF_Xfer_SUBTRACT: return "subtract";
      case PF_Xfer_DIVIDE: return "divide";
      default: return std::nullopt;
    }
  }

  [[nodiscard]] static std::optional<PF_TransferMode> layer_blending_mode_value(
      std::string_view mode) {
    if (mode == "normal") return PF_Xfer_COPY;
    if (mode == "dissolve") return PF_Xfer_DISSOLVE;
    if (mode == "add") return PF_Xfer_ADD;
    if (mode == "multiply") return PF_Xfer_MULTIPLY;
    if (mode == "screen") return PF_Xfer_SCREEN;
    if (mode == "overlay") return PF_Xfer_OVERLAY;
    if (mode == "soft-light") return PF_Xfer_SOFT_LIGHT;
    if (mode == "hard-light") return PF_Xfer_HARD_LIGHT;
    if (mode == "darken") return PF_Xfer_DARKEN;
    if (mode == "lighten") return PF_Xfer_LIGHTEN;
    if (mode == "difference") return PF_Xfer_DIFFERENCE2;
    if (mode == "hue") return PF_Xfer_HUE;
    if (mode == "saturation") return PF_Xfer_SATURATION;
    if (mode == "color") return PF_Xfer_COLOR;
    if (mode == "luminosity") return PF_Xfer_LUMINOSITY;
    if (mode == "color-dodge") return PF_Xfer_COLOR_DODGE2;
    if (mode == "color-burn") return PF_Xfer_COLOR_BURN2;
    if (mode == "exclusion") return PF_Xfer_EXCLUSION;
    if (mode == "linear-dodge") return PF_Xfer_LINEAR_DODGE;
    if (mode == "linear-burn") return PF_Xfer_LINEAR_BURN;
    if (mode == "linear-light") return PF_Xfer_LINEAR_LIGHT;
    if (mode == "vivid-light") return PF_Xfer_VIVID_LIGHT;
    if (mode == "pin-light") return PF_Xfer_PIN_LIGHT;
    if (mode == "hard-mix") return PF_Xfer_HARD_MIX;
    if (mode == "lighter-color") return PF_Xfer_LIGHTER_COLOR;
    if (mode == "darker-color") return PF_Xfer_DARKER_COLOR;
    if (mode == "subtract") return PF_Xfer_SUBTRACT;
    if (mode == "divide") return PF_Xfer_DIVIDE;
    return std::nullopt;
  }

  [[nodiscard]] static std::optional<std::string> layer_track_matte_name(
      AEGP_TrackMatte matte) {
    if (matte == AEGP_TrackMatte_NO_TRACK_MATTE) return "none";
    if (matte == AEGP_TrackMatte_ALPHA) return "alpha";
    if (matte == AEGP_TrackMatte_NOT_ALPHA) return "inverted-alpha";
    if (matte == AEGP_TrackMatte_LUMA) return "luma";
    if (matte == AEGP_TrackMatte_NOT_LUMA) return "inverted-luma";
    return std::nullopt;
  }

  [[nodiscard]] std::optional<LayerCompositingState>
      read_layer_compositing_value(
          const AEGP_LayerSuite9* layer_suite,
          const ResolvedLayer& resolved,
          std::string_view host,
          std::string_view session,
          std::string* diagnostic = nullptr) {
    const auto fail = [diagnostic](std::string message) {
      if (diagnostic != nullptr) *diagnostic = std::move(message);
      return std::optional<LayerCompositingState>{};
    };
    if (layer_suite == nullptr) return fail("layer suite is unavailable");
    AEGP_LayerFlags flags = 0;
    AEGP_LayerQuality quality = AEGP_LayerQual_NONE;
    AEGP_LayerTransferMode transfer{};
    const A_Err flags_error = layer_suite->AEGP_GetLayerFlags(resolved.layer, &flags);
    if (flags_error != A_Err_NONE) {
      return fail("AEGP_GetLayerFlags failed with error "
          + std::to_string(static_cast<long>(flags_error)));
    }
    const A_Err quality_error =
        layer_suite->AEGP_GetLayerQuality(resolved.layer, &quality);
    if (quality_error != A_Err_NONE) {
      return fail("AEGP_GetLayerQuality failed with error "
          + std::to_string(static_cast<long>(quality_error)));
    }
    const A_Err transfer_error =
        layer_suite->AEGP_GetLayerTransferMode(resolved.layer, &transfer);
    if (transfer_error != A_Err_NONE) {
      return fail("AEGP_GetLayerTransferMode failed with error "
          + std::to_string(static_cast<long>(transfer_error)));
    }
    const auto quality_name = layer_quality_name(quality);
    const auto mode_name = layer_blending_mode_name(transfer.mode);
    const auto matte_name = layer_track_matte_name(transfer.track_matte);
    if (!quality_name.has_value()) {
      return fail("unsupported layer quality value "
          + std::to_string(static_cast<long>(quality)));
    }
    if (!mode_name.has_value()) {
      return fail("unsupported transfer mode value "
          + std::to_string(static_cast<long>(transfer.mode)));
    }
    if (!matte_name.has_value()) {
      return fail("unsupported track matte value "
          + std::to_string(static_cast<long>(transfer.track_matte)));
    }
    return LayerCompositingState{
        graph_.layer_locator(
            resolved.composition_item_id, resolved.layer_id, host, session),
        (flags & AEGP_LayerFlag_VIDEO_ACTIVE) != 0,
        (flags & AEGP_LayerFlag_SOLO) != 0,
        (flags & AEGP_LayerFlag_LOCKED) != 0,
        (flags & AEGP_LayerFlag_SHY) != 0,
        (flags & AEGP_LayerFlag_MOTION_BLUR) != 0,
        (flags & AEGP_LayerFlag_LAYER_IS_3D) != 0,
        (flags & AEGP_LayerFlag_ADJUSTMENT_LAYER) != 0,
        *quality_name,
        *mode_name,
        (transfer.flags & AEGP_TransferFlag_PRESERVE_ALPHA) != 0,
        *matte_name};
  }

  struct ResolvedProperty {
    ResolvedLayer layer;
    StreamRefOwner stream;
    AEGP_StreamType type{AEGP_StreamType_NO_DATA};
    A_short temporal_dimensions{0};
    A_long keyframe_count{0};

    ResolvedProperty(
        ResolvedLayer resolved_layer,
        StreamRefOwner resolved_stream,
        AEGP_StreamType stream_type,
        A_short dimensions,
        A_long count)
        : layer(std::move(resolved_layer)),
          stream(std::move(resolved_stream)),
          type(stream_type),
          temporal_dimensions(dimensions),
          keyframe_count(count) {}
  };

  [[nodiscard]] std::optional<OpenProject> observe_open_project(
      const AEGP_ProjSuite6* project_suite,
      const AEGP_ItemSuite9* item_suite,
      const AEGP_MemorySuite1* memory_suite) {
    if (project_suite == nullptr || item_suite == nullptr || memory_suite == nullptr) {
      return std::nullopt;
    }
    A_long project_count = 0;
    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    A_long root_id = 0;
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE
        || project_count <= 0
        || project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE
        || root == nullptr
        || item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE) {
      if (project_count <= 0) graph_.project_closed();
      return std::nullopt;
    }
    std::optional<std::string> path = read_project_path(
        project_suite, memory_suite, project);
    if (!path.has_value()) return std::nullopt;
    graph_.observe_project(
        reinterpret_cast<std::uintptr_t>(project),
        reinterpret_cast<std::uintptr_t>(root),
        root_id,
        std::move(*path));
    return OpenProject{project, root};
  }

  [[nodiscard]] static std::optional<AEGP_ItemH> find_project_item(
      const AEGP_ItemSuite9* item_suite,
      AEGP_ProjectH project,
      AEGP_ItemH root,
      A_long wanted_id,
      TimePoint deadline) {
    AEGP_ItemH item = nullptr;
    if (item_suite == nullptr
        || item_suite->AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return std::nullopt;
    }
    std::size_t visited = 0;
    while (item != nullptr) {
      if (std::chrono::steady_clock::now() >= deadline
          || ++visited > static_cast<std::size_t>(kMaximumProjectItems)) {
        return std::nullopt;
      }
      A_long item_id = 0;
      if (item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE) {
        return std::nullopt;
      }
      if (item_id == wanted_id) return item;
      AEGP_ItemH next = nullptr;
      if (item_suite->AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return std::nullopt;
      }
      item = next;
    }
    return std::nullopt;
  }

  [[nodiscard]] std::optional<ResolvedLayer> resolve_layer(
      const AEGP_ProjSuite6* project_suite,
      const AEGP_ItemSuite9* item_suite,
      const AEGP_CompSuite12* comp_suite,
      const AEGP_LayerSuite9* layer_suite,
      const AEGP_MemorySuite1* memory_suite,
      const ObjectLocator& locator,
      std::string_view host,
      std::string_view session,
      TimePoint deadline) {
    const auto open = observe_open_project(project_suite, item_suite, memory_suite);
    const auto address = graph_.resolve_layer(locator, host, session);
    if (!open.has_value() || !address.has_value()) return std::nullopt;
    const auto item = find_project_item(
        item_suite, open->project, open->root,
        address->composition_item_id, deadline);
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (!item.has_value()
        || comp_suite->AEGP_GetCompFromItem(*item, &composition) != A_Err_NONE
        || composition == nullptr
        || layer_suite->AEGP_GetLayerFromLayerID(
            composition, address->layer_id, &layer) != A_Err_NONE
        || layer == nullptr) {
      return std::nullopt;
    }
    return ResolvedLayer{
        *open,
        address->composition_item_id,
        address->layer_id,
        *item,
        composition,
        layer};
  }

  [[nodiscard]] std::optional<ResolvedProperty> resolve_keyframe_property(
      const AEGP_ProjSuite6* project_suite,
      const AEGP_ItemSuite9* item_suite,
      const AEGP_CompSuite12* comp_suite,
      const AEGP_LayerSuite9* layer_suite,
      const AEGP_MemorySuite1* memory_suite,
      const AEGP_StreamSuite6* stream_suite,
      const AEGP_DynamicStreamSuite4* dynamic_suite,
      const AEGP_KeyframeSuite5* keyframe_suite,
      const ObjectLocator& property_locator,
      const std::optional<ObjectLocator>& expected_layer_locator,
      std::string_view host,
      std::string_view session,
      TimePoint deadline) {
    if (stream_suite == nullptr || dynamic_suite == nullptr
        || keyframe_suite == nullptr) return std::nullopt;
    const auto open = observe_open_project(project_suite, item_suite, memory_suite);
    const auto stream_address = graph_.resolve_stream(property_locator, host, session);
    if (!open.has_value() || !stream_address.has_value()) return std::nullopt;
    const auto layer_address = graph_.resolve_layer_object(
        stream_address->layer_object_id);
    if (!layer_address.has_value()) return std::nullopt;
    const auto composition_item = find_project_item(
        item_suite, open->project, open->root,
        layer_address->composition_item_id, deadline);
    AEGP_CompH composition = nullptr;
    AEGP_LayerH layer = nullptr;
    if (!composition_item.has_value()
        || comp_suite->AEGP_GetCompFromItem(*composition_item, &composition)
            != A_Err_NONE
        || composition == nullptr
        || layer_suite->AEGP_GetLayerFromLayerID(
            composition, layer_address->layer_id, &layer) != A_Err_NONE
        || layer == nullptr) {
      return std::nullopt;
    }
    const ObjectLocator actual_layer_locator = graph_.layer_locator(
        layer_address->composition_item_id, layer_address->layer_id, host, session);
    if (expected_layer_locator.has_value()
        && *expected_layer_locator != actual_layer_locator) return std::nullopt;

    AEGP_StreamRefH root = nullptr;
    if (dynamic_suite->AEGP_GetNewStreamRefForLayer(plugin_id_, layer, &root)
            != A_Err_NONE
        || root == nullptr) return std::nullopt;
    StreamRefOwner stream(stream_suite, root);
    for (std::size_t depth = 0; depth < stream_address->child_indices.size(); ++depth) {
      if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
      AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
      A_long child_count = 0;
      if (dynamic_suite->AEGP_GetStreamGroupingType(stream.get(), &grouping)
              != A_Err_NONE
          || grouping == AEGP_StreamGroupingType_LEAF
          || dynamic_suite->AEGP_GetNumStreamsInGroup(stream.get(), &child_count)
              != A_Err_NONE
          || stream_address->child_indices[depth] < 0
          || stream_address->child_indices[depth] >= child_count) {
        return std::nullopt;
      }
      AEGP_StreamRefH next = nullptr;
      if (dynamic_suite->AEGP_GetNewStreamRefByIndex(
              plugin_id_, stream.get(), stream_address->child_indices[depth], &next)
              != A_Err_NONE
          || next == nullptr) return std::nullopt;
      StreamRefOwner next_owner(stream_suite, next);
      std::int32_t unique_id = 0;
      if (stream_suite->AEGP_GetUniqueStreamID(next_owner.get(), &unique_id)
              != A_Err_NONE
          || unique_id != stream_address->unique_ids[depth]) return std::nullopt;
      stream = std::move(next_owner);
    }

    AEGP_StreamGroupingType grouping = AEGP_StreamGroupingType_NONE;
    AEGP_StreamType type = AEGP_StreamType_NO_DATA;
    A_Boolean can_vary = FALSE;
    A_short temporal_dimensions = 0;
    A_long keyframe_count = 0;
    if (dynamic_suite->AEGP_GetStreamGroupingType(stream.get(), &grouping)
            != A_Err_NONE
        || stream_suite->AEGP_GetStreamType(stream.get(), &type) != A_Err_NONE
        || stream_suite->AEGP_CanVaryOverTime(stream.get(), &can_vary) != A_Err_NONE
        || keyframe_suite->AEGP_GetStreamTemporalDimensionality(
            stream.get(), &temporal_dimensions) != A_Err_NONE
        || keyframe_suite->AEGP_GetStreamNumKFs(stream.get(), &keyframe_count)
            != A_Err_NONE) {
      return std::nullopt;
    }
    const bool primitive = type == AEGP_StreamType_OneD
        || type == AEGP_StreamType_TwoD || type == AEGP_StreamType_TwoD_SPATIAL
        || type == AEGP_StreamType_ThreeD || type == AEGP_StreamType_ThreeD_SPATIAL
        || type == AEGP_StreamType_COLOR;
    if (grouping != AEGP_StreamGroupingType_LEAF || can_vary == FALSE
        || !primitive || temporal_dimensions < 1 || temporal_dimensions > 4
        || keyframe_count == AEGP_NumKF_NO_DATA || keyframe_count < 0) {
      return std::nullopt;
    }
    return ResolvedProperty{
        ResolvedLayer{*open, layer_address->composition_item_id,
            layer_address->layer_id, *composition_item, composition, layer},
        std::move(stream), type, temporal_dimensions, keyframe_count};
  }

  [[nodiscard]] static bool keyframe_time_equal(
      const A_Time& actual,
      const LayerPropertySampleTime& requested) noexcept {
    if (actual.scale <= 0 || requested.scale == 0) return false;
    // AE's A_Time fields and validated wire times are bounded to 32-bit
    // values/scales, so their signed cross-products fit exactly in int64.
    return static_cast<std::int64_t>(actual.value)
            * static_cast<std::int64_t>(requested.scale)
        == static_cast<std::int64_t>(requested.value)
            * static_cast<std::int64_t>(actual.scale);
  }

  [[nodiscard]] static bool keyframe_time_equal(
      const LayerPropertySampleTime& actual,
      const LayerPropertySampleTime& requested) noexcept {
    if (actual.scale == 0 || requested.scale == 0) return false;
    return static_cast<std::int64_t>(actual.value)
            * static_cast<std::int64_t>(requested.scale)
        == static_cast<std::int64_t>(requested.value)
            * static_cast<std::int64_t>(actual.scale);
  }

  [[nodiscard]] static std::optional<AEGP_KeyframeIndex> find_keyframe_at_time(
      const AEGP_KeyframeSuite5* keyframe_suite,
      AEGP_StreamRefH stream,
      A_long keyframe_count,
      const LayerPropertySampleTime& requested,
      TimePoint deadline) {
    if (keyframe_suite == nullptr || stream == nullptr || requested.scale == 0
        || requested.value < std::numeric_limits<std::int32_t>::min()
        || requested.value > std::numeric_limits<std::int32_t>::max()) {
      return std::nullopt;
    }
    for (A_long index = 0; index < keyframe_count; ++index) {
      if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
      A_Time time{};
      if (keyframe_suite->AEGP_GetKeyframeTime(
              stream, index, AEGP_LTimeMode_CompTime, &time) != A_Err_NONE) {
        return std::nullopt;
      }
      if (keyframe_time_equal(time, requested)) return index;
    }
    return std::nullopt;
  }

  [[nodiscard]] std::optional<LayerPropertyKeyframeDetails>
      read_keyframe_details_value(
          const AEGP_StreamSuite6* stream_suite,
          const AEGP_KeyframeSuite5* keyframe_suite,
          const ResolvedProperty& resolved,
          AEGP_KeyframeIndex index,
          const ObjectLocator& property_locator) const {
    A_Time time{};
    StreamValueOwner value_owner(stream_suite);
    AEGP_KeyframeInterpolationType in_interpolation = AEGP_KeyInterp_NONE;
    AEGP_KeyframeInterpolationType out_interpolation = AEGP_KeyInterp_NONE;
    AEGP_KeyframeFlags flags = AEGP_KeyframeFlag_NONE;
    if (keyframe_suite->AEGP_GetKeyframeTime(
            resolved.stream.get(), index, AEGP_LTimeMode_CompTime, &time)
            != A_Err_NONE
        || time.scale <= 0
        || keyframe_suite->AEGP_GetNewKeyframeValue(
            plugin_id_, resolved.stream.get(), index, value_owner.out())
            != A_Err_NONE) return std::nullopt;
    value_owner.mark_initialized();
    if (keyframe_suite->AEGP_GetKeyframeInterpolation(
            resolved.stream.get(), index, &in_interpolation, &out_interpolation)
            != A_Err_NONE
        || keyframe_suite->AEGP_GetKeyframeFlags(
            resolved.stream.get(), index, &flags) != A_Err_NONE) {
      return std::nullopt;
    }
    const auto value = primitive_stream_value(resolved.type, value_owner.value());
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
    details.temporal_dimensionality = static_cast<std::uint16_t>(
        resolved.temporal_dimensions);
    details.in_interpolation = *in_name;
    details.out_interpolation = *out_name;
    details.temporal_ease.reserve(
        static_cast<std::size_t>(resolved.temporal_dimensions));
    for (A_long dimension = 0; dimension < resolved.temporal_dimensions; ++dimension) {
      AEGP_KeyframeEase in_ease{};
      AEGP_KeyframeEase out_ease{};
      if (keyframe_suite->AEGP_GetKeyframeTemporalEase(
              resolved.stream.get(), index, dimension, &in_ease, &out_ease)
              != A_Err_NONE) return std::nullopt;
      const auto in_speed = decimal_string(in_ease.speedF);
      const auto in_influence = decimal_string(in_ease.influenceF * 100.0);
      const auto out_speed = decimal_string(out_ease.speedF);
      const auto out_influence = decimal_string(out_ease.influenceF * 100.0);
      if (!in_speed.has_value() || !in_influence.has_value()
          || !out_speed.has_value() || !out_influence.has_value()) {
        return std::nullopt;
      }
      details.temporal_ease.push_back({
          static_cast<std::uint16_t>(dimension),
          {*in_speed, *in_influence},
          {*out_speed, *out_influence}});
    }
    details.behavior = {
        (flags & AEGP_KeyframeFlag_TEMPORAL_CONTINUOUS) != 0,
        (flags & AEGP_KeyframeFlag_TEMPORAL_AUTOBEZIER) != 0,
        (flags & AEGP_KeyframeFlag_SPATIAL_CONTINUOUS) != 0,
        (flags & AEGP_KeyframeFlag_SPATIAL_AUTOBEZIER) != 0,
        (flags & AEGP_KeyframeFlag_ROVING) != 0};
    return details;
  }

  [[nodiscard]] std::optional<LayerDetails> read_layer_details_value(
      const AEGP_ItemSuite9* item_suite,
      const AEGP_LayerSuite9* layer_suite,
      const AEGP_MemorySuite1* memory_suite,
      const ResolvedLayer& resolved,
      std::string_view host,
      std::string_view session) {
    A_long layer_index = -1;
    AEGP_LayerFlags flags = 0;
    AEGP_ObjectType object_type = AEGP_ObjectType_NONE;
    AEGP_LayerH parent = nullptr;
    AEGP_ItemH source = nullptr;
    A_Time in_point{};
    A_Time duration{};
    A_Time offset{};
    A_Ratio stretch{};
    std::string name_error;
    const auto name = read_effective_layer_name(
        layer_suite, item_suite, memory_suite, plugin_id_,
        resolved.layer, name_error);
    if (!name.has_value()
        || layer_suite->AEGP_GetLayerIndex(resolved.layer, &layer_index) != A_Err_NONE
        || layer_index < 0
        || layer_suite->AEGP_GetLayerFlags(resolved.layer, &flags) != A_Err_NONE
        || layer_suite->AEGP_GetLayerObjectType(
            resolved.layer, &object_type) != A_Err_NONE
        || layer_suite->AEGP_GetLayerParent(resolved.layer, &parent) != A_Err_NONE
        || layer_suite->AEGP_GetLayerSourceItem(resolved.layer, &source) != A_Err_NONE
        || layer_suite->AEGP_GetLayerInPoint(
            resolved.layer, AEGP_LTimeMode_CompTime, &in_point) != A_Err_NONE
        || layer_suite->AEGP_GetLayerDuration(
            resolved.layer, AEGP_LTimeMode_CompTime, &duration) != A_Err_NONE
        || layer_suite->AEGP_GetLayerOffset(resolved.layer, &offset) != A_Err_NONE
        || layer_suite->AEGP_GetLayerStretch(resolved.layer, &stretch) != A_Err_NONE
        || in_point.scale <= 0 || duration.scale <= 0 || duration.value <= 0
        || offset.scale <= 0 || stretch.num == 0 || stretch.den <= 0) {
      return std::nullopt;
    }
    const auto time_value = [](const A_Time& time) {
      return CompositionCurrentTime{
          static_cast<std::int32_t>(time.value),
          static_cast<std::uint32_t>(time.scale),
          aemcp::native::canonical_seconds_rational(time.value, time.scale)};
    };
    LayerDetails details;
    details.layer_locator = graph_.layer_locator(
        resolved.composition_item_id, resolved.layer_id, host, session);
    details.composition_locator = graph_.item_locator(
        resolved.composition_item_id, true, host, session);
    details.stack_index = static_cast<std::uint64_t>(layer_index) + 1U;
    details.name = *name;
    details.type = layer_type(object_type, flags);
    details.video_enabled = (flags & AEGP_LayerFlag_VIDEO_ACTIVE) != 0;
    details.is_three_d = (flags & AEGP_LayerFlag_LAYER_IS_3D) != 0;
    details.locked = (flags & AEGP_LayerFlag_LOCKED) != 0;
    details.in_point = time_value(in_point);
    details.duration = time_value(duration);
    details.start_time = time_value(offset);
    details.stretch = {
        static_cast<std::int32_t>(stretch.num),
        static_cast<std::int32_t>(stretch.den),
        aemcp::native::canonical_seconds_rational(
            stretch.num, static_cast<std::uint32_t>(stretch.den))};
    if (parent != nullptr) {
      AEGP_LayerIDVal parent_id = 0;
      if (layer_suite->AEGP_GetLayerID(parent, &parent_id) != A_Err_NONE) {
        return std::nullopt;
      }
      details.parent_locator = graph_.layer_locator(
          resolved.composition_item_id, parent_id, host, session);
    }
    if (source != nullptr) {
      A_long source_id = 0;
      AEGP_ItemType source_type = AEGP_ItemType_NONE;
      if (item_suite->AEGP_GetItemID(source, &source_id) != A_Err_NONE
          || item_suite->AEGP_GetItemType(source, &source_type) != A_Err_NONE) {
        return std::nullopt;
      }
      details.source_item_locator = graph_.item_locator(
          source_id, source_type == AEGP_ItemType_COMP, host, session);
    }
    return details;
  }

  [[nodiscard]] std::optional<ProjectItemEntry> project_item_entry(
      const AEGP_ItemSuite9* item_suite,
      const AEGP_MemorySuite1* memory_suite,
      AEGP_ItemH item,
      AEGP_ItemH root,
      std::string_view host,
      std::string_view session) {
    AEGP_ItemType type = AEGP_ItemType_NONE;
    A_long item_id = 0;
    AEGP_ItemH parent = nullptr;
    AEGP_MemHandle name_handle = nullptr;
    if (item == nullptr
        || item_suite->AEGP_GetItemType(item, &type) != A_Err_NONE
        || item_suite->AEGP_GetItemID(item, &item_id) != A_Err_NONE
        || item_suite->AEGP_GetItemParentFolder(item, &parent) != A_Err_NONE
        || item_suite->AEGP_GetItemName(plugin_id_, item, &name_handle) != A_Err_NONE
        || name_handle == nullptr) {
      return std::nullopt;
    }
    MemHandleOwner name_owner(memory_suite, name_handle);
    std::optional<std::string> name = name_owner.utf8();
    if (!name.has_value()) return std::nullopt;
    ProjectItemEntry entry;
    entry.locator = graph_.item_locator(
        item_id, type == AEGP_ItemType_COMP, host, session);
    entry.name = std::move(*name);
    entry.type = project_item_type(type);
    if (parent == nullptr || parent == root) {
      entry.parent_locator = graph_.project_locator(host, session);
    } else {
      A_long parent_id = 0;
      if (item_suite->AEGP_GetItemID(parent, &parent_id) != A_Err_NONE) {
        return std::nullopt;
      }
      entry.parent_locator = graph_.item_locator(parent_id, false, host, session);
    }
    return entry;
  }

  [[nodiscard]] std::optional<std::string> read_item_name(
      const AEGP_ItemSuite9* item_suite,
      const AEGP_MemorySuite1* memory_suite,
      AEGP_ItemH item) const {
    AEGP_MemHandle handle = nullptr;
    if (item_suite->AEGP_GetItemName(plugin_id_, item, &handle) != A_Err_NONE
        || handle == nullptr) {
      return std::nullopt;
    }
    MemHandleOwner owner(memory_suite, handle);
    return owner.utf8();
  }

  [[nodiscard]] static std::optional<std::string> read_item_comment(
      const AEGP_ItemSuite9* item_suite,
      const AEGP_MemorySuite1* memory_suite,
      AEGP_ItemH item) {
    AEGP_MemHandle handle = nullptr;
    if (item_suite->AEGP_GetItemComment(item, &handle) != A_Err_NONE) {
      return std::nullopt;
    }
    if (handle == nullptr) return std::string{};
    MemHandleOwner owner(memory_suite, handle);
    return owner.utf8();
  }

  [[nodiscard]] std::optional<CompositionSettings> composition_settings(
      const AEGP_ItemSuite9* item_suite,
      const AEGP_CompSuite12* comp_suite,
      const AEGP_LayerSuite9* layer_suite,
      const AEGP_MemorySuite1* memory_suite,
      AEGP_ItemH item,
      AEGP_CompH comp,
      ObjectLocator locator) const {
    const std::optional<std::string> name = read_item_name(
        item_suite, memory_suite, item);
    A_long width = 0;
    A_long height = 0;
    A_long layer_count = 0;
    A_Time duration{};
    A_Time frame_duration{};
    A_Time work_start{};
    A_Time work_duration{};
    A_Time display_start{};
    A_Ratio pixel_aspect{};
    if (!name.has_value()
        || item_suite->AEGP_GetItemDimensions(item, &width, &height) != A_Err_NONE
        || item_suite->AEGP_GetItemDuration(item, &duration) != A_Err_NONE
        || item_suite->AEGP_GetItemPixelAspectRatio(item, &pixel_aspect) != A_Err_NONE
        || comp_suite->AEGP_GetCompFrameDuration(comp, &frame_duration) != A_Err_NONE
        || comp_suite->AEGP_GetCompWorkAreaStart(comp, &work_start) != A_Err_NONE
        || comp_suite->AEGP_GetCompWorkAreaDuration(comp, &work_duration) != A_Err_NONE
        || comp_suite->AEGP_GetCompDisplayStartTime(comp, &display_start) != A_Err_NONE
        || layer_suite->AEGP_GetCompNumLayers(comp, &layer_count) != A_Err_NONE
        || width < 1 || width > 30000 || height < 1 || height > 30000
        || layer_count < 0
        || duration.scale <= 0 || duration.value <= 0
        || frame_duration.scale <= 0 || frame_duration.value <= 0
        || work_start.scale <= 0 || work_start.value < 0
        || work_duration.scale <= 0 || work_duration.value <= 0
        || display_start.scale <= 0
        || pixel_aspect.num <= 0 || pixel_aspect.den <= 0) {
      return std::nullopt;
    }
    const auto exact_time = [](const A_Time& value) {
      return CompositionCurrentTime{
          static_cast<std::int32_t>(value.value),
          static_cast<std::uint32_t>(value.scale),
          aemcp::native::canonical_seconds_rational(value.value, value.scale)};
    };
    const std::uint64_t rate_divisor = std::gcd(
        static_cast<std::uint64_t>(frame_duration.scale),
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
    settings.work_area_start = exact_time(work_start);
    settings.work_area_duration = exact_time(work_duration);
    settings.display_start_time = exact_time(display_start);
    settings.layer_count = static_cast<std::uint64_t>(layer_count);
    return settings;
  }

  [[nodiscard]] HostProjectItemTextWriteResult set_project_item_text(
      const aemcp::native::ProjectItemTextSetCommand& command,
      TimePoint work_deadline,
      bool set_name) {
    SuiteLease<AEGP_ProjSuite6> project_suite(
        basic_, kAEGPProjSuite, kAEGPProjSuiteVersion6);
    SuiteLease<AEGP_ItemSuite9> item_suite(
        basic_, kAEGPItemSuite, kAEGPItemSuiteVersion9);
    SuiteLease<AEGP_UtilitySuite6> utility_suite(
        basic_, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
    SuiteLease<AEGP_MemorySuite1> memory_suite(
        basic_, kAEGPMemorySuite, kAEGPMemorySuiteVersion1);
    if (project_suite.get() == nullptr || item_suite.get() == nullptr
        || utility_suite.get() == nullptr || memory_suite.get() == nullptr) {
      return HostProjectItemTextWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required project item text suites are unavailable");
    }
    const auto open = observe_open_project(
        project_suite.get(), item_suite.get(), memory_suite.get());
    const auto item_id = graph_.resolve_project_item(
        command.item_locator, command.host_instance_id, command.session_id);
    if (!open.has_value() || !item_id.has_value()) {
      return HostProjectItemTextWriteResult::failure(
          "STALE_LOCATOR", "itemLocator does not identify an item in the open project",
          "params.arguments.itemLocator");
    }
    const auto item = find_project_item(
        item_suite.get(), open->project, open->root, *item_id, work_deadline);
    const auto before = item.has_value()
        ? (set_name
          ? read_item_name(item_suite.get(), memory_suite.get(), *item)
          : read_item_comment(item_suite.get(), memory_suite.get(), *item))
        : std::nullopt;
    const auto utf16 = utf16_bounded_text(
        command.value, set_name ? 255U : 1024U, !set_name);
    if (!item.has_value() || !before.has_value() || !utf16.has_value()) {
      return HostProjectItemTextWriteResult::failure(
          "CAPABILITY_FAILED", "could not validate project item text mutation");
    }
    if (*before == command.value) {
      return HostProjectItemTextWriteResult::failure(
          "INVALID_ARGUMENT",
          set_name ? "name already matches the project item"
                   : "comment already matches the project item",
          set_name ? "params.arguments.name" : "params.arguments.comment");
    }
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return HostProjectItemTextWriteResult::failure(
          "DEADLINE_EXCEEDED", "project item text mutation budget elapsed");
    }
    static constexpr char kNameUndoLabel[] = "ae-mcp: Rename project item";
    static constexpr char kCommentUndoLabel[] = "ae-mcp: Set project item comment";
    if (utility_suite->AEGP_StartUndoGroup(
            set_name ? kNameUndoLabel : kCommentUndoLabel) != A_Err_NONE) {
      return HostProjectItemTextWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }
    const A_Err set_error = set_name
        ? item_suite->AEGP_SetItemName(*item, utf16->data())
        : item_suite->AEGP_SetItemComment(*item, utf16->data());
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    const auto after = set_name
        ? read_item_name(item_suite.get(), memory_suite.get(), *item)
        : read_item_comment(item_suite.get(), memory_suite.get(), *item);
    if (set_error != A_Err_NONE || end_error != A_Err_NONE
        || !after.has_value() || *after != command.value
        || std::chrono::steady_clock::now() >= work_deadline) {
      return HostProjectItemTextWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project item text may have changed but readback or Undo validation failed");
    }
    return HostProjectItemTextWriteResult::success({
        true, command.item_locator, *before, *after});
  }

  SPBasicSuite* basic_{nullptr};
  AEGP_PluginID plugin_id_{0};
  ProjectGraphRegistry& graph_;
};

class AegpHostIdleSignal final : public aemcp::native::HostIdleSignal {
 public:
  explicit AegpHostIdleSignal(const AEGP_UtilitySuite6* utility_suite) noexcept
      : utility_suite_(utility_suite) {}

  [[nodiscard]] bool request_idle() noexcept override {
    return utility_suite_ != nullptr
        && utility_suite_->AEGP_CauseIdleRoutinesToBeCalled != nullptr
        && utility_suite_->AEGP_CauseIdleRoutinesToBeCalled() == A_Err_NONE;
  }

 private:
  const AEGP_UtilitySuite6* utility_suite_{nullptr};
};

struct PluginState final : NativeIpcObserver, NativeRpcObserver {
  PluginState(SPBasicSuite* basic_suite, AEGP_PluginID plugin_id_value,
      A_long driver_major_value, A_long driver_minor_value)
      : basic(basic_suite),
        plugin_id(plugin_id_value),
        driver_major(driver_major_value),
        driver_minor(driver_minor_value),
        utility_suite(basic_suite, kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6),
        idle_signal(utility_suite.get()),
        dispatcher(std::this_thread::get_id(), clock),
        pairing_gate(pairing_clock, pairing_material) {
    if (utility_suite.get() == nullptr) {
      throw std::runtime_error("AEGP utility suite unavailable");
    }
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
            std::string(kCompositionTimeSetContractDigest),
            std::string(kCompositionCreateContractDigest),
            std::string(kCompositionLayerCreateContractDigest),
            std::string(kLayerEffectApplyContractDigest),
            std::string(kLayerPropertiesListContractDigest),
            std::string(kLayerPropertyKeyframesListContractDigest),
            std::string(kLayerPropertySetContractDigest),
            std::string(kCompositionSelectedLayersListContractDigest),
            std::string(kProjectContextReadContractDigest),
            std::string(kProjectItemMetadataReadContractDigest),
            std::string(kCompositionSettingsReadContractDigest),
            std::string(kCompositionWorkAreaSetContractDigest),
            std::string(kProjectItemNameSetContractDigest),
            std::string(kProjectItemCommentSetContractDigest),
            std::string(kProjectItemLabelSetContractDigest),
            std::string(kCompositionDuplicateContractDigest),
            std::string(kLayerDetailsReadContractDigest),
            std::string(kLayerNameSetContractDigest),
            std::string(kLayerRangeSetContractDigest),
            std::string(kLayerStartTimeSetContractDigest),
            std::string(kLayerStretchSetContractDigest),
            std::string(kLayerOrderSetContractDigest),
            std::string(kLayerParentSetContractDigest),
            std::string(kLayerDuplicateContractDigest),
            std::string(kLayerCompositingReadContractDigest),
            std::string(kLayerSwitchSetContractDigest),
            std::string(kLayerQualitySetContractDigest),
            std::string(kLayerBlendingModeSetContractDigest),
            std::string(kLayerPropertyKeyframeDetailsReadContractDigest),
            std::string(kLayerPropertyKeyframeAddContractDigest),
            std::string(kLayerPropertyKeyframeValueSetContractDigest),
            std::string(kLayerPropertyKeyframeInterpolationSetContractDigest),
            std::string(kLayerPropertyKeyframeTemporalEaseSetContractDigest),
            std::string(kLayerPropertyKeyframeBehaviorSetContractDigest),
            std::string(kLayerPropertyKeyframeDeleteContractDigest),
        },
        *this,
        idle_signal);
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
  SuiteLease<AEGP_UtilitySuite6> utility_suite;
  AegpHostIdleSignal idle_signal;
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
         << ",\"capabilities\":[";
  for (std::size_t index = 0;
       index < aemcp::native::kAdvertisedNativeCapabilities.size();
       ++index) {
    if (index > 0) output << ',';
    output << '"' << json_escape(
        aemcp::native::kAdvertisedNativeCapabilities[index]) << '"';
  }
  output << "]}";
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
    if (completion.capability_id == kProjectGraphInvalidateControl) {
      output << ",\"result\":{\"invalidated\":"
             << (completion.project_graph_invalidation_result.invalidated
                    ? "true" : "false")
             << ",\"generation\":"
             << completion.project_graph_invalidation_result.generation;
    } else if (completion.capability_id == kProjectBitDepthSetCapability) {
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
    } else if (completion.capability_id
        == kCompositionSelectedLayersListCapability) {
      output << ",\"result\":{\"total\":"
             << completion.composition_selected_layers_result.total
             << ",\"offset\":"
             << completion.composition_selected_layers_result.offset
             << ",\"returned\":"
             << completion.composition_selected_layers_result.layers.size()
             << ",\"hasMore\":"
             << (completion.composition_selected_layers_result.has_more
                    ? "true" : "false")
             << ",\"projectGeneration\":"
             << completion.composition_selected_layers_result
                    .composition_locator.generation;
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
    } else if (completion.capability_id == kCompositionTimeSetCapability) {
      output << ",\"result\":{\"changed\":true,\"beforeTime\":{\"value\":"
             << completion.composition_time_change_result.before_time.value
             << ",\"scale\":"
             << completion.composition_time_change_result.before_time.scale
             << "},\"afterTime\":{\"value\":"
             << completion.composition_time_change_result.after_time.value
             << ",\"scale\":"
             << completion.composition_time_change_result.after_time.scale
             << "},\"projectGeneration\":"
             << completion.composition_time_change_result
                    .composition_locator.generation;
    } else if (completion.capability_id == kCompositionCreateCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::composition_create_persistent_diagnostic_fields(
                    completion.composition_create_result);
    } else if (completion.capability_id == kCompositionLayerCreateCapability) {
      output << ",\"result\":{\"changed\":true,\"kind\":\""
             << json_escape(completion.composition_layer_create_result.kind)
             << "\",\"stackIndex\":"
             << completion.composition_layer_create_result.stack_index
             << ",\"layerCountBefore\":"
             << completion.composition_layer_create_result.layer_count_before
             << ",\"layerCountAfter\":"
             << completion.composition_layer_create_result.layer_count_after
             << ",\"projectGeneration\":"
             << completion.composition_layer_create_result
                    .composition_locator.generation;
    } else if (completion.capability_id == kLayerEffectApplyCapability) {
      output << ",\"result\":{\"changed\":true,\"effectIndex\":"
             << completion.layer_effect_apply_result.effect_index
             << ",\"effectCountBefore\":"
             << completion.layer_effect_apply_result.effect_count_before
             << ",\"effectCountAfter\":"
             << completion.layer_effect_apply_result.effect_count_after
             << ",\"matchingEffectCountBefore\":"
             << completion.layer_effect_apply_result.matching_effect_count_before
             << ",\"matchingEffectCountAfter\":"
             << completion.layer_effect_apply_result.matching_effect_count_after
             << ",\"projectGeneration\":"
             << completion.layer_effect_apply_result.layer_locator.generation;
    } else if (completion.capability_id == kLayerPropertiesListCapability) {
      output << ",\"result\":{\"total\":"
             << completion.layer_properties_result.total
             << ",\"offset\":" << completion.layer_properties_result.offset
             << ",\"returned\":" << completion.layer_properties_result.properties.size()
             << ",\"hasMore\":"
             << (completion.layer_properties_result.has_more ? "true" : "false")
             << ",\"projectGeneration\":"
             << completion.layer_properties_result.layer_locator.generation;
    } else if (completion.capability_id == kLayerPropertyKeyframesListCapability) {
      output << ",\"result\":{\"total\":"
             << completion.layer_property_keyframes_result.total
             << ",\"offset\":" << completion.layer_property_keyframes_result.offset
             << ",\"returned\":"
             << completion.layer_property_keyframes_result.keyframes.size()
             << ",\"hasMore\":"
             << (completion.layer_property_keyframes_result.has_more ? "true" : "false")
             << ",\"projectGeneration\":"
             << completion.layer_property_keyframes_result.property_locator.generation;
    } else if (completion.capability_id == kLayerPropertySetCapability) {
      output << ",\"result\":{\"changed\":true,\"valueType\":\""
             << json_escape(completion.layer_property_change_result.value_type)
             << "\",\"projectGeneration\":"
             << completion.layer_property_change_result.layer_locator.generation;
    } else if (completion.capability_id == kProjectContextReadCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::project_context_persistent_diagnostic_fields(
                    completion.project_context_result);
    } else if (completion.capability_id == kProjectItemMetadataReadCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::project_item_metadata_persistent_diagnostic_fields(
                    completion.project_item_metadata_result);
    } else if (completion.capability_id == kCompositionSettingsReadCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::composition_settings_persistent_diagnostic_fields(
                    completion.composition_settings_result);
    } else if (completion.capability_id == kCompositionWorkAreaSetCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::composition_work_area_persistent_diagnostic_fields(
                    completion.composition_work_area_change_result);
    } else if (completion.capability_id == kProjectItemNameSetCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::project_item_name_persistent_diagnostic_fields(
                    completion.project_item_text_change_result);
    } else if (completion.capability_id == kProjectItemCommentSetCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::project_item_comment_persistent_diagnostic_fields(
                    completion.project_item_text_change_result);
    } else if (completion.capability_id == kProjectItemLabelSetCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::project_item_label_persistent_diagnostic_fields(
                    completion.project_item_label_change_result);
    } else if (completion.capability_id == kCompositionDuplicateCapability) {
      output << ",\"result\":{"
             << aemcp::native::rpc::composition_duplicate_persistent_diagnostic_fields(
                    completion.composition_duplicate_result);
    } else if (completion.capability_id == kLayerDetailsReadCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerDetails>(*completion.layer_timeline_result);
      output << ",\"result\":{\"stackIndex\":" << value.stack_index
             << ",\"type\":\"" << json_escape(value.type)
             << "\",\"projectGeneration\":" << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerNameSetCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerNameChanged>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerRangeSetCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerRangeChanged>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerStartTimeSetCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerStartTimeChanged>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerStretchSetCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerStretchChanged>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerOrderSetCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerOrderChanged>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"beforeStackIndex\":"
             << value.before_stack_index << ",\"afterStackIndex\":"
             << value.after_stack_index << ",\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerParentSetCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerParentChanged>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerDuplicateCapability
        && completion.layer_timeline_result != nullptr) {
      const auto& value = std::get<LayerDuplicated>(*completion.layer_timeline_result);
      output << ",\"result\":{\"changed\":true,\"layerCountBefore\":"
             << value.layer_count_before << ",\"layerCountAfter\":"
             << value.layer_count_after << ",\"projectGeneration\":"
             << value.new_layer_locator.generation;
    } else if (completion.capability_id == kLayerCompositingReadCapability
        && completion.layer_compositing_result != nullptr) {
      const auto& value = std::get<LayerCompositingState>(
          *completion.layer_compositing_result);
      output << ",\"result\":{\"quality\":\"" << json_escape(value.quality)
             << "\",\"blendingMode\":\"" << json_escape(value.blending_mode)
             << "\",\"projectGeneration\":" << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerSwitchSetCapability
        && completion.layer_compositing_result != nullptr) {
      const auto& value = std::get<aemcp::native::LayerSwitchChanged>(
          *completion.layer_compositing_result);
      output << ",\"result\":{\"changed\":true,\"switch\":\""
             << json_escape(value.switch_name) << "\",\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerQualitySetCapability
        && completion.layer_compositing_result != nullptr) {
      const auto& value = std::get<aemcp::native::LayerQualityChanged>(
          *completion.layer_compositing_result);
      output << ",\"result\":{\"changed\":true,\"afterQuality\":\""
             << json_escape(value.after_quality) << "\",\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kLayerBlendingModeSetCapability
        && completion.layer_compositing_result != nullptr) {
      const auto& value = std::get<aemcp::native::LayerBlendingModeChanged>(
          *completion.layer_compositing_result);
      output << ",\"result\":{\"changed\":true,\"afterMode\":\""
             << json_escape(value.after_mode) << "\",\"projectGeneration\":"
             << value.layer_locator.generation;
    } else if (completion.capability_id == kProjectSummaryCapability) {
      output << ",\"result\":{\"projectOpen\":"
             << (completion.result.project_open ? "true" : "false")
             << ",\"projectNameRedacted\":"
             << (completion.result.project_name.empty() ? "false" : "true")
             << ",\"itemCount\":" << completion.result.item_count;
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
    if (state == nullptr) return A_Err_GENERIC;
    if (command != state->pairing_command) {
      const bool invalidated = state->project_graph.invalidate_project();
      state->dispatcher.invalidate_composition_creation_replays();
      state->log.append(event_prefix(*state, "project.command-invalidation")
          + ",\"command\":" + std::to_string(command)
          + ",\"phase\":\"before-ae\",\"invalidated\":"
          + (invalidated ? "true" : "false")
          + ",\"generation\":"
          + std::to_string(state->project_graph.generation()) + "}");
      return A_Err_NONE;
    }
    if (handled == nullptr) return A_Err_GENERIC;
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
