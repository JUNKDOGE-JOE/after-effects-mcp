#include "aemcp_native/native_primitive_registry.generated.hpp"
#include "aemcp_native/native_program.hpp"
#include "aemcp_native/rpc_codec.hpp"
#include "../src/aegp/native_program_executor.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using aemcp::native::digest_native_program;
using aemcp::native::native_primitive_registry;
using aemcp::native::NativeProgram;
using aemcp::native::parse_json_object;
using aemcp::native::parse_native_program;
using aemcp::native::ProgramAdmission;
using aemcp::native::validate_native_program;
using namespace std::chrono_literals;

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

void rejects(const std::function<void()> &action, const std::string &label) {
  try {
    action();
  } catch (const std::exception &) {
    return;
  }
  throw std::runtime_error(label + " was accepted");
}

std::string composition_locator() {
  return R"({"kind":"composition","hostInstanceId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","projectId":"33333333-3333-4333-8333-333333333333","generation":1,"objectId":"44444444-4444-4444-8444-444444444444"})";
}

std::string property_locator() {
  return R"({"kind":"stream","hostInstanceId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","projectId":"33333333-3333-4333-8333-333333333333","generation":1,"objectId":"55555555-5555-4555-8555-555555555555"})";
}

std::string layer_locator() {
  return R"({"kind":"layer","hostInstanceId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","projectId":"33333333-3333-4333-8333-333333333333","generation":1,"objectId":"66666666-6666-4666-8666-666666666666"})";
}

NativeProgram program(const std::string &json) {
  return parse_native_program(parse_json_object(json));
}

ProgramAdmission admit(const std::string &json) {
  return validate_native_program(program(json), native_primitive_registry());
}

std::vector<std::uint8_t> frame(const std::string &json) {
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
  const ProgramAdmission admission =
      admit(R"({"operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() + R"(},"saveAs":"composition"}]})");
  require(!admission.contains_write, "read program was classified as a write");
}

void read_program_rejects_write_metadata() {
  const std::string operations =
      R"([{"op":"project.items.list","args":{"offset":0,"limit":1}}])";
  rejects(
      [&] {
        (void)admit(R"({"operationKey":"read-program-key-0001","operations":)" +
                    operations + "}");
      },
      "read program with operationKey");
  rejects(
      [&] {
        (void)admit(R"({"undoGroup":"Read must not open Undo","operations":)" +
                    operations + "}");
      },
      "read program with undoGroup");
  rejects(
      [&] {
        (void)admit(R"({"operationKey":"read-program-key-0001",)"
                    R"("undoGroup":"Read must not open Undo","operations":)" +
                    operations + "}");
      },
      "read program with operationKey and undoGroup");
}

void write_program_requires_operation_key_and_undo_group() {
  const std::string operations =
      R"([{"op":"composition.resolve","args":{"locator":)" +
      composition_locator() +
      R"(},"saveAs":"composition"},{"op":"composition.time.set","args":{"composition":{"ref":"composition"},"targetTime":{"value":1,"scale":1}}}])";
  rejects([&] { (void)admit(R"({"operations":)" + operations + "}"); },
          "write without operationKey and undoGroup");
  rejects(
      [&] {
        (void)admit(R"({"operationKey":"program-key-0001","operations":)" +
                    operations + "}");
      },
      "write without undoGroup");
  rejects(
      [&] {
        (void)admit(R"({"undoGroup":"Set time","operations":)" + operations +
                    "}");
      },
      "write without operationKey");
}

void write_program_undo_group_matches_terminal_bound() {
  const std::string operations =
      R"([{"op":"composition.resolve","args":{"locator":)" +
      composition_locator() +
      R"(},"saveAs":"composition"},{"op":"composition.time.set","args":{"composition":{"ref":"composition"},"targetTime":{"value":1,"scale":1}}}])";
  const std::string prefix =
      R"({"operationKey":"program-key-0001","undoGroup":")";
  const std::string suffix = R"(","operations":)" + operations + "}";
  (void)admit(prefix + std::string(128, 'u') + suffix);
  rejects([&] { (void)admit(prefix + std::string(129, 'u') + suffix); },
          "129-character undoGroup");
}

