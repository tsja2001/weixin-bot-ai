# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Overview

This is a WeChat personal account Bot that connects to Tencent's official iLink Bot API (`ilinkai.weixin.qq.com`) and uses an Anthropic-format AI API for auto-reply. Single implementation in Node.js (`bot.js`, Node 18+, no extra deps).

## Running the bot

```bash
# Node.js (Node 18+, no extra deps)
node bot.js
```

The bot runs as a macOS launchd service for production:
```bash
# Check status
launchctl list | grep clawbot

# Restart instance 1
launchctl unload ~/Library/LaunchAgents/com.weixin.clawbot-api.plist && \
launchctl load ~/Library/LaunchAgents/com.weixin.clawbot-api.plist

# Restart instance 2
launchctl unload ~/Library/LaunchAgents/com.weixin.clawbot-api-2.plist && \
launchctl load ~/Library/LaunchAgents/com.weixin.clawbot-api-2.plist

# View live logs
tail -f logs/bot.log       # stdout
tail -f logs/bot-error.log # stderr
```

## Configuration

`config.json` (gitignored) — first run creates it interactively. Fields: `api_key`, `base_url`, `model`, `prompt`. After creation, subsequent runs show the current config (API key masked) and offer to keep or recreate.

## Architecture

### iLink bot lifecycle
1. `GET /ilink/bot/get_bot_qrcode?bot_type=3` → get QR code for scanning in WeChat
2. Poll `GET /ilink/bot/get_qrcode_status` until `status: "confirmed"` → receive `bot_token` and dynamic `base_url`
3. Enter long-polling loop: `POST /ilink/bot/getupdates` (server holds ~35s)
4. On new message: `GET /ilink/bot/getconfig` (caches per-user `typing_ticket` once) → `POST /ilink/bot/sendtyping` (status=1) → call AI API → `POST /ilink/bot/sendmessage` → `POST /ilink/bot/sendtyping` (status=2)

Each request must carry: `Content-Type`, `AuthorizationType: ilink_bot_token`, `X-WECHAT-UIN` (random uint32 base64-encoded), and `Authorization: Bearer <token>`.

### AI API (`callAI`)
`callAI()` function sends `POST <base_url>/v1/messages` with `Authorization: Bearer` header. Built-in gradient retry (5 retries: 2s/4s/8s/16s/32s). Parses Codex (`content[0].text`) vs GPT (search `content` for `type: "text"`) response formats.

### Message priority system (order of processing each incoming message)
1. **Reconnect confirmation** — pending Y/N after `/重新连接`
2. **Warning response** — Y/N during active reconnect warning window
3. **Welcome** — first message from a user triggers auto-reply with command list (`COMMANDS_MSG`)
4. **Bot commands** — `/help`, `/指令` (show commands), `/time` (remaining connection), `/重新连接` (trigger reconnect)
5. **AI conversation** — everything else goes to the AI API

### 24h auto-reconnect system
iLink sessions expire after 24 hours. A background timer task (`reconnect_timer_task`/`reconnectTimerLoop`) runs concurrently with the message loop:
- Warns user at `session_duration - warning_before` with Y/N prompt (default: 2h before expiry)
- On N: re-asks every `reminder_interval` (30 min)
- At `force_before` remaining (30 min): forced reconnect, no confirmation needed
- Reconnect fetches new QR code, waits for scan, atomically replaces `bot_token` and `base_url`

Tune via `RECONNECT_CONFIG` in `bot.js`.

### Conversation context memory
Per-user sliding window of last 10 turns (20 messages), with 60-minute TTL. History is passed to `callAI()` on each AI request. Messages over 2000 chars are truncated before storage. Non-AI messages (commands, Y/N replies, welcome) are excluded.

### Shared mutable state
Module-level variables shared between the async message loop and reconnect timer: `botToken`, `botBaseUrl`, `loginTime`, `typingTicketCache`, `reconnectInProgress`, `warningActive`, `reconnectResolve`.

## Key constraints when modifying

- `sendmessage` payload must include all fields shown in `sendMsgSafe` — missing fields cause silent message loss (HTTP 200 but no delivery)
- `context_token` must come from the current received message, never reused
- `config.json` is gitignored and must never be committed (contains `api_key` in plaintext)
