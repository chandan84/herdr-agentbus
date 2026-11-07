// Runs the real bridge and a real nats-server against a fake hc CLI, covering
// the failure paths that a live agent cannot be made to produce on demand.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const dataDir = join(root, '.test-data', 'nats');
const fakeDir = join(root, '.test-data', 'fake');
const port = '4399';

Object.assign(process.env, {
  AGENTBUS_CONFIG: join(root, '.test-data', 'no-config.json'), // Your own config can't affect tests.
  AGENTBUS_DATA_DIR: dataDir,
  AGENTBUS_NATS_PORT: port,
  AGENTBUS_ACK_WAIT_MS: '1500',
  AGENTBUS_HEARTBEAT_MS: '400',
  AGENTBUS_POLL_MS: '60',
  AGENTBUS_FETCH_EXPIRES_MS: '1000',
  AGENTBUS_PROMPT_TIMEOUT_MS: '500',
  AGENTBUS_START_GRACE_MS: '300',
  AGENTBUS_BACKOFF_BASE_MS: '200',
  AGENTBUS_BACKOFF_CAP_MS: '2000',
  AGENTBUS_MAX_ATTEMPTS: '4',
  AGENTBUS_HOP_LIMIT: '1000',
  AGENTBUS_HC_ARGV: JSON.stringify([process.execPath, join(root, 'test', 'fake-hc.mjs')]),
  FAKE_HC_DIR: fakeDir,
});

const { connectBus, ensureTopology, openStateBucket, sendMessage, sleep } = await import('../src/bus.mjs');
const { BUDGET_KEY, STREAM, consumerName, inboxSubject } = await import('../src/config.mjs');

