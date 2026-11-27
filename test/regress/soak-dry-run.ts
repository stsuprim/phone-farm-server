// The soak driver itself (scripts/soak.ts, docs/soak.md): `--dry-run` runs its whole loop for 20 s against an
// in-process MOCK=true server and must end with PASS (zero unrecovered stalls), having read, scrolled, gone Home,
// launched only TikTok or Instagram and opened the live view; and its journal holds nothing it must never send or
// keep (no tap, no typing, no token).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, regress, ROOT } from '../harness/index.js';

regress('soak-dry-run', async (t) => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-soak-')), 'soak.jsonl');
  const tsx = (() => {
    for (let d = ROOT; ; d = path.dirname(d)) {
      const f = path.join(d, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      if (fs.existsSync(f)) return f;
      if (path.dirname(d) === d) throw new Error('tsx not installed');
    }
  })();
  const { code, text } = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const env = { ...process.env };
    delete env.SOAK_URL;
    delete env.API_TOKEN;
    const child = spawn(process.execPath, [tsx, path.join(ROOT, 'scripts', 'soak.ts'), '--dry-run', '--out', out], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', (c) => resolve({ code: c, text }));
  });
  const verdict = /verdict: (\w+)/.exec(text)?.[1] ?? null;
  t.note(text.split(/\r?\n/).filter((l) => /inputs|live opens|verdict/.test(l)).map((l) => l.trim()).join(' / ').slice(0, 400));
  assert.equal(code, 0, `the dry run exited ${code}: ${text.slice(-400)}`);
  assert.equal(verdict, 'PASS');
  const evs = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const ops = new Set(evs.filter((e) => e.type === 'action').map((e) => e.op));
  for (const op of ops) assert.ok(['read', 'swipe', 'home', 'launch', 'wake', 'live-open', 'live-close'].includes(op), `an action the soak must never do: ${op}`);
  for (const need of ['read', 'swipe', 'home', 'launch', 'live-open']) assert.ok(ops.has(need), `the dry run did ${need}`);
  const apps = new Set(evs.filter((e) => e.op === 'launch').map((e) => e.app));
  for (const a of apps) assert.ok(['com.zhiliaoapp.musically', 'com.burbn.instagram'].includes(a), `launched ${a}`);
  const raw = fs.readFileSync(out, 'utf8');
  assert.ok(!/token=|bearer|authorization/i.test(raw), 'no token in the journal');
  assert.ok(evs.some((e) => e.type === 'frame-age'), 'picture ages were measured');
}, { timeoutMs: 90_000 });
