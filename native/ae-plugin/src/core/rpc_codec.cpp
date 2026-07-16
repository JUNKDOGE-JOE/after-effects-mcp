#include "aemcp_native/rpc_codec.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <locale>
#include <set>
#include <sstream>
#include <type_traits>
#include <utility>

namespace aemcp::native::rpc {
namespace {

using Bytes = std::span<const std::uint8_t>;

[[noreturn]] void invalid_request(std::string message) {
  throw CodecError(CodecErrorKind::kInvalidRequest, std::move(message));
}

[[noreturn]] void invalid_argument(std::string message) {
  throw CodecError(CodecErrorKind::kInvalidArgument, std::move(message));
}

[[noreturn]] void session_stale(std::string message) {
  throw CodecError(CodecErrorKind::kSessionStale, std::move(message));
}

struct JsonNumber {
  double value{0};
};

struct JsonValue {
  using Array = std::vector<JsonValue>;
  using Object = std::vector<std::pair<std::string, JsonValue>>;
  std::variant<std::nullptr_t, bool, JsonNumber, std::string, Array, Object> value;
};

std::size_t utf8_sequence_length(unsigned char lead) {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

std::uint32_t decode_utf8_scalar(std::string_view input, std::size_t& offset) {
  if (offset >= input.size()) invalid_request("incomplete UTF-8 sequence");
  const auto first = static_cast<unsigned char>(input[offset]);
  const std::size_t length = utf8_sequence_length(first);
  if (length == 0 || offset + length > input.size()) invalid_request("invalid UTF-8");
  if (length == 1) {
    ++offset;
    return first;
  }
  std::uint32_t scalar = first & ((1U << (7U - static_cast<unsigned>(length))) - 1U);
  for (std::size_t index = 1; index < length; ++index) {
    const auto next = static_cast<unsigned char>(input[offset + index]);
    if ((next & 0xc0U) != 0x80U) invalid_request("invalid UTF-8 continuation byte");
    scalar = (scalar << 6U) | (next & 0x3fU);
  }
  const std::uint32_t minimum = length == 2 ? 0x80U : (length == 3 ? 0x800U : 0x10000U);
  if (scalar < minimum || scalar > 0x10ffffU || (scalar >= 0xd800U && scalar <= 0xdfffU)) {
    invalid_request("non-scalar UTF-8 sequence");
  }
  offset += length;
  return scalar;
}

std::size_t validate_utf8_and_count(std::string_view input) {
  std::size_t offset = 0;
  std::size_t scalars = 0;
  while (offset < input.size()) {
    (void)decode_utf8_scalar(input, offset);
    ++scalars;
  }
  return scalars;
}

void append_utf8(std::string& output, std::uint32_t scalar) {
  if (scalar <= 0x7fU) {
    output.push_back(static_cast<char>(scalar));
  } else if (scalar <= 0x7ffU) {
    output.push_back(static_cast<char>(0xc0U | (scalar >> 6U)));
    output.push_back(static_cast<char>(0x80U | (scalar & 0x3fU)));
  } else if (scalar <= 0xffffU) {
    output.push_back(static_cast<char>(0xe0U | (scalar >> 12U)));
    output.push_back(static_cast<char>(0x80U | ((scalar >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (scalar & 0x3fU)));
  } else {
    output.push_back(static_cast<char>(0xf0U | (scalar >> 18U)));
    output.push_back(static_cast<char>(0x80U | ((scalar >> 12U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | ((scalar >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (scalar & 0x3fU)));
  }
}

int hex_value(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  if (character >= 'A' && character <= 'F') return character - 'A' + 10;
  return -1;
}

class JsonParser final {
 public:
  explicit JsonParser(std::string_view text) : text_(text) {
    (void)validate_utf8_and_count(text_);
  }

  JsonValue parse() {
    skip_space();
    JsonValue result = parse_value(1);
    skip_space();
    if (offset_ != text_.size()) invalid_request("trailing JSON bytes");
    return result;
  }

 private:
  void count_node(std::size_t depth) {
    if (depth > kMaxJsonDepth) invalid_request("JSON depth exceeded");
    if (++nodes_ > kMaxJsonNodes) invalid_request("JSON node limit exceeded");
  }

  JsonValue parse_value(std::size_t depth) {
    count_node(depth);
    if (offset_ >= text_.size()) invalid_request("missing JSON value");
    switch (text_[offset_]) {
      case '{': return JsonValue{parse_object(depth)};
      case '[': return JsonValue{parse_array(depth)};
      case '"': return JsonValue{parse_string()};
      case 't': parse_literal("true"); return JsonValue{true};
      case 'f': parse_literal("false"); return JsonValue{false};
      case 'n': parse_literal("null"); return JsonValue{nullptr};
      default: return JsonValue{parse_number()};
    }
  }

  JsonValue::Object parse_object(std::size_t depth) {
    ++offset_;
    skip_space();
    JsonValue::Object result;
    std::set<std::string> keys;
    if (consume('}')) return result;
    while (true) {
      if (offset_ >= text_.size() || text_[offset_] != '"') {
        invalid_request("object key must be a string");
      }
      std::string key = parse_string();
      if (!keys.insert(key).second) invalid_request("duplicate JSON object key");
      skip_space();
      if (!consume(':')) invalid_request("missing object colon");
      skip_space();
      result.emplace_back(std::move(key), parse_value(depth + 1));
      skip_space();
      if (consume('}')) return result;
      if (!consume(',')) invalid_request("invalid object separator");
      skip_space();
      if (offset_ < text_.size() && text_[offset_] == '}') {
        invalid_request("trailing object comma");
      }
    }
  }

  JsonValue::Array parse_array(std::size_t depth) {
    ++offset_;
    skip_space();
    JsonValue::Array result;
    if (consume(']')) return result;
    while (true) {
      result.push_back(parse_value(depth + 1));
      skip_space();
      if (consume(']')) return result;
      if (!consume(',')) invalid_request("invalid array separator");
      skip_space();
      if (offset_ < text_.size() && text_[offset_] == ']') {
        invalid_request("trailing array comma");
      }
    }
  }

  std::uint16_t parse_hex_quad() {
    if (offset_ + 4 > text_.size()) invalid_request("incomplete Unicode escape");
    std::uint16_t value = 0;
    for (int count = 0; count < 4; ++count) {
      const int digit = hex_value(text_[offset_++]);
      if (digit < 0) invalid_request("invalid Unicode escape");
      value = static_cast<std::uint16_t>((value << 4U) | static_cast<unsigned>(digit));
    }
    return value;
  }

  std::string parse_string() {
    ++offset_;
    std::string result;
    std::size_t scalars = 0;
    while (offset_ < text_.size()) {
      const auto byte = static_cast<unsigned char>(text_[offset_]);
      if (byte == '"') {
        ++offset_;
        return result;
      }
      if (byte < 0x20U) invalid_request("unescaped string control character");
      if (byte == '\\') {
        ++offset_;
        if (offset_ >= text_.size()) invalid_request("incomplete string escape");
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
            std::uint32_t scalar = parse_hex_quad();
            if (scalar >= 0xd800U && scalar <= 0xdbffU) {
              if (offset_ + 2 > text_.size() || text_[offset_] != '\\'
                  || text_[offset_ + 1] != 'u') {
                invalid_request("lone high surrogate");
              }
              offset_ += 2;
              const std::uint32_t low = parse_hex_quad();
              if (low < 0xdc00U || low > 0xdfffU) invalid_request("invalid surrogate pair");
              scalar = 0x10000U + ((scalar - 0xd800U) << 10U) + (low - 0xdc00U);
            } else if (scalar >= 0xdc00U && scalar <= 0xdfffU) {
              invalid_request("lone low surrogate");
            }
            append_utf8(result, scalar);
            break;
          }
          default: invalid_request("invalid string escape");
        }
        ++scalars;
      } else {
        const std::size_t start = offset_;
        (void)decode_utf8_scalar(text_, offset_);
        result.append(text_.substr(start, offset_ - start));
        ++scalars;
      }
      if (scalars > kMaxStringScalars) invalid_request("JSON string limit exceeded");
    }
    invalid_request("unterminated string");
  }

  JsonNumber parse_number() {
    const std::size_t start = offset_;
    if (consume('-') && offset_ >= text_.size()) invalid_request("incomplete JSON number");
    if (consume('0')) {
      if (offset_ < text_.size() && text_[offset_] >= '0' && text_[offset_] <= '9') {
        invalid_request("leading zero in JSON number");
      }
    } else {
      if (offset_ >= text_.size() || text_[offset_] < '1' || text_[offset_] > '9') {
        invalid_request("invalid JSON value");
      }
      while (offset_ < text_.size() && text_[offset_] >= '0' && text_[offset_] <= '9') ++offset_;
    }
    if (consume('.')) {
      const std::size_t digits = offset_;
      while (offset_ < text_.size() && text_[offset_] >= '0' && text_[offset_] <= '9') ++offset_;
      if (digits == offset_) invalid_request("missing fractional digits");
    }
    if (offset_ < text_.size() && (text_[offset_] == 'e' || text_[offset_] == 'E')) {
      ++offset_;
      if (offset_ < text_.size() && (text_[offset_] == '+' || text_[offset_] == '-')) ++offset_;
      const std::size_t digits = offset_;
      while (offset_ < text_.size() && text_[offset_] >= '0' && text_[offset_] <= '9') ++offset_;
      if (digits == offset_) invalid_request("missing exponent digits");
    }
    const std::string_view token = text_.substr(start, offset_ - start);
    double value = 0;
    std::istringstream stream{std::string(token)};
    stream.imbue(std::locale::classic());
    stream >> std::noskipws >> value;
    if (!stream || stream.peek() != std::char_traits<char>::eof() || !std::isfinite(value)) {
      invalid_request("non-finite or invalid JSON number");
    }
    if (std::trunc(value) == value
        && std::fabs(value) > static_cast<double>(kMaxSafeInteger)) {
      invalid_request("unsafe JSON integer");
    }
    return JsonNumber{value};
  }

  void parse_literal(std::string_view literal) {
    if (text_.substr(offset_, literal.size()) != literal) invalid_request("invalid JSON literal");
    offset_ += literal.size();
  }

  void skip_space() {
    while (offset_ < text_.size()
        && (text_[offset_] == ' ' || text_[offset_] == '\t'
          || text_[offset_] == '\r' || text_[offset_] == '\n')) ++offset_;
  }

  bool consume(char expected) {
    if (offset_ < text_.size() && text_[offset_] == expected) {
      ++offset_;
      return true;
    }
    return false;
  }

  std::string_view text_;
  std::size_t offset_{0};
  std::size_t nodes_{0};
};

const JsonValue::Object* object_of(const JsonValue& value) {
  return std::get_if<JsonValue::Object>(&value.value);
}

const JsonValue::Array* array_of(const JsonValue& value) {
  return std::get_if<JsonValue::Array>(&value.value);
}

const std::string* string_of(const JsonValue& value) {
  return std::get_if<std::string>(&value.value);
}

const JsonNumber* number_of(const JsonValue& value) {
  return std::get_if<JsonNumber>(&value.value);
}

const JsonValue* member(const JsonValue::Object& object, std::string_view name) {
  const auto found = std::find_if(object.begin(), object.end(), [&](const auto& item) {
    return item.first == name;
  });
  return found == object.end() ? nullptr : &found->second;
}

bool exact_keys(
    const JsonValue::Object& object,
    std::initializer_list<std::string_view> allowed,
    std::initializer_list<std::string_view> required = {}) {
  const auto permitted = [&](std::string_view key) {
    return std::find(allowed.begin(), allowed.end(), key) != allowed.end();
  };
  return std::all_of(object.begin(), object.end(), [&](const auto& item) {
      return permitted(item.first);
    }) && std::all_of(required.begin(), required.end(), [&](std::string_view key) {
      return member(object, key) != nullptr;
    });
}

std::string required_string(
    const JsonValue::Object& object, std::string_view name, CodecErrorKind kind) {
  const JsonValue* value = member(object, name);
  const std::string* result = value == nullptr ? nullptr : string_of(*value);
  if (result == nullptr) {
    if (kind == CodecErrorKind::kInvalidArgument) invalid_argument("invalid string field");
    invalid_request("invalid string field");
  }
  return *result;
}

std::uint64_t required_uint(
    const JsonValue::Object& object, std::string_view name, CodecErrorKind kind,
    std::uint64_t minimum, std::uint64_t maximum) {
  const JsonValue* value = member(object, name);
  const JsonNumber* number = value == nullptr ? nullptr : number_of(*value);
  if (number == nullptr || std::trunc(number->value) != number->value || number->value < 0
      || number->value < static_cast<double>(minimum)
      || number->value > static_cast<double>(maximum)) {
    if (kind == CodecErrorKind::kInvalidArgument) invalid_argument("invalid integer field");
    invalid_request("invalid integer field");
  }
  return static_cast<std::uint64_t>(number->value);
}

std::int64_t required_int(
    const JsonValue::Object& object, std::string_view name, CodecErrorKind kind,
    std::int64_t minimum, std::int64_t maximum) {
  const JsonValue* value = member(object, name);
  const JsonNumber* number = value == nullptr ? nullptr : number_of(*value);
  if (number == nullptr || std::trunc(number->value) != number->value
      || number->value < static_cast<double>(minimum)
      || number->value > static_cast<double>(maximum)) {
    if (kind == CodecErrorKind::kInvalidArgument) invalid_argument("invalid integer field");
    invalid_request("invalid integer field");
  }
  return static_cast<std::int64_t>(number->value);
}

bool ascii_alphanumeric(char value) {
  return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
      || (value >= '0' && value <= '9');
}

bool valid_request_id(std::string_view value) {
  if (value.empty() || value.size() > 64 || !ascii_alphanumeric(value.front())) return false;
  return std::all_of(value.begin() + 1, value.end(), [](char character) {
    return ascii_alphanumeric(character) || character == '.' || character == '_'
        || character == ':' || character == '-';
  });
}

bool valid_idempotency_key(std::string_view value) {
  if (value.size() < 16 || value.size() > 64 || !ascii_alphanumeric(value.front())) {
    return false;
  }
  return std::all_of(value.begin() + 1, value.end(), [](char character) {
    return ascii_alphanumeric(character) || character == '.' || character == '_'
        || character == ':' || character == '-';
  });
}

bool valid_bit_depth(std::int32_t value) {
  return value == 8 || value == 16 || value == 32;
}

bool valid_uuid(std::string_view value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-'
      || value[18] != '-' || value[23] != '-') return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    if (!((value[index] >= '0' && value[index] <= '9')
        || (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  if (value[14] < '1' || value[14] > '5') return false;
  return value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b';
}

bool valid_sha256(std::string_view value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char character) {
    return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
  });
}

bool valid_capability_id(std::string_view value) {
  if (value.size() < 3 || value.size() > 96 || !value.starts_with("ae.")) return false;
  std::size_t start = 3;
  while (true) {
    if (start >= value.size() || value[start] < 'a' || value[start] > 'z') return false;
    std::size_t end = start + 1;
    while (end < value.size() && value[end] != '.') {
      const char character = value[end];
      if (!((character >= 'a' && character <= 'z')
          || (character >= '0' && character <= '9') || character == '_' || character == '-')) {
        return false;
      }
      ++end;
    }
    if (end == value.size()) return true;
    start = end + 1;
  }
}

bool bounded_ascii_token(
    std::string_view value, std::size_t minimum, std::size_t maximum,
    bool (*allowed)(char)) {
  return value.size() >= minimum && value.size() <= maximum
      && std::all_of(value.begin(), value.end(), allowed);
}

std::string method_name(RpcMethod method) {
  switch (method) {
    case RpcMethod::kHello: return "hello";
    case RpcMethod::kCapabilities: return "capabilities";
    case RpcMethod::kInvoke: return "invoke";
    case RpcMethod::kCancel: return "cancel";
    case RpcMethod::kInvalidateGraph: return "invalidateGraph";
  }
  invalid_argument("unknown RPC method");
}

std::size_t output_scalar_count(std::string_view value) {
  try {
    return validate_utf8_and_count(value);
  } catch (const CodecError&) {
    invalid_argument("output string is not valid UTF-8 scalar data");
  }
}

std::string json_string(std::string_view value) {
  const std::size_t scalars = output_scalar_count(value);
  if (scalars > kMaxStringScalars) invalid_argument("output string limit exceeded");
  static constexpr char kHex[] = "0123456789abcdef";
  std::string output;
  output.reserve(value.size() + 2);
  output.push_back('"');
  for (unsigned char character : value) {
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
          output += "\\u00";
          output.push_back(kHex[(character >> 4U) & 0x0fU]);
          output.push_back(kHex[character & 0x0fU]);
        } else {
          output.push_back(static_cast<char>(character));
        }
    }
  }
  output.push_back('"');
  return output;
}

ObjectLocator parse_locator(const JsonValue& value, std::string_view expected_kind) {
  const JsonValue::Object* object = object_of(value);
  if (object == nullptr || !exact_keys(
          *object,
          {"kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId"},
          {"kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId"})) {
    invalid_argument("locator must be a closed object");
  }
  ObjectLocator locator;
  locator.kind = required_string(*object, "kind", CodecErrorKind::kInvalidArgument);
  locator.host_instance_id = required_string(
      *object, "hostInstanceId", CodecErrorKind::kInvalidArgument);
  locator.session_id = required_string(*object, "sessionId", CodecErrorKind::kInvalidArgument);
  locator.project_id = required_string(*object, "projectId", CodecErrorKind::kInvalidArgument);
  locator.generation = required_uint(
      *object, "generation", CodecErrorKind::kInvalidArgument, 1, kMaxSafeInteger);
  locator.object_id = required_string(*object, "objectId", CodecErrorKind::kInvalidArgument);
  if (locator.kind != expected_kind || !valid_uuid(locator.host_instance_id)
      || !valid_uuid(locator.session_id) || !valid_uuid(locator.project_id)
      || !valid_uuid(locator.object_id)) {
    invalid_argument("locator identity is invalid");
  }
  return locator;
}

bool valid_output_locator(const ObjectLocator& locator) {
  return (locator.kind == "project" || locator.kind == "item"
          || locator.kind == "composition" || locator.kind == "layer"
          || locator.kind == "stream")
      && valid_uuid(locator.host_instance_id) && valid_uuid(locator.session_id)
      && valid_uuid(locator.project_id) && locator.generation >= 1
      && locator.generation <= kMaxSafeInteger && valid_uuid(locator.object_id);
}

bool valid_decimal_string(std::string_view text);
bool same_locator_scope(const ObjectLocator& value, const ObjectLocator& scope);
std::string canonical_layer_property_value(const LayerPropertyValue& value);

LayerPropertyValue parse_layer_property_value(const JsonValue& value) {
  const JsonValue::Object* object = object_of(value);
  if (object == nullptr) invalid_argument("property value must be an object");
  const std::string kind = required_string(
      *object, "kind", CodecErrorKind::kInvalidArgument);
  if (kind == "scalar") {
    if (!exact_keys(*object, {"kind", "value"}, {"kind", "value"})) {
      invalid_argument("scalar property value is not closed");
    }
    const std::string scalar = required_string(
        *object, "value", CodecErrorKind::kInvalidArgument);
    if (!valid_decimal_string(scalar)) invalid_argument("invalid scalar property value");
    return LayerPropertyScalarValue{scalar};
  }
  if (kind == "vector") {
    if (!exact_keys(*object, {"kind", "components"}, {"kind", "components"})) {
      invalid_argument("vector property value is not closed");
    }
    const JsonValue* components_value = member(*object, "components");
    const JsonValue::Array* components = components_value == nullptr
        ? nullptr : array_of(*components_value);
    if (components == nullptr || (components->size() != 2 && components->size() != 3)) {
      invalid_argument("invalid vector property arity");
    }
    LayerPropertyVectorValue result;
    result.components.reserve(components->size());
    for (const JsonValue& component : *components) {
      const std::string* text = string_of(component);
      if (text == nullptr || !valid_decimal_string(*text)) {
        invalid_argument("invalid vector property value");
      }
      result.components.push_back(*text);
    }
    return result;
  }
  if (kind == "color") {
    if (!exact_keys(
            *object,
            {"kind", "alpha", "red", "green", "blue"},
            {"kind", "alpha", "red", "green", "blue"})) {
      invalid_argument("color property value is not closed");
    }
    LayerPropertyColorValue result{
        required_string(*object, "alpha", CodecErrorKind::kInvalidArgument),
        required_string(*object, "red", CodecErrorKind::kInvalidArgument),
        required_string(*object, "green", CodecErrorKind::kInvalidArgument),
        required_string(*object, "blue", CodecErrorKind::kInvalidArgument)};
    if (!valid_decimal_string(result.alpha) || !valid_decimal_string(result.red)
        || !valid_decimal_string(result.green) || !valid_decimal_string(result.blue)) {
      invalid_argument("invalid color property value");
    }
    return result;
  }
  invalid_argument("unsupported primitive property value kind");
}

std::string locator_json(const ObjectLocator& locator) {
  if (!valid_output_locator(locator)) invalid_argument("invalid output locator");
  // RFC 8785 key order.
  return "{\"generation\":" + std::to_string(locator.generation)
      + ",\"hostInstanceId\":" + json_string(locator.host_instance_id)
      + ",\"kind\":" + json_string(locator.kind)
      + ",\"objectId\":" + json_string(locator.object_id)
      + ",\"projectId\":" + json_string(locator.project_id)
      + ",\"sessionId\":" + json_string(locator.session_id) + "}";
}

std::string canonical_composition_layer_create_arguments(
    const ObjectLocator& composition_locator,
    std::string_view kind,
    std::string_view name,
    const std::optional<CompositionLayerCreateColor>& color,
    const std::optional<std::uint32_t>& width,
    const std::optional<std::uint32_t>& height,
    const std::optional<CompositionCurrentTime>& duration,
    std::string_view idempotency_key);

std::string canonical_request(const ParsedRequest& request) {
  std::string params;
  switch (request.method) {
    case RpcMethod::kHello: {
      const auto& value = std::get<HelloParams>(request.params);
      const std::string component = value.component == ClientComponent::kCoreBroker
          ? "core-broker" : "development-smoke";
      params = "{\"client\":{\"component\":" + json_string(component)
          + ",\"instanceId\":" + json_string(value.client_instance_id)
          + ",\"version\":" + json_string(value.client_version) + "},\"nonce\":"
          + json_string(value.nonce) + ",\"supportedWireVersions\":{\"maximum\":"
          + std::to_string(value.maximum_wire_version) + ",\"minimum\":"
          + std::to_string(value.minimum_wire_version) + "}}";
      break;
    }
    case RpcMethod::kCapabilities: {
      const auto& value = std::get<CapabilitiesParams>(request.params);
      std::vector<std::string> members;
      if (value.detail_was_provided) {
        members.push_back(value.detail == CapabilityDetail::kFull
            ? "\"detail\":\"full\"" : "\"detail\":\"summary\"");
      }
      if (value.ids.has_value()) {
        std::string ids = "\"ids\":[";
        for (std::size_t index = 0; index < value.ids->size(); ++index) {
          if (index != 0) ids.push_back(',');
          ids += json_string((*value.ids)[index]);
        }
        ids.push_back(']');
        members.push_back(std::move(ids));
      }
      if (value.limit_was_provided) {
        members.push_back("\"limit\":" + std::to_string(value.limit));
      }
      std::sort(members.begin(), members.end());
      params = "{";
      for (std::size_t index = 0; index < members.size(); ++index) {
        if (index != 0) params.push_back(',');
        params += members[index];
      }
      params.push_back('}');
      break;
    }
    case RpcMethod::kInvoke: {
      const auto& value = std::get<InvokeParams>(request.params);
      std::string arguments = "{}";
      if (value.capability_id == "ae.project.bit-depth.set") {
        arguments = "{\"idempotencyKey\":" + json_string(value.idempotency_key)
            + ",\"targetDepth\":" + std::to_string(value.target_depth) + "}";
      } else if (value.capability_id == "ae.project.items.list") {
        arguments = "{\"limit\":" + std::to_string(value.limit)
            + ",\"offset\":" + std::to_string(value.offset);
        if (value.project_locator.has_value()) {
          arguments += ",\"projectLocator\":" + locator_json(*value.project_locator);
        }
        arguments.push_back('}');
      } else if (value.capability_id == "ae.composition.layers.list"
          || value.capability_id == "ae.composition.selected-layers.list") {
        arguments = "{\"compositionLocator\":"
            + locator_json(*value.composition_locator)
            + ",\"limit\":" + std::to_string(value.limit)
            + ",\"offset\":" + std::to_string(value.offset) + "}";
      } else if (value.capability_id == "ae.composition.time.read") {
        arguments = "{\"compositionLocator\":"
            + locator_json(*value.composition_locator) + "}";
      } else if (value.capability_id == "ae.composition.time.set") {
        arguments = "{\"compositionLocator\":"
            + locator_json(*value.composition_locator)
            + ",\"idempotencyKey\":" + json_string(value.idempotency_key)
            + ",\"targetTime\":{\"scale\":"
            + std::to_string(value.target_time.scale) + ",\"value\":"
            + std::to_string(value.target_time.value) + "}}";
      } else if (value.capability_id == "ae.composition.layer.create") {
        arguments = canonical_composition_layer_create_arguments(
            *value.composition_locator,
            value.layer_create_kind,
            value.layer_create_name,
            value.layer_create_color,
            value.layer_create_width,
            value.layer_create_height,
            value.layer_create_duration,
            value.idempotency_key);
      } else if (value.capability_id == "ae.layer.properties.list") {
        arguments = "{\"layerLocator\":" + locator_json(*value.layer_locator)
            + ",\"limit\":" + std::to_string(value.limit)
            + ",\"offset\":" + std::to_string(value.offset);
        if (value.parent_property_locator.has_value()) {
          arguments += ",\"parentPropertyLocator\":"
              + locator_json(*value.parent_property_locator);
        }
        arguments.push_back('}');
      } else if (value.capability_id == "ae.layer.property.set") {
        arguments = "{\"idempotencyKey\":" + json_string(value.idempotency_key)
            + ",\"layerLocator\":" + locator_json(*value.layer_locator)
            + ",\"propertyLocator\":" + locator_json(*value.property_locator)
            + ",\"value\":" + canonical_layer_property_value(value.property_value)
            + "}";
      }
      params = "{\"arguments\":" + arguments + ",\"capabilityId\":"
          + json_string(value.capability_id)
          + ",\"capabilityVersion\":" + std::to_string(value.capability_version) + "}";
      break;
    }
    case RpcMethod::kCancel: {
      const auto& value = std::get<CancelParams>(request.params);
      params = "{\"targetRequestId\":" + json_string(value.target_request_id) + "}";
      break;
    }
    case RpcMethod::kInvalidateGraph: {
      const auto& value = std::get<InvalidateGraphParams>(request.params);
      if (value.reason != InvalidateGraphParams::Reason::kCepJsx) {
        invalid_argument("unknown project graph invalidation reason");
      }
      params = "{\"reason\":\"cep-jsx\"}";
      break;
    }
  }
  std::vector<std::string> members;
  if (request.deadline_unix_ms.has_value()) {
    members.push_back("\"deadlineUnixMs\":" + std::to_string(*request.deadline_unix_ms));
  }
  members.push_back("\"kind\":\"request\"");
  members.push_back("\"method\":" + json_string(method_name(request.method)));
  members.push_back("\"params\":" + params);
  members.push_back("\"requestId\":" + json_string(request.request_id));
  if (request.session_id.has_value()) {
    members.push_back("\"sessionId\":" + json_string(*request.session_id));
  }
  members.push_back("\"wireVersion\":1");
  std::sort(members.begin(), members.end());
  std::string result = "{";
  for (std::size_t index = 0; index < members.size(); ++index) {
    if (index != 0) result.push_back(',');
    result += members[index];
  }
  result.push_back('}');
  return result;
}

constexpr std::array<std::uint32_t, 64> kSha256Constants = {
  0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U,
  0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
  0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U,
  0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
  0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
  0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
  0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
  0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
  0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU,
  0x5b9cca4fU, 0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
  0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

std::string sha256_hex(std::string_view input) {
  std::vector<std::uint8_t> message(input.begin(), input.end());
  const std::uint64_t bit_length = static_cast<std::uint64_t>(message.size()) * 8U;
  message.push_back(0x80U);
  while ((message.size() % 64U) != 56U) message.push_back(0);
  for (int shift = 56; shift >= 0; shift -= 8) {
    message.push_back(static_cast<std::uint8_t>(bit_length >> shift));
  }
  std::array<std::uint32_t, 8> state = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
  };
  for (std::size_t chunk = 0; chunk < message.size(); chunk += 64) {
    std::array<std::uint32_t, 64> words{};
    for (std::size_t index = 0; index < 16; ++index) {
      const std::size_t base = chunk + index * 4;
      words[index] = (static_cast<std::uint32_t>(message[base]) << 24U)
          | (static_cast<std::uint32_t>(message[base + 1]) << 16U)
          | (static_cast<std::uint32_t>(message[base + 2]) << 8U)
          | static_cast<std::uint32_t>(message[base + 3]);
    }
    for (std::size_t index = 16; index < 64; ++index) {
      const std::uint32_t s0 = std::rotr(words[index - 15], 7)
          ^ std::rotr(words[index - 15], 18) ^ (words[index - 15] >> 3U);
      const std::uint32_t s1 = std::rotr(words[index - 2], 17)
          ^ std::rotr(words[index - 2], 19) ^ (words[index - 2] >> 10U);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    std::uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    std::uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
    for (std::size_t index = 0; index < 64; ++index) {
      const std::uint32_t sum1 = std::rotr(e, 6) ^ std::rotr(e, 11) ^ std::rotr(e, 25);
      const std::uint32_t choice = (e & f) ^ (~e & g);
      const std::uint32_t temp1 = h + sum1 + choice + kSha256Constants[index] + words[index];
      const std::uint32_t sum0 = std::rotr(a, 2) ^ std::rotr(a, 13) ^ std::rotr(a, 22);
      const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t temp2 = sum0 + majority;
      h = g; g = f; f = e; e = d + temp1; d = c; c = b; b = a; a = temp1 + temp2;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }
  static constexpr char kHex[] = "0123456789abcdef";
  std::string output;
  output.reserve(64);
  for (std::uint32_t word : state) {
    for (int shift = 28; shift >= 0; shift -= 4) output.push_back(kHex[(word >> shift) & 0xfU]);
  }
  return output;
}

ParsedRequest classify_request(const JsonValue& root) {
  const JsonValue::Object* envelope = object_of(root);
  if (envelope == nullptr || !exact_keys(*envelope,
      {"wireVersion", "kind", "sessionId", "requestId", "method", "deadlineUnixMs", "params"},
      {"wireVersion", "kind", "requestId", "method", "params"})) {
    invalid_request("request envelope is not closed");
  }
  if (required_uint(*envelope, "wireVersion", CodecErrorKind::kInvalidRequest, 1, 1) != 1
      || required_string(*envelope, "kind", CodecErrorKind::kInvalidRequest) != "request") {
    invalid_request("invalid request envelope discriminator");
  }
  ParsedRequest request;
  request.request_id = required_string(*envelope, "requestId", CodecErrorKind::kInvalidRequest);
  if (!valid_request_id(request.request_id)) invalid_request("invalid request ID");
  const std::string method = required_string(*envelope, "method", CodecErrorKind::kInvalidRequest);
  if (method == "hello") request.method = RpcMethod::kHello;
  else if (method == "capabilities") request.method = RpcMethod::kCapabilities;
  else if (method == "invoke") request.method = RpcMethod::kInvoke;
  else if (method == "cancel") request.method = RpcMethod::kCancel;
  else if (method == "invalidateGraph") request.method = RpcMethod::kInvalidateGraph;
  else invalid_request("unknown RPC method");

  if (const JsonValue* value = member(*envelope, "deadlineUnixMs")) {
    const JsonNumber* number = number_of(*value);
    if (number == nullptr || std::trunc(number->value) != number->value || number->value < 1
        || number->value > static_cast<double>(kMaxSafeInteger)) {
      invalid_argument("invalid request deadline");
    }
    request.deadline_unix_ms = static_cast<std::uint64_t>(number->value);
  }
  if (request.method == RpcMethod::kHello && member(*envelope, "sessionId") != nullptr) {
    invalid_request("hello must not include a session ID");
  }
  if (const JsonValue* value = member(*envelope, "sessionId")) {
    const std::string* session = string_of(*value);
    if (session == nullptr || !valid_uuid(*session)) session_stale("invalid session ID");
    request.session_id = *session;
  }
  const JsonValue* params_value = member(*envelope, "params");
  const JsonValue::Object* params = params_value == nullptr ? nullptr : object_of(*params_value);
  if (params == nullptr) invalid_argument("params must be an object");

  if (request.method == RpcMethod::kHello) {
    if (!exact_keys(*params, {"supportedWireVersions", "client", "nonce"},
        {"supportedWireVersions", "client", "nonce"})) invalid_argument("invalid hello params");
    const JsonValue* range_value = member(*params, "supportedWireVersions");
    const JsonValue::Object* range = range_value == nullptr ? nullptr : object_of(*range_value);
    const JsonValue* client_value = member(*params, "client");
    const JsonValue::Object* client = client_value == nullptr ? nullptr : object_of(*client_value);
    if (range == nullptr || !exact_keys(*range, {"minimum", "maximum"}, {"minimum", "maximum"})
        || client == nullptr || !exact_keys(*client, {"component", "version", "instanceId"},
          {"component", "version", "instanceId"})) invalid_argument("invalid hello object");
    HelloParams result;
    result.minimum_wire_version = static_cast<std::uint16_t>(required_uint(
        *range, "minimum", CodecErrorKind::kInvalidArgument, 1, 65'535));
    result.maximum_wire_version = static_cast<std::uint16_t>(required_uint(
        *range, "maximum", CodecErrorKind::kInvalidArgument, 1, 65'535));
    if (result.minimum_wire_version > result.maximum_wire_version) {
      invalid_argument("wire range minimum exceeds maximum");
    }
    const std::string component = required_string(*client, "component", CodecErrorKind::kInvalidArgument);
    if (component == "core-broker") result.component = ClientComponent::kCoreBroker;
    else if (component == "development-smoke") result.component = ClientComponent::kDevelopmentSmoke;
    else invalid_argument("invalid client component");
    result.client_version = required_string(*client, "version", CodecErrorKind::kInvalidArgument);
    if (validate_utf8_and_count(result.client_version) < 1
        || validate_utf8_and_count(result.client_version) > 64) invalid_argument("invalid client version");
    result.client_instance_id = required_string(*client, "instanceId", CodecErrorKind::kInvalidArgument);
    if (!valid_uuid(result.client_instance_id)) invalid_argument("invalid client instance ID");
    result.nonce = required_string(*params, "nonce", CodecErrorKind::kInvalidArgument);
    const auto nonce_character = [](char character) {
      return ascii_alphanumeric(character) || character == '_' || character == '-';
    };
    if (!bounded_ascii_token(result.nonce, 32, 128, nonce_character)) invalid_argument("invalid nonce");
    request.params = std::move(result);
  } else {
    if (!request.session_id.has_value()) session_stale("session ID is required");
    if (request.method == RpcMethod::kCapabilities) {
      if (!exact_keys(*params, {"ids", "detail", "limit"})) {
        invalid_argument("invalid capabilities params");
      }
      CapabilitiesParams result;
      if (const JsonValue* value = member(*params, "detail")) {
        const std::string* detail = string_of(*value);
        if (detail == nullptr || (*detail != "summary" && *detail != "full")) {
          invalid_argument("invalid capabilities detail");
        }
        result.detail = *detail == "full" ? CapabilityDetail::kFull : CapabilityDetail::kSummary;
        result.detail_was_provided = true;
      }
      if (member(*params, "limit") != nullptr) {
        result.limit = static_cast<std::uint16_t>(required_uint(
            *params, "limit", CodecErrorKind::kInvalidArgument, 1, 100));
        result.limit_was_provided = true;
      }
      if (const JsonValue* value = member(*params, "ids")) {
        const JsonValue::Array* ids = array_of(*value);
        if (ids == nullptr || ids->empty() || ids->size() > 32) invalid_argument("invalid capability IDs");
        std::vector<std::string> parsed_ids;
        std::set<std::string> unique;
        for (const JsonValue& item : *ids) {
          const std::string* id = string_of(item);
          if (id == nullptr || !valid_capability_id(*id) || !unique.insert(*id).second) {
            invalid_argument("invalid or duplicate capability ID");
          }
          parsed_ids.push_back(*id);
        }
        result.ids = std::move(parsed_ids);
      }
      request.params = std::move(result);
    } else if (request.method == RpcMethod::kInvoke) {
      if (!exact_keys(*params, {"capabilityId", "capabilityVersion", "arguments"},
          {"capabilityId", "capabilityVersion", "arguments"})) invalid_argument("invalid invoke params");
      const std::string capability = required_string(*params, "capabilityId", CodecErrorKind::kInvalidArgument);
      const std::uint64_t version = required_uint(
          *params, "capabilityVersion", CodecErrorKind::kInvalidArgument, 1, kMaxSafeInteger);
      const JsonValue* arguments_value = member(*params, "arguments");
      const JsonValue::Object* arguments = arguments_value == nullptr ? nullptr : object_of(*arguments_value);
      if (version != 1 || arguments == nullptr) {
        invalid_argument("invoke is not in the compile-time allowlist");
      }
      InvokeParams result;
      result.capability_id = capability;
      result.capability_version = 1;
      if (capability == "ae.project.summary") {
        if (!arguments->empty()) {
          invalid_argument("project summary arguments must be empty");
        }
      } else if (capability == "ae.project.bit-depth.read") {
        if (!arguments->empty()) {
          invalid_argument("project bit-depth read arguments must be empty");
        }
      } else if (capability == "ae.project.bit-depth.set") {
        if (!exact_keys(
                *arguments,
                {"targetDepth", "idempotencyKey"},
                {"targetDepth", "idempotencyKey"})) {
          invalid_argument("project bit-depth set arguments are not closed");
        }
        result.target_depth = static_cast<std::int32_t>(required_uint(
            *arguments, "targetDepth", CodecErrorKind::kInvalidArgument, 0, 32));
        result.idempotency_key = required_string(
            *arguments, "idempotencyKey", CodecErrorKind::kInvalidArgument);
        if (!valid_bit_depth(result.target_depth)) {
          invalid_argument("targetDepth must be one of 8, 16, or 32");
        }
        if (!valid_idempotency_key(result.idempotency_key)) {
          invalid_argument("invalid project bit-depth idempotency key");
        }
        const std::string canonical_arguments = "{\"idempotencyKey\":"
            + json_string(result.idempotency_key) + ",\"targetDepth\":"
            + std::to_string(result.target_depth) + "}";
        result.arguments_fingerprint_sha256 = sha256_hex(canonical_arguments);
      } else if (capability == "ae.project.items.list") {
        if (!exact_keys(
                *arguments,
                {"offset", "limit", "projectLocator"},
                {"offset", "limit"})) {
          invalid_argument("project items list arguments are not closed");
        }
        result.offset = required_uint(
            *arguments, "offset", CodecErrorKind::kInvalidArgument, 0, kMaxSafeInteger);
        result.limit = static_cast<std::uint16_t>(required_uint(
            *arguments, "limit", CodecErrorKind::kInvalidArgument, 1, 50));
        if (const JsonValue* locator = member(*arguments, "projectLocator")) {
          result.project_locator = parse_locator(*locator, "project");
        }
        if (result.offset > 0 && !result.project_locator.has_value()) {
          invalid_argument("projectLocator is required for a non-zero offset");
        }
      } else if (capability == "ae.composition.layers.list"
          || capability == "ae.composition.selected-layers.list") {
        if (!exact_keys(
                *arguments,
                {"compositionLocator", "offset", "limit"},
                {"compositionLocator", "offset", "limit"})) {
          invalid_argument("composition layer list arguments are not closed");
        }
        const JsonValue* locator = member(*arguments, "compositionLocator");
        result.composition_locator = parse_locator(*locator, "composition");
        result.offset = required_uint(
            *arguments, "offset", CodecErrorKind::kInvalidArgument, 0, kMaxSafeInteger);
        result.limit = static_cast<std::uint16_t>(required_uint(
            *arguments, "limit", CodecErrorKind::kInvalidArgument, 1, 50));
      } else if (capability == "ae.composition.time.read") {
        if (!exact_keys(
                *arguments,
                {"compositionLocator"},
                {"compositionLocator"})) {
          invalid_argument("composition time read arguments are not closed");
        }
        result.composition_locator = parse_locator(
            *member(*arguments, "compositionLocator"), "composition");
      } else if (capability == "ae.composition.time.set") {
        if (!exact_keys(
                *arguments,
                {"compositionLocator", "targetTime", "idempotencyKey"},
                {"compositionLocator", "targetTime", "idempotencyKey"})) {
          invalid_argument("composition time set arguments are not closed");
        }
        result.composition_locator = parse_locator(
            *member(*arguments, "compositionLocator"), "composition");
        const JsonValue* target_value = member(*arguments, "targetTime");
        const JsonValue::Object* target = target_value == nullptr
            ? nullptr : object_of(*target_value);
        if (target == nullptr
            || !exact_keys(*target, {"value", "scale"}, {"value", "scale"})) {
          invalid_argument("targetTime must be a closed exact time pair");
        }
        result.target_time.value = static_cast<std::int32_t>(required_int(
            *target,
            "value",
            CodecErrorKind::kInvalidArgument,
            std::numeric_limits<std::int32_t>::min(),
            std::numeric_limits<std::int32_t>::max()));
        result.target_time.scale = static_cast<std::uint32_t>(required_uint(
            *target,
            "scale",
            CodecErrorKind::kInvalidArgument,
            1,
            std::numeric_limits<std::uint32_t>::max()));
        result.target_time.seconds_rational = canonical_seconds_rational(
            result.target_time.value, result.target_time.scale);
        result.idempotency_key = required_string(
            *arguments, "idempotencyKey", CodecErrorKind::kInvalidArgument);
        if (!valid_idempotency_key(result.idempotency_key)) {
          invalid_argument("invalid composition time idempotency key");
        }
        result.arguments_fingerprint_sha256 = digest_composition_time_set_arguments(
            *result.composition_locator,
            result.target_time,
            result.idempotency_key);
      } else if (capability == "ae.composition.layer.create") {
        if (!exact_keys(
                *arguments,
                {"compositionLocator", "kind", "name", "color", "width",
                    "height", "duration", "idempotencyKey"},
                {"compositionLocator", "kind", "name", "idempotencyKey"})) {
          invalid_argument("composition layer create arguments are not closed");
        }
        result.composition_locator = parse_locator(
            *member(*arguments, "compositionLocator"), "composition");
        result.layer_create_kind = required_string(
            *arguments, "kind", CodecErrorKind::kInvalidArgument);
        result.layer_create_name = required_string(
            *arguments, "name", CodecErrorKind::kInvalidArgument);
        if ((result.layer_create_kind != "null"
                && result.layer_create_kind != "solid")
            || validate_utf8_and_count(result.layer_create_name) < 1
            || validate_utf8_and_count(result.layer_create_name) > 255) {
          invalid_argument("invalid composition layer kind or name");
        }
        if (const JsonValue* color_value = member(*arguments, "color")) {
          const JsonValue::Object* color = object_of(*color_value);
          if (color == nullptr
              || !exact_keys(
                  *color, {"red", "green", "blue", "alpha"},
                  {"red", "green", "blue", "alpha"})) {
            invalid_argument("composition layer color is not closed RGBA");
          }
          result.layer_create_color = CompositionLayerCreateColor{
              static_cast<std::uint16_t>(required_uint(
                  *color, "red", CodecErrorKind::kInvalidArgument, 0, 255)),
              static_cast<std::uint16_t>(required_uint(
                  *color, "green", CodecErrorKind::kInvalidArgument, 0, 255)),
              static_cast<std::uint16_t>(required_uint(
                  *color, "blue", CodecErrorKind::kInvalidArgument, 0, 255)),
              static_cast<std::uint16_t>(required_uint(
                  *color, "alpha", CodecErrorKind::kInvalidArgument, 0, 255)),
          };
        }
        if (member(*arguments, "width") != nullptr) {
          result.layer_create_width = static_cast<std::uint32_t>(required_uint(
              *arguments, "width", CodecErrorKind::kInvalidArgument, 1, 30000));
        }
        if (member(*arguments, "height") != nullptr) {
          result.layer_create_height = static_cast<std::uint32_t>(required_uint(
              *arguments, "height", CodecErrorKind::kInvalidArgument, 1, 30000));
        }
        if (const JsonValue* duration_value = member(*arguments, "duration")) {
          const JsonValue::Object* duration = object_of(*duration_value);
          if (duration == nullptr
              || !exact_keys(*duration, {"value", "scale"}, {"value", "scale"})) {
            invalid_argument("composition layer duration must be an exact time pair");
          }
          CompositionCurrentTime parsed_duration;
          parsed_duration.value = static_cast<std::int32_t>(required_int(
              *duration, "value", CodecErrorKind::kInvalidArgument,
              std::numeric_limits<std::int32_t>::min(),
              std::numeric_limits<std::int32_t>::max()));
          parsed_duration.scale = static_cast<std::uint32_t>(required_uint(
              *duration, "scale", CodecErrorKind::kInvalidArgument, 1,
              std::numeric_limits<std::uint32_t>::max()));
          parsed_duration.seconds_rational = canonical_seconds_rational(
              parsed_duration.value, parsed_duration.scale);
          result.layer_create_duration = parsed_duration;
        }
        if (result.layer_create_kind == "null"
            && (result.layer_create_color.has_value()
                || result.layer_create_width.has_value()
                || result.layer_create_height.has_value()
                || result.layer_create_duration.has_value())) {
          invalid_argument("solid-only options require kind solid");
        }
        result.idempotency_key = required_string(
            *arguments, "idempotencyKey", CodecErrorKind::kInvalidArgument);
        if (!valid_idempotency_key(result.idempotency_key)) {
          invalid_argument("invalid composition layer create idempotency key");
        }
        result.arguments_fingerprint_sha256 =
            digest_composition_layer_create_arguments(
                *result.composition_locator,
                result.layer_create_kind,
                result.layer_create_name,
                result.layer_create_color,
                result.layer_create_width,
                result.layer_create_height,
                result.layer_create_duration,
                result.idempotency_key);
      } else if (capability == "ae.layer.properties.list") {
        if (!exact_keys(
                *arguments,
                {"layerLocator", "parentPropertyLocator", "offset", "limit"},
                {"layerLocator", "offset", "limit"})) {
          invalid_argument("layer properties list arguments are not closed");
        }
        result.layer_locator = parse_locator(
            *member(*arguments, "layerLocator"), "layer");
        if (const JsonValue* locator = member(*arguments, "parentPropertyLocator")) {
          if (std::holds_alternative<std::nullptr_t>(locator->value)) {
            result.parent_property_locator = std::nullopt;
          } else {
            result.parent_property_locator = parse_locator(*locator, "stream");
          }
        }
        result.offset = required_uint(
            *arguments, "offset", CodecErrorKind::kInvalidArgument, 0, kMaxSafeInteger);
        result.limit = static_cast<std::uint16_t>(required_uint(
            *arguments, "limit", CodecErrorKind::kInvalidArgument, 1, 25));
      } else if (capability == "ae.layer.property.set") {
        if (!exact_keys(
                *arguments,
                {"layerLocator", "propertyLocator", "value", "idempotencyKey"},
                {"layerLocator", "propertyLocator", "value", "idempotencyKey"})) {
          invalid_argument("layer property set arguments are not closed");
        }
        result.layer_locator = parse_locator(
            *member(*arguments, "layerLocator"), "layer");
        result.property_locator = parse_locator(
            *member(*arguments, "propertyLocator"), "stream");
        if (!same_locator_scope(*result.layer_locator, *result.property_locator)) {
          invalid_argument("layer and property locators must share one context");
        }
        result.property_value = parse_layer_property_value(
            *member(*arguments, "value"));
        result.idempotency_key = required_string(
            *arguments, "idempotencyKey", CodecErrorKind::kInvalidArgument);
        if (!valid_idempotency_key(result.idempotency_key)) {
          invalid_argument("invalid layer property idempotency key");
        }
        result.arguments_fingerprint_sha256 = digest_layer_property_set_arguments(
            *result.layer_locator,
            *result.property_locator,
            result.property_value,
            result.idempotency_key);
      } else {
        invalid_argument("invoke is not in the compile-time allowlist");
      }
      request.params = std::move(result);
    } else if (request.method == RpcMethod::kCancel) {
      if (!exact_keys(*params, {"targetRequestId"}, {"targetRequestId"})) {
        invalid_argument("invalid cancel params");
      }
      CancelParams result;
      result.target_request_id = required_string(
          *params, "targetRequestId", CodecErrorKind::kInvalidArgument);
      if (!valid_request_id(result.target_request_id)) invalid_argument("invalid cancel target ID");
      request.params = std::move(result);
    } else {
      if (!exact_keys(*params, {"reason"}, {"reason"})
          || required_string(*params, "reason", CodecErrorKind::kInvalidArgument)
              != "cep-jsx") {
        invalid_argument("invalid project graph invalidation params");
      }
      request.params = InvalidateGraphParams{};
    }
  }
  request.request_fingerprint_sha256 = sha256_hex(canonical_request(request));
  return request;
}

bool same_locator_scope(const ObjectLocator& value, const ObjectLocator& scope) {
  return value.host_instance_id == scope.host_instance_id
      && value.session_id == scope.session_id
      && value.project_id == scope.project_id
      && value.generation == scope.generation;
}

std::string nullable_locator_json(const std::optional<ObjectLocator>& value) {
  return value.has_value() ? locator_json(*value) : "null";
}

std::string canonical_project_items_value(const ProjectItemsPage& page) {
  if (!valid_output_locator(page.project_locator) || page.project_locator.kind != "project"
      || page.total > kMaxSafeInteger || page.offset > kMaxSafeInteger
      || page.limit < 1 || page.limit > 50 || page.items.size() > page.limit
      || page.items.size() > kMaxSafeInteger) {
    invalid_argument("invalid project items page");
  }
  const std::uint64_t returned = page.items.size();
  if (page.offset > page.total || returned > page.total - page.offset) {
    invalid_argument("project items page exceeds the reported total");
  }
  const bool expected_more = page.offset + returned < page.total;
  if ((expected_more && returned == 0) || page.has_more != expected_more
      || (expected_more
          ? (!page.next_offset.has_value()
              || *page.next_offset != page.offset + returned)
          : page.next_offset.has_value())) {
    invalid_argument("project items pagination invariant failed");
  }
  std::string items = "[";
  std::set<std::string> object_ids;
  for (std::size_t index = 0; index < page.items.size(); ++index) {
    const ProjectItemEntry& item = page.items[index];
    if (index != 0) items.push_back(',');
    if (!valid_output_locator(item.locator) || !same_locator_scope(item.locator, page.project_locator)
        || (item.type != "folder" && item.type != "composition"
            && item.type != "footage" && item.type != "unknown")
        || (item.type == "composition" ? item.locator.kind != "composition"
                                        : item.locator.kind != "item")
        || validate_utf8_and_count(item.name) > 1'024
        || !object_ids.insert(item.locator.object_id).second) {
      invalid_argument("invalid project item result");
    }
    if (!item.parent_locator.has_value()
        || !valid_output_locator(*item.parent_locator)
            || !same_locator_scope(*item.parent_locator, page.project_locator)
            || (item.parent_locator->kind != "project"
                && item.parent_locator->kind != "item")
        || (item.parent_locator->kind == "project"
            && *item.parent_locator != page.project_locator)) {
      invalid_argument("invalid project item parent locator");
    }
    items += "{\"locator\":" + locator_json(item.locator)
        + ",\"name\":" + json_string(item.name)
        + ",\"parentLocator\":" + nullable_locator_json(item.parent_locator)
        + ",\"type\":" + json_string(item.type) + "}";
  }
  items.push_back(']');
  return "{\"hasMore\":" + std::string(page.has_more ? "true" : "false")
      + ",\"items\":" + items + ",\"limit\":" + std::to_string(page.limit)
      + ",\"nextOffset\":"
      + (page.next_offset.has_value() ? std::to_string(*page.next_offset) : "null")
      + ",\"offset\":" + std::to_string(page.offset)
      + ",\"projectLocator\":" + locator_json(page.project_locator)
      + ",\"returned\":" + std::to_string(returned)
      + ",\"total\":" + std::to_string(page.total) + "}";
}

std::string canonical_composition_layers_value(const CompositionLayersPage& page) {
  if (!valid_output_locator(page.composition_locator)
      || page.composition_locator.kind != "composition"
      || validate_utf8_and_count(page.composition_name) > 1'024
      || page.total > kMaxSafeInteger || page.offset > kMaxSafeInteger
      || page.limit < 1 || page.limit > 50 || page.layers.size() > page.limit
      || page.layers.size() > kMaxSafeInteger) {
    invalid_argument("invalid composition layers page");
  }
  const std::uint64_t returned = page.layers.size();
  if (page.offset > page.total || returned > page.total - page.offset) {
    invalid_argument("composition layers page exceeds the reported total");
  }
  const bool expected_more = page.offset + returned < page.total;
  if ((expected_more && returned == 0) || page.has_more != expected_more
      || (expected_more
          ? (!page.next_offset.has_value()
              || *page.next_offset != page.offset + returned)
          : page.next_offset.has_value())) {
    invalid_argument("composition layers pagination invariant failed");
  }
  std::string layers = "[";
  std::set<std::string> object_ids;
  for (std::size_t index = 0; index < page.layers.size(); ++index) {
    const CompositionLayerEntry& layer = page.layers[index];
    if (index != 0) layers.push_back(',');
    const bool valid_type = layer.type == "av" || layer.type == "camera"
        || layer.type == "light" || layer.type == "text" || layer.type == "shape"
        || layer.type == "model3d" || layer.type == "null"
        || layer.type == "adjustment" || layer.type == "unknown";
    if (!valid_output_locator(layer.locator) || layer.locator.kind != "layer"
        || !same_locator_scope(layer.locator, page.composition_locator)
        || layer.stack_index != page.offset + index + 1
        || layer.stack_index > kMaxSafeInteger
        || validate_utf8_and_count(layer.name) > 1'024 || !valid_type
        || !object_ids.insert(layer.locator.object_id).second) {
      invalid_argument("invalid composition layer result");
    }
    if (layer.parent_locator.has_value()
        && (!valid_output_locator(*layer.parent_locator)
            || layer.parent_locator->kind != "layer"
            || !same_locator_scope(*layer.parent_locator, page.composition_locator))) {
      invalid_argument("invalid parent layer locator");
    }
    if (layer.source_item_locator.has_value()
        && (!valid_output_locator(*layer.source_item_locator)
            || (layer.source_item_locator->kind != "item"
                && layer.source_item_locator->kind != "composition")
            || !same_locator_scope(*layer.source_item_locator, page.composition_locator))) {
      invalid_argument("invalid source item locator");
    }
    layers += "{\"isThreeD\":" + std::string(layer.is_three_d ? "true" : "false")
        + ",\"locator\":" + locator_json(layer.locator)
        + ",\"locked\":" + std::string(layer.locked ? "true" : "false")
        + ",\"name\":" + json_string(layer.name)
        + ",\"parentLocator\":" + nullable_locator_json(layer.parent_locator)
        + ",\"sourceItemLocator\":" + nullable_locator_json(layer.source_item_locator)
        + ",\"stackIndex\":" + std::to_string(layer.stack_index)
        + ",\"type\":" + json_string(layer.type)
        + ",\"videoEnabled\":" + std::string(layer.video_enabled ? "true" : "false")
        + "}";
  }
  layers.push_back(']');
  return "{\"compositionLocator\":" + locator_json(page.composition_locator)
      + ",\"compositionName\":" + json_string(page.composition_name)
      + ",\"hasMore\":" + std::string(page.has_more ? "true" : "false")
      + ",\"layers\":" + layers + ",\"limit\":" + std::to_string(page.limit)
      + ",\"nextOffset\":"
      + (page.next_offset.has_value() ? std::to_string(*page.next_offset) : "null")
      + ",\"offset\":" + std::to_string(page.offset)
      + ",\"returned\":" + std::to_string(returned)
      + ",\"total\":" + std::to_string(page.total) + "}";
}

std::string canonical_composition_selected_layers_value(
    const CompositionLayersPage& page) {
  if (!valid_output_locator(page.composition_locator)
      || page.composition_locator.kind != "composition"
      || validate_utf8_and_count(page.composition_name) > 1'024
      || page.total > kMaxSafeInteger || page.offset > kMaxSafeInteger
      || page.limit < 1 || page.limit > 50 || page.layers.size() > page.limit
      || page.layers.size() > kMaxSafeInteger) {
    invalid_argument("invalid composition selected layers page");
  }
  const std::uint64_t returned = page.layers.size();
  if (page.offset > page.total || returned > page.total - page.offset) {
    invalid_argument("composition selected layers page exceeds the reported total");
  }
  const bool expected_more = page.offset + returned < page.total;
  if ((expected_more && returned == 0) || page.has_more != expected_more
      || (expected_more
          ? (!page.next_offset.has_value()
              || *page.next_offset != page.offset + returned)
          : page.next_offset.has_value())) {
    invalid_argument("composition selected layers pagination invariant failed");
  }
  std::string layers = "[";
  std::set<std::string> object_ids;
  std::uint64_t previous_stack_index = 0;
  for (std::size_t index = 0; index < page.layers.size(); ++index) {
    const CompositionLayerEntry& layer = page.layers[index];
    if (index != 0) layers.push_back(',');
    const bool valid_type = layer.type == "av" || layer.type == "camera"
        || layer.type == "light" || layer.type == "text" || layer.type == "shape"
        || layer.type == "model3d" || layer.type == "null"
        || layer.type == "adjustment" || layer.type == "unknown";
    if (!valid_output_locator(layer.locator) || layer.locator.kind != "layer"
        || !same_locator_scope(layer.locator, page.composition_locator)
        || layer.stack_index < 1 || layer.stack_index > kMaxSafeInteger
        || (index != 0 && layer.stack_index <= previous_stack_index)
        || validate_utf8_and_count(layer.name) > 1'024 || !valid_type
        || !object_ids.insert(layer.locator.object_id).second) {
      invalid_argument("invalid composition selected layer result");
    }
    previous_stack_index = layer.stack_index;
    if (layer.parent_locator.has_value()
        && (!valid_output_locator(*layer.parent_locator)
            || layer.parent_locator->kind != "layer"
            || !same_locator_scope(*layer.parent_locator, page.composition_locator))) {
      invalid_argument("invalid selected layer parent locator");
    }
    if (layer.source_item_locator.has_value()
        && (!valid_output_locator(*layer.source_item_locator)
            || (layer.source_item_locator->kind != "item"
                && layer.source_item_locator->kind != "composition")
            || !same_locator_scope(*layer.source_item_locator, page.composition_locator))) {
      invalid_argument("invalid selected layer source item locator");
    }
    layers += "{\"isThreeD\":" + std::string(layer.is_three_d ? "true" : "false")
        + ",\"locator\":" + locator_json(layer.locator)
        + ",\"locked\":" + std::string(layer.locked ? "true" : "false")
        + ",\"name\":" + json_string(layer.name)
        + ",\"parentLocator\":" + nullable_locator_json(layer.parent_locator)
        + ",\"sourceItemLocator\":" + nullable_locator_json(layer.source_item_locator)
        + ",\"stackIndex\":" + std::to_string(layer.stack_index)
        + ",\"type\":" + json_string(layer.type)
        + ",\"videoEnabled\":" + std::string(layer.video_enabled ? "true" : "false")
        + "}";
  }
  layers.push_back(']');
  return "{\"compositionLocator\":" + locator_json(page.composition_locator)
      + ",\"compositionName\":" + json_string(page.composition_name)
      + ",\"hasMore\":" + std::string(page.has_more ? "true" : "false")
      + ",\"layers\":" + layers + ",\"limit\":" + std::to_string(page.limit)
      + ",\"nextOffset\":"
      + (page.next_offset.has_value() ? std::to_string(*page.next_offset) : "null")
      + ",\"offset\":" + std::to_string(page.offset)
      + ",\"returned\":" + std::to_string(returned)
      + ",\"total\":" + std::to_string(page.total) + "}";
}

std::string canonical_composition_time_value(const CompositionTimeRead& value) {
  if (!valid_output_locator(value.composition_locator)
      || value.composition_locator.kind != "composition"
      || value.current_time.scale < 1
      || value.current_time.seconds_rational
          != canonical_seconds_rational(
              static_cast<std::int64_t>(value.current_time.value),
              value.current_time.scale)) {
    invalid_argument("invalid composition time result");
  }
  return "{\"compositionLocator\":" + locator_json(value.composition_locator)
      + ",\"currentTime\":{\"scale\":" + std::to_string(value.current_time.scale)
      + ",\"secondsRational\":" + json_string(value.current_time.seconds_rational)
      + ",\"value\":" + std::to_string(value.current_time.value) + "}}";
}

std::string canonical_current_time(const CompositionCurrentTime& value) {
  if (value.scale < 1
      || value.seconds_rational
          != canonical_seconds_rational(value.value, value.scale)) {
    invalid_argument("invalid exact composition time");
  }
  return "{\"scale\":" + std::to_string(value.scale)
      + ",\"secondsRational\":" + json_string(value.seconds_rational)
      + ",\"value\":" + std::to_string(value.value) + "}";
}

bool composition_times_equal(
    const CompositionCurrentTime& left,
    const CompositionCurrentTime& right) {
  return static_cast<std::int64_t>(left.value)
          * static_cast<std::int64_t>(right.scale)
      == static_cast<std::int64_t>(right.value)
          * static_cast<std::int64_t>(left.scale);
}

std::string canonical_composition_time_set_value(
    const CompositionTimeChanged& value) {
  if (!value.changed || !valid_output_locator(value.composition_locator)
      || value.composition_locator.kind != "composition"
      || composition_times_equal(value.before_time, value.after_time)) {
    invalid_argument("invalid composition time change result");
  }
  return "{\"afterTime\":" + canonical_current_time(value.after_time)
      + ",\"beforeTime\":" + canonical_current_time(value.before_time)
      + ",\"changed\":true,\"compositionLocator\":"
      + locator_json(value.composition_locator) + "}";
}

std::string canonical_layer_create_color(
    const CompositionLayerCreateColor& color) {
  if (color.red > 255 || color.green > 255
      || color.blue > 255 || color.alpha > 255) {
    invalid_argument("invalid composition layer create color");
  }
  return "{\"alpha\":" + std::to_string(color.alpha)
      + ",\"blue\":" + std::to_string(color.blue)
      + ",\"green\":" + std::to_string(color.green)
      + ",\"red\":" + std::to_string(color.red) + "}";
}

std::string canonical_composition_layer_create_arguments(
    const ObjectLocator& composition_locator,
    std::string_view kind,
    std::string_view name,
    const std::optional<CompositionLayerCreateColor>& color,
    const std::optional<std::uint32_t>& width,
    const std::optional<std::uint32_t>& height,
    const std::optional<CompositionCurrentTime>& duration,
    std::string_view idempotency_key) {
  if (!valid_output_locator(composition_locator)
      || composition_locator.kind != "composition"
      || (kind != "null" && kind != "solid")
      || validate_utf8_and_count(name) < 1
      || validate_utf8_and_count(name) > 255
      || !valid_idempotency_key(idempotency_key)
      || (kind == "null" && (color.has_value() || width.has_value()
          || height.has_value() || duration.has_value()))
      || (width.has_value() && (*width < 1 || *width > 30000))
      || (height.has_value() && (*height < 1 || *height > 30000))) {
    invalid_argument("invalid composition layer create arguments");
  }
  std::vector<std::string> members{
      "\"compositionLocator\":" + locator_json(composition_locator),
      "\"idempotencyKey\":" + json_string(idempotency_key),
      "\"kind\":" + json_string(kind),
      "\"name\":" + json_string(name),
  };
  if (color.has_value()) {
    members.push_back("\"color\":" + canonical_layer_create_color(*color));
  }
  if (duration.has_value()) {
    members.push_back("\"duration\":{\"scale\":"
        + std::to_string(duration->scale) + ",\"value\":"
        + std::to_string(duration->value) + "}");
  }
  if (height.has_value()) {
    members.push_back("\"height\":" + std::to_string(*height));
  }
  if (width.has_value()) {
    members.push_back("\"width\":" + std::to_string(*width));
  }
  std::sort(members.begin(), members.end());
  std::string result = "{";
  for (std::size_t index = 0; index < members.size(); ++index) {
    if (index != 0) result.push_back(',');
    result += members[index];
  }
  result.push_back('}');
  return result;
}

std::string canonical_composition_layer_create_value(
    const CompositionLayerCreated& value) {
  if (!value.changed || (value.kind != "null" && value.kind != "solid")
      || validate_utf8_and_count(value.name) < 1
      || validate_utf8_and_count(value.name) > 255
      || value.stack_index < 1 || value.stack_index > kMaxSafeInteger
      || !valid_output_locator(value.composition_locator)
      || value.composition_locator.kind != "composition"
      || !valid_output_locator(value.layer_locator)
      || value.layer_locator.kind != "layer"
      || !same_locator_scope(value.composition_locator, value.layer_locator)
      || value.layer_count_before > kMaxSafeInteger
      || value.layer_count_after != value.layer_count_before + 1
      || value.stack_index > value.layer_count_after
      || value.project_item_count_before > kMaxSafeInteger
      || value.project_item_count_after > kMaxSafeInteger
      || value.project_item_count_after < value.project_item_count_before) {
    invalid_argument("invalid composition layer create result");
  }
  if (value.source_item_locator.has_value()
      && (!valid_output_locator(*value.source_item_locator)
          || (value.source_item_locator->kind != "item"
              && value.source_item_locator->kind != "composition")
          || !same_locator_scope(
              value.composition_locator, *value.source_item_locator))) {
    invalid_argument("invalid created layer source item locator");
  }
  std::string solid = "null";
  if (value.kind == "solid") {
    if (!value.solid.has_value() || !value.source_item_locator.has_value()
        || value.project_item_count_after <= value.project_item_count_before
        || value.solid->width < 1 || value.solid->width > 30000
        || value.solid->height < 1 || value.solid->height > 30000) {
      invalid_argument("invalid solid layer create result");
    }
    solid = "{\"color\":" + canonical_layer_create_color(value.solid->color)
        + ",\"duration\":" + canonical_current_time(value.solid->duration)
        + ",\"height\":" + std::to_string(value.solid->height)
        + ",\"width\":" + std::to_string(value.solid->width) + "}";
  } else if (value.solid.has_value()) {
    invalid_argument("null layer create returned solid metadata");
  }
  return "{\"changed\":true,\"compositionLocator\":"
      + locator_json(value.composition_locator)
      + ",\"kind\":" + json_string(value.kind)
      + ",\"layerCountAfter\":" + std::to_string(value.layer_count_after)
      + ",\"layerCountBefore\":" + std::to_string(value.layer_count_before)
      + ",\"layerLocator\":" + locator_json(value.layer_locator)
      + ",\"name\":" + json_string(value.name)
      + ",\"projectItemCountAfter\":"
      + std::to_string(value.project_item_count_after)
      + ",\"projectItemCountBefore\":"
      + std::to_string(value.project_item_count_before)
      + ",\"solid\":" + solid
      + ",\"sourceItemLocator\":"
      + nullable_locator_json(value.source_item_locator)
      + ",\"stackIndex\":" + std::to_string(value.stack_index) + "}";
}

bool valid_decimal_string(std::string_view text) {
  if (text.empty() || text.size() > 32) return false;
  std::size_t index = text.front() == '-' ? 1U : 0U;
  if (index >= text.size()) return false;
  if (text[index] == '0') {
    ++index;
    if (index < text.size() && text[index] >= '0' && text[index] <= '9') return false;
  } else {
    if (text[index] < '1' || text[index] > '9') return false;
    while (index < text.size() && text[index] >= '0' && text[index] <= '9') ++index;
  }
  if (index < text.size() && text[index] == '.') {
    const std::size_t fractional = ++index;
    while (index < text.size() && text[index] >= '0' && text[index] <= '9') ++index;
    if (index == fractional) return false;
  }
  if (index < text.size() && (text[index] == 'e' || text[index] == 'E')) {
    ++index;
    if (index < text.size() && (text[index] == '+' || text[index] == '-')) ++index;
    const std::size_t exponent = index;
    while (index < text.size() && text[index] >= '0' && text[index] <= '9') ++index;
    if (index == exponent) return false;
  }
  if (index != text.size()) return false;
  double parsed = 0;
  std::istringstream stream{std::string(text)};
  stream.imbue(std::locale::classic());
  stream >> std::noskipws >> parsed;
  if (!stream || stream.peek() != std::char_traits<char>::eof()
      || !std::isfinite(parsed)) {
    return false;
  }
  if (parsed == 0) {
    if (text.front() == '-') return false;
    const std::size_t exponent = text.find_first_of("eE");
    const std::string_view significand = text.substr(0, exponent);
    if (std::any_of(significand.begin(), significand.end(), [](char character) {
          return character >= '1' && character <= '9';
        })) return false;
  }
  return true;
}

std::string nullable_bool_json(const std::optional<bool>& value) {
  if (!value.has_value()) return "null";
  return *value ? "true" : "false";
}

std::string canonical_layer_property_value(const LayerPropertyValue& value) {
  if (std::holds_alternative<std::monostate>(value)) return "null";
  if (const auto* scalar = std::get_if<LayerPropertyScalarValue>(&value)) {
    if (!valid_decimal_string(scalar->value)) invalid_argument("invalid scalar property value");
    return "{\"kind\":\"scalar\",\"value\":" + json_string(scalar->value) + "}";
  }
  if (const auto* vector = std::get_if<LayerPropertyVectorValue>(&value)) {
    if (vector->components.size() != 2 && vector->components.size() != 3) {
      invalid_argument("invalid vector property arity");
    }
    std::string components = "[";
    for (std::size_t index = 0; index < vector->components.size(); ++index) {
      if (!valid_decimal_string(vector->components[index])) {
        invalid_argument("invalid vector property value");
      }
      if (index != 0) components.push_back(',');
      components += json_string(vector->components[index]);
    }
    components.push_back(']');
    return "{\"components\":" + components + ",\"kind\":\"vector\"}";
  }
  const auto& color = std::get<LayerPropertyColorValue>(value);
  if (!valid_decimal_string(color.alpha) || !valid_decimal_string(color.red)
      || !valid_decimal_string(color.green) || !valid_decimal_string(color.blue)) {
    invalid_argument("invalid color property value");
  }
  return "{\"alpha\":" + json_string(color.alpha) + ",\"blue\":"
      + json_string(color.blue) + ",\"green\":" + json_string(color.green)
      + ",\"kind\":\"color\",\"red\":" + json_string(color.red) + "}";
}

std::string canonical_layer_property_changed_value(
    const LayerPropertyChanged& value) {
  if (!value.changed || !valid_output_locator(value.layer_locator)
      || value.layer_locator.kind != "layer"
      || !valid_output_locator(value.property_locator)
      || value.property_locator.kind != "stream"
      || !same_locator_scope(value.property_locator, value.layer_locator)
      || value.before_value == value.after_value) {
    invalid_argument("invalid layer property write result");
  }
  const auto type_matches = [&](const LayerPropertyValue& candidate) {
    if (value.value_type == "one-d") {
      return std::holds_alternative<LayerPropertyScalarValue>(candidate);
    }
    if (value.value_type == "color") {
      return std::holds_alternative<LayerPropertyColorValue>(candidate);
    }
    const auto* vector = std::get_if<LayerPropertyVectorValue>(&candidate);
    if (vector == nullptr) return false;
    if (value.value_type == "two-d" || value.value_type == "two-d-spatial") {
      return vector->components.size() == 2;
    }
    if (value.value_type == "three-d" || value.value_type == "three-d-spatial") {
      return vector->components.size() == 3;
    }
    return false;
  };
  if (!type_matches(value.before_value) || !type_matches(value.after_value)) {
    invalid_argument("layer property value type mismatch");
  }
  return "{\"afterValue\":" + canonical_layer_property_value(value.after_value)
      + ",\"beforeValue\":" + canonical_layer_property_value(value.before_value)
      + ",\"changed\":true,\"layerLocator\":" + locator_json(value.layer_locator)
      + ",\"propertyLocator\":" + locator_json(value.property_locator)
      + ",\"valueType\":" + json_string(value.value_type) + "}";
}

std::string canonical_layer_properties_value(const LayerPropertiesPage& page) {
  if (!valid_output_locator(page.layer_locator) || page.layer_locator.kind != "layer"
      || (page.parent_property_locator.has_value()
          && (!valid_output_locator(*page.parent_property_locator)
              || page.parent_property_locator->kind != "stream"
              || !same_locator_scope(*page.parent_property_locator, page.layer_locator)))
      || validate_utf8_and_count(page.layer_name) > 1'024
      || page.sample_time.value < -static_cast<std::int64_t>(kMaxSafeInteger)
      || page.sample_time.value > static_cast<std::int64_t>(kMaxSafeInteger)
      || page.sample_time.scale < 1 || page.sample_time.scale > kMaxSafeInteger
      || page.total > kMaxSafeInteger || page.offset > kMaxSafeInteger
      || page.limit < 1 || page.limit > 25 || page.properties.size() > page.limit) {
    invalid_argument("invalid layer properties page");
  }
  const std::uint64_t returned = page.properties.size();
  if (page.offset > page.total || returned > page.total - page.offset) {
    invalid_argument("layer properties page exceeds the reported total");
  }
  const bool expected_more = page.offset + returned < page.total;
  if ((expected_more && returned == 0) || page.has_more != expected_more
      || (expected_more
          ? (!page.next_offset.has_value()
              || *page.next_offset != page.offset + returned)
          : page.next_offset.has_value())) {
    invalid_argument("layer properties pagination invariant failed");
  }
  const auto known_value_type = [](std::string_view value) {
    constexpr std::array<std::string_view, 14> values = {
        "none", "one-d", "two-d", "two-d-spatial", "three-d", "three-d-spatial",
        "color", "arb", "marker", "layer-id", "mask-id", "mask", "text-document",
        "unknown"};
    return std::find(values.begin(), values.end(), value) != values.end();
  };
  std::string properties = "[";
  std::set<std::string> object_ids;
  for (std::size_t index = 0; index < page.properties.size(); ++index) {
    const LayerPropertyEntry& property = page.properties[index];
    if (index != 0) properties.push_back(',');
    const bool group = property.grouping_type == "named-group"
        || property.grouping_type == "indexed-group";
    const bool leaf = property.grouping_type == "leaf";
    if (!valid_output_locator(property.property_locator)
        || property.property_locator.kind != "stream"
        || !same_locator_scope(property.property_locator, page.layer_locator)
        || (page.parent_property_locator.has_value()
            && property.property_locator.object_id
                == page.parent_property_locator->object_id)
        || property.property_index != page.offset + index + 1
        || property.property_index > kMaxSafeInteger
        || validate_utf8_and_count(property.name) > 1'024
        || validate_utf8_and_count(property.match_name) > 40
        || (!leaf && !group) || !known_value_type(property.value_type)
        || !object_ids.insert(property.property_locator.object_id).second) {
      invalid_argument("invalid layer property result");
    }
    const bool null_value = std::holds_alternative<std::monostate>(property.value);
    if (group) {
      if (property.value_type != "none" || property.value_status != "group"
          || !null_value || property.can_vary_over_time.has_value()
          || property.time_varying.has_value()) {
        invalid_argument("invalid property group result");
      }
    } else {
      if (property.child_count != 0
          || (property.value_status != "sampled"
              && property.value_status != "no-data"
              && property.value_status != "unsupported")) {
        invalid_argument("invalid leaf property result");
      }
      if (property.value_status == "sampled") {
        if (!property.can_vary_over_time.has_value()
            || !property.time_varying.has_value()) {
          invalid_argument("sampled property must report time flags");
        }
        const bool scalar = property.value_type == "one-d"
            && std::holds_alternative<LayerPropertyScalarValue>(property.value);
        const auto* vector = std::get_if<LayerPropertyVectorValue>(&property.value);
        const bool vector_matches = vector != nullptr
            && (((property.value_type == "two-d" || property.value_type == "two-d-spatial")
                  && vector->components.size() == 2)
                || ((property.value_type == "three-d"
                    || property.value_type == "three-d-spatial")
                  && vector->components.size() == 3));
        const bool color = property.value_type == "color"
            && std::holds_alternative<LayerPropertyColorValue>(property.value);
        if (!scalar && !vector_matches && !color) {
          invalid_argument("sampled property type does not match its value");
        }
      } else if (property.value_status == "no-data") {
        if (property.value_type != "none" || !null_value) {
          invalid_argument("no-data property must have no typed value");
        }
      } else {
        const bool complex_type = property.value_type == "arb"
            || property.value_type == "marker"
            || property.value_type == "layer-id"
            || property.value_type == "mask-id"
            || property.value_type == "mask"
            || property.value_type == "text-document"
            || property.value_type == "unknown";
        if (!complex_type || !null_value) {
          invalid_argument("unsupported property must have a complex value type");
        }
      }
    }
    properties += "{\"canVaryOverTime\":"
        + nullable_bool_json(property.can_vary_over_time)
        + ",\"childCount\":" + std::to_string(property.child_count)
        + ",\"disabled\":" + (property.disabled ? "true" : "false")
        + ",\"groupingType\":" + json_string(property.grouping_type)
        + ",\"hidden\":" + (property.hidden ? "true" : "false")
        + ",\"matchName\":" + json_string(property.match_name)
        + ",\"modified\":" + (property.modified ? "true" : "false")
        + ",\"name\":" + json_string(property.name)
        + ",\"propertyIndex\":" + std::to_string(property.property_index)
        + ",\"propertyLocator\":" + locator_json(property.property_locator)
        + ",\"timeVarying\":" + nullable_bool_json(property.time_varying)
        + ",\"value\":" + canonical_layer_property_value(property.value)
        + ",\"valueStatus\":" + json_string(property.value_status)
        + ",\"valueType\":" + json_string(property.value_type) + "}";
  }
  properties.push_back(']');
  return "{\"hasMore\":" + std::string(page.has_more ? "true" : "false")
      + ",\"layerLocator\":" + locator_json(page.layer_locator)
      + ",\"layerName\":" + json_string(page.layer_name)
      + ",\"limit\":" + std::to_string(page.limit)
      + ",\"nextOffset\":"
      + (page.next_offset.has_value() ? std::to_string(*page.next_offset) : "null")
      + ",\"offset\":" + std::to_string(page.offset)
      + ",\"parentPropertyLocator\":"
      + nullable_locator_json(page.parent_property_locator)
      + ",\"properties\":" + properties
      + ",\"returned\":" + std::to_string(returned)
      + ",\"sampleTime\":{\"mode\":\"comp-time\",\"scale\":"
      + std::to_string(page.sample_time.scale) + ",\"value\":"
      + std::to_string(page.sample_time.value) + "},\"total\":"
      + std::to_string(page.total) + "}";
}

std::uint32_t read_be32(Bytes bytes) {
  return (static_cast<std::uint32_t>(bytes[0]) << 24U)
      | (static_cast<std::uint32_t>(bytes[1]) << 16U)
      | (static_cast<std::uint32_t>(bytes[2]) << 8U)
      | static_cast<std::uint32_t>(bytes[3]);
}

}  // namespace

CodecError::CodecError(CodecErrorKind kind, std::string message)
    : std::runtime_error(std::move(message)), kind_(kind) {}

std::string_view CodecError::error_code() const noexcept {
  switch (kind_) {
    case CodecErrorKind::kInvalidRequest: return "INVALID_REQUEST";
    case CodecErrorKind::kInvalidArgument: return "INVALID_ARGUMENT";
    case CodecErrorKind::kSessionStale: return "SESSION_STALE";
  }
  return "INVALID_REQUEST";
}

ParsedRequest decode_request_frame(std::span<const std::uint8_t> frame) {
  if (frame.size() < kFramePrefixBytes) invalid_request("incomplete frame prefix");
  const std::uint32_t size = read_be32(frame.first<4>());
  if (size == 0 || size > kMaxFrameBytes) invalid_request("frame size rejected");
  if (frame.size() != static_cast<std::size_t>(size) + kFramePrefixBytes) {
    invalid_request("incomplete or trailing frame bytes");
  }
  const char* body = reinterpret_cast<const char*>(frame.data() + kFramePrefixBytes);
  return classify_request(JsonParser(std::string_view(body, size)).parse());
}

std::string digest_capabilities_query(
    std::string_view session_id,
    const CapabilitiesParams& params) {
  if (!valid_uuid(session_id) || params.limit < 1 || params.limit > 100) {
    invalid_argument("invalid capabilities query digest input");
  }
  std::string ids = "null";
  if (params.ids.has_value()) {
    if (params.ids->empty() || params.ids->size() > 32) {
      invalid_argument("invalid capabilities IDs for query digest");
    }
    ids = "[";
    for (std::size_t index = 0; index < params.ids->size(); ++index) {
      if (!valid_capability_id((*params.ids)[index])) {
        invalid_argument("invalid capability ID for query digest");
      }
      if (index != 0) ids.push_back(',');
      ids += json_string((*params.ids)[index]);
    }
    ids.push_back(']');
  }
  const std::string canonical = "{\"detail\":"
      + json_string(params.detail == CapabilityDetail::kFull ? "full" : "summary")
      + ",\"ids\":" + ids + ",\"limit\":" + std::to_string(params.limit)
      + ",\"sessionId\":" + json_string(session_id) + "}";
  return sha256_hex(canonical);
}

std::string digest_project_summary_postcondition(
    bool project_open,
    std::string_view project_name,
    std::uint64_t item_count) {
  if (item_count > kMaxSafeInteger) invalid_argument("project item count exceeds safe integer");
  if (validate_utf8_and_count(project_name) > 1'024) {
    invalid_argument("project name exceeds result contract");
  }
  const std::string canonical = "{\"capabilityId\":\"ae.project.summary\","
      "\"capabilityVersion\":1,\"value\":{\"itemCount\":" + std::to_string(item_count)
      + ",\"projectName\":" + json_string(project_name)
      + ",\"projectOpen\":" + (project_open ? "true" : "false") + "}}";
  return sha256_hex(canonical);
}

std::string digest_project_bit_depth_read_postcondition(
    std::int32_t bits_per_channel) {
  if (!valid_bit_depth(bits_per_channel)) {
    invalid_argument("invalid project bit-depth read result");
  }
  return sha256_hex(
      "{\"capabilityId\":\"ae.project.bit-depth.read\",\"capabilityVersion\":1,"
      "\"value\":{\"bitsPerChannel\":" + std::to_string(bits_per_channel) + "}}");
}

std::string digest_project_bit_depth_set_arguments(
    std::int32_t target_depth,
    std::string_view idempotency_key) {
  if (!valid_bit_depth(target_depth) || !valid_idempotency_key(idempotency_key)) {
    invalid_argument("invalid project bit-depth arguments digest input");
  }
  return sha256_hex("{\"idempotencyKey\":" + json_string(idempotency_key)
      + ",\"targetDepth\":" + std::to_string(target_depth) + "}");
}

std::string digest_project_bit_depth_set_postcondition(
    bool changed,
    std::int32_t before_bits_per_channel,
    std::int32_t after_bits_per_channel) {
  if (!changed || !valid_bit_depth(before_bits_per_channel)
      || !valid_bit_depth(after_bits_per_channel)
      || before_bits_per_channel == after_bits_per_channel) {
    invalid_argument("project bit-depth result violates its postcondition contract");
  }
  const std::string canonical =
      "{\"capabilityId\":\"ae.project.bit-depth.set\",\"capabilityVersion\":1,"
      "\"value\":{\"afterBitsPerChannel\":"
      + std::to_string(after_bits_per_channel) + ",\"beforeBitsPerChannel\":"
      + std::to_string(before_bits_per_channel) + ",\"changed\":true}}";
  return sha256_hex(canonical);
}

std::string digest_project_items_postcondition(const ProjectItemsPage& page) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.project.items.list\",\"capabilityVersion\":1,\"value\":"
      + canonical_project_items_value(page) + "}");
}

std::string digest_composition_layers_postcondition(
    const CompositionLayersPage& page) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.composition.layers.list\",\"capabilityVersion\":1,\"value\":"
      + canonical_composition_layers_value(page) + "}");
}

std::string digest_composition_selected_layers_postcondition(
    const CompositionLayersPage& page) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.composition.selected-layers.list\","
      "\"capabilityVersion\":1,\"value\":"
      + canonical_composition_selected_layers_value(page) + "}");
}

std::string digest_composition_time_postcondition(
    const CompositionTimeRead& value) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.composition.time.read\",\"capabilityVersion\":1,\"value\":"
      + canonical_composition_time_value(value) + "}");
}

std::string digest_composition_time_set_arguments(
    const ObjectLocator& composition_locator,
    const CompositionCurrentTime& target_time,
    std::string_view idempotency_key) {
  if (!valid_idempotency_key(idempotency_key)
      || composition_locator.kind != "composition"
      || !valid_output_locator(composition_locator)) {
    invalid_argument("invalid composition time write arguments digest input");
  }
  (void)canonical_current_time(target_time);
  return sha256_hex("{\"compositionLocator\":" + locator_json(composition_locator)
      + ",\"idempotencyKey\":" + json_string(idempotency_key)
      + ",\"targetTime\":{\"scale\":" + std::to_string(target_time.scale)
      + ",\"value\":" + std::to_string(target_time.value) + "}}");
}

std::string digest_composition_time_set_postcondition(
    const CompositionTimeChanged& value) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.composition.time.set\",\"capabilityVersion\":1,\"value\":"
      + canonical_composition_time_set_value(value) + "}");
}

