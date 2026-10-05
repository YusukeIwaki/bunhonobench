#!/usr/bin/env bun
// Parallel-access benchmark: Ruby+Sinatra+ActiveRecord vs Bun+Hono+drizzle.
// Usage: bun bench/bench.mjs [--detail-levels 1,10,50,100,200] [--list-levels 1,10,50]
//
// Both targets receive the *identical* request sequence per level (seeded RNG),
// so the comparison is fair. Targets are measured sequentially to avoid interference.

const RUBY = process.env.RUBY_URL ?? 'http://127.0.0.1:4567';
const BUN = process.env.BUN_URL ?? 'http://127.0.0.1:3000';
const ARTICLE_COUNT = 500;
const DETAIL_REQS = 3000;
const LIST_REQS = 500;
const WARMUP_REQS = 300;
const WARMUP_CONCURRENCY = 10;
const TIMEOUT_MS = 30000;

function parseArgs() {
  const out = { detailLevels: [1, 10, 50, 100, 200], listLevels: [1, 10, 50] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(detail|list)-levels(?:=(.+))?$/.exec(argv[i]);
    if (!m) continue;
    const val = m[2] ?? argv[++i] ?? '';
    out[m[1] === 'detail' ? 'detailLevels' : 'listLevels'] = val
      .split(',')
      .map(Number)
      .filter((n) => n > 0);
  }
  return out;
}

// Deterministic PRNG so both stacks get the same sequence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function detailPaths(n, seed) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => `/articles/${1 + Math.floor(rand() * ARTICLE_COUNT)}.html`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkHealth(base, label) {
  const res = await fetch(`${base}/articles/13.html`);
  const body = await res.text();
  if (res.status !== 200 || !body.includes('ベンチマーク記事 13')) {
    throw new Error(`${label} health check failed: status=${res.status}`);
  }
  console.log(`  ${label} OK (${base})`);
}

