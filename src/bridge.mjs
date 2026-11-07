#!/usr/bin/env node
// Moves messages from each agent's durable inbox into its terminal, one at a
// time. A message is acked only after the turn it started has settled.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BUDGET_KEY, STREAM, config, consumerName } from './config.mjs';
import { backoffMs, connectBus, deadLetter, ensureTopology, openStateBucket, sleep } from './bus.mjs';
import { findAgent, paneContains, pressEnter, readInputBox, showsDialog, submitPrompt } from './terminal.mjs';

let stopping = false;
const READY = new Set(['idle', 'done']);
const REDELIVERY_CAP_FACTOR = 5;

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  try {
    appendFileSync(join(config.dataDir, 'bridge.log'), `${text}\n`);
  } catch {
    // Logging must never stop delivery.
  }
}

function acquireLock() {
  mkdirSync(config.dataDir, { recursive: true });
  const path = join(config.dataDir, 'bridge.lock');
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(path, 'utf8'));
      try {
        process.kill(pid, 0);
        return null; // Holder is alive.
      } catch {
        unlinkSync(path); // Stale lock from a crashed bridge.
      }
    }
  }
  return null;
}

export const marker = (id) => `[agentbus id=${id}`;

export function renderPrompt(env) {
  const header = [`${marker(env.id)} from=${env.from}`];
  if (env.thread) header.push(`thread=${env.thread}`);
  if (env.in_reply_to) header.push(`in_reply_to=${env.in_reply_to}`);
  return [
    `${header.join(' ')}]`,
    env.body,
    '',
    `(Sent by the agent "${env.from}" over agentbus, not typed by the user. `
      + `To reply, call the agentbus send tool with to="${env.from}" and in_reply_to="${env.id}". `
      + 'If you already handled this id, ignore it.)',
  ].join('\n');
}

/** Tracks consecutive deliveries in KV so the runaway pause survives restarts. */
function makeBudget(kv) {
  const read = async () => {
    const entry = await kv.get(BUDGET_KEY);
    if (!entry || entry.operation !== 'PUT') return { value: { count: 0, lastAt: 0, paused: false }, revision: entry?.revision ?? 0 };
    return { value: entry.json(), revision: entry.revision };
  };
  return {
    async isPaused() {
      return (await read()).value.paused === true;
    },
    /** Returns true when this delivery used up the budget. */
    async record() {
      for (let i = 0; i < 5; i += 1) {
        const { value, revision } = await read();
        const now = Date.now();
        const count = now - value.lastAt > config.quietResetMs ? 1 : value.count + 1;
        const next = { count, lastAt: now, paused: count >= config.hopLimit };
        try {
          // update() rejects revision 0, which is what a never-written key has.
          if (revision === 0) await kv.create(BUDGET_KEY, JSON.stringify(next));
          else await kv.update(BUDGET_KEY, JSON.stringify(next), revision);
          return next.paused;
        } catch {
          await sleep(20); // Another agent loop or a resume won the update.
        }
      }
      log('could not update the hop count; the runaway guard missed a delivery');
      return false;
    },
  };
}

class Courier {
  constructor(agent, bus, consumer, budget) {
    // `current` is the one message in flight and its failed attempts. It lives in memory,
    // so a bridge crash doesn't use up attempts.
    Object.assign(this, { agent, bus, consumer, budget, lastState: null, current: null });
  }

  note(state, detail) {
    const key = `${state}:${detail ?? ''}`;
    if (key === this.lastState) return;
    this.lastState = key;
    log(`[${this.agent}] ${state}${detail ? ` (${detail})` : ''}`);
  }

  /** Waits without a time limit: a pause or a busy or absent agent is not a failed delivery. */
  async waitUntilReady() {
    while (!stopping) {
      if (await this.budget.isPaused()) {
        this.note('paused', 'hop limit reached; run: node src/cli.mjs resume');
        await sleep(config.pollMs);
        continue;
      }
      const found = await findAgent(this.agent);
      if (READY.has(found.state)) {
        if (!(await showsDialog(found.target))) {
          this.note('ready', found.target);
          return found;
        }
        this.note('dialog', 'waiting for you to answer the dialog in this pane');
      } else {
        this.note(found.state, found.detail);
      }
      await sleep(config.pollMs);
    }
    return null;
  }

