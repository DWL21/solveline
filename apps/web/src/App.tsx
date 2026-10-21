import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Language, ProblemMode, Session } from '@codetest/shared';
import { ApiError, api, qk } from './lib/api.ts';
import { LoginScreen } from './components/LoginScreen.tsx';
import { Workspace, blankProblem } from './components/Workspace.tsx';

/** #/p/<id> 형태의 아주 작은 라우터 */
function useHashId(): [string | null, (id: string | null) => void] {
  const read = () => /^#\/p\/([\w-]+)$/.exec(location.hash)?.[1] ?? null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const h = () => setId(read());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return [id, (next) => (location.hash = next ? `#/p/${next}` : '')];
}

export function App() {
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity });
  if (session.isPending) return <p className="p-6 text-[13px] text-dim">확인 중…</p>;
  if (session.isError)
    return (
      <div className="p-6 text-[13px]">
        <p className="font-semibold text-bad">{session.error instanceof ApiError ? session.error.message : '서버에 연결할 수 없어요'}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void session.refetch()}>
          다시 시도
        </button>
      </div>
    );
  return session.data.authenticated ? <Shell /> : <LoginScreen />;
}

function Shell() {
  const qc = useQueryClient();
  const [id, setId] = useHashId();
  const [listOpen, setListOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const problems = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const runtime = useQuery({ queryKey: qk.runtime, queryFn: api.runtime, staleTime: 60_000 });

  // 선택된 문제가 없으면 가장 최근 문제를 연다
  useEffect(() => {
    if (!id && problems.data?.[0]) setId(problems.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, problems.data]);

  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      const out: Session = { authenticated: false, expiresAt: null };
      qc.setQueryData(qk.session, out);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] });
    },
  });

  const v = runtime.data;
  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-[#0f1922] px-3 sm:px-4">
        <a href="#" className="flex items-center gap-2" onClick={(e) => (e.preventDefault(), setListOpen(true))}>
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="font-mono text-[15px] font-bold tracking-tight">codetest</span>
        </a>
        <button type="button" className="btn-quiet ml-1" onClick={() => setListOpen(true)}>
          문제 목록
        </button>
        <button type="button" className="btn-quiet" onClick={() => setCreating(true)}>
          + 새 문제
        </button>
        <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-faint md:flex" title="실행 환경">
          <span className={`size-1.5 rounded-full ${v?.runner === 'up' ? 'bg-ok' : 'bg-bad'}`} aria-hidden />
          {v?.runner === 'up' ? `Java ${v.versions.java ?? '?'} · Python ${v.versions.python ?? '?'}` : runtime.isPending ? '실행 환경 확인 중' : '실행 서버 연결 안 됨'}
        </span>
        <button type="button" className="btn-quiet ml-auto px-2 text-[12px] md:ml-0" onClick={() => logout.mutate()}>
          로그아웃
        </button>
      </header>

      {id ? (
        <Workspace problemId={id} onDeleted={() => setId(null)} />
      ) : problems.isPending ? (
        <p className="p-6 text-[13px] text-dim">불러오는 중…</p>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[15px] font-bold">아직 문제가 없어요</p>
          <p className="text-[13px] text-dim">문제를 만들고 설명·테스트 케이스를 붙여 넣은 뒤 풀어 보세요.</p>
          <button type="button" className="btn-primary mt-2" onClick={() => setCreating(true)}>
            + 새 문제
          </button>
        </div>
      )}

      {listOpen && (
        <ProblemDrawer
          currentId={id}
          onClose={() => setListOpen(false)}
          onPick={(pid) => {
            setId(pid);
            setListOpen(false);
          }}
          onNew={() => {
            setListOpen(false);
            setCreating(true);
          }}
        />
      )}
      {creating && (
        <NewProblemDialog
          onClose={() => setCreating(false)}
          onCreated={(pid) => {
            setCreating(false);
            setId(pid);
          }}
        />
      )}
    </div>
  );
}

function ProblemDrawer({ currentId, onClose, onPick, onNew }: { currentId: string | null; onClose: () => void; onPick: (id: string) => void; onNew: () => void }) {
  const problems = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const list = (problems.data ?? []).filter((p) => p.title.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label="문제 목록">
      <div className="flex h-full w-full max-w-sm flex-col border-r border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line p-3">
          <input className="field font-sans" placeholder="문제 검색" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          <button type="button" className="btn-primary" onClick={onNew}>
            + 새 문제
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {problems.isPending && <li className="p-3 text-[13px] text-dim">불러오는 중…</li>}
          {problems.isSuccess && list.length === 0 && <li className="p-3 text-[13px] text-faint">문제가 없어요</li>}
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id)}
                className={`flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2.5 text-left hover:bg-raised ${p.id === currentId ? 'bg-raised' : ''}`}
              >
                <span className="text-[14px] font-semibold">{p.title}</span>
                <span className="text-[11.5px] text-faint">
                  {p.language === 'java' ? 'Java' : 'Python3'} · {p.mode === 'function' ? 'solution 함수' : '표준 입출력'} · {new Date(p.updatedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" aria-label="닫기" className="flex-1 bg-black/50" onClick={onClose} />
    </div>
  );
}

function NewProblemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ProblemMode>('function');
  const [language, setLanguage] = useState<Language>('java');
  const create = useMutation({
    mutationFn: () => api.createProblem(blankProblem(title.trim() || '새 문제', mode, language)),
    onSuccess: (p) => {
      qc.setQueryData(qk.problem(p.id), p);
      void qc.invalidateQueries({ queryKey: qk.problems });
      onCreated(p.id);
    },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="새 문제">
      <form
        className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="text-[16px] font-bold">새 문제</h2>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-[12px] font-bold text-dim">제목</span>
          <input className="field font-sans text-[14px]" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 두 개 뽑아서 더하기" autoFocus />
        </label>
        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] font-bold text-dim">문제 형식</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['function', 'solution 함수', '일반 기존 문제'],
                ['stdin', '표준 입출력', 'PCCE·입출력 문제'],
              ] as const
            ).map(([m, name, hint]) => (
              <label key={m} className={`cursor-pointer rounded-md border p-3 ${mode === m ? 'border-accent bg-accent/10' : 'border-line-strong hover:border-dim'}`}>
                <input type="radio" name="mode" className="sr-only" checked={mode === m} onChange={() => setMode(m)} />
                <span className="block text-[13px] font-bold">{name}</span>
                <span className="block text-[11.5px] text-faint">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-[12px] font-bold text-dim">언어</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className="h-[34px] rounded-md border border-line-strong bg-raised px-2 text-[13px] font-semibold outline-none focus:border-accent"
          >
            <option value="java">Java</option>
            <option value="python">Python3</option>
          </select>
        </label>
        {create.isError && <p className="mt-3 text-[13px] font-semibold text-bad">{create.error instanceof ApiError ? create.error.message : '만들지 못했어요'}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-quiet" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? '만드는 중…' : '만들기'}
          </button>
        </div>
      </form>
    </div>
  );
}
