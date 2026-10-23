#!/usr/bin/env bash
# main 머지 시 self-hosted runner(pahidc, solveline-production)에서 실행된다.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>/tmp/solveline-deploy.lock
flock 9

# 이미지를 먼저 빌드해 두면 예전 프로젝트를 내린 뒤 다시 뜰 때까지의 시간이 짧다
sudo docker compose -f compose.production.yaml build

# 예전 이름(codetest)에서 한 번 옮긴다: 예전 compose 프로젝트를 내리고 데이터 폴더를 옮긴 뒤, 예전 env 파일을 지운다.
if sudo docker ps -aq --filter label=com.docker.compose.project=codetest-production | grep -q .; then
  echo "예전 compose 프로젝트(codetest-production)를 내립니다."
  sudo docker compose -p codetest-production down --remove-orphans
fi
if sudo test -d /var/lib/codetest; then
  if sudo test -e /var/lib/solveline; then
    echo "/var/lib/codetest와 /var/lib/solveline이 모두 있습니다. 직접 확인하세요." >&2
    exit 1
  fi
  echo "/var/lib/codetest → /var/lib/solveline"
  sudo mv /var/lib/codetest /var/lib/solveline
fi
sudo rm -rf /etc/codetest

# /etc/solveline은 root 700, api.env는 root 600 → 확인과 compose(env_file 읽기)는 root로 실행한다.
sudo test -f /etc/solveline/api.env || { echo "/etc/solveline/api.env 없음" >&2; exit 1; }
sudo install -d -o 1000 -g 1000 -m 700 /var/lib/solveline
sudo docker compose -f compose.production.yaml config --quiet
sudo docker compose -f compose.production.yaml up -d --build --force-recreate --wait --wait-timeout 300
curl --fail --silent --show-error http://127.0.0.1:8083/api/health
# 오래된 빌드 캐시·이미지 정리 (서버 디스크 보호)
sudo docker image prune -f >/dev/null
