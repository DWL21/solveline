#!/usr/bin/env bash
# 자동화 테스트 환경(Docker) 관리. 로컬과 GitHub Actions가 같은 스크립트를 쓴다.
#   scripts/test-env.sh up      이미지를 빌드하고 띄운 뒤 준비될 때까지 기다린다. 비밀 값은 e2e/.env.local에 새로 만든다.
#   scripts/test-env.sh down    내리고 지운다(데이터는 tmpfs라 남지 않는다).
#   scripts/test-env.sh logs    컨테이너 로그(실패 분석용)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=e2e/.env.local
# 컨테이너 안에서 실행하면 호스트에 띄운 테스트 환경을 host.docker.internal로 부른다
HOST=${SERVICE_HOST:-localhost}
COMPOSE=(docker compose -f compose.test.yaml)

rand() { openssl rand -hex 24; }

case "${1:-up}" in
  up)
    mkdir -p e2e
    if [ ! -f "$ENV_FILE" ]; then
      umask 077
      {
        echo "E2E_PORT=${E2E_PORT:-8090}"
        echo "E2E_SESSION_SECRET=$(rand)"
        echo "E2E_TEST_AUTH_TOKEN=$(rand)"
        echo "E2E_MASTER_PASSWORD=$(rand)"
      } > "$ENV_FILE"
    fi
    set -a; . "$ENV_FILE"; set +a
    "${COMPOSE[@]}" up -d --build --wait --wait-timeout 300
    curl -fsS "http://${HOST}:${E2E_PORT}/api/health" >/dev/null
    echo "테스트 환경 준비됨: http://${HOST}:${E2E_PORT}"
    ;;
  down)
    if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
    E2E_SESSION_SECRET=${E2E_SESSION_SECRET:-x} E2E_TEST_AUTH_TOKEN=${E2E_TEST_AUTH_TOKEN:-x} E2E_MASTER_PASSWORD=${E2E_MASTER_PASSWORD:-x} \
      "${COMPOSE[@]}" down --remove-orphans --volumes
    ;;
  logs)
    if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
    E2E_SESSION_SECRET=${E2E_SESSION_SECRET:-x} E2E_TEST_AUTH_TOKEN=${E2E_TEST_AUTH_TOKEN:-x} E2E_MASTER_PASSWORD=${E2E_MASTER_PASSWORD:-x} \
      "${COMPOSE[@]}" logs --no-color --timestamps
    ;;
  *) echo "사용법: $0 up|down|logs" >&2; exit 2 ;;
esac
