import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { templateFor, type Language, type Problem, type ProblemInput, type ProblemMode, type TestCase } from '@codetest/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { CasesEditor, MAX_CASES, newCase } from './CasesEditor.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { ResultPanel, type RunState } from './ResultPanel.tsx';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** 입력이 멈추고 이만큼 지나면 저장한다. 문제 전환·탭 숨김·페이지 이탈 때는 바로 저장한다. */
const SAVE_DELAY_MS = 300;
/** 브라우저가 keepalive 요청 본문을 64KB로 제한한다 */
const KEEPALIVE_LIMIT = 60_000;

const toInput = (p: Problem): ProblemInput => ({
  title: p.title,
  folderId: p.folderId,
  description: p.description,
  mode: p.mode,
  params: p.params,
  cases: p.cases,
  language: p.language,
  code: p.code,
  lastSubmission: p.lastSubmission,
});

export function blankProblem(title: string, mode: ProblemMode, language: Language, folderId: string | null = null): ProblemInput {
  const params = mode === 'function' ? ['numbers'] : [];
  return {
    title,
    folderId,
    description: '',
    mode,
    params,
    cases: [newCase(params.length)],
    language,
    code: { java: templateFor('java', mode, params), python: templateFor('python', mode, params) },
    lastSubmission: null,
  };
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const languageName = (l: Language) => (l === 'java' ? 'Java' : 'Python3');

export function Workspace({ problemId, onDeleted }: { problemId: string; onDeleted: () => void }) {
  const q = useQuery({ queryKey: qk.problem(problemId), queryFn: () => api.problem(problemId), staleTime: Infinity });

  if (q.isPending) return <p className="p-6 text-[13px] text-dim">불러오는 중…</p>;
  if (q.isError)
    return (
      <div className="p-6 text-[13px]">
        <p className="font-semibold text-bad">{errMsg(q.error)}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void q.refetch()}>
          다시 시도
        </button>
      </div>
    );
  return <Editor key={problemId} problem={q.data} onDeleted={onDeleted} />;
}

/** 실시간 저장: 짧은 지연 + 이탈 시 즉시. 요청은 순서대로 하나씩 보낸다. */
function useAutosave(problem: Problem, draft: ProblemInput) {
  const qc = useQueryClient();
  const [state, setState] = useState<SaveState>('saved');
  const dirty = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback(
    (opts: { keepalive?: boolean } = {}) => {
      if (!dirty.current) return;
      dirty.current = false;
      const sent = draftRef.current;
      // 다시 열었을 때 최신 내용이 보이도록 캐시를 먼저 바꾼다
      qc.setQueryData<Problem>(qk.problem(problem.id), (old) => (old ? { ...old, ...sent } : old));
      setState('saving');
      const keepalive = !!opts.keepalive && JSON.stringify(sent).length < KEEPALIVE_LIMIT;
      chain.current = chain.current
        .then(() => api.saveProblem(problem.id, sent, { keepalive }))
        .then((saved) => {
          if (draftRef.current === sent) qc.setQueryData(qk.problem(problem.id), saved);
          void qc.invalidateQueries({ queryKey: qk.problems });
          if (!dirty.current) setState('saved');
        })
        .catch(() => {
          dirty.current = true;
          setState('error');
        });
    },
    [problem.id, qc],
  );

  const markDirty = useCallback(() => {
    dirty.current = true;
    setState('dirty');
  }, []);

  // 입력 후 짧은 지연
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => flush(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [draft, flush]);

  // 탭 숨김·페이지 이탈·문제 전환(언마운트) 때 즉시 저장
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush({ keepalive: true });
    };
    const onPageHide = () => flush({ keepalive: true });
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flush({ keepalive: true });
      if (state === 'error') e.preventDefault();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [flush, state]);
  useEffect(() => () => flush(), [flush]);

  return { state, markDirty, retry: () => (markDirty(), flush()) };
}

