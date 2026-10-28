import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 네트워크·Docker 없이 실제 셸 흐름을 검사한다. 외부 명령만 대체하고 JSON 처리·분기는 그대로 실행한다.
function run(status) {
  const cwd = mkdtempSync(join(tmpdir(), 'solveline-sonar-'));
  const bin = join(cwd, 'bin');
  try {
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    mkdirSync(join(cwd, 'apps/api'), { recursive: true });
    mkdirSync(join(cwd, 'apps/judge'), { recursive: true });
    mkdirSync(bin);
    copyFileSync(new URL('./sonar.sh', import.meta.url), join(cwd, 'scripts/sonar.sh'));
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
    stub('docker', 'exit 0');
    stub('openssl', 'echo fixture-random');
    stub('sleep', 'exit 0');
    stub('seq', 'echo 1'); // 대기 한도를 줄여 timeout 경로도 즉시 검증한다.
    stub('pnpm', `if [ "\${1:-}" = exec ]; then
      mkdir -p .scannerwork
      echo 'ceTaskId=fixture-task' > .scannerwork/report-task.txt
    fi`);
    stub('curl', `printf '%s\\n' "$*" >> "$QA_REQUESTS"
    case "$*" in
      *api/user_tokens/generate*) echo '{"token":"fixture-token"}';;
      *api/qualitygates/create_condition*) echo '{}';;
      *api/qualitygates/create*) echo '{"name":"Fixture"}';;
      *api/ce/task?id=fixture-task*) printf '{"task":{"status":"%s"}}\\n' "$QA_TASK_STATUS";;
      *api/ce/component*) echo '잘못된 프로젝트 단위 조회' >&2; exit 1;;
      *api/qualitygates/project_status*) echo '{"projectStatus":{"status":"OK","conditions":[]}}';;
      *api/measures/component*) echo '{"component":{"measures":[]}}';;
      *api/issues/search*) echo '{"issues":[],"facets":[]}';;
      *) echo '{}';;
    esac`);
    const r = spawnSync('bash', ['scripts/sonar.sh'], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_TASK_STATUS: status, QA_REQUESTS: join(cwd, 'requests'), SONAR_KEEP: '0' },
    });
    return { ...r, requests: readFileSync(join(cwd, 'requests'), 'utf8'), hasReport: existsSync(join(cwd, 'reports/quality/sonar.json')) };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('Sonar는 이번 ceTaskId의 SUCCESS 이후에만 품질 결과를 조회한다', () => {
  const r = run('SUCCESS');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.requests, /api\/ce\/task\?id=fixture-task/);
  assert.equal(r.hasReport, true);
});
for (const status of ['FAILED', 'CANCELED', 'PENDING']) {
  test(`Sonar 작업 ${status}는 성공 지표를 조회하지 않고 실패한다`, () => {
    const r = run(status);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.requests, /api\/qualitygates\/project_status/);
    assert.equal(r.hasReport, false);
    assert.match(r.stdout + r.stderr, status === 'PENDING' ? /시간 초과/ : /분석 작업 실패/);
  });
}
