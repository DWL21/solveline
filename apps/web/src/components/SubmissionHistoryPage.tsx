import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SubmissionDetail, SubmissionHistoryItem } from '@solveline/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { loginHref, useMe } from '../lib/me.ts';
import { ResultPanel } from './ResultPanel.tsx';
import { LinesSkeleton } from './Loading.tsx';

const date = (value: string) => new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const errorText = (error: unknown) => error instanceof ApiError ? error.message : '제출 기록을 불러오지 못했어요';

function statusText(item: Pick<SubmissionHistoryItem, 'status' | 'score'>) {
  if (item.status === 'queued') return '대기 중';
  if (item.status === 'running') return '채점 중';
  if (item.status === 'cancelled') return '중지됨';
  if (item.status === 'error') return '실행 오류';
  return item.score === null ? '완료' : item.score === 100 ? '✓ 정답' : `${item.score}점`;
}

const isActive = (status: string | undefined) => status === 'queued' || status === 'running';

/** 채점 결과 영역: 상태별로 한 가지만 보여 준다 */
function GradeBody({ item }: { item: SubmissionDetail }) {
  if (isActive(item.status)) return <p className="p-4 text-[13px] text-dim">{statusText(item)}</p>;
  if (item.status === 'error') return <p className="p-4 text-[13px] text-bad">{item.error ?? '채점하지 못했어요'}</p>;
  if (item.status === 'cancelled') return <p className="p-4 text-[13px] text-warn">채점을 중지했습니다.</p>;
  if (item.result) return <ResultPanel state={{ kind: 'graded', result: item.result, score: item.score ?? 0 }} />;
  return <p className="p-4 text-[13px] text-dim">결과가 없어요</p>;
}

function Detail({ id, onClose, onPickProblem }: { id: string; onClose: () => void; onPickProblem: (id: string) => void }) {
  const query = useQuery({
    queryKey: qk.submissionDetail(id),
    queryFn: () => api.submissionDetail(id),
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 1500 : false),
  });
  const item: SubmissionDetail | undefined = query.data;
  return (
    <section className="min-w-0 flex-1 rounded-lg border border-line bg-panel" aria-label="제출 상세">
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 className="text-[16px] font-bold">{item?.problemTitle ?? '제출 상세'}</h2>
          {item && <p className="mt-1 text-[13px] text-dim">{date(item.createdAt)} · {item.language === 'java' ? 'Java' : 'Python3'} · {statusText(item)}</p>}
        </div>
        <button type="button" className="btn-quiet touch-target shrink-0" onClick={onClose} aria-label="상세 닫기"><span className="lg:hidden">목록으로</span><span className="hidden lg:inline">닫기</span></button>
      </div>
      {query.isPending && <div className="p-4"><LinesSkeleton /></div>}
      {query.isError && (
        <div className="p-4 text-[13px] text-bad">{errorText(query.error)} <button type="button" className="btn-ghost ml-2" onClick={() => void query.refetch()}>다시 시도</button></div>
      )}
      {!query.isPending && !query.isError && item && (
        <div className="space-y-5 p-4">
          {item.problemId && item.problemTitle && <button type="button" className="btn-ghost" onClick={() => onPickProblem(item.problemId!)}>문제로 이동</button>}
          <div>
            <h3 className="mb-2 text-[13px] font-bold">제출한 코드</h3>
            <pre className="max-h-96 overflow-auto rounded-md border border-line bg-raised p-3 font-mono text-[12px] leading-relaxed text-text"><code>{item.code}</code></pre>
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-bold">채점 결과</h3>
            <div className="rounded-md border border-line">
              <GradeBody item={item} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function SubmissionHistoryPage({ onPickProblem }: { onPickProblem: (id: string) => void }) {
  const me = useMe();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: qk.submissionHistory(offset),
    queryFn: () => api.submissionHistory(offset),
    enabled: !!me,
    refetchInterval: (q) => (q.state.data?.items.some((item) => isActive(item.status)) ? 1500 : false),
  });
  if (!me) return <div className="p-6 text-[14px]">제출 기록은 로그인하면 볼 수 있어요. <a className="font-semibold text-accent-text underline" href={loginHref()}>로그인</a></div>;
  return (
    <main className="pb-safe min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-10 sm:px-8 sm:pt-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-[24px] font-bold tracking-tight">제출 기록</h1>
        <p className="mt-1.5 text-[14px] text-dim">최근 30일 동안 제출한 코드와 채점 결과예요.</p>
        <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* 좁은 화면: 제출을 고르면 목록 대신 상세를 크게 보여 준다 */}
          <section className={`w-full shrink-0 lg:block lg:w-80 ${selected ? 'hidden' : ''}`} aria-label="제출 목록">
            {query.isPending ? <LinesSkeleton lines={5} /> : query.isError ? (
              <p className="text-[13px] text-bad">{errorText(query.error)} <button type="button" className="btn-ghost ml-2" onClick={() => void query.refetch()}>다시 시도</button></p>
            ) : query.data.items.length === 0 && offset === 0 ? <p className="rounded-lg border border-line bg-panel px-5 py-10 text-center text-[14px] text-dim">아직 제출한 기록이 없어요</p> : (
              <>
                <ol className="overflow-hidden rounded-lg border border-line bg-panel">
                  {query.data.items.map((item) => <li key={item.id} className="border-b border-line last:border-0">
                    <button type="button" onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} className={`w-full px-4 py-3 text-left hover:bg-raised ${selected === item.id ? 'bg-raised' : ''}`}>
                      <span className="block truncate text-[14px] font-semibold">{item.problemTitle ?? '삭제된 문제'}</span>
                      <span className="mt-1 flex items-center justify-between gap-2 text-[12.5px] text-dim"><span>{date(item.createdAt)} · {item.language === 'java' ? 'Java' : 'Python3'}</span><span className={`font-semibold ${item.score === 100 ? 'text-ok' : item.status === 'error' ? 'text-bad' : ''}`}>{statusText(item)}</span></span>
                    </button>
                  </li>)}
                </ol>
                <div className="mt-3 flex justify-between gap-2">
                  <button type="button" className="btn-ghost" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 20)); setSelected(null); }}>이전</button>
                  <button type="button" className="btn-ghost" disabled={query.data.nextOffset === null} onClick={() => { setOffset(query.data.nextOffset!); setSelected(null); }}>다음</button>
                </div>
              </>
            )}
          </section>
          {selected ? <Detail key={selected} id={selected} onClose={() => setSelected(null)} onPickProblem={onPickProblem} /> : <div className="hidden min-h-48 flex-1 items-center justify-center rounded-lg border border-dashed border-line-strong p-4 text-[14px] text-faint lg:flex">왼쪽에서 제출을 선택하세요</div>}
        </div>
      </div>
    </main>
  );
}
