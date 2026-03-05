# Roadmap

Zuler connects Claude Code agents to Zulip, giving teams a persistent, human-visible channel for agent-to-agent communication. This roadmap tracks the path to a standalone TypeScript MCP server.

## Phase 1 — Core Zulip client (TypeScript port)

Port the Zulip API interactions to TypeScript. No MCP yet — just a clean, well-typed library that the MCP layer will sit on top of.

- Zulip REST client (post DM, post to stream/topic, fetch messages, list streams/members)
- Bot key management: register a teammate bot, look up existing bots via admin API
- Event listener: receive inbound messages via Zulip's event queue API (long-polling)
- State management: load/save teammate registry and subscriptions
- Message routing logic: match inbound messages to subscribed teammates, deduplicate, auto-subscribe on @-mention
- Unread-check enforcement: block outbound posts when sender has unread messages from that topic

## Phase 2 — MCP server

Expose the Zulip operations as MCP tools. An agent with this MCP server configured can send and receive Zulip messages directly.

Tools to expose:
- `post` — send a DM or stream/topic message
- `read` — fetch recent messages from a stream/topic
- `subscribe` / `unsubscribe` — manage topic and stream subscriptions
- `subscriptions` — list current subscriptions
- `register` — create or look up a bot for a new teammate
- `teammates` — list registered teammates
- `check_inbox` — fetch buffered inbound messages for this agent

The MCP server is a long-lived process, so the Zulip event listener runs as a background task inside it. It listens on Zulip's event queue continuously, buffers inbound messages addressed to this agent, and surfaces them when the agent calls `check_inbox`. MCP is still request/response at the protocol level — the server can't interrupt the agent — but no separate sidecar process is needed.

## Phase 3 — Configuration and packaging

- Config file format (TOML or JSON) for Zulip credentials, teammate registry, and subscription defaults
- Example config file for bootstrapping new installs
- npm package / `bunx` invocation so it's installable without cloning the repo
- MCP server config snippet for `claude_desktop_config.json` / `mcp.json`
- Documentation: setup guide, command reference, architecture overview

## Phase 4 — Quality and hardening

- Full test coverage for routing logic, command dispatch, and state management
- Graceful reconnection on Zulip event queue timeouts
- Structured logging
- Rate limiting for outbound Zulip API calls
- Support for multiple Zulip organizations

## What's not in scope (for now)

- Support for chat platforms other than Zulip
- Web UI or dashboard
- Message threading / reaction support
- File/image attachments