  /** Returns true once the agent's turn counter passes `turn` or it shows activity. */
  async turnStarted(turn) {
    const deadline = Date.now() + config.startGraceMs;
    do {
      const found = await findAgent(this.agent);
      if (found.turn > turn || found.state === 'working' || found.state === 'blocked') return true;
      await sleep(config.pollMs);
    } while (Date.now() < deadline && !stopping);
    return false;
  }

  /** Returns true when the turn settled, false if the agent went away mid-turn. */
  async waitUntilSettled() {
    while (!stopping) {
      const found = await findAgent(this.agent);
      if (READY.has(found.state)) return true;
      if (found.state === 'missing') return false;
      await sleep(config.pollMs);
    }
    return false;
  }

  /**
   * Presses Enter on a pasted message only if the screen shows this message and nothing
   * else. Holding for you uses no attempt. Returns true once a turn started.
   */
  async submitPasted(target, turn, id, promptChars) {
    while (!stopping) {
      const box = await readInputBox(target, marker(id), promptChars);
      if (box === 'message') {
        log(`[${this.agent}] ${id} is unsubmitted in the input box; pressing Enter`);
        await pressEnter(target);
        return this.turnStarted(turn);
      }
      if (box === 'absent' || box === 'unknown') return false;
      this.note('holding', `${box} in the input box; submit or clear it to continue`);
      await sleep(config.pollMs);
      const found = await findAgent(this.agent);
      // That turn may be your own draft, so only the pane proves this message ran. If it
      // didn't, retrying it risks at worst a duplicate, where acking it would lose it.
      if (found.turn > turn || found.state === 'working') return paneContains(target, marker(id));
      if (found.state === 'missing') return false;
    }
    return false;
  }

  async run() {
    while (!stopping) {
      try {
        // Waiting for the agent happens only once there's a message, so an idle bus runs no hc.
        const msg = await this.consumer.next({ expires: config.fetchExpiresMs });
        if (msg) await this.handle(msg);
      } catch (err) {
        log(`[${this.agent}] loop error: ${err.message}`);
        await sleep(backoffMs(1, 1_000));
      }
    }
  }

  async handle(msg) {
    const { deliveryCount } = msg.info;
    let env;
    try {
      env = msg.json();
      if (!env?.id || typeof env.body !== 'string') throw new Error('missing id or body');
    } catch (err) {
      await this.bury(msg, { id: `seq-${msg.seq}`, raw: msg.string() }, `unreadable message: ${err.message}`, deliveryCount);
      return;
    }
    if (this.current?.id !== env.id) this.current = { id: env.id, failures: 0 };
    // Crashes aren't failed attempts, but a message that keeps killing the bridge must not
    // loop forever. Normal retries never get near this.
    if (deliveryCount > config.maxAttempts * REDELIVERY_CAP_FACTOR) {
      await this.bury(msg, env, `redelivered ${deliveryCount - 1} times`, this.current.failures);
      return;
    }

    const beat = setInterval(() => {
      try { msg.working(); } catch { /* Reconnecting: the server redelivers if this lasts. */ }
    }, config.heartbeatMs);
    try {
      await this.deliver(msg, env, deliveryCount > 1);
    } finally {
      clearInterval(beat);
    }
  }

