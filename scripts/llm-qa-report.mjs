// LLM QA(0010)의 Actions 쪽: 요청서를 만들고, pahidc가 돌려준 결과를 PR 댓글·커밋 상태 llm-qa·실패 이슈로 올린다.
//   node scripts/llm-qa-report.mjs decide <pr.json>             대상 판정(policy.json)   → GITHUB_OUTPUT에 action=run|not-applicable|skip, reason
//   node scripts/llm-qa-report.mjs request <request.json>       env: REPO PR SHA
//   node scripts/llm-qa-report.mjs status <state> <설명>         env: REPO SHA RUN_URL
//   node scripts/llm-qa-report.mjs report <결과 폴더> <request.json>  env: REPO PR SHA RUN_URL SHOTS_BASE [LLM_QA_DRY_RUN=1]
// 요청서·결과의 글(PR 본문, 모델이 쓴 글)은 신뢰하지 않는 입력이다. 셸에 넣지 않고, 올릴 때는 멘션·자동 연결을 끊고 길이를 자른다.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- llm-qa -->';
export const MAX_ISSUES = 5;
export const POLICY = JSON.parse(readFileSync(new URL('./llm-qa/policy.json', import.meta.url), 'utf8'));
const VERDICT = { pass: '✓ 통과', fail: '✗ 실패', blocked: '– 확인 못 함' };

/** `*.md`처럼 파일 이름 끝만 보는 간단한 패턴 */
const matches = (file, pattern) => (pattern.startsWith('*') ? file.endsWith(pattern.slice(1)) : file === pattern);

/** 화면·API 동작에 닿는 변경인지(문서·워크플로만 바꾼 PR은 대상 아님) */
export const relevant = (files, policy = POLICY) =>
  files.some((f) => policy.appPaths.some((p) => f.startsWith(p)) && !policy.ignorePaths.some((p) => matches(f, p)));

/**
 * LLM QA를 돌릴지 정한다(0010). 규칙은 scripts/llm-qa/policy.json.
 *   run            pahidc QA를 부른다
 *   not-applicable 상태를 success("대상 아님")로만 단다
 *   skip           아무것도 하지 않는다(상태도 달지 않음)
 * 손 실행(manual)은 쓰기 권한이 있는 사람만 할 수 있어 작성자·레이블·경로를 보지 않는다.
 */
export function decide(pr, policy = POLICY) {
  if (pr.state !== 'open') return { action: 'skip', reason: '열린 PR이 아닙니다' };
  if (pr.manual) return { action: 'run', reason: '손으로 실행했습니다' };
  if (pr.ciConclusion !== 'success') return { action: 'skip', reason: 'CI가 성공하지 않았습니다' };
  if (pr.headSha !== pr.ciSha) return { action: 'skip', reason: 'PR에 더 새 커밋이 있습니다(새 커밋의 CI가 다시 판정)' };
  const trusted = policy.trustedAuthors.includes(pr.authorAssociation) || pr.labels.includes(policy.allowLabel);
  if (!trusted) return { action: 'skip', reason: `신뢰된 작성자가 아니고 ${policy.allowLabel} 레이블이 없습니다` };
  if (!relevant(pr.files, policy)) return { action: 'not-applicable', reason: '대상 아님(화면·API 코드 변경 없음)' };
  return { action: 'run', reason: '화면·API 코드를 바꾼 신뢰된 PR입니다' };
}

