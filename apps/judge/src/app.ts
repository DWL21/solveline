import type Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { HiddenCases, JudgeJob, JUDGE_PAYLOAD_HEADER, judgeHeaders, verifyJudge, verifyJudgeUnsigned, type JudgeStatus, type Runtime, type TestCase } from '@solveline/shared';
import { Dispatcher, isTerminal, JobStore } from './jobs.ts';
import type { TestsetMirror } from './mirror.ts';
import { CaseInputError, validateCases, type RunnerClient } from './runner.ts';
import type { TestsetStore } from './testsets.ts';
import { log } from './redact.ts';

type Runner = Pick<RunnerClient, 'run' | 'runtime' | 'cancel'>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type JudgeDeps = {
  db: Database.Database;
  runners: Runner[];
  slotsPerRunner: number;
  testsets: TestsetStore;
  /** API와 나눠 가진 서명 비밀 */
  secret: string;
  /** 결과를 보낼 API 주소(예: https://solveline.simplyimg.com). null이면 보내지 않는다(긴 조회로만 전달) */
  resultsUrl: string | null;
  /** 결과 전송에 쓰는 fetch(테스트에서 API 앱으로 바로 보낸다) */
  fetch?: Fetch;
  /** 테스트셋 R2 원본. 없으면 로컬 파일만 */
  mirror?: TestsetMirror | null;
};

const RESULTS_PATH = '/api/internal/judge/results';
const fail = (c: Context, status: 400 | 401 | 404 | 409 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);

/**
 * judge: 제출 대기열과 runner 실행만 맡는다(사용자 데이터 없음). 모든 경로는 API와의 HMAC 서명이 있어야 한다.
 * 끝난 작업은 API에 결과를 보내고, 실패하면 보낼 목록에 남겨 다시 보낸다.
 */
