# Channels Migration Design

## Motivation

Zuler delivers inbound Zulip messages to Claude Code agents by writing to teammate inbox files (`~/.claude/teams/<team>/inboxes/<agent>.json`). This works, but it's a workaround — the teammate inbox system wasn't designed for MCP servers to push arbitrary content into agent context. It couples zuler to Claude Code's internal file layout and team naming conventions.

Claude Code v2.1.80 introduces **channels**: an MCP-native mechanism for servers to push events into a running session. A channel server emits `notifications/claude/channel` notifications, and Claude Code surfaces them directly in the agent's context. This is the supported way to do what we're doing with inbox files.

## What channels provide

A channel is an MCP server that declares the `claude/channel` capability. It pushes events via:

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'message body',
    meta: { stream: 'general', topic: 'standup', sender: 'Eric Rogstad' },
  },
})
```

The agent sees:

```
<channel source="zuler" stream="general" topic="standup" sender="Eric Rogstad">
message body
</channel>
```

Key properties:
- **Push-based**: events arrive in context as they happen (while the session is open)
- **Metadata via `meta`**: `Record<string, string>` where each key becomes a tag attribute — maps to our current structured inbox fields (`zulipStream`, `zulipTopic`, `zulipSender`, etc.)
- **Two-way capable**: servers can expose MCP tools alongside channel notifications (we already do this)
- **No history/backlog**: events are ephemeral — only delivered to active sessions. No query mechanism for past events.

## What channels don't replace

- **`read` and `catch-up` tools**: these pull from the Zulip API and remain the durable fallback for catching up after restarts, context compaction, or fetching older history
- **Zulip event listener**: still needed to long-poll Zulip's event queue — channels change the delivery target (MCP notification instead of inbox file), not the event source

## Current architecture

```
Zulip API  →  event listener (long-poll)  →  writeToInbox()  →  JSON file  →  Claude Code team infra  →  agent context
```

The event listener receives Zulip events, routes them to subscribed teammates, and writes each message to the teammate's inbox JSON file. Claude Code watches these files and injects new messages into the agent's conversation.

## Proposed architecture

```
Zulip API  →  event listener (long-poll)  →  mcp.notification()  →  MCP stdio  →  agent context
```

The event listener routes messages the same way, but instead of writing a file, it sends an MCP channel notification on the agent's stdio connection. Claude Code receives it directly via the MCP protocol.

## Key design questions

### 1. Routing notifications to the right agent

Each agent has its own MCP server connection (stdio). The event listener needs to know which server instance corresponds to which agent so it can send notifications to the right one.

Currently, the MCP server is a single process — all agents connect to the same server. The server doesn't know which connection belongs to which agent (agents identify themselves by passing `sender` in tool calls).

**Options:**
- **Connection registration**: when an agent first calls a tool (e.g. `register` or `catch-up`), the server associates that stdio connection with the agent name. Subsequent notifications route to the right connection.
- **Broadcast with filtering**: send all notifications on all connections, include the target agent in `meta`, and rely on the `instructions` string to tell Claude to ignore messages not addressed to it. Simpler but wasteful.
- **Per-agent server instances**: run a separate MCP server per agent. Clean routing but changes the deployment model.

Connection registration is the most likely path — it preserves the single-process model and adds minimal complexity.

### 2. Server capability declaration

The MCP server constructor needs `capabilities: { experimental: { 'claude/channel': {} } }` to register as a channel. This also requires `instructions` — a string added to Claude's system prompt explaining the channel's behavior.

```ts
const server = new Server(
  { name: 'zuler', version: '...' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: 'Zulip messages arrive as <channel source="zuler" stream="..." topic="..." sender="...">. React to these as you would to teammate inbox messages.',
  },
)
```

### 3. Notification payload mapping

Current inbox entry fields map to channel `meta` as follows:

| Inbox field | Channel `meta` key | Notes |
|---|---|---|
| `from` | — | Derived from `stream`/`topic`/`sender` |
| `text` | `content` (body) | Message content |
| `summary` | — | Could go in `meta.summary` or be dropped (Claude sees the full content) |
| `zulipMessageId` | `message_id` | For reactions/replies |
| `zulipSenderId` | `sender_id` | |
| `zulipStream` | `stream` | |
| `zulipTopic` | `topic` | |
| `zulipSender` | `sender` | Display name |

Note: `meta` values must be strings, so numeric IDs need string conversion.

### 4. Durability gap

Inbox files persist on disk. Channel notifications are ephemeral. If an agent restarts or a session ends, any notifications sent during downtime are lost.

This is acceptable because:
- `catch-up` already fetches unread messages from the Zulip API on startup
- The event listener marks messages as read per-bot, so `catch-up` with `first_unread` anchor recovers missed messages
- The durable source of truth is Zulip, not the inbox files

### 5. Removing team dependency

With channels handling notification delivery, agents no longer need to be "team members" in Claude Code's team system. This removes:
- Dependency on `ZULER_TEAM` matching Claude Code's team name
- Dependency on Claude Code's inbox file format/location
- The `~/.claude/teams/` directory structure

Agents would still coordinate through Zulip — the team system just wouldn't be the transport.

## Migration plan

### Phase 1: Add channel capability (additive)

- Declare `claude/channel` capability in the MCP server constructor
- Add connection-to-agent mapping (populated on first tool call per connection)
- Send channel notifications alongside inbox writes (dual-write)
- No behavior change — agents receive messages both ways

### Phase 2: Validate and switch

- Confirm channel delivery works reliably in practice
- Update agent `instructions`/system prompts to reference `<channel>` tags
- Remove inbox writes, keeping only channel notifications
- Remove inbox-related code (`writeToInbox`, `readInbox`, `consumeUnread*`, `inboxToFormattedMessages`, `mergeWithInbox`)

### Phase 3: Clean up team dependency

- Remove `ZULER_TEAM` env var requirement
- Remove `inboxDir`/`inboxPath` functions
- Remove `sanitizeSummary` (no longer writing to inbox `summary` field)
- Update onboarding to skip team setup

## Blockers

- **Auth model**: channels require `claude.ai` login — API key and Console auth are not supported. Our main user (chorus-sft) uses API auth. This blocks adoption until either Anthropic adds API key support or the project migrates auth.
- **Research preview**: channels are not GA. The `--channels` flag syntax and protocol contract may change. Custom channels need `--dangerously-load-development-channels` unless on Anthropic's approved allowlist.
- **Single-process routing**: the current MCP server doesn't track which stdio connection belongs to which agent. Phase 1 needs to solve this before notifications can be routed correctly.
