import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CatalogIndex, CatalogProblem, Collection, Folder } from '@solveline/shared';
import type { ObjectStore } from './r2.ts';
import type { TestsetStore } from './testsets.ts';
import { log } from './redact.ts';

// R2 키. apps/web/public/_worker.js도 같은 키를 읽으므로 바꾸면 함께 바꾼다.
export const CATALOG_INDEX_KEY = 'catalog/v1/index.json';
export const catalogProblemKey = (id: string, version: string) => `catalog/v1/problems/${id}/${version}.json`;
export const testsetKey = (hash: string) => `testsets/${hash}.json.gz`;

const JSON_TYPE = 'application/json; charset=utf-8';
/** 응답 봉투 그대로 저장한다. Worker가 R2 본문을 그대로 돌려줄 수 있다. */
const envelope = (data: unknown) => JSON.stringify({ data });
const versionOf = (json: string) => createHash('sha256').update(json).digest('hex').slice(0, 16);

export type CatalogSource = { problems: CatalogProblem[]; folders: Folder[]; collections: Collection[] };

export type BuiltCatalog = {
  index: CatalogIndex;
  indexJson: string;
  indexVersion: string;
  details: { id: string; version: string; json: string }[];
};

/** 공용 문제 데이터를 R2·캐시에 올릴 모양으로 만든다. 상세의 version은 내용 해시라 내용이 같으면 키도 같다. */
export function buildCatalog(src: CatalogSource): BuiltCatalog {
  const details = src.problems.map((p) => {
    const json = envelope(p);
    return { id: p.id, version: versionOf(json), json };
  });
  const index: CatalogIndex = {
    problems: src.problems.map((p, i) => ({ id: p.id, title: p.title, folderId: p.folderId, mode: p.mode, language: p.language, updatedAt: p.updatedAt, version: details[i]!.version })),
    folders: src.folders,
    collections: src.collections,
  };
  const indexJson = envelope(index);
  return { index, indexJson, indexVersion: versionOf(indexJson), details };
}

export type SyncResult = { problems: number; testsets: number; index: boolean };

/** 동시에 limit개씩 처리한다 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * SQLite(쓰기 원본)의 공용 문제 데이터와 히든 테스트셋을 R2로 게시한다.
 * 바뀐 문제의 상세와 목록만 올리고(쓰기 횟수 절약), 테스트셋은 R2에 없는 것만 gzip으로 올린다.
 * 동시에 여러 번 불러도 순서대로 한 번씩 돈다.
 */
export class CatalogPublisher {
  private published: { index: string | null; problems: Map<string, string> } | null = null;
  private remoteTestsets: Set<string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private store: ObjectStore,
    private source: () => CatalogSource,
    private testsets: TestsetStore,
    private testsetsInUse: () => Set<string>,
  ) {}

  sync(): Promise<SyncResult> {
    const run = this.chain.then(() => this.run());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async loadPublished() {
    const raw = await this.store.get(CATALOG_INDEX_KEY);
    if (!raw) return { index: null, problems: new Map<string, string>() };
    const json = new TextDecoder().decode(raw);
    const { data } = JSON.parse(json) as { data: CatalogIndex };
    return { index: versionOf(json), problems: new Map(data.problems.map((p) => [p.id, p.version])) };
  }

  private async run(): Promise<SyncResult> {
    const cat = buildCatalog(this.source());
    this.published ??= await this.loadPublished();
    this.remoteTestsets ??= new Set((await this.store.list('testsets/')).map((k) => k.slice('testsets/'.length).replace(/\.json\.gz$/, '')));
    const published = this.published;
    const remote = this.remoteTestsets;

    // 상세가 가리키는 테스트셋이 먼저 있어야 한다
    const missing = [...this.testsetsInUse()].filter((h) => !remote.has(h));
    let testsets = 0;
    await pool(missing, 4, async (hash) => {
      const raw = this.testsets.raw(hash);
      if (raw === null) return log.warn(`[catalog] 테스트셋 ${hash.slice(0, 12)} 파일이 없어 올리지 못했습니다.`);
      // Content-Encoding을 붙이면 fetch가 받을 때 저절로 풀어 버리므로 gzip 파일 그대로 둔다
      await this.store.put(testsetKey(hash), gzipSync(raw), { contentType: 'application/gzip' });
      remote.add(hash);
      testsets++;
    });

    const changed = cat.details.filter((d) => published.problems.get(d.id) !== d.version);
    await pool(changed, 8, async (d) => {
      await this.store.put(catalogProblemKey(d.id, d.version), d.json, { contentType: JSON_TYPE });
      published.problems.set(d.id, d.version);
    });

    // 목록은 상세를 다 올린 뒤에 바꾼다(목록이 가리키는 상세가 항상 있도록)
    const index = cat.indexVersion !== published.index;
    if (index) {
      await this.store.put(CATALOG_INDEX_KEY, cat.indexJson, { contentType: JSON_TYPE });
      published.index = cat.indexVersion;
      published.problems = new Map(cat.details.map((d) => [d.id, d.version]));
    }
    return { problems: changed.length, testsets, index };
  }

  /** 로컬에 없는 테스트셋을 R2에서 받아 둔다(디스크를 잃어도 R2에서 되살린다). 받은 개수를 돌려준다. */
  async hydrate(): Promise<number> {
    let restored = 0;
    for (const hash of this.testsetsInUse()) {
      if (this.testsets.raw(hash) !== null) continue;
      const gz = await this.store.get(testsetKey(hash));
      if (!gz) continue;
      if (this.testsets.putRaw(hash, gunzipSync(gz).toString('utf8'))) restored++;
    }
    return restored;
  }
}
