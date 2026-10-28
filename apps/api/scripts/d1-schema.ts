// 마이그레이션 결과로 D1 스키마 파일을 다시 만든다. --check면 파일과 다를 때 실패만 한다(CI·테스트).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db-node.ts';
import { D1_SCHEMA_FILE, schemaSql } from '../src/d1-schema.ts';

const file = fileURLToPath(new URL(`../${D1_SCHEMA_FILE}`, import.meta.url));
const sql = schemaSql(openDb(':memory:'));
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== sql) {
    console.error(`${D1_SCHEMA_FILE}가 마이그레이션과 다릅니다. pnpm --filter @solveline/api d1:schema 로 다시 만드세요.`);
    process.exit(1);
  }
} else {
  writeFileSync(file, sql);
  console.log(`${D1_SCHEMA_FILE} 생성`);
}
