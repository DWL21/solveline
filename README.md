<p align="center">
  <b>codetest</b> — 기존와 같은 Java·Python 코딩 테스트 환경
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Java-OpenJDK%2017-e76f00" alt="OpenJDK 17">
  <img src="https://img.shields.io/badge/Python-3.8-3776ab" alt="Python 3.8">
  <img src="https://img.shields.io/badge/access-password%20only-21242e" alt="Password only">
</p>

---

**서비스**: <a href="https://codetest.simplyimg.com">https://codetest.simplyimg.com</a> (비밀번호 보유자 전용)

**문서**: [`AGENTS.md`](AGENTS.md) · [`packages/shared/src/index.ts`](packages/shared/src/index.ts) (API 계약) · [`docs/decisions`](docs/decisions)

---

기존 코딩 테스트 화면처럼 문제 설명·코드 에디터·실행 결과를 한 화면에 두고, 같은 계열의 Java·Python 환경에서 코드를 실행하는 개인용 웹 IDE입니다.
인터넷에 배포하지만 **비밀번호를 아는 사람만** 열 수 있습니다.

주요 특징:

* **solution 함수형**: `class Solution { ... solution(...) }` / `def solution(...)`을 테스트 케이스마다 호출하고 반환값을 기댓값과 타입까지 비교. `[1, 2]`, `"abc"`, `[["a", 1]]`처럼 기존 표기 그대로 입력.
* **표준 입출력형**: PCCE·입출력 문제처럼 `main`/스크립트를 입력과 함께 실행하고 출력 비교.
* **코드 실행 / 제출 후 채점**: 코드 실행은 보이는 케이스로 입력·기댓값·출력까지, 제출은 히든 케이스로 통과/실패·시간·메모리와 점수만 보여 준다(기존와 같음).
* **폴더·컬렉션**: 문제는 폴더 하나에 들어가고, 컬렉션은 문제를 옮기지 않는 가상 묶음(한 문제가 여러 컬렉션에, 순서 유지).
* **실시간 저장**: 문제 설명·테스트 케이스·언어별 코드를 입력 즉시(0.3초) 저장하고, 문제 전환·탭 닫기 때도 바로 저장.
* **격리 실행**: 사용자 코드는 인터넷이 차단된 runner 컨테이너에서 권한을 낮춘 uid로 실행.
* **비밀번호 로그인**: 랜덤 비밀번호 하나. 원본은 GitHub Environment secret에만 있고, 시도 횟수를 제한한다.

## 실행 환경

| | 버전 | 실행 |
|---|---|---|
| Java | OpenJDK 17 (Temurin) | `javac -encoding UTF-8` → `java -Xmx512m -XX:+UseSerialGC` |
| Python3 | CPython 3.8 | `python3` (재귀 제한 등 기본값 그대로) |

버전은 [`docker/runner.Dockerfile`](docker/runner.Dockerfile)의 `JAVA_VERSION`, `PYTHON_VERSION` 빌드 인자로 바꿀 수 있습니다.
기존는 공식 버전 표를 공개하지 않아, 기존에서 `System.getProperty("java.version")` / `sys.version`을 출력해 확인한 뒤 맞추세요.

## Requirements

* Node.js 24+, pnpm 10+
* Docker (runner 실행)

## Installation

```console
$ git clone https://github.com/DWL21/codetest.git
$ cd codetest
$ pnpm install
```

## 비밀 정보 보관 위치

| 비밀 | 로컬 | 운영 |
|---|---|---|
| `ACCESS_PASSWORD`, `SESSION_SECRET` | `apps/api/.env` | GitHub → Settings → Environments → `production` → **Secrets** |
| `SESSION_TTL_DAYS`(선택) | `apps/api/.env` | 같은 환경의 **Variables** |

`apps/api/.env`는 gitignore 대상입니다. 변수 목록과 설명은 [`apps/api/.env.example`](apps/api/.env.example)에 있습니다.
배포 워크플로가 `production` 환경에서 위 값만 이름으로 꺼내 서버 `/etc/codetest/api.env`로 기록합니다. 새 변수는 [`deploy.yml`](.github/workflows/deploy.yml)의 목록에도 추가해야 합니다.

## Example

### 1. 비밀번호 정하기

```console
$ openssl rand -base64 24 | tr '+/' '-_' | tr -d '='
```

출력된 값을 `apps/api/.env`의 `ACCESS_PASSWORD=`에 넣습니다 (24자 이상).

### 2. 실행

```console
$ pnpm dev:runner   # 다른 터미널에서 계속 실행
$ pnpm dev
```

* 웹: http://localhost:5173 — `ACCESS_PASSWORD`로 로그인
* API: http://localhost:8787/api/health

## API

전체 스키마는 [`packages/shared/src/index.ts`](packages/shared/src/index.ts)에 있습니다. `/api/health`, `/api/auth/*` 외에는 세션이 필요합니다.

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/auth/login` | 비밀번호 확인, 세션 쿠키 발급 |
| `GET` | `/api/auth/session` | 세션 상태 |
| `POST` | `/api/auth/logout` | 로그아웃 |
| `GET` | `/api/runtime` | runner 상태와 Java·Python 버전 |
| `GET` `POST` | `/api/problems` | 문제 목록 / 만들기 |
| `GET` `PUT` `DELETE` | `/api/problems/{id}` | 문제 조회 / 저장 / 삭제 |
| `GET` `POST` | `/api/folders` | 폴더 목록 / 만들기 |
| `PUT` `DELETE` | `/api/folders/{id}` | 폴더 이름 바꾸기 / 삭제 (문제는 폴더 없음으로) |
| `GET` `POST` | `/api/collections` | 컬렉션 목록(문제 id 순서 포함) / 만들기 |
| `PUT` `DELETE` | `/api/collections/{id}` | 컬렉션 이름·설명 바꾸기 / 삭제 (문제는 그대로) |
| `PUT` | `/api/collections/{id}/items` | 컬렉션의 문제 목록·순서 지정 |
| `POST` | `/api/run` | 코드 실행 (테스트 케이스 최대 40개) |
| `GET` | `/api/health` | 상태 확인 |

## Stack

| | |
|---|---|
| Web | React 19 · Vite · TypeScript · Tailwind CSS v4 · TanStack Query · CodeMirror 6 |
| API | Hono · Node 24 · SQLite |
| Runner | Python 3.8 표준 라이브러리 HTTP 서버 · OpenJDK 17 |
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

## Development

이슈 → `<type>/<이슈 번호>` 브랜치 → PR → `main` squash 머지 → GitHub Actions가 pahidc에 자동 배포. 자세한 규칙은 [`AGENTS.md`](AGENTS.md).

```console
$ pnpm check   # 타입 검사 + 테스트 + 빌드
```

### 배포 구조

```
codetest.simplyimg.com ─ Cloudflare Tunnel ─ pahidc 127.0.0.1:8083
                                              └─ nginx (web 정적 파일)
                                                  └─ /api/* → api:8787 (Hono)
                                                               └─ runner:8000 (internal 네트워크, 인터넷 차단)
```

`main` 푸시 → `Production deployment` 워크플로(self-hosted runner `codetest-production`) → `/etc/codetest/api.env` 기록 → `docker compose up --build` → 공개 주소 헬스 체크.
