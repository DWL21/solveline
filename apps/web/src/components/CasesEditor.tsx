import { useEffect, useState } from 'react';
import type { ProblemMode, TestCase } from '@codetest/shared';

export const newCase = (params: number): TestCase => ({
  id: crypto.randomUUID().slice(0, 8),
  args: Array.from({ length: params }, () => ''),
  stdin: '',
  expected: '',
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

export function CasesEditor({
  mode,
  params,
  cases,
  onParams,
  onCases,
}: {
  mode: ProblemMode;
  params: string[];
  cases: TestCase[];
  onParams: (p: string[]) => void;
  onCases: (c: TestCase[]) => void;
}) {
  const update = (id: string, patch: Partial<TestCase>) => onCases(cases.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => onCases(cases.filter((c) => c.id !== id));

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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-separate border-spacing-y-1.5 text-[12.5px]">
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
                          aria-label={`테스트 ${i + 1} ${p}`}
                          onChange={(e) => update(c.id, { args: params.map((_, k) => (k === j ? e.target.value : (c.args[k] ?? ''))) })}
                        />
                      </td>
                    ))}
                    <td className="px-1">
                      <input className="field" value={c.expected} aria-label={`테스트 ${i + 1} 기댓값`} onChange={(e) => update(c.id, { expected: e.target.value })} />
                    </td>
                    <td>
                      <button type="button" className="btn-quiet px-2" aria-label={`테스트 ${i + 1} 삭제`} onClick={() => remove(c.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-faint">표준 입력과 기대 출력을 적습니다. 줄 끝 공백과 마지막 빈 줄은 무시하고 비교하며, 기대 출력을 비우면 결과만 봅니다.</p>
          {cases.map((c, i) => (
            <div key={c.id} className="rounded-md border border-line bg-base/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <b className="text-[13px]">테스트 {i + 1}</b>
                <button type="button" className="btn-quiet px-2" aria-label={`테스트 ${i + 1} 삭제`} onClick={() => remove(c.id)}>
                  ✕
                </button>
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
      )}
      <button type="button" className="btn-ghost self-start" disabled={cases.length >= 30} onClick={() => onCases([...cases, newCase(params.length)])}>
        + 테스트 케이스 추가
      </button>
    </div>
  );
}
