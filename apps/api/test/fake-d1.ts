import type Database from 'better-sqlite3';
import type { D1Like, Param } from '../src/sql.ts';

/** better-sqlite3 위에 D1 바인딩 모양(prepare·bind·all·first·run·batch)만 흉내 낸다. D1 어댑터 검증용. */
export function fakeD1(db: Database.Database): D1Like & { calls: number } {
  const fake = {
    calls: 0,
    prepare(sql: string) {
      return {
        bind(...params: Param[]) {
          const s = db.prepare(sql);
          const run = () => ({ meta: { changes: s.run(...params).changes } });
          return {
            async all<T>() {
              fake.calls++;
              return { results: (s.reader ? s.all(...params) : (run(), [])) as T[] };
            },
            async first<T>() {
              fake.calls++;
              return (s.get(...params) as T | undefined) ?? null;
            },
            async run() {
              fake.calls++;
              return run();
            },
            _run: run,
          };
        },
      };
    },
    async batch(statements: ReturnType<ReturnType<D1Like['prepare']>['bind']>[]) {
      fake.calls++;
      return db.transaction(() => statements.map((st) => (st as unknown as { _run: () => { meta: { changes: number } } })._run()))();
    },
  };
  return fake;
}
