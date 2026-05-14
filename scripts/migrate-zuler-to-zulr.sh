#!/bin/bash
# One-time migration from zuler to zulr.
#
# What this does:
#   - Moves ~/.zuler/ → ~/.zulr/ if it exists (preserves SQLite DB, log file, standalone MCP config)
#   - Rewrites standalone-mcp.json paths from /.zuler/ to /.zulr/ and packages/zuler/ to packages/zulr/
#   - Rewrites ZULER_* env var names to ZULR_* in ./.env (value-preserving — only the key is renamed)
#   - Exits non-zero if any running mngr standalone agents are detected (they need destroy + respawn)
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

# Auto-rewrite ZULER_* → ZULR_* env var names in ./.env. The transform is name-only
# (the value after the `=` is untouched), and incomplete migrations would silently fail at
# runtime since the code only reads ZULR_*. Backup the file before rewriting in case the
# user wants to compare.
if [ -f ".env" ] && grep -qE '^ZULER_' ".env"; then
  echo "Rewriting ZULER_* → ZULR_* in ./.env (backup at ./.env.zuler-bak)"
  cp ".env" ".env.zuler-bak"
  tmp=".env.tmp.$$"
  sed -E 's/^ZULER_([A-Z_]+)=/ZULR_\1=/' ".env" > "$tmp" && mv "$tmp" ".env"
  migrated=true
fi

# Detect running mngr standalone agents. They have ZULER_* env vars and old paths baked
# into their `mngr create` invocations; the script can't safely rewrite a running process.
# Exit non-zero so the user has to handle this explicitly — silent reports are easy to miss.
agents_blocking=false
if command -v mngr >/dev/null 2>&1; then
  running=$(mngr list --format json 2>/dev/null || echo '[]')
  if echo "$running" | grep -q '"running"'; then
    echo ""
    echo "error: running mngr agents detected — they have stale ZULER_* env vars baked in."
    echo "  Destroy and respawn each one before the rename takes effect:"
    echo "    mngr list                    # see the names"
    echo "    mngr destroy --force <name>"
    echo "    scripts/spawn-agent.sh <name>"
    agents_blocking=true
  fi
fi

if [ "$migrated" = true ]; then
  echo ""
  if [ "$agents_blocking" = true ]; then
    echo "Migration partially done — exiting non-zero because of running mngr agents (see above)."
    exit 1
  fi
  echo "Migration done."
else
  if [ "$agents_blocking" = true ]; then
    exit 1
  fi
  echo "Nothing to migrate."
fi
