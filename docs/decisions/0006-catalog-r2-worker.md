# 0006. 공용 문제 데이터는 R2와 Worker에서 읽고, 사용자 데이터는 pahidc에 둔다

- 상태: 코드 반영 완료. R2 데이터 이전과 Worker의 R2 읽기는 2026-10-28 운영자 승인으로 진행(아래 「켜는 순서」)
- 날짜: 2026-10-28

## 배경

조회가 압도적으로 많은 공용 문제 데이터까지 pahidc 한 대가 모두 처리했다. Pages의 `_worker.js`는 `/api/*`를 Tunnel로 넘기기만 하고 `no-store`를 붙여서 아무것도 캐시하지 않았다. 비회원이 문제 하나를 열 때도 세션·목록·폴더·컬렉션·상세 요청이 모두 pahidc까지 갔다.

2026-10-28 운영 데이터 측정:

| 항목 | 크기 |
|---|---|
| 문제 1,046개 상세(공용 부분) | 2.58MB, 문제당 평균 2.5KB(gzip 1.2KB) |
| 카탈로그 목록 한 장 | 238KB(gzip 21KB), 문제당 227B |
| 히든 테스트셋 51개(374케이스) | 60.6MB, gzip 17.8MB. 중앙값 315KB, 최대 6.7MB |
| SQLite 전체(사용자 데이터 포함) | 7.7MB |
| 같은 디스크의 백업 | 425MB(테스트셋 사본 128MB) |

R2로 옮길 양은 gzip 기준 약 21MB로, 무료 10GB의 0.2%다.

## 결정

### 역할 분담

| 처리 | 위치 | 이유 |
|---|---|---|
| 카탈로그 읽기(문제 목록·상세·기본 폴더·컬렉션) | **Worker + 엣지 캐시 + R2** | 모두에게 같은 데이터, 읽기 위주 |
| 비회원의 세션 확인, 쿠키 없는 `/api/me/*` | **Worker가 바로 답함** | 서버에 물을 필요가 없다 |
| 공개 설정·실행 환경 | Worker 엣지 캐시 30초 | 사용자와 무관 |
| 문제·컬렉션·히든 케이스 **쓰기** | pahidc API → R2에 게시 | 편집 권한 확인은 세션 DB가 필요하고, 쓰기는 드물다 |
| 로그인·세션·사용자 데이터·제출 큐·채점 | pahidc(그대로) | 상태와 계산이 필요 |
| 사용자 코드 실행 | pahidc runner(그대로) | 샌드박스 |

SQLite는 공용 문제의 **쓰기 원본**으로 남는다. 사용자 데이터가 문제 id를 외래 키로 참조하기 때문이다(`user_problems`, `folder_items`, `bookmarks`, `collection_items`, `submissions`). R2는 원본에서 게시한 **읽기 사본**이고, 히든 테스트셋은 R2가 **내구성 있는 원본**이 된다. 로컬 디스크가 사라지면 시작할 때 R2에서 되살린다.

### 데이터 흐름

```
읽기  브라우저 ─▶ Pages Worker ─▶ 엣지 캐시 ─(miss)─▶ R2  (R2를 켜기 전에는 pahidc /api/catalog/*)
     브라우저 ─▶ Pages Worker ─▶ Tunnel ─▶ pahidc /api/me/*  (로그인한 경우만)
     웹이 둘을 합친다(shared의 mergeProblem·mergeSummaries. 서버의 예전 /api/problems도 같은 함수)

쓰기  편집 권한자 ─▶ pahidc API ─▶ SQLite 저장 ─▶ 바뀐 상세 + 목록을 R2에 PUT ─▶ 응답
     웹은 쓰기 직후 2분 동안 목록을 ?fresh로 받는다(엣지·브라우저 캐시를 건너뜀)
```

### R2 키

| 키 | 내용 | 바뀌나 |
|---|---|---|
| `catalog/v1/index.json` | `{ data: CatalogIndex }`. 문제마다 `version`(상세 내용 SHA-256 앞 16자) | 편집하면 바뀐다 |
| `catalog/v1/problems/{id}/{version}.json` | `{ data: CatalogProblem }` | 안 바뀐다(내용이 같으면 키도 같다) |
| `testsets/{sha256}.json.gz` | 히든 테스트셋 gzip | 안 바뀐다 |

응답 봉투 그대로 저장하므로 Worker는 R2 본문을 다시 직렬화하지 않고 돌려준다. 상세를 먼저 올리고 목록을 나중에 바꿔서, 목록이 가리키는 상세는 항상 있다. 테스트셋은 공개 경로가 없고 pahidc만 S3 API 키로 읽는다.

## 캐시 설계

