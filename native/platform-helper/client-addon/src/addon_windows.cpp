#include "common.hpp"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

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
  WindowsTransport() {
    handle_ = CreateFileW(
        kPipeName,
        GENERIC_READ | GENERIC_WRITE,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
        nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) throw Win32Error("named-pipe connection");
    DWORD mode = PIPE_READMODE_BYTE;
    if (!SetNamedPipeHandleState(handle_, &mode, nullptr, nullptr)) {
      const auto error = Win32Error("named-pipe mode");
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw error;
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

std::shared_ptr<PlatformTransport> CreatePlatformTransport() {
  return std::make_shared<WindowsTransport>();
}

}  // namespace aemcp::platform_helper

NAPI_MODULE_INIT() {
  return aemcp::platform_helper::InitializeAddon(env, exports);
}
