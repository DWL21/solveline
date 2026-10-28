import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
    this.write(hash, json);
    return { hash, count: cases.length };
  }

  /** 다른 곳(R2)에서 받은 원문을 저장한다. 해시가 맞지 않으면 저장하지 않고 false */
  putRaw(hash: string, json: string): boolean {
    if (!HASH.test(hash) || createHash('sha256').update(json).digest('hex') !== hash) return false;
    this.write(hash, json);
    return true;
  }

  private write(hash: string, json: string) {
    if (this.dir === ':memory:') {
      this.mem.set(hash, json);
      return;
    }
    const path = join(this.dir, `${hash}.json`);
    if (existsSync(path)) return;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, path);
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

  /** 저장된 테스트셋 해시 전부 */
  hashes(): string[] {
    if (this.dir === ':memory:') return [...this.mem.keys()];
    return readdirSync(this.dir).map((n) => n.replace(/\.json$/, '')).filter((h) => HASH.test(h));
  }

  get directory() {
    return this.dir;
  }
}
