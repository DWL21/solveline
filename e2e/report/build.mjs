#!/usr/bin/env node
// QA 보고서 생성: CI 아티팩트 → PR 댓글(comment.md) + A4 문서(report.html, report.pdf)
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

writeFileSync(join(out, 'comment.md'), toMarkdown(model, links));
const image = (path) => {
  const file = join(input, 'e2e', path);
  return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : null;
};
const html = toHtml(model, links, image);
writeFileSync(join(out, 'report.html'), html);
writeFileSync(join(out, 'verdict.json'), JSON.stringify({ id: model.id, kind: model.kind, verdict: model.verdict }, null, 2));

if (!process.argv.includes('--no-pdf')) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const small = 'font-size:7pt;color:#5f6b72;font-family:sans-serif;width:100%;padding:0 16mm;display:flex;justify-content:space-between;';
    await page.pdf({
      path: join(out, `${model.id}.pdf`),
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
