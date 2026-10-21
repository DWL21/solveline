import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collection, Folder, ProblemSummary } from '@codetest/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import type { Scope } from '../lib/route.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const byTitle = (a: ProblemSummary, b: ProblemSummary) => a.title.localeCompare(b.title, 'ko', { numeric: true });
const sameScope = (a: Scope, b: Scope) =>
  a.kind === b.kind && (a.kind === 'all' || (a.kind === 'folder' && b.kind === 'folder' && a.id === b.id) || (a.kind === 'collection' && b.kind === 'collection' && a.id === b.id));

/** 문제 선택 화면: 왼쪽에 전체·폴더·컬렉션, 오른쪽에 그 범위의 문제 목록. */
export function Home({ scope, onScope, onPick, onNew }: { scope: Scope; onScope: (s: Scope) => void; onPick: (id: string) => void; onNew: () => void }) {
  const problems = useQuery({ queryKey: qk.problems, queryFn: api.problems });
  const folders = useQuery({ queryKey: qk.folders, queryFn: api.folders });
  const collections = useQuery({ queryKey: qk.collections, queryFn: api.collections });
  const [filter, setFilter] = useState('');

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
  if (!problems.data || !folders.data || !collections.data) return <p className="p-6 text-[13px] text-dim">불러오는 중…</p>;

  const all = problems.data;
  const byId = new Map(all.map((p) => [p.id, p]));
  const folder = scope.kind === 'folder' && scope.id ? folders.data.find((f) => f.id === scope.id) : undefined;
  const collection = scope.kind === 'collection' ? collections.data.find((c) => c.id === scope.id) : undefined;

  // 지워진 폴더·컬렉션 주소로 들어오면 전체로 보여 준다
  const effective: Scope = (scope.kind === 'folder' && scope.id && !folder) || (scope.kind === 'collection' && !collection) ? { kind: 'all' } : scope;

  let list: ProblemSummary[];
  if (effective.kind === 'folder') list = all.filter((p) => p.folderId === effective.id).sort(byTitle);
  else if (effective.kind === 'collection' && collection) list = collection.problemIds.map((id) => byId.get(id)).filter((p): p is ProblemSummary => !!p);
  else list = [...all].sort(byTitle);

  const q = filter.trim().toLowerCase();
  const shown = q ? list.filter((p) => p.title.toLowerCase().includes(q)) : list;
  const unfiled = all.filter((p) => !p.folderId).length;
  const folderName = new Map(folders.data.map((f) => [f.id, f.name]));
  const title = effective.kind === 'all' ? '전체 문제' : effective.kind === 'folder' ? (folder?.name ?? '폴더 없음') : (collection?.name ?? '');

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <Sidebar
        scope={effective}
        onScope={onScope}
        total={all.length}
        unfiled={unfiled}
        folders={folders.data}
        folderCount={(id) => all.filter((p) => p.folderId === id).length}
        collections={collections.data}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h1 className="text-[18px] font-bold">
              {effective.kind === 'collection' && <span className="mr-1.5 text-sky">◆</span>}
              {effective.kind === 'folder' && <span className="mr-1.5 text-warn">▤</span>}
              {title} <span className="text-[14px] font-semibold text-faint">{list.length}</span>
            </h1>
            {folder && <ScopeActions kind="folder" item={folder} onDeleted={() => onScope({ kind: 'all' })} />}
            {collection && <ScopeActions kind="collection" item={collection} onDeleted={() => onScope({ kind: 'all' })} />}
          </div>
          {effective.kind === 'collection' && <p className="mb-1 text-[12.5px] text-faint">가상 묶음이에요. 문제는 원래 폴더에 그대로 있고, 여러 컬렉션에 함께 들어갈 수 있어요.</p>}
          {collection?.description && <p className="mb-1 text-[13px] whitespace-pre-wrap text-dim">{collection.description}</p>}
          <div className="mt-3 mb-4 flex flex-wrap items-center gap-2">
            <input
              className="field w-full font-sans sm:w-72"
              placeholder="제목·유형·레벨 검색 (예: Lv2, DP)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="문제 검색"
            />
            <button type="button" className="btn-primary ml-auto" onClick={onNew}>
              + 새 문제
            </button>
          </div>
          {all.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-[15px] font-bold">아직 문제가 없어요</p>
              <p className="text-[13px] text-dim">문제를 만들고 설명·테스트 케이스를 붙여 넣은 뒤 풀어 보세요.</p>
            </div>
          ) : shown.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-faint">
              {q ? '검색 결과가 없어요' : effective.kind === 'collection' ? '아직 문제가 없어요. 문제 화면의 "컬렉션" 버튼으로 추가하세요.' : '이 폴더에 문제가 없어요'}
            </p>
          ) : (
            <ol className="overflow-hidden rounded-lg border border-line bg-panel">
              {shown.map((p) => (
                <li key={p.id} className="border-b border-line last:border-b-0">
                  <button type="button" onClick={() => onPick(p.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised">
                    {effective.kind === 'collection' && <span className="w-6 shrink-0 text-right font-mono text-[12px] text-faint">{list.indexOf(p) + 1}</span>}
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{p.title}</span>
                    {effective.kind !== 'folder' && p.folderId && (
                      <span className="hidden shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-dim sm:inline">{folderName.get(p.folderId)}</span>
                    )}
                    <span className="hidden shrink-0 text-[11.5px] text-faint md:inline">{p.language === 'java' ? 'Java' : 'Python3'}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

type ScopeItem = { scope: Scope; label: string; count: number; group: 'all' | 'folder' | 'collection'; key: string };

function Sidebar({
  scope,
  onScope,
  total,
  unfiled,
  folders,
  folderCount,
  collections,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  total: number;
  unfiled: number;
  folders: Folder[];
  folderCount: (id: string) => number;
  collections: Collection[];
}) {
  const scopes: ScopeItem[] = [
    { scope: { kind: 'all' }, label: '전체', count: total, group: 'all', key: 'all' },
    ...folders.map((f): ScopeItem => ({ scope: { kind: 'folder', id: f.id }, label: f.name, count: folderCount(f.id), group: 'folder', key: 'f' + f.id })),
    ...(unfiled > 0 ? [{ scope: { kind: 'folder', id: null }, label: '폴더 없음', count: unfiled, group: 'folder', key: 'fnone' } as ScopeItem] : []),
    ...collections.map((c): ScopeItem => ({ scope: { kind: 'collection', id: c.id }, label: c.name, count: c.problemIds.length, group: 'collection', key: 'c' + c.id })),
  ];
  const current = scopes.find((s) => sameScope(s.scope, scope))?.key ?? 'all';
  const icon = (g: ScopeItem['group']) => (g === 'collection' ? '◆' : g === 'folder' ? '▤' : '☰');

  const item = (s: ScopeItem) => (
    <li key={s.key}>
      <button
        type="button"
        onClick={() => onScope(s.scope)}
        aria-current={current === s.key ? 'page' : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${current === s.key ? 'bg-raised font-semibold text-text' : 'text-dim hover:bg-raised/60 hover:text-text'}`}
      >
        <span className={`w-4 shrink-0 text-center text-[11px] ${s.group === 'collection' ? 'text-sky' : s.group === 'folder' ? 'text-warn' : 'text-faint'}`} aria-hidden>
          {icon(s.group)}
        </span>
        <span className="min-w-0 flex-1 truncate">{s.label}</span>
        <span className="text-[11.5px] text-faint">{s.count}</span>
      </button>
    </li>
  );

  return (
    <>
      {/* 모바일: 범위 선택 드롭다운 */}
      <div className="border-b border-line bg-base px-4 py-2 lg:hidden">
        <select
          aria-label="보기 범위"
          value={current}
          onChange={(e) => {
            const s = scopes.find((x) => x.key === e.target.value);
            if (s) onScope(s.scope);
          }}
          className="h-9 w-full rounded-md border border-line-strong bg-raised px-2 text-[13px] font-semibold outline-none"
        >
          {scopes.map((s) => (
            <option key={s.key} value={s.key}>
              {s.group === 'folder' ? '폴더 · ' : s.group === 'collection' ? '컬렉션 · ' : ''}
              {s.label} ({s.count})
            </option>
          ))}
        </select>
      </div>
      <aside className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-base px-3 py-4 lg:flex">
        <ul>{scopes.filter((s) => s.group === 'all').map(item)}</ul>
        <section>
          <SectionHeader kind="folder" />
          <ul>{scopes.filter((s) => s.group === 'folder').map(item)}</ul>
        </section>
        <section>
          <SectionHeader kind="collection" />
          <ul>{scopes.filter((s) => s.group === 'collection').map(item)}</ul>
          {collections.length === 0 && <p className="px-2.5 text-[12px] text-faint">문제를 옮기지 않고 세트로 묶어요</p>}
        </section>
      </aside>
    </>
  );
}

/** 섹션 제목 + 새 폴더/컬렉션 입력 */
function SectionHeader({ kind }: { kind: 'folder' | 'collection' }) {
  const qc = useQueryClient();
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
        <h2 className="flex-1 text-[11.5px] font-bold tracking-wide text-faint">{label}</h2>
        <button
          type="button"
          className="rounded px-1.5 text-[15px] leading-6 text-faint hover:bg-raised hover:text-text"
          aria-label={`새 ${label}`}
          title={`새 ${label}`}
          onClick={() => setOpen((v) => !v)}
        >
          +
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="mt-1 px-1">
          <input
            className="field font-sans"
            placeholder={`${label} 이름`}
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
