#!/usr/bin/env node
// Stands in for the hc CLI in tests. FAKE_HC_DIR holds <agent>.json files:
//   { status, turn, turnMs, stallsLeft, lostAck, enterLost, keysIgnored, pending,
//     collapsePaste, typed, footer, userTurnOnStall, screen, hide, received: [], attempts: [] }
// calls.log records each call, for tests of how often hc runs.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_HC_DIR;
const args = process.argv.slice(2);
const pathFor = (agent) => join(dir, `${agent}.json`);
const load = (agent) => JSON.parse(readFileSync(pathFor(agent), 'utf8'));
const save = (agent, state) => writeFileSync(pathFor(agent), JSON.stringify(state));
const KIND = { claude: 'claude-code', codex: 'codex' };
const addressOf = (agent) => `t-${agent}`;
const agentOf = (address) => address.replace(/^t-/, '');

function fail(exitCode, message) {
  process.stderr.write(JSON.stringify({ error: { kind: 'fake', message } }));
  process.exit(exitCode);
}

// A turn ends once its deadline passes, so no background process is needed.
function settle(agent) {
  const state = load(agent);
  if (state.status === 'working' && Date.now() >= (state.busyUntil ?? 0)) {
    state.status = 'done';
    save(agent, state);
  }
  return state;
}

function startTurn(agent, state) {
  state.status = 'working';
  state.turn = (state.turn ?? 0) + 1;
  state.pending = false;
  state.busyUntil = Date.now() + (state.turnMs ?? 50);
  save(agent, state);
}

// An unsubmitted paste as an agent shows it. Long ones collapse to a placeholder.
function renderInputBox(state) {
  const message = state.received.at(-1);
  const paste = state.collapsePaste ? `› [Pasted Content ${message.length} chars]` : message;
  return `${paste}${state.typed ?? ''}\n${state.footer ?? 'footer'}`;
}

const [command] = args;
appendFileSync(join(dir, 'calls.log'), `${command}\n`);
if (command === 'ls') {
  const terminals = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .map((name) => ({ name, state: settle(name) }))
    .filter(({ state }) => !state.hide)
    .map(({ name, state }) => ({
      address: addressOf(name),
      agent: KIND[name],
      state: 'live',
      status: state.status,
      turn: state.turn ?? 0,
      ...(state.lsOverride ?? {}),
    }));
  console.log(JSON.stringify({ terminals }));
} else if (command === 'send') {
  const agent = agentOf(args[1]);
  if (!existsSync(pathFor(agent))) fail(3, 'no terminal');
  const state = settle(agent);
  if (state.status === 'blocked') fail(9, 'blocked');
  if (state.stallsLeft > 0) {
    state.stallsLeft -= 1;
    state.attempts = [...(state.attempts ?? []), Date.now()];
    if (state.userTurnOnStall) {
      // Someone submits their own text while this send fails.
      state.userTurnOnStall = false;
      startTurn(agent, state);
    } else {
      save(agent, state);
    }
    console.log(JSON.stringify({ started: false, wait: { reason: 'not_started' } }));
  } else {
    state.received.push(args[2]);
    if (state.lostAck || state.enterLost) {
      // Pasted but never submitted. hc reports this either way, as seen with Codex.
      const started = Boolean(state.enterLost);
      state.lostAck = false;
      state.enterLost = false;
      state.pending = true;
      save(agent, state);
      console.log(JSON.stringify({ started, status: 'idle', wait: { reason: 'status', status: 'idle' } }));
    } else {
      startTurn(agent, state);
      console.log(JSON.stringify({ started: true, status: 'idle', wait: { reason: 'timeout', status: 'working' } }));
    }
  }
} else if (command === 'keys') {
  const agent = agentOf(args[1]);
  const state = settle(agent);
  state.enterPresses = (state.enterPresses ?? 0) + 1;
  if (state.keysIgnored > 0) {
    state.keysIgnored -= 1;
    save(agent, state);
  } else if (state.pending) {
    startTurn(agent, state);
  } else {
    save(agent, state);
  }
  console.log('{}');
} else if (command === 'read') {
  const state = load(agentOf(args[1]));
  const screenOnly = args[args.indexOf('--lines') + 1] === '0';
  if (screenOnly) console.log(state.pending ? renderInputBox(state) : (state.screen ?? ''));
  else console.log(state.received.join('\n'));
} else {
  fail(2, `fake-hc: ${args.join(' ')}`);
}
