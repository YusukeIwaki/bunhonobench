import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from './db/client';
import { articles } from './db/schema';
import { renderDetail, renderList, renderNotFound } from './views';

const app = new Hono();

app.get('/', (c) => c.redirect('/articles.html', 302));

// List: 1 query (full rows, newest first)
app.get('/articles.html', async (c) => {
  const rows = await db.select().from(articles).orderBy(desc(articles.id));
  return c.html(renderList(rows));
});

// Detail: 2 queries (1 row by id + latest 5 for sidebar)
app.get('/articles/:name', async (c) => {
  const m = /^(\d+)\.html$/.exec(c.req.param('name'));
  if (!m) return c.html(renderNotFound(), 404);
  const id = Number(m[1]);
  const rows = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
  if (rows.length === 0) return c.html(renderNotFound(), 404);
  const latest = await db
    .select()
    .from(articles)
    .orderBy(desc(articles.id))
    .limit(5);
  return c.html(renderDetail(rows[0], latest));
});

app.notFound((c) => c.html(renderNotFound(), 404));

const port = Number(process.env.PORT ?? 3000);
console.log(`Bun+Hono listening on http://0.0.0.0:${port}`);

export default { port, fetch: app.fetch };
