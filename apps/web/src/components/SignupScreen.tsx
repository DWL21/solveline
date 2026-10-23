import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, qk } from '../lib/api.ts';
import { BootScreen, Spinner } from './Loading.tsx';
import { LegalFooter } from './Legal.tsx';
import { startGoogleLogin } from './LoginScreen.tsx';
import { Avatar } from './Avatar.tsx';

type Agree = { age: boolean; terms: boolean; privacy: boolean };

/** 회원가입: Google 인증을 마친 새 계정이 필수 항목에 동의하면 가입된다. */
export function SignupScreen() {
  const qc = useQueryClient();
  const pending = useQuery({ queryKey: qk.signup, queryFn: api.signupPending, retry: false, refetchOnWindowFocus: true });
  const [agree, setAgree] = useState<Agree>({ age: false, terms: false, privacy: false });
  const closed = pending.error instanceof ApiError && pending.error.code === 'signup_closed';
  const all = agree.age && agree.terms && agree.privacy;

  const signup = useMutation({
    mutationFn: api.signup,
    onSuccess: (session) => {
      qc.setQueryData(qk.session, session);
      location.replace('/');
    },
  });
  const cancel = useMutation({ mutationFn: api.signupCancel, onSettled: () => location.replace('/') });

  if (pending.isPending) return <BootScreen />;

  const item = (key: keyof Agree, label: string, href?: string) => (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-raised">
      <input type="checkbox" className="size-4 accent-accent" checked={agree[key]} onChange={(e) => setAgree({ ...agree, [key]: e.target.checked })} />
      <span className="flex-1 text-[13.5px]">
        <span className="font-semibold text-accent">[필수]</span> {label}
      </span>
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="text-[12px] text-faint underline hover:text-dim" onClick={(e) => e.stopPropagation()}>
          보기
        </a>
      )}
    </label>
  );

  return (
    <div className="flex min-h-full flex-col bg-ink">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <main className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="size-8" />
            <span className="text-[20px] font-extrabold tracking-tight">Solveline</span>
          </div>
          <div className="rounded-xl border border-line bg-panel p-5 shadow-2xl shadow-black/30">
            <h1 className="text-[17px] font-bold">회원가입</h1>
            {pending.isError ? (
              <>
                <p className="mt-3 text-[13px] text-dim">
                  {pending.error instanceof ApiError ? pending.error.message : '가입 정보를 불러오지 못했어요.'}
                </p>
                <button type="button" className="btn-primary mt-4 min-h-11 w-full" onClick={closed ? () => location.assign('/') : startGoogleLogin}>
                  {closed ? '문제 둘러보기' : 'Google로 다시 시작'}
                </button>
              </>
            ) : (
              <>
                <div className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-base/60 p-3">
                  <Avatar picture={pending.data.picture} email={pending.data.email} size={36} />
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold">{pending.data.name || pending.data.email}</p>
                    <p className="truncate text-[12.5px] text-dim">{pending.data.email}</p>
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-line">
                  <label className="flex cursor-pointer items-center gap-2.5 border-b border-line px-4 py-3">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={all}
                      onChange={(e) => setAgree({ age: e.target.checked, terms: e.target.checked, privacy: e.target.checked })}
                    />
                    <span className="text-[14px] font-bold">전체 동의</span>
                  </label>
                  <div className="p-2">
                    {item('age', '만 14세 이상입니다')}
                    {item('terms', '이용약관 동의', '/terms')}
                    {item('privacy', '개인정보 수집·이용 동의', '/privacy')}
                  </div>
                </div>

                <table className="mt-3 w-full text-left text-[12px] text-dim">
                  <tbody className="[&_th]:w-20 [&_th]:py-1 [&_th]:pr-2 [&_th]:align-top [&_th]:font-semibold [&_td]:py-1">
                    <tr>
                      <th>수집 항목</th>
                      <td>Google 계정 식별자, 이메일, 이름, 프로필 사진</td>
                    </tr>
                    <tr>
                      <th>이용 목적</th>
                      <td>회원 식별·로그인, 풀이 기록 저장</td>
                    </tr>
                    <tr>
                      <th>보유 기간</th>
                      <td>탈퇴할 때까지</td>
                    </tr>
                  </tbody>
                </table>

                {signup.isError && (
                  <p role="alert" className="mt-3 text-[13px] font-semibold text-bad">
                    {signup.error instanceof ApiError ? signup.error.message : '가입하지 못했어요'}
                  </p>
                )}
                <button type="button" className="btn-primary mt-4 min-h-11 w-full text-[14px]" disabled={!all || signup.isPending || (signup.error instanceof ApiError && signup.error.code === 'signup_closed')} onClick={() => signup.mutate()}>
                  {signup.isPending ? <Spinner size={16} label="가입하는 중" /> : '동의하고 가입하기'}
                </button>
                <button type="button" className="btn-quiet mt-2 w-full" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  취소
                </button>
              </>
            )}
          </div>
        </main>
      </div>
      <LegalFooter />
    </div>
  );
}
