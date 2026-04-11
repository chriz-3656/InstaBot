# InstaBot

Unofficial Discord-to-Instagram automation bot built on top of `instagram-private-api` and `instagram_mqtt`.

It lets you manage Instagram DMs from Discord with slash commands and an interactive panel.

## Disclaimer

This is an **unofficial Instagram integration**.

Use temporary/demo accounts only. Do **not** use your main account. You use this project at your own risk. Instagram can rate-limit, challenge, or restrict accounts that use unofficial clients.

## Features

- Instagram DM actions from Discord
- Slash commands: inbox, search, send, reply
- Interactive panel (`/ig panel`) with buttons and modal forms
- Account management commands:
  - `/ig account list`
  - `/ig account use username:<name>`
  - `/ig account current`
- Realtime relay of incoming IG messages to mapped Discord channels
- Session-based auth (no Instagram password sent in Discord)
- Safety layer: queue + rate limiting + retry logic

## Tech Stack

- Node.js + TypeScript
- Discord: `discord.js`
- Instagram: `instagram-private-api` + `instagram_mqtt`
- Build: `esbuild`
- Lint/format/test: `xo`, `prettier`, `ava`

## Requirements

- Node.js 20+
- A Discord bot application/token
- A Discord server where you can add the bot

## Setup

1. Install dependencies:

```bash
npm ci
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill `.env`:

- `DISCORD_BOT_TOKEN` (required)
- `DISCORD_CLIENT_ID` (required)
- `DISCORD_GUILD_ID` (optional, recommended for faster guild command registration)
- `IG_DEFAULT_ACCOUNT` (optional fallback account)

## Discord Bot Invite

Use this format:

```text
https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=274877919232
```

Replace `<DISCORD_CLIENT_ID>` with your value from `.env`.

## Authentication (Important)

Instagram login is local/terminal only.

Do one-time login to create a session file:

```bash
npm run auth:login
```

This stores session data under:

```text
~/.instagram-discord-bot/users/<username>/session.ts.json
```

If 2FA/challenge is required, the CLI prompts for verification code.

## Run

Build and start:

```bash
npm run build
npm start
```

Development watch mode:

```bash
npm run dev
```

## Using the Bot

### Account Commands

- `/ig account list` -> list locally saved IG sessions
- `/ig account use username:<name>` -> set active account
- `/ig account current` -> show active account

### Message Commands

- `/ig inbox [limit]`
- `/ig search query:<text> [limit]`
- `/ig send thread:<id|username|title> text:<message>`
- `/ig reply thread:<id|username|title> message_id:<id> text:<message>`

### Interactive UI

- `/ig panel`

Panel buttons:

- Inbox
- Search
- Send
- Reply

Search/Send/Reply open forms so users can enter fields without long slash command typing.

## Local Data Paths

Bot runtime data directory:

```text
~/.instagram-discord-bot/
```

Includes:

- `users/<username>/session.ts.json`
- `logs/`
- `discord-thread-map.json`
- `config.ts.yaml`

## Security Notes

- Never commit `.env`.
- Never share session files.
- Rotate Discord token if exposed.
- Use least-privilege Discord bot permissions when possible.
- Prefer private testing servers.

## Troubleshooting

### Error: `No session found for "<username>"`

Run:

```bash
npm run auth:login
```

Then set active account in Discord:

```text
/ig account use username:<username>
```

### Error: `Auth login failed: AggregateError`

Usually network/IP or Instagram-side request failure.

Try:

- Disable VPN/proxy
- Switch network (mobile hotspot)
- Retry after some time
- Verify credentials

Check logs in:

```text
~/.instagram-discord-bot/logs/
```

### Slash commands not showing

- Ensure bot has `applications.commands` scope
- If using `DISCORD_GUILD_ID`, commands are guild-scoped and faster to register
- Restart bot after env changes

## Scripts

- `npm run auth:login` - local Instagram login/session creation
- `npm run build` - typecheck + production build
- `npm start` - start bot from `dist`
- `npm run dev` - watch build
- `npm test` - prettier + xo + ava
- `npm run format` - format files

## Project Structure

- `source/bot.ts` - app bootstrap
- `source/auth-login.ts` - local auth/session bootstrap
- `source/discord/` - discord runtime + command router
- `source/discord/commands/ig.ts` - slash/button/modal command handlers
- `source/bridge/` - IG thread/channel mapping + relay
- `source/safety/` - queue/rate-limit/retry
- `source/core/instagram/` - core facades
- `source/client.ts` - main Instagram client implementation

## License

MIT
