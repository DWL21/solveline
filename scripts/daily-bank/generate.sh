#!/usr/bin/env bash
# 일일 미니 문제 자동 제작(매일 10개). 에이전트 CLI가 문제은행 MCP(solveline-bank-mcp)에 접속해 서버가 주는 출제 기준대로 새 문제를 만든다.
# pahidc에 /usr/local/bin/solveline-bank-generate로 설치되고 systemd 타이머(solveline-bank-generate.timer)가 실행한다.
# 모델은 MCP 뒤에 있으므로 BANK_AGENT_CLI만 바꾸면 다른 에이전트로 같은 일을 한다(codex | claude).
set -euo pipefail

COUNT="${BANK_GENERATE_COUNT:-10}"
AGENT="${BANK_AGENT_CLI:-codex}"
# 문제 품질을 위해 기본은 medium(Codex 기본값은 none일 수 있다)
EFFORT="${BANK_REASONING_EFFORT:-medium}"
MCP=/usr/local/bin/solveline-bank-mcp
[[ "$COUNT" =~ ^[1-9][0-9]?$ ]] || { echo "BANK_GENERATE_COUNT는 1~99입니다." >&2; exit 2; }
[[ "$EFFORT" =~ ^(none|minimal|low|medium|high|xhigh)$ ]] || { echo "BANK_REASONING_EFFORT 값이 올바르지 않습니다." >&2; exit 2; }

# 출제 기준과 작업 절차는 MCP 서버(bank_guide 도구, create_daily_batch 프롬프트)가 준다. 여기서는 개수만 정한다
PROMPT="solveline_bank MCP의 bank_guide 도구를 먼저 호출해 출제 기준과 작업 절차(workflow)를 읽고, 그 절차대로 새 문제 ${COUNT}개를 만들어 저장하라. solveline_bank 도구만 쓰고 셸 명령·파일·인터넷은 쓰지 않는다."

# 에이전트가 저장소나 홈 디렉터리를 읽지 않도록 빈 작업 폴더에서 실행한다
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

case "$AGENT" in
  codex)
    exec timeout 50m "$HOME/.local/bin/codex" exec --skip-git-repo-check --sandbox read-only \
      -c approval_policy='"never"' \
      -c "model_reasoning_effort=\"$EFFORT\"" \
      -c "mcp_servers.solveline_bank.command=\"$MCP\"" \
      -c 'mcp_servers.solveline_bank.args=["--agent","codex"]' \
      -c mcp_servers.solveline_bank.startup_timeout_sec=60 \
      -c mcp_servers.solveline_bank.tool_timeout_sec=180 \
      -c mcp_servers.solveline_bank.default_tools_approval_mode='"approve"' \
      "$PROMPT" </dev/null
    ;;
  claude)
    exec timeout 50m claude -p "$PROMPT" </dev/null \
      --mcp-config "{\"mcpServers\":{\"solveline_bank\":{\"command\":\"$MCP\",\"args\":[\"--agent\",\"claude\"]}}}" \
      --strict-mcp-config --allowedTools 'mcp__solveline_bank__*'
    ;;
  *)
    echo "지원하지 않는 에이전트입니다: $AGENT (codex | claude)" >&2
    exit 2
    ;;
esac
