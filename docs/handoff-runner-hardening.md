# 인수인계: runner 보안 강화 운영 반영 — 2026-11-04

pahidc에 접속할 수 있는 로컬 세션이 이 문서만 보고 이어서 할 수 있게 적는다. 작업 규칙은 `AGENTS.md`를 따른다.
- 배포는 GitHub Actions `Production deployment`(main 머지)로만 한다. **SSH로 배포하지 않는다.** SSH는 확인용이다.
- 비밀 값(`/etc/solveline/*.env`, GitHub secrets)은 출력하거나 기록하지 않는다.

## 무엇이 바뀌었나

점검 결과는 [docs/security/2026-11-04-runner-audit.md](security/2026-11-04-runner-audit.md)(F1~F6), 설계는 [0012](decisions/0012-runner-fast-concurrent-secure.md)에 있다. 이 PR([DWL21/solveline#203](https://github.com/DWL21/solveline/pull/203), 브랜치 `fix/runner-hardening`)은 다음을 바꾼다.

| 구성 | 전 | 후 |
|---|---|---|
| runner 네트워크 | `sandbox`(internal) 네트워크, TCP 8000 | **네트워크 없음**(`network_mode: none`) |
| judge → runner | `RUNNER_URLS=http://runner:8000` | `RUNNER_URLS=unix:/run/solveline-runner/runner.sock`, 공유 볼륨 `runner-socket` |
| 소켓 권한 | — | 폴더 root:1000 `0750`, 소켓 root:1000 `0660`(judge의 node 사용자만) |
| 테스트셋 캐시 | `/tmp/testsets`(사용자 코드와 같은 tmpfs, 755/644) | `/var/cache/solveline-testsets`(별도 tmpfs 224MB, 0700/0600) |
| 사용자 코드 uid | 모두 10001 | 슬롯마다 10002, 10003(`RUN_SLOTS=2`). 끝나면 남은 프로세스·파일 정리 |
| 함수형 시간 초과 | 하네스 보고값만 | + 바깥 측정값(기동 기준값을 뺀 값)이 제한 + 여유를 넘으면 시간 초과 |
| 제출 결과 stderr | 원문 2000자 | 오류 종류만(judge 저장 전, API 응답 전 모두) |
| runner 헬스 체크 | `urllib`로 TCP | `python3 /opt/runner/health.py`(소켓 또는 TCP) |

GitHub secrets·variables, `judge.env`, Pages 설정은 **바꿀 것이 없다**.

## 머지 전에 할 일

1. PR의 CI(`check`, `docker`, `secret-scan`)가 통과했는지 본다. `docker` 잡이 runner selftest(새 항목 5개 포함)를 돈다.
2. LLM QA가 돌면 결과를 본다. QA는 호스트의 main `compose.test.yaml`(TCP 설정)에 PR 이미지를 쓴다. runner는 `RUNNER_SOCKET`이 없으면 TCP로 받으므로 이 조합도 동작해야 한다.
3. 채점이 몰리지 않는 시간에 머지한다. 배포 중 judge·runner를 다시 만들 때 1~2분 채점이 멈춘다(대기열은 judge 재시작 뒤 이어서 처리).

## 머지 후 확인 (pahidc, SSH 확인만)

배포 워크플로가 끝난 뒤 아래를 순서대로 본다. 컨테이너 이름은 compose 프로젝트 `solveline-production` 기준이다.

```bash
ssh pahidc
```

```bash
sudo docker compose -p solveline-production ps
```
- `runner`, `judge`, `web`이 모두 `healthy`인지 본다.

```bash
sudo docker inspect -f '{{.HostConfig.NetworkMode}}' solveline-production-runner-1
```
- `none`이어야 한다.

```bash
sudo docker exec solveline-production-runner-1 ls -ln /run/solveline-runner /var/cache
```
- `runner.sock`이 `srw-rw---- 0 1000`, `solveline-testsets`가 `drwx------ 0 0`이어야 한다.

```bash
sudo docker exec solveline-production-judge-1 node -e "require('http').get({socketPath:'/run/solveline-runner/runner.sock',path:'/health'},r=>{console.log(r.statusCode);process.exit(0)}).on('error',e=>{console.log(e.message);process.exit(1)})"
```
- `200`이어야 한다(judge → runner 소켓).

```bash
curl -fsS https://solveline.simplyimg.com/api/runtime
```
- `"runner":"up"`과 Java 21.0.2·Python 3.13.13 버전이 보여야 한다.

```bash
sudo docker exec solveline-production-runner-1 python3 /opt/runner/selftest.py
```
- 모든 줄이 `PASS`여야 한다. 실행에 1분쯤 걸리고 슬롯을 쓰므로 한가한 시간에 한다.

```bash
sudo docker logs --since 30m solveline-production-runner-1 2>&1 | grep -i baseline
```
- 출력이 없어야 정상이다. `baseline … unavailable`이 있으면 바깥 시간 검사가 꺼진 상태다(아래 「문제가 생기면」).

마지막으로 브라우저에서 로그인한 계정으로 아무 문제나 **코드 실행**과 **제출**을 한 번씩 해서 결과가 나오는지 본다. 제출에서 런타임 에러가 나는 코드를 내면 오류가 "런타임 에러 (ValueError)"처럼 종류만 보여야 한다.

## 정리

- 예전 네트워크가 남는다(compose는 선언에서 빠진 네트워크를 지우지 않는다). 쓰는 컨테이너가 없는지 보고 지운다.

```bash
sudo docker network inspect solveline-production_sandbox -f '{{len .Containers}}'
```

```bash
sudo docker network rm solveline-production_sandbox
```
- 첫 명령이 `0`일 때만 두 번째를 실행한다.

## 운영자 결정이 필요한 것

1. **히든 테스트셋 교체**: F1은 배포 전까지 누구나 캐시된 히든 케이스를 읽을 수 있었고, runner에는 파일 접근 기록이 없어 악용 여부를 알 수 없다. 중요한 문제(시험·대회용)부터 히든 케이스를 바꿀지 정한다. 편집 권한으로 화면에서 바꾸면 새 해시로 저장되고 runner 캐시도 새로 받는다.
2. **보고서 공개 범위**: 점검 보고서는 저장소(공개)에 있다. 수정 배포가 확인되면 보고서 상태를 「수정·확인 완료」로 바꾼다(아래 PR).

## 문제가 생기면

| 증상 | 확인 | 조치 |
|---|---|---|
| runner가 `unhealthy`, judge가 뜨지 않음(`depends_on`) | `sudo docker logs solveline-production-runner-1` | 소켓 폴더 권한·볼륨 마운트 오류면 로그에 나온다. 바로 고칠 수 없으면 main에서 이 PR을 되돌리는 PR을 만들어 머지한다(배포로 되돌림). |
| `/api/runtime`이 `"runner":"down"` | judge 로그에서 `실행 서버에 연결할 수 없습니다` | 위 judge 소켓 확인 명령. `EACCES`면 judge 컨테이너 uid/gid가 1000인지(`docker exec … id`) 본다. 다르면 compose의 `RUNNER_SOCKET_GID`를 맞춘다. |
| 시간 초과가 갑자기 늘었다는 신고 | 해당 제출의 언어·제한·인자 크기 | 함수형은 모듈 최상위 코드·인자 파싱도 바깥 시간에 들어간다. 여유는 runner 환경 변수 `TRUST_SLACK_MS`(기본 150), `ARG_MS_PER_MB`(기본 200)로 조정한다(compose 변경 → PR). |
| `baseline … unavailable` 로그 | runner 로그 | 기동 기준값 측정이 실패해 바깥 시간 검사가 꺼졌다(판정은 예전처럼 동작). runner를 재시작하면 다시 잰다. 계속되면 이슈로 남긴다. |
| 테스트셋 캐시가 자주 비워짐 | runner `/var/cache/solveline-testsets` 크기 | tmpfs 224MB, 캐시 상한 `TESTSET_CACHE_MB=200`. 늘리면 컨테이너 메모리(1.5GB)도 함께 본다. |

## 끝났을 때 남길 것

- 위 확인 결과를 PR 또는 이슈에 짧게 남긴다(명령과 결과만, 비밀·사용자 데이터 없이).
- `docs/security/2026-11-04-runner-audit.md`의 상태를 「수정·확인 완료(날짜)」로 바꾸는 PR을 만든다.
