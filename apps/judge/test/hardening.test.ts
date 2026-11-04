import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactSubmitResult, submitErrorSummary } from '@solveline/shared';
import { RunnerClient, runnerFromUrl, unixSocketFetch } from '../src/runner.ts';

describe('제출 결과의 오류 출력은 종류만 남긴다(히든 입력 유출 방지)', () => {
  it('Python 역추적은 표준 예외 이름만', () => {
    expect(submitErrorSummary('Traceback (most recent call last):\n  File "solution.py", line 2\nValueError: [3, 1, 4, 1, 5]', 'error')).toBe('런타임 에러 (ValueError)');
    expect(submitErrorSummary('RecursionError: maximum recursion depth exceeded', 'error')).toBe('런타임 에러 (RecursionError)');
  });

  it('사용자가 만든 예외 이름(값을 담을 수 있다)은 남기지 않는다', () => {
    expect(submitErrorSummary('Traceback ...\nX314159: boom', 'error')).toBe('런타임 에러');
    expect(submitErrorSummary('json.decoder.JSONDecodeError: Expecting value', 'error')).toBe('런타임 에러');
  });

  it('Java 예외는 java·javax·jdk 패키지 이름만', () => {
    expect(submitErrorSummary('java.lang.ArrayIndexOutOfBoundsException: Index 7 out of bounds for length 3\n\tat Solution.solution(Solution.java:3)', 'error')).toBe(
      '런타임 에러 (ArrayIndexOutOfBoundsException)',
    );
    expect(submitErrorSummary('Exception in thread "main" java.lang.StackOverflowError\n\tat Main.f(Main.java:4)', 'error')).toBe('런타임 에러 (StackOverflowError)');
    expect(submitErrorSummary('Leak123Exception: 3 1 4\n\tat Solution.solution(Solution.java:3)', 'error')).toBe('런타임 에러');
  });

  it('runner 안내 문구는 그대로, 통과·실패·시간 초과의 출력은 지운다', () => {
    expect(submitErrorSummary('프로세스가 강제 종료되었습니다 (메모리 초과 가능).', 'error')).toBe('프로세스가 강제 종료되었습니다 (메모리 초과 가능).');
    expect(submitErrorSummary('hidden: 3 1 4', 'pass')).toBe('');
    expect(submitErrorSummary('hidden: 3 1 4', 'fail')).toBe('');
    expect(submitErrorSummary('hidden: 3 1 4', 'timeout')).toBe('');
    expect(submitErrorSummary('', 'error')).toBe('');
  });

  it('redactSubmitResult는 반환값·표준 출력도 지운다', () => {
    const r = redactSubmitResult({
      compile: { ok: true, output: '' },
      results: [{ id: 'a', status: 'fail', actual: '[3,1,4]', stdout: '3 1 4', stderr: '3 1 4', timeMs: 1, memoryMb: 1 }],
    });
    expect(r.results[0]).toEqual({ id: 'a', status: 'fail', actual: null, stdout: '', stderr: '', timeMs: 1, memoryMb: 1 });
  });
});

describe('unix 소켓 runner', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('RUNNER_URLS의 unix: 항목은 소켓으로 요청·본문·상태 코드를 주고받는다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-sock-'));
    const sock = join(dir, 'runner.sock');
    const seen: { method?: string; url?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'up', versions: { java: '21.0.2', python: '3.13.13' } }));
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'testset_missing' }));
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const client = runnerFromUrl(`unix:${sock}`);
      expect(client).toBeInstanceOf(RunnerClient);
      expect(await client.runtime()).toEqual({ runner: 'up', versions: { java: '21.0.2', python: '3.13.13' } });
      const res = await unixSocketFetch(sock)('http://runner/run?x=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":"한글"}' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'testset_missing' });
      expect(seen.at(-1)).toEqual({ method: 'POST', url: '/run?x=1', body: '{"a":"한글"}' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('소켓이 없으면 runner down', async () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-sock-'));
    expect((await runnerFromUrl(`unix:${join(dir, 'none.sock')}`).runtime()).runner).toBe('down');
  });

  it('http 주소는 그대로 쓴다', () => {
    expect(runnerFromUrl('http://runner:8000/').baseUrl).toBe('http://runner:8000');
  });
});
