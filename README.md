# Instagram Discord Bot

Discord-based Instagram automation bot that reuses the existing Instagram API core (`instagram-private-api` + `instagram_mqtt`) and exposes bot commands for inbox/search/send/reply.

## Features

- Discord slash command surface: `/ig inbox`, `/ig search`, `/ig send`, `/ig reply`
- Interactive panel: `/ig panel` (buttons + form modals)
- Account switching commands: `/ig account list`, `/ig account use`, `/ig account current`
- Realtime Instagram DM relay from MQTT events to Discord channels
- Thread-to-channel mapping persistence
- Session-based multi-account support
- Safety layer with rate limiting, queueing, and retries

## Requirements

- Node.js 20+
- A Discord application + bot token
- Existing Instagram sessions under `~/.instagram-discord-bot/users/<username>/session.ts.json`

## Environment Variables

- `DISCORD_BOT_TOKEN` (required)
- `DISCORD_CLIENT_ID` (required)
- `DISCORD_GUILD_ID` (optional, for guild-scoped command registration)
- `IG_DEFAULT_ACCOUNT` (optional)

## Run

```bash
npm ci
npm run auth:login
npm run build
npm start
```

Create `.env` first (recommended via template):

```bash
cp .env.example .env
```

## Development

```bash
npm run dev
npm test
```

## First-Time Auth

Run one-time session login to create:
`~/.instagram-discord-bot/users/<username>/session.ts.json`

```bash
npm run auth:login
```

## Account Selection

Use Discord commands to manage active account (no password in Discord):

```text
/ig account list
/ig account use username:<your_username>
/ig account current
```

All IG command responses include a warning banner:
"Unofficial Instagram integration. Use temporary/demo accounts. Use at your own risk."

## Project Structure

- `source/bot.ts`: app bootstrap
- `source/discord/*`: Discord runtime and commands
- `source/bridge/*`: IG -> Discord relay and thread mapping store
- `source/core/instagram/*`: core Instagram module facade
- `source/safety/*`: rate limiter, queue, retry utilities
- `source/client.ts`: preserved Instagram client implementation
