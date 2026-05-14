# Channels Migration Design

## Motivation

Zulr delivers inbound Zulip messages to Claude Code agents by writing to teammate inbox files (`~/.claude/teams/<team>/inboxes/<agent>.json`). This works, but it's a workaround — the teammate inbox system wasn't designed for MCP servers to push arbitrary content into agent context. It couples zulr to Claude Code's internal file layout and team naming conventions.

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
<channel source="zulr" stream="general" topic="standup" sender="Eric Rogstad">
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

The event listener receives Zulip events, routes them to teammates following the relevant topics, and writes each message to the teammate's inbox JSON file. Claude Code watches these files and injects new messages into the agent's conversation.

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
- **Connection registration**: when an agent first calls a tool (e.g. `register` or `catch-up`), the server associates that stdio connection with the agent name. Subsequent notifications route to the right connection. **Race condition**: a Zulip message could arrive before the agent makes any tool call. During Phase 1 (dual-write), inbox delivery covers this gap. Phase 2 requires that all agents have registered their connection before inbox writes are removed — this is a Phase 2 precondition.
- **Broadcast with filtering**: send all notifications on all connections, include the target agent in `meta`, and rely on the `instructions` string to tell Claude to ignore messages not addressed to it. For small teams (3-6 agents), the waste is negligible — each agent ignores a few extra notifications. The simplicity benefit (no connection tracking, no registration race) may outweigh the cost.
- **Per-agent server instances**: run a separate MCP server per agent. Clean routing but changes the deployment model.

Either connection registration or broadcast could work. Connection registration is more precise; broadcast is simpler and avoids the registration race entirely. The right choice depends on how many agents are typical and whether extra context injection is problematic at scale.

### 2. Server capability declaration

The MCP server constructor needs `capabilities: { experimental: { 'claude/channel': {} } }` to register as a channel. This also requires `instructions` — a string added to Claude's system prompt explaining the channel's behavior.

```ts
const server = new Server(
  { name: 'zulr', version: '...' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: 'Zulip messages arrive as <channel source="zulr" stream="..." topic="..." sender="...">. React to these as you would to teammate inbox messages.',
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

With channels handling notification delivery, agents no longer need to be "team members" in Claude Code's team system for **inbox delivery**. This removes:
- Dependency on `ZULER_TEAM` matching Claude Code's team name
- Dependency on Claude Code's inbox file format/location
- The `~/.claude/teams/` directory structure

Note: agents currently use the team system for more than inbox delivery — `SendMessage` between teammates also goes through team infra. If channels replace inbox delivery but agents still use `SendMessage`, the team dependency can't be fully removed. Phase 3 scope is limited to removing the *inbox* dependency; whether to also migrate inter-agent messaging is a separate decision.

## Relationship to stateful client design (PR #60)

The [stateful client design](stateful-client-design.md) introduces `ZulipSession` per bot with notification trigger evaluation (`shouldNotify`). That design changes *what* gets delivered (only notification-worthy messages, not everything). This design changes *how* delivery happens (MCP channel notifications instead of inbox files).

These are complementary and touch the same delivery path:
- `ZulipSession.shouldNotify()` gates whether a message is delivered at all
- Channel notifications (this design) change the transport for that delivery

**Sequencing**: implement the stateful client first. The channel migration builds on top of it — `ZulipSession`'s notification callback is the natural place to emit channel notifications instead of (or alongside) inbox writes. Migrating to channels before the stateful client would mean migrating the current "deliver everything" behavior, then changing the filtering logic — two migrations instead of one.

**Unread tracking interaction**: when a message is delivered via channel notification, the session should mark it as read (same as the current behavior where the event listener marks delivered messages as read per-bot). This ensures `catch-up` with `first_unread` anchor doesn't re-fetch already-delivered messages.

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
