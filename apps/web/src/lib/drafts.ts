import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Problem, ProblemInput, ProblemPatch } from '@solveline/shared';
import { api, qk } from './api.ts';
import { DraftQueue } from './draft-queue.ts';

const queues = new Map<string, DraftQueue>();
export function draftQueue(owner: string | undefined): DraftQueue | null {
  if (!owner) return null;
  let queue = queues.get(owner);
  if (!queue) {
    // localStorage 접근 자체가 차단된 환경에서도 메모리 큐와 서버 저장은 사용한다.
    const storage = {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => localStorage.setItem(key, value),
      removeItem: (key: string) => localStorage.removeItem(key),
      key: (index: number) => localStorage.key(index),
      get length() { return localStorage.length; },
    };
    queue = new DraftQueue(owner, storage, (id, patch, options) => api.patchProblem(id, patch, owner, options), Date.now,
      (async (key, run) => navigator.locks ? await navigator.locks.request(key, run) : await run()));
    queues.set(owner, queue);
  }
  return queue;
}

/** Shell에 하나만 설치한다. 문제를 나가도 미동기화 변경을 계속 처리한다. */
export function useDraftSync(owner: string | undefined) {
  const qc = useQueryClient();
  const queue = useMemo(() => draftQueue(owner), [owner]);
  useEffect(() => {
    if (!queue) return;
    queue.start();
    queue.onSaved = (id: string, problem: Problem) => {
      qc.setQueryData(qk.problem(id), problem);
      // 목록은 코드·메모 입력마다 갱신할 필요가 없다. 열려 있을 때만 새로 읽는다.
      void qc.invalidateQueries({ queryKey: qk.problems, refetchType: 'none' });
    };
    const interval = setInterval(() => void queue.tick(), 1_000);
    const online = () => void queue.flushAll();
    const hide = () => { if (document.visibilityState === 'hidden') void queue.flushAll(true); };
    const pagehide = () => void queue.flushAll(true);
    const storage = (event: StorageEvent) => { if (event.key?.startsWith(queue.prefix)) queue.notify(); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (queue.hasUnpersisted()) event.preventDefault(); };
    window.addEventListener('online', online);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('storage', storage);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hide);
    return () => {
      queue.stop(); queue.onSaved = undefined;
      clearInterval(interval);
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('storage', storage);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [queue, qc]);
  return queue;
}

const noSubscribe = () => () => {};
export function useDraftState(queue: DraftQueue | null, id: string) {
  useSyncExternalStore(queue?.subscribe ?? noSubscribe, () => queue?.version ?? 0);
  return queue?.state(id) ?? 'saved';
}

/** 바꾸지 않은 언어와 공용 필드는 전송하지 않는다. */
export function inputChanges(previous: ProblemInput, next: ProblemInput): ProblemPatch {
  const patch: ProblemPatch = {};
  for (const key of Object.keys(next) as (keyof ProblemInput)[]) {
    if (key === 'lastSubmission') continue;
    if (key === 'code' || key === 'starterCode') {
      for (const language of ['java', 'python'] as const) {
        const value = next[key]?.[language];
        if (value !== undefined && value !== previous[key]?.[language]) patch[key] = { ...patch[key], [language]: value };
      }
    } else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}