std::string digest_composition_layer_create_arguments(
    const ObjectLocator& composition_locator,
    std::string_view kind,
    std::string_view name,
    const std::optional<CompositionLayerCreateColor>& color,
    const std::optional<std::uint32_t>& width,
    const std::optional<std::uint32_t>& height,
    const std::optional<CompositionCurrentTime>& duration,
    std::string_view idempotency_key) {
  return sha256_hex(canonical_composition_layer_create_arguments(
      composition_locator,
      kind,
      name,
      color,
      width,
      height,
      duration,
      idempotency_key));
}

std::string digest_composition_layer_create_postcondition(
    const CompositionLayerCreated& value) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.composition.layer.create\","
      "\"capabilityVersion\":1,\"value\":"
      + canonical_composition_layer_create_value(value) + "}");
}

std::string digest_layer_properties_postcondition(
    const LayerPropertiesPage& page) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.layer.properties.list\",\"capabilityVersion\":1,\"value\":"
      + canonical_layer_properties_value(page) + "}");
}

std::string digest_layer_property_set_arguments(
    const ObjectLocator& layer_locator,
    const ObjectLocator& property_locator,
    const LayerPropertyValue& value,
    std::string_view idempotency_key) {
  if (!valid_idempotency_key(idempotency_key)
      || layer_locator.kind != "layer" || property_locator.kind != "stream"
      || !same_locator_scope(property_locator, layer_locator)
      || std::holds_alternative<std::monostate>(value)) {
    invalid_argument("invalid layer property write arguments digest input");
  }
  return sha256_hex("{\"idempotencyKey\":" + json_string(idempotency_key)
      + ",\"layerLocator\":" + locator_json(layer_locator)
      + ",\"propertyLocator\":" + locator_json(property_locator)
      + ",\"value\":" + canonical_layer_property_value(value) + "}");
}

