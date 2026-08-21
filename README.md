# Enclave RP Ticket Bot

Discord ticket bot for the **Enclave RP** server. Members open a ticket from a
panel in `#create-ticket`; the bot creates a private channel under the matching
section category, notifies the member by DM, and lets staff claim and resolve
it. Closing a ticket archives it to a log channel and deletes the channel.

## Requirements

- Node.js 18 or newer
- A Discord application with a bot user

## Setup

1. Install dependencies:

   ```powershell
   npm ci
   ```

2. Copy `.env.example` to `.env` and fill it in:

   ```env
   DISCORD_TOKEN=your_bot_token
   CLIENT_ID=your_application_client_id
   GUILD_ID=optional_test_guild_id
   ```

   Never commit `.env` or share the token. If it leaks, regenerate it
   immediately in the Developer Portal — a leaked bot token gives full control
   of the bot.

3. Invite the bot (see **Bot permissions** below).

4. Register the slash commands (once, and again whenever they change):

   ```powershell
   npm run deploy
   ```

5. Start the bot:

   ```powershell
   npm start
   ```

6. In Discord, run **`/quick-setup`**. That is all — see below.

On Windows you can just run `start-bot.bat`, which installs packages, registers
commands on first run, and restarts the bot if it exits. `deploy-commands.bat`
forces a command re-registration.

## Bot permissions

Invite the bot with exactly these:

`Manage Channels`, `Manage Roles`, `View Channels`, `Send Messages`,
`Manage Messages`, `Embed Links`, `Attach Files`, `Read Message History`

That is permissions integer **`268561424`**.

`Manage Roles` is required — every ticket channel is private, and creating or
editing a channel permission overwrite needs it. Without it, ticket creation
fails. The bot does **not** need `Mention Everyone` and does **not** need
`Administrator`.

## Getting the server ready

### `/quick-setup` (recommended)

Builds the entire structure in one command:

```
Support Center                 visible to everyone
  ├── #create-ticket           everyone can read and use the menu, nobody can post
  └── #tickets-log             staff can read, only the bot can post

❓ Inquiries                    hidden — appears only while it holds a ticket
⚠️ Technical Issue              hidden
🕵️ Reports                      hidden
⛔ Ban Appeal                   hidden
💸 Compensation                 hidden
💰 Store                        hidden
```

It also creates a **Ticket Staff** role if you do not pass one. That role is
created with *no* guild-wide permissions — all of its access comes from channel
overwrites.

Options:

| Option | Default |
| --- | --- |
| `staff_role` | Creates/reuses `Ticket Staff` |
| `panel_channel` | Creates/reuses `#create-ticket` under `Support Center` |
| `single_category` | `false` — one category per section. Set `true` to put every section in one shared `🎫 TICKETS` category |

It is **idempotent**: roles, categories and channels are matched by name and
reused, the panel message is edited in place rather than reposted, and category
permissions are re-applied on every run. If you move the panel to a different
channel, the old panel message is deleted so members cannot use a stale menu.

### How the hidden categories work

Each section category denies `ViewChannel` to `@everyone` **and grants nothing
to the staff role**. On its own, that makes the category invisible to everyone.

When a ticket is created, the new channel carries its own overwrites allowing
the member who opened it and the section's staff roles. Discord reveals a
category to anyone who can see at least one channel inside it, so:

- **While no ticket is open**, the category is invisible to everybody.
- **When a Ban Appeal ticket opens**, `⛔ Ban Appeal` appears for staff, showing
  `ticket-2002`. Any staff member can claim it and work it.
- **The member who opened it** sees only that category, containing only their
  own ticket.
- **When it is closed**, the channel is deleted and the category goes back to
  being invisible.

This is why the bot needs `Manage Roles`: those per-channel overwrites are the
entire mechanism.

### `/setup` (manual)

Run it in the channel where the panel should be posted. The bot opens a modal
for the main embed (title, description, colour, thumbnail, main image), then
**Add Section** for each category — section name and emoji in a modal, then a
category select menu, then a role select menu. Press **Publish Panel** when
done.

Note `/setup` points sections at categories you pick yourself, so it does not
apply the hidden-category permissions that `/quick-setup` does.

## Ticket lifecycle

1. A member picks a section in `#create-ticket` and gives a reason.
2. The bot creates `ticket-<number>` under that section's category, private to
   the member and the section's staff roles.
