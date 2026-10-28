# 보안 핫스팟 검토 기록

SonarQube의 보안 핫스팟은 자동으로 취약점이 되지 않고 사람이 안전 여부를 판단해야 한다([qa-register](qa-register.json) RR-03). 검토 결과를 여기에 남기고, 핫스팟이 새로 생기면 PR에서 이 표를 함께 고친다.

- 검토일: 2026-10-28, 기준: `scripts/sonar.sh` 분석 결과 6건
- 판정: 6건 모두 **안전(Safe)**. 코드 변경 없음
- 갱신: 2026-10-28 runner 정리(#126)로 시그널 전송 지점이 `_kill_group` 하나로 합쳐져 5건. 판정은 같다

| 규칙 | 위치 | 판정 | 근거 |
|---|---|---|---|
| S5852 정규식 과도한 역추적 | `apps/api/src/db.ts` `stripSourceMentions` 원문 주소 정규식 | 안전 | 마이그레이션에서 한 번만 실행한다. 입력은 서버 DB의 문제 본문(편집 권한자가 작성)이고 외부 요청이 직접 넣을 수 없다. 중첩 수량자가 없고 `[^)\s]*` 같은 부정 문자 클래스로 끊겨 지수 폭발은 없다 |
| S5852 | `apps/api/src/db.ts` 괄호 링크 제거 정규식 | 안전 | 위와 같음 |
| S5332 평문 HTTP | `runner/server.py` 서버 기동 | 안전 | runner는 `internal: true` 네트워크에서 api 디스패처만 접근한다. 호스트에 포트를 열지 않고 인터넷에도 나가지 못한다(AGENTS.md 코드 실행 샌드박스 규칙). 외부 구간 TLS는 Cloudflare Tunnel이 맡는다 |
| S4828 시그널 전송 | `runner/server.py` `Job.kill` | 안전 | 이 서버가 직접 만든 자식 프로세스 그룹(`pgid`)에만 SIGKILL을 보낸다. 사용자가 PID를 지정할 수 없다 |
| S4828 | `runner/server.py` `_kill_group` | 안전 | 시간 초과와 실행 뒤 자손 정리에서 쓴다. 인자는 `run_proc`가 방금 띄운 자식의 `p.pid`뿐이다 |

## 다시 검토하는 때

- 새 핫스팟이 생겼을 때(`reports/quality/sonar.json`의 `security_hotspots`가 5를 넘으면)
- `db.ts`의 정규식 입력이 외부 요청으로 바뀌거나, runner를 `internal` 네트워크 밖으로 옮길 때
