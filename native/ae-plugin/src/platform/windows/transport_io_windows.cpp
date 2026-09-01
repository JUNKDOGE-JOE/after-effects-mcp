#include "aemcp_native/transport_io.hpp"

#if defined(_WIN32)

#include <io.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <limits>

namespace aemcp::native {
namespace detail {
[[nodiscard]] int error_result(DWORD error, bool reading) noexcept {
  switch (error) {
    case ERROR_BROKEN_PIPE:
    case ERROR_NO_DATA:
    case ERROR_PIPE_NOT_CONNECTED:
      if (reading) return 0;
      errno = EPIPE;
      return -1;
    case ERROR_OPERATION_ABORTED:
      errno = ECANCELED;
      return -1;
    case ERROR_INVALID_HANDLE:
      errno = EBADF;
      return -1;
    default:
      errno = EIO;
      return -1;
  }
}

int complete_overlapped_io(HANDLE pipe, OVERLAPPED *operation, DWORD &transferred,
                           bool reading) noexcept {
  if (GetOverlappedResult(pipe, operation, &transferred, FALSE) == 0) {
    return error_result(GetLastError(), reading);
  }
  return static_cast<int>(transferred);
}

}  // namespace detail

namespace {

[[nodiscard]] HANDLE pipe_handle(int fd) noexcept {
  const HANDLE pipe = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  return pipe == INVALID_HANDLE_VALUE ? nullptr : pipe;
}

[[nodiscard]] int overlapped_io(int fd, void *buffer, std::size_t size, int timeout_ms,
                                bool reading) noexcept {
  const HANDLE pipe = pipe_handle(fd);
  if (pipe == nullptr) {
    errno = EBADF;
    return -1;
  }
  if (timeout_ms < 0) {
    errno = EINVAL;
    return -1;
  }
  if (size == 0) return 0;
  const DWORD requested = static_cast<DWORD>(
      std::min<std::size_t>(size, static_cast<std::size_t>(std::numeric_limits<int>::max())));
  const HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (event == nullptr) {
    errno = EIO;
    return -1;
  }
  OVERLAPPED operation{};
  operation.hEvent = event;
  DWORD transferred = 0;
  const BOOL completed = reading ? ReadFile(pipe, buffer, requested, &transferred, &operation)
                                 : WriteFile(pipe, buffer, requested, &transferred, &operation);
  if (completed != 0) {
    CloseHandle(event);
    return static_cast<int>(transferred);
  }
  const DWORD start_error = GetLastError();
  if (start_error != ERROR_IO_PENDING) {
    CloseHandle(event);
    return detail::error_result(start_error, reading);
  }
  const DWORD waited = WaitForSingleObject(event, static_cast<DWORD>(timeout_ms));
  if (waited != WAIT_OBJECT_0) {
    (void)CancelIoEx(pipe, &operation);
    // The OVERLAPPED storage must outlive cancellation completion.
    (void)WaitForSingleObject(event, INFINITE);
    const int result = detail::complete_overlapped_io(pipe, &operation, transferred, reading);
    CloseHandle(event);
    if (result >= 0) return result;
    if (waited == WAIT_TIMEOUT && errno == ECANCELED) {
      errno = ETIMEDOUT;
    } else if (waited != WAIT_TIMEOUT) {
      errno = EIO;
    }
    return -1;
  }
  const int result = detail::complete_overlapped_io(pipe, &operation, transferred, reading);
  CloseHandle(event);
  return result;
}

}  // namespace

int transport_wait_readable(int fd, int timeout_ms) noexcept {
  const HANDLE pipe = pipe_handle(fd);
  if (pipe == nullptr) {
    errno = EBADF;
    return -1;
  }
  if (timeout_ms < 0) {
    errno = EINVAL;
    return -1;
  }
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  // Named pipes are not waitable handles; PeekNamedPipe gives a bounded,
  // honest readability signal including peer hangup.
  for (;;) {
    DWORD available = 0;
    if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) == 0) {
      return detail::error_result(GetLastError(), false);
    }
    if (available > 0) return 1;
    if (std::chrono::steady_clock::now() >= deadline) return 0;
    Sleep(2);
  }
}

int transport_send(int fd, const void *data, std::size_t size, int timeout_ms) noexcept {
  return overlapped_io(fd, const_cast<void *>(data), size, timeout_ms, false);
}

int transport_recv(int fd, void *output, std::size_t size, int timeout_ms) noexcept {
  return overlapped_io(fd, output, size, timeout_ms, true);
}

}  // namespace aemcp::native

#endif
