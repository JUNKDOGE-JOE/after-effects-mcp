#include <windows.h>
#include <wincred.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <winver.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::IJsonValue;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;
using winrt::Windows::Data::Json::JsonValueType;

constexpr wchar_t kPipeName[] = LR"(\\.\pipe\com.junkdoge.ae-mcp.platform-helper)";
constexpr wchar_t kMutexName[] = LR"(Local\com.junkdoge.ae-mcp.platform-helper)";
constexpr wchar_t kCredentialPrefix[] = L"com.junkdoge.ae-mcp/provider:";
constexpr std::uint32_t kMaximumMessageBytes = 65536;
constexpr std::uint32_t kCredentialMagic = 0x3150434d;
constexpr std::size_t kMaximumAncestryDepth = 32;

class HelperFailure final : public std::runtime_error {
 public:
  HelperFailure(std::string code, std::string message, bool retryable)
      : std::runtime_error(std::move(message)), code_(std::move(code)), retryable_(retryable) {}

  const std::string& code() const { return code_; }
  bool retryable() const { return retryable_; }

 private:
  std::string code_;
  bool retryable_;
};

class ScopedHandle final {
 public:
  explicit ScopedHandle(HANDLE value = nullptr) : value_(value) {}
  ~ScopedHandle() { reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : value_(other.release()) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  HANDLE get() const { return value_; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }
  explicit operator bool() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }

 private:
  HANDLE value_;
};

std::wstring FromUtf8(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw HelperFailure("INVALID_REQUEST", "request is not valid UTF-8", false);
  std::wstring result(size, L'\0');
  if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
          result.data(), size) != size) {
    throw HelperFailure("INVALID_REQUEST", "request is not valid UTF-8", false);
  }
  return result;
}

std::string ToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw HelperFailure("HELPER_UNAVAILABLE", "UTF-8 conversion failed", true);
  std::string result(size, '\0');
  if (WideCharToMultiByte(
          CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
          result.data(), size, nullptr, nullptr) != size) {
    throw HelperFailure("HELPER_UNAVAILABLE", "UTF-8 conversion failed", true);
  }
  return result;
}

std::wstring Lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return value;
}

JsonValue StringValue(const std::string& value) {
  return JsonValue::CreateStringValue(winrt::to_hstring(value));
}

JsonValue NumberValue(std::uint64_t value) {
  return JsonValue::CreateNumberValue(static_cast<double>(value));
}

std::string JsonString(const JsonObject& object, const wchar_t* key) {
  if (!object.HasKey(key)) throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  const auto value = object.GetNamedValue(key);
  if (value.ValueType() != JsonValueType::String) {
    throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  }
  return winrt::to_string(value.GetString());
}

std::uint64_t JsonPositiveInteger(const JsonObject& object, const wchar_t* key) {
  if (!object.HasKey(key)) throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  const auto value = object.GetNamedValue(key);
  if (value.ValueType() != JsonValueType::Number) {
    throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  }
  const double number = value.GetNumber();
  if (!std::isfinite(number) || number < 1 || std::floor(number) != number
      || number > 9007199254740991.0) {
    throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  }
  return static_cast<std::uint64_t>(number);
}

bool ExactKeys(const JsonObject& object, std::initializer_list<const wchar_t*> expected) {
  if (object.Size() != expected.size()) return false;
  for (const wchar_t* key : expected) {
    if (!object.HasKey(key)) return false;
  }
  return true;
}

JsonObject ParseObject(const std::string& bytes) {
  try {
    return JsonObject::Parse(winrt::to_hstring(bytes));
  } catch (...) {
    throw HelperFailure("INVALID_REQUEST", "request JSON is invalid", false);
  }
}

std::string SerializeSuccess(std::uint64_t id, const IJsonValue& result) {
  JsonObject response;
  response.Insert(L"protocolVersion", NumberValue(1));
  response.Insert(L"id", NumberValue(id));
  response.Insert(L"ok", JsonValue::CreateBooleanValue(true));
  response.Insert(L"result", result);
  return winrt::to_string(response.Stringify());
}