/** 모델·PR 글: @멘션과 #숫자 자동 연결을 끊고, 표·HTML을 깨지 않게 다듬고, 길이를 자른다 */
export function safe(text, max = 600) {
  const s = String(text ?? '')
    .replace(/@/g, '@​')
    .replace(/#(\d)/g, '#​$1')
    .replace(/</g, '&lt;')
    .replace(/\r/g, '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
const cell = (s, max) => safe(s, max).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const quote = (s, max) => safe(s, max).split('\n').map((l) => `> ${l}`).join('\n');

/** 본문에서 `## 제목` 절만 꺼낸다 */
export function section(markdown, title) {
  const m = new RegExp(`^##\\s*${title}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(markdown ?? '');
  return m ? m[1].trim() : '';
}

/** PR·연결 이슈로 요청서를 만든다. 완료 기준은 이슈의 `## 완료 기준`, 변경 사항은 PR의 `## 변경 사항`(없으면 본문 앞부분) */
export function buildRequest({ pr, sha, title, body, files, issues }) {
  const criteria = issues.flatMap((i) =>
    section(i.body, '완료 기준')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*(\[.\]\s*)?/, '').trim())
      .filter(Boolean)
      .map((c) => `#${i.number}: ${c}`),
  );
  const changes = (section(body, '변경 사항') || String(body ?? '')).replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().slice(0, 4000);
  return { pr, sha, title, changes, criteria: criteria.slice(0, 30), changedFiles: files.slice(0, 80), changedFileCount: files.length };
}

export function counts(result) {
  const c = { pass: 0, fail: 0, blocked: 0 };
  for (const s of result?.scenarios ?? []) c[s.verdict] = (c[s.verdict] ?? 0) + 1;
  return c;
}

/** 커밋 상태 값은 pending·success·failure·error 넷뿐이라, 확인 못 함은 success에 설명으로 구분한다(0010) */
export function status({ result, error }) {
  if (error) return { state: 'error', description: `오류: ${error}`.slice(0, 140) };
  const c = counts(result);
  const head = `통과 ${c.pass} · 실패 ${c.fail} · 확인 못 함 ${c.blocked}`;
  if (c.fail) return { state: 'failure', description: head };
  if (!c.pass && !c.blocked) return { state: 'error', description: '오류: 시나리오가 없습니다' };
  return { state: 'success', description: c.blocked ? `${head} — 댓글 확인` : head };
}

/** 모델이 근거로 적은 스크린샷 파일 이름을 보관 위치 링크로 바꾼다 */
export function linkShots(text, shotsBase) {
  const s = safe(text, 400);
  return shotsBase ? s.replace(/\b(page-[\w.-]+\.png)\b/g, `[$1](${shotsBase}/$1)`) : s;
}

export function fingerprint(pr, scenario) {
  const key = `${pr}|${String(scenario.title).replace(/\s+/g, ' ').trim()}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function comment({ result, error, meta = {}, pr, sha, runUrl, shotsBase, issues = [] }) {
  const lines = [MARKER, '## LLM QA', ''];
  const model = meta.model ? `${meta.model}·${meta.effort}` : '';
  const took = meta.seconds ? `${Math.round(meta.seconds / 6) / 10}분` : '';
  if (error) {
    lines.push(`**오류**: ${safe(error, 300)}`, '', `대상 \`${sha.slice(0, 7)}\` · [실행 기록](${runUrl})`);
    return lines.join('\n');
  }
  const c = counts(result);
  lines.push(`**통과 ${c.pass} · 실패 ${c.fail} · 확인 못 함 ${c.blocked}** · 대상 \`${sha.slice(0, 7)}\`${model ? ` · ${model}` : ''}${took ? ` · ${took}` : ''} · [실행 기록](${runUrl})`, '');
  if (c.blocked) lines.push(`> – 확인 못 한 시나리오 ${c.blocked}개가 있습니다. 사람이 확인해 주세요.`, '');
  if (result.summary) lines.push(quote(result.summary, 800), '');
  lines.push('| 결과 | 시나리오 | 확인한 기준 |', '|---|---|---|');
  for (const s of result.scenarios) lines.push(`| ${VERDICT[s.verdict] ?? s.verdict} | ${cell(s.title, 120)} | ${cell(s.criterion, 160)} |`);
  lines.push('');
  for (const s of result.scenarios.filter((x) => x.verdict !== 'pass')) {
    const issue = issues.find((i) => i.fingerprint === fingerprint(pr, s));
    lines.push(`### ${VERDICT[s.verdict]}: ${safe(s.title, 120)}${issue?.number ? ` (#${issue.number})` : ''}`, '');
    lines.push(...s.steps.map((x, i) => `${i + 1}. ${safe(x, 300)}`), '');
    lines.push(`- 기대: ${safe(s.expected, 400)}`, `- 실제: ${safe(s.actual, 400)}`);
    lines.push(...s.evidence.map((e) => `- 근거: ${linkShots(e, shotsBase)}`), '');
  }
  if (result.suggestions?.length) {
    lines.push('<details><summary>테스트 초안(사람이 골라 넣기)</summary>', '');
    for (const t of result.suggestions) lines.push(`**${safe(t.criterion, 200)}**`, '', '```ts', String(t.code).slice(0, 3000).replace(/```/g, "'''"), '```', '');
    lines.push('</details>', '');
  }
  lines.push('<sub>참고 체크입니다(필수 아님). 결과는 판단 근거로만 쓰고, 실패는 재현해 확인합니다. 0010 참고.</sub>');
  return lines.join('\n');
}

/** 실패 시나리오마다 이슈 본문(AGENTS.md 이슈 형식 + 재현 정보). 확인 못 함은 이슈로 만들지 않는다 */
export function issueDrafts({ result, request, meta = {}, runUrl, shotsBase }) {
  return (result?.scenarios ?? [])
    .filter((s) => s.verdict === 'fail')
    .slice(0, MAX_ISSUES)
    .map((s) => {
      const fp = fingerprint(request.pr, s);
      const title = `bug(qa): ${safe(s.title, 70).replace(/\n/g, ' ')} — PR #${request.pr} LLM QA 실패`;
      const body = [
        `<!-- llm-qa:${fp} -->`,
        '## 배경',
        '',
        `PR #${request.pr}(\`${request.sha.slice(0, 7)}\`)의 LLM QA에서 아래 시나리오가 실패했다. 자동으로 만든 이슈다. 재현을 확인해 고치거나, 오탐이면 \`qa:false-positive\`를 붙여 닫는다.`,
        '',
        '- 확인한 기준:',
        quote(s.criterion, 400),
        '- 환경: 테스트 환경(`compose.test.yaml`, 운영과 같은 이미지·보안 헤더), Chromium(headless) 1280×800, 편집 권한 테스트 계정, 예제 문제 6개',
        `- 판정: ${meta.model ?? 'LLM'}${meta.effort ? `·${meta.effort}` : ''}, [실행 기록](${runUrl})`,
        '',
        '## 재현 단계',
        '',
        ...s.steps.map((x, i) => `${i + 1}. ${safe(x, 400)}`),
        '',
        '## 기대 결과',
        '',
        quote(s.expected, 600),
        '',
        '## 실제 결과',
        '',
        quote(s.actual, 800),
        '',
        '## 근거',
        '',
        ...s.evidence.map((e) => `- ${linkShots(e, shotsBase)}`),
        '',
        '## 범위',
        '',
        '- 원인을 찾아 고치고, 같은 결함을 막는 테스트를 가장 낮은 층에 더한다(`docs/quality/guide.md`).',
        '',
        '## 완료 기준',
        '',
        '- 위 재현 단계에서 기대 결과가 나온다.',
        '- 재현 테스트가 CI에서 통과한다.',
        '',
        `관련 PR: #${request.pr}`,
      ].join('\n');
      return { fingerprint: fp, title, body };
    });
}

// ── GitHub 호출(gh CLI, 인자 배열로만 넘긴다) ──────────────────────────────
const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
const ghJson = (args) => JSON.parse(gh(args) || 'null');
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const need = (name) => process.env[name] || (() => { throw new Error(`환경 변수 ${name}가 없습니다.`); })();

function setStatus(repo, sha, { state, description }, runUrl) {
  gh(['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', 'context=llm-qa', '-f', `description=${description}`, '-f', `target_url=${runUrl}`]);
}

function upsertComment(repo, pr, body) {
  // --paginate는 쪽마다 따로 출력하므로 한 줄에 하나씩 받는다
  const user = process.env.LLM_QA_COMMENT_USER || 'github-actions[bot]';
  const ids = lines(gh(['api', '--paginate', `repos/${repo}/issues/${pr}/comments`, '--jq', `.[] | select(.user.login == "${user}" and (.body | startswith("${MARKER}"))) | .id`]));
  const payload = JSON.stringify({ body });
  if (ids.length) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${ids[0]}`, '--input', '-'], payload);
  else gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], payload);
}

function fileIssues(repo, sha, drafts, runUrl) {
  return drafts.map((d) => {
    const found = ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--label', 'qa:llm', '--search', `llm-qa:${d.fingerprint} in:body`, '--json', 'number,body']);
    const same = (found ?? []).find((i) => i.body.includes(`llm-qa:${d.fingerprint}`));
    if (same) {
      gh(['issue', 'comment', String(same.number), '-R', repo, '--body-file', '-'], `다시 실패: \`${sha.slice(0, 7)}\` · [실행 기록](${runUrl})`);
      return { ...d, number: same.number, created: false };
    }
    const url = gh(['issue', 'create', '-R', repo, '--title', d.title, '--label', 'bug', '--label', 'qa:llm', '--body-file', '-'], d.body).trim();
    return { ...d, number: Number(url.split('/').pop()), created: true };
  });
}

/** 이번에 통과한 시나리오가 예전에 올린 열린 이슈와 같으면 통과 댓글을 남긴다(닫기는 사람이) */
function notePassed(repo, pr, sha, result, runUrl) {
  for (const s of (result?.scenarios ?? []).filter((x) => x.verdict === 'pass')) {
    const fp = fingerprint(pr, s);
    const found = ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--label', 'qa:llm', '--search', `llm-qa:${fp} in:body`, '--json', 'number,body']);
    for (const i of (found ?? []).filter((x) => x.body.includes(`llm-qa:${fp}`))) {
      gh(['issue', 'comment', String(i.number), '-R', repo, '--body-file', '-'], `통과: \`${sha.slice(0, 7)}\` · [실행 기록](${runUrl})`);
    }
  }
}

function readOut(dir) {
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
  const error = read('error.txt')?.trim() || null;
  const raw = read('result.json');
  let result = null;
  if (!error) {
    try {
      result = JSON.parse(raw ?? '');
    } catch {
      return { error: '결과(result.json)를 읽지 못했습니다.', result: null, meta: {} };
    }
  }
  return { error: error ?? (raw ? null : '결과가 없습니다.'), result, meta: JSON.parse(read('meta.json') ?? '{}') };
}

async function main([cmd, ...args]) {
  if (cmd === 'request') {
    const [out] = args;
    const repo = need('REPO');
    const pr = Number(need('PR'));
    const p = ghJson(['api', `repos/${repo}/pulls/${pr}`]);
    const files = lines(gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename']));
    const linked = ghJson(['pr', 'view', String(pr), '-R', repo, '--json', 'closingIssuesReferences']).closingIssuesReferences ?? [];
    const issues = linked.map((i) => ghJson(['api', `repos/${repo}/issues/${i.number}`, '--jq', '{number, body}']));
    const req = buildRequest({ pr, sha: need('SHA'), title: p.title, body: p.body, files, issues });
    writeFileSync(out, JSON.stringify(req, null, 2));
    console.log(`요청서: 변경 파일 ${files.length}개, 완료 기준 ${req.criteria.length}개`);
  } else if (cmd === 'decide') {
    const [input] = args;
    const d = decide(JSON.parse(readFileSync(input, 'utf8')));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `action=${d.action}\nreason=${d.reason}\n`);
    console.log(`판정: ${d.action} — ${d.reason}`);
  } else if (cmd === 'status') {
    const [state, description] = args;
    setStatus(need('REPO'), need('SHA'), { state, description }, need('RUN_URL'));
  } else if (cmd === 'report') {
    const [dir, requestPath] = args;
    const repo = need('REPO');
    const sha = need('SHA');
    const runUrl = need('RUN_URL');
    const shotsBase = process.env.SHOTS_BASE || '';
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    const { result, error, meta } = readOut(dir);
    const drafts = error ? [] : issueDrafts({ result, request, meta, runUrl, shotsBase });
    const st = status({ result, error });
    if (process.env.LLM_QA_DRY_RUN === '1') {
      const outDir = join(dir, 'report');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'comment.md'), comment({ result, error, meta, pr: request.pr, sha, runUrl, shotsBase }));
      for (const d of drafts) writeFileSync(join(outDir, `issue-${d.fingerprint}.md`), `# ${d.title}\n\n${d.body}`);
      writeFileSync(join(outDir, 'status.json'), JSON.stringify(st));
      console.log(`(시험) 상태 ${st.state}: ${st.description} / 이슈 초안 ${drafts.length}개 → ${outDir}`);
      return;
    }
    const filed = fileIssues(repo, sha, drafts, runUrl);
    if (!error) notePassed(repo, request.pr, sha, result, runUrl);
    // 옛 커밋의 실행이 늦게 끝나면 댓글은 그대로 둔다(최신 커밋 결과만 보인다). 상태·이슈는 그 커밋 기준으로 단다
    const head = gh(['api', `repos/${repo}/pulls/${request.pr}`, '--jq', '.head.sha']).trim();
    if (head === sha) upsertComment(repo, request.pr, comment({ result, error, meta, pr: request.pr, sha, runUrl, shotsBase, issues: filed }));
    else console.log(`PR 최신 커밋(${head.slice(0, 7)})이 아니라 댓글은 고치지 않는다`);
    setStatus(repo, sha, st, runUrl);
    console.log(`상태 ${st.state}: ${st.description} / 이슈 새로 ${filed.filter((f) => f.created).length}개, 기존 ${filed.filter((f) => !f.created).length}개`);
  } else {
    console.error('사용법: decide <pr.json> | request <out> | status <state> <설명> | report <결과 폴더> <request.json>');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
