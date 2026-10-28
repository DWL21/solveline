// QA 보고서 출력: PR 댓글(Markdown)과 A4 문서(HTML → PDF). 같은 모델에서 만든다.
// 소제목·표 머리글·상태 같은 짧은 항목은 영어, 설명 문장은 한국어로 쓴다.
import { fmt } from './model.mjs';

/** PR 하나에 댓글 하나. PR 단계에서 쓰고, 머지 후 배포 확인 때 같은 댓글을 갱신한다. */
export const MARKER = '<!-- solveline-qa-report -->';

const STATUS = { expected: 'Pass', unexpected: 'Fail', flaky: 'Flaky', skipped: 'Skipped' };
const REQ = { passed: 'Pass', failed: 'Fail', partial: 'Partial', notRun: 'Not run' };
const STATE = { 해결: 'Resolved', 열림: 'Open', 수용: 'Accepted' };
const FOUND = { '정적 분석': 'Static analysis', '비밀 값 검사': 'Secret scan', '결함 주입': 'Fault injection', 리뷰: 'Review', '절차 점검': 'Process review', '수동 탐색': 'Exploratory (device)', 이슈: 'Issue' };
const RISK = { 매우큼: 'Very high', '매우 큼': 'Very high', 큼: 'High', 중간: 'Medium', 낮음: 'Low' };
const PROJECTS = {
  api: ['API', 'No browser'],
  'desktop-chromium': ['Desktop Chrome', 'Chromium'],
  'desktop-webkit': ['Desktop Safari', 'WebKit'],
  'mobile-iphone': ['iPhone 15', 'WebKit (mobile)'],
  'mobile-pixel': ['Pixel 7', 'Chromium (mobile)'],
  'tablet-ipad': ['iPad (7th gen)', 'WebKit (tablet)'],
};
const en = (map, v) => map[v] ?? v;
const rating = (v) => (v ? 'ABCDE'[Math.round(Number(v)) - 1] : '—');
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const date = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) + ' KST' : '—');
const stage = (m) => (m.kind === 'pr' ? 'PR stage (pre-merge)' : 'Post-merge (deployment verified)');

// Markdown 표 안전: 파이프·꺾쇠·멘션을 무력화한다(PR 제목 등 외부 입력)
const md = (s) => String(s ?? '').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '@​').replaceAll('\n', ' ');
const h = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function measures(m) {
  const rows = [];
  if (m.unit) {
    rows.push(['Unit', 'Passed', `${m.unit.tests - m.unit.failed}/${m.unit.tests}`]);
    if (m.unit.coverage) rows.push(['Unit', 'Coverage (lines · branches · functions)', `${fmt(m.unit.coverage.lines)} · ${fmt(m.unit.coverage.branches)} · ${fmt(m.unit.coverage.functions)}`]);
  }
  if (m.e2e) {
    rows.push(['API/UI', 'Passed', `${m.e2e.passed}/${m.e2e.total}`]);
    rows.push(['API/UI', 'First-try pass rate · Flaky', `${fmt(m.e2e.firstTryPassRate)} · ${m.e2e.flaky}`]);
    if (m.e2e.wallMs) rows.push(['API/UI', 'Duration', sec(m.e2e.wallMs)]);
  }
  if (m.smoke) rows.push(['Production smoke', 'Passed', `${m.smoke.passed}/${m.smoke.total}`]);
  if (m.sonar) {
    const s = m.sonar.measures ?? {};
    rows.push(['Static analysis', 'Quality gate', m.sonar.gate]);
    rows.push(['Static analysis', 'Reliability · Security · Maintainability', `${rating(s.reliability_rating)} · ${rating(s.security_rating)} · ${rating(s.sqale_rating)}`]);
    rows.push(['Static analysis', 'Bugs · Vulnerabilities · Code smells', `${s.bugs ?? '—'} · ${s.vulnerabilities ?? '—'} · ${s.code_smells ?? '—'}`]);
    rows.push(['Static analysis', 'Duplication · Technical debt', `${fmt(s.duplicated_lines_density)} · ${s.sqale_index ? `${Math.round(s.sqale_index / 60)}h` : '—'}`]);
  }
  for (const a of m.e2e?.a11y ?? []) rows.push(['Accessibility', a.title.replace(/^접근성: /, ''), a.violations]);
  return rows;
}