std::string digest_layer_property_set_postcondition(
    const LayerPropertyChanged& value) {
  return sha256_hex(
      "{\"capabilityId\":\"ae.layer.property.set\",\"capabilityVersion\":1,\"value\":"
      + canonical_layer_property_changed_value(value) + "}");
}

std::vector<ParsedRequest> FrameDecoder::push(std::span<const std::uint8_t> chunk) {
  if (failed_) invalid_request("frame decoder is poisoned");
  if (chunk.size() > kMaxFrameBytes + kFramePrefixBytes) {
    failed_ = true;
    invalid_request("transport chunk exceeds bounded decoder input");
  }
  try {
    pending_.insert(pending_.end(), chunk.begin(), chunk.end());
    std::vector<ParsedRequest> result;
    while (pending_.size() >= kFramePrefixBytes) {
      const std::uint32_t size = read_be32(Bytes(pending_.data(), 4));
      if (size == 0 || size > kMaxFrameBytes) invalid_request("frame size rejected");
      const std::size_t total = static_cast<std::size_t>(size) + kFramePrefixBytes;
      if (pending_.size() < total) break;
      result.push_back(decode_request_frame(Bytes(pending_.data(), total)));
      pending_.erase(pending_.begin(), pending_.begin() + static_cast<std::ptrdiff_t>(total));
    }
    return result;
  } catch (...) {
    failed_ = true;
    pending_.clear();
    throw;
  }
}

