import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Language, type Problem, type ProblemInput, type ProblemMode, type Submission, type TestCase } from '@solveline/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { BookmarkStar } from './BookmarkStar.tsx';
import { CasesEditor, MAX_CASES } from './CasesEditor.tsx';
import { newCase } from '../lib/blank.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { useNarrow } from '../lib/media.ts';
import { ResultPanel, type RunState } from './ResultPanel.tsx';
import { PausedOverlay, SolveTimerBadge, useSolveTimer } from './SolveTimer.tsx';
import { SolvedDialog } from './SolvedDialog.tsx';
import { DEFAULT_LAYOUT, Splitter, useLayout } from './Splitter.tsx';
import { Spinner, WorkspaceSkeleton } from './Loading.tsx';
import { draftQueue, inputChanges, useDraftState } from '../lib/drafts.ts';
import { applyPatch, type DraftQueue, type DraftState } from '../lib/draft-queue.ts';
import { loginHref, useMe } from '../lib/me.ts';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

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

/** 끝난 제출을 결과 패널 상태로 바꾼다 */
function runStateOf(s: Submission, submit: boolean, cases: TestCase[], d: ProblemInput): RunState {
  const done = (cancelled?: true): RunState => ({ kind: 'done', result: s.result!, cases, mode: d.mode, limitMs: d.timeLimitMs, ...(cancelled && { cancelled }) });
  if (s.status === 'cancelled') return submit || !s.result ? { kind: 'cancelled', submit } : done(true);
  if (s.status === 'error' || !s.result) return { kind: 'error', message: s.error ?? '실행하지 못했어요' };
  return submit ? { kind: 'graded', result: s.result, score: s.score ?? 0 } : done();
}

/** 휴대폰 폭의 화면 탭(문제·코드·결과)과, 코드를 쓰는 동안 주변 막대를 숨기는 표시를 관리한다. */
function usePanes(narrow: boolean) {
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const [pane, setPaneState] = useState<Pane>('problem');
  const paneRef = useRef(pane);
  const [unseen, setUnseen] = useState(false);
  const setPane = useCallback((p: Pane) => {
    paneRef.current = p;
    setPaneState(p);
    if (p === 'result') setUnseen(false);
  }, []);
  /** 결과를 보여 줄 때: 휴대폰이면 결과 탭으로 */
  const showResult = useCallback(() => {
    if (narrowRef.current) setPane('result');
  }, [setPane]);
  /** 다른 탭을 보는 중에 결과가 나오면 새 결과 표시 */
  const markUnseenIfHidden = useCallback(() => {
    if (narrowRef.current && paneRef.current !== 'result') setUnseen(true);
  }, []);
  // 휴대폰 코드·결과 탭: 앱 상단바·문제 제목 줄을 숨겨 에디터·결과를 넓게(문제 탭으로 가면 다시 보인다)
  const codeFocus = narrow && pane !== 'problem';
  // 코드를 쓰는 중(에디터 초점 = 화상 키보드 열림): 탭·실행 바까지 숨겨 코드만 보여 준다
  const [typingRaw, setTyping] = useState(false);
  const typing = narrow && pane === 'code' && typingRaw;
  useEffect(() => {
    const root = document.documentElement;
    if (codeFocus) root.dataset.codeFocus = '';
    else delete root.dataset.codeFocus;
    if (typing) root.dataset.typing = '';
    else delete root.dataset.typing;
    return () => {
      delete root.dataset.codeFocus;
      delete root.dataset.typing;
    };
  }, [codeFocus, typing]);
  return { pane, setPane, unseen, showResult, markUnseenIfHidden, codeFocus, setTyping };
}

type Tab = 'desc' | 'cases' | 'memo';
type Pane = 'problem' | 'code' | 'result';
type Queue = DraftQueue | null;
type Solve = ReturnType<typeof useSolveTimer>;

const resultLabel = (run: RunState) => (run.kind === 'graded' || (run.kind === 'running' && run.submit) ? '채점 결과' : '실행 결과');
/** 휴대폰이면 고른 탭일 때만 보이고, 넓은 화면이면 늘 보인다 */
const paneClass = (narrow: boolean, shown: boolean, narrowClass: string, wideClass: string) => {
  if (!narrow) return wideClass;
  return shown ? narrowClass : 'hidden';
};