std::string SerializeFailure(std::uint64_t id, const HelperFailure& failure) {
  JsonObject error;
  error.Insert(L"code", StringValue(failure.code()));
  error.Insert(L"message", StringValue(failure.what()));
  error.Insert(L"retryable", JsonValue::CreateBooleanValue(failure.retryable()));
  JsonObject response;
  response.Insert(L"protocolVersion", NumberValue(1));
  response.Insert(L"id", NumberValue((std::max<std::uint64_t>)(1, id)));
  response.Insert(L"ok", JsonValue::CreateBooleanValue(false));
  response.Insert(L"error", error.as<IJsonValue>());
  return winrt::to_string(response.Stringify());
}

std::uint64_t BestEffortId(const std::string& bytes) {
  if (bytes.size() > kMaximumMessageBytes) return 1;
  try {
    const JsonObject object = ParseObject(bytes);
    return JsonPositiveInteger(object, L"id");
  } catch (...) {
    return 1;
  }
}

std::wstring SidForToken(HANDLE token) {
  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller identity is unavailable", false);
  }
  std::vector<std::uint8_t> buffer(bytes);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), bytes, &bytes)) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller identity is unavailable", false);
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  LPWSTR raw = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &raw)) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller identity is unavailable", false);
  }
  std::wstring sid(raw);
  LocalFree(raw);
  return sid;
}

std::wstring CurrentUserSid() {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) {
    throw HelperFailure("HELPER_UNAVAILABLE", "helper identity is unavailable", true);
  }
  ScopedHandle token(raw);
  return SidForToken(token.get());
}

std::uint64_t FileTimeValue(const FILETIME& value) {
  ULARGE_INTEGER integer{};
  integer.LowPart = value.dwLowDateTime;
  integer.HighPart = value.dwHighDateTime;
  return integer.QuadPart;
}

DWORD ParentProcessId(DWORD processId) {
  ScopedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) throw HelperFailure("HELPER_UNAUTHORIZED", "caller ancestry is unavailable", false);
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.get(), &entry)) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller ancestry is unavailable", false);
  }
  do {
    if (entry.th32ProcessID == processId) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.get(), &entry));
  throw HelperFailure("HELPER_UNAUTHORIZED", "caller ancestry is unavailable", false);
}

struct ProcessSnapshot {
  DWORD processId{};
  DWORD parentProcessId{};
  std::uint64_t creationTime{};
  std::wstring imagePath;
  std::wstring userSid;

  bool operator==(const ProcessSnapshot& other) const {
    return processId == other.processId && parentProcessId == other.parentProcessId
        && creationTime == other.creationTime && imagePath == other.imagePath
        && userSid == other.userSid;
  }
};

ProcessSnapshot InspectProcess(DWORD processId) {
  ScopedHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId));
  if (!process) throw HelperFailure("HELPER_UNAUTHORIZED", "caller process is unavailable", false);

  DWORD pathLength = 32768;
  std::wstring imagePath(pathLength, L'\0');
  if (!QueryFullProcessImageNameW(process.get(), 0, imagePath.data(), &pathLength)) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller image is unavailable", false);
  }
  imagePath.resize(pathLength);

  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process.get(), &created, &exited, &kernel, &user)) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller generation is unavailable", false);
  }

  USHORT processMachine = IMAGE_FILE_MACHINE_UNKNOWN;
  USHORT nativeMachine = IMAGE_FILE_MACHINE_UNKNOWN;
  if (!IsWow64Process2(process.get(), &processMachine, &nativeMachine)
      || processMachine != IMAGE_FILE_MACHINE_UNKNOWN
      || nativeMachine != IMAGE_FILE_MACHINE_AMD64) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller architecture is unsupported", false);
  }

  HANDLE rawToken = nullptr;
  if (!OpenProcessToken(process.get(), TOKEN_QUERY, &rawToken)) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller token is unavailable", false);
  }
  ScopedHandle token(rawToken);
  return ProcessSnapshot{
      processId,
      ParentProcessId(processId),
      FileTimeValue(created),
      std::move(imagePath),
      SidForToken(token.get()),
  };
}

bool ValidAuthenticodeSignature(const std::wstring& imagePath) {
  WINTRUST_FILE_INFO file{};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = imagePath.c_str();
  WINTRUST_DATA trust{};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(nullptr, &action, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &action, &trust);
  return status == ERROR_SUCCESS;
}

