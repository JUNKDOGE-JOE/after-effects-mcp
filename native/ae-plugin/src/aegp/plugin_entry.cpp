#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/endpoint_registry_macos.hpp"
#include "aemcp_native/mac_ipc_server.hpp"
#include "aemcp_native/native_rpc_connection.hpp"
#include "aemcp_native/pairing_gate.hpp"
#include "aemcp_native/pairing_ui_macos.hpp"
#include "aemcp_native/peer_identity_macos.hpp"
#include "aemcp_native/rpc_codec.hpp"
#include "aemcp_native/secure_random_macos.hpp"

#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
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

namespace {

using namespace std::chrono_literals;
using aemcp::native::Completion;
using aemcp::native::DrainBatch;
using aemcp::native::HostApi;
using aemcp::native::HostDispatcher;
using aemcp::native::HostReadResult;
using aemcp::native::HostWriteResult;
using aemcp::native::MacEndpointRegistry;
using aemcp::native::MacIpcServer;
using aemcp::native::NativeEndpointDescriptor;
using aemcp::native::NativeIpcObserver;
using aemcp::native::NativeRpcConnectionHandler;
using aemcp::native::NativeRpcObserver;
using aemcp::native::NativeRpcRuntimeInfo;
using aemcp::native::PairingGate;
using aemcp::native::PairingUiDecision;
using aemcp::native::ProjectSummary;
using aemcp::native::ProjectFolderCreated;
using aemcp::native::Request;
using aemcp::native::SystemClock;
using aemcp::native::TimePoint;
using aemcp::native::kProjectSummaryCapability;
using aemcp::native::kProjectFolderCreateCapability;

constexpr std::string_view kPluginVersion = "0.1.0-dev";
constexpr std::string_view kSdkVersion = "25.6.61";
constexpr std::uint64_t kSdkBuild = 61;
constexpr std::string_view kSourceCommit = AE_MCP_SOURCE_COMMIT;
constexpr std::string_view kCapabilitiesDigest =
    "33afff4311c76b6671101c9f2a15d2bbfe328c43dd7b539c0825b24ffa416be8";
constexpr std::string_view kProjectSummaryContractDigest =
    "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a";
constexpr std::string_view kProjectFolderCreateContractDigest =
    "d9defb50a560e02ee4ca2e46abccf903136b2f65f51a74fd24baaafc8bedcb0f";
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

class AegpHostApi final : public HostApi {
 public:
  AegpHostApi(SPBasicSuite* basic, AEGP_PluginID plugin_id)
      : basic_(basic), plugin_id_(plugin_id) {}

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

  [[nodiscard]] HostWriteResult create_project_folder(
      std::string_view name,
      TimePoint work_deadline) override {
    const auto budget_expired = [work_deadline] {
      return std::chrono::steady_clock::now() >= work_deadline;
    };
    if (budget_expired()) {
      return HostWriteResult::failure(
          "DEADLINE_EXCEEDED", "project folder create budget elapsed");
    }

    const auto utf16_name = utf16_folder_name(name);
    if (!utf16_name.has_value()) {
      return HostWriteResult::failure(
          "INVALID_ARGUMENT", "project folder name violates the host UTF-16 contract");
    }
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
      return HostWriteResult::failure(
          "NATIVE_UNSUPPORTED", "required project mutation suites unavailable");
    }

    A_long project_count = 0;
    if (budget_expired()) {
      return HostWriteResult::failure(
          "DEADLINE_EXCEEDED", "project folder create budget elapsed");
    }
    if (project_suite->AEGP_GetNumProjects(&project_count) != A_Err_NONE) {
      return HostWriteResult::failure(
          "CAPABILITY_FAILED", "could not read project count before mutation");
    }
    if (project_count <= 0) {
      return HostWriteResult::failure(
          "PRECONDITION_FAILED", "an After Effects project must be open");
    }

    AEGP_ProjectH project = nullptr;
    AEGP_ItemH root = nullptr;
    if (budget_expired()) {
      return HostWriteResult::failure(
          "DEADLINE_EXCEEDED", "project folder create budget elapsed");
    }
    if (project_suite->AEGP_GetProjectByIndex(0, &project) != A_Err_NONE
        || project == nullptr
        || project_suite->AEGP_GetProjectRootFolder(project, &root) != A_Err_NONE
        || root == nullptr) {
      return HostWriteResult::failure(
          "CAPABILITY_FAILED", "could not resolve the open project root");
    }

