#include "aemcp_native/native_program.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <cmath>
#include <iomanip>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>

namespace aemcp::native {
namespace {

[[noreturn]] void invalid(std::string message) {
  throw std::runtime_error("invalid native program: " + std::move(message));
}

const JsonValue* member(const JsonObject& object, std::string_view name) {
  const auto found = std::find_if(object.begin(), object.end(), [&](const auto& item) {
    return item.first == name;
  });
  return found == object.end() ? nullptr : &found->second;
}

const JsonObject* object_of(const JsonValue& value) {
  return std::get_if<JsonObject>(&value.value);
}

const JsonValue::Array* array_of(const JsonValue& value) {
  return std::get_if<JsonValue::Array>(&value.value);
}

const std::string* string_of(const JsonValue& value) {
  return std::get_if<std::string>(&value.value);
}

bool exact_keys(
    const JsonObject& object,
    std::initializer_list<std::string_view> allowed,
    std::initializer_list<std::string_view> required) {
  for (const auto& item : object) {
    if (std::find(allowed.begin(), allowed.end(), item.first) == allowed.end()) return false;
  }
  return std::all_of(required.begin(), required.end(), [&](std::string_view name) {
    return member(object, name) != nullptr;
  });
}

std::string required_string(const JsonObject& object, std::string_view name) {
  const JsonValue* value = member(object, name);
  const std::string* result = value == nullptr ? nullptr : string_of(*value);
  if (result == nullptr || result->empty()) invalid("missing or invalid " + std::string(name));
  return *result;
}

bool idempotency_key_shape(std::string_view value) {
  return value.size() >= 16 && value.size() <= 64 &&
      std::regex_match(value.begin(), value.end(), std::regex("^[A-Za-z0-9][A-Za-z0-9._:-]*$"));
}

void append_json_string(std::string& output, std::string_view value) {
  output.push_back('"');
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (character < 0x20U) {
          constexpr char digits[] = "0123456789abcdef";
          output += "\\u00";
          output.push_back(digits[character >> 4U]);
          output.push_back(digits[character & 0x0fU]);
        } else {
          output.push_back(static_cast<char>(character));
        }
    }
  }
  output.push_back('"');
}

std::string canonical_json(const JsonValue& value) {
  if (std::holds_alternative<std::nullptr_t>(value.value)) return "null";
  if (const auto* boolean = std::get_if<bool>(&value.value)) return *boolean ? "true" : "false";
  if (const auto* number = std::get_if<JsonNumber>(&value.value)) {
    if (!std::isfinite(number->value)) invalid("non-finite number");
    std::ostringstream stream;
    stream.imbue(std::locale::classic());
    stream << std::setprecision(17) << number->value;
    return stream.str();
  }
  if (const auto* string = std::get_if<std::string>(&value.value)) {
    std::string output;
    append_json_string(output, *string);
    return output;
  }
  if (const auto* array = std::get_if<JsonValue::Array>(&value.value)) {
    std::string output{"["};
    for (std::size_t index = 0; index < array->size(); ++index) {
      if (index != 0) output.push_back(',');
      output += canonical_json((*array)[index]);
    }
    return output + ']';
  }
  const auto& object = std::get<JsonObject>(value.value);
  std::vector<const std::pair<std::string, JsonValue>*> entries;
  entries.reserve(object.size());
  for (const auto& entry : object) entries.push_back(&entry);
  std::sort(entries.begin(), entries.end(), [](const auto* left, const auto* right) {
    return left->first < right->first;
  });
  std::string output{"{"};
  for (std::size_t index = 0; index < entries.size(); ++index) {
    if (index != 0) output.push_back(',');
    append_json_string(output, entries[index]->first);
    output.push_back(':');
    output += canonical_json(entries[index]->second);
  }
  return output + '}';
}

