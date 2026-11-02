import { useState, type ReactNode, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DailyAdminOverview, DailyIssue, DailyIssueInput, DailySubscriber } from '@solveline/shared';
import { ApiError, adminApi, qk } from '../lib/api.ts';
import { LinesSkeleton } from './Loading.tsx';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : '요청을 처리하지 못했어요');

const STATUS_LABEL: Record<DailySubscriber['status'], string> = {
  pending: '인증 대기',
  active: '구독 중',
  unsubscribed: '수신거부',
  bounced: '반송',
  complained: '스팸 신고',
};

const STATUS_COLOR: Record<DailySubscriber['status'], string> = {
  pending: 'text-warn',
  active: 'text-ok',
  unsubscribed: 'text-faint',
  bounced: 'text-bad',
  complained: 'text-bad',
};

type Draft = DailyIssueInput & { issueDate: string };

const emptyDraft = (today: string): Draft => ({ issueDate: today, problemId: '', title: '', body: '', difficulty: '쉬움', minutes: 15, note: '', status: 'draft' });

const toDraft = (i: DailyIssue): Draft => ({ issueDate: i.issueDate, problemId: i.problemId, title: i.title, body: i.body, difficulty: i.difficulty, minutes: i.minutes, note: i.note, status: i.status });

/** 관리자 모드의 일일 메일 탭: 발송 상태, 회차 작성·시험 발송, 구독자 관리 */
export function DailyMailPanel() {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: qk.adminDaily, queryFn: adminApi.daily, refetchOnWindowFocus: true });
  const apply = (data: DailyAdminOverview) => qc.setQueryData(qk.adminDaily, data);
  const pause = useMutation({ mutationFn: adminApi.setDailyPaused, onSuccess: apply });
  if (overview.isPending) return <LinesSkeleton />;
  if (overview.isError) return <p role="alert" className="text-[13px] text-bad">{errMsg(overview.error)}</p>;
  const data = overview.data;
  const active = data.subscribers.filter((s) => s.status === 'active').length;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className="rounded-lg border border-line bg-panel p-5">
          <h1 className="text-[16px] font-bold">일일 메일</h1>
          <output className={`mt-3 block font-semibold ${data.configured && !data.paused ? 'text-ok' : 'text-warn'}`}>
            {!data.configured && '✗ 발송 설정이 없어 구독과 발송이 꺼져 있어요'}
            {data.configured && (data.paused ? '✗ 발송을 멈춘 상태예요' : '✓ 평일 07시에 발송해요')}
          </output>
          <p className="mt-2 text-[13px] text-dim">
            구독 중 {active}명 / 상한 {data.maxSubscribers}명
          </p>
          <button type="button" className="btn-primary mt-4" disabled={pause.isPending} onClick={() => pause.mutate(!data.paused)}>
            {data.paused ? '발송 다시 시작하기' : '발송 멈추기'}
          </button>
          {pause.isError && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(pause.error)}</p>}
        </section>
        <IssueEditor key={data.today} data={data} onSaved={apply} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <SubscriberList subscribers={data.subscribers} onChanged={apply} />
      </div>
    </div>
  );
}

