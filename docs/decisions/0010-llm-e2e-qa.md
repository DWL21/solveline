# 0010. PR마다 LLM이 하는 e2e QA (pahidc Codex)

상태: 1차 구현(2026-11-03, `llm-qa.yml`·`scripts/llm-qa/`). 머지를 막지 않는 참고 체크다. 처음 설계(서버가 GitHub를 당겨 오는 작업자)는 시험 뒤 "Actions가 SSH 강제 명령으로 부른다"로 바꿨다(아래 고려한 길).

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
| pahidc가 GitHub를 당겨 오는 작업자(poller) | 들어오는 접속은 없지만, 댓글·이슈를 쓰려면 pahidc에 GitHub 토큰(쓰기 권한)을 둬야 한다. 처음 설계였으나 **바꿈** |
| **Actions가 SSH 강제 명령으로 pahidc QA 명령을 부름** | GitHub 쓰기는 Actions의 기본 토큰(`GITHUB_TOKEN`)이 하고, pahidc에는 GitHub 토큰이 없다. Actions 비밀의 SSH 키는 `authorized_keys`의 `command=…,restrict`로 QA 명령 하나만 실행한다(셸·포워딩 불가). 기다리는 동안의 Actions 시간은 공개 저장소라 무료. **채택** |
| Actions에서 GitHub Models(무료 한도) + 정해진 단계만 실행하는 실행기 | 비밀 없이 돌아서 포크 PR에도 쓸 수 있다. 다만 무료 한도(요청 수·토큰)가 작아 탐색형 QA는 어렵다. **3단계 보조안**(pahidc가 바쁘거나 꺼졌을 때 계획·판정만) |

## 흐름

```
PR push ─▶ CI(ci.yml) ─ 성공 ─▶ llm-qa.yml(Actions, 기본 브랜치 코드만 실행)
              │ ① 대상 판정(작성자·qa:llm 레이블·변경 경로)
              │ ② 요청서 JSON(PR 제목·변경 사항·연결 이슈 완료 기준·변경 파일)
              │ ③ 상태 llm-qa=pending
              ▼
   ssh ubuntu@pahidc "run <PR> <SHA>" < request.json   (키는 강제 명령 전용)
              ▼
pahidc  /usr/local/bin/solveline-llm-qa
   │  flock으로 한 번에 하나, 남은 메모리(실메모리+스왑) 3GB 미만이면 미룸, nice 10
   ├─ PR head를 빈 폴더에 받고 SHA 확인. 호스트에서 도는 compose.test.yaml·test-env.sh는 main 것으로 바꿔 씀
   ├─ 테스트 환경(compose 프로젝트 solveline-qa, 127.0.0.1:8091, tmpfs, 새 임의 비밀)
   ├─ 예제 데이터·로그인 쿠키(seed.mjs, 토큰은 모델에 안 감)
   ├─ Codex(gpt-6.1-terra) + Playwright MCP(테스트 환경 주소만 허용), 20분 제한
   └─ 결과 tar.gz(result.json·스크린샷·codex.log)를 표준 출력으로, 테스트 환경 내림
              ▼
llm-qa.yml  스크린샷 → qa-reports 브랜치 llm-qa/pr-<n>/<sha7>/
            PR 댓글(표식으로 하나만 갱신) · 상태 llm-qa · 실패 시나리오 이슈
```

### 대상 판정 (llm-qa.yml)

- `workflow_run`(CI 완료, 성공)으로 돈다. 기본 브랜치의 코드만 실행하고 PR 코드는 Actions에서 실행하지 않는다(`qa-report.yml`과 같은 방식). PR 글은 파일로만 넘긴다.
- 아래를 모두 만족해야 QA를 부른다.
  - 작성자가 `OWNER`·`MEMBER`·`COLLABORATOR`이거나, 관리자가 `qa:llm` 레이블을 붙였다. 외부 PR은 사람이 내용을 읽고 레이블로 허락한다. 레이블을 붙인 뒤에는 Actions 탭에서 `LLM QA`를 PR 번호로 직접 실행한다(`workflow_dispatch`).
  - 변경이 화면·API 동작에 닿는다(`apps/web`·`apps/api`·`apps/judge`·`packages/shared`·`runner`·`docker`). 아니면 상태를 `success`("대상 아님")로 단다.
  - CI 전체가 성공했다. 빌드가 깨진 PR에 LLM 사용량을 쓰지 않는다.
  - 그 사이 새 커밋이 올라왔으면 건너뛴다(새 커밋의 CI가 다시 부른다).
- 요청서(`scripts/llm-qa-report.mjs request`): PR 번호·head SHA·제목, PR 본문의 `## 변경 사항`(그림 제외, 4000자), 연결 이슈(`Closes`)의 `## 완료 기준` 항목, 변경 파일(80개까지). 모두 **신뢰하지 않는 입력**이다.