void FrameDecoder::finalize() {
  if (failed_) invalid_request("frame decoder is poisoned");
  if (!pending_.empty()) {
    failed_ = true;
    pending_.clear();
    invalid_request("incomplete frame at end of stream");
  }
}

std::uint64_t SystemSessionClock::now_unix_ms() const noexcept {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

RpcSessionFrontDoor::RpcSessionFrontDoor(
    std::string connection_id, std::string host_instance_id, std::string session_id,
    SessionClock& clock, SessionFrontDoorConfig config)
    : connection_id_(std::move(connection_id)),
      host_instance_id_(std::move(host_instance_id)),
      session_id_(std::move(session_id)),
      clock_(clock),
      config_(config) {
  if (connection_id_.empty() || connection_id_.size() > 1'024
      || output_scalar_count(connection_id_) > 256 || !valid_uuid(host_instance_id_)
      || !valid_uuid(session_id_) || config_.max_active_requests == 0
      || config_.max_active_requests > 64 || config_.max_terminal_tombstones == 0
      || config_.max_terminal_tombstones > 4'096 || config_.tombstone_ttl_ms < 1'000
      || config_.tombstone_ttl_ms > 300'000 || config_.default_deadline_ms == 0
      || config_.maximum_deadline_ms < 100 || config_.maximum_deadline_ms > 30'000
      || config_.default_deadline_ms > config_.maximum_deadline_ms) {
    throw std::invalid_argument("invalid RPC session front-door configuration");
  }
}

bool RpcSessionFrontDoor::authorize_pairing() noexcept {
  if (closed_) return false;
  paired_ = true;
  return true;
}

void RpcSessionFrontDoor::revoke_pairing() noexcept {
  paired_ = false;
  hello_complete_ = false;
  active_.clear();
  tombstones_.clear();
}

SessionIngressResult RpcSessionFrontDoor::admit(const ParsedRequest& request) {
  if (closed_) return {SessionIngressCode::kClosed, "SESSION_STALE", std::nullopt, false};
  if (!valid_request_id(request.request_id)
      || !valid_sha256(request.request_fingerprint_sha256)) {
    return {SessionIngressCode::kInvalidRequest, "INVALID_REQUEST", std::nullopt, false};
  }
  const bool params_match = (request.method == RpcMethod::kHello
        && std::holds_alternative<HelloParams>(request.params))
      || (request.method == RpcMethod::kCapabilities
        && std::holds_alternative<CapabilitiesParams>(request.params))
      || (request.method == RpcMethod::kInvoke
        && std::holds_alternative<InvokeParams>(request.params))
      || (request.method == RpcMethod::kCancel
        && std::holds_alternative<CancelParams>(request.params))
      || (request.method == RpcMethod::kInvalidateGraph
        && std::holds_alternative<InvalidateGraphParams>(request.params));
  if (!params_match) {
    return {SessionIngressCode::kInvalidRequest, "INVALID_REQUEST", std::nullopt, false};
  }
  if (request.method == RpcMethod::kHello) {
    const auto* hello = std::get_if<HelloParams>(&request.params);
    if (hello == nullptr || request.session_id.has_value()) {
      return {SessionIngressCode::kInvalidRequest, "INVALID_REQUEST", std::nullopt, false};
    }
    if (!paired_) {
      return {SessionIngressCode::kPairingRequired, "AUTH_REQUIRED", std::nullopt, false};
    }
    if (hello_complete_) {
      return {SessionIngressCode::kSessionStale, "SESSION_STALE", std::nullopt, false};
    }
    if (hello->minimum_wire_version > 1 || hello->maximum_wire_version < 1) {
      return {SessionIngressCode::kWireVersionMismatch, "WIRE_VERSION_MISMATCH", std::nullopt, false};
    }
    hello_complete_ = true;
    return {SessionIngressCode::kAcceptedHello, {}, std::nullopt, false};
  }
  if (!paired_) {
    return {SessionIngressCode::kAuthorizationRequired, "AUTH_REQUIRED", std::nullopt, false};
  }
  if (!hello_complete_) {
    return {SessionIngressCode::kHelloRequired, "SESSION_STALE", std::nullopt, false};
  }
  if (!request.session_id.has_value() || *request.session_id != session_id_) {
    return {SessionIngressCode::kSessionStale, "SESSION_STALE", std::nullopt, false};
  }
  const std::uint64_t now = clock_.now_unix_ms();
  cleanup(now);
  std::uint64_t deadline = 0;
  if (request.deadline_unix_ms.has_value()) {
    deadline = *request.deadline_unix_ms;
  } else if (now > kMaxSafeInteger - config_.default_deadline_ms) {
    return {SessionIngressCode::kInvalidDeadline, "INVALID_ARGUMENT", std::nullopt, false};
  } else {
    deadline = now + config_.default_deadline_ms;
  }
  if (deadline <= now) {
    return {SessionIngressCode::kDeadlineExceeded, "DEADLINE_EXCEEDED", std::nullopt, false};
  }
  if (now > kMaxSafeInteger - config_.maximum_deadline_ms
      || deadline > now + config_.maximum_deadline_ms) {
    return {SessionIngressCode::kInvalidDeadline, "INVALID_ARGUMENT", std::nullopt, false};
  }
  if (const auto found = active_.find(request.request_id); found != active_.end()) {
    return {SessionIngressCode::kDuplicateRequest, "DUPLICATE_REQUEST", std::nullopt,
      found->second.fingerprint == request.request_fingerprint_sha256};
  }
  const auto terminal = std::find_if(tombstones_.begin(), tombstones_.end(), [&](const Tombstone& item) {
    return item.request_id == request.request_id;
  });
  if (terminal != tombstones_.end()) {
    return {SessionIngressCode::kDuplicateRequest, "DUPLICATE_REQUEST", std::nullopt,
      terminal->fingerprint == request.request_fingerprint_sha256};
  }
  if (active_.size() >= config_.max_active_requests) {
    return {SessionIngressCode::kLedgerFull, "QUEUE_FULL", std::nullopt, false};
  }
  active_.emplace(request.request_id, ActiveEntry{request.request_fingerprint_sha256, deadline});
  return {SessionIngressCode::kAcceptedRequest, {}, deadline};
}

bool RpcSessionFrontDoor::complete_request(std::string_view request_id) {
  const auto found = active_.find(std::string(request_id));
  if (found == active_.end()) return false;
  std::string id = found->first;
  std::string fingerprint = found->second.fingerprint;
  active_.erase(found);
  add_tombstone(std::move(id), std::move(fingerprint), clock_.now_unix_ms());
  return true;
}

void RpcSessionFrontDoor::close() noexcept {
  closed_ = true;
  paired_ = false;
  hello_complete_ = false;
  active_.clear();
  tombstones_.clear();
}

void RpcSessionFrontDoor::cleanup(std::uint64_t now) {
  while (!tombstones_.empty() && tombstones_.front().expires_at_unix_ms <= now) {
    tombstones_.pop_front();
  }
  std::vector<std::pair<std::string, std::string>> expired;
  for (const auto& [id, entry] : active_) {
    if (entry.effective_deadline_unix_ms <= now) expired.emplace_back(id, entry.fingerprint);
  }
  for (auto& [id, fingerprint] : expired) {
    active_.erase(id);
    add_tombstone(std::move(id), std::move(fingerprint), now);
  }
}

void RpcSessionFrontDoor::add_tombstone(
    std::string request_id, std::string fingerprint, std::uint64_t now) {
  while (tombstones_.size() >= config_.max_terminal_tombstones) tombstones_.pop_front();
  const std::uint64_t expiry = now > kMaxSafeInteger - config_.tombstone_ttl_ms
      ? kMaxSafeInteger : now + config_.tombstone_ttl_ms;
  tombstones_.push_back({std::move(request_id), std::move(fingerprint), expiry});
}

namespace {

void require_output_string(
    std::string_view value, std::size_t minimum, std::size_t maximum,
    std::string_view field) {
  const std::size_t count = output_scalar_count(value);
  if (count < minimum || count > maximum) {
    invalid_argument(std::string(field) + " violates its output string bound");
  }
}

void require_request_id(std::string_view value) {
  if (!valid_request_id(value)) invalid_argument("invalid output request ID");
}

void require_uuid(std::string_view value, std::string_view field) {
  if (!valid_uuid(value)) invalid_argument(std::string("invalid output ") + std::string(field));
}

void require_digest(std::string_view value, std::string_view field) {
  if (!valid_sha256(value)) invalid_argument(std::string("invalid output ") + std::string(field));
}

bool valid_numeric_version(std::string_view value) {
  std::size_t parts = 0;
  std::size_t start = 0;
  while (start < value.size()) {
    std::size_t end = value.find('.', start);
    if (end == std::string_view::npos) end = value.size();
    if (end == start || !std::all_of(value.begin() + static_cast<std::ptrdiff_t>(start),
        value.begin() + static_cast<std::ptrdiff_t>(end), [](char character) {
          return character >= '0' && character <= '9';
        })) return false;
    ++parts;
    if (end == value.size()) break;
    start = end + 1;
  }
  return parts == 2 || parts == 3;
}

std::vector<std::uint8_t> frame_output(std::string json) {
  if (json.empty() || json.size() > kMaxFrameBytes) invalid_argument("output frame size rejected");
  (void)JsonParser(json).parse();
  std::vector<std::uint8_t> frame(json.size() + 4);
  const auto size = static_cast<std::uint32_t>(json.size());
  frame[0] = static_cast<std::uint8_t>(size >> 24U);
  frame[1] = static_cast<std::uint8_t>(size >> 16U);
  frame[2] = static_cast<std::uint8_t>(size >> 8U);
  frame[3] = static_cast<std::uint8_t>(size);
  std::memcpy(frame.data() + 4, json.data(), json.size());
  return frame;
}

std::string progress_phase_name(ProgressPhase phase) {
  switch (phase) {
    case ProgressPhase::kQueued: return "queued";
    case ProgressPhase::kDispatched: return "dispatched";
    case ProgressPhase::kRunning: return "running";
    case ProgressPhase::kValidating: return "validating";
  }
  invalid_argument("unknown progress phase");
}

std::string double_json(double value) {
  if (!std::isfinite(value)) invalid_argument("non-finite output number");
  std::ostringstream stream;
  stream.imbue(std::locale::classic());
  stream << std::setprecision(std::numeric_limits<double>::max_digits10) << value;
  if (!stream) invalid_argument("could not encode output number");
  return stream.str();
}

void validate_limits(const NegotiatedLimits& limits) {
  if (limits.max_frame_bytes < 4'096 || limits.max_frame_bytes > kMaxFrameBytes
      || limits.max_in_flight < 1 || limits.max_in_flight > 64
      || limits.max_queue_depth < 1 || limits.max_queue_depth > 256
      || limits.max_deadline_ms < 100 || limits.max_deadline_ms > 30'000
      || limits.max_requests_per_second < 1 || limits.max_requests_per_second > 100
      || limits.max_burst < 1 || limits.max_burst > 100
      || limits.max_control_in_flight < 1 || limits.max_control_in_flight > 8
      || limits.max_control_requests_per_second < 1
      || limits.max_control_requests_per_second > 100
      || limits.max_control_burst < 1 || limits.max_control_burst > 100
      || limits.max_terminal_cache_entries < 1 || limits.max_terminal_cache_entries > 4'096
      || limits.terminal_cache_ttl_ms < 1'000 || limits.terminal_cache_ttl_ms > 300'000) {
    invalid_argument("negotiated limits are outside the v1 contract");
  }
}

std::string project_summary_descriptor(const CapabilitiesSuccess& response) {
  const std::string detail = response.detail == CapabilityDetail::kFull ? "full" : "summary";
  std::string descriptor = "{\"cancellation\":\"before-dispatch\","
      "\"compatibility\":{\"intendedPlatforms\":[\"macos-arm64\",\"windows-x64\"],"
      "\"status\":\"unverified\"},\"detail\":" + json_string(detail)
      + ",\"id\":\"ae.project.summary\",\"idempotency\":\"idempotent\","
        "\"mutability\":\"read-only\",\"preconditions\":[],\"risk\":\"read\","
        "\"schemaVersion\":1,\"sideEffectSummary\":"
      + json_string("Reads project state without modifying it.")
      + ",\"summary\":"
      + json_string("Read bounded facts about the active After Effects project.")
      + ",\"undo\":\"not-applicable\",\"version\":1";
  if (response.detail == CapabilityDetail::kFull) {
    require_digest(response.project_summary_contract_digest, "contract digest");
    descriptor += ",\"contractDigest\":" + json_string(response.project_summary_contract_digest)
        + ",\"examples\":[{\"arguments\":{},\"expected\":{\"outcome\":\"succeeded\","
          "\"value\":{\"itemCount\":0,\"projectName\":\"SYNTHETIC_EXAMPLE\","
          "\"projectOpen\":false}},\"id\":\"aemcp-example-project-summary-empty\","
          "\"kind\":\"positive\",\"summary\":"
        + json_string("Read a bounded summary when no project content exists.")
        + "},{\"arguments\":{},\"expected\":{\"errorCode\":\"NATIVE_UNAVAILABLE\","
          "\"recoveryAction\":\"reconnect\"},"
          "\"id\":\"aemcp-example-project-summary-unavailable\",\"kind\":\"negative\","
          "\"summary\":"
        + json_string("Return a typed unavailable error before native dispatch.")
        + "}],\"inputContractId\":\"aemcp.contract.ae.project.summary.input.v1\","
          "\"inputSchema\":{\"additionalProperties\":false,\"properties\":{},"
          "\"required\":[],\"type\":\"object\"},\"requirements\":[{"
          "\"contractVersion\":1,\"id\":\"aemcp.requirement.native.project-read\"}],"
          "\"resultContractId\":\"aemcp.contract.ae.project.summary.result.v1\","
          "\"resultSchema\":{\"additionalProperties\":false,\"properties\":{"
          "\"itemCount\":{\"maximum\":9007199254740991,\"minimum\":0,"
          "\"type\":\"integer\"},\"projectName\":{\"maxLength\":1024,"
          "\"type\":\"string\"},\"projectOpen\":{\"type\":\"boolean\"}},"
          "\"required\":[\"projectOpen\",\"projectName\",\"itemCount\"],"
          "\"type\":\"object\"}";
  }
  descriptor.push_back('}');
  return descriptor;
}

std::string project_bit_depth_read_descriptor(const CapabilitiesSuccess& response) {
  const std::string detail = response.detail == CapabilityDetail::kFull ? "full" : "summary";
  std::string descriptor = "{\"cancellation\":\"before-dispatch\","
      "\"compatibility\":{\"intendedPlatforms\":[\"macos-arm64\",\"windows-x64\"],"
      "\"status\":\"unverified\"},\"detail\":" + json_string(detail)
      + ",\"id\":\"ae.project.bit-depth.read\",\"idempotency\":\"idempotent\","
        "\"mutability\":\"read-only\",\"preconditions\":["
      + json_string("An After Effects project must be open.")
      + "],\"risk\":\"read\",\"schemaVersion\":1,\"sideEffectSummary\":"
      + json_string("Reads project bit depth without changing After Effects state.")
      + ",\"summary\":"
      + json_string("Read the open After Effects project's bit depth.")
      + ",\"undo\":\"not-applicable\",\"version\":1";
  if (response.detail == CapabilityDetail::kFull) {
    require_digest(response.project_bit_depth_read_contract_digest, "contract digest");
    descriptor += ",\"contractDigest\":"
        + json_string(response.project_bit_depth_read_contract_digest)
        + ",\"examples\":[{\"arguments\":{},\"expected\":{\"outcome\":\"succeeded\","
          "\"value\":{\"bitsPerChannel\":16}},"
          "\"id\":\"aemcp-example-project-bit-depth-read\",\"kind\":\"positive\","
          "\"summary\":"
        + json_string("Read the project bits per channel.")
        + "},{\"arguments\":{},\"expected\":{\"errorCode\":\"PRECONDITION_FAILED\","
          "\"recoveryAction\":\"open-project\"},"
          "\"id\":\"aemcp-example-project-bit-depth-read-no-project\","
          "\"kind\":\"negative\","
          "\"summary\":"
        + json_string("Require an open project before reading bit depth.")
        + "}],\"inputContractId\":\"aemcp.contract.ae.project.bit-depth.read.input.v1\","
          "\"inputSchema\":{\"additionalProperties\":false,\"properties\":{},"
          "\"required\":[],\"type\":\"object\"},\"requirements\":[{"
          "\"contractVersion\":1,"
          "\"id\":\"aemcp.requirement.native.project-bit-depth-read\"}],"
          "\"resultContractId\":\"aemcp.contract.ae.project.bit-depth.read.result.v1\","
          "\"resultSchema\":{\"additionalProperties\":false,\"properties\":{"
          "\"bitsPerChannel\":{\"enum\":[8,16,32]}},"
          "\"required\":[\"bitsPerChannel\"],\"type\":\"object\"}";
  }
  descriptor.push_back('}');
  return descriptor;
}

std::string project_bit_depth_set_descriptor(const CapabilitiesSuccess& response) {
  const std::string detail = response.detail == CapabilityDetail::kFull ? "full" : "summary";
  std::string descriptor = "{\"cancellation\":\"before-dispatch\","
      "\"compatibility\":{\"intendedPlatforms\":[\"macos-arm64\",\"windows-x64\"],"
      "\"status\":\"unverified\"},\"detail\":" + json_string(detail)
      + ",\"id\":\"ae.project.bit-depth.set\",\"idempotency\":\"idempotency-key\","
        "\"mutability\":\"mutating\",\"preconditions\":["
      + json_string("An After Effects project must be open.") + ","
      + json_string("targetDepth must differ from the current project bit depth.")
      + "],\"risk\":\"write\",\"schemaVersion\":1,\"sideEffectSummary\":"
      + json_string("Changes project bit depth and creates one After Effects Undo step.")
      + ",\"summary\":"
      + json_string("Set the open After Effects project's bit depth.")
      + ",\"undo\":\"ae-undo-group\",\"version\":1";
  if (response.detail == CapabilityDetail::kFull) {
    require_digest(response.project_bit_depth_set_contract_digest, "contract digest");
    descriptor += ",\"contractDigest\":"
        + json_string(response.project_bit_depth_set_contract_digest)
        + ",\"examples\":[{\"arguments\":{\"idempotencyKey\":"
        + json_string("synthetic-bit-depth-0001") + ",\"targetDepth\":16},"
          "\"expected\":{\"outcome\":\"succeeded\",\"value\":{"
          "\"afterBitsPerChannel\":16,\"beforeBitsPerChannel\":8,\"changed\":true}},"
          "\"id\":\"aemcp-example-project-bit-depth-set\",\"kind\":\"positive\","
          "\"summary\":"
        + json_string("Change the project from 8 to 16 bits per channel.")
        + "},{\"arguments\":{\"idempotencyKey\":"
        + json_string("synthetic-bit-depth-0002") + ",\"targetDepth\":16},"
          "\"expected\":{\"errorCode\":\"INVALID_ARGUMENT\","
          "\"recoveryAction\":\"change-arguments\"},"
          "\"id\":\"aemcp-example-project-bit-depth-no-change\","
          "\"kind\":\"negative\",\"summary\":"
        + json_string("Reject a target that already matches the project bit depth.")
        + "}],\"inputContractId\":\"aemcp.contract.ae.project.bit-depth.set.input.v1\","
          "\"inputSchema\":{\"additionalProperties\":false,\"properties\":{"
          "\"idempotencyKey\":{\"maxLength\":64,\"minLength\":16,"
          "\"pattern\":\"^[A-Za-z0-9][A-Za-z0-9._:-]*$\",\"type\":\"string\"},"
          "\"targetDepth\":{\"enum\":[8,16,32]}},"
          "\"required\":[\"targetDepth\",\"idempotencyKey\"],\"type\":\"object\"},"
          "\"requirements\":[{\"contractVersion\":1,"
          "\"id\":\"aemcp.requirement.native.project-bit-depth-set\"}],"
          "\"resultContractId\":\"aemcp.contract.ae.project.bit-depth.set.result.v1\","
          "\"resultSchema\":{\"additionalProperties\":false,\"properties\":{"
          "\"afterBitsPerChannel\":{\"enum\":[8,16,32]},"
          "\"beforeBitsPerChannel\":{\"enum\":[8,16,32]},"
          "\"changed\":{\"const\":true}},"
          "\"required\":[\"changed\",\"beforeBitsPerChannel\","
          "\"afterBitsPerChannel\"],\"type\":\"object\","
          "\"x-invariant\":"
          "\"beforeBitsPerChannel-must-differ-from-afterBitsPerChannel\"}";
  }
  descriptor.push_back('}');
  return descriptor;
}

std::string project_items_list_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"detail":"summary","id":"ae.project.items.list","version":1,"schemaVersion":1,"summary":"List a bounded page of items in the open After Effects project.","risk":"read","mutability":"read-only","idempotency":"idempotent","cancellation":"before-dispatch","undo":"not-applicable","sideEffectSummary":"Reads project items without changing After Effects state.","preconditions":["An After Effects project must be open."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]}})aemcp";
  }
  require_digest(response.project_items_list_contract_digest, "contract digest");
  if (response.project_items_list_contract_digest
      != "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e") {
    invalid_argument("project items contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"detail":"full","id":"ae.project.items.list","version":1,"schemaVersion":1,"summary":"List a bounded page of items in the open After Effects project.","risk":"read","mutability":"read-only","idempotency":"idempotent","cancellation":"before-dispatch","undo":"not-applicable","sideEffectSummary":"Reads project items without changing After Effects state.","preconditions":["An After Effects project must be open."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]},"inputContractId":"aemcp.contract.ae.project.items.list.input.v1","resultContractId":"aemcp.contract.ae.project.items.list.result.v1","contractDigest":"64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e","inputSchema":{"type":"object","additionalProperties":false,"required":["offset","limit"],"properties":{"projectLocator":{"$ref":"#/$defs/projectLocator"},"offset":{"type":"integer","minimum":0,"maximum":9007199254740991,"default":0,"x-omissionBehavior":0},"limit":{"type":"integer","minimum":1,"maximum":50,"default":25,"x-omissionBehavior":25}},"allOf":[{"if":{"properties":{"offset":{"minimum":1}}},"then":{"required":["projectLocator"]}}],"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"projectLocator":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"const":"project"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}}},"x-invariant":"offset-greater-than-zero-requires-the-project-locator-from-the-previous-page"},"resultSchema":{"type":"object","additionalProperties":false,"required":["projectLocator","total","offset","limit","returned","hasMore","nextOffset","items"],"properties":{"projectLocator":{"$ref":"#/$defs/projectLocator"},"total":{"type":"integer","minimum":0,"maximum":9007199254740991},"offset":{"type":"integer","minimum":0,"maximum":9007199254740991},"limit":{"type":"integer","minimum":1,"maximum":50},"returned":{"type":"integer","minimum":0,"maximum":50},"hasMore":{"type":"boolean"},"nextOffset":{"oneOf":[{"type":"null"},{"type":"integer","minimum":0,"maximum":9007199254740991}]},"items":{"type":"array","maxItems":50,"items":{"type":"object","additionalProperties":false,"required":["locator","name","type","parentLocator"],"properties":{"locator":{"$ref":"#/$defs/projectItemLocator"},"name":{"type":"string","maxLength":1024},"type":{"enum":["folder","composition","footage","unknown"]},"parentLocator":{"$ref":"#/$defs/projectParentLocator"}}}}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"locatorBase":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"enum":["project","item","composition","layer","stream"]},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}},"projectLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"project"}}}]},"projectItemLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"enum":["item","composition"]}}}]},"projectParentLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"enum":["project","item"]}}}]}},"x-invariant":"returned-equals-items-length-and-page-metadata-is-self-consistent"},"requirements":[{"id":"aemcp.requirement.native.project-items-list","contractVersion":1}],"examples":[{"id":"aemcp-example-project-items-list-empty","kind":"positive","summary":"List the first bounded page of an empty project.","arguments":{"offset":0,"limit":25},"expected":{"outcome":"succeeded","value":{"projectLocator":{"kind":"project","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"77777777-7777-4777-8777-777777777777"},"total":0,"offset":0,"limit":25,"returned":0,"hasMore":false,"nextOffset":null,"items":[]}}},{"id":"aemcp-example-project-items-list-no-project","kind":"negative","summary":"Require an open project before listing items.","arguments":{"offset":0,"limit":25},"expected":{"errorCode":"PRECONDITION_FAILED","recoveryAction":"open-project"}}]})aemcp";
}

std::string composition_layers_list_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"detail":"summary","id":"ae.composition.layers.list","version":1,"schemaVersion":1,"summary":"List a bounded page of layers in one After Effects composition.","risk":"read","mutability":"read-only","idempotency":"idempotent","cancellation":"before-dispatch","undo":"not-applicable","sideEffectSummary":"Reads composition layers without changing After Effects state.","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]}})aemcp";
  }
  require_digest(response.composition_layers_list_contract_digest, "contract digest");
  if (response.composition_layers_list_contract_digest
      != "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75") {
    invalid_argument("composition layers contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"detail":"full","id":"ae.composition.layers.list","version":1,"schemaVersion":1,"summary":"List a bounded page of layers in one After Effects composition.","risk":"read","mutability":"read-only","idempotency":"idempotent","cancellation":"before-dispatch","undo":"not-applicable","sideEffectSummary":"Reads composition layers without changing After Effects state.","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]},"inputContractId":"aemcp.contract.ae.composition.layers.list.input.v1","resultContractId":"aemcp.contract.ae.composition.layers.list.result.v1","contractDigest":"3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75","inputSchema":{"type":"object","additionalProperties":false,"required":["compositionLocator","offset","limit"],"properties":{"compositionLocator":{"$ref":"#/$defs/compositionLocator"},"offset":{"type":"integer","minimum":0,"maximum":9007199254740991,"default":0,"x-omissionBehavior":0},"limit":{"type":"integer","minimum":1,"maximum":50,"default":25,"x-omissionBehavior":25}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"compositionLocator":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"const":"composition"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}}}},"resultSchema":{"type":"object","additionalProperties":false,"required":["compositionLocator","compositionName","total","offset","limit","returned","hasMore","nextOffset","layers"],"properties":{"compositionLocator":{"$ref":"#/$defs/compositionLocator"},"compositionName":{"type":"string","maxLength":1024},"total":{"type":"integer","minimum":0,"maximum":9007199254740991},"offset":{"type":"integer","minimum":0,"maximum":9007199254740991},"limit":{"type":"integer","minimum":1,"maximum":50},"returned":{"type":"integer","minimum":0,"maximum":50},"hasMore":{"type":"boolean"},"nextOffset":{"oneOf":[{"type":"null"},{"type":"integer","minimum":0,"maximum":9007199254740991}]},"layers":{"type":"array","maxItems":50,"items":{"type":"object","additionalProperties":false,"required":["locator","stackIndex","name","type","videoEnabled","isThreeD","locked","parentLocator","sourceItemLocator"],"properties":{"locator":{"$ref":"#/$defs/layerLocator"},"stackIndex":{"type":"integer","minimum":1,"maximum":9007199254740991},"name":{"type":"string","maxLength":1024},"type":{"enum":["av","camera","light","text","shape","model3d","null","adjustment","unknown"]},"videoEnabled":{"type":"boolean"},"isThreeD":{"type":"boolean"},"locked":{"type":"boolean"},"parentLocator":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/layerLocator"}]},"sourceItemLocator":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/sourceItemLocator"}]}}}}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"locatorBase":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"enum":["project","item","composition","layer","stream"]},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}},"compositionLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"composition"}}}]},"layerLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"layer"}}}]},"sourceItemLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"enum":["item","composition"]}}}]}},"x-invariant":"returned-equals-layers-length-and-page-metadata-is-self-consistent"},"requirements":[{"id":"aemcp.requirement.native.composition-layers-list","contractVersion":1}],"examples":[{"id":"aemcp-example-composition-layers-list-empty","kind":"positive","summary":"List the first bounded page of an empty composition.","arguments":{"compositionLocator":{"kind":"composition","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"66666666-6666-4666-8666-666666666666"},"offset":0,"limit":25},"expected":{"outcome":"succeeded","value":{"compositionLocator":{"kind":"composition","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"66666666-6666-4666-8666-666666666666"},"compositionName":"SYNTHETIC_COMPOSITION","total":0,"offset":0,"limit":25,"returned":0,"hasMore":false,"nextOffset":null,"layers":[]}}},{"id":"aemcp-example-composition-layers-list-stale","kind":"negative","summary":"Refresh a stale composition locator before listing layers.","arguments":{"compositionLocator":{"kind":"composition","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"66666666-6666-4666-8666-666666666666"},"offset":0,"limit":25},"expected":{"errorCode":"STALE_LOCATOR","recoveryAction":"refresh-locator"}}]})aemcp";
}