async function runLevel(base, paths, concurrency) {
  const latencies = new Array(paths.length);
  let errors = 0;
  let completed = 0;
  const statusHist = {};
  const queue = paths.map((p, i) => i);
  const start = performance.now();

  async function worker() {
    while (queue.length > 0) {
      const idx = queue.pop();
      const t0 = performance.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}${paths[idx]}`, { signal: ctrl.signal });
        clearTimeout(timer);
        const buf = await res.arrayBuffer();
        statusHist[res.status] = (statusHist[res.status] ?? 0) + 1;
        if (res.status !== 200 || buf.byteLength < 500) errors++;
        latencies[idx] = performance.now() - t0;
      } catch {
        statusHist.EXC = (statusHist.EXC ?? 0) + 1;
        errors++;
        latencies[idx] = performance.now() - t0;
      }
      completed++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedSec = (performance.now() - start) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  return {
    concurrency,
    requests: paths.length,
    elapsedSec: +elapsedSec.toFixed(2),
    reqPerSec: +(paths.length / elapsedSec).toFixed(1),
    avgMs: +avg.toFixed(2),
    p50Ms: +pct(50).toFixed(2),
    p95Ms: +pct(95).toFixed(2),
    p99Ms: +pct(99).toFixed(2),
    maxMs: +pct(100).toFixed(2),
    errors,
    statusHist,
    completed,
  };
}

function printTable(title, rubyRows, bunRows) {
  console.log(`\n## ${title}`);
  const head = '| conc | Ruby req/s | Bun req/s | Ruby p50 | Bun p50 | Ruby p95 | Bun p95 | Ruby p99 | Bun p99 | Ruby err | Bun err |';
  console.log(head);
  console.log('|' + '---:|'.repeat(10));
  for (let i = 0; i < rubyRows.length; i++) {
    const r = rubyRows[i];
    const b = bunRows[i];
    console.log(
      `| ${r.concurrency} | ${r.reqPerSec} | ${b.reqPerSec} | ${r.p50Ms}ms | ${b.p50Ms}ms | ${r.p95Ms}ms | ${b.p95Ms}ms | ${r.p99Ms}ms | ${b.p99Ms}ms | ${r.errors} | ${b.errors} |`,
    );
  }
}

async function measureScenario(name, makePaths, levels, totalReqs) {
  console.log(`\n=== Scenario: ${name} ===`);
  console.log('Health checks:');
  await checkHealth(RUBY, 'Ruby');
  await checkHealth(BUN, 'Bun');

  const seeds = levels.map((_, i) => 1000 + i * 7919);
  const rubyRows = [];
  const bunRows = [];

  for (const target of [
    { label: 'Ruby', base: RUBY, rows: rubyRows },
    { label: 'Bun', base: BUN, rows: bunRows },
  ]) {
    console.log(`\n-- warmup ${target.label} (${WARMUP_REQS} reqs, c=${WARMUP_CONCURRENCY}) --`);
    await runLevel(target.base, makePaths(WARMUP_REQS, 42), WARMUP_CONCURRENCY);
    await sleep(500);
    for (let i = 0; i < levels.length; i++) {
      const c = levels[i];
      process.stdout.write(`${target.label} c=${c} ... `);
      const row = await runLevel(target.base, makePaths(totalReqs, seeds[i]), c);
      target.rows.push(row);
      console.log(`${row.reqPerSec} req/s, p50=${row.p50Ms}ms p95=${row.p95Ms}ms p99=${row.p99Ms}ms err=${row.errors}`);
      await sleep(500);
    }
  }
  printTable(name, rubyRows, bunRows);
  return { ruby: rubyRows, bun: bunRows };
}

async function versions() {
  const run = async (cmd) => {
    try {
      const p = Bun.spawnSync(cmd);
      return new TextDecoder().decode(p.stdout).trim().split('\n')[0] ?? '';
    } catch {
      return 'unknown';
    }
  };
  // Resolve gems from Gemfile.lock (repo root) so the app's Ruby is reported,
  // not whatever `ruby` happens to be on PATH.
  const lock = await Bun.file('ruby-app/Gemfile.lock').text().catch(() => '');
  const gemVer = (name) => lock.match(new RegExp(`^    ${name} \\(([^)]+)\\)`, 'm'))?.[1] ?? 'unknown';
  const nodeVer = async (pkg) => {
    try {
      return (await Bun.file(`bun-app/node_modules/${pkg}/package.json`).json()).version;
    } catch {
      return 'unknown';
    }
  };
  return {
    ruby: (await run(['sh', '-c', 'cd ruby-app && ruby -v'])) || 'unknown',
    gems: {
      sinatra: gemVer('sinatra'),
      activerecord: gemVer('activerecord'),
      puma: gemVer('puma'),
      pg: gemVer('pg'),
    },
    bun: `Bun ${Bun.version}`,
    npm: {
      hono: await nodeVer('hono'),
      'drizzle-orm': await nodeVer('drizzle-orm'),
      pg: await nodeVer('pg'),
    },
    os: `${process.platform} ${process.arch}`,
    cpu: (await run(['sysctl', '-n', 'machdep.cpu.brand_string'])) || 'unknown',
  };
}

const { detailLevels, listLevels } = parseArgs();
console.log(`Targets: Ruby=${RUBY} Bun=${BUN}`);
console.log(`Detail levels: [${detailLevels}] x${DETAIL_REQS}reqs  List levels: [${listLevels}] x${LIST_REQS}reqs`);

const detail = await measureScenario(
  'detail: GET /articles/{id}.html (random id, 2 queries)',
  detailPaths,
  detailLevels,
  DETAIL_REQS,
);
const list = await measureScenario(
  'list: GET /articles.html (500 rows, ~234KB)',
  (n) => Array.from({ length: n }, () => '/articles.html'),
  listLevels,
  LIST_REQS,
);

const result = {
  at: new Date().toISOString(),
  ruby: RUBY,
  bun: BUN,
  versions: await versions(),
  detail,
  list,
};
await Bun.write(`bench/results/${Date.now()}.json`, JSON.stringify(result, null, 2));
console.log('\nSaved JSON to bench/results/');