const agentFile = (a) => join(fakeDir, `${a}.json`);
function readAgent(a) {
  // fake-hc rewrites this file in place, so a read can catch it half-written.
  for (let i = 0; ; i += 1) {
    try {
      return JSON.parse(readFileSync(agentFile(a), 'utf8'));
    } catch (err) {
      if (i >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
const writeAgent = (a, patch) => writeFileSync(agentFile(a), JSON.stringify({ status: 'idle', received: [], ...patch }));
const updateAgent = (a, patch) => writeFileSync(agentFile(a), JSON.stringify({ ...readAgent(a), ...patch }));

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

let bus;
let bridge;

function startBridge(env = {}) {
  const child = spawn(process.execPath, ['src/bridge.mjs'], { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' });
  bridge = child;
  return child;
}

async function stopBridge() {
  if (!bridge) return;
  const child = bridge;
  bridge = null;
  child.kill('SIGKILL');
  await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  rmSync(join(dataDir, 'bridge.lock'), { force: true });
}

function killNats() {
  try {
    // Scoped to the test port so a real bus on the default port is untouched.
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      const row = out.split('\n').find((l) => l.includes(`127.0.0.1:${port} `) && l.includes('LISTENING'));
      if (row) execFileSync('taskkill', ['/F', '/PID', row.trim().split(/\s+/).pop()], { stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', `.test-data/nats/nats.conf`], { stdio: 'ignore' });
    }
  } catch {
    // Nothing was running.
  }
}

const delivered = (a) => readAgent(a).received.map((p) => p.split('\n')[1]);
const queueEmpty = async (a) => {
  const info = await bus.jsm.consumers.info(STREAM, consumerName(a));
  return info.num_pending === 0 && info.num_ack_pending === 0;
};

before(async () => {
  killNats();
  await sleep(300);
  rmSync(join(root, '.test-data'), { recursive: true, force: true });
  mkdirSync(fakeDir, { recursive: true });
  writeAgent('claude', {});
  writeAgent('codex', {});
  bus = await connectBus({ name: 'test' });
  await ensureTopology(bus);
});

beforeEach(async () => {
  await stopBridge();
  await bus.jsm.streams.purge(STREAM);
  rmSync(join(fakeDir, 'calls.log'), { force: true });
  writeAgent('claude', {});
  writeAgent('codex', {});
  await (await openStateBucket(bus)).delete(BUDGET_KEY);
});

after(async () => {
  await stopBridge();
  await bus.nc.close();
  killNats();
});

/** Runs `cli config` with only the given settings, and returns its output or error. */
function configWith(fileContent, env = {}) {
  const path = join(root, '.test-data', 'config-test.json');
  if (fileContent === null) rmSync(path, { force: true });
  else writeFileSync(path, fileContent);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTBUS_')));
  try {
    return execFileSync(process.execPath, ['src/cli.mjs', 'config'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...clean, AGENTBUS_CONFIG: path, ...env },
    });
  } catch (err) {
    return err.stderr;
  }
}

test('settings come from the defaults, then the config file, then the environment', () => {
  const defaults = configWith(null);
  assert.match(defaults, /not found: using defaults/);
  assert.match(defaults, /natsPort: 4322/);
  assert.match(defaults, /hopLimit: 20/);

  const fromFile = configWith('{ "natsPort": 5000, "hopLimit": 7, "agents": ["claude", "reviewer"] }');
  assert.match(fromFile, /natsPort: 5000/);
  assert.match(fromFile, /hopLimit: 7/);
  assert.match(fromFile, /"reviewer"/);
  assert.match(fromFile, /maxAttempts: 10/);

  const fromEnv = configWith('{ "hopLimit": 7 }', { AGENTBUS_HOP_LIMIT: '9' });
  assert.match(fromEnv, /hopLimit: 9/);
});

test('a bad config file stops with a clear error', () => {
  assert.match(configWith('{ nope'), /not valid JSON/);
  assert.match(configWith('{ "hopLimt": 7 }'), /Unknown setting .*hopLimt/);
  assert.match(configWith('{ "hopLimit": "7" }'), /hopLimit must be a positive number/);
  assert.match(configWith('{ "hopLimit": 0 }'), /hopLimit must be a positive number/);
  assert.match(configWith('{ "natsPort": 70000 }'), /natsPort must be a port number/);
  assert.match(configWith('{ "agents": ["claude"] }'), /at least two/);
  assert.match(configWith('{ "heartbeatMs": 60000 }'), /must be less than ackWaitMs/);
  assert.match(configWith('{ "hopLimit": 7 }', { AGENTBUS_POLL_MS: 'x' }), /pollMs must be a positive number/);
});

test('global instructions keep your own text, and can be replaced and removed', async () => {
  const { applyInstructions, agentInstructions } = await import('../src/instructions.mjs');
  const mine = '# My notes\n\nKeep this.\n';

  const added = applyInstructions(mine, 'first');
  assert.ok(added.startsWith(mine));
  assert.match(added, /first/);

  const updated = applyInstructions(added, 'second');
  assert.doesNotMatch(updated, /first/);
  assert.match(updated, /second/);
  assert.equal(updated.match(/herdr-agentbus:start/g).length, 1);

  assert.equal(applyInstructions(updated, null), mine);
  assert.equal(applyInstructions(mine, null), mine);
  assert.equal(applyInstructions(applyInstructions('', 'only'), null), '');

  const middle = applyInstructions(`${applyInstructions('top', 'x')}\nbottom\n`, 'y');
  assert.match(middle, /^top\n\n<!-- herdr-agentbus:start -->\ny\n<!-- herdr-agentbus:end -->\n\nbottom\n$/);

  const section = agentInstructions(readFileSync(join(root, 'AGENTS.md'), 'utf8'));
  assert.ok(section.startsWith('# Working with the other agent'));
  assert.doesNotMatch(section, /# Installing/);
});

test('changing ackWaitMs updates the existing bus instead of failing', async () => {
  const ackWait = async () => (await bus.jsm.consumers.info(STREAM, consumerName('claude'))).config.ack_wait;
  const status = (ms) => execFileSync(process.execPath, ['src/cli.mjs', 'status'], {
    cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, AGENTBUS_ACK_WAIT_MS: ms },
  });
  status('3000');
  assert.equal(await ackWait(), 3_000_000_000);
  status(process.env.AGENTBUS_ACK_WAIT_MS);
  assert.equal(await ackWait(), 1_500_000_000);
});

test('a hop limit from the config file is what the bridge enforces', async () => {
  const path = join(root, '.test-data', 'config-hops.json');
  writeFileSync(path, '{ "hopLimit": 2 }');
  for (let i = 1; i <= 3; i += 1) await sendMessage(bus, { from: 'codex', to: 'claude', body: `f${i}` });
  startBridge({ AGENTBUS_CONFIG: path, AGENTBUS_HOP_LIMIT: '' });
  await waitFor(() => readAgent('claude').received.length === 2, 'two deliveries');
  await sleep(1_000);
  assert.deepEqual(delivered('claude'), ['f1', 'f2']);
});

test('delivers both directions in FIFO order, one turn at a time', async () => {
  updateAgent('claude', { turnMs: 150 });
  for (let i = 1; i <= 5; i += 1) await sendMessage(bus, { from: 'codex', to: 'claude', body: `c${i}` });
  for (let i = 1; i <= 3; i += 1) await sendMessage(bus, { from: 'claude', to: 'codex', body: `x${i}` });
  startBridge();
  await waitFor(async () => (await queueEmpty('claude')) && (await queueEmpty('codex')), 'queues to drain');
  assert.deepEqual(delivered('claude'), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(delivered('codex'), ['x1', 'x2', 'x3']);
});

test('a prompt carries the sender, the id, and reply instructions', async () => {
  const { id } = await sendMessage(bus, { from: 'codex', to: 'claude', body: 'hello', thread: 't1' });
  startBridge();
  await waitFor(() => queueEmpty('claude'), 'delivery');
  const [prompt] = readAgent('claude').received;
  assert.match(prompt, new RegExp(`^\\[agentbus id=${id} from=codex thread=t1\\]\\nhello\\n`));
  assert.match(prompt, /to="codex"/);
  assert.match(prompt, new RegExp(`in_reply_to="${id}"`));
});

test('messages queued while the bridge is down survive and arrive after it starts', async () => {
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'offline' });
  await sleep(300);
  assert.equal(readAgent('claude').received.length, 0);
  startBridge();
  await waitFor(() => readAgent('claude').received.length === 1, 'delivery');
});

test('messages survive a nats-server restart', async () => {
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'kept-1' });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'kept-2' });
  await bus.nc.close();
  killNats();
  await sleep(500);
  bus = await connectBus({ name: 'test' }); // Restarts the server from disk.
  startBridge();
  await waitFor(() => readAgent('claude').received.length === 2, 'delivery after restart');
  assert.deepEqual(delivered('claude'), ['kept-1', 'kept-2']);
});

test('retries a stalled prompt with growing delays, and keeps later messages behind it', async () => {
  updateAgent('claude', { stallsLeft: 3 });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'first' });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'second' });
  startBridge();
  await waitFor(() => queueEmpty('claude'), 'queue to drain', 30_000);
  assert.deepEqual(delivered('claude'), ['first', 'second']);
  const { attempts } = readAgent('claude');
  assert.equal(attempts.length, 3);
  const gaps = [attempts[1] - attempts[0], attempts[2] - attempts[1]];
  // Backoff is 200ms then 400ms, +/-20%, plus processing time; jitter must not reorder them.
  assert.ok(gaps[0] >= 160, `first gap ${gaps[0]}`);
  assert.ok(gaps[1] > gaps[0], `gaps should grow: ${gaps}`);
});

