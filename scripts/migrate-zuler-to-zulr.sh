#!/bin/bash
# One-time migration from zuler to zulr.
#
# What this does:
#   - Moves ~/.zuler/ → ~/.zulr/ if it exists (preserves SQLite DB, log file, standalone MCP config)
#   - Rewrites standalone-mcp.json paths from /.zuler/ to /.zulr/ and packages/zuler/ to packages/zulr/
#   - Reports any .env files in the cwd that reference ZULER_* env vars (does NOT auto-modify)
#
# Idempotent — running twice is a no-op.
#
# What this does NOT do:
#   - Migrate running mngr standalone agents. Their env vars and command lines are baked in;
#     they need to be destroyed and respawned. Use `mngr destroy <name>` then re-run
#     scripts/spawn-agent.sh with the new ZULR_* env vars.
#   - Rename the local repo directory. That's a developer choice.
#   - Clean up stale `~/.claude/teams/zuler-*/` team directories left behind by old standalone
#     agents. Nothing writes to them after migration, but you can `rm -rf` them by hand.
#
# IMPORTANT: stop any running zulr MCP servers (Claude Code sessions, mngr standalone agents)
# before running this script. A running MCP server has `~/.zuler/<repo-slug>/state.db` open
# and will silently recreate the directory after the move, leaving you with two state dirs
# and a confused process. If in doubt, restart your Claude Code session after running this.

set -euo pipefail

OLD_DIR="$HOME/.zuler"
NEW_DIR="$HOME/.zulr"

migrated=false

# Move ~/.zuler/ → ~/.zulr/ if applicable
if [ -d "$OLD_DIR" ]; then
  if [ -d "$NEW_DIR" ]; then
    echo "warning: both $OLD_DIR and $NEW_DIR exist."
    echo "  Not moving — investigate which one is current and merge manually."
    echo "  Tip: $NEW_DIR may have been created by a fresh install; back it up and run again."
    exit 1
  fi
  echo "Moving $OLD_DIR → $NEW_DIR"
  mv "$OLD_DIR" "$NEW_DIR"
  migrated=true
else
  echo "No $OLD_DIR found — skipping move."
fi

# Rewrite paths inside any standalone-mcp.json files
if [ -d "$NEW_DIR" ]; then
  while IFS= read -r -d '' mcp_file; do
    if grep -qE '\.zuler/|packages/zuler/|"zuler"' "$mcp_file"; then
      echo "Rewriting paths in $mcp_file"
      tmp="$mcp_file.tmp.$$"
      sed -e 's|/\.zuler/|/.zulr/|g' \
          -e 's|/packages/zuler/|/packages/zulr/|g' \
          -e 's|"zuler"|"zulr"|g' \
          "$mcp_file" > "$tmp" && mv "$tmp" "$mcp_file"
      migrated=true
    fi
  done < <(find "$NEW_DIR" -name 'standalone-mcp.json' -type f -print0 2>/dev/null)
fi

# Report (but don't modify) .env files referencing ZULER_*
if [ -f ".env" ] && grep -qE '^ZULER_' ".env"; then
  echo ""
  echo "note: ./.env references ZULER_* env vars. Rename them to ZULR_* manually:"
  grep -nE '^ZULER_' ".env" | sed 's/^/  /'
fi

# Report running standalone agents that will need a respawn
if command -v mngr >/dev/null 2>&1; then
  running=$(mngr list --format json 2>/dev/null || echo '[]')
  if echo "$running" | grep -q '"running"'; then
    echo ""
    echo "note: running mngr agents will have stale ZULER_* env vars baked in."
    echo "  Destroy and respawn them via scripts/spawn-agent.sh:"
    echo "    mngr list                    # see the names"
    echo "    mngr destroy --force <name>"
    echo "    scripts/spawn-agent.sh <name>"
  fi
fi

if [ "$migrated" = true ]; then
  echo ""
  echo "Migration done."
else
  echo "Nothing to migrate."
fi
