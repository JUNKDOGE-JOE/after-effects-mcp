#pragma once

#include <chrono>
#include <string_view>

namespace aemcp::native {

enum class PairingUiDecision { kAuthorize, kReject, kUnavailable };

[[nodiscard]] PairingUiDecision show_pairing_confirmation(
    std::string_view fingerprint,
    std::chrono::milliseconds expires_in) noexcept;
void show_no_pending_pairing() noexcept;

}  // namespace aemcp::native
