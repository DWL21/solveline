// QA 보고서 출력: PR 댓글(Markdown)과 A4 문서(HTML → PDF). 같은 모델에서 만든다.
import { fmt } from './model.mjs';

export const MARKER = { pr: '<!-- solveline-qa-report:pr -->', final: '<!-- solveline-qa-report:final -->' };

const STATUS = { expected: '통과', unexpected: '실패', flaky: '불안정', skipped: '건너뜀' };
const REQ = { passed: '통과', failed: '실패', partial: '일부', notRun: '미실행' };
const ICON = { pass: '✅', conditional: '🟡', fail: '❌' };
const PROJECTS = {
  api: ['API', '브라우저 없음'],
  'desktop-chromium': ['데스크톱 Chrome', 'Chromium'],
  'desktop-webkit': ['데스크톱 Safari 계열', 'WebKit'],
  'mobile-iphone': ['iPhone 15', 'WebKit 모바일'],
  'mobile-pixel': ['Pixel 7', 'Chromium 모바일'],
  'tablet-ipad': ['iPad (7세대)', 'WebKit 태블릿'],
};
const rating = (v) => (v ? 'ABCDE'[Math.round(Number(v)) - 1] : '—');
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const date = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '—');
const stageName = (m) => (m.kind === 'pr' ? 'PR 단계(머지 전)' : '머지 후 최종');

// Markdown 표 안전: 파이프·꺾쇠·멘션을 무력화한다(PR 제목 등 외부 입력)
const md = (s) => String(s ?? '').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '@​').replaceAll('\n', ' ');
const h = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function measures(m) {
  const rows = [];
  if (m.unit) {
    rows.push(['단위', '통과', `${m.unit.tests - m.unit.failed}/${m.unit.tests}`]);
    if (m.unit.coverage) rows.push(['단위', '커버리지 줄·분기·함수', `${fmt(m.unit.coverage.lines)} · ${fmt(m.unit.coverage.branches)} · ${fmt(m.unit.coverage.functions)}`]);
  }
  if (m.e2e) {
    rows.push(['API·UI', '통과', `${m.e2e.passed}/${m.e2e.total}`]);
    rows.push(['API·UI', '첫 시도 통과율 · 불안정', `${fmt(m.e2e.firstTryPassRate)} · ${m.e2e.flaky}건`]);
    if (m.e2e.wallMs) rows.push(['API·UI', '실행 시간', sec(m.e2e.wallMs)]);
  }
  if (m.smoke) rows.push(['운영 스모크', '통과', `${m.smoke.passed}/${m.smoke.total}`]);
  if (m.sonar) {
    const s = m.sonar.measures ?? {};
    rows.push(['정적 분석', '품질 게이트', m.sonar.gate]);
    rows.push(['정적 분석', '신뢰성 · 보안 · 유지보수 등급', `${rating(s.reliability_rating)} · ${rating(s.security_rating)} · ${rating(s.sqale_rating)}`]);
    rows.push(['정적 분석', '버그 · 취약점 · 코드 스멜', `${s.bugs ?? '—'} · ${s.vulnerabilities ?? '—'} · ${s.code_smells ?? '—'}`]);
    rows.push(['정적 분석', '중복 · 기술 부채', `${fmt(s.duplicated_lines_density)} · ${s.sqale_index ? `${Math.round(s.sqale_index / 60)}시간` : '—'}`]);
  }
  for (const a of m.e2e?.a11y ?? []) rows.push(['접근성', a.title.replace(/^접근성: /, ''), a.violations]);
  return rows;
}

const deliverables = (m, links) => [
  ['CI 실행', links.run ? `[#${m.run?.id}](${links.run})` : '—', '잡별 로그와 Step Summary'],
  ['e2e 아티팩트', links.run ? `[CI 실행의 Artifacts](${links.run}#artifacts)` : '—', `HTML 리포트, trace${m.kind === 'final' ? ', 영상·스크린샷(전체)' : '(실패 시)'}`],
  ['quality-report 아티팩트', links.run ? `[CI 실행의 Artifacts](${links.run}#artifacts)` : '—', 'metrics.json, summary.md'],
  ['A4 보고서(PDF)', links.report ? `[qa-report 아티팩트](${links.report}#artifacts)` : '—', '이 댓글과 같은 내용 + 증거 그림'],
];