std::wstring SignerOrganization(const std::wstring& imagePath) {
  HCERTSTORE store = nullptr;
  HCRYPTMSG message = nullptr;
  DWORD encoding = 0;
  DWORD content = 0;
  DWORD format = 0;
  if (!CryptQueryObject(
          CERT_QUERY_OBJECT_FILE, imagePath.c_str(),
          CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
          CERT_QUERY_FORMAT_FLAG_BINARY, 0, &encoding, &content, &format,
          &store, &message, nullptr)) {
    return {};
  }
  DWORD signerBytes = 0;
  CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, nullptr, &signerBytes);
  std::vector<std::uint8_t> signerBuffer(signerBytes);
  std::wstring organization;
  if (signerBytes > 0
      && CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, signerBuffer.data(), &signerBytes)) {
    const auto* signer = reinterpret_cast<const CMSG_SIGNER_INFO*>(signerBuffer.data());
    CERT_INFO certificateInfo{};
    certificateInfo.Issuer = signer->Issuer;
    certificateInfo.SerialNumber = signer->SerialNumber;
    PCCERT_CONTEXT certificate = CertFindCertificateInStore(
        store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0, CERT_FIND_SUBJECT_CERT,
        &certificateInfo, nullptr);
    if (certificate != nullptr) {
      wchar_t name[512]{};
      const DWORD length = CertGetNameStringW(
          certificate, CERT_NAME_ATTR_TYPE, 0,
          const_cast<char*>(szOID_ORGANIZATION_NAME), name, 512);
      if (length > 1) organization.assign(name, length - 1);
      CertFreeCertificateContext(certificate);
    }
  }
  if (message != nullptr) CryptMsgClose(message);
  if (store != nullptr) CertCloseStore(store, 0);
  return organization;
}

int FileVersionMajor(const std::wstring& imagePath) {
  DWORD ignored = 0;
  const DWORD size = GetFileVersionInfoSizeW(imagePath.c_str(), &ignored);
  if (size == 0) return 0;
  std::vector<std::uint8_t> data(size);
  if (!GetFileVersionInfoW(imagePath.c_str(), 0, size, data.data())) return 0;
  VS_FIXEDFILEINFO* info = nullptr;
  UINT infoBytes = 0;
  if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &infoBytes)
      || info == nullptr || infoBytes < sizeof(VS_FIXEDFILEINFO)) {
    return 0;
  }
  return HIWORD(info->dwFileVersionMS);
}

void RequireAdobeProcess(const ProcessSnapshot& process, const std::wstring& expectedName) {
  if (Lower(std::filesystem::path(process.imagePath).filename().wstring()) != Lower(expectedName)
      || !ValidAuthenticodeSignature(process.imagePath)
      || SignerOrganization(process.imagePath) != L"Adobe Inc.") {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller signature is not trusted", false);
  }
}

ProcessSnapshot AuthorizeAdobeAncestry(DWORD processId) {
  const std::wstring currentSid = CurrentUserSid();
  std::vector<ProcessSnapshot> ancestry;
  bool foundAfterEffects = false;
  for (std::size_t depth = 0; depth < kMaximumAncestryDepth && processId > 1; ++depth) {
    ProcessSnapshot process = InspectProcess(processId);
    if (process.userSid != currentSid) {
      throw HelperFailure("HELPER_UNAUTHORIZED", "caller user does not match", false);
    }
    const std::wstring name = Lower(std::filesystem::path(process.imagePath).filename().wstring());
    if (name == L"afterfx.exe") {
      RequireAdobeProcess(process, L"AfterFX.exe");
      const int major = FileVersionMajor(process.imagePath);
      if (major != 25 && major != 26) {
        throw HelperFailure("HELPER_UNAUTHORIZED", "After Effects version is unsupported", false);
      }
      ancestry.push_back(std::move(process));
      foundAfterEffects = true;
      break;
    }
    RequireAdobeProcess(process, L"CEPHtmlEngine.exe");
    processId = process.parentProcessId;
    ancestry.push_back(std::move(process));
  }
  if (!foundAfterEffects || ancestry.empty()) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller is not hosted by After Effects", false);
  }
  for (const ProcessSnapshot& expected : ancestry) {
    if (!(InspectProcess(expected.processId) == expected)) {
      throw HelperFailure("HELPER_UNAUTHORIZED", "caller process changed during authorization", false);
    }
  }
  return ancestry.back();
}

