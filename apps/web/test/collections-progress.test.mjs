import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionProgress } from '../src/lib/collections.ts';

test('빈 컬렉션은 클리어가 아니다', () => {
  assert.equal(collectionProgress([]).cleared, false);
});

test('최근 제출 100점만 완료로 세고 첫 미완료 문제를 고른다', () => {
  const problems = [
    { id: 'a', lastSubmission: { score: 100 } },
    { id: 'b', lastSubmission: { score: 80 } },
    { id: 'c', lastSubmission: null },
  ];
  const result = collectionProgress(problems);
  assert.equal(result.solved, 1);
  assert.equal(result.cleared, false);
  assert.equal(result.next.id, 'b');
});

test('모든 문제의 최근 제출이 100점이면 클리어한다', () => {
  const result = collectionProgress([{ id: 'a', lastSubmission: { score: 100 } }]);
  assert.equal(result.cleared, true);
  assert.equal(result.next, undefined);
});

test('상위 컬렉션은 직접 문제와 하위 문제를 순서대로 모으고 중복을 제거한다', async () => {
  const { buildTree, problemIdsUnder } = await import('../src/lib/collections.ts');
  const tree = buildTree([
    { name: '과정', problemIds: ['a', 'b'] },
    { name: '과정/02세트', problemIds: ['c', 'd'] },
    { name: '과정/01세트', problemIds: ['b', 'c'] },
  ]);
  assert.deepEqual(problemIdsUnder(tree[0]), ['a', 'b', 'c', 'd']);
});

test('직접 문제가 없는 상위 컬렉션도 하위 문제를 모은다', async () => {
  const { buildTree, problemIdsUnder } = await import('../src/lib/collections.ts');
  const tree = buildTree([
    { name: '과정', problemIds: [] },
    { name: '과정/1단계', problemIds: [] },
    { name: '과정/1단계/01세트', problemIds: ['a'] },
  ]);
  assert.deepEqual(problemIdsUnder(tree[0]), ['a']);
  assert.deepEqual(problemIdsUnder(buildTree([{ name: '빈 과정', problemIds: [] }])[0]), []);
});
