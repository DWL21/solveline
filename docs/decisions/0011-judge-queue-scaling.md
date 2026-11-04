# 0011. 채점 제출 인프라: 대기열 분리 · 오토스케일링 · 초당 제출 수별 전략

- 날짜: 2026-11-04
- 상태: 제안. Tier 0 측정 완료(2026-11-04, 5장) — 지금은 Tier 0으로 충분. 0003·0007의 "보류: 큐 → 외부 큐, 채점 호스트 분리"를 구체화한다.

## 1. 지금 구조와 한계

```
브라우저 ─▶ Worker(D1: submissions) ─서명 POST /jobs─▶ judge 1대(SQLite judge.db + 디스패처) ─▶ runner 1대(RUN_SLOTS=2)
                                      ◀─ 결과 콜백(outbox, 재시도) ─┘
```

| 항목 | 지금 | 한계 |
|---|---|---|
| 대기열 | judge 프로세스 안 SQLite(`jobs` 표, `priority, created_at` 순) | 디스패처가 프로세스 안에 있어 judge는 1대뿐. 다른 호스트의 실행기가 꺼내 갈 수 없다 |
| 실행 용량 | runner 1개 × 슬롯 2 = 동시 2건 | 처리량 = 2 / 평균 실행 시간. 확장은 `RUNNER_URLS`를 손으로 고쳐 재배포 |
| 받아들이기 제어 | 사용자별 분당 30회(`runLimit`) | 전체 대기열 상한·사용자별 동시 실행 상한이 없다. 30명이 한꺼번에 30회씩 넣으면 900건이 줄을 서고, 뒷사람은 몇 분을 기다린다 |
| 공정성 | 우선순위(run 0 > submit 1) + 먼저 온 순 | 한 사람이 대기열을 채우면 다른 사람이 모두 뒤로 밀린다. run이 계속 들어오면 submit이 굶는다 |
| 장애 | 재시작 시 running → queued, 결과는 outbox로 재전송 | 단일 호스트(pahidc)가 죽으면 채점 전체가 멈춘다 |

좋은 점은 그대로 둔다: **id 기반 멱등 처리**(judge `INSERT OR IGNORE`, Worker 결과 반영 1회), **결과 outbox**, **상태 없는 runner + 테스트셋 해시 캐시(R2 원본)**. 이 셋이 있으면 큐를 바깥으로 빼도 "최소 한 번 전달(at-least-once)"을 안전하게 받을 수 있다.

## 2. 설계 원칙

1. **세 층을 나눈다.** 받기(Worker: 검사·기록·받아들이기 제어) / 대기열(브로커) / 실행(judge-agent + runner 쌍). 각 층을 따로 늘린다.
2. **실행기는 끌어간다(pull).** 디스패처가 runner 주소를 아는 push 방식 대신, 실행 호스트의 agent가 브로커에서 빈 슬롯만큼 꺼낸다.
   - 호스트를 더하면 agent를 띄우기만 하면 된다(주소 등록·재배포 없음).
   - agent는 밖으로만 연결하므로 실행 호스트에 들어오는 포트가 없다. runner는 지금처럼 `internal` 네트워크에서 agent하고만 통신한다(샌드박스 규칙 유지).
3. **대기열은 몰림을 흡수하고, 오토스케일링은 지속 부하를 감당하고, 받아들이기 제어는 과부하를 막는다.** 대기열은 길어질 수 있지만 기다리는 시간 = 밀린 양 / 처리량이다. 셋 중 하나만으로는 안 된다.
4. **최소 한 번 전달 + 멱등.** 실행 중 호스트가 죽으면 같은 작업이 다른 호스트에서 다시 돈다. 결과 반영은 지금처럼 id로 한 번만 한다.
5. **호출 데이터는 작게(claim check).** 메시지에는 제출 id·언어·제한·테스트셋 해시만 넣고, 큰 코드나 케이스는 저장소(D1/R2)에서 읽는다.

## 3. 목표 구조

