import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collection, Folder, ProblemSummary } from '@solveline/shared';
import { useMe } from '../lib/me.ts';
import { ApiError, api, qk } from '../lib/api.ts';
import { ListSkeleton } from './Loading.tsx';
import { BookmarkStar } from './BookmarkStar.tsx';
import { Icon } from './Icon.tsx';
import type { Scope } from '../lib/route.ts';
import { ancestors, buildTree, collectionProgress, findNode, flatten, problemIdsUnder, siblingNodes, type CollectionNode } from '../lib/collections.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const byTitle = (a: ProblemSummary, b: ProblemSummary) => a.title.localeCompare(b.title, 'ko', { numeric: true });
const sameScope = (a: Scope, b: Scope) =>
  a.kind === b.kind &&
  (a.kind === 'collections' || a.kind === 'all' ||
    (a.kind === 'bookmarks' && b.kind === 'bookmarks') ||
    (a.kind === 'folder' && b.kind === 'folder' && a.id === b.id) ||
    (a.kind === 'collection' && b.kind === 'collection' && a.id === b.id) ||
    (a.kind === 'group' && b.kind === 'group' && a.path === b.path));

/** 나무의 한 단계로 가는 범위: 실제 컬렉션이면 그 컬렉션, 없으면 묶음 */
const scopeOfNode = (n: CollectionNode): Scope => (n.collection ? { kind: 'collection', id: n.collection.id } : { kind: 'group', path: n.path });

/** 범위(전체·폴더·컬렉션)의 문제 목록을 화면과 같은 순서로. "다음 문제"도 이 순서를 따른다. */
export function scopeList(scope: Scope, all: ProblemSummary[], collections: Collection[]): ProblemSummary[] {
  if (scope.kind === 'collections') return [];
  if (scope.kind === 'bookmarks') return all.filter((p) => p.bookmarked).sort(byTitle);
  if (scope.kind === 'folder') return all.filter((p) => p.folderId === scope.id).sort(byTitle);
  const byId = new Map(all.map((p) => [p.id, p]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is ProblemSummary => !!p);
  if (scope.kind === 'collection') {
    const col = collections.find((c) => c.id === scope.id);
    const node = col && findNode(buildTree(collections), col.name);
    if (node) return pick(problemIdsUnder(node));
  }
  // 묶음: 하위 컬렉션의 문제를 모아서
  if (scope.kind === 'group') {
    const node = findNode(buildTree(collections), scope.path);
    if (node) return pick(problemIdsUnder(node));
  }
  return [...all].sort(byTitle);
}

/** 마지막 제출 결과: 100점이면 ✓ 해결, 아니면 점수 */
export function SolvedMark({ p }: Readonly<{ p: ProblemSummary }>) {
  const sub = p.lastSubmission;
  if (!sub) return null;
  if (sub.score === 100)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-ok" title={new Date(sub.at).toLocaleString('ko-KR')} aria-label="해결">
        <Icon name="check" size={14} />
        <span className="max-sm:hidden">해결</span>
      </span>
    );
  return (
    <span className="shrink-0 text-[13px] font-semibold text-warn tabular-nums" title="최근 제출 점수">
      {sub.score}점
    </span>
  );
}

