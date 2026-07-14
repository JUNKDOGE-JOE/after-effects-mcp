#include "aemcp_native/secure_random_macos.hpp"

#include <cstdlib>
#include <iostream>
#include <set>
#include <string>

namespace {

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

}  // namespace

int main() {
  aemcp::native::MacPairingMaterialSource source;
  std::set<std::string> uuids;
  std::set<std::string> fingerprints;
  for (int index = 0; index < 32; ++index) {
    const std::string uuid = aemcp::native::secure_uuid_v4();
    require(uuid.size() == 36 && uuid[14] == '4'
            && (uuid[19] == '8' || uuid[19] == '9'
                || uuid[19] == 'a' || uuid[19] == 'b'),
        "secure UUID shape is invalid");
    require(uuids.insert(uuid).second, "secure UUID repeated in smoke sample");
    const auto material = source.create();
    require(material.fingerprint.size() == 9 && material.fingerprint[4] == '-',
        "pairing fingerprint shape is invalid");
    require(fingerprints.insert(material.fingerprint).second,
        "pairing fingerprint repeated in smoke sample");
  }
  std::cout << "secure_random_macos_test: PASS\n";
  return 0;
}
