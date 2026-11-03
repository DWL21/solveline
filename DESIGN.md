# DESIGN.md — Solveline 디자인시스템

Solveline 웹(`apps/web`) 화면의 시각 규칙입니다. 사람과 에이전트가 같은 기준으로 작업하도록 토큰의 **값·쓰임새·근거**를 함께 적습니다.

- 토큰 원본: [`apps/web/src/index.css`](apps/web/src/index.css)의 `@theme`(Tailwind v4). 이 문서와 코드가 다르면 코드가 맞고, 문서를 고친다.
- 테마 전환: [`apps/web/src/lib/theme.ts`](apps/web/src/lib/theme.ts), 첫 그리기 전 결정은 [`apps/web/public/theme-init.js`](apps/web/public/theme-init.js)(운영 CSP가 인라인 스크립트를 막아 파일로 둔다).
- 스택: React 19 + Tailwind v4 유틸리티. 별도 컴포넌트 라이브러리 없이 `@utility`(btn·field·pane-title)와 클래스 조합을 쓴다.
- 근거로 쓴 디자인 스킬: `.claude/skills/impeccable`(audit·critique·extract), `.claude/skills/ui-ux-pro-max`(디자인시스템 추천·UX 가이드라인). Impeccable hook은 쓰지 않는다.
- 전후 비교 스크린샷: [`docs/design/`](docs/design/).

## 1. 방향: 다크는 Discord풍, 라이트는 Toss풍

| | 다크 | 라이트 |
|---|---|---|
| 참고한 분위기 | Discord: 회색 층으로 면을 나누는 다크, 블러플 포인트, 밀도 있는 사이드바·목록 | Toss: 흰 바탕, 큰 글자와 분명한 위계, 블루 포인트, 넉넉한 여백·둥근 모서리·은은한 그림자 |
| 포인트 색 | `#5865f2` 계열 블러플 | `#1b64da` 블루 |
| 면 나누기 | 밝기 차이(`bar`·`base` < `panel` < `ink` < `raised`) | 흰 면 + 옅은 회색 + 그림자 |

**왜 이렇게 골랐나**

- Solveline은 코드를 오래 읽고 쓰는 IDE다. ui-ux-pro-max `--design-system`("coding practice education developer tool IDE dark")도 코딩 플랫폼에는 다크를 추천했다. 회색 층으로 면을 나누는 Discord식 다크가 밀도 높은 사이드바·문제 목록·툴바 구조와 잘 맞는다.
- 문제를 고르고 읽는 화면(목록·문제 설명·로그인)은 읽기 중심이라, 밝은 환경을 쓰는 사람에게는 Toss식 라이트가 더 읽기 좋다. 그래서 하나로 정하지 않고 **기기 설정(`prefers-color-scheme`)을 따르고 상단바에서 바꿀 수 있게** 했다.
- 브랜드 로고·고유 에셋·고유 글꼴은 가져오지 않고, 면을 나누는 방식·색의 역할·밀도·모서리·여백 같은 원칙만 참고했다. 브랜드 색도 대비 기준에 맞춰 조정했다(예: Toss 블루 `#3182f6`은 흰 글자와 3.7:1이라 더 진한 `#1b64da`를 쓴다).

## 2. 기존 UI 검증 결과(바꾸기 전)

Impeccable `audit`(접근성·테마·반응형·구현 일관성)와 `critique`(위계·정렬·근접성), ui-ux-pro-max 가이드라인(대비 4.5:1, 터치 44px, 타입 스케일, 색 역할)으로 점검했다.