const reusable = [
  ['Test environment', 'compose.test.yaml, scripts/test-env.sh', 'Docker environment built from production images'],
  ['API client', 'e2e/src/api.ts', 'Validates every response against the shared Zod contract'],
  ['Data builders · fixtures', 'e2e/src/builders.ts, e2e/src/fixtures.ts', 'Fresh user and data per test'],
  ['Page objects', 'e2e/src/pages/*', 'UI actions expressed as user tasks'],
  ['Traceability · register', 'docs/quality/test-cases.md, docs/quality/qa-register.json', 'Requirements, defects, residual risks'],
  ['Bug report template', '.github/ISSUE_TEMPLATE/bug_report.yml', 'Steps, severity, where found'],
];

const foundSummary = (m) => Object.entries(m.foundIn).map(([k, v]) => `${en(FOUND, k)} ${v}`).join(', ') || '—';
const byRequirement = (a, b) => (Number(a.requirements[0]?.slice(1) ?? 99) - Number(b.requirements[0]?.slice(1) ?? 99)) || a.title.localeCompare(b.title, 'ko');

/** PR 댓글. 판단에 필요한 1~5장은 펼치고 나머지는 접는다. PDF 표지를 보여 주고 PDF로 연결한다. */
export function toMarkdown(m, links = {}) {
  const L = [];
  const pdf = m.links.pdf;
  L.push(MARKER);
  L.push(`## QA Test Completion Report · ${stage(m)}`);
  L.push('');
  L.push(`**Verdict: ${m.verdict.label}**  `);
  L.push(md(m.verdict.reason));
  L.push('');
  L.push('| Document ID | Version | Test item | Commit | Evidence run | Prepared |');
  L.push('|---|---|---|---|---|---|');
  L.push(`| ${m.id} | ${m.version} | ${m.pr ? `#${m.pr.number}` : '—'} | \`${(m.sha ?? '').slice(0, 7)}\` | ${links.run ? `[CI #${m.run?.id}](${links.run})` : '—'} | GitHub Actions · ${date(m.generatedAt)} |`);
  L.push('');
  if (pdf) {
    L.push(`**PDF:** [${m.id} v${m.version}.pdf](${pdf})${links.report ? ` · [workflow run](${links.report})` : ''}`);
    if (m.links.cover) L.push('', `<a href="${pdf}"><img src="${m.links.cover}" width="320" alt="${m.id} v${m.version} cover"></a>`);
    L.push('');
  }
  L.push('### 1. Summary of Testing Performed');
  const total = (m.unit?.tests ?? 0) + (m.e2e?.total ?? 0) + (m.smoke?.total ?? 0);
  L.push(`단위 ${m.unit?.tests ?? 0} · API/UI ${m.e2e?.total ?? 0}${m.smoke ? ` · 운영 스모크 ${m.smoke.total}` : ''}, 모두 ${total}개를 실행했다. 요구사항 ${m.requirements.length}개를 ${Object.keys(m.projects).length}개 기기 프로젝트에서 확인했다. GitHub-hosted runner(ubuntu-24.04)에서 운영과 같은 이미지로 띄운 Docker 테스트 환경을 썼다.`);
  L.push('');
  L.push('### 2. Deviations from Planned Testing');
  L.push(m.deviations.length ? m.deviations.map((d) => `- ${md(d)}`).join('\n') : '- None');
  L.push('');
  L.push('### 3. Test Completion Evaluation');
  L.push('| Exit criterion | Target | Actual | Status |', '|---|---|---|---|');
  for (const c of m.criteria) L.push(`| ${c.name} | ${md(c.target)} | ${md(c.actual)} | ${c.met ? 'Met' : '**Not met**'} |`);
  L.push('');
  L.push('### 4. Factors that Blocked Progress');
  L.push(m.blockers.length ? m.blockers.slice(0, 15).map((b) => `- ${md(b)}`).join('\n') : '- None');
  L.push('');
  L.push('### 5. Test Measures');
  L.push('| Area | Metric | Value |', '|---|---|---|');
  for (const [a, b, c] of measures(m)) L.push(`| ${a} | ${md(b)} | ${md(c)} |`);
  L.push('');
  L.push('**Results by requirement**', '', '| ID | Requirement | Verified by | Passed | Status |', '|---|---|---|---|---|');
  for (const r of m.requirements) L.push(`| ${r.id} | ${md(r.name)} | ${r.via} | ${r.passed}/${r.total} | ${REQ[r.status]} |`);
  L.push('');
  L.push('**Results by device**', '', '| Project | Engine | Passed | Failed | Flaky | Duration |', '|---|---|---|---|---|---|');
  for (const [key, s] of Object.entries(m.projects)) L.push(`| ${PROJECTS[key]?.[0] ?? key} | ${PROJECTS[key]?.[1] ?? '—'} | ${s.passed} | ${s.failed} | ${s.flaky} | ${sec(s.durationMs)} |`);
  L.push('');
  L.push('<details><summary><b>6. Defects · 7. Residual Risks · 8. Test Deliverables · 9. Reusable Test Assets · 10. Lessons Learned</b></summary>', '');
  L.push('### 6. Defects');
  L.push(`Register ${m.defects.length} (resolved ${m.defects.filter((d) => d.status === '해결').length}) · Open bug issues ${m.openBugs.length} · Found in: ${foundSummary(m)}`, '');
  L.push('| ID | Description | Severity | Found in | Status |', '|---|---|---|---|---|');
  for (const d of m.defects) L.push(`| ${d.id} | ${md(d.summary)} | ${d.severity} | ${en(FOUND, d.foundIn)} | ${en(STATE, d.status)} ${d.ref ?? ''} |`);
  for (const b of m.openBugs) L.push(`| #${b.number} | ${md(b.title)} | — | Issue | Open |`);
  L.push('');
  L.push('### 7. Residual Risks');
  L.push('| ID | Risk | Severity | Mitigation | Status |', '|---|---|---|---|---|');
  for (const r of m.risks) L.push(`| ${r.id} | ${md(r.risk)} | ${r.severity} | ${md(r.mitigation)} | ${en(STATE, r.status)} |`);
  L.push('');
  L.push('### 8. Test Deliverables');
  L.push('| Deliverable | Location | Contents |', '|---|---|---|');
  L.push(`| CI run | ${links.run ? `[#${m.run?.id}](${links.run})` : '—'} | Job logs, Step Summary |`);
  L.push(`| e2e artifact | ${links.run ? `[Artifacts](${links.run}#artifacts)` : '—'} | HTML report, traces${m.kind === 'final' ? ', videos, screenshots' : ' (failures only)'} |`);
  L.push(`| quality-report artifact | ${links.run ? `[Artifacts](${links.run}#artifacts)` : '—'} | metrics.json, summary.md |`);
  L.push(`| QA report (PDF) | ${pdf ? `[${m.id} v${m.version}](${pdf})` : '—'} | Cover, approvals, revision history, evidence, test case appendix |`);
  L.push('');
  L.push('### 9. Reusable Test Assets');
  L.push('| Asset | Location | Purpose |', '|---|---|---|');
  for (const [a, b, c] of reusable) L.push(`| ${a} | \`${b}\` | ${c} |`);
  L.push('');
  L.push('### 10. Lessons Learned');
  L.push(m.lessons.map((x) => `- ${md(x)}`).join('\n') || '- None');
  L.push('', '</details>', '');
  L.push(`<details><summary><b>Appendix A. Test Case Results (${m.cases.length})</b></summary>`, '');
  L.push('| Req. | Test | Project | Result | Time |', '|---|---|---|---|---|');
  for (const c of [...m.cases].sort(byRequirement)) L.push(`| ${c.requirements.join(' ')} | ${md(c.title)} | ${c.project} | ${STATUS[c.status] ?? c.status} | ${sec(c.durationMs)} |`);
  L.push('', '</details>', '');
  L.push(`<sub>Structure: ISO/IEC/IEEE 29119-3 Test Completion Report · Traceability: \`docs/quality/test-cases.md\` · ${m.kind === 'pr' ? 'PR CI가 다시 돌면 이 댓글을 갱신하고, 머지 후 배포·운영 스모크 결과로 v1.0을 덧붙인다. 이 보고서는 필수 체크가 아니어서 머지를 막지 않는다.' : '머지 후 배포와 운영 스모크까지 확인한 v1.0이다.'}</sub>`);
  return L.join('\n');
}

/** A4 문서. image(path)는 증거 그림을 data URI로 바꾼다(없으면 null). */
export function toHtml(m, links = {}, image = () => null) {
  const ok = (yes, text) => `<span class="chip${yes ? '' : ' bad'}">${text}</span>`;
  const table = (head, rows, numeric = []) => `<table><thead><tr>${head.map((x, i) => `<th${numeric.includes(i) ? ' class="n"' : ''}>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const figures = m.evidence.map((e) => ({ ...e, src: image(e.path) })).filter((e) => e.src);
  const total = (m.unit?.tests ?? 0) + (m.e2e?.total ?? 0) + (m.smoke?.total ?? 0);
  const link = (url) => (url ? `<a href="${h(url)}">${h(url)}</a>` : '—');
  // 저장된 이전 판(qa-reports 브랜치의 history.json) + 이번 판
  const history = [...m.history.filter((x) => x.version !== m.version), { version: m.version, date: m.generatedAt, note: m.kind === 'pr' ? `PR stage report (CI #${m.run?.id ?? '—'})` : `Post-merge: deployment and production smoke (CI #${m.run?.id ?? '—'})` }];

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${h(m.id)} Test Completion Report</title>
<style>${CSS}</style></head><body>
<section class="cover">
  <div class="org">${h(m.id)} · v${h(m.version)}</div>
  <div class="titleblock">
    <h1>Test Completion Report</h1>
    <p class="sub">Solveline · ${h(m.pr ? `PR #${m.pr.number} ${m.pr.title}` : 'Deployment commit')}<br>${stage(m)}</p>
  </div>
  <div class="verdict"><b>Verdict: ${h(m.verdict.label)}</b>${h(m.verdict.reason)}</div>
  <h3>Document Information</h3>
  ${table(['Field', 'Value'], [
    ['Document ID', h(m.id)],
    ['Document type', 'Test Completion Report (ISO/IEC/IEEE 29119-3)'],
    ['Version', h(m.version)],
    ['Test item', h(m.pr ? `${m.repo ?? ''} PR #${m.pr.number} · commit ${(m.sha ?? '').slice(0, 7)}` : (m.sha ?? '').slice(0, 7))],
    ['Evidence run', link(links.run)],
    ['Generated', `${h(date(m.generatedAt))} · GitHub Actions`],
  ])}
  <h3>Review and Approval</h3>
  ${table(['Role', 'Name', 'Date', 'Note'], [
    ['Prepared', 'QA report workflow', h(date(m.generatedAt)), 'Generated'],
    ['Reviewed', h(m.pr?.author ?? '—'), h(date(m.pr?.updatedAt)), 'PR author'],
    ['Approved', h(m.pr?.mergedBy ?? '—'), h(date(m.pr?.mergedAt)), m.pr?.mergedBy ? 'Merged' : 'Pending merge'],
  ])}
  <h3>Revision History</h3>
  ${table(['Version', 'Date', 'Description'], history.map((x) => [h(x.version), h(date(x.date)), h(x.note)]))}
</section>

<section class="pb">
  <h2>1. Introduction</h2>
  <p><b>Purpose.</b> 변경이 요구사항 R1~R${m.requirements.length}을 지키는지 확인하고, 머지 판단과 배포 확인의 근거를 남긴다.</p>
  <p><b>Scope.</b> REST API(계약·권한·채점·데이터 분리·입력 검증), UI(둘러보기·풀이·자동 저장·편집 모드·관리자), 기기 5종(데스크톱 Chrome·Safari, iPhone, Pixel, iPad), 접근성, 정적 분석, 운영 스모크. 실제 Google 로그인·실기기 키보드·부하는 범위 밖이다(RR-04, RR-05).</p>
  <p><b>References.</b> docs/quality/strategy.md, docs/quality/test-cases.md, docs/quality/qa-register.json</p>

  <h2>2. Summary of Testing Performed</h2>
  <p>단위 ${m.unit?.tests ?? 0} · API/UI ${m.e2e?.total ?? 0}${m.smoke ? ` · 운영 스모크 ${m.smoke.total}` : ''}, 모두 <b>${total}개</b>를 실행했다. GitHub-hosted runner(ubuntu-24.04)에서 운영과 같은 이미지로 Docker 테스트 환경을 띄우고, 테스트마다 새 사용자와 데이터를 만들었다.</p>
  ${table(['Level', 'Tool', 'Scope', 'Executed'], [
    ['Unit', 'Vitest', '설정·저장소·마이그레이션·권한 규칙', m.unit?.tests ?? '—'],
    ['API', 'Playwright request', '계약·권한 결정표·채점 상태 전이·경계값·데이터 분리', m.projects.api?.total ?? '—'],
    ['UI', 'Playwright browser', '사용자 여정·반응형·접근성', m.e2e ? m.e2e.total - (m.projects.api?.total ?? 0) : '—'],
    ['Production smoke', 'Playwright', '배포 후 핵심 경로(읽기 전용)', m.smoke?.total ?? (m.kind === 'pr' ? 'After merge' : '—')],
    ['Static analysis', 'SonarQube', '버그·취약점·중복·커버리지 게이트', '—'],
  ], [3])}

  <h2>3. Deviations from Planned Testing</h2>
  ${m.deviations.length ? `<ul>${m.deviations.map((d) => `<li>${h(d)}</li>`).join('')}</ul>` : '<p>None</p>'}

  <h2>4. Test Completion Evaluation</h2>
  ${table(['Exit criterion', 'Target', 'Actual', 'Status'], m.criteria.map((c) => [h(c.name), h(c.target), h(c.actual), ok(c.met, c.met ? 'Met' : 'Not met')]))}

  <h2>5. Factors that Blocked Progress</h2>
  ${m.blockers.length ? `<ul>${m.blockers.map((b) => `<li>${h(b)}</li>`).join('')}</ul>` : '<p>None</p>'}
</section>

<section>
  <h2>6. Test Measures</h2>
  ${table(['Area', 'Metric', 'Value'], measures(m).map(([a, b, c]) => [h(a), h(b), h(c)]))}
  <h3>6.1 Results by Requirement</h3>
  ${table(['ID', 'Requirement', 'Risk', 'Verified by', 'Passed', 'Status'], m.requirements.map((r) => [r.id, h(r.name), h(en(RISK, r.risk)), r.via, `${r.passed}/${r.total}`, ok(r.status !== 'failed', REQ[r.status])]), [4])}
  <h3>6.2 Results by Device</h3>
  ${table(['Project', 'Engine', 'Passed', 'Failed', 'Flaky', 'Duration'], Object.entries(m.projects).map(([k, s]) => [h(PROJECTS[k]?.[0] ?? k), h(PROJECTS[k]?.[1] ?? '—'), s.passed, s.failed, s.flaky, sec(s.durationMs)]), [2, 3, 4, 5])}
  ${m.e2e?.slowest?.length ? `<h3>6.3 Slowest Tests</h3><ul>${m.e2e.slowest.map((t) => `<li>${sec(t.durationMs)} · ${h(t.project)} · ${h(t.title)}</li>`).join('')}</ul>` : ''}
</section>

<section>
  <h2>7. Defects</h2>
  <p>Register ${m.defects.length} (resolved ${m.defects.filter((d) => d.status === '해결').length}) · Open bug issues ${m.openBugs.length} · Found in: ${h(foundSummary(m))}</p>
  ${table(['ID', 'Description', 'Severity', 'Found in', 'Fix', 'Status'], [
    ...m.defects.map((d) => [d.id, h(d.summary), d.severity, h(en(FOUND, d.foundIn)), h(d.fix), `${ok(d.status === '해결', en(STATE, d.status))} ${h(d.ref ?? '')}`]),
    ...m.openBugs.map((b) => [`#${b.number}`, h(b.title), '—', 'Issue', '—', ok(false, 'Open')]),
  ])}
  <h2>8. Residual Risks</h2>
  ${table(['ID', 'Risk', 'Severity', 'Mitigation', 'Status'], m.risks.map((r) => [r.id, h(r.risk), r.severity, h(r.mitigation), h(en(STATE, r.status))]))}
  <h2>9. Test Deliverables</h2>
  ${table(['Deliverable', 'Location', 'Contents'], [
    ['CI run', link(links.run), 'Job logs, Step Summary'],
    ['e2e · quality-report artifacts', links.run ? link(`${links.run}#artifacts`) : '—', `HTML report, traces${m.kind === 'final' ? ', videos, screenshots' : ''}, metrics JSON`],
    ['PR comment', m.pr?.url ? link(m.pr.url) : '—', 'Same verdict and measures as this document'],
    ['This document (PDF)', link(m.links.pdf), 'Versioned on the qa-reports branch'],
  ])}
  <h2>10. Reusable Test Assets</h2>
  ${table(['Asset', 'Location', 'Purpose'], reusable.map(([a, b, c]) => [h(a), h(b), h(c)]))}
  <h2>11. Lessons Learned</h2>
  <ul>${m.lessons.map((x) => `<li>${h(x)}</li>`).join('')}</ul>
</section>

${figures.length ? `<section class="pb"><h2>Appendix A. Execution Evidence</h2><p>근거 실행에서 테스트가 남긴 화면이다. 그림 설명은 테스트 코드의 증거 이름이다.</p>
<div class="figs">${figures.map((f, i) => `<figure><img src="${f.src}" alt=""><figcaption><b>Figure ${i + 1}.</b> ${h(f.caption)} <span class="muted">(${h(f.project)})</span></figcaption></figure>`).join('')}</div></section>` : ''}

<section class="pb">
  <h2>Appendix ${figures.length ? 'B' : 'A'}. Test Case Results</h2>
  ${table(['Req.', 'Test', 'Project', 'Result', 'Time'], [...m.cases].sort(byRequirement).map((c) => [c.requirements.join(' '), h(c.title), h(c.project), ok(c.status === 'expected', STATUS[c.status] ?? h(c.status)), sec(c.durationMs)]), [4])}
</section>
</body></html>`;
}

const CSS = `
@page { size: A4; margin: 22mm 18mm 20mm; }
:root { --fg:#000; --sub:#444; --line:#000; --hair:#9a9a9a; --head:#e9e9e9; }
* { box-sizing:border-box; }
html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { margin:0; color:var(--fg); font:9.5pt/1.65 "Noto Sans CJK KR","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif; }
h1 { font-size:22pt; font-weight:700; margin:0; letter-spacing:.02em; }
h2 { font-size:12pt; font-weight:700; margin:8mm 0 2.5mm; padding-bottom:1mm; border-bottom:.8pt solid var(--line); break-after:avoid; }
section > h2:first-child { margin-top:0; }
h3 { font-size:10pt; font-weight:700; margin:5mm 0 1.5mm; break-after:avoid; }
p { margin:0 0 2mm; } ul { margin:0 0 2mm; padding-left:5mm; } li { margin:.3mm 0; }
a { color:inherit; text-decoration:none; word-break:break-all; }
.pb { break-before:page; }
table { width:100%; border-collapse:collapse; margin:1mm 0 3mm; font-size:8.5pt; border-top:.9pt solid var(--line); border-bottom:.9pt solid var(--line); }
thead { display:table-header-group; } tr { break-inside:avoid; }
th, td { border:.4pt solid var(--hair); border-left:0; border-right:0; padding:1.3mm 2mm; text-align:left; vertical-align:top; }
th { background:var(--head); font-weight:700; border-bottom:.6pt solid var(--line); }
td:first-child { white-space:nowrap; }
.n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.chip { font-weight:400; white-space:nowrap; }
.chip.bad { font-weight:700; text-decoration:underline; }
.muted { color:var(--sub); }
.cover .org { font-size:9pt; color:var(--sub); text-align:right; }
.cover .titleblock { text-align:center; margin:30mm 0 18mm; }
.cover h1 { font-size:26pt; }
.cover .sub { font-size:11pt; color:var(--sub); margin-top:4mm; text-align:center; }
.verdict { border:.9pt solid var(--line); padding:3mm 4mm; margin:0 0 5mm; }
.verdict b { display:block; font-size:11pt; margin-bottom:1mm; }
.cover td:first-child { width:30mm; font-weight:700; }
.figs { display:grid; grid-template-columns:1fr 1fr; gap:5mm 4mm; }
figure { margin:0; break-inside:avoid; }
figure img { width:100%; max-height:95mm; object-fit:contain; object-position:left top; border:.4pt solid var(--hair); display:block; }
figcaption { font-size:8pt; margin-top:1mm; }
`;