void unknown_primitive_duplicate_or_invalid_refs_fail_admission() {
  rejects(
      [] {
        (void)admit(R"({"operations":[{"op":"missing.operation","args":{}}]})");
      },
      "unknown primitive");
  rejects(
      [&] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() +
            R"(},"saveAs":"value"},{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() + R"(},"saveAs":"value"}]})");
      },
      "duplicate saveAs");
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"composition.time.read","args":{"composition":{"ref":"later"}}},{"op":"composition.resolve","args":{"locator":{}} ,"saveAs":"later"}]})");
      },
      "forward ref");
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"composition.time.read","args":{"composition":{"ref":"missing"}}}]})");
      },
      "unknown ref");
}

void reference_kinds_and_exports_are_closed() {
  rejects(
      [&] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() +
            R"(},"saveAs":"composition"},{"op":"property.resolve","args":{"layer":{"ref":"composition"},"locator":)" +
            property_locator() + R"(}}]})");
      },
      "composition accepted for layer reference");
  rejects(
      [&] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() + R"(},"returnAs":"escaped"}]})");
      },
      "resolver export");
}

void program_is_bounded_and_digest_binds_arguments() {
  std::string operations;
  for (int index = 0; index != 65; ++index) {
    if (!operations.empty())
      operations += ',';
    operations +=
        R"({"op":"project.items.list","args":{"offset":0,"limit":1}})";
  }
  rejects([&] { (void)admit(R"({"operations":[)" + operations + "]}"); },
          "65 operations");
  const NativeProgram first = program(
      R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1}}]})");
  const NativeProgram second = program(
      R"({"operations":[{"op":"project.items.list","args":{"limit":1}}]})");
  require(digest_native_program(first).size() == 64,
          "program digest is not SHA-256");
  require(digest_native_program(first) != digest_native_program(second),
          "program digest ignored operation arguments");
}

void literal_schemas_are_closed_and_bounded_before_dispatch() {
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{"unexpected":true}}]})");
      },
      "unexpected composition.resolve literal");
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{}}]})");
      },
      "missing composition locator");
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{"locator":{"kind":"composition","hostInstanceId":"not-a-uuid","sessionId":"22222222-2222-4222-8222-222222222222","projectId":"33333333-3333-4333-8333-333333333333","generation":1,"objectId":"44444444-4444-4444-8444-444444444444"}}}]})");
      },
      "bad root-ref locator");
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"project.items.list","args":{"offset":-1,"limit":1}}]})");
      },
      "negative page offset");
  rejects(
      [] {
        (void)admit(
            R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":51}}]})");
      },
      "limit upper bound");
  rejects(
      [&] {
        (void)admit(
            R"({"operationKey":"program-key-0001","undoGroup":"Set time","operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() +
            R"(},"saveAs":"composition"},{"op":"composition.time.set","args":{"composition":{"ref":"composition"},"targetTime":{"value":"1","scale":1}}}]})");
      },
      "wrong exact-time value type");
  rejects(
      [&] {
        (void)admit(
            R"({"operationKey":"program-key-0001","undoGroup":"Set time","operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() +
            R"(},"saveAs":"composition"},{"op":"composition.time.set","args":{"composition":{"ref":"composition"},"targetTime":{"value":1,"scale":0}}}]})");
      },
      "exact-time scale bound");
}

