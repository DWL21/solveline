import { describe, expect, it } from 'vitest';
import { backupsToPrune } from '../src/backup.ts';

describe('오래된 백업 고르기', () => {
  it('이름 앞부분(예전 이름 codetest)과 상관없이 날짜가 오래된 것부터 지운다', () => {
    const names = ['solveline-2026-10-20.db', 'codetest-2026-10-21.db', 'solveline-2026-10-19.db', 'codetest-2026-10-18.db', 'notes.txt'];
    // 최근 2개만 남긴다 → 10-21(codetest), 10-20(solveline)이 남아야 한다
    expect(backupsToPrune(names, 2)).toEqual(['codetest-2026-10-18.db', 'solveline-2026-10-19.db']);
  });

  it('남길 개수보다 적으면 지우지 않는다', () => {
    expect(backupsToPrune(['solveline-2026-10-20.db'], 7)).toEqual([]);
  });
});