| 항목 | 발견한 문제 | 근거 | 조치 |
|---|---|---|---|
| 글자 크기 | 11.5·12·12.5·13·13.5·14·15·16·20·22px 등 **10단계 이상**이 0.5px 간격으로 섞여 단계 차이가 눈에 안 보임 | 타입 스케일은 일정 비율로 뚜렷이 커져야 위계가 생긴다(모듈러 스케일) | 6단계 12·14·16·18·22·28로 통합(§4) |
| 페이지 제목 | 화면마다 18·22/24·24·26px로 제각각 | 같은 역할은 같은 모양(일관성) | `text-title sm:text-headline` 하나로 |
| 면 위계 | 남색 면 사이 밝기 차이가 작고, 에디터가 주변보다 **밝아** 층이 뒤집힘 | 다크에서는 밝을수록 위(가까이)로 읽힌다(Material 고도 원칙) | 에디터·입력은 가장 어두운 오목한 면(`base`/`editor`)으로 |
| 버튼 위계 | 주 버튼 외 보조 버튼이 모두 같은 테두리 무게라 툴바가 빽빽해 보임 | 주/보조/약한 행동이 시각적으로 구분돼야 한다(위계, Von Restorff) | 보조 버튼을 테두리 없는 회색 채움(`bg-fill`)으로 |
| 버튼 크기 | 최소 34px, 터치 기기 40px | 4/8pt 격자, 터치 44px(ui-ux-pro-max, WCAG 2.5.5 권고) | 36px, 터치 기기 44px |
| 키보드 초점 | 입력 칸 외에는 초점 표시가 브라우저 기본값에 맡겨져 제각각 | WCAG 2.4.7 초점 보임 | 전역 `:focus-visible` 2px 강조색 테두리 |
| 입력 칸 테두리 | 바탕과 1.3~2:1 | WCAG 1.4.11 비텍스트 대비 3:1 | `field-line` 토큰(3:1 이상) |
| 진행 막대 | 트랙이 바탕과 거의 같아 안 보임 | 비텍스트 대비 | 트랙 `bg-fill`, 두께 6→8px |
| 오류 글자 | `bad #ff6b6b`가 `raised` 위 4.4:1 | WCAG 1.4.3 AA 4.5:1 | 다크 `#ff8a8c`(최저 4.86:1) |
| 라이트 테마 | 없음(다크 고정) | 사용 환경 선택권 | Toss풍 라이트 + 전환 버튼 |
| 하드코딩 값 | `text-[Npx]` 260여 곳, 별·선택 영역·에디터 색 hex/rgb | 토큰 일관성(audit Theming) | 전부 토큰으로 |

잘 되어 있던 점(유지): 색 토큰 체계와 `btn`/`field` 유틸리티, 상태를 ✓/✗·문구와 함께 표시하는 규칙, `prefers-reduced-motion` 대응, 아이콘 버튼의 `aria-label`.

## 3. 색

이름은 Tailwind 클래스 접미사다(`bg-panel`, `text-dim`, `border-line` …). 투명도는 `/숫자`(`bg-ok/15`). 컴포넌트에 hex·rgb를 직접 쓰지 않는다(예외 §9).

### 표면

| 토큰 | 다크 | 라이트 | 쓰임 |
|---|---|---|---|
| `bar` | `#1e1f22` | `#ffffff` | 상단바 |
| `base` | `#1e1f22` | `#f2f4f6` | 오목한 면: 사이드바·하단 실행 바·입력 칸·코드 블록 |
| `editor` | `#1e1f22` | `#ffffff` | 코드 에디터 |
| `panel` | `#2b2d31` | `#ffffff` | 카드·패널·메뉴·대화상자 |
| `ink` | `#313338` | `#f9fafb` | 페이지 바탕(본문 영역) |
| `raised` | `#3a3c42` | `#eef1f4` | hover·선택된 항목 |
| `fill` / `fill-hover` | `#43454b` / `#4e5058` | `#e5e8eb` / `#d1d6db` | 보조 버튼, 진행 막대 트랙 |

다크는 Discord처럼 **밝기 차이만으로** 층을 나눈다: 바깥 틀(상단바·사이드바)과 오목한 칸(입력·에디터)이 가장 어둡고, 읽는 본문(`ink`)이 그보다 밝고, 손이 닿는 hover·선택(`raised`)이 가장 밝다. 라이트는 Toss처럼 흰 면 위에 옅은 회색(`base`)으로 영역을 나누고 카드에는 그림자를 더한다.

### 선·글자

| 토큰 | 다크 | 라이트 | 쓰임 |
|---|---|---|---|
| `line` | `#3f4147` | `#e5e8eb` | 구분선·카드 테두리 |
| `line-strong` | `#4e5058` | `#d1d6db` | 칩 테두리, 표 선, 스크롤바 |
| `field-line` | `#74767f` | `#848e9a` | 입력 칸 테두리(바탕과 3:1 이상) |
| `text` | `#f2f3f5` | `#191f28` | 본문·제목 |
| `dim` | `#b5bac1` | `#4e5968` | 보조 문구, 비활성 탭 |
| `faint` | `#a3a9b1` | `#636e7b` | 메타 정보·placeholder·아이콘 |

### 강조·상태

