# 0007. API 전체를 Worker(D1·R2)로 옮기고, pahidc에는 채점(judge)만 둔다

- 상태: 진행 중(단계별 PR). **D1·R2 생성, 사용자 데이터 이전, 운영 전환은 운영자 승인 후**
- 날짜: 2026-10-28
- 0006을 확장한다. 0006에서 pahidc에 남기기로 한 사용자 데이터도 옮긴다(운영자 결정).

## 결정

| 구성 | 위치 | 하는 일 |
|---|---|---|
| Worker(Pages `_worker.js`, Hono) | Cloudflare | 로그인·세션·관리자 모드, 사용자 데이터(자동 저장·타이머·북마크·폴더), 문제 쓰기, 제출 접수·기록·결과, 카탈로그 캐시 |
| D1(`DB`) | Cloudflare | 지금 SQLite의 모든 테이블. 스키마·마이그레이션은 그대로(같은 SQLite 문법) |
| R2(`CATALOG`) | Cloudflare | 카탈로그(0006), 히든 테스트셋, 암호화 백업(별도 버킷) |
| judge | pahidc | 제출 대기열·디스패처·runner 컨테이너·테스트셋 캐시. 사용자 데이터는 두지 않는다 |

pahidc는 **실행 관리만** 한다. 서버리스로 할 수 없는 부분은 신뢰할 수 없는 코드의 샌드박스 실행과, 최대 10분 걸리는 실행을 붙잡는 대기열이다.

### 제출 흐름

```
브라우저 ─POST /api/submissions?wait=25─▶ Worker: 검사 → D1에 queued 기록 → judge POST /jobs
                                           └─ judge GET /jobs/{id}?wait=25 (긴 조회를 judge에 그대로 위임)
judge: 대기열 → runner 실행 → 끝나면 Worker POST /api/internal/judge/results (서명, 성공할 때까지 재시도)
Worker: D1에 결과·점수·마지막 제출 기록(같은 제출을 두 번 받아도 한 번만 반영)
```

- Worker와 judge는 Tunnel 호스트(`solveline-judge.simplyimg.com`)로 통신한다. 양방향 모두 공유 비밀(`JUDGE_SECRET`) HMAC 서명과 시각(±5분)을 붙여 위조와 재전송을 막는다. runner는 지금처럼 인터넷이 막힌 내부 네트워크에 둔다.
- 대기 순번과 실행 상태는 judge가 알고, 결과의 원본은 D1이다. judge가 재시작해도 기록은 남고, 보내지 못한 결과는 judge의 보낼 목록에 남아 다시 보낸다.

### Workers Free의 CPU 10ms 제한에 맞춘 선택

| 무거운 일 | 처리 |
|---|---|
| 히든 테스트셋 읽기·쓰기(최대 8MB) | Worker는 권한만 확인하고 본문을 해석하지 않은 채 judge로 흘려보낸다. judge가 검사해 R2에 저장하고 `{hash, count}`를 돌려준다 |
| 카탈로그 게시 | 문제 전체를 다시 만들지 않는다(1,046개에 약 8ms). R2 목록에서 바뀐 문제 한 줄만 고쳐 쓴다 |
| `/api/me/problems` | `problems`를 훑지 않고 사용자 테이블(`user_problems`·`bookmarks`·`folder_items`)만 `user_id` 색인으로 읽는다. D1은 읽은 행 수로 한도를 센다 |
| 세션 확인 | 서명 쿠키 검증(WebCrypto) + D1 한 행 |

### 무료 한도(하루)

| 한도 | 값 | 주로 쓰는 곳 |
|---|---|---|
| Workers 요청 | 10만 | 모든 `/api/*`. 0006의 캐시와 #124의 긴 조회·저장 간격으로 줄였다 |
| D1 읽은 행 | 500만 | 세션 1, 내 상태 수십 행, 제출 기록 20행 단위 |
| D1 쓴 행 | 10만 | 자동 저장 1~2행, 제출 2~3행, 로그인 2행 |
| D1 저장 | 5GB | 지금 7.7MB |
| R2 | 0006 참고 | — |

하루에 활성 사용자 1,000명이 자동 저장 50회와 제출 10회를 하면, D1 쓰기가 약 9만 행으로 한도에 가깝다. 그보다 커지면 Workers Paid(월 $5: 요청 1,000만, D1 쓰기 5,000만)로 올린다. 코드는 그대로다.

## 백업

