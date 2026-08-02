#include "aemcp_native/peer_identity_windows.hpp"

#include <windows.h>
#include <tlhelp32.h>

#include <io.h>

namespace aemcp::native {
namespace {

constexpr std::int32_t kAmd64MachineType = 0x8664;  // IMAGE_FILE_MACHINE_AMD64

[[nodiscard]] ProcessGeneration generation_from_filetime(
    const FILETIME& created) noexcept {
  const std::uint64_t ticks =
      (static_cast<std::uint64_t>(created.dwHighDateTime) << 32U)
      | created.dwLowDateTime;
  if (ticks == 0) return {};
  constexpr std::uint64_t kEpochOffsetSeconds = 11644473600ULL;
  const std::uint64_t seconds = ticks / 10000000ULL;
  const std::uint64_t microseconds = (ticks % 10000000ULL) / 10ULL;
  if (seconds <= kEpochOffsetSeconds) return {};
  return ProcessGeneration{seconds - kEpochOffsetSeconds, microseconds};
}

class WindowsPeerIdentityBackend final : public PeerIdentityBackend {
 public:
  // fd wraps the server end of a named pipe. The OS-reported client PID is
  // diagnostic evidence only and does not participate in admission.
  [[nodiscard]] bool socket_peer(int socket_fd, SocketPeerEvidence& output) override {
    const HANDLE pipe = reinterpret_cast<HANDLE>(_get_osfhandle(socket_fd));
    if (pipe == INVALID_HANDLE_VALUE || pipe == nullptr) return false;
    ULONG client_pid = 0;
    if (GetNamedPipeClientProcessId(pipe, &client_pid) == 0 || client_pid <= 1) {
      return false;
    }
    output.pid = static_cast<std::int32_t>(client_pid);
    output.euid = 0;
    output.egid = 0;
    output.audit_session = 0;
    output.pid_version = 1;
    return true;
  }

  [[nodiscard]] bool process_snapshot(std::int32_t pid, ProcessSnapshot& output) override {
    if (pid <= 1) return false;
    output.pid = pid;
    output.parent_pid = 0;
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot != INVALID_HANDLE_VALUE) {
      PROCESSENTRY32W entry{};
      entry.dwSize = sizeof(entry);
      for (BOOL more = Process32FirstW(snapshot, &entry); more;
           more = Process32NextW(snapshot, &entry)) {
        if (static_cast<std::int32_t>(entry.th32ProcessID) == pid) {
          output.parent_pid = static_cast<std::int32_t>(entry.th32ParentProcessID);
          break;
        }
      }
      CloseHandle(snapshot);
    }
    const HANDLE process = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
    if (process == nullptr) return false;
    FILETIME created{}, exited{}, kernel{}, user{};
    const BOOL timed = GetProcessTimes(process, &created, &exited, &kernel, &user);
    USHORT native_machine = 0;
    USHORT process_machine = 0;
    const BOOL machine_known =
        IsWow64Process2(process, &process_machine, &native_machine);
    CloseHandle(process);
    if (timed == 0) return false;
    output.generation = generation_from_filetime(created);
    output.uid = 0;
    output.cpu_type = machine_known != 0 && native_machine != 0
                          ? static_cast<std::int32_t>(native_machine)
                          : kAmd64MachineType;
    output.traced = false;
    output.exiting = false;
    return output.generation.valid();
  }
};

}  // namespace

std::unique_ptr<PeerIdentityBackend> create_windows_peer_identity_backend() {
  return std::make_unique<WindowsPeerIdentityBackend>();
}

ExpectedProcess current_windows_process(PeerIdentityBackend& backend) {
  ProcessSnapshot snapshot{};
  if (!backend.process_snapshot(
          static_cast<std::int32_t>(GetCurrentProcessId()), snapshot)) {
    return {};
  }
  return ExpectedProcess{snapshot.pid, snapshot.generation};
}

std::int32_t windows_native_cpu_type() noexcept {
  return kAmd64MachineType;
}

}  // namespace aemcp::native
