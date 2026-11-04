import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareErrorLabel } from '../src/lib/result-labels.ts';

test('실행 전 검사 실패는 Java만 컴파일 에러, Python은 문법 에러로 보인다', () => {
  assert.equal(prepareErrorLabel('java'), '컴파일 에러');
  assert.equal(prepareErrorLabel('python'), '문법 에러');
});