ProcessSnapshot AuthorizeCaller(HANDLE pipe) {
  ULONG clientId = 0;
  if (!GetNamedPipeClientProcessId(pipe, &clientId) || clientId <= 1) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "caller identity is unavailable", false);
  }
  return AuthorizeAdobeAncestry(clientId);
}

struct OwnerWatch {
  DWORD processId{};
  HANDLE process{};
};

std::mutex ownerMutex;
std::vector<DWORD> ownerProcessIds;
bool ownerShutdownStarted = false;

DWORD WINAPI WatchAfterEffectsOwner(void* raw) {
  std::unique_ptr<OwnerWatch> watch(static_cast<OwnerWatch*>(raw));
  ScopedHandle process(watch->process);
  WaitForSingleObject(process.get(), INFINITE);

  bool exitHelper = false;
  {
    std::lock_guard lock(ownerMutex);
    ownerProcessIds.erase(
        std::remove(ownerProcessIds.begin(), ownerProcessIds.end(), watch->processId),
        ownerProcessIds.end());
    if (ownerProcessIds.empty() && !ownerShutdownStarted) {
      ownerShutdownStarted = true;
      exitHelper = true;
    }
  }
  if (exitHelper) ExitProcess(0);
  return 0;
}

void RegisterAfterEffectsOwner(const ProcessSnapshot& owner) {
  ScopedHandle process(OpenProcess(SYNCHRONIZE, FALSE, owner.processId));
  if (!process) {
    throw HelperFailure("HELPER_UNAUTHORIZED", "After Effects owner is unavailable", false);
  }

  auto watch = std::make_unique<OwnerWatch>();
  watch->processId = owner.processId;
  watch->process = process.get();
  std::lock_guard lock(ownerMutex);
  if (ownerShutdownStarted) {
    throw HelperFailure("HELPER_UNAVAILABLE", "platform helper is shutting down", true);
  }
  if (std::find(ownerProcessIds.begin(), ownerProcessIds.end(), owner.processId)
      != ownerProcessIds.end()) {
    return;
  }
  ownerProcessIds.push_back(owner.processId);
  HANDLE thread = CreateThread(nullptr, 0, WatchAfterEffectsOwner, watch.get(), 0, nullptr);
  if (thread == nullptr) {
    ownerProcessIds.erase(
        std::remove(ownerProcessIds.begin(), ownerProcessIds.end(), owner.processId),
        ownerProcessIds.end());
    throw HelperFailure("HELPER_UNAVAILABLE", "After Effects owner monitor is unavailable", true);
  }
  process.release();
  watch.release();
  CloseHandle(thread);
}

struct SecretReference {
  std::string raw;
  std::wstring target;
};

SecretReference ParseSecretReference(const std::string& raw) {
  static const std::regex pattern(
      R"(^aemcp-secret://provider/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/([a-z][a-z0-9_-]{0,31})/v1$)");
  std::smatch match;
  if (!std::regex_match(raw, match, pattern)) {
    throw HelperFailure("INVALID_REFERENCE", "secret reference is invalid", false);
  }
  return SecretReference{
      raw,
      std::wstring(kCredentialPrefix) + FromUtf8(match[1].str()) + L":"
          + FromUtf8(match[2].str()) + L":v1",
  };
}

struct SecretRecord {
  std::uint64_t revision{};
  std::string value;
};

void Append32(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
  for (int shift = 0; shift < 32; shift += 8) bytes.push_back(static_cast<std::uint8_t>(value >> shift));
}

void Append64(std::vector<std::uint8_t>& bytes, std::uint64_t value) {
  for (int shift = 0; shift < 64; shift += 8) bytes.push_back(static_cast<std::uint8_t>(value >> shift));
}

std::uint32_t Read32(const std::uint8_t* bytes) {
  return static_cast<std::uint32_t>(bytes[0])
      | (static_cast<std::uint32_t>(bytes[1]) << 8)
      | (static_cast<std::uint32_t>(bytes[2]) << 16)
      | (static_cast<std::uint32_t>(bytes[3]) << 24);
}

std::uint64_t Read64(const std::uint8_t* bytes) {
  std::uint64_t value = 0;
  for (int shift = 0; shift < 64; shift += 8) value |= static_cast<std::uint64_t>(bytes[shift / 8]) << shift;
  return value;
}

