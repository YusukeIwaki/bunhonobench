import type { Article } from './db/schema';

// Same escaping as ERB::Util.html_escape
export function h(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function excerpt(body: string, len = 120): string {
  return body.replace(/\n+/g, ' ').slice(0, len);
}

export function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function layout(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${h(title)} - 記事サイト (Bun)</title>
</head>
<body>
<header><h1>記事サイト (Bun+Hono+drizzle)</h1></header>
<main>
${inner}
</main>
<footer><p>benchmark test site</p></footer>
</body>
</html>
`;
}

export function renderList(articles: Article[]): string {
  const items = articles
    .map(
      (a) =>
        `<li><a href="/articles/${a.id}.html">${h(a.title)}</a> <span>${fmtTime(a.createdAt)}</span><p>${h(excerpt(a.body))}</p></li>`,
    )
    .join('\n');
  return layout(
    '記事一覧',
    `<h2>記事一覧 (${articles.length}件)</h2>\n<ul>\n${items}\n</ul>`,
  );
}

export function renderDetail(article: Article, latest: Article[]): string {
  const paras = h(article.body)
    .split('\n\n')
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const side = latest
    .map((a) => `<li><a href="/articles/${a.id}.html">${h(a.title)}</a></li>`)
    .join('\n');
  return layout(
    article.title,
    `<article>\n<h2>${h(article.title)}</h2>\n<p>${fmtTime(article.createdAt)}</p>\n<div>\n${paras}\n</div>\n</article>\n<aside>\n<h3>最新記事</h3>\n<ul>\n${side}\n</ul>\n</aside>\n<p><a href="/articles.html">一覧に戻る</a></p>`,
  );
}

export function renderNotFound(): string {
  return layout(
    'Not Found',
    '<h2>記事が見つかりません</h2>\n<p><a href="/articles.html">一覧に戻る</a></p>',
  );
}
