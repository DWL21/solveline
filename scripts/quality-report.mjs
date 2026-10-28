#!/usr/bin/env node
// 품질 지표 리포트: 흩어진 결과를 모아 한 장으로 만든다(사람용 Markdown + 기계용 JSON).
//   입력(--strict이면 모두 필수, 로컬 부분 집계에서는 누락을 표시한다)
//     apps/api/coverage/coverage-summary.json   단위 테스트 커버리지(vitest)
//     apps/api/reports/junit.xml                단위 테스트 결과
//     e2e/reports/results.json                  API·UI 자동화 결과(Playwright)
//     reports/quality/sonar.json                정적 분석·품질 게이트(SonarQube)
//   출력
//     reports/quality/metrics.json  추세 비교용(빌드마다 아티팩트로 보관)
//     reports/quality/summary.md    CI 요약(GitHub Actions Step Summary)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const strict = process.argv.includes('--strict');
const problems = [];
const missing = [];
const read = (path) => {
  if (!existsSync(path)) {
    missing.push(`누락: ${path}`);
    return null;
  }
  return readFileSync(path, 'utf8');
};
const json = (path, valid = () => true) => {
  const value = read(path);
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!valid(parsed)) throw new Error();
    return parsed;
  }
  catch { problems.push(`읽기 실패: ${path}`); return null; }
};
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ─── 단위 테스트 ───
let cov = json('apps/api/coverage/coverage-summary.json', (v) => v?.total && ['lines', 'branches', 'functions', 'statements'].every((k) => Number.isFinite(v.total[k]?.pct)))?.total ?? null;
if (cov && !['lines', 'branches', 'functions', 'statements'].every((k) => Number.isFinite(cov[k]?.pct) && cov[k].pct >= 0 && cov[k].pct <= 100)) {
  problems.push('읽기 실패: 커버리지 수치');
  cov = null;
}
const junit = read('apps/api/reports/junit.xml');
const unit = (() => {
  if (junit === null) return null;
  const root = /<testsuites\b([^>]*)>/.exec(junit)?.[1] ?? '';
  const attrs = Object.fromEntries([...root.matchAll(/([\w]+)=["']([^"']*)["']/g)].map((m) => [m[1], Number(m[2])]));
  if (!['tests', 'failures', 'errors', 'time'].every((k) => Number.isFinite(attrs[k]) && attrs[k] >= 0)) {
    problems.push('읽기 실패: 단위 JUnit 속성');
    return null;
  }
  return { tests: attrs.tests, failed: attrs.failures + attrs.errors, skipped: attrs.skipped ?? 0, durationMs: attrs.time * 1000 };
})();

// ─── 자동화(Playwright) ───
const validTest = (t) => t && typeof t.projectName === 'string'
  && (t.results === undefined || (Array.isArray(t.results) && t.results.every((r) => r && Number.isFinite(r.duration))))
  && (t.annotations === undefined || (Array.isArray(t.annotations) && t.annotations.every((a) => a && typeof a.type === 'string')));
const validSuite = (suite) => suite && typeof suite === 'object'
  && (suite.suites === undefined || (Array.isArray(suite.suites) && suite.suites.every(validSuite)))
  && (suite.specs === undefined || (Array.isArray(suite.specs) && suite.specs.every((spec) => spec && Array.isArray(spec.tests) && spec.tests.every(validTest))));