test('after max attempts a message is dead-lettered and the queue moves on', async () => {
  updateAgent('claude', { stallsLeft: 4 });
  const { id } = await sendMessage(bus, { from: 'codex', to: 'claude', body: 'poison' });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'after-poison' });
  startBridge();
  await waitFor(() => queueEmpty('claude'), 'queue to drain', 30_000);
  assert.deepEqual(delivered('claude'), ['after-poison']);
  const out = execFileSync(process.execPath, ['src/cli.mjs', 'dlq', 'list'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.match(out, new RegExp(`${id} to=claude from=codex`));
});

test('a timeout after a successful submit does not deliver twice', async () => {
  updateAgent('claude', { lostAck: true });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'once' });
  startBridge();
  await waitFor(() => queueEmpty('claude'), 'queue to drain');
  assert.deepEqual(delivered('claude'), ['once']);
});

test('a paste whose Enter was lost is submitted, not acked or pasted again', async () => {
  updateAgent('codex', { enterLost: true, turnMs: 400 });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'stuck' });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'after' });
  startBridge();
  await waitFor(() => queueEmpty('codex'), 'queue to drain');
  assert.deepEqual(delivered('codex'), ['stuck', 'after']);
  assert.equal(readAgent('codex').enterPresses, 1);
  assert.equal(readAgent('codex').turn, 2);
});

