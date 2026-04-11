# InstaBot

Unofficial Discord-to-Instagram automation bot built on top of `instagram-private-api` and `instagram_mqtt`.

It lets you manage Instagram DMs from Discord with slash commands, rich embeds, and interactive components.

## Disclaimer

This is an **unofficial Instagram integration**.

Use temporary/demo accounts only. Do **not** use your main account. You use this project at your own risk. Instagram can rate-limit, challenge, or restrict accounts that use unofficial clients.

## Features

### Messaging

- **Send DMs** - Send messages to any Instagram thread/user
- **Reply** - Reply to specific messages in a thread
- **Unsend** - Delete/unsend previously sent messages
- **Realtime relay** - Incoming IG messages are relayed to mapped Discord channels as rich embeds
- **Quick actions** - Reply and Open Thread buttons on every relayed message open pre-filled modals

### Inbox & Search

- **Inbox** - View recent DM threads with unread indicators
- **Search** - Find threads by username or title with match scoring
- **Unread check** - See all unread conversations at a glance

### Profile & Lookup

- **Profile lookup** - View any public Instagram profile (bio, follower/following/post counts, verification status)

### Notifications

- **Follower alerts** - Background polling detects new followers and posts alerts to Discord
- **Mention alerts** - Detects when someone tags/mentions your account in posts
- **Toggle controls** - Enable/disable each notification type per account

### Account Management

- Multi-account support with session-based authentication
- `/ig account list` - List saved sessions
- `/ig account use` - Switch active account
- `/ig account current` - Show active account

### Interactive UI

- Rich embed responses with color-coded messages (success, error, info)
- Select menus for inbox/search thread navigation
- Modal forms for send, reply, and search (no long slash command typing)
- Button-based panel for quick access

### Safety

- Token bucket rate limiting
- Async queue for operation serialization
- Exponential backoff retry logic
- Interaction expiry handling (prevents "Interaction failed" errors)
- Discord API limit compliance (100-byte customIds, 100-char labels, etc.)

## Tech Stack

- Node.js + TypeScript (ESM)
- Discord: `discord.js` v14
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

| Command                           | Description                    |
| --------------------------------- | ------------------------------ |
| `/ig account list`                | List locally saved IG sessions |
| `/ig account use username:<name>` | Set active account             |
| `/ig account current`             | Show active account            |

### Message Commands

| Command                                                                 | Description                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| `/ig inbox [limit]`                                                     | View recent DM threads (with select menu)           |
| `/ig search query:<text> [limit]`                                       | Search threads by username/title (with select menu) |
| `/ig send thread:<id\|username\|title> text:<message>`                  | Send a DM                                           |
| `/ig reply thread:<id\|username\|title> message_id:<id> text:<message>` | Reply to a specific message                         |
| `/ig unsend thread:<id\|username\|title> message_id:<id>`               | Delete/unsend a message                             |
| `/ig unread [limit]`                                                    | Check for unread messages                           |

### Profile & Lookup

| Command                       | Description                 |
| ----------------------------- | --------------------------- |
| `/ig profile username:<name>` | View Instagram profile info |

### Notifications

| Command                            | Description                |
| ---------------------------------- | -------------------------- |
| `/ig notifications type:followers` | Toggle new follower alerts |
| `/ig notifications type:mentions`  | Toggle mention/tag alerts  |

### Interactive UI

- `/ig panel` - Opens interactive DM manager panel

Panel buttons:

- **Inbox** - View recent threads with select menu
- **Search** - Open search form modal
- **Send** - Open send message modal
- **Reply** - Open reply modal

Relayed message buttons (on every incoming DM embed):

- **Reply** - Opens reply modal pre-filled with thread and message ID
- **Open Thread** - Opens send modal pre-filled with thread ID

Select menus:

- Inbox and search results include a dropdown to select a thread
- Selecting a thread opens a send modal with the thread ID pre-filled

## Notification Poller

The bot runs a background notification poller that checks for events every 5 minutes (configurable):

- **New followers** - Compares current followers with cached baseline, alerts on new follows
- **Mentions** - Checks posts where your account is tagged, shows caption preview

Notification state is persisted in `data/notification_state.json`. Alerts are sent to the first available text channel the bot can access.

## Local Data Paths

Bot runtime data directory:

```text
~/.instagram-discord-bot/
```

Includes:

- `users/<username>/session.ts.json` - Session files
- `logs/` - Log files
- `discord-thread-map.json` - IG thread to Discord channel mappings
- `config.ts.yaml` - Bot configuration

Local project data (created automatically):

- `data/notification_state.json` - Notification poller state (followers, mentions)

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

### "Interaction failed" error

- This can happen if a button/modal takes too long to respond
- The bot now defers interactions before async operations to prevent this
- If it persists, retry the action

## Scripts

| Script               | Description                            |
| -------------------- | -------------------------------------- |
| `npm run auth:login` | Local Instagram login/session creation |
| `npm run build`      | Typecheck + production build           |
| `npm start`          | Start bot from `dist`                  |
| `npm run dev`        | Watch mode development                 |
| `npm test`           | Prettier + xo + ava                    |
| `npm run format`     | Format files                           |

## Project Structure

```
source/
  bot.ts                          - App bootstrap
  client.ts                       - Main Instagram client (login, DMs, profiles, notifications)
  auth-login.ts                   - Local auth/session CLI
  session.ts                      - Session file management
  config.ts                       - Configuration management
  discord/
    bot.ts                        - Discord bot lifecycle
    command-router.ts             - Interaction routing (commands, buttons, modals, select menus)
    commands/ig.ts                - All slash command handlers and embed builders
    modals.ts                     - Shared modal builders (send, reply)
    account-manager.ts            - Instagram account session management
  bridge/
    dm-relay.ts                   - IG-to-Discord message relay with quick action buttons
    notification-poller.ts        - Background follower/mention notification poller
    thread-map-store.ts           - IG thread to Discord channel mapping
  core/instagram/
    index.ts                      - Core facades and exports
    thread-resolver.ts            - Thread resolution logic
  safety/
    rate-limiter.ts               - Token bucket rate limiter
    queue.ts                      - Async operation queue
    retry.ts                      - Exponential backoff retry
  utils/
    logger.ts                     - Structured logging
    message-parser.ts             - Instagram message parsing
  types/
    instagram.ts                  - TypeScript type definitions
```

## License

MIT
