# herdr-agentbus

Lets Claude Code and Codex message each other from their open herdr-app terminals. Messages are stored in NATS JetStream, delivered in FIFO order, and retried with exponential backoff.

```
Claude --send (MCP)--> JetStream --> bridge --hc send--> Codex
Codex  --send (MCP)--> JetStream --> bridge --hc send--> Claude
```

herdr-app runs its terminals on herdr-core, whose CLI is `hc`. This project isn't a herdr plugin: it's a folder you keep on disk, plus a small bridge process in its own terminal. It doesn't use the older `herdr` CLI.

## Requirements

- herdr-app, with its `hc` CLI on your PATH
- Node.js 20 or later
- The Claude Code and Codex CLIs
- Windows, macOS, or Linux, on x64 or arm64

## Install

Keep the clone somewhere permanent, because the agents run agentbus from it. An AI agent can do this for you: ask it to follow the install section of `AGENTS.md`.

```powershell
git clone https://github.com/chandan84/herdr-agentbus.git
cd herdr-agentbus
npm install             # Dependencies, plus a checksum-verified nats-server in bin/
npm run setup:global    # Lets Claude Code and Codex use agentbus from any folder
```

Then restart Claude Code and Codex, because agents load MCP servers only at startup.

### What `setup:global` changes

| For | What | Where |
|---|---|---|
| Claude Code | Adds the `agentbus` MCP server, using `claude mcp add --scope user` | `~/.claude.json` |
| Claude Code | Adds a marked section telling it how to use the bus | `~/.claude/CLAUDE.md` |
| Codex | Adds the `agentbus` MCP server, using `codex mcp add` | `~/.codex/config.toml` |
| Codex | Adds a marked section telling it how to use the bus | `~/.codex/AGENTS.md` |
| Both | Creates your settings file, if it doesn't exist | `~/.config/herdr-app/agentbus.json` |
| This folder | Removes `.mcp.json` and `.codex/config.toml` if `npm run setup` wrote them and you haven't edited them | This folder |

The `send` tool is then available in every Claude Code and Codex session on your machine. It's safe to run again, which is also how to repair it if you move this folder. Your own text in the instructions files stays as it is. `codex mcp add` rewrites `~/.codex/config.toml` when it adds a server, so other entries can change order or formatting, such as `120` becoming `120.0`, and an empty `args = []` can disappear.

To undo everything except your settings file:

```powershell
npm run uninstall:global
```

### Use it in one folder only

To keep agentbus out of your other projects, run `npm run setup` instead of `setup:global`. It writes `.mcp.json` for Claude Code and `.codex/config.toml` for Codex, plus your settings file. You then have to start both agents from this folder and accept their prompts: Claude Code asks about the `agentbus` MCP server, and Codex asks to trust the folder.

Those two files hold this folder's absolute path, so they aren't committed. If you move the folder, stop the bridge and nats-server, delete those two files, and run `npm run setup` again, because setup leaves existing files alone.

## Use with herdr-app

1. In herdr-app, open a terminal for each agent and go to the project you're working on. It can be any folder, and the two agents can be in different folders.
2. Start `claude` in one terminal and `codex` in the other.
3. Ask either agent to talk to the other. You type to one agent, and the other's reply comes back as a new prompt:

   - In Claude: "ask codex to review src/app.js"
   - In Codex: "ask claude what it thinks of this plan, then update the plan"

To watch the messages, run `hc read agentbus --lines 50` from anywhere. The other commands in this README, such as `node src/cli.mjs status`, run from the folder you installed into.

The bridge starts itself, as a terminal named `agentbus`, whenever an agent calls `send` and it isn't running. To start it by hand, run `node src/cli.mjs bridge`.

Each agent asks for approval the first time it calls `send`. Choose an "always allow" option if you don't want to approve each message. Claude Code remembers that per project, so to allow it everywhere, add `"mcp__agentbus__send"` to `permissions.allow` in `~/.claude/settings.json`. Until you answer, the agent stays blocked and its replies wait.

### Running several agents at once

The bus has one `claude` and one `codex`, wherever they're running. With several Claude Code or Codex sessions open across projects, name the pair you want to talk, and start them from the project's folder:

```powershell
hc run --bg --name claude claude
hc run --bg --name codex codex
```

The bridge picks a terminal in this order: one named `claude` or `codex`, the only agent of that kind, then the only one of that kind working in the folder you installed into. If that's still ambiguous, it waits, and `status` lists the terminals. A terminal named `claude` or `codex` that's running a different kind of agent also makes the bridge wait.

## Delivery behavior