std::vector<std::uint8_t> EncodeSecret(const SecretRecord& record) {
  if (record.value.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE - 20) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "credential is too large for the Windows credential store", false);
  }
  std::vector<std::uint8_t> bytes;
  bytes.reserve(20 + record.value.size());
  Append32(bytes, kCredentialMagic);
  Append32(bytes, 1);
  Append64(bytes, record.revision);
  Append32(bytes, static_cast<std::uint32_t>(record.value.size()));
  bytes.insert(bytes.end(), record.value.begin(), record.value.end());
  return bytes;
}

SecretRecord DecodeSecret(const CREDENTIALW& credential) {
  const auto* bytes = credential.CredentialBlob;
  const std::size_t size = credential.CredentialBlobSize;
  if (bytes == nullptr || size < 20 || Read32(bytes) != kCredentialMagic || Read32(bytes + 4) != 1) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "credential record is invalid", false);
  }
  const std::uint64_t revision = Read64(bytes + 8);
  const std::uint32_t valueSize = Read32(bytes + 16);
  if (revision == 0 || valueSize != size - 20) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "credential record is invalid", false);
  }
  return SecretRecord{revision, std::string(reinterpret_cast<const char*>(bytes + 20), valueSize)};
}

std::optional<SecretRecord> ReadSecret(const SecretReference& reference) {
  PCREDENTIALW raw = nullptr;
  if (!CredReadW(reference.target.c_str(), CRED_TYPE_GENERIC, 0, &raw)) {
    if (GetLastError() == ERROR_NOT_FOUND) return std::nullopt;
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "Windows credential store is unavailable", true);
  }
  std::unique_ptr<CREDENTIALW, decltype(&CredFree)> credential(raw, CredFree);
  return DecodeSecret(*credential);
}

void WriteSecret(const SecretReference& reference, const SecretRecord& record) {
  std::vector<std::uint8_t> blob = EncodeSecret(record);
  CREDENTIALW credential{};
  credential.Type = CRED_TYPE_GENERIC;
  credential.TargetName = const_cast<LPWSTR>(reference.target.c_str());
  credential.CredentialBlobSize = static_cast<DWORD>(blob.size());
  credential.CredentialBlob = blob.data();
  credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
  credential.UserName = const_cast<LPWSTR>(L"ae-mcp-provider");
  if (!CredWriteW(&credential, 0)) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "Windows credential store write failed", true);
  }
}

std::mutex credentialMutex;

std::optional<std::uint64_t> OptionalRevision(const JsonObject& params, const wchar_t* key) {
  if (!params.HasKey(key)) return std::nullopt;
  const auto value = params.GetNamedValue(key);
  if (value.ValueType() == JsonValueType::Null) return std::nullopt;
  return JsonPositiveInteger(params, key);
}

IJsonValue SecretGet(const JsonObject& params) {
  if (!ExactKeys(params, {L"reference"})) {
    throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  }
  const SecretReference reference = ParseSecretReference(JsonString(params, L"reference"));
  std::lock_guard lock(credentialMutex);
  const auto record = ReadSecret(reference);
  if (!record) throw HelperFailure("SECRET_NOT_FOUND", "secret was not found", false);
  JsonObject result;
  result.Insert(L"reference", StringValue(reference.raw));
  result.Insert(L"value", StringValue(record->value));
  result.Insert(L"revision", NumberValue(record->revision));
  return result.as<IJsonValue>();
}

IJsonValue SecretSet(const JsonObject& params) {
  if (!ExactKeys(params, {L"reference", L"value", L"expectedRevision"})) {
    throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  }
  const SecretReference reference = ParseSecretReference(JsonString(params, L"reference"));
  const std::string value = JsonString(params, L"value");
  const auto expected = OptionalRevision(params, L"expectedRevision");
  std::lock_guard lock(credentialMutex);
  const auto previous = ReadSecret(reference);
  std::uint64_t revision = 1;
  if (previous) {
    if (!expected || *expected != previous->revision
        || previous->revision == (std::numeric_limits<std::uint64_t>::max)()) {
      throw HelperFailure("SECRET_CONFLICT", "secret revision does not match", false);
    }
    revision = previous->revision + 1;
  } else if (expected) {
    throw HelperFailure("SECRET_CONFLICT", "secret revision does not match", false);
  }
  WriteSecret(reference, SecretRecord{revision, value});
  const auto readback = ReadSecret(reference);
  if (!readback || readback->revision != revision || readback->value != value) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "credential write verification failed", false);
  }
  JsonObject result;
  result.Insert(L"reference", StringValue(reference.raw));
  result.Insert(L"revision", NumberValue(revision));
  return result.as<IJsonValue>();
}

