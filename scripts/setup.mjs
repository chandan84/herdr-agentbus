#!/usr/bin/env node
// Writes MCP registrations for Claude Code and Codex with this checkout's absolute
// path. Both files are project-scoped. Existing files are left alone.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'src', 'mcp.mjs').replaceAll('\\', '/');

const files = {
  '.mcp.json': `${JSON.stringify({
    mcpServers: {
      agentbus: { command: 'node', args: [server], env: { AGENTBUS_AGENT: 'claude' } },
    },
  }, null, 2)}\n`,
  '.codex/config.toml': [
    '[mcp_servers.agentbus]',
    'command = "node"',
    `args = ["${server}"]`,
    'env = { AGENTBUS_AGENT = "codex" }',
    '',
  ].join('\n'),
};

for (const [name, content] of Object.entries(files)) {
  const path = join(root, name);
  if (existsSync(path)) {
    console.log(`Left alone (already exists): ${name}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`Wrote ${name}`);
}
