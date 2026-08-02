#pragma once

#include "aemcp_native/peer_identity.hpp"

#include <memory>

namespace aemcp::native {

// The Windows named pipe uses an OS same-user ACL as an implementation
// constraint. These probes populate the shared observer and binding surfaces
// with OS-reported peer facts for diagnostics; they never gate admission.
[[nodiscard]] std::unique_ptr<PeerIdentityBackend> create_windows_peer_identity_backend();
[[nodiscard]] ExpectedProcess current_windows_process(PeerIdentityBackend& backend);
[[nodiscard]] std::int32_t windows_native_cpu_type() noexcept;

}  // namespace aemcp::native
