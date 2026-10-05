#!/usr/bin/env bun
// Parallel-access benchmark: Ruby+Sinatra+ActiveRecord vs Bun+Hono+drizzle vs Rust+axum+sqlx.
// Usage: bun bench/bench.mjs [--detail-levels 1,10,50,100,200] [--list-levels 1,10,50]
//
// Both targets receive the *identical* request sequence per level (seeded RNG),
// so the comparison is fair. Targets are measured sequentially to avoid interference.

const RUBY = process.env.RUBY_URL ?? 'http://127.0.0.1:4567';
const BUN = process.env.BUN_URL ?? 'http://127.0.0.1:3000';
const RUST = process.env.RUST_URL ?? 'http://127.0.0.1:8080';

const TARGETS = [
  { key: 'ruby', label: 'Ruby', base: RUBY },
  { key: 'bun', label: 'Bun', base: BUN },
  { key: 'rust', label: 'Rust', base: RUST },
];
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

function printTable(title, byKey) {
  console.log(`\n## ${title}`);
  const labels = TARGETS.map((t) => t.label);
  const head =
    `| conc | ${labels.map((l) => `${l} req/s`).join(' | ')} | ` +
    ['p50', 'p95', 'p99']
      .map((p) => labels.map((l) => `${l} ${p}`).join(' | '))
      .join(' | ') +
    ` | ${labels.map((l) => `${l} err`).join(' | ')} |`;
  console.log(head);
  console.log('|' + '---:|'.repeat(1 + labels.length * 5));
  const n = byKey[TARGETS[0].key].length;
  for (let i = 0; i < n; i++) {
    const rows = TARGETS.map((t) => byKey[t.key][i]);
    console.log(
      `| ${rows[0].concurrency} | ${rows.map((r) => r.reqPerSec).join(' | ')} | ` +
        ['p50Ms', 'p95Ms', 'p99Ms']
          .map((f) => rows.map((r) => `${r[f]}ms`).join(' | '))
          .join(' | ') +
        ` | ${rows.map((r) => r.errors).join(' | ')} |`,
    );
  }
}

async function measureScenario(name, makePaths, levels, totalReqs) {
  console.log(`\n=== Scenario: ${name} ===`);
  console.log('Health checks:');
  for (const t of TARGETS) await checkHealth(t.base, t.label);

  const seeds = levels.map((_, i) => 1000 + i * 7919);
  const byKey = Object.fromEntries(TARGETS.map((t) => [t.key, []]));

  for (const target of TARGETS) {
    console.log(`\n-- warmup ${target.label} (${WARMUP_REQS} reqs, c=${WARMUP_CONCURRENCY}) --`);
    await runLevel(target.base, makePaths(WARMUP_REQS, 42), WARMUP_CONCURRENCY);
    await sleep(500);
    for (let i = 0; i < levels.length; i++) {
      const c = levels[i];
      process.stdout.write(`${target.label} c=${c} ... `);
      const row = await runLevel(target.base, makePaths(totalReqs, seeds[i]), c);
      byKey[target.key].push(row);
      console.log(`${row.reqPerSec} req/s, p50=${row.p50Ms}ms p95=${row.p95Ms}ms p99=${row.p99Ms}ms err=${row.errors}`);
      await sleep(500);
    }
  }
  printTable(name, byKey);
  return byKey;
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
  const clock = await Bun.file('rust-app/Cargo.lock').text().catch(() => '');
  const cargoVer = (name) =>
    clock.match(new RegExp(`name = "${name}"\nversion = "([^"]+)"`))?.[1] ?? 'unknown';
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
    rustc: (await run(['rustc', '--version'])) || 'unknown',
    crates: {
      axum: cargoVer('axum'),
      sqlx: cargoVer('sqlx'),
      tokio: cargoVer('tokio'),
    },
    os: `${process.platform} ${process.arch}`,
    cpu: (await run(['sysctl', '-n', 'machdep.cpu.brand_string'])) || 'unknown',
  };
}

const { detailLevels, listLevels } = parseArgs();
console.log(`Targets: Ruby=${RUBY} Bun=${BUN} Rust=${RUST}`);
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
  rust: RUST,
  versions: await versions(),
  detail,
  list,
};
await Bun.write(`bench/results/${Date.now()}.json`, JSON.stringify(result, null, 2));
console.log('\nSaved JSON to bench/results/');
