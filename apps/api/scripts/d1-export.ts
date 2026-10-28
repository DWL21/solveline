// 운영 SQLite → D1 넣기용 SQL(0007 5단계). 사용: node --import tsx scripts/d1-export.ts <solveline.db> <출력.sql>
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { exportForD1 } from '../src/d1-export.ts';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('사용: d1-export.ts <solveline.db> <출력.sql>');
  process.exit(2);
}
const db = new Database(src, { readonly: true, fileMustExist: true });
const { sql, rows } = exportForD1(db);
writeFileSync(dest, sql, { mode: 0o600 });
console.log(`D1 내보내기: ${Object.entries(rows).map(([t, n]) => `${t} ${n}`).join(', ')} (${(sql.length / 1e6).toFixed(1)}MB)`);
