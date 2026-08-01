#pragma once

#include "aemcp_native/peer_identity.hpp"

#include <memory>

namespace aemcp::native {

// Windows peer-identity backend. Per the #88 NOT_PLANNED disposition the
// named-pipe transport performs NO peer authentication beyond the OS
// same-user pipe ACL; these probes exist so the shared observer/binding
// surface can still record OS-reported peer facts (never to gate admission).
[[nodiscard]] std::unique_ptr<PeerIdentityBackend> create_windows_peer_identity_backend();
[[nodiscard]] ExpectedProcess current_windows_process(PeerIdentityBackend& backend);
[[nodiscard]] std::int32_t windows_native_cpu_type() noexcept;

}  // namespace aemcp::native
