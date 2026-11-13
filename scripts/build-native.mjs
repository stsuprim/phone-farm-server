// Builds the native capture helper (native/phonecap) on macOS. Never fails the build: if swiftc fails, the old
// binary is removed and the reason is written to native/phonecap/build/phonecap.error, so the server streams MJPEG
// and says why (GET /phones -> stats.h264_reason, and the stream hello's `reason`).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'native', 'phonecap');
const src = path.join(dir, 'main.swift');
const plist = path.join(dir, 'Info.plist');
const out = path.join(dir, 'build');
const bin = path.join(out, 'phonecap');
const errFile = path.join(out, 'phonecap.error');
const hashFile = path.join(out, 'phonecap.hash');

if (process.platform !== 'darwin') {
  console.log('[native] phonecap is macOS only; skipped (the server will stream MJPEG here)');
  process.exit(0);
}
fs.mkdirSync(out, { recursive: true });
const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).update(fs.readFileSync(plist)).digest('hex');
if (fs.existsSync(bin) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) {
  console.log('[native] phonecap up to date');
  process.exit(0);
}
const tmp = `${bin}.tmp`;
const args = [
  '--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', '-o', tmp, src,
  '-framework', 'AVFoundation', '-framework', 'CoreMedia', '-framework', 'CoreMediaIO',
  '-framework', 'CoreVideo', '-framework', 'VideoToolbox',
  // embed an Info.plist so macOS's camera prompt (TCC) has a usage string for this command-line tool
  '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
];
try {
  console.log('[native] building phonecap with swiftc...');
  execFileSync('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 });
  fs.renameSync(tmp, bin);
  fs.writeFileSync(hashFile, hash);
  fs.rmSync(errFile, { force: true });
  console.log('[native] phonecap built');
} catch (e) {
  const text = `${e.stderr?.toString() ?? ''}\n${e.message ?? e}`.trim();
  const errors = text.split('\n').filter((l) => /error/i.test(l));
  fs.rmSync(tmp, { force: true });
  fs.rmSync(bin, { force: true });
  fs.rmSync(hashFile, { force: true });
  fs.writeFileSync(errFile, `${(errors[0] ?? text.split('\n')[0] ?? 'swiftc failed').slice(0, 300)}\n\n${text.slice(-4000)}\n`);
  console.warn(`[native] phonecap build FAILED; the server will stream MJPEG. ${errors[0] ?? ''}`);
}