const pw = json('e2e/reports/results.json', (v) => Array.isArray(v?.suites) && validSuite(v) && (v.errors === undefined || Array.isArray(v.errors)));
const e2e = pw
  ? (() => {
      const tests = [];
      const walk = (suite, file) => {
        for (const s of suite.suites ?? []) walk(s, s.file ?? file);
        for (const spec of suite.specs ?? [])
          for (const t of spec.tests ?? []) {
            const results = t.results ?? [];
            tests.push({
              title: spec.title,
              file: spec.file ?? file,
              requirements: (Array.isArray(spec.tags) ? spec.tags : []).map((tag) => String(tag).replace(/^@/, '')).filter((tag) => /^R\d+$/.test(tag)), // JSON 리포트는 태그를 @ 없이 준다
              project: t.projectName,
              status: t.status, // expected | unexpected | flaky | skipped
              retries: Math.max(0, results.length - 1),
              durationMs: results.reduce((a, r) => a + (r.duration ?? 0), 0),
              a11y: (t.annotations ?? []).find((a) => a.type === 'a11y')?.description,
            });
          }
      };
      walk(pw, undefined);
      if (tests.some((t) => !['expected', 'unexpected', 'flaky', 'skipped'].includes(t.status))) problems.push('읽기 실패: Playwright 테스트 상태');
      const byProject = {};
      for (const t of tests) {
        const p = (byProject[t.project] ??= { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0 });
        p.total++;
        p.durationMs += t.durationMs;
        if (t.status === 'expected') p.passed++;
        else if (t.status === 'unexpected') p.failed++;
        else if (t.status === 'flaky') p.flaky++;
        else p.skipped++;
      }
      // 요구사항 추적: 테스트마다 @R 태그가 있어야 하고, 태그가 여럿이면 각 요구사항에 센다(docs/quality/test-cases.md)
      const byRequirement = {};
      for (const t of tests)
        for (const r of t.requirements) {
          const s = (byRequirement[r] ??= { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 });
          s.total++;
          if (t.status === 'expected') s.passed++;
          else if (t.status === 'unexpected') s.failed++;
          else if (t.status === 'flaky') s.flaky++;
          else s.skipped++;
        }
      const executed = tests.filter((t) => t.status !== 'skipped');
      return {
        total: tests.length,
        passed: tests.filter((t) => t.status === 'expected').length,
        failed: tests.filter((t) => t.status === 'unexpected').length,
        flaky: tests.filter((t) => t.status === 'flaky').length,
        skipped: tests.length - executed.length,
        globalErrors: pw.errors?.length ?? 0,
        executed: executed.length,
        passRate: executed.length ? (executed.filter((t) => t.status !== 'unexpected').length / executed.length) * 100 : null,
        firstTryPassRate: executed.length ? (executed.filter((t) => t.status === 'expected').length / executed.length) * 100 : null,
        wallMs: pw.stats?.duration ?? null,
        byProject,
        byRequirement,
        untraced: tests.filter((t) => t.requirements.length === 0),
        slowest: [...tests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
        flakyTests: tests.filter((t) => t.status === 'flaky'),
        failedTests: tests.filter((t) => t.status === 'unexpected'),
        a11y: tests.filter((t) => t.a11y).map((t) => ({ title: t.title, project: t.project, violations: t.a11y })),
      };
    })()
  : null;

// ─── 정적 분석 ───
const sonar = json('reports/quality/sonar.json', (v) => typeof v?.gate === 'string');
const rating = (v) => (v ? 'ABCDE'[Math.round(+v) - 1] : '—');

// 상위 잡 상태까지 확인한다. 커버리지 문턱 실패 등은 JUnit만으로 판별할 수 없다.
const jobs = { check: process.env.QUALITY_CHECK_RESULT, docker: process.env.QUALITY_DOCKER_RESULT, secret: process.env.QUALITY_SECRET_RESULT, unit: process.env.QUALITY_UNIT_RESULT, static: process.env.QUALITY_STATIC_RESULT, e2e: process.env.QUALITY_E2E_RESULT };
for (const [job, result] of Object.entries(jobs)) {
  if (result && result !== 'success') problems.push(`상위 잡 ${job}: ${result}`);
}
if (unit && (unit.failed || unit.tests - unit.skipped === 0)) problems.push('단위 테스트 실패 또는 실행 0건');
if (e2e) {
  if (e2e.failed) problems.push(`자동화 실패: ${e2e.failed}건`);
  if (e2e.flaky) problems.push(`자동화 불안정: ${e2e.flaky}건`);
  if (e2e.globalErrors) problems.push(`자동화 전역 오류: ${e2e.globalErrors}건`);
  if (e2e.untraced.length) problems.push(`요구사항 태그 없음: ${[...new Set(e2e.untraced.map((t) => `${t.file} › ${t.title}`))].slice(0, 5).join(', ')}`);
  // 프로젝트 삭제·잘못된 태그로 전체 기기 검사가 사라지는 회귀도 잡는다.
  for (const project of ['api', 'desktop-chromium', 'desktop-webkit', 'mobile-iphone', 'mobile-pixel', 'tablet-ipad']) {
    const stats = e2e.byProject[project];
    if (!stats || stats.total === stats.skipped) problems.push(`자동화 프로젝트 실행 누락: ${project}`);
  }
}
if (sonar && sonar.gate !== 'OK') problems.push(`Sonar 품질 게이트: ${sonar.gate ?? '없음'}`);
const gate = {
  status: problems.length || (strict && missing.length) ? 'failed' : missing.length ? 'incomplete' : 'passed',
  strict, problems: [...missing, ...problems],
};

const metrics = {
  gate,
  jobs,
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
  unit: unit && { ...unit, coverage: cov && { lines: cov.lines.pct, branches: cov.branches.pct, functions: cov.functions.pct, statements: cov.statements.pct } },
  e2e: e2e && { total: e2e.total, passed: e2e.passed, failed: e2e.failed, flaky: e2e.flaky, skipped: e2e.skipped, globalErrors: e2e.globalErrors, passRate: e2e.passRate, firstTryPassRate: e2e.firstTryPassRate, wallMs: e2e.wallMs, byProject: e2e.byProject, byRequirement: e2e.byRequirement },
  sonar: sonar && { gate: sonar.gate, measures: sonar.measures, issues: sonar.issues },
};

// ─── 사람용 요약 ───
const lines = ['# 품질 리포트', '', `품질 판정: ${gate.status === 'passed' ? '✅ 통과' : gate.status === 'failed' ? '❌ 실패' : '⚠️ 불완전'}`, ''];
if (gate.problems.length) lines.push(...gate.problems.map((p) => `- ${p}`), '');
lines.push('| 영역 | 지표 | 값 |', '|---|---|---|');
if (unit) lines.push(`| 단위 | 테스트 | ${unit.tests - unit.failed}/${unit.tests} 통과 (${sec(unit.durationMs)}) |`);
if (cov) lines.push(`| 단위 | 커버리지 줄·분기 | ${pct(cov.lines.pct)} · ${pct(cov.branches.pct)} |`);
if (e2e) {
  lines.push(`| 자동화 | 통과율(재시도 포함) | ${pct(e2e.passRate)} (${e2e.passed + e2e.flaky}/${e2e.executed}) |`);
  lines.push(`| 자동화 | 첫 시도 통과율 | ${pct(e2e.firstTryPassRate)} |`);
  lines.push(`| 자동화 | 불안정(flaky) | ${e2e.flaky}개 |`);
  if (e2e.wallMs) lines.push(`| 자동화 | 소요 시간 | ${sec(e2e.wallMs)} |`);
}
if (sonar) {
  const m = sonar.measures ?? {};
  lines.push(`| 정적 분석 | 품질 게이트 | ${sonar.gate === 'OK' ? '✅ 통과' : '❌ ' + sonar.gate} |`);
  lines.push(`| 정적 분석 | 신뢰성·보안·유지보수 등급 | ${rating(m.reliability_rating)} · ${rating(m.security_rating)} · ${rating(m.sqale_rating)} |`);
  lines.push(`| 정적 분석 | 버그·취약점·코드 스멜 | ${m.bugs ?? '—'} · ${m.vulnerabilities ?? '—'} · ${m.code_smells ?? '—'} |`);
  lines.push(`| 정적 분석 | 중복·기술 부채 | ${pct(m.duplicated_lines_density)} · ${m.sqale_index ? Math.round(m.sqale_index / 60) + '시간' : '—'} |`);
}
if (e2e) {
  lines.push('', '## 실행 단위별', '', '| 프로젝트 | 통과 | 실패 | 불안정 | 건너뜀 | 시간 |', '|---|---|---|---|---|---|');
  for (const [p, s] of Object.entries(e2e.byProject)) lines.push(`| ${p} | ${s.passed} | ${s.failed} | ${s.flaky} | ${s.skipped} | ${sec(s.durationMs)} |`);
  const reqs = Object.entries(e2e.byRequirement).sort(([a], [b]) => +a.slice(1) - +b.slice(1));
  if (reqs.length) {
    lines.push('', '## 요구사항별', '', '| 요구사항 | 통과 | 실패 | 불안정 | 건너뜀 |', '|---|---|---|---|---|');
    for (const [r, s] of reqs) lines.push(`| ${r} | ${s.passed}/${s.total} | ${s.failed} | ${s.flaky} | ${s.skipped} |`);
  }
  if (e2e.failedTests.length) {
    lines.push('', '## 실패', '');
    for (const t of e2e.failedTests) lines.push(`- \`${t.project}\` ${t.file} › ${t.title}`);
  }
  if (e2e.flakyTests.length) {
    lines.push('', '## 불안정(재시도로 통과) — 격리·원인 분석 대상', '');
    for (const t of e2e.flakyTests) lines.push(`- \`${t.project}\` ${t.file} › ${t.title} (재시도 ${t.retries}회)`);
  }
  lines.push('', '## 가장 느린 테스트', '');
  for (const t of e2e.slowest) lines.push(`- ${sec(t.durationMs)} \`${t.project}\` ${t.title}`);
  if (e2e.a11y.length) {
    lines.push('', '## 접근성(axe) 위반 — critical은 실패, 나머지는 추세 관리', '');
    for (const a of e2e.a11y) lines.push(`- \`${a.project}\` ${a.title}: ${a.violations}`);
  }
}
const md = lines.join('\n') + '\n';

mkdirSync('reports/quality', { recursive: true });
writeFileSync('reports/quality/metrics.json', JSON.stringify(metrics, null, 2));
writeFileSync('reports/quality/summary.md', md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
process.stdout.write(md);

if (strict && gate.status !== 'passed') process.exitCode = 1;
