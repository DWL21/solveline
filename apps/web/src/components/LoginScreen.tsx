import { LegalFooter } from './Legal.tsx';

const AUTH_ERRORS: Record<string, string> = {
  cancelled: 'Google 로그인을 취소했어요',
  blocked: '이용이 제한된 계정이에요',
  rate_limited: '시도가 너무 많아요. 잠시 후 다시 하세요',
  invalid_state: '로그인 시간이 지났어요. 다시 시도하세요',
  google_error: 'Google 로그인에 실패했어요. 다시 시도하세요',
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
  const error = new URLSearchParams(location.search).get('auth_error');
  return (
    <div className="relative flex min-h-full flex-col bg-ink">
      <a href="/" className="absolute top-3 left-4 text-[12px] text-faint hover:text-dim">
        ← 문제 둘러보기
      </a>
      <a href="/admin" className="absolute top-3 right-4 text-[11.5px] text-faint/60 hover:text-faint">
        관리자 모드
      </a>
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <main className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="size-8" />
            <span className="text-[20px] font-extrabold tracking-tight">Solveline</span>
          </div>
          <div className="rounded-xl border border-line bg-panel p-5 shadow-2xl shadow-black/30">
            <h1 className="text-[17px] font-bold">로그인</h1>
            <button
              type="button"
              onClick={startGoogleLogin}
              className="mt-5 flex min-h-11 w-full items-center justify-center gap-2.5 rounded-md bg-white text-[14px] font-semibold text-[#1f1f1f] hover:bg-[#f2f2f2]"
            >
              <GoogleMark /> Google로 로그인
            </button>
            <p className="mt-4 text-center text-[12.5px] text-dim">
              처음이신가요?{' '}
              <button type="button" className="font-semibold text-accent hover:underline" onClick={startGoogleLogin}>
                Google로 회원가입
              </button>
            </p>
            {error && (
              <p role="alert" className="mt-4 rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] font-semibold text-bad">
                {AUTH_ERRORS[error] ?? '로그인하지 못했어요'}
              </p>
            )}
          </div>
        </main>
      </div>
      <LegalFooter />
    </div>
  );
}
