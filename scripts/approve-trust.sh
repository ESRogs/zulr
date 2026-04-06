#!/bin/bash
# Approve Claude Code's workspace trust dialog for a mngr agent.
# Usage: ./approve-trust.sh <agent-name> [true|false]
#
# The second argument indicates Modal mode (default: false).
# For local agents, sends keys via local tmux.
# For Modal agents, sends keys via mngr exec on the remote sandbox.

set -euo pipefail

AGENT="${1:?Usage: approve-trust.sh <agent-name> [modal]}"
MODAL="${2:-false}"
TIMEOUT="${3:-30}"
TMUX_SESSION="mngr-${AGENT}"

send_keys() {
  if [ "$MODAL" = true ]; then
    mngr exec "$AGENT" "tmux send-keys -t $TMUX_SESSION $*" 2>/dev/null || true
  else
    tmux send-keys -t "$TMUX_SESSION" "$@"
  fi
}

for i in $(seq 1 "$TIMEOUT"); do
  SCREEN=$(mngr capture "$AGENT" 2>/dev/null || true)

  if echo "$SCREEN" | grep -q "Yes, I trust this folder"; then
    send_keys Enter
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
