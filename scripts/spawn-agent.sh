#!/bin/bash
# Spawn a standalone zulr agent via mngr.
# Usage: ./spawn-agent.sh [--replace] [--modal] <agent-name>
#
# Prerequisites:
#   - The bot must already be registered on Zulip (use the `register` MCP tool)
#   - mngr must be installed
#   - ZULIP_SITE env var set (e.g. https://your-org.zulipchat.com)
#   - For --modal: Modal CLI authenticated (`modal token new`)
#
# Options:
#   --replace   Destroy any existing agent with the same name before creating
#   --modal     Run the agent on Modal instead of a local worktree
#
# This script:
#   1. Extracts bot credentials from the zulr DB
#   2. Creates a mngr agent with the right env vars and MCP config
#   3. Approves the trust dialog if needed
#   4. Sends the initial prompt (create team + getting-started)

set -euo pipefail

REPLACE=false
MODAL=false
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --replace) REPLACE=true; shift ;;
    --modal) MODAL=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

AGENT="${1:?Usage: spawn-agent.sh [--replace] [--modal] <agent-name>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZULIP_SITE="${ZULIP_SITE:?ZULIP_SITE must be set (e.g. https://your-org.zulipchat.com)}"

# Find the zulr DB
REPO_SLUG=$(echo "$REPO_ROOT" | sed 's|/|-|g')
DB_PATH="$HOME/.zulr/$REPO_SLUG/state.db"

if [ ! -f "$DB_PATH" ]; then
  echo "error: zulr DB not found at $DB_PATH"
  echo "Make sure the bot is registered via the register MCP tool first."
  exit 1
fi

# Extract bot credentials (pass values via env vars to avoid injection)
CREDS=$(ZULR_DB_PATH="$DB_PATH" ZULR_BOT_NAME="$AGENT" bun -e "
import { Database } from 'bun:sqlite';
const db = new Database(process.env.ZULR_DB_PATH!);
const row = db.query('SELECT bot_email, api_key FROM teammates WHERE name = ?').get(process.env.ZULR_BOT_NAME!);
if (!row) { console.error('Bot not found: ' + process.env.ZULR_BOT_NAME); process.exit(1); }
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
  if [ "$REPLACE" = true ]; then
    echo "Replacing existing agent '$AGENT'..."
    echo "y" | mngr destroy --force "$AGENT" 2>/dev/null || true
    git branch -D "mngr/$AGENT" 2>/dev/null || true
  else
    echo "error: agent '$AGENT' already exists. Use --replace to destroy and recreate."
    exit 1
  fi
fi

# Common env vars for both local and Modal modes
COMMON_ENV=(
  --env "ZULR_TEAM=zulr-$AGENT"
  --env "ZULR_AGENT=$AGENT"
  --env "ZULIP_SITE=$ZULIP_SITE"
  --env "ZULIP_BOT_EMAIL=$BOT_EMAIL"
  --env "ZULIP_BOT_API_KEY=$BOT_API_KEY"
)

if [ "$MODAL" = true ]; then
  MODAL_EXTRA_ENV=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    MODAL_EXTRA_ENV+=(--env "GITHUB_TOKEN=$GITHUB_TOKEN")
  else
    echo "warning: GITHUB_TOKEN not set — Modal agent won't be able to push to GitHub"
  fi

  # Resolve Claude Code auth for the remote sandbox.
  # CLAUDE_CODE_OAUTH_TOKEN: long-lived token from 'claude setup-token' (subscription billing)
  # ANTHROPIC_API_KEY: API key (per-token billing)
  MODAL_AUTH_ENV=()
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    MODAL_AUTH_ENV=(--env "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    MODAL_AUTH_ENV=(--env "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
  else
    echo "error: --modal requires Claude Code auth. Set one of:"
    echo "  CLAUDE_CODE_OAUTH_TOKEN  (from 'claude setup-token')"
    echo "  ANTHROPIC_API_KEY"
    exit 1
  fi

  MODAL_TIMEOUT="${MODAL_TIMEOUT:-3600}"
  MODAL_CPU="${MODAL_CPU:-2}"
  MODAL_MEMORY="${MODAL_MEMORY:-4}"
  MODAL_IDLE_TIMEOUT="${MODAL_IDLE_TIMEOUT:-5m}"

  DOCKERFILE="$SCRIPT_DIR/Dockerfile.modal"
  if [ ! -f "$DOCKERFILE" ]; then
    echo "error: Dockerfile not found at $DOCKERFILE"
    exit 1
  fi

  # Generate the MCP config on-sandbox since local paths don't apply.
  # mngr places the repo at /mngr/projects/agent-<id>/ which is the work_dir.
  GENERATE_MCP='printf '"'"'{"mcpServers":{"zulr":{"type":"stdio","command":"%s/.bun/bin/bun","args":["run","%s/packages/zulr/src/index.ts"]}}}'"'"' "$HOME" "$(pwd)" > /tmp/zulr-mcp.json'

  echo "Creating Modal agent '$AGENT'..."
  mngr create "$AGENT@.modal" claude \
    "${COMMON_ENV[@]}" \
    "${MODAL_AUTH_ENV[@]}" \
    "${MODAL_EXTRA_ENV[@]}" \
    -b "file=$DOCKERFILE" \
    -b "timeout=$MODAL_TIMEOUT" \
    -b "cpu=$MODAL_CPU" \
    -b "memory=$MODAL_MEMORY" \
    --idle-timeout "$MODAL_IDLE_TIMEOUT" \
    --idle-mode io \
    --no-ensure-clean \
    --extra-provision-command 'bun install' \
    --extra-provision-command "$GENERATE_MCP" \
    --no-connect \
    -- --mcp-config /tmp/zulr-mcp.json --permission-mode auto
else
  # Generate the MCP config in ~/.zulr/<repo-slug>/ alongside the DB
  ZULR_STATE_DIR="$HOME/.zulr/$REPO_SLUG"
  MCP_CONFIG="$ZULR_STATE_DIR/standalone-mcp.json"
  cat > "$MCP_CONFIG" << MCPEOF
{
  "mcpServers": {
    "zulr": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "$REPO_ROOT/packages/zulr/src/index.ts"]
    }
  }
}
MCPEOF

  echo "Creating agent '$AGENT'..."
  mngr create "$AGENT" claude \
    "${COMMON_ENV[@]}" \
    --no-ensure-clean \
    --no-connect \
    -- --mcp-config "$MCP_CONFIG" --permission-mode auto
fi

# Helper: send tmux keys to the agent's session.
# For local agents, uses tmux directly. For Modal, uses mngr exec to run
# tmux on the remote sandbox.
TMUX_SESSION="mngr-$AGENT"
send_keys() {
  if [ "$MODAL" = true ]; then
    local escaped_args
    escaped_args=$(printf '%q ' "$@")
    mngr exec "$AGENT" "tmux send-keys -t $TMUX_SESSION $escaped_args" 2>/dev/null || true
  else
    tmux send-keys -t "$TMUX_SESSION" "$@"
  fi
}

# Navigate Claude Code's startup dialogs (trust, theme, auto mode).
# On first run (common on Modal), Claude Code shows a theme picker and
# possibly a login prompt before the trust and auto-mode dialogs.
for i in $(seq 1 60); do
  SCREEN=$(mngr capture "$AGENT" 2>/dev/null || true)

  # Theme picker (first-run only) — accept default with Enter
  if echo "$SCREEN" | grep -q "Dark mode"; then
    send_keys Enter
    echo "Accepted theme"
    sleep 2
    continue
  fi

  # API key detection — Claude Code asks whether to use the detected key.
  # Select "Yes" (first option) with Up + Enter.
  if echo "$SCREEN" | grep -q "API key"; then
    send_keys Up Enter
    echo "Accepted API key"
    sleep 2
    continue
  fi

  # Trust dialog
  if echo "$SCREEN" | grep -q "Yes, I trust this folder"; then
    send_keys Enter
    echo "Approved trust dialog"
    sleep 2
    continue
  fi

  # Auto mode dialog
  if echo "$SCREEN" | grep -q "Yes, enable auto mode"; then
    send_keys Down Enter
    echo "Approved auto mode"
    sleep 2
    continue
  fi

  if echo "$SCREEN" | grep -q "auto mode on"; then
    echo "Claude Code ready"
    break
  fi

  sleep 1
done

# Send the initial prompt
echo "Sending initial prompt..."
INITIAL_PROMPT="Create a team called 'zulr-$AGENT' using TeamCreate. Then read the docs channel topic 'getting-started' using the catch-up tool and follow its instructions."
send_keys "$INITIAL_PROMPT" Enter

echo ""
echo "Agent '$AGENT' spawned successfully!"
echo "  Connect: mngr connect $AGENT"
echo "  Capture: mngr capture $AGENT"
echo "  Destroy: echo y | mngr destroy --force $AGENT"
