#!/bin/bash
# start-mirror.sh - Start Mirror Mode (single Claude Code session, Terminal + Telegram in sync)

SESSION="claude-code"
WINDOW="main"

# Check if tmux session already exists
if tmux has-session -t $SESSION 2>/dev/null; then
    echo "tmux session '$SESSION' already exists."
    # Check if Claude Code is running
    PANE_CMD=$(tmux display-message -t $SESSION:$WINDOW -p "#{pane_current_command}" 2>/dev/null)
    if [ "$PANE_CMD" = "claude" ] || [ "$PANE_CMD" = "node" ]; then
        echo "Claude Code is already running in $SESSION:$WINDOW"
        echo "Attach with: tmux attach -t $SESSION"
        exit 0
    fi
else
    # Create new session
    tmux new-session -d -s $SESSION -n $WINDOW
    echo "Created tmux session: $SESSION"
fi

# Set environment variables and start Claude Code
tmux send-keys -t $SESSION:$WINDOW 'export TELEGRAM_HOOK_ENABLED=true' Enter
sleep 0.5
tmux send-keys -t $SESSION:$WINDOW 'claude' Enter

# Ensure pm2 services are running
cd "$(dirname "$0")"
pm2 describe ngrok-telegram > /dev/null 2>&1 || pm2 start ecosystem.config.js
pm2 describe telegram-webhook > /dev/null 2>&1 || pm2 start ecosystem.config.js

echo ""
echo "=== Mirror Mode Started ==="
echo "Terminal: tmux attach -t $SESSION"
echo "Telegram: Send /cmd <command> or just type a message"
echo ""
echo "Both sides see the same conversation."
