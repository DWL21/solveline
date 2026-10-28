// Pages는 정적 파일을 제공하고, API 중 서버 없이 답할 수 있는 것은 여기서 답한다.
// - 카탈로그(공용 문제 데이터): R2(바인딩 CATALOG, 변수 CATALOG_SOURCE=r2) 또는 API에서 읽어 엣지에 캐시한다.
// - 세션 쿠키가 없는 요청의 세션 확인·내 상태 조회: API까지 가지 않고 바로 답한다.
// - 공개 설정·실행 환경: 잠깐 엣지에 캐시한다.
// 나머지(로그인, 사용자 데이터, 실행·채점, 문제 쓰기)는 기존 Tunnel로 전달한다.

const API_HOST = 'solveline-api.simplyimg.com';
const PRODUCTION_HOST = 'solveline.simplyimg.com';
const SESSION_COOKIES = ['solveline_session', 'codetest_session'];

// R2 키. apps/api/src/catalog.ts와 같다.
const INDEX_KEY = 'catalog/v1/index.json';
const problemKey = (id, version) => `catalog/v1/problems/${id}/${version}.json`;

/** 목록은 편집하면 바뀌므로 짧게, 버전이 붙은 문제 상세는 내용이 바뀌지 않으므로 길게 둔다. */
const INDEX_TTL = 60;
const SHORT_TTL = 30;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const JSON_TYPE = 'application/json; charset=utf-8';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } });

const hasSession = (request) => {
  const cookie = request.headers.get('Cookie') ?? '';
  return SESSION_COOKIES.some((name) => new RegExp(`(?:^|;\\s*)${name}=[^;]`).test(cookie));
};

const fromR2 = (env) => !!env.CATALOG && env.CATALOG_SOURCE === 'r2';

/** 쿠키 없이 API에서 읽는다(공용 데이터라 사용자에 따라 달라지지 않는다). */
const fetchOrigin = (path) => fetch(`https://${API_HOST}${path}`, { headers: { Accept: 'application/json' } });

async function versionOf(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** 엣지 캐시에 넣을 응답 */
function cacheable(body, cacheControl, etag) {
  const headers = { 'Content-Type': JSON_TYPE, 'Cache-Control': cacheControl };
  if (etag) headers.ETag = etag;
  return new Response(body, { headers });
}

/** 브라우저로 보낸다. ETag가 같으면 본문 없이 304. */
function toBrowser(request, res, cacheControl) {
  const etag = res.headers.get('ETag');
  if (res.ok && etag && request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } });
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', res.ok ? cacheControl : 'no-store');
  return out;
}

