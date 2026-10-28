import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeNarrative, problemName } from './curriculum-copy.mjs';

export const STAGES = ['기초 구현', '핵심 유형', '실전 기본', '실전 응용', '복합 심화', '고난도 확장'];
const ROOT = '기업 코테 대비';
const TOPICS = ['구현', '문자열', '정렬', '수학', '완전탐색', '스택·큐', '해시·힙', '누적 합', '투 포인터', '그리디', '이분탐색', '그래프 탐색', '백트래킹', '동적 계획법', '분할정복', '트리', '최단거리', '분리집합', '최소 스패닝 트리', '위상정렬', '트리 DP', '트라이', '시뮬레이션'];
const TOPIC_ALIASES = { '스택/큐': '스택·큐', 자료구조: '스택·큐', 자료구조2: '해시·힙', 해시: '해시·힙', 그래프: '그래프 탐색', DP: '동적 계획법', '동적계획법 1': '동적 계획법', '동적계획법 2': '동적 계획법', '트리 디피': '트리 DP' };
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (name) => {
  const h = fingerprint(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const textState = (p) => ({ title: p.title, description: p.description });
const collectionState = (c) => ({ name: c.name, description: c.description, problemIds: c.problemIds });
const pad = (n) => String(n).padStart(2, '0');
const stageName = (n) => `${n}단계 · ${STAGES[n - 1]}`;
const banned = /올리브\s*영|olive\s*young|프로그래머스|programmers(?:\.co\.kr)?/i;

export function classify(problem, folders) {
  let topic = folders.get(problem.folderId);
  if (topic === '기존 추천 목록') {
    const algorithms = problem.description.match(/^알고리즘:\s*(.*)$/m)?.[1] ?? '';
    topic = /트라이/.test(algorithms) ? '트라이' : /트리/.test(algorithms) ? '트리' : /그래프/.test(algorithms) ? '그래프 탐색' : '구현';
  }
  if (!topic && problem.id === '19847acd-abff-442f-bc56-44c0a57807ed') topic = '완전탐색';
  topic = TOPIC_ALIASES[topic] ?? topic;
  if (!TOPICS.includes(topic)) throw new Error(`유형을 직접 지정해야 합니다: ${problem.id}`);
  const tier = problem.description.match(/^난이도:\s*(Bronze|Silver|Gold|Platinum|Diamond|Ruby)\s*(\d)/m);
  let stage, rank;
  if (tier) {
    const [, group, levelText] = tier;
    const level = Number(levelText);
    rank = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ruby'].indexOf(group) * 5 + 6 - level;
    stage = group === 'Bronze' ? 1 : group === 'Silver' ? (level >= 3 ? 2 : 3) : group === 'Gold' ? (level === 5 ? 3 : level >= 3 ? 4 : 5) : 6;
    // 최단경로·배낭·위상정렬은 기초 자료구조와 그래프를 먼저 익힌 뒤 푼다.
    if (group === 'Gold' && level === 5 && /데이크스트라|다익스트라|벨만|플로이드|배낭|위상 정렬|0.?1 너비/.test(problem.description.match(/^알고리즘:.*$/m)?.[0] ?? '')) stage = 4;
  } else if (problem.id === 'boj-6416') {
    stage = 3; rank = 10;
  } else {
    const lv = Number(problem.title.match(/Lv(\d)/)?.[1] ?? (problem.id === '19847acd-abff-442f-bc56-44c0a57807ed' ? 1 : 0));
    stage = { 1: 1, 2: 3, 3: 4 }[lv];
    if (!stage) throw new Error(`단계를 직접 지정해야 합니다: ${problem.id}`);
    rank = { 1: 3, 2: 10, 3: 14 }[lv];
  }
  const name = problemName(problem.title.replace(/^\d+\.\s*/, '').replace(/\s*\(Lv\d+·[^)]+\)\s*$/, '').trim(), problem.id);
  return { stage, topic, rank, name };
}

export function editDescription(problem, info) {
  let text = problem.description
    .replace(/^난이도:.*\n?/m, '')
    .replace(/^알고리즘:.*\n?/m, '')
    .replace(/^\[[^\n]*·\s*Lv\d+\][^\n]*\n?/, '')
    .replace(/^원문:\s*https?:\/\/[^\n]*programmers[^\n]*\n?/gim, '')
    .replace(/올리브영 온라인몰/g, '온라인몰')
    .replace(/올리브\s*영|olive\s*young/gi, '온라인 쇼핑 서비스')
    .replace(/프로그래머스|programmers(?:\.co\.kr)?/gi, '기업 코테 연습')
    .replace(/구하는 프로그램을 작성하시오\./g, '구해 반환하는 solution 함수를 완성해 주세요.')
    .replace(/프로그램을 작성하시오\./g, 'solution 함수를 완성해 주세요.')
    .replace(/프로그램을 작성해보자\./g, 'solution 함수를 완성해 주세요.')
    .replace(/\[그림(?: · [^:\]\n]*)?: (https?:\/\/[^\]\s]+)\]/g, '![문제 이해를 위한 그림]($1)')
    .replace(/^※ 코드 실행은 위 예시로, 제출 후 채점은 히든 케이스로 합니다\.\s*$/m, '')
    .trim();
  if (problem.id === 'boj-14945') text = text.replace('나무 높이 n (1..1000)', '직각삼각형 바닥의 높이 n (1..1000)').replace('불장난 결과의 수 modulo 10007', '두 사람이 모두 안전하게 탈출하는 경우의 수를 10007로 나눈 나머지');
  if (problem.id === 'boj-15724') text = text.replace('N×M 일별 인구 배열', 'N×M 각 칸의 인구 배열');
  if (problem.id === 'boj-1553') text = text.replace('위와 같이 총 28가지가 있다.', '각 칸의 수는 0부터 6까지이다. 순서를 구별하지 않는 모든 쌍 (a, b), 0 ≤ a ≤ b ≤ 6으로 이루어진 도미노 28종을 각각 한 개씩 사용한다.');
  if (problem.mode === 'function') text = normalizeNarrative(text, problem.id);
  text = text.replace(/^(문제 설명|함수 설명|매개변수|반환값|제한\s?사항|입출력 예(?: #\d+)?|예제 \d+)\s*$/gm, '## $1');
  if (!text.startsWith('## 문제 설명')) text = `## 문제 설명\n\n${text}`;
  return `${info.stage}단계 · ${pad(info.set)}세트 · ${info.position}/${info.size}\n\n${text}\n`;
}

export function buildPlan(catalog) {
  const folders = new Map(catalog.folders.map((f) => [f.id, f.name]));
  const classified = catalog.problems.map((p) => ({ problem: p, ...classify(p, folders) }));
  const problems = [], collections = [], stages = [];
  const oldByName = new Map(catalog.collections.map((c) => [c.name, c]));
  const addCollection = (name, description, problemIds = [], prior) => {
    if (description.length > 2000 || name.length > 200 || problemIds.length > 1000) throw new Error(`컬렉션 계약 초과: ${name}`);
    const current = { id: prior?.id ?? identity(name), name, description, problemIds };
    collections.push({ ...current, beforeHash: prior ? fingerprint(collectionState(prior)) : null });
    return current;
  };
  addCollection(ROOT, '', [], oldByName.get('올리브영 50제'));
  for (let stage = 1; stage <= STAGES.length; stage++) {
    const prefix = `${ROOT}/${stageName(stage)}`;
    const groups = TOPICS.map((topic) => classified.filter((p) => p.stage === stage && p.topic === topic)).filter((g) => g.length);
    const prior = oldByName.get({ 1: '올리브영 50제/Lv1', 3: '올리브영 50제/Lv2', 4: '올리브영 50제/Lv3' }[stage]);
    const stageSets = [];
    let set = 0;
    for (const group of groups) {
      group.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.problem.id.localeCompare(b.problem.id));
      const count = Math.ceil(group.length / 5);
      const small = Math.floor(group.length / count), extra = group.length % count;
      let offset = 0;
      for (let index = 0; index < count; index++) {
        const members = group.slice(offset, offset + small + (index < extra ? 1 : 0));
        offset += members.length; set++;
        const setName = `${prefix}/${pad(set)}세트 · ${group[0].topic}`;
        const entries = members.map((p, i) => {
          const info = { stage, topic: p.topic, set, position: i + 1, size: members.length, setName, name: p.name };
          const edited = { title: `${p.name} (${stage}단계·${p.topic})`, description: editDescription(p.problem, info) };
          const patch = { id: p.problem.id, ...info, beforeHash: fingerprint(textState(p.problem)), ...edited };
          problems.push(patch);
          return patch;
        });
        stageSets.push(addCollection(setName, '', entries.map((p) => p.id)));
      }
    }
    const count = stageSets.reduce((sum, s) => sum + s.problemIds.length, 0);
    if (count) {
      addCollection(prefix, '', [], prior);
      stages.push({ stage, name: stageName(stage), sets: set, problems: count });
    }
  }
  const mockOrder = [1, 2, 3, 4, 7, 5, 6, 8];
  const byId = new Map(problems.map((p) => [p.id, p]));
  const oldMocks = catalog.collections.filter((c) => /^모의고사\//.test(c.name));
  oldMocks.sort((a, b) => mockOrder.indexOf(Number(a.name.match(/\/(\d+)/)?.[1])) - mockOrder.indexOf(Number(b.name.match(/\/(\d+)/)?.[1])));
  if (oldMocks.length) addCollection('실전 모의고사', '세트당 180분');
  oldMocks.forEach((mock, i) => {
    const entries = mock.problemIds.map((id) => byId.get(id));
    if (entries.some((p) => !p)) throw new Error(`모의고사의 문제 누락: ${mock.id}`);
    addCollection(`실전 모의고사/${pad(i + 1)}세트 · ${i < 5 ? '실전 기본' : '실전 응용'}`, '180분', mock.problemIds, mock);
  });
  const retained = new Set(collections.map((c) => c.id));
  for (const c of catalog.collections) {
    if (retained.has(c.id)) continue;
    if (banned.test(c.name + c.description)) throw new Error(`기존 컬렉션의 편집을 직접 지정해야 합니다: ${c.id}`);
  }
  const ids = problems.map((p) => p.id);
  if (new Set(ids).size !== catalog.problems.length) throw new Error('문제 누락 또는 중복 배정');
  if (problems.some((p) => banned.test(p.title + p.description)) || collections.some((c) => banned.test(c.name + c.description))) throw new Error('제외할 명칭이 남아 있습니다.');
  return { format: 1, sourceCount: catalog.problems.length, stages, problems, collections };
}

export function report(plan) {
  return `# 기업 코테 대비 학습 과정\n\n총 ${plan.sourceCount}문제 · ${plan.stages.length}단계 · ${plan.stages.reduce((n, s) => n + s.sets, 0)}개 학습 세트 · 별도 실전 모의고사 8세트\n\n각 세트는 같은 유형의 문제를 최대 5개씩 담고, 기존 난이도와 선수 지식을 기준으로 쉬운 문제부터 배치한다. 단계는 학습 순서이며 공식 시험 난이도와 대응하지 않는다. 1~4단계는 핵심, 5단계는 심화, 6단계는 선택 확장이다.\n\n모든 문제의 최근 제출이 100점이면 세트를 클리어하고, 단계 안의 모든 세트를 클리어하면 해당 단계를 클리어한다. 단계 잠금 없이 자유롭게 풀 수 있다. 예제 실행만으로는 클리어하지 않는다.\n\n| 단계 | 세트 | 문제 |\n|---|---:|---:|\n${plan.stages.map((s) => `| ${s.name} | ${s.sets} | ${s.problems} |`).join('\n')}\n\n## 콘텐츠 편집\n\n전체 제목에서 과거 일련번호와 레벨 표기를 제거하고 단계·유형을 표시한다. 본문에는 단계·세트·문제 위치만 짧게 표시하고 기존 문제 설명·제약·예제의 의미를 유지한다. 컬렉션에는 반복 안내나 학습 규칙을 노출하지 않고 모의고사의 제한 시간만 표시한다. 그림 URL은 Markdown 이미지로 표시한다. 기존 기업명과 대상 연습 플랫폼 언급을 제거한다.\n\n명시 수정: 직각삼각형 탈출 문제의 높이·반환값 설명, 영역 인구 합 문제의 인구 배열 설명, 도미노 28종의 텍스트 정의를 보완한다. 문제 ID·함수 매개변수·반환 타입·시작 코드·보이는 예제·숨은 테스트셋과 사용자별 풀이 기록은 변경하지 않는다. 기존 컬렉션 12개는 ID를 보존하여 새 학습 단계와 실전 모의고사로 재편한다.\n\n## 반영 절차\n\n1. 익명 공개 API의 문제·기본 폴더·컬렉션만 읽어 catalog JSON을 준비한다.\n2. \`node scripts/curriculum.mjs plan <catalog.json> <plan.json> <report.md>\`로 편집안을 생성한다.\n3. 편집안과 검사 결과를 검토한 뒤 운영 컨테이너에서 \`node scripts/curriculum.mjs apply <database> <plan.json> <backup-dir>\`를 실행한다.\n4. 스크립트는 적용 직전 제목·본문·컬렉션이 계획 생성 시점과 같은지 확인하고, 공용 편집 필드만 백업한 뒤 한 트랜잭션으로 반영한다. 예상 밖 문제·개인 컬렉션·이름 충돌이 있으면 반영하지 않는다. 동일 계획의 재실행은 멱등이다.\n5. 공개 API로 전체 문제 수, 세트별 배정, 제외 명칭 잔존 여부와 채점 계약 보존을 재확인한다.\n\n## 전체 배정\n\n${plan.collections.filter((c) => c.problemIds.length).map((c) => `### ${c.name}\n\n${c.problemIds.map((id, i) => { const p = plan.problems.find((p) => p.id === id); return `${i + 1}. ${p.name} — \`${p.id}\``; }).join('\n')}\n`).join('\n')}`;
}

/** 제목·설명·공용 컬렉션만 수정한다. 사용자·제출·채점 데이터는 읽거나 수정하지 않는다. */
export function applyPlan(db, plan, backupDir) {
  if (plan.format !== 1) throw new Error('지원하지 않는 계획 형식');
  if (new Set(plan.problems.map((p) => p.id)).size !== plan.problems.length || new Set(plan.collections.map((c) => c.id)).size !== plan.collections.length || new Set(plan.collections.map((c) => c.name)).size !== plan.collections.length) throw new Error('계획에 중복 ID 또는 컬렉션 이름이 있습니다.');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  try {
    const rows = db.prepare('SELECT id, title, body FROM problems ORDER BY id').all();
    if (rows.length !== plan.sourceCount || rows.map((p) => p.id).join() !== plan.problems.map((p) => p.id).sort().join()) throw new Error('문제 목록이 계획과 다릅니다. 다시 생성하세요.');
    const byId = new Map(rows.map((p) => [p.id, p]));
    const backup = { format: 1, createdAt: new Date().toISOString(), problems: [], collections: [], newCollectionIds: [] };
    const changedProblems = [];
    for (const patch of plan.problems) {
      const row = byId.get(patch.id), body = JSON.parse(row.body);
      const current = { title: row.title, description: body.description };
      if (fingerprint(current) === fingerprint(textState(patch))) continue;
      if (fingerprint(current) !== patch.beforeHash) throw new Error(`편집 충돌: ${row.id}`);
      backup.problems.push({ id: row.id, ...current });
      changedProblems.push({ ...patch, body: JSON.stringify({ ...body, description: patch.description }) });
    }
    const changedCollections = [];
    for (const patch of plan.collections) {
      const row = db.prepare('SELECT id, user_id, name, description, created_at, updated_at FROM collections WHERE id = ?').get(patch.id);
      const nameOwner = db.prepare('SELECT id FROM collections WHERE name = ? AND id <> ? LIMIT 1').get(patch.name, patch.id);
      if (nameOwner) throw new Error(`컬렉션 이름 충돌: ${patch.name}`);
      if (row) {
        if (row.user_id !== null) throw new Error(`개인 컬렉션 편집 금지: ${patch.id}`);
        const problemIds = db.prepare('SELECT problem_id FROM collection_items WHERE collection_id = ? ORDER BY position').all(row.id).map((p) => p.problem_id);
        const current = { name: row.name, description: row.description, problemIds };
        if (fingerprint(current) === fingerprint(collectionState(patch))) continue;
        if (patch.beforeHash !== fingerprint(current)) throw new Error(`컬렉션 편집 충돌: ${patch.id}`);
        backup.collections.push({ id: row.id, ...current, createdAt: row.created_at, updatedAt: row.updated_at });
      } else {
        if (patch.beforeHash !== null) throw new Error(`기존 컬렉션이 사라졌습니다: ${patch.id}`);
        backup.newCollectionIds.push(patch.id);
      }
      changedCollections.push(patch);
    }
    let backupPath = null;
    if (changedProblems.length || changedCollections.length) {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      backupPath = resolve(backupDir, `curriculum-${Date.now()}.json`);
      writeFileSync(backupPath, JSON.stringify(backup), { mode: 0o600, flag: 'wx' });
      const ts = new Date().toISOString();
      for (const p of changedProblems) db.prepare('UPDATE problems SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(p.title, p.body, ts, p.id);
      for (const c of changedCollections) {
        db.prepare('INSERT INTO collections (id, user_id, name, description, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at').run(c.id, c.name, c.description, ts, ts);
        db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(c.id);
        for (const [position, id] of c.problemIds.entries()) db.prepare('INSERT INTO collection_items (collection_id, problem_id, position) VALUES (?, ?, ?)').run(c.id, id, position);
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('외래 키 검사 실패');
    db.exec('COMMIT');
    return { problems: changedProblems.length, collections: changedCollections.length, backupPath };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'plan' && first && second && third) {
    const plan = buildPlan(JSON.parse(readFileSync(first, 'utf8')));
    writeFileSync(second, JSON.stringify(plan, null, 2));
    writeFileSync(third, report(plan));
    console.log(JSON.stringify({ problems: plan.sourceCount, stages: plan.stages, collections: plan.collections.length, planHash: fingerprint(plan) }));
  } else if (command === 'apply' && first && second && third) {
    const db = new DatabaseSync(first);
    try { console.log(JSON.stringify(applyPlan(db, JSON.parse(readFileSync(second, 'utf8')), third))); }
    finally { db.close(); }
  } else {
    throw new Error('사용법: curriculum.mjs plan <catalog.json> <plan.json> <report.md> | apply <database> <plan.json> <backup-dir>');
  }
}
