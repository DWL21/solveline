import { z } from 'zod';
import { DAILY_AUTHOR_GUIDE, DAILY_BANK_PATH, DailyBankTools, dailyBatchTask, judgeHeaders, type DailyBankToolName } from '@solveline/shared';

/**
 * 일일 미니 문제 은행 MCP 서버(stdio). pahidc의 judge 컨테이너 안에서만 실행하고 외부 포트를 열지 않는다.
 *   ssh pahidc solveline-bank-mcp --agent <이름>   (scripts/daily-bank/solveline-bank-mcp → src/bank-mcp-main.ts)
 * 도구 목록·입력 형식은 @solveline/shared의 DailyBankTools 그대로이고, 호출은 judge 비밀로 서명해 Worker API로 넘긴다.
 * MCP를 쓰는 에이전트(Codex, Claude 등)라면 모델과 무관하게 같은 도구로 문제를 만든다.
 * 작업 지시도 서버가 준다: create_daily_batch 프롬프트(출제 기준 + 작업 절차). 실행하는 쪽은 개수만 정한다.
 */

const PROTOCOL_VERSION = '2025-06-18';

export type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
export type BankCaller = (tool: DailyBankToolName, args: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;

/** MCP 프롬프트: 클라이언트가 고르면 출제 기준과 작업 절차를 사용자 메시지로 받는다 */
export const PROMPTS = [
  {
    name: 'create_daily_batch',
    description: '출제 기준에 따라 일일 미니 문제를 여러 개 만들고 검증해 저장하는 작업',
    arguments: [{ name: 'count', description: '만들 문제 수(1~20, 기본 10)', required: false }],
  },
];

export function batchPrompt(count: unknown) {
  const n = Math.min(20, Math.max(1, Math.trunc(Number(count)) || 10));
  return {
    description: `일일 미니 문제 ${n}개 만들기`,
    messages: [{ role: 'user', content: { type: 'text', text: `${dailyBatchTask(n)}\n\n${DAILY_AUTHOR_GUIDE}` } }],
  };
}

export const toolList = () =>
  (Object.keys(DailyBankTools) as DailyBankToolName[]).map((name) => ({
    name,
    description: DailyBankTools[name].description,
    inputSchema: z.toJSONSchema(DailyBankTools[name].input, { io: 'input', unrepresentable: 'any' }),
  }));

/** 요청 하나를 처리한다. 알림(id 없음)이면 null */
export async function handle(msg: Rpc, call: BankCaller): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'solveline-bank', version: '1.1.0' },
        instructions: 'Solveline 일일 미니 문제 은행(학습용 코딩 테스트 문제). 문제를 만들 때는 create_daily_batch 프롬프트나 bank_guide의 출제 기준·작업 절차를 따른다.',
      });
    case 'ping':
      return reply({});
    case 'prompts/list':
      return reply({ prompts: PROMPTS });
    case 'prompts/get':
      if (msg.params?.name !== 'create_daily_batch') return error(-32602, `없는 프롬프트: ${String(msg.params?.name)}`);
      return reply(batchPrompt((msg.params?.arguments as Record<string, unknown> | undefined)?.count));
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call': {
      const name = msg.params?.name;
      if (typeof name !== 'string' || !(name in DailyBankTools)) return error(-32602, `없는 도구: ${String(name)}`);
      const res = await call(name as DailyBankToolName, msg.params?.arguments ?? {});
      const text = res.ok ? JSON.stringify(res.data, null, 2) : res.message;
      return reply({ content: [{ type: 'text', text }], isError: !res.ok });
    }
    default:
      return error(-32601, `지원하지 않는 메서드: ${msg.method}`);
  }
}

/** Worker의 내부 경로를 서명해 부른다 */
export function workerCaller(opts: { origin: string; secret: string; agent: string; fetch?: typeof fetch }): BankCaller {
  const doFetch = opts.fetch ?? fetch;
  return async (tool, args) => {
    const body = JSON.stringify({ agent: opts.agent, tool, args });
    try {
      const res = await doFetch(`${opts.origin}${DAILY_BANK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await judgeHeaders(opts.secret, 'POST', DAILY_BANK_PATH, body)) },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
      if (res.ok && json && 'data' in json) return { ok: true, data: json.data };
      return { ok: false, message: json?.error?.message ?? `Solveline API 응답 ${res.status}` };
    } catch (e) {
      return { ok: false, message: `Solveline API에 닿지 않았어요: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
}
