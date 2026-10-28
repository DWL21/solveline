import { useEffect, useState } from 'react';

/**
 * 해시 라우터.
 *   #/            컬렉션 선택
 *   #/all         전체 문제
 *   #/bookmarks   북마크한 문제
 *   #/f/<id>      폴더 (id가 'none'이면 폴더 없음)
 *   #/c/<id>      컬렉션
 *   #/cg/<경로>   컬렉션 묶음(이름의 '/' 계층에서 실제 컬렉션이 없는 상위 단계. 하위 컬렉션의 문제를 모아 보여 준다)
 *   #/p/<id>      문제 풀기
 *   #/submissions 제출 기록
 */
export type Route =
  | { kind: 'home'; scope: Scope }
  | { kind: 'submissions' }
  | { kind: 'problem'; id: string };

export type Scope = { kind: 'collections' } | { kind: 'all' } | { kind: 'bookmarks' } | { kind: 'folder'; id: string | null } | { kind: 'collection'; id: string } | { kind: 'group'; path: string };

export function parseRoute(hash: string): Route {
  if (hash === '#/all') return { kind: 'home', scope: { kind: 'all' } };
  if (hash === '#/bookmarks') return { kind: 'home', scope: { kind: 'bookmarks' } };
  if (hash === '#/submissions') return { kind: 'submissions' };
  const g = /^#\/cg\/(.+)$/.exec(hash);
  if (g) {
    try {
      return { kind: 'home', scope: { kind: 'group', path: decodeURIComponent(g[1]!) } };
    } catch {
      return { kind: 'home', scope: { kind: 'collections' } };
    }
  }
  const m = /^#\/([pfc])\/([\w-]+)$/.exec(hash);
  if (!m) return { kind: 'home', scope: { kind: 'collections' } };
  const [, k, id] = m as unknown as [string, 'p' | 'f' | 'c', string];
  if (k === 'p') return { kind: 'problem', id };
  if (k === 'f') return { kind: 'home', scope: { kind: 'folder', id: id === 'none' ? null : id } };
  return { kind: 'home', scope: { kind: 'collection', id } };
}

export function hrefOf(r: Route): string {
  if (r.kind === 'submissions') return '#/submissions';
  if (r.kind === 'problem') return `#/p/${r.id}`;
  const s = r.scope;
  if (s.kind === 'all') return '#/all';
  if (s.kind === 'bookmarks') return '#/bookmarks';
  if (s.kind === 'folder') return `#/f/${s.id ?? 'none'}`;
  if (s.kind === 'collection') return `#/c/${s.id}`;
  if (s.kind === 'group') return `#/cg/${encodeURIComponent(s.path)}`;
  return '#/';
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const h = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return [route, (r) => (location.hash = hrefOf(r))];
}
