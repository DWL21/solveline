import {
  Collection,
  EMPTY_TIMER,
  Folder,
  Problem,
  mergeProblem,
  type CatalogProblem,
  type MyProblemState,
  type MyProblemSummary,
  type AdminUser,
  type AdminUserDetail,
  type CodeSet,
  type CollectionInput,
  type Language,
  type LastSubmission,
  type ProblemInput,
  type ProblemPatch,
  type ProblemSummary,
  type ProblemTimer,
  type TestCase,
  type TestsetRef,
} from '@solveline/shared';
import { isUniqueViolation, stmt, type Param, type Sql, type Stmt } from './sql.ts';

/** 이름 중복·없는 폴더처럼 요청을 고쳐야 하는 오류 */
export class StoreError extends Error {
  constructor(
    public code: 'duplicate_name' | 'folder_not_found' | 'problem_not_found',
    message: string,
  ) {
    super(message);
  }
}


type Row = {
  id: string;
  title: string;
  folder_id: string | null;
  mode: string;
  language: string;
  body: string;
  created_at: string;
  updated_at: string;
};

/** 공용 문제 내용. code는 시작 코드다. */
type Body = {
  description: string;
  params: string[];
  timeLimitMs: number;
  /** 보이는 케이스만 */
  cases: TestCase[];
  code: CodeSet;
  hiddenTestset: TestsetRef | null;
};

/** 사용자별 풀이 상태 */
type StateRow = { language: string | null; code: string | null; my_cases: string | null; memo: string | null; timer: string | null; last_submission: string | null; updated_at: string };

const parse = <T>(v: string | null | undefined): T | null => (v ? (JSON.parse(v) as T) : null);

/**
 * 문제 저장소. 문제 내용은 모두가 같이 보는 공용이고(관리자만 바꾼다), 작성 코드·언어·풀이 시간·마지막 제출은 user_problems에 사용자별로 둔다.
 * 히든 케이스는 body가 아니라 judge(해시 파일·R2)에 두고 body에는 해시·개수만 남긴다.
 */
export class ProblemStore {
  constructor(private readonly sql: Sql) {}

  /**
   * 내 풀이 상태가 있는 문제만(작성 코드·북마크·개인 폴더 중 하나라도). 카탈로그 목록과 합쳐 쓴다.
   * problems를 훑지 않고 사용자 테이블만 user_id로 읽는다(D1은 읽은 행 수로 한도를 센다).
   */
  async mySummaries(userId: string): Promise<MyProblemSummary[]> {
    const rows = await this.sql.all<{ id: string; language: string | null; timer: string | null; last_submission: string | null; bookmarked: number; folder_id: string | null }>(
      `SELECT k.id, s.language, s.timer, s.last_submission, b.problem_id IS NOT NULL AS bookmarked, f.folder_id
       FROM (SELECT problem_id AS id FROM user_problems WHERE user_id = ?
             UNION SELECT problem_id FROM bookmarks WHERE user_id = ?
             UNION SELECT problem_id FROM folder_items WHERE user_id = ?) k
       LEFT JOIN user_problems s ON s.user_id = ? AND s.problem_id = k.id
       LEFT JOIN bookmarks b ON b.user_id = ? AND b.problem_id = k.id
       LEFT JOIN folder_items f ON f.user_id = ? AND f.problem_id = k.id`,
      ...new Array<string>(6).fill(userId),
    );
    return rows.map((r) => ({
      id: r.id,
      bookmarked: !!r.bookmarked,
      folderId: r.folder_id,
      language: r.language as Language | null,
      lastSubmission: parse<LastSubmission>(r.last_submission),
      timer: parse<ProblemTimer>(r.timer) ?? EMPTY_TIMER,
    }));
  }

  /** 문제 하나의 내 상태. 문제가 없으면 null */
  async myState(id: string, userId: string): Promise<MyProblemState | null> {
    if (!(await this.exists(id))) return null;
    const [st, folderId] = await Promise.all([this.state(id, userId), this.folderOf(id, userId)]);
    return {
      folderId,
      language: (st?.language ?? null) as Language | null,
      code: parse<CodeSet>(st?.code),
      myCases: parse<TestCase[]>(st?.my_cases) ?? [],
      memo: st?.memo ?? '',
      timer: parse<ProblemTimer>(st?.timer) ?? EMPTY_TIMER,
      lastSubmission: parse<LastSubmission>(st?.last_submission),
    };
  }

