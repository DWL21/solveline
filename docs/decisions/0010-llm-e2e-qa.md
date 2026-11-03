# 0010. PR마다 LLM이 하는 e2e QA (pahidc Codex)

상태: 제안. 단계별로 구현하며, 처음에는 머지를 막지 않는 참고 체크로 시작한다.

## 배경

- 지금 PR 검증은 사람이 미리 써 둔 테스트(Vitest·Playwright API/UI)와 정적 분석이다. **이미 테스트가 있는 동작**은 잘 지키지만, PR이 새로 넣은 기능은 그 PR이 테스트를 함께 쓰지 않으면 아무도 브라우저에서 눌러 보지 않는다.
  - 예) #171에서 운영 CSP가 테마 시작 스크립트를 막는 문제는 모든 체크를 통과한 뒤, 사람이 Docker 환경에서 캡처하다 찾았다.
- 전략 문서(`docs/quality/strategy.md` 4절)의 "새 기능은 자동화 전에 30분 탐색" 단계를 LLM이 PR마다 대신하게 한다.
- 비용 조건은 무료 범위다.
  - GitHub Actions: 공개 저장소의 표준 러너는 무료다.
  - LLM: OpenAI API 키는 쓰지 않는다(종량 과금). pahidc에 이미 로그인된 Codex CLI(ChatGPT 요금제 사용량, `~/.codex/auth.json`, 0009)를 쓴다.

## 목표

1. PR이 바꾼 기능을 LLM이 **PR 본문·연결된 이슈의 `## 완료 기준`·변경 파일**에서 읽어 시나리오로 만들고, 운영과 같은 이미지로 띄운 테스트 환경에서 브라우저로 직접 확인한다.
2. 결과를 PR에 남긴다.
   - 시나리오마다 통과·실패·확인 못 함을 ✓/✗/– 와 문구로 적는다. 색만으로 구분하지 않는다.
   - 스크린샷 근거를 붙인다.
   - 커밋 상태 `llm-qa`를 단다.
3. 자동화가 없는 완료 기준은 **Playwright 테스트 초안**으로 제안한다. 커밋은 하지 않고, 사람이 골라 넣는다.
4. 비용 0. 운영 judge·runner를 느리게 하지 않는다. 비밀 값은 새지 않는다.

## 고려한 길

| 길 | 판단 |
|---|---|
| Actions에서 `openai/codex-action` + `OPENAI_API_KEY` | API 종량 과금이라 무료 조건에 맞지 않는다. **안 씀** |
| Actions 비밀에 ChatGPT `auth.json`을 넣고 Codex 실행 | 문제가 세 가지라 **안 씀**. ① 공개 저장소 워크플로에 개인 세션을 노출한다. ② 포크 PR에는 비밀이 없다. ③ 토큰 갱신 결과가 일회용 러너와 함께 사라져 로그인이 풀린다 |
| pahidc를 self-hosted runner로 PR 이벤트에 붙임 | AGENTS.md 규칙(self-hosted는 `deploy.yml`의 main 푸시만) 위반. 외부 PR 코드가 운영 서버에서 돈다. **금지** |
| **pahidc가 GitHub를 당겨 오는 작업자(poller) + Docker 격리** | 들어오는 포트·러너 등록 없이 나가는 HTTPS만 쓴다. Codex 로그인은 이미 있다. **채택** |
| Actions에서 GitHub Models(무료 한도) + 정해진 단계만 실행하는 실행기 | 비밀 없이 돌아서 포크 PR에도 쓸 수 있다. 다만 무료 한도(요청 수·토큰)가 작아 탐색형 QA는 어렵다. **3단계 보조안**(pahidc가 바쁘거나 꺼졌을 때 계획·판정만) |

## 흐름

