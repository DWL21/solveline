# 인수인계: Worker(서버리스) 이전 — 2026-10-28

설계는 [0006](decisions/0006-catalog-r2-worker.md)(카탈로그·R2)과 [0007](decisions/0007-serverless-worker-and-judge.md)(API 전체를 Worker·D1로, pahidc에는 judge만)에 있다. 작업 규칙은 `AGENTS.md`를 따른다(이슈 → `<type>/<n>` 브랜치 → PR → CI → squash 머지 = 운영 배포, 강제 푸시 금지, 커밋·PR·사용자 문구는 한국어).

## 지금 상태

| PR | 내용 | 상태 |
|---|---|---|
| #120 | 카탈로그 분리, Worker 엣지 캐시, R2 게시 코드 | 머지·배포 완료 |
| #125 | 제출 결과 긴 조회, 자동 저장 10초/60초, 타이머 5분 | 머지·배포 중 |
| #130 | R2 키 없이 Worker `/api/internal/r2`로 게시, Pages R2 바인딩, 상세 바이트 고정 | 열림. CI 통과하면 머지 |
| #128(Draft) | 1단계: 저장소 비동기 `Sql`, D1 어댑터 | main(#120·#125)을 merge한 뒤 Ready |
| `refactor/judge` | 2단계: `apps/judge` 분리(진행 중, PR 없음) | 아래 남은 일 |

Cloudflare 쪽:
- R2 버킷 `solveline-catalog`를 만들었다.
- `R2_PROXY_SECRET`을 GitHub `production` secret과 Pages 비밀 양쪽에 같은 값으로 넣었다.
- 따라서 #130이 배포되면 api가 시작하면서 문제 1,046개·목록·테스트셋 51개를 R2로 올린다. 실패하면 1분마다 다시 시도한다.

## 남은 일(순서대로)

1. **#130 머지·확인**
   - 배포가 끝나면 `npx wrangler r2 bucket info solveline-catalog`로 객체 수를 확인한다(사용자 계정 필요).
   - 그다음 `apps/web/wrangler.toml`에 `[vars] CATALOG_SOURCE = "r2"`를 넣는 PR을 만든다.
   - 배포 뒤 `curl -sI https://solveline.simplyimg.com/api/catalog/index`의 ETag가 R2 형식(32자 hex)인지 본다.
2. **#128 정리**: `origin/main`을 merge하고 검사를 통과시킨 뒤 Ready로 바꾸고, CI가 통과하면 머지한다.
3. **2단계 judge 분리 마무리**(`refactor/judge`, #128 위에 쌓음):
   - `docker/judge.Dockerfile`을 만든다. `docker/api.Dockerfile`에는 `apps/judge` 패키지를 복사한다(api가 `@solveline/judge/r2`를 쓴다).
   - `compose.production.yaml`:
     - `judge` 서비스를 추가한다(`default`와 `sandbox` 네트워크, `/var/lib/solveline:/data`, `RUNNER_URLS=http://runner:8000`, `RESULTS_URL=http://api:8787`, `PORT=8790`, env_file `/etc/solveline/judge.env`).
     - api는 `sandbox` 네트워크에서 빼고 `JUDGE_URL=http://judge:8790`을 준다.
   - `deploy.yml`·`scripts/deploy-production.sh`: `JUDGE_SECRET`을 api.env와 새 judge.env에 쓴다. judge.env에는 `JUDGE_SECRET`·`R2_PROXY_SECRET`·`WEB_ORIGIN`을 넣는다.
     - GitHub secret `JUDGE_SECRET`은 사용자가 만든다(아래 명령).
   - judge의 테스트셋 미러가 R2 키 대신 #130의 `WorkerR2Store`(Worker 경유)를 쓰게 한다. main을 merge하면 `apps/api/src/r2.ts`가 충돌하는데, 그 파일은 `apps/judge/src/r2.ts`로 옮겼다.
   - `compose.test.yaml`·`scripts/test-env.sh`: judge 서비스를 추가하고 `E2E_JUDGE_SECRET`을 만든다.
   - CI `unit` 잡: judge 커버리지를 추가한다. `sonar-project.properties`의 sources·tests·lcov에 `apps/judge`를 넣는다.
   - `AGENTS.md`·`docs/architecture.md`에 judge를 반영한다. "api 안의 디스패처만 runner를 부른다"는 "judge만"으로 고친다.
4. **3단계 Worker 실행**:
   - API(Hono)를 esbuild로 묶어 기존 `_worker.js`의 카탈로그 캐시와 합친다.
   - D1(`d1Sql`), R2 바인딩 직접 쓰기, `node:crypto` 대신 WebCrypto(또는 `nodejs_compat`)를 쓴다.
   - 요청 제한(`RateLimiter`)은 메모리라 Worker에서 소용없으므로 D1 테이블로 옮긴다.
   - judge는 `HttpJudge`로 Tunnel 호스트 `solveline-judge.simplyimg.com`을 부른다(Tunnel 경로 추가는 사용자).
   - D1 스키마는 지금 마이그레이션 결과를 덤프해 `wrangler d1 migrations` 파일로 만든다.
   - Workers Free CPU 10ms에 주의한다. 히든 테스트셋은 해석하지 않고 judge로 흘려보낸다.
5. **4단계 백업**:
   - GitHub Actions 일정 실행(GitHub-hosted)이 `wrangler d1 export`로 내보내고 `age`로 암호화한 뒤, R2 버킷 `solveline-backup`(수명 주기 7일)에 올린다.
   - `CLOUDFLARE_API_TOKEN`과 age 공개 키는 사용자가 넣는다.
6. **5단계 전환(사용자 승인 필수)**: D1 생성, SQLite → D1 이전, Pages 바인딩, judge Tunnel 연결, 예전 api 컨테이너 내리기.

## 사용자가 해야 하는 일

클라우드 세션은 사용자 Cloudflare 계정·pahidc·GitHub secret 쓰기 권한이 없다. 필요할 때 아래처럼 실행해 달라고 요청한다.

```bash
S=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'); printf %s "$S" | gh secret set JUDGE_SECRET --repo DWL21/solveline --env production; unset S
```

- D1 생성·데이터 이전·Tunnel 경로 추가·백업용 토큰은 그 단계에서 요청한다.
- 히든 테스트셋 검증·보강은 사용자가 따로 진행 중이다. R2 게시는 편집할 때마다 자동으로 따라가므로 기다릴 필요는 없다.
- 원격의 `feat/edge` 브랜치(= #128과 같은 커밋)는 지워도 된다. 사용자 확인 뒤 지운다.