export function createJudge(deps: JudgeDeps) {
  const jobs = new JobStore(deps.db);
  const dispatcher = new Dispatcher(jobs, deps.testsets, deps.runners as RunnerClient[], deps.slotsPerRunner);
  const send: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const app = new Hono();

  app.onError((err, c) => {
    log.error(`[judge] ${c.req.path}`, err);
    return c.json({ error: { code: 'internal', message: '요청을 처리하지 못했습니다.' } }, 500);
  });

  // 상태 확인(컨테이너 healthcheck)만 서명 없이 연다
  app.get('/health', (c) => c.json({ data: { status: 'up' } }));

  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname + url.search;
    const header = (n: string) => c.req.header(n);
    // 큰 히든 테스트셋은 본문 없이 서명해 보낸다(Worker가 해시하지 않도록). 그 경로에서만 받는다.
    if (c.req.header(JUDGE_PAYLOAD_HEADER) === 'unsigned') {
      if (c.req.method === 'PUT' && url.pathname === '/testsets' && (await verifyJudgeUnsigned(deps.secret, header, c.req.method, path))) return next();
      return fail(c, 401, 'bad_signature', '서명이 올바르지 않습니다.');
    }
    const body = c.req.method === 'GET' ? '' : await c.req.raw.clone().text();
    if (!(await verifyJudge(deps.secret, header, c.req.method, path, body))) return fail(c, 401, 'bad_signature', '서명이 올바르지 않습니다.');
    return next();
  });

  /** 긴 조회 대기 시간(?wait=초, 최대 25초) */
  const waitMs = (c: Context) => Math.min(25, Math.max(0, Number(c.req.query('wait')) || 0)) * 1000;

  /** 테스트셋이 로컬에 없으면 R2에서 받는다 */
  const loadTestset = async (hash: string): Promise<TestCase[] | null> => {
    if (deps.testsets.raw(hash) === null) await deps.mirror?.load(hash);
    return deps.testsets.get(hash);
  };

  app.get('/runtime', async (c) => {
    const all = await Promise.all(deps.runners.map((r) => r.runtime()));
    return c.json({ data: all.find((r) => r.runner === 'up') ?? all[0] ?? ({ runner: 'down', versions: { java: null, python: null } } satisfies Runtime) });
  });

  app.post('/jobs', async (c) => {
    const parsed = JudgeJob.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid_request', '작업 형식이 올바르지 않습니다.');
    const job = parsed.data;
    let cases: TestCase[];
    if (job.testsetHash) {
      const loaded = await loadTestset(job.testsetHash);
      if (!loaded) return fail(c, 409, 'testset_missing', '테스트셋 파일이 없습니다.');
      cases = loaded;
    } else cases = job.cases ?? [];
    if (!cases.length) return fail(c, 400, 'no_cases', '실행할 테스트 케이스가 없습니다.');
    if (job.kind === 'submit' && cases.some((x) => !x.expected.trim()))
      return fail(c, 400, 'no_expected', job.testsetHash ? '기댓값이 없는 히든 케이스가 있습니다.' : '채점하려면 기댓값이 있는 테스트 케이스가 필요합니다.');
    try {
      validateCases(job.mode, cases);
    } catch (e) {
      if (e instanceof CaseInputError) return fail(c, 400, 'invalid_case', e.message);
      throw e;
    }
    jobs.insert(job, cases.map((x) => x.id));
    dispatcher.kick();
    const s = (await dispatcher.poll(job.id, waitMs(c)))!;
    return c.json({ data: s }, isTerminal(s.status) ? 200 : 202);
  });

  app.get('/jobs/:id', async (c) => {
    const s = await dispatcher.poll(c.req.param('id'), waitMs(c));
    return s ? c.json({ data: s }) : fail(c, 404, 'not_found', '없는 작업입니다.');
  });

  app.post('/jobs/:id/cancel', async (c) => {
    const s = await dispatcher.cancel(c.req.param('id'));
    return s ? c.json({ data: s }) : fail(c, 404, 'not_found', '없는 작업입니다.');
  });

  // ─── 히든 테스트셋: API가 편집 권한을 확인한 뒤 본문을 그대로 넘긴다(Worker CPU 제한 때문에 여기서 해석한다) ───
  app.put('/testsets', async (c) => {
    const parsed = HiddenCases.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid_request', '히든 케이스 형식이 올바르지 않습니다.');
    const cases = parsed.data.cases.map((x) => ({ ...x, hidden: true }));
    const ref = cases.length ? deps.testsets.put(cases) : null;
    // R2에 올린 뒤 답한다(내구성). 실패하면 API가 다시 시도할 수 있도록 오류로 돌려준다.
    if (ref && deps.mirror) await deps.mirror.upload(ref.hash);
    // 참조는 헤더로도 준다. ?echo=1이면 본문은 저장한 케이스({data:{cases}})라 Worker가 해석하지 않고 그대로 넘길 수 있다.
    c.header('x-testset-hash', ref?.hash ?? 'none');
    c.header('x-testset-count', String(ref?.count ?? 0));
    return c.req.query('echo') ? c.json({ data: { cases } }) : c.json({ data: ref });
  });

  app.get('/testsets/:hash', async (c) => {
    const cases = await loadTestset(c.req.param('hash'));
    return cases ? c.json({ data: { cases } }) : fail(c, 404, 'not_found', '없는 테스트셋입니다.');
  });

  // ─── 결과 전달(콜백) ───
  /** 보내지 못한 결과를 모두 보낸다. 겹쳐 불러도 차례로 돈다(앞의 전송이 끝난 뒤 남은 것을 보낸다). 보낸 개수 */
  const run = async (): Promise<number> => {
    if (!deps.resultsUrl) return 0;
    let sent = 0;
    for (const s of jobs.undelivered()) {
      if (!(await post(s))) break;
      jobs.markDelivered(s.id);
      sent++;
    }
    return sent;
  };
  let chain: Promise<number> = Promise.resolve(0);
  const deliver = (): Promise<number> => (chain = chain.then(run, run));
  const post = async (s: JudgeStatus) => {
    const body = JSON.stringify(s);
    try {
      const res = await send(`${deps.resultsUrl}${RESULTS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await judgeHeaders(deps.secret, 'POST', RESULTS_PATH, body)) },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      // 404: API에 없는 제출(지워짐)이면 더 보내지 않는다
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  };
  dispatcher.onFinished = () => void deliver();

  let timer: NodeJS.Timeout | null = null;
  return {
    app,
    jobs,
    dispatcher,
    deliver,
    start() {
      dispatcher.start();
      void deliver();
      // 보내지 못한 결과를 10초마다 다시 보내고, 하루 지난 작업은 지운다
      timer = setInterval(() => {
        void deliver();
        jobs.prune(new Date(Date.now() - 24 * 3600_000));
      }, 10_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
