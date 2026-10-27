#!/usr/bin/env node
// 품질 지표 리포트: 흩어진 결과를 모아 한 장으로 만든다(사람용 Markdown + 기계용 JSON).
//   입력(있는 것만 읽는다)
//     apps/api/coverage/coverage-summary.json   단위 테스트 커버리지(vitest)
//     apps/api/reports/junit.xml                단위 테스트 결과
//     e2e/reports/results.json                  API·UI 자동화 결과(Playwright)
//     reports/quality/sonar.json                정적 분석·품질 게이트(SonarQube)
//   출력
//     reports/quality/metrics.json  추세 비교용(빌드마다 아티팩트로 보관)
//     reports/quality/summary.md    CI 요약(GitHub Actions Step Summary)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const json = (p) => {
  const t = read(p);
  return t ? JSON.parse(t) : null;
};
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ─── 단위 테스트 ───
const cov = json('apps/api/coverage/coverage-summary.json')?.total ?? null;
const junit = read('apps/api/reports/junit.xml');
const unit = junit
  ? (() => {
      const m = /<testsuites[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"[^>]*time="([\d.]+)"/.exec(junit);
      return m ? { tests: +m[1], failed: +m[2] + +m[3], durationMs: +m[4] * 1000 } : null;
    })()
  : null;

// ─── 자동화(Playwright) ───
const pw = json('e2e/reports/results.json');
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
              project: t.projectName,
              status: t.status, // expected | unexpected | flaky | skipped
              retries: Math.max(0, results.length - 1),
              durationMs: results.reduce((a, r) => a + (r.duration ?? 0), 0),
              a11y: (t.annotations ?? []).find((a) => a.type === 'a11y')?.description,
            });
          }
      };
      walk(pw, undefined);
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
      const executed = tests.filter((t) => t.status !== 'skipped');
      return {
        total: tests.length,
        passed: tests.filter((t) => t.status === 'expected').length,
        failed: tests.filter((t) => t.status === 'unexpected').length,
        flaky: tests.filter((t) => t.status === 'flaky').length,
        executed: executed.length,
        passRate: executed.length ? (executed.filter((t) => t.status !== 'unexpected').length / executed.length) * 100 : null,
        firstTryPassRate: executed.length ? (executed.filter((t) => t.status === 'expected').length / executed.length) * 100 : null,
        wallMs: pw.stats?.duration ?? null,
        byProject,
        slowest: [...tests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
        flakyTests: tests.filter((t) => t.status === 'flaky'),
        failedTests: tests.filter((t) => t.status === 'unexpected'),
        a11y: tests.filter((t) => t.a11y).map((t) => ({ title: t.title, project: t.project, violations: t.a11y })),
      };
    })()
  : null;

// ─── 정적 분석 ───
const sonar = json('reports/quality/sonar.json');
const rating = (v) => (v ? 'ABCDE'[Math.round(+v) - 1] : '—');

const metrics = {
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
  unit: unit && { ...unit, coverage: cov && { lines: cov.lines.pct, branches: cov.branches.pct, functions: cov.functions.pct, statements: cov.statements.pct } },
  e2e: e2e && { total: e2e.total, passed: e2e.passed, failed: e2e.failed, flaky: e2e.flaky, passRate: e2e.passRate, firstTryPassRate: e2e.firstTryPassRate, wallMs: e2e.wallMs, byProject: e2e.byProject },
  sonar: sonar && { gate: sonar.gate, measures: sonar.measures, issues: sonar.issues },
};

// ─── 사람용 요약 ───
const lines = ['# 품질 리포트', ''];
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
  lines.push('', '## 실행 단위별', '', '| 프로젝트 | 통과 | 실패 | 불안정 | 시간 |', '|---|---|---|---|---|');
  for (const [p, s] of Object.entries(e2e.byProject)) lines.push(`| ${p} | ${s.passed} | ${s.failed} | ${s.flaky} | ${sec(s.durationMs)} |`);
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
