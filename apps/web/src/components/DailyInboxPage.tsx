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
      <h2 className="text-body-lg font-bold">수신 설정</h2>
      <p className="mt-1 break-all text-ui text-dim">받는 주소: {settings.email}</p>
      <label className="mt-4 flex items-center gap-2 text-body">
        <input type="checkbox" checked={settings.mail} disabled={save.isPending || !settings.mailAvailable || settings.mailBlocked} onChange={(e) => change({ mail: e.target.checked })} />
        메일로도 받기
      </label>
      {!settings.mailAvailable && <p className="mt-1 text-ui text-dim">지금은 메일을 보내지 않아요. 인박스로 받을 수 있어요.</p>}
      {settings.mailBlocked && <p className="mt-1 text-ui text-warn">반송이나 스팸 신고가 있었던 주소라 메일을 보낼 수 없어요.</p>}
      <fieldset className="mt-4" disabled={save.isPending || !settings.mail}>
        <legend className="text-ui font-semibold">메일 받을 요일</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {WEEKDAYS.map(({ day, label }) => {
            const checked = settings.weekdays.includes(day);
            return (
              <label key={day} className="flex items-center gap-1 text-body">
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
      {save.isError && <p role="alert" className="mt-3 text-ui text-bad">{errMsg(save.error)}</p>}
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
      <h2 className="text-lead font-bold">평일마다 나에게 맞춘 한 문제</h2>
      <p className="mt-2 text-body text-dim">코딩 테스트 준비용 미니 문제를 평일 아침 7시에 보내 드려요. 풀이 기록을 보고 약한 유형과 알맞은 난이도로 사람마다 다르게 골라요. 구독하면 첫 문제를 바로 받아요.</p>
      {settings.mailAvailable && !settings.mailBlocked && <p className="mt-1 break-all text-ui text-dim">{settings.email}(으)로 메일도 함께 보내 드려요. 수신 설정에서 언제든 끌 수 있어요.</p>}
      <p className="mt-3 text-meta text-dim">
        구독하면 이메일과 수신 기록을 일일 문제 제공에 사용하고, 메일 발송을 Resend(미국)에 맡겨요. 자세한 내용은 <a href="/privacy" className="underline">개인정보처리방침</a>을 확인해 주세요.
      </p>
      <button type="button" className="btn-primary mt-4" disabled={subscribe.isPending} onClick={() => subscribe.mutate()}>
        {subscribe.isPending ? '구독하는 중…' : '구독하기'}
      </button>
      {subscribe.isError && <p role="alert" className="mt-3 text-ui text-bad">{errMsg(subscribe.error)}</p>}
    </section>
  );
}

const PROGRESS: Record<DailyInboxItem['progress'], { label: string; className: string } | null> = {
  none: null,
  tried: { label: '도전 중', className: 'text-warn' },
  solved: { label: '해결', className: 'text-ok' },
};

function InboxEntry({ item, open, onToggle }: Readonly<{ item: DailyInboxItem; open: boolean; onToggle: () => void }>) {
  const progress = PROGRESS[item.progress];
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className="w-full px-4 py-3 text-left hover:bg-raised">
        <span className={`block truncate text-body ${item.read ? 'text-dim' : 'font-semibold'}`}>
          {!item.read && <span className="mr-2 text-caption font-bold text-accent-text">새 문제</span>}
          {item.title}
        </span>
        <span className="mt-1 block text-meta text-dim">
          {item.date} · {item.topic} · {item.level}단계
          {progress && <span className={`ml-2 font-semibold ${progress.className}`}>{progress.label}</span>}
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-4 py-4">
          <p className="whitespace-pre-wrap text-body leading-relaxed">{item.excerpt}</p>
          <a href={`#/p/${encodeURIComponent(item.problemId)}`} className="btn-primary mt-4 inline-flex">바로 풀기</a>
          {item.hint && (
            <details className="mt-4 text-body">
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
    return subscribed ? <p className="rounded-lg border border-line bg-panel px-5 py-10 text-center text-body text-dim">다음 평일 아침 7시에 첫 문제가 도착해요.</p> : null;
  }
  return (
    <ol className="overflow-hidden rounded-lg border border-line bg-panel" aria-label="받은 문제">
      {inbox.items.map((item) => (
        <InboxEntry
          key={item.date}
          item={item}
          open={openDate === item.date}
          onToggle={() => {
            setOpenDate(openDate === item.date ? null : item.date);
            if (!item.read) markRead.mutate(item.date);
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
  if (!me) return <div className="p-6 text-body">인박스는 로그인하면 볼 수 있어요. <a className="font-semibold text-accent-text underline" href={loginHref()}>로그인</a></div>;
  const failed = settings.error ?? inbox.error;
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <h1 className="text-[18px] font-bold">인박스</h1>
        {failed && <p role="alert" className="mt-4 text-ui text-bad">{errMsg(failed)}</p>}
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
