# 품질 엔지니어링

Solveline의 테스트 자동화와 품질 관리를 한곳에 모은 문서입니다.

| 문서 | 내용 |
|---|---|
| [요구사항과 테스트 케이스](test-cases.md) | 요구사항 R1~R11, 테스트 케이스 추적표, 기기별 실행, 시연 방법 |
| [테스트 전략](strategy.md) | 원칙, 테스트 피라미드, 위험 기반 범위, 설계 기법, 환경, 진입·종료 기준, 불안정 테스트 정책 |
| [품질 지표](metrics.md) | 지표 정의·계산식·목표·수집 위치, 품질 게이트, 리뷰 주기 |
| [팀 적용 가이드](guide.md) | 테스트 작성 규칙, 패턴(페이지 객체·데이터 빌더), PR 체크리스트, 처음 오는 사람의 30분 |

## 한눈에 보기

```
              ┌──────────────┐   운영 스모크(읽기 전용, 매일)            4
              │   smoke      │
            ┌─┴──────────────┴─┐ UI E2E(데스크톱·Safari 계열·휴대폰·태블릿)  21
            │      ui          │
        ┌───┴──────────────────┴───┐ API 블랙박스(계약·권한 결정표·채점 상태) 69
        │          api             │
  ┌─────┴──────────────────────────┴─────┐ 단위·통합(인메모리, 커버리지 래칫)  64
  │                unit                  │
  └──────────────────────────────────────┘
  + 정적 분석(SonarQube 품질 게이트) · runner 자체 검사(격리) · 접근성(axe)
```

## 실행