1. **D1 Time Travel**(무료 플랜 7일): 지난 7일 안의 아무 시각으로나 되돌릴 수 있다. 같은 디스크라 함께 잃는 문제가 없어진다.
2. **매일 암호화 내보내기**: GitHub Actions(GitHub-hosted, 일정 실행)가 `wrangler d1 export`로 SQL을 받는다.
   - `age` 공개 키로 암호화한다. 개인 키는 운영자만 오프라인에 보관한다.
   - 비공개 R2 버킷 `solveline-backup`에 올리고, 수명 주기 규칙으로 7일 뒤 지운다.
   - 쓰기는 하루 1회, 저장은 약 8MB×7이다.
   - pahidc를 거치지 않으므로 서버가 망가져도 백업이 남는다.
3. 테스트셋은 R2에 원본이 있으므로 따로 복사하지 않는다.

### 매일 내보내기 설정과 복원(4단계)

워크플로 `.github/workflows/backup-d1.yml`(매일 03:23 KST, 수동 실행 가능)이 `scripts/backup-d1.sh`를 실행한다. 백업을 올린 뒤에 매일 정리 SQL `apps/api/d1/cleanup.sql`(지난 세션·요청 제한, 30일 지난 끝난 제출)을 실행한다. 아래 값이 하나라도 없으면 아무것도 하지 않고 성공으로 끝난다.

| 이름 | 종류(`production` 환경) | 내용 |
|---|---|---|
| `CLOUDFLARE_BACKUP_TOKEN` | secret | D1 편집(내보내기·정리)과 R2 `solveline-backup` 쓰기만 허용한 API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Cloudflare 계정 ID |
| `D1_DATABASE` | variable | D1 이름(`solveline`) |
| `BACKUP_AGE_RECIPIENT` | variable | age 공개 키(`age1…`). 공개해도 되는 값이다 |
| `BACKUP_BUCKET` | variable(선택) | 기본 `solveline-backup` |

운영자가 처음 한 번 한다(값을 저장소·이슈에 남기지 않는다):

```bash
age-keygen -o solveline-backup.key        # 비공개 키: 오프라인에 보관하고 저장소·GitHub에 올리지 않는다
age-keygen -y solveline-backup.key | gh variable set BACKUP_AGE_RECIPIENT --repo DWL21/solveline --env production
npx wrangler r2 bucket create solveline-backup
npx wrangler r2 bucket lifecycle add solveline-backup expire-7d d1/ --expire-days 7   # d1/ 아래를 7일 뒤 지운다
```

복원(예: 2026-11-02 백업):

```bash
npx wrangler r2 object get solveline-backup/d1/solveline-2026-11-02.sql.age --file d1.sql.age --remote
age -d -i solveline-backup.key -o d1.sql d1.sql.age
# 새 D1에 넣는다(기존 D1이면 Time Travel이 먼저다). SQLite로 확인만 할 때는: sqlite3 check.db < d1.sql
npx wrangler d1 execute <새 D1> --remote --file d1.sql
```

## 단계(PR)

1. **저장소 비동기화**: 모든 저장소가 `Sql` 인터페이스(`all`·`get`·`run`·`batch`)를 쓴다. better-sqlite3 어댑터(테스트·로컬 개발)와 D1 어댑터를 둔다. 동작은 바뀌지 않는다.
2. **judge 분리**: `apps/judge`(대기열·디스패처·runner·테스트셋)와 API의 judge 클라이언트, 결과 수신 경로를 만든다. pahidc에서 api와 judge를 따로 띄운다.
3. **Worker 실행**: API를 Pages `_worker.js`로 묶는다(esbuild). D1·R2 바인딩, WebCrypto, D1 기반 요청 제한을 쓴다. 로컬·CI는 wrangler(Miniflare)로 돌린다.
   - 묶기: `pnpm build`가 web 빌드 뒤 `apps/api/scripts/build-worker.mjs`로 `apps/web/public/_worker.js`(카탈로그 캐시)와 `apps/api/src/worker.ts`(API)를 `apps/web/dist/_worker.js` 하나로 묶는다. Node 내장 모듈을 넣으면 빌드가 실패한다.
   - 켜기: `API_MODE = "worker"`이고 D1 바인딩 `DB`가 있을 때만 Worker 안의 API가 답한다. 아니면 지금처럼 Tunnel로 넘긴다. 운영 배포(`deploy.yml`)는 5단계에서 이 번들을 올리도록 바꾼다.
   - Node 전용 코드: better-sqlite3·마이그레이션(`db-node.ts`), 파일 백업(`backup.ts`), 진입점(`main.ts`)만 남는다. 나머지는 WebCrypto(`crypto.ts`)를 쓴다.
   - 요청 제한: Worker는 격리 공간이 여러 개라 메모리로 셀 수 없으므로 D1 `rate_limits`에 한 문장(UPSERT … RETURNING)으로 센다.
   - D1 스키마: `apps/api/migrations/0001_schema.sql`(마이그레이션 결과, `pnpm --filter @solveline/api d1:schema`로 만든다). 테스트가 마이그레이션과 같은지 확인한다.
   - 검증: 가짜 D1(better-sqlite3 위에 D1 모양)과 가짜 R2 바인딩으로 Node에서 돌린다. Miniflare(wrangler dev)로 돌리는 검사는 아직 없다.
   - 남은 일: 편집할 때 카탈로그 전체(1,046개)를 다시 해시하지 않고 바뀐 문제만 고쳐 쓰기(CPU 10ms), Worker에서의 매일 정리(오래된 제출·세션·`rate_limits`)는 4단계 일정 실행에서 SQL로 한다.
