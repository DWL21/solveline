import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DAILY_TOPICS, type DailyAdminOverview, type DailyProblemInput, type DailyProblemStatus, type DailySaveResult, type DailySubscriber } from '@solveline/shared';
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

const PROBLEM_STATUS: Record<DailyProblemStatus, string> = { ready: '발송 중', draft: '작성 중', retired: '그만 보냄' };

/** 새 문제 입력 예시. 에이전트(MCP create_problem)와 같은 형식이다 */
const TEMPLATE: DailyProblemInput = {
  topic: '해시',
  level: 1,
  title: '두 번째로 먼저 나온 수',
  description:
    '정수 배열 `numbers`를 앞에서부터 볼 때, 두 번째로 나타나는 순간이 가장 빠른 수를 반환한다. 그런 수가 없으면 -1을 반환한다.\n\n제한\n- 1 ≤ numbers의 길이 ≤ 100,000\n- -10^9 ≤ numbers[i] ≤ 10^9',
  mode: 'function',
  params: ['numbers'],
  timeLimitMs: 2000,
  cases: [
    { id: 'e1', args: ['[3, 1, 3, 1]'], stdin: '', expected: '3', hidden: false },
    { id: 'h1', args: ['[1, 2, 3]'], stdin: '', expected: '-1', hidden: true },
    { id: 'h2', args: ['[5, 5]'], stdin: '', expected: '5', hidden: true },
    { id: 'h3', args: ['[2, 1, 1, 2]'], stdin: '', expected: '1', hidden: true },
  ],
  starterCode: { java: 'class Solution {\n    public int solution(int[] numbers) {\n        return 0;\n    }\n}\n', python: 'def solution(numbers):\n    return 0\n' },
  referenceSolution: { language: 'python', code: 'def solution(numbers):\n    seen = set()\n    for n in numbers:\n        if n in seen:\n            return n\n        seen.add(n)\n    return -1\n' },
  hint: '지금까지 본 수를 빠르게 찾을 수 있는 자료구조를 떠올려 보세요.',
  status: 'ready',
};

/** 관리자 모드의 일일 메일 탭: 발송 상태, 문제은행(직접 추가·상태 관리), 구독자 관리 */
export function DailyMailPanel() {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: qk.adminDaily, queryFn: adminApi.daily, refetchOnWindowFocus: true });
  const apply = (data: DailyAdminOverview) => {
    qc.setQueryData(qk.adminDaily, data);
    void qc.invalidateQueries({ queryKey: qk.adminDailyProblems });
  };
  const pause = useMutation({ mutationFn: adminApi.setDailyPaused, onSuccess: apply });
  const send = useMutation({ mutationFn: adminApi.sendDaily, onSettled: () => void qc.invalidateQueries({ queryKey: qk.adminDaily }) });
  if (overview.isPending) return <LinesSkeleton />;
  if (overview.isError) return <p role="alert" className="text-[13px] text-bad">{errMsg(overview.error)}</p>;
  const data = overview.data;
  const active = data.subscribers.filter((s) => s.status === 'active').length;
  const ready = data.bank.reduce((n, c) => n + c.ready, 0);
  const action = pause.error ?? send.error;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className="rounded-lg border border-line bg-panel p-5">
          <h1 className="text-[16px] font-bold">일일 메일</h1>
          <output className={`mt-3 block font-semibold ${data.configured && !data.paused && ready ? 'text-ok' : 'text-warn'}`}>
            {!data.configured && '✗ 발송 설정이 없어 구독과 발송이 꺼져 있어요'}
            {data.configured && data.paused && '✗ 발송을 멈춘 상태예요'}
            {data.configured && !data.paused && (ready ? '✓ 평일 07시에 사람마다 다른 문제를 보내요' : '✗ 발송할 문제가 없어요')}
          </output>
          <p className="mt-2 text-[13px] text-dim">
            구독 중 {active}명 / 상한 {data.maxSubscribers}명 · 오늘({data.today}) 보냄 {data.delivery.sent} · 대기 {data.delivery.pending} · 실패 {data.delivery.failed} · 제외 {data.delivery.skipped}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={pause.isPending} onClick={() => pause.mutate(!data.paused)}>
              {data.paused ? '발송 다시 시작하기' : '발송 멈추기'}
            </button>
            <button
              type="button"
              className="btn-quiet border border-line px-3 text-[13px]"
              disabled={send.isPending || !data.configured}
              onClick={() => {
                if (window.confirm('오늘 문제를 구독자에게 지금 한 묶음 보낼까요?')) send.mutate();
              }}
            >
              {send.isPending ? '보내는 중…' : '오늘 문제 지금 보내기'}
            </button>
          </div>
          {send.isSuccess && (
            <output className="mt-3 block text-[13px] text-dim">
              {send.data.outcome === 'paused' ? '발송을 멈춘 상태라 보내지 않았어요.' : `보냄 ${send.data.sent}통, 실패 ${send.data.failed}통, 남음 ${send.data.remaining}통`}
            </output>
          )}
          {action && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(action)}</p>}
        </section>
        <BankGrid data={data} />
        <ProblemEditor onSaved={() => void qc.invalidateQueries({ queryKey: qk.adminDaily })} />
        <AgentInfo />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <ProblemList onChanged={apply} />
        <SubscriberList subscribers={data.subscribers} onChanged={apply} />
      </div>
    </div>
  );
}

