// QA 테스트 완료 보고서 모델. ISO/IEC/IEEE 29119-3의 Test Completion Report 구성을 따른다.
//   수행한 테스트 요약 · 계획 대비 차이 · 완료 평가 · 진행을 막은 요인 · 측정치 · 잔여 위험 · 산출물 · 재사용 자산 · 교훈
// 입력은 CI 아티팩트와 저장소 문서만 쓰고, 브라우저 없이 계산한다(단위 테스트 대상).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (path) => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/** docs/quality/test-cases.md의 요구사항 표(| R1 | 내용 | 위험 | …) */
export function parseRequirements(markdown) {
  const rows = [];
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*(R\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (m) rows.push({ id: m[1], name: m[2], risk: m[3] });
  }
  return rows;
}

/** apps/api/vitest.config.ts의 커버리지 기준(thresholds: { lines: 80, … }) */
export function parseThresholds(source) {
  const block = /thresholds:\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/(\w+):\s*(\d+(?:\.\d+)?)/g)].map(([, k, v]) => [k, Number(v)]));
}

/** Playwright JSON 리포트 → 실행 단위 목록. 증거 첨부(evidence: …)는 아티팩트 안의 상대 경로로 바꾼다. */
export function parseCases(results) {
  const cases = [];
  // describe 경로를 제목 앞에 붙인다(예: 권한 결정표 › guest › 문제 만들기 → 401). 파일 단위 suite는 뺀다.
  const walk = (suite, file, path) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file, s.title && s.title !== s.file ? [...path, s.title] : path);
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const runs = t.results ?? [];
        const last = runs.at(-1);
        cases.push({
          title: [...path, spec.title].join(' › ').replace(/\s@\w+/g, ''), // 기기 태그(@cross 등)는 기기 열로 보인다
          file: spec.file ?? file,
          project: t.projectName,
          status: t.status,
          durationMs: runs.reduce((a, r) => a + (r.duration ?? 0), 0),
          requirements: (spec.tags ?? []).map((tag) => String(tag).replace(/^@/, '')).filter((tag) => /^R\d+$/.test(tag)),
          evidence: (last?.attachments ?? [])
            .filter((a) => a.name?.startsWith('evidence: ') && a.path)
            .map((a) => ({ caption: a.name.slice('evidence: '.length), path: relativeArtifact(a.path) }))
            .filter((a) => a.path),
        });
      }
  };
  if (results) walk(results, undefined, []);
  return cases;
}

const relativeArtifact = (path) => {
  const i = path.replaceAll('\\', '/').lastIndexOf('reports/');
  return i < 0 ? null : path.replaceAll('\\', '/').slice(i + 'reports/'.length);
};

const count = (list) => ({
  total: list.length,
  passed: list.filter((c) => c.status === 'expected').length,
  failed: list.filter((c) => c.status === 'unexpected').length,
  flaky: list.filter((c) => c.status === 'flaky').length,
  skipped: list.filter((c) => c.status === 'skipped').length,
});

const smokeStats = (smoke) => {
  const s = smoke?.stats;
  if (!s) return null;
  const total = (s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0) + (s.skipped ?? 0);
  return { total, passed: s.expected ?? 0, failed: s.unexpected ?? 0, flaky: s.flaky ?? 0, skipped: s.skipped ?? 0 };
};

/**
 * @param input  CI 아티팩트 디렉터리(quality-report/, e2e/, context.json, smoke.json)
 * @param repo   저장소 루트(docs/quality/*, apps/api/vitest.config.ts)
 */