| 대상 | 엣지(Cache API) | 브라우저 | 무효화 |
|---|---|---|---|
| `/api/catalog/index` | 60초 | 60초 + stale-while-revalidate 600초, ETag(304) | 편집자는 `?fresh`로 우회. 다른 사용자는 최대 약 1~2분 뒤 반영 |
| `/api/catalog/problems/{id}?v=` | 1년(`immutable`) | 1년(`immutable`) | 필요 없음: 내용이 바뀌면 version이 바뀌어 다른 URL이 된다. Worker가 본문 해시를 검사해 맞을 때만 1년 캐시 |
| `/api/catalog/problems/{id}`(v 없음) | 30초 | 30초 | — |
| `/api/public/config`, `/api/runtime` | 30초 | 매번 재검증 | — |
| 비회원 `/api/auth/session` | Worker가 즉답 | no-store | — |
| 그 밖의 `/api/*` | 없음 | no-store | 사용자 데이터는 캐시하지 않는다 |
| 정적 파일(`/assets/*`) | Pages | 해시 파일명 | Worker를 거치지 않는다(`_routes.json`) |

- 웹은 목록 요청을 30초 동안 메모리에서 한 번만 보낸다. 목록·폴더·컬렉션 쿼리가 같은 응답을 쓴다.
- 버전이 붙은 상세의 키가 R2에 없으면(그 사이 목록이 바뀜) Worker가 `404 stale_version`을 주고, 웹이 목록을 새로 받아 다시 읽는다.

## 무료 한도

| 한도(Free) | 값 | 이 설계에서 쓰는 양 |
|---|---|---|
| Workers 요청 | **하루 10만** | 가장 먼저 닿는 한도. `/api/*` 요청 하나가 1회(Pages Functions도 같은 한도) |
| Workers CPU | 요청당 10ms | 목록 파싱(238KB) 약 2ms, 해시 검사 1ms 미만 |
| R2 저장 | 월 10GB | 지금 약 21MB. BOJ 3.3만 문제로 늘어도 상세 약 80MB, 테스트셋은 데이터 크기에 따라 다름(평균 1.2MB면 gzip 약 12GB, 초과분은 GB·월 $0.015) |
| R2 Class A(쓰기·목록) | 월 100만 | 처음 이전 약 1,100회, 이후 편집 1회당 2회 |
| R2 Class B(읽기) | 월 1,000만 | 엣지 캐시가 맞으면 0. 지역마다 목록은 분당 1회, 상세는 버전당 1회 |
| R2·Cache API 전송량 | 무료 | — |

방문당 Worker 호출(비회원, 문제 10개 열람): 세션 1 + 목록 1 + 상세 10 = 12회이고, pahidc 요청은 **0**이다. 같은 문제를 다시 열면 브라우저 캐시가 답해 Worker 호출도 0이다.
전에는 같은 방문에 pahidc 요청이 약 16회(세션·목록·폴더·컬렉션·설정·실행 환경·상세 10)였다.
하루 10만 회 기준으로 비회원 문제 열람만 하면 하루 활성 약 8,000명이다. 로그인한 사용자의 자동 저장·채점 요청도 같은 한도를 쓰므로, 실제 여유는 아래 「사용자 데이터 관리」의 2번이 결정한다.

## 사용자 데이터 관리(pahidc 유지)

지금 상태와 무료 한도 안에서 운영하는 방안이다. 1번은 이번에 반영했고, 2~5번은 설계만 했다.

1. **공용 데이터와 분리(반영)** — 목록·상세에서 사용자 부분만 `/api/me/*`로 받는다. 상태가 있는 문제만 오므로 1,046개 목록 대신 몇십 줄이다. 비회원은 이 요청 자체가 없다.
2. **로그인 요청의 Worker 한도 분리(다음 단계)** — 로그인한 사용자의 요청(자동 저장, 타이머, 제출 폴링)이 Pages Worker를 거치면 하루 10만 회를 함께 쓴다. 이 요청들을 `solveline-api.simplyimg.com`(Tunnel, 호출 수 제한 없음)으로 직접 보내면 Worker 한도는 카탈로그만 쓴다. 필요한 변경은 다음과 같다.
   - 세션 쿠키를 `Domain=simplyimg.com`으로 바꾸거나, API를 같은 출처의 하위 경로처럼 쓰게 한다.
   - API CORS에 웹 출처와 `credentials`를 허용한다(이미 `WEB_ORIGIN`은 허용).
   - CSP `connect-src`에 API 도메인을 추가한다.
   - Google 콜백 주소는 그대로 웹 도메인에 둔다.
   - 쿠키 범위가 넓어지므로 `simplyimg.com`의 다른 하위 도메인이 신뢰할 수 있는지 먼저 확인한다.