test('a retry finds a message still in the input box and presses Enter instead of pasting', async () => {
  updateAgent('codex', { enterLost: true, keysIgnored: 1 });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'stubborn' });
  startBridge();
  await waitFor(() => queueEmpty('codex'), 'queue to drain', 20_000);
  assert.deepEqual(delivered('codex'), ['stubborn']);
  assert.equal(readAgent('codex').enterPresses, 2);
  assert.equal(readAgent('codex').turn, 1);
});

test('a terminal named after an agent but running another kind gets nothing', async () => {
  const { findAgent } = await import('../src/terminal.mjs');
  updateAgent('claude', { lsOverride: { name: 'codex' } }); // A Claude terminal named "codex".
  const found = await findAgent('codex');
  assert.equal(found.state, 'ambiguous');
  assert.equal(found.target, undefined);
  assert.match(found.detail, /t-claude runs claude-code/);

  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'not for you' });
  startBridge();
  await sleep(1_500);
  assert.equal(readAgent('claude').received.length, 0);
  assert.equal(readAgent('codex').received.length, 0);

  updateAgent('claude', { lsOverride: null });
  await waitFor(() => queueEmpty('codex'), 'delivery to the real codex');
  assert.deepEqual(delivered('codex'), ['not for you']);
  assert.equal(readAgent('claude').received.length, 0);
});

test('a matching name wins, and a custom bus name can run any kind', async () => {
  const { findAgent } = await import('../src/terminal.mjs');
  updateAgent('codex', { lsOverride: { name: 'codex' } });
  assert.equal((await findAgent('codex')).target, 't-codex');
  updateAgent('codex', { lsOverride: { name: 'reviewer' } });
  assert.equal((await findAgent('reviewer')).target, 't-codex');
});

test('terminal checks see a message wrapped across lines inside an hc tag', async () => {
  const { readInputBox, paneContains } = await import('../src/terminal.mjs');
  const needle = '[agentbus id=abc123';
  const footer = '\n\n\n  GPT-6-Luna high · ~\\wrkspcs\\genexp · Confirm re…\n  ← for agents · ? for shortcuts\n';
  const wrapped = '› <hc from="t5 agentbus">[agentbus\n  id=abc123 from=claude]\n  Body text\n\n  (If you already handled this id, ignore\n  it.)</hc>';
  updateAgent('codex', { screen: `${wrapped}${footer}`, received: [wrapped] });
  assert.equal(await paneContains('t-codex', needle), true);
  assert.equal(await readInputBox('t-codex', needle), 'message');

  const reply = `\n• ${'A reply that ran after the message. '.repeat(6)}\n\n› Ask Codex to do anything\n`;
  updateAgent('codex', { screen: `${wrapped}${reply}` });
  assert.equal(await readInputBox('t-codex', needle), 'absent');

  updateAgent('codex', { screen: `${wrapped}abc${footer}` });
  assert.equal(await readInputBox('t-codex', needle), 'typing');
  updateAgent('codex', { screen: `› [Pasted Content 3781 chars]${footer}` });
  assert.equal(await readInputBox('t-codex', needle, 3761), 'message');
  assert.equal(await readInputBox('t-codex', needle, 2000), 'placeholder');
  updateAgent('codex', { screen: `› [Pasted Content 3781 chars]abc${footer}` });
  assert.equal(await readInputBox('t-codex', needle, 3761), 'typing');
  updateAgent('codex', { screen: `› [Pasted text #1 +40 lines]${footer}` });
  assert.equal(await readInputBox('t-codex', needle, 3761), 'placeholder');
});

