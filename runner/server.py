"""코드 실행 서버 (runner 컨테이너 전용, 인터넷 차단 네트워크).

judge만 이 서버를 호출한다(운영은 네트워크 없이 unix 소켓, RUNNER_SOCKET). 서버는 root로 돌고,
사용자 코드는 실행 슬롯마다 다른 sandbox uid로 낮춘 별도 프로세스 그룹에서 rlimit·시간 제한을 걸어 실행한다.
작업이 끝나면 그 uid의 남은 프로세스와 파일을 지운 뒤 다음 작업에 넘긴다.
서버에 남기는 capability(CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL)는 setuid 후 자식에 남지 않는다.
자식은 setuid 뒤 seccomp 필터(seccomp_filter.py)를 걸고 exec한다.
Python 표준 라이브러리만 쓴다 (사용자 코드와 같은 인터프리터).
"""
import hashlib
import json
import os
import queue
import re
import resource
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import seccomp_filter

HARNESS_DIR = os.environ.get("HARNESS_DIR", os.path.dirname(os.path.abspath(__file__)))
JAVA_HARNESS_CP = os.environ.get("JAVA_HARNESS_CP", os.path.join(HARNESS_DIR, "java"))
SANDBOX_UID = int(os.environ.get("SANDBOX_UID", "-1"))  # -1이면 낮추지 않음 (로컬 개발)
WORK_ROOT = os.environ.get("WORK_ROOT", tempfile.gettempdir())
PORT = int(os.environ.get("PORT", "8000"))
# 운영: TCP 대신 이 unix 소켓으로만 받는다(컨테이너는 네트워크 없음). 소켓은 root와 RUNNER_SOCKET_GID(judge)만 연다.
SOCKET_PATH = os.environ.get("RUNNER_SOCKET", "")
SOCKET_GID = int(os.environ.get("RUNNER_SOCKET_GID", "-1"))
# 동시에 실행하는 요청 수. 슬롯마다 uid가 다르다: SANDBOX_UID+1 … SANDBOX_UID+RUN_SLOTS.
# SANDBOX_UID 자체는 기준 시간 측정(신뢰 코드)에만 쓴다.
RUN_SLOTS = max(1, int(os.environ.get("RUN_SLOTS", "2")))
# uid 하나가 만들 수 있는 프로세스·스레드 수(JVM 스레드 포함)
NPROC_LIMIT = int(os.environ.get("NPROC_LIMIT", "128"))
# 사용자 코드에 거는 seccomp 필터. uid를 낮추는 환경(컨테이너)에서만 쓴다. 만들 수 없으면 서버가 뜨지 않는다.
SECCOMP = seccomp_filter.load() if SANDBOX_UID >= 0 else None

RUN_TIMEOUT_S = float(os.environ.get("RUN_TIMEOUT_S", "10"))  # 문제가 시간 제한을 정하지 않으면 10초
# 시간 제한은 solution 호출(입출력형은 실행) 시간 기준이다. 프로세스는 언어별 시작 시간만큼 여유를 두고 종료한다.
STARTUP_SLACK_S = {"java": 3.0, "python": 1.0}
COMPILE_TIMEOUT_S = 30.0
JAVA_XMX = os.environ.get("JAVA_XMX", "512m")
PY_AS_LIMIT = int(os.environ.get("PY_AS_LIMIT_MB", "1024")) * 1024 * 1024
# 함수형 시간 초과는 하네스가 보고한 시간(사용자 프로세스 안)만 믿지 않는다. 바깥에서 잰 시간에서
# 언어별 기동 기준값을 뺀 값이 제한 + 여유(+ 인자 크기에 따른 파싱 여유)를 넘어도 시간 초과다.
TRUST_SLACK_MS = float(os.environ.get("TRUST_SLACK_MS", "150"))
ARG_MS_PER_MB = float(os.environ.get("ARG_MS_PER_MB", "200"))
OUTPUT_LIMIT = 64 * 1024
MAX_CASES = 200
# 요청 하나의 전체 실행 시간 상한. (api는 비동기 큐라 Cloudflare 응답 제한과 무관하다)
TOTAL_BUDGET_S = float(os.environ.get("TOTAL_BUDGET_S", "600"))
MAX_CODE = 200 * 1024

