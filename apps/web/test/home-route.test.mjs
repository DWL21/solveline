import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hrefOf, parseRoute } from '../src/lib/route.ts';

test('첫 방문·로고 주소·잘못된 주소는 컬렉션 선택 화면으로 열린다', () => {
  const route = { kind: 'home', scope: { kind: 'collections' } };
  for (const hash of ['', '#/', '#/unknown', '#/cg/%zz']) assert.deepEqual(parseRoute(hash), route);
  assert.equal(hrefOf(route), '#/');
});

test('전체 보기는 독립 주소로 열리고 새로고침해도 전체 목록을 유지한다', () => {
  const route = { kind: 'home', scope: { kind: 'all' } };
  assert.equal(hrefOf(route), '#/all');
  assert.deepEqual(parseRoute(hrefOf(route)), route);
});

test('기존 컬렉션·문제 주소를 유지한다', () => {
  for (const route of [{ kind: 'home', scope: { kind: 'collection', id: 'c1' } }, { kind: 'problem', id: 'p1' }]) {
    assert.deepEqual(parseRoute(hrefOf(route)), route);
  }
});
