import { Language } from '@solveline/shared';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collection, Folder, ProblemSummary } from '@solveline/shared';
import { useMe } from '../lib/me.ts';
import { ApiError, api, qk } from '../lib/api.ts';
import { ListSkeleton } from './Loading.tsx';
import type { Scope } from '../lib/route.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const byTitle = (a: ProblemSummary, b: ProblemSummary) => a.title.localeCompare(b.title, 'ko', { numeric: true });
const sameScope = (a: Scope, b: Scope) =>
  a.kind === b.kind && (a.kind === 'all' || (a.kind === 'folder' && b.kind === 'folder' && a.id === b.id) || (a.kind === 'collection' && b.kind === 'collection' && a.id === b.id));

/** 범위(전체·폴더·컬렉션)의 문제 목록을 화면과 같은 순서로. "다음 문제"도 이 순서를 따른다. */
export function scopeList(scope: Scope, all: ProblemSummary[], collections: Collection[]): ProblemSummary[] {
  if (scope.kind === 'folder') return all.filter((p) => p.folderId === scope.id).sort(byTitle);
  if (scope.kind === 'collection') {
    const col = collections.find((c) => c.id === scope.id);
    if (col) {
      const byId = new Map(all.map((p) => [p.id, p]));
      return col.problemIds.map((id) => byId.get(id)).filter((p): p is ProblemSummary => !!p);
    }
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

  // 지워진 폴더·컬렉션 주소로 들어오면 전체로 보여 준다
  const effective: Scope = (scope.kind === 'folder' && scope.id && !folder) || (scope.kind === 'collection' && !collection) ? { kind: 'all' } : scope;

  const list = scopeList(effective, all, collections.data);
  const solved = list.filter((p) => p.lastSubmission?.score === 100).length;

  const q = filter.trim().toLowerCase();
  const shown = q ? list.filter((p) => p.title.toLowerCase().includes(q)) : list;
  const unfiled = all.filter((p) => !p.folderId).length;
  const folderName = new Map(folders.data.map((f) => [f.id, f.name]));
  const title = effective.kind === 'all' ? '전체 문제' : effective.kind === 'folder' ? (folder?.name ?? '폴더 없음') : (collection?.name ?? '');

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
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
            {list.length > 0 && signedIn && (
              <span className="text-[12px] font-semibold text-ok" title="100점을 받은 문제">
                ✓ {solved}/{list.length}
              </span>
            )}
            {folder && editor && <ScopeActions kind="folder" item={folder} onDeleted={() => onScope({ kind: 'all' })} />}
            {collection && <ScopeActions kind="collection" item={collection} onDeleted={() => onScope({ kind: 'all' })} />}
          </div>
          {collection?.description && <p className="mb-1 text-[13px] whitespace-pre-wrap text-dim">{collection.description}</p>}
          <div className="mt-3 mb-4 flex flex-wrap items-center gap-2">
            <input
              className="field w-full font-sans sm:w-72"
              placeholder="제목·유형·레벨 검색 (예: Lv2, DP)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="문제 검색"
            />
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
              {q ? '검색 결과가 없어요' : effective.kind === 'collection' ? '아직 문제가 없어요. 문제 화면의 "컬렉션" 버튼으로 추가하세요.' : '이 폴더에 문제가 없어요'}
            </p>
          ) : (
            <ol className="overflow-hidden rounded-lg border border-line bg-panel">
              {shown.map((p) => (
                <li key={p.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onPick(p.id)}
                    className={`flex w-full items-center gap-3 border-l-[3px] px-4 py-3 text-left hover:bg-raised ${p.lastSubmission?.score === 100 ? 'border-ok bg-ok/[0.06]' : 'border-transparent'}`}
                  >
                    {effective.kind === 'collection' && <span className="w-6 shrink-0 text-right font-mono text-[12px] text-faint">{list.indexOf(p) + 1}</span>}
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
  const me = useMe();
  const [creating, setCreating] = useState(false);
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
              {s.group === 'folder' ? '폴더 · ' : s.group === 'collection' ? '컬렉션 · ' : ''}
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
        {me && (
        <section>
          <SectionHeader kind="collection" />
          <ul>{scopes.filter((s) => s.group === 'collection').map(item)}</ul>
        </section>
        )}
      </aside>
    </>
  );
}

/** 휴대폰: 컬렉션(누구나)·폴더(편집 권한)를 바로 만든다 */
function QuickCreate({ editor, onDone }: { editor: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'collection' | 'folder'>('collection');
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
              ['collection', '◆ 내 컬렉션'],
              ['folder', '▤ 폴더'],
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
          placeholder={kind === 'folder' ? '새 폴더 이름' : '새 컬렉션 이름'}
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
  // 폴더는 공용이라 편집 권한이 있어야 만든다. 컬렉션은 각자 만든다.
  const canAdd = kind === 'collection' || !!useMe()?.editor;
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
        <h2 className="flex-1 text-[11.5px] font-bold tracking-wide text-faint">{kind === 'collection' ? '내 컬렉션' : label}</h2>
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