# 테스트셋 캐시: api가 해시만 보내고, 없을 때만 내용을 올린다(파일은 내용이 바뀌지 않는다).
# 히든 테스트셋은 root만 읽는다(폴더 0700, 파일 0600). 운영은 사용자 코드가 쓰는 /tmp 밖의 별도 tmpfs에 둔다.
TESTSET_DIR = os.environ.get("TESTSET_DIR", os.path.join(WORK_ROOT, "testsets"))
TESTSET_CACHE_BYTES = int(os.environ.get("TESTSET_CACHE_MB", "200")) * 1024 * 1024
# Java 컴파일 캐시(0012 4단계): 같은 코드면 class 파일을 다시 쓴다(실행 뒤 같은 코드로 제출). 테스트셋처럼 root만 읽는다.
CLASS_CACHE_DIR = os.environ.get("CLASS_CACHE_DIR", os.path.join(TESTSET_DIR, "classes"))
CLASS_CACHE_BYTES = int(os.environ.get("CLASS_CACHE_MB", "16")) * 1024 * 1024
# 예열 컴파일 서버: 전용 uid로 떠 있는 JVM에서 javac를 부른다. off면 매번 javac 명령(예전 방식).
JAVA_COMPILE_SERVER = os.environ.get("JAVA_COMPILE_SERVER", "on") != "off"
COMPILER_UID = int(os.environ.get("COMPILER_UID", "-1"))
COMPILER_CP = os.environ.get("COMPILER_CP", os.path.join(HARNESS_DIR, "compiler"))
COMPILER_XMX = os.environ.get("COMPILER_XMX", "256m")
_testset_lock = threading.Lock()


def testset_path(h):
    if not re.fullmatch(r"[0-9a-f]{64}", h or ""):
        raise ValueError("테스트셋 해시가 올바르지 않습니다.")
    return os.path.join(TESTSET_DIR, h + ".json")


def _ensure_testset_dir():
    os.makedirs(TESTSET_DIR, mode=0o700, exist_ok=True)
    os.chmod(TESTSET_DIR, 0o700)


def secure_testsets():
    """시작할 때 이미 있는 캐시의 권한도 고친다."""
    if not os.path.isdir(TESTSET_DIR):
        return
    _ensure_testset_dir()
    for n in os.listdir(TESTSET_DIR):
        os.chmod(os.path.join(TESTSET_DIR, n), 0o600)


def load_testset(h):
    """캐시에 있으면 케이스 목록, 없으면 None. 쓸 때마다 mtime을 갱신해 LRU로 쓴다."""
    path = testset_path(h)
    try:
        with open(path, encoding="utf-8") as f:
            cases = json.load(f)
        os.utime(path)
        return cases
    except FileNotFoundError:
        return None


def store_testset(h, raw):
    if hashlib.sha256(raw).hexdigest() != h:
        raise ValueError("테스트셋 내용이 해시와 다릅니다.")
    json.loads(raw)
    with _testset_lock:
        _ensure_testset_dir()
        tmp = testset_path(h) + ".tmp"
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f:
            f.write(raw)
        os.chmod(tmp, 0o600)
        os.replace(tmp, testset_path(h))
        # 용량을 넘으면 오래 안 쓴 것부터 지운다
        files = [os.path.join(TESTSET_DIR, n) for n in os.listdir(TESTSET_DIR) if n.endswith(".json")]
        files.sort(key=lambda p: os.stat(p).st_mtime)
        total = sum(os.stat(p).st_size for p in files)
        while files and total > TESTSET_CACHE_BYTES and files[0] != testset_path(h):
            total -= os.stat(files[0]).st_size
            os.remove(files.pop(0))


def loads_literal(text):
    """기존 표기 리터럴(JSON, 작은따옴표 허용)을 해석한다. 정수는 정밀도 제한이 없다."""
    t = text.strip()
    try:
        return json.loads(t)
    except ValueError:
        if "'" in t and '"' not in t:
            return json.loads(t.replace("'", '"'))
        raise ValueError("JSON 형식이 아닌 값이 있습니다: " + t[:50])


# ─── 중지 ───
# api가 실행 요청에 jobId를 붙이고, POST /cancel/<jobId>로 중지한다.
# 요청이 도착하기 전에 온 중지도 기억해 둔다(오래된 기록은 지운다).
CANCEL_TTL_S = 60 * 60
CANCELLED_MSG = "중지되어 실행하지 않았습니다."
SOLUTION_FILE = "solution.py"


class Job:
    def __init__(self, uid=None):
        # 이 작업의 사용자 코드를 실행할 uid(execute가 슬롯 uid를 넣는다)
        self.uid = SANDBOX_UID if uid is None else uid
        self.cancelled = threading.Event()
        self.pgid = None
        self.lock = threading.Lock()
        self.at = time.monotonic()

    def kill(self):
        with self.lock:
            if self.pgid is not None:
                try:
                    os.killpg(self.pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass


_jobs = {}
_jobs_lock = threading.Lock()


def _job(job_id):
    with _jobs_lock:
        now = time.monotonic()
        for k in [k for k, j in _jobs.items() if now - j.at > CANCEL_TTL_S]:
            del _jobs[k]
        return _jobs.setdefault(job_id, Job())


def cancel(job_id):
    if not re.fullmatch(r"[0-9A-Za-z-]{1,64}", job_id or ""):
        raise ValueError("jobId가 올바르지 않습니다.")
    job = _job(job_id)
    job.cancelled.set()
    job.kill()


# 실행 슬롯 = uid. 꺼내 쓰고, 정리한 뒤 돌려준다(동시에 도는 두 작업은 항상 uid가 다르다).
_uid_pool = queue.Queue()
for _i in range(RUN_SLOTS):
    _uid_pool.put(SANDBOX_UID + 1 + _i if SANDBOX_UID >= 0 else -1)


def _uid_procs(uid):
    """/proc에서 실제·유효 uid가 uid인 프로세스"""
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/status" % name) as f:
                for line in f:
                    if line.startswith("Uid:"):
                        real, eff = line.split()[1:3]
                        if uid in (int(real), int(eff)):
                            pids.append(int(name))
                        break
        except (OSError, ValueError):
            pass
    return pids


def reap_uid(uid):
    """작업이 끝난 uid의 남은 프로세스(새 세션으로 빠져나간 것 포함)와 공용 쓰기 폴더의 파일을 지운다."""
    if uid < 0:
        return
    for _ in range(50):
        pids = _uid_procs(uid)
        if not pids:
            break
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.02)
    for root in {WORK_ROOT, "/dev/shm"}:
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for n in names:
            path = os.path.join(root, n)
            try:
                if os.lstat(path).st_uid != uid:
                    continue
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.unlink(path)
            except OSError:
                pass


