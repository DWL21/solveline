#!/usr/bin/env bash
# 로컬 Jenkins로 Jenkinsfile을 실제로 돌려 본다.
#   ci/jenkins/run.sh [브랜치]   Jenkins를 띄우고(처음엔 이미지 빌드) 'solveline-quality' 작업을 실행해 결과를 기다린다.
#   ci/jenkins/run.sh down        Jenkins를 내린다(작업 기록은 ~/.solveline-jenkins에 남는다).
# 관리자 비밀번호는 처음 실행할 때 임의로 만들어 ci/jenkins/.env.local에 둔다(커밋 금지). 화면: http://localhost:8099
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE=.env.local
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  echo "JENKINS_ADMIN_PASSWORD=$(openssl rand -hex 16)" > "$ENV_FILE"
fi
set -a; . "$ENV_FILE"; set +a
export JENKINS_HOME_DIR="${JENKINS_HOME_DIR:-$HOME/.solveline-jenkins}"
export REPO_DIR="$(cd ../.. && pwd)"
export JENKINS_PORT="${JENKINS_PORT:-8099}"
mkdir -p "$JENKINS_HOME_DIR"

if [ "${1:-}" = down ]; then docker compose down; exit 0; fi
export JENKINS_BRANCH="${1:-$(git -C "$REPO_DIR" branch --show-current)}"

docker compose up -d --build
URL="http://localhost:${JENKINS_PORT}"
AUTH=(-u "admin:${JENKINS_ADMIN_PASSWORD}")
echo "Jenkins 기다리는 중…"
for _ in $(seq 1 120); do curl -fs "${AUTH[@]}" "$URL/api/json" >/dev/null 2>&1 && break; sleep 5; done
# 작업 정의(JCasC)가 브랜치를 반영하도록 다시 읽는다
curl -fsS "${AUTH[@]}" -X POST "$URL/configuration-as-code/reload" >/dev/null || true

JAR=$(mktemp)
CRUMB=$(curl -fsS -c "$JAR" "${AUTH[@]}" "$URL/crumbIssuer/api/json" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["crumbRequestField"]+":"+d["crumb"])')
NEXT=$(curl -fsS "${AUTH[@]}" "$URL/job/solveline-quality/api/json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["nextBuildNumber"])')
curl -fsS -b "$JAR" "${AUTH[@]}" -H "$CRUMB" -X POST "$URL/job/solveline-quality/buildWithParameters" >/dev/null
echo "빌드 #$NEXT 시작: $URL/job/solveline-quality/$NEXT/"
for _ in $(seq 1 60); do curl -fs "${AUTH[@]}" "$URL/job/solveline-quality/$NEXT/api/json" >/dev/null 2>&1 && break; sleep 5; done
while :; do
  R=$(curl -fsS "${AUTH[@]}" "$URL/job/solveline-quality/$NEXT/api/json" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["result"] or "")')
  [ -n "$R" ] && break
  sleep 15
done
curl -fsS "${AUTH[@]}" "$URL/job/solveline-quality/$NEXT/consoleText" | tail -40
echo "결과: $R"
[ "$R" = SUCCESS ]
