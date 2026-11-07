#!/usr/bin/env node
// Makes agentbus available to Claude Code and Codex in every folder, or with --remove
// undoes that. MCP registrations go through each agent's own CLI. Instructions go in a
// marked section of its global instructions file, leaving the rest of that file alone.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DEFAULTS } from '../src/config.mjs';
import { agentInstructions, applyInstructions } from '../src/instructions.mjs';
import { projectFiles } from './project-files.mjs';

const remove = process.argv.includes('--remove');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'src', 'mcp.mjs').replaceAll('\\', '/');
const home = homedir();

const AGENTS = [
  {
    label: 'Claude Code',
    command: 'claude',
    unregister: ['mcp', 'remove', 'agentbus', '--scope', 'user'],
    register: ['mcp', 'add', 'agentbus', '--scope', 'user', '-e', 'AGENTBUS_AGENT=claude', '--', 'node', server],
    instructions: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'CLAUDE.md'),
  },
  {
    label: 'Codex',
    command: 'codex',
    unregister: ['mcp', 'remove', 'agentbus'],
    register: ['mcp', 'add', 'agentbus', '--env', 'AGENTBUS_AGENT=codex', '--', 'node', server],
    instructions: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'AGENTS.md'),
  },
];

/** On Windows these CLIs can be .cmd launchers, which only a shell can run. */
function runCli(command, args) {
  const res = process.platform === 'win32'
    ? spawnSync([command, ...args.map((a) => `"${a}"`)].join(' '), { shell: true, encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { encoding: 'utf8' });
  return { ok: res.status === 0, output: `${res.stderr ?? ''}${res.stdout ?? ''}`.trim() };
}

function updateInstructions(path, body) {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const after = applyInstructions(before, body);
  if (after === before) return;
  if (after === '') {
    rmSync(path);
    console.log(`  Removed ${path}, which held only agentbus's section`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  console.log(`  ${remove ? 'Removed agentbus\'s section from' : 'Wrote agentbus\'s section to'} ${path}`);
}

/**
 * A project entry outranks a global one, and Claude Code asks to approve it, so this folder
 * would work differently from every other. Only unedited files from `npm run setup` go.
 */
function removeProjectFiles() {
  for (const [name, content] of Object.entries(projectFiles(root))) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    if (readFileSync(path, 'utf8').replace(/\r\n/g, '\n') === content) {
      rmSync(path);
      console.log(`Removed the project-only ${name}`);
    } else {
      console.log(`Left alone (edited by hand): ${name}. It overrides the global setup in this folder.`);
    }
  }
}

const body = remove ? null : agentInstructions(readFileSync(join(root, 'AGENTS.md'), 'utf8'));
const failed = [];

for (const agent of AGENTS) {
  console.log(agent.label);
  if (!runCli(agent.command, ['--version']).ok) {
    console.log(`  Skipped: the ${agent.command} CLI isn't on your PATH`);
    failed.push(agent.label);
    continue;
  }
  // Replaces any earlier entry, which may point to a folder that has since moved.
  const removed = runCli(agent.command, agent.unregister);
  if (remove) {
    console.log(removed.ok ? '  Removed the agentbus MCP server' : '  No agentbus MCP server to remove');
  } else {
    const added = runCli(agent.command, agent.register);
    if (!added.ok) {
      console.log(`  Could not register the agentbus MCP server: ${added.output}`);
      failed.push(agent.label);
      continue;
    }
    console.log(`  Registered the agentbus MCP server: node ${server}`);
  }
  updateInstructions(agent.instructions, body);
}

if (remove) {
  console.log(`\nYour settings file stays at ${CONFIG_PATH}. To use agentbus from this folder only, run: npm run setup`);
} else {
  removeProjectFiles();
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
    console.log(`Wrote ${CONFIG_PATH}`);
  }
  console.log('\nRestart Claude Code and Codex to load this. They can then start from any folder.');
}

if (failed.length > 0) {
  console.log(`\nNot finished for: ${failed.join(', ')}. Fix that, then run this again.`);
  process.exit(1);
}
