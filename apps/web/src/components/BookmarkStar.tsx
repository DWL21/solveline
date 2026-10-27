import { useQueryClient } from '@tanstack/react-query';
import type { ProblemSummary } from '@solveline/shared';
import { api, qk } from '../lib/api.ts';
import { BookmarkQueue } from '../lib/bookmark-queue.ts';
import { loginHref, useMe } from '../lib/me.ts';

const queue = new BookmarkQueue((owner, id, value) => api.setBookmark(id, value, owner));

export function BookmarkStar({ id, bookmarked }: { id: string; bookmarked: boolean | undefined }) {
  const me = useMe();
  const qc = useQueryClient();
  const label = bookmarked ? '북마크 해제' : '북마크 추가';
  // 터치 영역은 유지하고 별만 작게 표시한다.
  const style = 'flex size-11 shrink-0 items-center justify-center text-[16px] text-warn hover:bg-raised disabled:opacity-50';
  if (!me) return <a href={loginHref()} className={style} aria-label="로그인하고 북마크하기" title="로그인하고 북마크하기">☆</a>;
  const toggle = () => {
    const previous = qc.getQueryData<ProblemSummary[]>(qk.problems)?.find((p) => p.id === id)?.bookmarked;
    if (previous === undefined) return;
    const next = !previous;
    void qc.cancelQueries({ queryKey: qk.problems });
    qc.setQueryData<ProblemSummary[]>(qk.problems, (all) => all?.map((p) => p.id === id ? { ...p, bookmarked: next } : p));
    queue.set(me.email, id, next, () => {
      void qc.invalidateQueries({ queryKey: qk.problems });
    });
  };
  return <span className="flex shrink-0 items-center">
    <button type="button" className={style} aria-label={label} aria-pressed={bookmarked} title={label} disabled={bookmarked === undefined} onClick={toggle}>{bookmarked ? '★' : '☆'}</button>
  </span>;
}
