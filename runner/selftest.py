"""runner 자체 검사. CI에서 runner 이미지 안에서 실행한다: python3 selftest.py"""
import json
import os
import shutil
import stat
import sys
import tempfile
import threading

import server


def run(req):
    """셀프테스트는 값으로 적고, runner 형식(리터럴 텍스트)으로 바꿔 실행한다. raw=True면 그대로."""
    for c in req["cases"]:
        if c.pop("raw", False):
            continue
        if "args" in c:
            c["args"] = [json.dumps(a) for a in c["args"]]
        if "expected" in c:
            e = c["expected"]
            if e is None:
                c["expected"] = ""
            elif req["mode"] == "stdin":
                c["expected"] = e
            else:
                c["expected"] = json.dumps(e)
    return server.execute(req)

JAVA_SUM = """
import java.util.*;

class Solution {
    public int solution(int[] numbers, int k) {
        System.out.println("debug " + numbers.length);
        return Arrays.stream(numbers).sum() + k;
    }
}
"""

JAVA_ARR = """
import java.util.*;
class Solution {
    public String[] solution(String[] words, long[][] grid, char c, List<Integer> list) {
        return new String[] { words[0] + c, String.valueOf(grid[1][0] + list.get(0)) };
    }
}
"""

JAVA_STDIN = """
import java.util.Scanner;

public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int a = sc.nextInt(), b = sc.nextInt();
        System.out.println(a + b);
    }
}
"""

PY_SUM = """
def solution(numbers, k):
    print("debug", len(numbers))
    return sum(numbers) + k
"""

PY_TUPLE = """
def solution(s):
    return (s.upper(), [1.5, True])
"""

PY_LOOP = """
def solution(x):
    while True:
        pass
"""

PY_STDIN = """
a, b = map(int, input().split())
print(a + b)
"""


# seccomp: 막아야 할 호출은 EPERM, 채점에 필요한 스레드·자식 프로세스는 그대로 된다
PY_SECCOMP = """
import ctypes, errno, os, socket, subprocess, threading
def solution():
    def eperm(fn):
        try:
            fn()
            return False
        except OSError as e:
            return e.errno == errno.EPERM
    libc = ctypes.CDLL(None, use_errno=True)
    def ptrace_me():
        if libc.ptrace(0, 0, None, None) != 0:
            raise OSError(ctypes.get_errno(), 'ptrace')
    mode = [l.split()[1] for l in open('/proc/self/status') if l.startswith('Seccomp:')][0]
    t = threading.Thread(target=lambda: None)
    t.start()
    t.join()
    child = subprocess.run(['/bin/true']).returncode == 0
    return {
        'filter': mode == '2',
        'socket': eperm(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)),
        'unix_socket': eperm(lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)),
        'unshare': eperm(lambda: os.unshare(os.CLONE_NEWUSER)),
        'ptrace': eperm(ptrace_me),
        'threads_and_child': child,
    }
"""

JAVA_SECCOMP = """
class Solution {
    boolean solution() throws Exception {
        Thread t = new Thread(() -> {});
        t.start();
        t.join();
        try {
            java.nio.channels.SocketChannel.open();
            return false;
        } catch (java.io.IOException e) {
            return true;
        }
    }
}
"""

PY_ESCAPE = """
import os
def solution():
    def denied(fn):
        try:
            fn()
            return False
        except OSError:
            return True
    kill_server = denied(lambda: os.kill(1, 9))
    write_harness = denied(lambda: open('/opt/runner/server.py', 'a'))
    return [kill_server, write_harness, os.getuid() == 0]
"""


PY_UID = "import os, time\ndef solution():\n    time.sleep(1)\n    return os.getuid()\n"


