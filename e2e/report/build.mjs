#!/usr/bin/env node
// QA 보고서 생성: CI 아티팩트 → PR 댓글(comment.md) + A4 문서(report.html, <id>-v<version>.pdf) + 표지 이미지(댓글 미리보기)
//   node report/build.mjs --input <아티팩트 디렉터리> [--repo ..] [--out reports/qa] [--no-pdf]
// 입력 디렉터리: context.json(워크플로가 만든 PR·실행 정보), quality-report/, e2e/, smoke.json(머지 후)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadReport } from './model.mjs';
import { toHtml, toMarkdown } from './render.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const input = resolve(arg('input', 'reports/qa-input'));
const repo = resolve(arg('repo', '..'));
const out = resolve(arg('out', 'reports/qa'));
mkdirSync(out, { recursive: true });

const model = loadReport(input, repo);
const context = existsSync(join(input, 'context.json')) ? JSON.parse(readFileSync(join(input, 'context.json'), 'utf8')) : {};
const links = { run: context.run?.url, report: context.reportRunUrl };
const name = `${model.id}-v${model.version}`;

writeFileSync(join(out, 'comment.md'), toMarkdown(model, links));
const image = (path) => {
  const file = join(input, 'e2e', path);
  return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : null;
};
const html = toHtml(model, links, image);
writeFileSync(join(out, 'report.html'), html);
writeFileSync(join(out, 'verdict.json'), JSON.stringify({ id: model.id, version: model.version, name, kind: model.kind, verdict: model.verdict }, null, 2));

if (!process.argv.includes('--no-pdf')) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // 댓글에 띄울 표지: 화면용 여백을 준 A4 첫 쪽
    await page.addStyleTag({ content: '@media screen { body { padding: 20mm 18mm; } }' });
    const cover = await page.locator('.cover').boundingBox();
    await page.screenshot({ path: join(out, `${name}-cover.png`), clip: { x: 0, y: 0, width: 794, height: Math.ceil((cover?.y ?? 0) + (cover?.height ?? 1047) + 76) } });
    await page.addStyleTag({ content: '@media screen { body { padding: 0; } }' });
    const small = 'font-size:7pt;color:#555;font-family:\'Noto Sans CJK KR\',\'Apple SD Gothic Neo\',sans-serif;width:100%;padding:0 18mm;display:flex;justify-content:space-between;';
    await page.pdf({
      path: join(out, `${name}.pdf`),
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="${small}"><span>${model.id} · 테스트 완료 보고서</span><span>Solveline</span></div>`,
      footerTemplate: `<div style="${small}"><span>v${model.version}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await browser.close();
  }
}
console.log(`${model.id}: ${model.verdict.label} → ${out}`);