void named_results_and_unicode_parser_are_uniform() {
  rejects(
      [&] {
        (void)admit(
            R"({"operations":[{"op":"composition.resolve","args":{"locator":)" +
            composition_locator() +
            R"(},"returnAs":"name"},{"op":"project.items.list","args":{"offset":0,"limit":1},"returnAs":"name"}]})");
      },
      "duplicate returnAs");
  rejects(
      [&] {
        (void)admit(
            R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1},"saveAs":"name"},{"op":"project.items.list","args":{"offset":0,"limit":1},"returnAs":"name"}]})");
      },
      "saveAs returnAs namespace collision");
  const NativeProgram escaped = program(
      R"({"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1},"returnAs":"\uD83D\uDE80"}]})");
  const NativeProgram utf8 =
      program("{\"operations\":[{\"op\":\"project.items.list\",\"args\":{"
              "\"offset\":0,\"limit\":1},\"returnAs\":\"\xF0\x9F\x9A\x80\"}]}");
  require(digest_native_program(escaped) == digest_native_program(utf8),
          "unicode escape and UTF-8 JSON do not canonicalize identically");
  const std::string escaped_wire =
      R"({"wireVersion":1,"kind":"request","sessionId":"11111111-1111-4111-8111-111111111111","requestId":"unicode","method":"invoke","params":{"capabilityId":"ae.native.exec","capabilityVersion":1,"arguments":{"operations":[{"op":"project.items.list","args":{"offset":0,"limit":1},"returnAs":"\uD83D\uDE80"}]}}})";
  const std::string utf8_wire =
      "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\"11111111-1111-"
      "4111-8111-111111111111\",\"requestId\":\"unicode\",\"method\":"
      "\"invoke\",\"params\":{\"capabilityId\":\"ae.native.exec\","
      "\"capabilityVersion\":1,\"arguments\":{\"operations\":[{\"op\":"
      "\"project.items.list\",\"args\":{\"offset\":0,\"limit\":1},\"returnAs\":"
      "\"\xF0\x9F\x9A\x80\"}]}}}";
  require(aemcp::native::rpc::decode_request_frame(frame(escaped_wire))
                  .request_fingerprint_sha256 ==
              aemcp::native::rpc::decode_request_frame(frame(utf8_wire))
                  .request_fingerprint_sha256,
          "direct parser unicode canonicalization diverged from the wire path");
  rejects([] { (void)program(R"({"operations":[],"undoGroup":"\uD83D"})"); },
          "unpaired surrogate");
}

void codec_accepts_only_the_native_program_invoke_shape() {
  const std::string legacy =
      R"({"wireVersion":1,"kind":"request","sessionId":"session","requestId":"legacy","method":"invoke","params":{"capabilityId":"ae.retired.direct","capabilityVersion":1,"arguments":{}}})";
  rejects(
      [&] {
        const auto encoded = frame(legacy);
        (void)aemcp::native::rpc::decode_request_frame(encoded);
      },
      "legacy operation-specific invoke");
  const std::string accepted =
      R"({"wireVersion":1,"kind":"request","sessionId":"11111111-1111-4111-8111-111111111111","requestId":"native","method":"invoke","params":{"capabilityId":"ae.native.exec","capabilityVersion":1,"arguments":{"operations":[{"op":"composition.resolve","args":{"locator":)" +
      composition_locator() + R"(},"saveAs":"composition"}]}}})";
  const auto parsed = aemcp::native::rpc::decode_request_frame(frame(accepted));
  require(std::holds_alternative<aemcp::native::rpc::NativeProgramParams>(
              parsed.params),
          "native program did not become the invoke wire parameter");
}

