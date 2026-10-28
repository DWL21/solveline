import { sameSecret } from '../crypto.ts';

/** 비밀번호를 상수 시간으로 비교한다. 길이가 달라도 시간이 새지 않도록 해시끼리 비교한다. */
export const passwordMatches = (expected: string, given: string): Promise<boolean> => sameSecret(expected, given);