function Editor({ problem, onDeleted }: { problem: Problem; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ProblemInput>(() => toInput(problem));
  const save = useAutosave(problem, draft);
  const [tab, setTab] = useState<'desc' | 'cases'>(problem.description.trim() ? 'desc' : 'cases');
  const [editingDesc, setEditingDesc] = useState(false);
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [resets, setResets] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const patch = useCallback(
    (p: Partial<ProblemInput>) => {
      setDraft((d) => ({ ...d, ...p }));
      save.markDirty();
    },
    [save],
  );

  const lang = draft.language;
  const code = draft.code[lang];

  const runMut = useMutation({
    mutationFn: ({ cases }: { cases: TestCase[]; submit: boolean }) => {
      const d = draftRef.current;
      return api.run({ language: d.language, mode: d.mode, code: d.code[d.language], cases });
    },
    onMutate: ({ submit }) => setRun({ kind: 'running', submit }),
    onSuccess: (result, { cases, submit }) => {
      if (!submit) return setRun({ kind: 'done', result, cases, mode: draftRef.current.mode });
      const passed = result.compile.ok ? result.results.filter((r) => r.status === 'pass').length : 0;
      const score = Math.round((passed / cases.length) * 100);
      setRun({ kind: 'graded', result, score });
      patch({ lastSubmission: { score, passed, total: cases.length, language: draftRef.current.language, at: new Date().toISOString() } });
    },
    onError: (e) => setRun({ kind: 'error', message: errMsg(e) }),
  });

  /** 코드 실행: 보이는 케이스만 */
  const doRun = useCallback(() => {
    if (runMut.isPending) return;
    const cases = draftRef.current.cases.filter((c) => !c.hidden);
    if (cases.length === 0) {
      setTab('cases');
      setRun({ kind: 'error', message: '보이는 테스트 케이스가 없어요. 케이스를 추가하세요.' });
      return;
    }
    runMut.mutate({ cases, submit: false });
  }, [runMut]);

  /** 제출 후 채점: 히든 케이스(없으면 전체). 기댓값이 모두 있어야 한다. */
  const doSubmit = useCallback(() => {
    if (runMut.isPending) return;
    const all = draftRef.current.cases;
    const hidden = all.filter((c) => c.hidden);
    const cases = hidden.length ? hidden : all;
    if (cases.length === 0 || cases.some((c) => !c.expected.trim())) {
      setTab('cases');
      setRun({ kind: 'error', message: '채점하려면 기댓값이 있는 테스트 케이스가 필요해요.' });
      return;
    }
    runMut.mutate({ cases, submit: true });
  }, [runMut]);

  const delMut = useMutation({
    mutationFn: () => api.deleteProblem(problem.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.problem(problem.id) });
      void qc.invalidateQueries({ queryKey: qk.problems });
      void qc.invalidateQueries({ queryKey: qk.collections });
      onDeleted();
    },
  });

  const reset = () => {
    if (!confirm(`${languageName(lang)} 코드를 기본 템플릿으로 되돌릴까요?`)) return;
    patch({ code: { ...draft.code, [lang]: templateFor(lang, draft.mode, draft.params) } });
    setResets((n) => n + 1);
  };

  const visibleCount = draft.cases.filter((c) => !c.hidden).length;
  const sub = draft.lastSubmission;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 문제 제목 줄 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-base px-3 py-2 sm:px-4">
        <input
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          aria-label="문제 제목"
          className="min-w-0 flex-1 basis-56 rounded bg-transparent px-1 py-1 text-[15px] font-bold outline-none hover:bg-raised/60 focus:bg-raised"
        />
        <SaveBadge state={save.state} onRetry={save.retry} />
        {sub && (
          <span className={`text-[12px] font-semibold ${sub.score === 100 ? 'text-ok' : 'text-warn'}`} title={new Date(sub.at).toLocaleString('ko-KR')}>
            {sub.score === 100 ? '✓' : '△'} 최근 제출 {sub.score}점
          </span>
        )}
        <FolderSelect value={draft.folderId} onChange={(folderId) => patch({ folderId })} />
        <CollectionsMenu problemId={problem.id} />
        <select
          value={lang}
          aria-label="언어"
          onChange={(e) => patch({ language: e.target.value as Language })}
          className="h-[34px] rounded-md border border-line-strong bg-raised px-2 text-[13px] font-semibold outline-none focus:border-accent"
        >
          <option value="java">Java</option>
          <option value="python">Python3</option>
        </select>
        <button
          type="button"
          className="btn-quiet px-2 text-[12px]"
          disabled={delMut.isPending}
          onClick={() => confirm(`"${draft.title}" 문제를 삭제할까요? 되돌릴 수 없어요.`) && delMut.mutate()}
        >
          삭제
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 왼쪽: 문제 설명 / 테스트 케이스 */}
        <section className="flex min-h-[260px] flex-col border-line lg:w-[40%] lg:min-w-[340px] lg:border-r">
          <div className="pane-title gap-0 px-1">
            {(['desc', 'cases'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`h-full border-b-2 px-3 ${tab === t ? 'border-accent text-text' : 'border-transparent hover:text-text'}`}
              >
                {t === 'desc' ? '문제 설명' : `테스트 케이스 ${visibleCount}`}
              </button>
            ))}
            {tab === 'desc' && (
              <button type="button" className="btn-quiet ml-auto min-h-7 px-2 text-[12px]" onClick={() => setEditingDesc((v) => !v)}>
                {editingDesc ? '완료' : '편집'}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-panel">
            {tab === 'desc' ? (
              editingDesc || !draft.description.trim() ? (
                <textarea
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="문제 설명, 제한 사항, 입출력 예를 붙여 넣으세요."
                  className="h-full min-h-[240px] w-full resize-none bg-transparent p-4 text-[14px] leading-relaxed outline-none placeholder:text-faint"
                  autoFocus={editingDesc}
                />
              ) : (
                <div className="p-4 text-[14px] leading-[1.75] whitespace-pre-wrap text-text/90" onDoubleClick={() => setEditingDesc(true)}>
                  {draft.description}
                </div>
              )
            ) : (
              <CasesEditor mode={draft.mode} params={draft.params} cases={draft.cases} onParams={(params) => patch({ params })} onCases={(cases) => patch({ cases })} />
            )}
          </div>
        </section>

        {/* 오른쪽: 에디터 + 실행 결과 */}
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="pane-title">
            <span>solution.{lang === 'java' ? 'java' : 'py'}</span>
          </div>
          <div className="min-h-[300px] flex-[3] lg:min-h-0">
            <CodeEditor docKey={`${lang}:${resets}`} value={code} language={lang} onChange={(v) => patch({ code: { ...draftRef.current.code, [lang]: v } })} onRun={doRun} />
          </div>
          <div className="pane-title border-t">{run.kind === 'graded' || (run.kind === 'running' && run.submit) ? '채점 결과' : '실행 결과'}</div>
          <div className="min-h-[180px] flex-[2] overflow-y-auto bg-panel lg:min-h-0">
            <ResultPanel state={run} />
          </div>
          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-base px-3 py-2 sm:px-4">
            <button type="button" className="btn-ghost" onClick={reset}>
              초기화
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setTab('cases');
                if (draft.cases.length < MAX_CASES) patch({ cases: [...draft.cases, newCase(draft.params.length)] });
              }}
            >
              테스트 케이스 추가하기
            </button>
            <div className="ml-auto flex gap-2">
              <button type="button" className="btn-ghost min-w-24" disabled={runMut.isPending} onClick={doRun} title="보이는 케이스로 실행 (⌘/Ctrl + Enter)">
                코드 실행
              </button>
              <button type="button" className="btn-primary min-w-32" disabled={runMut.isPending} onClick={doSubmit} title="히든 케이스로 채점">
                {runMut.isPending ? (run.kind === 'running' && run.submit ? '채점 중…' : '실행 중…') : '제출 후 채점하기'}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

