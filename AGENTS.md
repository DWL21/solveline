# AGENTS.md — codetest 작업 규칙

사람과 AI 에이전트(Claude Code, Codex 등)가 이 저장소에서 작업할 때 지키는 규칙입니다. `CLAUDE.md`는 이 파일을 가리킵니다.
**공개 저장소**입니다. 커밋·이슈·PR·Actions 로그는 누구나 볼 수 있다고 가정합니다.

## 저장소 구조

| 경로 | 내용 | 실행 환경 |
|---|---|---|
| `apps/api` | Hono REST API, 개인키 인증, 문제 저장(SQLite), runner 프록시 | Node 24 (Docker, pahidc) |
| `apps/web` | React 19 + Vite + Tailwind v4 + CodeMirror 6 웹 IDE | nginx (Docker, pahidc) — API와 같은 출처 |
| `runner` | 코드 실행 서버(Python 3.8 표준 라이브러리) + Java/Python 실행기 | 인터넷 차단 컨테이너 (OpenJDK 17, Python 3.8) |
| `packages/shared` | API 계약(Zod 스키마·타입), 기본 코드 템플릿 | api·web 공용 |
| `docker`, `deploy`, `compose.production.yaml`, `scripts/deploy-production.sh` | 운영 이미지·nginx·배포 | pahidc |
| `.github/workflows` | CI(`ci.yml`), 배포(`deploy.yml`) | GitHub-hosted / self-hosted(pahidc) |
| `scripts/keygen.mjs` | 접근 키 생성 | 로컬 |
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
| `SESSION_SECRET` | `apps/api/.env` (gitignore, 권한 600) | GitHub Environment `production` **secrets** |
| `ACCESS_PUBLIC_KEY` | `apps/api/.env` | GitHub Environment `production` **variables** (공개키라 비밀 아님) |
| `SESSION_TTL_DAYS` (선택) | `apps/api/.env` | GitHub Environment `production` **variables** |
| 접근 개인키 | `~/.codetest/access.key` (권한 600) — 사용자 기기에만 | 서버·GitHub에 두지 않음 |

- 배포 워크플로는 `production` 환경에서 **이름을 지정한 값만** 서버 `/etc/codetest/api.env`(root, 600)로 기록한다. 공개 저장소이므로 비밀 전체를 한꺼번에 꺼내는 코드(`toJSON(secrets)` 등)를 쓰지 않는다 — GitHub가 악성 워크플로로 분류해 실행을 막는다.
- 새 환경 변수는 ① GitHub Environment ② `apps/api/.env.example` ③ `deploy.yml`의 `env:`와 `KEYS`(필수면 `REQUIRED`도)에 함께 추가해야 반영된다.
- `production` 환경은 `main` 브랜치에서만 쓸 수 있다(deployment branch policy).
- `.env.example`은 커밋 대상이다. 실제 값을 넣지 않는다.
- 키·토큰·비밀번호·쿠키·`.env` 내용을 **커밋·PR 본문·이슈·로그·출력에 남기지 않는다.**
- 새 환경 변수는 `apps/api/.env.example`에 **이름과 설명만** 추가한다.

## 공개 저장소 + self-hosted runner 규칙

- self-hosted runner(`codetest-production`)는 `deploy.yml`의 `push: main`·`workflow_dispatch`에서만 쓴다. 다른 워크플로·`pull_request` 이벤트에 self-hosted 레이블을 쓰지 않는다.
- `deploy` 잡은 `github.repository == 'DWL21/codetest' && github.ref == 'refs/heads/main'`일 때만 돈다.
- 외부 기여자 PR의 워크플로는 **항상 승인 후 실행**(저장소 설정 `all_external_contributors`). 외부 PR이 `.github/workflows`를 바꾸면 승인 전에 반드시 내용을 읽는다.
- CI(`ci.yml`)는 GitHub-hosted runner만 쓴다.

## 코드 실행 샌드박스 규칙

- 사용자 코드는 `runner` 컨테이너에서만 실행한다. api·web 컨테이너에서 실행하지 않는다.
- runner는 `internal: true` 네트워크에만 붙어 **인터넷에 나갈 수 없다**. 포트를 호스트에 열지 않는다.
- runner 서버는 root로 돌지만 capability는 `CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL`만 남긴다. 사용자 코드는 항상 `sandbox`(uid 10001)로 낮추고 새 세션·rlimit(CPU, 파일 크기, 프로세스 수, Python 주소 공간)·10초 제한을 건다.
- 루트 파일시스템은 읽기 전용, 쓰기는 `/tmp` tmpfs(512MB)만. 컨테이너 메모리 1.5GB, CPU 2, PID 512.
- 샌드박스 옵션을 바꾸면 `runner/selftest.py`의 격리 검사도 함께 고치고 CI `docker` 잡에서 통과시킨다.

## 기존 동등성

- 기본 버전: **OpenJDK 17, Python 3.8** (`docker/runner.Dockerfile`의 `JAVA_VERSION`, `PYTHON_VERSION` 빌드 인자). 바꾸면 README와 이 문서를 같이 고친다.
- 함수형 문제: Java는 `class Solution`의 `solution(...)`, Python은 `solution(...)`을 테스트 케이스마다 새 프로세스로 한 번 호출한다. 결과는 타입까지 비교(bool≠int, 실수 1e-9 허용)한다.
- 입출력형 문제: Java는 `static void main`이 있는 클래스, Python은 스크립트를 표준 입력과 함께 실행하고 줄 끝 공백을 무시해 비교한다.
- 테스트 케이스당 10초, 요청 전체 80초(Cloudflare 100초 제한 안쪽), 케이스 최대 30개.

## 접근 제어

단일 사용자 전용. 계정·비밀번호 대신 **Ed25519 개인키 서명**으로 로그인한다 (stock과 같은 방식).

1. `pnpm keygen` → 개인키는 `~/.codetest/access.key`, 공개키를 `ACCESS_PUBLIC_KEY`로 등록
2. 웹에서 개인키 파일을 선택하면 브라우저가 서버 nonce에 서명 (개인키는 전송하지 않음)
3. 서버가 공개키로 검증 → HttpOnly·Secure·SameSite=Strict 세션 쿠키 발급

`/api/health`, `/api/auth/*` 외 모든 API는 세션이 필요하다. 계약은 `packages/shared/src/index.ts`.

## 코드 규칙

- TypeScript strict. `any` 금지(불가피하면 이유 주석). runner는 Python 3.8 표준 라이브러리만.
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
```
