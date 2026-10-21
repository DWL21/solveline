import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { templateFor, type Language, type Problem, type ProblemInput, type ProblemMode } from '@codetest/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { CasesEditor, newCase } from './CasesEditor.tsx';
import { CodeEditor } from './CodeEditor.tsx';
import { ResultPanel, type RunState } from './ResultPanel.tsx';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const toInput = (p: Problem): ProblemInput => ({
  title: p.title,
  description: p.description,
  mode: p.mode,
  params: p.params,
  cases: p.cases,
  language: p.language,
  code: p.code,
});

export function blankProblem(title: string, mode: ProblemMode, language: Language): ProblemInput {
  const params = mode === 'function' ? ['numbers'] : [];
  return {
    title,
    description: '',
    mode,
    params,
    cases: [newCase(params.length)],
    language,
    code: { java: templateFor('java', mode, params), python: templateFor('python', mode, params) },
  };
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');

export function Workspace({ problemId, onDeleted }: { problemId: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.problem(problemId), queryFn: () => api.problem(problemId) });

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
  return <Editor key={problemId} problem={q.data} onDeleted={onDeleted} onSaved={(p) => {
    qc.setQueryData(qk.problem(p.id), p);
    void qc.invalidateQueries({ queryKey: qk.problems });
  }} />;
}

function Editor({ problem, onDeleted, onSaved }: { problem: Problem; onDeleted: () => void; onSaved: (p: Problem) => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ProblemInput>(() => toInput(problem));
  const [save, setSave] = useState<SaveState>('saved');
  const [tab, setTab] = useState<'desc' | 'cases'>(problem.description.trim() ? 'desc' : 'cases');
  const [editingDesc, setEditingDesc] = useState(false);
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [resets, setResets] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 변경 후 0.8초 뒤 자동 저장
  const saveMut = useMutation({
    mutationFn: (p: ProblemInput) => api.saveProblem(problem.id, p),
    onSuccess: (p, sent) => {
      onSaved(p);
      setSave(draftRef.current === sent ? 'saved' : 'dirty');
    },
    onError: () => setSave('error'),
  });
  useEffect(() => {
    if (save !== 'dirty') return;
    const t = setTimeout(() => {
      setSave('saving');
      saveMut.mutate(draftRef.current);
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, save]);

  // 저장 안 된 변경이 있으면 닫기 전에 경고
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (save === 'dirty' || save === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [save]);

  const patch = useCallback((p: Partial<ProblemInput>) => {
    setDraft((d) => ({ ...d, ...p }));
    setSave('dirty');
  }, []);

  const lang = draft.language;
  const code = draft.code[lang];

  const runMut = useMutation({
    mutationFn: () => {
      const d = draftRef.current;
      return api.run({ language: d.language, mode: d.mode, code: d.code[d.language], cases: d.cases });
    },
    onMutate: () => setRun({ kind: 'running' }),
    onSuccess: (result) => setRun({ kind: 'done', result, cases: draftRef.current.cases, mode: draftRef.current.mode }),
    onError: (e) => setRun({ kind: 'error', message: errMsg(e) }),
  });
  const doRun = useCallback(() => {
    if (runMut.isPending) return;
    if (draftRef.current.cases.length === 0) {
      setTab('cases');
      setRun({ kind: 'error', message: '테스트 케이스를 하나 이상 추가하세요.' });
      return;
    }
    runMut.mutate();
  }, [runMut]);

  const delMut = useMutation({
    mutationFn: () => api.deleteProblem(problem.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.problem(problem.id) });
      void qc.invalidateQueries({ queryKey: qk.problems });
      onDeleted();
    },
  });

  const reset = () => {
    if (!confirm(`${lang === 'java' ? 'Java' : 'Python3'} 코드를 기본 템플릿으로 되돌릴까요?`)) return;
    patch({ code: { ...draft.code, [lang]: templateFor(lang, draft.mode, draft.params) } });
    setResets((n) => n + 1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 문제 제목 줄 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-base px-3 py-2 sm:px-4">
        <input
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          aria-label="문제 제목"
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-1 text-[15px] font-bold outline-none hover:bg-raised/60 focus:bg-raised"
        />
        <span className="rounded border border-line-strong px-2 py-0.5 text-[11px] font-semibold text-dim">
          {draft.mode === 'function' ? 'solution 함수' : '표준 입출력'}
        </span>
        <SaveBadge state={save} onRetry={() => setSave('dirty')} />
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
                {t === 'desc' ? '문제 설명' : `테스트 케이스 ${draft.cases.length}`}
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
          <div className="pane-title border-t">실행 결과</div>
          <div className="min-h-[180px] flex-[2] overflow-y-auto bg-panel lg:min-h-0">
            <ResultPanel state={run} />
          </div>
          <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-base px-3 py-2 sm:px-4">
            <button type="button" className="btn-ghost" onClick={reset}>
              초기화
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setTab('cases');
                if (draft.cases.length < 30) patch({ cases: [...draft.cases, newCase(draft.params.length)] });
              }}
            >
              테스트 케이스 추가하기
            </button>
            <button type="button" className="btn-primary ml-auto min-w-28" disabled={runMut.isPending} onClick={doRun}>
              {runMut.isPending ? '실행 중…' : '코드 실행'}
            </button>
          </footer>
        </section>
      </div>
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