  async deliver(msg, env, redelivered) {
    const prompt = renderPrompt(env);
    let mayAlreadyBeInPane = redelivered;
    let counted = false;
    while (!stopping) {
      const ready = await this.waitUntilReady();
      if (!ready) return;
      const { target, turn } = ready;

      // A redelivery may follow a crash or a lost Enter. If the message is already
      // in the pane, never paste it again: the agent would run it twice.
      const box = mayAlreadyBeInPane ? await readInputBox(target, marker(env.id), prompt.length) : 'absent';
      if (box !== 'absent' && box !== 'unknown') {
        if (!(await this.submitPasted(target, turn, env.id, prompt.length))) {
          await this.fail(msg, env, 'Enter did not start a turn');
          return;
        }
      } else if (mayAlreadyBeInPane && (await paneContains(target, marker(env.id)))) {
        log(`[${this.agent}] ${env.id} already in pane; not resending`);
      } else {
        // The other agent's courier may have hit the hop limit since waitUntilReady.
        if (await this.budget.isPaused()) continue;
        log(`[${this.agent}] delivering ${env.id} from ${env.from} (attempt ${this.current.failures + 1})`);
        const res = await submitPrompt(target, prompt, config.promptTimeoutMs);
        if (['blocked', 'not_found', 'finished', 'status_mismatch'].includes(res.code)) {
          // Lost a race with a state change. This is not a delivery failure.
          this.note('holding', res.code);
          await sleep(config.pollMs);
          continue;
        }
        if (!res.ok && !['not_started', 'cli_timeout'].includes(res.code)) {
          await this.fail(msg, env, `${res.code}: ${res.message}`);
          return;
        }
        // With Codex on Windows the paste lands but its Enter is lost, and hc returns not_started.
        // Without proof of a paste, a turn that starts may be your own, so check the pane.
        const submitted = (await this.turnStarted(turn))
          ? res.ok || (await paneContains(target, marker(env.id)))
          : await this.submitPasted(target, turn, env.id, prompt.length);
        if (!submitted) {
          await this.fail(msg, env, res.ok ? 'no turn started' : `${res.code}: ${res.message}`);
          return;
        }
      }

      if (!counted) {
        counted = true;
        if (await this.budget.record()) {
          log(`hop limit of ${config.hopLimit} reached; pausing after this turn. Run: node src/cli.mjs resume`);
        }
      }

      if (await this.waitUntilSettled()) {
        await msg.ackAck({ timeout: 5_000 }).catch((err) => log(`[${this.agent}] ack failed: ${err.message}`));
        this.current = null;
        log(`[${this.agent}] done ${env.id}`);
        return;
      }
      if (stopping) return;
      // The agent went away mid-turn. Keep the message for its replacement.
      log(`[${this.agent}] agent went away during ${env.id}; holding`);
      mayAlreadyBeInPane = true;
    }
  }

  async fail(msg, env, reason) {
    this.current.failures += 1;
    const attempt = this.current.failures;
    if (attempt >= config.maxAttempts) {
      await this.bury(msg, env, reason, attempt);
      return;
    }
    const delay = backoffMs(attempt);
    log(`[${this.agent}] attempt ${attempt} failed for ${env.id}: ${reason}; retrying in ${delay}ms`);
    // The message stays pending during the delay, which holds its place in line.
    msg.nak(delay);
  }

  async bury(msg, env, reason, attempts) {
    // Publish before term(): a crash between the two leaves a duplicate in the
    // DLQ (deduped by msgID) rather than losing the message.
    await deadLetter(this.bus, this.agent, env, reason, attempts);
    msg.term(reason);
    this.current = null;
    log(`[${this.agent}] dead-lettered ${env.id}: ${reason}. See: node src/cli.mjs dlq list`);
  }
}

async function main() {
  const release = acquireLock();
  if (!release) {
    console.log('Another agentbus bridge is already running. Exiting.');
    return;
  }
  const bus = await connectBus({ name: 'agentbus-bridge' });
  await ensureTopology(bus);
  const budget = makeBudget(await openStateBucket(bus));
  log(`bridge up for: ${config.agents.join(', ')}`);

  const shutdown = () => {
    stopping = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const couriers = await Promise.all(config.agents.map(async (agent) => {
    const consumer = await bus.js.consumers.get(STREAM, consumerName(agent));
    return new Courier(agent, bus, consumer, budget);
  }));
  await Promise.all(couriers.map((c) => c.run()));
  await bus.nc.drain().catch(() => {});
  release();
  log('bridge stopped');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
