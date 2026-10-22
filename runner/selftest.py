"""runner 자체 검사. CI에서 runner 이미지 안에서 실행한다: python3 selftest.py"""
import sys

import server

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


def check(name, cond, detail):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        print("   ", detail)
    return cond


def main():
    ok = True
    r = server.execute({"language": "java", "mode": "function", "code": JAVA_SUM,
                        "cases": [{"args": [[1, 2, 3], 4], "expected": 10}, {"args": [[1], 1], "expected": 3}]})
    ok &= check("java function pass/fail", [x["status"] for x in r["results"]] == ["pass", "fail"], r)
    ok &= check("java stdout", r["results"][0]["stdout"].strip() == "debug 3", r)

    r = server.execute({"language": "java", "mode": "function", "code": JAVA_ARR,
                        "cases": [{"args": [["ab"], [[1], [2]], "z", [5]], "expected": ["abz", "7"]}]})
    ok &= check("java arrays/char/list", r["results"][0]["status"] == "pass", r)

    r = server.execute({"language": "java", "mode": "function", "code": "class Solution { int solution() { return } }",
                        "cases": [{"args": [], "expected": 1}]})
    ok &= check("java compile error", not r["compile"]["ok"] and "error" in r["compile"]["output"], r)

    r = server.execute({"language": "java", "mode": "function",
                        "code": "class Solution { int solution(int a) { return 10 / a; } }",
                        "cases": [{"args": [0], "expected": 1}]})
    ok &= check("java runtime error", r["results"][0]["status"] == "error" and "ArithmeticException" in r["results"][0]["stderr"], r)

    r = server.execute({"language": "java", "mode": "stdin", "code": JAVA_STDIN,
                        "cases": [{"stdin": "3 4\n", "expected": "7"}]})
    ok &= check("java stdin", r["results"][0]["status"] == "pass", r)

    r = server.execute({"language": "python", "mode": "function", "code": PY_SUM,
                        "cases": [{"args": [[1, 2, 3], 4], "expected": 10}, {"args": [[1], 1], "expected": True}]})
    ok &= check("python function pass/fail(bool!=int)", [x["status"] for x in r["results"]] == ["pass", "fail"], r)

    r = server.execute({"language": "python", "mode": "function", "code": PY_TUPLE,
                        "cases": [{"args": ["ab"], "expected": ["AB", [1.5, True]]}]})
    ok &= check("python tuple→list", r["results"][0]["status"] == "pass", r)

    r = server.execute({"language": "python", "mode": "function", "code": "def solution(:\n  pass",
                        "cases": [{"args": [], "expected": 1}]})
    ok &= check("python syntax error", not r["compile"]["ok"], r)

    big = "123456789012345678901"
    r = server.execute({"language": "python", "mode": "function", "code": "def solution(x):\n    return x * 10 + 1\n",
                        "cases": [{"argsJson": ["12345678901234567890"], "expectedJson": big}]})
    ok &= check("python big int exact", r["results"][0]["status"] == "pass", r)
    r = server.execute({"language": "java", "mode": "function", "code": "class Solution { long solution(long x) { return x * 10 + 7; } }",
                        "cases": [{"argsJson": ["900719925474099"], "expectedJson": "9007199254740997"}, {"argsJson": ["900719925474099"], "expectedJson": "9007199254740996"}]})
    ok &= check("java long beyond 2^53", [x["status"] for x in r["results"]] == ["pass", "fail"], r)

    server.RUN_TIMEOUT_S = 2.0
    r = server.execute({"language": "python", "mode": "function", "code": PY_LOOP,
                        "cases": [{"args": [1], "expected": 1}]})
    ok &= check("python timeout", r["results"][0]["status"] == "timeout", r)
    server.RUN_TIMEOUT_S = 10.0

    r = server.execute({"language": "python", "mode": "stdin", "code": PY_STDIN,
                        "cases": [{"stdin": "3 4\n", "expected": "7\n"}, {"stdin": "1 1", "expected": None}]})
    ok &= check("python stdin", [x["status"] for x in r["results"]] == ["pass", "done"], r)

    if server.SANDBOX_UID >= 0:
        r = server.execute({"language": "python", "mode": "function", "code": PY_ESCAPE,
                            "cases": [{"args": [], "expected": [True, True, False]}]})
        ok &= check("sandbox isolation", r["results"][0]["status"] == "pass", r)

    print("versions", server.VERSIONS)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