function FolderSelect({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const folders = useQuery({ queryKey: qk.folders, queryFn: api.folders });
  return (
    <select
      value={value ?? ''}
      aria-label="폴더"
      title="폴더"
      onChange={(e) => onChange(e.target.value || null)}
      className="h-[34px] max-w-40 rounded-md border border-line-strong bg-raised px-2 text-[13px] outline-none focus:border-accent"
    >
      <option value="">▤ 폴더 없음</option>
      {folders.data?.map((f) => (
        <option key={f.id} value={f.id}>
          ▤ {f.name}
        </option>
      ))}
    </select>
  );
}

/** 이 문제가 들어 있는 컬렉션을 고른다. 컬렉션은 가상 묶음이라 여러 개 고를 수 있다. */
function CollectionsMenu({ problemId }: { problemId: string }) {
  const qc = useQueryClient();
  const collections = useQuery({ queryKey: qk.collections, queryFn: api.collections });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useMutation({
    mutationFn: ({ id, ids }: { id: string; ids: string[] }) => api.setCollectionItems(id, ids),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.collections }),
    onError: (e) => alert(errMsg(e)),
  });

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);

  const list = collections.data ?? [];
  const mine = list.filter((c) => c.problemIds.includes(problemId)).length;
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn-ghost px-2.5" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="컬렉션">
        <span className="text-sky">◆</span> 컬렉션{mine > 0 ? ` ${mine}` : ''}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-60 rounded-lg border border-line-strong bg-panel p-2 shadow-2xl">
          {list.length === 0 ? (
            <p className="p-2 text-[12.5px] text-faint">컬렉션이 없어요. 홈 화면 왼쪽에서 만들 수 있어요.</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {list.map((c) => {
                const checked = c.problemIds.includes(problemId);
                return (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-raised">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        checked={checked}
                        disabled={toggle.isPending}
                        onChange={() => toggle.mutate({ id: c.id, ids: checked ? c.problemIds.filter((x) => x !== problemId) : [...c.problemIds, problemId] })}
                      />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className="text-[11.5px] text-faint">{c.problemIds.length}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SaveBadge({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'error')
    return (
      <button type="button" onClick={onRetry} className="text-[12px] font-semibold text-bad underline">
        저장 실패 · 다시 시도
      </button>
    );
  return <span className="text-[12px] text-faint">{state === 'saved' ? '저장됨' : '저장 중…'}</span>;
}
