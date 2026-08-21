# Enclave Tickets

A Discord ticket bot that runs **two different ticket lifecycles side by side in
the same server**, so they can be compared directly on real traffic:

- **🎫 Modern Flow** — categories that stay invisible until a ticket exists, DM
  notifications to the member, and closing archives the ticket to a log channel
  and deletes the channel.
- **🗂️ Classic Flow** — the original AbuFaisal behaviour: a staff-visible
  category, no DMs, and closing renames the channel to `closed-<number>` and
  keeps it in place with Transcript / Open / Delete controls.

Each ticket records which flow it belongs to in its channel topic, and every
lifecycle decision branches on that.

## The two flows compared

| | 🎫 Modern | 🗂️ Classic |
| --- | --- | --- |
| Panel channel | `#create-ticket` | `#create-ticket-classic` |
| Categories | One hidden category per section | One shared, staff-visible category |
| Category visible when idle | No — invisible to everyone | Yes, to staff |
| Member notified on create | DM with their reason and a link | Nothing |
| Member notified on claim | DM: "under process", names the staff member | Nothing |
| Closing | Archives to `#tickets-log`, deletes the channel | Renames to `closed-<number>`, keeps it |
| After close | Channel gone; log entry is the record | Channel is the record |
| Reopen | Not possible — open a new ticket | Yes, renames back and restores access |
| Transcript | Written to the log automatically | On demand, DMed |
| Depends on renames | No | Yes — and Discord rate-limits them |

The last row is the substantive difference. Discord allows roughly **two channel
renames per ten minutes per channel**, and the classic flow puts a rename on the
critical path of both closing and reopening. The retry queue exists to absorb
that: renames are queued, retried with backoff, persisted to disk, and resumed
after a restart. The modern flow takes renames off that path entirely.

## Requirements

- Node.js 18 or newer
- A Discord application with a bot user

## Setup

1. `npm ci`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `CLIENT_ID`
   (and `GUILD_ID` for instant command registration while testing).
3. Invite the bot — see **Bot permissions**.
4. `npm run deploy` to register the slash commands.
5. `npm start`
6. In Discord, run **`/quick-setup`**. That builds both flows.

On Windows, `start-bot.bat` installs packages, registers commands on first run,
and restarts the bot if it exits. `deploy-commands.bat` forces a re-register.

Never commit `.env` or share the token. If it leaks, regenerate it in the
Developer Portal — a leaked bot token gives full control of the bot.

## Bot permissions

`Manage Channels`, `Manage Roles`, `View Channels`, `Send Messages`,
`Manage Messages`, `Embed Links`, `Attach Files`, `Read Message History`,
`Pin Messages`

That is permissions integer **`2251800082246672`**.

Two of these are easy to miss:

- **`Manage Roles`** is required. Every ticket channel is private, and creating
  or editing a channel permission overwrite needs it. Without it, ticket
  creation fails outright.
- **`Pin Messages`** is a *separate* permission — Discord split it out of
  `Manage Messages`, so an invite generated before that change does not include
  it and every pin returns 403. The bot handles this: it records the control
  message id in the channel topic and only falls back to pins, so tickets work
  either way. You just lose the pin. `/quick-setup` reports it if missing.

The bot does **not** need `Mention Everyone` and does **not** need
`Administrator`.

## `/quick-setup`

Builds everything in one command:

```
Support Center                 visible to everyone
  ├── #create-ticket           modern panel
  ├── #create-ticket-classic   classic panel
  └── #tickets-log             staff read-only, bot writes

❓ Inquiries          hidden — modern, appears only while holding a ticket
⚠️ Technical Issue    hidden — modern
🕵️ Reports            hidden — modern
⛔ Ban Appeal         hidden — modern
💸 Compensation       hidden — modern
💰 Store              hidden — modern

🗂️ Classic Tickets    staff-visible — every classic section lives here
```

It also creates a **Ticket Staff** role if you do not pass one, with *no*
guild-wide permissions — all of its access comes from channel overwrites.

| Option | Default |
| --- | --- |
| `staff_role` | Creates/reuses `Ticket Staff` |
| `panel_channel` | Creates/reuses `#create-ticket` under `Support Center` |
| `log_channel` | Creates/reuses `#tickets-log` |
| `anchor_category` | None — new categories go wherever Discord puts them |
| `single_category` | `false` — one modern category per section. `true` puts them all in one shared `🎫 TICKETS` category |

It is **idempotent**: roles, categories and channels are matched by name and
reused, panel messages are edited in place, category permissions are re-applied
on every run, and panel presentation is reset to the flow defaults. If a panel
moves channels, the old message is deleted so members cannot use a stale menu.

### Adopting an existing server

On an established community you usually already have a tickets channel, a log
channel and a staff role. Point the bot at them in `.env` and `/quick-setup`
adopts them instead of creating its own:

```env
PANEL_CHANNEL_ID=1535680161704452116
LOG_CHANNEL_ID=1535680712944918602
STAFF_ROLE_ID=1540394789550432288
ANCHOR_CATEGORY_ID=1535680078279741521
ENABLED_FLOWS=new
```

Each has a matching `/quick-setup` option (`panel_channel`, `log_channel`,
`anchor_category`, `staff_role`) if you would rather pass them per run.

**Adopted channels are never wiped.** For a channel the bot creates it sets the
full permission overwrites; for one you hand it, it only *adds* what it needs —
its own access, plus staff read access on the log channel. Whatever overwrites
the channel already had are left alone, because that channel belongs to the
server rather than to this bot.

The one thing it will not do silently is change who can see your log channel.
If `@everyone` can read it, `/quick-setup` warns you and leaves it as it is —
closed-ticket transcripts get posted there, so that is your call to make.

