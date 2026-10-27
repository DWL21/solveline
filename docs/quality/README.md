# 품질 엔지니어링

Solveline의 테스트 자동화와 품질 관리를 한곳에 모은 문서입니다.

| 문서 | 내용 |
|---|---|
| [테스트 전략](strategy.md) | 원칙, 테스트 피라미드, 위험 기반 범위, 설계 기법, 환경, 진입·종료 기준, 불안정 테스트 정책 |
| [품질 지표](metrics.md) | 지표 정의·계산식·목표·수집 위치, 품질 게이트, 리뷰 주기 |
| [팀 적용 가이드](guide.md) | 테스트 작성 규칙, 패턴(페이지 객체·데이터 빌더), PR 체크리스트, 처음 오는 사람의 30분 |

## 한눈에 보기

```
              ┌──────────────┐   운영 스모크(읽기 전용, 매일)            4
              │   smoke      │
            ┌─┴──────────────┴─┐ UI E2E(데스크톱·Safari 계열·휴대폰·태블릿)  21
            │      ui          │
        ┌───┴──────────────────┴───┐ API 블랙박스(계약·권한 결정표·채점 상태) 59
        │          api             │
  ┌─────┴──────────────────────────┴─────┐ 단위·통합(인메모리, 커버리지 래칫)  61+
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

처음이면 `pnpm install` 뒤 `pnpm --filter @solveline/e2e exec playwright install chromium webkit`.

## 파이프라인

| 어디서 | 파일 | 언제 |
|---|---|---|
| GitHub Actions | [`.github/workflows/quality.yml`](../../.github/workflows/quality.yml) | 모든 PR·main 푸시: 단위 → 정적 분석 → API·UI → 품질 리포트(Step Summary) |
| GitHub Actions | [`.github/workflows/smoke.yml`](../../.github/workflows/smoke.yml) | 매일 09:00 KST, 수동 |

CI는 GitHub가 호스팅하는 runner에서만 돈다. 운영 서버·개발자 PC의 자원을 쓰지 않고, 매 실행 새 가상 머신이라 이전 실행의 흔적이 남지 않는다.

CI 도구가 바뀌어도 테스트가 바뀌지 않도록, 파이프라인은 얇게 두고 일은 저장소의 스크립트(`scripts/test-env.sh`, `scripts/sonar.sh`, `scripts/quality-report.mjs`)가 한다. 같은 스크립트를 로컬에서도 그대로 돌린다.
