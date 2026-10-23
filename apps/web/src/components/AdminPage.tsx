import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUser, AdminUserDetail } from '@solveline/shared';
import { ApiError, adminApi, qk } from '../lib/api.ts';
import { formatDuration } from '../lib/time.ts';
import { useMediaQuery } from '../lib/media.ts';
import { Avatar } from './Avatar.tsx';
import { BootScreen, LinesSkeleton, ListSkeleton, Spinner } from './Loading.tsx';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');
const day = (iso: string) => new Date(iso).toLocaleDateString('ko-KR');
const time = (iso: string) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

/** 관리자 모드: 마스터 비밀번호로만 연다. 사용자에게 편집 권한을 주고, 신규 가입 허용 여부를 관리한다. */
export function AdminPage() {
  const session = useQuery({ queryKey: qk.admin, queryFn: adminApi.session, staleTime: Infinity, retry: false });
  if (session.isPending) return <BootScreen />;
  return session.data?.authenticated ? <Dashboard /> : <AdminLogin />;
}

function AdminLogin() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => adminApi.login(password),
    onSuccess: (s) => {
      setPassword('');
      qc.setQueryData(qk.admin, s);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password && !login.isPending) login.mutate();
  };
  const error = login.error instanceof ApiError ? (login.error.status === 401 ? '비밀번호가 맞지 않아요' : login.error.message) : login.isError ? '들어가지 못했어요' : null;
  return (
    <div className="flex min-h-full items-center justify-center bg-ink px-4 py-10">
      <main className="w-full max-w-sm">
        <a href="/" className="mb-6 flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-[20px] font-extrabold tracking-tight">Solveline</span>
        </a>
        <form onSubmit={submit} className="rounded-xl border border-line bg-panel p-5 shadow-2xl shadow-black/30">
          <h1 className="text-[17px] font-bold">관리자 모드</h1>
          <input type="text" name="username" autoComplete="username" value="solveline-admin" readOnly hidden />
          <label className="mt-5 flex flex-col gap-1.5">
            <span className="text-[12px] font-bold text-dim">비밀번호</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field py-2.5 text-[14px]"
              autoFocus
              required
            />
          </label>
          <button type="submit" disabled={login.isPending || !password} className="btn-primary mt-4 min-h-11 w-full text-[14px]">
            {login.isPending ? <Spinner size={16} label="확인하는 중" /> : '들어가기'}
          </button>
          {error && (
            <p role="alert" className="mt-3 rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] font-semibold text-bad">
              {error}
            </p>
          )}
        </form>
      </main>
    </div>
  );
}

