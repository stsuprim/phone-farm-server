// One regression class per file: `regress(id, fn)` runs it under a time limit and prints one line the runner reads
// (`#result {"id","pass","ms","detail"}`), plus the server's last log lines when it fails. Exit 0 = pass.
import assert from 'node:assert/strict';

export { assert };

export interface Ctx {
  /** A note shown with the result (numbers measured). */
  note(s: string): void;
  /** Things to close at the end, pass or fail. */
  later(fn: () => unknown): void;
  /** The log lines to print when it fails (a farm's `logs`). */
  logs?: string[];
}

export function regress(id: string, fn: (t: Ctx) => Promise<void>, o: { timeoutMs?: number } = {}): void {
  const t0 = Date.now();
  const notes: string[] = [];
  const closers: (() => unknown)[] = [];
  const ctx: Ctx = { note: (s) => void notes.push(s), later: (f) => void closers.push(f) };
  const finish = async (pass: boolean, detail: string) => {
    for (const c of closers.reverse()) {
      try {
        await Promise.race([c(), new Promise((r) => setTimeout(r, 4000))]);
      } catch {
        /* closing */
      }
    }
    const line = { id, pass, ms: Date.now() - t0, detail: [detail, ...notes].filter(Boolean).join('; ').slice(0, 600) };
    if (!pass && ctx.logs?.length) process.stdout.write(`# last server lines:\n${ctx.logs.slice(-30).map((l) => `#   ${l.slice(0, 300)}`).join('\n')}\n`);
    process.stdout.write(`${pass ? 'ok' : 'not ok'} - ${id}${line.detail ? `: ${line.detail}` : ''}\n#result ${JSON.stringify(line)}\n`);
    process.exitCode = pass ? 0 : 1;
    setTimeout(() => process.exit(pass ? 0 : 1), 150).unref();
  };
  const limit = setTimeout(() => void finish(false, `timed out after ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s`), o.timeoutMs ?? 60_000);
  fn(ctx).then(
    () => {
      clearTimeout(limit);
      void finish(true, '');
    },
    (err: Error) => {
      clearTimeout(limit);
      void finish(false, err?.message ?? String(err));
    },
  );
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function p95(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
}
