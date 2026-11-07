#!/usr/bin/env node
// Stdio MCP server giving one agent a durable `send` tool. Set AGENTBUS_AGENT to
// that agent's bus name. Inbound messages arrive through the bridge, not here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { assertAgentName, config } from './config.mjs';
import { connectBus, ensureTopology, sendMessage } from './bus.mjs';
import { startBridge } from './terminal.mjs';

const self = assertAgentName(process.env.AGENTBUS_AGENT ?? '');
const peers = config.agents.filter((a) => a !== self);

// Connected on first use, so a slow broker never delays agent startup.
let busPromise;
function getBus() {
  busPromise ??= (async () => {
    const bus = await connectBus({ name: `agentbus-mcp-${self}` });
    await ensureTopology(bus);
    return bus;
  })().catch((err) => {
    busPromise = undefined;
    throw err;
  });
  return busPromise;
}

const server = new McpServer({ name: 'agentbus', version: '0.1.0' });

server.registerTool('send', {
  description: `Send a message to another coding agent (${peers.join(', ')}) running in a herdr terminal. `
    + 'It is stored durably and pasted into that agent\'s terminal in FIFO order once the agent is idle. '
    + 'This returns as soon as the message is queued, so do not wait or poll for a reply: '
    + 'any reply will arrive later as a new prompt.',
  inputSchema: {
    to: z.enum(peers).describe('Bus name of the receiving agent'),
    body: z.string().min(1).max(config.maxBodyChars).describe(
      `Message text, up to ${config.maxBodyChars} characters. For anything longer, write a file and send its path.`,
    ),
    thread: z.string().max(80).optional().describe('Optional conversation label'),
    in_reply_to: z.string().max(80).optional().describe('The id of the message you are replying to'),
  },
}, async ({ to, body, thread, in_reply_to: inReplyTo }) => {
  try {
    const { id, seq } = await sendMessage(await getBus(), { from: self, to, body, thread, inReplyTo });
    // Every send, because the bridge may have died since the last one. If it's running,
    // hc rejects the duplicate name. Best effort: the message is already safe in the queue.
    if (!process.env.AGENTBUS_NO_AUTOSTART) void startBridge();
    return { content: [{ type: 'text', text: `Queued for ${to}: id=${id} seq=${seq}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Not queued: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