function Dashboard() {
  const wide = useMediaQuery('(min-width: 1024px)');
  const qc = useQueryClient();
  const [tab, setTab] = useState<'users' | 'signup'>('users');
  const [selected, setSelected] = useState<string | null>(null);
  const logout = useMutation({
    mutationFn: adminApi.logout,
    // 나가면 관리자 쿠키를 지우고 초기 화면으로
    onSettled: () => {
      qc.removeQueries({ queryKey: qk.admin });
      location.replace('/');
    },
  });
  return (
    <div className="flex min-h-full flex-col bg-ink">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-line bg-[#0f1922] px-4 sm:h-12 sm:flex-nowrap">
        <a href="/" className="flex items-center gap-2">
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="text-[15px] font-extrabold tracking-tight">Solveline</span>
        </a>
        <span className="shrink-0 whitespace-nowrap rounded bg-warn/15 px-2 py-0.5 text-[11.5px] font-bold text-warn">관리자 모드</span>
        <nav className="order-last flex h-10 w-full gap-1 sm:order-none sm:ml-4 sm:h-full sm:w-auto">
          {(
            [
              ['users', '사용자'],
              ['signup', '신규 가입'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`h-full whitespace-nowrap border-b-2 px-3 text-[13px] font-semibold ${tab === t ? 'border-accent text-text' : 'border-transparent text-dim hover:text-text'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <button type="button" className="btn-quiet ml-auto px-2 text-[12px]" onClick={() => logout.mutate()}>
          나가기
        </button>
      </header>
      <main className="pb-safe mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {tab === 'users' ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {/* 좁은 화면: 목록과 상세를 번갈아 보여 준다 */}
            <div className={`min-w-0 ${selected && !wide ? 'hidden' : ''}`}>
              <UserList selected={selected} onSelect={setSelected} />
            </div>
            {selected ? (
              <div className="min-w-0">
                {!wide && (
                  <button type="button" className="btn-quiet touch-target mb-2 px-1 text-[13px]" onClick={() => setSelected(null)}>
                    ← 사용자 목록
                  </button>
                )}
                <UserDetail id={selected} onDeleted={() => setSelected(null)} />
              </div>
            ) : (
              <p className="hidden py-16 text-center text-[13px] text-faint lg:block">사용자를 고르세요</p>
            )}
          </div>
        ) : (
          <SignupControl />
        )}
      </main>
    </div>
  );
}

function UserList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const users = useQuery({ queryKey: qk.adminUsers, queryFn: adminApi.users });
  const [filter, setFilter] = useState('');
  if (users.isPending) return <ListSkeleton />;
  if (users.isError) return <p className="text-[13px] text-bad">{errMsg(users.error)}</p>;
  const q = filter.trim().toLowerCase();
  const list = users.data.filter((u) => !q || u.email.includes(q) || u.name.toLowerCase().includes(q));
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-[16px] font-bold">
          사용자 <span className="text-faint">{users.data.length}</span>
        </h1>
        <input className="field ml-auto w-56 font-sans" placeholder="이메일·이름 검색" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="사용자 검색" />
      </div>
      <ol className="overflow-hidden rounded-lg border border-line bg-panel">
        {list.map((u) => (
          <li key={u.id} className="border-b border-line last:border-0">
            <button
              type="button"
              onClick={() => onSelect(u.id)}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-raised ${selected === u.id ? 'bg-raised' : ''}`}
            >
              <Avatar picture={u.picture} email={u.email} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{u.name || u.email}</span>
                <span className="block truncate text-[12px] text-dim">{u.email}</span>
              </span>
              <Badges user={u} />
              <span className="w-16 shrink-0 text-right text-[12px] text-dim" title="맞힌 문제 / 제출">
                <span className="text-ok">✓ {u.solved}</span> · {u.submissions}
              </span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="p-6 text-center text-[13px] text-faint">사용자가 없어요</li>}
      </ol>
    </section>
  );
}

function Badges({ user }: { user: AdminUser }) {
  return (
    <span className="flex shrink-0 gap-1">
      {user.editor && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-bold text-accent">편집</span>}
    </span>
  );
}

function UserDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: qk.adminUser(id), queryFn: () => adminApi.user(id) });
  const done = (u: AdminUserDetail) => {
    qc.setQueryData(qk.adminUser(id), u);
    void qc.invalidateQueries({ queryKey: qk.adminUsers });
  };
  const role = useMutation({ mutationFn: (editor: boolean) => adminApi.setEditor(id, editor), onSuccess: done, onError: (e) => alert(errMsg(e)) });
  const remove = useMutation({
    mutationFn: () => adminApi.deleteUser(id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.adminUser(id) });
      void qc.invalidateQueries({ queryKey: qk.adminUsers });
      onDeleted();
    },
    onError: (e) => alert(errMsg(e)),
  });

  if (d.isPending)
    return (
      <section className="rounded-lg border border-line bg-panel p-4">
        <LinesSkeleton />
      </section>
    );
  if (d.isError) return <p className="text-[13px] text-bad">{errMsg(d.error)}</p>;
  const u = d.data;
  const busy = role.isPending || remove.isPending;
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="flex items-center gap-3">
        <Avatar picture={u.picture} email={u.email} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold">{u.name || u.email}</p>
          <p className="truncate text-[12.5px] text-dim">{u.email}</p>
        </div>
        <Badges user={u} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
        {(
          [
            ['가입', day(u.createdAt)],
            ['최근 로그인', time(u.lastLoginAt)],
            ['맞힌 문제', `${u.solved}`],
            ['제출', `${u.submissions}`],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-faint">{k}</dt>
            <dd className="font-semibold whitespace-nowrap">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11.5px] text-faint">
        약관 {u.termsVersion} · 개인정보 {u.privacyVersion} 동의 <span className="whitespace-nowrap">({time(u.agreedAt)})</span>
      </p>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        <button type="button" className={u.editor ? 'btn-ghost' : 'btn-primary'} disabled={busy} onClick={() => role.mutate(!u.editor)}>
          {u.editor ? '편집 권한 회수' : '편집 권한 주기'}
        </button>
        <button
          type="button"
          className="btn-quiet ml-auto text-[12px] text-faint hover:text-bad"
          disabled={busy}
          onClick={() => confirm(`${u.email} 사용자를 삭제할까요? 작성 코드·메모·제출 기록이 모두 지워지고 되돌릴 수 없어요.`) && remove.mutate()}
        >
          사용자 삭제
        </button>
      </div>

      <h2 className="mt-5 mb-2 text-[13px] font-bold">풀이 현황 {u.problems.length}</h2>
      {u.problems.length === 0 ? (
        <p className="text-[12.5px] text-faint">아직 연 문제가 없어요</p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-md border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-base text-left text-dim">
              <tr>
                <th className="px-2 py-1.5 font-semibold">문제</th>
                <th className="w-14 px-2 py-1.5 text-right font-semibold">점수</th>
                <th className="w-20 px-2 py-1.5 text-right font-semibold">풀이 시간</th>
              </tr>
            </thead>
            <tbody>
              {u.problems.map((p) => (
                <tr key={p.problemId} className="border-t border-line">
                  <td className="truncate px-2 py-1.5">{p.title}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${p.score === 100 ? 'text-ok' : p.score === null ? 'text-faint' : 'text-warn'}`}>
                    {p.score === 100 ? '✓' : (p.score ?? '—')}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-dim">{formatDuration(p.solvedMs ?? p.elapsedMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-5 mb-2 text-[13px] font-bold">최근 제출</h2>
      {u.recentSubmissions.length === 0 ? (
        <p className="text-[12.5px] text-faint">제출 기록이 없어요</p>
      ) : (
        <ul className="max-h-60 overflow-y-auto rounded-md border border-line text-[12.5px]">
          {u.recentSubmissions.map((s) => (
            <li key={s.id} className="border-b border-line px-2.5 py-2 last:border-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{s.problemTitle ?? '(스크립트 실행)'}</span>
                <span className={`shrink-0 font-semibold ${s.score === 100 ? 'text-ok' : 'text-dim'}`}>
                  {s.kind === 'submit' && s.score !== null ? (s.score === 100 ? '✓' : `${s.score}점`) : ''}
                </span>
              </div>
              <p className="mt-0.5 text-[11.5px] whitespace-nowrap text-faint tabular-nums">
                {time(s.createdAt)} · {s.kind === 'submit' ? '제출' : '실행'} · {s.language === 'java' ? 'Java' : 'Python'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SignupControl() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: qk.signupSettings, queryFn: adminApi.signupSettings, refetchOnWindowFocus: true });
  const save = useMutation({
    mutationFn: adminApi.setSignupEnabled,
    onSuccess: (data) => {
      qc.setQueryData(qk.signupSettings, data);
      void qc.invalidateQueries({ queryKey: qk.publicConfig });
    },
  });
  if (settings.isPending) return <LinesSkeleton />;
  if (settings.isError) return <p role="alert" className="text-[13px] text-bad">{errMsg(settings.error)}</p>;
  const enabled = settings.data.signupEnabled;
  return (
    <section className="max-w-xl rounded-lg border border-line bg-panel p-5">
      <h1 className="text-[16px] font-bold">신규 가입</h1>
      <p role="status" className={`mt-4 font-semibold ${enabled ? 'text-ok' : 'text-warn'}`}>
        {enabled ? '✓ 신규 가입 허용 중' : '✗ 신규 가입 중지 중'}
      </p>
      <p className="mt-2 text-[13px] text-dim">중지하면 새 계정을 만들 수 없어요. 가입 절차를 진행 중인 계정에도 적용돼요. 기존 회원은 계속 로그인하고 이용할 수 있어요.</p>
      <button
        type="button"
        className="btn-primary mt-5"
        disabled={save.isPending}
        onClick={() => save.mutate(!enabled)}
      >
        {save.isPending ? '저장 중…' : enabled ? '신규 가입 중지' : '신규 가입 허용'}
      </button>
      {save.isError && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(save.error)}</p>}
      {save.isSuccess && <p role="status" className="mt-3 text-[13px] text-dim">설정을 저장했어요.</p>}
    </section>
  );
}
