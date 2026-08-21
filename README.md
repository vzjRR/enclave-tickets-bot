# Enclave Tickets

A Discord ticket bot built around one idea: **a support category should not
exist until someone needs it.**

Members open a ticket from a select menu. The bot creates a private channel
under the matching category, notifies the staff role, and lets any of them claim
it. When the ticket closes, it is archived to a staff log, the member is sent
their own copy, and the channel is deleted — leaving the server exactly as it
was.

```
Support Center                 visible to everyone
  ├── #create-ticket           the panel
  └── #tickets-log             staff read-only, bot writes

❓ Inquiries          invisible until it holds a ticket
⚠️ Technical Issue    invisible
🕵️ Reports            invisible
⛔ Ban Appeal         invisible
💸 Compensation       invisible
💰 Store              invisible
```

## Features

- **Self-provisioning.** One command builds the categories, channels, role and
  panel — or adopts the ones your server already has.
- **Categories that hide themselves.** A section category is invisible to
  everyone while empty and surfaces only for the people involved in a live
  ticket.
- **Notifications that reach people.** Staff are mentioned in the channel and
  optionally DMed; the member is DMed on open, on claim, and on close.
- **Durable archives.** Closed tickets become a structured log entry with a full
  transcript attached. The member gets their own copy by DM.
- **Authorization that is actually enforced.** Every command re-checks
  permissions in code rather than trusting Discord's per-command defaults.
- **Storage that survives a crash.** Atomic writes, a backup snapshot, and
  automatic recovery from a corrupt file.
- **A real test suite.** 68 assertions driven against a live guild.

## Requirements

- Node.js 18 or newer
- A Discord application with a bot user

## Quick start

```bash
npm ci
cp .env.example .env      # fill in DISCORD_TOKEN and CLIENT_ID
npm run deploy            # register slash commands
npm start
```

Then invite the bot (below) and run **`/quick-setup`** in your server.

On Windows, `start-bot.bat` does the install, registration and start in one go
and restarts the bot if it exits. For a Linux host see
[`deploy/README.md`](deploy/README.md).

## Bot permissions

`Manage Channels`, `Manage Roles`, `View Channels`, `Send Messages`,
`Manage Messages`, `Embed Links`, `Attach Files`, `Read Message History`,
`Pin Messages`

Permissions integer **`2251800082246672`**:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2251800082246672&scope=bot+applications.commands
```

Two are easy to miss:

- **`Manage Roles`** is required. Every ticket channel is private, and creating
  or editing a channel permission overwrite needs it. Without it, ticket
  creation fails outright.
- **`Pin Messages`** is a *separate* permission — Discord split it out of
  `Manage Messages`, so invite links generated before that change omit it and
  every pin returns 403. The bot works without it (it tracks the control message
  itself and only falls back to pins); you just lose the pin. `/quick-setup`
  reports it if missing.

The bot never needs `Mention Everyone` or `Administrator`.

## `/quick-setup`

Builds the whole structure, and is safe to re-run: roles, categories and
channels are matched by name and reused, panel messages are edited in place, and
category permissions are re-applied every time.

| Option | Default |
| --- | --- |
| `staff_role` | Creates/reuses a `Ticket Staff` role |
| `panel_channel` | Creates/reuses `#create-ticket` |
| `log_channel` | Creates/reuses `#tickets-log` |
| `anchor_category` | None — categories go wherever Discord puts them |
| `single_category` | `false` — one category per section |

The staff role it creates has **no** guild-wide permissions; all of its access
comes from channel overwrites.

### Adopting an existing server

On an established community you probably already have a tickets channel, a log
channel and a staff role. Point the bot at them in `.env` and `/quick-setup`
adopts them instead of creating its own:

```env
PANEL_CHANNEL_ID=000000000000000000
LOG_CHANNEL_ID=000000000000000000
STAFF_ROLE_ID=000000000000000000
ANCHOR_CATEGORY_ID=000000000000000000
```

**Adopted channels are never wiped.** For a channel the bot creates it sets the
full permission overwrites; for one you hand it, it only *adds* what it needs —
its own access, plus staff read access on the log. Whatever overwrites the
channel already had are left alone, because that channel belongs to the server
rather than to the bot.

The one thing it will not do silently is change who can see your log channel. If
`@everyone` can read it, `/quick-setup` warns and leaves it alone — transcripts
are posted there, so that decision is yours.

`ANCHOR_CATEGORY_ID` places the new categories directly above that category,
preserving the relative order of everything else.

### How the invisible categories work

A section category denies `ViewChannel` to `@everyone` **and grants the staff
role nothing**. On its own that makes it invisible to everybody.

When a ticket opens, the new channel carries its own overwrites allowing the
member and the staff role. Discord reveals a category to anyone who can see at
least one channel inside it, so:

- **Idle** — invisible to everyone.
- **A ticket opens** — the category appears for staff, showing `ticket-2011`,
  and any of them can claim it.
- **The member** sees only that category, holding only their own ticket.
- **On close** — the channel is deleted and the category disappears again.

This is why `Manage Roles` is required: those per-channel overwrites are the
entire mechanism.

## Ticket lifecycle

1. A member picks a category in the panel channel and writes their concern.
2. The bot creates `ticket-<number>`, private to them and the staff role.
3. Staff are **mentioned in the channel**, and DMed as well if
   `ENABLE_GUILD_MEMBERS` is on. The member is DMed a confirmation.
4. The pinned control message carries **Claim**, **Close & Delete** and
   **Admin Panel**.
