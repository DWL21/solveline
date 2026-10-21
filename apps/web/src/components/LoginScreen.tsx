import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@codetest/shared';
import { ApiError, qk } from '../lib/api.ts';
import { KeyError, ed25519Supported, importPrivateKey, rememberedKey, signIn } from '../lib/auth.ts';

function loginMessage(e: unknown): string {
  if (e instanceof KeyError) return e.message;
  if (e instanceof ApiError) {
    if (e.unreachable) return '서버에 연결할 수 없어요';
    if (e.status === 401 || e.status === 403) return '등록된 키와 맞지 않아요';
    if (e.status === 429) return '시도가 너무 많아요. 잠시 후 다시 하세요';
    return e.message;
  }
  return '로그인하지 못했어요';
}

export function LoginScreen() {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<CryptoKey | null>(null);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void ed25519Supported().then((ok) => alive && setSupported(ok));
    void rememberedKey.load().then((k) => alive && setSaved(k));
    return () => {
      alive = false;
    };
  }, []);

  async function finish(run: () => Promise<Session>) {
    setBusy(true);
    setError(null);
    try {
      const session = await run();
      if (!session.authenticated) throw new ApiError(401, 'UNAUTHORIZED', '');
      qc.setQueryData(qk.session, session);
    } catch (e) {
      setError(loginMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일을 다시 고를 수 있게
    if (!file) return;
    if (file.size > 16 * 1024) return setError('키 파일이 아니에요 (크기가 너무 큼)');
    await finish(async () => {
      const key = await importPrivateKey(await file.text());
      const session = await signIn(key);
      if (session.authenticated && remember && (await rememberedKey.save(key))) setSaved(key);
      return session;
    });
  }

  async function forget() {
    await rememberedKey.clear();
    setSaved(null);
  }

  const blocked = supported === false || busy;

  return (
    <div className="flex min-h-full items-center justify-center bg-ink px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="font-mono text-[20px] font-bold tracking-tight">codetest</span>
        </div>
        <section className="rounded-xl border border-line bg-panel p-5 shadow-2xl shadow-black/30">
          <h1 className="text-[17px] font-bold">개인키로 로그인</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-dim">기존와 같은 Java·Python 환경입니다. 등록된 개인키가 있는 기기에서만 열려요.</p>

          {supported === false && (
            <p role="alert" className="mt-4 rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] leading-snug text-bad">
              이 브라우저는 Ed25519 서명을 지원하지 않아요. 최신 Chrome·Edge·Safari·Firefox에서 HTTPS로 여세요.
            </p>
          )}

          <div className="mt-5 flex flex-col gap-2">
            {saved && (
              <>
                <button type="button" disabled={blocked} onClick={() => void finish(() => signIn(saved))} className="btn-primary min-h-11 w-full text-[14px]">
                  {busy ? '확인 중…' : '기억한 키로 로그인'}
                </button>
                <button type="button" onClick={() => void forget()} className="btn-quiet w-full text-[12px]">
                  기억한 키 지우기
                </button>
              </>
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".key,.pem,application/x-pem-file,text/plain"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void onFile(e)}
            />
            <button
              type="button"
              disabled={blocked}
              onClick={() => fileInput.current?.click()}
              className={`${saved ? 'btn-ghost' : 'btn-primary'} min-h-11 w-full text-[14px]`}
            >
              {busy && !saved ? '확인 중…' : '키 파일 선택'}
            </button>
          </div>
          <p className="mt-3 text-[12px] leading-snug text-faint">
            <code className="font-mono text-dim">~/.codetest/access.key</code> — 키는 이 브라우저에서 서명에만 쓰고 서버로 보내지 않아요.
          </p>
          <label className="mt-3 flex min-h-9 cursor-pointer items-center gap-2 text-[13px] text-dim">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-accent" />
            이 브라우저에 기억 <span className="text-[11px] text-faint">(키 내보내기 불가)</span>
          </label>
          {error && (
            <p role="alert" className="mt-3 rounded-md border border-bad/40 bg-bad/10 p-3 text-[13px] font-semibold text-bad">
              {error}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
