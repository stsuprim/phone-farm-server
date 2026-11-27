// The regression runner: one test per past bug class (test/regress/manifest.json, docs/regression.md). Each class runs
// in its own process (its own fake phones, ports and data/ folder), a few at a time. It prints pass/fail per class and
// exits non-zero when any class fails that isn't marked `expectedAfterRebuild` (behaviour the rebuild of
// docs/root-cause.md 13.5 introduces). A pending class that passes is said so: take its mark off.
// `--all` (npm run regress) first runs the type-check (src, test, the harness and scripts/soak.ts) and every file of
// the existing suite (package.json's "test", one row each, so one failing file doesn't hide the others).
//   tsx test/regress/run.ts [--all] [--only id,id] [--jobs 3] [--suite-jobs 1] [--json file]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Entry {
  id: string;
  title: string;
  section: string;
  commits: string[];
  file: string;
  expectedAfterRebuild: boolean;
  timeoutMs: number;
}
interface Outcome {
  id: string;
  pass: boolean;
  ms: number;
  detail: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8')) as { classes: Entry[] };
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')?.split(',').filter(Boolean);
const jobs = Math.max(1, Number(arg('--jobs') ?? process.env.REGRESS_JOBS ?? 3));
const jsonOut = arg('--json');

// every test file is listed: a class without an entry would silently never run
const files = fs.readdirSync(here).filter((f) => f.endsWith('.ts') && f !== 'run.ts');
const listed = new Set(manifest.classes.map((c) => c.file));
const unlisted = files.filter((f) => !listed.has(f));
const missing = manifest.classes.filter((c) => !files.includes(c.file)).map((c) => c.file);

// tsx's CLI, from the nearest node_modules up the tree
const tsxCli = (() => {
  for (let d = root; ; d = path.dirname(d)) {
    const f = path.join(d, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) throw new Error('tsx is not installed (npm install)');
  }
})();
const bin = (rel: string) => {
  for (let d = root; ; d = path.dirname(d)) {
    const f = path.join(d, 'node_modules', rel);
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) throw new Error(`${rel} is not installed (npm install)`);
  }
};

/** One check of the existing suite or the type-check: passes on exit 0. */
const runCheck = (id: string, args: string[], timeoutMs: number): Promise<Outcome> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, INPUT_LOG: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(kill);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const bad = lines.filter((l) => /error TS|not ok|AssertionError|Error:|failed/i.test(l));
      const detail = code === 0 ? (lines[lines.length - 1] ?? '').slice(0, 160) : `exit ${code}: ${(bad.length ? bad.slice(0, 3) : lines.slice(-3)).join(' | ').slice(0, 300)}`;
      resolve({ id, pass: code === 0, ms: Date.now() - t0, detail });
    });
  });

const runOne = (c: Entry): Promise<Outcome> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [tsxCli, path.join(here, c.file)], { cwd: root, env: { ...process.env, INPUT_LOG: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const kill = setTimeout(() => child.kill('SIGKILL'), c.timeoutMs + 15_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('#result '));
      let r: Outcome | null = null;
      try {
        r = line ? (JSON.parse(line.slice(8)) as Outcome) : null;
      } catch {
        r = null;
      }
      if (!r) r = { id: c.id, pass: false, ms: Date.now() - t0, detail: `no result (exit ${code}): ${out.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300)}` };
      if (process.env.REGRESS_VERBOSE || (!r.pass && !c.expectedAfterRebuild)) process.stdout.write(out.split(/\r?\n/).filter((l) => l.startsWith('#   ')).slice(-15).map((l) => `      ${l}\n`).join(''));
      resolve({ ...r, id: c.id });
    });
  });

// ---- --all: the type-check and the existing suite first ----
const checks: Outcome[] = [];
if (process.argv.includes('--all')) {
  const tsc = bin(path.join('typescript', 'bin', 'tsc'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const suite = [...(pkg.scripts?.test ?? '').matchAll(/tsx\s+(\S+\.ts)/g)].map((m) => m[1]!);
  const list: [string, string[], number][] = [
    ['typecheck', [tsc, '--noEmit'], 600_000],
    ['typecheck:regress+soak', [tsc, '-p', path.join('test', 'regress', 'tsconfig.json')], 600_000],
    ...suite.map((f): [string, string[], number] => [`suite:${path.basename(f, '.ts')}`, [tsxCli, f], 900_000]),
  ];
  const suiteJobs = Math.max(1, Number(arg('--suite-jobs') ?? 1));
  console.log(`checks: ${list.length} (type-check and the existing suite, ${suiteJobs} at a time)
`);
  let k = 0;
  await Promise.all(
    Array.from({ length: suiteJobs }, async () => {
      while (k < list.length) {
        const [id, args, ms] = list[k++]!;
        const r = await runCheck(id, args, ms);
        checks.push(r);
        console.log(`${(r.pass ? 'PASS' : 'FAIL').padEnd(8)} ${id.padEnd(34)} ${String(Math.round(r.ms / 100) / 10).padStart(5)} s  ${r.detail.slice(0, 200)}`);
      }
    }),
  );
  console.log('');
}

const classes = manifest.classes.filter((c) => !only || only.includes(c.id));
const results = new Map<string, Outcome>();
const label = (c: Entry, r: Outcome) => (r.pass ? (c.expectedAfterRebuild ? 'XPASS' : 'PASS') : c.expectedAfterRebuild ? 'PENDING' : 'FAIL');
console.log(`regression classes: ${classes.length} (${classes.filter((c) => c.expectedAfterRebuild).length} pending the rebuild), ${jobs} at a time\n`);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, classes.length) }, async () => {
    while (next < classes.length) {
      const c = classes[next++]!;
      const r = await runOne(c);
      results.set(c.id, r);
      console.log(`${label(c, r).padEnd(8)} ${c.id.padEnd(34)} ${String(Math.round(r.ms / 100) / 10).padStart(5)} s  ${c.section}  ${r.detail.slice(0, 160)}`);
    }
  }),
);

const rows = classes.map((c) => ({ ...c, result: results.get(c.id)!, status: label(c, results.get(c.id)!) }));
const count = (s: string) => rows.filter((r) => r.status === s).length;
console.log(`\n${'class'.padEnd(34)} status    section  title`);
for (const r of rows) console.log(`${r.id.padEnd(34)} ${r.status.padEnd(9)} ${r.section.padEnd(8)} ${r.title}`);
console.log(`\nPASS ${count('PASS')}  FAIL ${count('FAIL')}  PENDING ${count('PENDING')} (expected after the rebuild)  XPASS ${count('XPASS')} (pending, now passing: take the mark off)`);
if (unlisted.length) console.log(`not in manifest.json (never run): ${unlisted.join(', ')}`);
if (missing.length) console.log(`in manifest.json without a file: ${missing.join(', ')}`);
if (jsonOut) {
  const all = [...checks.map((c) => ({ id: c.id, status: c.pass ? 'PASS' : 'FAIL', ms: c.ms, detail: c.detail })), ...rows.map((r) => ({ id: r.id, status: r.status, ms: r.result.ms, detail: r.result.detail }))];
  fs.writeFileSync(jsonOut, JSON.stringify(all, null, 2));
}
process.exitCode = count('FAIL') > 0 || checks.some((c) => !c.pass) || unlisted.length > 0 || missing.length > 0 ? 1 : 0;
