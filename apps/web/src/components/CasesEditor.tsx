import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProblemMode, TestCase, TestsetRef } from '@solveline/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { newCase } from '../lib/blank.ts';
import { useNarrow } from '../lib/media.ts';
import { LinesSkeleton, Spinner } from './Loading.tsx';

export const MAX_CASES = 60;
const MAX_HIDDEN = 200;
const HIDDEN_SAVE_DELAY_MS = 500;

/** 매개변수 이름 입력: 쉼표로 구분. 타이핑 중 빈 칸을 지우지 않도록 로컬 텍스트를 따로 둔다. */
function ParamsInput({ params, onChange }: Readonly<{ params: string[]; onChange: (p: string[]) => void }>) {
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

const BIG_FIELD = 10_000;

/** 큰 값(효율성 케이스)은 입력칸에 넣으면 화면이 느려지므로 읽기 전용으로 크기와 앞부분만 보여 준다. */
function Field({ value, label, multiline, readOnly, onChange }: Readonly<{ value: string; label: string; multiline?: boolean; readOnly?: boolean; onChange: (v: string) => void }>) {
  if (readOnly)
    return (
      <div className={`field cursor-default font-mono ${multiline ? 'min-h-10 whitespace-pre-wrap' : 'truncate'}`} aria-label={label} title={value.length > 200 ? `${value.length.toLocaleString()}자` : value}>
        {value.length > BIG_FIELD ? `${value.slice(0, 40)}… (${(value.length / 1024).toFixed(0)}KB)` : value || <span className="text-faint">—</span>}
      </div>
    );
  if (value.length > BIG_FIELD)
    return (
      <div className="field cursor-default truncate text-faint" title={`${value.length.toLocaleString()}자 — 너무 커서 여기서는 편집할 수 없어요`} aria-label={label}>
        {value.slice(0, 40)}… <span className="text-[11px]">({(value.length / 1024).toFixed(0)}KB)</span>
      </div>
    );
  return multiline ? (
    <textarea className="field min-h-24 resize-y" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <input className="field" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
  );
}

/** 케이스 목록(보이는/히든/내 케이스 공용). readOnly면 보기만 한다. */
function CaseList({
  mode,
  params,
  cases,
  label,
  readOnly,
  onChange,
}: Readonly<{
  mode: ProblemMode;
  params: string[];
  cases: TestCase[];
  label: string;
  readOnly?: boolean;
  onChange: (c: TestCase[]) => void;
}>) {
  const narrow = useNarrow();
  const update = (id: string, patch: Partial<TestCase>) => onChange(cases.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => onChange(cases.filter((c) => c.id !== id));
  const del = (n: number, id: string) =>
    readOnly ? null : (
    <button type="button" className="btn-quiet touch-target min-h-7 px-1.5" aria-label={`${label} ${n} 삭제`} onClick={() => remove(id)}>
      ✕
    </button>
    );
  // 휴대폰 폭: 표 대신 케이스마다 카드로 쌓는다(가로 스크롤 없이)
  if (mode === 'function' && narrow)
    return (
      <div className="flex flex-col gap-2">
        {cases.map((c, i) => (
          <div key={c.id} className="rounded-md border border-line bg-base/50 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <b className="text-[12.5px] text-dim">
                {label} {i + 1}
              </b>
              {del(i + 1, c.id)}
            </div>
            <div className="flex flex-col gap-1.5">
              {params.map((p, j) => (
                <label key={p} className="flex flex-col gap-1">
                  <span className="font-mono text-[11.5px] text-faint">{p}</span>
                  <Field
                    readOnly={readOnly}
                    value={c.args[j] ?? ''}
                    label={`${label} ${i + 1} ${p}`}
                    onChange={(v) => update(c.id, { args: params.map((_, k) => (k === j ? v : (c.args[k] ?? ''))) })}
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-faint">기댓값 (return)</span>
                <Field readOnly={readOnly} value={c.expected} label={`${label} ${i + 1} 기댓값`} onChange={(v) => update(c.id, { expected: v })} />
              </label>
            </div>
          </div>
        ))}
      </div>
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
                  <td key={p} className="max-w-48 px-1">
                    <Field
                      readOnly={readOnly}
                      value={c.args[j] ?? ''}
                      label={`${label} ${i + 1} ${p}`}
                      onChange={(v) => update(c.id, { args: params.map((_, k) => (k === j ? v : (c.args[k] ?? ''))) })}
                    />
                  </td>
                ))}
                <td className="max-w-48 px-1">
                  <Field readOnly={readOnly} value={c.expected} label={`${label} ${i + 1} 기댓값`} onChange={(v) => update(c.id, { expected: v })} />
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
              <Field multiline readOnly={readOnly} value={c.stdin} label={`${label} ${i + 1} 입력`} onChange={(v) => update(c.id, { stdin: v })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">기대 출력</span>
              <Field multiline readOnly={readOnly} value={c.expected} label={`${label} ${i + 1} 기대 출력`} onChange={(v) => update(c.id, { expected: v })} />
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 테스트 케이스.
 * - 채점 케이스(보이는·히든·시간 제한·매개변수)는 공용이다. 편집 권한이 있는 사용자가 편집 모드에서만 바꾸고, 바꾸면 모두에게 적용된다.
 * - 내 테스트 케이스는 사용자마다 따로 저장되고 "코드 실행"에만 쓴다(기존의 "테스트 케이스 추가하기").
 * 히든 케이스는 서버의 테스트셋 파일에 따로 있어, 편집 모드에서 펼칠 때만 불러오고 따로 저장한다.
 */
export function CasesEditor({
  problemId,
  guest = false,
  editing,
  mode,
  params,
  cases,
  myCases,
  hidden,
  timeLimitMs,
  onTimeLimit,
  onParams,
  onCases,
  onMyCases,
}: Readonly<{
  problemId: string;
  /** 비회원: 내 테스트 케이스를 만들 수 없다 */
  guest?: boolean;
  editing: boolean;
  mode: ProblemMode;
  params: string[];
  cases: TestCase[];
  myCases: TestCase[];
  hidden: TestsetRef | null;
  timeLimitMs: number;
  onTimeLimit: (ms: number) => void;
  onParams: (p: string[]) => void;
  onCases: (c: TestCase[]) => void;
  onMyCases: (c: TestCase[]) => void;
}>) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {editing && <TimeLimit value={timeLimitMs} onChange={onTimeLimit} />}
      {mode === 'function' && editing && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-bold text-dim">매개변수 이름 (쉼표로 구분)</span>
          <ParamsInput
            params={params}
            onChange={(next) => {
              onParams(next);
              onCases(cases.map((c) => ({ ...c, args: next.map((_, i) => c.args[i] ?? '') })));
              onMyCases(myCases.map((c) => ({ ...c, args: next.map((_, i) => c.args[i] ?? '') })));
            }}
          />
        </label>
      )}

      <section>
        <h3 className="mb-1 text-[12px] font-bold text-dim">
          기본 케이스 {cases.length}
        </h3>
        {cases.length > 0 ? (
          <CaseList mode={mode} params={params} cases={cases} label="테스트" readOnly={!editing} onChange={onCases} />
        ) : (
          <p className="py-2 text-[12.5px] text-faint">기본 케이스가 없어요</p>
        )}
        {editing && (
          <button type="button" className="btn-ghost mt-2" disabled={cases.length >= MAX_CASES} onClick={() => onCases([...cases, newCase(params.length)])}>
            + 기본 케이스 추가
          </button>
        )}
      </section>

      {!guest && (
      <section className="border-t border-line pt-3">
        <h3 className="mb-1 text-[12px] font-bold text-dim">
          내 테스트 케이스 {myCases.length}
        </h3>
        {myCases.length > 0 && <CaseList mode={mode} params={params} cases={myCases} label="내 테스트" onChange={onMyCases} />}
        <button type="button" className="btn-ghost mt-2" disabled={myCases.length >= MAX_CASES} onClick={() => onMyCases([...myCases, newCase(params.length)])}>
          + 테스트 케이스 추가
        </button>
      </section>
      )}

      {editing && <HiddenCases problemId={problemId} mode={mode} params={params} summary={hidden} />}
    </div>
  );
}

/** 시간 제한(초). 함수형은 solution 호출 시간, 입출력형은 실행 시간 기준. 0.1~10초. */
function TimeLimit({ value, onChange }: Readonly<{ value: number; onChange: (ms: number) => void }>) {
  const [text, setText] = useState(String(value / 1000));
  useEffect(() => setText(String(value / 1000)), [value]);
  const commit = () => {
    const sec = Number(text);
    if (!Number.isFinite(sec)) return setText(String(value / 1000));
    const ms = Math.round(Math.min(10, Math.max(0.1, sec)) * 1000);
    setText(String(ms / 1000));
    if (ms !== value) onChange(ms);
  };
  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-bold text-dim">시간 제한</span>
      <input
        className="field w-20 text-right"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label="시간 제한(초)"
      />
      <span className="text-[12px] text-dim">초</span>
    </label>
  );
}

type HiddenState = 'saved' | 'dirty' | 'saving' | 'error';

function HiddenCases({ problemId, mode, params, summary }: Readonly<{ problemId: string; mode: ProblemMode; params: string[]; summary: TestsetRef | null }>) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
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
          <span className={`inline-flex items-center gap-1 text-[11.5px] ${state === 'error' ? 'text-bad' : 'text-faint'}`}>
            {state === 'error' ? '저장 실패' : <><Spinner size={11} /> 저장 중</>}
          </span>
        )}
      </div>
      {!open && count === 0 && <p className="py-2 text-[12.5px] text-faint">히든 케이스가 없으면 제출할 때 보이는 케이스로 채점해요.</p>}
      {open && q.isPending && <LinesSkeleton />}
      {open && q.isError && (
        <div className="flex flex-wrap items-center gap-2 py-2">
          <p className="text-[12.5px] text-bad">{q.error instanceof ApiError ? q.error.message : '불러오지 못했어요'}</p>
          <button type="button" className="btn-quiet min-h-7 px-2 text-[12px]" onClick={() => void q.refetch()}>
            다시 시도
          </button>
        </div>
      )}
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
