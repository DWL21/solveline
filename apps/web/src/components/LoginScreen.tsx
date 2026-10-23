import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api, qk } from '../lib/api.ts';

function loginMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.unreachable) return '서버에 연결할 수 없어요';
    if (e.status === 401) return '비밀번호가 맞지 않아요';
    if (e.status === 429) return '시도가 너무 많아요. 잠시 후 다시 하세요';
    return e.message;
  }
  return '로그인하지 못했어요';
}

export function LoginScreen() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(password);
      if (!session.authenticated) throw new ApiError(401, 'UNAUTHORIZED', '');
      setPassword('');
      qc.setQueryData(qk.session, session);
    } catch (err) {
      setError(loginMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-ink px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-[20px] font-extrabold tracking-tight">Solveline</span>
        </div>
        <form onSubmit={(e) => void submit(e)} className="rounded-xl border border-line bg-panel p-5 shadow-2xl shadow-black/30">
          <h1 className="text-[17px] font-bold">로그인</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-dim">기존와 같은 Java·Python 환경입니다. 비밀번호를 아는 사람만 열 수 있어요.</p>
          {/* 비밀번호 관리자가 이 사이트의 항목으로 저장·자동 입력하도록 사용자 이름 칸을 숨겨 둔다 */}
          <input type="text" name="username" autoComplete="username" value="solveline" readOnly hidden />
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
          <button type="submit" disabled={busy || !password} className="btn-primary mt-4 min-h-11 w-full text-[14px]">
            {busy ? '확인 중…' : '로그인'}
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
