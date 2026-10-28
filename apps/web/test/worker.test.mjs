import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../public/_worker.js';

const HOST = 'https://solveline.simplyimg.com';
const version = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** 엣지 캐시·API(fetch)·R2를 흉내 낸다. origin은 경로별 응답 본문, 부른 경로는 calls에 남는다. */
function setup({ origin = {}, r2 = null } = {}) {
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => void store.set(req.url, res),
    },
  };
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    calls.push({ path: url.pathname + url.search, cookie: req.headers.get('Cookie') });
    const body = origin[url.pathname];
    if (body === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', message: '없음' } }), { status: 404 });
    return new Response(body, { headers: { 'Content-Type': 'application/json', ETag: `"${version(body)}"` } });
  };
  const r2Reads = [];
  const env = {
    ASSETS: { fetch: async () => new Response('asset') },
    ...(r2 && {
      CATALOG_SOURCE: 'r2',
      CATALOG: {
        get: async (key) => {
          r2Reads.push(key);
          return key in r2 ? { text: async () => r2[key], httpEtag: `"r2-${version(r2[key])}"` } : null;
        },
      },
    }),
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (path, headers = {}) => {
    const res = await worker.fetch(new Request(`${HOST}${path}`, { headers }), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { call, calls, r2Reads };
}

const detail = JSON.stringify({ data: { id: 'p1', title: '두 수의 합' } });
const index = JSON.stringify({ data: { problems: [{ id: 'p1', version: version(detail) }], folders: [], collections: [] } });

test('R2가 없으면 카탈로그를 쿠키 없이 API에서 읽어 엣지에 캐시한다', async () => {
  const s = setup({ origin: { '/api/catalog/index': index, '/api/catalog/problems/p1': detail } });
  const first = await s.call('/api/catalog/index', { Cookie: 'solveline_session=abc' });
  assert.equal(first.status, 200);
  assert.equal(await first.text(), index);
  assert.match(first.headers.get('Cache-Control'), /max-age=60/);
  await s.call('/api/catalog/index');
  assert.deepEqual(s.calls, [{ path: '/api/catalog/index', cookie: null }]);

  // ETag가 같으면 304
  const etag = first.headers.get('ETag');
  assert.equal((await s.call('/api/catalog/index', { 'If-None-Match': etag })).status, 304);

  // 편집 직후(fresh)는 캐시를 건너뛴다
  await s.call('/api/catalog/index?fresh=1');
  assert.equal(s.calls.length, 2);
});

test('버전이 내용 해시와 맞는 상세는 1년 캐시하고, 아니면 짧게 둔다', async () => {
  const s = setup({ origin: { '/api/catalog/problems/p1': detail } });
  const good = await s.call(`/api/catalog/problems/p1?v=${version(detail)}`);
  assert.equal(good.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  await s.call(`/api/catalog/problems/p1?v=${version(detail)}`);
  assert.equal(s.calls.length, 1);
  const stale = await s.call('/api/catalog/problems/p1?v=0000000000000000');
  assert.equal(stale.headers.get('Cache-Control'), 'public, max-age=30');
  assert.equal((await s.call('/api/catalog/problems/none')).status, 404);
});

test('R2 모드: 목록·상세를 R2에서 읽고, 없는 버전은 stale_version으로 알린다', async () => {
  const s = setup({ r2: { 'catalog/v1/index.json': index, [`catalog/v1/problems/p1/${version(detail)}.json`]: detail } });
  assert.equal(await (await s.call('/api/catalog/index')).text(), index);
  assert.equal(await (await s.call(`/api/catalog/problems/p1?v=${version(detail)}`)).text(), detail);
  // 버전 없이 오면 (캐시된) 목록에서 찾는다
  assert.equal(await (await s.call('/api/catalog/problems/p1')).text(), detail);
  assert.deepEqual(s.r2Reads, ['catalog/v1/index.json', `catalog/v1/problems/p1/${version(detail)}.json`, `catalog/v1/problems/p1/${version(detail)}.json`]);
  const gone = await s.call('/api/catalog/problems/p1?v=ffffffffffffffff');
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, 'stale_version');
  assert.deepEqual(s.calls, []);
});

test('세션 쿠키가 없으면 세션 확인·내 상태 조회를 서버까지 보내지 않는다', async () => {
  const s = setup({ origin: { '/api/auth/session': JSON.stringify({ data: { authenticated: true } }) } });
  assert.equal((await (await s.call('/api/auth/session')).json()).data.authenticated, false);
  assert.equal((await s.call('/api/me/problems')).status, 401);
  assert.equal(s.calls.length, 0);
  // 쿠키가 있으면 그대로 전달한다
  await s.call('/api/auth/session', { Cookie: 'other=1; solveline_session=abc' });
  assert.deepEqual(s.calls, [{ path: '/api/auth/session', cookie: 'other=1; solveline_session=abc' }]);
  // 빈 쿠키 값은 세션이 없는 것으로 본다
  assert.equal((await s.call('/api/me/problems', { Cookie: 'solveline_session=' })).status, 401);
});

test('공개 설정은 잠깐 캐시하고, 미리보기 도메인의 API는 막는다', async () => {
  const s = setup({ origin: { '/api/public/config': JSON.stringify({ data: { googleEnabled: true } }) } });
  await s.call('/api/public/config');
  await s.call('/api/public/config');
  assert.equal(s.calls.length, 1);
  const preview = await worker.fetch(new Request('https://abc.solveline.pages.dev/api/catalog/index'), {}, { waitUntil() {} });
  assert.equal(preview.status, 403);
});
