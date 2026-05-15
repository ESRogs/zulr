# Standalone Mode

Run a zulr agent as an independent Claude Code instance (not a teammate in a shared team). Each agent gets its own MCP server process, event listener, and inbox.

## Quick Start

```bash
# 1. Register a bot (from the main zulr session)
#    Use the `register` MCP tool to create a bot on Zulip

# 2. Spawn the agent
./scripts/spawn-agent.sh <agent-name>

# If an agent with the same name already exists:
./scripts/spawn-agent.sh --replace <agent-name>
```

The script extracts bot credentials from the DB, creates the mngr agent with correct env vars and MCP config, approves trust/auto-mode dialogs, and sends the initial prompt.

## Manual Setup

For reference, here are the individual steps that `spawn-agent.sh` automates:

1. Extract bot credentials from the zulr DB
2. Create a mngr agent with env vars (`ZULR_TEAM`, `ZULR_AGENT`, `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`)
3. Generate `standalone-mcp.json` in `~/.zulr/<repo-slug>/` pointing to the zulr entry point
4. Approve the trust dialog (`scripts/approve-trust.sh`)
5. Send the initial prompt (create team + getting-started)

## How It Works

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ZULR_AGENT` | Bot identity (e.g. `ranger`). Activates standalone mode. |
| `ZULR_TEAM` | Team name for inbox routing. Use `zulr-<agent-name>` for per-agent teams. |
| `ZULIP_SITE` | Zulip server URL |
| `ZULIP_BOT_EMAIL` | Bot's email from Zulip |
| `ZULIP_BOT_API_KEY` | Bot's API key from Zulip |

### MCP Config

The `spawn-agent.sh` script generates `~/.zulr/<repo-slug>/standalone-mcp.json` with the correct repo path. The file contains only the bun command — env vars are inherited from the mngr environment.

### Per-Agent Teams

Each standalone agent creates its own Claude Code team (`zulr-<agent-name>`) to enable inbox polling. The zulr MCP server writes to `~/.claude/teams/<ZULR_TEAM>/inboxes/team-lead.json` in standalone mode, since the agent is always the team-lead of its own team.

### Differences from Team Mode

| Feature | Team Mode | Standalone Mode |
|---------|-----------|-----------------|
| MCP server | One shared process | One per agent |
| Credentials | DB lookup via admin key | Env vars (`ZULIP_BOT_*`) |
| `sender` param | Required on tools | Optional (defaults to `ZULR_AGENT`) |
| Inbox routing | `~/.claude/teams/zulr/inboxes/<name>.json` | `~/.claude/teams/zulr-<name>/inboxes/team-lead.json` |
| Event listener | One per bot, all in one process | One per agent process |
| `register` tool | Creates bots via admin API | Returns error (no admin key) |

### Trust Dialog

Claude Code shows a workspace trust dialog on first launch in a new directory. The `scripts/approve-trust.sh` script automates approval by polling `mngr capture` and sending Enter via tmux when the dialog appears. After the first approval, Claude Code remembers the trust for that repo.

### Permission Mode

Use `--permission-mode auto` to avoid manual tool approval dialogs. Auto mode checks each tool call for safety before executing — safe calls proceed automatically, risky calls are blocked.

## Modal (Remote Sandboxes)

Run standalone agents on Modal instead of local worktrees. The script runs locally but the agent executes in a remote Modal sandbox.

### Prerequisites

- Modal CLI installed and authenticated: `uv tool install modal && modal token new`
- `GITHUB_TOKEN` env var set (for the agent to push code / create PRs)
- Claude Code auth: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)

### Quick Start

```bash
# With API key:
ANTHROPIC_API_KEY=sk-... GITHUB_TOKEN=ghp_... ./scripts/spawn-agent.sh --modal <agent-name>

# With OAuth token (from 'claude setup-token', uses subscription billing):
CLAUDE_CODE_OAUTH_TOKEN=... GITHUB_TOKEN=ghp_... ./scripts/spawn-agent.sh --modal <agent-name>
```

### How It Works

1. Bot credentials are extracted locally from the zulr DB (same as local mode)
2. `mngr create agent@.modal` builds a custom image from `scripts/Dockerfile.modal` (debian:bookworm-slim + mngr packages + bun + Claude Code)
3. The repo is transferred to the sandbox, then `bun install` runs on-sandbox
4. The MCP config is generated on-sandbox using the correct sandbox paths
5. The agent starts with `--idle-timeout 5m --idle-mode io` for cost-efficient lifecycle management

### Lifecycle (Idle/Wake)

Modal agents automatically shut down when idle, snapshotting their state:

- **Idle** → mngr detects inactivity → snapshots sandbox → shuts down
- **Wake** → `mngr start <agent>` → restores from snapshot → resumes

After waking, the Zulip event queue may have expired (~10 min TTL). The session re-registers and backfill recovers any unread messages from the gap.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MODAL_TIMEOUT` | `3600` | Max sandbox lifetime in seconds |
| `MODAL_CPU` | `2` | CPU cores (0.25–16) |
| `MODAL_MEMORY` | `4` | Memory in GB (0.5–32) |
| `MODAL_IDLE_TIMEOUT` | `5m` | Idle time before auto-shutdown |
| `GITHUB_TOKEN` | (required) | GitHub PAT for pushing code |
