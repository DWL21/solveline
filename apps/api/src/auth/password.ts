import { createHash, timingSafeEqual } from 'node:crypto';

/** 비밀번호를 상수 시간으로 비교한다. 길이가 달라도 시간이 새지 않도록 해시끼리 비교한다. */
export function passwordMatches(expected: string, given: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(given, 'utf8').digest();
  return timingSafeEqual(a, b);
}