`ANCHOR_CATEGORY_ID` places the new categories directly above that category,
preserving the relative order of everything else in the list.

`ENABLED_FLOWS` picks which lifecycles to provision. Production normally wants
`new` on its own; set `new,classic` to run both side by side.

### How the hidden categories work

A modern section category denies `ViewChannel` to `@everyone` **and grants the
staff role nothing**. On its own that makes it invisible to everybody.

When a ticket opens, the new channel carries its own overwrites allowing the
member and the section's staff roles. Discord reveals a category to anyone who
can see at least one channel inside it, so:

- **Idle** — invisible to everyone.
- **A Ban Appeal ticket opens** — `⛔ Ban Appeal` appears for staff showing
  `ticket-2011`, and any staff member can claim it.
- **The member** sees only that category, holding only their own ticket.
- **On close** — the channel is deleted and the category disappears again.

The classic category is deliberately *not* hidden this way: it stays visible to
staff, which is how the original behaved, and closed tickets accumulate in it as
`closed-<number>`.

## The ticket log

Modern tickets are deleted on close, so `#tickets-log` is their only durable
record. Each entry is an embed plus a `.txt` transcript attachment recording
section, channel name, ticket number, message count, who opened / claimed /
closed it with their ids, opened and closed timestamps, how long it stayed open,
and the reason the member gave.

Message **text** requires the Message Content intent (below); without it each
line reads `[no text content]` and the transcript header says so.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token. Required. |
| `CLIENT_ID` | — | Application ID. Required for command registration. |
| `GUILD_ID` | empty | Register commands to one guild instantly. Empty registers globally. Run `npm run guilds` to list ids. |
| `PANEL_CHANNEL_ID` | empty | Adopt an existing channel for the panel. |
| `LOG_CHANNEL_ID` | empty | Adopt an existing channel for the archive. |
| `STAFF_ROLE_ID` | empty | Adopt an existing staff role. |
| `ANCHOR_CATEGORY_ID` | empty | Place new categories directly above this category. |
| `ENABLED_FLOWS` | `new,classic` | Which lifecycles to provision. |
| `BOT_ACTIVITY` | `ENCLAVE RP TICKETS SYSTEM` | Shown under the bot name in the member list. |
| `TICKET_REFRESH_INTERVAL_MINUTES` | `30` | Maintenance sweep. Minimum 5. |
| `ENABLE_MESSAGE_CONTENT` | `false` | Privileged intent; see below. |
| `TRANSCRIPT_SEND_TO_OWNER` | `true` | Classic-flow transcripts go to the member as well as the claiming staff member. |
| `CLOSED_CARD_THUMBNAIL` | empty | Image on the "Ticket Closed" card. Defaults to the bot avatar. |

### Message Content intent

1. Developer Portal → your app → **Bot** → **Privileged Gateway Intents** →
   enable **Message Content Intent**.
2. Set `ENABLE_MESSAGE_CONTENT=true` in `.env`.

Requesting the intent in code without enabling it in the portal makes login
fail, which is why it is opt-in. Leave it off and the bot still runs.

## Commands

| Command | Who can use it |
| --- | --- |
| `/quick-setup` | Manage Server |
| `/setup`, `/ticket-panel`, `/ticket-section-add`, `/tickets-refresh` | Manage Server |
| `/ticket-admin` | Manage Messages or Manage Channels in the ticket |
| `/ticket-close` | Ticket staff, **or** the member who opened the ticket |
| `/ticket-add`, `/ticket-remove`, `/ticket-rename` | Ticket staff |

`/ticket-close` follows the ticket's own flow: archive-and-delete for modern,
rename-and-keep for classic.

Every one of these is re-checked inside the bot. Discord's "default member
permissions" are only a default that a server admin can override per role, so
the code does not rely on them alone.

## Running it on a server

See [`deploy/README.md`](deploy/README.md) for a Linux / Oracle Cloud setup:
a systemd unit that restarts the bot on exit, a dedicated service user,
filesystem confinement, log access via `journalctl`, and a backup command for
`data/`. It is scoped so it can sit alongside other bots on the same box.

| Script | |
| --- | --- |
| `npm start` | Run the bot |
| `npm run deploy` | Register slash commands |
| `npm run guilds` | List servers the bot is in, with ids |
| `npm run selftest` | Full live test suite (see below) |
| `npm run check` | Syntax-check every source file |
| `npm run audit` | Dependency vulnerability scan |

## Self-test

```powershell
npm run selftest
```

Drives the real code paths against the guild in `.env`: provisions both flows,
asserts the structure and every permission rule, opens a ticket in each flow,
claims and closes them, and checks that the modern one was archived and deleted
while the classic one was renamed and kept. It cleans up after itself.

84 assertions, covering both flows end to end plus the production path:
adopting existing channels, preserving their overwrites, positioning
categories above an anchor, and provisioning a single flow.

It opens and closes real tickets in that guild and DMs the guild owner, so
point it at a test server, never at production.

## Data and backups

All persistent state is `data/tickets.json` — panel config for both flows,
sections, the log channel id, the ticket counter, and pending renames. It is
written atomically (temp file + rename) with a `.bak` copy the bot recovers from
automatically if the primary file is corrupt.

`data/` is gitignored. **Back it up separately.** Losing it means re-running
`/quick-setup` and losing the ticket counter.

## A note on `@everyone`

The original implementation pinged `@everyone` on every ticket creation. That is
deliberately **not** reproduced in either flow here: ticket creation is
member-triggered, so it let any member force a server-wide notification. Both
flows mention the responsible staff roles and the ticket owner instead. It is
the one place where the classic flow intentionally diverges from the original.