```
                     ┌──────────── 받아들이기 제어 ────────────┐
브라우저 ─POST─▶ Worker: 사용자 토큰 버킷 · 사용자별 동시 실행 상한 · 전체 대기열 상한
                     │  D1 submissions(queued)
                     ▼
              브로커: queue.run (우선)   queue.submit   (+ DLQ)
                     ▲ pull (빈 슬롯만큼, 리스/가시성 제한 시간)
     ┌───────────────┼────────────────┐
  호스트 A         호스트 B   …      호스트 N      ← 오토스케일러가 밀린 양으로 N을 정한다
  agent+runner    agent+runner      agent+runner
     │ 결과(서명, outbox 재시도)
     ▼
  Worker /api/internal/judge/results → D1(멱등) → 기다리는 요청 깨우기
```

### agent(지금 judge의 디스패처를 떼어 낸 것)

- 슬롯 수(= vCPU 수, Java가 CPU 2를 쓰므로 runner 1개당 슬롯 2와 같은 비율)만큼 동시에 꺼낸다. run 큐를 먼저 보고, 비었을 때 submit 큐를 본다.
- 작업 시간이 길면(최대 600초) 리스를 연장한다(heartbeat). 가시성 제한 시간은 `최대 실행 시간 + 여유`(예: 15분)로 잡는다.
- 끝나면 결과를 Worker로 보내고(지금 outbox 그대로), 성공하면 메시지를 ack한다. 보내기 전에 죽으면 메시지가 다시 보이고 다른 agent가 다시 실행한다 → Worker가 멱등으로 처리.
- 같은 메시지가 N번(예: 3번) 실패하면 DLQ로 보내고 제출을 `error`로 기록한다(runner를 죽이는 코드가 계속 돌며 호스트를 갉아먹는 것을 막는다).
- 스케일 인: SIGTERM을 받으면 더 꺼내지 않고 실행 중인 작업만 끝낸 뒤 나간다(drain).
- 중지(cancel): 대기 중이면 Worker가 D1 상태를 `cancelled`로 바꾸고 agent는 꺼낸 뒤 상태를 확인해 버린다. 실행 중이면 취소 표시(D1 또는 브로커의 KV)를 agent가 주기적으로 확인해 runner `/cancel`을 부른다.

### 상태 조회(긴 조회)

지금은 Worker가 judge의 `GET /jobs/:id?wait=`에 긴 조회를 맡긴다. 실행기가 여러 대가 되면 "누가 이 작업을 갖고 있는지"를 Worker가 모르므로 다음 중 하나로 바꾼다.

- **권장: Durable Object(제출당 1개 또는 사용자당 1개).** 결과 콜백이 DO를 깨우고, 기다리던 요청이 바로 응답한다. Worker CPU 10ms 제한과 무관하게 오래 기다릴 수 있다(대기 중 CPU를 쓰지 않음).
- 단순안: 브라우저가 1~2초 간격으로 D1을 조회. D1 읽기 한도를 쓰므로 Tier 1 이하에서만.
- 대기 순번(`ahead`)은 큐 길이 근사값(브로커 지표) + 사용자 순번으로 보여 준다. 정확한 순번은 분산 큐에서 비싸므로 "약 n명 대기"로 바꾼다.

## 4. 브로커 비교

