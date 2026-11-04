// QA 에이전트 루프(0011)의 Actions 쪽: 판정, 작업서, 패치 검사, PR 본문, 이슈 진행 댓글.
//   node scripts/qa-agent.mjs decide <issue.json>               → GITHUB_OUTPUT에 action=run|reject|skip, kind, reason
//   node scripts/qa-agent.mjs task <issue.json> <base SHA>      → 작업서 JSON(표준 출력)
//   node scripts/qa-agent.mjs check <patch.diff> <kind>         → GITHUB_OUTPUT에 ok=true|false, reason, files, lines
//   node scripts/qa-agent.mjs title <issue.json> <kind>          → 커밋·PR 제목
//   node scripts/qa-agent.mjs pr-body <issue.json> <결과 폴더>    → PR 본문(표준 출력), env: KIND RUN_URL
//   node scripts/qa-agent.mjs comment <state> [이유] [PR 주소] [브랜치] → 이슈 진행 댓글, env: RUN_URL
// 이슈 본문과 에이전트가 만든 패치는 신뢰하지 않는 입력이다. 이 모듈은 읽고 검사만 하고 실행하지 않는다.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY, safe } from './llm-qa-report.mjs';

export const MARKER = '<!-- qa-agent -->';

/** 이슈 레이블로 종류를 고른다(정책에 있는 종류만) */
export function kindOf(labels, policy = POLICY) {
  return Object.entries(policy.agent.kinds).find(([, k]) => k.labels.some((l) => labels.includes(l)))?.[0] ?? null;
}

/**
 * 에이전트를 돌릴지 정한다(0011). 규칙은 policy.json의 agent.
 *   run    pahidc에 fix를 부른다
 *   reject 이슈에 이유를 남기고 멈춘다(사람이 고칠 수 있는 이유)
 *   skip   아무것도 하지 않는다(다른 레이블 등)
 * 이슈는 누구나 열 수 있으므로, 쓰기 권한이 있는 사람이 qa:agent를 붙였을 때만 돈다.
 */
export function decideAgent(issue, policy = POLICY) {
  const a = policy.agent;
  if (issue.label !== a.label) return { action: 'skip', kind: null, reason: `${a.label} 레이블이 아닙니다` };
  if (issue.isPullRequest) return { action: 'skip', kind: null, reason: 'PR에는 붙이지 않습니다' };
  if (issue.state !== 'open') return { action: 'skip', kind: null, reason: '열린 이슈가 아닙니다' };
  if (!a.permissions.includes(issue.senderPermission)) return { action: 'skip', kind: null, reason: '레이블을 붙인 사람에게 쓰기 권한이 없습니다' };
  const kind = kindOf(issue.labels, policy);
  if (!kind) return { action: 'reject', kind: null, reason: `맡을 수 있는 종류가 아닙니다(레이블: ${Object.values(a.kinds).flatMap((k) => k.labels).join(', ')})` };
  return { action: 'run', kind, reason: `${kind} 이슈를 맡습니다` };
}

/** 작업서: 에이전트가 읽는 입력. 이슈 글은 길이를 자르고 그대로 넘긴다(지침이 데이터로 다룬다) */
export function buildTask(issue, baseSha, policy = POLICY) {
  const kind = kindOf(issue.labels, policy);
  return {
    issue: issue.number,
    kind,
    baseSha,
    title: String(issue.title).slice(0, 200),
    body: String(issue.body ?? '').slice(0, 12000),
    allowedPaths: policy.agent.kinds[kind]?.paths ?? [],
  };
}

const denied = (path, deny) => deny.some((d) => path.startsWith(d) || path.split('/').pop() === d);

/** git diff(텍스트)를 검사한다: 바꾼 파일이 종류별 허용 경로 안인지, 거부 목록·바이너리·크기 */
export function checkPatch(diff, kind, policy = POLICY) {
  const a = policy.agent;
  const allowed = a.kinds[kind]?.paths;
  if (!allowed) return { ok: false, reason: `모르는 종류입니다: ${kind}`, files: [], lines: 0 };
  if (!diff.trim()) return { ok: false, reason: '바꾼 것이 없습니다', files: [], lines: 0 };
  if (/^(GIT binary patch|Binary files )/m.test(diff)) return { ok: false, reason: '바이너리 파일은 받지 않습니다', files: [], lines: 0 };
  const files = new Set();
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(m[1]);
    files.add(m[2]);
  }
  const lines = diff.split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
  const list = [...files];
  if (!list.length) return { ok: false, reason: '패치 형식이 아닙니다', files: [], lines };
  const bad = list.find((f) => denied(f, a.deny) || !allowed.some((p) => f.startsWith(p)));
  if (bad) return { ok: false, reason: `바꿀 수 없는 경로입니다: ${bad} (허용: ${allowed.join(', ')})`, files: list, lines };
  if (list.length > a.maxFiles) return { ok: false, reason: `바꾼 파일이 너무 많습니다(${list.length}개, 최대 ${a.maxFiles})`, files: list, lines };
  if (lines > a.maxLines) return { ok: false, reason: `바꾼 줄이 너무 많습니다(${lines}줄, 최대 ${a.maxLines})`, files: list, lines };
  return { ok: true, reason: '검사 통과', files: list, lines };
}

