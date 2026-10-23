import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Language, type Problem, type ProblemInput, type ProblemMode, type TestCase } from '@solveline/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { CasesEditor, MAX_CASES } from './CasesEditor.tsx';
import { newCase } from '../lib/blank.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { ResultPanel, type RunState } from './ResultPanel.tsx';
import { PausedOverlay, SolveTimerBadge, useSolveTimer } from './SolveTimer.tsx';
import { SolvedDialog } from './SolvedDialog.tsx';
import { DEFAULT_LAYOUT, Splitter, useLayout } from './Splitter.tsx';
import { Spinner, WorkspaceSkeleton } from './Loading.tsx';
import { draftQueue, inputChanges, useDraftState } from '../lib/drafts.ts';
import { applyPatch, type DraftState } from '../lib/draft-queue.ts';
import { loginHref, useMe } from '../lib/me.ts';

const toInput = (p: Problem): ProblemInput => ({
  title: p.title,
  folderId: p.folderId,
  description: p.description,
  mode: p.mode,
  params: p.params,
  timeLimitMs: p.timeLimitMs,
  cases: p.cases,
  language: p.language,
  code: p.code,
  starterCode: p.starterCode,
  myCases: p.myCases,
  memo: p.memo,
  lastSubmission: p.lastSubmission,
});

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const languageName = (l: Language) => (l === 'java' ? 'Java' : 'Python3');

export function Workspace({ problemId, onDeleted, onNext, onList }: { problemId: string; onDeleted: () => void; onNext?: () => void; onList: () => void }) {
  const q = useQuery({ queryKey: qk.problem(problemId), queryFn: () => api.problem(problemId), staleTime: Infinity });

  if (q.isPending) return <WorkspaceSkeleton />;
  if (q.isError)
    return (
      <div className="p-6 text-[13px]">
        <p className="font-semibold text-bad">{errMsg(q.error)}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void q.refetch()}>
          다시 시도
        </button>
      </div>
    );
  return <Editor key={problemId} problem={q.data} onDeleted={onDeleted} onNext={onNext} onList={onList} />;
}

