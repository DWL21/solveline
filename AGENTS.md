# AGENTS.md — Solveline 작업 규칙

사람과 AI 에이전트(Claude Code, Codex 등)가 이 저장소에서 작업할 때 지키는 규칙입니다. `CLAUDE.md`는 이 파일을 가리킵니다.
**공개 저장소**(DWL21/solveline, 예전 이름 codetest)입니다. 서비스 이름은 **Solveline**, 주소는 https://solveline.simplyimg.com 입니다.
내부 식별자도 모두 solveline입니다(`@solveline/*` 패키지, compose 프로젝트 `solveline-production`, `/var/lib/solveline`·`/etc/solveline`, 세션 쿠키 `solveline_session`). 예전 이름에서의 이전은 [docs/architecture.md](docs/architecture.md#이름) 참고. 커밋·이슈·PR·Actions 로그는 누구나 볼 수 있다고 가정합니다.

## 저장소 구조

| 경로 | 내용 | 실행 환경 |
|---|---|---|
| `apps/api` | Hono REST API, Google 로그인·관리자 모드, 문제 저장(SQLite), 제출 기록·judge 클라이언트, 매일 백업 | Node 24 (Docker, pahidc) |
| `apps/judge` | 채점 서비스: 제출 대기열·디스패처, 히든 테스트셋(해시 파일, R2 미러), runner 호출 | Node 24 (Docker, pahidc) |
| `apps/web` | React 19 + Vite + Tailwind v4 + CodeMirror 6 웹 IDE, `public/_worker.js`(카탈로그 캐시·R2 읽기, 나머지 `/api/*`는 Tunnel로) | Cloudflare Pages |
| `runner` | 코드 실행 서버(Python 표준 라이브러리) + Java/Python 실행기 | 인터넷 차단 컨테이너 (OpenJDK 21.0.2, Python 3.13.13) |
| `packages/shared` | API 계약(Zod 스키마·타입), api↔judge 계약·서명, 기본 코드 템플릿 | api·judge·web 공용 |
| `docker`, `deploy`, `compose.production.yaml`, `scripts/deploy-production.sh` | 운영 API·judge 이미지·nginx 게이트웨이·배포 | pahidc |
| `.github/workflows` | 통합 CI(`ci.yml`), 배포(`deploy.yml`), 운영 스모크(`smoke.yml`) | GitHub-hosted / self-hosted(pahidc) |
| `docs/decisions` | 결정 기록 | — |

## 작업 흐름 (필수)

1. **이슈** — 코드·문서·설정 등 독립적인 작업은 커밋 전에 GitHub Issue를 만든다. 본문은 `## 배경` / `## 범위` / `## 완료 기준`. 레이블을 1개 이상 붙인다.
2. **브랜치** — 최신 `main`에서 `<type>/<이슈번호>` (예: `feat/12`, `fix/18`, `docs/23`). 한 브랜치에는 한 이슈만.
3. **커밋** — Conventional Commits. `<type>(<scope>): <한국어 요약>`, 명령형, 마침표 없음. 한 커밋은 한 가지 의도.
4. **PR** — base는 `main`. 제목은 커밋 규칙과 같다. 본문은 `## 변경 사항` / `## 검증` / `Closes #n`. 검증에는 실제로 실행한 명령과 결과만 적는다. 레이블 1개 이상.
5. **머지** — CI(`check`, `docker`, `secret-scan`) 통과 후 squash 머지. main 머지 = 운영 배포.
6. **완료 전 확인** — `pnpm check`, `git diff --check`, `git status`로 의도하지 않은 파일이 없는지 확인한다.

레이블: `feat` `fix` `bug` `docs` `chore` `refactor` `test` `style` `ci` `build` `perf` `revert`

## 비밀 정보 (절대 규칙)

| 비밀 | 로컬 | 운영 |
|---|---|---|
| `ACCESS_PASSWORD` (관리자 모드 마스터 비밀번호), `GOOGLE_CLIENT_SECRET` | `apps/api/.env` (gitignore, 권한 600) | GitHub Environment `production` **secrets** |
| `JUDGE_SECRET` (api↔judge 서명) | 개발은 비워 두면 임의 값(judge에도 같은 값을 줘야 한다) | GitHub Environment `production` **secrets** → `api.env`·`judge.env` |
| `SESSION_SECRET` | `apps/api/.env` | GitHub Environment `production` **secrets** |
| `SESSION_TTL_DAYS` (선택) | `apps/api/.env` | GitHub Environment `production` **variables** |

- 배포 워크플로는 `production` 환경에서 **이름을 지정한 값만** 서버 `/etc/solveline/api.env`·`judge.env`(root, 600)로 기록한다. judge.env에는 judge가 쓰는 값(`JUDGE_SECRET`, R2 설정)만 넣는다. 공개 저장소이므로 비밀 전체를 한꺼번에 꺼내는 코드(`toJSON(secrets)` 등)를 쓰지 않는다 — GitHub가 악성 워크플로로 분류해 실행을 막는다.
- 새 환경 변수는 ① GitHub Environment ② `apps/api/.env.example` ③ `deploy.yml`의 `env:`와 `KEYS`(judge가 쓰면 `JUDGE_KEYS`, 필수면 `REQUIRED`도)에 함께 추가해야 반영된다.
- `production` 환경은 `main` 브랜치에서만 쓸 수 있다(deployment branch policy).
- `.env.example`은 커밋 대상이다. 실제 값을 넣지 않는다.
- 키·토큰·비밀번호·쿠키·`.env` 내용을 **커밋·PR 본문·이슈·로그·출력에 남기지 않는다.**
- 새 환경 변수는 `apps/api/.env.example`에 **이름과 설명만** 추가한다.

## 공개 저장소 + self-hosted runner 규칙

- self-hosted runner(레이블 `solveline-production`)는 `deploy.yml`의 `push: main`·`workflow_dispatch`에서만 쓴다. 다른 워크플로·`pull_request` 이벤트에 self-hosted 레이블을 쓰지 않는다.
- `deploy` 잡은 `github.repository == 'DWL21/solveline' && github.ref == 'refs/heads/main'`일 때만 돈다.
- 외부 기여자 PR의 워크플로는 **항상 승인 후 실행**(저장소 설정 `all_external_contributors`). 외부 PR이 `.github/workflows`를 바꾸면 승인 전에 반드시 내용을 읽는다.
- CI(`ci.yml`)는 GitHub-hosted runner만 쓴다.

## 코드 실행 샌드박스 규칙

- 사용자 코드는 `runner` 컨테이너에서만 실행한다. api·judge·web 컨테이너에서 실행하지 않는다.
- `sandbox` 네트워크에는 runner와 judge만 붙는다. api는 runner에 직접 닿지 않는다.
- runner는 `internal: true` 네트워크에만 붙어 **인터넷에 나갈 수 없다**. 포트를 호스트에 열지 않는다.
- runner 서버는 root로 돌지만 capability는 `CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL`만 남긴다. 사용자 코드는 항상 `sandbox`(uid 10001)로 낮추고 새 세션·rlimit(CPU, 파일 크기, 프로세스 수, Python 주소 공간)·10초 제한을 건다.
- 루트 파일시스템은 읽기 전용, 쓰기는 `/tmp` tmpfs(512MB)만. 컨테이너 메모리 1.5GB, CPU 2, PID 512.
- 샌드박스 옵션을 바꾸면 `runner/selftest.py`의 격리 검사도 함께 고치고 CI `docker` 잡에서 통과시킨다.

## 기존 동등성

- 기본 버전: **OpenJDK 21.0.2, Python 3.13.13** (`docker/runner.Dockerfile`의 `JAVA_VERSION`, `PYTHON_VERSION` 빌드 인자). 바꾸면 README·docs/architecture.md와 이 문서를 같이 고친다.
- 함수형 문제: Java는 `class Solution`의 `solution(...)`, Python은 `solution(...)`을 테스트 케이스마다 새 프로세스로 한 번 호출한다. 결과는 타입까지 비교(bool≠int, 실수 1e-9 허용)한다.
- 입출력형 문제: Java는 `static void main`이 있는 클래스, Python은 스크립트를 표준 입력과 함께 실행하고 줄 끝 공백을 무시해 비교한다.
- 테스트 케이스당 10초, 제출 하나당 최대 600초, 히든 케이스 최대 200개. 채점은 비동기 큐라 Cloudflare 응답 제한과 무관하다.

## 카탈로그·사용자 데이터 분리 규칙 (0006)

- 공용 문제 데이터(문제 내용·기본 폴더·컬렉션)는 `/api/catalog/*`, 사용자 데이터는 `/api/me/*`로 나눈다. 웹이 `mergeProblem`·`mergeSummaries`(shared)로 합치고, 예전 `/api/problems`도 같은 함수로 만든다.
- Worker는 카탈로그만 캐시한다. 사용자 데이터·쿠키가 붙은 응답은 캐시하지 않는다(`no-store`).
- SQLite가 쓰기 원본이고 R2는 게시 사본이다. 공용 데이터를 바꾸는 API는 성공하면 R2에 게시한 뒤 응답한다. 히든 테스트셋은 R2(비공개)에 gzip으로 두고 공개 경로를 만들지 않는다.
- R2 키 형식을 바꾸면 `apps/api/src/catalog.ts`와 `apps/web/public/_worker.js`를 함께 고친다.
- pahidc는 R2 API 키 없이 Worker의 `/api/internal/r2`(공유 비밀 `R2_PROXY_SECRET`)로만 R2에 쓴다. R2 바인딩·변수는 `apps/web/wrangler.toml`이 관리한다.

## Worker 실행 규칙 (0007 3단계)

- api 코드(`apps/api/src`)는 Node·Workers 둘 다에서 돈다. `node:*`·`Buffer`·better-sqlite3는 `main.ts`·`db-node.ts`·`backup.ts`에서만 쓰고, 암호 기능은 `crypto.ts`(WebCrypto)를 쓴다. 어기면 `pnpm build`의 Worker 묶기가 실패한다.
- 마이그레이션(`db-node.ts`)을 더하면 `pnpm --filter @solveline/api d1:schema`로 D1 스키마 파일을 다시 만든다(테스트가 어긋나면 실패한다). 기본 행을 넣는 마이그레이션은 `d1-schema.ts`의 SEED에도 더한다.
- Worker 안의 API(`API_MODE = "worker"`, D1 바인딩)는 5단계 전환(운영자 승인) 전에는 켜지 않는다.

## 채점 파이프라인 규칙 (0003, 0007)

- 실행은 반드시 제출 기록(`submissions`)과 judge의 대기열을 거친다. judge만 runner를 부른다. 우선순위: 코드 실행(0) > 제출(1).
- api와 judge는 서로의 요청에 공유 비밀 `JUDGE_SECRET` HMAC 서명과 시각(±5분)을 붙인다(`packages/shared`의 `judgeHeaders`). judge는 결과를 api `/api/internal/judge/results`로 보내고, 실패하면 남겨 두었다가 다시 보낸다. 결과의 원본은 api(SQLite, 나중에 D1)다.
- 히든 케이스는 문제 본문에 넣지 않는다. judge가 `DATA_DIR/testsets/<sha256>.json`(바뀌지 않는 파일)에 두고 R2 `testsets/`에 올린다. 본문에는 `hiddenTestset {hash, count}`만 둔다.
- runner는 상태가 없다. 테스트셋은 해시로 캐시하고, 없으면 409를 돌려 디스패처가 올리게 한다. runner를 늘릴 때는 `RUNNER_URLS`에 더한다.
- 디스패처는 judge 프로세스 안에 있으므로 judge는 1대만 띄운다(대기열은 `DATA_DIR/judge/judge.db`).
- 백업: api가 매일 `DATA_DIR/backups`에 DB 스냅숏(7일)과 테스트셋 사본을 남긴다. 30일 지난 제출 기록과 안 쓰는 테스트셋은 정리한다.

## 접근 제어

[0004](docs/decisions/0004-google-login-and-roles.md) 참고.

- **비회원**: 문제·기본 폴더·컬렉션 조회(GET)만. 코드 작성·실행·저장은 로그인 후.
- **회원**: Google 로그인(Authorization Code + PKCE). 새 계정은 `/signup`에서 필수 동의(만 14세 이상·이용약관·개인정보 수집·이용) 후 가입. 세션은 SQLite + 서명 쿠키(HttpOnly·Secure·SameSite=Lax).
- **편집 권한**(`users.role = editor`): 문제 추가·수정·삭제, 채점 케이스(보이는·히든), 시작 코드, 컬렉션(공용, 이름의 `/`는 계층). 바꾸면 모든 사용자에게 적용된다. 운영자(`OWNER_EMAIL`)는 가입할 때 편집 권한을 받고 비밀번호 시절의 풀이 기록(`legacy_state`)을 넘겨받는다.
- **사용자별 데이터**: 작성 코드·언어·내 테스트 케이스·메모·풀이 시간·마지막 제출(`user_problems`), 폴더(`folders.user_id`, 배치는 `folder_items`), 제출 기록. 탈퇴하면 CASCADE로 지운다. 기본 폴더(틀: `folders.user_id IS NULL`, 배치는 `problems.folder_id`)는 가입할 때 개인 폴더로 복사한다.
- **관리자 모드**(`/admin`): 마스터 비밀번호 `ACCESS_PASSWORD`로만 연다(상수 시간 비교, IP별 분당 5회·전체 시간당 60회, 12시간짜리 서명 쿠키). 사용자 목록·상세, 편집 권한 부여·회수, 신규 가입 전체 허용·중지.
- **신규 가입 제어**(`signup_settings`): 기본값은 허용. 마스터가 전체 중지하면 가입 대기 계정을 포함한 신규 가입만 막고, 기존 회원 로그인·세션은 유지한다. 설정은 DB에 저장한다. 이메일 블랙리스트는 사용하지 않는다.

비밀 값(`ACCESS_PASSWORD`, `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `JUDGE_SECRET`, `R2_PROXY_SECRET`)은 GitHub Environment `production` secret에만 두고 코드·이슈·PR·로그·Actions 출력에 남기지 않는다. 계약은 `packages/shared/src/index.ts`.

## 코드 규칙

- TypeScript strict. `any` 금지(불가피하면 이유 주석). runner는 Python 표준 라이브러리만.
- API 계약 변경 시 `packages/shared`의 스키마를 먼저 고치고 api·web을 함께 맞춘다.
- 응답 형식: 성공 `{ data }`, 실패 `{ error: { code, message } }` + 적절한 4xx/5xx.
- 사용자에게 보이는 문구는 한국어, 짧고 구체적으로.
- 통과/실패는 색만으로 구분하지 않는다(✓/✗와 문구 병기).

## 검증 명령

```bash
pnpm install
pnpm check        # 타입 검사 + 테스트 + 빌드
pnpm dev:runner   # runner 컨테이너 (127.0.0.1:8000)
pnpm dev          # api :8787, web :5173 (WEB_PORT, API_PORT로 변경 가능)
docker compose -f compose.production.yaml build
scripts/test-env.sh up && pnpm --filter @solveline/e2e e2e:ci   # API·UI 자동화(Docker 테스트 환경)
scripts/sonar.sh  # 정적 분석·품질 게이트
```

테스트 작성 규칙·층 선택·PR 체크리스트는 [docs/quality/guide.md](docs/quality/guide.md). 버그 수정은 재현 테스트를 가장 낮은 층에 먼저 쓴다.
