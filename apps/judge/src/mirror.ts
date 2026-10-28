import { gunzipSync, gzipSync } from 'node:zlib';
import type { ObjectStore } from './r2.ts';
import type { TestsetStore } from './testsets.ts';

// R2 키. apps/api의 카탈로그와 같은 버킷의 testsets/ 아래에 둔다.
export const testsetKey = (hash: string) => `testsets/${hash}.json.gz`;

/**
 * 히든 테스트셋을 R2에 두고(내구성 있는 원본), 로컬 디렉터리는 캐시로 쓴다.
 * gzip 파일 그대로 저장한다(Content-Encoding을 붙이면 fetch가 받을 때 저절로 풀어 버린다).
 */
export class TestsetMirror {
  private remote: Set<string> | null = null;

  constructor(
    private store: ObjectStore,
    private testsets: TestsetStore,
  ) {}

  private async remoteHashes() {
    this.remote ??= new Set((await this.store.list('testsets/')).map((k) => k.slice('testsets/'.length).replace(/\.json\.gz$/, '')));
    return this.remote;
  }

  /** 하나를 올린다(이미 있으면 그대로) */
  async upload(hash: string): Promise<boolean> {
    const remote = await this.remoteHashes();
    if (remote.has(hash)) return false;
    const raw = this.testsets.raw(hash);
    if (raw === null) return false;
    await this.store.put(testsetKey(hash), gzipSync(raw), { contentType: 'application/gzip' });
    remote.add(hash);
    return true;
  }

  /** 로컬에만 있는 것을 모두 올린다. 올린 개수 */
  async syncUp(): Promise<number> {
    let n = 0;
    for (const hash of this.testsets.hashes()) if (await this.upload(hash)) n++;
    return n;
  }

  /** 로컬에 없으면 R2에서 받아 둔다(해시 검증). 로컬에 있게 됐으면 true */
  async load(hash: string): Promise<boolean> {
    if (this.testsets.raw(hash) !== null) return true;
    const gz = await this.store.get(testsetKey(hash));
    return !!gz && this.testsets.putRaw(hash, gunzipSync(gz).toString('utf8'));
  }
}
