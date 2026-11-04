"""사용자 코드 프로세스에 거는 seccomp 필터 (Python 표준 라이브러리 ctypes만 쓴다).

채점에 필요 없는 커널 기능을 막는다: 소켓 생성, 다른 프로세스 추적·메모리 접근, 네임스페이스·마운트,
커널 모듈·kexec, bpf·perf·userfaultfd·io_uring, 키링. 막힌 호출은 EPERM으로 실패한다(clone3는 ENOSYS라서
glibc가 clone으로 다시 부르고, 그 clone의 네임스페이스 플래그를 검사한다). 다른 아키텍처(32비트 호환·x32)로
들어온 호출은 프로세스를 끝낸다. 컨테이너 기본 프로파일 위에 한 겹 더 건다.

번호표는 커널 헤더(sys/syscall.h)에서 x86_64·aarch64 각각 확인한 값이다.
"""
import ctypes
import errno
import os
import platform
import struct

# seccomp_data: nr(u32) · arch(u32) · instruction_pointer(u64) · args[6](u64). args[0]의 아래 32비트는 오프셋 16(리틀 엔디언).
_OFF_NR, _OFF_ARCH, _OFF_ARG0_LO = 0, 4, 16

_LD_ABS = 0x20  # BPF_LD | BPF_W | BPF_ABS
_JEQ = 0x15  # BPF_JMP | BPF_JEQ | BPF_K
_JGE = 0x35  # BPF_JMP | BPF_JGE | BPF_K
_JSET = 0x45  # BPF_JMP | BPF_JSET | BPF_K
_RET = 0x06  # BPF_RET | BPF_K

_ALLOW = 0x7FFF0000
_KILL_PROCESS = 0x80000000
_ERRNO = 0x00050000

_PR_SET_NO_NEW_PRIVS = 38
_PR_SET_SECCOMP = 22
_SECCOMP_MODE_FILTER = 2

# CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET
_CLONE_NS_FLAGS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000

_DENIED = (
    "socket ptrace process_vm_readv process_vm_writev unshare setns mount umount2 pivot_root chroot "
    "bpf perf_event_open userfaultfd keyctl add_key request_key io_uring_setup io_uring_enter io_uring_register "
    "kexec_load kexec_file_load init_module finit_module delete_module open_tree move_mount fsopen fsconfig "
    "fsmount fspick mount_setattr name_to_handle_at open_by_handle_at acct swapon swapoff reboot quotactl"
).split()

_ARCHES = {
    "x86_64": {
        "audit": 0xC000003E,
        "x32_bit": 0x40000000,
        "nr": {
            "socket": 41, "ptrace": 101, "process_vm_readv": 310, "process_vm_writev": 311, "unshare": 272, "setns": 308,
            "mount": 165, "umount2": 166, "pivot_root": 155, "chroot": 161, "bpf": 321, "perf_event_open": 298,
            "userfaultfd": 323, "keyctl": 250, "add_key": 248, "request_key": 249, "io_uring_setup": 425,
            "io_uring_enter": 426, "io_uring_register": 427, "kexec_load": 246, "kexec_file_load": 320,
            "init_module": 175, "finit_module": 313, "delete_module": 176, "open_tree": 428, "move_mount": 429,
            "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442,
            "name_to_handle_at": 303, "open_by_handle_at": 304, "acct": 163, "swapon": 167, "swapoff": 168,
            "reboot": 169, "quotactl": 179, "clone": 56, "clone3": 435,
        },
    },
    "aarch64": {
        "audit": 0xC00000B7,
        "x32_bit": None,
        "nr": {
            "socket": 198, "ptrace": 117, "process_vm_readv": 270, "process_vm_writev": 271, "unshare": 97, "setns": 268,
            "mount": 40, "umount2": 39, "pivot_root": 41, "chroot": 51, "bpf": 280, "perf_event_open": 241,
            "userfaultfd": 282, "keyctl": 219, "add_key": 217, "request_key": 218, "io_uring_setup": 425,
            "io_uring_enter": 426, "io_uring_register": 427, "kexec_load": 104, "kexec_file_load": 294,
            "init_module": 105, "finit_module": 273, "delete_module": 106, "open_tree": 428, "move_mount": 429,
            "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442,
            "name_to_handle_at": 264, "open_by_handle_at": 265, "acct": 89, "swapon": 224, "swapoff": 225,
            "reboot": 142, "quotactl": 60, "clone": 220, "clone3": 435,
        },
    },
}
_ARCHES["arm64"] = _ARCHES["aarch64"]


def program(machine):
    """BPF 명령 목록 [(code, jt, jf, k)]. 지원하지 않는 아키텍처면 None."""
    a = _ARCHES.get(machine)
    if not a:
        return None
    nr = a["nr"]
    p = [
        (_LD_ABS, 0, 0, _OFF_ARCH),
        (_JEQ, 1, 0, a["audit"]),
        (_RET, 0, 0, _KILL_PROCESS),
        (_LD_ABS, 0, 0, _OFF_NR),
    ]
    if a["x32_bit"]:
        p += [(_JGE, 0, 1, a["x32_bit"]), (_RET, 0, 0, _KILL_PROCESS)]
    for name in _DENIED:
        p += [(_JEQ, 0, 1, nr[name]), (_RET, 0, 0, _ERRNO | errno.EPERM)]
    p += [(_JEQ, 0, 1, nr["clone3"]), (_RET, 0, 0, _ERRNO | errno.ENOSYS)]
    # clone: 네임스페이스 플래그가 있으면 막는다. 아니면 허용.
    p += [
        (_JEQ, 0, 3, nr["clone"]),
        (_LD_ABS, 0, 0, _OFF_ARG0_LO),
        (_JSET, 0, 1, _CLONE_NS_FLAGS),
        (_RET, 0, 0, _ERRNO | errno.EPERM),
        (_RET, 0, 0, _ALLOW),
    ]
    return p


class _Fprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]


class Filter:
    """fork 전에 만들어 두고, 자식(preexec)에서는 prctl 두 번만 부른다."""

    def __init__(self, machine=None):
        prog = program(machine or platform.machine())
        if prog is None:
            raise OSError("seccomp: 지원하지 않는 아키텍처 %s" % (machine or platform.machine()))
        self._buf = ctypes.create_string_buffer(b"".join(struct.pack("=HBBI", *ins) for ins in prog))
        self._fprog = _Fprog(len(prog), ctypes.addressof(self._buf))
        self._libc = ctypes.CDLL(None, use_errno=True)
        self._prctl = self._libc.prctl
        self._prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
        self._prctl.restype = ctypes.c_int
        self.size = len(prog)

    def install(self):
        if self._prctl(_PR_SET_NO_NEW_PRIVS, 1, None, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_NO_NEW_PRIVS)")
        if self._prctl(_PR_SET_SECCOMP, _SECCOMP_MODE_FILTER, ctypes.addressof(self._fprog), 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_SECCOMP)")


def load():
    """Linux가 아니거나 RUNNER_SECCOMP=off면 None(로컬 개발·비상 해제). 그 밖에 만들 수 없으면 예외(실행하지 않는다)."""
    if os.environ.get("RUNNER_SECCOMP", "on") == "off" or platform.system() != "Linux":
        return None
    return Filter()
