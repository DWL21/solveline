<p align="center">
  <b>Solveline</b> — 기존와 같은 Java·Python 코딩 테스트 연습 환경
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Java-OpenJDK%2017-e76f00" alt="OpenJDK 17">
  <img src="https://img.shields.io/badge/Python-3.8-3776ab" alt="Python 3.8">
  <img src="https://img.shields.io/badge/access-password%20only-21242e" alt="Password only">
</p>

---

**서비스**: <a href="https://solveline.simplyimg.com">https://solveline.simplyimg.com</a> (예전 주소 codetest.simplyimg.com은 이곳으로 이동)

**문서**: [`AGENTS.md`](AGENTS.md) · [`packages/shared/src/index.ts`](packages/shared/src/index.ts) (API 계약) · [`docs/decisions`](docs/decisions)

---

기존 코딩 테스트 화면처럼 문제 설명·코드 에디터·실행 결과를 한 화면에 두고, 같은 계열의 Java·Python 환경에서 코드를 실행하는 개인용 웹 IDE입니다.
누구나 문제를 둘러볼 수 있고, Google 계정으로 가입하면 코드를 작성·실행·채점하고 풀이 기록을 남길 수 있습니다.

주요 특징:

* **solution 함수형**: `class Solution { ... solution(...) }` / `def solution(...)`을 테스트 케이스마다 호출하고 반환값을 기댓값과 타입까지 비교. `[1, 2]`, `"abc"`, `[["a", 1]]`처럼 기존 표기 그대로 입력.
* **표준 입출력형**: PCCE·입출력 문제처럼 `main`/스크립트를 입력과 함께 실행하고 출력 비교.
* **코드 실행 / 제출 후 채점**: 코드 실행은 보이는 케이스로 입력·기댓값·출력까지, 제출은 히든 케이스로 통과/실패·시간·메모리와 점수만 보여 준다(기존와 같음).
* **공용 문제집**: 문제·폴더·채점 케이스는 모두가 같이 본다. 편집 권한이 있는 사용자만 편집 모드에서 바꾸고, 바꾸면 모두에게 적용된다.
* **내 풀이 기록**: 작성 코드·내 테스트 케이스·메모·풀이 시간·채점 결과·컬렉션(가상 묶음)은 계정마다 따로 저장된다.
* **실시간 저장**: 언어별 코드·내 케이스·메모를 입력 즉시(0.3초) 저장하고, 문제 전환·탭 닫기 때도 바로 저장.
* **격리 실행**: 사용자 코드는 인터넷이 차단된 runner 컨테이너에서 권한을 낮춘 uid로 실행.
* **Google 로그인**: 로그인과 회원가입 모두 Google 계정. 처음이면 약관 동의(만 14세 이상·이용약관·개인정보 수집·이용) 화면을 거친다.
* **관리자 모드**(`/admin`): 마스터 비밀번호로만 연다. 사용자 목록·상세 현황을 보고, 편집 권한을 주거나 회수하고, 이용 정지·블랙리스트(이메일)를 관리한다.

## 실행 환경

| | 버전 | 실행 |
|---|---|---|
| Java | OpenJDK 17 (Temurin) | `javac -encoding UTF-8` → `java -Xmx512m -XX:+UseSerialGC` |
| Python3 | CPython 3.8 | `python3` (재귀 제한 등 기본값 그대로) |

버전은 [`docker/runner.Dockerfile`](docker/runner.Dockerfile)의 `JAVA_VERSION`, `PYTHON_VERSION` 빌드 인자로 바꿀 수 있습니다.
기존는 공식 버전 표를 공개하지 않아, 기존에서 `System.getProperty("java.version")` / `sys.version`을 출력해 확인한 뒤 맞추세요.

## 이름

서비스 이름은 **Solveline**입니다(예전 이름 codetest, 저장소 DWL21/solveline). 내부 식별자(`@codetest/*` 패키지, compose 프로젝트 `codetest-production`, 서버 경로 `/var/lib/codetest`·`/etc/codetest`, 세션 쿠키 이름)는 운영 데이터 이전 없이 그대로 둡니다.

## Requirements

* Node.js 24+, pnpm 10+
* Docker (runner 실행)

## Installation

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

