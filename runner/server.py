"""코드 실행 서버 (runner 컨테이너 전용, 인터넷 차단 네트워크).

api만 이 서버를 호출한다. 서버는 root로 돌고, 사용자 코드는 항상 sandbox uid로
낮춘 별도 프로세스 그룹에서 rlimit·시간 제한을 걸어 실행한다.
서버에 남기는 capability(CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL)는 setuid 후 자식에 남지 않는다.
Python 3.8 표준 라이브러리만 쓴다 (사용자 코드와 같은 인터프리터).
"""
import hashlib
import json
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HARNESS_DIR = os.environ.get("HARNESS_DIR", os.path.dirname(os.path.abspath(__file__)))
JAVA_HARNESS_CP = os.environ.get("JAVA_HARNESS_CP", os.path.join(HARNESS_DIR, "java"))
SANDBOX_UID = int(os.environ.get("SANDBOX_UID", "-1"))  # -1이면 낮추지 않음 (로컬 개발)
WORK_ROOT = os.environ.get("WORK_ROOT", tempfile.gettempdir())
PORT = int(os.environ.get("PORT", "8000"))

RUN_TIMEOUT_S = float(os.environ.get("RUN_TIMEOUT_S", "10"))  # 문제가 시간 제한을 정하지 않으면 10초
# 시간 제한은 solution 호출(입출력형은 실행) 시간 기준이다. 프로세스는 언어별 시작 시간만큼 여유를 두고 종료한다.
STARTUP_SLACK_S = {"java": 3.0, "python": 1.0}
COMPILE_TIMEOUT_S = 30.0
JAVA_XMX = os.environ.get("JAVA_XMX", "512m")
PY_AS_LIMIT = int(os.environ.get("PY_AS_LIMIT_MB", "1024")) * 1024 * 1024
OUTPUT_LIMIT = 64 * 1024
MAX_CASES = 200
# 요청 하나의 전체 실행 시간 상한. (api는 비동기 큐라 Cloudflare 응답 제한과 무관하다)
TOTAL_BUDGET_S = float(os.environ.get("TOTAL_BUDGET_S", "600"))
MAX_CODE = 200 * 1024

# 테스트셋 캐시: api가 해시만 보내고, 없을 때만 내용을 올린다(파일은 내용이 바뀌지 않는다).
TESTSET_DIR = os.environ.get("TESTSET_DIR", os.path.join(WORK_ROOT, "testsets"))
TESTSET_CACHE_BYTES = int(os.environ.get("TESTSET_CACHE_MB", "200")) * 1024 * 1024
_testset_lock = threading.Lock()


def testset_path(h):
    if not re.fullmatch(r"[0-9a-f]{64}", h or ""):
        raise ValueError("테스트셋 해시가 올바르지 않습니다.")
    return os.path.join(TESTSET_DIR, h + ".json")


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
        os.makedirs(TESTSET_DIR, exist_ok=True)
        tmp = testset_path(h) + ".tmp"
        with open(tmp, "wb") as f:
            f.write(raw)
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


# 한 번에 실행하는 요청 수 (단일 사용자, 4코어 서버)
_slots = threading.BoundedSemaphore(int(os.environ.get("RUN_SLOTS", "2")))


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
    def __init__(self, status, exit_code, stdout, stderr, time_ms, memory_kb):
        self.status = status  # ok | timeout | error
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        self.time_ms = time_ms
        self.memory_kb = memory_kb


def _preexec(as_limit):
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
        if SANDBOX_UID >= 0:
            resource.setrlimit(resource.RLIMIT_NPROC, (512, 512))
            os.setgroups([])
            os.setgid(SANDBOX_UID)
            os.setuid(SANDBOX_UID)
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


