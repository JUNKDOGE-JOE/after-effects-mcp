#import <AppKit/AppKit.h>

#include "aemcp_native/pairing_ui_macos.hpp"

#include <algorithm>
#include <string>

namespace aemcp::native {

PairingUiDecision show_pairing_confirmation(
    std::string_view fingerprint,
    std::chrono::milliseconds expires_in) noexcept {
  @autoreleasepool {
    try {
      if (fingerprint.size() != 9 || expires_in.count() <= 0) {
        return PairingUiDecision::kUnavailable;
      }
      const std::string fingerprint_text(fingerprint);
      NSAlert* alert = [[NSAlert alloc] init];
      alert.alertStyle = NSAlertStyleWarning;
      alert.messageText = @"Authorize ae-mcp native connection?";
      const auto seconds = std::max<long long>(1, expires_in.count() / 1000);
      alert.informativeText = [NSString stringWithFormat:
          @"Compare this fingerprint with the ae-mcp panel:\n\n%s\n\n"
           "Only authorize if both match. This request expires in about %lld seconds.",
          fingerprint_text.c_str(), seconds];
      [alert addButtonWithTitle:@"Authorize"];
      [alert addButtonWithTitle:@"Reject"];
      const NSModalResponse response = [alert runModal];
      return response == NSAlertFirstButtonReturn
          ? PairingUiDecision::kAuthorize : PairingUiDecision::kReject;
    } catch (...) {
      return PairingUiDecision::kUnavailable;
    }
  }
}

void show_no_pending_pairing() noexcept {
  @autoreleasepool {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleInformational;
    alert.messageText = @"No ae-mcp connection is waiting";
    alert.informativeText = @"Start the native connection from the ae-mcp panel, then choose this command again.";
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
  }
}

}  // namespace aemcp::native
