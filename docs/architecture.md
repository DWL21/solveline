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
solveline.simplyimg.com ─ Cloudflare Pages (web 정적 파일)
                        └─ /api/* → Pages 프록시 → solveline-api.simplyimg.com
                                                   └─ Cloudflare Tunnel → pahidc 127.0.0.1:8083
                                                       └─ nginx → api:8787 (Hono, SQLite, 제출 큐)
                                                                  └─ runner:8000 (internal 네트워크)
```

채점 흐름(자세히는 [`decisions/0003-judge-pipeline.md`](decisions/0003-judge-pipeline.md)):

```
브라우저 ─POST /api/submissions─▶ api: submissions 표(queued) ─디스패처(코드 실행 > 제출)─▶ 빈 runner 슬롯
   └─ GET /api/submissions/:id 로 결과 조회         runner: 테스트셋을 해시로 캐시, 없을 때만 받음 (409 → 업로드)
```

`main` 푸시 → `Production deployment` 워크플로(self-hosted runner `solveline-production`) → `/etc/solveline/api.env` 기록 → web 빌드 → API·runner·게이트웨이 `docker compose up --build` → Pages 업로드 → 공개 주소 헬스 체크. PR의 `check`, `docker`, `secret-scan`은 기존처럼 GitHub-hosted에서 실행합니다.

배포 준비·전환·롤백은 [Pages 배포](pages-deployment.md)를 참고하세요.

## 이름

서비스 이름은 **Solveline**입니다(예전 이름 codetest). 패키지 `@solveline/*`, compose 프로젝트 `solveline-production`, 서버 경로 `/var/lib/solveline`·`/etc/solveline`, 세션 쿠키 `solveline_session`, DB 파일 `solveline.db`를 씁니다.
예전 이름에서의 이전은 배포 스크립트([`scripts/deploy-production.sh`](../scripts/deploy-production.sh))와 api가 한 번 처리합니다: 예전 compose 프로젝트를 내리고 데이터 폴더를 옮기며, `codetest.db`는 `solveline.db`로 바꾸고, 예전 세션 쿠키와 창 크기 설정은 계속 읽습니다.
예전 주소 codetest.simplyimg.com은 solveline.simplyimg.com으로 이동합니다.

## 자동 저장

작성 변경은 계정 이메일·문제 ID로 분리한 브라우저 localStorage에 보관합니다. 서버 동기화가 끝난 필드만 지우고, 전송 중 추가된 편집은 다음 요청에 남깁니다. 5초 유휴·최대 30초 간격으로 변경분을 전송하며 풀이 시간만 바뀌면 60초마다 보냅니다. 실행·제출 전에는 내용 변경부터 동기화합니다. 페이지 이탈 시 작은 변경은 keepalive로 전송을 시도하고 큰 변경은 로컬에서 보존합니다.

문제 이동 후에도 Shell의 큐가 미전송 문제를 처리하며, 연결 복구 시 재시도합니다. 로그아웃하면 전송을 중지하고 다른 계정의 임시 저장은 읽지 않습니다. 서버도 `X-Draft-Owner`와 로그인 세션을 비교합니다. 여러 탭의 전송은 Web Locks가 제공되는 브라우저에서 문제별로 직렬화합니다. 같은 필드를 여러 기기에서 동시에 고치면 마지막 서버 저장이 반영됩니다.

브라우저 저장 공간이 부족하거나 차단되면 화면에 로컬 저장 실패를 표시하고 메모리 변경을 서버로 보냅니다. 서버 동기화 전 브라우저 데이터를 삭제하면 해당 기기의 미전송 변경은 복구할 수 없습니다. 로컬 캐시는 서비스 워커가 아니므로 네트워크 없이 사이트 전체를 처음 여는 기능은 제공하지 않습니다.

## 반응형 화면

| 폭 | 대상 | 문제 화면 |
|---|---|---|
| 768px 미만, 또는 가로 휴대폰 | 휴대폰(아이폰·갤럭시·폴드) | 문제·코드·결과 탭 + 하단 실행 바, 코드 탭은 상단바·제목 숨김, 코드를 쓰는 동안은 탭·실행 바까지 숨김, 테스트 케이스는 카드 |
| 768px 이상 | 태블릿 세로·가로, 데스크톱 | 문제 / 에디터·결과 좌우 분할(크기 조절) |

- 앱은 화면에 실제로 보이는 영역(`visualViewport`)에 고정한다(`#root` position fixed, `--app-h`·`--app-top`, `apps/web/src/main.tsx`). 화상 키보드·브라우저 도구 막대가 나타나고 사라져도 하단 실행 바가 그 바로 위에 붙고 아래 빈 공간이 생기지 않는다. 문서는 스크롤하지 않고 긴 화면은 `#root` 안에서 스크롤한다. 안드로이드는 `interactive-widget=resizes-content`.
- 호환: dvh를 모르면 100vh, `overflow-x: clip`을 모르면 hidden으로 대체. 안전 영역은 위·좌·우를 `#root`에서, 아래는 홈 화면 앱(standalone)일 때만 하단 바에서 비켜 간다.
- 휴대폰 배치 판단: 폭 768px 미만, 또는 터치 기기에서 높이 500px 이하(가로로 눕힌 휴대폰). 360px 미만(갤럭시 폴드 덮개 화면, 아이폰 SE)은 상단바 로고 글자를 숨긴다.
- iOS는 입력칸 초점 때 자동 확대되지 않도록 `maximum-scale=1`을 iOS에서만 붙인다(손가락 확대는 그대로).
- 휴대폰 에디터: 자동 대문자·자동 수정·맞춤법 검사를 끄고, 긴 줄은 그 줄 들여쓰기 + 2칸으로 줄바꿈, 접기 여백 없음, 끝에 40vh 여백(마지막 줄도 키보드 위로 올릴 수 있게). 오른쪽 빠른 스크롤 손잡이, 두 손가락으로 글자 크기 11~22px(기기에 저장, 기본 14px).
- 코드 탭(`html[data-code-focus]`)은 상단바·제목 줄을, 에디터 초점(`html[data-typing]`)·키보드 열림(`html[data-keyboard]`)은 탭·실행 바를 숨긴다.
- 노치·홈 막대는 `env(safe-area-inset-*)`로 비켜 간다. 폭 판단은 `apps/web/src/lib/media.ts`.

