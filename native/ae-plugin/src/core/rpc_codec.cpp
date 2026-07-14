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

bool valid_folder_name(std::string_view value) {
  if (value.empty()) return false;
  std::size_t offset = 0;
  std::size_t utf16_units = 0;
  while (offset < value.size()) {
    const std::uint32_t scalar = decode_utf8_scalar(value, offset);
    if (scalar <= 0x1fU || scalar == 0x7fU) return false;
    utf16_units += scalar > 0xffffU ? 2U : 1U;
    if (utf16_units > 31) return false;
  }
  return utf16_units > 0;
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
      if (value.capability_id == "ae.project.folder.create") {
        arguments = "{\"idempotencyKey\":" + json_string(value.idempotency_key)
            + ",\"name\":" + json_string(value.folder_name) + "}";
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
      } else if (capability == "ae.project.folder.create") {
        if (!exact_keys(
                *arguments,
                {"name", "idempotencyKey"},
                {"name", "idempotencyKey"})) {
          invalid_argument("project folder create arguments are not closed");
        }
        result.folder_name = required_string(
            *arguments, "name", CodecErrorKind::kInvalidArgument);
        result.idempotency_key = required_string(
            *arguments, "idempotencyKey", CodecErrorKind::kInvalidArgument);
        if (!valid_folder_name(result.folder_name)) {
          invalid_argument("project folder name violates the host name contract");
        }
        if (!valid_idempotency_key(result.idempotency_key)) {
          invalid_argument("invalid project folder idempotency key");
        }
        const std::string canonical_arguments = "{\"idempotencyKey\":"
            + json_string(result.idempotency_key) + ",\"name\":"
            + json_string(result.folder_name) + "}";
        result.arguments_fingerprint_sha256 = sha256_hex(canonical_arguments);
      } else {
        invalid_argument("invoke is not in the compile-time allowlist");
      }
      request.params = std::move(result);
    } else {
      if (!exact_keys(*params, {"targetRequestId"}, {"targetRequestId"})) {
        invalid_argument("invalid cancel params");
      }
      CancelParams result;
      result.target_request_id = required_string(
          *params, "targetRequestId", CodecErrorKind::kInvalidArgument);
      if (!valid_request_id(result.target_request_id)) invalid_argument("invalid cancel target ID");
      request.params = std::move(result);
    }
  }
  request.request_fingerprint_sha256 = sha256_hex(canonical_request(request));
  return request;
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

std::string digest_project_folder_arguments(
    std::string_view name,
    std::string_view idempotency_key) {
  if (!valid_folder_name(name) || !valid_idempotency_key(idempotency_key)) {
    invalid_argument("invalid project folder arguments digest input");
  }
  return sha256_hex("{\"idempotencyKey\":" + json_string(idempotency_key)
      + ",\"name\":" + json_string(name) + "}");
}

std::string digest_project_folder_postcondition(
    std::int64_t folder_item_id,
    std::string_view folder_name,
    std::int64_t parent_item_id,
    std::int64_t item_count_before,
    std::int64_t item_count_after) {
  if (folder_item_id <= 0 || parent_item_id < 0 || item_count_before < 0
      || item_count_before >= static_cast<std::int64_t>(kMaxSafeInteger)
      || item_count_after != item_count_before + 1
      || static_cast<std::uint64_t>(folder_item_id) > kMaxSafeInteger
      || static_cast<std::uint64_t>(parent_item_id) > kMaxSafeInteger
      || static_cast<std::uint64_t>(item_count_after) > kMaxSafeInteger
      || !valid_folder_name(folder_name)) {
    invalid_argument("project folder result violates its postcondition contract");
  }
  const std::string canonical =
      "{\"capabilityId\":\"ae.project.folder.create\",\"capabilityVersion\":1,"
      "\"value\":{\"created\":true,\"folderItemId\":"
      + std::to_string(folder_item_id) + ",\"folderName\":"
      + json_string(folder_name) + ",\"itemCountAfter\":"
      + std::to_string(item_count_after) + ",\"itemCountBefore\":"
      + std::to_string(item_count_before) + ",\"parentItemId\":"
      + std::to_string(parent_item_id) + "}}";
  return sha256_hex(canonical);
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
        && std::holds_alternative<CancelParams>(request.params));
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