function Editor({ problem, onDeleted, onNext, onList }: { problem: Problem; onDeleted: () => void; onNext?: () => void; onList: () => void }) {
  const qc = useQueryClient();
  // 비회원: 문제를 볼 수만 있다(코드 작성·실행·저장은 로그인 후)
  const me = useMe();
  const guest = !me;
  const queue = draftQueue(me?.email);
  const [draft, setDraft] = useState<ProblemInput>(() => toInput(applyPatch(problem, queue?.read(problem.id)?.patch)));
  const saveState = useDraftState(queue, problem.id);
  const solve = useSolveTimer(problem, queue);
  const { layout, set: setLayout } = useLayout();
  const rowRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const [solvedOpen, setSolvedOpen] = useState(false);
  const [tab, setTab] = useState<'desc' | 'cases' | 'memo'>(problem.description.trim() ? 'desc' : 'cases');
  // 편집 모드: 편집 권한이 있는 사용자만. 켜면 문제 내용·채점 케이스·폴더를 바꿀 수 있고 모든 사용자에게 적용된다.
  const canEdit = !!me?.editor;
  const [editing, setEditing] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [resets, setResets] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const patch = useCallback(
    (p: Partial<ProblemInput>) => {
      const previous = draftRef.current;
      const next = { ...previous, ...p };
      draftRef.current = next;
      setDraft(next);
      queue?.edit(problem.id, inputChanges(previous, next));
    },
    [queue, problem.id],
  );

  const lang = draft.language;
  const code = draft.code[lang];

  /** 진행 중인 제출: 중지 버튼이 쓰는 id와, 조회 대기를 바로 깨우는 함수 */
  const current = useRef<{ id: string | null; wake: () => void; stopping: boolean }>({ id: null, wake: () => {}, stopping: false });
  const [stopping, setStopping] = useState(false);

  /** 제출 큐에 넣고 끝날 때까지 조회한다(처음엔 빠르게, 점점 느리게). */
  const runMut = useMutation({
    mutationFn: async ({ cases, submit }: { cases: TestCase[]; submit: boolean }) => {
      // 채점은 서버의 공용 케이스를 사용하므로 편집한 내용부터 반영한다.
      while (queue?.read(problem.id) && Object.keys(queue.read(problem.id)!.patch).some((key) => key !== 'timer')) {
        if (!await queue.flush(problem.id)) throw new ApiError(0, 'sync_failed', '변경 내용을 동기화하지 못했어요. 연결을 확인해 주세요.');
      }
      const d = draftRef.current;
      let s = await api.submit({ problemId: problem.id, kind: submit ? 'submit' : 'run', language: d.language, mode: d.mode, code: d.code[d.language], cases });
      current.current.id = s.id;
      // 제출 응답이 오기 전에 중지를 눌렀으면 지금 보낸다
      if (current.current.stopping) s = await api.cancelSubmission(s.id);
      let delay = 250;
      while (s.status === 'queued' || s.status === 'running') {
        setRun({ kind: 'running', submit, ahead: s.status === 'queued' ? s.ahead : null });
        await new Promise<void>((r) => {
          const t = setTimeout(r, delay);
          current.current.wake = () => {
            clearTimeout(t);
            r();
          };
        });
        delay = Math.min(1500, Math.round(delay * 1.5));
        s = await api.submission(s.id);
      }
      return s;
    },
    onSettled: () => {
      current.current = { id: null, wake: () => {}, stopping: false };
      setStopping(false);
    },
    onMutate: ({ submit }) => setRun({ kind: 'running', submit, ahead: null }),
    onSuccess: (s, { cases, submit }) => {
      if (s.status === 'cancelled') {
        if (submit || !s.result) return setRun({ kind: 'cancelled', submit });
        return setRun({ kind: 'done', result: s.result, cases, mode: draftRef.current.mode, limitMs: draftRef.current.timeLimitMs, cancelled: true });
      }
      if (s.status === 'error' || !s.result) return setRun({ kind: 'error', message: s.error ?? '실행하지 못했어요' });
      if (!submit) return setRun({ kind: 'done', result: s.result, cases, mode: draftRef.current.mode, limitMs: draftRef.current.timeLimitMs });
      setRun({ kind: 'graded', result: s.result, score: s.score ?? 0 });
      void qc.invalidateQueries({ queryKey: ['submission-history'] });
      if (s.score === 100) {
        solve.markSolved();
        setSolvedOpen(true);
      }
      // 점수는 서버가 기록한다 → 문제·목록을 다시 읽는다
      void qc.invalidateQueries({ queryKey: qk.problem(problem.id) });
      void qc.invalidateQueries({ queryKey: qk.problems });
    },
    onError: (e) => setRun({ kind: 'error', message: errMsg(e) }),
  });

  /** 실행·채점 중지: 서버에 알리고, 결과 조회를 바로 다시 한다 */
  const doStop = useCallback(async () => {
    const cur = current.current;
    if (cur.stopping) return;
    cur.stopping = true;
    setStopping(true);
    if (!cur.id) return; // 제출 응답을 받으면 mutationFn이 보낸다
    try {
      await api.cancelSubmission(cur.id);
    } catch {
      /* 다음 조회에서 상태를 다시 본다 */
    }
    cur.wake();
  }, []);

  /** 코드 실행: 보이는 케이스만 */
  const doRun = useCallback(() => {
    if (runMut.isPending) return;
    const cases = [...draftRef.current.cases.filter((c) => !c.hidden), ...draftRef.current.myCases];
    if (cases.length === 0) {
      setTab('cases');
      setRun({ kind: 'error', message: '실행할 테스트 케이스가 없어요. 케이스를 추가하세요.' });
      return;
    }
    runMut.mutate({ cases, submit: false });
  }, [runMut]);

  /** 제출 후 채점: 서버의 히든 테스트셋으로. 히든이 없으면 보이는 케이스로(기댓값 필요). */
  const doSubmit = useCallback(() => {
    if (runMut.isPending) return;
    const cases = draftRef.current.cases.filter((c) => !c.hidden);
    if (!problem.hiddenTestset?.count && (cases.length === 0 || cases.some((c) => !c.expected.trim()))) {
      setTab('cases');
      setRun({ kind: 'error', message: '채점하려면 히든 케이스나 기댓값이 있는 테스트 케이스가 필요해요.' });
      return;
    }
    runMut.mutate({ cases, submit: true });
  }, [runMut, problem.hiddenTestset]);

  const delMut = useMutation({
    mutationFn: () => api.deleteProblem(problem.id),
    onSuccess: () => {
      queue?.discard(problem.id);
      qc.removeQueries({ queryKey: qk.problem(problem.id) });
      void qc.invalidateQueries({ queryKey: qk.problems });
      void qc.invalidateQueries({ queryKey: qk.collections });
      onDeleted();
    },
  });

  const starter = draft.starterCode ?? problem.starterCode;
  const reset = () => {
    if (!confirm(`${languageName(lang)} 코드를 시작 코드로 되돌릴까요?`)) return;
    patch({ code: { ...draft.code, [lang]: starter[lang] } });
    setResets((n) => n + 1);
  };
  /** 편집 모드: 지금 에디터의 코드를 이 문제의 시작 코드(모든 사용자 공용)로 */
  const saveAsStarter = () => {
    if (!confirm(`지금 ${languageName(lang)} 코드를 모든 사용자의 시작 코드로 저장할까요?`)) return;
    patch({ starterCode: { ...starter, [lang]: code } });
  };

  const visibleCount = draft.cases.filter((c) => !c.hidden).length + draft.myCases.length;
  const sub = problem.lastSubmission;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 문제 제목 줄 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-base px-3 py-2 sm:px-4">
        {editing ? (
          <input
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            aria-label="문제 제목"
            className="min-w-0 flex-1 basis-56 rounded bg-raised/60 px-1 py-1 text-[15px] font-bold outline-none focus:bg-raised"
          />
        ) : (
          <h1 className="min-w-0 flex-1 basis-56 truncate px-1 py-1 text-[15px] font-bold">{draft.title}</h1>
        )}
        {!guest && <SaveBadge state={saveState} onRetry={() => void queue?.flush(problem.id)} />}
        {!guest && <SolveTimerBadge timer={solve.timer} onReset={solve.reset} onPause={solve.pause} onResume={solve.resume} />}
        {sub && (
          <span className={`text-[12px] font-semibold ${sub.score === 100 ? 'text-ok' : 'text-warn'}`} title={new Date(sub.at).toLocaleString('ko-KR')}>
            {sub.score === 100 ? '✓' : `△ ${sub.score}점`}
          </span>
        )}
        {editing ? <FolderSelect value={draft.folderId} onChange={(folderId) => patch({ folderId })} /> : <FolderName id={draft.folderId} />}
        {!guest && <CollectionsMenu problemId={problem.id} />}
        <select
          value={lang}
          aria-label="언어"
          onChange={(e) => patch({ language: e.target.value as Language })}
          className="h-[34px] rounded-md border border-line-strong bg-raised px-2 text-[13px] font-semibold outline-none focus:border-accent"
        >
          <option value="java">Java</option>
          <option value="python">Python3</option>
        </select>
        {editing && (
          <button
            type="button"
            className="btn-quiet px-2 text-[12px]"
            disabled={delMut.isPending}
            onClick={() => confirm(`"${draft.title}" 문제를 모든 사용자에게서 삭제할까요? 되돌릴 수 없어요.`) && delMut.mutate()}
          >
            삭제
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className={editing ? 'btn-primary px-3' : 'btn-ghost px-3'}
            aria-pressed={editing}
            title="문제 내용·채점 케이스·폴더를 바꿉니다. 바꾸면 모든 사용자에게 적용돼요."
            onClick={() => {
              setEditing((v) => !v);
              setEditingDesc(false);
            }}
          >
            {editing ? '편집 끝내기' : '편집 모드'}
          </button>
        )}
      </div>
      {editing && (
        <p className="border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-[12px] text-warn">편집 모드 · 바꾼 내용은 모든 사용자에게 적용돼요</p>
      )}

      {solvedOpen && (
        <SolvedDialog
          solvedMs={solve.timer.solvedMs ?? solve.timer.elapsedMs}
          onNext={onNext}
          onList={onList}
          onClose={() => setSolvedOpen(false)}
        />
      )}
      <div ref={rowRef} className="relative flex min-h-0 flex-1 flex-col lg:flex-row" style={{ '--left': `${layout.leftPct}%` } as React.CSSProperties}>
        {solve.timer.paused && solve.timer.solvedMs === null && <PausedOverlay elapsedMs={solve.timer.elapsedMs} onResume={solve.resume} />}
        {/* 왼쪽: 문제 설명 / 테스트 케이스 */}
        <section className="flex min-h-[260px] flex-col lg:w-(--left) lg:min-w-[280px] lg:shrink-0">
          <div className="pane-title gap-0 px-1">
            {(guest ? (['desc', 'cases'] as const) : (['desc', 'cases', 'memo'] as const)).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`h-full border-b-2 px-3 ${tab === t ? 'border-accent text-text' : 'border-transparent hover:text-text'}`}
              >
                {t === 'desc' ? '문제 설명' : t === 'cases' ? `테스트 케이스 ${visibleCount}` : draft.memo.trim() ? '메모 •' : '메모'}
              </button>
            ))}
            {tab === 'desc' && editing && (
              <button type="button" className="btn-quiet ml-auto min-h-7 px-2 text-[12px]" onClick={() => setEditingDesc((v) => !v)}>
                {editingDesc ? '완료' : '편집'}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-panel">
            {tab === 'memo' ? (
              <textarea
                value={draft.memo}
                onChange={(e) => patch({ memo: e.target.value })}
                placeholder="풀이 아이디어, 막힌 부분, 다시 볼 점을 적어 두세요. 나만 볼 수 있어요."
                aria-label="내 메모"
                className="h-full min-h-[240px] w-full resize-none bg-transparent p-4 text-[14px] leading-relaxed outline-none placeholder:text-faint"
              />
            ) : tab === 'desc' ? (
              editing && (editingDesc || !draft.description.trim()) ? (
                <textarea
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="문제 설명, 제한 사항, 입출력 예를 붙여 넣으세요."
                  className="h-full min-h-[240px] w-full resize-none bg-transparent p-4 text-[14px] leading-relaxed outline-none placeholder:text-faint"
                  autoFocus={editingDesc}
                />
              ) : (
                <div className="p-4 text-[14px] leading-[1.75] whitespace-pre-wrap text-text/90" onDoubleClick={() => editing && setEditingDesc(true)}>
                  {draft.description.trim() || <span className="text-faint">문제 설명이 없어요.</span>}
                </div>
              )
            ) : (
              <CasesEditor
                problemId={problem.id}
                guest={guest}
                editing={editing}
                mode={draft.mode}
                params={draft.params}
                cases={draft.cases}
                myCases={draft.myCases}
                onMyCases={(myCases) => patch({ myCases })}
                hidden={problem.hiddenTestset}
                timeLimitMs={draft.timeLimitMs}
                onTimeLimit={(timeLimitMs) => patch({ timeLimitMs })}
                onParams={(params) => patch({ params })}
                onCases={(cases) => patch({ cases })}
              />
            )}
          </div>
        </section>

        <Splitter
          direction="vertical"
          container={rowRef}
          value={layout.leftPct}
          defaultValue={DEFAULT_LAYOUT.leftPct}
          label="문제·에디터 너비"
          onChange={(v) => setLayout('leftPct', v)}
        />

        {/* 오른쪽: 에디터 + 실행 결과 */}
        <section ref={rightRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="pane-title">
            <span>solution.{lang === 'java' ? 'java' : 'py'}</span>
          </div>
          <div className="min-h-[300px] lg:min-h-0" style={{ flex: `${layout.editorPct} 1 0` }}>
            <CodeEditor readOnly={guest} docKey={`${lang}:${resets}`} value={code} language={lang} onChange={(v) => patch({ code: { ...draftRef.current.code, [lang]: v } })} onRun={doRun} />
          </div>
          <Splitter
            direction="horizontal"
            container={rightRef}
            value={layout.editorPct}
            defaultValue={DEFAULT_LAYOUT.editorPct}
            label="에디터·실행 결과 높이"
            onChange={(v) => setLayout('editorPct', v)}
          />
          <div className="pane-title">{run.kind === 'graded' || (run.kind === 'running' && run.submit) ? '채점 결과' : '실행 결과'}</div>
          <div className="min-h-[180px] overflow-y-auto bg-panel lg:min-h-0" style={{ flex: `${100 - layout.editorPct} 1 0` }}>
            <ResultPanel state={run} />
          </div>
          {guest ? (
            <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-base px-3 py-2 sm:px-4">
              <a href={loginHref()} className="btn-primary ml-auto min-w-32">
                로그인하기
              </a>
            </footer>
          ) : (
          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-base px-3 py-2 sm:px-4">
            <button type="button" className="btn-ghost" onClick={reset}>
              초기화
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setTab('cases');
                if (draft.myCases.length < MAX_CASES) patch({ myCases: [...draft.myCases, newCase(draft.params.length)] });
              }}
            >
              테스트 케이스 추가하기
            </button>
            {editing && (
              <button type="button" className="btn-quiet text-[12px]" onClick={saveAsStarter} title="모든 사용자의 시작 코드가 바뀌어요">
                시작 코드로 저장
              </button>
            )}
            <div className="ml-auto flex gap-2">
              {runMut.isPending && (
                <button type="button" className="btn-ghost min-w-20 text-bad" disabled={stopping} onClick={() => void doStop()} title="실행·채점 중지">
                  {stopping ? (
                    <>
                      <Spinner size={13} /> 중지 중
                    </>
                  ) : (
                    '■ 중지'
                  )}
                </button>
              )}
              <button type="button" className="btn-ghost min-w-24" disabled={runMut.isPending} onClick={doRun} title="보이는 케이스로 실행 (⌘/Ctrl + Enter)">
                코드 실행
              </button>
              <button type="button" className="btn-primary min-w-32" disabled={runMut.isPending} onClick={doSubmit} title={problem.hiddenTestset?.count ? `히든 케이스 ${problem.hiddenTestset.count}개로 채점` : '보이는 케이스로 채점'}>
                {runMut.isPending ? (
                  <>
                    <Spinner size={14} /> {run.kind === 'running' && run.submit ? '채점 중' : '실행 중'}
                  </>
                ) : (
                  '제출 후 채점하기'
                )}
              </button>
            </div>
          </footer>
          )}
        </section>
      </div>
    </div>
  );
}