    A_long root_id = -1;
    if (item_suite->AEGP_GetItemID(root, &root_id) != A_Err_NONE || root_id < 0) {
      return HostWriteResult::failure(
          "CAPABILITY_FAILED", "could not read the project root item ID");
    }
    const auto count_before = count_project_items(
        project, root, *item_suite.get(), work_deadline);
    if (!count_before.has_value()) {
      return HostWriteResult::failure(
          budget_expired() ? "DEADLINE_EXCEEDED" : "CAPABILITY_FAILED",
          "could not count project items before mutation");
    }
    if (budget_expired()) {
      return HostWriteResult::failure(
          "DEADLINE_EXCEEDED", "project folder create budget elapsed");
    }

    static constexpr char kUndoLabel[] = "ae-mcp: Create project folder";
    if (utility_suite->AEGP_StartUndoGroup(kUndoLabel) != A_Err_NONE) {
      return HostWriteResult::failure(
          "CAPABILITY_FAILED", "could not start the After Effects undo group");
    }

    AEGP_ItemH folder = nullptr;
    const A_Err create_error = item_suite->AEGP_CreateNewFolder(
        utf16_name->data(), root, &folder);
    // Every successful StartUndoGroup must be balanced, including an error or
    // deadline path. Once CreateNewFolder was called, any failure is treated as
    // possibly side-effecting because the SDK cannot prove rollback.
    const A_Err end_error = utility_suite->AEGP_EndUndoGroup();
    if (create_error != A_Err_NONE || folder == nullptr) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project folder creation may have occurred; inspect project state");
    }
    if (end_error != A_Err_NONE) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project folder was created but its undo group did not close cleanly");
    }
    if (budget_expired()) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project folder was created after the validation budget elapsed");
    }

    AEGP_ItemType item_type = AEGP_ItemType_NONE;
    A_long folder_id = 0;
    AEGP_ItemH parent = nullptr;
    if (item_suite->AEGP_GetItemType(folder, &item_type) != A_Err_NONE
        || item_type != AEGP_ItemType_FOLDER
        || item_suite->AEGP_GetItemID(folder, &folder_id) != A_Err_NONE
        || folder_id <= 0
        || item_suite->AEGP_GetItemParentFolder(folder, &parent) != A_Err_NONE
        || parent != root) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created project folder failed type, ID, or root-parent verification");
    }

    const auto observed_name = read_item_name(folder, *item_suite.get(), *memory_suite.get());
    if (!observed_name.has_value() || *observed_name != name) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created project folder failed exact name verification");
    }
    const auto count_after = count_project_items(
        project, root, *item_suite.get(), work_deadline);
    if (!count_after.has_value() || *count_after != *count_before + 1) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "created project folder failed item-count verification");
    }
    if (budget_expired()) {
      return HostWriteResult::failure(
          "POSSIBLY_SIDE_EFFECTING_FAILURE",
          "project folder verification exceeded the request budget");
    }
    return HostWriteResult::success(ProjectFolderCreated{
        true,
        static_cast<std::int64_t>(folder_id),
        *observed_name,
        static_cast<std::int64_t>(root_id),
        *count_before,
        *count_after,
    });
  }

 private:
  [[nodiscard]] static std::optional<std::vector<A_UTF16Char>> utf16_folder_name(
      std::string_view name) {
    if (name.empty() || name.size() > 124 || name.find('\0') != std::string_view::npos) {
      return std::nullopt;
    }
    const CFStringRef value = CFStringCreateWithBytes(
        kCFAllocatorDefault,
        reinterpret_cast<const UInt8*>(name.data()),
        static_cast<CFIndex>(name.size()),
        kCFStringEncodingUTF8,
        false);
    if (value == nullptr) return std::nullopt;
    const CFIndex length = CFStringGetLength(value);
    if (length < 1 || length > AEGP_MAX_ITEM_NAME_SIZE - 1) {
      CFRelease(value);
      return std::nullopt;
    }
    std::vector<A_UTF16Char> result(static_cast<std::size_t>(length) + 1, 0);
    static_assert(sizeof(A_UTF16Char) == sizeof(UniChar));
    CFStringGetCharacters(
        value,
        CFRangeMake(0, length),
        reinterpret_cast<UniChar*>(result.data()));
    CFRelease(value);
    for (CFIndex index = 0; index < length; ++index) {
      const auto unit = static_cast<std::uint16_t>(result[static_cast<std::size_t>(index)]);
      if (unit <= 0x1fU || unit == 0x7fU) return std::nullopt;
    }
    return result;
  }

  [[nodiscard]] static std::optional<std::int64_t> count_project_items(
      AEGP_ProjectH project,
      AEGP_ItemH root,
      const AEGP_ItemSuite9& item_suite,
      TimePoint work_deadline) {
    if (std::chrono::steady_clock::now() >= work_deadline) return std::nullopt;
    AEGP_ItemH item = nullptr;
    if (item_suite.AEGP_GetNextProjItem(project, root, &item) != A_Err_NONE) {
      return std::nullopt;
    }
    std::int64_t count = 0;
    while (item != nullptr) {
      if (std::chrono::steady_clock::now() >= work_deadline
          || ++count > kMaximumProjectItems) {
        return std::nullopt;
      }
      AEGP_ItemH next = nullptr;
      if (item_suite.AEGP_GetNextProjItem(project, item, &next) != A_Err_NONE) {
        return std::nullopt;
      }
      item = next;
    }
    return count;
  }

  [[nodiscard]] std::optional<std::string> read_item_name(
      AEGP_ItemH item,
      const AEGP_ItemSuite9& item_suite,
      const AEGP_MemorySuite1& memory_suite) const {
    AEGP_MemHandle handle = nullptr;
    if (item_suite.AEGP_GetItemName(plugin_id_, item, &handle) != A_Err_NONE
        || handle == nullptr) {
      return std::nullopt;
    }
    AEGP_MemSize bytes = 0;
    void* pointer = nullptr;
    bool locked = false;
    std::optional<std::string> result;
    if (memory_suite.AEGP_GetMemHandleSize(handle, &bytes) == A_Err_NONE
        && bytes >= sizeof(A_UTF16Char)
        && bytes <= AEGP_MAX_ITEM_NAME_SIZE * sizeof(A_UTF16Char)
        && bytes % sizeof(A_UTF16Char) == 0
        && memory_suite.AEGP_LockMemHandle(handle, &pointer) == A_Err_NONE
        && pointer != nullptr) {
      locked = true;
      const auto* units = static_cast<const A_UTF16Char*>(pointer);
      const std::size_t capacity = bytes / sizeof(A_UTF16Char);
      std::size_t length = 0;
      while (length < capacity && units[length] != 0) ++length;
      if (length < capacity && length <= AEGP_MAX_ITEM_NAME_SIZE - 1) {
        const CFStringRef value = CFStringCreateWithCharacters(
            kCFAllocatorDefault,
            reinterpret_cast<const UniChar*>(units),
            static_cast<CFIndex>(length));
        if (value != nullptr) {
          result = cf_string(value);
          CFRelease(value);
        }
      }
    }
    if (locked && memory_suite.AEGP_UnlockMemHandle(handle) != A_Err_NONE) {
      result.reset();
    }
    if (memory_suite.AEGP_FreeMemHandle(handle) != A_Err_NONE) result.reset();
    return result;
  }

  SPBasicSuite* basic_{nullptr};
  AEGP_PluginID plugin_id_{0};
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
            std::string(kProjectFolderCreateContractDigest),
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
         << kProjectFolderCreateCapability << "\"]}"
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
    if (completion.capability_id == kProjectFolderCreateCapability) {
      output << ",\"result\":{\"created\":true,\"folderItemId\":"
             << completion.folder_result.folder_item_id
             << ",\"folderNameRedacted\":true,\"parentItemId\":"
             << completion.folder_result.parent_item_id
             << ",\"itemCountBefore\":" << completion.folder_result.item_count_before
             << ",\"itemCountAfter\":" << completion.folder_result.item_count_after;
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
    AegpHostApi host(state->basic, state->plugin_id);
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