/** 문제 선택 화면: 왼쪽에 전체·폴더·컬렉션, 오른쪽에 그 범위의 문제 목록. */
export function Home({ scope, onScope, onPick, onNew, footer }: Readonly<{ scope: Scope; onScope: (s: Scope) => void; onPick: (id: string) => void; onNew: () => void; footer?: ReactNode }>) {
  const me = useMe();
  const editor = !!me?.editor;
  const signedIn = !!me;
  const problems = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const folders = useQuery({ queryKey: qk.folders, queryFn: api.folders });
  const collections = useQuery({ queryKey: qk.collections, queryFn: api.collections });
  const [filter, setFilter] = useState('');
  const [bookmarksOnly, setBookmarksOnly] = useState(false);
  // 문제가 많으면(1,000개 넘게) 한 번에 그리지 않고 처음 일부만, 내려가면 이어서 그린다(화면 전환이 바로 되게)
  const [limit, setLimit] = useState(PAGE);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => setLimit(PAGE), [scopeKey, filter, bookmarksOnly]);

  const failed = [problems, folders, collections].find((q) => q.isError);
  if (failed) return <LoadError error={failed.error} onRetry={() => failed.refetch()} />;
  if (!problems.data || !folders.data || !collections.data) return <ListSkeleton />;

  const all = problems.data;
  const { effective, folder, collection, node, overview, inCollection, cards, tree } = resolveScope(scope, folders.data, collections.data);

  const list = scopeList(effective, all, collections.data);
  const progress = collectionProgress(list);
  const solved = progress.solved;
  const siblings = node && node.depth > 0 ? siblingNodes(tree, node) : null;
  const parent = node && node.depth > 0 ? findNode(tree, node.path.split('/').slice(0, -1).join('/')) : null;
  const levelLabel = levelLabelOf(node);

  const q = filter.trim().toLowerCase();
  const shown = list.filter((p) => (!bookmarksOnly || p.bookmarked) && (!q || p.title.toLowerCase().includes(q)));
  const unfiled = all.filter((p) => !p.folderId).length;
  const folderName = new Map(folders.data.map((f) => [f.id, f.name]));
  const title = scopeTitle(effective, folder, node);

  let listBody: ReactNode;
  if (all.length === 0)
    listBody = (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-line bg-panel py-16 text-center">
        <p className="text-[15px] font-semibold">아직 문제가 없어요</p>
        {editor && <p className="text-[13px] text-dim">새 문제를 추가해 보세요.</p>}
      </div>
    );
  else if (shown.length === 0)
    listBody = (
      <p className="rounded-lg border border-line bg-panel py-14 text-center text-[14px] text-faint">{emptyMessage({ q, bookmarksOnly, kind: effective.kind, signedIn, inCollection, hasCards: cards.length > 0 })}</p>
    );
  else
    listBody = (
      <>
      <ol className="overflow-hidden rounded-lg border border-line bg-panel" aria-label="문제 목록">
        {shown.slice(0, limit).map((p) => (
          <ProblemRow
            key={p.id}
            p={p}
            order={inCollection ? list.indexOf(p) + 1 : null}
            folderLabel={effective.kind !== 'folder' && p.folderId ? folderName.get(p.folderId) : undefined}
            onPick={onPick}
          />
        ))}
      </ol>
      {shown.length > limit && <MoreSentinel onMore={() => setLimit((n) => n + PAGE)} remaining={shown.length - limit} />}
      </>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <Sidebar
        scope={effective}
        onScope={onScope}
        total={all.length}
        bookmarked={all.filter((p) => p.bookmarked).length}
        unfiled={unfiled}
        folders={folders.data}
        folderCount={(id) => all.filter((p) => p.folderId === id).length}
        tree={tree}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl flex-1 px-4 pt-6 pb-10 sm:px-8 sm:pt-8">
          {effective.kind === 'all' && (
            <nav className="mb-2 text-[13px]" aria-label="컬렉션 경로">
              <button type="button" className="text-dim hover:text-text hover:underline" onClick={() => onScope({ kind: 'collections' })}>
                컬렉션
              </button>
            </nav>
          )}
          {inCollection && node && <CollectionPath node={node} tree={tree} onScope={onScope} />}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {inCollection && node && (
              <button type="button" className="btn-quiet -ml-2 size-9 px-0" aria-label="돌아가기" title="돌아가기" onClick={() => onScope(parent ? scopeOfNode(parent) : { kind: 'collections' })}>
                <Icon name="left" size={18} />
              </button>
            )}
            <h1 className="min-w-0 text-[22px] font-bold tracking-tight sm:text-[24px]">
              {title} <span className="text-[16px] font-semibold text-faint tabular-nums">{overview ? cards.length : list.length}</span>
            </h1>
            {overview && <button type="button" className="btn-ghost ml-auto" onClick={() => onScope({ kind: 'all' })}>전체 보기</button>}
            {(siblings || (folder && signedIn) || (collection && editor)) && (
              <div className="ml-auto flex items-center gap-1">
                {folder && signedIn && <ScopeActions kind="folder" item={folder} onDeleted={() => onScope({ kind: 'all' })} />}
                {collection && editor && <ScopeActions kind="collection" item={collection} onDeleted={() => onScope({ kind: 'collections' })} />}
                {siblings && <SiblingNav siblings={siblings} label={levelLabel} onScope={onScope} />}
              </div>
            )}
          </div>
          {collection?.description && <p className="mt-2 max-w-2xl text-[14px] leading-relaxed whitespace-pre-wrap text-dim">{collection.description}</p>}
          {!overview && list.length > 0 && signedIn && <Progress solved={solved} total={list.length} done={inCollection && progress.cleared} />}
          {cards.length > 0 && <CollectionCards cards={cards} all={all} signedIn={signedIn} overview={overview} onScope={onScope} />}
          {overview && cards.length === 0 && <p className="py-16 text-center text-[14px] text-faint">아직 컬렉션이 없어요</p>}
          {!overview && <>
          <div className="mt-6 mb-3 flex flex-wrap items-center gap-2">
            <label className="relative w-full sm:w-72">
              <Icon name="search" size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
              <input
                className="field h-10 pl-9 font-sans text-[14px]"
                placeholder="문제 제목 검색"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="문제 검색"
              />
            </label>
            {signedIn && effective.kind !== 'bookmarks' && (
              <button type="button" aria-pressed={bookmarksOnly} onClick={() => setBookmarksOnly((v) => !v)} className={`btn-ghost h-10 ${bookmarksOnly ? 'border-accent text-accent-text' : ''}`}>
                <Icon name="star" size={14} filled={bookmarksOnly} /> 북마크
              </button>
            )}
            {editor && (
              <button type="button" className="btn-primary ml-auto h-10" onClick={onNew}>
                <Icon name="plus" size={14} /> 새 문제
              </button>
            )}
          </div>
          {listBody}
          </>}
        </div>
        {footer}
      </div>
    </div>
  );
}


