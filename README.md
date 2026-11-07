# herdr-agentbus

Lets Claude Code and Codex message each other from their open herdr-app terminals. Messages are stored in NATS JetStream, delivered in FIFO order, and retried with exponential backoff.

```
Claude --send (MCP)--> JetStream --> bridge --hc send--> Codex
Codex  --send (MCP)--> JetStream --> bridge --hc send--> Claude
```

herdr-app runs its terminals on herdr-core, whose CLI is `hc`. It has no plugin system, so this is a project folder plus a small bridge process in its own terminal, not an installed plugin. It doesn't use the older `herdr` CLI.

## Requirements

- herdr-app, with its `hc` CLI on your PATH
- Node.js 20 or later
- The Claude Code and Codex CLIs
- Windows, macOS, or Linux, on x64 or arm64

## Setup

```powershell
git clone https://github.com/chandan84/herdr-agentbus.git
cd herdr-agentbus
npm install    # Dependencies, plus a checksum-verified nats-server in bin/
npm run setup  # Writes .mcp.json and .codex/config.toml
```

Those two files hold this folder's absolute path, so they aren't committed. If you move the folder, stop the bridge and nats-server, delete both files, and run `npm run setup` again, because setup leaves existing files alone.

An AI agent can do this for you: ask it to follow the install section of `AGENTS.md`.

## Use with herdr-app

1. In herdr-app, open a terminal for each agent and go to this folder in both. The MCP registrations belong to this folder, so agents started elsewhere don't get the `send` tool.
2. Start `claude` in one terminal and `codex` in the other. Agents load MCP servers only at startup, so restart any that were already running.
3. Accept the prompts: Claude Code asks about the `agentbus` MCP server, and Codex asks to trust the folder.
4. Ask either agent to talk to the other. You type to one agent, and the other's reply comes back as a new prompt:

   - In Claude: "ask codex to review src/bridge.mjs"
   - In Codex: "ask claude what it thinks of this plan, then update the plan"

To watch the messages, run `hc read agentbus --lines 50`.

The bridge starts itself, as a terminal named `agentbus`, whenever an agent calls `send` and it isn't running. To start it by hand, run `node src/cli.mjs bridge`.

Each agent asks for approval the first time it calls `send`. Choose an "always allow" option if you don't want to approve each message. Until you answer, the agent stays blocked and its replies wait.

The bridge picks a terminal in this order: one named `claude` or `codex`, the only agent of that kind, then the only one of that kind working in this folder. If that's still ambiguous, it waits. Start the one you want with a name, such as `hc run --bg --name codex codex`. A terminal named `claude` or `codex` that's running a different kind of agent also makes the bridge wait, and `status` names the terminal.

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
node src/cli.mjs bridge          # Start the bridge
node src/cli.mjs send <from> <to> <text>  # Queue a message by hand
node src/cli.mjs resume          # Clear a hop-limit pause
node src/cli.mjs dlq list        # Show dead letters
node src/cli.mjs dlq retry <id>  # Requeue one at the back of its inbox
node src/cli.mjs stop            # Stop nats-server; messages stay on disk
hc read agentbus --lines 50      # Watch the bridge
hc kill agentbus                 # Stop the bridge
```

The bridge logs to `.data/bridge.log` and its terminal. Settings are `AGENTBUS_*` environment variables, listed in `src/config.mjs`. Messages are kept for 30 days.

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
