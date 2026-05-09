# Moderation Bot

A Discord moderation bot built with **Discord.js v14** and **MongoDB (Mongoose)**.  
Designed with clear architectural separation, persistent moderation logs, and an autonomous AutoMod system.

---

## Features

### Slash Commands

| Command | Description |
|---|---|
| `/mod kick` | Kick a member (logs to DB) |
| `/mod ban` | Ban a member (logs to DB) |
| `/mod timeout` | Timeout a member for N minutes |
| `/warn add` | Issue a warning (persisted in MongoDB) |
| `/warn list` | Browse warning history with **paginated buttons** |
| `/warn-remove` | Remove a specific warning by ID |
| `/ticket-setup` | Post the support ticket panel |
| `/close` | Close and delete the current ticket channel |
| `/automod status` | View current AutoMod configuration |
| `/automod toggle` | Enable or disable AutoMod |
| `/automod set-action` | Set punishment (delete / warn / timeout / kick / ban) |
| `/automod add-word` | Add a phrase to the banned-word list |
| `/automod remove-word` | Remove a phrase from the banned-word list |
| `/automod set-log-channel` | Designate a channel for violation logs |
| `/automod set-spam-limit` | Configure spam detection threshold |
| `/automod exempt-role` | Add or remove a role from AutoMod exemptions |

### AutoMod System

Autonomous message moderation powered by an event-driven `messageCreate` listener:

- **Banned-word filter** — case-insensitive substring matching against a configurable list.
- **Spam detector** — sliding-window rate limiter per `(guild, user)` pair. In-memory for sub-millisecond checks.
- **Per-guild config** — all settings stored in MongoDB via `GuildConfig`, loaded with an in-memory cache to minimise DB reads on the hot path.
- **Configurable actions** — `delete`, `warn`, `timeout`, `kick`, `ban`.
- **Role exemptions** — roles can be whitelisted to bypass all AutoMod checks.
- **Violation log channel** — structured embeds posted to a designated channel.

### Paginated Warning List

`/warn list` uses Discord.js's `createMessageComponentCollector` to implement interactive pagination:

- Warnings split into pages of 5 entries.
- **◀ Previous** / **Next ▶** buttons update the embed in-place (no new messages).
- Buttons disabled at page boundaries.
- Collector uses `idle` timeout — 2 minutes of inactivity ends the session and disables buttons.
- Filter ensures only the command invoker can navigate pages.

---

## Architecture

```
index.js              — Bootstrap, client creation, interaction router
commands/
  mod.js              — Kick / ban / timeout with DB logging
  warnings.js         — Warn add + paginated warn list
  warn-remove.js      — Remove a specific warning by index
  ticket.js           — Ticket panel setup
  close.js            — Ticket closure with DB cleanup
  automod.js          — AutoMod configuration command
events/
  autoMod.js          — messageCreate handler (banned words + spam detection)
models/
  GuildUser.js        — Per-user moderation state (warnings, ticket state)
  GuildConfig.js      — Per-guild AutoMod configuration
  warnSchema.js       — Alternative collection-based warning model (reference)
```

---

## Setup

1. Clone the repository.
2. Copy `.env.example` to `.env` and fill in the values.
3. Enable **Message Content Intent** and **Server Members Intent** in the Discord Developer Portal.
4. Run `npm install`.
5. Run `node index.js`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `MONGO_URI` | MongoDB connection string |