```
PR push ─▶ CI(ci.yml, Actions 무료) ─ 완료 ─▶ llm-qa-request.yml(Actions, 비밀 없음)
                                              │ 대상 판정 + 요청서(JSON) 아티팩트 + 상태 llm-qa=pending
                                              ▼
pahidc  solveline-llm-qa.timer(2분) ─▶ 작업자: 대기 요청 확인(GitHub API, 나가는 HTTPS)
   │  flock으로 한 번에 하나, nice/CPU·메모리 제한, 전체 30분 제한
   ├─ ① PR head SHA를 빈 폴더에 받기(git fetch, 실행 권한 없음)
   ├─ ② 테스트 환경: compose.test.yaml을 프로젝트 이름 solveline-qa-<PR>로 띄움(tmpfs, 새 임의 비밀)
   ├─ ③ 기본 체크: 기존 e2e 중 변경 파일에 걸린 @R 태그만 돌림(빠른 회귀)
   ├─ ④ LLM QA: qa-agent 컨테이너(Codex) + 브라우저 컨테이너(Playwright MCP) + qa MCP
   ├─ ⑤ 결과: PR 댓글 1개 갱신, 커밋 상태 llm-qa, 스크린샷은 qa-reports 브랜치
   └─ ⑥ 정리: compose down --volumes, 작업 폴더 삭제
```

### 대상 판정 (llm-qa-request.yml)

- `workflow_run`(CI 완료)으로 돈다. 기본 브랜치의 코드만 실행하고 PR 코드는 실행하지 않는다(`qa-report.yml`과 같은 방식).
- 아래를 모두 만족해야 요청서를 만든다.
  - 작성자가 `OWNER`·`MEMBER`·`COLLABORATOR`이거나, 관리자가 `qa:llm` 레이블을 붙였다. 외부 PR은 사람이 내용을 읽고 레이블로 허락한다.
  - 변경이 화면·API 동작에 닿는다(`apps/web`·`apps/api`·`apps/judge`·`packages/shared`·`runner`). 문서·워크플로만 바꾼 PR은 건너뛰고 상태를 `success`("대상 아님")로 단다.
  - CI의 `check`가 통과했다. 빌드가 깨진 PR에 LLM 사용량을 쓰지 않는다.
- 요청서(`llm-qa-request.json`)에 담는 것:
  - PR 번호, head SHA
  - 제목·본문, 연결된 이슈의 `## 완료 기준`
  - 변경 파일 목록과 diff 통계, 변경 파일에 해당하는 요구사항 태그(@R…)
  - 이전 실행 결과(재실행이면)

  모두 **신뢰하지 않는 입력**으로 다룬다.

### pahidc 작업자

- `scripts/llm-qa/worker.sh`가 systemd 타이머로 2분마다 돈다. `solveline-bank-generate`와 같은 설치 방식이다.
- 할 일을 찾는 법: `llm-qa=pending` 상태인 열린 PR의 최신 요청서 아티팩트를 받는다. 같은 SHA에 이미 결과가 있으면 건너뛰고, 새 커밋이 오면 이전 작업을 버린다.
- GitHub 토큰: 이 저장소 하나만 쓰는 fine-grained 토큰을 `/etc/solveline/llm-qa.env`(root, 600)에 둔다.
  - 권한은 Pull requests 쓰기, Commit statuses 쓰기, Actions 읽기, Contents 쓰기다. Contents 쓰기는 `qa-reports` 브랜치 업로드에만 쓴다. main은 브랜치 보호로 막혀 있어야 한다.
  - 토큰은 작업자 프로세스만 갖고 컨테이너에는 넘기지 않는다.
- 자원: 운영 judge·runner가 우선이다.
  - QA 컨테이너 전체를 `--cpus 1.5`·메모리 3GB로 제한하고 `nice 10`으로 돌린다.
  - judge 대기열이 길면(`/health`의 queued > 5) 시작을 미룬다.
  - 하루 최대 횟수(`LLM_QA_DAILY_MAX`, 기본 20)를 넘기면 `success`("확인 못 함: 오늘 한도 초과")로 끝낸다(판정과 결과 참고). 0009의 문제 자동 제작(04:00)과 Codex 사용량을 나눠 쓴다.

