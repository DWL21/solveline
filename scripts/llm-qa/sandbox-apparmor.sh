#!/usr/bin/env bash
# pahidc: QA 에이전트(0011)의 Codex 샌드박스가 동작하게 한다. 사람이 한 번 실행한다(sudo). 배포가 자동으로 하지 않는다.
#   scripts/llm-qa/sandbox-apparmor.sh
# Codex는 셸 명령을 bubblewrap으로 가둔다(체크아웃 폴더만 쓰기, 네트워크 없음). Ubuntu 24.04는 비특권 사용자 네임스페이스를
# AppArmor로 막아(kernel.apparmor_restrict_unprivileged_userns=1) bwrap이 "loopback: Failed RTM_NEWADDR"로 실패한다.
# 서버 전체 제한은 그대로 두고 /usr/bin/bwrap 하나에만 userns를 허용한다(Ubuntu가 이런 프로그램에 권하는 방식).
set -euo pipefail
command -v bwrap >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap
sudo tee /etc/apparmor.d/bwrap-solveline >/dev/null <<'PROFILE'
# QA 에이전트(0011) Codex 샌드박스: /usr/bin/bwrap에만 userns를 허용한다. 서버 전체 제한은 그대로다.
abi <abi/4.0>,
include <tunables/global>

profile bwrap-solveline /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap-solveline>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/bwrap-solveline
bwrap --unshare-net --ro-bind / / --dev /dev --proc /proc true && echo "bwrap 네트워크 분리 OK"
