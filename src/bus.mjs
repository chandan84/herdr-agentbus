// NATS JetStream plumbing shared by the bridge, the MCP server, and the CLI.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '@nats-io/transport-node';
import { AckPolicy, DeliverPolicy, RetentionPolicy, StorageType, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { STATE_BUCKET, STREAM, config, consumerName, dlqSubject, inboxSubject } from './config.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nanos = (ms) => ms * 1_000_000;

/** Exponential backoff with +/-20% jitter. `attempt` starts at 1. */
export function backoffMs(attempt, base = config.backoffBaseMs, cap = config.backoffCapMs) {
  const delay = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(delay * (0.8 + Math.random() * 0.4));
}

export const newMessageId = () => randomBytes(8).toString('hex');

function serverSettings() {
  mkdirSync(config.dataDir, { recursive: true });
  const tokenPath = join(config.dataDir, 'token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString('hex'), { mode: 0o600 });
  const token = readFileSync(tokenPath, 'utf8').trim();

  const confPath = join(config.dataDir, 'nats.conf');
  const storeDir = join(config.dataDir, 'jetstream').replaceAll('\\', '/');
  // sync_interval: always fsyncs each write, so an acknowledged publish survives
  // power loss. Agent chat is low volume, so the write cost does not matter.
  writeFileSync(confPath, [
    `listen: "127.0.0.1:${config.natsPort}"`,
    `jetstream { store_dir: "${storeDir}", sync_interval: "always" }`,
    `authorization { token: "${token}" }`,
    '',
  ].join('\n'));
  return { token, confPath };
}

function startServer(confPath) {
  if (!existsSync(config.natsBinary)) {
    throw new Error(`nats-server is missing at ${config.natsBinary}. Run: npm install`);
  }
  // Detached so queued messages stay reachable when the bridge or an agent exits.
  // If two callers race, the loser fails to bind the port and exits harmlessly.
  const log = openSync(join(config.dataDir, 'nats-server.log'), 'a');
  const child = spawn(config.natsBinary, ['-c', confPath], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

/** Connects to the local server, starting it first if nothing is listening. */
export async function connectBus({ deadlineMs = 30_000, name = 'agentbus' } = {}) {
  const { token, confPath } = serverSettings();
  const servers = `nats://127.0.0.1:${config.natsPort}`;
  const deadline = Date.now() + deadlineMs;
  let started = false;
  let lastError;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    try {
      const nc = await connect({
        servers,
        token,
        name,
        timeout: 2_000,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1_000,
      });
      const js = jetstream(nc);
      const jsm = await jetstreamManager(nc);
      return { nc, js, jsm };
    } catch (err) {
      lastError = err;
      if (!started) {
        startServer(confPath);
        started = true;
      }
      await sleep(backoffMs(attempt, 200, 3_000));
    }
  }
  throw new Error(`Could not reach nats-server at ${servers}: ${lastError?.message}`);
}

export async function ensureTopology({ jsm }) {
  const streamConfig = {
    name: STREAM,
    subjects: ['agentbus.inbox.*', 'agentbus.dlq.*'],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    max_age: nanos(config.retentionDays * 86_400_000),
    duplicate_window: nanos(120_000),
  };
  try {
    await jsm.streams.info(STREAM);
    await jsm.streams.update(STREAM, streamConfig);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await jsm.streams.add(streamConfig);
  }
  for (const agent of config.agents) {
    // max_ack_pending=1 gives strict FIFO: the next message waits until this
    // one is acked. max_deliver is unlimited because the bridge moves exhausted
    // messages to the DLQ itself; the server would otherwise just stop trying.
    const name = consumerName(agent);
    const ackWait = nanos(config.ackWaitMs);
    try {
      // The server rejects adding a consumer that exists with a different ackWait.
      const { config: current } = await jsm.consumers.info(STREAM, name);
      if (current.ack_wait !== ackWait) await jsm.consumers.update(STREAM, name, { ack_wait: ackWait });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await jsm.consumers.add(STREAM, {
        durable_name: name,
        filter_subject: inboxSubject(agent),
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: ackWait,
        max_ack_pending: 1,
        max_deliver: -1,
      });
    }
  }
}

export function isNotFound(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return text.includes('not found') || text.includes('404');
}

export async function openStateBucket({ nc }) {
  return new Kvm(nc).create(STATE_BUCKET, { history: 1, storage: StorageType.File });
}

/** Publishes durably. Retries reuse the msgID, so the stream dedupes them. */
export async function publishWithRetry({ js }, subject, envelope, { msgId = envelope.id, attempts = 8 } = {}) {
  const payload = JSON.stringify(envelope);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await js.publish(subject, payload, { msgID: msgId, timeout: 5_000 });
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(backoffMs(attempt, 250, 10_000));
    }
  }
  throw new Error(`Publish to ${subject} failed after ${attempts} attempts: ${lastError?.message}`);
}

export async function sendMessage(bus, { from, to, body, thread, inReplyTo }) {
  const envelope = {
    id: newMessageId(),
    from,
    to,
    thread: thread ?? null,
    in_reply_to: inReplyTo ?? null,
    body,
    ts: new Date().toISOString(),
  };
  const ack = await publishWithRetry(bus, inboxSubject(to), envelope);
  return { id: envelope.id, seq: ack.seq, duplicate: ack.duplicate };
}

export async function deadLetter(bus, agent, envelope, reason, attempts) {
  return publishWithRetry(bus, dlqSubject(agent), {
    ...envelope,
    dead_letter: { reason, attempts, at: new Date().toISOString() },
  }, { msgId: `dlq-${envelope.id ?? newMessageId()}` });
}
