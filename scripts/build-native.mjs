// Builds the native capture helper (native/phonecap) on macOS. Never fails the build: if swiftc fails, the reason is
// written to native/phonecap/build/phonecap.error and the previous helper (if any) is KEPT, so live video keeps working
// with it (the server only uses what that helper speaks: build/phonecap.caps); with no previous helper the server
// streams MJPEG and says why (GET /phones -> stats.h264_reason, and the stream hello's `reason`).
//
// build/phonecap.caps: the capabilities of the built helper, from main.swift's "// phonecap-caps: ..." line (e.g.
// "lanes": several encoders from one capture). Written only with a successful build, so it always matches the binary.
//
// The helper is wrapped in a minimal app bundle, build/PhoneCap.app (bundle id com.lotus.phonecap, with
// NSCameraUsageDescription), and the bundle is code-signed, so macOS gives it its own Camera (TCC) entry. Signing is
// ad-hoc unless PHONECAP_SIGN_IDENTITY names a certificate (e.g. "Apple Development: ..."). The signature carries an
// explicit designated requirement (identifier "com.lotus.phonecap") so the Camera grant can survive rebuilds; if macOS
// still asks again after a rebuild, run phonecap --request-access once more.
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
const app = path.join(out, 'PhoneCap.app');
const bin = path.join(app, 'Contents', 'MacOS', 'phonecap');
const oldBin = path.join(out, 'phonecap'); // before the app bundle
const errFile = path.join(out, 'phonecap.error');
const hashFile = path.join(out, 'phonecap.hash');
const capsFile = path.join(out, 'phonecap.caps');

/** The caps main.swift declares ("// phonecap-caps: lanes ..."). */
function declaredCaps() {
  const m = /^\/\/\s*phonecap-caps:\s*(.*)$/m.exec(fs.readFileSync(src, 'utf8'));
  return m ? m[1].split(/[\s,]+/).filter(Boolean) : [];
}

if (process.platform !== 'darwin') {
  console.log('[native] phonecap is macOS only; skipped (the server will stream MJPEG here)');
  process.exit(0);
}
fs.mkdirSync(out, { recursive: true });
const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).update(fs.readFileSync(plist))
  .update(`bundle-v2|${process.env.PHONECAP_SIGN_IDENTITY ?? ''}`).digest('hex');
if (fs.existsSync(bin) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) {
  console.log('[native] phonecap up to date');
  process.exit(0);
}
const tmp = path.join(out, 'phonecap.tmp');
const tmpApp = path.join(out, 'PhoneCap.app.tmp');
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
  fs.rmSync(tmpApp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpApp, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync(plist, path.join(tmpApp, 'Contents', 'Info.plist'));
  fs.renameSync(tmp, path.join(tmpApp, 'Contents', 'MacOS', 'phonecap'));
  const identity = process.env.PHONECAP_SIGN_IDENTITY || '-';
  const sign = (extra) => execFileSync('codesign', ['--force', '--sign', identity, '--identifier', 'com.lotus.phonecap', ...extra, '--timestamp=none', tmpApp],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2 * 60_000 });
  try {
    // a stable designated requirement: the Camera grant follows the identifier, not this build's hash
    sign(['-r=designated => identifier "com.lotus.phonecap"']);
  } catch (e) {
    console.warn(`[native] codesign with a designated requirement failed, signing without: ${(e.stderr?.toString() ?? e.message ?? '').trim().split('\n')[0]}`);
    sign([]);
  }
  fs.rmSync(app, { recursive: true, force: true });
  fs.renameSync(tmpApp, app);
  fs.rmSync(oldBin, { force: true });
  fs.writeFileSync(hashFile, hash);
  fs.writeFileSync(capsFile, `${declaredCaps().join(' ')}\n`);
  fs.rmSync(errFile, { force: true });
  console.log(`[native] phonecap built (caps: ${declaredCaps().join(' ') || 'none'})`);
} catch (e) {
  const text = `${e.stderr?.toString() ?? ''}\n${e.message ?? e}`.trim();
  // the first real compiler error ("file:line:col: error: ..."), not a deprecation warning that merely names an *Error
  const errors = text.split('\n').filter((l) => /\berror:/i.test(l));
  fs.rmSync(tmp, { force: true });
  fs.rmSync(tmpApp, { recursive: true, force: true });
  // the previous helper stays (with its own caps file): live video keeps working while this build is broken
  fs.rmSync(hashFile, { force: true });
  fs.writeFileSync(errFile, `${(errors[0] ?? text.split('\n')[0] ?? 'swiftc failed').slice(0, 300)}\n\n${text.slice(-4000)}\n`);
  const kept = fs.existsSync(bin) || fs.existsSync(oldBin);
  console.warn(`[native] phonecap build FAILED; ${kept ? 'the previous helper keeps running' : 'the server will stream MJPEG'}. ${errors[0] ?? ''}`);
}