| 후보 | 우선순위 | 오토스케일 지표 | 운영 부담 | 이 프로젝트에 맞는 점 / 걸리는 점 |
|---|---|---|---|---|
| **지금 SQLite(judge 안)** | 있음(정렬) | 직접 노출해야 함 | 없음 | 호스트 1대에서는 가장 단순. 여러 호스트는 불가 |
| **Cloudflare Queues (HTTP pull consumer)** | 없음 → 큐 2개(run/submit) | 백로그(분석 API) | 관리할 서버 없음 | 이미 Worker·D1·R2를 쓴다. agent는 HTTPS로만 꺼내므로 어느 호스트든 붙는다. 큐당 5,000 msg/s, 가시성 제한 최대 12시간, 메시지 128KB(→ claim check), Free 플랜 보관 24시간 |
| **Redis Streams + consumer group** | 없음 → 스트림 2개 | KEDA lag(Redis 7+, 0까지 축소 가능) | Redis 1대(+복제) | 빠르고 익숙함. `XAUTOCLAIM`으로 멈춘 작업 회수. 외부 호스트가 붙으려면 Redis를 Tunnel/WireGuard로 열어야 한다 |
| **NATS JetStream (WorkQueue 스트림, pull consumer)** | 없음 → subject 2개 | KEDA lag(커뮤니티 스케일러) | NATS 클러스터 | `max_ack_pending`으로 흐름 제어, ack 대기 시간·재전송 내장. 대규모(Tier 2~3)에 유리 |
| **PostgreSQL `SKIP LOCKED` (pgmq, River 등)** | 있음(정렬) | SQL로 큐 길이 | Postgres 1대 | 지금 SQLite 모델 그대로 여러 소비자로 확장. D1을 쓰므로 Postgres를 새로 들여야 하는 게 부담 |
| **RabbitMQ** | 기본 지원(`x-max-priority`) | KEDA 큐 길이 | 브로커 운영 | 우선순위가 자연스럽다. 운영 부담이 가장 크다 |
| Kafka | — | — | 큼 | 파티션 단위 순서 처리라 길이가 들쭉날쭉한 작업에서 앞 작업이 뒤를 막는다. 작업 큐로 맞지 않아 제외 |

**권장**: Tier 1까지는 **Cloudflare Queues pull**(관리할 서버 없음, 지금 스택과 같은 곳, 실행 호스트 위치 자유). 자체 운영·K8s로 가는 Tier 2부터는 **Redis Streams 또는 NATS JetStream + KEDA**. 어느 쪽이든 agent 안에서 브로커를 `Queue` 인터페이스(`pull(n) / extend(id) / ack(id) / nack(id)`) 뒤에 숨겨 교체할 수 있게 한다. 지금 SQLite 큐도 같은 인터페이스의 구현 하나로 남겨 로컬 개발·테스트에 쓴다.

## 5. 용량 계산

Little의 법칙으로 필요한 슬롯을 정한다.

```
필요 슬롯 = λ(초당 작업 수) × S(평균 실행 시간, 초) ÷ ρ(목표 사용률, 0.7)
```

평균 실행 시간은 **가정값**이다(아래 표). 착수 전에 judge.db의 `started_at`·`finished_at`으로 언어·종류별 p50/p95를 재서 바꾼다.

```sql
-- pahidc /var/lib/solveline/judge/judge.db (하루 보관분)
SELECT kind, language, COUNT(*),
       AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_s
FROM jobs WHERE status = 'done' GROUP BY kind, language;
```

가정: run 70%(S≈1.5초: 컴파일 + 보이는 케이스 몇 개), submit 30%(S≈8초: 히든 케이스 수십 개) → 가중 평균 S̄ ≈ 3.5초. 슬롯 1개 ≈ vCPU 1개, 메모리 ≈ 0.75GB.

| 초당 작업(λ) | 필요 슬롯 | vCPU / 메모리 | 지금 대비 |
|---|---|---|---|
| 0.4 | 2 | 2 / 1.5GB | 지금 용량 |
| 1 | 5 | 5 / 4GB | runner 3개(호스트 1대) |
| 5 | 25 | 25 / 19GB | 호스트 3~4대 |
| 10 | 50 | 50 / 38GB | 호스트 6~7대(8 vCPU 기준) |
| 50 | 250 | 250 / 190GB | 클러스터 |
| 100 | 500 | 500 / 375GB | 클러스터 + 다중 리전 |

### 측정 (2026-11-04, Tier 0)

pahidc judge.db(하루 보관분, 2026-11-03 08:02 ~ 11-04 03:41)를 읽기 전용으로 쟀다. 끝난 작업만 센다.

| 종류 | 언어 | 건수 | 평균 케이스 | 실행 시간 평균 / 최대 | 대기 시간 최대 |
|---|---|---|---|---|---|
| run | python | 3 | 2 | 0.07초 / 0.15초 | 0초 |
| submit | python | 31 | 8.5 | 0.33초 / 0.67초 | 0.01초 |
| submit | java | 2 | 8 | 0.93초 / 1.03초 | 0초 |