std::string sha256_hex(std::string_view input) {
  constexpr std::array<std::uint32_t, 64> constants = {0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U};
  std::vector<std::uint8_t> message(input.begin(), input.end());
  const std::uint64_t bits = static_cast<std::uint64_t>(message.size()) * 8U;
  message.push_back(0x80U);
  while (message.size() % 64U != 56U) message.push_back(0);
  for (int shift = 56; shift >= 0; shift -= 8) message.push_back(static_cast<std::uint8_t>(bits >> shift));
  std::array<std::uint32_t, 8> state = {0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U};
  for (std::size_t chunk = 0; chunk < message.size(); chunk += 64) {
    std::array<std::uint32_t, 64> words{};
    for (std::size_t index = 0; index < 16; ++index) {
      const std::size_t base = chunk + index * 4;
      words[index] = (static_cast<std::uint32_t>(message[base]) << 24U) | (static_cast<std::uint32_t>(message[base + 1]) << 16U) | (static_cast<std::uint32_t>(message[base + 2]) << 8U) | static_cast<std::uint32_t>(message[base + 3]);
    }
    for (std::size_t index = 16; index < 64; ++index) {
      const std::uint32_t s0 = std::rotr(words[index - 15], 7) ^ std::rotr(words[index - 15], 18) ^ (words[index - 15] >> 3U);
      const std::uint32_t s1 = std::rotr(words[index - 2], 17) ^ std::rotr(words[index - 2], 19) ^ (words[index - 2] >> 10U);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    std::uint32_t a=state[0],b=state[1],c=state[2],d=state[3],e=state[4],f=state[5],g=state[6],h=state[7];
    for (std::size_t index = 0; index < 64; ++index) {
      const std::uint32_t s1 = std::rotr(e,6)^std::rotr(e,11)^std::rotr(e,25);
      const std::uint32_t choice = (e & f) ^ (~e & g);
      const std::uint32_t temporary1 = h + s1 + choice + constants[index] + words[index];
      const std::uint32_t s0 = std::rotr(a,2)^std::rotr(a,13)^std::rotr(a,22);
      const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      h=g; g=f; f=e; e=d+temporary1; d=c; c=b; b=a; a=temporary1+s0+majority;
    }
    state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d; state[4]+=e; state[5]+=f; state[6]+=g; state[7]+=h;
  }
  static constexpr char hex[] = "0123456789abcdef";
  std::string output;
  output.reserve(64);
  for (const std::uint32_t word : state) for (int shift = 28; shift >= 0; shift -= 4) output.push_back(hex[(word >> shift) & 0xfU]);
  return output;
}

class Parser final {
 public:
  explicit Parser(std::string_view text) : text_(text) {}

  JsonValue parse() {
    space();
    JsonValue result = value();
    space();
    if (offset_ != text_.size()) invalid("trailing JSON");
    return result;
  }

 private:
  void space() {
    while (offset_ < text_.size() && std::isspace(static_cast<unsigned char>(text_[offset_]))) ++offset_;
  }
  bool consume(char expected) {
    if (offset_ < text_.size() && text_[offset_] == expected) { ++offset_; return true; }
    return false;
  }
  JsonValue value() {
    if (offset_ == text_.size()) invalid("missing JSON value");
    switch (text_[offset_]) {
      case '{': return JsonValue{object()};
      case '[': return JsonValue{array()};
      case '"': return JsonValue{string()};
      case 't': literal("true"); return JsonValue{true};
      case 'f': literal("false"); return JsonValue{false};
      case 'n': literal("null"); return JsonValue{nullptr};
      default: return JsonValue{number()};
    }
  }
  void literal(std::string_view literal_value) {
    if (text_.substr(offset_, literal_value.size()) != literal_value) invalid("invalid literal");
    offset_ += literal_value.size();
  }
  JsonObject object() {
    ++offset_;
    space();
    JsonObject result;
    std::set<std::string> keys;
    if (consume('}')) return result;
    while (true) {
      if (offset_ == text_.size() || text_[offset_] != '"') invalid("object key");
      std::string key = string();
      if (!keys.insert(key).second) invalid("duplicate JSON key");
      space();
      if (!consume(':')) invalid("object colon");
      space();
      result.emplace_back(std::move(key), value());
      space();
      if (consume('}')) return result;
      if (!consume(',')) invalid("object separator");
      space();
    }
  }
  JsonValue::Array array() {
    ++offset_;
    space();
    JsonValue::Array result;
    if (consume(']')) return result;
    while (true) {
      result.push_back(value());
      space();
      if (consume(']')) return result;
      if (!consume(',')) invalid("array separator");
      space();
    }
  }
  std::string string() {
    if (!consume('"')) invalid("string");
    std::string result;
    while (offset_ < text_.size()) {
      const char character = text_[offset_++];
      if (character == '"') return result;
      if (character == '\\') {
        if (offset_ == text_.size()) invalid("incomplete escape");
        const char escaped = text_[offset_++];
        switch (escaped) {
          case '"': result.push_back('"'); break;
          case '\\': result.push_back('\\'); break;
          case '/': result.push_back('/'); break;
          case 'b': result.push_back('\b'); break;
          case 'f': result.push_back('\f'); break;
          case 'n': result.push_back('\n'); break;
          case 'r': result.push_back('\r'); break;
          case 't': result.push_back('\t'); break;
          case 'u': {
            const auto hex = [&](char digit) -> std::uint32_t {
              if (digit >= '0' && digit <= '9') return static_cast<std::uint32_t>(digit - '0');
              if (digit >= 'a' && digit <= 'f') return static_cast<std::uint32_t>(digit - 'a' + 10);
              if (digit >= 'A' && digit <= 'F') return static_cast<std::uint32_t>(digit - 'A' + 10);
              invalid("invalid unicode escape");
            };
            const auto unit = [&]() -> std::uint32_t {
              if (offset_ + 4 > text_.size()) invalid("incomplete unicode escape");
              std::uint32_t code = 0;
              for (int index = 0; index != 4; ++index) code = (code << 4U) | hex(text_[offset_++]);
              return code;
            };
            std::uint32_t code = unit();
            if (code >= 0xd800U && code <= 0xdbffU) {
              if (offset_ + 2 > text_.size() || text_[offset_] != '\\' || text_[offset_ + 1] != 'u') {
                invalid("unpaired unicode surrogate");
              }
              offset_ += 2;
              const std::uint32_t low = unit();
              if (low < 0xdc00U || low > 0xdfffU) invalid("unpaired unicode surrogate");
              code = 0x10000U + ((code - 0xd800U) << 10U) + (low - 0xdc00U);
            } else if (code >= 0xdc00U && code <= 0xdfffU) {
              invalid("unpaired unicode surrogate");
            }
            if (code <= 0x7fU) result.push_back(static_cast<char>(code));
            else if (code <= 0x7ffU) {
              result.push_back(static_cast<char>(0xc0U | (code >> 6U)));
              result.push_back(static_cast<char>(0x80U | (code & 0x3fU)));
            } else if (code <= 0xffffU) {
              result.push_back(static_cast<char>(0xe0U | (code >> 12U)));
              result.push_back(static_cast<char>(0x80U | ((code >> 6U) & 0x3fU)));
              result.push_back(static_cast<char>(0x80U | (code & 0x3fU)));
            } else {
              result.push_back(static_cast<char>(0xf0U | (code >> 18U)));
              result.push_back(static_cast<char>(0x80U | ((code >> 12U) & 0x3fU)));
              result.push_back(static_cast<char>(0x80U | ((code >> 6U) & 0x3fU)));
              result.push_back(static_cast<char>(0x80U | (code & 0x3fU)));
            }
            break;
          }
          default: invalid("unsupported string escape");
        }
      } else {
        if (static_cast<unsigned char>(character) < 0x20U) invalid("control in string");
        result.push_back(character);
      }
    }
    invalid("unterminated string");
  }
  JsonNumber number() {
    const std::size_t start = offset_;
    if (consume('-') && offset_ == text_.size()) invalid("number");
    if (consume('0')) {
    } else {
      if (offset_ == text_.size() || !std::isdigit(static_cast<unsigned char>(text_[offset_]))) invalid("number");
      while (offset_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[offset_]))) ++offset_;
    }
    if (consume('.')) {
      if (offset_ == text_.size() || !std::isdigit(static_cast<unsigned char>(text_[offset_]))) invalid("number fraction");
      while (offset_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[offset_]))) ++offset_;
    }
    if (offset_ < text_.size() && (text_[offset_] == 'e' || text_[offset_] == 'E')) {
      ++offset_;
      if (offset_ < text_.size() && (text_[offset_] == '+' || text_[offset_] == '-')) ++offset_;
      if (offset_ == text_.size() || !std::isdigit(static_cast<unsigned char>(text_[offset_]))) invalid("number exponent");
      while (offset_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[offset_]))) ++offset_;
    }
    return {std::stod(std::string(text_.substr(start, offset_ - start)))};
  }

  std::string_view text_;
  std::size_t offset_{0};
};

