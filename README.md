# Enclave RP Ticket Bot

Discord ticket bot for the **Enclave RP** server. Members open a ticket from a
select-menu panel, the bot creates a private channel under the matching
category, and the responsible staff roles get access to it.

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

Builds the entire ticket structure in one command:

- Creates a **Ticket Staff** role, if you do not pass one. It is created with no
  guild-wide permissions — all of its access comes from channel overwrites.
- Creates a **🎫 TICKETS** category, locked to `@everyone` and opened to the
  staff role.
- Creates a **#tickets** channel that everyone can read but nobody can post in.
- Seeds six sections (استفسارات, مشكلة تقنية, شكوى ورقابة, مراجعة باند,
  طلب تعويض, المتجر) and publishes the panel.

Options:

| Option | Default |
| --- | --- |
| `staff_role` | Creates/reuses `Ticket Staff` |
| `panel_channel` | Creates/reuses `#tickets` |
| `separate_categories` | `false` — one shared category. Set `true` for one category per section |

It is **idempotent**: roles, categories and channels are matched by name and
reused, so running it twice will not duplicate anything.

Afterwards, add your staff to the **Ticket Staff** role. Edit the sections with
`/ticket-section-add`, or re-run `/setup` for full manual control.

### `/setup` (manual)

Run it in the channel where the panel should be posted. The bot opens a modal
for the main embed:

- Title
- Description
- Colour (hex)
- Thumbnail URL
- Main image URL

Then use **Add Section** for each ticket category. Discord modals cannot contain
role or category select menus, so each section continues with:

1. Section name and emoji (modal)
2. Ticket category (category select menu)
3. Responsible staff roles (role select menu)

When all sections are added, press **Publish Panel**.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token. Required. |
| `CLIENT_ID` | — | Application ID. Required for command registration. |
| `GUILD_ID` | empty | Register commands to one guild instantly. Empty registers globally (up to 1 hour to propagate). |
| `TICKET_REFRESH_INTERVAL_MINUTES` | `30` | Automatic maintenance sweep. Minimum 5. |
| `ENABLE_MESSAGE_CONTENT` | `false` | See below. |
| `TRANSCRIPT_SEND_TO_OWNER` | `true` | Whether transcripts are DM'd to the ticket owner as well as the claiming staff member. |

### Message Content intent

Transcripts can only include message **text** if the privileged Message Content
intent is on. To enable it:

1. Developer Portal → your app → **Bot** → **Privileged Gateway Intents** →
   enable **Message Content Intent**.
2. Set `ENABLE_MESSAGE_CONTENT=true` in `.env`.

Leave both off and the bot still runs — transcripts just record authors,
timestamps and attachments, with each line marked `[no text content]`.
Requesting the intent in code without enabling it in the portal makes login
fail, which is why it is opt-in.

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

Every one of these is re-checked inside the bot. Discord's "default member
permissions" are only a default that a server admin can override per role, so
the code does not rely on them alone.

## Ticket lifecycle

- A member picks a section, gives a reason, and the bot creates
  `ticket-<number>` under that section's category.
- The channel is private: `@everyone` is denied, the opener and the section's
  staff roles are allowed.
- The first message pings the responsible staff roles and the opener, then pins
  itself. It carries **Claim**, **Close**, and **Admin Panel** buttons.
- Closing renames the channel to `closed-<number>` and revokes the opener's
  access. Reopening restores it.
- Closed tickets expose **Transcript**, **Open**, and **Delete**.
- Ticket state lives in the channel topic (`owner=`, `status=`, `claimedBy=`,
  `ticketNumber=`); panel configuration lives in `data/tickets.json`.
- One open ticket per member at a time.

## Admin panel

The pinned ticket message has an **Admin Panel** button, and `/ticket-admin`
opens the same panel. It is ephemeral, and every action re-checks that the
clicker has `Manage Messages` or `Manage Channels` **in that channel** before
changing anything.

Note this is a ticket-staff gate, not an Administrator gate — any role you grant
those permissions on a ticket channel can use the panel there. Section staff
roles get `Manage Messages` on their own tickets by design.

## Maintenance

- A sweep runs every `TICKET_REFRESH_INTERVAL_MINUTES` (default 30). It resumes
  interrupted channel renames, refreshes pinned controls, reconciles ticket
  status, and drops references to deleted tickets.
- `/tickets-refresh` runs the same sweep on demand.
- Channel renames are rate-limited by Discord to roughly 2 per 10 minutes per
  channel, so a close or reopen may take a few minutes to show the new name.
  The rename is queued and retried, and survives a restart.

## Data and backups

All persistent state is `data/tickets.json` — panel config, sections, the ticket
counter, and pending renames. It is written atomically (temp file + rename) and
a `.bak` copy is kept, which the bot recovers from automatically if the primary
file is ever corrupt.

`data/` is gitignored. **Back it up separately.** Losing it means re-running
`/quick-setup` and losing the ticket counter.