| 토큰 | 다크 | 라이트 | 쓰임 |
|---|---|---|---|
| `accent` / `accent-hover` | `#5865f2` / `#4752c4` | `#1b64da` / `#1957c2` | 주 버튼, 초점 테두리, 선택 표시 |
| `accent-text` | `#a5acff` | `#1b64da` | 강조 글자(선택된 탭, 링크형 버튼) |
| `accent-soft` | 블러플 16% | `#e8f3ff` | 강조 배경(선택된 칩·배지) |
| `on-accent` | `#ffffff` | `#ffffff` | `accent` 위 글자 |
| `sky` | `#00a8fc` | `#1b64da` | 마크다운 링크 |
| `ok` | `#4fd08a` | `#067a46` | 정답·통과·완료 |
| `bad` | `#ff8a8c` | `#d22030` | 오답·실패·오류·삭제 |
| `warn` | `#f0b232` | `#a65200` | 경고·편집 모드·관리자 모드 |
| `star` / `star-hover` | `#f0b232` / `#e3a21a` | `#e19a00` / `#c98500` | 북마크 별(아이콘이라 3:1 기준) |
| `scrim` | 검정 70% | 검정 40% | 대화상자 뒤 덮개 |
| `selection` | 블러플 40% | 블루 18% | 텍스트 선택 영역 |
| `editor-active-line` / `-gutter` | 흰색 4% / 6% | 검정 3% / 5% | 에디터 현재 줄 |

### 대비 검증(WCAG 2.2 AA)

각 글자색을 그 테마의 네 표면(`ink`·`panel`·`base`·`raised`) 위에 놓았을 때 **가장 낮은 값**이다. 모두 4.5:1 이상이다.

| 글자 | 다크 최저 | 라이트 최저 |
|---|---|---|
| `text` | 9.93 | 14.61 |
| `dim` | 5.65 | 6.27 |
| `faint` | 4.65 | 4.58 |
| `accent-text` | 5.22 | 4.77 |
| `ok` | 5.63 | 4.77 |
| `bad` | 4.86 | 4.64 |
| `warn` | 5.84 | 4.84 |
| `accent` 위 `on-accent` | 4.61 | 5.41 |

- 비텍스트(WCAG 1.4.11, 3:1): 입력 칸 테두리 `field-line`은 다크 `base` 위 3.64, 라이트 `base` 위 3.02. 초점 테두리 `accent`는 라이트 `ink` 위 5.18, 다크 `ink` 위 2.74라 2px 두께에 2px 간격을 둬 굵기로 보완한다.
- `sky`(다크)는 `ink` 위 4.82지만 `raised` 위 4.2라 링크를 `raised` 위에 두지 않는다.
- 상태는 색만으로 구분하지 않는다(WCAG 1.4.1): ✓/✗ 기호와 문구를 함께 쓴다.

**상태 배경 조합**: `bg-<상태>/10~15` + `text-<상태>` (+ 필요하면 `border-<상태>/30~40`). 예: `rounded-md bg-ok/12 px-3 py-2.5 text-ui font-bold text-ok` → "✓ 정답입니다".

## 4. 타이포

- 글꼴: `font-sans` = Pretendard(→ 시스템 한글 글꼴), `font-mono` = JetBrains Mono(→ D2Coding …). 코드·입력 칸·시간은 `font-mono`, 바뀌는 숫자는 `tabular-nums`.
- 크기 6단계. 작은 쪽은 약 1.14배(장2도), 제목 쪽은 약 1.25배(장3도)로 커진다. 단계 사이가 2px 이상 벌어져 눈으로 구분된다.

| 토큰 | 값 | 쓰임 | 예전 값 |
|---|---|---|---|
| `text-caption` | 12px | 메타 정보·도움말·배지·표 머리 | 11.5·12·12.5 |
| `text-ui` | 14px | **기본 UI**: 버튼·입력·탭·패널 제목·결과 메시지 | 13·13.5 |
| `text-body` | 16px | 본문: 문제 설명, 목록 항목, 사이드바, 메모 | 14·15 |
| `text-lead` | 18px | 로고·카드 제목·대화상자 제목·문서 소제목 | 16·17·18 |
| `text-title` | 22px | 화면 제목(휴대폰) | 20 |
| `text-headline` | 28px | 화면 제목(데스크톱 `sm:` 이상) | 22·24·26 |

