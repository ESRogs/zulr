#!/bin/bash
# Spawn a standalone zuler agent via mngr.
# Usage: ./spawn-agent.sh <agent-name>
#
# Prerequisites:
#   - The bot must already be registered on Zulip (use the `register` MCP tool)
#   - mngr must be installed
#
# This script:
#   1. Extracts bot credentials from the zuler DB
#   2. Creates a mngr agent with the right env vars and MCP config
#   3. Approves the trust dialog if needed
#   4. Sends the initial prompt (create team + getting-started)

set -euo pipefail

AGENT="${1:?Usage: spawn-agent.sh <agent-name>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZULIP_SITE="${ZULIP_SITE:-https://zuler.zulipchat.com}"

# Find the zuler DB
REPO_SLUG=$(echo "$REPO_ROOT" | sed 's|/|-|g')
DB_PATH="$HOME/.zuler/$REPO_SLUG/state.db"

if [ ! -f "$DB_PATH" ]; then
  echo "error: zuler DB not found at $DB_PATH"
  echo "Make sure the bot is registered via the register MCP tool first."
  exit 1
fi

# Extract bot credentials
CREDS=$(bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('$DB_PATH');
const row = db.query('SELECT bot_email, api_key FROM teammates WHERE name = ?').get('$AGENT');
if (!row) { console.error('Bot not found: $AGENT'); process.exit(1); }
console.log(JSON.stringify(row));
" 2>&1)

if [ $? -ne 0 ]; then
  echo "error: failed to extract credentials for '$AGENT'"
  echo "$CREDS"
  exit 1
fi

BOT_EMAIL=$(echo "$CREDS" | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.bot_email)")
BOT_API_KEY=$(echo "$CREDS" | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.api_key)")

echo "Bot: $BOT_EMAIL"

# Clean up any existing agent with the same name
if mngr list --format json 2>/dev/null | grep -q "\"$AGENT\""; then
  echo "Destroying existing agent '$AGENT'..."
  echo "y" | mngr destroy --force "$AGENT" 2>/dev/null || true
  git branch -D "mngr/$AGENT" 2>/dev/null || true
fi

# Create the MCP config (shared, env vars are inherited)
MCP_CONFIG="$REPO_ROOT/zuler-standalone-mcp.json"
if [ ! -f "$MCP_CONFIG" ]; then
  cat > "$MCP_CONFIG" << 'MCPEOF'
{
  "mcpServers": {
    "zuler": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "REPO_ROOT_PLACEHOLDER/packages/zuler/src/index.ts"]
    }
  }
}
MCPEOF
  sed -i '' "s|REPO_ROOT_PLACEHOLDER|$REPO_ROOT|g" "$MCP_CONFIG"
fi

# Create the agent
echo "Creating agent '$AGENT'..."
mngr create "$AGENT" claude \
  --env "ZULER_TEAM=zuler-$AGENT" \
  --env "ZULER_AGENT=$AGENT" \
  --env "ZULIP_SITE=$ZULIP_SITE" \
  --env "ZULIP_BOT_EMAIL=$BOT_EMAIL" \
  --env "ZULIP_BOT_API_KEY=$BOT_API_KEY" \
  --no-ensure-clean \
  --no-connect \
  -- --mcp-config "$MCP_CONFIG" --permission-mode auto

# Approve trust and auto-mode dialogs
TMUX_SESSION="mngr-$AGENT"
echo "Waiting for dialogs..."
for i in $(seq 1 30); do
  SCREEN=$(mngr capture "$AGENT" 2>/dev/null || true)

  # Trust dialog
  if echo "$SCREEN" | grep -q "Yes, I trust this folder"; then
    tmux send-keys -t "$TMUX_SESSION" Enter
    echo "Approved trust dialog"
    sleep 2
    continue
  fi

  # Auto mode dialog
  if echo "$SCREEN" | grep -q "Yes, enable auto mode"; then
    tmux send-keys -t "$TMUX_SESSION" Down Enter
    echo "Approved auto mode"
    sleep 2
    continue
  fi

  # Claude Code is ready (prompt visible)
  if echo "$SCREEN" | grep -q "auto mode on"; then
    echo "Claude Code ready"
    break
  fi

  sleep 1
done

# Send the initial prompt
echo "Sending initial prompt..."
INITIAL_PROMPT="Create a team called 'zuler-$AGENT' using TeamCreate. Then read the docs channel topic 'getting-started' using the catch-up tool and follow its instructions."
tmux send-keys -t "$TMUX_SESSION" "$INITIAL_PROMPT" Enter

echo ""
echo "Agent '$AGENT' spawned successfully!"
echo "  Connect: mngr connect $AGENT"
echo "  Capture: mngr capture $AGENT"
echo "  Destroy: echo y | mngr destroy --force $AGENT"
