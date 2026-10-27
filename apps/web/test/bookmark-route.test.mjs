import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hrefOf, parseRoute } from '../src/lib/route.ts';

test('북마크 목록 주소를 만들고 다시 읽는다', () => {
  const route = { kind: 'home', scope: { kind: 'bookmarks' } };
  assert.equal(hrefOf(route), '#/bookmarks');
  assert.deepEqual(parseRoute('#/bookmarks'), route);
});