IJsonValue SecretDelete(const JsonObject& params) {
  if (!(ExactKeys(params, {L"reference"})
        || ExactKeys(params, {L"reference", L"expectedRevision"}))) {
    throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
  }
  const SecretReference reference = ParseSecretReference(JsonString(params, L"reference"));
  const auto expected = OptionalRevision(params, L"expectedRevision");
  std::lock_guard lock(credentialMutex);
  const auto previous = ReadSecret(reference);
  JsonObject result;
  result.Insert(L"reference", StringValue(reference.raw));
  if (!previous) {
    result.Insert(L"deleted", JsonValue::CreateBooleanValue(false));
    result.Insert(L"revision", JsonValue::CreateNullValue());
    return result.as<IJsonValue>();
  }
  if (expected && *expected != previous->revision) {
    throw HelperFailure("SECRET_CONFLICT", "secret revision does not match", false);
  }
  if (!CredDeleteW(reference.target.c_str(), CRED_TYPE_GENERIC, 0)) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "Windows credential store delete failed", true);
  }
  if (ReadSecret(reference)) {
    throw HelperFailure("SECRET_STORE_UNAVAILABLE", "credential delete verification failed", false);
  }
  result.Insert(L"deleted", JsonValue::CreateBooleanValue(true));
  result.Insert(L"revision", NumberValue(previous->revision));
  return result.as<IJsonValue>();
}

IJsonValue Capabilities() {
  JsonArray methods;
  for (const char* method : {
           "capabilities", "secret.get", "secret.set", "secret.delete",
           "window.find", "window.describe", "window.capture"}) {
    methods.Append(StringValue(method));
  }
  JsonObject result;
  result.Insert(L"protocolVersion", NumberValue(1));
  result.Insert(L"platform", StringValue("windows-x64"));
  result.Insert(L"helperVersion", StringValue("0.9.1"));
  result.Insert(L"secretBackend", StringValue("credential-manager"));
  result.Insert(L"captureBackend", StringValue("windows-graphics-capture"));
  result.Insert(L"authenticatedCaller", JsonValue::CreateBooleanValue(true));
  result.Insert(L"maxMessageBytes", NumberValue(kMaximumMessageBytes));
  result.Insert(L"methods", methods.as<IJsonValue>());
  return result.as<IJsonValue>();
}

std::string Dispatch(const std::string& bytes) {
  if (bytes.size() > kMaximumMessageBytes) {
    return SerializeFailure(1, HelperFailure("MESSAGE_TOO_LARGE", "request exceeds 65536 bytes", false));
  }
  std::uint64_t id = BestEffortId(bytes);
  try {
    const JsonObject request = ParseObject(bytes);
    if (!ExactKeys(request, {L"protocolVersion", L"id", L"method", L"params"})
        || JsonPositiveInteger(request, L"protocolVersion") != 1) {
      throw HelperFailure("PROTOCOL_VERSION_UNSUPPORTED", "protocol version is unsupported", false);
    }
    id = JsonPositiveInteger(request, L"id");
    const std::string method = JsonString(request, L"method");
    const auto paramsValue = request.GetNamedValue(L"params");
    if (paramsValue.ValueType() != JsonValueType::Object) {
      throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
    }
    const JsonObject params = paramsValue.GetObject();
    if (method == "capabilities") {
      if (!ExactKeys(params, {})) throw HelperFailure("INVALID_REQUEST", "request parameters are invalid", false);
      return SerializeSuccess(id, Capabilities());
    }
    if (method == "secret.get") return SerializeSuccess(id, SecretGet(params));
    if (method == "secret.set") return SerializeSuccess(id, SecretSet(params));
    if (method == "secret.delete") return SerializeSuccess(id, SecretDelete(params));
    if (method == "window.find" || method == "window.describe" || method == "window.capture") {
      throw HelperFailure("HELPER_UNAVAILABLE", "window capture is not available in this helper build", true);
    }
    throw HelperFailure("INVALID_REQUEST", "unknown helper method", false);
  } catch (const HelperFailure& failure) {
    return SerializeFailure(id, failure);
  } catch (...) {
    return SerializeFailure(id, HelperFailure("HELPER_UNAVAILABLE", "platform helper failed", true));
  }
}