| 무엇 | 명령 | 걸리는 시간(로컬) |
|---|---|---|
| 단위 + 커버리지 | `pnpm --filter @solveline/api test:coverage` | ~5초 |
| 테스트 환경(Docker) | `scripts/test-env.sh up` / `down` / `logs` | 처음 빌드 수 분, 이후 ~30초 |
| API 자동화 | `pnpm --filter @solveline/e2e e2e:api` | ~30초 |
| UI 자동화 | `pnpm --filter @solveline/e2e e2e:ui` | ~30초 |
| CI와 같은 전체 | `pnpm --filter @solveline/e2e e2e:ci` | ~1분 |
| 운영 스모크 | `pnpm --filter @solveline/e2e e2e:smoke` | ~5초 |
| 정적 분석 | `scripts/sonar.sh` (`SONAR_KEEP=1`이면 http://localhost:9000 에서 결과 보기) | 3~5분 |
| 품질 리포트 | `node scripts/quality-report.mjs` → `reports/quality/summary.md` | 즉시 |
| 테스트 리포트 | `pnpm --filter @solveline/e2e report` (실패 시 trace·영상 포함) | — |
| 요구사항 하나만 | `pnpm --filter @solveline/e2e exec playwright test --grep @R3` | — |
| 시연(모든 테스트 영상·trace) | GitHub Actions → CI → Run workflow → `demo` 켜기 → `e2e` 아티팩트 | ~5분 |

처음이면 `pnpm install` 뒤 `pnpm --filter @solveline/e2e exec playwright install chromium webkit`.

## 파이프라인

| 어디서 | 파일 | 언제 |
|---|---|---|
| GitHub Actions | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | 모든 PR·main 푸시: 기본 검사·이미지·시크릿·단위·정적 분석·API·UI 병렬 실행 → 엄격 품질 게이트·리포트(Step Summary) |
| GitHub Actions | [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) | main 푸시·수동: 운영 배포(self-hosted) |
| GitHub Actions | [`.github/workflows/smoke.yml`](../../.github/workflows/smoke.yml) | 매일 09:00 KST, 수동 |
| GitHub Actions | [`.github/workflows/qa-report.yml`](../../.github/workflows/qa-report.yml) | CI가 끝날 때: PR 단계 보고서 댓글(v0.x), 머지 후 배포·운영 스모크로 같은 보고서를 v1.0으로 갱신. 필수 체크 아님 |

## QA 테스트 보고서

CI가 끝나면 ISO/IEC/IEEE 29119-3의 테스트 완료 보고서 구성(수행한 테스트 요약 · 계획 대비 차이 · 완료 평가 · 진행을 막은 요인 · 측정치 · 결함 · 잔여 위험 · 산출물 · 재사용 자산 · 교훈)으로 보고서를 만든다.

PR 하나에 보고서 하나다. 작성 시점은 PR의 CI가 돌 때이고, 보고서 워크플로는 필수 체크가 아니어서 CI만 통과하면 보고서 작성을 기다리지 않고 머지할 수 있다.

| 판 | 언제 | 판정(Verdict) |
|---|---|---|
| v0.1, v0.2 … | PR의 CI가 끝날 때마다(새 커밋이면 판을 올리고 같은 댓글 갱신) | Ready to Merge · Ready to Merge (Conditional) · Merge Blocked |
| v1.0 | 머지 후 main CI가 끝나고 배포가 끝나면, 운영 스모크까지 돌려 같은 댓글 갱신 | Release Verified · Release Verified (Conditional) · Action Required |

- 소제목·표 머리글·상태 같은 짧은 항목은 영어, 설명 문장은 한국어로 쓴다.
- 판정은 종료 기준(단위·커버리지·자동화·불안정 0·품질 게이트·요구사항별 실패 0·CI 잡, 머지 후에는 배포·운영 스모크)으로 정한다. 열린 잔여 위험이 있으면 조건부다.
- 같은 내용의 A4 PDF(표지·문서 정보·검토·승인·개정 이력·증거 그림·테스트 케이스 부록)는 `qa-reports` 브랜치의 `pr-<번호>/`에 판별로 보관하고, 댓글에 표지 미리보기와 링크를 단다. 이 브랜치는 main과 히스토리를 공유하지 않는 데이터 전용 브랜치라 main 코드에 보고서가 들어가지 않고, 머지하지 않으며, CI·배포를 트리거하지 않는다. 아티팩트(로그인 필요·zip·최대 90일)나 Release 첨부(다운로드 전용)와 달리 GitHub 화면에서 PDF가 바로 열리고 기한 없이 남는다. 같은 파일을 `qa-report` 아티팩트에도 둔다.
- main 실행은 시연 모드로 돌아 v1.0에는 증거 그림이 들어간다.
- 결함·잔여 위험·교훈은 [`qa-register.json`](qa-register.json)에서, 요구사항은 [`test-cases.md`](test-cases.md)에서 읽는다. 상태가 바뀌면 같은 PR에서 고친다.
- 생성기: `e2e/report/`(모델·출력 분리, `model.test.mjs`로 판정 로직 검증). 로컬에서는 아티팩트를 받아 `pnpm --filter @solveline/e2e qa-report --input <디렉터리>`.

CI는 GitHub가 호스팅하는 runner에서만 돈다. 운영 서버·개발자 PC의 자원을 쓰지 않고, 매 실행 새 가상 머신이라 이전 실행의 흔적이 남지 않는다.

CI 도구가 바뀌어도 테스트가 바뀌지 않도록, 파이프라인은 얇게 두고 일은 저장소의 스크립트(`scripts/test-env.sh`, `scripts/sonar.sh`, `scripts/quality-report.mjs`)가 한다. 같은 스크립트를 로컬에서도 그대로 돌린다.

- [2026-10-28 QA 감사·개선 및 잔여 위험](audit-2026-10-28.md)


워크플로는 3개다. 기존 `Quality`는 `CI`로 통합했고, main 보호 규칙이 참조하는 기존 6개 체크 이름은 유지한다. `품질 리포트`는 이 6개 잡을 모두 기다려 하나라도 실패·취소·skip이면 실패한다. Node·pnpm 설치는 `.github/actions/setup-node`에서 공통 관리하며, 운영 배포의 서버 전용 설치 절차는 별도로 둔다. 수동 CI의 시크릿 검사는 선택한 커밋을 검사한다. `check` 잡은 고정 버전 actionlint로 워크플로 문법도 검사한다(`.github/actionlint.yaml`에 운영 runner 레이블 명시).


## 캐시

| 대상 | 키·무효화 | 동작 |
|---|---|---|
| pnpm store | OS·아키텍처·lockfile (`setup-node`) | 패키지 다운로드 재사용, 매번 frozen lockfile 설치 |
| Playwright 브라우저 | OS·아키텍처·Ubuntu 24·정확한 Playwright 버전·브라우저 목록 | 정확히 일치할 때만 바이너리 설치 생략 |
| apt 다운로드 | 위 키 + ISO 주차, 이전 주 prefix 복원 | `.deb`만 재사용. 매번 apt 메타데이터 갱신·서명 확인·정상 설치. OS 설치 상태·apt lists는 캐시하지 않음 |
| Docker 레이어 | BuildKit 내용 기반 + 이미지별 GHA scope | API·runner는 CI 이미지 빌드끼리 공유, 웹 운영·테스트는 별도 scope. 완성 이미지를 로드하고 E2E 시작 시 재빌드하지 않음 |
| Sonar 분석기·JRE | OS·아키텍처·lockfile·분석 설정 | 분석기 다운로드 재사용. 서버 DB·분석 결과·토큰은 캐시하지 않음 |

브라우저·apt 캐시는 설치 직후 저장해 이후 테스트가 실패해도 재사용한다. 운영 배포는 캐시 권한·수명주기가 달라 이 CI 캐시 액션을 사용하지 않는다. 로컬 `scripts/test-env.sh up`은 계속 빌드하며, CI에서만 `TEST_ENV_SKIP_BUILD=1`로 이미 빌드한 이미지를 사용한다. 캐시가 없어도 같은 설치·빌드 경로로 동작한다.