class PropertyResultHost final
    : public aemcp::native::NativeProgramPrimitiveHost {
public:
  [[nodiscard]] aemcp::native::NativeHandleResolveResult
  resolve_native_handle(
      aemcp::native::HandleKind kind,
      const aemcp::native::ObjectLocator &locator,
      const std::optional<aemcp::native::ObjectLocator> &owner_locator,
      aemcp::native::TimePoint) override {
    if (kind == aemcp::native::HandleKind::kComposition) {
      return aemcp::native::NativeHandleResolveResult::success(
          aemcp::native::ScopedCompositionHandle{locator, 1});
    }
    if (!owner_locator.has_value()) {
      return aemcp::native::NativeHandleResolveResult::failure(
          "INVALID_ARGUMENT", "owner locator is required");
    }
    if (kind == aemcp::native::HandleKind::kLayer) {
      return aemcp::native::NativeHandleResolveResult::success(
          aemcp::native::ScopedLayerHandle{
              {locator, 2, 1},
          });
    }
    return aemcp::native::NativeHandleResolveResult::success(
        aemcp::native::ScopedPropertyHandle{locator, *owner_locator, 3});
  }

  [[nodiscard]] aemcp::native::HostLayerPropertiesResult
  list_layer_properties(const aemcp::native::LayerPropertiesQuery &query,
                        aemcp::native::TimePoint) override {
    aemcp::native::LayerPropertiesPage page;
    page.layer_locator = query.layer_locator;
    page.layer_name = "Layer";
    page.sample_time = {-3, 24};
    page.limit = query.limit;
    return aemcp::native::HostLayerPropertiesResult::success(std::move(page));
  }

  [[nodiscard]] aemcp::native::HostLayerPropertyKeyframesResult
  list_layer_property_keyframes(
      const aemcp::native::LayerPropertyKeyframesQuery &query,
      aemcp::native::TimePoint) override {
    aemcp::native::LayerPropertyKeyframesPage page;
    page.property_locator = query.property_locator;
    page.value_type = "one-d";
    page.total = 1;
    page.limit = query.limit;
    page.keyframes.push_back({
        1,
        {5, 24},
        aemcp::native::LayerPropertyScalarValue{"1"},
        "linear",
        "linear",
    });
    return aemcp::native::HostLayerPropertyKeyframesResult::success(
        std::move(page));
  }

  [[nodiscard]] aemcp::native::HostLayerPropertyKeyframeDetailsResult
  read_layer_property_keyframe_details(
      const aemcp::native::LayerPropertyKeyframeDetailsQuery &query,
      aemcp::native::TimePoint) override {
    return aemcp::native::HostLayerPropertyKeyframeDetailsResult::success(
        details(query.property_locator, {7, 24}));
  }

  [[nodiscard]] aemcp::native::HostLayerPropertyKeyframeWriteResult
  mutate_layer_property_keyframe(
      const aemcp::native::LayerPropertyKeyframeMutationCommand &command,
      aemcp::native::TimePoint) override {
    aemcp::native::LayerPropertyKeyframeChanged changed;
    changed.layer_locator = command.layer_locator;
    changed.property_locator = command.property_locator;
    changed.time = command.time;
    changed.keyframe_count_before = 1;
    changed.keyframe_count_after = 1;
    return aemcp::native::HostLayerPropertyKeyframeWriteResult::success(
        std::move(changed));
  }

private:
  [[nodiscard]] static aemcp::native::LayerPropertyKeyframeDetails
  details(const aemcp::native::ObjectLocator &property,
          aemcp::native::LayerPropertySampleTime time) {
    aemcp::native::LayerPropertyKeyframeDetails result;
    result.property_locator = property;
    result.time = time;
    result.value_type = "one-d";
    result.value = aemcp::native::LayerPropertyScalarValue{"1"};
    result.temporal_dimensionality = 1;
    result.in_interpolation = "linear";
    result.out_interpolation = "linear";
    result.temporal_ease.push_back({
        0,
        {"0", "33"},
        {"0", "33"},
    });
    return result;
  }
};

std::size_t count_text(std::string_view value, std::string_view needle) {
  std::size_t count = 0;
  std::size_t offset = 0;
  while ((offset = value.find(needle, offset)) != std::string_view::npos) {
    ++count;
    offset += needle.size();
  }
  return count;
}

