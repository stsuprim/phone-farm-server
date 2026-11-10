import { loadConfig } from './config.js';
import { MockBackend } from './mock.js';
import { RealBackend } from './real.js';
import { createServer } from './server.js';

const cfg = loadConfig();
if (!cfg.mock && !cfg.wdaProject) {
  console.error('WDA_PROJECT is not set in .env (see README), or set MOCK=true.');
  process.exit(1);
}
const backend = cfg.mock ? new MockBackend(cfg.mockPhones) : new RealBackend(cfg);
const server = createServer(backend, cfg.token);

server.listen(cfg.port, cfg.host, () => {
  console.log(`phone-farm-server listening on http://${cfg.host}:${cfg.port} (${cfg.mock ? 'MOCK' : 'real'} mode)`);
});

const shutdown = () => {
  server.close();
  void backend.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
