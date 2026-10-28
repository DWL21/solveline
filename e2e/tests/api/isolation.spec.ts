import { SubmissionDetail, SubmissionHistory } from '@solveline/shared';
import { test, expect, emailFor } from '../../src/fixtures.ts';
import { Api } from '../../src/api.ts';
import { aCase, aProblem, sumSolutions, uid } from '../../src/builders.ts';

/** 사용자별 데이터 분리와 공용 데이터의 규칙(폴더는 개인, 컬렉션은 공용·경로형) */
test.describe('데이터 분리', { tag: '@R4' }, () => {
  test('작성 코드·메모·폴더는 사용자마다 따로다', async ({ playwright, baseURL, seedProblem }) => {
    const p = await seedProblem();
    const [a, b] = await Promise.all([0, 1].map(async () => new Api(await playwright.request.newContext({ baseURL }))));
    await a!.signIn(emailFor('a'));
    await b!.signIn(emailFor('b'));
    const folder = await a!.createFolder(`내 폴더 ${uid()}`);
    await a!.saveProblem(p.id, { ...aProblem(), title: p.title, folderId: folder.id, code: { java: 'A의 코드', python: '' }, memo: 'A의 메모' });

    const seenByB = await b!.problem(p.id);
    expect(seenByB).toMatchObject({ memo: '', folderId: null });
    expect(seenByB.code.java).not.toBe('A의 코드');
    expect((await b!.folders()).some((f) => f.id === folder.id)).toBe(false);
    // 남의 폴더로는 옮길 수 없다
    expect((await b!.fail(b!.request.put(`/api/problems/${p.id}`, { data: { ...aProblem(), title: p.title, folderId: folder.id } }))).status).toBe(400);
    // 일반 사용자가 보낸 문제 내용 변경은 무시된다(편집 권한자만 공용 내용을 바꾼다)
    expect((await a!.problem(p.id)).title).toBe(p.title);
    await Promise.all([a!.request.dispose(), b!.request.dispose()]);
  });

  test('컬렉션은 공용이고 이름의 /는 계층으로 정리된다', { tag: '@R5' }, async ({ editorApi, api, seedProblem }) => {
    const p = await seedProblem();
    const name = `E2E ${uid()}`;
    const col = await editorApi.createCollection({ name: ` ${name} /  1회 `, description: '' });
    expect(col.name).toBe(`${name}/1회`);
    await editorApi.setCollectionItems(col.id, [p.id]);
    expect((await api.collections()).find((c) => c.id === col.id)?.problemIds).toEqual([p.id]);
    expect((await editorApi.fail(editorApi.request.post('/api/collections', { data: { name: `${name}/1회`, description: '' } }))).status).toBe(409);
  });
});

test('북마크는 사용자별로 저장되고 비회원과 다른 사용자에게 보이지 않는다', { tag: '@R4' }, async ({ api, signIn, editorApi, seedProblem }) => {
  const p = await seedProblem();
  const bookmark = (value: boolean) => editorApi.bookmark(p.id, value);
  await bookmark(true);
  expect((await editorApi.problems()).find((x) => x.id === p.id)?.bookmarked).toBe(true);
  expect((await api.problems()).find((x) => x.id === p.id)?.bookmarked).toBe(false);
  await signIn();
  expect((await api.problems()).find((x) => x.id === p.id)?.bookmarked).toBe(false);
  await bookmark(false);
  expect((await editorApi.problems()).find((x) => x.id === p.id)?.bookmarked).toBe(false);
});

for (const access of ['상태 조회', '코드 상세 조회', '실행 취소'] as const) {
  test(`다른 사용자(편집 권한 포함)는 남의 제출 ${access}를 할 수 없다`, { tag: ['@R4', '@R2'] }, async ({ api, signIn, editorApi, seedProblem }) => {
    const p = await seedProblem();
    await signIn();
    const code = sumSolutions.python.correct;
    const own = await api.submit({ problemId: p.id, kind: 'submit', language: 'python', mode: 'function', code, cases: [aCase(['[1, 2]'], '3')] });
    const path = `/api/submissions/${own.id}`;
    try {
      const response = access === '실행 취소' ? editorApi.request.post(`${path}/cancel`)
        : editorApi.request.get(`${path}${access === '코드 상세 조회' ? '/detail' : ''}`);
      expect(await editorApi.fail(response)).toEqual({ status: 404, code: 'not_found' });
      expect((await api.ok(api.request.get(`${path}/detail`), SubmissionDetail)).code).toBe(code);
      const history = await editorApi.ok(editorApi.request.get('/api/submissions'), SubmissionHistory);
      expect(history.items.some((item) => item.id === own.id)).toBe(false);
      expect((await api.submission(own.id)).status).not.toBe('cancelled');
    } finally {
      await api.request.post(`${path}/cancel`);
    }
  });
}