### pahidc QA 명령

- 설치: 저장소 main을 받아 `scripts/llm-qa/install.sh <Actions 공개 키>`. `/opt/solveline-llm-qa`(지침·결과 형식·seed, Playwright MCP 0.0.83, Chromium)와 `/usr/local/bin/solveline-llm-qa`를 둔다. 지침(`guide.md`)을 고치면 다시 설치해야 반영된다.
- 접속 설정(사람이 한다):
  - pahidc `~/.ssh/authorized_keys`: `command="/usr/local/bin/solveline-llm-qa",restrict ssh-ed25519 …` (install.sh가 공개 키를 받으면 더한다)
  - 저장소 비밀 `LLM_QA_SSH_KEY`(그 키의 비공개 키)·`LLM_QA_SSH_HOST`, 저장소 변수 `LLM_QA_SSH_KNOWN_HOSTS`(`ssh-keyscan` 결과). 없으면 상태가 `error`("접속 설정 없음")가 된다.
- PR 코드는 테스트 환경 이미지 빌드와 컨테이너 안에서만 돈다. 호스트에서 도는 정의(`compose.test.yaml`, `scripts/test-env.sh`)는 main 것을 쓰므로, PR이 이 두 파일을 바꾸면 바뀐 내용은 QA에 반영되지 않는다.
- 자원: 운영 judge·runner가 우선이다.
  - 2026-11-03 시험에서 잰 양: 테스트 환경 컨테이너 넷 약 350MB, 브라우저·Codex·MCP 약 1.6GB, 이미지 약 1.3GB.
  - 같은 날 pahidc를 정리했다: never-ai 서비스와 배포 러너를 멈춤(데이터·이미지는 남김), 빌드 캐시·예전 이미지·러너 예전 버전·캐시·로그를 지움(디스크 94% → 73%), 스왑 4GB → 8GB(`/swapfile2`, `vm.swappiness=10`).
  - 남은 메모리(MemAvailable + SwapFree)가 3GB 미만이면 시작하지 않고 `error`로 끝낸다. 한 번에 하나만 돌고(30분까지 기다림), `nice 10`으로 돈다.
  - 0009의 문제 자동 제작(04:00)과 Codex 사용량을 나눠 쓴다. 하루 한도는 아직 두지 않았다(다음 단계).

### LLM QA 실행 (격리)

**1차 구현**은 Codex와 Playwright MCP를 pahidc 호스트의 `ubuntu` 프로세스로 띄우고 아래로 막는다.

- Codex: `codex exec --ignore-user-config --skip-git-repo-check --sandbox read-only --ephemeral`, 빈 작업 폴더, `approval_policy="never"`, 20분 제한.
  - 셸은 읽기 전용 샌드박스라 네트워크·쓰기가 막힌다.
  - `--ignore-user-config`로 사용자 `config.toml`의 모델·MCP 서버·hook을 읽지 않고 로그인(`auth.json`)만 쓴다. 시험에서 이 옵션 없이 돌리자 개발 PC의 다른 MCP 서버(데스크톱 제어 포함)까지 불러왔다.
  - 모델: 기본 `gpt-6.1-terra`, 추론 강도 `medium`. `LLM_QA_MODEL`·`LLM_QA_EFFORT`로 바꾼다. ChatGPT 로그인으로 이 모델을 쓰려면 Codex CLI 0.164.0 이상이 필요하다(0.155.1은 "지원하지 않는 모델"로 거절된다).
  - 결과는 `--output-schema scripts/llm-qa/result.schema.json`으로 받는다: `{ summary, scenarios: [{ id, title, criterion, steps, expected, actual, verdict: pass|fail|blocked, evidence }], suggestions: [{ criterion, code }] }`.
- 브라우저: Playwright MCP 0.0.83, Chromium headless, `--isolated --allowed-origins http://localhost:8091`(테스트 환경 밖 요청 차단), 1280×800, 스크린샷은 결과 폴더로.
- 로그인: `seed.mjs`가 테스트 토큰으로 편집 권한 계정을 만들어 쿠키를 storage state 파일로 넘긴다. 토큰은 모델에 가지 않는다. 실행마다 새로 만든다(모델이 로그아웃하면 세션이 끊긴다. 시험에서 실제로 일어남).

**다음 단계**에서 세 컨테이너로 나눠 LLM이 인터넷과 비밀에 동시에 닿지 않게 한다.

| 컨테이너 | 네트워크 | 가진 것 |
|---|---|---|
| `qa-agent`(Codex CLI, 버전 고정) | 인터넷(OpenAI) | 요청서(읽기 전용), Codex 로그인 사본(tmpfs) |
| `qa-browser`(Playwright MCP) | 테스트 환경 내부 망만(`internal: true`) | 테스트 환경 웹 주소만 허용 |
| `qa-mcp`(우리 MCP) | 테스트 환경 내부 망만 | 테스트 토큰. 역할별 로그인·예제 데이터 도구만 준다 |

