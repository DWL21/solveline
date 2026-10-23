import { describe, expect, it, vi } from 'vitest';
import { Problem, type ProblemPatch } from '@solveline/shared';
import { DraftQueue, applyPatch, IDLE_SAVE_MS, MAX_SAVE_MS, TIMER_SAVE_MS } from '../../web/src/lib/draft-queue.ts';

const problem = Problem.parse({ id: 'p1', title: '문제', folderId: null, description: '', mode: 'function', params: [], cases: [], language: 'java', code: { java: 'old', python: 'old' }, starterCode: { java: '', python: '' }, hiddenTestset: null, timer: { elapsedMs: 0, solvedMs: null, paused: false }, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function setup(storage = new MemoryStorage(), owner = 'one@example.com') {
  let now = 0;
  const send = vi.fn(async (_id: string, patch: ProblemPatch) => applyPatch(problem, patch));
  const queue = new DraftQueue(owner, storage, send, () => now);
  queue.start();
  return { queue, storage, send, time: (n: number) => { now = n; } };
}

describe('로컬 변경 큐', () => {
  it('짧은 입력은 로컬에 합치고 5초 유휴 후 한 번만 보낸다', async () => {
    const { queue, storage, send, time } = setup();
    queue.edit('p1', { code: { java: 'a' } });
    time(1_000); queue.edit('p1', { code: { java: 'ab' }, memo: 'memo' });
    time(4_000); await queue.tick();
    expect(send).not.toHaveBeenCalled();
    expect(storage.length).toBe(1);
    time(1_000 + IDLE_SAVE_MS); await queue.tick(); await queue.flush('p1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toEqual({ code: { java: 'ab' }, memo: 'memo' });
    expect(queue.read('p1')).toBeUndefined();
    expect(queue.state('p1')).toBe('saved');
  });

  it('계속 입력해도 30초 뒤에는 동기화하고 타이머만 바뀌면 60초까지 모은다', async () => {
    const { queue, send, time } = setup();
    queue.edit('p1', { memo: '0' });
    for (let at = 1_000; at <= MAX_SAVE_MS; at += 1_000) {
      time(at); queue.edit('p1', { memo: String(at) }); await queue.tick();
    }
    await queue.flush('p1');
    expect(send).toHaveBeenCalledTimes(1);
    time(MAX_SAVE_MS + 1_000); queue.edit('p1', { timer: { ...problem.timer, elapsedMs: 1_000 } });
    time(MAX_SAVE_MS + TIMER_SAVE_MS); await queue.tick();
    expect(send).toHaveBeenCalledTimes(1);
    time(MAX_SAVE_MS + TIMER_SAVE_MS + 1_000); await queue.tick(); await queue.flush('p1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('새로 연 큐는 초안을 복원하고 다른 계정은 읽거나 전송하지 않는다', async () => {
    const { queue, storage } = setup();
    queue.edit('p1', { code: { python: 'print(1)' } });
    const restored = setup(storage);
    expect(restored.queue.read('p1')?.patch.code?.python).toBe('print(1)');
    const other = setup(storage, 'two@example.com');
    expect(other.queue.ids()).toEqual([]);
    await other.queue.flushAll(); expect(other.send).not.toHaveBeenCalled();
  });

  it('전송 중 새 편집을 지우지 않고 서버 요청을 중복 실행하지 않는다', async () => {
    const { queue, send } = setup();
    let resolve!: (value: Problem) => void;
    send.mockImplementationOnce(() => new Promise<Problem>((done) => { resolve = done; }));
    queue.edit('p1', { code: { java: 'sent' }, memo: 'sent memo' });
    const first = queue.flush('p1');
    queue.edit('p1', { code: { java: 'latest', python: 'new' } });
    expect(queue.flush('p1')).toBe(first);
    resolve(problem); await first;
    expect(queue.read('p1')?.patch).toEqual({ code: { java: 'latest', python: 'new' } });
    await queue.flush('p1'); expect(send).toHaveBeenCalledTimes(2);
  });

  it('전송 중 타이머만 갱신되면 다음 전송은 60초를 기다린다', async () => {
    const { queue, send, time } = setup();
    let resolve!: (value: Problem) => void;
    send.mockImplementationOnce(() => new Promise<Problem>((done) => { resolve = done; }));
    queue.edit('p1', { memo: 'sent' });
    time(5_000);
    const first = queue.flush('p1');
    queue.edit('p1', { timer: { ...problem.timer, elapsedMs: 5_000 } });
    resolve(problem); await first;
    time(10_000); await queue.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.read('p1')?.editedAt).toBeNull();
    time(65_000); await queue.tick(); await queue.flush('p1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('통신 실패에도 초안을 남기고 재시도 시 최신 변경을 보낸다', async () => {
    const { queue, send, time } = setup();
    send.mockRejectedValueOnce(new Error('offline'));
    queue.edit('p1', { memo: 'offline draft' });
    expect(await queue.flush('p1')).toBe(false);
    expect(queue.state('p1')).toBe('error');
    time(6_000); await queue.tick(); expect(send).toHaveBeenCalledTimes(1);
    queue.edit('p1', { memo: 'latest draft' });
    time(MAX_SAVE_MS); await queue.tick(); await queue.flush('p1');
    expect(send.mock.calls[1]?.[1]).toEqual({ memo: 'latest draft' });
  });

  it('저장소 용량 초과는 표시하고 메모리 변경을 서버에 저장할 수 있다', async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => { throw new Error('quota'); };
    const { queue, send } = setup(storage);
    queue.edit('p1', { memo: 'keep' });
    expect(queue.state('p1')).toBe('storage-error');
    expect(queue.hasUnpersisted()).toBe(true);
    await queue.flush('p1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.hasUnpersisted()).toBe(false);
  });

  it('큰 변경은 이탈 시 무리하게 전송하지 않고 로컬에 보관한다', async () => {
    const { queue, send } = setup();
    queue.edit('p1', { memo: '한'.repeat(30_000) });
    expect(await queue.flush('p1', true)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(queue.read('p1')).toBeDefined();
    await queue.flush('p1'); expect(send).toHaveBeenCalledTimes(1);
  });

  it('정지한 큐는 이전 계정의 변경을 전송하지 않는다', async () => {
    const { queue, send } = setup();
    queue.edit('p1', { memo: 'private' }); queue.stop();
    await queue.flushAll(); expect(send).not.toHaveBeenCalled();
    expect(queue.read('p1')?.patch.memo).toBe('private');
  });

  it('다른 탭에서 바뀐 변경도 보존하고 공용 필드와 다른 언어를 덮어쓰지 않는다', async () => {
    const { queue, storage } = setup();
    queue.edit('p1', { code: { java: 'java draft' } });
    const tab = setup(storage);
    tab.queue.edit('p1', { code: { python: 'python draft' } });
    expect(queue.read('p1')?.patch.code).toEqual({ java: 'java draft', python: 'python draft' });
    expect(applyPatch(problem, { code: { python: 'new' } })).toMatchObject({ title: problem.title, code: { java: 'old', python: 'new' } });
  });
});