bool contains_ref(const JsonValue& value) {
  if (const auto* object = object_of(value)) {
    if (member(*object, "ref") != nullptr) return true;
    return std::any_of(object->begin(), object->end(), [](const auto& item) {
      return contains_ref(item.second);
    });
  }
  if (const auto* array = array_of(value)) {
    return std::any_of(array->begin(), array->end(), contains_ref);
  }
  return false;
}

const NativePrimitiveDescriptor* lookup(
    std::string_view id, std::span<const NativePrimitiveDescriptor> registry) {
  const auto found = std::find_if(registry.begin(), registry.end(), [&](const auto& entry) {
    return entry.id == id;
  });
  return found == registry.end() ? nullptr : &*found;
}

const JsonNumber* number_of(const JsonValue& value) {
  return std::get_if<JsonNumber>(&value.value);
}

bool validates_literal(const JsonValue& value, const JsonObject& schema) {
  // Generated admission schemas inline every local root definition.  Rejecting a
  // remaining ref is intentional: it would otherwise bypass pre-dispatch checks.
  if (member(schema, "$ref") != nullptr) return false;
  for (const std::string_view composition : {"allOf", "anyOf", "oneOf"}) {
    const JsonValue* branch_value = member(schema, composition);
    if (branch_value == nullptr) continue;
    const auto* branches = array_of(*branch_value);
    if (branches == nullptr || branches->empty()) return false;
    std::size_t matches = 0;
    for (const JsonValue& branch : *branches) {
      const auto* branch_schema = object_of(branch);
      if (branch_schema != nullptr && validates_literal(value, *branch_schema)) ++matches;
    }
    if ((composition == "allOf" && matches != branches->size()) ||
        (composition == "anyOf" && matches == 0) ||
        (composition == "oneOf" && matches != 1)) return false;
  }
  if (const JsonValue* constant = member(schema, "const")) return canonical_json(value) == canonical_json(*constant);
  if (const JsonValue* enumeration = member(schema, "enum")) {
    const auto* values = array_of(*enumeration);
    return values != nullptr && std::any_of(values->begin(), values->end(), [&](const JsonValue& item) {
      return canonical_json(value) == canonical_json(item);
    });
  }
  const std::string* type = member(schema, "type") == nullptr ? nullptr : string_of(*member(schema, "type"));
  const bool object_rules =
      (type != nullptr && *type == "object") || member(schema, "properties") != nullptr;
  if (object_rules) {
    const auto* object = object_of(value);
    if (object == nullptr) return false;
    const auto* properties = member(schema, "properties") == nullptr ? nullptr : object_of(*member(schema, "properties"));
    const auto* required = member(schema, "required") == nullptr ? nullptr : array_of(*member(schema, "required"));
    if (properties == nullptr && required != nullptr) return false;
    for (const auto& item : *object) {
      const JsonValue* child = properties == nullptr ? nullptr : member(*properties, item.first);
      if (child == nullptr) {
        const JsonValue* closed = member(schema, "additionalProperties");
        if (closed != nullptr && std::holds_alternative<bool>(closed->value) && !std::get<bool>(closed->value)) return false;
        continue;
      }
      const auto* child_schema = object_of(*child);
      if (child_schema == nullptr || !validates_literal(item.second, *child_schema)) return false;
    }
    if (required != nullptr) for (const JsonValue& required_name : *required) {
      const auto* name = string_of(required_name);
      if (name == nullptr || member(*object, *name) == nullptr) return false;
    }
    return true;
  }
  if (type == nullptr) return true;
  if (*type == "array") {
    const auto* array = array_of(value); if (array == nullptr) return false;
    if (const auto* minimum = member(schema, "minItems"); minimum != nullptr) {
      const auto* number = number_of(*minimum);
      if (number == nullptr || array->size() < static_cast<std::size_t>(number->value)) return false;
    }
    if (const auto* maximum = member(schema, "maxItems"); maximum != nullptr) {
      const auto* number = number_of(*maximum);
      if (number == nullptr || array->size() > static_cast<std::size_t>(number->value)) return false;
    }
    const auto* items = member(schema, "items") == nullptr ? nullptr : object_of(*member(schema, "items"));
    if (items == nullptr) return false;
    for (const JsonValue& item : *array) if (!validates_literal(item, *items)) return false;
    return true;
  }
  if (*type == "string") {
    const auto* string = string_of(value); if (string == nullptr) return false;
    if (const auto* minimum = member(schema, "minLength"); minimum != nullptr) {
      const auto* number = number_of(*minimum);
      if (number == nullptr || string->size() < static_cast<std::size_t>(number->value)) return false;
    }
    if (const auto* maximum = member(schema, "maxLength"); maximum != nullptr) {
      const auto* number = number_of(*maximum);
      if (number == nullptr || string->size() > static_cast<std::size_t>(number->value)) return false;
    }
    if (const auto* pattern = member(schema, "pattern"); pattern != nullptr) {
      const auto* expression = string_of(*pattern);
      if (expression == nullptr || !std::regex_match(*string, std::regex(*expression))) return false;
    }
    return true;
  }
  if (*type == "boolean") return std::holds_alternative<bool>(value.value);
  if (*type == "number" || *type == "integer") {
    const auto* number = number_of(value);
    if (number == nullptr || !std::isfinite(number->value)) return false;
    if (*type == "integer" && std::trunc(number->value) != number->value) return false;
    if (const auto* minimum = member(schema, "minimum"); minimum != nullptr) {
      const auto* bound = number_of(*minimum);
      if (bound == nullptr || number->value < bound->value) return false;
    }
    if (const auto* maximum = member(schema, "maximum"); maximum != nullptr) {
      const auto* bound = number_of(*maximum);
      if (bound == nullptr || number->value > bound->value) return false;
    }
    return true;
  }
  return true;
}

}  // namespace