- 지침(`scripts/llm-qa/guide.md`) 줄거리:
  1. 요청서로 시나리오 4~8개를 정한다. 정상 경로 먼저, 상태 변화·환경 차이(기기 테마·390px·키보드)·오류 입력 가운데 PR과 관계있는 것을 더한다. 브라우저로 확인할 수 없는 기준(문서·소스)은 시나리오로 만들지 않는다.
  2. 시나리오마다 실행하고 스크린샷·콘솔 오류·실패한 요청·측정값을 근거로 남긴다. 추측으로 pass를 주지 않는다.
  3. 재현 단계는 다른 사람이 그대로 따라 할 수 있게 연 주소·화면 폭·누른 요소·입력값을 적는다(시험에서 "라이트 모드 버튼을 누른다"처럼 주소 없는 단계가 나왔다).
  4. 자동화가 없는 완료 기준은 Playwright 테스트 초안을 남긴다.
- 프롬프트 인젝션 대비:
  - PR 본문·코드·화면 글자는 데이터로만 다루라고 지침에 적는다.
  - 더 중요한 장치는 구조다. 모델이 할 수 있는 일이 테스트 환경 안의 클릭과 기록뿐이고, 가진 비밀(Codex 로그인)을 내보낼 길(셸 네트워크·브라우저 인터넷)이 막혀 있다.
  - 결과 댓글·이슈는 `scripts/llm-qa-report.mjs`가 정해진 틀로 만든다. 모델이 쓴 글은 인용 블록 안에 길이를 제한해 넣고 멘션(@)을 지운다.

### 판정과 결과

- `llm-qa`는 커밋 상태(Commit Status API)로 단다. 커밋 상태의 값은 `pending`·`success`·`failure`·`error` 넷뿐이다. `neutral`은 GitHub App이 쓰는 Checks API에만 있으므로, "확인 못 함"은 `success`에 설명 문구로 구분한다. 시나리오를 돌린 경우 설명란(140자)은 항상 `통과 n · 실패 n · 확인 못 함 n`으로 시작하고, 돌리지 못한 경우는 `대상 아님`·`확인 못 함:`으로 시작해, 초록 체크만 보고 통과로 오해하지 않게 한다.

  | 상태 | 경우 | 설명 예 |
  |---|---|---|
  | `pending` | pahidc에서 실행 중 | `실행 중` |
  | `success` | 모든 시나리오 통과 | `통과 6 · 실패 0 · 확인 못 함 0` |
  | `success` | 실패는 없고 확인 못 한 시나리오가 있음 | `통과 4 · 실패 0 · 확인 못 함 2 — 댓글 확인` |
  | `success` | 대상 아님(화면·API 코드 변경 없음) | `대상 아님(화면·API 코드 변경 없음)` |
  | `failure` | 실패가 하나라도 있음 | `통과 3 · 실패 1 · 확인 못 함 0` |
  | `error` | 접속 설정 없음, 메모리 부족, 테스트 환경·QA 명령 오류. Actions에서 다시 실행한다 | `오류: 테스트 환경이 뜨지 않았습니다.` |

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
- QA 보고서(`qa-report.yml`)에 반영한다. LLM QA가 결과(`llm-qa` 아티팩트)를 남기고 끝나면 보고서 워크플로가 다시 돌아, 같은 커밋의 PR CI 결과에 "LLM e2e QA (advisory)" 절(댓글 5장, PDF 6.4)과 측정치 한 줄을 더한 **새 판**(0.x를 하나 올림)을 만든다. 개정 이력에는 "PR stage report + LLM e2e QA (CI #…, LLM QA #…)"로 남고, 같은 CI·LLM QA 실행을 다시 돌리면 판 번호를 유지한다. 참고 체크라 보고서 판정(Verdict)은 바꾸지 않고, LLM QA를 끝내지 못했으면 "계획 대비 차이"에 적는다.

### 실패하면 이슈를 올린다

실패(`fail`) 시나리오마다 `llm-qa.yml`이 GitHub 이슈를 하나씩 만든다. PR 댓글은 다음 커밋에서 덮이지만, 이슈는 결함을 고칠 때까지 남는다.

