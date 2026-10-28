import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Language, ProblemMode, Session } from '@solveline/shared';
import { ApiError, api, qk } from './lib/api.ts';
import { useRoute, type Scope } from './lib/route.ts';
import { LoginScreen } from './components/LoginScreen.tsx';
import { LegalFooter, PrivacyPage, TermsPage } from './components/Legal.tsx';
import { SignupScreen } from './components/SignupScreen.tsx';
import { AdminPage } from './components/AdminPage.tsx';
import { Avatar } from './components/Avatar.tsx';
import { BootScreen, Spinner, WorkspaceSkeleton } from './components/Loading.tsx';
import { Home, scopeList } from './components/Home.tsx';
import { SubmissionHistoryPage } from './components/SubmissionHistoryPage.tsx';
import { blankProblem } from './lib/blank.ts';
import { useDraftSync } from './lib/drafts.ts';
import { loginHref, useMe } from './lib/me.ts';

// 문제 화면(에디터)은 무거우므로 열 때만 받는다. 목록 화면이 뜨면 미리 받아 둔다(prefetchWorkspace).
const loadWorkspace = () => import('./components/Workspace.tsx');
const Workspace = lazy(() => loadWorkspace().then((m) => ({ default: m.Workspace })));
const prefetchWorkspace = () => {
  const run = () => void loadWorkspace();
  if ('requestIdleCallback' in globalThis) globalThis.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
};

/** 경로로 여는 화면(로그인 없이도 열림). 나머지는 해시 라우터(#/...)가 다룬다. */
export function App() {
  switch (location.pathname) {
    case '/terms':
      return <TermsPage />;
    case '/privacy':
      return <PrivacyPage />;
    case '/signup':
      return <SignupScreen />;
    case '/admin':
      return <AdminPage />;
    case '/login':
      return <LoginScreen />;
    default:
      return <Main />;
  }
}

function Main() {
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity });
  if (session.isPending) return <BootScreen />;
  if (session.isError)
    return (
      <div className="p-6 text-[13px]">
        <p className="font-semibold text-bad">{session.error instanceof ApiError ? session.error.message : '서버에 연결할 수 없어요'}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void session.refetch()}>
          다시 시도
        </button>
      </div>
    );
  // 로그인 오류로 돌아왔으면 로그인 화면, 아니면 비회원도 문제를 둘러볼 수 있다
  if (!session.data.authenticated && new URLSearchParams(location.search).has('auth_error')) return <LoginScreen />;
  return <Shell key={session.data.user?.email ?? 'guest'} />;
}

/** 목록에서 id 바로 뒤 문제(없으면 null) */
function nextProblemId(id: string, list: { id: string }[]) {
  const i = list.findIndex((p) => p.id === id);
  return i >= 0 ? (list[i + 1]?.id ?? null) : null;
}