### LLM QA 실행 (격리)

세 컨테이너로 나눠 **LLM이 인터넷과 비밀에 동시에 닿지 않게** 한다.

| 컨테이너 | 네트워크 | 가진 것 |
|---|---|---|
| `qa-agent`(Codex CLI) | 인터넷(OpenAI) | 요청서(읽기 전용), Codex 로그인 사본(tmpfs). 셸은 `--sandbox read-only`라 네트워크·쓰기가 막힌다 |
| `qa-browser`(Playwright MCP, chromium) | 테스트 환경 내부 망만(`internal: true`, 인터넷 없음) | 테스트 환경 웹 주소만 허용(`--allowed-origins`) |
| `qa-mcp`(우리 MCP, Node) | 테스트 환경 내부 망만 | `TEST_AUTH_TOKEN`. 도구로 역할별 테스트 로그인(`login_as`), 예제 데이터 넣기(`seed_problem`), 결과 기록(`report_scenario`, 스크린샷 저장)만 준다. 토큰 값은 모델에 보이지 않는다 |

- Codex 실행 형태는 `generate.sh`와 같다: `codex exec --sandbox read-only -c approval_policy="never"`. MCP 서버로 `qa_browser`와 `qa`를 HTTP(SSE)로 붙인다. 둘 다 다른 컨테이너라 stdio로 띄우지 않는다.
- 프롬프트 줄거리:
  1. `qa.guide`를 읽는다. 저장소의 `docs/quality/llm-qa-guide.md`를 서버가 준다. 0009처럼 지침을 고치면 모델과 상관없이 함께 적용된다.
  2. 요청서의 완료 기준과 변경 파일로 시나리오 3~8개를 만든다. 정상 경로 하나, 경계·오류 하나, 권한 하나, 휴대폰 폭 하나를 포함한다.
  3. 시나리오마다 브라우저로 실행하고 `report_scenario`로 기록한다. 기록 형식은 `{ id, title, criterion, steps, expected, actual, verdict: pass|fail|blocked, screenshots }`이다.
  4. 자동화가 없는 완료 기준은 Playwright 테스트 초안을 `report_suggestion`으로 남긴다.
- 프롬프트 인젝션 대비:
  - PR 본문·코드·화면 글자는 데이터로만 다루라고 지침에 적는다.
  - 더 중요한 장치는 구조다. 모델이 할 수 있는 일이 테스트 환경 안의 클릭과 기록뿐이고, 가진 비밀(Codex 로그인)을 내보낼 길(셸 네트워크·브라우저 인터넷)이 막혀 있다.
  - 결과 댓글은 작업자가 정해진 틀로 만든다. 모델이 쓴 글은 인용 블록 안에 길이를 제한해 넣고 멘션(@)을 지운다.

### 판정과 결과

- `llm-qa`는 커밋 상태(Commit Status API)로 단다. 커밋 상태의 값은 `pending`·`success`·`failure`·`error` 넷뿐이다. `neutral`은 GitHub App이 쓰는 Checks API에만 있으므로, "확인 못 함"은 `success`에 설명 문구로 구분한다. 시나리오를 돌린 경우 설명란(140자)은 항상 `통과 n · 실패 n · 확인 못 함 n`으로 시작하고, 돌리지 못한 경우는 `대상 아님`·`확인 못 함:`으로 시작해, 초록 체크만 보고 통과로 오해하지 않게 한다.

  | 상태 | 경우 | 설명 예 |
  |---|---|---|
  | `pending` | 요청서를 만들었거나 작업자가 실행 중 | `대기 중` · `실행 중(3/6)` |
  | `success` | 모든 시나리오 통과 | `통과 6 · 실패 0 · 확인 못 함 0` |
  | `success` | 실패는 없고 확인 못 한 시나리오가 있음 | `통과 4 · 실패 0 · 확인 못 함 2 — 댓글 확인` |
  | `success` | 대상 아님, 오늘 한도 초과 | `대상 아님(문서만 변경)` · `확인 못 함: 오늘 한도 초과` |
  | `failure` | 실패가 하나라도 있음 | `통과 3 · 실패 1 · 확인 못 함 0` |
  | `error` | 작업자·테스트 환경 오류. `/llm-qa`로 다시 돌린다 | `오류: 테스트 환경이 뜨지 않음` |

  - 확인 못 함이 섞인 `success`는 PR 댓글 맨 위에 "– 확인 못 한 시나리오 n개"를 따로 적어 사람이 보게 한다.
  - 상태 링크(`target_url`)는 PR 댓글로 건다.