4. **백업 워크플로**: 위 2번.
5. **전환(승인 필요)**:
   - D1을 만들고 스키마를 적용한다.
   - 점검 시간 동안 api를 읽기 전용으로 둔 채 SQLite를 D1로 옮긴다.
   - Pages 바인딩을 켜고, judge Tunnel을 연결하고, 예전 api 컨테이너를 내린다.

## 5단계 전환(2026-10-28, 운영자 승인)

배포 한 번(`deploy.yml`)으로 다음 순서로 진행한다.

1. **서버**: judge 결과를 Worker(`https://solveline.simplyimg.com`)로 보낸다. 게이트웨이는 `/judge/`를 judge로 넘긴다(Tunnel `solveline-api` 호스트, 요청마다 서명 확인). 예전 api는 compose `legacy` 프로필로 내린다.
2. **Pages 비밀**: GitHub `production` 값을 그대로 넣는다. `SESSION_SECRET`이 같아서 로그인이 유지된다.
3. **D1**: `wrangler d1 migrations apply`(매번, 이미 적용했으면 그대로)를 실행한다.
4. **한 번만 하는 이전**(`/var/lib/solveline/.d1-migrated`가 없을 때):
   - 예전 api를 멈춰 쓰기를 막는다.
   - `scripts/d1-export.ts`로 SQLite를 SQL로 내보낸다. `INSERT OR REPLACE`를 쓰고, 외래 키 검사는 미루며, 100KB가 넘는 행은 조각으로 나눈다.
   - `wrangler d1 execute --file`로 넣는다.
   - 표마다 행 수를 맞춰 본다.
   - 어느 단계든 실패하면 예전 api를 다시 띄우고 배포를 멈춘다(Pages는 바뀌지 않는다).
5. **Pages**: API를 함께 묶은 `_worker.js`를 올린다. `wrangler.toml`의 `API_MODE = "worker"`와 D1 바인딩이 켜진다.
6. **확인**: Worker `/api/health`, judge `/judge/health`, Worker → judge → runner의 `/api/runtime`을 본다.

점검 시간은 4~5단계 사이의 1~2분이다. 이 동안 API가 응답하지 않는다.

## 롤백(기간 하루, 끝남)

전환 뒤 하루 동안은 예전 api를 compose `legacy` 프로필로 다시 띄워 되돌릴 수 있었다.

롤백 기간이 지나서 예전 api를 없앴다(#150).
- compose의 `api` 서비스, `api.env` 기록, 한 번만 하는 이전 단계를 지웠다.
- 배포의 "Remove legacy user data" 단계가 `.d1-migrated`가 24시간 지난 뒤 처음 배포할 때 pahidc에서 다음을 지우고 `.legacy-removed`를 남긴다.
  - 예전 SQLite(`solveline.db`)와 `backups/` 아래 DB 스냅숏
  - `/etc/solveline/api.env`(로그인 비밀)
  - `solveline-production-api` 이미지
- 테스트셋 파일(`testsets/`, `backups/**/testsets`)·커리큘럼 JSON·judge 대기열(`judge/`)은 남긴다.

이제 사용자 데이터의 원본과 복구 수단은 D1뿐이다.
- D1 Time Travel로 시점 복구를 한다.
- 매일 암호화 백업(4단계)을 R2 `solveline-backup`에 올린다. `CLOUDFLARE_BACKUP_TOKEN`을 넣어야 시작된다.

Worker 쪽 문제는 Pages 배포를 이전 배포로 되돌려 해결한다.
