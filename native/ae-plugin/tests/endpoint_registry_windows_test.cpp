// Contract tests for the Windows named-pipe endpoint registry. They pin the
// same-user ACL boundary, naming scheme, metadata bounds, stale-entry cleanup,
// and descriptor ownership; peer facts remain observability-only metadata.

#include "../src/platform/windows/endpoint_registry_windows.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <string>

namespace {

using aemcp::native::EndpointCode;
using aemcp::native::EndpointRegistryConfig;
using aemcp::native::ExpectedProcess;
using aemcp::native::NativeEndpointDescriptor;
using aemcp::native::PeerIdentityBackend;
using aemcp::native::ProcessSnapshot;
using aemcp::native::SocketPeerEvidence;
using aemcp::native::WindowsEndpointRegistry;

[[noreturn]] void fail(const std::string &message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string &message) {
  if (!condition) fail(message);
}

class FakeBackend final : public PeerIdentityBackend {
 public:
  bool socket_peer(int, SocketPeerEvidence &) override { return false; }
  bool process_snapshot(std::int32_t pid, ProcessSnapshot &output) override {
    const auto found = processes.find(pid);
    if (found == processes.end()) return false;
    output = found->second;
    return true;
  }
  std::map<std::int32_t, ProcessSnapshot> processes;
};

struct TempRoot {
  TempRoot() {
    std::error_code error;
    path = std::filesystem::temp_directory_path(error).string();
    require(!error, "could not resolve temp root");
    path = (std::filesystem::path(path) /
            ("aemcp-endpoint-test-" + std::to_string(::GetCurrentProcessId())))
               .string();
    std::filesystem::remove_all(path, error);
    std::filesystem::create_directories(path, error);
    require(!error, "could not create temp root");
  }
  ~TempRoot() {
    std::error_code error;
    std::filesystem::remove_all(path, error);
  }
  std::string path;
};

NativeEndpointDescriptor descriptor(std::string host = "11111111-1111-4111-8111-111111111111",
                                    std::int32_t pid = 1234, std::uint64_t start = 50) {
  return {
      1,
      std::move(host),
      ExpectedProcess{pid, {start, 7}},
      "\\\\.\\pipe\\aemcp-n1-a1b2c3d4e5f6",
      1,
      "0123456789abcdef0123456789abcdef01234567",
  };
}

void publish_verify_and_cleanup() {
  TempRoot root;
  FakeBackend backend;
  WindowsEndpointRegistry registry(backend,
                                   EndpointRegistryConfig{root.path, "a1b2c3d4e5f6", 2, 32});
  const auto started = registry.start(descriptor());
  require(started.ok(), "valid endpoint did not start: " + started.diagnostic);
  require(registry.listener_pipe() != nullptr && registry.verify().ok(),
          "published endpoint did not verify");
  require(registry.pipe_name() == "\\\\.\\pipe\\aemcp-n1-a1b2c3d4e5f6",
          "pipe name drifted from the aemcp-n1 naming scheme");
  require(registry.descriptor().socket_name == registry.pipe_name(),
          "descriptor did not bind the derived pipe name");
  std::error_code error;
  require(std::filesystem::is_regular_file(registry.descriptor_path(), error),
          "descriptor file was not published");
  require(registry.descriptor_path().find("d-11111111-1111-4111-8111-111111111111.endpoint") !=
              std::string::npos,
          "descriptor file name does not carry the host instance id");
  const std::string descriptor_path = registry.descriptor_path();
  registry.stop();
  require(registry.listener_pipe() == nullptr, "pipe remained after stop");
  require(!std::filesystem::exists(descriptor_path, error), "descriptor remained after stop");
}

void replacement_is_detected_and_not_deleted() {
  TempRoot root;
  FakeBackend backend;
  WindowsEndpointRegistry registry(backend,
                                   EndpointRegistryConfig{root.path, "112233445566", 2, 32});
  require(registry.start(descriptor()).ok(), "replacement setup failed");
  const std::string descriptor_path = registry.descriptor_path();
  {
    std::ofstream replacement(descriptor_path, std::ios::binary | std::ios::trunc);
    replacement << "attacker\n";
  }
  require(registry.verify().code == EndpointCode::kEndpointReplaced,
          "descriptor replacement was not detected");
  registry.stop();
  std::error_code error;
  require(std::filesystem::is_regular_file(descriptor_path, error),
          "stop deleted a replacement it did not own");
}

void stale_owned_endpoint_is_recovered() {
  TempRoot root;
  FakeBackend backend;
  const std::string stale_path = (std::filesystem::path(root.path) / "aemcp-n1" /
                                  "d-22222222-2222-4222-8222-222222222222.endpoint")
                                     .string();
  std::filesystem::create_directories(std::filesystem::path(stale_path).parent_path());
  {
    // pid 9999 is absent from the fake backend, so the owning AE host is
    // gone and the entry is stale regardless of pipe state.
    std::ofstream stale(stale_path, std::ios::binary | std::ios::trunc);
    stale << WindowsEndpointRegistry::serialize_descriptor(
        descriptor("22222222-2222-4222-8222-222222222222", 9999, 99));
  }
  WindowsEndpointRegistry fresh(backend, EndpointRegistryConfig{root.path, "ddddeeeeffff", 2, 32});
  require(fresh.start(descriptor()).ok(), "fresh endpoint did not recover stale endpoint");
  std::error_code error;
  require(!std::filesystem::exists(stale_path, error), "stale descriptor was not removed");
}

void live_endpoint_is_never_collected() {
  TempRoot root;
  FakeBackend backend;
  ProcessSnapshot alive{};
  alive.pid = 4242;
  alive.generation = {50, 7};
  backend.processes.emplace(4242, alive);
  const std::string live_path = (std::filesystem::path(root.path) / "aemcp-n1" /
                                 "d-33333333-3333-4333-8333-333333333333.endpoint")
                                    .string();
  std::filesystem::create_directories(std::filesystem::path(live_path).parent_path());
  {
    std::ofstream live(live_path, std::ios::binary | std::ios::trunc);
    live << WindowsEndpointRegistry::serialize_descriptor(
        descriptor("33333333-3333-4333-8333-333333333333", 4242, 50));
  }
  WindowsEndpointRegistry fresh(backend, EndpointRegistryConfig{root.path, "eeeeffff0000", 2, 32});
  require(fresh.start(descriptor()).ok(), "fresh endpoint failed beside a live one");
  std::error_code error;
  require(std::filesystem::exists(live_path, error), "live descriptor was collected as stale");
}

void descriptor_parser_is_closed() {
  NativeEndpointDescriptor parsed;
  const std::string valid = WindowsEndpointRegistry::serialize_descriptor(descriptor());
  require(WindowsEndpointRegistry::parse_descriptor(valid, parsed), "valid descriptor rejected");
  require(parsed.host_process.pid == 1234 && !parsed.socket_name.empty(),
          "descriptor fields changed");
  require(!WindowsEndpointRegistry::parse_descriptor(valid + "extra=x\n", parsed),
          "extra descriptor field accepted");
  require(!WindowsEndpointRegistry::parse_descriptor(valid.substr(0, valid.size() - 1), parsed),
          "unterminated descriptor accepted");
  NativeEndpointDescriptor mutated = descriptor();
  mutated.socket_name = "\\\\.\\pipe\\other-a1b2c3d4e5f6";
  std::string text;
  try {
    text = WindowsEndpointRegistry::serialize_descriptor(mutated);
    fail("non-aemcp pipe name serialized");
  } catch (const std::invalid_argument &) {
  }
  mutated = descriptor();
  mutated.socket_name = "\\\\.\\pipe\\aemcp-n1-A1B2C3D4E5F6";
  try {
    text = WindowsEndpointRegistry::serialize_descriptor(mutated);
    fail("uppercase nonce serialized");
  } catch (const std::invalid_argument &) {
  }
  const std::string oversized(2048, 'x');
  require(!WindowsEndpointRegistry::parse_descriptor(oversized, parsed),
          "oversized descriptor accepted");
}

}  // namespace

int main() {
  publish_verify_and_cleanup();
  replacement_is_detected_and_not_deleted();
  stale_owned_endpoint_is_recovered();
  live_endpoint_is_never_collected();
  descriptor_parser_is_closed();
  std::cout << "endpoint_registry_windows_test: PASS\n";
  return 0;
}
