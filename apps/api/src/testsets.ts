import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestCase, TestsetRef } from '@solveline/shared';

const HASH = /^[0-9a-f]{64}$/;

/**
 * 히든 테스트셋 저장소. 내용(JSON)의 SHA-256을 파일 이름으로 쓰므로 같은 내용은 한 번만 저장되고,
 * 파일은 만든 뒤 바뀌지 않는다(runner가 해시로 캐시해도 안전하다).
 * dir이 ':memory:'면 메모리에만 둔다(테스트용).
 */
export class TestsetStore {
  private mem = new Map<string, string>();

  constructor(private dir: string) {
    if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
  }

  put(cases: TestCase[]): TestsetRef {
    const json = JSON.stringify(cases.map((c) => ({ ...c, hidden: true })));
    const hash = createHash('sha256').update(json).digest('hex');
    if (this.dir === ':memory:') this.mem.set(hash, json);
    else {
      const path = join(this.dir, `${hash}.json`);
      if (!existsSync(path)) {
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, json);
        renameSync(tmp, path);
      }
    }
    return { hash, count: cases.length };
  }

  /** 원문 그대로(runner에 올릴 때 해시가 맞아야 하므로 다시 직렬화하지 않는다) */
  raw(hash: string): string | null {
    if (!HASH.test(hash)) return null;
    if (this.dir === ':memory:') return this.mem.get(hash) ?? null;
    try {
      return readFileSync(join(this.dir, `${hash}.json`), 'utf8');
    } catch {
      return null;
    }
  }

  get(hash: string): TestCase[] | null {
    const raw = this.raw(hash);
    return raw === null ? null : (JSON.parse(raw) as TestCase[]);
  }

  /** 어디서도 쓰지 않고 minAgeMs보다 오래된 파일을 지운다. 지운 개수를 돌려준다. */
  gc(inUse: Set<string>, minAgeMs = 24 * 3600_000, now = Date.now()): number {
    if (this.dir === ':memory:') return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const hash = name.replace(/\.json$/, '');
      if (!HASH.test(hash) || inUse.has(hash)) continue;
      const path = join(this.dir, name);
      if (now - statSync(path).mtimeMs > minAgeMs) {
        unlinkSync(path);
        removed++;
      }
    }
    return removed;
  }

  get directory() {
    return this.dir;
  }
}
