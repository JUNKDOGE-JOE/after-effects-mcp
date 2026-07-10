#import <Foundation/Foundation.h>

#include "common.hpp"

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

@protocol AEMCPPlatformHelperXPC
- (void)requestJSON:(NSData*)request
          withReply:(void (^)(NSData* response, NSError* error))reply;
@end

namespace aemcp::platform_helper {
namespace {

constexpr const char* kServiceName = "com.junkdoge.ae-mcp.platform-helper";

struct ReplyState {
  std::mutex mutex;
  std::condition_variable ready;
  bool complete{false};
  std::string response;
  std::string error;
};

void FinishReply(
    const std::shared_ptr<ReplyState>& state,
    NSData* response,
    NSError* error) {
  std::lock_guard<std::mutex> lock(state->mutex);
  if (state->complete) return;
  if (error != nil) {
    state->error = error.localizedDescription.UTF8String ?: "XPC request failed";
  } else if (response == nil || response.length > kMaxMessageBytes) {
    state->error = "XPC returned an invalid response";
  } else {
    state->response.assign(
        static_cast<const char*>(response.bytes),
        static_cast<std::size_t>(response.length));
  }
  state->complete = true;
  state->ready.notify_one();
}

class MacTransport final : public PlatformTransport {
 public:
  MacTransport() {
    NSString* service = [NSString stringWithUTF8String:kServiceName];
    connection_ = [[NSXPCConnection alloc] initWithMachServiceName:service options:0];
    connection_.remoteObjectInterface =
        [NSXPCInterface interfaceWithProtocol:@protocol(AEMCPPlatformHelperXPC)];
    [connection_ resume];
  }

  ~MacTransport() override { Close(); }

  std::string Request(const std::string& json_utf8) override {
    if (json_utf8.size() > kMaxMessageBytes) {
      throw std::runtime_error("platform helper request exceeds 65536 bytes");
    }
    std::lock_guard<std::mutex> serial(request_mutex_);
    NSXPCConnection* connection;
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (connection_ == nil) throw std::runtime_error("XPC transport is closed");
      connection = connection_;
    }

    NSData* request = [NSData dataWithBytes:json_utf8.data() length:json_utf8.size()];
    auto reply_state = std::make_shared<ReplyState>();
    id<AEMCPPlatformHelperXPC> proxy =
        [connection remoteObjectProxyWithErrorHandler:^(NSError* error) {
          FinishReply(reply_state, nil, error);
        }];
    [proxy requestJSON:request withReply:^(NSData* response, NSError* error) {
      FinishReply(reply_state, response, error);
    }];

    std::unique_lock<std::mutex> wait_lock(reply_state->mutex);
    if (!reply_state->ready.wait_for(
            wait_lock, std::chrono::seconds(10), [&] { return reply_state->complete; })) {
      throw std::runtime_error("XPC request timed out");
    }
    if (!reply_state->error.empty()) throw std::runtime_error(reply_state->error);
    return reply_state->response;
  }

  void Cancel() override {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (connection_ != nil) {
      [connection_ invalidate];
      connection_ = nil;
    }
  }

  void Close() override { Cancel(); }

 private:
  std::mutex request_mutex_;
  std::mutex state_mutex_;
  __strong NSXPCConnection* connection_{nil};
};

}  // namespace

std::shared_ptr<PlatformTransport> CreatePlatformTransport() {
  return std::make_shared<MacTransport>();
}

}  // namespace aemcp::platform_helper

NAPI_MODULE_INIT() {
  return aemcp::platform_helper::InitializeAddon(env, exports);
}