std::string replace_descriptor_text(
    std::string value, std::string_view from, std::string_view to) {
  if (from.empty()) invalid_argument("descriptor replacement source is empty");
  std::size_t offset = 0;
  std::size_t replacements = 0;
  while ((offset = value.find(from, offset)) != std::string::npos) {
    value.replace(offset, from.size(), to);
    offset += to.size();
    ++replacements;
  }
  if (replacements == 0) invalid_argument("compiled descriptor replacement was not found");
  return value;
}

std::string composition_selected_layers_list_descriptor(
    const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kFull) {
    require_digest(
        response.composition_selected_layers_list_contract_digest,
        "contract digest");
    if (response.composition_selected_layers_list_contract_digest
        != "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75") {
      invalid_argument(
          "composition selected layers contract digest does not match the compiled descriptor");
    }
  }
  CapabilitiesSuccess base = response;
  base.composition_layers_list_contract_digest =
      "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75";
  std::string descriptor = composition_layers_list_descriptor(base);
  descriptor = replace_descriptor_text(
      std::move(descriptor),
      "ae.composition.layers.list",
      "ae.composition.selected-layers.list");
  descriptor = replace_descriptor_text(
      std::move(descriptor),
      "List a bounded page of layers in one After Effects composition.",
      "List a bounded page of selected layers in one After Effects composition.");
  descriptor = replace_descriptor_text(
      std::move(descriptor),
      "Reads composition layers without changing After Effects state.",
      "Reads selected composition layers without changing After Effects state.");
  if (response.detail == CapabilityDetail::kFull) {
    descriptor = replace_descriptor_text(
        std::move(descriptor),
        "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75",
        response.composition_selected_layers_list_contract_digest);
    descriptor = replace_descriptor_text(
        std::move(descriptor),
        "aemcp.requirement.native.composition-layers-list",
        "aemcp.requirement.native.composition-selected-layers-list");
    descriptor = replace_descriptor_text(
        std::move(descriptor),
        "aemcp-example-composition-layers-list-empty",
        "aemcp-example-composition-selected-layers-list-empty");
    descriptor = replace_descriptor_text(
        std::move(descriptor),
        "List the first bounded page of an empty composition.",
        "List an empty selected-layer page for a composition.");
    descriptor = replace_descriptor_text(
        std::move(descriptor),
        "aemcp-example-composition-layers-list-stale",
        "aemcp-example-composition-selected-layers-list-stale");
    descriptor = replace_descriptor_text(
        std::move(descriptor),
        "Refresh a stale composition locator before listing layers.",
        "Refresh a stale composition locator before listing selected layers.");
  }
  return descriptor;
}