bool ReadExact(HANDLE pipe, void* destination, std::size_t size) {
  auto* cursor = static_cast<std::uint8_t*>(destination);
  while (size > 0) {
    DWORD read = 0;
    if (!ReadFile(pipe, cursor, static_cast<DWORD>(size), &read, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA) return false;
      throw HelperFailure("HELPER_UNAVAILABLE", "named-pipe read failed", true);
    }
    if (read == 0) return false;
    cursor += read;
    size -= read;
  }
  return true;
}

void WriteExact(HANDLE pipe, const void* source, std::size_t size) {
  const auto* cursor = static_cast<const std::uint8_t*>(source);
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(pipe, cursor, static_cast<DWORD>(size), &written, nullptr) || written == 0) {
      throw HelperFailure("HELPER_UNAVAILABLE", "named-pipe write failed", true);
    }
    cursor += written;
    size -= written;
  }
}

bool ReadFrame(HANDLE pipe, std::string& result) {
  std::array<std::uint8_t, 4> prefix{};
  if (!ReadExact(pipe, prefix.data(), prefix.size())) return false;
  const std::uint32_t size = Read32(prefix.data());
  if (size > kMaximumMessageBytes) {
    throw HelperFailure("MESSAGE_TOO_LARGE", "request exceeds 65536 bytes", false);
  }
  result.assign(size, '\0');
  return size == 0 || ReadExact(pipe, result.data(), size);
}

void WriteFrame(HANDLE pipe, const std::string& value) {
  if (value.size() > kMaximumMessageBytes) {
    throw HelperFailure("MESSAGE_TOO_LARGE", "response exceeds 65536 bytes", false);
  }
  const std::uint32_t size = static_cast<std::uint32_t>(value.size());
  const std::array<std::uint8_t, 4> prefix = {
      static_cast<std::uint8_t>(size), static_cast<std::uint8_t>(size >> 8),
      static_cast<std::uint8_t>(size >> 16), static_cast<std::uint8_t>(size >> 24)};
  WriteExact(pipe, prefix.data(), prefix.size());
  if (!value.empty()) WriteExact(pipe, value.data(), value.size());
}

void HandleClient(HANDLE pipe) {
  try {
    RegisterAfterEffectsOwner(AuthorizeCaller(pipe));
  } catch (const HelperFailure& failure) {
    std::string request;
    if (ReadFrame(pipe, request)) WriteFrame(pipe, SerializeFailure(BestEffortId(request), failure));
    return;
  }
  std::string request;
  while (ReadFrame(pipe, request)) WriteFrame(pipe, Dispatch(request));
}

PSECURITY_DESCRIPTOR PipeSecurityDescriptor() {
  const std::wstring sddl = L"D:P(A;;GA;;;" + CurrentUserSid() + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
    throw HelperFailure("HELPER_UNAVAILABLE", "named-pipe security could not be created", true);
  }
  return descriptor;
}

int RunService() {
  ScopedHandle mutex(CreateMutexW(nullptr, FALSE, kMutexName));
  if (!mutex) return 70;
  if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;

  const DWORD launcherProcessId = ParentProcessId(GetCurrentProcessId());
  RegisterAfterEffectsOwner(AuthorizeAdobeAncestry(launcherProcessId));

  PSECURITY_DESCRIPTOR rawDescriptor = PipeSecurityDescriptor();
  std::unique_ptr<void, decltype(&LocalFree)> descriptor(rawDescriptor, LocalFree);
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.lpSecurityDescriptor = descriptor.get();

  for (;;) {
    ScopedHandle pipe(CreateNamedPipeW(
        kPipeName, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, kMaximumMessageBytes + 4, kMaximumMessageBytes + 4, 0, &security));
    if (!pipe) return 70;
    const BOOL connected = ConnectNamedPipe(pipe.get(), nullptr)
        || GetLastError() == ERROR_PIPE_CONNECTED;
    if (!connected) continue;
    try {
      HandleClient(pipe.get());
    } catch (...) {
    }
    FlushFileBuffers(pipe.get());
    DisconnectNamedPipe(pipe.get());
  }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    return RunService();
  } catch (...) {
    return 70;
  }
}
