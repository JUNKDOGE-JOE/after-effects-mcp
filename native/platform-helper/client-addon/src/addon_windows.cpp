#include "common.hpp"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cwctype>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace aemcp::platform_helper {
namespace {

constexpr wchar_t kPipeName[] = LR"(\\.\pipe\com.junkdoge.ae-mcp.platform-helper)";
constexpr DWORD kRequestTimeoutMs = 10000;

using RequestDeadline = std::chrono::steady_clock::time_point;

std::runtime_error Win32Error(const char* operation, DWORD error) {
  return std::runtime_error(
      std::string(operation) + " failed with Win32 error " + std::to_string(error));
}

std::runtime_error Win32Error(const char* operation) {
  return Win32Error(operation, GetLastError());
}

class ScopedHandle final {
 public:
  explicit ScopedHandle(HANDLE handle) : handle_(handle) {}
  ~ScopedHandle() {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
  }

  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  HANDLE get() const { return handle_; }

 private:
  HANDLE handle_;
};

class ScopedAlgorithm final {
 public:
  explicit ScopedAlgorithm(BCRYPT_ALG_HANDLE value) : value_(value) {}
  ~ScopedAlgorithm() {
    if (value_ != nullptr) BCryptCloseAlgorithmProvider(value_, 0);
  }
  ScopedAlgorithm(const ScopedAlgorithm&) = delete;
  ScopedAlgorithm& operator=(const ScopedAlgorithm&) = delete;
  BCRYPT_ALG_HANDLE get() const { return value_; }

 private:
  BCRYPT_ALG_HANDLE value_{};
};

class ScopedHash final {
 public:
  explicit ScopedHash(BCRYPT_HASH_HANDLE value) : value_(value) {}
  ~ScopedHash() {
    if (value_ != nullptr) BCryptDestroyHash(value_);
  }
  ScopedHash(const ScopedHash&) = delete;
  ScopedHash& operator=(const ScopedHash&) = delete;
  BCRYPT_HASH_HANDLE get() const { return value_; }

 private:
  BCRYPT_HASH_HANDLE value_{};
};

std::wstring FromUtf8(const std::string& value) {
  if (value.empty()) throw std::runtime_error("platform helper server identity is invalid");
  const int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw std::runtime_error("platform helper server identity is invalid");
  std::wstring result(size, L'\0');
  if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
          result.data(), size) != size) {
    throw std::runtime_error("platform helper server identity is invalid");
  }
  return result;
}

std::wstring Lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return value;
}