function Shell() {
  const me = useMe();
  const sync = useDraftSync(me?.email);
  const qc = useQueryClient();
  const [route, go] = useRoute();
  // 로고를 누를 때마다 초기 화면을 새로 그린다: 이미 초기 화면이어도 맨 위(컬렉션 카드)로, 검색어도 지운다
  const [homeKey, setHomeKey] = useState(0);
  const [creating, setCreating] = useState(false);
  useEffect(prefetchWorkspace, []);
  // 홈에서 마지막으로 보던 범위. 문제를 닫으면 그 범위로 돌아간다.
  const [lastScope, setLastScope] = useState<Scope>(route.kind === 'home' ? route.scope : { kind: 'collections' });
  useEffect(() => {
    if (route.kind === 'home') setLastScope(route.scope);
  }, [route]);

  const logout = useMutation({
    mutationFn: () => { sync?.stop(); return api.logout(); },
    onSettled: () => {
      const out: Session = { authenticated: false, expiresAt: null, user: null };
      qc.setQueryData(qk.session, out);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] });
    },
  });

  // 다음 문제: 들어온 목록(마지막으로 본 범위)의 순서에서 현재 문제 바로 뒤
  const problems = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const collections = useQuery({ queryKey: qk.collections, queryFn: api.collections });
  const nextId = route.kind === 'problem' && problems.data && collections.data ? nextProblemId(route.id, scopeList(lastScope, problems.data, collections.data)) : null;

  let page: ReactNode;
  if (route.kind === 'problem')
    page = (
      <Suspense fallback={<WorkspaceSkeleton />}>
        <Workspace
          problemId={route.id}
          onDeleted={() => go({ kind: 'home', scope: lastScope })}
          onNext={nextId ? () => go({ kind: 'problem', id: nextId }) : undefined}
          onList={() => go({ kind: 'home', scope: lastScope })}
        />
      </Suspense>
    );
  else if (route.kind === 'submissions') page = <SubmissionHistoryPage onPickProblem={(id) => go({ kind: 'problem', id })} />;
  else
    page = (
      <div key={homeKey} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Home
          scope={route.scope}
          onScope={(scope) => go({ kind: 'home', scope })}
          onPick={(id) => go({ kind: 'problem', id })}
          onNew={() => setCreating(true)}
        />
        <LegalFooter admin={!!me?.owner} />
      </div>
    );

  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="code-focus-hide flex h-12 shrink-0 items-center gap-2 border-b border-line bg-[#0f1922] px-3 sm:px-4">
        <a
          href="#/"
          className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-raised"
          title="문제 선택 화면으로"
          onClick={(e) => {
            e.preventDefault();
            setHomeKey((k) => k + 1);
            go({ kind: 'home', scope: { kind: 'collections' } });
          }}
        >
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="text-[15px] font-extrabold tracking-tight max-[359px]:hidden">Solveline</span>
        </a>
        {route.kind === 'problem' && (
          <button type="button" className="btn-quiet ml-1" onClick={() => go({ kind: 'home', scope: lastScope })}>
            ← 문제 목록
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {me && <a href="#/submissions" className={`btn-quiet ${route.kind === 'submissions' ? 'text-accent-text' : ''}`} aria-current={route.kind === 'submissions' ? 'page' : undefined}>제출 기록</a>}
          <UserMenu onLogout={() => logout.mutate()} />
        </div>
      </header>

      {page}

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

/** 상단바 오른쪽: 로그인한 계정. 누르면 로그아웃. */
function UserMenu({ onLogout }: Readonly<{ onLogout: () => void }>) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('[data-user-menu]')) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!me)
    return (
      <a href={loginHref()} className="btn-primary min-h-8 px-3 text-[12.5px]">
        로그인
      </a>
    );
  const temporary = me.email.endsWith('@temporary.invalid');
  const label = temporary ? me.name : me.email;
  return (
    <div className="relative" data-user-menu>
      <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Avatar picture={me.picture} email={me.email} name={temporary ? me.name : undefined} size={24} />
        <span className="hidden max-w-56 truncate text-[12.5px] text-dim sm:inline">{label}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-60 rounded-lg border border-line-strong bg-panel p-1.5 shadow-2xl">
          <div className="border-b border-line px-2.5 pt-1.5 pb-2.5">
            <p className="truncate text-[13px] font-semibold">{me.name || me.email}</p>
            <p className="truncate text-[12px] text-dim">{temporary ? '임시 계정' : me.email}</p>
            {me.editor && <p className="mt-1 text-[11.5px] font-bold text-accent-text">편집 권한</p>}
          </div>
          <button type="button" className="mt-1 w-full rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-raised" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

/** 새 문제: 보던 폴더를 기본값으로 하고, 컬렉션을 보던 중이면 그 컬렉션 끝에 넣는다. */
function NewProblemDialog({ scope, onClose, onCreated }: Readonly<{ scope: Scope; onClose: () => void; onCreated: (id: string) => void }>) {
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
    <dialog open className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 h-auto max-h-none w-auto max-w-none text-inherit" aria-modal="true" aria-label="새 문제">
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
                ['function', 'solution 함수', '함수를 완성하는 문제'],
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
            {create.isPending ? (
              <>
                <Spinner size={14} /> 만드는 중
              </>
            ) : (
              '만들기'
            )}
          </button>
        </div>
      </form>
    </dialog>
  );
}
