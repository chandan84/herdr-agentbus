import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
};

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.AGENTBUS_DATA_DIR ?? join(ROOT, '.data');

export const config = {
  agents: (process.env.AGENTBUS_AGENTS ?? 'claude,codex').split(',').map((s) => s.trim()).filter(Boolean),
  dataDir,
  natsPort: num('AGENTBUS_NATS_PORT', 4322),
  natsBinary: join(ROOT, 'bin', process.platform === 'win32' ? 'nats-server.exe' : 'nats-server'),

  // In-flight messages must be heartbeated faster than ackWait, or JetStream
  // redelivers them. That redelivery is what recovers from a bridge crash.
  ackWaitMs: num('AGENTBUS_ACK_WAIT_MS', 30_000),
  heartbeatMs: num('AGENTBUS_HEARTBEAT_MS', 10_000),
  pollMs: num('AGENTBUS_POLL_MS', 1_000),
  fetchExpiresMs: num('AGENTBUS_FETCH_EXPIRES_MS', 3_000),
  promptTimeoutMs: num('AGENTBUS_PROMPT_TIMEOUT_MS', 20_000),
  startGraceMs: num('AGENTBUS_START_GRACE_MS', 5_000),

  // Delivery retries: base * 2^(attempt-1), capped, with +/-20% jitter.
  backoffBaseMs: num('AGENTBUS_BACKOFF_BASE_MS', 1_000),
  backoffCapMs: num('AGENTBUS_BACKOFF_CAP_MS', 300_000),
  maxAttempts: num('AGENTBUS_MAX_ATTEMPTS', 10),

  // Runaway guard: pause after this many deliveries with no quiet gap.
  hopLimit: num('AGENTBUS_HOP_LIMIT', 20),
  quietResetMs: num('AGENTBUS_QUIET_RESET_MS', 600_000),

  maxBodyChars: 16_000,
  retentionDays: 30,
};

export const STREAM = 'AGENTBUS';
export const STATE_BUCKET = 'AGENTBUS_STATE';
export const BUDGET_KEY = 'budget';
export const inboxSubject = (agent) => `agentbus.inbox.${agent}`;
export const dlqSubject = (agent) => `agentbus.dlq.${agent}`;
export const consumerName = (agent) => `deliver-${agent}`;

export function assertAgentName(agent) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new Error(`Invalid agent name: ${agent}`);
  return agent;
}