- 근거: 본문 16px은 ui-ux-pro-max의 "Base 16px"와 Toss의 큰 본문 원칙을 따랐다. UI 컨트롤은 정보 밀도를 위해 한 단계 작은 14px(Discord 수준). 12px 미만은 쓰지 않는다.
- 줄 높이는 토큰에 넣지 않고 부모를 따른다. 긴 글은 `leading-relaxed`(1.625)~`leading-[1.75]`.
- 굵기: 본문 400, 버튼·라벨 600, 제목 700, 로고 800. 같은 크기 안에서는 굵기로 위계를 더한다.
- 남은 임의 크기: 풀이 타이머 일시정지 판의 32px 숫자 하나(표시용).

## 5. 간격·크기

Tailwind 기본 4px 단위(`--spacing: 0.25rem`)를 쓰고 **4/8pt 리듬**을 지킨다.

- 컴포넌트 안쪽: 버튼 `px-4`(16), 입력 `px-3 py-2`(12·8), 카드 `p-4`~`p-5`, 대화상자 `p-6`.
- 요소 사이(근접성): 관련된 것끼리 `gap-2`(8), 묶음 사이 `gap-4`~`gap-6`(16~24). 묶음 사이 간격이 묶음 안 간격의 2배 이상이 되게 한다(게슈탈트 근접성).
- 컨트롤 높이: 버튼·입력 36px, 상단바 52px(`h-13`), 패널 제목 40px(`h-10`), 칩 36px(`h-9`).
- 터치(`pointer: coarse`): `.touch-target` 최소 44px, 아이콘 버튼은 `size-11`(44px)로 누르는 영역을 확보하고 아이콘만 작게 그린다.
- 예전 코드에 남은 반 단계(`px-3.5`, `py-2.5`, `gap-1.5`)는 2px 격자로 허용하되 새 코드에서는 4px 단계를 쓴다.

## 6. 모서리(radius)

Toss·Discord처럼 둥근 모서리. Tailwind 단계 값을 키워 뜻별로 쓴다.

| 클래스 | 값 | 쓰임 |
|---|---|---|
| `rounded` | 4px | 작은 배지, 인라인 코드 |
| `rounded-md` | **8px** | 버튼·입력·상태 알림(컨트롤) |
| `rounded-lg` | **12px** | 카드·목록 상자·드롭다운 메뉴 |
| `rounded-xl` | **16px** | 대화상자·로그인/가입 카드 |
| `rounded-full` | — | 칩, 아바타, 진행 막대 |

근거: 안쪽 요소의 모서리가 바깥보다 작아야 겹쳐 보일 때 자연스럽다(바깥 radius ≈ 안쪽 radius + 안쪽 여백). 카드(12) 안 버튼(8), 대화상자(16) 안 입력(8).

## 7. 그림자·층

| 토큰 | 다크 | 라이트 | 쓰임 |
|---|---|---|---|
| `shadow-card` | `0 1px 2px` 검정 20% | 두 겹, 남색 4~5% | 목록 상자·카드 |
| `shadow-overlay` | `0 8px 24px` 검정 45% | `0 12px 32px` 남색 14% | 메뉴·대화상자·로그인 카드 |

- 다크에서는 그림자가 잘 보이지 않으므로 **밝기 차이가 주된 층 표현**이고 그림자는 보조다. 라이트는 Toss처럼 옅은 그림자로 카드를 띄운다.
- 테마마다 값이 달라 `--elev-card`·`--elev-overlay` CSS 변수를 거친다.
- 대화상자 덮개 `bg-scrim`. z-index: 메뉴 `z-30~40`, 대화상자 `z-50`.

## 8. 컴포넌트

### 버튼(`@utility`)

| 클래스 | 모양 | 쓰임 |
|---|---|---|
| `btn-primary` | `accent` 채움, 흰 글자 | 화면의 주 행동 **하나**(제출, 저장, 새 문제) |
| `btn-ghost` | `fill` 회색 채움, 테두리 없음 | 보조 행동(코드 실행, 초기화, 취소) |
| `btn-quiet` | 배경 없음, `dim` 글자, hover에 `raised` | 툴바·목록 안의 가벼운 행동, 아이콘 버튼 |

공통(`btn`): `rounded-md`, `text-ui font-semibold`, 최소 높이 36px, `px-4`, 아이콘과 `gap-1.5`, `transition-colors`.

