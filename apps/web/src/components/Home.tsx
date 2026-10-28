import { Language } from '@solveline/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collection, Folder, ProblemSummary } from '@solveline/shared';
import { loginHref, useMe } from '../lib/me.ts';
import { ApiError, api, qk } from '../lib/api.ts';
import { ListSkeleton } from './Loading.tsx';
import { BookmarkStar } from './BookmarkStar.tsx';
import type { Scope } from '../lib/route.ts';
import { ancestors, buildTree, collectionProgress, findNode, flatten, problemIdsUnder, type CollectionNode } from '../lib/collections.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const byTitle = (a: ProblemSummary, b: ProblemSummary) => a.title.localeCompare(b.title, 'ko', { numeric: true });
const sameScope = (a: Scope, b: Scope) =>
  a.kind === b.kind &&
  (a.kind === 'all' ||
    (a.kind === 'bookmarks' && b.kind === 'bookmarks') ||
    (a.kind === 'folder' && b.kind === 'folder' && a.id === b.id) ||
    (a.kind === 'collection' && b.kind === 'collection' && a.id === b.id) ||
    (a.kind === 'group' && b.kind === 'group' && a.path === b.path));

/** 나무의 한 단계로 가는 범위: 실제 컬렉션이면 그 컬렉션, 없으면 묶음 */
const scopeOfNode = (n: CollectionNode): Scope => (n.collection ? { kind: 'collection', id: n.collection.id } : { kind: 'group', path: n.path });

