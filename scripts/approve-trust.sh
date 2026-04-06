#!/bin/bash
# Approve Claude Code's workspace trust dialog for a mngr agent.
# Usage: ./approve-trust.sh <agent-name>
#
# Polls the agent's screen for the trust dialog, approves it with Enter,
# and exits. If the dialog doesn't appear within the timeout, reports
# what the screen shows instead.

set -euo pipefail

AGENT="${1:?Usage: approve-trust.sh <agent-name>}"
TIMEOUT="${2:-30}"
TMUX_SESSION="mngr-${AGENT}"

for i in $(seq 1 "$TIMEOUT"); do
  SCREEN=$(mngr capture "$AGENT" 2>/dev/null || true)

  if echo "$SCREEN" | grep -q "Yes, I trust this folder"; then
    tmux send-keys -t "$TMUX_SESSION" Enter
    echo "approved trust dialog for $AGENT"
    exit 0
  fi

  # Check for other known dialogs we should NOT approve
  if echo "$SCREEN" | grep -q "Bypass Permissions mode"; then
    echo "error: got bypass permissions dialog instead of trust dialog"
    echo "screen content:"
    echo "$SCREEN" | tail -10
    exit 1
  fi

  # Check if Claude Code already started (no dialog needed)
  if echo "$SCREEN" | grep -q "Claude Code v"; then
    if ! echo "$SCREEN" | grep -q "trust this folder"; then
      echo "Claude Code already running — no trust dialog needed"
      exit 0
    fi
  fi

  sleep 1
done

echo "error: trust dialog not found within ${TIMEOUT}s"
echo "last screen content:"
mngr capture "$AGENT" 2>/dev/null | tail -15
exit 1
