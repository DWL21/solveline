import type { Db } from './db-node.ts';

/** D1 마이그레이션 파일(migrations/0001_schema.sql)의 경로. wrangler.toml의 migrations_dir와 맞춘다 */
export const D1_SCHEMA_FILE = 'migrations/0001_schema.sql';

/** 마이그레이션이 넣는 기본 행(데이터라 스키마에 나오지 않는다). 마이그레이션에 기본 행을 더하면 여기도 더한다 */
const SEED = ['INSERT INTO signup_settings (id, enabled) VALUES (1, 1);'];

/**
 * 마이그레이션을 모두 적용한 SQLite의 스키마를 D1에 그대로 만들 SQL로 뽑는다.
 * 생성 순서(rowid)대로 테이블·색인·트리거를 쓴다. 마이그레이션 기록 표(_migrations)와 SQLite 내부 표는 뺀다.
 */
export function schemaSql(db: Db): string {
  const rows = db
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY rowid")
    .pluck()
    .all() as string[];
  return [
    '-- 자동 생성: pnpm --filter @solveline/api d1:schema (apps/api/src/db-node.ts의 마이그레이션 결과). 직접 고치지 않는다.',
    ...rows.map((s) => `${s.trim()};`),
    ...SEED,
    '',
  ].join('\n');
}