3. The member gets a **DM** confirming the ticket, with the reason they gave and
   a link to the channel. If their DMs are closed, the bot says so in the ticket
   instead.
4. The first message in the channel pings the staff roles and the member, then
   pins itself. It carries **Claim**, **Close & Delete**, and **Admin Panel**.
5. When a staff member clicks **Claim**, the member gets a second **DM** telling
   them their ticket is under process and who took it, and a note is posted in
   the channel.
6. **Close & Delete** writes a full archive to `#tickets-log`, DMs the member
   that the ticket was closed, and deletes the channel 10 seconds later.

One open ticket per member at a time. Ticket state lives in the channel topic
(`owner=`, `status=`, `claimedBy=`, `ticketNumber=`); panel configuration lives
in `data/tickets.json`.

## The ticket log

Because closed tickets are deleted, `#tickets-log` is the only durable record.
Each entry is an embed plus a `.txt` transcript attachment, recording:

- Section, channel name, ticket number, message count
- Who opened it, who claimed it (or "Never claimed"), who closed it — with IDs
- Opened at, closed at, and how long it stayed open
- The reason the member gave when opening it
- A full transcript of every message

Transcripts include author, timestamp and attachment URLs. Message **text**
requires the Message Content intent (below); without it every line reads
`[no text content]` and the transcript header says so.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token. Required. |
| `CLIENT_ID` | — | Application ID. Required for command registration. |
| `GUILD_ID` | empty | Register commands to one guild instantly. Empty registers globally (up to 1 hour to propagate). |
| `TICKET_REFRESH_INTERVAL_MINUTES` | `30` | Automatic maintenance sweep. Minimum 5. |
| `ENABLE_MESSAGE_CONTENT` | `false` | See below. |

### Message Content intent

Transcripts can only include message **text** if the privileged Message Content
intent is on. To enable it:

1. Developer Portal → your app → **Bot** → **Privileged Gateway Intents** →
   enable **Message Content Intent**.
2. Set `ENABLE_MESSAGE_CONTENT=true` in `.env`.

Leave both off and the bot still runs — logs just record authors, timestamps and
attachments. Requesting the intent in code without enabling it in the portal
makes login fail, which is why it is opt-in.

## Commands

| Command | Who can use it |
| --- | --- |
| `/quick-setup` | Manage Server |
| `/setup` | Manage Server |
| `/ticket-panel` | Manage Server |
| `/ticket-section-add` | Manage Server |
| `/tickets-refresh` | Manage Server |
| `/ticket-admin` | Manage Messages or Manage Channels in the ticket |
| `/ticket-close` | Ticket staff, **or** the member who opened the ticket |
| `/ticket-add`, `/ticket-remove`, `/ticket-rename` | Ticket staff |

`/ticket-close` archives and deletes, exactly like the button.

Every one of these is re-checked inside the bot. Discord's "default member
permissions" are only a default that a server admin can override per role, so
the code does not rely on them alone.

## Admin panel

The pinned ticket message has an **Admin Panel** button, and `/ticket-admin`
opens the same panel. It is ephemeral, and every action re-checks that the
clicker has `Manage Messages` or `Manage Channels` **in that channel** before
changing anything. From it staff can rename the ticket, add a staff note, move
it to another category, and add or remove members.

Note this is a ticket-staff gate, not an Administrator gate — any role you grant
those permissions on a ticket channel can use the panel there. Section staff
roles get `Manage Messages` on their own tickets by design.

## Maintenance

- A sweep runs every `TICKET_REFRESH_INTERVAL_MINUTES` (default 30). It resumes
  interrupted channel renames, refreshes pinned controls, reconciles ticket
  status, and drops references to deleted tickets.
- `/tickets-refresh` runs the same sweep on demand.
- Channel renames are rate-limited by Discord to roughly 2 per 10 minutes per
  channel, so a rename may take a few minutes to show. Renames are queued,
  retried, and survive a restart.

## Data and backups

All persistent state is `data/tickets.json` — panel config, sections, the log
channel id, the ticket counter, and pending renames. It is written atomically
(temp file + rename) and a `.bak` copy is kept, which the bot recovers from
automatically if the primary file is ever corrupt.

`data/` is gitignored. **Back it up separately.** Losing it means re-running
`/quick-setup` and losing the ticket counter.
