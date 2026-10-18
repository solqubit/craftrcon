import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp({ config, db: null, services: {} });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  console.error(err);
  process.exit(1);
}