JsonObject parse_json_object(std::string_view json) {
  JsonValue parsed = Parser(json).parse();
  const JsonObject* object = object_of(parsed);
  if (object == nullptr) invalid("expected object");
  return *object;
}

NativeProgram parse_native_program(const JsonObject& object) {
  if (!exact_keys(object, {"operationKey", "undoGroup", "operations"}, {"operations"})) {
    invalid("program envelope is not closed");
  }
  NativeProgram result;
  if (member(object, "operationKey") != nullptr) {
    result.operation_key = required_string(object, "operationKey");
    if (!idempotency_key_shape(result.operation_key)) invalid("operationKey does not match wire schema");
  }
  if (member(object, "undoGroup") != nullptr) {
    result.undo_group = required_string(object, "undoGroup");
    if (result.undo_group.size() > 256) invalid("undoGroup does not match wire schema");
  }
  const JsonValue* operations_value = member(object, "operations");
  const auto* operations = operations_value == nullptr ? nullptr : array_of(*operations_value);
  if (operations == nullptr || operations->empty() || operations->size() > kMaxNativeProgramOperations) {
    invalid("operations must contain 1..64 items");
  }
  for (const JsonValue& operation_value : *operations) {
    const JsonObject* operation = object_of(operation_value);
    if (operation == nullptr || !exact_keys(*operation, {"op", "args", "saveAs", "returnAs"}, {"op", "args"})) {
      invalid("operation is not closed");
    }
    const JsonValue* arguments_value = member(*operation, "args");
    const JsonObject* arguments = arguments_value == nullptr ? nullptr : object_of(*arguments_value);
    if (arguments == nullptr) invalid("operation args must be an object");
    NativeProgramOperation parsed;
    parsed.primitive_id = required_string(*operation, "op");
    parsed.arguments = *arguments;
    if (member(*operation, "saveAs") != nullptr) {
      parsed.save_as = required_string(*operation, "saveAs");
      if (parsed.save_as->size() > 64) invalid("saveAs does not match wire schema");
    }
    if (member(*operation, "returnAs") != nullptr) {
      parsed.return_as = required_string(*operation, "returnAs");
      if (parsed.return_as->size() > 64) invalid("returnAs does not match wire schema");
    }
    result.operations.push_back(std::move(parsed));
  }
  return result;
}