def _versions():
    out = {"python": sys.version.split()[0], "java": None}
    try:
        p = subprocess.run(["java", "-version"], capture_output=True, text=True, timeout=10)
        m = re.search(r'version "([^"]+)"', p.stderr)
        out["java"] = m.group(1) if m else None
    except Exception:
        pass
    return out


VERSIONS = _versions()


# ─── 프로세스 실행 ───

class Proc:
    def __init__(self, status, exit_code, stdout, stderr, time_ms, memory_kb, cpu_ms=0.0):
        self.status = status  # ok | timeout | error
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        self.time_ms = time_ms
        self.memory_kb = memory_kb
        self.cpu_ms = cpu_ms  # 자식이 쓴 CPU 시간(사용자 + 커널), 바깥에서 잰 값


def _preexec(as_limit, uid):
    def fn():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_CPU, (int(RUN_TIMEOUT_S) + 5, int(RUN_TIMEOUT_S) + 5))
        if as_limit:
            try:
                resource.setrlimit(resource.RLIMIT_AS, (as_limit, as_limit))
            except (ValueError, OSError):  # macOS(로컬 개발)는 RLIMIT_AS를 지원하지 않는다
                pass
        if uid >= 0:
            resource.setrlimit(resource.RLIMIT_NPROC, (NPROC_LIMIT, NPROC_LIMIT))
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            if SECCOMP:
                SECCOMP.install()
    return fn


def _read_capped(stream, sink):
    total = 0
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        if total < OUTPUT_LIMIT:
            sink.append(chunk[: OUTPUT_LIMIT - total])
        total += len(chunk)
    if total > OUTPUT_LIMIT:
        sink.append("\n... (출력이 너무 길어 잘렸습니다)".encode("utf-8"))


def _sandbox_env(cwd):
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": cwd,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "JAVA_HOME": os.environ.get("JAVA_HOME", ""),
    }


def _kill_group(pid, ignore=(ProcessLookupError,)):
    """이 서버가 만든 자식의 프로세스 그룹에만 보낸다."""
    try:
        os.killpg(pid, signal.SIGKILL)
    except ignore:
        pass


def _set_job_pgid(job, pgid):
    if not job:
        return
    with job.lock:
        job.pgid = pgid
    if pgid is not None and job.cancelled.is_set():
        job.kill()


def _exit_code(wstatus):
    if hasattr(os, "waitstatus_to_exitcode"):
        return os.waitstatus_to_exitcode(wstatus)
    return -os.WTERMSIG(wstatus) if os.WIFSIGNALED(wstatus) else os.WEXITSTATUS(wstatus)


def _proc_status(job, timed_out, returncode):
    if job and job.cancelled.is_set():
        return "cancelled"
    if timed_out:
        return "timeout"
    return "ok" if returncode == 0 else "error"


def _write_stdin(p, stdin_data):
    try:
        p.stdin.write(stdin_data)
        p.stdin.close()
    except BrokenPipeError:
        pass