function levelLabelOf(node: CollectionNode | null): string {
  if (node?.name.includes('단계')) return '단계';
  if (node?.name.includes('세트')) return '세트';
  return '컬렉션';
}

function CollectionPath({ node, tree, onScope }: Readonly<{ node: CollectionNode; tree: CollectionNode[]; onScope: (s: Scope) => void }>) {
  return (
    <nav className="mb-2 flex flex-wrap items-center gap-1 text-[13px] text-dim" aria-label="컬렉션 경로">
      <button type="button" className="hover:text-text hover:underline" onClick={() => onScope({ kind: 'collections' })}>컬렉션</button>
      {ancestors(node.path)
        .slice(0, -1)
        .map((path) => {
          const n = findNode(tree, path);
          return (
            <span key={path} className="flex items-center gap-1">
              <Icon name="right" size={12} className="text-faint" />
              <button type="button" className="hover:text-text hover:underline" onClick={() => n && onScope(scopeOfNode(n))}>
                {n?.name ?? path}
              </button>
            </span>
          );
        })}
    </nav>
  );
}

function SiblingNav({ siblings, label, onScope }: Readonly<{ siblings: NonNullable<ReturnType<typeof siblingNodes>>; label: string; onScope: (s: Scope) => void }>) {
  const go = (n: CollectionNode | null | undefined) => n && onScope(scopeOfNode(n));
  return (
    <>
      <button type="button" className="btn-ghost ml-1 size-9 px-0 disabled:opacity-40" aria-label={`이전 ${label}`} title={`이전 ${label}`} disabled={!siblings.previous} onClick={() => go(siblings.previous)}><Icon name="left" /></button>
      <button type="button" className="btn-ghost size-9 px-0 disabled:opacity-40" aria-label={`다음 ${label}`} title={`다음 ${label}`} disabled={!siblings.next} onClick={() => go(siblings.next)}><Icon name="right" /></button>
    </>
  );
}