- submit p50 0.30초·p95 0.83초, run p50 0.04초·p95 0.15초. 가중 평균 **S̄ ≈ 0.35초**로 가정값(3.5초)의 1/10이다.
- 부하: 하루 약 33건, 가장 바쁜 1분에 6건(0.1건/초). 대기가 생긴 적이 없다.
- 호스트: vCPU 4, 메모리 3GB. runner 컨테이너 메모리 1.5GB·`RUN_SLOTS=2`라 **메모리가 먼저 한계**다(슬롯을 늘리기 전에 메모리를 본다).
- 한계: 표본이 작고(36건), 하루만 남아 있으며, 히든 케이스가 적은 문제(평균 8.5개)뿐이다. 히든 200개짜리 Java 제출은 케이스당 JVM 기동 비용(약 67ms)만으로 10초를 넘을 수 있다. 0.35초는 지금 문제 구성의 값이다.

측정값으로 다시 계산하면 지금 2슬롯의 처리량은 2 ÷ 0.35 × 0.7 ≈ **4건/초**로, 가장 바쁜 1분의 약 40배다. 위 용량 표의 단계 경계는 S̄ 3.5초 기준이라 지금 문제 구성에서는 약 10배 보수적이다. 따라서:

- Tier 1(실행 호스트 분리·외부 브로커)과 0012의 4~7단계(예열 컴파일·케이스 단위 동시 실행·워밍 실행기·agent 재작성)는 **지금 필요 없다**.
- Tier 0 할 일 중 1(지표)을 먼저 한다. judge.db가 하루만 남아 측정을 이어 갈 수 없기 때문이다. 2(받아들이기 제어)·3(aging)은 몰림 대비로 작게 한다. 5(`Queue` 인터페이스)는 Tier 1이 필요해질 때 한다.
- 다시 잴 때: 시험·대회 같은 예정된 몰림 전, 또는 히든 케이스가 많은 문제가 늘었을 때.

몰림(burst)은 대기열이 흡수한다. 예: 지속 처리량 1건/초인 상태에서 시험 시작 직후 300건이 한꺼번에 들어오면, 마지막 사람은 약 300 ÷ (5슬롯 ÷ 3.5초) ≈ 3.5분을 기다린다. 이 시간이 받아들일 수 있는지가 오토스케일링 목표값을 정한다.

### 오토스케일링 목표값(백로그/실행기)

AWS의 SQS 기반 확장 방식과 같다: 큐 길이를 실행기 수로 나눈 값을 목표로 추적한다.

```
목표 백로그/agent = 허용 대기 시간 ÷ S̄ × 슬롯
원하는 agent 수   = ceil((백로그 + 실행 중) ÷ 목표 백로그/agent), [최소, 최대]로 자른다
```

예: 허용 대기 10초, S̄ 3.5초, 슬롯 8 → agent당 백로그 약 23건. 백로그 230건이면 10대.

- 실행 시간이 바뀌면(긴 히든 케이스 문제가 몰릴 때) 목표값도 바뀐다 → S̄를 최근 5분 이동 평균으로 계산한다.
- **늘릴 때는 빠르게, 줄일 때는 천천히**: 확장은 1분 안에, 축소는 10분 동안 낮게 유지될 때만(진동 방지). 축소 대상은 drain 후 종료.
- 새 호스트가 뜨는 시간(VM 부팅 + 이미지 받기 30~90초)이 몰림보다 느리므로, **예정된 몰림(시험·대회·매일 문제 메일 발송 시각)은 미리 늘린다(scheduled scaling)**. 대부분의 몰림은 예측할 수 있다.
- 최소 1대(pahidc)는 항상 둔다. 0까지 줄이면 첫 제출이 부팅 시간만큼 기다린다.

## 6. 받아들이기 제어(과부하 방지)

대기열이 무한하다고 기다리는 시간도 무한하면 안 된다. Worker에서 다음 순서로 거른다.

