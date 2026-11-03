import { createInterface } from 'node:readline';
import { handle, workerCaller, type Rpc } from './bank-mcp.ts';

// 문제은행 MCP 서버의 stdio 진입점(judge 컨테이너 안에서 실행). 처리 로직은 bank-mcp.ts에 있고 테스트한다.

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

void main();
