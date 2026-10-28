import { sha256Hex } from './crypto.ts';
import type { CatalogIndex, CatalogProblem, Collection, Folder } from '@solveline/shared';
import type { ObjectStore } from '@solveline/judge/r2';

// R2 키. apps/web/public/_worker.js도 같은 키를 읽으므로 바꾸면 함께 바꾼다.
export const CATALOG_INDEX_KEY = 'catalog/v1/index.json';
export const catalogProblemKey = (id: string, version: string) => `catalog/v1/problems/${id}/${version}.json`;

const JSON_TYPE = 'application/json; charset=utf-8';
/** 응답 봉투 그대로 저장한다. Worker가 R2 본문을 그대로 돌려줄 수 있다. */
const envelope = (data: unknown) => JSON.stringify({ data });
const versionOf = async (json: string) => (await sha256Hex(json)).slice(0, 16);

export type CatalogSource = { problems: CatalogProblem[]; folders: Folder[]; collections: Collection[] };

export type BuiltCatalog = {
  index: CatalogIndex;
  indexJson: string;
  indexVersion: string;
  details: { id: string; version: string; json: string }[];
};

/** 공용 문제 데이터를 R2·캐시에 올릴 모양으로 만든다. 상세의 version은 내용 해시라 내용이 같으면 키도 같다. */
export async function buildCatalog(src: CatalogSource): Promise<BuiltCatalog> {
  const details = await Promise.all(
    src.problems.map(async (p) => {
      const json = envelope(p);
      return { id: p.id, version: await versionOf(json), json };
    }),
  );
  const index: CatalogIndex = {
    problems: src.problems.map((p, i) => ({ id: p.id, title: p.title, folderId: p.folderId, mode: p.mode, language: p.language, updatedAt: p.updatedAt, version: details[i]!.version })),
    folders: src.folders,
    collections: src.collections,
  };
  const indexJson = envelope(index);
  return { index, indexJson, indexVersion: await versionOf(indexJson), details };
}

export type SyncResult = { problems: number; index: boolean };

/** 편집 한 번에 바뀐 것: 문제 id(지워졌으면 목록에서 뺀다)와 컬렉션 */
export type CatalogChange = { problemIds: string[]; collections: boolean };

/** 부분 게시에 필요한 원본 조회 */
export type CatalogReader = { problem: (id: string) => Promise<CatalogProblem | null>; collections: () => Promise<Collection[]> };

const byTitle = (a: { title: string }, b: { title: string }) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

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
    private readonly store: ObjectStore,
    private readonly source: () => Promise<CatalogSource>,
    private readonly reader?: CatalogReader,
  ) {}

  /**
   * 바뀐 것만 게시한다(Worker CPU 10ms 안에서). 전체를 다시 만들지 않고 R2의 목록을 읽어 바뀐 문제 줄과 컬렉션만 고쳐 쓴다.
   * 목록이 아직 없거나 reader가 없으면 전체 동기화로 대신한다. 같은 순간 다른 곳의 편집과 겹치면 늦게 쓴 쪽이 이기므로,
   * 그때 빠진 줄은 그 문제를 다시 저장하거나 전체 동기화(sync)로 맞춘다.
   */
  publish(change: CatalogChange): Promise<SyncResult> {
    const run = this.chain.then(() => this.runPartial(change));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runPartial(change: CatalogChange): Promise<SyncResult> {
    const raw = this.reader ? await this.store.get(CATALOG_INDEX_KEY) : null;
    if (!raw || !this.reader) return this.run();
    const json = new TextDecoder().decode(raw);
    const index = (JSON.parse(json) as { data: CatalogIndex }).data;
    let problems = 0;
    for (const id of change.problemIds) {
      const p = await this.reader.problem(id);
      const at = index.problems.findIndex((x) => x.id === id);
      if (!p) {
        if (at >= 0) index.problems.splice(at, 1);
        continue;
      }
      const detail = envelope(p);
      const version = await versionOf(detail);
      if (at >= 0 && index.problems[at]!.version === version) continue;
      await this.store.put(catalogProblemKey(id, version), detail, { contentType: JSON_TYPE });
      problems++;
      const row = { id: p.id, title: p.title, folderId: p.folderId, mode: p.mode, language: p.language, updatedAt: p.updatedAt, version };
      if (at >= 0) index.problems.splice(at, 1);
      index.problems.push(row);
      index.problems.sort(byTitle);
    }
    if (change.collections) index.collections = await this.reader.collections();
    const next = envelope(index);
    if (next === json) return { problems, index: false };
    // 상세를 먼저 올린 뒤 목록을 바꾼다(목록이 가리키는 상세가 항상 있도록)
    await this.store.put(CATALOG_INDEX_KEY, next, { contentType: JSON_TYPE });
    this.published = null;
    return { problems, index: true };
  }

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
    return { index: await versionOf(json), problems: new Map(data.problems.map((p) => [p.id, p.version])) };
  }

  private async run(): Promise<SyncResult> {
    const cat = await buildCatalog(await this.source());
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
