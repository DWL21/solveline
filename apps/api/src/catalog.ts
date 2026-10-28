import { createHash } from 'node:crypto';
import type { CatalogIndex, CatalogProblem, Collection, Folder } from '@solveline/shared';
import type { ObjectStore } from '@solveline/judge/r2';

// R2 키. apps/web/public/_worker.js도 같은 키를 읽으므로 바꾸면 함께 바꾼다.
export const CATALOG_INDEX_KEY = 'catalog/v1/index.json';
export const catalogProblemKey = (id: string, version: string) => `catalog/v1/problems/${id}/${version}.json`;

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

export type SyncResult = { problems: number; index: boolean };

/** 동시에 limit개씩 처리한다 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * SQLite(쓰기 원본)의 공용 문제 데이터를 R2로 게시한다.
 * 바뀐 문제의 상세와 목록만 올린다(쓰기 횟수 절약). 히든 테스트셋은 judge가 올린다.
 * 동시에 여러 번 불러도 순서대로 한 번씩 돈다.
 */
export class CatalogPublisher {
  private published: { index: string | null; problems: Map<string, string> } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private store: ObjectStore,
    private source: () => Promise<CatalogSource>,
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
    const cat = buildCatalog(await this.source());
    this.published ??= await this.loadPublished();
    const published = this.published;

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
    return { problems: changed.length, index };
  }
}