| Situation | What happens | Uses an attempt? |
|---|---|---|
| Agent is working, blocked, or closed, or shows a dialog | Message waits in the queue | No |
| You're typing in the agent's terminal | `hc send` waits for you to pause | No |
| Agent is idle or done | Message is pasted, and the next one waits until that turn settles | n/a |
| Paste lands but no turn starts | The bridge presses Enter once, without pasting again | n/a |
| You typed after the paste, or a dialog appeared | No Enter is pressed. Delivery waits until you submit or clear it | No |
| No turn starts after that | Retried at 1s, 2s, 4s... up to 5m, with jitter | Yes |
| 10 attempts fail | Moved to the dead-letter queue and logged | n/a |
| Bridge or nats-server crashes | Messages are recovered from disk. The bridge checks the terminal so it doesn't resend | No |
| 50 redeliveries, such as repeated crashes | Moved to the dead-letter queue and logged, so a message can't loop forever | n/a |

Delivery is at-least-once. The terminal check prevents most duplicates. If the terminal was replaced, or a crash follows more than 10,000 lines of output, a message can arrive a second time, and `AGENTS.md` tells agents to skip ids they've handled.

Attempt counts live in memory, so restarting the bridge gives the message in flight a fresh 10 attempts.

**Hop limit:** delivery pauses after 20 messages in a row, so the agents can't reply to each other forever. Below the limit, the count resets after 10 quiet minutes. Once delivery pauses, only `node src/cli.mjs resume` clears it, however long you wait.

## Commands

```powershell
node src/cli.mjs status          # Queues, agent state, pause state
node src/cli.mjs config          # Config file path and the settings in effect
node src/cli.mjs bridge          # Start the bridge
node src/cli.mjs send <from> <to> <text>  # Queue a message by hand
node src/cli.mjs resume          # Clear a hop-limit pause
node src/cli.mjs dlq list        # Show dead letters
node src/cli.mjs dlq retry <id>  # Requeue one at the back of its inbox
node src/cli.mjs stop            # Stop nats-server; messages stay on disk
hc read agentbus --lines 50      # Watch the bridge
hc kill agentbus                 # Stop the bridge
```

The bridge logs to `.data/bridge.log` and its terminal.

## Configuration

Settings live in `~/.config/herdr-app/agentbus.json`, which `npm run setup` creates with the defaults. On Windows that's `%USERPROFILE%\.config\herdr-app\agentbus.json`. You can delete any setting to go back to its default. To see the file's path and the settings in effect, run `node src/cli.mjs config`.

| Setting | Default | What it does |
|---|---|---|
| `natsPort` | 4322 | Local port for nats-server |
| `agents` | `["claude", "codex"]` | Bus names of the agents |
| `hopLimit` | 20 | Messages in a row between agents before delivery pauses |
| `quietResetMs` | 600000 | Quiet time that resets the hop count, below the limit |
| `maxAttempts` | 10 | Failed attempts before a message is dead-lettered. The redelivery cap is 5 times this |
| `backoffBaseMs` | 1000 | Delay before the first retry, which doubles each attempt |
| `backoffCapMs` | 300000 | Longest delay between retries |
| `ackWaitMs` | 30000 | How long nats-server waits before redelivering after a bridge crash |
| `heartbeatMs` | 10000 | How often the bridge renews a message in flight. Must be less than `ackWaitMs` |
| `pollMs` | 1000 | How often the bridge checks an agent's state while delivering |
| `fetchExpiresMs` | 3000 | How long each wait for a new message lasts |
| `promptTimeoutMs` | 20000 | How long `hc send` waits for a turn to start |
| `startGraceMs` | 5000 | How long to wait for a turn before checking for a lost Enter |
| `maxBodyChars` | 16000 | Longest message an agent can send |
| `retentionDays` | 30 | How long messages are kept |

A setting can also come from an environment variable named after it, such as `AGENTBUS_HOP_LIMIT`, which overrides the file. `AGENTBUS_CONFIG` points to a different config file.

The file is read at startup, and a typo or invalid value stops the program with an error naming the setting. To apply a change:

- **Most settings:** restart the bridge with `hc kill agentbus`, then `node src/cli.mjs bridge`.
- **`maxBodyChars` and `agents`:** also restart Claude and Codex.
- **`natsPort`:** run `node src/cli.mjs stop` *before* you edit the file, because `stop` finds the server by its port. Then restart the bridge and both agents.

## Limitations

- **No pop-up alerts:** `hc` has no notification command, so a hop-limit pause or dead letter appears only in the log and `status`.
- **Dialogs:** dialog detection matches known footer text such as "enter to confirm" on the last lines of the screen. A dialog with different wording and reported as idle could receive a message, and its Enter key. Keep your normal permission settings on.
- **Unknown state:** a terminal reporting no agent status holds its queue until the status changes.
- **Long pastes:** agents collapse a long paste to a placeholder such as `[Pasted Content 3781 chars]`. The bridge presses Enter on one only if its size is within 64 characters of the message, so a draft of yours that close in size could be submitted. Any other placeholder, or one with no size, holds delivery until you submit or clear the box.
- **Typing detection:** text typed on a new line after a paste isn't detected, and the screen is read a moment before Enter is pressed.

## Tests

```powershell
npm test
```

The tests run the real bridge and a real nats-server against a fake `hc` CLI (`test/fake-hc.mjs`), on a separate port and data directory.
