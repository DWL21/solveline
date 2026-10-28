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

## 단계(PR)

1. **저장소 비동기화**: 모든 저장소가 `Sql` 인터페이스(`all`·`get`·`run`·`batch`)를 쓴다. better-sqlite3 어댑터(테스트·로컬 개발)와 D1 어댑터를 둔다. 동작은 바뀌지 않는다.
2. **judge 분리**: `apps/judge`(대기열·디스패처·runner·테스트셋)와 API의 judge 클라이언트, 결과 수신 경로를 만든다. pahidc에서 api와 judge를 따로 띄운다.
3. **Worker 실행**: API를 Pages `_worker.js`로 묶는다(esbuild). D1·R2 바인딩, WebCrypto, D1 기반 요청 제한을 쓴다. 로컬·CI는 wrangler(Miniflare)로 돌린다.
4. **백업 워크플로**: 위 2번.
5. **전환(승인 필요)**:
   - D1을 만들고 스키마를 적용한다.
   - 점검 시간 동안 api를 읽기 전용으로 둔 채 SQLite를 D1로 옮긴다.
   - Pages 바인딩을 켜고, judge Tunnel을 연결하고, 예전 api 컨테이너를 내린다.

## 롤백

- 5단계 전까지는 운영이 바뀌지 않는다.
- 전환 뒤 문제가 생기면 Pages를 이전 배포로 되돌리고 pahidc api를 다시 켠다. 그 사이 D1에 쌓인 변경은 D1 내보내기로 SQLite에 되돌린다(전환 직후 하루는 api 컨테이너와 DB 파일을 지우지 않는다).
