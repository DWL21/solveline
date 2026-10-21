"""Python 함수형 문제 실행기: solution.py의 solution(*args)를 한 번 호출한다.

사용자 print는 그대로 stdout으로 나가고, 반환값은 result.json에 기록한다.
"""
import json
import os
import sys
import time
import traceback


def to_json(v):
    if isinstance(v, (tuple, list, set, frozenset)):
        items = sorted(v) if isinstance(v, (set, frozenset)) else v
        return [to_json(x) for x in items]
    if isinstance(v, dict):
        return {str(k): to_json(x) for k, x in v.items()}
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    raise TypeError("반환할 수 없는 타입입니다: %s" % type(v).__name__)


def main():
    work = sys.argv[1]
    os.chdir(work)
    sys.path.insert(0, work)
    sys.argv = ["solution.py"]
    with open("case.json", encoding="utf-8") as f:
        args = json.load(f)["args"]

    def write(obj):
        sys.stdout.flush()
        with open(os.path.join(work, "result.json"), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)

    try:
        ns = {"__name__": "solution", "__file__": os.path.join(work, "solution.py")}
        with open("solution.py", encoding="utf-8") as f:
            code = compile(f.read(), "solution.py", "exec")
        exec(code, ns)
        fn = ns.get("solution")
        if not callable(fn):
            write({"ok": False, "error": "solution 함수가 없습니다."})
            return
        start = time.perf_counter()
        value = fn(*args)
        elapsed = (time.perf_counter() - start) * 1000
        write({"ok": True, "value": to_json(value), "timeMs": round(elapsed, 2)})
    except BaseException:  # noqa: BLE001 - SystemExit/RecursionError도 보고
        tb = traceback.format_exc().replace(work + "/", "")
        write({"ok": False, "error": tb})


if __name__ == "__main__":
    main()
