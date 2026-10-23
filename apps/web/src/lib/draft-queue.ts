import { z } from 'zod';
import { ProblemPatch, type Problem } from '@solveline/shared';

export const IDLE_SAVE_MS = 5_000;
export const MAX_SAVE_MS = 30_000;
export const TIMER_SAVE_MS = 60_000;
const KEEPALIVE_BYTES = 60_000;
// 서버 검증에 실패하는 작성 중 문자열도 로컬에서는 잃지 않는다.
const localCode = z.object({ java: z.string().optional(), python: z.string().optional() });
const RecordSchema = z.object({
  revision: z.string(), firstAt: z.number(), editedAt: z.number().nullable(), firstEditAt: z.number().nullable(),
  patch: ProblemPatch.extend({ title: z.string().optional(), description: z.string().optional(), memo: z.string().optional(), code: localCode.optional(), starterCode: localCode.optional() }),
});
type Entry = z.infer<typeof RecordSchema>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export type DraftState = 'saved' | 'local' | 'saving' | 'error' | 'storage-error';
type Send = (id: string, patch: ProblemPatch, options: { keepalive: boolean; signal: AbortSignal }) => Promise<Problem>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mergePatch(a: ProblemPatch, b: ProblemPatch): ProblemPatch {
  return { ...a, ...b, ...(b.code ? { code: { ...a.code, ...b.code } } : {}), ...(b.starterCode ? { starterCode: { ...a.starterCode, ...b.starterCode } } : {}) };
}

export function applyPatch(problem: Problem, patch: ProblemPatch = {}): Problem {
  return { ...problem, ...patch, code: { ...problem.code, ...patch.code }, starterCode: { ...problem.starterCode, ...patch.starterCode } };
}

/** 보낸 값과 같은 필드만 지운다. 전송 중 생긴 편집은 다음 동기화에 남긴다. */
function remainingPatch(current: ProblemPatch, sent: ProblemPatch): ProblemPatch {
  const result = { ...current };
  for (const key of Object.keys(sent) as (keyof ProblemPatch)[]) {
    if (key === 'code' || key === 'starterCode') {
      const code = { ...current[key] };
      for (const language of ['java', 'python'] as const) {
        if (sent[key]?.[language] !== undefined && equal(code[language], sent[key]?.[language])) delete code[language];
      }
      if (Object.keys(code).length) result[key] = code;
      else delete result[key];
    } else if (equal(current[key], sent[key])) delete result[key];
  }
  return result;
}