/** 목록(엣지 캐시 60초). fresh면 캐시를 건너뛰고 새로 읽어 캐시도 바꾼다. 실패하면 API 응답을 그대로 돌려준다. */
async function indexResponse(env, ctx, host, fresh) {
  const key = new Request(`https://${host}/api/catalog/index`);
  if (!fresh) {
    const hit = await caches.default.match(key);
    if (hit) return hit;
  }
  let body = null;
  let etag = null;
  if (fromR2(env)) {
    const obj = await env.CATALOG.get(INDEX_KEY);
    if (obj) [body, etag] = [await obj.text(), obj.httpEtag];
  }
  if (body === null) {
    const res = await fetchOrigin('/api/catalog/index');
    if (!res.ok) return res;
    [body, etag] = [await res.text(), res.headers.get('ETag')];
  }
  const res = cacheable(body, `public, max-age=${INDEX_TTL}`, etag);
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

/** 문제 상세 원문. version이 있는데 R2에 없으면 missing(목록이 바뀐 것) */
async function loadProblem(env, ctx, host, id, version) {
  if (fromR2(env)) {
    let v = version;
    if (!v) {
      const idx = await indexResponse(env, ctx, host, false);
      if (idx.ok) v = (await idx.clone().json()).data.problems.find((p) => p.id === id)?.version;
    }
    const obj = v ? await env.CATALOG.get(problemKey(id, v)) : null;
    if (obj) return { body: await obj.text() };
    if (version) return { missing: true };
  }
  const res = await fetchOrigin(`/api/catalog/problems/${encodeURIComponent(id)}`);
  return res.ok ? { body: await res.text() } : { error: res };
}

/** 문제 상세: ?v=<버전>이 내용 해시와 맞으면 1년(바뀌지 않는다), 아니면 30초 캐시 */
async function catalogProblem(request, env, ctx, url, id) {
  const version = url.searchParams.get('v');
  const key = new Request(`https://${url.host}/api/catalog/problems/${encodeURIComponent(id)}${version ? `?v=${encodeURIComponent(version)}` : ''}`);
  const hit = await caches.default.match(key);
  if (hit) return toBrowser(request, hit, hit.headers.get('Cache-Control'));
  const loaded = await loadProblem(env, ctx, url.host, id, version);
  if (loaded.missing) return json({ error: { code: 'stale_version', message: '문제 목록이 바뀌었어요. 다시 불러올게요.' } }, 404);
  if (loaded.error) return toBrowser(request, loaded.error, 'no-store');
  // API에서 읽었을 때는 그 사이 내용이 바뀌었을 수 있으므로 해시가 맞을 때만 오래 둔다
  const immutable = !!version && (await versionOf(loaded.body)) === version;
  const res = cacheable(loaded.body, immutable ? IMMUTABLE : `public, max-age=${SHORT_TTL}`, immutable ? `"${version}"` : null);
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return toBrowser(request, res, res.headers.get('Cache-Control'));
}

/** 사용자와 무관한 공개 응답을 잠깐 엣지에 캐시한다(쿠키는 보내지 않는다). */
async function shortCached(request, ctx, url) {
  const key = new Request(`https://${url.host}${url.pathname}`);
  const hit = await caches.default.match(key);
  if (hit) return toBrowser(request, hit, 'no-cache');
  const res = await fetchOrigin(url.pathname);
  if (!res.ok) return toBrowser(request, res, 'no-store');
  const stored = cacheable(await res.text(), `public, max-age=${SHORT_TTL}`);
  ctx.waitUntil(caches.default.put(key, stored.clone()));
  return toBrowser(request, stored, 'no-cache');
}

async function proxy(request, url) {
  url.protocol = 'https:';
  url.host = API_HOST;
  const upstream = new Request(url, request);
  // Google 로그인 리다이렉트와 여러 Set-Cookie 헤더를 그대로 브라우저로 보낸다.
  const response = await fetch(upstream, { redirect: 'manual' });
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    // 미리보기에서 운영 세션을 만들거나 운영 데이터를 변경하지 않는다.
    if (url.hostname !== PRODUCTION_HOST && url.pathname !== '/api/health') {
      return json({ error: { code: 'PREVIEW_API_DISABLED', message: '운영 사이트에서 이용해 주세요.' } }, 403);
    }
    if (request.method === 'GET') {
      const p = url.pathname;
      if (p === '/api/catalog/index') {
        const fresh = url.searchParams.has('fresh');
        return toBrowser(request, await indexResponse(env, ctx, url.host, fresh), fresh ? 'no-store' : `public, max-age=${INDEX_TTL}, stale-while-revalidate=600`);
      }
      const problem = p.match(/^\/api\/catalog\/problems\/([^/]+)$/);
      if (problem) return catalogProblem(request, env, ctx, url, decodeURIComponent(problem[1]));
      if (!hasSession(request)) {
        if (p === '/api/auth/session') return json({ data: { authenticated: false, expiresAt: null, user: null } });
        if (p.startsWith('/api/me/')) return json({ error: { code: 'unauthorized', message: '로그인이 필요합니다.' } }, 401);
      }
      if (p === '/api/public/config' || p === '/api/runtime') return shortCached(request, ctx, url);
    }
    return proxy(request, url);
  },
};
