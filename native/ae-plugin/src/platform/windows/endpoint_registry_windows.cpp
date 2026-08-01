#include "endpoint_registry_windows.hpp"

#include <sddl.h>

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string_view>

namespace aemcp::native {
namespace {

constexpr std::string_view kDirectoryName = "aemcp-n1";
constexpr std::string_view kPipePrefix = "\\\\.\\pipe\\aemcp-n1-";
constexpr std::size_t kNonceBytes = 12;
constexpr std::size_t kMaximumDescriptorBytes = 1024;

[[nodiscard]] bool uuid_v4(std::string_view value) noexcept {
  if (value.size() != 36) return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char character = value[index];
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (character != '-') return false;
      continue;
    }
    const bool hex = std::isxdigit(static_cast<unsigned char>(character)) != 0
        && character == static_cast<char>(std::tolower(character));
    if (!hex) return false;
  }
  return value[14] == '4'
      && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b');
}

[[nodiscard]] bool ascii_hex(std::string_view value, std::size_t length) noexcept {
  return value.size() == length
      && std::all_of(value.begin(), value.end(), [](char character) {
           return std::isxdigit(static_cast<unsigned char>(character)) != 0
               && character == static_cast<char>(std::tolower(character));
         });
}

[[nodiscard]] bool pipe_name_valid(std::string_view value) noexcept {
  if (value.size() != kPipePrefix.size() + kNonceBytes
      || value.substr(0, kPipePrefix.size()) != kPipePrefix) {
    return false;
  }
  return ascii_hex(value.substr(kPipePrefix.size()), kNonceBytes);
}

[[nodiscard]] bool parse_uint64(std::string_view text, std::uint64_t& output) noexcept {
  if (text.empty() || text.size() > 20) return false;
  std::uint64_t value = 0;
  const auto [end, error] =
      std::from_chars(text.data(), text.data() + text.size(), value);
  if (error != std::errc{} || end != text.data() + text.size()) return false;
  output = value;
  return true;
}

[[nodiscard]] std::wstring widen(std::string_view value) {
  std::wstring output;
  output.reserve(value.size());
  for (const char character : value) output.push_back(static_cast<wchar_t>(character));
  return output;
}

class SecurityDescriptorOwner {
 public:
  SecurityDescriptorOwner() = default;
  ~SecurityDescriptorOwner() {
    if (descriptor_ != nullptr) LocalFree(descriptor_);
    if (sid_ != nullptr) FreeSid(sid_);
  }
  SecurityDescriptorOwner(const SecurityDescriptorOwner&) = delete;
  SecurityDescriptorOwner& operator=(const SecurityDescriptorOwner&) = delete;

  // Builds "D:P(A;;GA;;;<current-user-SID>)(A;;GA;;;SY)" — the same-user ACL
  // that is the entire Windows transport boundary (#88 NOT_PLANNED).
  [[nodiscard]] SECURITY_ATTRIBUTES* same_user_attributes() {
    HANDLE token = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) == 0) {
      return nullptr;
    }
    DWORD length = 0;
    (void)GetTokenInformation(token, TokenUser, nullptr, 0, &length);
    std::string storage(length, '\0');
    TOKEN_USER* user = nullptr;
    if (length == 0 || length > 4096
        || GetTokenInformation(token, TokenUser, storage.data(), length, &length) == 0) {
      CloseHandle(token);
      return nullptr;
    }
    CloseHandle(token);
    user = reinterpret_cast<TOKEN_USER*>(storage.data());
    LPWSTR sid_text = nullptr;
    if (ConvertSidToStringSidW(user->User.Sid, &sid_text) == 0) return nullptr;
    const std::wstring sddl =
        L"D:P(A;;GA;;;" + std::wstring(sid_text) + L")(A;;GA;;;SY)";
    LocalFree(sid_text);
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.c_str(), SDDL_REVISION_1, &descriptor_, nullptr) == 0) {
      return nullptr;
    }
    attributes_.nLength = sizeof(attributes_);
    attributes_.lpSecurityDescriptor = descriptor_;
    attributes_.bInheritHandle = FALSE;
    return &attributes_;
  }

 private:
  SECURITY_ATTRIBUTES attributes_{};
  PSECURITY_DESCRIPTOR descriptor_{nullptr};
  PSID sid_{nullptr};
};

}  // namespace

