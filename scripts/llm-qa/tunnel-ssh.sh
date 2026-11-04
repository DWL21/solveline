#!/usr/bin/env bash
# pahidc: Actions가 Cloudflare Tunnel로 LLM QA 명령에 닿게 한다(0010). ubuntu 사용자로 한 번 실행한다(sudo 사용).
#   scripts/llm-qa/tunnel-ssh.sh <Actions QA 공개 키 파일> [호스트 이름]
# - QA 전용 sshd: 127.0.0.1:2222, QA 키 하나만 받고 QA 명령만 실행(비밀번호·root·포워딩·터미널 불가)
# - 기존 터널(/etc/cloudflared/config.yml)에 <호스트 이름> → ssh://127.0.0.1:2222 를 더하고 DNS를 잇는다
# 호스팅 방화벽의 22번 허용 목록은 그대로 둔다. 터널로 들어온 접속은 이 전용 sshd에만 닿는다.
set -euo pipefail
KEY_FILE=${1:?사용법: tunnel-ssh.sh <공개 키 파일> [호스트 이름]}
HOST=${2:-llm-qa-ssh.simplyimg.com}
CONFIG=/etc/cloudflared/config.yml

key=$(cat "$KEY_FILE")
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "ssh-ed25519 공개 키가 아닙니다." >&2; exit 2; }
command -v solveline-llm-qa >/dev/null || { echo "먼저 scripts/llm-qa/install.sh로 QA 명령을 설치하세요." >&2; exit 2; }

echo "restrict $key" | sudo tee /etc/ssh/llm_qa_authorized_keys >/dev/null
sudo chmod 644 /etc/ssh/llm_qa_authorized_keys
sudo tee /etc/ssh/sshd_llm_qa_config >/dev/null <<'EOF'
# LLM QA 전용 sshd(0010). Cloudflare Tunnel로만 들어오고, QA 키 하나로 QA 명령만 실행한다.
Port 2222
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/sshd-llm-qa.pid
AllowUsers ubuntu
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile /etc/ssh/llm_qa_authorized_keys
ForceCommand /usr/local/bin/solveline-llm-qa
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
PermitTunnel no
MaxAuthTries 2
MaxSessions 2
LoginGraceTime 20
UsePAM yes
EOF
sudo tee /etc/systemd/system/sshd-llm-qa.service >/dev/null <<'EOF'
[Unit]
Description=Solveline LLM QA 전용 sshd(127.0.0.1:2222, Cloudflare Tunnel 전용)
After=network.target

[Service]
ExecStartPre=/usr/bin/mkdir -p /run/sshd
ExecStartPre=/usr/sbin/sshd -t -f /etc/ssh/sshd_llm_qa_config
ExecStart=/usr/sbin/sshd -D -f /etc/ssh/sshd_llm_qa_config
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now sshd-llm-qa.service
sudo systemctl restart sshd-llm-qa.service

# 터널: 마지막 404 규칙 앞에 한 번만 더한다
if ! sudo grep -q "hostname: $HOST" "$CONFIG"; then
  sudo cp "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d%H%M%S)"
  sudo sed -i "s|^  - service: http_status:404|  - hostname: $HOST\n    service: ssh://127.0.0.1:2222\n  - service: http_status:404|" "$CONFIG"
fi
sudo cloudflared tunnel --config "$CONFIG" ingress validate
tunnel=$(sudo awk '/^tunnel:/ {print $2}' "$CONFIG")
cloudflared tunnel route dns "$tunnel" "$HOST" || echo "DNS가 이미 있으면 위 오류는 무시해도 된다."
sudo systemctl restart cloudflared

systemctl is-active sshd-llm-qa.service cloudflared
echo "Actions 변수 LLM_QA_SSH_KNOWN_HOSTS에 넣을 줄:"
echo "$HOST $(awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub)"
