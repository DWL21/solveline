import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Language, ProblemMode, Session } from '@codetest/shared';
import { ApiError, api, qk } from './lib/api.ts';
import { useRoute, type Scope } from './lib/route.ts';
import { LoginScreen } from './components/LoginScreen.tsx';
import { Home, scopeList } from './components/Home.tsx';
import { Workspace, blankProblem } from './components/Workspace.tsx';

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
  const [route, go] = useRoute();
  const [creating, setCreating] = useState(false);
  const runtime = useQuery({ queryKey: qk.runtime, queryFn: api.runtime, staleTime: 60_000 });
  // 홈에서 마지막으로 보던 범위. 문제를 닫으면 그 범위로 돌아간다.
  const [lastScope, setLastScope] = useState<Scope>(route.kind === 'home' ? route.scope : { kind: 'all' });
  useEffect(() => {
    if (route.kind === 'home') setLastScope(route.scope);
  }, [route]);

  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      const out: Session = { authenticated: false, expiresAt: null };
      qc.setQueryData(qk.session, out);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] });
    },
  });

  // 다음 문제: 들어온 목록(마지막으로 본 범위)의 순서에서 현재 문제 바로 뒤
  const problems = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const collections = useQuery({ queryKey: qk.collections, queryFn: api.collections });
  let nextId: string | null = null;
  if (route.kind === 'problem' && problems.data && collections.data) {
    const list = scopeList(lastScope, problems.data, collections.data);
    const i = list.findIndex((p) => p.id === route.id);
    nextId = i >= 0 ? (list[i + 1]?.id ?? null) : null;
  }

  const v = runtime.data;
  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-[#0f1922] px-3 sm:px-4">
        <a
          href="#/"
          className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-raised"
          title="문제 선택 화면으로"
          onClick={(e) => (e.preventDefault(), go({ kind: 'home', scope: { kind: 'all' } }))}
        >
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="font-mono text-[15px] font-bold tracking-tight">codetest</span>
        </a>
        {route.kind === 'problem' && (
          <button type="button" className="btn-quiet ml-1" onClick={() => go({ kind: 'home', scope: lastScope })}>
            ← 문제 목록
          </button>
        )}
        <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-faint md:flex" title="실행 환경">
          <span className={`size-1.5 rounded-full ${v?.runner === 'up' ? 'bg-ok' : 'bg-bad'}`} aria-hidden />
          {v?.runner === 'up' ? `Java ${v.versions.java ?? '?'} · Python ${v.versions.python ?? '?'}` : runtime.isPending ? '실행 환경 확인 중' : '실행 서버 연결 안 됨'}
        </span>
        <button type="button" className="btn-quiet ml-auto px-2 text-[12px] md:ml-0" onClick={() => logout.mutate()}>
          로그아웃
        </button>
      </header>

      {route.kind === 'problem' ? (
        <Workspace
          problemId={route.id}
          onDeleted={() => go({ kind: 'home', scope: lastScope })}
          onNext={nextId ? () => go({ kind: 'problem', id: nextId }) : undefined}
        />
      ) : (
        <Home
          scope={route.scope}
          onScope={(scope) => go({ kind: 'home', scope })}
          onPick={(id) => go({ kind: 'problem', id })}
          onNew={() => setCreating(true)}
        />
      )}

      {creating && (
        <NewProblemDialog
          scope={route.kind === 'home' ? route.scope : lastScope}
          onClose={() => setCreating(false)}
          onCreated={(pid) => {
            setCreating(false);
            go({ kind: 'problem', id: pid });
          }}
        />
      )}
    </div>
  );
}

/** 새 문제: 보던 폴더를 기본값으로 하고, 컬렉션을 보던 중이면 그 컬렉션 끝에 넣는다. */
function NewProblemDialog({ scope, onClose, onCreated }: { scope: Scope; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: qk.folders, queryFn: api.folders });
  const collections = useQuery({ queryKey: qk.collections, queryFn: api.collections });
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ProblemMode>('function');
  const [language, setLanguage] = useState<Language>('java');
  const [folderId, setFolderId] = useState<string | null>(scope.kind === 'folder' ? scope.id : null);
  const collection = scope.kind === 'collection' ? collections.data?.find((c) => c.id === scope.id) : undefined;
  const create = useMutation({
    mutationFn: async () => {
      const p = await api.createProblem(blankProblem(title.trim() || '새 문제', mode, language, folderId));
      if (collection) await api.setCollectionItems(collection.id, [...collection.problemIds, p.id]);
      return p;
    },
    onSuccess: (p) => {
      qc.setQueryData(qk.problem(p.id), p);
      void qc.invalidateQueries({ queryKey: qk.problems });
      void qc.invalidateQueries({ queryKey: qk.collections });
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
          <span className="text-[12px] font-bold text-dim">폴더</span>
          <select
            value={folderId ?? ''}
            onChange={(e) => setFolderId(e.target.value || null)}
            className="h-[34px] rounded-md border border-line-strong bg-raised px-2 text-[13px] outline-none focus:border-accent"
          >
            <option value="">폴더 없음</option>
            {folders.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {collection && (
          <p className="mt-2 text-[12px] text-faint">
            <span className="text-sky">◆</span> "{collection.name}" 컬렉션 끝에 추가돼요.
          </p>
        )}
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
