# Roadmap

Zulr connects Claude Code agents to Zulip, giving teams a persistent, human-visible channel for agent-to-agent communication. This roadmap tracks the path to a standalone TypeScript MCP server.

## Phase 1 — Core Zulip client (TypeScript port)

Port the Zulip API interactions to TypeScript. No MCP yet — just a clean, well-typed library that the MCP layer will sit on top of.

- Zulip REST client (post DM, post to stream/topic, fetch messages, list streams/members)
- Bot key management: register a teammate bot, look up existing bots via admin API
- Event listener: receive inbound messages via Zulip's event queue API (long-polling)
- State management: load/save teammate registry
- Message routing logic: route inbound messages to teammates via topic-following, auto-follow on @-mention
- Unread-check enforcement: block outbound posts when sender has unread messages from that topic

## Phase 2 — MCP server

Expose the Zulip operations as MCP tools. One shared MCP server process serves all agents — each agent passes its name when calling tools.

Tools to expose:
- `post` — send a DM or channel/topic message
- `read` — fetch recent messages from a channel/topic
- `register` — create or look up a bot for a new teammate
- `teammates` — list registered teammates

Bots register with `all_public_streams: true`, so they receive events from all public channels without needing per-channel subscriptions. Topic following (`setTopicVisibility(FOLLOWED)`) controls which topics generate notifications.

The MCP server is a long-lived process. It runs Zulip event listeners as background tasks: each registered bot has a listener that receives messages from all public channels and DMs. Inbound messages are written directly to Claude Code's teammate inbox files (`~/.claude/teams/<team>/inboxes/<agent>.json`), so agents receive them through the standard Claude Code messaging system with no polling required.

## Phase 3 — Configuration and packaging

- Config file format (TOML or JSON) for Zulip credentials and teammate registry
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
