// Thin wrapper over `hc`, the CLI for herdr-core, which runs herdr-app's terminals.
import { execFile } from 'node:child_process';
import { ROOT } from './config.mjs';

// Documented hc exit codes.
const EXIT_CODES = { 3: 'not_found', 9: 'blocked', 10: 'status_mismatch', 11: 'finished' };

// hc reports Claude Code under a different name than its bus name.
const KIND_FOR = { claude: 'claude-code' };
const KNOWN_KINDS = new Set(['claude-code', 'codex']);

// The closing words of every message the bridge renders, wrapped or not.
const MESSAGE_END = /ignore\s+it\.\)/g;
// How agents show a large paste in their input box, such as "[Pasted Content 3781 chars]".
// Its size is the only clue to whose paste it is. hc's tag adds about 20 to 30 characters.
const PASTE_PLACEHOLDER = /\[Pasted[^\]]*\]/g;
const PLACEHOLDER_SIZE_TOLERANCE = 64;
// Measured on Codex: 55 to 85 characters of footer follow an unsubmitted message, and
// 205 follow even a one-line reply.
const MAX_FOOTER_CHARS = 120;
// Long enough to find a message behind a long turn. Only redeliveries read this far.
const HISTORY_LINES = 10_000;

function baseArgv() {
  return process.env.AGENTBUS_HC_ARGV ? JSON.parse(process.env.AGENTBUS_HC_ARGV) : ['hc'];
}

function run(args, { timeoutMs = 15_000 } = {}) {
  const [bin, ...prefix] = baseArgv();
  return new Promise((resolve) => {
    execFile(bin, [...prefix, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, stdout });
        return;
      }
      let code = err.killed ? 'cli_timeout' : (EXIT_CODES[err.code] ?? 'cli_error');
      let message = stderr?.trim() || err.message;
      try {
        message = JSON.parse(stderr).error?.message ?? message;
      } catch {
        // Non-JSON stderr: keep the raw text.
      }
      resolve({ ok: false, code, message, stdout });
    });
  });
}

// Terminals wrap long lines, and hc may prefix an <hc from="..."> tag, so a phrase can
// straddle a line break anywhere there's a space.
const collapse = (text) => text.replace(/\s+/g, ' ');

const normalizePath = (path) => String(path ?? '').replace(/[\\/]+$/, '').toLowerCase();

/** Narrows several same-kind agents to those working in this project's folder. */
async function inThisProject(terminals) {
  const details = await Promise.all(terminals.map(async (t) => {
    const res = await run(['get', t.address, '--json']);
    return res.ok ? JSON.parse(res.stdout) : null;
  }));
  return terminals.filter((_, i) => normalizePath(details[i]?.foreground?.cwd) === normalizePath(ROOT));
}

/**
 * Finds the live agent for a bus name. A terminal with that exact name wins, then
 * a single agent of that kind, then a single one of that kind in this folder.
 * Anything still ambiguous waits, because the wrong pane is worse than a delay.
 */
export async function findAgent(busName) {
  const res = await run(['ls', '--json']);
  if (!res.ok) return { state: 'unreachable', detail: res.message };
  let terminals;
  try {
    terminals = JSON.parse(res.stdout).terminals.filter((t) => t.state === 'live');
  } catch (err) {
    return { state: 'unreachable', detail: `Unexpected hc ls output: ${err.message}` };
  }
  const kind = KIND_FOR[busName] ?? busName;
  let matches = terminals.filter((t) => t.name === busName);
  // A bus name that is also an agent kind must really be that kind. Otherwise another
  // agent in a terminal named "codex" would receive Codex's messages. Custom bus names
  // such as "reviewer" can run any kind.
  const wrongKind = KNOWN_KINDS.has(kind) ? matches.filter((t) => t.agent !== kind) : [];
  if (wrongKind.length > 0) {
    const list = wrongKind.map((t) => `${t.address} runs ${t.agent}`).join(', ');
    return { state: 'ambiguous', detail: `terminal named ${busName}: ${list}. Rename it or close it.` };
  }
  if (matches.length === 0) matches = terminals.filter((t) => t.agent === kind);
  if (matches.length > 1) {
    const here = await inThisProject(matches);
    if (here.length > 0) matches = here;
  }
  if (matches.length === 0) return { state: 'missing' };
  if (matches.length > 1) {
    const list = matches.map((t) => t.address).join(', ');
    return { state: 'ambiguous', detail: `terminals ${list}. Start the intended one with: hc run --bg --name ${busName} ...` };
  }
  return { state: matches[0].status ?? 'unknown', target: matches[0].address, turn: matches[0].turn ?? 0 };
}