- 제목: `bug(qa): <시나리오 제목> — PR #<n> LLM QA 실패`. 레이블은 `bug`·`qa:llm`. 본문 끝에 원래 PR을 연결하되 `Closes`는 쓰지 않는다.
- 본문은 AGENTS.md 이슈 형식(`## 배경`/`## 범위`/`## 완료 기준`)에 아래를 더한다. 작업자가 정해진 틀로 채우고, 모델이 쓴 글은 인용 블록에 넣는다. 길이를 자르고 `@`·`#숫자`가 멘션·자동 연결이 되지 않게 바꾼다.
  - **배경**: PR 번호·SHA, 확인한 완료 기준, 환경(테스트 환경·브라우저·화면 크기·계정 역할), 모델과 실행 기록 링크
  - **재현 단계**: 번호를 매긴 단계. 지침에서 "다른 사람이 그대로 따라 할 수 있게, 주소·누른 것·입력값을 구체적으로"를 요구한다
  - **기대 결과 / 실제 결과**
  - **근거**: 스크린샷 링크(`qa-reports`), 콘솔 오류, 실패한 네트워크 요청, 측정값(색·크기·대비)
  - **완료 기준**: 재현 단계에서 기대 결과가 나오고, 재현 테스트가 CI에서 통과한다
- 같은 결함을 다시 올리지 않는다. PR 번호와 시나리오 제목으로 지문을 만들어 본문에 숨겨 두고(`<!-- llm-qa:<지문> -->`), 열린 이슈에 같은 지문이 있으면 새로 만들지 않고 댓글로 "다시 실패(SHA)"만 더한다.
- 다음 실행에서 같은 시나리오가 통과하면 이슈에 "통과(SHA)" 댓글을 남긴다. 닫는 것은 사람이 한다.
- 오탐이면 사람이 `qa:false-positive` 레이블을 붙여 닫는다. 이 레이블 수가 거짓 실패율 지표가 된다.
- 한 실행에서 이슈는 최대 5개까지 만든다. 나머지는 PR 댓글에만 둔다(폭주 방지).
- `확인 못 함`(`blocked`)은 이슈로 만들지 않는다.

### 다시 돌리기

- Actions 탭에서 `LLM QA` 워크플로를 PR 번호로 실행한다(`workflow_dispatch`, 쓰기 권한이 있는 사람만). 작성자·레이블·경로 조건 없이 그 PR의 최신 커밋으로 돈다.
- PR 댓글 `/llm-qa`로 다시 돌리기는 다음 단계다.

## 단계

1. **루프(이번)**: `llm-qa.yml`, `scripts/llm-qa/`(QA 명령·설치·seed·지침·결과 형식), `scripts/llm-qa-report.mjs`(요청서·댓글·상태·이슈, 테스트 `scripts/llm-qa-report.test.mjs`).
   - 개발 PC 시험(2026-11-03): #171의 CSP 문제(사람이 찾은 결함)를 고치기 전 커밋(`9abf426`)에서 LLM이 찾는지 확인했다. 같은 Docker 테스트 환경, Codex 0.164.0 + Playwright MCP 0.0.83.

     | 모델 | 시나리오 | CSP 결함 | 그 밖 | 토큰 |
     |---|---|---|---|---|
     | `gpt-6-astra` | 8개: 통과 4 · 실패 3 · 확인 못 함 1 | 찾음(첫 테마·새로고침 유지, 콘솔 CSP 오류 근거) | 휴대폰에서 테마 버튼이 사라졌다는 실패는 오탐(사용자 메뉴로 옮김) | 약 4.8만 |
     | `gpt-6.1-terra` | 6개: 통과 2 · 실패 2 · 확인 못 함 2 | 찾음(같은 근거) | 오탐 없음. 실행 약 1분 | 약 7만 |

   - pahidc 시험: PR #181(이 PR) 문서에 적는다.
2. **격리·운영**: 세 컨테이너 분리, 하루 한도(`LLM_QA_DAILY_MAX`), `/llm-qa` 댓글 재실행, 기존 e2e 중 변경 파일에 걸린 @R 태그만 먼저 돌리기.
3. **보조안·고도화**: pahidc가 응답하지 않으면 Actions에서 GitHub Models로 "완료 기준 → 시나리오 계획"만 댓글로 남긴다. 거짓 실패율 지표, 필수 체크 승격 검토.

## 결과

- 새 비밀(저장소 secrets): `LLM_QA_SSH_KEY`(QA 강제 명령 전용 SSH 비공개 키), `LLM_QA_SSH_HOST`. 새 변수: `LLM_QA_SSH_KNOWN_HOSTS`. pahidc에는 GitHub 토큰을 두지 않는다.
- 새 상태 체크 `llm-qa`(필수 아님), 새 레이블 `qa:llm`·`qa:false-positive`. 실패하면 이슈가 자동으로 생긴다.
- pahidc에 QA 전용 compose 프로젝트(`solveline-qa`, 127.0.0.1:8091)가 잠깐 뜬다. 운영 compose(`solveline-production`)와 네트워크·볼륨을 나눈다. 테스트 환경 데이터는 tmpfs라 남지 않는다.
- 사용자 코드 실행은 여전히 테스트 환경의 runner 컨테이너에서만 한다(샌드박스 규칙 그대로).