  private toCatalog(row: Row): CatalogProblem {
    const b = this.body(row);
    return {
      id: row.id,
      title: row.title,
      folderId: row.folder_id,
      mode: row.mode as Problem['mode'],
      language: row.language as Language,
      description: b.description,
      params: b.params,
      timeLimitMs: b.timeLimitMs,
      cases: b.cases,
      hiddenTestset: b.hiddenTestset,
      starterCode: b.code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 공용 문제 내용(사용자 상태 없음) */
  async catalogProblem(id: string): Promise<CatalogProblem | null> {
    const row = await this.row(id);
    return row ? this.toCatalog(row) : null;
  }

  /** 모든 공용 문제(제목순). 카탈로그 게시에 쓴다. */
  async catalogProblems(): Promise<CatalogProblem[]> {
    return (await this.sql.all<Row>('SELECT * FROM problems ORDER BY title')).map((r) => this.toCatalog(r));
  }

  /** userId가 null이면 비회원: 풀이 상태 없이 문제만(폴더는 틀 배치) */
  async list(userId: string | null): Promise<ProblemSummary[]> {
    const rows = await this.sql.all<Row & { my_language: string | null; timer: string | null; last_submission: string | null; bookmark_id: string | null }>(
      `SELECT p.id, p.title, CASE WHEN ? IS NULL THEN p.folder_id ELSE f.folder_id END AS folder_id, p.mode, p.language, p.updated_at,
              s.language AS my_language, s.timer, s.last_submission, b.problem_id AS bookmark_id
       FROM problems p
       LEFT JOIN user_problems s ON s.problem_id = p.id AND s.user_id = ?
       LEFT JOIN bookmarks b ON b.problem_id = p.id AND b.user_id = ?
       LEFT JOIN folder_items f ON f.problem_id = p.id AND f.user_id = ?
       ORDER BY p.title`,
      ...new Array<string | null>(4).fill(userId),
    );
    return rows.map((r) => ({
      id: r.id,
      bookmarked: r.bookmark_id !== null,
      title: r.title,
      folderId: r.folder_id,
      mode: r.mode as Problem['mode'],
      language: (r.my_language ?? r.language) as Language,
      lastSubmission: parse<LastSubmission>(r.last_submission),
      timer: parse<ProblemTimer>(r.timer) ?? EMPTY_TIMER,
      updatedAt: r.updated_at,
    }));
  }

  async setBookmark(id: string, userId: string, bookmarked: boolean) {
    if (!(await this.exists(id))) return false;
    if (bookmarked) await this.sql.run('INSERT OR IGNORE INTO bookmarks (user_id, problem_id) VALUES (?, ?)', userId, id);
    else await this.sql.run('DELETE FROM bookmarks WHERE user_id = ? AND problem_id = ?', userId, id);
    return true;
  }

  private row(id: string) {
    return this.sql.get<Row>('SELECT * FROM problems WHERE id = ?', id);
  }

  async exists(id: string) {
    return (await this.sql.value<number>('SELECT 1 FROM problems WHERE id = ?', id)) !== undefined;
  }

  private body(row: Row): Body {
    const b = JSON.parse(row.body) as Partial<Body>;
    return {
      description: b.description ?? '',
      params: b.params ?? [],
      timeLimitMs: b.timeLimitMs ?? 10_000,
      cases: b.cases ?? [],
      code: b.code ?? { java: '', python: '' },
      hiddenTestset: b.hiddenTestset ?? null,
    };
  }

  private state(id: string, userId: string) {
    return this.sql.get<StateRow>('SELECT language, code, my_cases, memo, timer, last_submission, updated_at FROM user_problems WHERE user_id = ? AND problem_id = ?', userId, id);
  }

  /** 사용자 상태의 일부를 바꾼다(없으면 만든다) */
  private upsertState(id: string, userId: string, patch: { language?: string; code?: string; my_cases?: string; memo?: string; timer?: string; last_submission?: string }, now = new Date()) {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
    return stmt(
      `INSERT INTO user_problems (user_id, problem_id, ${cols.join(', ')}, updated_at) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)
       ON CONFLICT (user_id, problem_id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`,
      userId,
      id,
      ...cols.map((c) => patch[c]!),
      now.toISOString(),
    );
  }

  async get(id: string, userId: string | null): Promise<Problem | null> {
    // 웹이 카탈로그와 내 상태를 합치는 것과 같은 방식으로 만든다.
    const p = await this.catalogProblem(id);
    if (!p) return null;
    return Problem.parse(mergeProblem(p, userId ? await this.myState(id, userId) : null));
  }

  /** 이 사용자가 문제를 넣어 둔 개인 폴더 */
  private async folderOf(id: string, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    return (await this.sql.value<string>('SELECT folder_id FROM folder_items WHERE user_id = ? AND problem_id = ?', userId, id)) ?? null;
  }

  /** 문제를 이 사용자의 개인 폴더에 넣는 문(null이면 폴더 없음). 남의 폴더에는 넣을 수 없다. */
  private async setFolder(id: string, userId: string, folderId: string | null): Promise<Stmt> {
    if (!folderId) return stmt('DELETE FROM folder_items WHERE user_id = ? AND problem_id = ?', userId, id);
    if ((await this.sql.value('SELECT 1 FROM folders WHERE id = ? AND user_id = ?', folderId, userId)) === undefined) throw new StoreError('folder_not_found', '없는 폴더입니다.');
    return stmt(
      'INSERT INTO folder_items (user_id, problem_id, folder_id) VALUES (?, ?, ?) ON CONFLICT (user_id, problem_id) DO UPDATE SET folder_id = excluded.folder_id',
      userId,
      id,
      folderId,
    );
  }

  /**
   * hiddenRef: 입력에 hidden 케이스가 있어 judge에 새로 저장한 테스트셋(없으면 기존 테스트셋 유지).
   * 시작 코드는 starterCode가 있을 때만 바꾼다.
   */
  private toBody(input: ProblemInput, prev: Body | null, hiddenRef?: TestsetRef | null): Body {
    return {
      description: input.description,
      params: input.params,
      timeLimitMs: input.timeLimitMs,
      cases: input.cases.filter((c) => !c.hidden),
      code: input.starterCode ?? prev?.code ?? input.code,
      hiddenTestset: hiddenRef !== undefined ? hiddenRef : (prev?.hiddenTestset ?? null),
    };
  }

  /** 편집 권한자만. 만든 사람의 작성 코드는 시작 코드와 같다. */
  async create(input: ProblemInput, userId: string, hiddenRef?: TestsetRef | null, now = new Date()): Promise<Problem> {
    const id = crypto.randomUUID();
    const ts = now.toISOString();
    // 폴더는 개인 정리용: 만든 사람의 폴더에만 넣는다
    const folder = await this.setFolder(id, userId, input.folderId);
    await this.sql.batch([
      stmt('INSERT INTO problems (id, title, folder_id, mode, language, body, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', id, input.title, input.mode, input.language, JSON.stringify(this.toBody(input, null, hiddenRef)), ts, ts),
      folder,
    ]);
    return (await this.get(id, userId))!;
  }

  /**
   * 자동 저장. 작성 코드·언어·내 케이스·메모는 언제나 그 사용자 것으로 저장하고, 문제 내용은 편집 권한이 있을 때만 바꾼다
   * (권한 없는 사용자가 보낸 내용 변경은 무시한다).
   */
  async update(id: string, input: ProblemInput, userId: string, editor: boolean, hiddenRef?: TestsetRef | null, now = new Date()): Promise<Problem | null> {
    const row = await this.row(id);
    if (!row) return null;
    const writes: Stmt[] = [];
    if (editor) {
      const prev = this.body(row);
      const next = this.toBody(input, prev, hiddenRef);
      if (row.title !== input.title || row.mode !== input.mode || JSON.stringify(prev) !== JSON.stringify(next))
        writes.push(stmt('UPDATE problems SET title = ?, mode = ?, body = ?, updated_at = ? WHERE id = ?', input.title, input.mode, JSON.stringify(next), now.toISOString(), id));
    }
    // 폴더 배치는 사용자별(누구나 자기 폴더로 정리)
    if (input.folderId !== (await this.folderOf(id, userId))) writes.push(await this.setFolder(id, userId, input.folderId));
    writes.push(this.upsertState(id, userId, { language: input.language, code: JSON.stringify(input.code), my_cases: JSON.stringify(input.myCases.map((c) => ({ ...c, hidden: false }))), memo: input.memo }, now));
    await this.sql.batch(writes);
    return this.get(id, userId);
  }

  /** 변경 필드만 최신 데이터에 합친다. 코드도 언어별로 합쳐 다른 언어의 풀이를 보존한다. */
  async patch(id: string, patch: ProblemPatch, userId: string, editor: boolean, hiddenRef?: TestsetRef | null): Promise<Problem | null> {
    const current = await this.get(id, userId);
    if (!current) return null;
    const { timer, ...fields } = patch;
    if (Object.keys(fields).length) {
      await this.update(id, {
        ...current, ...fields,
        code: { ...current.code, ...fields.code },
        starterCode: fields.starterCode ? { ...current.starterCode, ...fields.starterCode } : undefined,
      }, userId, editor, hiddenRef);
    }
    if (timer) await this.setTimer(id, timer, userId);
    return this.get(id, userId);
  }

  /** 시작 코드만 바꾼다(마스터·편집 권한자) */
  async setStarter(id: string, code: CodeSet, now = new Date()): Promise<boolean> {
    const row = await this.row(id);
    if (!row) return false;
    await this.sql.run('UPDATE problems SET body = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...this.body(row), code }), now.toISOString(), id);
    return true;
  }

  /** 히든 테스트셋 참조. 문제가 없으면 false */
  async hiddenRef(id: string): Promise<TestsetRef | null | false> {
    const row = await this.row(id);
    return row ? this.body(row).hiddenTestset : false;
  }

  /** 히든 테스트셋을 바꾼다(judge에 저장한 참조). 문제가 없으면 false */
  async setHidden(id: string, ref: TestsetRef | null, now = new Date()): Promise<boolean> {
    const row = await this.row(id);
    if (!row) return false;
    await this.sql.run('UPDATE problems SET body = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...this.body(row), hiddenTestset: ref }), now.toISOString(), id);
    return true;
  }

  /** 풀이 시간 저장(사용자별) */
  async setTimer(id: string, timer: ProblemTimer, userId: string): Promise<ProblemTimer | null> {
    if (!(await this.exists(id))) return null;
    await this.sql.batch([this.upsertState(id, userId, { timer: JSON.stringify(timer) })]);
    return timer;
  }

  /** 채점 결과로 그 사용자의 마지막 제출을 갱신한다 */
  async setLastSubmission(id: string, userId: string, sub: LastSubmission) {
    if (!(await this.exists(id))) return;
    await this.sql.batch([this.upsertState(id, userId, { last_submission: JSON.stringify(sub) })]);
  }

  /** 편집 권한자만. 모든 사용자의 작성 코드·풀이 시간도 함께 지워진다. */
  async delete(id: string): Promise<boolean> {
    return (await this.sql.run('DELETE FROM problems WHERE id = ?', id)).changes > 0;
  }
}

type FolderRow = { id: string; name: string; position: number; created_at: string };

/** 폴더: 사용자별 개인 정리. 문제는 사용자마다 폴더 하나에 들어간다(folder_items). 비회원에게는 틀 폴더를 보여 준다. */
export class FolderStore {
  constructor(private readonly sql: Sql) {}

  private toFolder(r: FolderRow): Folder {
    return { id: r.id, name: r.name, position: r.position, createdAt: r.created_at };
  }

  private one(id: string, userId: string) {
    return this.sql.get<FolderRow>('SELECT * FROM folders WHERE id = ? AND user_id = ?', id, userId);
  }

  async list(userId: string | null): Promise<Folder[]> {
    const rows = userId
      ? await this.sql.all<FolderRow>('SELECT * FROM folders WHERE user_id = ? ORDER BY position, name', userId)
      : await this.sql.all<FolderRow>('SELECT * FROM folders WHERE user_id IS NULL ORDER BY position, name');
    return rows.map((r) => this.toFolder(r));
  }

  async create(name: string, userId: string, now = new Date()): Promise<Folder> {
    const id = crypto.randomUUID();
    const position = (await this.sql.value<number>('SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE user_id = ?', userId)) ?? 0;
    try {
      await this.sql.run('INSERT INTO folders (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', id, userId, name, position, now.toISOString());
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 폴더가 있습니다.');
      throw e;
    }
    return this.toFolder((await this.one(id, userId))!);
  }

  async rename(id: string, name: string, userId: string): Promise<Folder | null> {
    try {
      if (!(await this.sql.run('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', name, id, userId)).changes) return null;
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 폴더가 있습니다.');
      throw e;
    }
    return this.toFolder((await this.one(id, userId))!);
  }

  /** 폴더를 지워도 문제는 남는다(폴더 없음). */
  async delete(id: string, userId: string): Promise<boolean> {
    return (await this.sql.run('DELETE FROM folders WHERE id = ? AND user_id = ?', id, userId)).changes > 0;
  }
}

type CollectionRow = { id: string; name: string; description: string; created_at: string; updated_at: string };

/**
 * 컬렉션: 모두가 같이 보는 공용 묶음(편집 권한자만 바꾼다). 문제를 옮기지 않는 가상 묶음이라 한 문제가 여러 컬렉션에 들어갈 수 있다.
 * 이름의 '/'는 계층이다(예: "모의고사/1회"). 화면이 이름으로 나무를 그린다.
 */
export class CollectionStore {
  constructor(private readonly sql: Sql) {}

  /** 컬렉션들의 문제 목록을 한 번에 읽는다(컬렉션마다 따로 묻지 않는다) */
  private async withItems(rows: CollectionRow[], where = '', ...params: Param[]): Promise<Collection[]> {
    const items = await this.sql.all<{ collection_id: string; problem_id: string }>(`SELECT collection_id, problem_id FROM collection_items ${where} ORDER BY collection_id, position`, ...params);
    const byCollection = new Map<string, string[]>();
    for (const i of items) byCollection.set(i.collection_id, [...(byCollection.get(i.collection_id) ?? []), i.problem_id]);
    return rows.map((r) => Collection.parse({ id: r.id, name: r.name, description: r.description, problemIds: byCollection.get(r.id) ?? [], createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async list(): Promise<Collection[]> {
    return this.withItems(await this.sql.all<CollectionRow>('SELECT * FROM collections ORDER BY name'));
  }

  async get(id: string): Promise<Collection | null> {
    const r = await this.sql.get<CollectionRow>('SELECT * FROM collections WHERE id = ?', id);
    return r ? (await this.withItems([r], 'WHERE collection_id = ?', id))[0]! : null;
  }

  /** 경로 이름 정리: 앞뒤·구분자 주변 공백과 빈 단계를 없앤다("a / /b" → "a/b") */
  static normalize(name: string): string {
    return name
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');
  }

  private async assertFree(name: string, exceptId?: string) {
    const hit = await this.sql.value<string>('SELECT id FROM collections WHERE name = ?', name);
    if (hit && hit !== exceptId) throw new StoreError('duplicate_name', '같은 이름의 컬렉션이 있습니다.');
  }

  async create(input: CollectionInput, now = new Date()): Promise<Collection> {
    const name = CollectionStore.normalize(input.name);
    if (!name) throw new StoreError('duplicate_name', '컬렉션 이름이 필요합니다.');
    await this.assertFree(name);
    const id = crypto.randomUUID();
    const ts = now.toISOString();
    await this.sql.run('INSERT INTO collections (id, user_id, name, description, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)', id, name, input.description, ts, ts);
    return (await this.get(id))!;
  }

  async update(id: string, input: CollectionInput, now = new Date()): Promise<Collection | null> {
    const name = CollectionStore.normalize(input.name);
    if (!name) throw new StoreError('duplicate_name', '컬렉션 이름이 필요합니다.');
    await this.assertFree(name, id);
    const r = await this.sql.run('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?', name, input.description, now.toISOString(), id);
    return r.changes ? this.get(id) : null;
  }

  /** 컬렉션의 문제 목록을 통째로 바꾼다(순서 포함). 중복 id는 처음 것만 남긴다. */
  async setItems(id: string, problemIds: string[], now = new Date()): Promise<Collection | null> {
    if ((await this.sql.value('SELECT 1 FROM collections WHERE id = ?', id)) === undefined) return null;
    const unique = [...new Set(problemIds)];
    if (unique.length) {
      const found = new Set(await this.sql.column<string>(`SELECT id FROM problems WHERE id IN (${unique.map(() => '?').join(', ')})`, ...unique));
      const missing = unique.find((pid) => !found.has(pid));
      if (missing) throw new StoreError('problem_not_found', `없는 문제입니다: ${missing}`);
    }
    await this.sql.batch([
      stmt('DELETE FROM collection_items WHERE collection_id = ?', id),
      ...unique.map((pid, i) => stmt('INSERT INTO collection_items (collection_id, problem_id, position) VALUES (?, ?, ?)', id, pid, i)),
      stmt('UPDATE collections SET updated_at = ? WHERE id = ?', now.toISOString(), id),
    ]);
    return this.get(id);
  }

  /** 컬렉션을 지워도 문제는 남는다. */
  async delete(id: string): Promise<boolean> {
    return (await this.sql.run('DELETE FROM collections WHERE id = ?', id)).changes > 0;
  }
}

type UserRow = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  role: 'user' | 'editor';
  terms_version: string;
  privacy_version: string;
  agreed_at: string;
  created_at: string;
  last_login_at: string;
};

export type GoogleProfile = { sub: string; email: string; name: string; picture: string };

export type User = { id: string; email: string; name: string; picture: string; editor: boolean };

/** 틀 폴더(user_id NULL)와 그 배치를 이 사용자의 개인 폴더로 복사하는 문(가입할 때) */
async function templateFolderCopies(sql: Sql, userId: string, now: Date): Promise<Stmt[]> {
  const templates = await sql.all<{ id: string; name: string; position: number }>('SELECT id, name, position FROM folders WHERE user_id IS NULL ORDER BY position');
  return templates.flatMap((t) => {
    const id = crypto.randomUUID();
    return [
      stmt('INSERT OR IGNORE INTO folders (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', id, userId, t.name, t.position, now.toISOString()),
      stmt('INSERT OR IGNORE INTO folder_items (user_id, problem_id, folder_id) SELECT ?, p.id, f.id FROM problems p JOIN folders f ON f.id = ? WHERE p.folder_id = ?', userId, id, t.id),
    ];
  });
}

/**
 * 사용자(Google 계정 1개 = 사용자 1명). 탈퇴하면 그 사용자의 작성 코드·컬렉션·제출이 모두 지워진다(ON DELETE CASCADE).
 * 편집 권한(role=editor)은 관리자 모드(마스터)에서 준다.
 */
export class UserStore {
  constructor(private readonly sql: Sql) {}

  private toUser(r: UserRow): User {
    return { id: r.id, email: r.email, name: r.name, picture: r.picture, editor: r.role === 'editor' };
  }

  async byGoogleSub(sub: string) {
    const r = await this.sql.get<UserRow>('SELECT * FROM users WHERE google_sub = ?', sub);
    return r ? this.toUser(r) : null;
  }

  async byId(id: string) {
    const r = await this.sql.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return r ? this.toUser(r) : null;
  }

  /** 동의를 받은 뒤 가입. 같은 Google 계정이 이미 있으면 그 사용자를 돌려준다. */
  async create(p: GoogleProfile, versions: { terms: string; privacy: string }, opts: { editor?: boolean } = {}, now = new Date()) {
    const existing = await this.byGoogleSub(p.sub);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const ts = now.toISOString();
    await this.sql.batch([
      stmt(
        `INSERT INTO users (id, google_sub, email, name, picture, role, terms_version, privacy_version, agreed_at, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, p.sub, p.email, p.name, p.picture, opts.editor ? 'editor' : 'user', versions.terms, versions.privacy, ts, ts, ts,
      ),
      // 새 사용자도 기본 폴더 구성(틀)으로 시작한다
      ...(await templateFolderCopies(this.sql, id, now)),
    ]);
    return (await this.byId(id))!;
  }

  /** 로그인할 때 Google의 최신 이메일·이름·사진으로 갱신 */
  async touch(id: string, p: GoogleProfile, now = new Date()) {
    await this.sql.run('UPDATE users SET email = ?, name = ?, picture = ?, last_login_at = ? WHERE id = ?', p.email, p.name, p.picture, now.toISOString(), id);
  }

  async setEditor(id: string, editor: boolean): Promise<User | null> {
    if (!(await this.sql.run('UPDATE users SET role = ? WHERE id = ?', editor ? 'editor' : 'user', id)).changes) return null;
    return this.byId(id);
  }

  /**
   * 소유자가 없는 예전 데이터(비밀번호 로그인 시절)를 이 사용자에게 넘긴다. 운영자 계정에만 쓴다.
   * 작성 코드·풀이 시간·채점 결과, 제출 기록. 넘긴 행 수를 돌려준다.
   */
  async claimLegacy(userId: string, now = new Date()): Promise<number> {
    const [moved, , claimed] = await this.sql.batch([
      stmt(
        `INSERT OR IGNORE INTO user_problems (user_id, problem_id, language, code, timer, last_submission, updated_at)
         SELECT ?, problem_id, language, code, timer, last_submission, ? FROM legacy_state`,
        userId,
        now.toISOString(),
      ),
      stmt('DELETE FROM legacy_state'),
      // 컬렉션은 공용(user_id NULL)이므로 넘겨받지 않는다
      stmt('UPDATE submissions SET user_id = ? WHERE user_id IS NULL', userId),
    ]);
    return moved!.changes + claimed!.changes;
  }

  private async summaries(where: string, ...args: Param[]): Promise<AdminUser[]> {
    const rows = await this.sql.all<UserRow & { solved: number; submission_count: number }>(
      `SELECT u.*,
         (SELECT COUNT(*) FROM user_problems s WHERE s.user_id = u.id AND json_extract(s.last_submission, '$.score') = 100) AS solved,
         (SELECT COUNT(*) FROM submissions x WHERE x.user_id = u.id) AS submission_count
       FROM users u ${where} ORDER BY u.created_at`,
      ...args,
    );
    return rows.map((r) => ({
      ...this.toUser(r),
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      solved: r.solved,
      submissions: r.submission_count,
    }));
  }

  /** 관리자 페이지: 사용자 목록과 간단한 현황 */
  list(): Promise<AdminUser[]> {
    return this.summaries('');
  }

  /** 관리자 페이지: 사용자 상세(문제별 풀이 현황, 최근 제출) */
  async detail(id: string): Promise<AdminUserDetail | null> {
    const [summary] = await this.summaries('WHERE u.id = ?', id);
    if (!summary) return null;
    const [r, problemRows, submissionRows] = await Promise.all([
      this.sql.get<UserRow>('SELECT terms_version, privacy_version, agreed_at FROM users WHERE id = ?', id),
      this.sql.all<{ problem_id: string; title: string; timer: string | null; last_submission: string | null; updated_at: string }>(
        `SELECT s.problem_id, p.title, s.timer, s.last_submission, s.updated_at FROM user_problems s JOIN problems p ON p.id = s.problem_id
         WHERE s.user_id = ? ORDER BY p.title`,
        id,
      ),
      this.sql.all<{ id: string; title: string | null; kind: 'run' | 'submit'; language: Language; status: string; score: number | null; created_at: string }>(
        `SELECT x.id, p.title, x.kind, x.language, x.status, x.score, x.created_at FROM submissions x LEFT JOIN problems p ON p.id = x.problem_id
         WHERE x.user_id = ? ORDER BY x.created_at DESC LIMIT 30`,
        id,
      ),
    ]);
    const problems = problemRows.map((x) => {
      const timer = parse<ProblemTimer>(x.timer) ?? EMPTY_TIMER;
      return {
        problemId: x.problem_id,
        title: x.title,
        score: parse<LastSubmission>(x.last_submission)?.score ?? null,
        elapsedMs: timer.elapsedMs,
        solvedMs: timer.solvedMs,
        updatedAt: x.updated_at,
      };
    });
    const recentSubmissions = submissionRows.map((x) => ({ id: x.id, problemTitle: x.title, kind: x.kind, language: x.language, status: x.status, score: x.score, createdAt: x.created_at }));
    return { ...summary, termsVersion: r!.terms_version, privacyVersion: r!.privacy_version, agreedAt: r!.agreed_at, problems, recentSubmissions };
  }

  /** 탈퇴: 사용자와 그 사용자의 작성 코드·컬렉션·제출·세션을 모두 지운다. */
  async delete(id: string): Promise<boolean> {
    return (await this.sql.run('DELETE FROM users WHERE id = ?', id)).changes > 0;
  }
}

/** 전체 신규 가입 정책. 기본값은 기존처럼 가입 허용이다. */
export class SignupSettingsStore {
  constructor(private readonly sql: Sql) {}

  async enabled(): Promise<boolean> {
    return (await this.sql.value<number>('SELECT enabled FROM signup_settings WHERE id = 1')) === 1;
  }

  async setEnabled(enabled: boolean) {
    await this.sql.run('UPDATE signup_settings SET enabled = ? WHERE id = 1', enabled ? 1 : 0);
  }
}