std::string project_folder_create_descriptor(const CapabilitiesSuccess& response) {
  const std::string detail = response.detail == CapabilityDetail::kFull ? "full" : "summary";
  std::string descriptor = "{\"cancellation\":\"before-dispatch\","
      "\"compatibility\":{\"intendedPlatforms\":[\"macos-arm64\",\"windows-x64\"],"
      "\"status\":\"unverified\"},\"detail\":" + json_string(detail)
      + ",\"id\":\"ae.project.folder.create\",\"idempotency\":\"idempotency-key\","
        "\"mutability\":\"mutating\",\"preconditions\":["
      + json_string("An After Effects project must be open.")
      + "],\"risk\":\"write\",\"schemaVersion\":1,\"sideEffectSummary\":"
      + json_string("Creates one root project folder and one After Effects undo step.")
      + ",\"summary\":"
      + json_string("Create one folder at the root of the open After Effects project.")
      + ",\"undo\":\"ae-undo-group\",\"version\":1";
  if (response.detail == CapabilityDetail::kFull) {
    require_digest(response.project_folder_create_contract_digest, "contract digest");
    descriptor += ",\"contractDigest\":"
        + json_string(response.project_folder_create_contract_digest)
        + ",\"examples\":[{\"arguments\":{\"idempotencyKey\":"
        + json_string("synthetic-folder-0001") + ",\"name\":"
        + json_string("AI Assets")
        + "},\"expected\":{\"outcome\":\"succeeded\",\"value\":{"
          "\"created\":true,\"folderItemId\":101,\"folderName\":\"AI Assets\","
          "\"itemCountAfter\":3,\"itemCountBefore\":2,\"parentItemId\":1}},"
          "\"id\":\"aemcp-example-project-folder-create\",\"kind\":\"positive\","
          "\"summary\":"
        + json_string("Create one synthetic root project folder.")
        + "},{\"arguments\":{\"idempotencyKey\":"
        + json_string("synthetic-folder-0002") + ",\"name\":"
        + json_string("AI Assets")
        + "},\"expected\":{\"errorCode\":\"PRECONDITION_FAILED\","
          "\"recoveryAction\":\"open-project\"},"
          "\"id\":\"aemcp-example-project-folder-no-project\",\"kind\":\"negative\","
          "\"summary\":"
        + json_string("Require an open project before native mutation.")
        + "}],\"inputContractId\":\"aemcp.contract.ae.project.folder.create.input.v1\","
          "\"inputSchema\":{\"additionalProperties\":false,\"properties\":{"
          "\"idempotencyKey\":{\"maxLength\":64,\"minLength\":16,"
          "\"pattern\":\"^[A-Za-z0-9][A-Za-z0-9._:-]*$\",\"type\":\"string\"},"
          "\"name\":{\"maxLength\":31,\"minLength\":1,"
          "\"pattern\":\"^[^\\u0000-\\u001f\\u007f]+$\",\"type\":\"string\","
          "\"x-lengthUnit\":\"utf-16-code-units\",\"x-maximumUtf16CodeUnits\":31}},"
          "\"required\":[\"name\",\"idempotencyKey\"],\"type\":\"object\","
          "\"x-invariant\":\"name-must-not-exceed-31-utf16-code-units\"},"
          "\"requirements\":[{\"contractVersion\":1,"
          "\"id\":\"aemcp.requirement.native.project-folder-create\"}],"
          "\"resultContractId\":\"aemcp.contract.ae.project.folder.create.result.v1\","
          "\"resultSchema\":{\"additionalProperties\":false,\"properties\":{"
          "\"created\":{\"const\":true},"
          "\"folderItemId\":{\"maximum\":9007199254740991,\"minimum\":1,"
          "\"type\":\"integer\"},"
          "\"folderName\":{\"maxLength\":31,\"minLength\":1,\"type\":\"string\","
          "\"x-lengthUnit\":\"utf-16-code-units\",\"x-maximumUtf16CodeUnits\":31},"
          "\"itemCountAfter\":{\"maximum\":9007199254740991,\"minimum\":0,"
          "\"type\":\"integer\"},"
          "\"itemCountBefore\":{\"maximum\":9007199254740991,\"minimum\":0,"
          "\"type\":\"integer\"},"
          "\"parentItemId\":{\"maximum\":9007199254740991,\"minimum\":0,"
          "\"type\":\"integer\"}},"
          "\"required\":[\"created\",\"folderItemId\",\"folderName\","
          "\"parentItemId\",\"itemCountBefore\",\"itemCountAfter\"],"
          "\"type\":\"object\","
          "\"x-invariant\":\"itemCountAfter-must-equal-itemCountBefore-plus-one\"}";
  }
  descriptor.push_back('}');
  return descriptor;
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
  if (response.include_project_folder_create) {
    if (needs_comma) items.push_back(',');
    items += project_folder_create_descriptor(response);
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

std::vector<std::uint8_t> encode_project_folder_create_success(
    const ProjectFolderCreateSuccess& response) {
  require_request_id(response.request_id);
  require_uuid(response.session_id, "session ID");
  require_uuid(response.host_instance_id, "host instance ID");
  require_digest(response.request_digest, "request digest");
  require_digest(response.postcondition_digest, "postcondition digest");
  if (response.replayed || !valid_folder_name(response.folder_name)
      || response.folder_item_id <= 0 || response.parent_item_id < 0
      || response.item_count_before < 0
      || response.item_count_before >= static_cast<std::int64_t>(kMaxSafeInteger)
      || response.item_count_after != response.item_count_before + 1
      || static_cast<std::uint64_t>(response.folder_item_id) > kMaxSafeInteger
      || static_cast<std::uint64_t>(response.parent_item_id) > kMaxSafeInteger
      || response.started_at_unix_ms < 1
      || response.started_at_unix_ms > kMaxSafeInteger
      || response.completed_at_unix_ms < response.started_at_unix_ms
      || response.completed_at_unix_ms > kMaxSafeInteger) {
    invalid_argument("invalid or unvalidated project folder create evidence");
  }
  std::string json = "{\"kind\":\"response\",\"method\":\"invoke\",\"ok\":true,"
      "\"replayed\":false,\"requestId\":" + json_string(response.request_id)
      + ",\"result\":{\"capabilityId\":\"ae.project.folder.create\","
        "\"capabilityVersion\":1,\"engine\":\"native-aegp\",\"evidence\":{"
        "\"capabilityId\":\"ae.project.folder.create\",\"capabilityVersion\":1,"
        "\"completedAtUnixMs\":" + std::to_string(response.completed_at_unix_ms)
      + ",\"effect\":\"committed\",\"engine\":\"native-aegp\","
        "\"hostInstanceId\":" + json_string(response.host_instance_id)
      + ",\"postcondition\":{\"algorithm\":\"sha256-rfc8785-jcs-v1\","
        "\"digest\":" + json_string(response.postcondition_digest)
      + ",\"kind\":\"project-folder-created\",\"verified\":true},"
        "\"requestDigest\":" + json_string(response.request_digest)
      + ",\"requestId\":" + json_string(response.request_id)
      + ",\"sessionId\":" + json_string(response.session_id)
      + ",\"startedAtUnixMs\":" + std::to_string(response.started_at_unix_ms)
      + ",\"undo\":{\"available\":true,\"verified\":true}},"
        "\"outcome\":\"succeeded\",\"value\":{\"created\":true,"
        "\"folderItemId\":" + std::to_string(response.folder_item_id)
      + ",\"folderName\":" + json_string(response.folder_name)
      + ",\"itemCountAfter\":" + std::to_string(response.item_count_after)
      + ",\"itemCountBefore\":" + std::to_string(response.item_count_before)
      + ",\"parentItemId\":" + std::to_string(response.parent_item_id)
      + "}},\"sessionId\":" + json_string(response.session_id)
      + ",\"wireVersion\":1}";
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
  std::string recovery = "{\"action\":" + json_string(policy.recovery)
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
