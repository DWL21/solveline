#!/usr/bin/env bash
# pahidc에 LLM QA 명령을 설치한다(0010). 저장소 main을 받은 폴더에서 ubuntu 사용자로 실행:
#   scripts/llm-qa/install.sh [Actions가 쓸 SSH 공개 키 파일]
# - /opt/solveline-llm-qa: 지침·결과 형식·예제 데이터 스크립트, Playwright MCP(버전 고정), Chromium
# - /usr/local/bin/solveline-llm-qa: QA 명령
# - 공개 키를 주면 ~/.ssh/authorized_keys에 QA 명령만 실행하는 줄을 더한다(셸·포워딩 불가)
set -euo pipefail
cd "$(dirname "$0")"
TOOLS=/opt/solveline-llm-qa
MCP_VERSION=0.0.83
export PATH="$HOME/.local/node/bin:$PATH"

sudo install -d -o "$USER" -g "$USER" "$TOOLS"
install -m 644 guide.md result.schema.json seed.mjs agent-guide.md agent.schema.json "$TOOLS/"
if [ "$(node -p "require('$TOOLS/node_modules/@playwright/mcp/package.json').version" 2>/dev/null)" != "$MCP_VERSION" ]; then
  (cd "$TOOLS" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "@playwright/mcp@$MCP_VERSION")
fi
# MCP가 쓰는 Playwright와 같은 버전의 Chromium(OS 패키지 포함)
PLAYWRIGHT_BROWSERS_PATH="$TOOLS/browsers" sudo -E env "PATH=$PATH" node "$TOOLS/node_modules/playwright-core/cli.js" install-deps chromium >/dev/null
PLAYWRIGHT_BROWSERS_PATH="$TOOLS/browsers" node "$TOOLS/node_modules/playwright-core/cli.js" install chromium
sudo install -m 755 solveline-llm-qa /usr/local/bin/solveline-llm-qa

if [ -n "${1:-}" ]; then
  key=$(cat "$1")
  [[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "ssh-ed25519 공개 키가 아닙니다." >&2; exit 2; }
  line="command=\"/usr/local/bin/solveline-llm-qa\",restrict $key"
  grep -qF "$(echo "$key" | cut -d' ' -f2)" ~/.ssh/authorized_keys || echo "$line" >>~/.ssh/authorized_keys
fi
echo "설치 끝: $(node -p "require('$TOOLS/node_modules/@playwright/mcp/package.json').version") / $(command -v solveline-llm-qa)"
