import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '../lib/api.ts';
import { loginHref, useMe } from '../lib/me.ts';

export function BookmarkStar({ id, bookmarked }: { id: string; bookmarked: boolean | undefined }) {
  const me = useMe();
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: () => api.setBookmark(id, !bookmarked),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.problems }),
  });
  const label = bookmarked ? '북마크 해제' : '북마크 추가';
  const style = 'flex size-11 shrink-0 items-center justify-center text-[22px] text-warn hover:bg-raised disabled:opacity-50';
  if (!me) return <a href={loginHref()} className={style} aria-label="로그인하고 북마크하기" title="로그인하고 북마크하기">☆</a>;
  return <span className="flex shrink-0 items-center">
    <button type="button" className={style} aria-label={label} aria-pressed={bookmarked} title={label} disabled={change.isPending || bookmarked === undefined} onClick={() => change.mutate()}>{bookmarked ? '★' : '☆'}</button>
    {change.isError && <span role="alert" className="text-[12px] text-bad">저장하지 못했어요</span>}
  </span>;
}
