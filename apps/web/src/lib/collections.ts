import type { Collection } from '@solveline/shared';

/**
 * 컬렉션 계층: 이름의 '/'로 나무를 만든다(Vaultwarden 방식). "모의고사/1회"는 "모의고사" 아래의 "1회".
 * 상위 단계는 실제 컬렉션이 없을 수도 있다(묶음). 묶음을 열면 하위 컬렉션의 문제를 모아 보여 준다.
 */
export type CollectionNode = {
  path: string;
  /** 마지막 단계 이름 */
  name: string;
  depth: number;
  collection: Collection | null;
  children: CollectionNode[];
};

const natural = (a: string, b: string) => a.localeCompare(b, 'ko', { numeric: true });

export function buildTree(collections: Collection[]): CollectionNode[] {
  const roots: CollectionNode[] = [];
  const byPath = new Map<string, CollectionNode>();
  const ensure = (path: string): CollectionNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const parts = path.split('/');
    const node: CollectionNode = { path, name: parts[parts.length - 1]!, depth: parts.length - 1, collection: null, children: [] };
    byPath.set(path, node);
    if (parts.length === 1) roots.push(node);
    else ensure(parts.slice(0, -1).join('/')).children.push(node);
    return node;
  };
  for (const c of collections) ensure(c.name).collection = c;
  const sort = (nodes: CollectionNode[]) => {
    nodes.sort((a, b) => natural(a.name, b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** 나무를 위에서부터 펼친 순서(사이드바·드롭다운용) */
export function flatten(nodes: CollectionNode[]): CollectionNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

export function findNode(nodes: CollectionNode[], path: string): CollectionNode | null {
  return flatten(nodes).find((n) => n.path === path) ?? null;
}

/** 이 단계와 그 아래 모든 컬렉션의 문제 id(겹치면 처음 것만, 위에서부터 순서대로) */
export function problemIdsUnder(node: CollectionNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of flatten([node])) {
    for (const id of n.collection?.problemIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** 경로의 각 단계(이동 경로 표시용): "a/b/c" → ["a", "a/b", "a/b/c"] */
export const ancestors = (path: string) => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/** 최근 제출이 100점인 문제만 완료로 보고, 목록 순서대로 다음 문제를 고른다. */
export function collectionProgress<T extends { id: string; lastSubmission?: { score: number } | null }>(problems: T[]) {
  const solved = problems.filter((p) => p.lastSubmission?.score === 100).length;
  return { solved, total: problems.length, cleared: problems.length > 0 && solved === problems.length, next: problems.find((p) => p.lastSubmission?.score !== 100) };
}