/** 커밋·PR 제목: 저장소 규칙(Conventional Commits, 한국어 요약) */
export function title(issue, kind, policy = POLICY) {
  const k = policy.agent.kinds[kind];
  const summary = String(issue.title).replace(/^\w+(\([^)]*\))?:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 72);
  return `${k.commitType}(${k.commitScope}): ${summary}`;
}

const verdict = (v) => (v === 'pass' ? '✓ 통과' : v === 'fail' ? '✗ 실패' : v === 'skip' ? '– 건너뜀' : `– ${safe(v, 40)}`);

/** draft PR 본문: 저장소 PR 형식(변경 사항·검증·Closes) + 에이전트 요약·검증 결과 */
export function prBody({ issue, report, verify, check, runUrl }) {
  const L = [
    '> 🤖 QA 에이전트(0011)가 만든 PR입니다. **사람이 검토한 뒤 머지**합니다. 자동 머지하지 않습니다.',
    '',
    '## 변경 사항',
    '',
    safe(report?.summary ?? '(요약 없음)', 1500),
    '',
    ...(report?.changes ?? []).map((c) => `- \`${safe(c.file, 120)}\`: ${safe(c.what, 300)}`),
    '',
    '## 검증',
    '',
    '| 단계 | 결과 | 내용 |',
    '|---|---|---|',
    `| 패치 검사(경로·크기) | ${check.ok ? '✓ 통과' : '✗ 실패'} | ${check.files.length}개 파일, ${check.lines}줄 |`,
    ...(verify?.steps ?? []).map((s) => `| ${safe(s.name, 80)} | ${verdict(s.result)} | ${safe(s.detail ?? '', 200).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
    ...(report?.notes ? ['**에이전트 메모**', '', safe(report.notes, 1500), ''] : []),
    `[에이전트 실행 기록](${runUrl}) · 이 PR의 CI는 에이전트 워크플로가 시작한다(GITHUB_TOKEN으로 만든 PR은 CI를 자동으로 부르지 않는다).`,
    '',
    `Closes #${issue.number}`,
    '',
    '🤖 Generated with QA agent (Codex on pahidc)',
  ];
  return L.join('\n');
}

/** 이슈 진행 댓글(표식으로 하나만 갱신) */
export function issueComment({ state, reason = '', prUrl = '', branch = '', runUrl }) {
  const head = {
    start: '⏳ QA 에이전트가 작업을 시작했습니다.',
    done: `✓ draft PR을 열었습니다: ${prUrl}`,
    // PR을 자동으로 못 만들면(저장소 설정 등) 브랜치는 두고 사람이 한 번 눌러 열게 한다
    branch: `– 브랜치 \`${safe(branch, 80)}\`에 커밋하고 CI를 시작했지만 PR은 자동으로 만들지 못했습니다(${safe(reason, 300)}). [PR 만들기](${prUrl})`,
    failed: `✗ PR을 만들지 못했습니다: ${safe(reason, 500)}`,
    rejected: `– 맡지 않았습니다: ${safe(reason, 300)}`,
  }[state];
  return [MARKER, head, '', `[실행 기록](${runUrl})`].join('\n');
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const output = (pairs) => {
  const text = Object.entries(pairs).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
};

function main([cmd, ...args]) {
  if (cmd === 'decide') {
    const d = decideAgent(JSON.parse(readFileSync(args[0], 'utf8')));
    output({ action: d.action, kind: d.kind ?? '', reason: d.reason });
  } else if (cmd === 'task') {
    process.stdout.write(JSON.stringify(buildTask(JSON.parse(readFileSync(args[0], 'utf8')), args[1]), null, 2));
  } else if (cmd === 'check') {
    const c = checkPatch(readFileSync(args[0], 'utf8'), args[1]);
    output({ ok: c.ok, reason: c.reason, files: c.files.length, lines: c.lines });
  } else if (cmd === 'title') {
    process.stdout.write(title(JSON.parse(readFileSync(args[0], 'utf8')), args[1]));
  } else if (cmd === 'pr-body') {
    const [issuePath, dir] = args;
    const issue = JSON.parse(readFileSync(issuePath, 'utf8'));
    const c = checkPatch(readFileSync(join(dir, 'patch.diff'), 'utf8'), process.env.KIND);
    process.stdout.write(prBody({ issue, report: readJson(join(dir, 'report.json')), verify: readJson(join(dir, 'verify.json')), check: c, runUrl: process.env.RUN_URL }));
  } else if (cmd === 'comment') {
    const [state, reason = '', prUrl = '', branch = ''] = args;
    process.stdout.write(issueComment({ state, reason, prUrl, branch, runUrl: process.env.RUN_URL }));
  } else {
    console.error('사용법: decide <issue.json> | task <issue.json> <base> | check <patch> <kind> | title <issue.json> <kind> | pr-body <issue.json> <dir> | comment <state> [reason] [pr]');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
