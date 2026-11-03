#!/usr/bin/env bash
# 일일 미니 문제 자동 제작. 에이전트 CLI가 문제은행 MCP(solveline-bank-mcp)에 접속해 부족한 유형·난이도부터 새 문제를 만든다.
# pahidc에 /usr/local/bin/solveline-bank-generate로 설치되고 systemd 타이머(solveline-bank-generate.timer)가 실행한다.
# 모델은 MCP 뒤에 있으므로 BANK_AGENT_CLI만 바꾸면 다른 에이전트로 같은 일을 한다(codex | claude).
set -euo pipefail

COUNT="${BANK_GENERATE_COUNT:-3}"
AGENT="${BANK_AGENT_CLI:-codex}"
MCP=/usr/local/bin/solveline-bank-mcp
[[ "$COUNT" =~ ^[1-9][0-9]?$ ]] || { echo "BANK_GENERATE_COUNT는 1~99입니다." >&2; exit 2; }

read -r -d '' PROMPT <<EOF || true
너는 Solveline 일일 미니 문제 출제자다. solveline_bank MCP 도구만 쓰고, 셸 명령·파일·인터넷은 쓰지 않는다.
1. bank_guide를 읽고 지침을 그대로 따른다.
2. bank_overview에서 ready 수가 가장 적은 유형(topic)×난이도(level) 칸을 고른다. 여러 개를 만들 때는 서로 다른 유형으로 고른다.
3. 칸마다 list_problems로 같은 유형의 기존 제목을 보고 겹치지 않는 새 문제를 만든다.
4. create_problem으로 저장한다(status는 ready). saved가 false면 verify.failures를 보고 케이스나 기준 풀이를 고쳐 다시 시도한다(문제마다 최대 3번).
5. 새 문제 ${COUNT}개를 저장하면 끝내고, 저장한 문제의 id·유형·난이도·제목을 한 줄씩 보고한다. 저장하지 못한 문제가 있으면 이유도 적는다.
EOF

# 에이전트가 저장소나 홈 디렉터리를 읽지 않도록 빈 작업 폴더에서 실행한다
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

case "$AGENT" in
  codex)
    exec timeout 50m "$HOME/.local/bin/codex" exec --skip-git-repo-check --sandbox read-only \
      -c approval_policy='"never"' \
      -c "mcp_servers.solveline_bank.command=\"$MCP\"" \
      -c 'mcp_servers.solveline_bank.args=["--agent","codex"]' \
      -c mcp_servers.solveline_bank.startup_timeout_sec=60 \
      -c mcp_servers.solveline_bank.tool_timeout_sec=180 \
      "$PROMPT"
    ;;
  claude)
    exec timeout 50m claude -p "$PROMPT" \
      --mcp-config "{\"mcpServers\":{\"solveline_bank\":{\"command\":\"$MCP\",\"args\":[\"--agent\",\"claude\"]}}}" \
      --strict-mcp-config --allowedTools 'mcp__solveline_bank__*'
    ;;
  *)
    echo "지원하지 않는 에이전트입니다: $AGENT (codex | claude)" >&2
    exit 2
    ;;
esac