- 필수 체크로 넣지 않는다. main 머지가 곧 배포라서 LLM 판정 오류가 배포를 막으면 안 된다.
  - 2주 동안 거짓 실패율을 본다(`docs/quality/metrics.md`에 기록).
  - 거짓 실패가 10% 아래로 유지되면 "실패하면 머지 전 사람 확인"을 PR 체크리스트에 넣는다.
- PR 댓글(표식으로 하나만 갱신)에 담는 것:
  - 요약 줄: 통과 n · 실패 n · 확인 못 함 n, 소요 시간, 모델·추론 강도
  - 시나리오 표: 완료 기준 ↔ 결과 ✓/✗/–, 근거 스크린샷 링크
  - 실패 상세: 재현 단계, 기대값과 실제값
  - 테스트 초안: 접어 두기
- 스크린샷·초안·실행 로그(비밀 가린 것)는 `qa-reports` 브랜치 `llm-qa/pr-<n>/<sha>/`에 둔다. 기존 QA 보고서와 같은 보관 방식이다.
- 다음 PR의 QA 보고서(`qa-report.yml`)가 `llm-qa` 결과를 한 절로 묶어 보여 준다.

### 다시 돌리기

- PR 댓글 `/llm-qa`(작성자·관리자만) 또는 `qa:llm` 레이블을 다시 붙이면 같은 SHA로 재실행한다.

## 단계

1. **작업자와 기본 체크**
   - `llm-qa-request.yml`, `scripts/llm-qa/worker.sh`, 테스트 환경 띄우기, 변경 파일 → @R 태그 → 해당 e2e만 실행, PR 댓글·상태.
   - LLM은 아직 없다. 경로·권한·자원 제한을 먼저 검증한다.
2. **LLM QA**
   - `qa-agent`·`qa-browser`·`qa-mcp` 컨테이너, 지침(`llm-qa-guide.md`), 시나리오·스크린샷·초안.
   - #171의 CSP 문제(사람이 찾은 결함)를 재현 사례로 써서, 고치기 전 커밋(`9abf426`)에서 LLM이 찾는지 확인한다.
3. **보조안·고도화**
   - pahidc가 응답하지 않으면 Actions에서 GitHub Models로 "완료 기준 → 시나리오 계획"만 만들어 댓글로 남긴다.
   - 거짓 실패율 지표, 필수 체크 승격 검토.

## 결과

- 새 비밀: `/etc/solveline/llm-qa.env`(fine-grained GitHub 토큰). GitHub Environment에 넣지 않고 pahidc에만 둔다. 이 저장소의 워크플로는 이 토큰을 모른다.
- 새 상태 체크 `llm-qa`(필수 아님), 새 레이블 `qa:llm`.
- pahidc에 QA 전용 compose 프로젝트(`solveline-qa-*`)가 잠깐 뜬다. 운영 compose(`solveline-production`)와 네트워크·볼륨을 나눈다. 테스트 환경 데이터는 tmpfs라 남지 않는다.
- 사용자 코드 실행은 여전히 테스트 환경의 runner 컨테이너에서만 한다(샌드박스 규칙 그대로).
