# 개발 가이드

## 요구 사항

* Node.js 24+, pnpm 10+
* Docker (runner 실행)

## 설치

```console
$ git clone https://github.com/DWL21/solveline.git
$ cd solveline
$ pnpm install
```

## 비밀 정보 보관 위치

| 비밀 | 로컬 | 운영 |
|---|---|---|
| `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `ACCESS_PASSWORD`(관리자 모드) | `apps/api/.env` | GitHub → Settings → Environments → `production` → **Secrets** |
| `GOOGLE_CLIENT_ID`, `OWNER_EMAIL`, `CONTACT_EMAIL`(선택), `SESSION_TTL_DAYS`(선택) | `apps/api/.env` | 같은 환경의 **Variables** |

Google OAuth 클라이언트의 승인된 리디렉션 URI는 `https://solveline.simplyimg.com/api/auth/google/callback`(로컬은 `http://localhost:<웹 포트>/api/auth/google/callback`)입니다.

`apps/api/.env`는 gitignore 대상입니다. 변수 목록과 설명은 [`apps/api/.env.example`](../apps/api/.env.example)에 있습니다.
배포 워크플로가 `production` 환경에서 위 값만 이름으로 꺼내 서버 `/etc/solveline/api.env`로 기록합니다. 새 변수는 [`deploy.yml`](../.github/workflows/deploy.yml)의 목록에도 추가해야 합니다.

## 로컬 실행

### 1. 환경 변수

`apps/api/.env`에 `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`·`OWNER_EMAIL`과, 관리자 모드용 `ACCESS_PASSWORD`(24자 이상)를 넣습니다.

```console
$ openssl rand -base64 24 | tr '+/' '-_' | tr -d '='
```

### 2. 실행

```console
$ pnpm dev:runner   # 다른 터미널에서 계속 실행
$ pnpm dev
```

* 웹: http://localhost:5173 — Google 계정으로 로그인, 관리자 모드는 `/admin`
* API: http://localhost:8787/api/health

## 스택

| | |
|---|---|
| Web | React 19 · Vite · TypeScript · Tailwind CSS v4 · TanStack Query · CodeMirror 6 |
| API | Hono · Node 24 · SQLite |
| Runner | Python 표준 라이브러리 HTTP 서버 · OpenJDK 21 |
| 계약 | Zod (`packages/shared`) |
| 배포 | Docker Compose on pahidc (nginx + api + runner) · Cloudflare Tunnel · GitHub Actions |

## 저장소 구조

```
apps/
├── api/       REST API, 인증, 문제 저장, runner 프록시
└── web/       웹 IDE
packages/
└── shared/    API 계약 (Zod), 기본 템플릿
runner/        코드 실행 서버, Java·Python 실행기, 자체 검사
docker/        운영 이미지 (api, web+nginx, runner)
deploy/        nginx 설정
scripts/       키 생성, 운영 배포
docs/          결정 기록
```

## 작업 흐름

이슈 → `<type>/<이슈 번호>` 브랜치 → PR → `main` squash 머지 → GitHub Actions가 pahidc에 자동 배포. 자세한 규칙은 [`AGENTS.md`](../AGENTS.md).

```console
$ pnpm check   # 타입 검사 + 테스트 + 빌드
```

