import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../lib/api.ts';
import { LegalFooter } from './Legal.tsx';

const AUTH_ERRORS: Record<string, string> = {
  cancelled: '로그인을 취소했어요',
  signup_closed: '지금은 신규 가입을 받지 않아요',
  rate_limited: '시도가 너무 많아요. 잠시 후 다시 시도해 주세요',
  invalid_state: '로그인 시간이 지났어요. 다시 시도해 주세요',
  google_error: 'Google 로그인에 실패했어요. 다시 시도해 주세요',
  auth_not_configured: 'Google 로그인이 아직 설정되지 않았어요',
};

/** Google 로그인을 시작한다. 처음인 계정은 돌아온 뒤 약관 동의 화면(/signup)으로 간다. */
export function startGoogleLogin() {
  const next = new URLSearchParams(location.search).get('next') ?? (location.hash ? `/${location.hash}` : '/');
  location.href = `/api/auth/google/start?next=${encodeURIComponent(next)}`;
}

export function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-[18px]" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function LoginScreen() {
  const config = useQuery({ queryKey: qk.publicConfig, queryFn: api.publicConfig, refetchOnWindowFocus: true });
  const error = new URLSearchParams(location.search).get('auth_error');
  const [temporaryError, setTemporaryError] = useState('');
  const [pending, setPending] = useState(false);
  const temporaryLogin = async () => {
    setPending(true);
    setTemporaryError('');
    try {
      await api.temporaryLogin();
      const next = new URLSearchParams(location.search).get('next');
      location.href = next && /^\/(?![\/\\])/.test(next) && next.length < 300 ? next : '/';
    } catch (e) {
      setTemporaryError(e instanceof Error ? e.message : '임시 계정을 만들지 못했어요');
      setPending(false);
    }
  };
  const closed = config.data?.signupEnabled === false;
  return (
    <div className="flex min-h-full flex-col bg-ink">
      <header className="flex h-13 shrink-0 items-center px-4 sm:px-5">
        <a href="/" className="flex items-center gap-2">
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="text-[16px] font-extrabold tracking-tight">Solveline</span>
        </a>
        <a href="/" className="ml-auto text-[13px] font-semibold text-dim hover:text-text">
          문제 둘러보기
        </a>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pt-6 pb-16">
        <main className="w-full max-w-[400px] rounded-xl border border-line bg-panel px-6 py-8 shadow-sm sm:px-8">
          <h1 className="text-[22px] font-bold tracking-tight">로그인</h1>
          <p className="mt-1.5 text-[14px] text-dim">로그인하면 작성한 코드와 풀이 기록이 저장돼요.</p>
          {error && (
            <p role="alert" className="mt-5 rounded-md bg-bad/8 px-3 py-2.5 text-[13px] font-semibold text-bad">
              {AUTH_ERRORS[error] ?? '로그인하지 못했어요'}
            </p>
          )}
          <button
            type="button"
            onClick={startGoogleLogin}
            className="mt-6 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-md border border-line-strong bg-white text-[15px] font-semibold text-[#1f1f1f] hover:bg-[#f6f8fa]"
          >
            <GoogleMark /> Google 계정으로 계속하기
          </button>
          <p className="mt-3 text-center text-[12.5px] text-faint">
            {closed ? '지금은 신규 가입을 받지 않아요. 기존 회원은 로그인할 수 있어요.' : '처음이면 약관 동의 후 바로 가입돼요.'}
          </p>
          <div className="my-6 flex items-center gap-3 text-[12px] text-faint" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            또는
            <span className="h-px flex-1 bg-line" />
          </div>
          <button type="button" disabled={pending || closed} onClick={temporaryLogin} className="btn-ghost min-h-12 w-full text-[15px]">
            {pending ? '시작하는 중…' : '임시 계정으로 둘러보기'}
          </button>
          <p className="mt-3 text-center text-[12.5px] text-faint">임시 계정은 로그아웃하거나 24시간이 지나면 사라져요.</p>
          {temporaryError && <p role="alert" className="mt-4 text-[13px] text-bad">{temporaryError}</p>}
        </main>
      </div>
      <LegalFooter />
    </div>
  );
}