3. **쓰기 횟수 줄이기** — 자동 저장은 이미 변경분(PATCH)만 묶어 보낸다(`draft-queue`). 제출 결과 폴링은 지수 간격으로 늘리고, 타이머는 화면을 떠날 때와 1분 간격으로만 저장해 요청 수를 줄인다.
4. **백업을 R2로(외부 보관)** — 지금 백업은 같은 디스크라 디스크 고장을 막지 못한다. 매일 SQLite 스냅숏을 **암호화**(age 등, 키는 GitHub secret과 별도 보관)해 별도 비공개 버킷 `solveline-backup`에 올리고, 수명 주기 규칙으로 7일 뒤 지운다. 쓰기는 월 30회, 저장은 약 8MB×7이다. 테스트셋은 이미 R2에 있으므로 로컬 `backups/testsets`(128MB)는 그만 만든다.
5. **보관 기한과 삭제** — 제출 기록은 지금처럼 30일 뒤 지운다. 회원을 삭제하면 DB에서는 바로 지워지지만 백업에는 최대 7일 남는다. 개인정보처리방침에 이를 적는다. 사용자 데이터는 R2 공개 경로나 Worker 캐시에 절대 두지 않는다.

DB가 커지거나 api를 여러 대 띄워야 할 때의 Postgres·Redis 이전은 기존 로드맵을 따른다.

## 켜는 순서(2026-10-28 운영자 승인으로 진행)

코드는 R2 설정이 없으면 예전과 같이 동작한다. Worker는 R2 대신 pahidc `/api/catalog/*`에서 읽어 캐시하고, API는 아무것도 올리지 않는다.

**R2 API 키를 서버에 두지 않는다.** R2 바인딩은 Pages Worker만 갖는다. pahidc는 Worker의 내부 경로 `/api/internal/r2`로 쓴다.
- 공유 비밀 `R2_PROXY_SECRET`을 확인한다(GitHub secret과 Pages 비밀에 같은 값).
- `catalog/`·`testsets/` 아래만 다룬다.
- 본문은 해석하지 않고 흘려보내므로 Worker CPU를 거의 쓰지 않는다.

1. 비공개 R2 버킷 `solveline-catalog`를 만든다. `apps/web/wrangler.toml`에 바인딩 `CATALOG`가 있다(이 파일이 대시보드의 바인딩·변수 설정을 대신한다).
2. 32자 이상의 임의 값을 만들어 GitHub Environment `production` secret `R2_PROXY_SECRET`과 Pages 비밀 `R2_PROXY_SECRET`에 넣는다.
3. **데이터 이전**(배포):
   - api가 시작하면서 문제 전체와 테스트셋을 Worker를 거쳐 올린다.
   - 배포 중에는 Worker가 API보다 늦게 올라오므로 성공할 때까지 1분마다 다시 시도한다.
   - 로그에 `[catalog] R2 게시: 문제 N개, 테스트셋 M개`가 나오는지 본다.
   - 그 뒤의 편집(히든 테스트셋 보강 포함)은 저장할 때마다 자동으로 게시된다.
4. **Worker의 R2 읽기**: `wrangler.toml`에 `[vars] CATALOG_SOURCE = "r2"`를 넣고 배포한다.
5. 확인:
   - `curl -s -D - -o /dev/null https://solveline.simplyimg.com/api/catalog/index`의 `ETag`가 R2 형식(따옴표 안 32자 hex)인지 본다. `curl -I`(HEAD)는 Worker의 GET 분기를 거치지 않고 API로 가므로 확인에 쓰지 않는다.
   - 문제를 편집한 뒤 다른 브라우저에서 2분 안에 반영되는지 본다.
   - pahidc 로그에서 `/api/catalog/*` 요청이 줄었는지 본다.

## 롤백

- Worker: `wrangler.toml`의 `CATALOG_SOURCE`를 지우고 배포하면 다시 pahidc에서 읽는다(캐시는 그대로).
- API: `R2_PROXY_SECRET`을 지우고 배포하면 게시를 멈춘다. SQLite와 로컬 테스트셋은 지우지 않았으므로 데이터 손실이 없다.
- 웹: 예전 `/api/problems` 경로가 그대로 있다. 이전 Pages 배포로 되돌려도 동작한다.

## 한계와 다음 일

- **목록 크기**: 문제당 227B라 BOJ 3.3만 문제면 목록이 약 7.5MB가 된다. 그때는 목록을 폴더·번호 범위로 나누고(`catalog/v1/index/{shard}.json`) 검색은 별도 색인으로 옮긴다.
- **엣지 캐시는 지역별**이다. 첫 요청은 지역마다 한 번 R2를 읽는다. 많아지면 Cache Reserve나 R2 사용자 지정 도메인(Worker 호출 없이 Cache Everything)을 검토한다.
- **삭제한 문제의 옛 상세**는 R2에 남는다(작다). 쌓이면 목록에 없는 키를 지우는 정리 작업을 추가한다.
