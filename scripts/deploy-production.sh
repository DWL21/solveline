#!/usr/bin/env bash
# main 머지 시 self-hosted runner(pahidc, codetest-production)에서 실행된다.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>/tmp/codetest-deploy.lock
flock 9
test -f /etc/codetest/api.env || { echo "/etc/codetest/api.env 없음" >&2; exit 1; }
sudo install -d -o 1000 -g 1000 -m 700 /var/lib/codetest
docker compose -f compose.production.yaml config --quiet
docker compose -f compose.production.yaml up -d --build --force-recreate --wait --wait-timeout 300
curl --fail --silent --show-error http://127.0.0.1:8083/api/health
# 오래된 빌드 캐시·이미지 정리 (서버 디스크 보호)
docker image prune -f >/dev/null
