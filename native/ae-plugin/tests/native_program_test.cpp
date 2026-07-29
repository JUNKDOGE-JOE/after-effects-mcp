#include "aemcp_native/native_program.hpp"
#include "aemcp_native/native_primitive_registry.generated.hpp"
#include "aemcp_native/rpc_codec.hpp"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using aemcp::native::NativeProgram;
using aemcp::native::ProgramAdmission;
using aemcp::native::digest_native_program;
using aemcp::native::native_primitive_registry;
using aemcp::native::parse_json_object;
using aemcp::native::parse_native_program;
using aemcp::native::validate_native_program;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void rejects(const std::function<void()>& action, const std::string& label) {
  try {
    action();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(label + " was accepted");
}

std::string composition_locator() {
  return R"({"kind":"composition","hostInstanceId":"host","sessionId":"session","projectId":"project","generation":1,"objectId":"composition"})";
}

std::string property_locator() {
  return R"({"kind":"stream","hostInstanceId":"host","sessionId":"session","projectId":"project","generation":1,"objectId":"property"})";
}

NativeProgram program(const std::string& json) {
  return parse_native_program(parse_json_object(json));
}

ProgramAdmission admit(const std::string& json) {
  return validate_native_program(program(json), native_primitive_registry());
}

std::vector<std::uint8_t> frame(const std::string& json) {
  std::vector<std::uint8_t> result(4 + json.size());
  const auto size = static_cast<std::uint32_t>(json.size());
  result[0] = static_cast<std::uint8_t>(size >> 24U);
  result[1] = static_cast<std::uint8_t>(size >> 16U);
  result[2] = static_cast<std::uint8_t>(size >> 8U);
  result[3] = static_cast<std::uint8_t>(size);
  std::copy(json.begin(), json.end(), result.begin() + 4);
  return result;
}

void read_program_needs_no_write_key() {
  const ProgramAdmission admission = admit(
      R"({"operations":[{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"saveAs":"composition"}]})");
  require(!admission.contains_write, "read program was classified as a write");
}

void write_program_requires_operation_key_and_undo_group() {
  const std::string operations = R"([{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"saveAs":"composition"},{"op":"composition.time.set","args":{"composition":{"ref":"composition"},"targetTime":{"value":1,"scale":1}}}])";
  rejects([&] { (void)admit(R"({"operations":)" + operations + "}"); },
      "write without operationKey and undoGroup");
  rejects([&] { (void)admit(R"({"operationKey":"program-key-0001","operations":)"
      + operations + "}"); }, "write without undoGroup");
  rejects([&] { (void)admit(R"({"undoGroup":"Set time","operations":)"
      + operations + "}"); }, "write without operationKey");
}

void unknown_primitive_duplicate_or_invalid_refs_fail_admission() {
  rejects([] { (void)admit(R"({"operations":[{"op":"missing.operation","args":{}}]})"); },
      "unknown primitive");
  rejects([&] { (void)admit(
      R"({"operations":[{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"saveAs":"value"},{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"saveAs":"value"}]})"); }, "duplicate saveAs");
  rejects([] { (void)admit(R"({"operations":[{"op":"composition.time.read","args":{"composition":{"ref":"later"}}},{"op":"composition.resolve","args":{"locator":{}} ,"saveAs":"later"}]})"); },
      "forward ref");
  rejects([] { (void)admit(R"({"operations":[{"op":"composition.time.read","args":{"composition":{"ref":"missing"}}}]})"); },
      "unknown ref");
}

void reference_kinds_and_exports_are_closed() {
  rejects([&] { (void)admit(
      R"({"operations":[{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"saveAs":"composition"},{"op":"property.resolve","args":{"layer":{"ref":"composition"},"locator":)"
      + property_locator() + R"(}}]})"); }, "composition accepted for layer reference");
  rejects([&] { (void)admit(
      R"({"operations":[{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"returnAs":"escaped"}]})"); }, "resolver export");
}

void program_is_bounded_and_digest_binds_arguments() {
  std::string operations;
  for (int index = 0; index != 65; ++index) {
    if (!operations.empty()) operations += ',';
    operations += R"({"op":"project.items.list","args":{}})";
  }
  rejects([&] { (void)admit(R"({"operations":[)" + operations + "]}"); },
      "65 operations");
  const NativeProgram first = program(R"({"operations":[{"op":"project.items.list","args":{}}]})");
  const NativeProgram second = program(R"({"operations":[{"op":"project.items.list","args":{"limit":1}}]})");
  require(digest_native_program(first).size() == 64, "program digest is not SHA-256");
  require(digest_native_program(first) != digest_native_program(second),
      "program digest ignored operation arguments");
}

void codec_accepts_only_the_native_program_invoke_shape() {
  const std::string legacy = R"({"wireVersion":1,"kind":"request","sessionId":"session","requestId":"legacy","method":"invoke","params":{"capabilityId":"ae.layer.track-matte.set","capabilityVersion":1,"arguments":{}}})";
  rejects([&] {
    const auto encoded = frame(legacy);
    (void)aemcp::native::rpc::decode_request_frame(encoded);
  }, "legacy operation-specific invoke");
  const std::string accepted = R"({"wireVersion":1,"kind":"request","sessionId":"11111111-1111-4111-8111-111111111111","requestId":"native","method":"invoke","params":{"capabilityId":"ae.native.exec","capabilityVersion":1,"arguments":{"operations":[{"op":"composition.resolve","args":{"locator":)"
      + composition_locator() + R"(},"saveAs":"composition"}]}}})";
  const auto parsed = aemcp::native::rpc::decode_request_frame(frame(accepted));
  require(std::holds_alternative<aemcp::native::rpc::NativeProgramParams>(parsed.params),
      "native program did not become the invoke wire parameter");
}

}  // namespace

int main() {
  try {
    read_program_needs_no_write_key();
    write_program_requires_operation_key_and_undo_group();
    unknown_primitive_duplicate_or_invalid_refs_fail_admission();
    reference_kinds_and_exports_are_closed();
    program_is_bounded_and_digest_binds_arguments();
    codec_accepts_only_the_native_program_invoke_shape();
    std::cout << "native_program_test: PASS\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "native_program_test: " << error.what() << '\n';
    return 1;
  }
}
