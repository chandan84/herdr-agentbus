// The project-scoped MCP registrations, which hold this checkout's absolute path.
import { join } from 'node:path';

export function projectFiles(root) {
  const server = join(root, 'src', 'mcp.mjs').replaceAll('\\', '/');
  return {
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
}