bool WindowsEndpointRegistry::parse_descriptor(
    const std::string& text,
    NativeEndpointDescriptor& output) noexcept {
  constexpr std::string_view kMagic = "AEMCP_NATIVE_ENDPOINT_V1\n";
  if (text.empty() || text.size() > kMaximumDescriptorBytes
      || text.compare(0, kMagic.size(), kMagic) != 0) {
    return false;
  }
  NativeEndpointDescriptor parsed{};
  bool have_host = false;
  bool have_pid = false;
  bool have_seconds = false;
  bool have_micros = false;
  bool have_socket = false;
  bool have_wire = false;
  bool have_source = false;
  std::size_t offset = kMagic.size();
  while (offset < text.size()) {
    const std::size_t newline = text.find('\n', offset);
    if (newline == std::string::npos) {
      // Every field line must be newline-terminated; a trailing partial
      // line means the descriptor was truncated or tampered with.
      return false;
    }
    const std::string_view line = std::string_view(text).substr(
        offset, newline - offset);
    offset = newline + 1;
    const std::size_t equals = line.find('=');
    if (equals == std::string_view::npos || equals == 0) return false;
    const std::string_view key = line.substr(0, equals);
    const std::string_view value = line.substr(equals + 1);
    std::uint64_t number = 0;
    if (key == "host" && !have_host) {
      if (!uuid_v4(value)) return false;
      parsed.host_instance_id = std::string(value);
      have_host = true;
    } else if (key == "pid" && !have_pid) {
      if (!parse_uint64(value, number) || number <= 1 || number > 0x7fffffffULL) return false;
      parsed.host_process.pid = static_cast<std::int32_t>(number);
      have_pid = true;
    } else if (key == "startSeconds" && !have_seconds) {
      if (!parse_uint64(value, number) || number == 0) return false;
      parsed.host_process.generation.start_seconds = number;
      have_seconds = true;
    } else if (key == "startMicros" && !have_micros) {
      if (!parse_uint64(value, number) || number >= 1000000ULL) return false;
      parsed.host_process.generation.start_microseconds = number;
      have_micros = true;
    } else if (key == "socket" && !have_socket) {
      if (!pipe_name_valid(value)) return false;
      parsed.socket_name = std::string(value);
      have_socket = true;
    } else if (key == "wire" && !have_wire) {
      if (!parse_uint64(value, number) || number != 1) return false;
      parsed.wire_version = static_cast<std::uint32_t>(number);
      have_wire = true;
    } else if (key == "source" && !have_source) {
      if (!ascii_hex(value, 40)) return false;
      parsed.source_commit = std::string(value);
      have_source = true;
    } else {
      return false;
    }
  }
  if (!have_host || !have_pid || !have_seconds || !have_micros || !have_socket
      || !have_wire || !have_source || !parsed.host_process.valid()) {
    return false;
  }
  output = std::move(parsed);
  return true;
}

std::string WindowsEndpointRegistry::serialize_descriptor(
    const NativeEndpointDescriptor& descriptor) {
  if (descriptor.schema_version != 1 || !uuid_v4(descriptor.host_instance_id)
      || !descriptor.host_process.valid() || !pipe_name_valid(descriptor.socket_name)
      || descriptor.wire_version != 1 || !ascii_hex(descriptor.source_commit, 40)) {
    throw std::invalid_argument("invalid native endpoint descriptor");
  }
  return "AEMCP_NATIVE_ENDPOINT_V1\n"
      "host=" + descriptor.host_instance_id + "\n"
      "pid=" + std::to_string(descriptor.host_process.pid) + "\n"
      "startSeconds=" + std::to_string(descriptor.host_process.generation.start_seconds) + "\n"
      "startMicros=" + std::to_string(descriptor.host_process.generation.start_microseconds) + "\n"
      "socket=" + descriptor.socket_name + "\n"
      "wire=" + std::to_string(descriptor.wire_version) + "\n"
      "source=" + descriptor.source_commit + "\n";
}

WindowsEndpointRegistry::WindowsEndpointRegistry(
    PeerIdentityBackend& process_backend,
    EndpointRegistryConfig config)
    : process_backend_(process_backend), config_(std::move(config)) {}

WindowsEndpointRegistry::~WindowsEndpointRegistry() {
  stop();
}

