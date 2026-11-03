import { describe, expect, it } from 'vitest';
import { DAILY_BANK_PATH, DailyBankTools, verifyJudge } from '@solveline/shared';
import { handle, toolList, workerCaller, type BankCaller } from '../src/bank-mcp.ts';

const SECRET = 'j'.repeat(40);
const echo: BankCaller = async (tool, args) => (tool === 'get_problem' ? { ok: false, message: '없는 문제예요.' } : { ok: true, data: { tool, args } });
const rpc = (method: string, params?: Record<string, unknown>, id: number | undefined = 1) => ({ jsonrpc: '2.0' as const, id, method, params });

describe('문제은행 MCP 서버', () => {
  it('초기화에 요청한 프로토콜 버전과 도구 기능을 알린다', async () => {
    const res = (await handle(rpc('initialize', { protocolVersion: '2025-03-26' }), echo)) as { result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } } };
    expect(res.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'solveline-bank' } });
    const fallback = (await handle(rpc('initialize', {}), echo)) as { result: { protocolVersion: string } };
    expect(fallback.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('알림에는 답하지 않고, ping과 모르는 메서드를 처리한다', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, echo)).toBeNull();
    expect(await handle(rpc('ping'), echo)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(await handle(rpc('resources/list'), echo)).toMatchObject({ error: { code: -32601 } });
  });

  it('작업 지시를 MCP 프롬프트로 준다(출제 기준 + 작업 절차, 개수는 1~20)', async () => {
    const init = (await handle(rpc('initialize', {}), echo)) as { result: { capabilities: Record<string, unknown> } };
    expect(init.result.capabilities).toHaveProperty('prompts');
    expect(await handle(rpc('prompts/list'), echo)).toMatchObject({ result: { prompts: [{ name: 'create_daily_batch' }] } });
    type Got = { result: { messages: { role: string; content: { text: string } }[] } };
    const got = (await handle(rpc('prompts/get', { name: 'create_daily_batch', arguments: { count: '7' } }), echo)) as Got;
    expect(got.result.messages[0]!.role).toBe('user');
    expect(got.result.messages[0]!.content.text).toContain('7개');
    expect(got.result.messages[0]!.content.text).toContain('학습 목표 개념');
    expect(((await handle(rpc('prompts/get', { name: 'create_daily_batch', arguments: { count: '999' } }), echo)) as Got).result.messages[0]!.content.text).toContain('20개');
    expect(((await handle(rpc('prompts/get', { name: 'create_daily_batch' }), echo)) as Got).result.messages[0]!.content.text).toContain('10개');
    expect(await handle(rpc('prompts/get', { name: 'nope' }), echo)).toMatchObject({ error: { code: -32602 } });
  });

  it('공용 도구 목록을 JSON Schema로 내보낸다', async () => {
    const res = (await handle(rpc('tools/list'), echo)) as { result: { tools: ReturnType<typeof toolList> } };
    expect(res.result.tools.map((t) => t.name)).toEqual(Object.keys(DailyBankTools));
    const create = res.result.tools.find((t) => t.name === 'create_problem')!;
    expect(create.inputSchema).toMatchObject({ type: 'object', properties: { referenceSolution: { type: 'object' }, topic: { enum: expect.arrayContaining(['해시']) } } });
  });

  it('도구 호출을 넘기고 결과·오류를 MCP 내용으로 감싼다', async () => {
    const ok = (await handle(rpc('tools/call', { name: 'bank_overview', arguments: { a: 1 } }), echo)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(ok.result.isError).toBe(false);
    expect(JSON.parse(ok.result.content[0]!.text)).toEqual({ tool: 'bank_overview', args: { a: 1 } });
    const bad = (await handle(rpc('tools/call', { name: 'get_problem', arguments: {} }), echo)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result).toEqual({ isError: true, content: [{ type: 'text', text: '없는 문제예요.' }] });
    expect(await handle(rpc('tools/call', { name: 'rm_rf' }), echo)).toMatchObject({ error: { code: -32602 } });
  });

  it('Worker 호출을 judge 비밀로 서명하고, 응답 오류와 연결 실패를 메시지로 돌려준다', async () => {
    const seen: { url: string; ok: boolean; body: unknown }[] = [];
    let reply = new Response(JSON.stringify({ data: { saved: true } }), { status: 200 });
    const fake = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = String(init.body);
      seen.push({ url, ok: await verifyJudge(SECRET, (n) => headers.get(n) ?? undefined, 'POST', DAILY_BANK_PATH, body), body: JSON.parse(body) });
      return reply;
    }) as typeof fetch;
    const call = workerCaller({ origin: 'https://solveline.test', secret: SECRET, agent: 'codex', fetch: fake });
    expect(await call('create_problem', { x: 1 })).toEqual({ ok: true, data: { saved: true } });
    expect(seen[0]).toEqual({ url: `https://solveline.test${DAILY_BANK_PATH}`, ok: true, body: { agent: 'codex', tool: 'create_problem', args: { x: 1 } } });

    reply = new Response(JSON.stringify({ error: { code: 'invalid_args', message: 'topic: 잘못된 값' } }), { status: 400 });
    expect(await call('create_problem', {})).toEqual({ ok: false, message: 'topic: 잘못된 값' });
    reply = new Response('bad gateway', { status: 502 });
    expect(await call('bank_overview', {})).toEqual({ ok: false, message: 'Solveline API 응답 502' });

    const down = workerCaller({ origin: 'https://solveline.test', secret: SECRET, agent: 'codex', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    expect(await down('bank_overview', {})).toEqual({ ok: false, message: 'Solveline API에 닿지 않았어요: ECONNREFUSED' });
  });
});