export function loadReport(input, repo) {
  const context = readJson(join(input, 'context.json')) ?? {};
  const metrics = readJson(join(input, 'quality-report/metrics.json'));
  const results = readJson(join(input, 'e2e/results.json'));
  const smoke = readJson(join(input, 'smoke.json'));
  const register = readJson(join(repo, 'docs/quality/qa-register.json')) ?? { defects: [], risks: [], lessons: [] };
  const requirementsMd = existsSync(join(repo, 'docs/quality/test-cases.md')) ? readFileSync(join(repo, 'docs/quality/test-cases.md'), 'utf8') : '';
  const vitest = existsSync(join(repo, 'apps/api/vitest.config.ts')) ? readFileSync(join(repo, 'apps/api/vitest.config.ts'), 'utf8') : '';
  return buildModel({ context, metrics, results, smoke, register, requirements: parseRequirements(requirementsMd), thresholds: parseThresholds(vitest) });
}

export function buildModel({ context, metrics, results, smoke, register, requirements, thresholds }) {
  const kind = context.kind === 'final' ? 'final' : 'pr';
  const cases = parseCases(results);
  const smokeResult = smokeStats(smoke);
  const unit = metrics?.unit ?? null;
  const e2e = metrics?.e2e ?? null;
  const sonar = metrics?.sonar ?? null;
  const jobs = context.run?.jobs ?? [];

  const reqRows = requirements.map((r) => {
    const own = cases.filter((c) => c.requirements.includes(r.id));
    // 운영 스모크만으로 확인하는 요구사항(R11)은 머지 후 보고서에서 스모크 결과로 채운다
    const stats = own.length ? count(own) : r.id === 'R11' && smokeResult ? smokeResult : count([]);
    const status = stats.total === 0 ? 'notRun' : stats.failed || stats.flaky ? 'failed' : stats.passed === stats.total ? 'passed' : 'partial';
    return { ...r, ...stats, via: own.length ? 'CI automation' : r.id === 'R11' ? 'Production smoke' : '—', status };
  });

  const cov = unit?.coverage;
  const covOk = cov && Object.entries(thresholds).every(([k, v]) => (cov[k] ?? -1) >= v);
  const criteria = [
    { name: 'Unit tests all pass', target: '0 failed', actual: unit ? `${unit.tests - unit.failed}/${unit.tests}` : NO_DATA, met: !!unit && unit.failed === 0 && unit.tests > 0 },
    { name: 'Coverage thresholds met', target: Object.entries(thresholds).map(([k, v]) => `${label(k)} ${v}%`).join(' · ') || '—', actual: cov ? `lines ${fmt(cov.lines)} · branches ${fmt(cov.branches)} · functions ${fmt(cov.functions)} · statements ${fmt(cov.statements)}` : NO_DATA, met: !!covOk },
    { name: 'API/UI automation all pass', target: '0 failed', actual: e2e ? `${e2e.passed}/${e2e.total}` : NO_DATA, met: !!e2e && e2e.failed === 0 && e2e.total - e2e.skipped > 0 },
    { name: 'No flaky tests', target: '0', actual: e2e ? `${e2e.flaky}` : NO_DATA, met: !!e2e && e2e.flaky === 0 },
    { name: 'Static analysis quality gate', target: 'OK', actual: sonar?.gate ?? NO_DATA, met: sonar?.gate === 'OK' },
    { name: 'No failing requirement', target: '0 failed', actual: `${reqRows.filter((r) => r.status === 'failed').length} failed`, met: reqRows.length > 0 && reqRows.every((r) => r.status !== 'failed') },
    { name: 'All CI jobs succeeded', target: 'all success', actual: jobs.length ? `${jobs.filter((j) => j.conclusion === 'success').length}/${jobs.length}` : NO_DATA, met: jobs.length > 0 && jobs.every((j) => j.conclusion === 'success') },
  ];
  if (kind === 'final') {
    criteria.push(
      { name: 'Production deployment succeeded', target: 'success', actual: context.deploy?.conclusion ?? NO_DATA, met: context.deploy?.conclusion === 'success' },
      { name: 'Post-deploy production smoke passed', target: '0 failed', actual: smokeResult ? `${smokeResult.passed}/${smokeResult.total}` : NO_DATA, met: !!smokeResult && smokeResult.failed === 0 && smokeResult.total > 0 },
    );
  }

  const deviations = [];
  if (!metrics) deviations.push('품질 리포트 아티팩트가 없어 측정치를 채우지 못했다');
  if (!results) deviations.push('자동화 결과(results.json)가 없어 테스트 케이스 목록을 채우지 못했다');
  if (e2e?.skipped) deviations.push(`건너뛴 테스트 ${e2e.skipped}개`);
  for (const r of reqRows.filter((r) => r.status === 'notRun'))
    deviations.push(r.id === 'R11' && kind === 'pr' ? `${r.id}(운영 가용성)은 머지 후 배포가 끝난 뒤 운영 스모크로 확인한다` : `${r.id}를 확인한 테스트가 없다`);
  if (kind === 'final' && !cases.some((c) => c.evidence.length)) deviations.push('시연 증거(스크린샷)가 없다');
  if (kind === 'final' && !smokeResult) deviations.push('배포 후 운영 스모크 결과가 없다');

  const blockers = [
    ...jobs.filter((j) => j.conclusion !== 'success').map((j) => `CI job ${j.conclusion ?? 'in progress'}: ${j.name}`),
    ...(e2e?.failedTests ?? []).map((t) => `Failed: [${t.project}] ${t.file} › ${t.title}`),
    ...(e2e?.flakyTests ?? []).map((t) => `Flaky: [${t.project}] ${t.file} › ${t.title} (retries ${t.retries})`),
    ...(kind === 'final' && context.deploy && context.deploy.conclusion !== 'success' ? [`Production deployment: ${context.deploy.conclusion ?? 'not finished'}`] : []),
  ];

  const openRisks = (register.risks ?? []).filter((r) => r.status === '열림');
  const failed = criteria.some((c) => !c.met);
  const verdict = failed
    ? { status: 'fail', label: kind === 'pr' ? 'Merge Blocked' : 'Action Required' }
    : openRisks.length
      ? { status: 'conditional', label: kind === 'pr' ? 'Ready to Merge (Conditional)' : 'Release Verified (Conditional)' }
      : { status: 'pass', label: kind === 'pr' ? 'Ready to Merge' : 'Release Verified' };
  verdict.reason = failed
    ? `종료 기준 ${criteria.filter((c) => !c.met).length}개를 충족하지 못했다: ${criteria.filter((c) => !c.met).map((c) => c.name).join(', ')}`
    : `종료 기준 ${criteria.length}개를 모두 충족했다.${openRisks.length ? ` 열린 잔여 위험 ${openRisks.length}건은 출시를 막지 않는 수준이며 개선 일정으로 관리한다.` : ''}`;

  const defects = register.defects ?? [];
  const foundIn = {};
  for (const d of defects) foundIn[d.foundIn] = (foundIn[d.foundIn] ?? 0) + 1;

  const pr = context.pr ?? null;
  return {
    kind,
    // PR 하나에 보고서 하나: PR 단계는 0.x(커밋마다 올림), 머지 후 배포 확인은 1.0
    id: `QA-TCR-${pr ? `PR${pr.number}` : (context.sha ?? 'local').slice(0, 7)}`,
    version: context.version ?? (kind === 'final' ? '1.0' : '0.1'),
    history: context.history ?? [],
    links: context.links ?? {},
    generatedAt: context.generatedAt ?? new Date().toISOString(),
    repo: context.repo ?? null,
    sha: context.sha ?? null,
    pr,
    run: context.run ?? null,
    deploy: context.deploy ?? null,
    openBugs: context.openBugs ?? [],
    verdict,
    criteria,
    deviations,
    blockers,
    unit,
    e2e,
    sonar,
    smoke: smokeResult,
    requirements: reqRows,
    projects: e2e?.byProject ?? {},
    cases,
    evidence: cases.flatMap((c) => c.evidence.map((e) => ({ ...e, test: c.title, project: c.project }))),
    defects,
    foundIn,
    risks: register.risks ?? [],
    lessons: register.lessons ?? [],
  };
}

const label = (k) => k;
const NO_DATA = 'no data';
export const fmt = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
