#pragma once

#include "aemcp_native/host_dispatcher.hpp"
#include "aemcp_native/mac_ipc_server.hpp"
#include "aemcp_native/rpc_codec.hpp"

#include <cstdint>
#include <string>
#include <string_view>

namespace aemcp::native {

struct NativeRpcRuntimeInfo {
  std::string plugin_version;
  std::string compiled_sdk_version;
  std::uint64_t compiled_sdk_build{0};
  std::string host_version;
  std::uint64_t host_build{0};
  std::string host_instance_id;
};

class NativeRpcObserver {
 public:
  virtual ~NativeRpcObserver() = default;
  virtual void on_rpc_event(
      std::string_view event,
      std::string_view request_id,
      std::string_view decision) noexcept = 0;
  virtual void on_rpc_terminal(
      const Completion& completion,
      std::string_view request_digest,
      std::string_view postcondition_digest,
      std::uint64_t started_at_unix_ms,
      std::uint64_t completed_at_unix_ms) noexcept = 0;
};

// Signals After Effects that its registered idle hooks should run. Production
// uses the SDK's worker-safe asynchronous wake routine; tests provide a fake.
// The signal never performs host work itself.
class HostIdleSignal {
 public:
  virtual ~HostIdleSignal() = default;
  [[nodiscard]] virtual bool request_idle() noexcept = 0;
};

// Classifies a terminal-evidence failure after host dispatch. Mutating
// capabilities must remain ambiguous because the host write may have landed.
[[nodiscard]] std::string_view post_dispatch_evidence_failure_code(
    std::string_view capability_id,
    bool graph_invalidation = false) noexcept;

// Owns #72 framing/session state on the single IPC worker and bridges only
// admitted invoke/cancel requests to HostDispatcher. It never calls HostApi;
// after a queued progress frame is delivered it only schedules AE's idle hook.
class NativeRpcConnectionHandler final : public AuthenticatedConnectionHandler {
 public:
  NativeRpcConnectionHandler(
      HostDispatcher& dispatcher,
      Clock& dispatcher_clock,
      rpc::SessionClock& session_clock,
      NativeRpcRuntimeInfo runtime,
      NativeRpcObserver& observer,
      HostIdleSignal& idle_signal);

  void serve(const AuthenticatedConnection& connection) noexcept override;

 private:
  HostDispatcher& dispatcher_;
  Clock& dispatcher_clock_;
  rpc::SessionClock& session_clock_;
  const NativeRpcRuntimeInfo runtime_;
  NativeRpcObserver& observer_;
  HostIdleSignal& idle_signal_;
};

}  // namespace aemcp::native
