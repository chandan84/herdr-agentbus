#!/usr/bin/env node
// Operator commands: status, send, resume, dlq list, dlq retry, stop.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import { BUDGET_KEY, STREAM, config, consumerName, dlqSubject } from './config.mjs';
import { connectBus, ensureTopology, openStateBucket, sendMessage } from './bus.mjs';
import { findAgent, startBridge } from './terminal.mjs';

const USAGE = `Usage: node src/cli.mjs <command>
  bridge                         Start the bridge in its own hc terminal
  status                         Queue depth, agent state, and pause state
  send <from> <to> <body...>     Queue a message
  resume                         Clear the hop-limit pause
  dlq list                       Show dead-lettered messages
  dlq retry <id>                 Move a dead letter to the back of its inbox
  stop                           Stop nats-server (queued messages stay on disk)`;

async function deadLetters(bus) {
  const out = [];
  for (const agent of config.agents) {
    const info = await bus.jsm.consumers.add(STREAM, {
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.All,
      filter_subject: dlqSubject(agent),
      inactive_threshold: 30_000_000_000,
    });
    const consumer = await bus.js.consumers.get(STREAM, info.name);
    let remaining = info.num_pending;
    while (remaining > 0) {
      const msg = await consumer.next({ expires: 2_000 });
      if (!msg) break;
      out.push({ agent, seq: msg.seq, env: msg.json() });
      remaining -= 1;
    }
    await consumer.delete().catch(() => {});
  }
  return out;
}

async function status(bus) {
  const kv = await openStateBucket(bus);
  const entry = await kv.get(BUDGET_KEY);
  const budget = entry?.operation === 'PUT' ? entry.json() : { count: 0, paused: false };
  console.log(`hops: ${budget.count}/${config.hopLimit}${budget.paused ? '  PAUSED (run: resume)' : ''}`);
  for (const agent of config.agents) {
    const c = await bus.jsm.consumers.info(STREAM, consumerName(agent));
    const found = await findAgent(agent);
    console.log(`${agent}: pane=${found.target ?? '-'} state=${found.state} queued=${c.num_pending} in_flight=${c.num_ack_pending}${found.detail ? ` (${found.detail})` : ''}`);
  }
  console.log(`dead letters: ${(await deadLetters(bus)).length}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }

  if (command === 'bridge') {
    const res = await startBridge();
    console.log(res.ok ? `Bridge started: ${res.stdout.trim()}` : `Not started: ${res.message}`);
    return;
  }

  if (command === 'stop') {
    // Targets only this bus's server, not other nats-server processes on the machine.
    const { execFileSync } = await import('node:child_process');
    if (process.platform !== 'win32') {
      execFileSync('pkill', ['-f', config.natsBinary], { stdio: 'inherit' });
      return;
    }
    const row = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
      .split('\n')
      .find((line) => line.includes(`127.0.0.1:${config.natsPort} `) && line.includes('LISTENING'));
    if (!row) {
      console.log('nats-server is not running.');
      return;
    }
    execFileSync('taskkill', ['/F', '/PID', row.trim().split(/\s+/).pop()], { stdio: 'inherit' });
    return;
  }

  const bus = await connectBus({ name: 'agentbus-cli' });
  await ensureTopology(bus);
  try {
    if (command === 'status') {
      await status(bus);
    } else if (command === 'send') {
      const [from, to, ...body] = args;
      if (!from || !to || body.length === 0) throw new Error(USAGE);
      console.log(await sendMessage(bus, { from, to, body: body.join(' ') }));
    } else if (command === 'resume') {
      const kv = await openStateBucket(bus);
      await kv.delete(BUDGET_KEY);
      console.log('Resumed.');
    } else if (command === 'dlq' && args[0] === 'list') {
      for (const { agent, env } of await deadLetters(bus)) {
        console.log(`${env.id} to=${agent} from=${env.from} reason="${env.dead_letter?.reason}" attempts=${env.dead_letter?.attempts}`);
      }
    } else if (command === 'dlq' && args[0] === 'retry' && args[1]) {
      const entry = (await deadLetters(bus)).find((d) => d.env.id === args[1]);
      if (!entry) throw new Error(`No dead letter with id ${args[1]}`);
      const { from, thread, in_reply_to: inReplyTo, body } = entry.env;
      const sent = await sendMessage(bus, { from, to: entry.agent, body, thread, inReplyTo });
      await bus.jsm.streams.deleteMessage(STREAM, entry.seq);
      console.log(`Requeued as ${sent.id}`);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    await bus.nc.drain().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