def hardening_checks():
    """설정 확인(docs/security/2026-11-04-runner-audit.md): 테스트셋 권한, 슬롯별 uid, 소켓 권한, 기동 기준값."""
    ok = True
    mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)  # noqa: E731
    files = [f for f in os.listdir(server.TESTSET_DIR) if f.endswith(".json")] if os.path.isdir(server.TESTSET_DIR) else []
    ok &= check("testset cache root only (dir 0700, files 0600)",
                files and mode(server.TESTSET_DIR) == 0o700 and all(mode(os.path.join(server.TESTSET_DIR, f)) == 0o600 for f in files),
                (oct(mode(server.TESTSET_DIR)) if os.path.isdir(server.TESTSET_DIR) else None, files))
    if server.SANDBOX_UID >= 0 and server.RUN_SLOTS >= 2:
        out = []
        threads = [threading.Thread(target=lambda: out.append(run({"language": "python", "mode": "function", "code": PY_UID,
                                                                   "cases": [{"args": [], "expected": None}]})))
                   for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        uids = sorted(json.loads(r["results"][0]["actual"]) for r in out)
        ok &= check("concurrent jobs use different uids", len(set(uids)) == 2 and all(u > server.SANDBOX_UID for u in uids), uids)
    d = tempfile.mkdtemp(prefix="selftest-sock-")
    httpd = server.serve_unix(os.path.join(d, "s", "runner.sock"), 1000)
    try:
        st = os.stat(os.path.join(d, "s", "runner.sock"))
        ok &= check("runner socket 0660 root:judge", stat.S_IMODE(st.st_mode) == 0o660 and st.st_uid == 0 and st.st_gid == 1000
                    and mode(os.path.join(d, "s")) == 0o750, oct(st.st_mode))
    finally:
        httpd.server_close()
    for lang in ("python", "java"):
        b = server.baseline(lang)
        ok &= check("startup baseline measured (%s)" % lang, b is not None and b[0] > 0, b)
    return ok


def java_compile_checks():
    """0012 4단계: 예열 컴파일 서버와 컴파일 캐시. 판정·오류 문구는 예전 방식(javac 명령)과 같아야 한다."""
    ok = True
    bad = "class Solution {\n    int solution(int a) {\n        return a +;\n    }\n}\n"
    good = "class Solution { int solution(int a) { return a * 2; } }"

    def cold(code):
        work = tempfile.mkdtemp(dir=server.WORK_ROOT)
        try:
            os.chown(work, server.SANDBOX_UID, server.SANDBOX_UID) if server.SANDBOX_UID >= 0 else None
            with open(os.path.join(work, "Solution.java"), "w") as f:
                f.write(code)
            os.makedirs(os.path.join(work, "out"))
            if server.SANDBOX_UID >= 0:
                os.chown(os.path.join(work, "out"), server.SANDBOX_UID, server.SANDBOX_UID)
            return server._javac_cold("Solution.java", work, server.Job())
        finally:
            shutil.rmtree(work, ignore_errors=True)

    warm = server.COMPILER.compile(bad, "Solution.java")
    if warm and warm[2]:
        shutil.rmtree(warm[2], ignore_errors=True)
    ref = cold(bad)
    ok &= check("compile server output == javac command", warm is not None and warm[:2] == ref, (warm and warm[:2], ref))
    proc = server.COMPILER.proc
    status = {}
    if proc:
        with open("/proc/%d/status" % proc.pid) as f:
            status = dict(l.split(":", 1) for l in f if ":" in l)
    ok &= check("compile server runs as compiler uid with seccomp", proc is not None
                and status.get("Uid", "").split()[:1] == [str(server.COMPILER_UID)] and status.get("Seccomp", "").strip() == "2", status.get("Uid"))

    r1 = run({"language": "java", "mode": "function", "code": good, "cases": [{"args": [3], "expected": 6}]})
    key = server._class_key(good, "Solution.java")
    cached = os.path.isdir(os.path.join(server.CLASS_CACHE_DIR, key))
    calls = []
    orig = server.COMPILER.compile
    server.COMPILER.compile = lambda *a, **k: calls.append(a) or orig(*a, **k)
    try:
        r2 = run({"language": "java", "mode": "function", "code": good, "cases": [{"args": [4], "expected": 8}]})
    finally:
        server.COMPILER.compile = orig
    ok &= check("class cache hit skips compile", cached and not calls and r1["results"][0]["status"] == "pass"
                and r2["results"][0]["status"] == "pass", (cached, calls, r1, r2))
    st = os.stat(server.CLASS_CACHE_DIR)
    ok &= check("class cache root only (0700)", stat.S_IMODE(st.st_mode) == 0o700 and st.st_uid == 0, oct(st.st_mode))

    # 시간 초과면 서버를 끝내고, 다음 컴파일은 예전 방식(또는 다시 띄운 서버)으로 된다
    t = server.COMPILER.compile(good + " ", "Solution.java", timeout=0.0001)
    if t and t[2]:
        shutil.rmtree(t[2], ignore_errors=True)
    r3 = run({"language": "java", "mode": "function", "code": good + "  ", "cases": [{"args": [5], "expected": 10}]})
    ok &= check("compile timeout recovers", t is not None and t[:2] == (False, server.COMPILE_TIMEOUT_MSG) and r3["results"][0]["status"] == "pass", (t, r3))
    return ok


def check(name, cond, detail):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        print("   ", detail)
    return cond


def main():
    ok = True
    r = run({"language": "java", "mode": "function", "code": JAVA_SUM,
                        "cases": [{"args": [[1, 2, 3], 4], "expected": 10}, {"args": [[1], 1], "expected": 3}]})
    ok &= check("java function pass/fail", [x["status"] for x in r["results"]] == ["pass", "fail"], r)
    ok &= check("java stdout", r["results"][0]["stdout"].strip() == "debug 3", r)

    r = run({"language": "java", "mode": "function", "code": JAVA_ARR,
                        "cases": [{"args": [["ab"], [[1], [2]], "z", [5]], "expected": ["abz", "7"]}]})
    ok &= check("java arrays/char/list", r["results"][0]["status"] == "pass", r)

    r = run({"language": "java", "mode": "function", "code": "class Solution { int solution() { return } }",
                        "cases": [{"args": [], "expected": 1}]})
    ok &= check("java compile error", not r["compile"]["ok"] and "error" in r["compile"]["output"], r)

    r = run({"language": "java", "mode": "function",
                        "code": "class Solution { int solution(int a) { return 10 / a; } }",
                        "cases": [{"args": [0], "expected": 1}]})
    ok &= check("java runtime error", r["results"][0]["status"] == "error" and "ArithmeticException" in r["results"][0]["stderr"], r)

    r = run({"language": "java", "mode": "stdin", "code": JAVA_STDIN,
                        "cases": [{"stdin": "3 4\n", "expected": "7"}]})
    ok &= check("java stdin", r["results"][0]["status"] == "pass", r)

    r = run({"language": "python", "mode": "function", "code": PY_SUM,
                        "cases": [{"args": [[1, 2, 3], 4], "expected": 10}, {"args": [[1], 1], "expected": True}]})
    ok &= check("python function pass/fail(bool!=int)", [x["status"] for x in r["results"]] == ["pass", "fail"], r)

    r = run({"language": "python", "mode": "function", "code": PY_TUPLE,
                        "cases": [{"args": ["ab"], "expected": ["AB", [1.5, True]]}]})
    ok &= check("python tuple→list", r["results"][0]["status"] == "pass", r)

    r = run({"language": "python", "mode": "function", "code": "def solution(:\n  pass",
                        "cases": [{"args": [], "expected": 1}]})
    ok &= check("python syntax error", not r["compile"]["ok"], r)

    big = "123456789012345678901"
    r = run({"language": "python", "mode": "function", "code": "def solution(x):\n    return x * 10 + 1\n",
                        "cases": [{"args": ["12345678901234567890"], "expected": big, "raw": True}]})
    ok &= check("python big int exact", r["results"][0]["status"] == "pass", r)
    r = run({"language": "java", "mode": "function", "code": "class Solution { long solution(long x) { return x * 10 + 7; } }",
                        "cases": [{"args": ["900719925474099"], "expected": "9007199254740997", "raw": True}, {"args": ["900719925474099"], "expected": "9007199254740996", "raw": True}]})
    ok &= check("java long beyond 2^53", [x["status"] for x in r["results"]] == ["pass", "fail"], r)

    # 문제별 시간 제한: solution 호출 시간 기준(JVM 시작은 빼고)
    r = run({"language": "python", "mode": "function", "timeLimitMs": 200,
             "code": "import time\ndef solution(x):\n    t = time.time()\n    while time.time() - t < 0.5:\n        pass\n    return x\n",
             "cases": [{"args": [1], "expected": 1}]})
    ok &= check("time limit (python 0.5s > 200ms)", r["results"][0]["status"] == "timeout", r)
    r = run({"language": "java", "mode": "function", "timeLimitMs": 300, "code": "class Solution { int solution(int x) { return x; } }",
             "cases": [{"args": [1], "expected": 1}]})
    ok &= check("time limit excludes JVM startup", r["results"][0]["status"] == "pass", r)

    server.RUN_TIMEOUT_S = 2.0
    r = run({"language": "python", "mode": "function", "code": PY_LOOP,
                        "cases": [{"args": [1], "expected": 1}]})
    ok &= check("python timeout", r["results"][0]["status"] == "timeout", r)
    server.RUN_TIMEOUT_S = 10.0

    r = run({"language": "python", "mode": "stdin", "code": PY_STDIN,
                        "cases": [{"stdin": "3 4\n", "expected": "7\n"}, {"stdin": "1 1", "expected": None}]})
    ok &= check("python stdin", [x["status"] for x in r["results"]] == ["pass", "done"], r)

    # 테스트셋 캐시: 없으면 TestsetMissing, 올린 뒤에는 해시로 실행
    import hashlib
    raw = json.dumps([{"id": "h1", "args": ["[1, 2]", "3"], "stdin": "", "expected": "6", "hidden": True}]).encode()
    h = hashlib.sha256(raw).hexdigest()
    req = {"language": "python", "mode": "function", "code": PY_SUM, "testset": h}
    try:  # 이전 실행이 남긴 캐시를 지우고 시작
        import os
        os.remove(server.testset_path(h))
    except FileNotFoundError:
        pass
    try:
        server.execute(dict(req))
        ok &= check("testset missing -> 409", False, "no exception")
    except server.TestsetMissing:
        ok &= check("testset missing -> 409", True, "")
    server.store_testset(h, raw)
    r = server.execute(dict(req))
    ok &= check("testset cached run", r["results"][0]["status"] == "pass", r)
    try:
        server.store_testset(h, raw + b" ")
        ok &= check("testset hash verified", False, "accepted bad content")
    except ValueError:
        ok &= check("testset hash verified", True, "")

    # 중지: 실행 중인 프로세스를 죽이고 남은 케이스를 건너뛴다
    import threading
    import time
    loop = {"language": "python", "mode": "function", "code": "def solution(x):\n    while True:\n        pass\n",
            "timeLimitMs": 10000, "jobId": "selftest-cancel", "cases": [{"args": [1], "expected": 1}] * 3}
    out = {}
    t0 = time.monotonic()
    th = threading.Thread(target=lambda: out.update(r=run(loop)))
    th.start()
    time.sleep(1.5)
    server.cancel("selftest-cancel")
    th.join(15)
    r = out.get("r") or {}
    ok &= check("cancel running job", r.get("cancelled") is True and time.monotonic() - t0 < 5
                and [x["status"] for x in r["results"]] == ["skipped"] * 3, r)
    server.cancel("selftest-precancel")  # 요청보다 먼저 온 중지
    r = run({"language": "python", "mode": "function", "code": PY_SUM, "jobId": "selftest-precancel",
             "cases": [{"args": [[1], 1], "expected": 2}]})
    ok &= check("cancel before start", r.get("cancelled") is True and r["results"][0]["status"] == "skipped", r)

    if server.SANDBOX_UID >= 0:
        r = run({"language": "python", "mode": "function", "code": PY_ESCAPE,
                            "cases": [{"args": [], "expected": [True, True, False]}]})
        ok &= check("sandbox isolation", r["results"][0]["status"] == "pass", r)
        want = {"filter": True, "socket": True, "unix_socket": True, "unshare": True, "ptrace": True, "threads_and_child": True}
        r = run({"language": "python", "mode": "function", "code": PY_SECCOMP, "cases": [{"args": [], "expected": want}]})
        ok &= check("seccomp blocks socket/ptrace/unshare (python)", r["results"][0]["status"] == "pass", r)
        r = run({"language": "java", "mode": "function", "code": JAVA_SECCOMP, "cases": [{"args": [], "expected": True}]})
        ok &= check("seccomp blocks socket (java)", r["results"][0]["status"] == "pass", r)
        import seccomp_filter
        ok &= check("seccomp filter has no other arch path", seccomp_filter.program("i386") is None
                    and all(code & 0x07 != 0x05 or i + 1 + max(jt, jf) < len(prog)  # 점프는 프로그램 안에 떨어진다
                            for prog in [seccomp_filter.program("x86_64"), seccomp_filter.program("aarch64")]
                            for i, (code, jt, jf, _) in enumerate(prog))
                    and all(prog[-1][0] == 0x06 for prog in [seccomp_filter.program("x86_64"), seccomp_filter.program("aarch64")]), "")

    ok &= hardening_checks()
    if server.SANDBOX_UID >= 0:
        ok &= java_compile_checks()
    print("versions", server.VERSIONS)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
