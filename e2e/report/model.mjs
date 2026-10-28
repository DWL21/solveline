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
    return { ...r, ...stats, via: own.length ? 'CI 자동화' : r.id === 'R11' ? '운영 스모크' : '—', status };
  });

  const cov = unit?.coverage;
  const covOk = cov && Object.entries(thresholds).every(([k, v]) => (cov[k] ?? -1) >= v);
  const criteria = [
    { name: '단위 테스트 전부 통과', target: '실패 0', actual: unit ? `${unit.tests - unit.failed}/${unit.tests}` : '자료 없음', met: !!unit && unit.failed === 0 && unit.tests > 0 },
    { name: '커버리지 기준 이상', target: Object.entries(thresholds).map(([k, v]) => `${label(k)} ${v}%`).join(' · ') || '—', actual: cov ? `줄 ${fmt(cov.lines)} · 분기 ${fmt(cov.branches)} · 함수 ${fmt(cov.functions)} · 문장 ${fmt(cov.statements)}` : '자료 없음', met: !!covOk },
    { name: 'API·UI 자동화 전부 통과', target: '실패 0', actual: e2e ? `${e2e.passed}/${e2e.total}` : '자료 없음', met: !!e2e && e2e.failed === 0 && e2e.total - e2e.skipped > 0 },
    { name: '불안정 테스트 없음', target: '0건', actual: e2e ? `${e2e.flaky}건` : '자료 없음', met: !!e2e && e2e.flaky === 0 },
    { name: '정적 분석 품질 게이트', target: 'OK', actual: sonar?.gate ?? '자료 없음', met: sonar?.gate === 'OK' },
    { name: '요구사항별 실패 없음', target: '실패 0', actual: `${reqRows.filter((r) => r.status === 'failed').length}개 실패`, met: reqRows.length > 0 && reqRows.every((r) => r.status !== 'failed') },
    { name: 'CI 잡 전부 성공', target: '전부 success', actual: jobs.length ? `${jobs.filter((j) => j.conclusion === 'success').length}/${jobs.length}` : '자료 없음', met: jobs.length > 0 && jobs.every((j) => j.conclusion === 'success') },
  ];
  if (kind === 'final') {
    criteria.push(
      { name: '운영 배포 성공', target: 'success', actual: context.deploy?.conclusion ?? '자료 없음', met: context.deploy?.conclusion === 'success' },
      { name: '배포 후 운영 스모크 통과', target: '실패 0', actual: smokeResult ? `${smokeResult.passed}/${smokeResult.total}` : '자료 없음', met: !!smokeResult && smokeResult.failed === 0 && smokeResult.total > 0 },
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
    ...jobs.filter((j) => j.conclusion !== 'success').map((j) => `CI 잡 실패: ${j.name} (${j.conclusion ?? '진행 중'})`),
    ...(e2e?.failedTests ?? []).map((t) => `실패: [${t.project}] ${t.file} › ${t.title}`),
    ...(e2e?.flakyTests ?? []).map((t) => `불안정: [${t.project}] ${t.file} › ${t.title} (재시도 ${t.retries}회)`),
    ...(kind === 'final' && context.deploy && context.deploy.conclusion !== 'success' ? [`운영 배포: ${context.deploy.conclusion ?? '끝나지 않음'}`] : []),
  ];

  const openRisks = (register.risks ?? []).filter((r) => r.status === '열림');
  const failed = criteria.some((c) => !c.met);
  const verdict = failed
    ? { status: 'fail', label: kind === 'pr' ? '머지 보류' : '출시 후 조치 필요' }
    : openRisks.length
      ? { status: 'conditional', label: kind === 'pr' ? '머지 가능(조건부)' : '출시 확인(조건부)' }
      : { status: 'pass', label: kind === 'pr' ? '머지 가능' : '출시 확인' };
  verdict.reason = failed
    ? `종료 기준 ${criteria.filter((c) => !c.met).length}개를 충족하지 못했다: ${criteria.filter((c) => !c.met).map((c) => c.name).join(', ')}`
    : `종료 기준 ${criteria.length}개를 모두 충족했다.${openRisks.length ? ` 열린 잔여 위험 ${openRisks.length}건은 출시를 막지 않는 수준이며 개선 일정으로 관리한다.` : ''}`;

  const defects = register.defects ?? [];
  const foundIn = {};
  for (const d of defects) foundIn[d.foundIn] = (foundIn[d.foundIn] ?? 0) + 1;

  const pr = context.pr ?? null;
  return {
    kind,
    id: `QA-TCR-${pr ? `PR${pr.number}` : (context.sha ?? 'local').slice(0, 7)}-${kind === 'final' ? 'F' : 'P'}`,
    version: kind === 'final' ? '1.0' : `0.${context.run?.attempt ?? 1}`,
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

const label = (k) => ({ lines: '줄', branches: '분기', functions: '함수', statements: '문장' })[k] ?? k;
export const fmt = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
