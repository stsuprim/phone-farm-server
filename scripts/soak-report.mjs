#!/usr/bin/env node
// The soak's summary (docs/soak.md), from its journal data/soak-<date>.jsonl: input and read latency, picture age,
// freezes, stalls and how long each took to recover, runner restarts and Home presses, and the verdict (PASS = zero
// unrecovered stalls). scripts/soak.ts prints the same at the end of a run; this re-reads any journal later:
//   node scripts/soak-report.mjs data/soak-2026-11-28.jsonl [--json]
import fs from 'node:fs';

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]);
};

/** The summary of a soak journal's events (objects, one per JSONL line). */
export function summarize(events) {
  const start = events.find((e) => e.type === 'start') ?? null;
  const actions = events.filter((e) => e.type === 'action');
  const inputs = actions.filter((e) => ['swipe', 'home', 'launch'].includes(e.op) && e.ok);
  const reads = actions.filter((e) => e.op === 'read' && e.ok);
  const opens = actions.filter((e) => e.op === 'live-open');
  const ages = events.filter((e) => e.type === 'frame-age');
  const freezes = events.filter((e) => e.type === 'freeze');
  const stalls = events.filter((e) => e.type === 'stall');
  const recovered = new Map(events.filter((e) => e.type === 'recovered').map((e) => [e.id, e]));
  const unrecovered = stalls.filter((s) => !recovered.has(s.id));
  const recoverMs = [...recovered.values()].map((r) => r.ms);
  // counters: the last minus the first seen per phone (a server restart resets them: never negative)
  const counters = {};
  for (const c of events.filter((e) => e.type === 'counters')) {
    const k = c.phone;
    counters[k] ??= { first: c, last: c };
    counters[k].last = c;
  }
  const delta = (k) => Object.values(counters).reduce((n, { first, last }) => n + Math.max(0, (last[k] ?? 0) - (first[k] ?? 0)), 0);
  const asked = actions.filter((e) => e.op === 'home' && e.ok).length;
  const homeSeen = Object.values(counters).some(({ last }) => typeof last.homePresses === 'number') ? delta('homePresses') : null;
  const byCause = {};
  for (const s of stalls) byCause[s.cause] = (byCause[s.cause] ?? 0) + 1;
  const freezeCause = {};
  for (const f of freezes) freezeCause[f.cause] = (freezeCause[f.cause] ?? 0) + 1;
  const first = events[0]?.t ?? null;
  const last = events[events.length - 1]?.t ?? null;
  return {
    ranS: first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 1000) : 0,
    phones: start?.phones ?? [],
    dryRun: !!start?.dryRun,
    inputs: inputs.length,
    inputP95Ms: pct(inputs.map((e) => e.ms), 95),
    inputFailed: actions.filter((e) => ['swipe', 'home', 'launch'].includes(e.op) && !e.ok).length,
    reads: reads.length,
    readP95Ms: pct(reads.map((e) => e.ms), 95),
    liveOpens: opens.length,
    liveOpenFailed: opens.filter((e) => !e.ok).length,
    liveOpenP95Ms: pct(opens.filter((e) => e.ok).map((e) => e.ms), 95),
    pictureAgeP95Ms: pct(ages.map((e) => e.p95).filter((x) => typeof x === 'number'), 95),
    pictureAgeMaxMs: ages.length ? Math.max(...ages.map((e) => e.max ?? 0)) : null,
    freezes: freezes.length,
    freezeCauses: freezeCause,
    stalls: stalls.length,
    stallCauses: byCause,
    recovered: recovered.size,
    unrecovered: unrecovered.length,
    unrecoveredList: unrecovered.map((s) => ({ phone: s.phone, cause: s.cause, at: s.t })),
    recoverP95Ms: pct(recoverMs, 95),
    recoverMaxMs: recoverMs.length ? Math.max(...recoverMs) : null,
    runnerRestarts: delta('runnerRestarts'),
    recoveries: delta('recoveries'),
    homePressesAsked: asked,
    homePressesSeen: homeSeen,
    homePressesNotAsked: homeSeen === null ? null : Math.max(0, homeSeen - asked),
    verdict: unrecovered.length === 0 ? 'PASS' : 'FAIL',
  };
}

/** The summary as lines for a terminal. */
export function format(s) {
  const v = (x, unit = '') => (x === null || x === undefined ? 'n/a' : `${x}${unit}`);
  return [
    `soak ${s.dryRun ? '(dry run, mock) ' : ''}over ${s.ranS} s on ${s.phones.join(', ') || '?'}`,
    `  inputs ${s.inputs} (failed ${s.inputFailed}), p95 ${v(s.inputP95Ms, ' ms')}; reads ${s.reads}, p95 ${v(s.readP95Ms, ' ms')}`,
    `  live opens ${s.liveOpens} (failed ${s.liveOpenFailed}), p95 ${v(s.liveOpenP95Ms, ' ms')}; picture age p95 ${v(s.pictureAgeP95Ms, ' ms')}, max ${v(s.pictureAgeMaxMs, ' ms')}`,
    `  freezes ${s.freezes} ${JSON.stringify(s.freezeCauses)}`,
    `  stalls ${s.stalls} ${JSON.stringify(s.stallCauses)}; recovered ${s.recovered} (p95 ${v(s.recoverP95Ms, ' ms')}, max ${v(s.recoverMaxMs, ' ms')}); unrecovered ${s.unrecovered}`,
    `  runner restarts ${s.runnerRestarts}, recoveries ${s.recoveries}; Home presses asked ${s.homePressesAsked}, seen ${v(s.homePressesSeen)}, not asked ${v(s.homePressesNotAsked)}`,
    `  verdict: ${s.verdict}${s.unrecovered ? ` (${s.unrecoveredList.map((u) => `${u.phone}: ${u.cause}`).join('; ')})` : ' (zero unrecovered stalls)'}`,
  ].join('\n');
}

export function readJournal(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/soak-report.mjs data/soak-<date>.jsonl [--json]');
    process.exit(2);
  }
  const s = summarize(readJournal(file));
  console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : format(s));
  process.exit(s.verdict === 'PASS' ? 0 : 1);
}