test('no Enter is pressed over text you typed, and delivery continues once it is gone', async () => {
  updateAgent('codex', { enterLost: true, typed: ' my draft' });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'careful' });
  startBridge();
  await waitFor(() => readAgent('codex').received.length === 1, 'the paste');
  await sleep(1_500);
  assert.equal(readAgent('codex').enterPresses, undefined);
  updateAgent('codex', { typed: '' });
  await waitFor(() => queueEmpty('codex'), 'queue to drain');
  assert.equal(readAgent('codex').enterPresses, 1);
  assert.equal(readAgent('codex').received.length, 1);
});

test('no Enter is pressed into a dialog that appears after the paste', async () => {
  updateAgent('codex', { enterLost: true, footer: 'enter to confirm · esc to cancel' });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'careful' });
  startBridge();
  await waitFor(() => readAgent('codex').received.length === 1, 'the paste');
  await sleep(1_500);
  assert.equal(readAgent('codex').enterPresses, undefined);
  updateAgent('codex', { footer: 'footer' });
  await waitFor(() => queueEmpty('codex'), 'queue to drain');
  assert.equal(readAgent('codex').enterPresses, 1);
});

test('a long paste shown as a placeholder is retried with Enter, not pasted twice', async () => {
  updateAgent('codex', { enterLost: true, collapsePaste: true, keysIgnored: 1 });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'long' });
  startBridge();
  await waitFor(() => queueEmpty('codex'), 'queue to drain', 20_000);
  assert.equal(readAgent('codex').received.length, 1);
  assert.equal(readAgent('codex').enterPresses, 2);
  assert.equal(readAgent('codex').turn, 1);
});

test('after a restart a long paste is recognized by its size, not pasted again', async () => {
  updateAgent('codex', { enterLost: true, collapsePaste: true, keysIgnored: 1000 });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'long' });
  startBridge();
  await waitFor(() => readAgent('codex').enterPresses >= 1, 'the first Enter');
  await stopBridge();
  updateAgent('codex', { keysIgnored: 0 });
  startBridge();
  await waitFor(() => queueEmpty('codex'), 'queue to drain');
  assert.equal(readAgent('codex').received.length, 1);
  assert.equal(readAgent('codex').turn, 1);
});

test('your own long paste is never submitted, and submitting it does not lose the message', async () => {
  updateAgent('codex', { stallsLeft: 1, screen: '› [Pasted Content 5000 chars]\nfooter' });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'kept' });
  startBridge();
  await waitFor(() => readAgent('codex').attempts?.length === 1, 'the failed send');
  await sleep(1_500);
  assert.equal(readAgent('codex').enterPresses, undefined);
  updateAgent('codex', { screen: '', turn: 1 }); // You submit your draft by hand.
  await waitFor(() => queueEmpty('codex'), 'queue to drain');
  assert.deepEqual(delivered('codex'), ['kept']);
  assert.equal(readAgent('codex').enterPresses, undefined);
});

test('a turn you start while a send fails does not count as delivering the message', async () => {
  updateAgent('codex', { stallsLeft: 1, userTurnOnStall: true });
  await sendMessage(bus, { from: 'claude', to: 'codex', body: 'kept' });
  startBridge();
  await waitFor(() => queueEmpty('codex'), 'queue to drain');
  assert.deepEqual(delivered('codex'), ['kept']);
});

test('bridge crashes do not use up delivery attempts', async () => {
  updateAgent('claude', { turnMs: 6_000 });
  const { id } = await sendMessage(bus, { from: 'codex', to: 'claude', body: 'survivor' });
  startBridge({ AGENTBUS_MAX_ATTEMPTS: '1' });
  await waitFor(() => readAgent('claude').received.length === 1, 'first delivery');
  for (let i = 0; i < 2; i += 1) {
    await stopBridge();
    startBridge({ AGENTBUS_MAX_ATTEMPTS: '1' });
    await sleep(2_000); // Longer than ackWait, so each bridge gets a redelivery.
  }
  await waitFor(() => queueEmpty('claude'), 'recovery', 20_000);
  assert.equal(readAgent('claude').received.length, 1);
  const out = execFileSync(process.execPath, ['src/cli.mjs', 'dlq', 'list'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.doesNotMatch(out, new RegExp(id));
});

test('an idle bus never runs hc', async () => {
  startBridge();
  await sleep(1_500);
  assert.equal(existsSync(join(fakeDir, 'calls.log')), false);
});

test('a blocked or absent agent holds messages without using up attempts', async () => {
  updateAgent('claude', { status: 'blocked' });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'waits' });
  startBridge();
  await sleep(2_500); // Longer than ackWait, so only heartbeats could prevent redelivery.
  assert.equal(readAgent('claude').received.length, 0);
  updateAgent('claude', { status: 'idle', hide: true });
  await sleep(500);
  assert.equal(readAgent('claude').received.length, 0);
  updateAgent('claude', { hide: false });
  await waitFor(() => queueEmpty('claude'), 'delivery after agent returned');
  assert.deepEqual(delivered('claude'), ['waits']);
});

