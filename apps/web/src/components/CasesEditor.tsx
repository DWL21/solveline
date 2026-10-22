import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProblemMode, TestCase, TestsetRef } from '@codetest/shared';
import { ApiError, api, qk } from '../lib/api.ts';

export const MAX_CASES = 60;
const MAX_HIDDEN = 200;
const HIDDEN_SAVE_DELAY_MS = 500;

export const newCase = (params: number, hidden = false): TestCase => ({
  id: crypto.randomUUID().slice(0, 8),
  args: Array.from({ length: params }, () => ''),
  stdin: '',
  expected: '',
  hidden,
});

/** 매개변수 이름 입력: 쉼표로 구분. 타이핑 중 빈 칸을 지우지 않도록 로컬 텍스트를 따로 둔다. */
function ParamsInput({ params, onChange }: { params: string[]; onChange: (p: string[]) => void }) {
  const [text, setText] = useState(params.join(', '));
  useEffect(() => setText(params.join(', ')), [params]);
  return (
    <input
      className="field"
      value={text}
      placeholder="예: numbers, target"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (next.join(',') !== params.join(',')) onChange(next);
        else setText(params.join(', '));
      }}
    />
  );
}

/** 케이스 목록 편집(보이는/히든 공용) */
function CaseList({ mode, params, cases, label, onChange }: { mode: ProblemMode; params: string[]; cases: TestCase[]; label: string; onChange: (c: TestCase[]) => void }) {
  const update = (id: string, patch: Partial<TestCase>) => onChange(cases.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => onChange(cases.filter((c) => c.id !== id));
  const del = (n: number, id: string) => (
    <button type="button" className="btn-quiet min-h-7 px-1.5" aria-label={`${label} ${n} 삭제`} onClick={() => remove(id)}>
      ✕
    </button>
  );
  if (mode === 'function')
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] border-separate border-spacing-y-1.5 text-[12.5px]">
          <thead>
            <tr className="text-left text-dim">
              <th className="w-8 font-semibold">#</th>
              {params.map((p) => (
                <th key={p} className="px-1 font-mono font-semibold">
                  {p}
                </th>
              ))}
              <th className="px-1 font-semibold">기댓값 (return)</th>
              <th className="w-9" />
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => (
              <tr key={c.id}>
                <td className="text-faint">{i + 1}</td>
                {params.map((p, j) => (
                  <td key={p} className="px-1">
                    <input
                      className="field"
                      value={c.args[j] ?? ''}
                      aria-label={`${label} ${i + 1} ${p}`}
                      onChange={(e) => update(c.id, { args: params.map((_, k) => (k === j ? e.target.value : (c.args[k] ?? ''))) })}
                    />
                  </td>
                ))}
                <td className="px-1">
                  <input className="field" value={c.expected} aria-label={`${label} ${i + 1} 기댓값`} onChange={(e) => update(c.id, { expected: e.target.value })} />
                </td>
                <td>{del(i + 1, c.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {cases.map((c, i) => (
        <div key={c.id} className="rounded-md border border-line bg-base/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <b className="text-[13px]">
              {label} {i + 1}
            </b>
            {del(i + 1, c.id)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">입력</span>
              <textarea className="field min-h-24 resize-y" value={c.stdin} onChange={(e) => update(c.id, { stdin: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">기대 출력</span>
              <textarea className="field min-h-24 resize-y" value={c.expected} onChange={(e) => update(c.id, { expected: e.target.value })} />
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 테스트 케이스 편집. 보이는 케이스는 문제와 함께 자동 저장되고 "코드 실행"에 쓴다.
 * 히든 케이스는 서버의 테스트셋 파일에 따로 있어, 펼칠 때만 불러오고 따로 저장한다(채점 전용, 스포일러 방지로 기본 접힘).
 */
export function CasesEditor({
  problemId,
  mode,
  params,
  cases,
  hidden,
  onParams,
  onCases,
}: {
  problemId: string;
  mode: ProblemMode;
  params: string[];
  cases: TestCase[];
  hidden: TestsetRef | null;
  onParams: (p: string[]) => void;
  onCases: (c: TestCase[]) => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {mode === 'function' ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-bold text-dim">매개변수 이름 (쉼표로 구분)</span>
            <ParamsInput
              params={params}
              onChange={(next) => {
                onParams(next);
                onCases(cases.map((c) => ({ ...c, args: next.map((_, i) => c.args[i] ?? '') })));
              }}
            />
          </label>
          <p className="text-[12px] leading-relaxed text-faint">
            값은 기존 표기 그대로 적습니다: <code className="text-dim">[1, 2, 3]</code>, <code className="text-dim">"abc"</code>,{' '}
            <code className="text-dim">[["a", 1]]</code>, <code className="text-dim">true</code>. 기댓값을 비우면 비교 없이 결과만 봅니다.
          </p>
        </>
      ) : (
        <p className="text-[12px] leading-relaxed text-faint">표준 입력과 기대 출력을 적습니다. 줄 끝 공백과 마지막 빈 줄은 무시하고 비교하며, 기대 출력을 비우면 결과만 봅니다.</p>
      )}

      <section>
        <h3 className="mb-1 text-[12px] font-bold text-dim">
          보이는 케이스 {cases.length} <span className="font-normal text-faint">— 코드 실행</span>
        </h3>
        {cases.length > 0 ? (
          <CaseList mode={mode} params={params} cases={cases} label="테스트" onChange={onCases} />
        ) : (
          <p className="py-2 text-[12.5px] text-faint">보이는 케이스가 없어요</p>
        )}
        <button type="button" className="btn-ghost mt-2" disabled={cases.length >= MAX_CASES} onClick={() => onCases([...cases, newCase(params.length)])}>
          + 테스트 케이스 추가
        </button>
      </section>

      <HiddenCases problemId={problemId} mode={mode} params={params} summary={hidden} />
    </div>
  );
}

type HiddenState = 'saved' | 'dirty' | 'saving' | 'error';

function HiddenCases({ problemId, mode, params, summary }: { problemId: string; mode: ProblemMode; params: string[]; summary: TestsetRef | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: qk.hidden(problemId), queryFn: () => api.hidden(problemId), enabled: open, staleTime: Infinity });
  const [cases, setCases] = useState<TestCase[] | null>(null);
  const [state, setState] = useState<HiddenState>('saved');
  const latest = useRef<TestCase[] | null>(null);

  useEffect(() => {
    if (q.data && cases === null) setCases(q.data.cases);
  }, [q.data, cases]);

  // 편집 후 잠시 뒤 저장 → 문제의 히든 개수(요약)도 갱신
  useEffect(() => {
    if (state !== 'dirty' || !latest.current) return;
    const t = setTimeout(() => {
      const sent = latest.current!;
      setState('saving');
      api
        .saveHidden(problemId, sent)
        .then((saved) => {
          qc.setQueryData(qk.hidden(problemId), saved);
          void qc.invalidateQueries({ queryKey: qk.problem(problemId) });
          setState(latest.current === sent ? 'saved' : 'dirty');
        })
        .catch(() => setState('error'));
    }, HIDDEN_SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state, cases, problemId, qc]);

  const change = (next: TestCase[]) => {
    const fixed = next.map((c) => ({ ...c, hidden: true, args: params.map((_, i) => c.args[i] ?? '') }));
    latest.current = fixed;
    setCases(fixed);
    setState('dirty');
  };

  const count = cases?.length ?? summary?.count ?? 0;
  return (
    <section className="border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-bold text-dim">
          히든 케이스 {count} <span className="font-normal text-faint">— 제출 후 채점에만 사용</span>
        </h3>
        <button type="button" className="btn-quiet min-h-7 px-2 text-[12px]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '접기' : count ? '펼쳐서 보기' : '추가하기'}
        </button>
        {open && state !== 'saved' && (
          <span className={`text-[11.5px] ${state === 'error' ? 'text-bad' : 'text-faint'}`}>{state === 'error' ? '저장 실패' : '저장 중…'}</span>
        )}
      </div>
      {!open && count === 0 && <p className="py-2 text-[12.5px] text-faint">히든 케이스가 없으면 제출할 때 보이는 케이스로 채점해요.</p>}
      {open && q.isPending && <p className="py-2 text-[12.5px] text-dim">불러오는 중…</p>}
      {open && q.isError && <p className="py-2 text-[12.5px] text-bad">{q.error instanceof ApiError ? q.error.message : '불러오지 못했어요'}</p>}
      {open && cases && (
        <div className="mt-1">
          {cases.length > 0 && <CaseList mode={mode} params={params} cases={cases} label="히든 테스트" onChange={change} />}
          <button type="button" className="btn-quiet mt-1 px-2 text-[12px]" disabled={cases.length >= MAX_HIDDEN} onClick={() => change([...cases, newCase(params.length, true)])}>
            + 히든 케이스 추가
          </button>
        </div>
      )}
    </section>
  );
}
