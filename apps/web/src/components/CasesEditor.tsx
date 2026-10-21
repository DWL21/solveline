import { useEffect, useState } from 'react';
import type { ProblemMode, TestCase } from '@codetest/shared';

export const MAX_CASES = 60;

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

/**
 * 테스트 케이스 편집. 보이는 케이스는 "코드 실행"에, 히든 케이스는 "제출 후 채점하기"에만 쓴다.
 * 히든 케이스는 스포일러가 되지 않게 기본으로 접어 둔다.
 */
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
  const [showHidden, setShowHidden] = useState(false);
  const update = (id: string, patch: Partial<TestCase>) => onCases(cases.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => onCases(cases.filter((c) => c.id !== id));
  const visible = cases.filter((c) => !c.hidden);
  const hidden = cases.filter((c) => c.hidden);
  const full = cases.length >= MAX_CASES;

  const caseList = (list: TestCase[], isHidden: boolean) =>
    mode === 'function' ? (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] border-separate border-spacing-y-1.5 text-[12.5px]">
          <thead>
            <tr className="text-left text-dim">
              <th className="w-8 font-semibold">#</th>
              {params.map((p) => (
                <th key={p} className="px-1 font-mono font-semibold">
                  {p}
                </th>
              ))}
              <th className="px-1 font-semibold">기댓값 (return)</th>
              <th className="w-[72px]" />
            </tr>
          </thead>
          <tbody>
            {list.map((c, i) => (
              <tr key={c.id}>
                <td className="text-faint">{i + 1}</td>
                {params.map((p, j) => (
                  <td key={p} className="px-1">
                    <input
                      className="field"
                      value={c.args[j] ?? ''}
                      aria-label={`${isHidden ? '히든 ' : ''}테스트 ${i + 1} ${p}`}
                      onChange={(e) => update(c.id, { args: params.map((_, k) => (k === j ? e.target.value : (c.args[k] ?? ''))) })}
                    />
                  </td>
                ))}
                <td className="px-1">
                  <input
                    className="field"
                    value={c.expected}
                    aria-label={`${isHidden ? '히든 ' : ''}테스트 ${i + 1} 기댓값`}
                    onChange={(e) => update(c.id, { expected: e.target.value })}
                  />
                </td>
                <td className="whitespace-nowrap">
                  <RowActions c={c} n={i + 1} onToggle={() => update(c.id, { hidden: !c.hidden })} onRemove={() => remove(c.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="flex flex-col gap-3">
        {list.map((c, i) => (
          <div key={c.id} className="rounded-md border border-line bg-base/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <b className="text-[13px]">
                {isHidden ? '히든 ' : ''}테스트 {i + 1}
              </b>
              <RowActions c={c} n={i + 1} onToggle={() => update(c.id, { hidden: !c.hidden })} onRemove={() => remove(c.id)} />
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

  return (
    <div className="flex flex-col gap-4 p-4">
      {mode === 'function' && (
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
      )}
      {mode === 'stdin' && (
        <p className="text-[12px] leading-relaxed text-faint">표준 입력과 기대 출력을 적습니다. 줄 끝 공백과 마지막 빈 줄은 무시하고 비교하며, 기대 출력을 비우면 결과만 봅니다.</p>
      )}

      <section>
        <h3 className="mb-1 text-[12px] font-bold text-dim">
          보이는 케이스 {visible.length} <span className="font-normal text-faint">— 코드 실행</span>
        </h3>
        {visible.length > 0 ? caseList(visible, false) : <p className="py-2 text-[12.5px] text-faint">보이는 케이스가 없어요</p>}
        <button type="button" className="btn-ghost mt-2" disabled={full} onClick={() => onCases([...cases, newCase(params.length)])}>
          + 테스트 케이스 추가
        </button>
      </section>

      <section className="border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[12px] font-bold text-dim">
            히든 케이스 {hidden.length} <span className="font-normal text-faint">— 제출 후 채점에만 사용</span>
          </h3>
          {hidden.length > 0 && (
            <button type="button" className="btn-quiet min-h-7 px-2 text-[12px]" onClick={() => setShowHidden((v) => !v)} aria-expanded={showHidden}>
              {showHidden ? '접기' : '펼쳐서 보기'}
            </button>
          )}
        </div>
        {hidden.length === 0 && <p className="py-2 text-[12.5px] text-faint">히든 케이스가 없으면 제출할 때 모든 케이스로 채점해요.</p>}
        {showHidden && hidden.length > 0 && <div className="mt-1">{caseList(hidden, true)}</div>}
        <button
          type="button"
          className="btn-quiet mt-1 px-2 text-[12px]"
          disabled={full}
          onClick={() => {
            onCases([...cases, newCase(params.length, true)]);
            setShowHidden(true);
          }}
        >
          + 히든 케이스 추가
        </button>
      </section>
    </div>
  );
}

function RowActions({ c, n, onToggle, onRemove }: { c: TestCase; n: number; onToggle: () => void; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        className="btn-quiet min-h-7 px-1.5 text-[11.5px]"
        title={c.hidden ? '보이는 케이스로 옮기기' : '히든 케이스로 옮기기'}
        aria-label={`테스트 ${n} ${c.hidden ? '보이는 케이스로' : '히든 케이스로'}`}
        onClick={onToggle}
      >
        {c.hidden ? '공개' : '숨김'}
      </button>
      <button type="button" className="btn-quiet min-h-7 px-1.5" aria-label={`테스트 ${n} 삭제`} onClick={onRemove}>
        ✕
      </button>
    </span>
  );
}