1. **사용자 토큰 버킷**(지금 분당 30회 유지): 연타 방지.
2. **사용자별 동시 실행 상한**: 사용자당 대기+실행 중 run 2건, submit 1건. 넘으면 이전 run을 자동 중지하고 새 것을 넣는다(코드를 고쳐 다시 실행하는 흐름에 맞음). D1에서 `status IN ('queued','running')`를 사용자 색인으로 센다.
3. **전체 대기열 상한**: 예상 대기 시간 = 백로그 ÷ 처리량이 상한(예: run 60초, submit 5분)을 넘으면 `503` + `Retry-After`와 "지금 채점 요청이 많아요(약 n분 대기)" 문구. run을 먼저 거절하고 submit은 더 오래 받는다(제출은 사용자가 결과를 기다릴 이유가 크다).
4. **같은 내용 중복 제거**: `(user, problem, kind, sha256(code))`가 대기 중이면 새로 넣지 않고 기존 id를 돌려준다.

공정성:

- **사용자별 순서 섞기(fair queueing)**: 한 큐에서 먼저 온 순으로만 꺼내면 한 사람이 큐를 채운다. 2번(동시 실행 상한)이 이를 대부분 막는다. Tier 2 이상에서는 사용자 해시로 큐를 여러 개로 나누고 agent가 돌아가며 꺼낸다.
- **굶주림 방지(aging)**: run이 끝없이 들어와도 submit이 가장 오래 기다린 지 30초를 넘으면 agent가 submit을 먼저 꺼낸다. 또는 슬롯의 일부(예: 25%)를 submit 전용으로 둔다.

## 7. 초당 제출 수별 전략

| 단계 | 초당 작업 | 대기열 | 실행 | 확장 방법 | 받아들이기 제어 |
|---|---|---|---|---|---|
| **Tier 0** (지금~수백 명) | < 1 | 지금 SQLite 그대로 | pahidc, runner 1→3개 | 손으로(`RUNNER_URLS`, `RUN_SLOTS`) | 6장 1~4 추가 |
| **Tier 1** (수천 명, 시험 몰림) | 1~10 | Cloudflare Queues pull(run/submit 2개 + DLQ) | pahidc + 클라우드 VM 0~N대(agent+runner 이미지) | 작은 오토스케일러(5장 공식, 클라우드 API로 VM 생성·삭제) + 예정 확장 | 위 + 대기 시간 기반 503 |
| **Tier 2** (대회 운영) | 10~100 | Redis Streams 또는 NATS JetStream(클러스터) | Kubernetes 노드 풀, 언어별 Deployment | KEDA(lag 기반) + Cluster Autoscaler, 대회 전 미리 확장 | 위 + 사용자 해시 분할 큐 |
| **Tier 3** | 100+ | 파티션된 NATS/Redis, 리전별 | 다중 리전, 샌드박스 엔진 교체(isolate/go-judge, 0003 보류 항목) | 리전별 KEDA | 대회별 할당량, 지연 채점(제출 받고 나중에 결과) |

### Tier 0 — 지금 바로 할 일 (브로커 바꾸지 않음)

1. 실행 시간 측정(5장 SQL)과 지표 노출: judge `/metrics`에 대기 수(종류별), 실행 중 수, 최근 5분 S̄, 대기 시간 p95.
2. 받아들이기 제어 6장 1~4.
3. 굶주림 방지(aging) — `claim()`의 정렬을 `priority - (기다린 초 / 30)`처럼 바꾼다.
4. pahidc 여유가 있으면 runner를 늘린다(compose에 runner2, `RUNNER_URLS`). 늘리기 전 pahidc의 vCPU·메모리를 확인한다(슬롯 1 ≈ vCPU 1, 0.75GB).
5. 디스패처를 `Queue` 인터페이스 뒤로 옮긴다(SQLite 구현). Tier 1 전환 때 구현만 바꾼다.

### Tier 1 — 실행 호스트 분리

1. `apps/judge`를 둘로 나눈다.
   - **judge-control**(Worker 쪽으로 흡수 가능): 작업 넣기, 테스트셋 업로드·검사(R2), 취소 표시.
   - **judge-agent**(실행 호스트마다): 큐에서 꺼내기 → runner → 결과 보내기. 상태 없음. 테스트셋은 R2에서 해시로 받아 로컬 캐시.