/** 계정별 영속 변경 큐. 서버 요청은 문제별로 하나만 실행한다. */
export class DraftQueue {
  readonly prefix: string;
  private memory = new Map<string, Entry>();
  private unpersisted = new Set<string>();
  private errors = new Set<string>();
  private inflight = new Map<string, Promise<boolean>>();
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private retryAt = new Map<string, number>();
  private active = false;
  version = 0;
  onSaved?: (id: string, problem: Problem) => void;
  constructor(readonly owner: string, private storage: StorageLike, private send: Send, private now = Date.now,
    private lock: (key: string, run: () => Promise<boolean>) => Promise<boolean> = (_key, run) => run()) {
    this.prefix = `solveline:draft:v1:${encodeURIComponent(owner)}:`;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  notify = () => { this.version++; this.listeners.forEach((listener) => listener()); };
  start() { this.active = true; }
  stop() { this.active = false; this.controllers.forEach((controller) => controller.abort()); }
  private key(id: string) { return this.prefix + encodeURIComponent(id); }
  read(id: string): Entry | undefined {
    if (this.unpersisted.has(id)) return this.memory.get(id);
    try {
      const raw = this.storage.getItem(this.key(id));
      if (!raw) { this.memory.delete(id); return undefined; }
      const parsed = RecordSchema.safeParse(JSON.parse(raw));
      if (parsed.success) { this.memory.set(id, parsed.data); return parsed.data; }
      // 손상된 캐시는 전송하지 않고 원본도 지우지 않는다.
      return undefined;
    } catch { return this.memory.get(id); }
  }
  private write(id: string, entry: Entry) {
    this.memory.set(id, entry);
    try { this.storage.setItem(this.key(id), JSON.stringify(entry)); this.unpersisted.delete(id); }
    catch { this.unpersisted.add(id); }
  }
  ids(): string[] {
    const ids = new Set(this.memory.keys());
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(this.prefix)) ids.add(decodeURIComponent(key.slice(this.prefix.length)));
      }
    } catch { /* 저장소가 막혀도 메모리 변경분은 동기화한다. */ }
    return [...ids].filter((id) => !!this.read(id));
  }
  edit(id: string, patch: ProblemPatch) {
    if (!Object.keys(patch).length) return;
    const previous = this.read(id);
    const isContent = Object.keys(patch).some((key) => key !== 'timer');
    const at = this.now();
    this.write(id, {
      revision: crypto.randomUUID(), patch: mergePatch(previous?.patch ?? {}, patch), firstAt: previous?.firstAt ?? at,
      editedAt: isContent ? at : previous?.editedAt ?? null,
      firstEditAt: previous?.firstEditAt ?? (isContent ? at : null),
    });
    this.errors.delete(id);
    this.notify();
  }
  discard(id: string) {
    try { this.storage.removeItem(this.key(id)); } catch { /* 다음 조회에서 남은 캐시를 다시 확인한다. */ }
    this.memory.delete(id); this.unpersisted.delete(id); this.errors.delete(id); this.notify();
  }
  state(id: string): DraftState {
    if (this.unpersisted.has(id)) return 'storage-error';
    if (this.errors.has(id)) return 'error';
    if (this.inflight.has(id)) return 'saving';
    return this.read(id) ? 'local' : 'saved';
  }
  hasUnpersisted() { return this.unpersisted.size > 0; }
  async tick() {
    if (!this.active) return;
    for (const id of this.ids()) {
      const entry = this.read(id)!;
      const at = this.now();
      if (at < (this.retryAt.get(id) ?? 0)) continue;
      const due = entry.editedAt === null ? at - entry.firstAt >= TIMER_SAVE_MS
        : at - entry.editedAt >= IDLE_SAVE_MS || at - (entry.firstEditAt ?? entry.firstAt) >= MAX_SAVE_MS;
      if (due) void this.flush(id);
    }
  }
  async flushAll(keepalive = false) { return Promise.all(this.ids().map((id) => this.flush(id, keepalive))); }
  flush(id: string, keepalive = false): Promise<boolean> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    if (!this.active) return Promise.resolve(false);
    const task = this.lock(this.key(id), async () => {
      if (!this.active) return false;
      const sent = this.read(id);
      if (!sent) return true;
      if (keepalive && new TextEncoder().encode(JSON.stringify(sent.patch)).byteLength >= KEEPALIVE_BYTES) return false;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const saved = await this.send(id, sent.patch, { keepalive, signal: controller.signal });
        const current = this.read(id);
        if (current) {
          const remaining = remainingPatch(current.patch, sent.patch);
          if (!Object.keys(remaining).length) this.discard(id);
          else {
            const hasContent = Object.keys(remaining).some((key) => key !== 'timer');
            this.write(id, { ...current, patch: remaining, firstAt: this.now(), editedAt: hasContent ? current.editedAt : null, firstEditAt: hasContent ? this.now() : null });
          }
        }
        this.errors.delete(id); this.retryAt.delete(id);
        if (this.active) this.onSaved?.(id, applyPatch(saved, this.read(id)?.patch));
        return true;
      } catch {
        if (!controller.signal.aborted) { this.errors.add(id); this.retryAt.set(id, this.now() + MAX_SAVE_MS); }
        return false;
      } finally { this.controllers.delete(controller); }
    }).finally(() => { this.inflight.delete(id); this.notify(); });
    this.inflight.set(id, task); this.notify();
    return task;
  }
}
