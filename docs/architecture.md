# 구조와 배포

## 실행 환경

| | 버전 | 실행 |
|---|---|---|
| Java | OpenJDK 21.0.2 (Temurin) | `javac -encoding UTF-8 -g:none -Xlint:deprecation` → `java -Xmx512m -XX:+UseSerialGC` |
| Python3 | Python 3.13.13 | `python3` (재귀 제한 등 기본값 그대로) |

버전은 [`docker/runner.Dockerfile`](../docker/runner.Dockerfile)의 `JAVA_VERSION`, `PYTHON_VERSION` 빌드 인자로 바꿀 수 있습니다.
기존는 공식 버전 표를 공개하지 않아, 기존에서 `System.getProperty("java.version")` / `sys.version`을 출력해 확인한 뒤 맞추세요.

## 배포 구조

```
solveline.simplyimg.com ─ Cloudflare Tunnel ─ pahidc 127.0.0.1:8083
                                              └─ nginx (web 정적 파일)
                                                  └─ /api/* → api:8787 (Hono, SQLite, 제출 큐·디스패처)
                                                               └─ runner:8000 × RUNNER_URLS (internal 네트워크, 인터넷 차단, 테스트셋 캐시)
```

채점 흐름(자세히는 [`decisions/0003-judge-pipeline.md`](decisions/0003-judge-pipeline.md)):

```
브라우저 ─POST /api/submissions─▶ api: submissions 표(queued) ─디스패처(코드 실행 > 제출)─▶ 빈 runner 슬롯
   └─ GET /api/submissions/:id 로 결과 조회         runner: 테스트셋을 해시로 캐시, 없을 때만 받음 (409 → 업로드)
```

`main` 푸시 → `Production deployment` 워크플로(self-hosted runner `solveline-production`) → `/etc/solveline/api.env` 기록 → `docker compose up --build` → 공개 주소 헬스 체크.

## 이름

서비스 이름은 **Solveline**입니다(예전 이름 codetest). 패키지 `@solveline/*`, compose 프로젝트 `solveline-production`, 서버 경로 `/var/lib/solveline`·`/etc/solveline`, 세션 쿠키 `solveline_session`, DB 파일 `solveline.db`를 씁니다.
예전 이름에서의 이전은 배포 스크립트([`scripts/deploy-production.sh`](../scripts/deploy-production.sh))와 api가 한 번 처리합니다: 예전 compose 프로젝트를 내리고 데이터 폴더를 옮기며, `codetest.db`는 `solveline.db`로 바꾸고, 예전 세션 쿠키와 창 크기 설정은 계속 읽습니다.
예전 주소 codetest.simplyimg.com은 solveline.simplyimg.com으로 이동합니다.
