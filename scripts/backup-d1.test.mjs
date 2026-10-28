import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 네트워크 없이 실제 셸 흐름을 검사한다. npx(wrangler)·age만 대체한다.
function run(env, { exportSql = 'CREATE TABLE users (id TEXT);\nINSERT INTO users VALUES (\'u\');\n' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'solveline-backup-'));
  const bin = join(cwd, 'bin');
  try {
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    mkdirSync(join(cwd, 'apps/api/d1'), { recursive: true });
    mkdirSync(bin);
    copyFileSync(new URL('./backup-d1.sh', import.meta.url), join(cwd, 'scripts/backup-d1.sh'));
    copyFileSync(new URL('../apps/api/d1/cleanup.sql', import.meta.url), join(cwd, 'apps/api/d1/cleanup.sql'));
    writeFileSync(join(cwd, 'export.sql'), exportSql);
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
    // npx --yes wrangler@x <명령…>: 호출을 남기고, export는 --output에 쓰고, r2 put은 올린 파일을 보관한다
    stub('npx', `printf '%s\\n' "$*" >> "$CALLS"
    shift 2
    out=""; file=""
    while [ $# -gt 0 ]; do
      case "$1" in --output) out=$2; shift;; --file) file=$2; shift;; esac
      shift
    done
    if [ -n "$out" ]; then cp "$EXPORT" "$out"; fi
    case "$file" in *.age) cp "$file" "$UPLOADED";; esac`);
    // age -r <공개 키> -o <출력> <입력>: 받는 사람과 함께 감싼다(실제 암호화는 아래 로컬 재현에서 확인)
    stub('age', `[ "$1" = -r ] && [ "$3" = -o ] || exit 9
    { printf 'AGE:%s\\n' "$2"; cat "$5"; } > "$4"`);
    const r = spawnSync('bash', ['scripts/backup-d1.sh'], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: { PATH: `${bin}:${process.env.PATH}`, CALLS: join(cwd, 'calls'), EXPORT: join(cwd, 'export.sql'), UPLOADED: join(cwd, 'uploaded'), ...env },
    });
    const calls = existsSync(join(cwd, 'calls')) ? readFileSync(join(cwd, 'calls'), 'utf8').trim().split('\n') : [];
    const uploaded = existsSync(join(cwd, 'uploaded')) ? readFileSync(join(cwd, 'uploaded'), 'utf8') : null;
    return { ...r, calls, uploaded };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const full = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'acc', D1_DATABASE: 'solveline', BACKUP_AGE_RECIPIENT: 'age1recipient' };

test('설정이 하나라도 없으면 아무것도 부르지 않고 성공으로 건너뛴다', () => {
  const r = run({ ...full, D1_DATABASE: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /건너뜁니다: D1_DATABASE/);
  assert.deepEqual(r.calls, []);
});

test('내보내고 암호화해 올린 뒤에 정리 SQL을 실행한다', () => {
  const r = run({ ...full, BACKUP_BUCKET: 'bk' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 3);
  assert.match(r.calls[0], /d1 export solveline --remote --output /);
  assert.match(r.calls[1], /r2 object put bk\/d1\/solveline-\d{4}-\d{2}-\d{2}\.sql\.age --file .*d1\.sql\.age --content-type application\/octet-stream --remote/);
  assert.match(r.calls[2], /d1 execute solveline --remote --file apps\/api\/d1\/cleanup\.sql --yes/);
  // 올린 것은 암호화 결과(받는 사람 공개 키로)이고, 비밀 값은 출력하지 않는다
  assert.match(r.uploaded, /^AGE:age1recipient\n/);
  assert.doesNotMatch(r.stdout + r.stderr, /token/);
});

test('내보낸 SQL이 비었거나 테이블이 없으면 올리지 않고 실패한다', () => {
  for (const exportSql of ['', 'SELECT 1;\n']) {
    const r = run(full, { exportSql });
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 1);
    assert.equal(r.uploaded, null);
  }
});
