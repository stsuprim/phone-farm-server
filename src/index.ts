import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { IdleLock } from './idle.js';
import { MockBackend } from './mock.js';
import { RealBackend } from './real.js';
import { buildWdaRunner, WdaResigner } from './resign.js';
import { loadRtc, rtcCleanup } from './rtc.js';
import { createServer } from './server.js';
import { SettingsStore } from './settings.js';
import { createUpdater } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
if (!cfg.mock && !cfg.wdaProject) {
  console.error('WDA_PROJECT is not set in .env (see README), or set MOCK=true.');
  process.exit(1);
}
const backend = cfg.mock ? new MockBackend(cfg.mockPhones) : new RealBackend(cfg);
const updater = cfg.mock ? undefined : createUpdater(() => shutdown());

// the server's config dir (data/, next to ports.json): settings and the WDA signing record
const settings = new SettingsStore(path.join(cfg.dataDir, 'settings.json'));
const idle = new IdleLock(backend, () => settings.get().idleLockMinutes);
const onlinePhones = async () => (await backend.list()).filter((p) => p.online).map((p) => p.udid);
const resigner =
  cfg.mock || !cfg.wdaResign
    ? undefined
    : new WdaResigner({
        file: path.join(cfg.dataDir, 'wda-sign.json'),
        provisionFile: path.join(cfg.wdaDerivedData, 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app', 'embedded.mobileprovision'),
        run: buildWdaRunner(ROOT, () => cfg.wdaTeamId),
        devices: onlinePhones,
        liveViewers: () => idle.liveViewers(),
        prepare: (udid) => idle.wake(udid),
        installed: (udid) => backend.restartWda?.(udid),
        quietStartHour: cfg.wdaResignHour,
        problem: () =>
          process.platform !== 'darwin' ? 'WDA signing needs macOS' : cfg.wdaTeamId ? null : 'WDA_TEAM_ID is not set in .env (the Apple Team ID build-wda.sh signs with)',
      });
const server = createServer(backend, cfg.token, updater, { settings, idle, resigner });

server.listen(cfg.port, cfg.host, () => {
  console.log(`phone-farm-server listening on http://${cfg.host}:${cfg.port} (${cfg.mock ? 'MOCK' : 'real'} mode)`);
});
// the WebRTC library (a native module) loads now rather than under the first viewer's offer
void loadRtc();

const shutdown = () => {
  server.close();
  idle.close();
  resigner?.close();
  void backend.close().finally(() => {
    rtcCleanup();
    process.exit(0);
  });
};
updater?.start(cfg.autoUpdateMinutes);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
