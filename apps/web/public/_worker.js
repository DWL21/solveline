// Pages는 정적 파일을 제공하고 API만 기존 Tunnel로 전달한다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    // 미리보기에서 운영 세션을 만들거나 운영 데이터를 변경하지 않는다.
    if (url.hostname !== 'solveline.simplyimg.com' && url.pathname !== '/api/health') {
      return Response.json({ error: { code: 'PREVIEW_API_DISABLED', message: '운영 사이트에서 이용해 주세요.' } }, { status: 403 });
    }
    url.protocol = 'https:';
    url.host = 'solveline-api.simplyimg.com';
    const upstream = new Request(url, request);
    // Google 로그인 리다이렉트와 여러 Set-Cookie 헤더를 그대로 브라우저로 보낸다.
    const response = await fetch(upstream, { redirect: 'manual' });
    const result = new Response(response.body, response);
    result.headers.set('Cache-Control', 'no-store');
    return result;
  },
};
