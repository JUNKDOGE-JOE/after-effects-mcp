#include "aemcp_native/peer_identity_macos.hpp"

#include <bsm/libbsm.h>
#include <libproc.h>
#include <mach/machine.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <memory>

namespace aemcp::native {
namespace {

class MacPeerIdentityBackend final : public PeerIdentityBackend {
 public:
  bool socket_peer(int socket_fd, SocketPeerEvidence& output) override {
    uid_t euid = 0;
    gid_t egid = 0;
    if (::getpeereid(socket_fd, &euid, &egid) != 0) return false;
    pid_t peer_pid = 0;
    socklen_t pid_size = sizeof(peer_pid);
    if (::getsockopt(
            socket_fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &pid_size) != 0
        || pid_size != sizeof(peer_pid)) {
      return false;
    }
    audit_token_t token{};
    socklen_t token_size = sizeof(token);
    if (::getsockopt(
            socket_fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_size) != 0
        || token_size != sizeof(token)) {
      return false;
    }
    const pid_t audit_pid = audit_token_to_pid(token);
    const uid_t audit_euid = audit_token_to_euid(token);
    if (audit_pid != peer_pid || audit_euid != euid) return false;
    const int pid_version = audit_token_to_pidversion(token);
    const au_asid_t audit_session = audit_token_to_asid(token);
    if (pid_version <= 0 || audit_session < 0) return false;
    output = {
        static_cast<std::int32_t>(peer_pid),
        static_cast<std::uint32_t>(euid),
        static_cast<std::uint32_t>(egid),
        static_cast<std::uint32_t>(audit_session),
        static_cast<std::uint32_t>(pid_version),
    };
    return true;
  }

  bool process_snapshot(std::int32_t pid, ProcessSnapshot& output) override {
    proc_bsdinfo bsd{};
    const int bsd_bytes = ::proc_pidinfo(
        pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd));
    if (bsd_bytes != static_cast<int>(sizeof(bsd))
        || static_cast<std::int32_t>(bsd.pbi_pid) != pid) {
      return false;
    }
    proc_archinfo architecture{};
    const int arch_bytes = ::proc_pidinfo(
        pid, PROC_PIDARCHINFO, 0, &architecture, sizeof(architecture));
    if (arch_bytes != static_cast<int>(sizeof(architecture))) return false;
    output = {
        pid,
        static_cast<std::int32_t>(bsd.pbi_ppid),
        static_cast<std::uint32_t>(bsd.pbi_uid),
        {bsd.pbi_start_tvsec, bsd.pbi_start_tvusec},
        static_cast<std::int32_t>(architecture.p_cputype),
        (bsd.pbi_flags & PROC_FLAG_TRACED) != 0,
        (bsd.pbi_flags & PROC_FLAG_INEXIT) != 0,
    };
    return true;
  }
};

}  // namespace

std::unique_ptr<PeerIdentityBackend> create_macos_peer_identity_backend() {
  return std::make_unique<MacPeerIdentityBackend>();
}

ExpectedProcess current_macos_process(PeerIdentityBackend& backend) {
  ProcessSnapshot snapshot;
  const auto pid = static_cast<std::int32_t>(::getpid());
  if (!backend.process_snapshot(pid, snapshot)) return {};
  return {snapshot.pid, snapshot.generation};
}

std::int32_t macos_native_cpu_type() noexcept {
  return static_cast<std::int32_t>(CPU_TYPE_ARM64);
}

}  // namespace aemcp::native