def run_proc(cmd, cwd, stdin_data=b"", timeout=None, as_limit=0, job=None):
    timeout = RUN_TIMEOUT_S if timeout is None else timeout
    start = time.monotonic()
    p = subprocess.Popen(
        cmd, cwd=cwd, env=_sandbox_env(cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        preexec_fn=_preexec(as_limit, job.uid if job else SANDBOX_UID), close_fds=True,
    )
    _set_job_pgid(job, p.pid)
    out, err = [], []
    readers = [threading.Thread(target=_read_capped, args=(p.stdout, out)),
               threading.Thread(target=_read_capped, args=(p.stderr, err))]
    for t in readers:
        t.start()
    _write_stdin(p, stdin_data)

    timed_out = threading.Event()

    def kill():
        timed_out.set()
        _kill_group(p.pid)

    timer = threading.Timer(timeout, kill)
    timer.start()
    # wait4로 기다려야 이 자식의 최대 RSS를 얻을 수 있다.
    _, wstatus, usage = os.wait4(p.pid, 0)
    elapsed = (time.monotonic() - start) * 1000
    timer.cancel()
    _set_job_pgid(job, None)
    _kill_group(p.pid, (ProcessLookupError, PermissionError))  # 남은 자손 프로세스 정리
    p.returncode = _exit_code(wstatus)
    for t in readers:
        t.join(2)
    if p.returncode == -signal.SIGXCPU:  # CPU 시간 제한
        timed_out.set()
    return Proc(_proc_status(job, timed_out.is_set(), p.returncode), p.returncode, b"".join(out).decode("utf-8", "replace"),
                b"".join(err).decode("utf-8", "replace"), round(elapsed, 2),
                usage.ru_maxrss // 1024 if sys.platform == "darwin" else usage.ru_maxrss,
                round((usage.ru_utime + usage.ru_stime) * 1000, 2))


# ─── 결과 비교 ───

def _same(a, b):
    """기존처럼 타입까지 비교한다. bool과 숫자는 다르고, 실수는 1e-9 오차를 허용."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if isinstance(a, int) and isinstance(b, int):
            return a == b
        return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def _norm_output(s):
    return "\n".join(line.rstrip() for line in s.strip().splitlines())


# ─── 언어별 준비 ───

def _java_file_name(code):
    m = re.search(r"\bpublic\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)", code)
    return (m.group(1) if m else "Solution") + ".java"


def _java_main_class(code):
    # static void main 을 가진 클래스: main 앞에 마지막으로 선언된 class
    idx = re.search(r"\bstatic\s+void\s+main\s*\(", code)
    head = code[: idx.start()] if idx else code
    names = re.findall(r"\b(?:class|record|enum|interface)\s+([A-Za-z_]\w*)", head)
    return names[-1] if names else "Solution"

# ─── Java 컴파일: 캐시와 예열 컴파일 서버 (0012 4단계) ───
# 판정에 쓰는 class 파일은 javac 출력 그대로다(사용자 코드를 실행하기 전에 저장하고, 같은 코드에만 다시 쓴다).
JAVAC_OPTS = ["-encoding", "UTF-8", "-g:none", "-Xlint:deprecation"]
COMPILE_TIMEOUT_MSG = "컴파일 시간이 초과되었습니다."
_class_lock = threading.Lock()


def _class_key(code, name):
    h = hashlib.sha256()
    for part in ("v1", VERSIONS.get("java") or "", " ".join(JAVAC_OPTS), JAVA_HARNESS_CP, name, code):
        h.update(part.encode("utf-8") + b"\0")
    return h.hexdigest()


def _copy_tree(src, dst, uid):
    """src의 파일을 dst로 복사한다. uid가 있으면 그 uid 소유로(작업 폴더) 바꾼다."""
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        if uid >= 0:
            os.chown(target, uid, uid)
        for n in files:
            d = os.path.join(target, n)
            shutil.copyfile(os.path.join(root, n), d)
            os.chmod(d, 0o644)
            if uid >= 0:
                os.chown(d, uid, uid)


def _tree_size(path):
    return sum(os.path.getsize(os.path.join(r, n)) for r, _, fs in os.walk(path) for n in fs)


def class_cache_load(key, out, uid):
    """캐시에 있으면 out에 복사하고 True"""
    path = os.path.join(CLASS_CACHE_DIR, key)
    with _class_lock:
        if not os.path.isdir(path):
            return False
        os.utime(path)
        _copy_tree(path, out, uid)
    return True


def class_cache_store(key, out):
    """사용자 코드를 실행하기 전의 컴파일 결과를 넣는다. 용량을 넘으면 오래 안 쓴 것부터 지운다."""
    if CLASS_CACHE_BYTES <= 0:
        return
    with _class_lock:
        os.makedirs(CLASS_CACHE_DIR, mode=0o700, exist_ok=True)
        os.chmod(CLASS_CACHE_DIR, 0o700)
        path = os.path.join(CLASS_CACHE_DIR, key)
        if os.path.isdir(path):
            return
        tmp = tempfile.mkdtemp(prefix=".tmp-", dir=CLASS_CACHE_DIR)
        _copy_tree(out, tmp, -1)
        os.rename(tmp, path)
        entries = [os.path.join(CLASS_CACHE_DIR, n) for n in os.listdir(CLASS_CACHE_DIR) if not n.startswith(".")]
        entries.sort(key=lambda e: os.stat(e).st_mtime)
        sizes = {e: _tree_size(e) for e in entries}
        total = sum(sizes.values())
        while entries and total > CLASS_CACHE_BYTES and entries[0] != path:
            e = entries.pop(0)
            total -= sizes[e]
            shutil.rmtree(e, ignore_errors=True)


def _compiler_preexec():
    def fn():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
        if COMPILER_UID >= 0:
            resource.setrlimit(resource.RLIMIT_NPROC, (NPROC_LIMIT, NPROC_LIMIT))
            os.setgroups([])
            os.setgid(COMPILER_UID)
            os.setuid(COMPILER_UID)
            if SECCOMP:
                SECCOMP.install()
    return fn


class CompileServer:
    """runner/java/SolvelineCompiler를 띄워 두고 요청을 보낸다. 쓸 수 없으면 compile()이 None(예전 방식으로)."""

    RESTART_GAP_S = 10.0

    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
        self.pending = {}
        self.seq = 0
        self.started_at = 0.0
        self.disabled = not JAVA_COMPILE_SERVER or not os.path.isdir(COMPILER_CP)

    def _start(self):
        """lock을 잡고 부른다. 준비(예열)가 끝날 때까지 기다린다."""
        if self.proc and self.proc.poll() is None:
            return True
        if time.monotonic() - self.started_at < self.RESTART_GAP_S:
            return False  # 방금 죽었다: 잠시 예전 방식으로
        self.started_at = time.monotonic()
        cmd = ["java", "-Xmx" + COMPILER_XMX, "-XX:+UseSerialGC", "-Xshare:auto", "-Dfile.encoding=UTF-8", "-Djava.io.tmpdir=" + WORK_ROOT,
               "-cp", COMPILER_CP, "SolvelineCompiler", str(RUN_SLOTS), JAVA_HARNESS_CP]
        try:
            p = subprocess.Popen(cmd, cwd=WORK_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env=_sandbox_env(WORK_ROOT), preexec_fn=_compiler_preexec(), close_fds=True)
        except OSError as e:
            print("[runner] compile server unavailable:", e, flush=True)
            return False
        if p.stdout.readline() != b"ready\n":
            _kill_group(p.pid)
            p.wait()
            print("[runner] compile server failed to start", flush=True)
            return False
        self.proc = p
        threading.Thread(target=self._read, args=(p,), daemon=True).start()
        return True

    def _read(self, p):
        try:
            while True:
                head = p.stdout.readline()
                if not head:
                    break
                rid, code, size = head.decode().split()
                body = p.stdout.read(int(size)) if int(size) else b""
                with self.lock:
                    slot = self.pending.pop(rid, None)
                if slot:
                    slot[1].append((int(code), body.decode("utf-8", "replace")))
                    slot[0].set()
        except (ValueError, OSError):
            pass
        finally:
            with self.lock:
                if self.proc is p:
                    self.proc = None
                waiting = list(self.pending.values())
                self.pending.clear()
            for ev, _ in waiting:
                ev.set()  # 결과 없이 깨운다 → 예전 방식으로
            _kill_group(p.pid)
            p.wait()

    def warm(self):
        if not self.disabled:
            with self.lock:
                self._start()

    def stop(self):
        with self.lock:
            p = self.proc
            self.proc = None
        if p:
            _kill_group(p.pid)

    def compile(self, code, name, timeout=COMPILE_TIMEOUT_S):
        """(ok, 메시지, out 폴더를 가진 임시 폴더) 또는 None. 임시 폴더는 부른 쪽이 지운다."""
        if self.disabled:
            return None
        stage = tempfile.mkdtemp(prefix="compile-", dir=WORK_ROOT)
        try:
            os.chmod(stage, 0o700)
            os.makedirs(os.path.join(stage, "out"))
            src = os.path.join(stage, name)
            with open(src, "w", encoding="utf-8") as f:
                f.write(code)
            if COMPILER_UID >= 0:
                for path in (stage, os.path.join(stage, "out"), src):
                    os.chown(path, COMPILER_UID, COMPILER_UID)
            ev, box = threading.Event(), []
            with self.lock:
                if not self._start():
                    shutil.rmtree(stage, ignore_errors=True)
                    return None
                self.seq += 1
                rid = str(self.seq)
                self.pending[rid] = (ev, box)
                p = self.proc
                try:
                    p.stdin.write(("%s %s %s\n" % (rid, stage, name)).encode())
                    p.stdin.flush()
                except OSError:
                    self.pending.pop(rid, None)
                    shutil.rmtree(stage, ignore_errors=True)
                    return None
            if not ev.wait(timeout):
                # 한 요청이 오래 걸리면 서버를 끝낸다(같이 기다리던 요청은 예전 방식으로 다시 컴파일한다)
                _kill_group(p.pid)
                shutil.rmtree(stage, ignore_errors=True)
                return False, COMPILE_TIMEOUT_MSG, None
            if not box:
                shutil.rmtree(stage, ignore_errors=True)
                return None
            code_, msg = box[0]
            # javac 명령은 작업 폴더에서 상대 경로로 돌았다: 같은 문구가 되게 폴더 경로를 지운다
            return code_ == 0, msg.replace(stage + "/", ""), stage
        except BaseException:
            shutil.rmtree(stage, ignore_errors=True)
            raise


COMPILER = CompileServer()


def _javac_cold(name, work, job):
    p = run_proc(["javac", "-J-Xmx384m"] + JAVAC_OPTS + ["-d", "out", "-cp", JAVA_HARNESS_CP, name], work, timeout=COMPILE_TIMEOUT_S, job=job)
    if p.status == "ok":
        return True, ""
    return False, COMPILE_TIMEOUT_MSG if p.status == "timeout" else (p.stderr or p.stdout)


def _prepare_java(code, work, job):
    name = _java_file_name(code)
    with open(os.path.join(work, name), "w", encoding="utf-8") as f:
        f.write(code)
    out = os.path.join(work, "out")
    os.makedirs(out, exist_ok=True)
    uid = job.uid if job else SANDBOX_UID
    if uid >= 0:
        os.chown(out, uid, uid)
    key = _class_key(code, name)
    if class_cache_load(key, out, uid):
        return True, ""
    res = COMPILER.compile(code, name)
    if res is None:
        ok, msg = _javac_cold(name, work, job)
    else:
        ok, msg, stage = res
        try:
            if ok:
                _copy_tree(os.path.join(stage, "out"), out, uid)
        finally:
            if stage:
                shutil.rmtree(stage, ignore_errors=True)
    if ok:
        # 아직 사용자 코드를 실행하지 않았다: out은 javac 출력 그대로다
        class_cache_store(key, out)
    return ok, msg


def prepare(lang, code, work, job=None):
    """컴파일한다. 실패 시 (False, 메시지)."""
    if lang == "python":
        with open(os.path.join(work, SOLUTION_FILE), "w", encoding="utf-8") as f:
            f.write(code)
        p = run_proc([sys.executable, "-m", "py_compile", SOLUTION_FILE], work, timeout=COMPILE_TIMEOUT_S, job=job)
        if p.status != "ok":
            return False, (p.stderr or p.stdout).replace(work + "/", "")
        return True, ""
    return _prepare_java(code, work, job)


def java_cmd(*rest):
    return ["java", "-Xmx" + JAVA_XMX, "-XX:+UseSerialGC", "-Xshare:auto", "-Dfile.encoding=UTF-8",
            "-Dstdout.encoding=UTF-8", "-cp", "out" + os.pathsep + JAVA_HARNESS_CP] + list(rest)


def _base_result(p, actual):
    return {"status": "error", "stdout": p.stdout, "stderr": p.stderr, "timeMs": p.time_ms,
            "memoryMb": round(p.memory_kb / 1024, 1), "actual": actual}


def _explain_kill(p, res):
    if p.exit_code in (-9, 137) and not res["stderr"]:
        res["stderr"] = "프로세스가 강제 종료되었습니다 (메모리 초과 가능)."


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _function_proc(lang, work, limit_s, job):
    timeout = limit_s + STARTUP_SLACK_S[lang]
    if lang == "python":
        return run_proc([sys.executable, "-I", os.path.join(HARNESS_DIR, "py_harness.py"), work], work, as_limit=PY_AS_LIMIT,
                        timeout=timeout, job=job)
    return run_proc(java_cmd("SolvelineHarness", work), work, timeout=timeout, job=job)


# ─── 기동 기준값: 아무것도 하지 않는 풀이의 바깥 측정 시간(벽시계, CPU) ───

_TRIVIAL = {"python": "def solution(x):\n    return x\n", "java": "class Solution { int solution(int x) { return x; } }"}
_baselines = {}
_baseline_lock = threading.Lock()


def _calibrate(lang):
    job = Job(uid=SANDBOX_UID)
    work = tempfile.mkdtemp(prefix="cal-", dir=WORK_ROOT)
    try:
        os.chmod(work, 0o700)
        if SANDBOX_UID >= 0:
            os.chown(work, SANDBOX_UID, SANDBOX_UID)
        ok, _ = prepare(lang, _TRIVIAL[lang], work, job)
        if not ok:
            return None
        walls, cpus = [], []
        for _ in range(5):
            with open(os.path.join(work, "case.json"), "w", encoding="utf-8") as f:
                json.dump({"args": [1]}, f)
            p = _function_proc(lang, work, 1.0, job)
            if p.status != "ok":
                return None
            walls.append(p.time_ms)
            cpus.append(p.cpu_ms)
        return sorted(walls)[2], sorted(cpus)[2]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def baseline(lang):
    """(벽시계 ms, CPU ms). 측정에 실패하면 None(바깥 시간 검사를 하지 않는다)."""
    with _baseline_lock:
        if lang not in _baselines:
            try:
                _baselines[lang] = _calibrate(lang)
            except Exception as e:  # noqa: BLE001 - 기준값이 없어도 실행은 한다
                sys.stderr.write("baseline %s failed: %r\n" % (lang, e))
                _baselines[lang] = None
            if _baselines[lang] is None:
                sys.stderr.write("baseline %s unavailable\n" % lang)
        return _baselines[lang]


def _external_ms(lang, p):
    """바깥에서 잰 실행 시간에서 기동 기준값을 뺀 값. 다른 작업과 CPU를 나눠 벽시계가 늘거나,
    JIT·GC 스레드로 CPU 시간이 늘 수 있으므로 둘 중 작은 값을 쓴다."""
    b = baseline(lang)
    if b is None:
        return None
    return max(0.0, min(p.time_ms - b[0], p.cpu_ms - b[1]))


def _judge_value(res, r, expected, limit_s, external_ms=None, allowance_ms=0.0):
    """하네스가 돌려준 값으로 판정한다. 하네스는 사용자 코드와 같은 프로세스라 값을 믿지 않는다:
    반환값은 정답 비교에만 쓰고, 시간은 바깥 측정으로 상한을 확인한다."""
    if not isinstance(r, dict):
        r = {"ok": False, "error": "실행 결과를 읽지 못했습니다."}
    if not r.get("ok"):
        err = r.get("error", "")
        res["stderr"] = (res["stderr"] + "\n" + (err if isinstance(err, str) else "")).strip()
        return res
    if "value" not in r:
        res["stderr"] = (res["stderr"] + "\n실행 결과를 읽지 못했습니다.").strip()
        return res
    t = r.get("timeMs")
    res["timeMs"] = t if isinstance(t, (int, float)) and not isinstance(t, bool) and t >= 0 else res["timeMs"]
    res["actual"] = json.dumps(r["value"], ensure_ascii=False)
    over = external_ms is not None and external_ms > limit_s * 1000 + allowance_ms
    if over:
        res["timeMs"] = max(res["timeMs"], round(external_ms, 2))
    if over or res["timeMs"] > limit_s * 1000:
        res["status"] = "timeout"
    elif expected is None:
        res["status"] = "done"
    else:
        res["status"] = "pass" if _same(r["value"], expected) else "fail"
    return res


def run_function_case(lang, work, args, expected, limit_s, job=None):
    case_path = os.path.join(work, "case.json")
    result_path = os.path.join(work, "result.json")
    if os.path.exists(result_path):
        os.remove(result_path)
    case_text = json.dumps({"args": args}, ensure_ascii=False)
    with open(case_path, "w", encoding="utf-8") as f:
        f.write(case_text)
    p = _function_proc(lang, work, limit_s, job)

    res = _base_result(p, None)
    if p.status == "timeout":
        res["status"] = "timeout"
        return res
    r = _read_json(result_path)
    if not r or p.status != "ok":
        _explain_kill(p, res)
        return res
    allowance = TRUST_SLACK_MS + ARG_MS_PER_MB * len(case_text.encode("utf-8")) / 1_000_000
    return _judge_value(res, r, expected, limit_s, _external_ms(lang, p), allowance)


def run_stdin_case(lang, code, work, stdin, expected, limit_s, job=None):
    timeout = limit_s + STARTUP_SLACK_S[lang]
    if lang == "python":
        p = run_proc([sys.executable, SOLUTION_FILE], work, stdin.encode("utf-8"), as_limit=PY_AS_LIMIT, timeout=timeout, job=job)
    else:
        p = run_proc(java_cmd(_java_main_class(code)), work, stdin.encode("utf-8"), timeout=timeout, job=job)
    res = _base_result(p, p.stdout)
    if p.status == "timeout":
        res["status"] = "timeout"
    elif p.status != "ok":
        _explain_kill(p, res)
    elif expected is None:
        res["status"] = "done"
    else:
        res["status"] = "pass" if _norm_output(p.stdout) == _norm_output(expected) else "fail"
    return res


class TestsetMissing(Exception):
    pass


def _time_limit_s(req):
    try:
        limit_s = min(float(req.get("timeLimitMs") or RUN_TIMEOUT_S * 1000), RUN_TIMEOUT_S * 1000) / 1000
    except (TypeError, ValueError):
        raise ValueError("timeLimitMs 값이 올바르지 않습니다.")
    if limit_s < 0.1:
        raise ValueError("timeLimitMs는 100 이상이어야 합니다.")
    return limit_s


def _request_cases(req):
    if not req.get("testset"):
        return req.get("cases") or []
    cases = load_testset(req["testset"])
    if cases is None:
        raise TestsetMissing()
    return cases


def _validate(req):
    """요청을 검사해 (언어, 모드, 코드, 케이스, 케이스당 제한 초)를 돌려준다."""
    lang = req.get("language")
    mode = req.get("mode")
    code = req.get("code", "")
    cases = _request_cases(req)
    limit_s = _time_limit_s(req)
    if lang not in ("java", "python") or mode not in ("function", "stdin"):
        raise ValueError("language/mode 값이 올바르지 않습니다.")
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise ValueError("코드가 너무 깁니다.")
    if not isinstance(cases, list) or not 1 <= len(cases) <= MAX_CASES:
        raise ValueError("테스트 케이스는 1~%d개여야 합니다." % MAX_CASES)
    return lang, mode, code, cases, limit_s


def _skipped(msg):
    return {"status": "skipped", "stdout": "", "stderr": msg, "timeMs": 0, "memoryMb": 0, "actual": None}


def _cancelled_result(results, total):
    results = results + [_skipped(CANCELLED_MSG)] * (total - len(results))
    return {"compile": {"ok": True, "output": ""}, "results": results, "cancelled": True}


def _run_case(c, lang, mode, code, work, limit_s, job):
    # 케이스는 화면과 같은 형식: args = 리터럴 텍스트 목록, expected = 텍스트('' 이면 비교 안 함)
    exp_text = c.get("expected") or ""
    if mode == "function":
        args = [loads_literal(a) for a in c.get("args", [])]
        expected = loads_literal(exp_text) if exp_text.strip() else None
        return run_function_case(lang, work, args, expected, limit_s, job)
    return run_stdin_case(lang, code, work, c.get("stdin", ""), exp_text if exp_text.strip() else None, limit_s, job)


def _run_cases(cases, lang, mode, code, work, limit_s, job):
    results = []
    deadline = time.monotonic() + TOTAL_BUDGET_S
    for c in cases:
        if job.cancelled.is_set():
            return _cancelled_result(results, len(cases))
        if time.monotonic() > deadline:
            results.append(_skipped("전체 실행 시간 제한으로 건너뛰었습니다."))
            continue
        r = _run_case(c, lang, mode, code, work, limit_s, job)
        if job.cancelled.is_set():  # 실행 중에 중지된 케이스는 결과를 버린다
            return _cancelled_result(results, len(cases))
        results.append(r)
    return {"compile": {"ok": True, "output": ""}, "results": results}


def _compile_and_run(lang, mode, code, cases, limit_s, job):
    if job.cancelled.is_set():
        return _cancelled_result([], len(cases))
    work = tempfile.mkdtemp(prefix="run-", dir=WORK_ROOT)
    try:
        os.chmod(work, 0o700)
        if job.uid >= 0:
            os.chown(work, job.uid, job.uid)
        ok, msg = prepare(lang, code, work, job)
        if job.cancelled.is_set():
            return _cancelled_result([], len(cases))
        if not ok:
            return {"compile": {"ok": False, "output": msg}, "results": []}
        return _run_cases(cases, lang, mode, code, work, limit_s, job)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def execute(req):
    lang, mode, code, cases, limit_s = _validate(req)
    job_id = req.get("jobId")
    job = _job(job_id) if job_id else Job()
    try:
        uid = _uid_pool.get()
        try:
            job.uid = uid
            return _compile_and_run(lang, mode, code, cases, limit_s, job)
        finally:
            reap_uid(uid)
            _uid_pool.put(uid)
    finally:
        if job_id:
            with _jobs_lock:
                _jobs.pop(job_id, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "solveline-runner"
    sys_version = ""

    def _send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "up", "versions": VERSIONS})
        self._send(404, {"error": "not_found"})

    def do_PUT(self):
        m = re.fullmatch(r"/testsets/([0-9a-f]{64})", self.path)
        if not m:
            return self._send(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 64 * 1024 * 1024:
                return self._send(413, {"error": "테스트셋이 너무 큽니다."})
            store_testset(m.group(1), self.rfile.read(length))
            return self._send(200, {"stored": m.group(1)})
        except ValueError as e:
            return self._send(400, {"error": str(e)})

    def do_POST(self):
        m = re.fullmatch(r"/cancel/([0-9A-Za-z-]{1,64})", self.path)
        if m:
            cancel(m.group(1))
            return self._send(200, {"cancelled": m.group(1)})
        if self.path != "/run":
            return self._send(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 16 * 1024 * 1024:
                return self._send(413, {"error": "요청이 너무 큽니다."})
            req = json.loads(self.rfile.read(length) or b"{}")
            return self._send(200, execute(req))
        except TestsetMissing:
            return self._send(409, {"error": "testset_missing"})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - 서버는 죽지 않는다
            sys.stderr.write("run failed: %r\n" % (e,))
            return self._send(500, {"error": "실행 서버 오류"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        req, _ = super().get_request()
        return req, ("unix", 0)


def serve_unix(path, gid=-1):
    """unix 소켓 서버를 만든다. 소켓 0660·폴더 0750(gid가 있으면 root:gid, 없으면 root만)."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    if gid >= 0:
        os.chown(d, 0, gid)
    os.chmod(d, 0o750 if gid >= 0 else 0o700)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    old = os.umask(0o177)
    try:
        httpd = UnixHTTPServer(path, Handler)
    finally:
        os.umask(old)
    if gid >= 0:
        os.chown(path, 0, gid)
        os.chmod(path, 0o660)
    return httpd


if __name__ == "__main__":
    secure_testsets()
    # 컴파일 서버를 띄워 예열하고, 기동 기준값을 미리 잰다(첫 요청이 기다리지 않게). 예열과 겹치지 않게 차례로.
    threading.Thread(target=lambda: [COMPILER.warm()] + [baseline(lang) for lang in ("python", "java")], daemon=True).start()
    if SOCKET_PATH:
        print("solveline-runner unix:%s %s" % (SOCKET_PATH, VERSIONS), flush=True)
        serve_unix(SOCKET_PATH, SOCKET_GID).serve_forever()
    else:
        print("solveline-runner :%d %s" % (PORT, VERSIONS), flush=True)
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
