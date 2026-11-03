# 문제은행 MCP 서버

일일 미니 문제 은행을 에이전트가 채우는 MCP(Model Context Protocol) 서버의 구조와 연결·운영 방법이다. 결정 배경은 [0009](decisions/0009-daily-problem-bank-agent.md)에 있다.

## 한눈에

```
에이전트(Codex·Claude 등 MCP 클라이언트)
  │  stdio(JSON-RPC 2.0, 한 줄에 메시지 하나)
  ▼
ssh pahidc solveline-bank-mcp --agent <이름>          ← SSH가 유일한 입구(포트를 열지 않는다)
  │  sudo docker exec -i solveline-production-judge-1
  ▼
judge 컨테이너 안의 MCP 서버 (apps/judge/src/bank-mcp-main.ts)
  │  HTTPS POST /api/internal/daily/bank
  │  본문 {agent, tool, args} + HMAC 서명(JUDGE_SECRET, 시각·메서드·경로·본문)
  ▼
Worker API (apps/api/src/app.ts의 bankTool)
  │  입력 검증(Zod) → 도구 실행
  ├─ D1: problems, daily_bank
  └─ judge: 기준 풀이 채점(verify), 히든 테스트셋 저장
```

- **MCP 서버는 얇다.** 도구 목록을 내보내고, 호출을 서명해 Worker로 넘기고, 결과를 MCP 응답으로 감싼다. 문제를 검증·저장하는 일은 모두 Worker가 한다. 관리자 화면의 "문제 직접 추가"도 같은 함수(`saveDaily`)를 쓴다.
- **도구 정의는 한 곳에 있다.** `packages/shared/src/index.ts`의 `DailyBankTools`(이름·설명·Zod 입력)를 MCP 서버는 `z.toJSONSchema`로 내보내고, Worker는 같은 Zod로 검증한다. 도구를 바꾸면 양쪽이 함께 바뀐다.
- **모델과 무관하다.** MCP를 말하는 클라이언트라면 어떤 모델이든 같은 도구로 문제를 만든다.
- **작업 지시도 서버가 준다.** 출제 기준(`DAILY_AUTHOR_GUIDE`: 학습 목표 개념, 유형별 핵심 개념, 난이도 2~4 중심, 형식)과 작업 절차(`dailyBatchTask`)는 `bank_guide` 도구와 `create_daily_batch` 프롬프트로 나간다. 실행하는 쪽의 프롬프트는 "지침을 읽고 N개 만들라" 한 줄뿐이라, 기준을 바꾸려면 서버 코드만 고치면 모든 모델에 함께 적용된다.

## 구성 요소

| 파일 | 역할 |
|---|---|
| `packages/shared/src/index.ts` | `DailyBankTools`(도구 계약), `DailyProblemInput`(문제 형식), `DAILY_AUTHOR_GUIDE`(작성 지침), `DAILY_BANK_PATH` |
| `apps/judge/src/bank-mcp.ts` | MCP 처리(`handle`: initialize·ping·tools/list·tools/call)와 Worker 호출(`workerCaller`, 서명·시간 제한 90초) |
| `apps/judge/src/bank-mcp-main.ts` | stdio 진입점. 표준 입력의 줄을 읽어 순서대로 처리하고 표준 출력에 한 줄씩 쓴다 |
| `apps/api/src/app.ts` | `POST /api/internal/daily/bank`(서명 확인) → `bankTool` → `verifyDaily`·`saveDaily` |
| `scripts/daily-bank/solveline-bank-mcp` | pahidc의 `/usr/local/bin/solveline-bank-mcp`. judge 컨테이너 안에서 MCP 서버를 실행한다 |
| `scripts/daily-bank/generate.sh` | pahidc의 `/usr/local/bin/solveline-bank-generate`. 에이전트 CLI에 MCP를 붙여 문제를 만든다 |
| `scripts/daily-bank/solveline-bank-generate.{service,timer}` | 매일 04:00 KST 자동 제작(systemd) |
| `scripts/deploy-production.sh` | 위 스크립트와 systemd 유닛을 설치하고 타이머를 켠다(main 머지 때) |

## 프롬프트

