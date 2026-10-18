import { readFileSync } from 'node:fs';

const VERSION_FILE = new URL('../VERSION', import.meta.url);

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8080,
  dataDir: './data',
  domain: null,
  trustProxy: false,
};

export function loadConfig(env = process.env) {
  let fileConfig = {};
  if (env.CRAFTRCON_CONFIG) {
    fileConfig = JSON.parse(readFileSync(env.CRAFTRCON_CONFIG, 'utf8'));
  }
  const version = readFileSync(VERSION_FILE, 'utf8').trim();
  return { ...DEFAULTS, ...fileConfig, version };
}
