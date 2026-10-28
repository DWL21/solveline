import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, buildPlan, classify, fingerprint } from './curriculum.mjs';
import { normalizeNarrative, problemName } from './curriculum-copy.mjs';

const sample = (id = 'p1') => ({ id, title: '01. 결제 금액 (Lv1·구현)', folderId: 'f1', description: '[구현 · Lv1] 시간 제한 2초 (테스트당)\n\n문제 설명\n올리브영 온라인몰 결제 금액을 반환하세요.\n\n제한 사항\n0 ≤ coupon ≤ 50\n\n입출력 예 #1\nreturn = 5400', mode: 'function', params: ['prices', 'coupon'], timeLimitMs: 2000 });
const catalog = (problems = [sample()]) => ({ problems, folders: [{ id: 'f1', name: '구현' }], collections: [{ id: 'old-root', name: '올리브영 50제', description: '기존 공용 컬렉션', problemIds: problems.map((p) => p.id) }] });

function fixture(t, source = catalog()) {
  const db = new DatabaseSync(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'solveline-curriculum-'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE problems (id TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at TEXT, mode TEXT, language TEXT);
    CREATE TABLE collections (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, description TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id,name));
    CREATE TABLE collection_items (collection_id TEXT REFERENCES collections(id), problem_id TEXT REFERENCES problems(id), position INTEGER, PRIMARY KEY(collection_id,problem_id));
    CREATE TABLE user_problems (user_id TEXT, problem_id TEXT, code TEXT, timer TEXT, last_submission TEXT);
    INSERT INTO user_problems VALUES ('user','p1','private draft','private timer','private submission');
    INSERT INTO collections VALUES ('private','user','個人','private description','before','before');`);
  for (const p of source.problems) db.prepare('INSERT INTO problems VALUES (?,?,?,?,?,?)').run(p.id, p.title, JSON.stringify({ description: p.description, params: p.params, code: { java: 'starter', python: 'starter' }, cases: [{ expected: '5400' }], hiddenTestset: { hash: 'untouched', count: 100 }, timeLimitMs: p.timeLimitMs }), 'before', p.mode, 'java');
  for (const c of source.collections) {
    db.prepare('INSERT INTO collections VALUES (?,NULL,?,?,?,?)').run(c.id, c.name, c.description, 'before', 'before');
    c.problemIds.forEach((id, i) => db.prepare('INSERT INTO collection_items VALUES (?,?,?)').run(c.id, id, i));
  }
  return { db, dir, plan: buildPlan(source) };
}

test('모든 문제를 한 학습 세트에 배정하고 작은 나머지도 고르게 나눈다', () => {
  const plan = buildPlan(catalog(Array.from({ length: 11 }, (_, i) => sample(`p${i}`))));
  const leaves = plan.collections.filter((c) => c.problemIds.length);
  assert.deepEqual(leaves.map((c) => c.problemIds.length), [4, 4, 3]);
  assert.equal(new Set(leaves.flatMap((c) => c.problemIds)).size, 11);
  assert.equal(plan.problems.length, 11);
  assert.equal(plan.collections.find((c) => c.id === 'old-root').name, '기업 코테 대비');
  assert.ok(plan.problems.every((p) => !/올리브영|프로그래머스|programmers/i.test(p.title + p.description)));
  assert.match(plan.problems[0].description, /0 ≤ coupon ≤ 50/);
  assert.match(plan.problems[0].description, /return = 5400/);
});

test('누락된 분류는 중단하고 미분류 트리는 명시 단계에 배정한다', () => {
  assert.throws(() => classify({ ...sample(), folderId: 'unknown' }, new Map()), /직접 지정/);
  const problem = { ...sample('boj-6416'), title: '6416. 트리인가?', description: '난이도: 미분류\n알고리즘: 트리, 그래프 이론\n문제 설명' };
  assert.equal(classify(problem, new Map([['f1', '트리']])).stage, 3);
  assert.equal(classify({ ...problem, id: 'boj-1916', description: '난이도: Gold 5\n알고리즘: 데이크스트라\n문제 설명' }, new Map([['f1', '최단거리']])).stage, 4);
});

test('동일 제목을 구별하고 문제의 내부 출력 동작은 보존한다', () => {
  assert.notEqual(problemName('토마토', 'boj-7569'), problemName('토마토', 'boj-7576'));
  const fibonacci = 'printf("0");\nfibonacci(0)은 0을 출력한다.\n호출 횟수를 구하는 프로그램을 작성하라.';
  const normalized = normalizeNarrative(fibonacci, 'boj-1003');
  assert.match(normalized, /printf\("0"\)/);
  assert.match(normalized, /fibonacci\(0\)은 0을 출력한다/);
  assert.match(normalized, /구해 반환하는 solution 함수/);
  assert.equal(normalizeNarrative('입력을 읽어서 각 사람의 덩치 등수를 계산하여 출력해야 한다', 'boj-7568'), '정보를 받아 각 사람의 덩치 등수를 계산해 반환해야 한다');
});

test('공용 제목·설명·컬렉션만 바꾸고 채점 계약·개인 풀이를 보존하며 재실행은 멱등이다', (t) => {
  const { db, dir, plan } = fixture(t);
  const before = JSON.parse(db.prepare('SELECT body FROM problems').get().body);
  const privateBefore = db.prepare('SELECT * FROM user_problems').all();
  const result = applyPlan(db, plan, dir);
  assert.equal(result.problems, 1);
  const after = JSON.parse(db.prepare('SELECT body FROM problems').get().body);
  delete before.description; delete after.description;
  assert.deepEqual(after, before);
  assert.deepEqual(db.prepare('SELECT * FROM user_problems').all(), privateBefore);
  assert.equal(db.prepare("SELECT description FROM collections WHERE id='private'").get().description, 'private description');
  const backup = readFileSync(result.backupPath, 'utf8');
  assert.ok(!backup.includes('private'));
  assert.equal(JSON.parse(backup).problems[0].title, sample().title);
  assert.deepEqual(applyPlan(db, plan, dir), { problems: 0, collections: 0, backupPath: null });
  assert.equal(readdirSync(dir).length, 1);
});

test('문제 편집 충돌이 있으면 컬렉션까지 전부 반영하지 않는다', (t) => {
  const { db, dir, plan } = fixture(t, catalog([sample('p1'), sample('p2')]));
  db.prepare('UPDATE problems SET title = ? WHERE id = ?').run('다른 편집자의 제목', 'p2');
  assert.throws(() => applyPlan(db, plan, dir), /편집 충돌/);
  assert.equal(db.prepare("SELECT title FROM problems WHERE id='p1'").get().title, sample().title);
  assert.equal(db.prepare("SELECT name FROM collections WHERE id='old-root'").get().name, '올리브영 50제');
  assert.equal(readdirSync(dir).length, 0);
});

test('계획 이후 추가된 문제가 있으면 재분류 전까지 반영하지 않는다', (t) => {
  const { db, dir, plan } = fixture(t);
  db.prepare('INSERT INTO problems (id,title,body) VALUES (?,?,?)').run('new', '추가 문제', '{}');
  assert.throws(() => applyPlan(db, plan, dir), /문제 목록/);
});

test('같은 이름의 다른 컬렉션과 개인 컬렉션 ID를 덮어쓰지 않는다', (t) => {
  const { db, dir, plan } = fixture(t);
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run('기업 코테 대비', 'old-root');
  // 같은 이름의 공용 컬렉션이 먼저 검색되더라도 다른 개인 행을 놓치지 않는다.
  db.prepare('INSERT INTO collections VALUES (?,?,?,?,?,?)').run('private2', 'another', '기업 코테 대비', 'private description', 'before', 'before');
  assert.throws(() => applyPlan(db, plan, dir), /컬렉션 이름 충돌/);
  const first = plan.collections[0];
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run('다른 이름', 'private2');
  first.id = 'private'; first.name = '個人'; first.beforeHash = fingerprint({ name: '個人', description: 'private description', problemIds: [] });
  assert.throws(() => applyPlan(db, plan, dir), /개인 컬렉션/);
});

test('계획 내부의 중복 컬렉션 이름 또는 ID도 반영 전에 거부한다', (t) => {
  const { db, dir, plan } = fixture(t);
  plan.collections.push({ ...plan.collections[0] });
  assert.throws(() => applyPlan(db, plan, dir), /중복 ID 또는 컬렉션 이름/);
  assert.equal(readdirSync(dir).length, 0);
});