| 프롬프트 | 하는 일 |
|---|---|
| `create_daily_batch` (`count`, 기본 10) | 출제 기준과 작업 절차를 사용자 메시지로 준다. Claude Code에서는 `/mcp__solveline-bank__create_daily_batch`로 쓴다 |

Codex CLI처럼 MCP 프롬프트를 고를 수 없는 클라이언트는 `bank_guide` 도구가 같은 내용(출제 기준 + workflow)을 돌려준다.

## 도구

| 도구 | 하는 일 |
|---|---|
| `bank_guide` | 출제 기준, 작업 절차(workflow), 유형 목록. 문제를 만들기 전에 먼저 읽는다 |
| `bank_overview` | 유형(topic)×난이도(level)별 공개(ready)·작성 중(draft) 문제 수. 적은 칸부터 채운다 |
| `list_problems` | 제목·유형·난이도·상태·만든 곳·받은 사람·맞힌 사람. 겹치는 문제를 피할 때 쓴다 |
| `get_problem` | 설명·예제·시작 코드·힌트(채점 케이스는 보이지 않는다) |
| `verify_problem` | 저장하지 않고 기준 풀이로 모든 케이스를 채점해 본다 |
| `create_problem` | 검증을 통과하면 저장한다. 실패하면 `verify.failures`(케이스·기대값·실제값·오류)를 돌려준다 |
| `update_problem` | 내용을 고친다(검증을 다시 한다) |
| `set_status` | ready(발송 대상)·draft(작성 중)·retired(더 보내지 않음) |

만든 문제의 `source`는 `agent:<이름>`으로 남는다(`--agent` 값). 관리자 화면 문제 목록에서 보인다.

## 보안

- **입구는 SSH뿐이다.** MCP 서버는 포트를 열지 않고, 실행하려면 pahidc에 SSH로 들어와 `sudo docker exec`를 할 수 있어야 한다. 따로 발급하는 토큰이 없다.
- **비밀은 컨테이너 밖으로 나오지 않는다.** 서명 비밀(`JUDGE_SECRET`)은 judge 컨테이너의 환경 변수이고, MCP 서버는 그 안에서 실행된다. 에이전트는 비밀을 보지 못한다.
- **Worker는 서명을 확인한다.** `/api/internal/daily/bank`는 시각·메서드·경로·본문 HMAC이 맞고 5분 안에 만든 요청만 받는다(judge 결과 콜백과 같은 방식). 공개 인터넷에서 부를 수 있는 경로지만 비밀 없이는 쓸 수 없다.
- **에이전트는 문제은행만 만진다.** 도구는 문제은행 읽기·쓰기뿐이다. 사용자·구독자·제출 데이터는 도구로 노출하지 않는다.
- **자동 제작은 빈 폴더에서 읽기 전용으로 돈다.** Codex는 `--sandbox read-only`로 임시 폴더에서 실행해 저장소나 홈 디렉터리를 바꾸지 않는다.

## 연결하기

SSH로 pahidc에 접속할 수 있는 곳이면 어디서든 MCP 클라이언트에 아래 명령을 stdio 서버로 등록한다.

```bash
ssh pahidc solveline-bank-mcp --agent <이름>
```

**Claude Code**

```bash
claude mcp add solveline-bank -- ssh pahidc solveline-bank-mcp --agent claude
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.solveline_bank]
command = "ssh"
args = ["pahidc", "solveline-bank-mcp", "--agent", "codex"]
startup_timeout_sec = 60
tool_timeout_sec = 180          # 기준 풀이 채점을 기다린다
default_tools_approval_mode = "approve"   # 비대화 실행(codex exec)에서 도구마다 승인을 묻지 않게
```

**직접 시험** (MCP 클라이언트 없이)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bank_overview","arguments":{}}}' \
  | ssh pahidc solveline-bank-mcp --agent test
