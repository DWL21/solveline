import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

function render(markdown) {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkBreaks], skipHtml: true }, markdown),
  );
}

test('Markdown renders headings, preserved line breaks, tables, code, and links', () => {
  const html = render('# 문제 제목\n\n첫 줄\n둘째 줄\n\n| 입력 | 출력 |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(1)\n```\n\n[문서](https://example.com)');

  assert.match(html, /<h1>문제 제목<\/h1>/);
  assert.match(html, /첫 줄<br\/>\s*둘째 줄/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code class="language-python">print\(1\)\n<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example\.com">문서<\/a>/);
});

test('raw HTML is not rendered and unsafe links are not kept', () => {
  const html = render('<script>alert(1)</script>\n\n[위험](javascript:alert(1))');

  assert.doesNotMatch(html, /<script|javascript:/i);
});
