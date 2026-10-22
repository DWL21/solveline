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
  const running = timer.solvedMs === null;

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const delta = Math.min(MAX_TICK_MS, now - last);
      last = now;
      if (document.visibilityState !== 'visible') return;
      setTimer((t) => (t.solvedMs === null ? { ...t, elapsedMs: t.elapsedMs + Math.round(delta) } : t));
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
    setTimer((t) => (t.solvedMs === null ? { ...t, solvedMs: t.elapsedMs } : t));
    setBump((n) => n + 1);
  }, []);
  const reset = useCallback(() => {
    setTimer(EMPTY_TIMER);
    setBump((n) => n + 1);
  }, []);

  return { timer, markSolved, reset };
}

export function SolveTimerBadge({ timer, onReset }: { timer: ProblemTimer; onReset: () => void }) {
  const solved = timer.solvedMs !== null;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`rounded-md px-2 py-1 font-mono text-[12.5px] font-semibold tabular-nums ${solved ? 'bg-ok/15 text-ok' : 'bg-raised text-text'}`}
        title={solved ? '맞춘 순간의 풀이 시간 (타이머 멈춤)' : '풀이 시간 — 이 화면이 보일 때만 자동으로 잽니다'}
        aria-label={solved ? `풀이 시간 ${formatDuration(timer.solvedMs!)}에 맞춤` : `풀이 시간 ${formatDuration(timer.elapsedMs)}`}
      >
        {solved ? `✓ ${formatDuration(timer.solvedMs!)}` : `⏱ ${formatDuration(timer.elapsedMs)}`}
      </span>
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