std::string composition_time_read_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"cancellation":"before-dispatch","compatibility":{"intendedPlatforms":["macos-arm64","windows-x64"],"status":"unverified"},"detail":"summary","id":"ae.composition.time.read","idempotency":"idempotent","mutability":"read-only","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1."],"risk":"read","schemaVersion":1,"sideEffectSummary":"Reads composition time without changing After Effects state.","summary":"Read the current time of one After Effects composition.","undo":"not-applicable","version":1})aemcp";
  }
  require_digest(response.composition_time_read_contract_digest, "contract digest");
  if (response.composition_time_read_contract_digest
      != "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd") {
    invalid_argument(
        "composition time contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"cancellation":"before-dispatch","compatibility":{"intendedPlatforms":["macos-arm64","windows-x64"],"status":"unverified"},"contractDigest":"fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd","detail":"full","examples":[{"arguments":{"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"}},"expected":{"outcome":"succeeded","value":{"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"},"currentTime":{"scale":1000,"secondsRational":"3003/1000","value":3003}}},"id":"aemcp-example-composition-time-read","kind":"positive","summary":"Read an exact rational current time from a composition."},{"arguments":{"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"}},"expected":{"errorCode":"STALE_LOCATOR","recoveryAction":"refresh-locator"},"id":"aemcp-example-composition-time-read-stale","kind":"negative","summary":"Refresh a stale composition locator before reading current time."}],"id":"ae.composition.time.read","idempotency":"idempotent","inputContractId":"aemcp.contract.ae.composition.time.read.input.v1","inputSchema":{"$defs":{"compositionLocator":{"additionalProperties":false,"properties":{"generation":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"kind":{"const":"composition"},"objectId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"}},"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"type":"object"},"uuid":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"}},"additionalProperties":false,"properties":{"compositionLocator":{"$ref":"#/$defs/compositionLocator"}},"required":["compositionLocator"],"type":"object"},"mutability":"read-only","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1."],"requirements":[{"contractVersion":1,"id":"aemcp.requirement.native.composition-time-read"}],"resultContractId":"aemcp.contract.ae.composition.time.read.result.v1","resultSchema":{"$defs":{"compositionLocator":{"additionalProperties":false,"properties":{"generation":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"kind":{"const":"composition"},"objectId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"}},"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"type":"object"},"uuid":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"}},"additionalProperties":false,"properties":{"compositionLocator":{"$ref":"#/$defs/compositionLocator"},"currentTime":{"additionalProperties":false,"properties":{"scale":{"maximum":4294967295,"minimum":1,"type":"integer"},"secondsRational":{"maxLength":28,"minLength":1,"pattern":"^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$","type":"string"},"value":{"maximum":2147483647,"minimum":-2147483648,"type":"integer"}},"required":["value","scale","secondsRational"],"type":"object"}},"required":["compositionLocator","currentTime"],"type":"object","x-invariant":"secondsRational-is-the-reduced-canonical-form-of-value-over-scale"},"risk":"read","schemaVersion":1,"sideEffectSummary":"Reads composition time without changing After Effects state.","summary":"Read the current time of one After Effects composition.","undo":"not-applicable","version":1})aemcp";
}

std::string composition_time_set_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"cancellation":"before-dispatch","compatibility":{"intendedPlatforms":["macos-arm64","windows-x64"],"status":"unverified"},"detail":"summary","id":"ae.composition.time.set","idempotency":"idempotency-key","mutability":"mutating","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1.","targetTime must differ from the composition's current time."],"risk":"write","schemaVersion":1,"sideEffectSummary":"Changes composition current time and creates one After Effects Undo step.","summary":"Set the current time of one After Effects composition.","undo":"ae-undo-group","version":1})aemcp";
  }
  require_digest(response.composition_time_set_contract_digest, "contract digest");
  if (response.composition_time_set_contract_digest
      != "724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308") {
    invalid_argument(
        "composition time set contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"cancellation":"before-dispatch","compatibility":{"intendedPlatforms":["macos-arm64","windows-x64"],"status":"unverified"},"contractDigest":"724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308","detail":"full","examples":[{"arguments":{"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"},"idempotencyKey":"synthetic-comp-time-0001","targetTime":{"scale":1,"value":1}},"expected":{"outcome":"succeeded","value":{"afterTime":{"scale":1,"secondsRational":"1","value":1},"beforeTime":{"scale":1,"secondsRational":"0","value":0},"changed":true,"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"}}},"id":"aemcp-example-composition-time-set","kind":"positive","summary":"Set and verify an exact rational composition time."},{"arguments":{"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"},"idempotencyKey":"synthetic-comp-time-0002","targetTime":{"scale":1,"value":1}},"expected":{"errorCode":"STALE_LOCATOR","recoveryAction":"refresh-locator"},"id":"aemcp-example-composition-time-set-stale","kind":"negative","summary":"Refresh a stale composition locator before setting current time."}],"id":"ae.composition.time.set","idempotency":"idempotency-key","inputContractId":"aemcp.contract.ae.composition.time.set.input.v1","inputSchema":{"$defs":{"compositionLocator":{"additionalProperties":false,"properties":{"generation":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"kind":{"const":"composition"},"objectId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"}},"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"type":"object"},"timeInput":{"additionalProperties":false,"properties":{"scale":{"maximum":4294967295,"minimum":1,"type":"integer"},"value":{"maximum":2147483647,"minimum":-2147483648,"type":"integer"}},"required":["value","scale"],"type":"object"},"uuid":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"}},"additionalProperties":false,"properties":{"compositionLocator":{"$ref":"#/$defs/compositionLocator"},"idempotencyKey":{"maxLength":64,"minLength":16,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$","type":"string"},"targetTime":{"$ref":"#/$defs/timeInput"}},"required":["compositionLocator","targetTime","idempotencyKey"],"type":"object"},"mutability":"mutating","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1.","targetTime must differ from the composition's current time."],"requirements":[{"contractVersion":1,"id":"aemcp.requirement.native.composition-time-set"}],"resultContractId":"aemcp.contract.ae.composition.time.set.result.v1","resultSchema":{"$defs":{"compositionLocator":{"additionalProperties":false,"properties":{"generation":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"kind":{"const":"composition"},"objectId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"}},"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"type":"object"},"currentTime":{"additionalProperties":false,"properties":{"scale":{"maximum":4294967295,"minimum":1,"type":"integer"},"secondsRational":{"maxLength":28,"minLength":1,"pattern":"^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$","type":"string"},"value":{"maximum":2147483647,"minimum":-2147483648,"type":"integer"}},"required":["value","scale","secondsRational"],"type":"object"},"uuid":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"}},"additionalProperties":false,"properties":{"afterTime":{"$ref":"#/$defs/currentTime"},"beforeTime":{"$ref":"#/$defs/currentTime"},"changed":{"const":true},"compositionLocator":{"$ref":"#/$defs/compositionLocator"}},"required":["changed","compositionLocator","beforeTime","afterTime"],"type":"object","x-invariant":"beforeTime-must-differ-from-afterTime-and-afterTime-must-equal-targetTime"},"risk":"write","schemaVersion":1,"sideEffectSummary":"Changes composition current time and creates one After Effects Undo step.","summary":"Set the current time of one After Effects composition.","undo":"ae-undo-group","version":1})aemcp";
}