EndpointResult WindowsEndpointRegistry::open_directories() {
  if (config_.runtime_root.empty()) {
    const char* base = std::getenv("LOCALAPPDATA");
    if (base == nullptr || *base == '\0') {
      return {EndpointCode::kRuntimeRootUnavailable, "local-appdata-unavailable"};
    }
    runtime_root_ = (std::filesystem::path(base) / "AfterEffectsMCP").string();
  } else {
    runtime_root_ = config_.runtime_root;
  }
  if (runtime_root_.empty() || runtime_root_.size() > 240) {
    return {EndpointCode::kRuntimeRootUnavailable, "runtime-root-invalid"};
  }
  std::error_code error;
  std::filesystem::create_directories(runtime_root_, error);
  if (error || !std::filesystem::is_directory(runtime_root_, error) || error) {
    return {EndpointCode::kRuntimeRootUnsafe, "runtime-root-unsafe"};
  }
  directory_path_ = (std::filesystem::path(runtime_root_) / kDirectoryName).string();
  std::filesystem::create_directories(directory_path_, error);
  if (error || !std::filesystem::is_directory(directory_path_, error) || error) {
    return {EndpointCode::kRuntimeRootUnsafe, "endpoint-directory-create-failed"};
  }
  return {EndpointCode::kOk, {}};
}

bool WindowsEndpointRegistry::host_descriptor_alive(
    const NativeEndpointDescriptor& candidate) noexcept {
  ProcessSnapshot snapshot{};
  if (!process_backend_.process_snapshot(candidate.host_process.pid, snapshot)) {
    return false;
  }
  return snapshot.generation == candidate.host_process.generation;
}

