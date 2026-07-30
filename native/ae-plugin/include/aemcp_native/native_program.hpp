#pragma once

#include "aemcp_native/native_primitive_registry.generated.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

namespace aemcp::native {

struct JsonNumber {
  double value{0};
};

struct JsonValue {
  using Array = std::vector<JsonValue>;
  using Object = std::vector<std::pair<std::string, JsonValue>>;
  std::variant<std::nullptr_t, bool, JsonNumber, std::string, Array, Object>
      value;
};

using JsonObject = JsonValue::Object;

inline constexpr std::size_t kMaxNativeProgramOperations = 64;

struct NativeProgramOperation {
  std::string primitive_id;
  JsonObject arguments;
  std::optional<std::string> save_as;
  std::optional<std::string> return_as;
};

struct NativeProgram {
  std::string operation_key;
  std::string undo_group;
  std::vector<NativeProgramOperation> operations;
};

struct ProgramAdmission {
  std::vector<const NativePrimitiveDescriptor *> descriptors;
  std::unordered_map<std::string, PrimitiveValueKind> named_value_kinds;
  bool contains_write{false};
  std::string program_digest;
};

[[nodiscard]] JsonValue parse_json(std::string_view json);
[[nodiscard]] JsonObject parse_json_object(std::string_view json);
[[nodiscard]] std::string canonicalize_json(const JsonValue &value);
[[nodiscard]] std::string sha256_hex_digest(std::string_view value);
[[nodiscard]] NativeProgram parse_native_program(const JsonObject &object);
[[nodiscard]] ProgramAdmission
validate_native_program(const NativeProgram &program,
                        std::span<const NativePrimitiveDescriptor> registry);
[[nodiscard]] std::string
canonical_native_program(const NativeProgram &program);
[[nodiscard]] std::string digest_native_program(const NativeProgram &program);

} // namespace aemcp::native