/** 채점은 서버의 공용 케이스를 사용하므로 편집한 내용부터 반영한다. */
async function flushEdits(queue: Queue, id: string) {
  const pendingEdits = () => Object.keys(queue?.read(id)?.patch ?? {}).some((key) => key !== 'timer');
  while (queue && pendingEdits()) {
    if (!(await queue.flush(id))) throw new ApiError(0, 'sync_failed', '변경 내용을 동기화하지 못했어요. 연결을 확인해 주세요.');
  }
}

type RunHandle = { id: string | null; wake: () => void; stopping: boolean };
const idleHandle = (): RunHandle => ({ id: null, wake: () => {}, stopping: false });
const isActive = (s: Submission) => s.status === 'queued' || s.status === 'running';

/** 끝날 때까지 조회한다(처음엔 빠르게, 점점 느리게). 중지를 누르면 handle.wake로 바로 다시 조회한다. */
async function pollUntilDone(s: Submission, handle: RunHandle, onProgress: (s: Submission) => void) {
  let delay = 250;
  while (isActive(s)) {
    onProgress(s);
    await new Promise<void>((r) => {
      const t = setTimeout(r, delay);
      handle.wake = () => {
        clearTimeout(t);
        r();
      };
    });
    delay = Math.min(1500, Math.round(delay * 1.5));
    s = await api.submission(s.id);
  }
  return s;
}

/** 편집 중인 문제: 화면 상태와 서버 동기화 큐에 함께 반영한다 */
function useProblemDraft(problem: Problem, queue: Queue) {
  const [draft, setDraft] = useState<ProblemInput>(() => toInput(applyPatch(problem, queue?.read(problem.id)?.patch)));
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
  return { draft, draftRef, patch };
}

