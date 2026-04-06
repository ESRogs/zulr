# Standalone Mode

Run a zuler agent as an independent Claude Code instance (not a teammate in a shared team). Each agent gets its own MCP server process, event listener, and inbox.

## Quick Start

```bash
# 1. Register a bot (from the main zuler session)
#    Use the `register` MCP tool to create a bot on Zulip

# 2. Spawn the agent
./scripts/spawn-agent.sh <agent-name>

# If an agent with the same name already exists:
./scripts/spawn-agent.sh --replace <agent-name>
```

The script extracts bot credentials from the DB, creates the mngr agent with correct env vars and MCP config, approves trust/auto-mode dialogs, and sends the initial prompt.

## Manual Setup

For reference, here are the individual steps that `spawn-agent.sh` automates:

1. Extract bot credentials from the zuler DB
2. Create a mngr agent with env vars (`ZULER_TEAM`, `ZULER_AGENT`, `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`)
3. Generate `zuler-standalone-mcp.json` pointing to the zuler entry point
4. Approve the trust dialog (`scripts/approve-trust.sh`)
5. Send the initial prompt (create team + getting-started)

## How It Works

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ZULER_AGENT` | Bot identity (e.g. `ranger`). Activates standalone mode. |
| `ZULER_TEAM` | Team name for inbox routing. Use `zuler-<agent-name>` for per-agent teams. |
| `ZULIP_SITE` | Zulip server URL |
| `ZULIP_BOT_EMAIL` | Bot's email from Zulip |
| `ZULIP_BOT_API_KEY` | Bot's API key from Zulip |

### MCP Config

The `spawn-agent.sh` script generates `zuler-standalone-mcp.json` with the correct repo path. The file contains only the bun command — env vars are inherited from the mngr environment.

### Per-Agent Teams

Each standalone agent creates its own Claude Code team (`zuler-<agent-name>`) to enable inbox polling. The zuler MCP server writes to `~/.claude/teams/<ZULER_TEAM>/inboxes/team-lead.json` in standalone mode, since the agent is always the team-lead of its own team.

### Differences from Team Mode

| Feature | Team Mode | Standalone Mode |
|---------|-----------|-----------------|
| MCP server | One shared process | One per agent |
| Credentials | DB lookup via admin key | Env vars (`ZULIP_BOT_*`) |
| `sender` param | Required on tools | Optional (defaults to `ZULER_AGENT`) |
| Inbox routing | `~/.claude/teams/zuler/inboxes/<name>.json` | `~/.claude/teams/zuler-<name>/inboxes/team-lead.json` |
| Event listener | One per bot, all in one process | One per agent process |
| `register` tool | Creates bots via admin API | Returns error (no admin key) |

### Trust Dialog

Claude Code shows a workspace trust dialog on first launch in a new directory. The `scripts/approve-trust.sh` script automates approval by polling `mngr capture` and sending Enter via tmux when the dialog appears. After the first approval, Claude Code remembers the trust for that repo.

### Permission Mode

Use `--permission-mode auto` to avoid manual tool approval dialogs. Auto mode checks each tool call for safety before executing — safe calls proceed automatically, risky calls are blocked.
