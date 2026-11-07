import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.AGENTBUS_CONFIG ?? join(homedir(), '.config', 'herdr-app', 'agentbus.json');
const dataDir = process.env.AGENTBUS_DATA_DIR ?? join(ROOT, '.data');

// Each setting can be set in the config file, or by an environment variable named after
// it, such as AGENTBUS_HOP_LIMIT for hopLimit. The variable wins.
export const DEFAULTS = {
  natsPort: 4322,
  agents: ['claude', 'codex'],

  // Runaway guard: pause after this many deliveries with no quiet gap.
  hopLimit: 20,
  quietResetMs: 600_000,

  // Delivery retries: base * 2^(attempt-1), capped, with +/-20% jitter.
  maxAttempts: 10,
  backoffBaseMs: 1_000,
  backoffCapMs: 300_000,

  // In-flight messages must be heartbeated faster than ackWait, or JetStream
  // redelivers them. That redelivery is what recovers from a bridge crash.
  ackWaitMs: 30_000,
  heartbeatMs: 10_000,

  pollMs: 1_000,
  fetchExpiresMs: 3_000,
  promptTimeoutMs: 20_000,
  startGraceMs: 5_000,

  maxBodyChars: 16_000,
  retentionDays: 30,
};

const envName = (key) => `AGENTBUS_${key.replace(/[A-Z]/g, '_$&').toUpperCase()}`;

export function assertAgentName(agent) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new Error(`Invalid agent name: ${agent}`);
  return agent;
}

function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  let file;
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }
  if (file === null || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`${CONFIG_PATH} must hold a JSON object of settings`);
  }
  // A misspelled setting would otherwise be ignored without any sign.
  const unknown = Object.keys(file).filter((key) => !(key in DEFAULTS));
  if (unknown.length > 0) {
    throw new Error(`Unknown setting in ${CONFIG_PATH}: ${unknown.join(', ')}. Valid settings: ${Object.keys(DEFAULTS).join(', ')}`);
  }
  return file;
}

function checkNumber(key, value, source) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number, got ${JSON.stringify(value)} from ${source}`);
  }
  return value;
}

function checkAgents(value, source) {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`agents must list at least two names, got ${JSON.stringify(value)} from ${source}`);
  }
  return value.map(assertAgentName);
}

function resolveSettings() {
  const file = readConfigFile();
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const name = envName(key);
    const raw = process.env[name];
    const fromEnv = raw !== undefined && raw !== '';
    const source = fromEnv ? name : (key in file ? CONFIG_PATH : 'defaults');
    if (key === 'agents') {
      const value = fromEnv ? raw.split(',').map((s) => s.trim()).filter(Boolean) : (file.agents ?? fallback);
      settings.agents = checkAgents(value, source);
    } else {
      settings[key] = checkNumber(key, fromEnv ? Number(raw) : (file[key] ?? fallback), source);
    }
  }
  if (!Number.isInteger(settings.natsPort) || settings.natsPort > 65_535) {
    throw new Error(`natsPort must be a port number, got ${settings.natsPort}`);
  }
  if (settings.heartbeatMs >= settings.ackWaitMs) {
    throw new Error(`heartbeatMs (${settings.heartbeatMs}) must be less than ackWaitMs (${settings.ackWaitMs}), or messages in flight get redelivered`);
  }
  return settings;
}

export const config = {
  ...resolveSettings(),
  dataDir,
  natsBinary: join(ROOT, 'bin', process.platform === 'win32' ? 'nats-server.exe' : 'nats-server'),
};

export const STREAM = 'AGENTBUS';
export const STATE_BUCKET = 'AGENTBUS_STATE';
export const BUDGET_KEY = 'budget';
export const inboxSubject = (agent) => `agentbus.inbox.${agent}`;
export const dlqSubject = (agent) => `agentbus.dlq.${agent}`;
export const consumerName = (agent) => `deliver-${agent}`;