function IssueEditor({ data, onSaved }: Readonly<{ data: DailyAdminOverview; onSaved: (d: DailyAdminOverview) => void }>) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => {
    const today = data.issues.find((i) => i.issueDate === data.today);
    return today ? toDraft(today) : emptyDraft(data.today);
  });
  const [testEmails, setTestEmails] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const refresh = () => qc.invalidateQueries({ queryKey: qk.adminDaily });
  const save = useMutation({
    mutationFn: () => {
      const { issueDate, ...input } = draft;
      return adminApi.saveDailyIssue(issueDate, input);
    },
    onSuccess: onSaved,
  });
  const remove = useMutation({
    mutationFn: () => adminApi.deleteDailyIssue(draft.issueDate),
    onSuccess: (d) => {
      onSaved(d);
      setDraft(emptyDraft(d.today));
    },
  });
  const test = useMutation({
    mutationFn: () => adminApi.testDailyIssue(draft.issueDate, testEmails.split(/[\s,]+/).filter(Boolean)),
  });
  const send = useMutation({ mutationFn: () => adminApi.sendDailyIssue(draft.issueDate), onSettled: refresh });
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  const saved = data.issues.find((i) => i.issueDate === draft.issueDate);
  const action = save.error ?? remove.error ?? test.error ?? send.error;
  return (
    <>
      <form onSubmit={submit} className="rounded-lg border border-line bg-panel p-5">
        <h2 className="text-[15px] font-bold">회차 작성</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="발송일(한국 시간)">
            <input type="date" className="field" value={draft.issueDate} onChange={(e) => set('issueDate', e.target.value)} required />
          </Field>
          <Field label="문제 ID">
            <input className="field" value={draft.problemId} onChange={(e) => set('problemId', e.target.value)} required pattern="[\w-]+" />
          </Field>
        </div>
        <Field label="제목" className="mt-3">
          <input className="field font-sans" value={draft.title} onChange={(e) => set('title', e.target.value)} required maxLength={120} />
        </Field>
        <Field label="지문" className="mt-3">
          <textarea className="field min-h-36 font-sans" value={draft.body} onChange={(e) => set('body', e.target.value)} required maxLength={5000} />
        </Field>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="난이도">
            <input className="field font-sans" value={draft.difficulty} onChange={(e) => set('difficulty', e.target.value)} required maxLength={20} />
          </Field>
          <Field label="예상 시간(분)">
            <input type="number" className="field" min={1} max={120} value={draft.minutes} onChange={(e) => set('minutes', Number(e.target.value))} required />
          </Field>
          <Field label="상태">
            <select className="field font-sans" value={draft.status} onChange={(e) => set('status', e.target.value as Draft['status'])}>
              <option value="draft">작성 중(발송 안 함)</option>
              <option value="ready">발송 준비 완료</option>
            </select>
          </Field>
        </div>
        <Field label="어제 문제 핵심(선택)" className="mt-3">
          <textarea className="field min-h-20 font-sans" value={draft.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} />
        </Field>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={save.isPending}>
            {save.isPending ? '저장 중…' : '저장하기'}
          </button>
          <button type="button" className="btn-quiet px-3 text-[13px]" onClick={() => setDraft(emptyDraft(data.today))}>
            새 회차
          </button>
          {saved && (
            <button type="button" className="btn-quiet px-3 text-[13px] text-bad" disabled={remove.isPending} onClick={() => remove.mutate()}>
              회차 지우기
            </button>
          )}
        </div>
        {save.isSuccess && <output className="mt-3 block text-[13px] text-dim">회차를 저장했어요.</output>}
      </form>

      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="text-[15px] font-bold">발송</h2>
        <p className="mt-1 text-[13px] text-dim">저장한 회차를 기준으로 보내요. 시험 발송은 입력한 주소로만 가요.</p>
        <Field label="시험 받을 주소(최대 5개, 쉼표로 구분)" className="mt-3">
          <input className="field" value={testEmails} onChange={(e) => setTestEmails(e.target.value)} autoComplete="off" />
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-quiet border border-line px-3 text-[13px]" disabled={!saved || !testEmails.trim() || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? '보내는 중…' : '시험 발송'}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saved?.status !== 'ready' || send.isPending}
            onClick={() => {
              if (window.confirm(`${draft.issueDate} 회차를 구독자에게 지금 보낼까요?`)) send.mutate();
            }}
          >
            {send.isPending ? '보내는 중…' : '구독자에게 지금 보내기'}
          </button>
        </div>
        {test.isSuccess && <output className="mt-3 block text-[13px] text-dim">시험 메일 {test.data.sent}통을 보냈어요.</output>}
        {send.isSuccess && (
          <output className="mt-3 block text-[13px] text-dim">
            {send.data.outcome === 'paused' && '발송을 멈춘 상태라 보내지 않았어요.'}
            {send.data.outcome !== 'paused' && `보냄 ${send.data.sent}통, 실패 ${send.data.failed}통, 남음 ${send.data.remaining}통`}
          </output>
        )}
        {action && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(action)}</p>}

        <h3 className="mt-5 text-[13px] font-bold text-dim">회차별 현황</h3>
        {data.issues.length === 0 && <p className="mt-2 text-[13px] text-faint">아직 회차가 없어요.</p>}
        <ol className="mt-2 divide-y divide-line">
          {data.issues.map((i) => (
            <li key={i.issueDate}>
              <button type="button" className="w-full py-2 text-left text-[13px] hover:text-text" onClick={() => setDraft(toDraft(i))}>
                <span className="font-semibold">{i.issueDate}</span> {i.title}
                <span className="block text-[12px] text-faint">
                  {i.status === 'ready' ? '준비 완료' : '작성 중'} · 보냄 {i.delivery.sent} · 대기 {i.delivery.pending} · 실패 {i.delivery.failed} · 제외 {i.delivery.skipped}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function SubscriberList({ subscribers, onChanged }: Readonly<{ subscribers: DailySubscriber[]; onChanged: (d: DailyAdminOverview) => void }>) {
  const remove = useMutation({ mutationFn: adminApi.deleteDailySubscriber, onSuccess: onChanged });
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">
        구독자 <span className="text-faint">{subscribers.length}</span>
      </h2>
      {subscribers.length === 0 && <p className="mt-3 text-[13px] text-faint">아직 구독자가 없어요.</p>}
      {remove.isError && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(remove.error)}</p>}
      <ol className="mt-2 divide-y divide-line">
        {subscribers.map((s) => (
          <li key={s.id} className="flex items-center gap-2 py-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{s.email}</span>
            <span className={`shrink-0 text-[12px] font-semibold ${STATUS_COLOR[s.status]}`}>{STATUS_LABEL[s.status]}</span>
            <button
              type="button"
              className="btn-quiet shrink-0 px-2 text-[12px]"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`${s.email} 구독자 정보를 완전히 지울까요?`)) remove.mutate(s.id);
              }}
            >
              지우기
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Field({ label, className = '', children }: Readonly<{ label: string; className?: string; children: ReactNode }>) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-[12px] font-bold text-dim">{label}</span>
      {children}
    </label>
  );
}