ProgramAdmission validate_native_program(
    const NativeProgram& program, std::span<const NativePrimitiveDescriptor> registry) {
  if (program.operations.empty() || program.operations.size() > kMaxNativeProgramOperations) {
    invalid("operations must contain 1..64 items");
  }
  ProgramAdmission result;
  std::set<std::string> names;
  for (const NativeProgramOperation& operation : program.operations) {
    const NativePrimitiveDescriptor* descriptor = lookup(operation.primitive_id, registry);
    if (descriptor == nullptr) invalid("unknown primitive " + operation.primitive_id);
    result.descriptors.push_back(descriptor);
    result.contains_write = result.contains_write || descriptor->mutability == PrimitiveMutability::kWrite;
    const JsonObject literal_schema = parse_json_object(descriptor->input_schema_json);
    const JsonValue* properties_value = member(literal_schema, "properties");
    const JsonObject* literal_properties = properties_value == nullptr ? nullptr : object_of(*properties_value);
    const JsonValue* required_value = member(literal_schema, "required");
    const JsonValue::Array* literal_required = required_value == nullptr ? nullptr : array_of(*required_value);
    if (literal_properties == nullptr || literal_required == nullptr) invalid("generated literal schema is invalid");
    std::set<std::string_view> declared_refs;
    for (const NativeReferenceArgument& reference : descriptor->reference_arguments) {
      declared_refs.insert(reference.name);
      const JsonValue* candidate = member(operation.arguments, reference.name);
      if (candidate == nullptr && !reference.required) continue;
      const JsonObject* ref = candidate == nullptr ? nullptr : object_of(*candidate);
      if (ref == nullptr || !exact_keys(*ref, {"ref"}, {"ref"})) {
        invalid("missing or invalid reference argument " + std::string(reference.name));
      }
      const std::string name = required_string(*ref, "ref");
      const auto named = result.named_value_kinds.find(name);
      if (named == result.named_value_kinds.end()) invalid("forward or unknown reference " + name);
      if (named->second != reference.kind) invalid("reference kind mismatch for " + std::string(reference.name));
    }
    for (const auto& argument : operation.arguments) {
      if (declared_refs.contains(argument.first)) continue;
      if (member(*literal_properties, argument.first) == nullptr) {
        invalid("unexpected literal argument " + argument.first);
      }
      const auto* argument_schema = object_of(*member(*literal_properties, argument.first));
      if (argument_schema == nullptr || !validates_literal(argument.second, *argument_schema)) {
        invalid("invalid literal argument " + argument.first);
      }
      if (contains_ref(argument.second)) invalid("reference used outside generated reference arguments");
    }
    for (const JsonValue& required : *literal_required) {
      const std::string* name = string_of(required);
      if (name == nullptr || member(operation.arguments, *name) == nullptr) {
        invalid("missing required literal argument");
      }
    }
    if (operation.save_as.has_value()) {
      if (!names.insert(*operation.save_as).second) invalid("duplicate saveAs " + *operation.save_as);
      result.named_value_kinds.emplace(*operation.save_as, descriptor->result_kind);
    }
    if (operation.return_as.has_value()) {
      if (!descriptor->exportable) invalid("resolver handles cannot be exported");
      if (!names.insert(*operation.return_as).second) {
        invalid("duplicate named value " + *operation.return_as);
      }
    }
  }
  if (result.contains_write && (program.operation_key.empty() || program.undo_group.empty())) {
    invalid("write program requires operationKey and undoGroup");
  }
  if (!result.contains_write
      && (!program.operation_key.empty() || !program.undo_group.empty())) {
    invalid("read program must not include operationKey or undoGroup");
  }
  result.program_digest = digest_native_program(program);
  return result;
}

