import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./quality-report.mjs', import.meta.url));
const projects = ['api', 'desktop-chromium', 'desktop-webkit', 'mobile-iphone', 'mobile-pixel', 'tablet-ipad'];
const junitPath = 'apps/api/reports/junit.xml';
const coveragePath = 'apps/api/coverage/coverage-summary.json';
const pwPath = 'e2e/reports/results.json';
const sonarPath = 'reports/quality/sonar.json';
const passed = () => ({
  suites: [{ specs: projects.map((projectName) => ({ title: projectName, tests: [{ projectName, status: 'expected', results: [{ status: 'passed', duration: 10 }] }] })) }],
  errors: [], stats: { duration: 100 },
});
const inputs = () => ({
  [junitPath]: '<testsuites tests="4" failures="0" errors="0" time="0.5"></testsuites>',
  [coveragePath]: { total: Object.fromEntries(['lines', 'branches', 'functions', 'statements'].map((k) => [k, { pct: 85 }])) },
  [pwPath]: passed(),
  [sonarPath]: { gate: 'OK', measures: {} },
});
function run(files, { strict = true, env = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'solveline-quality-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), typeof body === 'string' ? body : JSON.stringify(body));
    }
    const result = spawnSync(process.execPath, [script, ...(strict ? ['--strict'] : [])], {
      cwd, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', QUALITY_CHECK_RESULT: '', QUALITY_DOCKER_RESULT: '', QUALITY_SECRET_RESULT: '', QUALITY_UNIT_RESULT: '', QUALITY_STATIC_RESULT: '', QUALITY_E2E_RESULT: '', ...env },
    });
    return { ...result, metrics: JSON.parse(readFileSync(join(cwd, 'reports/quality/metrics.json'), 'utf8')), summary: readFileSync(join(cwd, 'reports/quality/summary.md'), 'utf8') };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('모든 영역이 통과하면 엄격 게이트가 통과한다', () => {
  const r = run(inputs());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.metrics.gate.status, 'passed');
});
for (const path of [junitPath, coveragePath, pwPath, sonarPath]) {
  test(`${path} 누락은 실패하면서 진단 리포트를 남긴다`, () => {
    const files = inputs();
    delete files[path];
    const r = run(files);
    assert.equal(r.status, 1);
    assert.match(r.summary, /누락/);
  });
}
for (const path of [coveragePath, pwPath, sonarPath]) {
  test(`${path} 손상은 실패하면서 나머지 결과를 보존한다`, () => {
    const r = run({ ...inputs(), [path]: '{broken' });
    assert.equal(r.status, 1);
    assert.equal(r.metrics.unit.tests, 4);
    assert.match(r.summary, /읽기 실패/);
  });
}
test('JUnit 속성 순서와 작은따옴표가 달라도 실패 수를 읽는다', () => {
  const r = run({ ...inputs(), [junitPath]: "<testsuites time='1.25' errors='1' failures='2' tests='4'></testsuites>" });
  assert.equal(r.status, 1);
  assert.equal(r.metrics.unit.failed, 3);
  assert.equal(r.metrics.unit.durationMs, 1250);
});
test('읽을 수 없는 JUnit은 성공으로 취급하지 않는다', () => {
  const r = run({ ...inputs(), [junitPath]: '<testsuites></testsuites>' });
  assert.equal(r.status, 1);
});
for (const status of ['flaky', 'unexpected', 'skipped']) {
  test(`자동화 ${status}만 있는 프로젝트는 차단한다`, () => {
    const pw = passed();
    pw.suites[0].specs[0].tests[0].status = status;
    const r = run({ ...inputs(), [pwPath]: pw });
    assert.equal(r.status, 1);
  });
}
test('자동화 전역 오류는 개별 테스트가 통과해도 차단한다', () => {
  const pw = { ...passed(), errors: [{ message: 'global teardown failed' }] };
  assert.equal(run({ ...inputs(), [pwPath]: pw }).status, 1);
});
test('프로젝트 하나가 빠지면 차단한다', () => {
  const pw = passed();
  pw.suites[0].specs.pop();
  assert.equal(run({ ...inputs(), [pwPath]: pw }).status, 1);
});
test('Sonar 게이트 실패를 차단한다', () => {
  assert.equal(run({ ...inputs(), [sonarPath]: { gate: 'ERROR' } }).status, 1);
});
test('상위 잡이 실패·취소·건너뛰기이면 정상 리포트만으로 성공하지 않는다', () => {
  for (const key of ['QUALITY_CHECK_RESULT', 'QUALITY_DOCKER_RESULT', 'QUALITY_SECRET_RESULT', 'QUALITY_UNIT_RESULT', 'QUALITY_STATIC_RESULT', 'QUALITY_E2E_RESULT']) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(run(inputs(), { env: { [key]: result } }).status, 1);
    }
  }
});
test('로컬 부분 집계는 허용하되 누락을 명시한다', () => {
  const r = run({}, { strict: false });
  assert.equal(r.status, 0);
  assert.equal(r.metrics.gate.status, 'incomplete');
  assert.match(r.summary, /누락/);
});

for (const [path, value] of [[coveragePath, {}], [pwPath, { suites: [{ specs: [{}] }] }], [sonarPath, null]]) {
  test(`${path}의 올바른 JSON도 스키마가 다르면 차단한다`, () => {
    const r = run({ ...inputs(), [path]: JSON.stringify(value) });
    assert.equal(r.status, 1);
    assert.match(r.summary, /읽기 실패/);
  });
}