std::string composition_layer_create_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"cancellation":"before-dispatch","compatibility":{"intendedPlatforms":["macos-arm64","windows-x64"],"status":"unverified"},"detail":"summary","id":"ae.composition.layer.create","idempotency":"idempotency-key","mutability":"mutating","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1.","kind must be null or solid and solid-only options require kind solid."],"risk":"write","schemaVersion":1,"sideEffectSummary":"Creates one composition layer, may create one solid project item, and creates one After Effects Undo step.","summary":"Create one null or solid layer in an After Effects composition.","undo":"ae-undo-group","version":1})aemcp";
  }
  require_digest(response.composition_layer_create_contract_digest, "contract digest");
  if (response.composition_layer_create_contract_digest
      != "d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee") {
    invalid_argument(
        "composition layer create contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"cancellation":"before-dispatch","compatibility":{"intendedPlatforms":["macos-arm64","windows-x64"],"status":"unverified"},"contractDigest":"d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee","detail":"full","examples":[{"arguments":{"compositionLocator":{"generation":8,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"66666666-6666-4666-8666-666666666666","projectId":"44444444-4444-4444-8444-444444444444","sessionId":"11111111-1111-4111-8111-111111111111"},"idempotencyKey":"synthetic-layer-create-0001","kind":"null","name":"Controller"},"expected":{"outcome":"succeeded","value":{"changed":true,"compositionLocator":{"generation":9,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"composition","objectId":"77777777-7777-4777-8777-777777777777","projectId":"55555555-5555-4555-8555-555555555555","sessionId":"11111111-1111-4111-8111-111111111111"},"kind":"null","layerCountAfter":1,"layerCountBefore":0,"layerLocator":{"generation":9,"hostInstanceId":"22222222-2222-4222-8222-222222222222","kind":"layer","objectId":"88888888-8888-4888-8888-888888888888","projectId":"55555555-5555-4555-8555-555555555555","sessionId":"11111111-1111-4111-8111-111111111111"},"name":"Controller","projectItemCountAfter":1,"projectItemCountBefore":1,"solid":null,"sourceItemLocator":null,"stackIndex":1}},"id":"aemcp-example-composition-layer-create-null","kind":"positive","summary":"Create one null layer and return fresh post-mutation locators."}],"id":"ae.composition.layer.create","idempotency":"idempotency-key","inputContractId":"aemcp.contract.ae.composition.layer.create.input.v1","inputSchema":{"$defs":{"color":{"additionalProperties":false,"properties":{"alpha":{"maximum":255,"minimum":0,"type":"integer"},"blue":{"maximum":255,"minimum":0,"type":"integer"},"green":{"maximum":255,"minimum":0,"type":"integer"},"red":{"maximum":255,"minimum":0,"type":"integer"}},"required":["red","green","blue","alpha"],"type":"object"},"compositionLocator":{"additionalProperties":false,"properties":{"generation":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"kind":{"const":"composition"},"objectId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"}},"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"type":"object"},"timeInput":{"additionalProperties":false,"properties":{"scale":{"maximum":4294967295,"minimum":1,"type":"integer"},"value":{"maximum":2147483647,"minimum":-2147483648,"type":"integer"}},"required":["value","scale"],"type":"object"},"uuid":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"}},"additionalProperties":false,"properties":{"color":{"$ref":"#/$defs/color","default":{"alpha":255,"blue":255,"green":255,"red":255},"x-omissionBehavior":"opaque-white"},"compositionLocator":{"$ref":"#/$defs/compositionLocator"},"duration":{"$ref":"#/$defs/timeInput","x-omissionBehavior":"composition-duration"},"height":{"maximum":30000,"minimum":1,"type":"integer","x-omissionBehavior":"composition-height"},"idempotencyKey":{"maxLength":64,"minLength":16,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$","type":"string"},"kind":{"enum":["null","solid"]},"name":{"maxLength":255,"minLength":1,"type":"string"},"width":{"maximum":30000,"minimum":1,"type":"integer","x-omissionBehavior":"composition-width"}},"required":["compositionLocator","kind","name","idempotencyKey"],"type":"object","x-invariant":"solid-options-are-forbidden-when-kind-is-null"},"mutability":"mutating","preconditions":["An After Effects project must be open.","compositionLocator must come from ae.project.items.list@1.","kind must be null or solid and solid-only options require kind solid."],"requirements":[{"contractVersion":1,"id":"aemcp.requirement.native.composition-layer-create"}],"resultContractId":"aemcp.contract.ae.composition.layer.create.result.v1","resultSchema":{"$defs":{"color":{"additionalProperties":false,"properties":{"alpha":{"maximum":255,"minimum":0,"type":"integer"},"blue":{"maximum":255,"minimum":0,"type":"integer"},"green":{"maximum":255,"minimum":0,"type":"integer"},"red":{"maximum":255,"minimum":0,"type":"integer"}},"required":["red","green","blue","alpha"],"type":"object"},"compositionLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"composition"}}}]},"currentTime":{"additionalProperties":false,"properties":{"scale":{"maximum":4294967295,"minimum":1,"type":"integer"},"secondsRational":{"maxLength":28,"minLength":1,"pattern":"^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$","type":"string"},"value":{"maximum":2147483647,"minimum":-2147483648,"type":"integer"}},"required":["value","scale","secondsRational"],"type":"object"},"itemLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"enum":["item","composition"]}}}]},"layerLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"layer"}}}]},"locatorBase":{"additionalProperties":false,"properties":{"generation":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"kind":{"enum":["composition","layer","item"]},"objectId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"}},"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"type":"object"},"solidSpec":{"additionalProperties":false,"properties":{"color":{"$ref":"#/$defs/color"},"duration":{"$ref":"#/$defs/currentTime"},"height":{"maximum":30000,"minimum":1,"type":"integer"},"width":{"maximum":30000,"minimum":1,"type":"integer"}},"required":["color","width","height","duration"],"type":"object"},"uuid":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","type":"string"}},"additionalProperties":false,"properties":{"changed":{"const":true},"compositionLocator":{"$ref":"#/$defs/compositionLocator"},"kind":{"enum":["null","solid"]},"layerCountAfter":{"maximum":9007199254740991,"minimum":1,"type":"integer"},"layerCountBefore":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"layerLocator":{"$ref":"#/$defs/layerLocator"},"name":{"maxLength":255,"minLength":1,"type":"string"},"projectItemCountAfter":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"projectItemCountBefore":{"maximum":9007199254740991,"minimum":0,"type":"integer"},"solid":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/solidSpec"}]},"sourceItemLocator":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/itemLocator"}]},"stackIndex":{"maximum":9007199254740991,"minimum":1,"type":"integer"}},"required":["changed","kind","name","stackIndex","compositionLocator","layerLocator","sourceItemLocator","layerCountBefore","layerCountAfter","projectItemCountBefore","projectItemCountAfter","solid"],"type":"object","x-invariant":"new-locators-share-one-post-mutation-generation;layerCountAfter-equals-layerCountBefore-plus-one;solid-requires-source-item-and-solid-metadata"},"risk":"write","schemaVersion":1,"sideEffectSummary":"Creates one composition layer, may create one solid project item, and creates one After Effects Undo step.","summary":"Create one null or solid layer in an After Effects composition.","undo":"ae-undo-group","version":1})aemcp";
}

std::string layer_properties_list_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"detail":"summary","id":"ae.layer.properties.list","version":1,"schemaVersion":1,"summary":"List a bounded page of direct properties on an After Effects layer or property group.","risk":"read","mutability":"read-only","idempotency":"idempotent","cancellation":"before-dispatch","undo":"not-applicable","sideEffectSummary":"Reads layer properties and safe primitive values without changing After Effects state.","preconditions":["An After Effects project must be open.","layerLocator must come from ae.composition.layers.list@1.","parentPropertyLocator must come from ae.layer.properties.list@1 for the same layer."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]}})aemcp";
  }
  require_digest(response.layer_properties_list_contract_digest, "contract digest");
  if (response.layer_properties_list_contract_digest
      != "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba") {
    invalid_argument("layer properties contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"detail":"full","id":"ae.layer.properties.list","version":1,"schemaVersion":1,"summary":"List a bounded page of direct properties on an After Effects layer or property group.","risk":"read","mutability":"read-only","idempotency":"idempotent","cancellation":"before-dispatch","undo":"not-applicable","sideEffectSummary":"Reads layer properties and safe primitive values without changing After Effects state.","preconditions":["An After Effects project must be open.","layerLocator must come from ae.composition.layers.list@1.","parentPropertyLocator must come from ae.layer.properties.list@1 for the same layer."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]},"inputContractId":"aemcp.contract.ae.layer.properties.list.input.v1","resultContractId":"aemcp.contract.ae.layer.properties.list.result.v1","contractDigest":"a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba","inputSchema":{"type":"object","additionalProperties":false,"required":["layerLocator","offset","limit"],"properties":{"layerLocator":{"$ref":"#/$defs/layerLocator"},"parentPropertyLocator":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/streamLocator"}]},"offset":{"type":"integer","minimum":0,"maximum":9007199254740991,"default":0,"x-omissionBehavior":0},"limit":{"type":"integer","minimum":1,"maximum":25,"default":25,"x-omissionBehavior":25}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"layerLocator":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"const":"layer"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}},"streamLocator":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"const":"stream"},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}}}},"resultSchema":{"type":"object","additionalProperties":false,"required":["layerLocator","parentPropertyLocator","layerName","sampleTime","total","offset","limit","returned","hasMore","nextOffset","properties"],"properties":{"layerLocator":{"$ref":"#/$defs/layerLocator"},"parentPropertyLocator":{"oneOf":[{"type":"null"},{"$ref":"#/$defs/streamLocator"}]},"layerName":{"type":"string","maxLength":1024},"sampleTime":{"type":"object","additionalProperties":false,"required":["value","scale","mode"],"properties":{"value":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"scale":{"type":"integer","minimum":1,"maximum":9007199254740991},"mode":{"const":"comp-time"}}},"total":{"type":"integer","minimum":0,"maximum":9007199254740991},"offset":{"type":"integer","minimum":0,"maximum":9007199254740991},"limit":{"type":"integer","minimum":1,"maximum":25},"returned":{"type":"integer","minimum":0,"maximum":25},"hasMore":{"type":"boolean"},"nextOffset":{"oneOf":[{"type":"null"},{"type":"integer","minimum":0,"maximum":9007199254740991}]},"properties":{"type":"array","maxItems":25,"items":{"type":"object","additionalProperties":false,"required":["propertyLocator","propertyIndex","name","matchName","groupingType","childCount","hidden","disabled","modified","canVaryOverTime","timeVarying","valueType","valueStatus","value"],"properties":{"propertyLocator":{"$ref":"#/$defs/streamLocator"},"propertyIndex":{"type":"integer","minimum":1,"maximum":9007199254740991},"name":{"type":"string","maxLength":1024},"matchName":{"type":"string","maxLength":40},"groupingType":{"enum":["leaf","named-group","indexed-group"]},"childCount":{"type":"integer","minimum":0,"maximum":9007199254740991},"hidden":{"type":"boolean"},"disabled":{"type":"boolean"},"modified":{"type":"boolean"},"canVaryOverTime":{"oneOf":[{"type":"null"},{"type":"boolean"}]},"timeVarying":{"oneOf":[{"type":"null"},{"type":"boolean"}]},"valueType":{"enum":["none","one-d","two-d","two-d-spatial","three-d","three-d-spatial","color","arb","marker","layer-id","mask-id","mask","text-document","unknown"]},"valueStatus":{"enum":["group","sampled","no-data","unsupported"]},"value":{"oneOf":[{"type":"null"},{"type":"object","additionalProperties":false,"required":["kind","value"],"properties":{"kind":{"const":"scalar"},"value":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}},{"type":"object","additionalProperties":false,"required":["kind","components"],"properties":{"kind":{"const":"vector"},"components":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}}},{"type":"object","additionalProperties":false,"required":["kind","alpha","red","green","blue"],"properties":{"kind":{"const":"color"},"alpha":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"red":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"green":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"blue":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}}]}}}}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"locatorBase":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"enum":["project","item","composition","layer","stream"]},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}},"layerLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"layer"}}}]},"streamLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"stream"}}}]}},"x-invariant":"returned-equals-properties-length-and-page-metadata-and-value-types-are-self-consistent"},"requirements":[{"id":"aemcp.requirement.native.layer-properties-list","contractVersion":1}],"examples":[{"id":"aemcp-example-layer-properties-list-empty","kind":"positive","summary":"List the first bounded page of direct properties on a layer.","arguments":{"layerLocator":{"kind":"layer","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"88888888-8888-4888-8888-888888888888"},"offset":0,"limit":25},"expected":{"outcome":"succeeded","value":{"layerLocator":{"kind":"layer","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"88888888-8888-4888-8888-888888888888"},"parentPropertyLocator":null,"layerName":"SYNTHETIC_LAYER","sampleTime":{"value":0,"scale":1,"mode":"comp-time"},"total":0,"offset":0,"limit":25,"returned":0,"hasMore":false,"nextOffset":null,"properties":[]}}},{"id":"aemcp-example-layer-properties-list-stale","kind":"negative","summary":"Refresh stale layer and property locators before listing properties.","arguments":{"layerLocator":{"kind":"layer","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"88888888-8888-4888-8888-888888888888"},"offset":0,"limit":25},"expected":{"errorCode":"STALE_LOCATOR","recoveryAction":"refresh-locator"}}]})aemcp";
}

std::string layer_property_set_descriptor(const CapabilitiesSuccess& response) {
  if (response.detail == CapabilityDetail::kSummary) {
    return R"aemcp({"detail":"summary","id":"ae.layer.property.set","version":1,"schemaVersion":1,"summary":"Set one non-keyframed primitive After Effects layer property value.","risk":"write","mutability":"mutating","idempotency":"idempotency-key","cancellation":"before-dispatch","undo":"ae-undo-group","sideEffectSummary":"Changes one primitive layer property and creates one After Effects Undo step.","preconditions":["An After Effects project must be open.","Both locators must come from ae.layer.properties.list@1 for the same layer.","The property must be a non-keyframed scalar, vector, or color leaf stream.","value must differ from the property's current sampled value."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]}})aemcp";
  }
  require_digest(response.layer_property_set_contract_digest, "contract digest");
  if (response.layer_property_set_contract_digest
      != "5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c") {
    invalid_argument(
        "layer property set contract digest does not match the compiled descriptor");
  }
  return R"aemcp({"detail":"full","id":"ae.layer.property.set","version":1,"schemaVersion":1,"summary":"Set one non-keyframed primitive After Effects layer property value.","risk":"write","mutability":"mutating","idempotency":"idempotency-key","cancellation":"before-dispatch","undo":"ae-undo-group","sideEffectSummary":"Changes one primitive layer property and creates one After Effects Undo step.","preconditions":["An After Effects project must be open.","Both locators must come from ae.layer.properties.list@1 for the same layer.","The property must be a non-keyframed scalar, vector, or color leaf stream.","value must differ from the property's current sampled value."],"compatibility":{"status":"unverified","intendedPlatforms":["macos-arm64","windows-x64"]},"inputContractId":"aemcp.contract.ae.layer.property.set.input.v1","resultContractId":"aemcp.contract.ae.layer.property.set.result.v1","contractDigest":"5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c","inputSchema":{"type":"object","additionalProperties":false,"required":["layerLocator","propertyLocator","value","idempotencyKey"],"properties":{"layerLocator":{"$ref":"#/$defs/layerLocator"},"propertyLocator":{"$ref":"#/$defs/streamLocator"},"value":{"$ref":"#/$defs/primitiveValue"},"idempotencyKey":{"type":"string","minLength":16,"maxLength":64,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"locatorBase":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"enum":["layer","stream"]},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}},"layerLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"layer"}}}]},"streamLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"stream"}}}]},"primitiveValue":{"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","value"],"properties":{"kind":{"const":"scalar"},"value":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}},{"type":"object","additionalProperties":false,"required":["kind","components"],"properties":{"kind":{"const":"vector"},"components":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}}},{"type":"object","additionalProperties":false,"required":["kind","alpha","red","green","blue"],"properties":{"kind":{"const":"color"},"alpha":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"red":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"green":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"blue":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}}]}},"x-invariant":"both-locators-must-share-one-host-session-project-generation"},"resultSchema":{"type":"object","additionalProperties":false,"required":["changed","layerLocator","propertyLocator","valueType","beforeValue","afterValue"],"properties":{"changed":{"const":true},"layerLocator":{"$ref":"#/$defs/layerLocator"},"propertyLocator":{"$ref":"#/$defs/streamLocator"},"valueType":{"enum":["one-d","two-d","two-d-spatial","three-d","three-d-spatial","color"]},"beforeValue":{"$ref":"#/$defs/primitiveValue"},"afterValue":{"$ref":"#/$defs/primitiveValue"}},"$defs":{"uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"locatorBase":{"type":"object","additionalProperties":false,"required":["kind","hostInstanceId","sessionId","projectId","generation","objectId"],"properties":{"kind":{"enum":["layer","stream"]},"hostInstanceId":{"$ref":"#/$defs/uuid"},"sessionId":{"$ref":"#/$defs/uuid"},"projectId":{"$ref":"#/$defs/uuid"},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"objectId":{"$ref":"#/$defs/uuid"}}},"layerLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"layer"}}}]},"streamLocator":{"allOf":[{"$ref":"#/$defs/locatorBase"},{"properties":{"kind":{"const":"stream"}}}]},"primitiveValue":{"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","value"],"properties":{"kind":{"const":"scalar"},"value":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}},{"type":"object","additionalProperties":false,"required":["kind","components"],"properties":{"kind":{"const":"vector"},"components":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}}},{"type":"object","additionalProperties":false,"required":["kind","alpha","red","green","blue"],"properties":{"kind":{"const":"color"},"alpha":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"red":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"green":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"},"blue":{"type":"string","minLength":1,"maxLength":32,"pattern":"^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"}}}]}},"x-invariant":"beforeValue-must-differ-from-afterValue-and-values-must-match-valueType"},"requirements":[{"id":"aemcp.requirement.native.layer-property-set","contractVersion":1}],"examples":[{"id":"aemcp-example-layer-property-set","kind":"positive","summary":"Change one non-keyframed scalar property with Undo available.","arguments":{"layerLocator":{"kind":"layer","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"88888888-8888-4888-8888-888888888888"},"propertyLocator":{"kind":"stream","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"},"value":{"kind":"scalar","value":"40"},"idempotencyKey":"synthetic-property-0001"},"expected":{"outcome":"succeeded","value":{"changed":true,"layerLocator":{"kind":"layer","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"88888888-8888-4888-8888-888888888888"},"propertyLocator":{"kind":"stream","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"},"valueType":"one-d","beforeValue":{"kind":"scalar","value":"25"},"afterValue":{"kind":"scalar","value":"40"}}}},{"id":"aemcp-example-layer-property-set-keyframed","kind":"negative","summary":"Reject a keyframed stream without changing After Effects state.","arguments":{"layerLocator":{"kind":"layer","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"88888888-8888-4888-8888-888888888888"},"propertyLocator":{"kind":"stream","hostInstanceId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","projectId":"44444444-4444-4444-8444-444444444444","generation":8,"objectId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"},"value":{"kind":"scalar","value":"40"},"idempotencyKey":"synthetic-property-0002"},"expected":{"errorCode":"PRECONDITION_FAILED","recoveryAction":"change-arguments"}}]})aemcp";
}


struct ErrorPolicy {
  const char* code;
  bool retryable;
  const char* side_effect;
  const char* recovery;
  bool capability_details;
};

ErrorPolicy error_policy(RpcErrorCode code) {
  switch (code) {
    case RpcErrorCode::kNativeUnavailable:
      return {"NATIVE_UNAVAILABLE", true, "not-started", "reconnect", false};
    case RpcErrorCode::kNativeUnsupported:
      return {"NATIVE_UNSUPPORTED", false, "not-started", "refresh-capabilities", true};
    case RpcErrorCode::kWireVersionMismatch:
      return {"WIRE_VERSION_MISMATCH", false, "not-started", "reconnect", false};
    case RpcErrorCode::kInvalidRequest:
      return {"INVALID_REQUEST", false, "not-started", "none", false};
    case RpcErrorCode::kInvalidArgument:
      return {"INVALID_ARGUMENT", false, "not-started", "change-arguments", false};
    case RpcErrorCode::kDuplicateRequest:
      return {"DUPLICATE_REQUEST", false, "not-started", "inspect-state", false};
    case RpcErrorCode::kPreconditionFailed:
      return {"PRECONDITION_FAILED", false, "not-started", "open-project", true};
    case RpcErrorCode::kStaleLocator:
      return {"STALE_LOCATOR", true, "not-started", "refresh-locator", true};
    case RpcErrorCode::kDeadlineExceeded:
      return {"DEADLINE_EXCEEDED", true, "not-started", "retry", false};
    case RpcErrorCode::kCancelled:
      return {"CANCELLED", false, "not-started", "none", false};
    case RpcErrorCode::kQueueFull:
      return {"QUEUE_FULL", true, "not-started", "retry", false};
    case RpcErrorCode::kAeShuttingDown:
      return {"AE_SHUTTING_DOWN", true, "not-started", "reconnect", false};
    case RpcErrorCode::kSessionStale:
      return {"SESSION_STALE", true, "not-started", "reconnect", false};
    case RpcErrorCode::kCapabilityFailed:
      return {"CAPABILITY_FAILED", false, "not-started", "inspect-state", true};
    case RpcErrorCode::kPossiblySideEffectingFailure:
      return {"POSSIBLY_SIDE_EFFECTING_FAILURE", false, "may-have-occurred", "inspect-state", true};
  }
  invalid_argument("unknown RPC error code");
}

}  // namespace