def run_proc(cmd, cwd, stdin_data=b"", timeout=None, as_limit=0):
    timeout = RUN_TIMEOUT_S if timeout is None else timeout
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": cwd,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "JAVA_HOME": os.environ.get("JAVA_HOME", ""),
    }
    start = time.monotonic()
    p = subprocess.Popen(
        cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        preexec_fn=_preexec(as_limit), close_fds=True,
    )
    out, err = [], []
    readers = [threading.Thread(target=_read_capped, args=(p.stdout, out)),
               threading.Thread(target=_read_capped, args=(p.stderr, err))]
    for t in readers:
        t.start()
    try:
        p.stdin.write(stdin_data)
        p.stdin.close()
    except BrokenPipeError:
        pass

    timed_out = threading.Event()

    def kill():
        timed_out.set()
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    timer = threading.Timer(timeout, kill)
    timer.start()
    # wait4로 기다려야 이 자식의 최대 RSS를 얻을 수 있다.
    _, wstatus, usage = os.wait4(p.pid, 0)
    elapsed = (time.monotonic() - start) * 1000
    timer.cancel()
    try:  # 남은 자손 프로세스 정리
        os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    p.returncode = os.waitstatus_to_exitcode(wstatus) if hasattr(os, "waitstatus_to_exitcode") else (
        -os.WTERMSIG(wstatus) if os.WIFSIGNALED(wstatus) else os.WEXITSTATUS(wstatus))
    for t in readers:
        t.join(2)
    if p.returncode == -signal.SIGXCPU:  # CPU 시간 제한
        timed_out.set()
    status = "timeout" if timed_out.is_set() else ("ok" if p.returncode == 0 else "error")
    return Proc(status, p.returncode, b"".join(out).decode("utf-8", "replace"),
                b"".join(err).decode("utf-8", "replace"), round(elapsed, 2),
                usage.ru_maxrss // 1024 if sys.platform == "darwin" else usage.ru_maxrss)


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


def prepare(lang, code, work):
    """컴파일한다. 실패 시 (False, 메시지)."""
    if lang == "python":
        with open(os.path.join(work, "solution.py"), "w", encoding="utf-8") as f:
            f.write(code)
        p = run_proc([sys.executable, "-m", "py_compile", "solution.py"], work, timeout=COMPILE_TIMEOUT_S)
        if p.status != "ok":
            return False, (p.stderr or p.stdout).replace(work + "/", "")
        return True, ""
    name = _java_file_name(code)
    with open(os.path.join(work, name), "w", encoding="utf-8") as f:
        f.write(code)
    os.makedirs(os.path.join(work, "out"), exist_ok=True)
    if SANDBOX_UID >= 0:
        os.chown(os.path.join(work, "out"), SANDBOX_UID, SANDBOX_UID)
    p = run_proc(["javac", "-J-Xmx384m", "-encoding", "UTF-8", "-nowarn", "-d", "out", "-cp", JAVA_HARNESS_CP, name],
                 work, timeout=COMPILE_TIMEOUT_S)
    if p.status != "ok":
        msg = p.stderr or p.stdout
        if p.status == "timeout":
            msg = "컴파일 시간이 초과되었습니다."
        return False, msg
    return True, ""


def java_cmd(*rest):
    return ["java", "-Xmx" + JAVA_XMX, "-XX:+UseSerialGC", "-Xshare:auto", "-Dfile.encoding=UTF-8",
            "-Dstdout.encoding=UTF-8", "-cp", "out" + os.pathsep + JAVA_HARNESS_CP] + list(rest)


def run_function_case(lang, work, args, expected, limit_s):
    case_path = os.path.join(work, "case.json")
    result_path = os.path.join(work, "result.json")
    for path in (result_path,):
        if os.path.exists(path):
            os.remove(path)
    with open(case_path, "w", encoding="utf-8") as f:
        json.dump({"args": args}, f, ensure_ascii=False)
    if lang == "python":
        p = run_proc([sys.executable, "-I", os.path.join(HARNESS_DIR, "py_harness.py"), work], work, as_limit=PY_AS_LIMIT,
                     timeout=limit_s + STARTUP_SLACK_S[lang])
    else:
        p = run_proc(java_cmd("CodetestHarness", work), work, timeout=limit_s + STARTUP_SLACK_S[lang])

    res = {"status": "error", "stdout": p.stdout, "stderr": p.stderr, "timeMs": p.time_ms,
           "memoryMb": round(p.memory_kb / 1024, 1), "actual": None}
    if p.status == "timeout":
        res["status"] = "timeout"
        return res
    try:
        with open(result_path, encoding="utf-8") as f:
            r = json.load(f)
    except (OSError, ValueError):
        r = None
    if not r or p.status != "ok":
        if p.exit_code in (-9, 137) and not res["stderr"]:
            res["stderr"] = "프로세스가 강제 종료되었습니다 (메모리 초과 가능)."
        res["status"] = "error"
        return res
    if not r.get("ok"):
        res["stderr"] = (res["stderr"] + "\n" + r.get("error", "")).strip()
        return res
    res["timeMs"] = r.get("timeMs", res["timeMs"])
    res["actual"] = json.dumps(r["value"], ensure_ascii=False)
    if res["timeMs"] > limit_s * 1000:
        res["status"] = "timeout"
        return res
    res["status"] = "pass" if expected is None or _same(r["value"], expected) else "fail"
    if expected is None:
        res["status"] = "done"
    return res


def run_stdin_case(lang, code, work, stdin, expected, limit_s):
    timeout = limit_s + STARTUP_SLACK_S[lang]
    if lang == "python":
        p = run_proc([sys.executable, "solution.py"], work, stdin.encode("utf-8"), as_limit=PY_AS_LIMIT, timeout=timeout)
    else:
        p = run_proc(java_cmd(_java_main_class(code)), work, stdin.encode("utf-8"), timeout=timeout)
    res = {"status": "error", "stdout": p.stdout, "stderr": p.stderr, "timeMs": p.time_ms,
           "memoryMb": round(p.memory_kb / 1024, 1), "actual": p.stdout}
    if p.status == "timeout":
        res["status"] = "timeout"
    elif p.status != "ok":
        if p.exit_code in (-9, 137) and not res["stderr"]:
            res["stderr"] = "프로세스가 강제 종료되었습니다 (메모리 초과 가능)."
    elif expected is None:
        res["status"] = "done"
    else:
        res["status"] = "pass" if _norm_output(p.stdout) == _norm_output(expected) else "fail"
    return res


class TestsetMissing(Exception):
    pass


def execute(req):
    lang = req.get("language")
    mode = req.get("mode")
    code = req.get("code", "")
    if req.get("testset"):
        cases = load_testset(req["testset"])
        if cases is None:
            raise TestsetMissing()
    else:
        cases = req.get("cases") or []
    try:
        limit_s = min(float(req.get("timeLimitMs") or RUN_TIMEOUT_S * 1000), RUN_TIMEOUT_S * 1000) / 1000
    except (TypeError, ValueError):
        raise ValueError("timeLimitMs 값이 올바르지 않습니다.")
    if limit_s < 0.1:
        raise ValueError("timeLimitMs는 100 이상이어야 합니다.")
    if lang not in ("java", "python") or mode not in ("function", "stdin"):
        raise ValueError("language/mode 값이 올바르지 않습니다.")
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise ValueError("코드가 너무 깁니다.")
    if not isinstance(cases, list) or not 1 <= len(cases) <= MAX_CASES:
        raise ValueError("테스트 케이스는 1~%d개여야 합니다." % MAX_CASES)

    with _slots:
        work = tempfile.mkdtemp(prefix="run-", dir=WORK_ROOT)
        try:
            os.chmod(work, 0o700)
            if SANDBOX_UID >= 0:
                os.chown(work, SANDBOX_UID, SANDBOX_UID)
            ok, msg = prepare(lang, code, work)
            if not ok:
                return {"compile": {"ok": False, "output": msg}, "results": []}
            results = []
            deadline = time.monotonic() + TOTAL_BUDGET_S
            for c in cases:
                if time.monotonic() > deadline:
                    results.append({"status": "skipped", "stdout": "", "stderr": "전체 실행 시간 제한으로 건너뛰었습니다.",
                                    "timeMs": 0, "memoryMb": 0, "actual": None})
                    continue
                # 케이스는 화면과 같은 형식: args = 리터럴 텍스트 목록, expected = 텍스트('' 이면 비교 안 함)
                exp_text = c.get("expected") or ""
                if mode == "function":
                    args = [loads_literal(a) for a in c.get("args", [])]
                    expected = loads_literal(exp_text) if exp_text.strip() else None
                    results.append(run_function_case(lang, work, args, expected, limit_s))
                else:
                    results.append(run_stdin_case(lang, code, work, c.get("stdin", ""), exp_text if exp_text.strip() else None, limit_s))
            return {"compile": {"ok": True, "output": ""}, "results": results}
        finally:
            shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "codetest-runner"
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


if __name__ == "__main__":
    print("codetest-runner :%d %s" % (PORT, VERSIONS), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
