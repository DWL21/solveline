import { Spinner } from './Loading.tsx';
import type { CaseResult, ProblemMode, RunResult, TestCase } from '@solveline/shared';

export type RunState =
  | { kind: 'idle' }
  /** ahead: 대기열에서 앞에 있는 제출 수(대기 중일 때) */
  | { kind: 'running'; submit: boolean; ahead: number | null }
  | { kind: 'error'; message: string }
  /** 중지함. 코드 실행이면 중지 전까지의 결과를 done(cancelled)으로 보여 준다 */
  | { kind: 'cancelled'; submit: boolean }
  | { kind: 'done'; result: RunResult; cases: TestCase[]; mode: ProblemMode; limitMs: number; cancelled?: boolean }
  /** 제출 후 채점: 입력·기댓값은 보여 주지 않는다 */
  | { kind: 'graded'; result: RunResult; score: number };

const label: Record<CaseResult['status'], string> = {
  pass: '통과',
  fail: '실패',
  done: '실행 완료',
  error: '런타임 에러',
  timeout: '시간 초과',
  skipped: '건너뜀',
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}초`;

function verdict(r: CaseResult, mode: ProblemMode, expected: string, limitMs: number) {
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
      return <span className="text-warn">실행 시간이 제한({seconds(limitMs)})을 초과했습니다.</span>;
    case 'skipped':
      return <span className="text-faint">{r.stderr.trim() || '전체 실행 시간 제한으로 건너뛰었습니다.'}</span>;
    default:
      return <span className="text-bad">실행 중 에러가 발생했습니다.</span>;
  }
}

function show(v: string | null, mode: ProblemMode) {
  if (v === null) return 'null';
  return mode === 'stdin' ? v.trimEnd() : v;
}

/** 케이스 상태 색과 앞 기호(통과·실패는 색만으로 구분하지 않는다) */
const STATUS_STYLE: Record<CaseResult['status'], { color: string; mark: string }> = {
  pass: { color: 'text-ok', mark: '✓ ' },
  fail: { color: 'text-bad', mark: '✗ ' },
  done: { color: 'text-dim', mark: '' },
  error: { color: 'text-bad', mark: '✗ ' },
  timeout: { color: 'text-warn', mark: '' },
  skipped: { color: 'text-dim', mark: '' },
};

function Code({ children }: Readonly<{ children: React.ReactNode }>) {
  return <code className="rounded bg-raised px-1 py-0.5 font-mono text-[12.5px] text-text">{children}</code>;
}

export function ResultPanel({ state }: Readonly<{ state: RunState }>) {
  if (state.kind === 'idle')
    return <p className="p-4 text-[13px] text-faint">실행 결과가 여기에 표시됩니다. (⌘/Ctrl + Enter로 실행)</p>;
  if (state.kind === 'running')
    return (
      <output className="flex items-center gap-2.5 p-4 text-[13px] text-dim" aria-live="polite">
        <Spinner size={16} className="text-accent-text" />
        {state.ahead ? (
          <span>
            대기 중 <span className="text-faint">· 앞에 {state.ahead}개</span>
          </span>
        ) : (
          <span>{state.submit ? '채점하는 중이에요' : '코드를 실행하는 중이에요'}</span>
        )}
      </output>
    );
  if (state.kind === 'error') return <p className="p-4 text-[13px] font-semibold text-bad">{state.message}</p>;
  if (state.kind === 'cancelled') return <p className="p-4 text-[13px] font-semibold text-warn">{state.submit ? '채점을 중지했습니다.' : '실행을 중지했습니다.'}</p>;
  if (!state.result.compile.ok) return <CompileError output={state.result.compile.output} />;
  if (state.kind === 'graded') return <Graded result={state.result} score={state.score} />;

  const { result, cases, mode, limitMs } = state;

  const graded = result.results.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'error' || r.status === 'timeout');
  const passed = result.results.filter((r) => r.status === 'pass').length;

  return (
    <div className="flex flex-col gap-3 p-4 font-mono text-[12.5px] leading-relaxed">
      {state.cancelled && <p className="font-sans text-[13px] font-semibold text-warn">실행을 중지했습니다.</p>}
      {result.results.map((r, i) => {
        const c = cases.find((x) => x.id === r.id);
        return (
          <section key={r.id} className="rounded-md border border-line bg-base/60 p-3">
            <header className="mb-1.5 flex flex-wrap items-baseline gap-x-2 font-sans">
              <b className="text-[13px] text-text">테스트 {i + 1}</b>
              <span
                className={`text-[12px] font-bold ${STATUS_STYLE[r.status].color}`}
              >
                {STATUS_STYLE[r.status].mark}
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
                <dd className="font-sans break-all">{verdict(r, mode, c.expected, limitMs)}</dd>
                {r.stdout && (
                  <>
                    <dt className="text-faint">출력 〉</dt>
                    <dd className="break-all whitespace-pre-wrap text-sky">{r.stdout.trimEnd()}</dd>
                  </>
                )}
                {r.stderr && r.status !== 'skipped' && (
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

function CompileError({ output }: Readonly<{ output: string }>) {
  return (
    <div className="p-4">
      <p className="mb-2 text-[13px] font-bold text-bad">컴파일 에러</p>
      <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-bad/90">{output.trim()}</pre>
    </div>
  );
}

const gradedLabel: Record<CaseResult['status'], string> = {
  pass: '통과',
  fail: '실패',
  done: '통과',
  error: '실패 (런타임 에러)',
  timeout: '실패 (시간 초과)',
  skipped: '실패 (시간 초과)',
};

/** 기존 채점 결과 형식: 테스트별 통과/실패와 시간·메모리, 마지막에 점수 */
function Graded({ result, score }: Readonly<{ result: RunResult; score: number }>) {
  const passed = result.results.filter((r) => r.status === 'pass').length;
  return (
    <div className="p-4 font-mono text-[12.5px] leading-[1.9]">
      <p className="mb-1 font-sans text-[13px] font-bold">정확성 테스트</p>
      <ul>
        {result.results.map((r, i) => {
          const ok = r.status === 'pass';
          return (
            <li key={r.id} className="flex flex-wrap gap-x-2">
              <span className="w-[72px] text-faint">테스트 {i + 1} 〉</span>
              <span className={ok ? 'text-ok' : 'text-bad'}>
                {ok ? '✓ ' : '✗ '}
                {gradedLabel[r.status]}
              </span>
              {r.status !== 'skipped' && (
                <span className="text-faint">
                  ({r.timeMs.toFixed(2)}ms, {r.memoryMb.toFixed(1)}MB)
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 border-t border-line pt-3 font-sans text-[13px]">
        <p className="font-bold">채점 결과</p>
        <p>
          정확성: <b>{score.toFixed(1)}</b>
        </p>
        <p>
          합계: <b className={score === 100 ? 'text-ok' : 'text-bad'}>{score.toFixed(1)}</b> / 100.0{/* 공백 없이 여백(ml-2)으로 띄운다 */}
          <span className="ml-2 text-[12px] text-faint">
            ({result.results.length}개 중 {passed}개 통과)
          </span>
        </p>
        {score === 100 && <p className="mt-3 rounded-md border border-ok/40 bg-ok/10 px-3 py-2 font-bold text-ok">✓ 정답입니다!</p>}
      </div>
    </div>
  );
}