- 상태: hover는 한 단계 진한 색(`accent-hover`, `fill-hover`, `raised`), 키보드 초점은 전역 `:focus-visible`(2px `accent` + 2px 간격), 비활성은 `opacity-40` + `cursor-not-allowed`.
- 위험한 행동(삭제)은 `btn-ghost`·`btn-quiet`에 `text-bad`(또는 `hover:text-bad`)를 더하고 확인을 받는다.
- 근거: 주 버튼만 채도 높은 채움, 보조는 무채색 채움, 약한 행동은 글자만. 무게가 세 단계로 확실히 달라야 주 행동이 먼저 눈에 들어온다(Von Restorff 효과, Hick 법칙).

### 입력(`field`)

`base` 바탕, `field-line` 테두리, `rounded-md`, `px-3 py-2`, `font-mono text-ui`, placeholder `faint`. 초점이면 `border-accent` + `ring-3 ring-accent/20`, 오류면 `aria-invalid="true"`로 `border-bad`. 라벨은 칸 위에 보이게 두고 placeholder만으로 라벨을 대신하지 않는다.

### 카드·패널

- 카드: `rounded-lg border border-line bg-panel shadow-card` (+ `p-4~5`).
- 패널 제목: `pane-title`(`h-10`, `border-b border-line`, `bg-panel`, `text-ui font-bold text-dim`).
- 대화상자: 바깥 `bg-scrim`, 안쪽 `rounded-xl border border-line bg-panel p-6 shadow-overlay`.

### 배지·칩

- 상태 배지: `rounded bg-<상태>/15 px-2 py-0.5 text-caption font-bold text-<상태>`.
- 필터 칩: `h-9 rounded-full border px-3.5 text-ui font-semibold`. 선택은 반전(`border-text bg-text text-base`), 기본은 `border-line-strong text-dim`.

### 진행 막대

트랙 `h-2 rounded-full bg-fill`, 채움 `bg-ok`. 옆에 "0 / 6 해결"처럼 숫자를 함께 쓴다.

### 테마 전환

상단바 오른쪽 해/달 아이콘 버튼(`btn-quiet size-9`, `aria-label` "라이트 모드로 바꾸기" 등). 휴대폰에서 로그인한 상태면 상단바가 좁아 계정 메뉴 안에 둔다. 고른 값은 이 기기에 기억하고(`localStorage` `solveline:theme`), 고른 적이 없으면 기기 설정을 따라간다. 에디터 문법 색도 함께 바뀐다(다크 oneDark, 라이트 CodeMirror 기본 색).

### 모션

`transition-colors`(150ms)로 hover만 부드럽게, 나타나기는 `fadein 200ms ease-out`. 큰 이동·확대는 쓰지 않고, `prefers-reduced-motion`이면 스켈레톤 반짝임을 멈춘다.

## 9. 예외(토큰을 쓰지 않는 곳)

- **Google 로그인 버튼**(`LoginScreen.tsx`): Google 브랜드 지침대로 흰 바탕·`#1f1f1f` 글자·`#dadce0` 테두리·로고 색을 두 테마 모두 그대로 쓴다.
- **CodeMirror 문법 색**: 다크 `@codemirror/theme-one-dark`, 라이트 `defaultHighlightStyle`. 바탕·여백·현재 줄만 토큰.
- 레이아웃 폭(`max-w-[440px]`, `md:w-[40%]` 등)은 화면 배치 값이라 임의 값으로 둔다.

## 10. 새 화면 점검표

- [ ] 색·글자 크기·그림자를 토큰으로만 썼다(hex·`text-[Npx]` 새로 추가 없음).
- [ ] 다크·라이트 두 테마에서 모두 확인했다.
- [ ] 주 행동은 `btn-primary` 하나다.
- [ ] 상태는 기호·문구와 함께 표시했다.
- [ ] 아이콘만 있는 버튼에 `aria-label`이 있고, 터치 기기에서 누르는 영역이 44px 이상이다.
- [ ] 키보드 Tab으로 초점이 보인다.
- [ ] 375px 휴대폰과 1440px 데스크톱에서 가로 스크롤이 없다(의도한 툴바 가로 스크롤 제외).

## 앞으로

- 남은 반 단계 간격(`px-3.5` 등) 정리, 반복되는 배지·카드 조합을 `@utility`로 추출할지 검토(Impeccable `extract`: 같은 뜻으로 3번 이상 쓰일 때만).
- 로그인 전 화면(로그인·약관)에도 테마 전환 버튼 두기.
- `field`가 검색 칸처럼 한글 입력에도 고정폭 글꼴을 쓰는 문제: 코드·데이터 입력에만 `font-mono`를 쓰도록 나누기.
