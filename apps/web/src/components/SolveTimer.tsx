import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EMPTY_TIMER, type Problem, type ProblemTimer } from '@codetest/shared';
import { api, qk } from '../lib/api.ts';
import { formatDuration } from '../lib/time.ts';

const SAVE_EVERY_MS = 10_000;
/** 타이머가 늦게 깨어나도(절전·백그라운드 제한) 한 번에 크게 늘지 않게 */
const MAX_TICK_MS = 5_000;

/**
 * 풀이 시간 자동 측정. 문제 화면이 열려 있고 탭이 보일 때만 늘어난다.
 * 100점을 받으면 멈추고(solvedMs), 초기화하면 0부터 다시. 10초마다·탭 숨김·이탈 때 서버에 저장한다.
 */
export function useSolveTimer(problem: Problem) {
  const qc = useQueryClient();
  const [timer, setTimer] = useState<ProblemTimer>(problem.timer);
  const ref = useRef(timer);
  ref.current = timer;
  const saved = useRef(JSON.stringify(problem.timer));
  const running = timer.solvedMs === null && !timer.paused;

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const delta = Math.min(MAX_TICK_MS, now - last);
      last = now;
      if (document.visibilityState !== 'visible') return;
      setTimer((t) => (t.solvedMs === null && !t.paused ? { ...t, elapsedMs: t.elapsedMs + Math.round(delta) } : t));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const persist = useCallback(
    (opts: { keepalive?: boolean; refreshList?: boolean } = {}) => {
      const cur = ref.current;
      const json = JSON.stringify(cur);
      if (json === saved.current) return;
      saved.current = json;
      qc.setQueryData<Problem>(qk.problem(problem.id), (old) => (old ? { ...old, timer: cur } : old));
      api
        .saveTimer(problem.id, cur, { keepalive: opts.keepalive })
        .then(() => {
          if (opts.refreshList) void qc.invalidateQueries({ queryKey: qk.problems });
        })
        .catch(() => {
          saved.current = ''; // 다음 기회에 다시 저장
        });
    },
    [problem.id, qc],
  );

  useEffect(() => {
    const id = setInterval(() => persist(), SAVE_EVERY_MS);
    const onHide = () => document.visibilityState === 'hidden' && persist({ keepalive: true });
    const onPageHide = () => persist({ keepalive: true });
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      persist({ refreshList: true });
    };
  }, [persist]);

  // 맞춤·초기화는 바로 저장하고 목록도 갱신
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (bump) persist({ refreshList: true });
  }, [bump, persist]);

  const markSolved = useCallback(() => {
    setTimer((t) => (t.solvedMs === null ? { ...t, solvedMs: t.elapsedMs, paused: false } : t));
    setBump((n) => n + 1);
  }, []);
  const reset = useCallback(() => {
    setTimer(EMPTY_TIMER);
    setBump((n) => n + 1);
  }, []);
  /** 일시정지/다시 시작: 다시 시작하면 멈춘 시간부터 이어서 잰다 */
  const setPaused = useCallback((paused: boolean) => {
    setTimer((t) => (t.solvedMs === null ? { ...t, paused } : t));
    setBump((n) => n + 1);
  }, []);

  return { timer, markSolved, reset, pause: () => setPaused(true), resume: () => setPaused(false) };
}

export function SolveTimerBadge({
  timer,
  onReset,
  onPause,
  onResume,
}: {
  timer: ProblemTimer;
  onReset: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const solved = timer.solvedMs !== null;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`rounded-md px-2 py-1 font-mono text-[12.5px] font-semibold tabular-nums ${solved ? 'bg-ok/15 text-ok' : 'bg-raised text-text'}`}
        title={solved ? '맞춘 순간의 풀이 시간 (타이머 멈춤)' : '풀이 시간 — 이 화면이 보일 때만 자동으로 잽니다'}
        aria-label={solved ? `풀이 시간 ${formatDuration(timer.solvedMs!)}에 맞춤` : `풀이 시간 ${formatDuration(timer.elapsedMs)}`}
      >
        {solved ? `✓ ${formatDuration(timer.solvedMs!)}` : `${timer.paused ? '⏸' : '⏱'} ${formatDuration(timer.elapsedMs)}`}
      </span>
      {!solved &&
        (timer.paused ? (
          <button type="button" className="btn-quiet min-h-7 px-1.5 text-[13px]" title="다시 시작" aria-label="타이머 다시 시작" onClick={onResume}>
            ▶
          </button>
        ) : (
          <button type="button" className="btn-quiet min-h-7 px-1.5 text-[13px]" title="일시정지" aria-label="타이머 일시정지" onClick={onPause}>
            ⏸
          </button>
        ))}
      <button
        type="button"
        className="btn-quiet min-h-7 px-1.5 text-[13px]"
        title="풀이 시간 초기화"
        aria-label="풀이 시간 초기화"
        onClick={() => confirm('풀이 시간을 0:00으로 초기화할까요? 맞춘 기록이 있으면 다시 잽니다.') && onReset()}
      >
        ↺
      </button>
    </span>
  );
}

/** 일시정지 중에는 문제·에디터·결과를 흐리게 가린다(멈춘 동안 풀 수 없게). */
export function PausedOverlay({ elapsedMs, onResume }: { elapsedMs: number; onResume: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink/40 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="타이머 일시정지됨">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-line-strong bg-panel/95 px-8 py-6 text-center shadow-2xl">
        <p className="text-[13px] font-bold text-dim">일시정지됨</p>
        <p className="font-mono text-[32px] font-bold tabular-nums">{formatDuration(elapsedMs)}</p>
        <button type="button" className="btn-primary min-h-11 px-6 text-[15px]" onClick={onResume} autoFocus>
          ▶ 다시 시작
        </button>
        <p className="text-[11.5px] text-faint">멈춘 시간부터 이어서 잽니다</p>
      </div>
    </div>
  );
}