/** 코드 실행·채점: 제출 큐에 넣고, 진행 상태를 보여 주고, 중지를 처리한다 */
function useRunner({
  problem,
  queue,
  draftRef,
  panes,
  onNeedCases,
  onSolved,
}: {
  problem: Problem;
  queue: Queue;
  draftRef: { current: ProblemInput };
  panes: { showResult: () => void; markUnseenIfHidden: () => void };
  onNeedCases: () => void;
  onSolved: () => void;
}) {
  const qc = useQueryClient();
  const { showResult, markUnseenIfHidden } = panes;
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  /** 진행 중인 제출: 중지 버튼이 쓰는 id와, 조회 대기를 바로 깨우는 함수 */
  const current = useRef<RunHandle>(idleHandle());
  const [stopping, setStopping] = useState(false);

  const runMut = useMutation({
    mutationFn: async ({ cases, submit }: { cases: TestCase[]; submit: boolean }) => {
      await flushEdits(queue, problem.id);
      const d = draftRef.current;
      let s = await api.submit({ problemId: problem.id, kind: submit ? 'submit' : 'run', language: d.language, mode: d.mode, code: d.code[d.language], cases });
      current.current.id = s.id;
      // 제출 응답이 오기 전에 중지를 눌렀으면 지금 보낸다
      if (current.current.stopping) s = await api.cancelSubmission(s.id);
      return pollUntilDone(s, current.current, (p) => setRun({ kind: 'running', submit, ahead: p.status === 'queued' ? p.ahead : null }));
    },
    onSettled: () => {
      current.current = idleHandle();
      setStopping(false);
      markUnseenIfHidden();
    },
    onMutate: ({ submit }) => {
      setRun({ kind: 'running', submit, ahead: null });
      showResult();
    },
    onSuccess: (s, { cases, submit }) => {
      setRun(runStateOf(s, submit, cases, draftRef.current));
      if (!submit || s.status === 'cancelled' || s.status === 'error' || !s.result) return;
      void qc.invalidateQueries({ queryKey: ['submission-history'] });
      if (s.score === 100) onSolved();
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

  const refuse = useCallback(
    (message: string) => {
      onNeedCases();
      setRun({ kind: 'error', message });
      showResult();
    },
    [onNeedCases, showResult],
  );

  /** 코드 실행: 보이는 케이스만 */
  const doRun = useCallback(() => {
    if (runMut.isPending) return;
    const cases = [...draftRef.current.cases.filter((c) => !c.hidden), ...draftRef.current.myCases];
    if (cases.length === 0) return refuse('실행할 테스트 케이스가 없어요. 케이스를 추가하세요.');
    runMut.mutate({ cases, submit: false });
  }, [runMut, draftRef, refuse]);

  /** 제출 후 채점: 서버의 히든 테스트셋으로. 히든이 없으면 보이는 케이스로(기댓값 필요). */
  const doSubmit = useCallback(() => {
    if (runMut.isPending) return;
    const cases = draftRef.current.cases.filter((c) => !c.hidden);
    const gradable = !!problem.hiddenTestset?.count || (cases.length > 0 && cases.every((c) => c.expected.trim()));
    if (!gradable) return refuse('채점하려면 히든 케이스나 기댓값이 있는 테스트 케이스가 필요해요.');
    runMut.mutate({ cases, submit: true });
  }, [runMut, draftRef, problem.hiddenTestset, refuse]);

  return { run, pending: runMut.isPending, stopping, doRun, doSubmit, doStop };
}
type Runner = ReturnType<typeof useRunner>;

function Editor({ problem, onDeleted, onNext, onList }: { problem: Problem; onDeleted: () => void; onNext?: () => void; onList: () => void }) {
  const qc = useQueryClient();
  // 비회원: 문제를 볼 수만 있다(코드 작성·실행·저장은 로그인 후)
  const me = useMe();
  const guest = !me;
  // 편집 모드: 편집 권한이 있는 사용자만. 켜면 문제 내용·채점 케이스·폴더를 바꿀 수 있고 모든 사용자에게 적용된다.
  const canEdit = !!me?.editor;
  const queue = draftQueue(me?.email);
  const { draft, draftRef, patch } = useProblemDraft(problem, queue);
  const solve = useSolveTimer(problem, queue);
  const { layout, set: setLayout } = useLayout();
  const rowRef = useRef<HTMLDivElement>(null);
  const [solvedOpen, setSolvedOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(problem.description.trim() ? 'desc' : 'cases');
  const [editing, setEditing] = useState(false);
  const [resets, setResets] = useState(0);
  // 휴대폰 폭: 문제·코드·결과를 탭으로 나눠 한 번에 하나만 크게 보여 준다
  const narrow = useNarrow();
  const panes = usePanes(narrow);
  const showCases = useCallback(() => setTab('cases'), []);
  const runner = useRunner({
    problem,
    queue,
    draftRef,
    panes,
    onNeedCases: showCases,
    onSolved: () => {
      solve.markSolved();
      setSolvedOpen(true);
    },
  });

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

  const lang = draft.language;
  const starter = draft.starterCode ?? problem.starterCode;
  const reset = () => {
    if (!confirm(`${languageName(lang)} 코드를 시작 코드로 되돌릴까요?`)) return;
    patch({ code: { ...draft.code, [lang]: starter[lang] } });
    setResets((n) => n + 1);
  };
  /** 편집 모드: 지금 에디터의 코드를 이 문제의 시작 코드(모든 사용자 공용)로 */
  const saveAsStarter = () => {
    if (!confirm(`지금 ${languageName(lang)} 코드를 모든 사용자의 시작 코드로 저장할까요?`)) return;
    patch({ starterCode: { ...starter, [lang]: draft.code[lang] } });
  };
  const toggleEditing = () => {
    setEditing(!editing);
    if (!editing) setTab('desc');
  };
  const addCase = () => {
    setTab('cases');
    if (draft.myCases.length < MAX_CASES) patch({ myCases: [...draft.myCases, newCase(draft.params.length)] });
  };

  /** 하단 실행 바. 휴대폰에서는 탭과 상관없이 늘 보이게 화면 맨 아래에 둔다. */
  const footer = guest ? (
    <GuestFooter narrow={narrow} />
  ) : (
    <RunFooter narrow={narrow} editing={editing} runner={runner} hiddenCount={problem.hiddenTestset?.count} onReset={reset} onAddCase={addCase} onSaveStarter={saveAsStarter} />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TitleBar
        problem={problem}
        draft={draft}
        patch={patch}
        queue={queue}
        solve={solve}
        guest={guest}
        canEdit={canEdit}
        editing={editing}
        narrow={narrow}
        hidden={panes.codeFocus}
        deleting={delMut.isPending}
        onDelete={() => delMut.mutate()}
        onToggleEditing={toggleEditing}
        onSaveStarter={saveAsStarter}
      />
      {editing && !panes.codeFocus && <p className="border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-[12px] text-warn">편집 모드 · 바꾼 내용은 모든 사용자에게 적용돼요</p>}
      {narrow && <PaneTabs pane={panes.pane} onPane={panes.setPane} compact={panes.codeFocus} runner={runner} unseen={panes.unseen} />}
      {solvedOpen && <SolvedDialog solvedMs={solve.timer.solvedMs ?? solve.timer.elapsedMs} onNext={onNext} onList={onList} onClose={() => setSolvedOpen(false)} />}
      <div ref={rowRef} className="relative flex min-h-0 flex-1 flex-col md:flex-row" style={{ '--left': `${layout.leftPct}%` } as React.CSSProperties}>
        <Paused solve={solve} />
        {/* 왼쪽: 문제 설명 / 테스트 케이스 */}
        <section className={paneClass(narrow, panes.pane === 'problem', 'flex min-h-0 flex-1 flex-col', 'flex min-h-[260px] flex-col md:w-(--left) md:min-w-[280px] md:shrink-0')}>
          <ProblemTabs tab={tab} onTab={setTab} guest={guest} draft={draft} />
          <div className="min-h-0 flex-1 overflow-y-auto bg-panel">
            <ProblemBody tab={tab} problem={problem} draft={draft} patch={patch} guest={guest} editing={editing} />
          </div>
        </section>
        {!narrow && <Splitter direction="vertical" container={rowRef} value={layout.leftPct} defaultValue={DEFAULT_LAYOUT.leftPct} label="문제·에디터 너비" onChange={(v) => setLayout('leftPct', v)} />}
        {/* 오른쪽: 에디터 + 실행 결과 */}
        <CodePane
          narrow={narrow}
          pane={panes.pane}
          draft={draft}
          readOnly={guest}
          docKey={`${lang}:${resets}`}
          onCode={(v) => patch({ code: { ...draftRef.current.code, [lang]: v } })}
          onFocusChange={panes.setTyping}
          runner={runner}
          editorPct={layout.editorPct}
          onEditorPct={(v) => setLayout('editorPct', v)}
          footer={footer}
        />
      </div>
      {narrow && footer}
    </div>
  );
}

function Paused({ solve }: { solve: Solve }) {
  if (!solve.timer.paused || solve.timer.solvedMs !== null) return null;
  return <PausedOverlay elapsedMs={solve.timer.elapsedMs} onResume={solve.resume} />;
}

function GuestFooter({ narrow }: { narrow: boolean }) {
  return (
    <footer className="pb-safe flex shrink-0 items-center gap-2 border-t border-line bg-base px-3 py-2 sm:px-4">
      <a href={loginHref()} className={`btn-primary touch-target ${narrow ? 'w-full' : 'ml-auto min-w-32'}`}>
        로그인하기
      </a>
    </footer>
  );
}

function RunFooter({
  narrow,
  editing,
  runner,
  hiddenCount,
  onReset,
  onAddCase,
  onSaveStarter,
}: {
  narrow: boolean;
  editing: boolean;
  runner: Runner;
  hiddenCount: number | undefined;
  onReset: () => void;
  onAddCase: () => void;
  onSaveStarter: () => void;
}) {
  const { pending, run } = runner;
  return (
    <footer className={`pb-safe flex shrink-0 items-center gap-2 border-t border-line bg-base px-3 py-2 sm:px-4 ${narrow ? 'keyboard-hide typing-hide' : 'flex-wrap'}`}>
      <button type="button" className="btn-ghost touch-target" onClick={onReset} aria-label="초기화" title="시작 코드로 되돌리기">
        {narrow ? '↺' : '초기화'}
      </button>
      <button type="button" className={`btn-ghost touch-target ${narrow ? 'hidden' : ''}`} onClick={onAddCase}>
        테스트 케이스 추가하기
      </button>
      {editing && !narrow && (
        <button type="button" className="btn-quiet text-[12px]" onClick={onSaveStarter} title="모든 사용자의 시작 코드가 바뀌어요">
          시작 코드로 저장
        </button>
      )}
      <div className={`ml-auto flex gap-2 ${narrow ? 'flex-1 justify-end' : ''}`}>
        {pending && <StopButton runner={runner} />}
        <button type="button" className={`btn-ghost touch-target ${narrow ? 'flex-1' : 'min-w-24'}`} disabled={pending} onClick={runner.doRun} title="보이는 케이스로 실행 (⌘/Ctrl + Enter)">
          코드 실행
        </button>
        <button type="button" className={`btn-primary touch-target ${narrow ? 'flex-[1.4]' : 'min-w-32'}`} disabled={pending} onClick={runner.doSubmit} title={hiddenCount ? `히든 케이스 ${hiddenCount}개로 채점` : '보이는 케이스로 채점'}>
          {pending ? (
            <>
              <Spinner size={14} /> {run.kind === 'running' && run.submit ? '채점 중' : '실행 중'}
            </>
          ) : (
            narrow ? '제출 후 채점' : '제출 후 채점하기'
          )}
        </button>
      </div>
    </footer>
  );
}

function StopButton({ runner }: { runner: Runner }) {
  return (
    <button type="button" className="btn-ghost touch-target min-w-20 text-bad" disabled={runner.stopping} onClick={() => void runner.doStop()} title="실행·채점 중지">
      {runner.stopping ? (
        <>
          <Spinner size={13} /> 중지 중
        </>
      ) : (
        '■ 중지'
      )}
    </button>
  );
}

function TitleBar({
  problem,
  draft,
  patch,
  queue,
  solve,
  guest,
  canEdit,
  editing,
  narrow,
  hidden,
  deleting,
  onDelete,
  onToggleEditing,
  onSaveStarter,
}: {
  problem: Problem;
  draft: ProblemInput;
  patch: (p: Partial<ProblemInput>) => void;
  queue: Queue;
  solve: Solve;
  guest: boolean;
  canEdit: boolean;
  editing: boolean;
  narrow: boolean;
  hidden: boolean;
  deleting: boolean;
  onDelete: () => void;
  onToggleEditing: () => void;
  onSaveStarter: () => void;
}) {
  const summaries = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const saveState = useDraftState(queue, problem.id);
  return (
    <div className={`flex items-center gap-2 border-b border-line bg-base px-3 py-2 sm:px-4 ${narrow ? 'flex-wrap gap-y-1.5' : 'flex-wrap'} ${hidden ? 'hidden' : ''}`}>
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
      <BookmarkStar id={problem.id} bookmarked={summaries.data?.find((p) => p.id === problem.id)?.bookmarked} />
      {!guest && <SaveBadge state={saveState} onRetry={() => void queue?.flush(problem.id)} />}
      {/* 휴대폰: 도구는 한 줄로 두고 가로로 밀어서 본다 */}
      <div className={narrow ? 'no-scrollbar flex w-full min-w-0 basis-full items-center gap-2 overflow-x-auto whitespace-nowrap' : 'contents'}>
        {!guest && <SolveTimerBadge timer={solve.timer} onReset={solve.reset} onPause={solve.pause} onResume={solve.resume} />}
        <LastScore problem={problem} />
        {/* 폴더는 개인 정리: 로그인하면 언제든 내 폴더로 옮긴다. 컬렉션(공용)은 편집 권한자만 넣고 뺀다. */}
        {guest ? <FolderName id={draft.folderId} /> : <FolderSelect value={draft.folderId} onChange={(folderId) => patch({ folderId })} />}
        {canEdit && <CollectionsMenu problemId={problem.id} />}
        <select
          value={draft.language}
          aria-label="언어"
          onChange={(e) => patch({ language: e.target.value as Language })}
          className="h-[34px] rounded-md border border-line-strong bg-raised px-2 text-[13px] font-semibold outline-none focus:border-accent"
        >
          <option value="java">Java</option>
          <option value="python">Python3</option>
        </select>
        {canEdit && <EditTools title={draft.title} editing={editing} narrow={narrow} deleting={deleting} onDelete={onDelete} onToggle={onToggleEditing} onSaveStarter={onSaveStarter} />}
      </div>
    </div>
  );
}

function LastScore({ problem }: { problem: Problem }) {
  const sub = problem.lastSubmission;
  if (!sub) return null;
  const solved = sub.score === 100;
  return (
    <span className={`text-[12px] font-semibold ${solved ? 'text-ok' : 'text-warn'}`} title={new Date(sub.at).toLocaleString('ko-KR')}>
      {solved ? '✓' : `△ ${sub.score}점`}
    </span>
  );
}

function EditTools({
  title,
  editing,
  narrow,
  deleting,
  onDelete,
  onToggle,
  onSaveStarter,
}: {
  title: string;
  editing: boolean;
  narrow: boolean;
  deleting: boolean;
  onDelete: () => void;
  onToggle: () => void;
  onSaveStarter: () => void;
}) {
  return (
    <>
      {editing && narrow && (
        <button type="button" className="btn-quiet px-2 text-[12px]" onClick={onSaveStarter}>
          시작 코드로 저장
        </button>
      )}
      {editing && (
        <button type="button" className="btn-quiet px-2 text-[12px]" disabled={deleting} onClick={() => confirm(`"${title}" 문제를 모든 사용자에게서 삭제할까요? 되돌릴 수 없어요.`) && onDelete()}>
          삭제
        </button>
      )}
      <button
        type="button"
        className={editing ? 'btn-primary px-3' : 'btn-ghost px-3'}
        aria-pressed={editing}
        title="문제 내용·채점 케이스·폴더를 바꿉니다. 바꾸면 모든 사용자에게 적용돼요."
        onClick={onToggle}
      >
        {editing ? '편집 끝내기' : '편집 모드'}
      </button>
    </>
  );
}

function PaneTabs({ pane, onPane, compact, runner, unseen }: { pane: Pane; onPane: (p: Pane) => void; compact: boolean; runner: Runner; unseen: boolean }) {
  const tabs: [Pane, string][] = [
    ['problem', '문제'],
    ['code', '코드'],
    ['result', resultLabel(runner.run)],
  ];
  return (
    <nav className="typing-hide grid shrink-0 grid-cols-3 border-b border-line bg-base" aria-label="문제 화면">
      {tabs.map(([p, label]) => (
        <button
          key={p}
          type="button"
          aria-pressed={pane === p}
          onClick={() => onPane(p)}
          className={`relative border-b-2 text-[13.5px] font-semibold ${compact ? 'h-10' : 'h-11'} ${pane === p ? 'border-accent text-text' : 'border-transparent text-dim'}`}
        >
          {label}
          {p === 'result' && <ResultDot pending={runner.pending} unseen={unseen} />}
        </button>
      ))}
    </nav>
  );
}

function ResultDot({ pending, unseen }: { pending: boolean; unseen: boolean }) {
  if (pending) return <Spinner size={11} />;
  if (!unseen) return null;
  return <span className="absolute top-3 ml-1 inline-block size-1.5 rounded-full bg-accent" aria-label="새 결과" />;
}

function tabLabel(t: Tab, draft: ProblemInput): string {
  if (t === 'desc') return '문제 설명';
  if (t === 'cases') return `테스트 케이스 ${draft.cases.filter((c) => !c.hidden).length + draft.myCases.length}`;
  return draft.memo.trim() ? '메모 •' : '메모';
}

function ProblemTabs({ tab, onTab, guest, draft }: { tab: Tab; onTab: (t: Tab) => void; guest: boolean; draft: ProblemInput }) {
  const tabs: readonly Tab[] = guest ? ['desc', 'cases'] : ['desc', 'cases', 'memo'];
  return (
    <div className="pane-title gap-0 px-1">
      {tabs.map((t) => (
        <button key={t} type="button" onClick={() => onTab(t)} className={`h-full shrink-0 border-b-2 px-3 ${tab === t ? 'border-accent text-text' : 'border-transparent hover:text-text'}`}>
          {tabLabel(t, draft)}
        </button>
      ))}
    </div>
  );
}

function ProblemBody({ tab, problem, draft, patch, guest, editing }: { tab: Tab; problem: Problem; draft: ProblemInput; patch: (p: Partial<ProblemInput>) => void; guest: boolean; editing: boolean }) {
  if (tab === 'memo')
    return (
      <textarea
        value={draft.memo}
        onChange={(e) => patch({ memo: e.target.value })}
        placeholder="풀이 아이디어, 막힌 부분, 다시 볼 점을 적어 두세요. 나만 볼 수 있어요."
        aria-label="내 메모"
        className="h-full min-h-[240px] w-full resize-none bg-transparent p-4 text-[14px] leading-relaxed outline-none placeholder:text-faint"
      />
    );
  if (tab === 'desc') return <Description value={draft.description} editing={editing} onChange={(description) => patch({ description })} />;
  return (
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
  );
}

function Description({ value, editing, onChange }: { value: string; editing: boolean; onChange: (v: string) => void }) {
  if (editing)
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="문제 설명을 Markdown으로 작성하세요. 제목, 목록, 표, 코드 블록, 링크를 쓸 수 있어요."
        className="h-full min-h-[240px] w-full resize-none bg-transparent p-4 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        autoFocus
      />
    );
  return (
    <div className="markdown-body p-4 text-[14px] leading-[1.75] text-text/90">
      {value.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml>
          {value}
        </ReactMarkdown>
      ) : (
        <span className="text-faint">문제 설명이 없어요.</span>
      )}
    </div>
  );
}

function CodePane({
  narrow,
  pane,
  draft,
  readOnly,
  docKey,
  onCode,
  onFocusChange,
  runner,
  editorPct,
  onEditorPct,
  footer,
}: {
  narrow: boolean;
  pane: Pane;
  draft: ProblemInput;
  readOnly: boolean;
  docKey: string;
  onCode: (v: string) => void;
  onFocusChange: (focused: boolean) => void;
  runner: Runner;
  editorPct: number;
  onEditorPct: (v: number) => void;
  footer: React.ReactNode;
}) {
  const rightRef = useRef<HTMLElement>(null);
  const lang = draft.language;
  return (
    <section ref={rightRef} className={narrow && pane === 'problem' ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
      {!narrow && (
        <div className="pane-title">
          <span>solution.{lang === 'java' ? 'java' : 'py'}</span>
        </div>
      )}
      <div className={paneClass(narrow, pane === 'code', 'min-h-0 flex-1', 'min-h-[300px] md:min-h-0')} style={narrow ? undefined : { flex: `${editorPct} 1 0` }}>
        <CodeEditor compact={narrow} onFocusChange={onFocusChange} visible={!narrow || pane === 'code'} readOnly={readOnly} docKey={docKey} value={draft.code[lang]} language={lang} onChange={onCode} onRun={runner.doRun} />
      </div>
      {!narrow && (
        <>
          <Splitter direction="horizontal" container={rightRef} value={editorPct} defaultValue={DEFAULT_LAYOUT.editorPct} label="에디터·실행 결과 높이" onChange={onEditorPct} />
          <div className="pane-title">{resultLabel(runner.run)}</div>
        </>
      )}
      <div
        className={paneClass(narrow, pane === 'result', 'min-h-0 flex-1 overflow-y-auto bg-panel', 'min-h-[180px] overflow-y-auto bg-panel md:min-h-0')}
        style={narrow ? undefined : { flex: `${100 - editorPct} 1 0` }}
      >
        <ResultPanel state={runner.run} />
      </div>
      {!narrow && footer}
    </section>
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
      title="내 폴더"
      onChange={(e) => onChange(e.target.value || null)}
      className="h-[34px] max-w-40 rounded-md border border-line-strong bg-raised px-2 text-[13px] outline-none focus:border-accent"
    >
      <option value="">▤ 내 폴더 없음</option>
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