void property_and_keyframe_adapters_emit_generated_time_shapes() {
  PropertyResultHost host;
  const std::string handles =
      R"({"op":"composition.resolve","args":{"locator":)" +
      composition_locator() +
      R"(},"saveAs":"composition"},{"op":"layer.resolve","args":{"composition":{"ref":"composition"},"locator":)" +
      layer_locator() +
      R"(},"saveAs":"layer"},{"op":"property.resolve","args":{"layer":{"ref":"layer"},"locator":)" +
      property_locator() + R"(},"saveAs":"property"})";
  const NativeProgram read = program(
      R"({"operations":[)" + handles +
      R"(,{"op":"layer.properties.list","args":{"layer":{"ref":"layer"},"offset":0,"limit":1},"returnAs":"properties"},{"op":"property.keyframes.list","args":{"property":{"ref":"property"},"offset":0,"limit":1},"returnAs":"keyframes"},{"op":"property.keyframe.details.read","args":{"property":{"ref":"property"},"time":{"value":7,"scale":24}},"returnAs":"details"}]})");
  const auto read_result = aemcp::native::execute_native_program(
      host, read, "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      std::chrono::steady_clock::now() + 1s);
  require(read_result.ok, "property read adapter program failed");
  const std::string read_json = aemcp::native::canonicalize_json(
      aemcp::native::JsonValue{read_result.outputs});
  require(read_json.find(
              "\"sampleTime\":{\"mode\":\"comp-time\",\"scale\":24,"
              "\"value\":-3}") != std::string::npos,
          "layer.properties.list sampleTime does not match generated schema");
  require(read_json.find(
              "\"time\":{\"mode\":\"comp-time\",\"scale\":24,\"value\":5}") !=
              std::string::npos,
          "property.keyframes.list time does not match generated schema");
  require(read_json.find(
              "\"time\":{\"scale\":24,\"secondsRational\":\"7/24\","
              "\"value\":7}") != std::string::npos,
          "keyframe details time is not an exact canonical rational");

  const std::string time = R"({"value":9,"scale":24})";
  const NativeProgram writes = program(
      R"({"operationKey":"property-keyframe-write-0001","undoGroup":"Mutate keyframes","operations":[)" +
      handles +
      R"(,{"op":"property.keyframe.add","args":{"layer":{"ref":"layer"},"property":{"ref":"property"},"time":)" +
      time +
      R"(,"value":{"kind":"scalar","value":"1"}},"returnAs":"add"},{"op":"property.keyframe.value.set","args":{"layer":{"ref":"layer"},"property":{"ref":"property"},"time":)" +
      time +
      R"(,"value":{"kind":"scalar","value":"2"}},"returnAs":"value"},{"op":"property.keyframe.interpolation.set","args":{"layer":{"ref":"layer"},"property":{"ref":"property"},"time":)" +
      time +
      R"(,"inInterpolation":"linear","outInterpolation":"bezier"},"returnAs":"interpolation"},{"op":"property.keyframe.temporalEase.set","args":{"layer":{"ref":"layer"},"property":{"ref":"property"},"time":)" +
      time +
      R"(,"dimensions":[{"dimension":0,"inEase":{"speed":"0","influence":"33"},"outEase":{"speed":"0","influence":"33"}}]},"returnAs":"temporalEase"},{"op":"property.keyframe.behavior.set","args":{"layer":{"ref":"layer"},"property":{"ref":"property"},"time":)" +
      time +
      R"(,"behavior":"temporal-continuous","enabled":true},"returnAs":"behavior"},{"op":"property.keyframe.delete","args":{"layer":{"ref":"layer"},"property":{"ref":"property"},"time":)" +
      time + R"(},"returnAs":"delete"}]})");
  const auto write_result = aemcp::native::execute_native_program(
      host, writes, "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      std::chrono::steady_clock::now() + 1s);
  require(write_result.ok, "keyframe mutation adapter program failed");
  const std::string write_json = aemcp::native::canonicalize_json(
      aemcp::native::JsonValue{write_result.outputs});
  require(count_text(write_json, "\"secondsRational\":\"3/8\"") == 6,
          "six keyframe mutation results did not use canonical exact time");
  require(write_json.find("\"mode\":\"comp-time\"") == std::string::npos,
          "keyframe mutation result reused the list sample-time shape");
}

} // namespace

int main() {
  try {
    read_program_needs_no_write_key();
    read_program_rejects_write_metadata();
    write_program_requires_operation_key_and_undo_group();
    write_program_undo_group_matches_terminal_bound();
    unknown_primitive_duplicate_or_invalid_refs_fail_admission();
    reference_kinds_and_exports_are_closed();
    program_is_bounded_and_digest_binds_arguments();
    literal_schemas_are_closed_and_bounded_before_dispatch();
    named_results_and_unicode_parser_are_uniform();
    codec_accepts_only_the_native_program_invoke_shape();
    property_and_keyframe_adapters_emit_generated_time_shapes();
    std::cout << "native_program_test: PASS\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "native_program_test: " << error.what() << '\n';
    return 1;
  }
}