export async function pressEnter(target) {
  return run(['keys', target, 'enter']);
}

/**
 * Looks at what ends the input box, given a pattern for the paste. Returns null when
 * the pattern isn't there, or when output follows it so it was already submitted.
 */
function pasteAtEnd(screen, pattern) {
  const last = [...screen.matchAll(pattern)].at(-1);
  if (!last) return null;
  const after = screen.slice(last.index + last[0].length);
  if (collapse(after).length > MAX_FOOTER_CHARS) return null;
  const restOfLine = after.split('\n', 1)[0].replace('</hc>', '');
  return { text: last[0], typed: /[^\s│]/.test(restOfLine) };
}

/**
 * Reads the input box right before an Enter key press, which unlike `hc send` doesn't
 * wait for a person. Returns one of:
 *   dialog       a dialog would take the Enter
 *   typing       someone typed after the paste, so Enter would submit their text too
 *   message      this message with nothing after it, visibly or as a placeholder of its size
 *   placeholder  a large paste that isn't this message's size, so probably your own
 *   absent       nothing to submit
 *   unknown      the screen couldn't be read
 */
export async function readInputBox(target, needle, messageChars) {
  const res = await run(['read', target, '--lines', '0']);
  if (!res.ok) return 'unknown';
  const screen = res.stdout;
  if (hasDialogFooter(screen)) return 'dialog';
  if (collapse(screen).includes(needle)) {
    const end = pasteAtEnd(screen, MESSAGE_END);
    if (end) return end.typed ? 'typing' : 'message';
  }
  const paste = pasteAtEnd(screen, PASTE_PLACEHOLDER);
  if (!paste) return 'absent';
  if (paste.typed) return 'typing';
  const chars = paste.text.match(/(\d+) chars/)?.[1];
  return chars && Math.abs(Number(chars) - messageChars) <= PLACEHOLDER_SIZE_TOLERANCE ? 'message' : 'placeholder';
}

/** Pastes the message and waits for its turn. hc holds it while a person is typing. */
export async function submitPrompt(target, text, timeoutMs) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const res = await run(['send', target, text, '--wait', '--timeout', String(seconds), '--json'], { timeoutMs: timeoutMs + 60_000 });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  try {
    const { started } = JSON.parse(res.stdout);
    return started ? { ok: true } : { ok: false, code: 'not_started', message: 'the turn did not start' };
  } catch {
    return { ok: false, code: 'not_started', message: `Unexpected hc send output: ${res.stdout}` };
  }
}

export async function paneContains(target, needle) {
  const res = await run(['read', target, '--lines', String(HISTORY_LINES)]);
  return res.ok && collapse(res.stdout).includes(needle);
}

// Footer hints from selection dialogs. A dialog can be reported as idle, and pasting
// a message there would press Enter on it.
const DIALOG_FOOTER = /\b(enter|esc)\b\s*(to\s+)?(confirm|continue|cancel|back|select)\b/i;

/** Checks only the last lines of the screen, so chat text mentioning these words is not a match. */
function hasDialogFooter(screen) {
  // Joined because a narrow pane can wrap the hint across lines.
  const lines = screen.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return DIALOG_FOOTER.test(lines.slice(-3).join(' '));
}

export async function showsDialog(target) {
  const res = await run(['read', target, '--lines', '0']);
  return res.ok && hasDialogFooter(res.stdout);
}

/**
 * Starts the bridge in its own hc terminal, visible and independent of its caller.
 * If one is already live, hc rejects the duplicate name, so this is safe to repeat.
 */
export async function startBridge() {
  return run(['run', '--bg', '--json', '--no-parent', '--outlive-parent', '--no-notify', '--rm',
    '--name', 'agentbus', '--cwd', ROOT, '--', 'node', 'src/bridge.mjs']);
}
