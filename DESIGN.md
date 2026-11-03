# DESIGN.md — Solveline 디자인시스템

Solveline 웹(`apps/web`) 화면을 만들 때 지키는 시각 규칙입니다. 사람과 에이전트가 같은 기준으로 작업하도록 토큰의 값과 **쓰임새**를 함께 적습니다.

- 토큰 원본: [`apps/web/src/index.css`](apps/web/src/index.css)의 `@theme`(Tailwind v4). 이 문서와 코드가 다르면 코드가 맞고, 문서를 고친다.
- 스택: React 19 + Tailwind v4 유틸리티 클래스. 별도 컴포넌트 라이브러리 없이 `@utility`(btn·field·pane-title)와 클래스 조합을 쓴다.
- 디자인 스킬: `.claude/skills/ui-ux-pro-max`(방향·점검표), `.claude/skills/impeccable`(추출·정리·다듬기). Impeccable hook은 쓰지 않는다.

## 1. 방향

**어두운 남색 IDE.** 오래 코드를 읽고 쓰는 화면이라 눈이 편한 다크가 기본이고, 장식보다 정보 밀도와 가독성을 우선한다.

- ui-ux-pro-max `--design-system`("coding practice education developer tool IDE dark") 추천은 *Dark Mode (OLED)* 스타일, 코딩 플랫폼용 다크, JetBrains Mono였다. 방향은 그대로 받고, 색·글꼴은 **기존 정체성(남색 표면 + 파란 강조, Pretendard)** 을 유지했다. 추천의 초록 CTA(#22C55E)는 쓰지 않는다 — Solveline에서 초록은 "정답" 상태색이다.
- 원칙
  1. 색은 토큰으로만 쓴다. 컴포넌트에 hex·rgb를 적지 않는다(예외는 §8).
  2. 상태(정답·오답·경고)는 색만으로 구분하지 않는다. ✓/✗와 문구를 같이 쓴다.
  3. 강조색(파랑)은 화면마다 주 행동 하나에 아낀다.
  4. 사용자에게 보이는 문구는 한국어, 짧고 구체적으로.

## 2. 색

이름은 Tailwind 클래스 접미사다(`bg-panel`, `text-dim`, `border-line` …). 투명도는 `/숫자`로 붙인다(`bg-ok/15`).

### 표면 (어두움 → 밝음)

| 토큰 | 다크(기본) | 라이트(준비) | 쓰임 |
|---|---|---|---|
| `ink` | `#0c151c` | `#eef2f6` | 페이지 바탕(body) |
| `bar` | `#0f1922` | `#e3e9ef` | 상단바·하단 실행 바 |
| `base` | `#172334` | `#f7f9fb` | 입력 칸·코드 블록 바탕, 패널 안의 오목한 영역 |
| `panel` | `#1e2a38` | `#ffffff` | 카드·패널·메뉴·대화상자 |
| `raised` | `#263747` | `#e9eef3` | 에디터 바탕, hover, 선택된 항목 |

### 선·글자

| 토큰 | 다크 | 라이트 | 쓰임 |
|---|---|---|---|
| `line` | `#2f4256` | `#d5dde6` | 기본 구분선·카드 테두리 |
| `line-strong` | `#3d5468` | `#b8c4d1` | 입력·보조 버튼 테두리, 스크롤바 |
| `text` | `#e6edf3` | `#13202c` | 본문·제목 |
| `dim` | `#aab9c9` | `#44566a` | 보조 문구, 비활성 탭 |
| `faint` | `#90a3b6` | `#5a6b7d` | 메타 정보·placeholder·아이콘 |

### 강조·상태

| 토큰 | 다크 | 라이트 | 쓰임 |
|---|---|---|---|
| `accent` | `#0066e0` | `#0066e0` | 주 버튼 바탕, 초점 테두리, 선택 표시 |
| `accent-hover` | `#1a74e8` | `#0057c2` | 주 버튼 hover |
| `accent-text` | `#5aaeff` | `#0058c4` | 강조 글자(링크형 버튼, 선택된 탭 글자) |
| `on-accent` | `#ffffff` | `#ffffff` | `accent` 위 글자 |
| `sky` | `#44c4f5` | `#0b6f9c` | 마크다운 링크 |
| `ok` | `#3ec27d` | `#167443` | 정답·통과·완료 |
| `bad` | `#ff6b6b` | `#c53030` | 오답·실패·오류·삭제 |
| `warn` | `#f5b94a` | `#8f5c00` | 경고·편집 모드·관리자 모드 |
| `star` / `star-hover` | `#f0a80e` / `#e8a20c` | `#b07800` / `#9a6900` | 북마크 별 |
| `scrim` | `rgb(0 0 0 / .6)` | `rgb(15 25 34 / .45)` | 대화상자 뒤 덮개 |
| `selection` | `rgb(0 120 255 / .35)` | `rgb(0 102 224 / .2)` | 텍스트 선택 영역 |
| `editor-active-line` / `-gutter` | 흰색 4% / 6% | 검정 4% / 6% | CodeMirror 현재 줄 |

**대비(WCAG).** 다크에서 `text`·`dim`·`faint`·`accent-text`·`ok`·`warn`은 `ink`~`raised` 모든 표면에서 4.5:1 이상이다. `bad`는 `raised` 위에서 4.4:1이라 `raised` 위 작은 오류 글자는 피한다. 라이트 팔레트도 `panel`·`base` 위에서 본문색 모두 4.5:1 이상으로 골랐다. `accent` 위 흰 글자는 5.3:1.

**상태 배경 조합.** 상태 알림은 `bg-<상태>/10~15` + `text-<상태>` (+ 필요하면 `border-<상태>/30~40`). 예: `rounded-md bg-ok/12 px-3 py-2.5 text-body font-bold text-ok` → "✓ 정답입니다".

### 라이트 테마 상태

`<html data-theme="light">`이면 위 라이트 값이 적용된다(CSS 변수 덮어쓰기). **아직 화면에서 고르는 UI는 없고**, 아래가 끝나야 노출한다.

- CodeMirror 테마(`oneDark` + `navy`)가 다크 고정 → 라이트용 에디터 테마 필요.
- 그림자(`shadow-overlay`)는 Tailwind가 값을 그대로 넣어 테마별로 바뀌지 않는다.
- 다크를 전제로 한 투명도 조합(`bg-ok/15` 등)의 라이트 대비 확인.
- 브라우저로 켜 본 결과: Google 로그인 버튼(흰 바탕)이 `panel`과 구분되지 않아 테두리가 필요하고, `bg-text` 반전 버튼(임시 계정·선택된 칩)이 진한 남색이 된다.

## 3. 타이포

- 글꼴: `font-sans` = Pretendard(→ 시스템 한글 글꼴), `font-mono` = JetBrains Mono(→ D2Coding …). 코드·입력 칸·시간·숫자 표는 `font-mono`, 숫자가 바뀌는 곳은 `tabular-nums`.
- 크기 토큰(`text-<이름>`). 줄 높이는 정하지 않고 부모를 따른다(긴 글은 `leading-*`를 따로 준다).

| 토큰 | 값 | 쓰임 |
|---|---|---|
| `text-micro` | 11.5px | 작은 배지·꼬리표 |
| `text-caption` | 12px | 도움말·캡션·표 머리 |
| `text-meta` | 12.5px | 목록 메타(난이도·시간), 보조 설명 |
| `text-ui` | 13px | **기본 UI 크기**: 버튼·입력·탭·패널 제목 |
| `text-ui-lg` | 13.5px | 필터 칩 등 조금 큰 컨트롤 |
| `text-body` | 14px | 본문·결과 메시지·에디터 |
| `text-body-lg` | 15px | 목록 항목 제목, 로그인 버튼 |
| `text-lead` | 16px | 로고·카드·섹션 제목 |
| `text-title` | 20px | 화면 제목 |
| `text-title-lg` | 22px | 큰 화면 제목 |

- 굵기: 본문 400, 버튼·라벨 600(`font-semibold`), 제목·패널 제목 700(`font-bold`).
- 이 표에 없는 크기(17·18·24·26·32px 등 한두 번 쓰는 표시용 크기)는 아직 `text-[Npx]`로 둔다. 세 번 이상 같은 뜻으로 쓰이면 토큰으로 올린다.
- 마크다운 문제 본문(`.markdown-body`)은 em 기준: h1 1.45rem, h2 1.25rem, h3 1.1rem, 문단 간격 0.9em.

## 4. 간격·크기

Tailwind 기본 4px 단위(`--spacing: 0.25rem`)를 그대로 쓴다.

- 자주 쓰는 간격: 요소 사이 `gap-1`·`gap-2`·`gap-3`, 카드 안쪽 `p-4`·`p-5`, 대화상자 `px-6 py-7~8`, 문단 사이 `mt-2`·`mt-3`.
- 컨트롤 높이: 버튼 최소 34px(`btn`), 상단바·패널 제목 `h-10`(40px), 칩 `h-9`(36px).
- 터치: `pointer: coarse` 기기에서 `.touch-target` 최소 40px, 아이콘 버튼은 `size-11`(44px)로 누르는 영역을 확보하고 아이콘만 작게 그린다(예: 북마크 별).
- 안전 영역: `pt-safe`·`pb-safe` 유틸리티.

## 5. 모서리(radius)

Tailwind 기본 단계를 뜻으로 나눠 쓴다.

| 클래스 | 값 | 쓰임 |
|---|---|---|
| `rounded` | 4px | 작은 배지, 인라인 코드, 분할 버튼 안쪽 |
| `rounded-md` | 6px | 버튼·입력·상태 알림 (컨트롤) |
| `rounded-lg` | 8px | 카드·목록 상자·드롭다운 메뉴 |
| `rounded-xl` | 12px | 대화상자·로그인/가입 카드 |
| `rounded-full` | — | 칩, 아바타, 진행 막대, 원형 아이콘 |

## 6. 그림자·층

다크 화면은 그림자보다 **표면 밝기 차이(ink → panel → raised)와 테두리**로 층을 나눈다. 그림자는 떠 있는 층에만 쓴다.

- `shadow-overlay` (`0 25px 50px -12px rgb(0 0 0 / .25)`, 예전 `shadow-2xl`): 드롭다운 메뉴, 대화상자, 로그인·가입·관리자 카드, 풀이 타이머 일시정지 판.
- 화면 가운데 카드형 화면은 `shadow-overlay shadow-black/30`으로 조금 진하게.
- 대화상자 덮개: `bg-scrim`. z-index: 메뉴 `z-30~40`, 대화상자 `z-50`.

## 7. 컴포넌트

### 버튼 (`index.css`의 `@utility`)

| 클래스 | 모양 | 쓰임 |
|---|---|---|
| `btn-primary` | `accent` 바탕, `on-accent` 글자 | 화면의 주 행동 하나(제출, 저장, 시작) |
| `btn-ghost` | `panel` 바탕, `line-strong` 테두리 | 보조 행동(실행, 취소, 불러오기) |
| `btn-quiet` | 배경 없음, `dim` 글자, hover에 `raised` | 도구 막대·목록 안의 가벼운 행동 |

공통(`btn`): `rounded-md`, `text-ui`, `font-semibold`, 최소 높이 34px, 아이콘과 `gap-1.5`, 비활성 `opacity-50` + `cursor-not-allowed`. 위험한 행동(삭제)은 `btn-ghost`·`btn-quiet`에 `text-bad`(또는 `hover:text-bad`)를 더하고 확인을 받는다.

### 입력 (`field`)

`base` 바탕, `line-strong` 테두리, `rounded-md`, `font-mono text-ui`, placeholder `faint`, 초점 시 `border-accent` + `ring-2 ring-accent/15`. 라벨은 칸 위에 보이게 두고 placeholder만으로 라벨을 대신하지 않는다.

### 카드·패널

- 카드: `rounded-lg border border-line bg-panel` (+ `p-4~5`).
- 패널 제목: `pane-title` (`h-10`, `border-b border-line`, `bg-panel`, `text-ui font-bold text-dim`).
- 대화상자: `<dialog>` 바깥 `bg-scrim`, 안쪽 `rounded-xl border border-line bg-panel p-6 shadow-overlay`.

### 배지·칩

- 상태 배지: `rounded bg-<상태>/15 px-2 py-0.5 text-micro font-bold text-<상태>` (예: "관리자 모드").
- 필터 칩: `h-9 rounded-full border px-3.5 text-ui-lg font-semibold`. 선택은 `border-text bg-text text-base`(반전), 기본은 `border-line-strong text-dim`.

### 상태 표시

- 결과: `✓ 정답입니다` / `✗ 틀렸습니다`처럼 기호 + 문구 + 색.
- 로딩: `.skeleton`(반짝임, `prefers-reduced-motion`이면 정지).

### 모션

`transition-colors`(Tailwind 기본 150ms)로 hover만 부드럽게. 나타나기는 `animate-[fadein_200ms_ease-out]`. 큰 이동·확대 애니메이션은 쓰지 않고, 움직임 줄이기 설정을 따른다.

## 8. 예외(토큰을 쓰지 않는 곳)

- **Google 로그인 버튼**(`LoginScreen.tsx`): Google 브랜드 지침의 흰 바탕·`#1f1f1f` 글자·로고 색을 그대로 쓴다.
- **CodeMirror 문법 색**: `@codemirror/theme-one-dark`를 따른다. 바탕·여백·현재 줄만 토큰(`raised`, `line`, `faint`, `editor-active-*`).
- 한두 번 쓰는 표시용 글자 크기·레이아웃 폭(`max-w-[440px]` 등)은 임의 값으로 둔다.

## 9. 새 화면 점검표

- [ ] 색·글자 크기·그림자를 토큰으로만 썼다(hex·`text-[Npx]` 새로 추가 없음).
- [ ] 주 행동은 `btn-primary` 하나다.
- [ ] 상태는 기호·문구와 함께 표시했다.
- [ ] 아이콘만 있는 버튼에 `aria-label`이 있고 누르는 영역이 40px 이상이다.
- [ ] 키보드로 초점이 보인다(`focus:border-accent`, `focus-visible:*`).
- [ ] 375px 휴대폰과 1440px 데스크톱에서 가로 스크롤이 없다.

## 앞으로

- 라이트 테마 노출(에디터 테마·그림자·대비 확인 후 설정 UI).
- 남은 임의 글자 크기 정리, 반복되는 배지·카드 조합을 `@utility`로 추출할지 검토(Impeccable `extract`: 같은 뜻으로 3번 이상 쓰일 때만).
- 키보드 초점 표시(`focus-visible`) 일관화.