/** 범위(전체·폴더·컬렉션)의 문제 목록을 화면과 같은 순서로. "다음 문제"도 이 순서를 따른다. */
export function scopeList(scope: Scope, all: ProblemSummary[], collections: Collection[]): ProblemSummary[] {
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

/** 마지막 제출 결과 표시: 100점이면 초록 ✓, 아니면 점수 */
export function SolvedMark({ p }: { p: ProblemSummary }) {
  const sub = p.lastSubmission;
  if (!sub) return null;
  if (sub.score === 100)
    return (
      <span className="shrink-0 text-[14px] font-bold text-ok" title={new Date(sub.at).toLocaleString('ko-KR')} aria-label="맞춤">
        ✓
      </span>
    );
  return (
    <span className="shrink-0 text-[11.5px] font-semibold text-warn" title={`최근 제출 ${sub.score}점`}>
      △ {sub.score}점
    </span>
  );
}

/** 문제 선택 화면: 왼쪽에 전체·폴더·컬렉션, 오른쪽에 그 범위의 문제 목록. */
export function Home({ scope, onScope, onPick, onNew }: { scope: Scope; onScope: (s: Scope) => void; onPick: (id: string) => void; onNew: () => void }) {
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
  if (failed)
    return (
      <div className="p-6 text-[13px]">
        <p className="font-semibold text-bad">{errMsg(failed.error)}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void failed.refetch()}>
          다시 시도
        </button>
      </div>
    );
  if (!problems.data || !folders.data || !collections.data) return <ListSkeleton />;

  const all = problems.data;
  const folder = scope.kind === 'folder' && scope.id ? folders.data.find((f) => f.id === scope.id) : undefined;
  const collection = scope.kind === 'collection' ? collections.data.find((c) => c.id === scope.id) : undefined;
  const tree = buildTree(collections.data);
  const node = collection ? findNode(tree, collection.name) : scope.kind === 'group' ? findNode(tree, scope.path) : null;

  // 지워진 폴더·컬렉션 주소로 들어오면 전체로 보여 준다
  const effective: Scope =
    (scope.kind === 'folder' && scope.id && !folder) || (scope.kind === 'collection' && !collection) || (scope.kind === 'group' && !node) ? { kind: 'all' } : scope;
  const inCollection = effective.kind === 'collection' || effective.kind === 'group';
  // 카드로 보여 줄 컬렉션: 전체 화면이면 최상위, 컬렉션 안이면 그 하위
  const cards = effective.kind === 'all' ? tree : inCollection && node ? node.children : [];

  const list = scopeList(effective, all, collections.data);
  const progress = collectionProgress(list);
  const solved = progress.solved;

  const q = filter.trim().toLowerCase();
  const shown = list.filter((p) => (!bookmarksOnly || p.bookmarked) && (!q || p.title.toLowerCase().includes(q)));
  const unfiled = all.filter((p) => !p.folderId).length;
  const folderName = new Map(folders.data.map((f) => [f.id, f.name]));
  const title = effective.kind === 'all' ? '전체 문제' : effective.kind === 'bookmarks' ? '북마크' : effective.kind === 'folder' ? (folder?.name ?? '폴더 없음') : (node?.name ?? '');

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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
          {inCollection && node && node.depth > 0 && (
            <nav className="mb-1 flex flex-wrap items-center gap-1 text-[12.5px] text-dim" aria-label="컬렉션 경로">
              {ancestors(node.path)
                .slice(0, -1)
                .map((path) => {
                  const n = findNode(tree, path);
                  return (
                    <span key={path} className="flex items-center gap-1">
                      <button type="button" className="hover:text-text hover:underline" onClick={() => n && onScope(scopeOfNode(n))}>
                        {n?.name ?? path}
                      </button>
                      <span className="text-faint">/</span>
                    </span>
                  );
                })}
            </nav>
          )}
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h1 className="text-[18px] font-bold">
              {inCollection && <span className="mr-1.5 text-sky">◆</span>}
              {effective.kind === 'folder' && <span className="mr-1.5 text-warn">▤</span>}
              {title} <span className="text-[14px] font-semibold text-faint">{list.length}</span>
            </h1>
            {list.length > 0 && signedIn && (
              <span className="text-[12px] font-semibold text-ok" title="100점을 받은 문제">
                ✓ {solved}/{list.length}
              </span>
            )}
            {folder && signedIn && <ScopeActions kind="folder" item={folder} onDeleted={() => onScope({ kind: 'all' })} />}
            {collection && editor && <ScopeActions kind="collection" item={collection} onDeleted={() => onScope({ kind: 'all' })} />}
          </div>
          {inCollection && list.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px]">
              {signedIn ? (
                progress.cleared ? <span className="font-semibold text-ok">✓ {node?.name.includes('단계') ? '단계' : node?.name.includes('세트') ? '세트' : '컬렉션'} 클리어</span> :
                  <button type="button" className="btn-primary" onClick={() => progress.next && onPick(progress.next.id)}>다음 미완료 문제 풀기</button>
              ) : <span className="text-dim">로그인하면 풀이 진행 상황을 확인할 수 있어요. <a className="text-sky underline" href={loginHref()}>로그인</a></span>}
            </div>
          )}
          {collection?.description && <p className="mb-1 text-[13px] whitespace-pre-wrap text-dim">{collection.description}</p>}
          {cards.length > 0 && (
            <section className="mt-3 mb-5" aria-label={effective.kind === 'all' ? '컬렉션' : '하위 컬렉션'}>
              {effective.kind === 'all' && <h2 className="mb-2 text-[13px] font-bold text-dim">컬렉션</h2>}
              <ul className="grid grid-cols-2 gap-2 sm:gap-2.5 lg:grid-cols-3">
                {cards.map((n) => (
                  <li key={n.path}>
                    <CollectionCard node={n} all={all} signedIn={signedIn} onOpen={() => onScope(scopeOfNode(n))} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {effective.kind === 'all' && cards.length > 0 && <h2 className="mb-0 text-[13px] font-bold text-dim">전체 문제</h2>}
          <div className="mt-3 mb-4 flex flex-wrap items-center gap-2">
            <input
              className="field w-full font-sans sm:w-72"
              placeholder="제목·유형·단계 검색 (예: 3단계, DP)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="문제 검색"
            />
            {signedIn && effective.kind !== 'bookmarks' && <button type="button" aria-pressed={bookmarksOnly} onClick={() => setBookmarksOnly((v) => !v)} className={`btn-ghost ${bookmarksOnly ? 'text-warn' : ''}`}>★ 북마크만 보기</button>}
            {editor && (
              <button type="button" className="btn-primary ml-auto" onClick={onNew} title="편집 권한: 모든 사용자에게 보이는 문제를 만들어요">
                + 새 문제
              </button>
            )}
          </div>
          {all.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-[15px] font-bold">아직 문제가 없어요</p>
              <p className="text-[13px] text-dim">{editor ? '문제를 만들고 설명·테스트 케이스를 붙여 넣은 뒤 풀어 보세요.' : '문제가 등록되면 여기에 보여요.'}</p>
            </div>
          ) : shown.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-faint">
              {q ? '검색 결과가 없어요' : bookmarksOnly || effective.kind === 'bookmarks' ? (signedIn ? '북마크한 문제가 없어요' : '로그인하면 북마크를 사용할 수 있어요') : inCollection ? (cards.length ? '하위 컬렉션을 골라 보세요' : '아직 문제가 없어요') : '이 폴더에 문제가 없어요'}
            </p>
          ) : (
            <>
            <ol className="overflow-hidden rounded-lg border border-line bg-panel">
              {shown.slice(0, limit).map((p) => (
                <li key={p.id} className="flex items-center border-b border-line last:border-b-0">
                  <BookmarkStar id={p.id} bookmarked={p.bookmarked} />
                  <button
                    type="button"
                    onClick={() => onPick(p.id)}
                    className={`flex min-w-0 flex-1 items-center gap-3 border-l-[3px] px-4 py-3 text-left hover:bg-raised ${p.lastSubmission?.score === 100 ? 'border-ok bg-ok/[0.06]' : 'border-transparent'}`}
                  >
                    {inCollection && <span className="w-6 shrink-0 text-right font-mono text-[12px] text-faint">{list.indexOf(p) + 1}</span>}
                    <span className={`min-w-0 flex-1 truncate text-[14px] font-semibold ${p.lastSubmission?.score === 100 ? 'text-ok' : ''}`}>{p.title}</span>
                    <SolvedMark p={p} />
                    {effective.kind !== 'folder' && p.folderId && (
                      <span className="hidden shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-dim sm:inline">{folderName.get(p.folderId)}</span>
                    )}
                    <span className="shrink-0 text-[11.5px] text-faint" aria-label="지원 언어">{Language.options.map((language) => language === 'java' ? 'Java' : 'Python').join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ol>
            {shown.length > limit && <MoreSentinel onMore={() => setLimit((n) => n + PAGE)} remaining={shown.length - limit} />}
            </>
          )}
        </div>
      </div>
    </div>
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
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  total: number;
  bookmarked: number;
  unfiled: number;
  folders: Folder[];
  folderCount: (id: string) => number;
  tree: CollectionNode[];
}) {
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const scopes: ScopeItem[] = [
    { scope: { kind: 'all' }, label: '전체', count: total, group: 'all', key: 'all' },
    { scope: { kind: 'bookmarks' }, label: '북마크', count: bookmarked, group: 'all', key: 'bookmarks' },
    ...folders.map((f): ScopeItem => ({ scope: { kind: 'folder', id: f.id }, label: f.name, count: folderCount(f.id), group: 'folder', key: 'f' + f.id })),
    ...(unfiled > 0 ? [{ scope: { kind: 'folder', id: null }, label: '폴더 없음', count: unfiled, group: 'folder', key: 'fnone' } as ScopeItem] : []),
    // 컬렉션은 '/' 계층을 들여쓰기로 보여 준다. 묶음(실제 컬렉션 없음)도 고를 수 있다.
    ...flatten(tree).map(
      (n): ScopeItem => ({ scope: scopeOfNode(n), label: n.name, count: problemIdsUnder(n).length, group: 'collection', key: 'c' + n.path, depth: n.depth }),
    ),
  ];
  const current = scopes.find((s) => sameScope(s.scope, scope))?.key ?? 'all';
  const icon = (g: ScopeItem['group']) => (g === 'collection' ? '◆' : g === 'folder' ? '▤' : '☰');

  const item = (s: ScopeItem) => (
    <li key={s.key}>
      <button
        type="button"
        onClick={() => onScope(s.scope)}
        aria-current={current === s.key ? 'page' : undefined}
        style={s.depth ? { paddingLeft: `${10 + s.depth * 14}px` } : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${current === s.key ? 'bg-raised font-semibold text-text' : 'text-dim hover:bg-raised/60 hover:text-text'}`}
      >
        <span className={`w-4 shrink-0 text-center text-[11px] ${s.group === 'collection' ? 'text-sky' : s.group === 'folder' ? 'text-warn' : 'text-faint'}`} aria-hidden>
          {s.key === 'bookmarks' ? '★' : icon(s.group)}
        </span>
        <span className="min-w-0 flex-1 truncate">{s.label}</span>
        <span className="text-[11.5px] text-faint">{s.count}</span>
      </button>
    </li>
  );

  return (
    <>
      {/* 휴대폰: 범위 선택 드롭다운 + 폴더·컬렉션 만들기 */}
      <div className="border-b border-line bg-base px-4 py-2 md:hidden">
        <div className="flex gap-2">
        <select
          aria-label="보기 범위"
          value={current}
          onChange={(e) => {
            const s = scopes.find((x) => x.key === e.target.value);
            if (s) onScope(s.scope);
          }}
          className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-raised px-2 text-[14px] font-semibold outline-none"
        >
          {scopes.map((s) => (
            <option key={s.key} value={s.key}>
              {s.group === 'folder' ? '폴더 · ' : s.group === 'collection' ? `컬렉션 · ${'　'.repeat(s.depth ?? 0)}` : ''}
              {s.label} ({s.count})
            </option>
          ))}
        </select>
        {me && (
          <button
            type="button"
            className="btn-ghost h-10 w-10 shrink-0 px-0 text-[18px]"
            aria-expanded={creating}
            aria-label="폴더·컬렉션 만들기"
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? '×' : '+'}
          </button>
        )}
        </div>
        {creating && me && (
          <QuickCreate editor={me.editor} onDone={() => setCreating(false)} />
        )}
      </div>
      <aside className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-base px-3 py-4 md:flex">
        <ul>{scopes.filter((s) => s.group === 'all').map(item)}</ul>
        <section>
          <SectionHeader kind="folder" />
          <ul>{scopes.filter((s) => s.group === 'folder').map(item)}</ul>
        </section>
        <section>
          <SectionHeader kind="collection" />
          <ul>{scopes.filter((s) => s.group === 'collection').map(item)}</ul>
        </section>
      </aside>
    </>
  );
}

/** 휴대폰: 내 폴더(누구나)·공용 컬렉션(편집 권한)을 바로 만든다 */
function QuickCreate({ editor, onDone }: { editor: boolean; onDone: () => void }) {
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
      className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      {editor && (
        <div className="grid grid-cols-2 gap-1 rounded-md bg-base p-1" role="radiogroup" aria-label="만들 항목">
          {(
            [
              ['folder', '▤ 내 폴더'],
              ['collection', '◆ 컬렉션'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={`h-9 rounded text-[13px] font-semibold ${kind === k ? 'bg-raised text-text' : 'text-dim'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="field h-10 min-w-0 flex-1 font-sans text-[14px]"
          placeholder={kind === 'folder' ? '새 폴더 이름' : '새 컬렉션 이름 (예: 모의고사/1회)'}
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
function SectionHeader({ kind }: { kind: 'folder' | 'collection' }) {
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  const label = kind === 'folder' ? '폴더' : '컬렉션';
  return (
    <div className="mb-1">
      <div className="flex items-center px-2.5">
        <h2 className="flex-1 text-[11.5px] font-bold tracking-wide text-faint">{kind === 'folder' && me ? '내 폴더' : label}</h2>
        {canAdd && (
        <button
          type="button"
          className="touch-target rounded px-1.5 text-[15px] leading-6 text-faint hover:bg-raised hover:text-text"
          aria-label={`새 ${label}`}
          title={`새 ${label}`}
          onClick={() => setOpen((v) => !v)}
        >
          +
        </button>
        )}
      </div>
      {open && canAdd && (
        <form onSubmit={submit} className="mt-1 px-1">
          <input
            className="field font-sans"
            placeholder={kind === 'collection' ? '컬렉션 이름 (예: 모의고사/1회)' : `${label} 이름`}
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
function ScopeActions({ kind, item, onDeleted }: { kind: 'folder' | 'collection'; item: Folder | Collection; onDeleted: () => void }) {
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
    <div className="ml-auto flex gap-1">
      <button
        type="button"
        className="btn-quiet min-h-7 px-2 text-[12px]"
        onClick={() => {
          const name = prompt(`${label} 이름`, item.name)?.trim();
          if (name && name !== item.name) rename.mutate(name);
        }}
      >
        이름 바꾸기
      </button>
      <button
        type="button"
        className="btn-quiet min-h-7 px-2 text-[12px]"
        onClick={() =>
          confirm(kind === 'folder' ? `"${item.name}" 폴더를 지울까요? 안의 문제는 "폴더 없음"으로 남아요.` : `"${item.name}" 컬렉션을 지울까요? 문제는 지워지지 않아요.`) &&
          remove.mutate()
        }
      >
        삭제
      </button>
    </div>
  );
}

/** 컬렉션 카드: 이름, 문제 수, (로그인 시) 맞힌 비율, 하위 컬렉션 수 */
function CollectionCard({ node, all, signedIn, onOpen }: { node: CollectionNode; all: ProblemSummary[]; signedIn: boolean; onOpen: () => void }) {
  const ids = new Set(problemIdsUnder(node));
  const total = ids.size;
  const solved = all.filter((p) => ids.has(p.id) && p.lastSubmission?.score === 100).length;
  const pct = total ? Math.round((solved / total) * 100) : 0;
  // 카드에는 설명의 첫 줄만 한 줄로(자세한 규칙·목록은 컬렉션을 열면 보인다)
  const desc = node.collection?.description.trim().split('\n')[0]?.trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-left sm:p-4 transition-colors hover:border-sky/50 hover:bg-raised"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-[12px] text-sky" aria-hidden>
          ◆
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-bold">{node.name}</span>
          {desc ? <span className="mt-0.5 line-clamp-1 text-[12px] text-dim">{desc}</span> : null}
        </span>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
        <span>문제 {total}</span>
        {node.children.length > 0 && <span>하위 {node.children.length}</span>}
        {signedIn && total > 0 && <span className={solved === total ? 'font-semibold text-ok' : ''}>✓ {solved}/{total}{solved === total && ` · ${node.name.includes('단계') ? '단계' : node.name.includes('세트') ? '세트' : '컬렉션'} 클리어`}</span>}
      </div>
      {signedIn && total > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden>
          <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
        </div>
      )}
    </button>
  );
}

const PAGE = 80;

/** 목록 끝에 닿으면 다음 묶음을 그린다(스크롤하지 못하는 환경을 위해 버튼도 둔다) */
function MoreSentinel({ onMore, remaining }: { onMore: () => void; remaining: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return (
    <button ref={ref} type="button" className="btn-ghost mt-3 w-full" onClick={onMore}>
      더 보기 ({remaining})
    </button>
  );
}
