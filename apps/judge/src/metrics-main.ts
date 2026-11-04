import Database from 'better-sqlite3';
import { join } from 'node:path';
import { collectMetrics } from './metrics.ts';

// 운영자용: judge.db를 읽기 전용으로 열어 지표를 JSON으로 출력한다(서명 없이 컨테이너 안에서만).
//   docker exec solveline-production-judge-1 node --import tsx src/metrics-main.ts
const env = process.env;
const slots = (env.RUNNER_URLS ?? 'http://127.0.0.1:8000').split(',').filter((u) => u.trim()).length * Math.max(1, Number(env.RUNNER_SLOTS) || 2);
const db = new Database(join(env.DATA_DIR ?? './data', 'judge', 'judge.db'), { readonly: true, fileMustExist: true });
console.log(JSON.stringify(collectMetrics(db, slots), null, 2));
db.close();