`apps/api/.env`는 gitignore 대상입니다. 변수 목록과 설명은 [`apps/api/.env.example`](apps/api/.env.example)에 있습니다.
배포 워크플로가 `production` 환경에서 위 값만 이름으로 꺼내 서버 `/etc/codetest/api.env`로 기록합니다. 새 변수는 [`deploy.yml`](.github/workflows/deploy.yml)의 목록에도 추가해야 합니다.

## Example

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

## API

전체 스키마는 [`packages/shared/src/index.ts`](packages/shared/src/index.ts)에 있습니다. 문제·폴더 조회(GET)는 비회원도 되고, 나머지는 로그인 세션이 필요합니다. 문제·폴더·히든 케이스를 바꾸는 요청은 편집 권한이 있어야 합니다.

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/api/auth/google/start` | Google 로그인 시작(로그인·회원가입 공통) |
| `GET` | `/api/auth/google/callback` | Google 인증 결과. 기존 회원은 로그인, 새 계정은 `/signup`으로 |
| `GET` `POST` | `/api/auth/signup` | 가입 대기 중인 Google 계정 / 약관 동의 후 가입 |
| `GET` | `/api/auth/session` | 세션 상태와 로그인한 계정(편집 권한 포함) |
| `POST` | `/api/auth/logout` | 로그아웃 |
| `DELETE` | `/api/account` | 회원 탈퇴(내 풀이 기록 모두 삭제) |
| `GET` | `/api/public/config` | 공개 설정(문의 이메일, 약관 버전) |
| `POST` | `/api/admin/login` | 관리자 모드(마스터 비밀번호) |
| `GET` | `/api/admin/users`, `/api/admin/users/{id}` | 사용자 목록 / 상세 현황 |
| `PUT` | `/api/admin/users/{id}/role`, `/api/admin/users/{id}/block` | 편집 권한 주기·회수 / 이용 정지·해제 |
| `GET` `POST` `DELETE` | `/api/admin/blocklist` | 블랙리스트(이메일) |
| `GET` | `/api/runtime` | runner 상태와 Java·Python 버전 |
| `GET` `POST` | `/api/problems` | 문제 목록 / 만들기 |
| `GET` `PUT` `DELETE` | `/api/problems/{id}` | 문제 조회 / 저장 / 삭제 |
| `GET` `POST` | `/api/folders` | 폴더 목록 / 만들기 |
| `PUT` `DELETE` | `/api/folders/{id}` | 폴더 이름 바꾸기 / 삭제 (문제는 폴더 없음으로) |
| `GET` `POST` | `/api/collections` | 컬렉션 목록(문제 id 순서 포함) / 만들기 |
| `PUT` `DELETE` | `/api/collections/{id}` | 컬렉션 이름·설명 바꾸기 / 삭제 (문제는 그대로) |
| `PUT` | `/api/collections/{id}/items` | 컬렉션의 문제 목록·순서 지정 |
| `GET` `PUT` | `/api/problems/{id}/hidden` | 히든 테스트셋 읽기 / 바꾸기 (내용 해시 파일로 저장) |
| `POST` | `/api/submissions` | 코드 실행(`run`) 또는 제출 채점(`submit`)을 대기열에 넣고 id 반환 (202) |
| `GET` | `/api/submissions/{id}` | 제출 상태(queued·running·done·error), 대기 순번, 결과·점수 |
| `POST` | `/api/run` | 동기 실행(스크립트용, 내부적으로 대기열 사용) |
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
solveline.simplyimg.com ─ Cloudflare Tunnel ─ pahidc 127.0.0.1:8083
                                              └─ nginx (web 정적 파일)
                                                  └─ /api/* → api:8787 (Hono, SQLite, 제출 큐·디스패처)
                                                               └─ runner:8000 × RUNNER_URLS (internal 네트워크, 인터넷 차단, 테스트셋 캐시)
```

채점 흐름(자세히는 [`docs/decisions/0003-judge-pipeline.md`](docs/decisions/0003-judge-pipeline.md)):

```
브라우저 ─POST /api/submissions─▶ api: submissions 표(queued) ─디스패처(코드 실행 > 제출)─▶ 빈 runner 슬롯
   └─ GET /api/submissions/:id 로 결과 조회         runner: 테스트셋을 해시로 캐시, 없을 때만 받음 (409 → 업로드)
```

`main` 푸시 → `Production deployment` 워크플로(self-hosted runner `codetest-production`) → `/etc/codetest/api.env` 기록 → `docker compose up --build` → 공개 주소 헬스 체크.
