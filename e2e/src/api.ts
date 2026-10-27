import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { z } from 'zod';
import {
  AdminSession,
  Bookmark,
  Collection,
  Folder,
  HiddenCases,
  Problem,
  ProblemSummary,
  PublicConfig,
  Session,
  Submission,
  type CollectionInput,
  type ProblemInput,
  type SubmissionRequest,
} from '@solveline/shared';
import { env } from './env.ts';

/**
 * API 클라이언트. 모든 성공 응답을 앱과 같은 공유 계약(Zod)으로 검증한다 — 소비자 쪽 계약 검사.
 * 실패 응답은 { error: { code, message } } 봉투인지 확인한다.
 * 같은 브라우저 컨텍스트의 request를 넘기면 쿠키(세션)를 함께 쓴다.
 */
export class Api {
  constructor(readonly request: APIRequestContext) {}

  /** 성공(2xx)과 계약 일치를 함께 확인하고 data를 돌려준다 */
  async ok<T extends z.ZodType>(res: APIResponse | Promise<APIResponse>, schema: T): Promise<z.output<T>> {
    const r = await res;
    const body = await r.json().catch(() => null);
    expect(r.ok(), `${r.url()} → ${r.status()} ${JSON.stringify(body)?.slice(0, 300)}`).toBe(true);
    const parsed = schema.safeParse((body as { data?: unknown } | null)?.data);
    expect(parsed.success, `계약 위반 ${r.url()}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
    return parsed.data as z.output<T>;
  }

  /** 실패 응답: 상태 코드와 오류 코드를 돌려준다(봉투 형식 검사 포함) */
  async fail(res: APIResponse | Promise<APIResponse>): Promise<{ status: number; code: string }> {
    const r = await res;
    expect(r.ok(), `${r.url()}가 성공하면 안 됩니다`).toBe(false);
    const body = await r.json().catch(() => null);
    const parsed = z.object({ error: z.object({ code: z.string().min(1), message: z.string().min(1) }) }).safeParse(body);
    expect(parsed.success, '오류 봉투 { error: { code, message } }').toBe(true);
    return { status: r.status(), code: parsed.data!.error.code };
  }

  // ─── 인증 ───
  /** 테스트 전용 로그인(테스트 환경에서만 켜진다). 같은 컨텍스트에 세션 쿠키가 붙는다. */
  signIn(email: string, opts: { editor?: boolean } = {}) {
    return this.ok(
      this.request.post('/api/test/session', { headers: { 'x-test-auth': env.testAuthToken }, data: { email, editor: opts.editor } }),
      Session,
    );
  }
  session = () => this.ok(this.request.get('/api/auth/session'), Session);
  signOut = () => this.ok(this.request.post('/api/auth/logout', { data: {} }), Session);
  publicConfig = () => this.ok(this.request.get('/api/public/config'), PublicConfig);
  masterLogin = (password = env.masterPassword) => this.ok(this.request.post('/api/admin/login', { data: { password } }), AdminSession);

  // ─── 문제 ───
  problems = () => this.ok(this.request.get('/api/problems'), z.array(ProblemSummary));
  problem = (id: string) => this.ok(this.request.get(`/api/problems/${id}`), Problem);
  createProblem = (p: ProblemInput) => this.ok(this.request.post('/api/problems', { data: p }), Problem);
  saveProblem = (id: string, p: ProblemInput) => this.ok(this.request.put(`/api/problems/${id}`, { data: p }), Problem);
  setHidden = (id: string, cases: HiddenCases['cases']) => this.ok(this.request.put(`/api/problems/${id}/hidden`, { data: { cases } }), HiddenCases);

  async bookmark(id: string, bookmarked: boolean) {
    const email = (await this.session()).user?.email ?? '';
    return this.ok(this.request.put(`/api/problems/${id}/bookmark`, { headers: { 'x-draft-owner': email }, data: { bookmarked } }), Bookmark);
  }

  // ─── 폴더·컬렉션 ───
  folders = () => this.ok(this.request.get('/api/folders'), z.array(Folder));
  createFolder = (name: string) => this.ok(this.request.post('/api/folders', { data: { name } }), Folder);
  collections = () => this.ok(this.request.get('/api/collections'), z.array(Collection));
  createCollection = (c: CollectionInput) => this.ok(this.request.post('/api/collections', { data: c }), Collection);
  setCollectionItems = (id: string, problemIds: string[]) => this.ok(this.request.put(`/api/collections/${id}/items`, { data: { problemIds } }), Collection);

  // ─── 제출 ───
  submit = (s: SubmissionRequest) => this.ok(this.request.post('/api/submissions', { data: s }), Submission);
  submission = (id: string) => this.ok(this.request.get(`/api/submissions/${id}`), Submission);

  /** 끝날 때까지 조회한다(앱과 같은 방식). 상태 전이를 기록해 돌려준다. */
  async judge(s: SubmissionRequest, timeoutMs = 60_000) {
    let sub = await this.submit(s);
    const seen = [sub.status];
    const until = Date.now() + timeoutMs;
    while (sub.status === 'queued' || sub.status === 'running') {
      expect(Date.now(), '채점이 제한 시간 안에 끝나야 합니다').toBeLessThan(until);
      await new Promise((r) => setTimeout(r, 250));
      sub = await this.submission(sub.id);
      if (seen.at(-1) !== sub.status) seen.push(sub.status);
    }
    return { submission: sub, transitions: seen };
  }
}