5. On **Claim**, the member is told their ticket is being handled and by whom.
6. On **Close**, the archive is written to the log, the member is DMed a
   "Ticket Closed" card with their transcript attached, and the channel is
   deleted ten seconds later.

One open ticket per member. Ticket state lives in the channel topic (`owner=`,
`status=`, `claimedBy=`, `ticketNumber=`); configuration lives in
`data/tickets.json`.

### The log, and member privacy

Discord has no way to show a member only their own entry in a shared channel, so
the log stays staff-only and **each member is DMed their own transcript** when
their ticket closes. Set `TRANSCRIPT_SEND_TO_OWNER=false` to turn that off.

Each log entry records who opened, claimed and closed the ticket with their ids,
the open and close times, how long it stayed open, the category, the message
count, the concern the member wrote, and a full `.txt` transcript.

Transcripts include authors, timestamps and attachment URLs. Message **text**
additionally requires the Message Content intent; without it every line reads
`[no text content]` and the transcript header says so.

## Commands

| Command | Who can use it |
| --- | --- |
| `/quick-setup` | Manage Server |
| `/setup`, `/ticket-panel`, `/ticket-section-add`, `/tickets-refresh` | Manage Server |
| `/ticket-admin` | Manage Messages or Manage Channels in the ticket |
| `/ticket-close` | Ticket staff, **or** the member who opened it |
| `/ticket-add`, `/ticket-remove`, `/ticket-rename` | Ticket staff |

All of these are re-checked inside the bot. Discord's "default member
permissions" are only a default a server admin can override per role, so the
code never relies on them alone.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token. Required. |
| `CLIENT_ID` | — | Application id. Required to register commands. |
| `GUILD_ID` | empty | Register commands to one guild instantly. `npm run guilds` lists ids. |
| `PANEL_CHANNEL_ID` | empty | Adopt an existing panel channel. |
| `LOG_CHANNEL_ID` | empty | Adopt an existing log channel. |
| `STAFF_ROLE_ID` | empty | Adopt an existing staff role. |
| `ANCHOR_CATEGORY_ID` | empty | Place new categories above this category. |
| `BOT_ACTIVITY` | `ENCLAVE RP TICKETS SYSTEM` | Shown under the bot's name. |
| `BRAND_TAGLINE` | `Discord Manager` | Second half of every embed footer. |
| `CLOSED_CARD_THUMBNAIL` | empty | Image on the "Ticket Closed" card. |
| `ENABLE_GUILD_MEMBERS` | `false` | Privileged intent; lets staff be DMed. |
| `STAFF_DM_ON_NEW_TICKET` | `true` | DM staff on a new ticket (needs the above). |
| `STAFF_DM_LIMIT` | `25` | Cap on DMs per ticket. |
| `TRANSCRIPT_SEND_TO_OWNER` | `true` | DM the member their transcript. |
| `ENABLE_MESSAGE_CONTENT` | `false` | Privileged intent; puts message text in transcripts. |
| `TICKET_REFRESH_INTERVAL_MINUTES` | `30` | Maintenance sweep. Minimum 5. |

### Privileged intents

`ENABLE_GUILD_MEMBERS` and `ENABLE_MESSAGE_CONTENT` both map to privileged
gateway intents. Enable them at **Developer Portal → your app → Bot → Privileged
Gateway Intents** *before* switching them on here — requesting an intent that is
not enabled makes login fail outright. Both default to off, and the features
they gate degrade rather than break.

## Running it on a server

[`deploy/README.md`](deploy/README.md) covers a Linux host: a systemd unit that
restarts the bot on exit, a dedicated service user, filesystem confinement,
`journalctl` logging, and a backup command for `data/`. It is scoped to sit
alongside other bots on the same machine.

| Script | |
| --- | --- |
| `npm start` | Run the bot |
| `npm run deploy` | Register slash commands |
| `npm run guilds` | List servers the bot is in, with ids |
| `npm run selftest` | Live test suite |
| `npm run check` | Syntax-check every source file |
| `npm run audit` | Dependency vulnerability scan |

## Self-test

```bash
npm run selftest
```

68 assertions driven against the guild in `.env`: provisioning, every
permission rule, the full ticket lifecycle, adopting existing channels without
clobbering their overwrites, category positioning, branding, and notification
fallbacks. It cleans up after itself.

It opens and closes real tickets and DMs the guild owner, so **point it at a
test server, never at production.** As a guard against exactly that mistake it
refuses to run unless the target guild is named twice:

```bash
SELFTEST_ALLOW_GUILD=<your test guild id> npm run selftest
```

## Data and backups

Everything persistent is `data/tickets.json`: panel configuration, sections, the
log channel id, control message ids, the ticket counter and pending renames. It
is written atomically (temp file + rename) with a `.bak` snapshot the bot
recovers from automatically if the primary file is corrupt.

`data/` is gitignored and exists nowhere else. **Back it up.** Losing it means
re-running `/quick-setup` and resetting ticket numbering.

## Notes

- **No `@everyone` pings.** Ticket creation is member-triggered, so pinging the
  whole server on each one would let any member force a server-wide
  notification. Staff roles and the ticket owner are mentioned instead.
- **Channel renames are rate-limited** by Discord to roughly two per ten minutes
  per channel. The bot queues renames, retries with backoff, persists the queue
  and resumes it after a restart.
- **The admin panel is a staff gate, not an admin gate.** Any role with
  `Manage Messages` or `Manage Channels` on a ticket channel can use it there.
