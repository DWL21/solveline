import type { ObjectStore } from '@solveline/judge/r2';
import { createApp } from './app.ts';
import { sqlLimiters } from './auth/rate-limit.ts';
import { loadConfig } from './config.ts';
import { HttpJudge } from './judge.ts';
import { registerSecret } from './redact.ts';
import { d1Sql, type D1Like } from './sql.ts';

// Pages Worker에서 API를 실행한다(0007 3단계). apps/web/public/_worker.js가 API_MODE=worker이고 DB 바인딩이 있을 때만 부른다.
// 파일 시스템·프로세스 메모리가 없으므로 사용자 데이터는 D1, 공용 데이터는 R2 바인딩, 요청 제한은 D1 테이블, 실행은 judge(Tunnel)로 간다.

/** R2 바인딩의 필요한 부분(타입 패키지 없이 쓴다) */
export type R2BucketLike = {
  put(key: string, body: string | Uint8Array, opts: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
};

/** R2 바인딩을 그대로 쓰는 저장소(Worker 안이라 /api/internal/r2를 거치지 않는다) */
export class R2BindingStore implements ObjectStore {
  constructor(private bucket: R2BucketLike) {}

  async put(key: string, body: string | Uint8Array, meta: { contentType: string }) {
    await this.bucket.put(key, body, { httpMetadata: { contentType: meta.contentType } });
  }

  async get(key: string) {
    const obj = await this.bucket.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
}

/** Pages Worker의 env: 바인딩과 변수·비밀(문자열)이 섞여 있다 */
export type WorkerEnv = { DB: D1Like; CATALOG?: R2BucketLike } & Record<string, unknown>;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** env의 문자열 값만 환경 변수로 본다. Worker는 운영으로 간주한다(NODE_ENV를 따로 주지 않으면). */
const varsOf = (env: WorkerEnv) => {
  const vars: Record<string, string> = { NODE_ENV: 'production' };
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') vars[k] = v;
  return vars;
};

/** env마다 한 번 만든다(같은 격리 공간의 요청끼리 재사용). judgeFetch는 테스트에서 judge를 바로 붙일 때 쓴다. */
export function createWorkerApi(env: WorkerEnv, opts: { judgeFetch?: Fetch } = {}) {
  const config = loadConfig(varsOf(env));
  registerSecret(config.sessionSecret);
  registerSecret(config.google?.clientSecret);
  registerSecret(config.adminPassword);
  registerSecret(config.judgeSecret);
  const sql = d1Sql(env.DB);
  return createApp({
    config,
    sql,
    judge: new HttpJudge(config.judgeUrl, config.judgeSecret, opts.judgeFetch),
    objectStore: env.CATALOG ? new R2BindingStore(env.CATALOG) : null,
    limiters: sqlLimiters(sql),
  });
}

const apps = new WeakMap<object, ReturnType<typeof createWorkerApi>>();

/** _worker.js가 부르는 진입점 */
export function handleApi(request: Request, env: WorkerEnv): Response | Promise<Response> {
  let api = apps.get(env);
  if (!api) {
    api = createWorkerApi(env);
    apps.set(env, api);
  }
  return api.app.fetch(request);
}
