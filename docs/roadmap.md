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

Expose the Zulip operations as MCP tools. One shared MCP server process serves all agents — each agent passes its name when calling tools, and the server maintains per-agent subscriptions.

Tools to expose:
- `post` — send a DM or stream/topic message
- `read` — fetch recent messages from a stream/topic
- `subscribe` / `unsubscribe` — manage topic and stream subscriptions
- `subscriptions` — list current subscriptions
- `register` — create or look up a bot for a new teammate
- `teammates` — list registered teammates

The MCP server is a long-lived process. It runs Zulip event listeners as background tasks: one admin-level listener handles all stream messages and fans them out to subscribed teammates; each registered bot also has its own listener to receive DMs. Inbound messages are written directly to Claude Code's teammate inbox files (`~/.claude/teams/<team>/inboxes/<agent>.json`), so agents receive them through the standard Claude Code messaging system with no polling required.

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
