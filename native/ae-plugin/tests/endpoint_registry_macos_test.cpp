#include "aemcp_native/endpoint_registry_macos.hpp"

#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <array>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <map>
#include <string>

namespace {

using aemcp::native::EndpointCode;
using aemcp::native::EndpointRegistryConfig;
using aemcp::native::ExpectedProcess;
using aemcp::native::MacEndpointRegistry;
using aemcp::native::NativeEndpointDescriptor;
using aemcp::native::PeerIdentityBackend;
using aemcp::native::ProcessSnapshot;
using aemcp::native::SocketPeerEvidence;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

class FakeBackend final : public PeerIdentityBackend {
 public:
  bool socket_peer(int, SocketPeerEvidence&) override { return false; }
  bool process_snapshot(std::int32_t pid, ProcessSnapshot& output) override {
    const auto found = processes.find(pid);
    if (found == processes.end()) return false;
    output = found->second;
    return true;
  }
  std::map<std::int32_t, ProcessSnapshot> processes;
};

struct TempRoot {
  TempRoot() {
    std::array<char, 64> pattern{};
    const std::string prefix = "/private/tmp/aemcp-endpoint-test-XXXXXX";
    std::copy(prefix.begin(), prefix.end(), pattern.begin());
    char* created = ::mkdtemp(pattern.data());
    if (created == nullptr) fail("could not create temp root");
    path = created;
    if (::chmod(path.c_str(), 0700) != 0) fail("could not secure temp root");
  }
  ~TempRoot() { std::filesystem::remove_all(path); }
  std::string path;
};

NativeEndpointDescriptor descriptor(
    std::string host = "11111111-1111-4111-8111-111111111111",
    std::int32_t pid = 1234,
    std::uint64_t start = 50) {
  return {
      1,
      std::move(host),
      ExpectedProcess{pid, {start, 7}},
      "s-abcdef123456.sock",
      1,
      "0123456789abcdef0123456789abcdef01234567",
  };
}

void publish_verify_and_cleanup() {
  TempRoot root;
  FakeBackend backend;
  MacEndpointRegistry registry(backend, EndpointRegistryConfig{
      root.path, "a1b2c3d4e5f6", 2, 32});
  const auto started = registry.start(descriptor());
  require(started.ok(), "valid endpoint did not start: " + started.diagnostic);
  require(registry.listener_fd() >= 0 && registry.verify().ok(),
      "published endpoint did not verify");
  struct stat socket_status {};
  struct stat descriptor_status {};
  require(::lstat(registry.socket_path().c_str(), &socket_status) == 0
          && S_ISSOCK(socket_status.st_mode) && (socket_status.st_mode & 0777) == 0600,
      "socket was not private");
  require(::lstat(registry.descriptor_path().c_str(), &descriptor_status) == 0
          && S_ISREG(descriptor_status.st_mode) && (descriptor_status.st_mode & 0777) == 0600,
      "descriptor was not private");
  const std::string socket_path = registry.socket_path();
  const std::string descriptor_path = registry.descriptor_path();
  registry.stop();
  require(::lstat(socket_path.c_str(), &socket_status) != 0 && errno == ENOENT,
      "socket remained after stop");
  require(::lstat(descriptor_path.c_str(), &descriptor_status) != 0 && errno == ENOENT,
      "descriptor remained after stop");
}

void replacement_is_detected_and_not_deleted() {
  TempRoot root;
  FakeBackend backend;
  MacEndpointRegistry registry(backend, EndpointRegistryConfig{
      root.path, "112233445566", 2, 32});
  require(registry.start(descriptor()).ok(), "replacement setup failed");
  const std::string descriptor_path = registry.descriptor_path();
  require(::unlink(descriptor_path.c_str()) == 0, "could not replace descriptor");
  const int replacement = ::open(
      descriptor_path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  require(replacement >= 0, "could not create replacement descriptor");
  require(::write(replacement, "attacker\n", 9) == 9, "could not write replacement");
  ::close(replacement);
  require(registry.verify().code == EndpointCode::kEndpointReplaced,
      "descriptor replacement was not detected");
  registry.stop();
  struct stat status {};
  require(::lstat(descriptor_path.c_str(), &status) == 0 && S_ISREG(status.st_mode),
      "stop deleted a replacement it did not own");
}

void stale_owned_endpoint_is_recovered() {
  TempRoot root;
  FakeBackend backend;
  std::string stale_socket;
  std::string stale_descriptor;
  {
    MacEndpointRegistry stale(backend, EndpointRegistryConfig{
        root.path, "aaaabbbbcccc", 2, 32});
    require(stale.start(descriptor(
                "22222222-2222-4222-8222-222222222222", 9999, 99)).ok(),
        "stale setup failed");
    stale_socket = stale.socket_path();
    stale_descriptor = stale.descriptor_path();
    // Simulate SIGKILL: prevent the destructor from seeing its original inode
    // ownership by leaving copied managed entries after the normal stop.
    const std::string descriptor_text = MacEndpointRegistry::serialize_descriptor(stale.descriptor());
    const std::string directory = std::filesystem::path(stale_descriptor).parent_path();
    const std::string expected_socket = directory + "/" + stale.descriptor().socket_name;
    stale.stop();
    const int socket_fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    require(socket_fd >= 0, "could not recreate stale socket");
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::copy(expected_socket.begin(), expected_socket.end(), address.sun_path);
    address.sun_len = SUN_LEN(&address);
    require(::bind(socket_fd, reinterpret_cast<const sockaddr*>(&address), address.sun_len) == 0,
        "could not bind stale socket");
    require(::chmod(expected_socket.c_str(), 0600) == 0, "could not chmod stale socket");
    const int file = ::open(stale_descriptor.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
    require(file >= 0, "could not recreate stale descriptor");
    require(::write(file, descriptor_text.data(), descriptor_text.size())
            == static_cast<ssize_t>(descriptor_text.size()),
        "could not recreate stale descriptor text");
    ::close(file);
    ::close(socket_fd);
  }
  MacEndpointRegistry fresh(backend, EndpointRegistryConfig{
      root.path, "ddddeeeeffff", 2, 32});
  require(fresh.start(descriptor()).ok(), "fresh endpoint did not recover stale endpoint");
  struct stat status {};
  require(::lstat(stale_socket.c_str(), &status) != 0 && errno == ENOENT,
      "stale socket was not removed");
  require(::lstat(stale_descriptor.c_str(), &status) != 0 && errno == ENOENT,
      "stale descriptor was not removed");
}

void descriptor_parser_is_closed() {
  NativeEndpointDescriptor parsed;
  const std::string valid = MacEndpointRegistry::serialize_descriptor(descriptor());
  require(MacEndpointRegistry::parse_descriptor(valid, parsed), "valid descriptor rejected");
  require(parsed.host_process.pid == 1234 && parsed.socket_name.empty() == false,
      "descriptor fields changed");
  require(!MacEndpointRegistry::parse_descriptor(valid + "extra=x\n", parsed),
      "extra descriptor field accepted");
  require(!MacEndpointRegistry::parse_descriptor(
              valid.substr(0, valid.size() - 1), parsed),
      "unterminated descriptor accepted");
}

}  // namespace

int main() {
  publish_verify_and_cleanup();
  replacement_is_detected_and_not_deleted();
  stale_owned_endpoint_is_recovered();
  descriptor_parser_is_closed();
  std::cout << "endpoint_registry_macos_test: PASS\n";
  return 0;
}
