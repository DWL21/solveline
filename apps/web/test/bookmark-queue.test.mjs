import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { BookmarkQueue } from '../src/lib/bookmark-queue.ts';

test('빠른 변경은 마지막 상태만 지연 전송한다', async () => {
  const calls = [];
  const q = new BookmarkQueue(async (...args) => calls.push(args), 15);
  q.set('user', 'p', true, () => assert.fail('unexpected failure'));
  q.set('user', 'p', false, () => assert.fail('unexpected failure'));
  assert.deepEqual(calls, []);
  await wait(40);
  assert.deepEqual(calls, [['user', 'p', false]]);
});

test('전송 중 변경은 순서대로 마지막 상태까지 보낸다', async () => {
  const calls = [];
  let resolveFirst;
  const q = new BookmarkQueue(async (_owner, _id, value) => {
    calls.push(value);
    if (calls.length === 1) await new Promise((resolve) => { resolveFirst = resolve; });
  }, 10);
  q.set('user', 'p', true, () => assert.fail('unexpected failure'));
  await wait(25);
  q.set('user', 'p', false, () => assert.fail('unexpected failure'));
  await wait(25);
  assert.deepEqual(calls, [true]);
  resolveFirst();
  await wait(10);
  assert.deepEqual(calls, [true, false]);
});

test('마지막 상태 저장이 실패하면 알린다', async () => {
  let failed = false;
  const q = new BookmarkQueue(async () => { throw new Error('offline'); }, 10);
  q.set('user', 'p', true, () => { failed = true; });
  await wait(30);
  assert.equal(failed, true);
});
