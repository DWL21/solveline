#!/usr/bin/env bash
# SonarQube 정적 분석 + 품질 게이트. 로컬과 GitHub Actions가 같은 스크립트를 쓴다.
#   1) Docker로 SonarQube를 띄운다(매번 새 서버 → 기준이 흔들리지 않는다)
#   2) 관리자 비밀번호를 임의 값으로 바꾸고 분석 토큰을 만든다(출력하지 않는다)
#   3) 프로젝트 품질 게이트(코드 전체 기준)를 만든다: 신뢰성·보안 등급 A, 보안 핫스팟 검토 100%는 리포트만, 중복 < 5%, 커버리지 >= 75%
#   4) 단위 테스트 커버리지(lcov)와 함께 분석하고, 결과·지표를 reports/quality/sonar.json에 남긴다
#   5) 품질 게이트가 ERROR면 종료 코드 1
# 환경 변수: SONAR_KEEP=1 이면 끝나도 서버를 내리지 않는다(브라우저로 결과를 보려면 http://localhost:9000).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${SONAR_PORT:-9000}
# 컨테이너 안에서 실행하면 SERVICE_HOST=host.docker.internal
URL="http://${SERVICE_HOST:-localhost}:${PORT}"
OUT=reports/quality
mkdir -p "$OUT"
COMPOSE=(docker compose -f compose.quality.yaml)

cleanup() { if [ "${SONAR_KEEP:-0}" != 1 ]; then "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

echo "▶ 커버리지 측정"
(cd apps/api && pnpm -s exec vitest run --coverage >/dev/null 2>&1) || { echo '커버리지 측정 실패'; exit 1; }

echo "▶ SonarQube 시작"
"${COMPOSE[@]}" up -d --wait --wait-timeout 600

# 새 서버의 처음 관리자 계정(이미지 기본값: 아이디와 같은 비밀번호)을 곧바로 임의 비밀번호로 바꾼다
ADMIN_USER=admin
FIRST_PASS=$ADMIN_USER
ADMIN_PASS="$(openssl rand -hex 16)Aa1!"
curl -fsS --user "$ADMIN_USER:$FIRST_PASS" -X POST "$URL/api/users/change_password" --data-urlencode "login=$ADMIN_USER" --data-urlencode "previousPassword=$FIRST_PASS" --data-urlencode "password=$ADMIN_PASS" >/dev/null
api() { curl -fsS --user "$ADMIN_USER:$ADMIN_PASS" "$@"; }

TOKEN=$(api -X POST "$URL/api/user_tokens/generate" --data-urlencode "name=ci-$(date +%s)" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
api -X POST "$URL/api/projects/create" -d "project=solveline&name=Solveline" >/dev/null

# 품질 게이트(코드 전체 기준). 서버를 매번 새로 띄우므로 "새 코드" 기준 대신 전체 기준으로 판정한다.
GATE=$(api -X POST "$URL/api/qualitygates/create" --data-urlencode "name=Solveline" | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])')
cond() { api -X POST "$URL/api/qualitygates/create_condition" --data-urlencode "gateName=$GATE" -d "metric=$1&op=$2&error=$3" >/dev/null; }
cond reliability_rating GT 1      # 버그: 등급 A만 통과
cond security_rating GT 1         # 취약점: 등급 A만 통과
cond duplicated_lines_density GT 5
cond coverage LT 75
api -X POST "$URL/api/qualitygates/select" --data-urlencode "gateName=$GATE" -d "projectKey=solveline" >/dev/null

echo "▶ 분석"
# 스캐너는 호스트에서 npm 패키지(@sonar/scan, JRE는 서버에서 받아 쓴다)로 돌린다.
# Docker 안에서 서버와 스캐너를 함께 돌리면 작은 머신에서 메모리가 모자라 서버가 강제 종료된다.
pnpm exec sonar-scanner-npm -Dsonar.host.url="$URL" -Dsonar.token="$TOKEN" -Dsonar.qualitygate.wait=false -Dsonar.javascript.node.maxspace=2048 \
  >"$OUT/sonar-scanner.log" 2>&1 || { tail -40 "$OUT/sonar-scanner.log"; exit 1; }

# 스캐너가 기록한 이번 작업 ID로 완료를 확인한다.
TASK_ID=$(python3 -c 'from pathlib import Path; print(dict(line.split("=", 1) for line in Path(".scannerwork/report-task.txt").read_text().splitlines() if "=" in line)["ceTaskId"])')
# 백그라운드 분석 작업이 끝날 때까지
for _ in $(seq 1 120); do
  STATUS=$(api "$URL/api/ce/task?id=$TASK_ID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["task"]["status"])')
  [ "$STATUS" = SUCCESS ] && break
  case "$STATUS" in FAILED|CANCELED) echo "분석 작업 실패: $STATUS"; exit 1;; esac
  sleep 3
done
[ "$STATUS" = SUCCESS ] || { echo "분석 작업 완료 대기 시간 초과" >&2; exit 1; }

api "$URL/api/issues/search?componentKeys=solveline&resolved=false&ps=500&rules=typescript:S3776,python:S3776" > /tmp/claude-501/s3776.json
METRICS=bugs,vulnerabilities,code_smells,security_hotspots,coverage,line_coverage,branch_coverage,duplicated_lines_density,ncloc,reliability_rating,security_rating,sqale_rating,sqale_index,cognitive_complexity
api "$URL/api/qualitygates/project_status?projectKey=solveline" > "$OUT/sonar-gate.json"
api "$URL/api/measures/component?component=solveline&metricKeys=$METRICS" > "$OUT/sonar-measures.json"
api "$URL/api/issues/search?componentKeys=solveline&resolved=false&ps=1&facets=severities,types,rules" > "$OUT/sonar-issues.json"
api "$URL/api/issues/search?componentKeys=solveline&resolved=false&ps=100&types=BUG,VULNERABILITY&s=SEVERITY&asc=false" > "$OUT/sonar-bugs.json"
python3 - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
gate = json.load(open(f"{out}/sonar-gate.json"))["projectStatus"]
measures = {m["metric"]: m.get("value") for m in json.load(open(f"{out}/sonar-measures.json"))["component"]["measures"]}
issues = json.load(open(f"{out}/sonar-issues.json"))
facets = {f["property"]: {v["val"]: v["count"] for v in f["values"]} for f in issues.get("facets", [])}
bugs = [{"type": i["type"], "severity": i["severity"], "rule": i["rule"], "file": i["component"].split(":", 1)[1], "line": i.get("line"), "message": i["message"]} for i in json.load(open(f"{out}/sonar-bugs.json"))["issues"]]
json.dump({"gate": gate["status"], "conditions": gate.get("conditions", []), "measures": measures, "issues": facets, "bugs": bugs}, open(f"{out}/sonar.json", "w"), ensure_ascii=False, indent=2)
for b in bugs:
    print(f"  {b['type']} {b['severity']} {b['file']}:{b['line']} {b['rule']} {b['message']}")
print(f"품질 게이트: {gate['status']}")
for c in gate.get("conditions", []):
    print(f"  {c['status']:5} {c['metricKey']}: {c.get('actualValue')} (기준 {c['comparator']} {c['errorThreshold']})")
PY
[ "$(python3 -c 'import json;print(json.load(open("reports/quality/sonar.json"))["gate"])')" = OK ]
