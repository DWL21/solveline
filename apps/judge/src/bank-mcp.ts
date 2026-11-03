import { createInterface } from 'node:readline';
import { z } from 'zod';
import { DAILY_BANK_PATH, DailyBankTools, judgeHeaders, type DailyBankToolName } from '@solveline/shared';

/**
 * 일일 미니 문제 은행 MCP 서버(stdio). pahidc의 judge 컨테이너 안에서만 실행하고 외부 포트를 열지 않는다.
 *   ssh pahidc solveline-bank-mcp --agent <이름>   (scripts/daily-bank/solveline-bank-mcp)
 * 도구 목록·입력 형식은 @solveline/shared의 DailyBankTools 그대로이고, 호출은 judge 비밀로 서명해 Worker API로 넘긴다.
 * MCP를 쓰는 에이전트(Codex, Claude 등)라면 모델과 무관하게 같은 도구로 문제를 만든다.
 */

const PROTOCOL_VERSION = '2025-06-18';

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
export type BankCaller = (tool: DailyBankToolName, args: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;

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
        capabilities: { tools: {} },
        serverInfo: { name: 'solveline-bank', version: '1.0.0' },
        instructions: 'Solveline 일일 미니 문제 은행. 먼저 bank_guide와 bank_overview를 보고, 부족한 유형·난이도부터 create_problem으로 채운다.',
      });
    case 'ping':
      return reply({});
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

function agentName(argv: string[]) {
  const i = argv.indexOf('--agent');
  const name = i >= 0 ? argv[i + 1] : process.env.BANK_AGENT;
  return name && /^[\w.-]{1,40}$/.test(name) ? name : 'agent';
}

async function main() {
  const secret = process.env.JUDGE_SECRET;
  const origin = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
  if (!secret || !origin) {
    process.stderr.write('JUDGE_SECRET·WEB_ORIGIN이 없어 시작하지 않습니다.\n');
    process.exit(1);
  }
  const call = workerCaller({ origin, secret, agent: agentName(process.argv) });
  const rl = createInterface({ input: process.stdin });
  // 응답은 받은 순서대로 쓴다(긴 검증 중에도 다음 줄을 받아 둔다)
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON을 읽지 못했어요' } })}\n`);
        return;
      }
      const out = await handle(msg, call);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  rl.on('close', () => void chain.then(() => process.exit(0)));
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
