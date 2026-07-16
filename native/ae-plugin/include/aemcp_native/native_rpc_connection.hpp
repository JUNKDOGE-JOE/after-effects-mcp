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
  std::string capabilities_digest;
  std::string project_summary_contract_digest;
  std::string project_bit_depth_read_contract_digest;
  std::string project_bit_depth_set_contract_digest;
  std::string project_items_list_contract_digest;
  std::string composition_layers_list_contract_digest;
  std::string composition_time_read_contract_digest;
  std::string composition_time_set_contract_digest;
  std::string composition_create_contract_digest;
  std::string composition_layer_create_contract_digest;
  std::string layer_effect_apply_contract_digest;
  std::string layer_properties_list_contract_digest;
  std::string layer_property_set_contract_digest;
  std::string composition_selected_layers_list_contract_digest;
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
