import { loadConfig } from './config.js';
import { MockBackend } from './mock.js';
import { RealBackend } from './real.js';
import { createServer } from './server.js';
import { createUpdater } from './updater.js';

const cfg = loadConfig();
if (!cfg.mock && !cfg.wdaProject) {
  console.error('WDA_PROJECT is not set in .env (see README), or set MOCK=true.');
  process.exit(1);
}
const backend = cfg.mock ? new MockBackend(cfg.mockPhones) : new RealBackend(cfg);
const updater = cfg.mock ? undefined : createUpdater(() => shutdown());
const server = createServer(backend, cfg.token, updater);

server.listen(cfg.port, cfg.host, () => {
  console.log(`phone-farm-server listening on http://${cfg.host}:${cfg.port} (${cfg.mock ? 'MOCK' : 'real'} mode)`);
});

const shutdown = () => {
  server.close();
  void backend.close().finally(() => process.exit(0));
};
updater?.start(cfg.autoUpdateMinutes);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