std::string canonical_native_program(const NativeProgram& program) {
  std::string canonical{"{"};
  if (!program.operation_key.empty()) {
    canonical += "\"operationKey\":";
    append_json_string(canonical, program.operation_key);
    canonical.push_back(',');
  }
  canonical += "\"operations\":[";
  for (std::size_t index = 0; index < program.operations.size(); ++index) {
    if (index != 0) canonical.push_back(',');
    const NativeProgramOperation& operation = program.operations[index];
    canonical += "{\"args\":" + canonical_json(JsonValue{operation.arguments}) + ",\"op\":";
    append_json_string(canonical, operation.primitive_id);
    if (operation.return_as.has_value()) {
      canonical += ",\"returnAs\":";
      append_json_string(canonical, *operation.return_as);
    }
    if (operation.save_as.has_value()) {
      canonical += ",\"saveAs\":";
      append_json_string(canonical, *operation.save_as);
    }
    canonical.push_back('}');
  }
  canonical += ']';
  if (!program.undo_group.empty()) {
    canonical += ",\"undoGroup\":";
    append_json_string(canonical, program.undo_group);
  }
  canonical.push_back('}');
  return canonical;
}

std::string digest_native_program(const NativeProgram& program) {
  return sha256_hex(canonical_native_program(program));
}

}  // namespace aemcp::native
