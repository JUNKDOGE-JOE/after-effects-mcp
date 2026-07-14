#pragma once

#include "aemcp_native/peer_identity.hpp"

#include <memory>

namespace aemcp::native {

[[nodiscard]] std::unique_ptr<PeerIdentityBackend> create_macos_peer_identity_backend();
[[nodiscard]] ExpectedProcess current_macos_process(PeerIdentityBackend& backend);
[[nodiscard]] std::int32_t macos_native_cpu_type() noexcept;

}  // namespace aemcp::native
