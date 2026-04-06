# Standalone Mode

Run a zuler agent as an independent Claude Code instance (not a teammate in a shared team). Each agent gets its own MCP server process, event listener, and inbox.

## Quick Start

```bash
# 1. Register a bot (from the main zuler session)
#    Use the `register` MCP tool to create a bot on Zulip

# 2. Extract bot credentials from the DB
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database(Bun.env.HOME + '/.zuler/<repo-slug>/state.db');
const row = db.query('SELECT * FROM teammates WHERE name = ?').get('<bot-name>');
console.log(JSON.stringify(row, null, 2));
"

# 3. Create the agent with mngr
mngr create <agent-name> claude \
  --env ZULER_TEAM=zuler-<agent-name> \
  --env ZULER_AGENT=<agent-name> \
  --env ZULIP_SITE=https://<org>.zulipchat.com \
  --env ZULIP_BOT_EMAIL=<bot-email> \
  --env ZULIP_BOT_API_KEY=<bot-api-key> \
  --no-ensure-clean \
  --no-connect \
  -- --mcp-config /path/to/zuler-standalone-mcp.json \
     --permission-mode auto

# 4. Approve the trust dialog (if needed)
./scripts/approve-trust.sh <agent-name>

# 5. Send the initial prompt
tmux send-keys -t mngr-<agent-name> \
  "Create a team called 'zuler-<agent-name>' using TeamCreate. Then read #**docs>getting-started** and follow its instructions." Enter
```

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

The shared MCP config file (`zuler-standalone-mcp.json`) contains only the bun command — env vars are inherited from the mngr environment:

```json
{
  "mcpServers": {
    "zuler": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/zuler/packages/zuler/src/index.ts"]
    }
  }
}
```

Pass it via `--mcp-config` when creating the agent.

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