EndpointResult WindowsEndpointRegistry::cleanup_stale() {
  std::error_code error;
  std::size_t entries = 0;
  for (const auto& item : std::filesystem::directory_iterator(directory_path_, error)) {
    if (error) return {EndpointCode::kRuntimeRootUnsafe, "endpoint-directory-unreadable"};
    if (++entries > config_.maximum_directory_entries) {
      return {EndpointCode::kDirectoryLimitExceeded, "endpoint-directory-overflow"};
    }
    if (!item.is_regular_file(error) || error
        || item.path().extension() != ".endpoint") {
      continue;
    }
    std::string text;
    {
      std::ifstream input(item.path(), std::ios::binary);
      text.assign(
          (std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    }
    NativeEndpointDescriptor candidate{};
    if (!WindowsEndpointRegistry::parse_descriptor(text, candidate)) {
      return {EndpointCode::kStaleEntryUnsafe, "stale-descriptor-unparseable"};
    }
    if (!host_descriptor_alive(candidate)) {
      std::filesystem::remove(item.path(), error);
      if (error) return {EndpointCode::kStaleEntryUnsafe, "stale-descriptor-remove-failed"};
    }
  }
  return {EndpointCode::kOk, {}};
}

EndpointResult WindowsEndpointRegistry::create_listener() {
  pipe_name_ = std::string(kPipePrefix) + config_.endpoint_nonce;
  if (!pipe_name_valid(pipe_name_)) {
    return {EndpointCode::kInvalidArgument, "endpoint-nonce-invalid"};
  }
  SecurityDescriptorOwner security;
  SECURITY_ATTRIBUTES* attributes = security.same_user_attributes();
  if (attributes == nullptr) {
    return {EndpointCode::kSocketCreateFailed, "same-user-acl-unavailable"};
  }
  listener_pipe_ = CreateNamedPipeW(
      widen(pipe_name_).c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1,
      8192,
      8192,
      0,
      attributes);
  if (listener_pipe_ == nullptr || listener_pipe_ == INVALID_HANDLE_VALUE) {
    listener_pipe_ = nullptr;
    return {EndpointCode::kSocketCreateFailed, "pipe-create-failed"};
  }
  return {EndpointCode::kOk, {}};
}

EndpointResult WindowsEndpointRegistry::publish_descriptor() {
  // Descriptor files carry the host instance UUID (d-<uuid>.endpoint), the
  // same naming the macOS registry and the shared client discovery use.
  descriptor_path_ =
      (std::filesystem::path(directory_path_)
       / ("d-" + descriptor_.host_instance_id + ".endpoint")).string();
  const std::string body = serialize_descriptor(descriptor_);
  {
    std::ofstream output(
        descriptor_path_, std::ios::binary | std::ios::trunc);
    if (!output) return {EndpointCode::kDescriptorPublishFailed, "descriptor-write-failed"};
    output << body;
    output.flush();
    if (!output) return {EndpointCode::kDescriptorPublishFailed, "descriptor-write-failed"};
  }
  std::ifstream verify_input(descriptor_path_, std::ios::binary);
  std::string reread(
      (std::istreambuf_iterator<char>(verify_input)), std::istreambuf_iterator<char>());
  if (reread != body) {
    return {EndpointCode::kDescriptorPublishFailed, "descriptor-verify-failed"};
  }
  return {EndpointCode::kOk, {}};
}

EndpointResult WindowsEndpointRegistry::start(NativeEndpointDescriptor descriptor) {
  if (started_) return {EndpointCode::kAlreadyStarted, "endpoint-already-started"};
  // The registry derives the endpoint name from the validated nonce, like the
  // macOS registry derives its socket name; callers never choose it.
  descriptor.socket_name = std::string(kPipePrefix) + config_.endpoint_nonce;
  try {
    (void)serialize_descriptor(descriptor);
  } catch (...) {
    return {EndpointCode::kInvalidArgument, "descriptor-invalid"};
  }
  descriptor_ = std::move(descriptor);
  for (const auto step : {
           &WindowsEndpointRegistry::open_directories,
           &WindowsEndpointRegistry::cleanup_stale,
           &WindowsEndpointRegistry::create_listener,
           &WindowsEndpointRegistry::publish_descriptor,
       }) {
    const EndpointResult result = (this->*step)();
    if (!result.ok()) {
      stop();
      return result;
    }
  }
  started_ = true;
  return {EndpointCode::kOk, {}};
}

EndpointResult WindowsEndpointRegistry::verify() const {
  if (!started_ || listener_pipe_ == nullptr) {
    return {EndpointCode::kInvalidArgument, "endpoint-not-started"};
  }
  std::ifstream input(descriptor_path_, std::ios::binary);
  std::string text(
      (std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  NativeEndpointDescriptor published{};
  if (!WindowsEndpointRegistry::parse_descriptor(text, published)) {
    return {EndpointCode::kEndpointReplaced, "descriptor-missing-or-invalid"};
  }
  if (published.host_instance_id != descriptor_.host_instance_id
      || published.host_process.pid != descriptor_.host_process.pid
      || published.host_process.generation != descriptor_.host_process.generation
      || published.socket_name != descriptor_.socket_name
      || published.wire_version != descriptor_.wire_version
      || published.source_commit != descriptor_.source_commit) {
    return {EndpointCode::kEndpointReplaced, "descriptor-replaced"};
  }
  return {EndpointCode::kOk, {}};
}

void WindowsEndpointRegistry::stop() noexcept {
  if (listener_pipe_ != nullptr) {
    (void)DisconnectNamedPipe(listener_pipe_);
    CloseHandle(listener_pipe_);
    listener_pipe_ = nullptr;
  }
  if (started_ && !descriptor_path_.empty()) {
    std::string text;
    {
      std::ifstream input(descriptor_path_, std::ios::binary);
      text.assign(
          (std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    }
    NativeEndpointDescriptor published{};
    if (WindowsEndpointRegistry::parse_descriptor(text, published)
        && published.host_instance_id == descriptor_.host_instance_id
        && published.socket_name == descriptor_.socket_name) {
      std::error_code error;
      std::filesystem::remove(descriptor_path_, error);
    }
  }
  started_ = false;
}

const char* endpoint_code_name(EndpointCode code) noexcept {
  switch (code) {
    case EndpointCode::kOk: return "ok";
    case EndpointCode::kInvalidArgument: return "invalid-argument";
    case EndpointCode::kRuntimeRootUnavailable: return "runtime-root-unavailable";
    case EndpointCode::kRuntimeRootUnsafe: return "runtime-root-unsafe";
    case EndpointCode::kDirectoryLimitExceeded: return "directory-limit-exceeded";
    case EndpointCode::kStaleEntryUnsafe: return "stale-entry-unsafe";
    case EndpointCode::kSocketCreateFailed: return "socket-create-failed";
    case EndpointCode::kSocketPublishFailed: return "socket-publish-failed";
    case EndpointCode::kDescriptorPublishFailed: return "descriptor-publish-failed";
    case EndpointCode::kEndpointReplaced: return "endpoint-replaced";
    case EndpointCode::kAlreadyStarted: return "already-started";
  }
  return "unknown";
}

}  // namespace aemcp::native
