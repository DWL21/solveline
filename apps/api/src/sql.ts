import type Database from 'better-sqlite3';

/**
 * 저장소가 쓰는 SQL 실행 계층. 같은 SQLite 문법을 Node(better-sqlite3: 테스트·로컬 개발)와
 * Cloudflare D1(Worker)에서 똑같이 실행한다. 매개변수는 ?로만 넘긴다(D1은 이름 붙은 매개변수를 받지 않는다).
 * D1에는 대화형 트랜잭션이 없으므로, 한꺼번에 반영해야 하는 쓰기는 batch로 묶는다.
 */
export type Param = string | number | null;
export type Stmt = { sql: string; params: Param[] };
export const stmt = (sql: string, ...params: Param[]): Stmt => ({ sql, params });

export interface Sql {
  all<T>(sql: string, ...params: Param[]): Promise<T[]>;
  get<T>(sql: string, ...params: Param[]): Promise<T | undefined>;
  /** 첫 행의 첫 열 */
  value<T>(sql: string, ...params: Param[]): Promise<T | undefined>;
  /** 모든 행의 첫 열 */
  column<T>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  /** 모두 반영되거나 하나도 반영되지 않는다 */
  batch(stmts: Stmt[]): Promise<{ changes: number }[]>;
}

/** UNIQUE 제약 위반(better-sqlite3·D1 모두 메시지에 남긴다) */
export const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/.test(e.message);

export function sqliteSql(db: Database.Database): Sql {
  const first = (row: unknown) => (row === undefined ? undefined : Object.values(row as Record<string, unknown>)[0]);
  return {
    all: async <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as T[],
    get: async <T>(sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as T | undefined,
    value: async <T>(sql: string, ...params: Param[]) => first(db.prepare(sql).get(...params)) as T | undefined,
    column: async <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params).map(first) as T[],
    run: async (sql: string, ...params: Param[]) => ({ changes: db.prepare(sql).run(...params).changes }),
    batch: async (stmts: Stmt[]) => db.transaction(() => stmts.map((s) => ({ changes: db.prepare(s.sql).run(...s.params).changes })))(),
  };
}

/** Cloudflare D1 바인딩의 필요한 부분(타입 패키지 없이 쓴다) */
export type D1Like = {
  prepare(sql: string): {
    bind(...params: Param[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: ReturnType<ReturnType<D1Like['prepare']>['bind']>[]): Promise<{ meta: { changes: number } }[]>;
};

export function d1Sql(d1: D1Like): Sql {
  const bound = (sql: string, params: Param[]) => d1.prepare(sql).bind(...params);
  const first = (row: unknown) => (row === null || row === undefined ? undefined : Object.values(row as Record<string, unknown>)[0]);
  return {
    all: async <T>(sql: string, ...params: Param[]) => (await bound(sql, params).all<T>()).results,
    get: async <T>(sql: string, ...params: Param[]) => (await bound(sql, params).first<T>()) ?? undefined,
    value: async <T>(sql: string, ...params: Param[]) => first(await bound(sql, params).first()) as T | undefined,
    column: async <T>(sql: string, ...params: Param[]) => (await bound(sql, params).all<Record<string, unknown>>()).results.map(first) as T[],
    run: async (sql: string, ...params: Param[]) => ({ changes: (await bound(sql, params).run()).meta.changes }),
    batch: async (stmts: Stmt[]) => (stmts.length ? (await d1.batch(stmts.map((s) => bound(s.sql, s.params)))).map((r) => ({ changes: r.meta.changes })) : []),
  };
}
