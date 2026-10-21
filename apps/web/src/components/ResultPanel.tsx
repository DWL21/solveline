import type { CaseResult, ProblemMode, RunResult, TestCase } from '@codetest/shared';

export type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: RunResult; cases: TestCase[]; mode: ProblemMode };

const label: Record<CaseResult['status'], string> = {
  pass: '통과',
  fail: '실패',
  done: '실행 완료',
  error: '런타임 에러',
  timeout: '시간 초과',
  skipped: '건너뜀',
};

function verdict(r: CaseResult, mode: ProblemMode, expected: string) {
  switch (r.status) {
    case 'pass':
      return <span className="text-ok">테스트를 통과하였습니다.</span>;
    case 'fail':
      return (
        <span className="text-bad">
          실행한 결괏값 <Code>{show(r.actual, mode)}</Code>이(가) 기댓값 <Code>{expected.trim()}</Code>과(와) 다릅니다.
        </span>
      );
    case 'done':
      return <span className="text-dim">실행 결과 〉 {mode === 'function' ? show(r.actual, mode) : '(아래 출력 참고)'}</span>;
    case 'timeout':
      return <span className="text-warn">실행 시간이 10.0초를 초과하여 실행이 중단되었습니다.</span>;
    case 'skipped':
      return <span className="text-faint">전체 실행 시간 제한으로 건너뛰었습니다.</span>;
    default:
      return <span className="text-bad">실행 중 에러가 발생했습니다.</span>;
  }
}

const show = (v: string | null, mode: ProblemMode) => (v === null ? 'null' : mode === 'stdin' ? v.trimEnd() : v);

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-raised px-1 py-0.5 font-mono text-[12.5px] text-text">{children}</code>;
}

export function ResultPanel({ state }: { state: RunState }) {
  if (state.kind === 'idle')
    return <p className="p-4 text-[13px] text-faint">실행 결과가 여기에 표시됩니다. (⌘/Ctrl + Enter로 실행)</p>;
  if (state.kind === 'running') return <p className="animate-pulse p-4 text-[13px] text-dim">실행 중…</p>;
  if (state.kind === 'error') return <p className="p-4 text-[13px] font-semibold text-bad">{state.message}</p>;

  const { result, cases, mode } = state;
  if (!result.compile.ok)
    return (
      <div className="p-4">
        <p className="mb-2 text-[13px] font-bold text-bad">컴파일 에러</p>
        <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-bad/90">{result.compile.output.trim()}</pre>
      </div>
    );

  const graded = result.results.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'error' || r.status === 'timeout');
  const passed = result.results.filter((r) => r.status === 'pass').length;

  return (
    <div className="flex flex-col gap-3 p-4 font-mono text-[12.5px] leading-relaxed">
      {result.results.map((r, i) => {
        const c = cases.find((x) => x.id === r.id);
        return (
          <section key={r.id} className="rounded-md border border-line bg-base/60 p-3">
            <header className="mb-1.5 flex flex-wrap items-baseline gap-x-2 font-sans">
              <b className="text-[13px] text-text">테스트 {i + 1}</b>
              <span
                className={`text-[12px] font-bold ${r.status === 'pass' ? 'text-ok' : r.status === 'fail' || r.status === 'error' ? 'text-bad' : r.status === 'timeout' ? 'text-warn' : 'text-dim'}`}
              >
                {r.status === 'pass' ? '✓ ' : r.status === 'fail' || r.status === 'error' ? '✗ ' : ''}
                {label[r.status]}
              </span>
              {r.status !== 'skipped' && (
                <span className="text-[11.5px] text-faint">
                  ({r.timeMs.toFixed(2)}ms, {r.memoryMb.toFixed(1)}MB)
                </span>
              )}
            </header>
            {c && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                <dt className="text-faint">입력값 〉</dt>
                <dd className="break-all whitespace-pre-wrap text-text">{mode === 'function' ? c.args.join(', ') : c.stdin.trimEnd() || '(없음)'}</dd>
                {c.expected.trim() !== '' && (
                  <>
                    <dt className="text-faint">기댓값 〉</dt>
                    <dd className="break-all whitespace-pre-wrap text-text">{c.expected.trim()}</dd>
                  </>
                )}
                <dt className="text-faint">실행 결과 〉</dt>
                <dd className="font-sans break-all">{verdict(r, mode, c.expected)}</dd>
                {r.stdout && (
                  <>
                    <dt className="text-faint">출력 〉</dt>
                    <dd className="break-all whitespace-pre-wrap text-sky">{r.stdout.trimEnd()}</dd>
                  </>
                )}
                {r.stderr && (
                  <>
                    <dt className="text-faint">에러 〉</dt>
                    <dd className="break-all whitespace-pre-wrap text-bad/90">{r.stderr.trimEnd()}</dd>
                  </>
                )}
              </dl>
            )}
          </section>
        );
      })}
      {graded.length > 0 && (
        <p className="font-sans text-[13px] font-bold">
          테스트 결과 <span className="text-faint">(~˘▾˘)~</span>{' '}
          <span className={passed === graded.length ? 'text-ok' : 'text-bad'}>
            {graded.length}개 중 {passed}개 성공
          </span>
        </p>
      )}
    </div>
  );
}
