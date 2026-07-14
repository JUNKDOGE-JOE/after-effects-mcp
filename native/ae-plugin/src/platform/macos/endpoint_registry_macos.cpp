#include "aemcp_native/endpoint_registry_macos.hpp"

#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace aemcp::native {
namespace {

constexpr std::string_view kDirectoryName = "aemcp-n1";
constexpr std::size_t kMaximumDescriptorBytes = 1024;

bool ascii_hex(std::string_view value, std::size_t size) {
  return value.size() == size && std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
}

bool uuid_v4(std::string_view value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-'
      || value[18] != '-' || value[23] != '-' || value[14] != '4'
      || !(value[19] == '8' || value[19] == '9'
          || value[19] == 'a' || value[19] == 'b')) {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    const unsigned char c = static_cast<unsigned char>(value[index]);
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool socket_basename(std::string_view value) {
  constexpr std::string_view prefix = "s-";
  constexpr std::string_view suffix = ".sock";
  if (!value.starts_with(prefix) || !value.ends_with(suffix)) return false;
  return ascii_hex(value.substr(prefix.size(), value.size() - prefix.size() - suffix.size()), 12);
}

bool descriptor_basename(std::string_view value) {
  constexpr std::string_view prefix = "d-";
  constexpr std::string_view suffix = ".endpoint";
  if (!value.starts_with(prefix) || !value.ends_with(suffix)) return false;
  return uuid_v4(value.substr(prefix.size(), value.size() - prefix.size() - suffix.size()));
}

bool private_directory(const struct stat& status, uid_t uid) {
  return S_ISDIR(status.st_mode) && status.st_uid == uid
      && (status.st_mode & 0077) == 0;
}

bool private_regular(const struct stat& status, uid_t uid) {
  return S_ISREG(status.st_mode) && status.st_uid == uid && status.st_nlink == 1
      && (status.st_mode & 0777) == 0600;
}

bool private_socket(const struct stat& status, uid_t uid) {
  return S_ISSOCK(status.st_mode) && status.st_uid == uid && status.st_nlink == 1
      && (status.st_mode & 0777) == 0600;
}

bool read_bounded_file(int descriptor, std::string& output) {
  struct stat status {};
  if (::fstat(descriptor, &status) != 0 || !private_regular(status, ::getuid())
      || status.st_size <= 0
      || static_cast<std::uint64_t>(status.st_size) > kMaximumDescriptorBytes) {
    return false;
  }
  output.assign(static_cast<std::size_t>(status.st_size), '\0');
  std::size_t read_bytes = 0;
  while (read_bytes < output.size()) {
    const ssize_t count = ::pread(
        descriptor, output.data() + read_bytes, output.size() - read_bytes,
        static_cast<off_t>(read_bytes));
    if (count > 0) read_bytes += static_cast<std::size_t>(count);
    else if (count < 0 && errno == EINTR) continue;
    else return false;
  }
  struct stat after {};
  return ::fstat(descriptor, &after) == 0 && after.st_dev == status.st_dev
      && after.st_ino == status.st_ino && after.st_size == status.st_size;
}

template <typename Integer>
bool parse_integer(std::string_view value, Integer& output) {
  if (value.empty() || value.size() > 20) return false;
  Integer parsed{};
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (error != std::errc{} || end != value.data() + value.size()) return false;
  output = parsed;
  return true;
}

std::vector<std::string_view> exact_lines(const std::string& text) {
  std::vector<std::string_view> lines;
  std::size_t start = 0;
  while (start < text.size()) {
    const std::size_t end = text.find('\n', start);
    if (end == std::string::npos) return {};
    lines.emplace_back(text.data() + start, end - start);
    start = end + 1;
  }
  return lines;
}

bool safe_name_value(std::string_view line, std::string_view name, std::string_view& value) {
  if (!line.starts_with(name) || line.size() <= name.size()) return false;
  value = line.substr(name.size());
  return true;
}

}  // namespace

MacEndpointRegistry::MacEndpointRegistry(
    PeerIdentityBackend& process_backend,
    EndpointRegistryConfig config)
    : process_backend_(process_backend), config_(std::move(config)) {}

MacEndpointRegistry::~MacEndpointRegistry() {
  stop();
}

EndpointResult MacEndpointRegistry::start(NativeEndpointDescriptor descriptor) {
  if (started_ || listener_fd_ >= 0) return {EndpointCode::kAlreadyStarted, "already-started"};
  descriptor_ = std::move(descriptor);
  if (descriptor_.schema_version != 1 || !uuid_v4(descriptor_.host_instance_id)
      || !descriptor_.host_process.valid() || descriptor_.wire_version != 1
      || !ascii_hex(descriptor_.source_commit, 40)
      || !ascii_hex(config_.endpoint_nonce, 12)
      || config_.listen_backlog < 1 || config_.listen_backlog > 8
      || config_.maximum_directory_entries < 8
      || config_.maximum_directory_entries > 1024) {
    stop();
    return {EndpointCode::kInvalidArgument, "invalid-endpoint-config"};
  }
  descriptor_.socket_name = "s-" + config_.endpoint_nonce + ".sock";
  if (EndpointResult result = open_directories(); !result.ok()) {
    stop();
    return result;
  }
  if (EndpointResult result = cleanup_stale(); !result.ok()) {
    stop();
    return result;
  }
  if (EndpointResult result = create_listener(); !result.ok()) {
    stop();
    return result;
  }
  if (EndpointResult result = publish_descriptor(); !result.ok()) {
    stop();
    return result;
  }
  started_ = true;
  if (EndpointResult result = verify(); !result.ok()) {
    stop();
    return result;
  }
  return {EndpointCode::kOk, "ok"};
}

EndpointResult MacEndpointRegistry::verify() const {
  if (!started_ || directory_fd_ < 0 || listener_fd_ < 0
      || descriptor_entry_.name.empty() || socket_entry_.name.empty()) {
    return {EndpointCode::kEndpointReplaced, "endpoint-not-active"};
  }
  struct stat directory {};
  if (::fstat(directory_fd_, &directory) != 0 || !private_directory(directory, ::getuid())) {
    return {EndpointCode::kEndpointReplaced, "endpoint-directory-changed"};
  }
  struct stat socket_status {};
  if (::fstatat(
          directory_fd_, socket_entry_.name.c_str(), &socket_status,
          AT_SYMLINK_NOFOLLOW) != 0
      || !private_socket(socket_status, ::getuid())
      || static_cast<std::uint64_t>(socket_status.st_dev) != socket_entry_.device
      || static_cast<std::uint64_t>(socket_status.st_ino) != socket_entry_.inode) {
    return {EndpointCode::kEndpointReplaced, "endpoint-socket-changed"};
  }
  struct stat descriptor_status {};
  if (::fstatat(
          directory_fd_, descriptor_entry_.name.c_str(), &descriptor_status,
          AT_SYMLINK_NOFOLLOW) != 0
      || !private_regular(descriptor_status, ::getuid())
      || static_cast<std::uint64_t>(descriptor_status.st_dev) != descriptor_entry_.device
      || static_cast<std::uint64_t>(descriptor_status.st_ino) != descriptor_entry_.inode) {
    return {EndpointCode::kEndpointReplaced, "endpoint-descriptor-changed"};
  }
  return {EndpointCode::kOk, "ok"};
}

void MacEndpointRegistry::stop() noexcept {
  started_ = false;
  if (listener_fd_ >= 0) {
    ::shutdown(listener_fd_, SHUT_RDWR);
    ::close(listener_fd_);
    listener_fd_ = -1;
  }
  const bool descriptor_removed = safe_unlink(descriptor_entry_, false);
  const bool socket_removed = safe_unlink(socket_entry_, true);
  (void)descriptor_removed;
  (void)socket_removed;
  descriptor_entry_ = {};
  socket_entry_ = {};
  descriptor_path_.clear();
  socket_path_.clear();
  if (directory_fd_ >= 0) {
    ::close(directory_fd_);
    directory_fd_ = -1;
  }
  if (root_fd_ >= 0) {
    ::close(root_fd_);
    root_fd_ = -1;
  }
  directory_path_.clear();
  runtime_root_.clear();
}

bool MacEndpointRegistry::parse_descriptor(
    const std::string& text,
    NativeEndpointDescriptor& output) noexcept {
  try {
    const auto lines = exact_lines(text);
    if (lines.size() != 8 || lines[0] != "AEMCP_NATIVE_ENDPOINT_V1") return false;
    std::string_view host;
    std::string_view pid;
    std::string_view seconds;
    std::string_view micros;
    std::string_view socket;
    std::string_view wire;
    std::string_view source;
    if (!safe_name_value(lines[1], "host=", host)
        || !safe_name_value(lines[2], "pid=", pid)
        || !safe_name_value(lines[3], "startSeconds=", seconds)
        || !safe_name_value(lines[4], "startMicros=", micros)
        || !safe_name_value(lines[5], "socket=", socket)
        || !safe_name_value(lines[6], "wire=", wire)
        || !safe_name_value(lines[7], "source=", source)
        || !uuid_v4(host) || !socket_basename(socket) || !ascii_hex(source, 40)) {
      return false;
    }
    NativeEndpointDescriptor parsed;
    parsed.host_instance_id = std::string(host);
    parsed.socket_name = std::string(socket);
    parsed.source_commit = std::string(source);
    if (!parse_integer(pid, parsed.host_process.pid)
        || !parse_integer(seconds, parsed.host_process.generation.start_seconds)
        || !parse_integer(micros, parsed.host_process.generation.start_microseconds)
        || !parse_integer(wire, parsed.wire_version)
        || !parsed.host_process.valid() || parsed.wire_version != 1
        || parsed.host_process.generation.start_microseconds >= 1000000) {
      return false;
    }
    output = std::move(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

std::string MacEndpointRegistry::serialize_descriptor(
    const NativeEndpointDescriptor& descriptor) {
  if (descriptor.schema_version != 1 || !uuid_v4(descriptor.host_instance_id)
      || !descriptor.host_process.valid() || !socket_basename(descriptor.socket_name)
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

EndpointResult MacEndpointRegistry::open_directories() {
  if (config_.runtime_root.empty()) {
    const std::size_t bytes = ::confstr(_CS_DARWIN_USER_TEMP_DIR, nullptr, 0);
    if (bytes <= 1 || bytes > 4096) {
      return {EndpointCode::kRuntimeRootUnavailable, "darwin-user-temp-unavailable"};
    }
    runtime_root_.assign(bytes, '\0');
    if (::confstr(_CS_DARWIN_USER_TEMP_DIR, runtime_root_.data(), bytes) != bytes) {
      return {EndpointCode::kRuntimeRootUnavailable, "darwin-user-temp-changed"};
    }
    runtime_root_.resize(std::char_traits<char>::length(runtime_root_.c_str()));
  } else {
    runtime_root_ = config_.runtime_root;
  }
  root_fd_ = ::open(
      runtime_root_.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat root_status {};
  if (root_fd_ < 0 || ::fstat(root_fd_, &root_status) != 0
      || !private_directory(root_status, ::getuid())) {
    return {EndpointCode::kRuntimeRootUnsafe, "runtime-root-unsafe"};
  }
  if (::mkdirat(root_fd_, kDirectoryName.data(), 0700) != 0 && errno != EEXIST) {
    return {EndpointCode::kRuntimeRootUnsafe, "endpoint-directory-create-failed"};
  }
  directory_fd_ = ::openat(
      root_fd_, kDirectoryName.data(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat directory_status {};
  if (directory_fd_ < 0 || ::fstat(directory_fd_, &directory_status) != 0
      || !private_directory(directory_status, ::getuid())
      || ::fchmod(directory_fd_, 0700) != 0) {
    return {EndpointCode::kRuntimeRootUnsafe, "endpoint-directory-unsafe"};
  }
  std::array<char, 4096> path{};
  if (::fcntl(directory_fd_, F_GETPATH, path.data()) != 0) {
    return {EndpointCode::kRuntimeRootUnavailable, "endpoint-directory-path-unavailable"};
  }
  directory_path_ = path.data();
  return {EndpointCode::kOk, "ok"};
}

EndpointResult MacEndpointRegistry::cleanup_stale() {
  const int duplicate = ::dup(directory_fd_);
  if (duplicate < 0) return {EndpointCode::kRuntimeRootUnsafe, "directory-scan-failed"};
  DIR* stream = ::fdopendir(duplicate);
  if (stream == nullptr) {
    ::close(duplicate);
    return {EndpointCode::kRuntimeRootUnsafe, "directory-scan-failed"};
  }
  std::vector<std::string> descriptors;
  std::size_t observed = 0;
  errno = 0;
  while (dirent* entry = ::readdir(stream)) {
    const std::string_view name(entry->d_name);
    if (name == "." || name == "..") continue;
    if (++observed > config_.maximum_directory_entries) {
      ::closedir(stream);
      return {EndpointCode::kDirectoryLimitExceeded, "endpoint-directory-limit"};
    }
    if (descriptor_basename(name)) descriptors.emplace_back(name);
  }
  const int scan_error = errno;
  ::closedir(stream);
  if (scan_error != 0) return {EndpointCode::kRuntimeRootUnsafe, "directory-scan-failed"};

  for (const std::string& name : descriptors) {
    const int file = ::openat(directory_fd_, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (file < 0) return {EndpointCode::kStaleEntryUnsafe, "managed-descriptor-unsafe"};
    struct stat descriptor_status {};
    std::string text;
    const bool readable = ::fstat(file, &descriptor_status) == 0
        && read_bounded_file(file, text);
    ::close(file);
    NativeEndpointDescriptor stale;
    if (!readable || !parse_descriptor(text, stale)
        || name != "d-" + stale.host_instance_id + ".endpoint") {
      return {EndpointCode::kStaleEntryUnsafe, "managed-descriptor-invalid"};
    }
    ProcessSnapshot live;
    if (process_backend_.process_snapshot(stale.host_process.pid, live)
        && live.pid == stale.host_process.pid
        && live.generation == stale.host_process.generation) {
      continue;
    }

    struct stat socket_status {};
    if (::fstatat(
            directory_fd_, stale.socket_name.c_str(), &socket_status,
            AT_SYMLINK_NOFOLLOW) == 0) {
      if (!private_socket(socket_status, ::getuid())) {
        return {EndpointCode::kStaleEntryUnsafe, "managed-stale-socket-unsafe"};
      }
      PublishedEntry socket_entry{
          stale.socket_name,
          static_cast<std::uint64_t>(socket_status.st_dev),
          static_cast<std::uint64_t>(socket_status.st_ino),
      };
      if (!safe_unlink(socket_entry, true)) {
        return {EndpointCode::kStaleEntryUnsafe, "managed-stale-socket-changed"};
      }
    } else if (errno != ENOENT) {
      return {EndpointCode::kStaleEntryUnsafe, "managed-stale-socket-unreadable"};
    }
    PublishedEntry descriptor_entry{
        name,
        static_cast<std::uint64_t>(descriptor_status.st_dev),
        static_cast<std::uint64_t>(descriptor_status.st_ino),
    };
    if (!safe_unlink(descriptor_entry, false)) {
      return {EndpointCode::kStaleEntryUnsafe, "managed-stale-descriptor-changed"};
    }
  }
  return {EndpointCode::kOk, "ok"};
}

EndpointResult MacEndpointRegistry::create_listener() {
  socket_entry_.name = descriptor_.socket_name;
  socket_path_ = directory_path_ + "/" + socket_entry_.name;
  if (socket_path_.size() >= sizeof(sockaddr_un::sun_path)) {
    return {EndpointCode::kSocketCreateFailed, "endpoint-path-too-long"};
  }
  struct stat existing {};
  if (::fstatat(
          directory_fd_, socket_entry_.name.c_str(), &existing,
          AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    return {EndpointCode::kSocketPublishFailed, "endpoint-name-not-empty"};
  }
  listener_fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener_fd_ < 0) return {EndpointCode::kSocketCreateFailed, "socket-create-failed"};
  if (::fcntl(listener_fd_, F_SETFD, FD_CLOEXEC) != 0) {
    return {EndpointCode::kSocketCreateFailed, "socket-cloexec-failed"};
  }
  int no_sigpipe = 1;
  if (::setsockopt(listener_fd_, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) {
    return {EndpointCode::kSocketCreateFailed, "socket-option-failed"};
  }
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, socket_path_.c_str(), socket_path_.size() + 1);
  address.sun_len = SUN_LEN(&address);
  if (::bind(
          listener_fd_, reinterpret_cast<const sockaddr*>(&address),
          address.sun_len) != 0) {
    return {EndpointCode::kSocketPublishFailed,
        "socket-bind-failed-" + std::to_string(errno)};
  }
  if (::fchmodat(directory_fd_, socket_entry_.name.c_str(), 0600, AT_SYMLINK_NOFOLLOW) != 0) {
    return {EndpointCode::kSocketPublishFailed, "socket-permission-failed"};
  }
  struct stat status {};
  if (::fstatat(
          directory_fd_, socket_entry_.name.c_str(), &status,
          AT_SYMLINK_NOFOLLOW) != 0 || !private_socket(status, ::getuid())) {
    return {EndpointCode::kSocketPublishFailed, "socket-validation-failed"};
  }
  socket_entry_.device = static_cast<std::uint64_t>(status.st_dev);
  socket_entry_.inode = static_cast<std::uint64_t>(status.st_ino);
  if (::listen(listener_fd_, config_.listen_backlog) != 0) {
    return {EndpointCode::kSocketCreateFailed, "socket-listen-failed"};
  }
  return {EndpointCode::kOk, "ok"};
}

EndpointResult MacEndpointRegistry::publish_descriptor() {
  descriptor_entry_.name = "d-" + descriptor_.host_instance_id + ".endpoint";
  descriptor_path_ = directory_path_ + "/" + descriptor_entry_.name;
  struct stat existing {};
  if (::fstatat(
          directory_fd_, descriptor_entry_.name.c_str(), &existing,
          AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    return {EndpointCode::kDescriptorPublishFailed, "descriptor-name-not-empty"};
  }
  const std::string temporary = ".tmp-" + config_.endpoint_nonce;
  const int file = ::openat(
      directory_fd_, temporary.c_str(),
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      0600);
  if (file < 0) return {EndpointCode::kDescriptorPublishFailed, "descriptor-create-failed"};
  bool published = false;
  const auto cleanup = [&] {
    ::close(file);
    if (!published) ::unlinkat(directory_fd_, temporary.c_str(), 0);
  };
  const std::string text = serialize_descriptor(descriptor_);
  std::size_t written = 0;
  while (written < text.size()) {
    const ssize_t count = ::write(file, text.data() + written, text.size() - written);
    if (count > 0) written += static_cast<std::size_t>(count);
    else if (count < 0 && errno == EINTR) continue;
    else {
      cleanup();
      return {EndpointCode::kDescriptorPublishFailed, "descriptor-write-failed"};
    }
  }
  struct stat status {};
  if (::fchmod(file, 0600) != 0 || ::fsync(file) != 0 || ::fstat(file, &status) != 0
      || !private_regular(status, ::getuid())
      || status.st_size != static_cast<off_t>(text.size())) {
    cleanup();
    return {EndpointCode::kDescriptorPublishFailed, "descriptor-validation-failed"};
  }
  if (::renameat(
          directory_fd_, temporary.c_str(),
          directory_fd_, descriptor_entry_.name.c_str()) != 0
      || ::fsync(directory_fd_) != 0) {
    cleanup();
    return {EndpointCode::kDescriptorPublishFailed, "descriptor-rename-failed"};
  }
  published = true;
  descriptor_entry_.device = static_cast<std::uint64_t>(status.st_dev);
  descriptor_entry_.inode = static_cast<std::uint64_t>(status.st_ino);
  cleanup();
  return {EndpointCode::kOk, "ok"};
}

bool MacEndpointRegistry::safe_unlink(
    const PublishedEntry& entry,
    bool socket) const noexcept {
  if (directory_fd_ < 0 || entry.name.empty() || entry.device == 0 || entry.inode == 0) {
    return false;
  }
  struct stat status {};
  if (::fstatat(directory_fd_, entry.name.c_str(), &status, AT_SYMLINK_NOFOLLOW) != 0) {
    return errno == ENOENT;
  }
  const bool safe_type = socket
      ? private_socket(status, ::getuid()) : private_regular(status, ::getuid());
  if (!safe_type || static_cast<std::uint64_t>(status.st_dev) != entry.device
      || static_cast<std::uint64_t>(status.st_ino) != entry.inode) {
    return false;
  }
  return ::unlinkat(directory_fd_, entry.name.c_str(), 0) == 0 || errno == ENOENT;
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