2. Worker가 D1에 `queued` 기록 후 큐에 메시지를 넣는다(넣기 실패 시 D1 기록을 지우거나, 주기적으로 `queued`인데 메시지가 없는 것을 다시 넣는 정리 작업).
3. 긴 조회를 Durable Object로 바꾼다(3장).
4. 오토스케일러: pahidc의 systemd 타이머 또는 Cloudflare Cron Worker가 1분마다 백로그·S̄를 읽어 원하는 agent 수를 계산하고, 클라우드 API로 VM을 만든다/지운다. VM은 cloud-init으로 agent+runner compose를 띄운다. 비밀은 agent 전용 토큰(큐 pull + 결과 콜백 서명)만 준다.
5. 보안: 실행 호스트에는 사용자 데이터·로그인 비밀을 두지 않는다(0007 원칙 유지). runner는 호스트마다 `internal` 네트워크.

### Tier 2 이상

- Kubernetes에서 agent+runner를 한 Pod(두 컨테이너, Pod 안 네트워크만 공유)로 두고 KEDA `ScaledObject`가 큐 lag로 replica를 정한다. 노드는 Cluster Autoscaler가 늘린다.
- 언어별 큐/Deployment(Java는 메모리가 크고 JVM 기동이 느리다)로 나눠 따로 늘린다.
- 테스트셋 캐시 적중률을 높이려면 문제 해시로 큐를 나눠 같은 문제를 같은 agent 묶음이 받게 한다(선택).
- 샌드박스를 cgroup 기반 엔진으로 바꿔 Pod당 슬롯을 늘린다(0003 보류 항목 재검토).

## 8. 장애와 운영

| 상황 | 동작 |
|---|---|
| agent가 실행 중 죽음 | 리스 만료 → 다른 agent가 다시 실행. Worker는 같은 id 결과를 한 번만 반영 |
| runner를 계속 죽이는 코드 | 3회 실패 후 DLQ, 제출은 `error`("채점 서버 오류"). DLQ는 알림 |
| 브로커 장애 | Worker는 넣기 실패 시 503(재시도 안내). D1의 `queued` 정리 작업이 복구 후 다시 넣는다 |
| 결과 콜백 실패 | agent outbox(로컬 SQLite)에 남겨 재시도, ack는 콜백 성공 뒤 |
| 과부하 | 6장 3번이 run부터 거절. 대시보드: 대기 수, 예상 대기 시간, agent 수, DLQ 수 |

## 9. 결정이 필요한 것

1. **허용 대기 시간**(run / submit): 오토스케일링 목표와 503 기준이 이 값에서 나온다. 제안: run 10초, submit 60초.
2. **Tier 1 실행 호스트 공급처**와 월 예산 상한(최대 agent 수를 정한다).
3. **Tier 1 브로커**: Cloudflare Queues(권장, Workers Paid 필요 여부와 분석 API로 백로그를 읽을 수 있는지 확인) vs pahidc의 Redis Streams.
4. ~~Tier 0 측정 결과로 5장의 가정값(S̄)을 바꾼 뒤 단계 경계를 다시 정한다.~~ 2026-11-04 측정: S̄ ≈ 0.35초, 최대 0.1건/초. 지금은 Tier 0으로 충분하다(5장 「측정」). 표본이 작아 지표(Tier 0 1번)를 붙인 뒤 다시 본다.

## 참고

- Cloudflare Queues 한도: https://developers.cloudflare.com/queues/platform/limits/ , pull consumer 처리량 변경: https://developers.cloudflare.com/changelog/2025-04-17-pull-consumer-limits/
- KEDA Redis Streams 스케일러(lag 기반): https://keda.sh/docs/latest/scalers/redis-streams/
- KEDA NATS JetStream 스케일러: https://github.com/kedacore/keda-docs/blob/main/content/docs/2.13/scalers/nats-jetstream.md , JetStream consumer: https://docs.nats.io/nats-concepts/jetstream/consumers
- AWS SQS 기반 확장(백로그/인스턴스): https://docs.aws.amazon.com/autoscaling/latest/userguide/as-using-sqs-queue.html , 동적 목표값: https://aws.amazon.com/blogs/compute/scaling-an-asg-using-target-tracking-with-a-dynamic-sqs-target/
- 이전 결정: [0003](0003-judge-pipeline.md)(제출 큐·테스트셋 분리), [0007](0007-serverless-worker-and-judge.md)(Worker·judge 분리)