function CollectionCards({ cards, all, signedIn, overview, onScope }: Readonly<{ cards: CollectionNode[]; all: ProblemSummary[]; signedIn: boolean; overview: boolean; onScope: (s: Scope) => void }>) {
  return (
    <section className={overview ? 'mt-6' : 'mt-6 mb-2'} aria-label={overview ? '컬렉션' : '하위 컬렉션'}>
      <ul className={overview ? 'flex flex-col gap-8' : 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'}>
        {cards.map((n) => (
          <li key={n.path} className="min-w-0">
            <CollectionCard node={n} all={all} signedIn={signedIn} stretch={!overview || n.children.length === 0} onOpen={() => onScope(scopeOfNode(n))} />
            {overview && n.children.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3">
                {n.children.map((child) => <CollectionCard key={child.path} node={child} all={all} signedIn={signedIn} compact onOpen={() => onScope(scopeOfNode(child))} />)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 이 범위에서 맞힌 문제 수 */
function Progress({ solved, total, done }: Readonly<{ solved: number; total: number; done: boolean }>) {
  return (
    <div className="mt-4 flex max-w-md items-center gap-3 text-[13px]" title="100점을 받은 문제">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden>
        <div className="h-full rounded-full bg-ok" style={{ width: `${total ? (solved / total) * 100 : 0}%` }} />
      </div>
      <span className={`shrink-0 font-semibold tabular-nums ${done ? 'text-ok' : 'text-dim'}`}>
        {done ? '✓ 모두 해결' : `${solved} / ${total} 해결`}
      </span>
    </div>
  );
}

function LoadError({ error, onRetry }: Readonly<{ error: unknown; onRetry: () => Promise<unknown> }>) {
  return (
    <div className="p-6 text-[13px]">
      <p className="font-semibold text-bad">{errMsg(error)}</p>
      <button type="button" className="btn-ghost mt-3" onClick={() => void onRetry()}>
        다시 시도
      </button>
    </div>
  );
}

/** 주소의 범위를 실제 데이터에 맞춘다. 지워진 폴더·컬렉션 주소로 들어오면 컬렉션 선택 화면을 보여 준다. */
function resolveScope(scope: Scope, folders: Folder[], collections: Collection[]) {
  const folder = scope.kind === 'folder' && scope.id ? folders.find((f) => f.id === scope.id) : undefined;
  const collection = scope.kind === 'collection' ? collections.find((c) => c.id === scope.id) : undefined;
  const tree = buildTree(collections);
  let node: CollectionNode | null = null;
  if (collection) node = findNode(tree, collection.name);
  else if (scope.kind === 'group') node = findNode(tree, scope.path);
  const missing = (scope.kind === 'folder' && scope.id && !folder) || (scope.kind === 'collection' && !collection) || (scope.kind === 'group' && !node);
  const effective: Scope = missing ? { kind: 'collections' } : scope;
  const overview = effective.kind === 'collections';
  const inCollection = effective.kind === 'collection' || effective.kind === 'group';
  // 첫 화면은 최상위 컬렉션, 컬렉션 안에서는 그 하위를 보여 준다.
  let cards: CollectionNode[] = [];
  if (overview) cards = tree;
  else if (inCollection && node) cards = node.children;
  return { effective, folder, collection, node, tree, overview, inCollection, cards };
}

function scopeTitle(scope: Scope, folder: Folder | undefined, node: CollectionNode | null): string {
  if (scope.kind === 'collections') return '컬렉션';
  if (scope.kind === 'all') return '전체 문제';
  if (scope.kind === 'bookmarks') return '북마크';
  if (scope.kind === 'folder') return folder?.name ?? '폴더 없음';
  return node?.name ?? '';
}

function emptyMessage({ q, bookmarksOnly, kind, signedIn, inCollection, hasCards }: { q: string; bookmarksOnly: boolean; kind: Scope['kind']; signedIn: boolean; inCollection: boolean; hasCards: boolean }): string {
  if (q) return `'${q}'에 맞는 문제가 없어요`;
  if (bookmarksOnly || kind === 'bookmarks') return signedIn ? '북마크한 문제가 없어요' : '로그인하면 북마크를 쓸 수 있어요';
  if (inCollection) return hasCards ? '위에서 하위 컬렉션을 골라 주세요' : '아직 문제가 없어요';
  return '이 폴더에 문제가 없어요';
}

function ProblemRow({ p, order, folderLabel, onPick }: Readonly<{ p: ProblemSummary; order: number | null; folderLabel: string | undefined; onPick: (id: string) => void }>) {
  return (
    <li className="flex items-center border-b border-line last:border-b-0 hover:bg-raised/60">
      <button type="button" onClick={() => onPick(p.id)} className="flex min-h-13 min-w-0 flex-1 items-center gap-4 py-3 pl-5 text-left">
        {order !== null && <span className="w-5 shrink-0 text-right text-[13px] text-faint tabular-nums">{order}</span>}
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{p.title}</span>
        {folderLabel && <span className="hidden max-w-32 shrink-0 truncate rounded bg-raised px-2 py-0.5 text-[12px] text-dim sm:inline">{folderLabel}</span>}
        <SolvedMark p={p} />
      </button>
      <BookmarkStar id={p.id} bookmarked={p.bookmarked} />
    </li>
  );
}

type ScopeItem = { scope: Scope; label: string; count: number; group: 'all' | 'folder' | 'collection'; key: string; depth?: number };

function Sidebar({
  scope,
  onScope,
  total,
  bookmarked,
  unfiled,
  folders,
  folderCount,
  tree,
}: Readonly<{
  scope: Scope;
  onScope: (s: Scope) => void;
  total: number;
  bookmarked: number;
  unfiled: number;
  folders: Folder[];
  folderCount: (id: string) => number;
  tree: CollectionNode[];
}>) {
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const scopes: ScopeItem[] = [
    { scope: { kind: 'collections' }, label: '컬렉션', count: tree.length, group: 'all', key: 'collections' },
    { scope: { kind: 'all' }, label: '전체 문제', count: total, group: 'all', key: 'all' },
    { scope: { kind: 'bookmarks' }, label: '북마크', count: bookmarked, group: 'all', key: 'bookmarks' },
    ...folders.map((f): ScopeItem => ({ scope: { kind: 'folder', id: f.id }, label: f.name, count: folderCount(f.id), group: 'folder', key: 'f' + f.id })),
    ...(unfiled > 0 ? [{ scope: { kind: 'folder', id: null }, label: '폴더 없음', count: unfiled, group: 'folder', key: 'fnone' } as ScopeItem] : []),
    // 컬렉션은 '/' 계층을 들여쓰기로 보여 준다. 묶음(실제 컬렉션 없음)도 고를 수 있다.
    ...flatten(tree).map(
      (n): ScopeItem => ({ scope: scopeOfNode(n), label: n.name, count: problemIdsUnder(n).length, group: 'collection', key: 'c' + n.path, depth: n.depth }),
    ),
  ];
  const current = scopes.find((s) => sameScope(s.scope, scope))?.key ?? 'collections';
  // 컬렉션 안을 보는 중이면 휴대폰 상단에서는 "컬렉션"을 고른 것으로 보여 준다
  const chip = current.startsWith('c') && current !== 'collections' ? 'collections' : current;

  const item = (s: ScopeItem) => (
    <li key={s.key}>
      <button
        type="button"
        onClick={() => onScope(s.scope)}
        aria-current={current === s.key ? 'page' : undefined}
        style={s.depth ? { paddingLeft: `${12 + s.depth * 14}px` } : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-3 py-[7px] text-left text-[14px] ${current === s.key ? 'bg-raised font-semibold text-text' : 'text-dim hover:bg-raised hover:text-text'}`}
      >
        <span className="min-w-0 flex-1 truncate">{s.label}</span>
        <span className={`text-[12px] tabular-nums text-faint`}>{s.count}</span>
      </button>
    </li>
  );

  return (
    <>
      {/* 휴대폰: 범위를 가로로 넘겨 고른다. 컬렉션 안쪽은 카드로 들어간다. */}
      <div className="border-b border-line bg-base md:hidden">
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto px-4 py-2.5">
          {scopes
            .filter((s) => s.group !== 'collection')
            .map((s) => (
              <button
                key={s.key}
                type="button"
                aria-current={chip === s.key ? 'page' : undefined}
                onClick={() => onScope(s.scope)}
                className={`h-9 shrink-0 rounded-full border px-3.5 text-[13.5px] font-semibold whitespace-nowrap ${chip === s.key ? 'border-text bg-text text-base' : 'border-line-strong text-dim'}`}
              >
                {s.label} <span className="font-normal opacity-70">{s.count}</span>
              </button>
            ))}
          {me && (
            <button
              type="button"
              className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-dim"
              aria-expanded={creating}
              aria-label="폴더·컬렉션 만들기"
              onClick={() => setCreating((v) => !v)}
            >
              <Icon name={creating ? 'close' : 'plus'} size={14} />
            </button>
          )}
        </div>
        {creating && me && (
          <div className="px-4 pb-3">
            <QuickCreate editor={me.editor} onDone={() => setCreating(false)} />
          </div>
        )}
      </div>
      <aside className="hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-base px-3 py-5 md:flex">
        <ul className="flex flex-col gap-0.5">{scopes.filter((s) => s.group === 'all').map(item)}</ul>
        <section>
          <SectionHeader kind="folder" />
          <ul className="flex flex-col gap-0.5">{scopes.filter((s) => s.group === 'folder').map(item)}</ul>
        </section>
        <section>
          <SectionHeader kind="collection" />
          <ul className="flex flex-col gap-0.5">{scopes.filter((s) => s.group === 'collection').map(item)}</ul>
        </section>
      </aside>
    </>
  );
}

/** 휴대폰: 내 폴더(누구나)·공용 컬렉션(편집 권한)을 바로 만든다 */
function QuickCreate({ editor, onDone }: Readonly<{ editor: boolean; onDone: () => void }>) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'collection' | 'folder'>('folder');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async (): Promise<unknown> => (kind === 'folder' ? api.createFolder(name.trim()) : api.createCollection({ name: name.trim(), description: '' })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: kind === 'folder' ? qk.folders : qk.collections });
      setName('');
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      {editor && (
        <div className="grid grid-cols-2 gap-1 rounded-md bg-raised p-1" role="radiogroup" aria-label="만들 항목">
          {(
            [
              ['folder', '내 폴더'],
              ['collection', '컬렉션'],
            ] as const
          ).map(([k, label]) => (
            <label
              key={k}
              className={`flex h-9 cursor-pointer items-center justify-center rounded text-[13px] font-semibold has-focus-visible:outline-2 has-focus-visible:outline-accent ${kind === k ? 'bg-panel text-text shadow-sm' : 'text-dim'}`}
            >
              <input type="radio" name="quick-create-kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
              {label}
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="field h-10 min-w-0 flex-1 font-sans text-[14px]"
          placeholder={kind === 'folder' ? '폴더 이름' : '컬렉션 이름 (하위는 / 로 구분)'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <button type="submit" className="btn-primary h-10 shrink-0" disabled={!name.trim() || create.isPending}>
          만들기
        </button>
      </div>
      {create.isError && <p className="text-[12px] text-bad">{errMsg(create.error)}</p>}
    </form>
  );
}

/** 섹션 제목 + 새 폴더/컬렉션 입력 */
function SectionHeader({ kind }: Readonly<{ kind: 'folder' | 'collection' }>) {
  const qc = useQueryClient();
  // 폴더는 각자 만드는 개인 정리, 컬렉션은 공용이라 편집 권한이 있어야 만든다
  const me = useMe();
  const canAdd = kind === 'folder' ? !!me : !!me?.editor;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async (): Promise<unknown> => (kind === 'folder' ? api.createFolder(name.trim()) : api.createCollection({ name: name.trim(), description: '' })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: kind === 'folder' ? qk.folders : qk.collections });
      setName('');
      setOpen(false);
    },
  });
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  const label = kind === 'folder' ? '폴더' : '컬렉션';
  return (
    <div className="mb-1">
      <div className="flex h-7 items-center pr-1 pl-3">
        <h2 className="flex-1 text-[12px] font-semibold text-faint">{kind === 'folder' && me ? '내 폴더' : label}</h2>
        {canAdd && (
        <button
          type="button"
          className="touch-target flex size-6 items-center justify-center rounded text-faint hover:bg-raised hover:text-text"
          aria-label={`새 ${label}`}
          title={`새 ${label}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="plus" size={14} />
        </button>
        )}
      </div>
      {open && canAdd && (
        <form onSubmit={submit} className="mt-1 mb-1 px-1">
          <input
            className="field font-sans"
            placeholder={kind === 'collection' ? '컬렉션 이름 (하위는 / 로 구분)' : '폴더 이름'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            autoFocus
          />
          {create.isError && <p className="mt-1 text-[12px] text-bad">{errMsg(create.error)}</p>}
        </form>
      )}
    </div>
  );
}

/** 선택한 폴더·컬렉션의 이름 바꾸기·삭제 */
function ScopeActions({ kind, item, onDeleted }: Readonly<{ kind: 'folder' | 'collection'; item: Folder | Collection; onDeleted: () => void }>) {
  const qc = useQueryClient();
  const key = kind === 'folder' ? qk.folders : qk.collections;
  const rename = useMutation({
    mutationFn: async (name: string): Promise<unknown> =>
      kind === 'folder' ? api.renameFolder(item.id, name) : api.updateCollection(item.id, { name, description: (item as Collection).description }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => alert(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: async (): Promise<unknown> => (kind === 'folder' ? api.deleteFolder(item.id) : api.deleteCollection(item.id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: qk.problems });
      onDeleted();
    },
    onError: (e) => alert(errMsg(e)),
  });
  const label = kind === 'folder' ? '폴더' : '컬렉션';
  return (
    <div className="flex gap-1">
      <button
        type="button"
        className="btn-quiet min-h-8 px-2.5"
        onClick={() => {
          const name = prompt(`새 ${label} 이름`, item.name)?.trim();
          if (name && name !== item.name) rename.mutate(name);
        }}
      >
        이름 바꾸기
      </button>
      <button
        type="button"
        className="btn-quiet min-h-8 px-2.5 hover:text-bad"
        onClick={() =>
          confirm(kind === 'folder' ? `'${item.name}' 폴더를 삭제할까요? 폴더 안의 문제는 지워지지 않아요.` : `'${item.name}' 컬렉션을 삭제할까요? 문제는 지워지지 않아요.`) &&
          remove.mutate()
        }
      >
        삭제
      </button>
    </div>
  );
}

/** 컬렉션 카드: 이름, 설명 첫 줄, 문제 수, (로그인 시) 맞힌 비율 */
function CollectionCard({ node, all, signedIn, onOpen, compact = false, stretch = true }: Readonly<{ node: CollectionNode; all: ProblemSummary[]; signedIn: boolean; onOpen: () => void; compact?: boolean; stretch?: boolean }>) {
  const ids = new Set(problemIdsUnder(node));
  const total = ids.size;
  const solved = all.filter((p) => ids.has(p.id) && p.lastSubmission?.score === 100).length;
  const pct = total ? Math.round((solved / total) * 100) : 0;
  // 카드에는 설명의 첫 줄만 한 줄로(자세한 규칙·목록은 컬렉션을 열면 보인다)
  const desc = node.collection?.description.trim().split('\n')[0]?.trim();
  const meta = [`${total}문제`, node.children.length > 0 && `하위 ${node.children.length}개`].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full flex-col rounded-lg border border-line bg-panel text-left transition hover:border-line-strong hover:bg-raised/40 ${compact ? 'gap-3 px-3.5 py-3 sm:px-4 sm:py-3.5' : 'gap-4 p-5 sm:p-6'} ${stretch ? 'h-full' : ''}`}
    >
      <span className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className={`block truncate font-bold ${compact ? 'text-[15px]' : 'text-[18px]'}`}>{node.name}</span>
          {!compact && desc ? <span className="mt-1 line-clamp-1 text-[14px] text-dim">{desc}</span> : null}
        </span>
        <Icon name="right" size={compact ? 14 : 16} className="mt-1 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-text" />
      </span>
      <span className={`mt-auto flex min-w-0 items-center text-faint ${compact ? 'flex-wrap gap-x-2 gap-y-1 text-[12.5px]' : 'gap-3 text-[13px]'}`}>
        <span className={compact ? 'min-w-0 basis-full break-words' : 'shrink-0'}>{meta}</span>
        {signedIn && total > 0 && (
          <>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden>
              <span className="block h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
            </span>
            <span className={`shrink-0 tabular-nums ${solved === total ? 'font-semibold text-ok' : ''}`}>
              {solved === total ? '✓ ' : ''}
              {solved}/{total}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

const PAGE = 80;

/** 목록 끝에 닿으면 다음 묶음을 그린다(스크롤하지 못하는 환경을 위해 버튼도 둔다) */
function MoreSentinel({ onMore, remaining }: Readonly<{ onMore: () => void; remaining: number }>) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in globalThis)) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return (
    <button ref={ref} type="button" className="btn-ghost mt-3 h-10 w-full" onClick={onMore}>
      {remaining}개 더 보기
    </button>
  );
}
