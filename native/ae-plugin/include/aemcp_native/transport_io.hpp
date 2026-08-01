#pragma once

// Transport I/O seam for the shared RPC connection core. Exactly one platform
// selector lives here; shared logic never branches on the platform directly.
// macOS wraps the POSIX socket syscalls with their exact current semantics.
// Windows implements the same contract over the named-pipe HANDLE wrapped by
// the C runtime (_open_osfhandle), so the shared framing code keeps its
// fd-based shape.
//
// Contract for transport_wait_*: 1 = ready, 0 = timeout, negative = error or
// hangup (with errno semantics preserved on macOS, including EINTR).

#if defined(_WIN32)

#include <cstddef>

namespace aemcp::native {

// Host identity values reported by the shared hello handshake.
inline constexpr const char* kHostPlatformId = "windows-x64";
inline constexpr const char* kHostArchId = "x64";

[[nodiscard]] int transport_wait_readable(int fd, int timeout_ms) noexcept;
[[nodiscard]] int transport_wait_writable(int fd, int timeout_ms) noexcept;

// Mirrors send/recv: byte count on success, 0 on orderly peer shutdown
// (recv only), negative on error.
[[nodiscard]] int transport_send(int fd, const void* data, std::size_t size) noexcept;
[[nodiscard]] int transport_recv(int fd, void* output, std::size_t size) noexcept;

}  // namespace aemcp::native

#elif defined(__APPLE__) || defined(__linux__)

#include <cerrno>
#include <cstddef>

#include <poll.h>
#include <sys/socket.h>

namespace aemcp::native {

// Host identity values reported by the shared hello handshake. The Linux
// branch exists so portable CI test binaries compile; the shipping macOS
// host reports these same values.
inline constexpr const char* kHostPlatformId = "macos-arm64";
inline constexpr const char* kHostArchId = "arm64";

[[nodiscard]] inline int transport_wait_readable(int fd, int timeout_ms) noexcept {
  pollfd socket{};
  socket.fd = fd;
  socket.events = POLLIN;
  const int polled = ::poll(&socket, 1, timeout_ms);
  if (polled <= 0) return polled;
  if ((socket.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) return -1;
  return (socket.revents & POLLIN) != 0 ? 1 : 0;
}

[[nodiscard]] inline int transport_wait_writable(int fd, int timeout_ms) noexcept {
  pollfd item{};
  item.fd = fd;
  item.events = POLLOUT;
  const int polled = ::poll(&item, 1, timeout_ms);
  if (polled <= 0) return polled;
  if ((item.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) return -1;
  return (item.revents & POLLOUT) != 0 ? 1 : 0;
}

[[nodiscard]] inline int transport_send(int fd, const void* data, std::size_t size) noexcept {
  return static_cast<int>(::send(fd, data, size, 0));
}

[[nodiscard]] inline int transport_recv(int fd, void* output, std::size_t size) noexcept {
  return static_cast<int>(::recv(fd, output, size, 0));
}

}  // namespace aemcp::native

#else
#error "aemcp transport I/O seam supports only Windows (_WIN32) and macOS (__APPLE__)"
#endif