```

## 자동 제작

`solveline-bank-generate.timer`(systemd, cron과 같은 매일 실행이며 꺼져 있던 동안 놓친 실행은 켜질 때 한 번 돈다)가 매일 04:00 KST(무작위 지연 최대 10분)에 `solveline-bank-generate`를 실행해 문제 10개를 만든다. 스크립트는 에이전트 CLI에 MCP를 붙이고 "`bank_guide`를 읽고 그 절차대로 N개 만들라"는 한 줄만 준다.

| 환경 변수(`/etc/solveline/bank-generate.env`) | 기본값 | 뜻 |
|---|---|---|
| `BANK_AGENT_CLI` | `codex` | 쓸 에이전트(`codex`, `claude`) |
| `BANK_GENERATE_COUNT` | `10` | 한 번에 만들 문제 수(1~99) |
| `BANK_REASONING_EFFORT` | `medium` | Codex 추론 강도 |

에이전트 CLI는 pahidc의 `ubuntu` 사용자로 미리 로그인해 둔다(Codex: `~/.codex/auth.json`). 로그인이 풀리면 자동 제작만 멈추고 메일 발송은 계속된다.

```bash
ssh pahidc 'BANK_GENERATE_COUNT=5 /usr/local/bin/solveline-bank-generate'           # 지금 한 번 실행
ssh pahidc 'sudo systemctl start solveline-bank-generate.service'                   # 타이머와 같은 방식으로 실행
ssh pahidc 'sudo journalctl -u solveline-bank-generate.service -n 100 --no-pager'   # 기록 보기
ssh pahidc 'systemctl list-timers solveline-bank-generate.timer'                     # 다음 실행 시각
```

### 다른 모델 붙이기

1. pahidc에 그 모델의 CLI를 설치하고 로그인한다.
2. `scripts/daily-bank/generate.sh`의 `case`에 한 갈래를 더한다. 하는 일은 셋뿐이다: `solveline_bank`라는 이름으로 `/usr/local/bin/solveline-bank-mcp --agent <이름>`을 stdio MCP 서버로 등록하고, 도구 호출을 자동 승인하고, `$PROMPT`를 비대화로 실행한다(표준 입력은 닫는다).
3. `/etc/solveline/bank-generate.env`에 `BANK_AGENT_CLI=<이름>`을 둔다.

도구·지침·검증은 서버 쪽에 있으므로 모델마다 따로 맞출 것이 없다.

## 문제 형식과 검증

`create_problem` 입력은 `DailyProblemInput`이다. 관리자 화면의 "문제 직접 추가"에 넣는 JSON과 같다(화면의 "예시 채우기"가 예시다).

- 예제(`hidden: false`) 1~5개, 채점 케이스(`hidden: true`) 3개 이상(지침은 6개 이상)
- `referenceSolution`(java 또는 python)으로 예제와 채점 케이스를 모두 실제 judge에서 채점해 100점일 때만 저장한다. 채점 기록은 남기지 않는다.
- 저장하면 채점 케이스는 judge 테스트셋(R2)으로, 문제는 `problems`에, 유형·난이도·힌트·상태는 `daily_bank`에 한 번에 쓴다. 미니 문제는 일반 목록과 카탈로그에 나오지 않고 링크로만 열린다.

## 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `MCP tool call requires approval, but approval policy is never` | Codex는 `approval_policy="never"`여도 MCP 도구마다 승인을 묻는다. `mcp_servers.<이름>.default_tools_approval_mode="approve"`를 준다 |
| Codex가 `Reading additional input from stdin...`에서 멈춤 | 표준 입력이 열려 있으면 기다린다. `</dev/null`로 닫는다 |
| `Codex could not find bubblewrap on PATH` 경고 | Codex가 내장 bubblewrap을 쓰므로 동작에는 문제없다. 없애려면 `sudo apt install bubblewrap` |
| 도구 호출이 `bad_signature`로 실패 | judge 컨테이너의 `JUDGE_SECRET`과 Worker(Pages 비밀)의 값이 다르거나, 서버 시각이 5분 넘게 어긋났다 |
| `채점 서버에 닿지 않았어요` / `채점이 끝나지 않았어요` | judge·runner 상태를 확인한다(`curl https://solveline-api.simplyimg.com/judge/health`). 대기열이 길면 잠시 뒤 다시 시도한다 |
| 큰 케이스를 넣으면 도구 호출이 실패 | 도구 호출 크기 제한이다. 케이스 입력은 작게 두고 최대 크기는 설명의 제한에만 적는다(지침에 있다) |
| `sudo: a password is required` | SSH 사용자에게 비밀번호 없는 sudo(docker exec)가 필요하다 |
