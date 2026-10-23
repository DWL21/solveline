import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/web/public/_worker.js';

test('API 프록시는 본문·쿼리·인증 헤더와 리다이렉트·쿠키를 보존한다', async (t) => {
  t.mock.method(globalThis, 'fetch', async (request, options) => {
    assert.equal(request.url, 'https://solveline-api.simplyimg.com/api/auth/signup?mode=join');
    assert.equal(request.method, 'POST');
    assert.equal(await request.text(), '{"agree":true}');
    assert.equal(request.headers.get('Cookie'), 'test=session');
    assert.equal(request.headers.get('Origin'), 'https://solveline.simplyimg.com');
    assert.equal(options.redirect, 'manual');
    const headers = new Headers({ Location: 'https://accounts.google.com/', 'Cache-Control': 'public' });
    headers.append('Set-Cookie', 'a=1; HttpOnly; Secure');
    headers.append('Set-Cookie', 'b=2; HttpOnly; Secure');
    return new Response(null, { status: 302, headers });
  });
  const response = await worker.fetch(new Request('https://solveline.simplyimg.com/api/auth/signup?mode=join', {
    method: 'POST', body: '{"agree":true}', headers: { Cookie: 'test=session', Origin: 'https://solveline.simplyimg.com' },
  }), {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://accounts.google.com/');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('정적 페이지는 ASSETS가 처리한다', async () => {
  const response = await worker.fetch(new Request('https://solveline.simplyimg.com/signup'), {
    ASSETS: { fetch: async () => new Response('SPA') },
  });
  assert.equal(await response.text(), 'SPA');
});

test('미리보기에서 운영 API 사용을 차단한다', async () => {
  const response = await worker.fetch(new Request('https://preview.solveline.pages.dev/api/auth/google'), {});
  assert.equal(response.status, 403);
});

test('미리보기에서도 헬스 체크와 API 오류 상태를 확인할 수 있다', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  const response = await worker.fetch(new Request('https://solveline.pages.dev/api/health'), {});
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'unavailable');
});
