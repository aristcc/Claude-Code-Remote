# Claude Code Remote

> Fork of [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) with enhanced **Mirror Mode** — bidirectional Terminal ↔ Telegram sync.

Control [Claude Code](https://claude.ai/code) remotely via multiple messaging platforms. Start tasks locally, receive notifications when Claude completes them, and send new commands by simply replying.

## What's New in This Fork

- **Mirror Mode** — Bidirectional sync between your terminal (tmux) and Telegram. Both sides see the same Claude conversation.
- **Simplified Telegram commands** — No token required. Just type your message or use `/cmd <command>`.
- **Transcript-based notifications** — Reads the actual Claude transcript file for accurate output (fixes `type: 'user'` vs `'human'` parsing).
- **HTML formatting with auto-fallback** — Sends Telegram messages as HTML; falls back to plain text if parsing fails.
- **Cleaned up session management** — Removed token/session system for single-user mirror mode use.

## Supported Platforms

- 📱 **Telegram** — Interactive bot with mirror mode
- 📧 **Email** — SMTP/IMAP integration with execution trace
- 💬 **LINE** — Rich messaging with token-based commands
- 🖥️ **Desktop** — Sound alerts and system notifications

## Quick Start

### Prerequisites

- Node.js >= 14.0.0
- tmux (for mirror mode)
- A Telegram bot (create via [@BotFather](https://t.me/BotFather))
- ngrok or a public HTTPS URL for the webhook

### Install

```bash
git clone https://github.com/aristcc/Claude-Code-Remote.git
cd Claude-Code-Remote
npm install
```

### Configure

```bash
cp .env.example .env
nano .env
```

Set these required values:

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
TELEGRAM_WEBHOOK_URL=https://your-ngrok-url.app
```

### Configure Claude Code Hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node /path/to/Claude-Code-Remote/claude-hook-notify.js completed",
        "timeout": 5
      }]
    }]
  }
}
```

Or run the interactive setup:

```bash
npm run setup
```

### Test

```bash
node claude-hook-notify.js completed
```

You should receive a Telegram notification.

## Mirror Mode Setup

Mirror Mode creates a single Claude Code session in tmux and bridges it with Telegram. Everything you see in the terminal, your Telegram bot reports. Commands from Telegram are injected directly into the Claude session.

### 1. Configure for tmux injection

In your `.env`:

```env
INJECTION_MODE=tmux
TMUX_SESSION=claude-code:main
```

### 2. Start mirror mode

```bash
chmod +x start-mirror.sh
./start-mirror.sh
```

This will:
- Create a tmux session `claude-code:main`
- Launch Claude Code inside it
- Start ngrok + webhook server via pm2

### 3. Use it

- **Terminal**: `tmux attach -t claude-code` — interact with Claude normally
- **Telegram**: Type a message or `/cmd <command>` — it goes to the same Claude session
- **Notifications**: When Claude finishes, you get the full response on Telegram

### Architecture

```
┌─────────────┐     Claude Code Hooks      ┌───────────────────┐
│  Terminal    │ ──────────────────────────→ │  Telegram Bot     │
│  (tmux)     │                             │  (notifications)  │
│             │ ←────────────────────────── │                   │
└─────────────┘   tmux send-keys injection  └───────────────────┘
                         ↑
                   Webhook Server
                   (express + ngrok)
```

## All Channels

### Email

```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_TO=your-email@gmail.com
```

### LINE

```env
LINE_ENABLED=true
LINE_CHANNEL_ACCESS_TOKEN=your-token
LINE_CHANNEL_SECRET=your-secret
LINE_USER_ID=your-user-id
```

### Desktop (always enabled)

Sound alerts play automatically when Claude completes a task.

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_ENABLED` | `false` | Enable Telegram notifications |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your personal chat ID |
| `TELEGRAM_GROUP_ID` | — | Group chat ID (usually negative) |
| `TELEGRAM_WEBHOOK_URL` | — | Public HTTPS URL for webhook |
| `TELEGRAM_WEBHOOK_PORT` | `3001` | Local port for webhook server |
| `TELEGRAM_FORCE_IPV4` | `false` | Force IPv4 for Telegram API |
| `INJECTION_MODE` | `pty` | `pty` or `tmux` |
| `TMUX_SESSION` | `claude-code:main` | Target tmux session:window |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude CLI binary |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

See `.env.example` for the full list.

## PM2 Process Management

For production use, manage ngrok and the webhook server with pm2:

```bash
# Start both services
pm2 start ecosystem.config.js

# Check status
pm2 status

# View logs
pm2 logs telegram-webhook
```

## Troubleshooting

**Not receiving Telegram notifications?**
```bash
# Test notification directly
node claude-hook-notify.js completed

# Check webhook status
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

**Commands from Telegram not working?**
```bash
# Verify tmux session exists
tmux list-sessions

# Check injection mode in .env
grep INJECTION_MODE .env  # Should be 'tmux'
```

**Webhook not receiving updates?**
```bash
# Check ngrok is running
curl http://localhost:4040/api/tunnels

# Re-register webhook
node -e "
  const handler = require('./src/channels/telegram/webhook');
  const h = new handler({botToken: process.env.TELEGRAM_BOT_TOKEN});
  h.setWebhook('YOUR_NGROK_URL/webhook/telegram').then(console.log);
"
```

## Credits

- Original project: [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) by [@Jiaxi_Cui](https://x.com/Jiaxi_Cui)
- Contributors to the original: [@vaclisinc](https://github.com/vaclisinc), [@kevinsslin](https://github.com/kevinsslin), [@laihenyi](https://github.com/laihenyi)

## License

MIT License
