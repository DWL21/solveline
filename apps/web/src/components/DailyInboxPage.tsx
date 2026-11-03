import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DailyInbox, DailyInboxItem, DailySettings, DailySettingsInput } from '@solveline/shared';
import { ApiError, api, qk } from '../lib/api.ts';
import { loginHref, useMe } from '../lib/me.ts';
import { LinesSkeleton } from './Loading.tsx';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');

const WEEKDAYS = [
  { day: 1, label: '월' },
  { day: 2, label: '화' },
  { day: 3, label: '수' },
  { day: 4, label: '목' },
  { day: 5, label: '금' },
];

/** 수신 설정: 바꾸는 즉시 저장한다. 받는 주소는 로그인 계정의 이메일이라 보여 주기만 한다 */
function SettingsPanel({ settings }: Readonly<{ settings: DailySettings }>) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: api.saveDailySettings,
    onSuccess: (data) => qc.setQueryData(qk.dailySettings, data),
    onError: () => void qc.invalidateQueries({ queryKey: qk.dailySettings }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.dailyInbox }),
  });
  const change = (patch: Partial<DailySettingsInput>) =>
    save.mutate({ subscribed: settings.subscribed, mail: settings.mail, weekdays: settings.weekdays, ...patch });
  const toggleDay = (day: number) =>
    change({ weekdays: settings.weekdays.includes(day) ? settings.weekdays.filter((d) => d !== day) : [...settings.weekdays, day].sort((a, b) => a - b) });

  return (
    <section className="rounded-lg border border-line bg-panel p-5" aria-label="수신 설정">
      <h2 className="text-[15px] font-bold">수신 설정</h2>
      <p className="mt-1 break-all text-[13px] text-dim">받는 주소: {settings.email}</p>
      <label className="mt-4 flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={settings.mail} disabled={save.isPending || !settings.mailAvailable || settings.mailBlocked} onChange={(e) => change({ mail: e.target.checked })} />
        메일로도 받기
      </label>
      {!settings.mailAvailable && <p className="mt-1 text-[13px] text-dim">지금은 메일을 보내지 않아요. 인박스로 받을 수 있어요.</p>}
      {settings.mailBlocked && <p className="mt-1 text-[13px] text-warn">반송이나 스팸 신고가 있었던 주소라 메일을 보낼 수 없어요.</p>}
      <fieldset className="mt-4" disabled={save.isPending || !settings.mail}>
        <legend className="text-[13px] font-semibold">메일 받을 요일</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {WEEKDAYS.map(({ day, label }) => {
            const checked = settings.weekdays.includes(day);
            return (
              <label key={day} className="flex items-center gap-1 text-[14px]">
                <input type="checkbox" checked={checked} disabled={checked && settings.weekdays.length === 1} onChange={() => toggleDay(day)} />
                {label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <button type="button" className="btn-ghost mt-5" disabled={save.isPending} onClick={() => change({ subscribed: false, mail: false })}>
        구독 그만두기
      </button>
      {save.isError && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(save.error)}</p>}
    </section>
  );
}

function SubscribeCard({ settings }: Readonly<{ settings: DailySettings }>) {
  const qc = useQueryClient();
  const subscribe = useMutation({
    mutationFn: () => api.saveDailySettings({ subscribed: true, mail: settings.mailAvailable && !settings.mailBlocked, weekdays: settings.weekdays }),
    onSuccess: (data) => qc.setQueryData(qk.dailySettings, data),
    onError: () => void qc.invalidateQueries({ queryKey: qk.dailySettings }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.dailyInbox }),
  });
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-[16px] font-bold">평일마다 한 문제, 인박스로 받아 보세요</h2>
      <p className="mt-2 text-[14px] text-dim">코딩 테스트 준비에 맞춘 새 문제를 평일 아침 7시에 보내 드려요.</p>
      {settings.mailAvailable && !settings.mailBlocked && <p className="mt-1 break-all text-[13px] text-dim">{settings.email}(으)로 메일도 함께 보내 드려요. 수신 설정에서 언제든 끌 수 있어요.</p>}
      <p className="mt-3 text-[12.5px] text-dim">
        구독하면 이메일과 수신 기록을 일일 문제 제공에 사용하고, 메일 발송을 Resend(미국)에 맡겨요. 자세한 내용은 <a href="/privacy" className="underline">개인정보처리방침</a>을 확인해 주세요.
      </p>
      <button type="button" className="btn-primary mt-4" disabled={subscribe.isPending} onClick={() => subscribe.mutate()}>
        {subscribe.isPending ? '구독하는 중…' : '구독하기'}
      </button>
      {subscribe.isError && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(subscribe.error)}</p>}
    </section>
  );
}