std::vector<std::uint8_t> encode_hello_success(const HelloSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_output_string(response.client_nonce, 32, 128, "client nonce");
  if (!std::all_of(response.client_nonce.begin(), response.client_nonce.end(), [](char character) {
      return ascii_alphanumeric(character) || character == '_' || character == '-';
    })) invalid_argument("client nonce is not URL-safe base64 text");
  require_output_string(response.plugin_version, 1, 64, "plugin version");
  if (!valid_numeric_version(response.compiled_sdk_version)
      || !valid_numeric_version(response.host_version)
      || response.compiled_sdk_build < 1 || response.compiled_sdk_build > kMaxSafeInteger
      || response.host_build < 1 || response.host_build > kMaxSafeInteger
      || response.session_generation < 1 || response.session_generation > kMaxSafeInteger
      || (response.architecture != "arm64" && response.architecture != "x86_64")
      || (response.platform != "macos-arm64" && response.platform != "windows-x64")
      || (response.platform == "macos-arm64" && response.architecture != "arm64")
      || (response.platform == "windows-x64" && response.architecture != "x86_64")) {
    invalid_argument("invalid hello identity");
  }
  validate_limits(response.limits);
  require_digest(response.capabilities_digest, "capabilities digest");
  const NegotiatedLimits& limits = response.limits;
  std::string json = "{\"kind\":\"response\",\"method\":\"hello\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilitiesDigest\":" + json_string(response.capabilities_digest)
      + ",\"clientNonce\":" + json_string(response.client_nonce)
      + ",\"compiledSdk\":{\"architecture\":" + json_string(response.architecture)
      + ",\"build\":" + std::to_string(response.compiled_sdk_build)
      + ",\"version\":" + json_string(response.compiled_sdk_version)
      + "},\"host\":{\"application\":\"after-effects\",\"build\":"
      + std::to_string(response.host_build) + ",\"instanceId\":"
      + json_string(response.host_instance_id) + ",\"platform\":"
      + json_string(response.platform) + ",\"version\":" + json_string(response.host_version)
      + "},\"limits\":{\"maxBurst\":" + std::to_string(limits.max_burst)
      + ",\"maxControlBurst\":" + std::to_string(limits.max_control_burst)
      + ",\"maxControlInFlight\":" + std::to_string(limits.max_control_in_flight)
      + ",\"maxControlRequestsPerSecond\":"
      + std::to_string(limits.max_control_requests_per_second)
      + ",\"maxDeadlineMs\":" + std::to_string(limits.max_deadline_ms)
      + ",\"maxFrameBytes\":" + std::to_string(limits.max_frame_bytes)
      + ",\"maxInFlight\":" + std::to_string(limits.max_in_flight)
      + ",\"maxQueueDepth\":" + std::to_string(limits.max_queue_depth)
      + ",\"maxRequestsPerSecond\":" + std::to_string(limits.max_requests_per_second)
      + ",\"maxTerminalCacheEntries\":"
      + std::to_string(limits.max_terminal_cache_entries)
      + ",\"terminalCacheTtlMs\":" + std::to_string(limits.terminal_cache_ttl_ms)
      + "},\"pluginVersion\":" + json_string(response.plugin_version)
      + ",\"selectedWireVersion\":1,\"sessionGeneration\":"
      + std::to_string(response.session_generation) + ",\"sessionId\":"
      + json_string(response.session_id) + "},\"sessionId\":" + json_string(response.session_id)
      + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_capabilities_success(const CapabilitiesSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_digest(response.query_digest, "query digest");
  require_digest(response.capabilities_digest, "capabilities digest");
  const std::string detail = response.detail == CapabilityDetail::kFull ? "full" : "summary";
  std::string items = "[";
  bool needs_comma = false;
  if (response.include_project_summary) {
    items += project_summary_descriptor(response);
    needs_comma = true;
  }
  if (response.include_project_bit_depth_read) {
    if (needs_comma) items.push_back(',');
    items += project_bit_depth_read_descriptor(response);
    needs_comma = true;
  }
  if (response.include_project_bit_depth_set) {
    if (needs_comma) items.push_back(',');
    items += project_bit_depth_set_descriptor(response);
    needs_comma = true;
  }
  if (response.include_project_items_list) {
    if (needs_comma) items.push_back(',');
    items += project_items_list_descriptor(response);
    needs_comma = true;
  }
  if (response.include_composition_layers_list) {
    if (needs_comma) items.push_back(',');
    items += composition_layers_list_descriptor(response);
    needs_comma = true;
  }
  if (response.include_composition_selected_layers_list) {
    if (needs_comma) items.push_back(',');
    items += composition_selected_layers_list_descriptor(response);
    needs_comma = true;
  }
  if (response.include_composition_time_read) {
    if (needs_comma) items.push_back(',');
    items += composition_time_read_descriptor(response);
    needs_comma = true;
  }
  if (response.include_composition_time_set) {
    if (needs_comma) items.push_back(',');
    items += composition_time_set_descriptor(response);
    needs_comma = true;
  }
  if (response.include_composition_layer_create) {
    if (needs_comma) items.push_back(',');
    items += composition_layer_create_descriptor(response);
    needs_comma = true;
  }
  if (response.include_layer_properties_list) {
    if (needs_comma) items.push_back(',');
    items += layer_properties_list_descriptor(response);
    needs_comma = true;
  }
  if (response.include_layer_property_set) {
    if (needs_comma) items.push_back(',');
    items += layer_property_set_descriptor(response);
  }
  items.push_back(']');
  std::string json = "{\"kind\":\"response\",\"method\":\"capabilities\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilitiesDigest\":" + json_string(response.capabilities_digest)
      + ",\"detail\":" + json_string(detail) + ",\"items\":" + items
      + ",\"nextCursor\":null,\"queryDigest\":" + json_string(response.query_digest)
      + "},\"sessionId\":" + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_progress_event(const ProgressEvent& event) {
  require_request_id(event.request_id);
  require_uuid(event.session_id, "session ID");
  if (event.sequence < 1 || event.sequence > kMaxSafeInteger || !std::isfinite(event.fraction)
      || event.fraction < 0 || event.fraction > 1) invalid_argument("invalid progress value");
  require_output_string(event.message, 1, 160, "progress message");
  std::string json = "{\"event\":\"progress\",\"kind\":\"event\",\"progress\":{"
      "\"fraction\":" + double_json(event.fraction) + ",\"message\":"
      + json_string(event.message) + ",\"phase\":" + json_string(progress_phase_name(event.phase))
      + "},\"requestId\":" + json_string(event.request_id) + ",\"sequence\":"
      + std::to_string(event.sequence) + ",\"sessionId\":" + json_string(event.session_id)
      + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_project_summary_success(
    const ProjectSummarySuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_output_string(response.project_name, 0, 1'024, "project name");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  if (response.replayed || response.item_count > kMaxSafeInteger || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger || response.completed_at_unix_ms < 1
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms) {
    invalid_argument("invalid or unvalidated project summary evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":" + std::string(response.replayed ? "true" : "false")
      + ",\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.project.summary\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.project.summary\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id) + ",\"postcondition\":{"
        "\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"project-summary\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":" + json_string(response.session_id)
      + ",\"startedAtUnixMs\":" + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":{\"itemCount\":"
      + std::to_string(response.item_count) + ",\"projectName\":"
      + json_string(response.project_name) + ",\"projectOpen\":"
      + (response.project_open ? "true" : "false") + "}},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_project_bit_depth_read_success(
    const ProjectBitDepthReadSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  if (response.replayed || !valid_bit_depth(response.bits_per_channel)
      || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger) {
    invalid_argument("invalid or unvalidated project bit-depth read evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.project.bit-depth.read\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.project.bit-depth.read\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\","
        "\"hostInstanceId\":" + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\","
        "\"digest\":" + json_string(response.postcondition_digest)
      + ",\"kind\":\"project-bit-depth-read\",\"verified\":true},"
        "\"requestDigest\":" + json_string(response.request_digest)
      + ",\"requestId\":" + json_string(response.request_id)
      + ",\"sessionId\":" + json_string(response.session_id)
      + ",\"startedAtUnixMs\":" + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":{\"bitsPerChannel\":"
      + std::to_string(response.bits_per_channel)
      + "}},\"sessionId\":" + json_string(response.session_id)
      + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_project_bit_depth_set_success(
    const ProjectBitDepthSetSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  if (response.replayed || !response.changed
      || !valid_bit_depth(response.before_bits_per_channel)
      || !valid_bit_depth(response.after_bits_per_channel)
      || response.before_bits_per_channel == response.after_bits_per_channel
      || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger) {
    invalid_argument("invalid or unvalidated project bit-depth set evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.project.bit-depth.set\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.project.bit-depth.set\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"committed\",\"engine\":\"native-aegp\","
        "\"hostInstanceId\":" + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\","
        "\"digest\":" + json_string(response.postcondition_digest)
      + ",\"kind\":\"project-bit-depth-set\",\"verified\":true},"
        "\"requestDigest\":" + json_string(response.request_digest)
      + ",\"requestId\":" + json_string(response.request_id)
      + ",\"sessionId\":" + json_string(response.session_id)
      + ",\"startedAtUnixMs\":" + std::to_string(response.started_at_unix_ms)
      // A balanced native Undo group makes the SDK-documented undo available.
      // Hardware qualification verifies the reverse transition separately so
      // the tool never consumes the user's global Undo stack itself.
      + ",\"undo\":{\"available\":true,\"verified\":false}},"
        "\"outcome\":\"succeeded\",\"value\":{\"afterBitsPerChannel\":"
      + std::to_string(response.after_bits_per_channel)
      + ",\"beforeBitsPerChannel\":" + std::to_string(response.before_bits_per_channel)
      + ",\"changed\":true}},\"sessionId\":" + json_string(response.session_id)
      + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_project_items_success(
    const ProjectItemsSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_project_items_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.project_locator.host_instance_id != response.host_instance_id
      || response.value.project_locator.session_id != response.session_id
      || response.postcondition_digest != digest_project_items_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated project items evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.project.items.list\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.project.items.list\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"project-items-list\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":" + value + "},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_composition_layers_success(
    const CompositionLayersSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_composition_layers_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.composition_locator.host_instance_id != response.host_instance_id
      || response.value.composition_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_composition_layers_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated composition layers evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.composition.layers.list\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.composition.layers.list\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"composition-layers-list\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":" + value + "},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_composition_selected_layers_success(
    const CompositionSelectedLayersSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_composition_selected_layers_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.composition_locator.host_instance_id != response.host_instance_id
      || response.value.composition_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_composition_selected_layers_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated composition selected layers evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.composition.selected-layers.list\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.composition.selected-layers.list\","
        "\"capabilityVersion\":1,\"completedAtUnixMs\":"
      + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"composition-selected-layers-list\",\"verified\":true},"
        "\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":" + value + "},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_composition_time_success(
    const CompositionTimeSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_composition_time_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.composition_locator.host_instance_id != response.host_instance_id
      || response.value.composition_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_composition_time_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated composition time evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.composition.time.read\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.composition.time.read\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"composition-time-read\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":" + value + "},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_composition_time_set_success(
    const CompositionTimeSetSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_composition_time_set_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.composition_locator.host_instance_id != response.host_instance_id
      || response.value.composition_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_composition_time_set_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated composition time mutation evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.composition.time.set\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.composition.time.set\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"committed\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"composition-time-set\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + ",\"undo\":{\"available\":true,\"verified\":false}},"
        "\"outcome\":\"succeeded\",\"value\":" + value
      + "},\"sessionId\":" + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_composition_layer_create_success(
    const CompositionLayerCreateSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_composition_layer_create_value(response.value);
  if (response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.composition_locator.host_instance_id
          != response.host_instance_id
      || response.value.composition_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_composition_layer_create_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated composition layer create evidence");
  }
  const std::string replayed = response.replayed ? "true" : "false";
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":" + replayed + ",\"requestId\":"
      + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.composition.layer.create\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.composition.layer.create\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"committed\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"composition-layer-create\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + ",\"undo\":{\"available\":true,\"verified\":false}},"
        "\"outcome\":\"succeeded\",\"value\":" + value
      + "},\"sessionId\":" + json_string(response.session_id)
      + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_layer_properties_success(
    const LayerPropertiesSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_layer_properties_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.layer_locator.host_instance_id != response.host_instance_id
      || response.value.layer_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_layer_properties_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated layer properties evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.layer.properties.list\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.layer.properties.list\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"none\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"layer-properties-list\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + "},\"outcome\":\"succeeded\",\"value\":" + value + "},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_layer_property_set_success(
    const LayerPropertySetSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  const std::string value = canonical_layer_property_changed_value(response.value);
  if (response.replayed || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger
      || response.value.layer_locator.host_instance_id != response.host_instance_id
      || response.value.layer_locator.session_id != response.session_id
      || response.postcondition_digest
          != digest_layer_property_set_postcondition(response.value)) {
    invalid_argument("invalid or unvalidated layer property mutation evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.layer.property.set\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.layer.property.set\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"committed\",\"engine\":\"native-aegp\",\"hostInstanceId\":"
      + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\",\"digest\":"
      + json_string(response.postcondition_digest)
      + ",\"kind\":\"layer-property-set\",\"verified\":true},\"requestDigest\":"
      + json_string(response.request_digest) + ",\"requestId\":"
      + json_string(response.request_id) + ",\"sessionId\":"
      + json_string(response.session_id) + ",\"startedAtUnixMs\":"
      + std::to_string(response.started_at_unix_ms)
      + ",\"undo\":{\"available\":true,\"verified\":false}},"
        "\"outcome\":\"succeeded\",\"value\":" + value
      + "},\"sessionId\":" + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_cancel_success(const CancelSuccess& response) {
  require_request_id(response.request_id);
  require_request_id(response.target_request_id);
  require_uuid(response.session_id, "session ID");
  std::string_view state;
  bool terminal_expected = false;
  switch (response.state) {
    case CancelState::kQueuedCancelled:
      state = "queued-cancelled";
      terminal_expected = true;
      break;
    case CancelState::kRunningCancelRequested:
      state = "running-cancel-requested";
      terminal_expected = true;
      break;
    case CancelState::kRunningNotCancellable:
      state = "running-not-cancellable";
      terminal_expected = true;
      break;
    case CancelState::kAlreadyTerminal:
      state = "already-terminal";
      break;
    case CancelState::kNotFound:
      state = "not-found";
      break;
  }
  if (response.terminal_response_expected != terminal_expected) {
    invalid_argument("cancel terminal expectation does not match state");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"cancel\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"state\":" + json_string(state)
      + ",\"targetRequestId\":" + json_string(response.target_request_id)
      + ",\"terminalResponseExpected\":"
      + (response.terminal_response_expected ? "true" : "false")
      + "},\"sessionId\":" + json_string(response.session_id)
      + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_project_graph_invalidate_success(
    const ProjectGraphInvalidateSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  if (response.invalidated
      ? response.generation < 1 || response.generation > kMaxSafeInteger
      : response.generation != 0) {
    invalid_argument("invalid project graph invalidation result");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invalidateGraph\","
      "\"ok\":true,\"replayed\":false,\"requestId\":"
      + json_string(response.request_id) + ",\"result\":{\"generation\":"
      + std::to_string(response.generation) + ",\"invalidated\":"
      + (response.invalidated ? "true" : "false") + "},\"sessionId\":"
      + json_string(response.session_id) + ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

std::vector<std::uint8_t> encode_error_response(const ErrorResponse& response) {
  require_request_id(response.request_id);
  const ErrorPolicy policy = error_policy(response.code);
  require_output_string(response.message, 1, 512, "error message");
  require_output_string(response.recovery_hint, 1, 256, "recovery hint");
  if (response.method == RpcMethod::kHello) {
    if (response.session_id.has_value()
        || !(response.code == RpcErrorCode::kNativeUnavailable
          || response.code == RpcErrorCode::kWireVersionMismatch
          || response.code == RpcErrorCode::kInvalidRequest
          || response.code == RpcErrorCode::kInvalidArgument)) {
      invalid_argument("invalid hello failure shape");
    }
  } else {
    if (!response.session_id.has_value()) invalid_argument("session failure needs a session ID");
    require_uuid(*response.session_id, "session ID");
    if (response.code == RpcErrorCode::kWireVersionMismatch) {
      invalid_argument("wire mismatch is only valid during hello");
    }
  }
  if (response.code == RpcErrorCode::kQueueFull) {
    if (!response.retry_after_ms.has_value() || *response.retry_after_ms < 1
        || *response.retry_after_ms > 30'000) invalid_argument("QUEUE_FULL needs retryAfterMs");
  } else if (response.retry_after_ms.has_value()) {
    invalid_argument("retryAfterMs is only valid for QUEUE_FULL");
  }
  if (response.code == RpcErrorCode::kWireVersionMismatch) {
    if (!response.details.has_value() || !response.details->supported_wire_minimum.has_value()
        || !response.details->supported_wire_maximum.has_value()
        || *response.details->supported_wire_minimum < 1
        || *response.details->supported_wire_maximum
          < *response.details->supported_wire_minimum) {
      invalid_argument("wire mismatch needs a valid supported range");
    }
  }
  if (policy.capability_details
      && (!response.details.has_value() || !response.details->capability_id.has_value()
        || !valid_capability_id(*response.details->capability_id))) {
    invalid_argument("capability failure needs capabilityId details");
  }
  std::string recovery_action = policy.recovery;
  if (response.recovery_action.has_value()) {
    if (response.code != RpcErrorCode::kPreconditionFailed
        || *response.recovery_action != "change-arguments"
        || !response.details.has_value()
        || !response.details->capability_id.has_value()
        || *response.details->capability_id != kLayerPropertySetCapability
        || !response.details->field.has_value()
        || *response.details->field != "params.arguments.propertyLocator") {
      invalid_argument("invalid capability-specific recovery action");
    }
    recovery_action = *response.recovery_action;
  }
  std::string recovery = "{\"action\":" + json_string(recovery_action)
      + ",\"hint\":" + json_string(response.recovery_hint);
  if (response.retry_after_ms.has_value()) {
    recovery += ",\"retryAfterMs\":" + std::to_string(*response.retry_after_ms);
  }
  recovery.push_back('}');

  std::string details;
  if (response.details.has_value()) {
    const ErrorDetails& value = *response.details;
    std::vector<std::string> members;
    if (value.field.has_value()) {
      require_output_string(*value.field, 1, 128, "error field");
      members.push_back("\"field\":" + json_string(*value.field));
    }
    if (value.capability_id.has_value()) {
      if (!valid_capability_id(*value.capability_id)) invalid_argument("invalid detail capability ID");
      members.push_back("\"capabilityId\":" + json_string(*value.capability_id));
    }
    if (value.supported_wire_minimum.has_value() || value.supported_wire_maximum.has_value()) {
      if (!value.supported_wire_minimum.has_value() || !value.supported_wire_maximum.has_value()
          || *value.supported_wire_minimum < 1
          || *value.supported_wire_minimum > *value.supported_wire_maximum) {
        invalid_argument("invalid detail wire range");
      }
      members.push_back("\"supportedWireVersions\":{\"maximum\":"
          + std::to_string(*value.supported_wire_maximum) + ",\"minimum\":"
          + std::to_string(*value.supported_wire_minimum) + "}");
    }
    if (value.current_generation.has_value()) {
      if (*value.current_generation < 1 || *value.current_generation > kMaxSafeInteger) {
        invalid_argument("invalid detail generation");
      }
      members.push_back("\"currentGeneration\":" + std::to_string(*value.current_generation));
    }
    std::sort(members.begin(), members.end());
    details = ",\"details\":{";
    for (std::size_t index = 0; index < members.size(); ++index) {
      if (index != 0) details.push_back(',');
      details += members[index];
    }
    details.push_back('}');
  }
  std::string json = "{\"error\":{\"code\":" + json_string(policy.code) + details
      + ",\"message\":" + json_string(response.message) + ",\"recovery\":" + recovery
      + ",\"retryable\":" + (policy.retryable ? "true" : "false")
      + ",\"sideEffect\":" + json_string(policy.side_effect) + "},\"kind\":\"response\","
        "\"method\":" + json_string(method_name(response.method))
      + ",\"ok\":false,\"replayed\":false,\"requestId\":"
      + json_string(response.request_id);
  if (response.session_id.has_value()) json += ",\"sessionId\":" + json_string(*response.session_id);
  json += ",\"wireVersion\":1}";
  return frame_output(std::move(json));
}

}  // namespace aemcp::native::rpc