const reusable = [
  ['테스트 환경', '`compose.test.yaml`, `scripts/test-env.sh`', '운영 이미지로 띄우는 Docker 테스트 환경'],
  ['API 클라이언트', '`e2e/src/api.ts`', '모든 응답을 공유 계약(Zod)으로 검증'],
  ['데이터 빌더·픽스처', '`e2e/src/builders.ts`, `e2e/src/fixtures.ts`', '테스트마다 새 사용자·데이터'],
  ['페이지 객체', '`e2e/src/pages/*`', '화면 조작을 사용자 동작 단위로'],
  ['추적표·대장', '`docs/quality/test-cases.md`, `docs/quality/qa-register.json`', '요구사항·결함·잔여 위험'],
  ['결함 보고 양식', '`.github/ISSUE_TEMPLATE/bug_report.yml`', '재현 절차·심각도·발견 위치'],
];

/** PR 댓글. 판단에 필요한 1~5장은 펼쳐 두고, 나머지는 접는다. */
export function toMarkdown(m, links = {}) {
  const L = [];
  L.push(MARKER[m.kind]);
  L.push(`## ${ICON[m.verdict.status]} QA 테스트 보고서 · ${stageName(m)}`);
  L.push('');
  L.push(`**판정: ${m.verdict.label}** — ${md(m.verdict.reason)}`);
  L.push('');
  L.push('| 문서 번호 | 버전 | 대상 | 커밋 | 근거 실행 | 작성 |');
  L.push('|---|---|---|---|---|---|');
  L.push(`| ${m.id} | ${m.version} | ${m.pr ? `#${m.pr.number} ${md(m.pr.title)}` : '—'} | \`${(m.sha ?? '').slice(0, 7)}\` | ${links.run ? `[CI #${m.run?.id}](${links.run})` : '—'} | GitHub Actions 자동 생성 · ${date(m.generatedAt)} |`);
  L.push('');
  L.push('### 1. 수행한 테스트 요약');
  const total = (m.unit?.tests ?? 0) + (m.e2e?.total ?? 0) + (m.smoke?.total ?? 0);
  L.push(`단위 ${m.unit?.tests ?? 0} · API·UI ${m.e2e?.total ?? 0}${m.smoke ? ` · 운영 스모크 ${m.smoke.total}` : ''}, 모두 ${total}개 실행. 요구사항 ${m.requirements.length}개를 ${Object.keys(m.projects).length}개 기기 프로젝트에서 확인했다. GitHub-hosted runner(ubuntu-24.04)에서 운영과 같은 이미지로 띄운 Docker 테스트 환경을 썼다.`);
  L.push('');
  L.push('### 2. 계획 대비 차이');
  L.push(m.deviations.length ? m.deviations.map((d) => `- ${md(d)}`).join('\n') : '- 없음');
  L.push('');
  L.push('### 3. 완료 평가(종료 기준)');
  L.push('| 기준 | 목표 | 결과 | 충족 |', '|---|---|---|---|');
  for (const c of m.criteria) L.push(`| ${c.name} | ${md(c.target)} | ${md(c.actual)} | ${c.met ? '✅' : '❌'} |`);
  L.push('');
  L.push('### 4. 진행을 막은 요인');
  L.push(m.blockers.length ? m.blockers.slice(0, 15).map((b) => `- ${md(b)}`).join('\n') : '- 없음');
  L.push('');
  L.push('### 5. 테스트 측정치');
  L.push('| 영역 | 지표 | 값 |', '|---|---|---|');
  for (const [a, b, c] of measures(m)) L.push(`| ${a} | ${md(b)} | ${md(c)} |`);
  L.push('');
  L.push('**요구사항별**', '', '| 번호 | 요구사항 | 확인 | 통과 | 판정 |', '|---|---|---|---|---|');
  for (const r of m.requirements) L.push(`| ${r.id} | ${md(r.name)} | ${r.via} | ${r.passed}/${r.total} | ${REQ[r.status]} |`);
  L.push('');
  L.push('**기기별**', '', '| 프로젝트 | 엔진 | 통과 | 실패 | 불안정 | 누적 시간 |', '|---|---|---|---|---|---|');
  for (const [key, s] of Object.entries(m.projects)) L.push(`| ${PROJECTS[key]?.[0] ?? key} | ${PROJECTS[key]?.[1] ?? '—'} | ${s.passed} | ${s.failed} | ${s.flaky} | ${sec(s.durationMs)} |`);
  L.push('');
  L.push('<details><summary><b>6. 결함 현황 · 7. 잔여 위험 · 8. 산출물 · 9. 재사용 자산 · 10. 교훈</b></summary>', '');
  L.push('### 6. 결함 현황');
  L.push(`대장 ${m.defects.length}건(해결 ${m.defects.filter((d) => d.status === '해결').length}) · 열린 버그 이슈 ${m.openBugs.length}건. 발견 위치: ${Object.entries(m.foundIn).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`, '');
  L.push('| ID | 내용 | 심각도 | 발견 위치 | 상태 |', '|---|---|---|---|---|');
  for (const d of m.defects) L.push(`| ${d.id} | ${md(d.summary)} | ${d.severity} | ${d.foundIn} | ${d.status} ${d.ref ?? ''} |`);
  for (const b of m.openBugs) L.push(`| #${b.number} | ${md(b.title)} | — | 이슈 | 열림 |`);
  L.push('');
  L.push('### 7. 잔여 위험');
  L.push('| ID | 위험 | 심각도 | 대응 | 상태 |', '|---|---|---|---|---|');
  for (const r of m.risks) L.push(`| ${r.id} | ${md(r.risk)} | ${r.severity} | ${md(r.mitigation)} | ${r.status} |`);
  L.push('');
  L.push('### 8. 산출물');
  L.push('| 산출물 | 위치 | 내용 |', '|---|---|---|');
  for (const [a, b, c] of deliverables(m, links)) L.push(`| ${a} | ${b} | ${c} |`);
  L.push('');
  L.push('### 9. 재사용 가능한 테스트 자산');
  L.push('| 자산 | 위치 | 쓰임 |', '|---|---|---|');
  for (const [a, b, c] of reusable) L.push(`| ${a} | ${b} | ${c} |`);
  L.push('');
  L.push('### 10. 교훈');
  L.push(m.lessons.map((x) => `- ${md(x)}`).join('\n') || '- 없음');
  L.push('', '</details>', '');
  L.push(`<details><summary><b>부록 A. 테스트 케이스 실행 결과 (${m.cases.length})</b></summary>`, '');
  L.push('| 요구사항 | 테스트 | 기기 | 결과 | 시간 |', '|---|---|---|---|---|');
  for (const c of [...m.cases].sort(byRequirement)) L.push(`| ${c.requirements.join(' ')} | ${md(c.title)} | ${c.project} | ${STATUS[c.status] ?? c.status} | ${sec(c.durationMs)} |`);
  L.push('', '</details>', '');
  L.push(`<sub>ISO/IEC/IEEE 29119-3 테스트 완료 보고서 구성 · 요구사항 추적표 \`docs/quality/test-cases.md\` · ${m.kind === 'pr' ? 'CI가 다시 돌면 이 댓글을 갱신합니다. 머지 후 배포·운영 스모크까지 확인한 최종 보고서가 따로 달립니다.' : '배포 완료 뒤 운영 스모크까지 확인한 최종본입니다.'}</sub>`);
  return L.join('\n');
}

const byRequirement = (a, b) => (Number(a.requirements[0]?.slice(1) ?? 99) - Number(b.requirements[0]?.slice(1) ?? 99)) || a.title.localeCompare(b.title, 'ko');

/** A4 문서. image(path)는 증거 그림을 data URI로 바꾼다(없으면 null). */
export function toHtml(m, links = {}, image = () => null) {
  const chip = (ok, yes = '충족', no = '미충족') => `<span class="chip ${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`;
  const verdictClass = { pass: 'ok', conditional: 'warn', fail: 'bad' }[m.verdict.status];
  const table = (head, rows, numeric = []) => `<table><thead><tr>${head.map((x, i) => `<th${numeric.includes(i) ? ' class="n"' : ''}>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const figures = m.evidence.map((e) => ({ ...e, src: image(e.path) })).filter((e) => e.src);
  const total = (m.unit?.tests ?? 0) + (m.e2e?.total ?? 0) + (m.smoke?.total ?? 0);
  const linkText = (url) => (url ? `<a href="${h(url)}">${h(url)}</a>` : '—');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${h(m.id)} QA 테스트 완료 보고서</title>
<style>${CSS}</style></head><body>
<section class="cover">
  <div class="org">Solveline · 품질 보증</div>
  <h1>테스트 완료 보고서</h1>
  <p class="sub">${h(m.pr ? `PR #${m.pr.number} ${m.pr.title}` : '배포 커밋')} · ${stageName(m)}</p>
  <div class="verdict ${verdictClass}"><b>판정: ${h(m.verdict.label)}</b><span>${h(m.verdict.reason)}</span></div>
  <h3>문서 정보</h3>
  ${table(['항목', '내용'], [
    ['문서 번호', h(m.id)],
    ['문서 종류', 'ISO/IEC/IEEE 29119-3 테스트 완료 보고서(Test Completion Report)'],
    ['버전', h(m.version)],
    ['시험 대상', h(m.pr ? `${m.repo ?? ''} PR #${m.pr.number} · 커밋 ${(m.sha ?? '').slice(0, 7)}` : (m.sha ?? '').slice(0, 7))],
    ['근거 실행', linkText(links.run)],
    ['생성', `${h(date(m.generatedAt))} · GitHub Actions 자동 생성`],
  ])}
  <h3>검토·승인</h3>
  ${table(['역할', '이름', '일자', '비고'], [
    ['작성', 'QA 보고서 워크플로', h(date(m.generatedAt)), '자동 생성'],
    ['검토', h(m.pr?.author ?? '—'), h(date(m.pr?.updatedAt)), 'PR 작성자'],
    ['승인', h(m.pr?.mergedBy ?? (m.kind === 'pr' ? '머지 시 승인' : '—')), h(date(m.pr?.mergedAt)), m.kind === 'pr' ? '머지 전' : '머지'],
  ])}
  <h3>개정 이력</h3>
  ${table(['버전', '일자', '내용'], [[h(m.version), h(date(m.generatedAt)), m.kind === 'pr' ? 'PR 단계 보고서(CI 결과 기준)' : '머지 후 최종 보고서(배포·운영 스모크 포함)']])}
</section>

<section class="pb">
  <h2>1. 개요</h2>
  <p><b>목적.</b> 변경이 요구사항 R1~R${m.requirements.length}을 지키는지 확인하고 ${m.kind === 'pr' ? '머지 여부를 판단하는' : '배포된 결과를 확인하는'} 근거를 남긴다.</p>
  <p><b>범위.</b> REST API(계약·권한·채점·데이터 분리·입력 검증), UI(둘러보기·풀이·자동 저장·편집 모드·관리자), 기기 5종(데스크톱 Chrome·Safari 계열, iPhone, Pixel, iPad), 접근성, 정적 분석${m.kind === 'final' ? ', 운영 스모크' : ''}. 실제 Google 로그인·실기기 키보드·부하는 범위 밖이다(잔여 위험 RR-04·05).</p>
  <p><b>참조.</b> docs/quality/strategy.md(테스트 전략), docs/quality/test-cases.md(요구사항·테스트 케이스), docs/quality/qa-register.json(결함·위험 대장)</p>

  <h2>2. 수행한 테스트 요약</h2>
  <p>단위 ${m.unit?.tests ?? 0} · API·UI ${m.e2e?.total ?? 0}${m.smoke ? ` · 운영 스모크 ${m.smoke.total}` : ''}, 모두 <b>${total}개</b>를 실행했다. GitHub-hosted runner(ubuntu-24.04)에서 운영과 같은 이미지로 Docker 테스트 환경을 띄우고, 테스트마다 새 사용자·데이터를 만들었다.</p>
  ${table(['층', '도구', '확인 내용', '실행 수'], [
    ['단위', 'Vitest', '설정·저장소·마이그레이션·권한 규칙', m.unit?.tests ?? '—'],
    ['API', 'Playwright request', '계약·권한 결정표·채점 상태 전이·경계값·데이터 분리', m.projects.api?.total ?? '—'],
    ['UI', 'Playwright 브라우저', '사용자 여정·반응형·접근성', m.e2e ? m.e2e.total - (m.projects.api?.total ?? 0) : '—'],
    ['운영 스모크', 'Playwright', '배포 후 핵심 경로(읽기 전용)', m.smoke?.total ?? (m.kind === 'pr' ? '머지 후' : '—')],
    ['정적 분석', 'SonarQube', '버그·취약점·중복·커버리지 게이트', '—'],
  ], [3])}

  <h2>3. 계획 대비 차이</h2>
  ${m.deviations.length ? `<ul>${m.deviations.map((d) => `<li>${h(d)}</li>`).join('')}</ul>` : '<p>없음</p>'}

  <h2>4. 완료 평가(종료 기준)</h2>
  ${table(['기준', '목표', '결과', '충족'], m.criteria.map((c) => [h(c.name), h(c.target), h(c.actual), chip(c.met)]))}

  <h2>5. 진행을 막은 요인</h2>
  ${m.blockers.length ? `<ul>${m.blockers.map((b) => `<li>${h(b)}</li>`).join('')}</ul>` : '<p>없음</p>'}
</section>

<section class="pb">
  <h2>6. 테스트 측정치</h2>
  ${table(['영역', '지표', '값'], measures(m).map(([a, b, c]) => [h(a), h(b), h(c)]))}
  <h3>6.1 요구사항별 결과</h3>
  ${table(['번호', '요구사항', '위험', '확인', '통과', '판정'], m.requirements.map((r) => [r.id, h(r.name), h(r.risk), r.via, `${r.passed}/${r.total}`, `<span class="chip ${r.status === 'passed' ? 'ok' : r.status === 'notRun' ? 'warn' : 'bad'}">${REQ[r.status]}</span>`]), [4])}
  <h3>6.2 기기별 결과</h3>
  ${table(['프로젝트', '엔진', '통과', '실패', '불안정', '누적 시간'], Object.entries(m.projects).map(([k, s]) => [h(PROJECTS[k]?.[0] ?? k), h(PROJECTS[k]?.[1] ?? '—'), s.passed, s.failed, s.flaky, sec(s.durationMs)]), [2, 3, 4, 5])}
  ${m.e2e?.slowest?.length ? `<h3>6.3 가장 느린 테스트</h3><ul>${m.e2e.slowest.map((t) => `<li>${sec(t.durationMs)} · ${h(t.project)} · ${h(t.title)}</li>`).join('')}</ul>` : ''}
</section>

<section class="pb">
  <h2>7. 결함 현황</h2>
  <p>대장 ${m.defects.length}건(해결 ${m.defects.filter((d) => d.status === '해결').length}) · 열린 버그 이슈 ${m.openBugs.length}건. 발견 위치: ${h(Object.entries(m.foundIn).map(([k, v]) => `${k} ${v}`).join(', ') || '—')}</p>
  ${table(['ID', '내용', '심각도', '발견 위치', '조치', '상태'], [
    ...m.defects.map((d) => [d.id, h(d.summary), d.severity, h(d.foundIn), h(d.fix), `<span class="chip ${d.status === '해결' ? 'ok' : 'warn'}">${h(d.status)}</span> ${h(d.ref ?? '')}`]),
    ...m.openBugs.map((b) => [`#${b.number}`, h(b.title), '—', '이슈', '—', '<span class="chip warn">열림</span>']),
  ])}
  <h2>8. 잔여 위험</h2>
  ${table(['ID', '위험', '심각도', '대응', '상태'], m.risks.map((r) => [r.id, h(r.risk), r.severity, h(r.mitigation), `<span class="chip ${r.status === '열림' ? 'warn' : 'ok'}">${h(r.status)}</span>`]))}
  <h2>9. 산출물</h2>
  ${table(['산출물', '위치', '내용'], [
    ['CI 실행', linkText(links.run), '잡별 로그와 Step Summary'],
    ['e2e · quality-report 아티팩트', links.run ? linkText(`${links.run}#artifacts`) : '—', `HTML 리포트·trace${m.kind === 'final' ? '·영상·스크린샷' : ''}, 지표 JSON`],
    ['PR 댓글', m.pr?.url ? linkText(m.pr.url) : '—', '이 문서와 같은 판정·측정치'],
  ])}
  <h2>10. 재사용 가능한 테스트 자산</h2>
  ${table(['자산', '위치', '쓰임'], reusable.map(([a, b, c]) => [h(a), h(b.replaceAll('`', '')), h(c)]))}
  <h2>11. 교훈</h2>
  <ul>${m.lessons.map((x) => `<li>${h(x)}</li>`).join('')}</ul>
</section>

${figures.length ? `<section class="pb"><h2>부록 A. 실행 증거</h2><p>근거 실행의 시연 모드 아티팩트에서 테스트가 남긴 화면이다. 그림 설명은 테스트 코드의 증거 이름이다.</p>
<div class="figs">${figures.map((f, i) => `<figure><img src="${f.src}" alt=""><figcaption><b>그림 ${i + 1}.</b> ${h(f.caption)} <span class="muted">(${h(f.project)})</span></figcaption></figure>`).join('')}</div></section>` : ''}

<section class="pb">
  <h2>부록 ${figures.length ? 'B' : 'A'}. 테스트 케이스 실행 결과</h2>
  ${table(['요구사항', '테스트', '기기', '결과', '시간'], [...m.cases].sort(byRequirement).map((c) => [c.requirements.join(' '), h(c.title), h(c.project), `<span class="chip ${c.status === 'expected' ? 'ok' : c.status === 'skipped' ? 'warn' : 'bad'}">${STATUS[c.status] ?? h(c.status)}</span>`, sec(c.durationMs)]), [4])}
</section>
</body></html>`;
}

const CSS = `
@page { size: A4; margin: 20mm 16mm 18mm; }
:root { --fg:#1b1f23; --muted:#5f6b72; --line:#c9d1d6; --head:#eef2f4; --accent:#1f4e79; --ok:#1e6b3a; --okbg:#e2f1e7; --warn:#8a5a00; --warnbg:#fcefd6; --bad:#a4262c; --badbg:#fbe3e4; }
* { box-sizing:border-box; }
html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { margin:0; color:var(--fg); font:9.4pt/1.6 "Noto Sans CJK KR","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif; }
h1 { font-size:24pt; margin:0 0 2mm; letter-spacing:-.01em; }
h2 { font-size:12.5pt; color:var(--accent); margin:7mm 0 2.5mm; padding-bottom:1.2mm; border-bottom:1pt solid var(--accent); break-after:avoid; }
section > h2:first-child { margin-top:0; }
h3 { font-size:10pt; margin:5mm 0 1.5mm; break-after:avoid; }
p { margin:0 0 2mm; } ul { margin:0 0 2mm; padding-left:5mm; } li { margin:.4mm 0; }
a { color:var(--accent); text-decoration:none; word-break:break-all; }
.pb { break-before:page; }
table { width:100%; border-collapse:collapse; margin:1mm 0 3mm; font-size:8.4pt; }
thead { display:table-header-group; } tr { break-inside:avoid; }
th, td { border:.5pt solid var(--line); padding:1.3mm 2mm; text-align:left; vertical-align:top; }
th { background:var(--head); font-weight:700; }
td:first-child { white-space:nowrap; }
.n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.chip { display:inline-block; padding:0 1.6mm; border-radius:2mm; font-size:7.6pt; font-weight:700; white-space:nowrap; }
.chip.ok { color:var(--ok); background:var(--okbg); } .chip.warn { color:var(--warn); background:var(--warnbg); } .chip.bad { color:var(--bad); background:var(--badbg); }
.muted { color:var(--muted); }
.cover .org { font-size:9pt; letter-spacing:.14em; color:var(--accent); border-top:3pt solid var(--accent); padding-top:6mm; margin-top:8mm; }
.cover h1 { margin-top:5mm; }
.cover .sub { font-size:11pt; color:var(--muted); margin-bottom:6mm; }
.verdict { border:1pt solid; border-radius:1.5mm; padding:3.5mm 4mm; margin:0 0 4mm; display:flex; flex-direction:column; gap:1mm; }
.verdict b { font-size:12pt; }
.verdict.ok { border-color:var(--ok); background:var(--okbg); } .verdict.ok b { color:var(--ok); }
.verdict.warn { border-color:var(--warn); background:var(--warnbg); } .verdict.warn b { color:var(--warn); }
.verdict.bad { border-color:var(--bad); background:var(--badbg); } .verdict.bad b { color:var(--bad); }
.cover td:first-child { width:30mm; background:#f7f9fa; }
.figs { display:grid; grid-template-columns:1fr 1fr; gap:4mm; }
figure { margin:0; break-inside:avoid; }
figure img { width:100%; max-height:95mm; object-fit:contain; object-position:left top; border:.5pt solid var(--line); display:block; }
figcaption { font-size:7.8pt; color:var(--fg); margin-top:1mm; }
`;
