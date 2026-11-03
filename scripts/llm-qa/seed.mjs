// LLM QA 테스트 환경 준비: 편집 권한 테스트 계정으로 예제 문제·컬렉션을 넣고, 그 로그인 쿠키를 Playwright storage state로 저장한다.
// 테스트 로그인 토큰은 여기서만 쓴다. 모델에는 쿠키 파일만 간다(0010).
//   node seed.mjs <base URL> <e2e/.env.local> <state.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [base, envFile, stateOut] = process.argv.slice(2);
const token = /^E2E_TEST_AUTH_TOKEN=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim();
if (!base || !token || !stateOut) throw new Error('사용법: node seed.mjs <base> <env 파일> <state.json>');

const login = await fetch(`${base}/api/test/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-test-auth': token },
  body: JSON.stringify({ email: 'qa-agent@e2e.test', editor: true }),
});
if (!login.ok) throw new Error(`테스트 로그인 실패: ${login.status}`);
const setCookies = login.headers.getSetCookie();
const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

const post = async (path, data) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()).data;
};

const code = {
  java: 'class Solution {\n    public int solution(int[] numbers) {\n        int answer = 0;\n        return answer;\n    }\n}\n',
  python: 'def solution(numbers):\n    answer = 0\n    return answer\n',
};
const titles = ['두 수의 합', '문자열 뒤집기', '괄호 짝 맞추기', '최단 경로 찾기', '가장 긴 증가 부분 수열', '섬의 개수'];
const ids = [];
for (const [i, title] of titles.entries()) {
  const p = await post('/api/problems', {
    title,
    folderId: null,
    description: `## 문제 설명\n\n정수 배열 \`numbers\`의 모든 원소를 더한 값을 return 하세요. (**${title}** 예제)\n\n### 제한 사항\n\n- 1 ≤ numbers의 길이 ≤ 100\n\n### 입출력 예\n\n| numbers | result |\n|---|---|\n| [1, 2] | 3 |\n| [10, 20, 30] | 60 |`,
    mode: 'function',
    params: ['numbers'],
    timeLimitMs: 2000,
    cases: [
      { id: `a${i}`, args: ['[1, 2]'], stdin: '', expected: '3', hidden: false },
      { id: `b${i}`, args: ['[10, 20, 30]'], stdin: '', expected: '60', hidden: false },
    ],
    language: 'java',
    code,
    myCases: [],
    memo: '',
    lastSubmission: null,
  });
  ids.push(p.id);
}
await post('/api/collections', { name: '코딩테스트 입문', problemIds: ids.slice(0, 4) });
await post('/api/collections', { name: '그래프/BFS', problemIds: ids.slice(3) });

const { hostname } = new URL(base);
const cookies = setCookies.map((c) => {
  const [pair, ...attrs] = c.split(';').map((s) => s.trim());
  const at = (k) => attrs.find((a) => a.toLowerCase().startsWith(k));
  const same = at('samesite=')?.split('=')[1] ?? 'Lax';
  return {
    name: pair.slice(0, pair.indexOf('=')),
    value: pair.slice(pair.indexOf('=') + 1),
    domain: hostname,
    path: at('path=')?.split('=')[1] ?? '/',
    expires: -1,
    httpOnly: Boolean(at('httponly')),
    secure: Boolean(at('secure')),
    sameSite: same[0].toUpperCase() + same.slice(1).toLowerCase(),
  };
});
writeFileSync(stateOut, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
console.error(`예제 문제 ${ids.length}개, 컬렉션 2개, 로그인 쿠키 ${cookies.length}개`);