const LEVELS = [1, 2, 3, 4, 5];

/** 유형×난이도별 발송 중인 문제 수(괄호는 작성 중). 비어 있는 칸부터 에이전트가 채운다 */
function BankGrid({ data }: Readonly<{ data: DailyAdminOverview }>) {
  const cell = (topic: string, level: number) => data.bank.find((c) => c.topic === topic && c.level === level);
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">문제은행</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-faint">
              <th className="py-1 pr-2 text-left font-semibold">유형</th>
              {LEVELS.map((l) => (
                <th key={l} className="px-1 py-1 text-right font-semibold">
                  {l}단계
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAILY_TOPICS.map((topic) => (
              <tr key={topic} className="border-t border-line">
                <td className="py-1 pr-2 whitespace-nowrap">{topic}</td>
                {LEVELS.map((l) => {
                  const c = cell(topic, l);
                  return (
                    <td key={l} className={`px-1 py-1 text-right tabular-nums ${c?.ready ? '' : 'text-faint'}`}>
                      {c?.ready ?? 0}
                      {c?.draft ? <span className="text-warn"> ({c.draft})</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 직접 추가: 에이전트와 같은 JSON 형식. 기준 풀이가 모든 케이스를 통과해야 저장된다 */
function ProblemEditor({ onSaved }: Readonly<{ onSaved: () => void }>) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: DailyProblemInput) => adminApi.saveDailyProblem(null, input),
    onSuccess: (r: DailySaveResult) => {
      if (!r.saved) return;
      setText('');
      onSaved();
      void qc.invalidateQueries({ queryKey: qk.adminDailyProblems });
    },
  });
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    let input: DailyProblemInput;
    try {
      input = JSON.parse(text) as DailyProblemInput;
    } catch {
      setParseError('JSON 형식이 올바르지 않아요.');
      return;
    }
    setParseError(null);
    save.mutate(input);
  };
  const result = save.data;
  return (
    <form onSubmit={submit} className="rounded-lg border border-line bg-panel p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-bold">문제 직접 추가</h2>
        <button type="button" className="btn-quiet ml-auto px-2 text-[12px]" onClick={() => setText(JSON.stringify(TEMPLATE, null, 2))}>
          예시 채우기
        </button>
      </div>
      <p className="mt-1 text-[12.5px] text-dim">에이전트(MCP create_problem)와 같은 형식이에요. 기준 풀이로 예제와 채점 케이스를 모두 채점해 통과해야 저장돼요.</p>
      <textarea className="field mt-3 min-h-64 font-mono text-[12px]" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="문제 JSON" required />
      <button type="submit" className="btn-primary mt-3" disabled={save.isPending || !text.trim()}>
        {save.isPending ? '채점하고 저장하는 중…' : '검증하고 저장하기'}
      </button>
      {parseError && <p role="alert" className="mt-3 text-[13px] text-bad">{parseError}</p>}
      {save.isError && <p role="alert" className="mt-3 whitespace-pre-wrap text-[13px] text-bad">{errMsg(save.error)}</p>}
      {result?.saved && <output className="mt-3 block text-[13px] text-ok">저장했어요.</output>}
      {result && !result.saved && (
        <div role="alert" className="mt-3 text-[13px] text-bad">
          <p>{result.verify.error ?? `기준 풀이가 ${result.verify.score ?? 0}점이에요. 아래 케이스를 확인해 주세요.`}</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-[12px]">
            {result.verify.failures.map((f) => (
              <li key={f.id} className="break-all">
                {f.id}: {f.status} · 기대 {f.expected} · 실제 {f.actual ?? '-'} {f.stderr && `· ${f.stderr}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function ProblemList({ onChanged }: Readonly<{ onChanged: (d: DailyAdminOverview) => void }>) {
  const list = useQuery({ queryKey: qk.adminDailyProblems, queryFn: adminApi.dailyProblems });
  const [testEmails, setTestEmails] = useState('');
  const status = useMutation({ mutationFn: ({ id, s }: { id: string; s: DailyProblemStatus }) => adminApi.setDailyProblemStatus(id, s), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: adminApi.deleteDailyProblem, onSuccess: onChanged });
  const test = useMutation({ mutationFn: (id: string) => adminApi.testDailyProblem(id, testEmails.split(/[\s,]+/).filter(Boolean)) });
  const action = status.error ?? remove.error ?? test.error;
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">
        문제 <span className="text-faint">{list.data?.length ?? ''}</span>
      </h2>
      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-[12px] font-bold text-dim">시험 받을 주소(최대 5개, 쉼표로 구분)</span>
        <input className="field" value={testEmails} onChange={(e) => setTestEmails(e.target.value)} autoComplete="off" />
      </label>
      {list.isPending && <LinesSkeleton />}
      {list.isError && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(list.error)}</p>}
      {list.data?.length === 0 && <p className="mt-3 text-[13px] text-faint">아직 문제가 없어요. 직접 추가하거나 에이전트로 채워 주세요.</p>}
      {test.isSuccess && <output className="mt-3 block text-[13px] text-dim">시험 메일 {test.data.sent}통을 보냈어요.</output>}
      {action && <p role="alert" className="mt-3 text-[13px] text-bad">{errMsg(action)}</p>}
      <ol className="mt-2 divide-y divide-line">
        {list.data?.map((p) => (
          <li key={p.id} className="py-2 text-[13px]">
            <div className="flex items-center gap-2">
              <a href={`#/p/${encodeURIComponent(p.id)}`} className="min-w-0 flex-1 truncate font-semibold hover:underline">
                {p.title}
              </a>
              <select
                className="field w-auto py-0.5 text-[12px]"
                value={p.status}
                aria-label={`${p.title} 상태`}
                disabled={status.isPending}
                onChange={(e) => status.mutate({ id: p.id, s: e.target.value as DailyProblemStatus })}
              >
                {(Object.keys(PROBLEM_STATUS) as DailyProblemStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {PROBLEM_STATUS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-faint">
              <span>
                {p.topic} · {p.level}단계 · {p.source} · 받음 {p.picks} · 해결 {p.solved}
              </span>
              <button type="button" className="btn-quiet px-1 text-[12px]" disabled={!testEmails.trim() || test.isPending} onClick={() => test.mutate(p.id)}>
                시험 발송
              </button>
              {p.picks === 0 && (
                <button
                  type="button"
                  className="btn-quiet px-1 text-[12px] text-bad"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`'${p.title}' 문제를 지울까요?`)) remove.mutate(p.id);
                  }}
                >
                  지우기
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 에이전트 연결 안내. MCP는 pahidc 안에서만 실행되고 외부에 열려 있지 않다 */
function AgentInfo() {
  return (
    <section className="rounded-lg border border-line bg-panel p-5 text-[13px]">
      <h2 className="text-[15px] font-bold">에이전트 자동 제작</h2>
      <p className="mt-1 text-dim">
        pahidc의 타이머가 Codex CLI로 문제은행 MCP에 접속해, 부족한 유형·난이도부터 새 문제를 만들고 검증해 추가해요. 다른 모델도 같은 MCP에 연결하면 똑같이 동작해요.
      </p>
      <p className="mt-2 text-dim">SSH로 접속할 수 있는 곳에서 직접 연결:</p>
      <pre className="mt-1 overflow-x-auto rounded bg-raised p-2 font-mono text-[12px]">ssh pahidc solveline-bank-mcp --agent 이름</pre>
    </section>
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
