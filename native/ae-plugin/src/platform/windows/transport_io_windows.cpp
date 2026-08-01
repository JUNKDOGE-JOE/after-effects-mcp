#include "aemcp_native/transport_io.hpp"

#if defined(_WIN32)

#include <cerrno>
#include <chrono>

#include <io.h>
#include <windows.h>

namespace aemcp::native {
namespace {

[[nodiscard]] HANDLE pipe_handle(int fd) noexcept {
  const HANDLE pipe = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  return pipe == INVALID_HANDLE_VALUE ? nullptr : pipe;
}

}  // namespace

int transport_wait_readable(int fd, int timeout_ms) noexcept {
  const HANDLE pipe = pipe_handle(fd);
  if (pipe == nullptr) return -1;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  // Named pipes are not waitable handles; PeekNamedPipe gives a bounded,
  // honest readability signal including peer hangup.
  for (;;) {
    DWORD available = 0;
    if (PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) == 0) {
      return -1;
    }
    if (available > 0) return 1;
    if (std::chrono::steady_clock::now() >= deadline) return 0;
    Sleep(2);
  }
}

int transport_wait_writable(int fd, int timeout_ms) noexcept {
  (void)timeout_ms;
  const HANDLE pipe = pipe_handle(fd);
  if (pipe == nullptr) return -1;
  // Byte-mode blocking pipes apply backpressure inside WriteFile; the shared
  // write deadline still bounds the overall frame budget.
  return 1;
}

int transport_send(int fd, const void* data, std::size_t size) noexcept {
  return _write(fd, data, static_cast<unsigned int>(size));
}

int transport_recv(int fd, void* output, std::size_t size) noexcept {
  return _read(fd, output, static_cast<unsigned int>(size));
}

}  // namespace aemcp::native

#endif
