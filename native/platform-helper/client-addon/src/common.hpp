#pragma once

#include <node_api.h>

#include <cstddef>
#include <memory>
#include <string>

namespace aemcp::platform_helper {

inline constexpr std::size_t kMaxMessageBytes = 65536;

struct PlatformTransportOptions {
  std::string expected_server_path;
  std::string expected_server_sha256;
};

class PlatformTransport {
 public:
  virtual ~PlatformTransport() = default;
  virtual std::string Request(const std::string& json_utf8) = 0;
  virtual void Cancel() = 0;
  virtual void Close() = 0;
};

std::shared_ptr<PlatformTransport> CreatePlatformTransport(
    const PlatformTransportOptions& options);

napi_value CreateTransport(napi_env env, napi_callback_info info);
napi_value InitializeAddon(napi_env env, napi_value exports);

}  // namespace aemcp::platform_helper