function InboxEntry({ item, open, onToggle }: Readonly<{ item: DailyInboxItem; open: boolean; onToggle: () => void }>) {
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className="w-full px-4 py-3 text-left hover:bg-raised">
        <span className={`block truncate text-[14px] ${item.read ? 'text-dim' : 'font-semibold'}`}>
          {!item.read && <span className="mr-2 text-[12px] font-bold text-accent-text">새 문제</span>}
          {item.title}
        </span>
        <span className="mt-1 block text-[12.5px] text-dim">{item.issueDate} · {item.difficulty}</span>
      </button>
      {open && (
        <div className="border-t border-line px-4 py-4">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{item.body}</p>
          <a href={`#/p/${encodeURIComponent(item.problemId)}`} className="btn-primary mt-4 inline-flex">바로 풀기</a>
          {item.hint && (
            <details className="mt-4 text-[14px]">
              <summary className="cursor-pointer font-semibold">힌트 확인</summary>
              <p className="mt-2 whitespace-pre-wrap leading-relaxed text-dim">{item.hint}</p>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

function InboxList({ inbox, subscribed }: Readonly<{ inbox: DailyInbox; subscribed: boolean }>) {
  const qc = useQueryClient();
  const [openDate, setOpenDate] = useState<string | null>(null);
  const markRead = useMutation({ mutationFn: api.markDailyRead, onSuccess: (data) => qc.setQueryData(qk.dailyInbox, data) });
  if (inbox.items.length === 0) {
    return subscribed ? <p className="rounded-lg border border-line bg-panel px-5 py-10 text-center text-[14px] text-dim">다음 평일 아침 7시에 첫 문제가 도착해요.</p> : null;
  }
  return (
    <ol className="overflow-hidden rounded-lg border border-line bg-panel" aria-label="받은 문제">
      {inbox.items.map((item) => (
        <InboxEntry
          key={item.issueDate}
          item={item}
          open={openDate === item.issueDate}
          onToggle={() => {
            setOpenDate(openDate === item.issueDate ? null : item.issueDate);
            if (!item.read) markRead.mutate(item.issueDate);
          }}
        />
      ))}
    </ol>
  );
}

/** 일일 문제 인박스: 받은 문제 목록과 수신 설정 */
export function DailyInboxPage() {
  const me = useMe();
  const settings = useQuery({ queryKey: qk.dailySettings, queryFn: api.dailySettings, enabled: !!me });
  const inbox = useQuery({ queryKey: qk.dailyInbox, queryFn: api.dailyInbox, enabled: !!me });
  if (!me) return <div className="p-6 text-[14px]">인박스는 로그인하면 볼 수 있어요. <a className="font-semibold text-accent-text underline" href={loginHref()}>로그인</a></div>;
  const failed = settings.error ?? inbox.error;
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <h1 className="text-[18px] font-bold">인박스</h1>
        {failed && <p role="alert" className="mt-4 text-[13px] text-bad">{errMsg(failed)}</p>}
        {!failed && (!settings.data || !inbox.data) && <div className="mt-4"><LinesSkeleton lines={5} /></div>}
        {!failed && settings.data && inbox.data && (
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="flex min-w-0 flex-col gap-4">
              {!settings.data.subscribed && <SubscribeCard settings={settings.data} />}
              <InboxList inbox={inbox.data} subscribed={settings.data.subscribed} />
            </div>
            {settings.data.subscribed && <SettingsPanel settings={settings.data} />}
          </div>
        )}
      </div>
    </main>
  );
}