test('a dialog reported as idle holds delivery, but chat text about dialogs does not', async () => {
  updateAgent('claude', { screen: 'Trust this folder?\n1. Trust and continue\n\nenter continue · esc back\n' });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'held' });
  startBridge();
  await sleep(1_000);
  assert.equal(readAgent('claude').received.length, 0);
  updateAgent('claude', { screen: 'The dialog said: press enter to continue\nmore chat\nand more\nprompt >\n? for shortcuts\n' });
  await waitFor(() => queueEmpty('claude'), 'delivery after the dialog closed');
  assert.deepEqual(delivered('claude'), ['held']);
});

test('a turn longer than ackWait is not redelivered', async () => {
  updateAgent('claude', { turnMs: 3_500 });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'long' });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'next' });
  startBridge();
  await waitFor(() => readAgent('claude').received.length === 1, 'first delivery');
  await sleep(2_500);
  assert.deepEqual(delivered('claude'), ['long'], 'next must wait for the long turn');
  await waitFor(() => queueEmpty('claude'), 'queue to drain');
  assert.deepEqual(delivered('claude'), ['long', 'next']);
});

test('a bridge crash mid-turn redelivers to the bridge but not to the agent', async () => {
  updateAgent('claude', { turnMs: 2_500 });
  await sendMessage(bus, { from: 'codex', to: 'claude', body: 'crash' });
  startBridge();
  await waitFor(() => readAgent('claude').received.length === 1, 'first delivery');
  await stopBridge();
  startBridge();
  await waitFor(() => queueEmpty('claude'), 'recovery', 20_000);
  assert.deepEqual(delivered('claude'), ['crash']);
});

test('a second bridge exits instead of delivering in parallel', async () => {
  startBridge();
  await waitFor(() => {
    try { return readFileSync(join(dataDir, 'bridge.lock'), 'utf8').length > 0; } catch { return false; }
  }, 'lock');
  const out = execFileSync(process.execPath, ['src/bridge.mjs'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.match(out, /already running/);
});

test('publishing the same id twice stores one message', async () => {
  const { publishWithRetry } = await import('../src/bus.mjs');
  const env = { id: 'dup-1', from: 'codex', to: 'claude', body: 'once' };
  await publishWithRetry(bus, inboxSubject('claude'), env);
  const second = await publishWithRetry(bus, inboxSubject('claude'), env);
  assert.equal(second.duplicate, true);
  startBridge();
  await waitFor(() => queueEmpty('claude'), 'delivery');
  assert.equal(readAgent('claude').received.length, 1);
});

test('the hop limit pauses delivery until resume, starting from a never-written counter', async () => {
  await (await openStateBucket(bus)).destroy();
  for (let i = 1; i <= 3; i += 1) await sendMessage(bus, { from: 'codex', to: 'claude', body: `h${i}` });
  startBridge({ AGENTBUS_HOP_LIMIT: '2' });
  await waitFor(() => readAgent('claude').received.length === 2, 'two deliveries');
  await sleep(1_000);
  assert.deepEqual(delivered('claude'), ['h1', 'h2']);
  execFileSync(process.execPath, ['src/cli.mjs', 'resume'], { cwd: root, env: process.env });
  await waitFor(() => readAgent('claude').received.length === 3, 'delivery after resume');
});