std::wstring CanonicalFilePath(const std::wstring& path) {
  ScopedHandle file(CreateFileW(
      path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) throw Win32Error("helper identity file open");
  const DWORD required = GetFinalPathNameByHandleW(
      file.get(), nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (required == 0 || required > 32768) throw Win32Error("helper identity path query");
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1, L'\0');
  const DWORD copied = GetFinalPathNameByHandleW(
      file.get(), buffer.data(), static_cast<DWORD>(buffer.size()),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (copied == 0 || copied >= buffer.size()) throw Win32Error("helper identity path query");
  std::wstring result(buffer.data(), copied);
  if (result.starts_with(LR"(\\?\UNC\)")) result = LR"(\\)" + result.substr(8);
  else if (result.starts_with(LR"(\\?\)")) result = result.substr(4);
  return Lower(result);
}

std::array<std::uint8_t, 32> ParseSha256(const std::string& value) {
  if (value.size() != 64) throw std::runtime_error("platform helper server identity is invalid");
  auto hex = [](char character) -> int {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
  };
  std::array<std::uint8_t, 32> result{};
  for (std::size_t index = 0; index < result.size(); ++index) {
    const int high = hex(value[index * 2]);
    const int low = hex(value[index * 2 + 1]);
    if (high < 0 || low < 0) throw std::runtime_error("platform helper server identity is invalid");
    result[index] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return result;
}

std::array<std::uint8_t, 32> Sha256File(const std::wstring& path) {
  ScopedHandle file(CreateFileW(
      path.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) throw Win32Error("helper identity hash open");

  BCRYPT_ALG_HANDLE raw_algorithm{};
  if (BCryptOpenAlgorithmProvider(&raw_algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
    throw std::runtime_error("platform helper server identity verification failed");
  }
  ScopedAlgorithm algorithm(raw_algorithm);
  DWORD object_size = 0;
  DWORD copied = 0;
  if (BCryptGetProperty(
          algorithm.get(), BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &copied, 0) < 0
      || object_size == 0) {
    throw std::runtime_error("platform helper server identity verification failed");
  }
  std::vector<std::uint8_t> hash_object(object_size);
  BCRYPT_HASH_HANDLE raw_hash{};
  if (BCryptCreateHash(
          algorithm.get(), &raw_hash, hash_object.data(), object_size,
          nullptr, 0, 0) < 0) {
    throw std::runtime_error("platform helper server identity verification failed");
  }
  ScopedHash hash(raw_hash);
  std::array<std::uint8_t, 64 * 1024> buffer{};
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(file.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      throw Win32Error("helper identity hash read");
    }
    if (read == 0) break;
    if (BCryptHashData(hash.get(), buffer.data(), read, 0) < 0) {
      throw std::runtime_error("platform helper server identity verification failed");
    }
  }
  std::array<std::uint8_t, 32> digest{};
  if (BCryptFinishHash(hash.get(), digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
    throw std::runtime_error("platform helper server identity verification failed");
  }
  return digest;
}

std::wstring ProcessImagePath(HANDLE process) {
  std::wstring path(32768, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process, 0, path.data(), &size) || size == 0) {
    throw Win32Error("named-pipe server image query");
  }
  path.resize(size);
  return path;
}

void AuthenticateServer(
    HANDLE pipe,
    const PlatformTransportOptions& options) {
  const std::wstring expected_path = FromUtf8(options.expected_server_path);
  const auto expected_hash = ParseSha256(options.expected_server_sha256);
  DWORD process_id = 0;
  if (!GetNamedPipeServerProcessId(pipe, &process_id) || process_id == 0) {
    throw Win32Error("named-pipe server identity query");
  }
  ScopedHandle process(OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, process_id));
  if (process.get() == nullptr) throw Win32Error("named-pipe server process open");
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process.get(), &created, &exited, &kernel, &user)
      || (created.dwLowDateTime == 0 && created.dwHighDateTime == 0)
      || WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) {
    throw std::runtime_error("platform helper server identity verification failed");
  }
  const std::wstring process_path = CanonicalFilePath(ProcessImagePath(process.get()));
  if (process_path != CanonicalFilePath(expected_path)
      || Sha256File(process_path) != expected_hash
      || WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) {
    throw std::runtime_error("platform helper server identity verification failed");
  }
}

DWORD RemainingWaitMilliseconds(const RequestDeadline& deadline) {
  const auto now = std::chrono::steady_clock::now();
  if (now >= deadline) return 0;
  const auto remaining = std::chrono::ceil<std::chrono::milliseconds>(deadline - now);
  return static_cast<DWORD>((std::min)(
      remaining.count(),
      static_cast<decltype(remaining.count())>((std::numeric_limits<DWORD>::max)() - 1)));
}

void CancelAndDrain(HANDLE handle, OVERLAPPED* overlapped) noexcept {
  if (!CancelIoEx(handle, overlapped) && GetLastError() != ERROR_NOT_FOUND) {
    // GetOverlappedResult still owns the lifetime barrier for OVERLAPPED.
  }
  DWORD ignored = 0;
  GetOverlappedResult(handle, overlapped, &ignored, TRUE);
}

template <typename StartOperation>
DWORD RunOverlapped(
    HANDLE handle,
    const RequestDeadline& deadline,
    const char* operation,
    StartOperation start) {
  ScopedHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (event.get() == nullptr) throw Win32Error("named-pipe event creation");
  OVERLAPPED overlapped{};
  overlapped.hEvent = event.get();

  const BOOL completed = start(&overlapped);
  if (!completed) {
    const DWORD start_error = GetLastError();
    if (start_error != ERROR_IO_PENDING) throw Win32Error(operation, start_error);
    const DWORD wait_result = WaitForSingleObject(
        overlapped.hEvent,
        RemainingWaitMilliseconds(deadline));
    if (wait_result == WAIT_TIMEOUT) {
      CancelAndDrain(handle, &overlapped);
      throw std::runtime_error("named-pipe request timed out after 10000ms");
    }
    if (wait_result != WAIT_OBJECT_0) {
      const DWORD wait_error = GetLastError();
      CancelAndDrain(handle, &overlapped);
      throw Win32Error("named-pipe overlapped wait", wait_error);
    }
  }

  DWORD transferred = 0;
  if (!GetOverlappedResult(handle, &overlapped, &transferred, FALSE)) {
    const DWORD result_error = GetLastError();
    if (result_error == ERROR_OPERATION_ABORTED) {
      throw std::runtime_error("named-pipe request was cancelled");
    }
    throw Win32Error(operation, result_error);
  }
  return transferred;
}

void WriteExact(
    HANDLE handle,
    const void* bytes,
    std::size_t size,
    const RequestDeadline& deadline) {
  const auto* cursor = static_cast<const std::uint8_t*>(bytes);
  while (size > 0) {
    const DWORD chunk = static_cast<DWORD>(
        (std::min)(size, static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    const DWORD written = RunOverlapped(
        handle,
        deadline,
        "named-pipe write",
        [&](OVERLAPPED* overlapped) {
          return WriteFile(handle, cursor, chunk, nullptr, overlapped);
        });
    if (written == 0) throw std::runtime_error("named-pipe write returned zero bytes");
    cursor += written;
    size -= written;
  }
}

void ReadExact(
    HANDLE handle,
    void* bytes,
    std::size_t size,
    const RequestDeadline& deadline) {
  auto* cursor = static_cast<std::uint8_t*>(bytes);
  while (size > 0) {
    const DWORD chunk = static_cast<DWORD>(
        (std::min)(size, static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    const DWORD received = RunOverlapped(
        handle,
        deadline,
        "named-pipe read",
        [&](OVERLAPPED* overlapped) {
          return ReadFile(handle, cursor, chunk, nullptr, overlapped);
        });
    if (received == 0) throw std::runtime_error("named-pipe read returned zero bytes");
    cursor += received;
    size -= received;
  }
}

class WindowsTransport final : public PlatformTransport {
 public:
  explicit WindowsTransport(const PlatformTransportOptions& options) {
    handle_ = CreateFileW(
        kPipeName,
        GENERIC_READ | GENERIC_WRITE,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
        nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) throw Win32Error("named-pipe connection");
    try {
      AuthenticateServer(handle_, options);
      DWORD mode = PIPE_READMODE_BYTE;
      if (!SetNamedPipeHandleState(handle_, &mode, nullptr, nullptr)) {
        throw Win32Error("named-pipe mode");
      }
    } catch (...) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw;
    }
  }

  ~WindowsTransport() override { Close(); }

  std::string Request(const std::string& json_utf8) override {
    if (json_utf8.size() > kMaxMessageBytes) {
      throw std::runtime_error("platform helper request exceeds 65536 bytes");
    }
    const RequestDeadline deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(kRequestTimeoutMs);
    std::unique_lock<std::timed_mutex> request_lock(request_mutex_, std::defer_lock);
    if (!request_lock.try_lock_until(deadline)) {
      Cancel();
      throw std::runtime_error("named-pipe request timed out after 10000ms");
    }
    HANDLE handle;
    {
      std::lock_guard<std::mutex> state_lock(state_mutex_);
      if (closed_ || handle_ == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("named-pipe transport is closed");
      }
      handle = handle_;
    }
    try {
      const std::uint32_t request_size = static_cast<std::uint32_t>(json_utf8.size());
      const std::array<std::uint8_t, 4> prefix = {
          static_cast<std::uint8_t>(request_size),
          static_cast<std::uint8_t>(request_size >> 8),
          static_cast<std::uint8_t>(request_size >> 16),
          static_cast<std::uint8_t>(request_size >> 24),
      };
      WriteExact(handle, prefix.data(), prefix.size(), deadline);
      WriteExact(handle, json_utf8.data(), json_utf8.size(), deadline);

      std::array<std::uint8_t, 4> response_prefix{};
      ReadExact(handle, response_prefix.data(), response_prefix.size(), deadline);
      const std::uint32_t response_size =
          static_cast<std::uint32_t>(response_prefix[0])
          | (static_cast<std::uint32_t>(response_prefix[1]) << 8)
          | (static_cast<std::uint32_t>(response_prefix[2]) << 16)
          | (static_cast<std::uint32_t>(response_prefix[3]) << 24);
      if (response_size > kMaxMessageBytes) {
        throw std::runtime_error("platform helper response exceeds 65536 bytes");
      }
      std::string response(response_size, '\0');
      ReadExact(handle, response.data(), response.size(), deadline);
      return response;
    } catch (...) {
      Cancel();
      throw;
    }
  }

  void Cancel() override {
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    closed_ = true;
    if (handle_ != INVALID_HANDLE_VALUE
        && !CancelIoEx(handle_, nullptr)
        && GetLastError() != ERROR_NOT_FOUND) {
      // Close() still owns the handle and will release it after active I/O settles.
    }
  }

  void Close() override {
    Cancel();
    std::lock_guard<std::timed_mutex> request_lock(request_mutex_);
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    if (handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
    }
  }

 private:
  std::timed_mutex request_mutex_;
  std::mutex state_mutex_;
  HANDLE handle_{INVALID_HANDLE_VALUE};
  bool closed_{false};
};

}  // namespace

std::shared_ptr<PlatformTransport> CreatePlatformTransport(
    const PlatformTransportOptions& options) {
  return std::make_shared<WindowsTransport>(options);
}

}  // namespace aemcp::platform_helper

NAPI_MODULE_INIT() {
  return aemcp::platform_helper::InitializeAddon(env, exports);
}
