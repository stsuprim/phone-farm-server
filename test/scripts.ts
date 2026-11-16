// Our WebDriverAgent's build-phase scripts are runnable before every build (2026-11-17: embed-runner-icon.sh was in
// git without its executable bit, and Xcode's build failed right after signing with "permission denied"): they are
// 100755 in git, and the server chmods them before it runs scripts/build-wda.sh (a clone with core.fileMode false).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScriptsRunnable, wdaScripts } from '../src/resign.js';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`ok - ${name}`);
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WDA = path.join(ROOT, 'wda');
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

// the real fork: every script it builds with is found, the scheme's icon script included
{
  const found = wdaScripts(WDA).map(rel);
  for (const want of ['wda/Scripts/embed-runner-icon.sh', 'wda/Scripts/build.sh']) assert.ok(found.includes(want), `${want} is found`);
  // and git keeps them executable (a fresh clone gets 100755)
  let staged = '';
  try {
    staged = execFileSync('git', ['-C', ROOT, 'ls-files', '-s', '--', ...found], { encoding: 'utf8' });
  } catch {
    /* not a git checkout: nothing to check */
  }
  for (const line of staged.trim().split('\n').filter(Boolean)) assert.ok(line.startsWith('100755 '), `executable in git: ${line}`);
  ok(`the fork's scripts are found (${found.length}) and are 100755 in git`);
}

// a copy without the bits: the scheme's named script and every *.sh made runnable, nothing else touched
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-scripts-'));
  try {
    fs.mkdirSync(path.join(dir, 'Scripts', 'ci'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'P.xcodeproj', 'xcshareddata', 'xcschemes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    for (const f of ['Scripts/embed-runner-icon.sh', 'Scripts/ci/build-real.sh', 'Scripts/tool', 'node_modules/x/skip.sh', 'readme.txt']) {
      fs.writeFileSync(path.join(dir, f), '#!/bin/bash\n', { mode: 0o644 });
    }
    fs.writeFileSync(path.join(dir, 'P.xcodeproj', 'xcshareddata', 'xcschemes', 'R.xcscheme'), 'scriptText = "&quot;${SRCROOT}/Scripts/embed-runner-icon.sh&quot;&#10;"\nshellScript = "$SRCROOT/Scripts/tool\n";');
    const found = wdaScripts(dir).map((f) => path.relative(dir, f).split(path.sep).join('/'));
    assert.deepEqual(found, ['Scripts/ci/build-real.sh', 'Scripts/embed-runner-icon.sh', 'Scripts/tool'], 'the *.sh files and the named script, never node_modules');
    const changed = makeScriptsRunnable(dir);
    if (process.platform !== 'win32') {
      assert.equal(changed.length, 3);
      for (const f of found) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o111, 0o111, `${f} is runnable`);
      assert.equal(fs.statSync(path.join(dir, 'readme.txt')).mode & 0o111, 0, 'nothing else touched');
      assert.deepEqual(makeScriptsRunnable(dir), [], 'a second run changes nothing');
    }
    ok('makeScriptsRunnable: chmod +x the scripts a build runs before it runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nall ${passed} script checks passed`);
