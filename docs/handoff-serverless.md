# 인수인계: Worker(서버리스) 이전 — 2026-10-28

설계는 [0006](decisions/0006-catalog-r2-worker.md)(카탈로그·R2)과 [0007](decisions/0007-serverless-worker-and-judge.md)(API 전체를 Worker·D1로, pahidc에는 judge만)에 있다. 작업 규칙은 `AGENTS.md`를 따른다(이슈 → `<type>/<n>` 브랜치 → PR → CI → squash 머지 = 운영 배포, 강제 푸시 금지, 커밋·PR·사용자 문구는 한국어).

## 지금 상태

| PR | 내용 | 상태 |
|---|---|---|
| #120·#125·#130 | 카탈로그 분리·엣지 캐시, 긴 조회·저장 간격, Worker 경유 R2 게시 | 머지·배포 완료 |
| #128 | 1단계: 저장소 비동기 `Sql`, D1 어댑터 | 머지·배포 완료 |
| #133 | `CATALOG_SOURCE = "r2"`(Worker가 R2에서 읽기) | 머지·배포 완료(ETag 32자 hex, 문제 1,046개 확인) |
| #135 | 2단계: `apps/judge` 분리와 배포 구성 | 머지·배포 완료(`/api/runtime`이 judge를 거쳐 runner up) |
| #139 | 3단계: API를 Pages Worker로 묶기, D1·R2 바인딩, WebCrypto, D1 요청 제한, D1 스키마 | 열림(Ready). CI 통과 뒤 머지 |
| #140 이슈의 PR(Draft, #139 위) | 4단계: D1 매일 암호화 백업·정리 워크플로 | #139 머지 뒤 Ready. 설정 전에는 건너뛴다 |

Cloudflare 쪽:
- R2 버킷 `solveline-catalog`를 만들었다.
- `R2_PROXY_SECRET`을 GitHub `production` secret과 Pages 비밀 양쪽에 같은 값으로 넣었다.
- 따라서 #130이 배포되면 api가 시작하면서 문제 1,046개·목록·테스트셋 51개를 R2로 올린다. 실패하면 1분마다 다시 시도한다.

## 남은 일(순서대로)

1. **#133·#135**: 끝났다. 남은 확인: 로그인한 계정으로 운영에서 코드 실행·제출이 judge를 거쳐 끝나는지 본다(운영 스모크는 비회원 경로만 본다).
2. **#139·#140**: 아래 PR이 머지되면 main을 merge(rebase 금지)해 Ready로 바꾸고 CI 통과 뒤 머지한다.
4. **3단계에서 남긴 일**(0007 「단계」 3번의 남은 일):
   - 편집할 때 카탈로그 전체를 다시 해시하지 않고 바뀐 문제만 고쳐 쓰기(Workers Free CPU 10ms)
   - Miniflare(wrangler dev)로 Worker 번들 실제 실행 검사
5. **5단계 전환(운영자 승인 필수)**:
   - D1 생성 → `apps/web/wrangler.toml`의 `[[d1_databases]]` 주석을 풀고 `database_id`를 넣는다 → `npx wrangler d1 migrations apply solveline --remote`
   - Pages 비밀: `SESSION_SECRET`·`GOOGLE_CLIENT_SECRET`·`ACCESS_PASSWORD`·`JUDGE_SECRET`. 변수: `GOOGLE_CLIENT_ID`·`OWNER_EMAIL`·`CONTACT_EMAIL`·`JUDGE_URL=https://solveline-judge.simplyimg.com`·`WEB_ORIGIN`
   - Tunnel에 `solveline-judge.simplyimg.com → judge:8790`을 추가하고, judge의 `RESULTS_URL`을 `https://solveline.simplyimg.com`으로 바꾼다
   - `deploy.yml`의 web 빌드를 `pnpm install --filter @solveline/web... --filter @solveline/api...` → web 빌드 → `pnpm --filter @solveline/api build:worker`로 바꿔 묶은 `_worker.js`를 올린다
   - 점검 시간: api를 읽기 전용으로 두고 SQLite → D1 이전(`sqlite3 .dump`에서 `_migrations` 제외, `wrangler d1 execute --file`) → `API_MODE = "worker"` → 확인 → 예전 api 컨테이너 내리기(하루는 지우지 않는다)
   - 백업 설정(0007 「매일 내보내기 설정과 복원」)

## 사용자가 해야 하는 일

클라우드 세션은 사용자 Cloudflare 계정·pahidc·GitHub secret 쓰기 권한이 없다. 필요할 때 아래처럼 실행해 달라고 요청한다.

```bash
S=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'); printf %s "$S" | gh secret set JUDGE_SECRET --repo DWL21/solveline --env production; unset S
```

- D1 생성·데이터 이전·Tunnel 경로 추가·백업용 토큰은 그 단계에서 요청한다.
- 히든 테스트셋 검증·보강은 사용자가 따로 진행 중이다. R2 게시는 편집할 때마다 자동으로 따라가므로 기다릴 필요는 없다.
- 원격의 `feat/edge` 브랜치(= #128과 같은 커밋)는 지워도 된다. 사용자 확인 뒤 지운다.
