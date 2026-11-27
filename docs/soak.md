# The soak: hours on the real phones, measured (2026-11-27)

`scripts/soak.ts` runs against a **real running server** for N hours. On the phones you pick, it does what an agent
and a watching owner do, only ever as a viewer, and measures what root-cause.md's acceptance asks for (13.5): input
p95, read p95, picture age, freezes, runner restarts, Home presses not asked for, and every stall with its cause and
how long it took to recover. The verdict at the end is **PASS when no stall is left unrecovered**.

## What it does, and what it never does

Each phone gets one worker, one thing at a time:
- an explicit wake once at the start;
- reads of the screen (`GET /ui`, the agent's look);
- Home, then TikTok (`com.zhiliaoapp.musically`) or Instagram (`com.burbn.instagram`), in turn;
- vertical scrolls in the middle of the screen (the next video or post), a few seconds apart;
- the live view (the `/stream` WebSocket, H.264 by default) opened for 60 s every 3 minutes.

It **never** taps, types, posts, deletes, likes, follows, comments or signs out, and never opens another app. Every
request goes through `guard()`: read-only GETs (`/health`, `/phones`, `/trace`, `/phones/:id/ui|input|info`) and four
POSTs (a vertical swipe between 20 % and 80 % of the height in the middle third, Home, launch TikTok or Instagram,
wake). Anything else throws before it's sent, and the guard tests itself at every start.

The server's address and token are never printed or written. They come from `SOAK_URL` and `API_TOKEN`; run in the
server's folder on the Mac, both default from its `.env` (`API_TOKEN`, and `PORT` on 127.0.0.1).

## Running it on the Mac

```
cd ~/phone-farm                      # the server's folder (its .env has API_TOKEN)
npm run soak -- --dry-run            # 20 s against an in-process mock server: checks the tool itself
npm run soak -- --hours 4 --phones iPhone-1,iPhone-2
npm run soak -- --hours 1 --phones iPhone-1 --apps tiktok --live mjpeg
node scripts/soak-report.mjs data/soak-2026-11-28.jsonl      # the summary of a journal, again
```

Options: `--hours H` or `--seconds S`, `--phones` (names or udids, default every online phone), `--apps
tiktok,instagram`, `--live h264|mjpeg|off`, `--out file.jsonl`. Ctrl+C ends it early and still writes the summary.

Run it on the Mac itself, so the picture ages use one clock. From another machine, set `SOAK_URL` (the Tailscale
address); the ages are then corrected by the stream's ping/pong clock offset, which is less exact.

Don't run it while a posting hand works on the same phone: it scrolls the app in front.

## The journal (`data/soak-<date>.jsonl`)

One JSON object per line, each with `t` (ISO time) and `type`:

| type | fields |
|---|---|
| `start` | phones, seconds, live, apps, dryRun, server `{commit, mock, uptimeS}` |
| `action` | phone, op (`read`, `swipe`, `home`, `launch`, `wake`, `live-open`, `live-close`), ok, ms, status, error |
| `frame-age` | phone, frames, p50, p95, max (ms from capture to arrival, per live session) |
| `freeze` | phone, gapMs, cause (`no-frame-after-input`: the picture didn't move within 1.5 s of a scroll) |
| `stall` | id, phone, kind (`server`, `control`, `read`, `input`, `live`), cause |
| `recovered` | id, phone, kind, cause, ms (the stall's time to recovery) |
| `counters` | phone, runnerRestarts, recoveries, homePresses (from `GET /trace` when the server has it), source |
| `server-restarted` | uptimeS, commit (the server's uptime went back) |
| `end` | the stalls still open |

A stall opens on a failure or a slow answer (an input over 3 s, a read over 15 s, a live view that doesn't open in
15 s or freezes 5 s after a scroll, a phone not `ready` or offline, `/health` down), and closes at the next success of
the same kind. Runner restarts and recoveries come from `/phones` (`stats.controlLink.wda`); Home presses need the
server's trace (`GET /trace`, root-cause.md W0-a); without it the summary says `n/a`.

## The summary

```
soak over 14400 s on iPhone-1, iPhone-2
  inputs 5210 (failed 0), p95 180 ms; reads 2600, p95 2400 ms
  live opens 160 (failed 0), p95 1900 ms; picture age p95 120 ms, max 900 ms
  freezes 3 {"no-frame-after-input":3}
  stalls 4 {...}; recovered 4 (p95 6100 ms, max 9000 ms); unrecovered 0
  runner restarts 0, recoveries 0; Home presses asked 380, seen 380, not asked 0
  verdict: PASS (zero unrecovered stalls)
```
(numbers for illustration only). The acceptance in root-cause.md 13.5 also wants 0 runner restarts, 0 Home presses
not asked for, input p95 under 300 ms and no input dropped as busy: read them from the same summary.

`npm run regress` runs the dry run as the class `soak-dry-run`.