function FolderName({ id }: { id: string | null }) {
  const folders = useQuery({ queryKey: qk.folders, queryFn: api.folders });
  const name = folders.data?.find((f) => f.id === id)?.name;
  return name ? <span className="max-w-40 truncate text-[12.5px] text-dim">▤ {name}</span> : null;
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
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const collection = await api.createCollection({ name: name.trim(), description: '' });
      setName('');
      try {
        return await api.setCollectionItems(collection.id, [problemId]);
      } catch {
        throw new Error('컬렉션은 만들었지만 문제를 추가하지 못했어요. 목록에서 다시 선택해 주세요.');
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.collections }),
  });
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
          {list.length > 0 && (
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
          <form
            className="mt-2 flex gap-1 border-t border-line pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !create.isPending) create.mutate();
            }}
          >
            <input className="field min-w-0 flex-1" aria-label="새 컬렉션 이름" placeholder="새 컬렉션 이름" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} disabled={create.isPending} />
            <button type="submit" className="btn-primary shrink-0 px-2" disabled={!name.trim() || create.isPending}>만들기</button>
          </form>
          {create.isError && <p role="alert" className="mt-2 text-[12px] text-bad">{create.error.message}</p>}
        </div>
      )}
    </div>
  );
}

function SaveBadge({ state, onRetry }: { state: DraftState; onRetry: () => void }) {
  if (state === 'error' || state === 'storage-error')
    return (
      <button type="button" onClick={onRetry} className="text-[12px] font-semibold text-bad underline">
        {state === 'storage-error' ? '로컬 저장 실패 · 서버 저장' : '기기에 보관 중 · 동기화 재시도'}
      </button>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-faint" aria-live="polite">
      {state === 'saved' || state === 'local' ? '✓ 저장됨' : <><Spinner size={11} /> 동기화 중</>}
    </span>
  );
}
