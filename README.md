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

- **Streamer Application wizard.** A dedicated ticket section that walks the
  applicant through a 46-question, 7-stage form (in Arabic), then routes the
  result to a staff review channel with Approve / Reject / Request More
  Information. See [Streamer Application](#streamer-application) below.
- **Bilingual panel.** The panel embed and the language picker are shown in
  English and Arabic together; after a member picks one, the category list
  itself is re-rendered in that language.
- **A daily cap on tickets.** Non-admin members (including ticket staff
  without Administrator) can open a limited number of tickets per day,
  resetting at midnight Oman time.
- **A claim-response deadline.** A member is warned when their ticket is
  claimed that they have a limited window to reply, and the ticket closes on
  its own if they don't.
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

1. A member picks a language from the panel, then a category in that
   language, and writes their concern.
2. The bot creates `ticket-<number>`, private to them and the staff role.
3. Staff are **mentioned in the channel**, and DMed as well if
   `ENABLE_GUILD_MEMBERS` is on. The member is DMed a confirmation.
4. The pinned control message carries **Claim**, **Close & Delete** and
   **Admin Panel**.
5. On **Claim**, the member is told their ticket is being handled, by whom,
   and that they have `CLAIM_RESPONSE_TIMEOUT_HOURS` to reply before it closes
   automatically.
6. On **Close**, the archive is written to the log, the member is DMed a
   "Ticket Closed" card with their transcript attached, and the channel is
   deleted ten seconds later.

One open ticket per member, and at most `TICKET_DAILY_LIMIT` new tickets per
day for anyone without Administrator (resetting at 00:00 Oman time). Ticket
state lives in the channel topic (`owner=`, `status=`, `claimedBy=`,
`claimedAt=`, `ticketNumber=`); configuration lives in `data/tickets.json`.

### Language picker

The panel's select menu is a language choice first ("Choose your language -
اختر لغتك المفضلة"): English (🇬🇧) or العربية (🇴🇲). Picking one shows the
category list again, in that language. Only the section names /quick-setup
ships (Inquiries, Technical Issue, Reports, Ban Appeal, Compensation, Store)
have a stored Arabic label; a section added later via `/ticket-section-add`
shows the same name in both, since there is nowhere to store a translation
for a custom name. Language only affects that picker and the reason modal —
the ticket channel itself, its embeds and the transcript stay in the
section's own configured name.

### Claim-response timeout

Claiming a ticket starts a clock on the **member**, not on staff: if the
owner does not post in their own ticket within `CLAIM_RESPONSE_TIMEOUT_HOURS`
of being claimed, the ticket is closed automatically (archived exactly like
any other close). It is checked on the same cadence as the maintenance sweep
(`TICKET_REFRESH_INTERVAL_MINUTES`), so the actual close can land up to that
long after the deadline — lower the interval for tighter precision. The
clock is tracked in memory and resets on every message from the owner; a bot
restart resets it to the claim time rather than the owner's last message, the
conservative direction.

### The log, and member privacy

Discord has no way to show a member only their own entry in a shared channel, so
the log stays staff-only and **each member is DMed their own transcript** when
their ticket closes. Set `TRANSCRIPT_SEND_TO_OWNER=false` to turn that off.

Each log entry records who opened, claimed and closed the ticket with their ids,
the open and close times, how long it stayed open, the category, the message
count, the concern the member wrote, and a full `.txt` transcript.

Transcripts include authors, timestamps and attachment URLs. Message **text**
additionally requires the Message Content intent; without it every line reads
`[no text content]`. The staff copy in the log channel says so in its header
when the intent is off; the member's own copy never mentions the bot's
configuration at all — that notice, like any other operational detail, is
staff-only.

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
| `TICKET_DAILY_LIMIT` | `3` | Tickets per day for a non-admin member. Resets at 00:00 Oman time. |
| `CLAIM_RESPONSE_TIMEOUT_HOURS` | `12` | Hours the member has to reply after claim before auto-close. |
| `STREAMER_APPLICATION_CATEGORY_ID` | empty | Enables the Streamer Application section; the category its tickets are created under. |
| `STREAMER_ROLE_ID` | empty | Role granted automatically on approval. |
| `STREAMER_REVIEW_ROLE_ID` | `STAFF_ROLE_ID` | Role that can review/approve/reject applications. |
| `STREAMER_REVIEW_CHANNEL_ID` | `LOG_CHANNEL_ID` | Channel the staff application card is posted in. |

### Privileged intents

`ENABLE_GUILD_MEMBERS` and `ENABLE_MESSAGE_CONTENT` both map to privileged
gateway intents. Enable them at **Developer Portal → your app → Bot → Privileged
Gateway Intents** *before* switching them on here — requesting an intent that is
not enabled makes login fail outright. Both default to off, and the features
they gate degrade rather than break.

The bot also requests the (non-privileged, no portal toggle needed)
`GuildMessages` intent, so it can see when a claimed ticket's owner replies —
that is what the claim-response timeout watches.

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
| `npm run test:streamer-app` | Offline Streamer Application wizard test (no token needed) |
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

## Streamer Application

A guided form for a "become a streamer" application, built on top of the
ordinary ticket system rather than beside it: picking **🎥 Streamer
Application** from the panel creates a ticket exactly like any other section
(same channel naming, same permissions, same Claim/Close controls), except
the free-text "describe your concern" step is replaced by a 46-question,
7-stage wizard that runs inside the ticket. It is a self-contained module
(`src/streamerApplications.js`); index.js only hooks it in, it does not
modify any other ticket flow.

Set `STREAMER_APPLICATION_CATEGORY_ID` to enable it — with that unset, the
section is never added to the panel and none of this code path runs. The bot
adds the section to the panel automatically on every restart (and whenever
`/quick-setup` runs); no extra command is needed once the env var is set.

**The wizard.** Each of the 46 questions is answered one at a time —
free-text questions open a modal (grouped up to 5 per modal, under Discord's
field cap), yes/no questions get two buttons, and the platform question gets
a multi-select — with the bot always editing the same message rather than
spamming new ones. Four rule-agreement questions in stages 5 and 7 are
"gates": answering **لا** re-shows the question instead of advancing, since
the applicant must agree to proceed.

**Review, edit, submit.** After the last question, the applicant sees a full
review of every answer with **Submit / Edit / Cancel**. Edit opens a
stage-then-question picker so a single answer can be corrected without
retyping everything else, then returns to the review screen.

**Staff review.** Submitting posts a summary card to
`STREAMER_REVIEW_CHANNEL_ID` (or `LOG_CHANNEL_ID` if unset) with **🟢
Approve / 🔴 Reject / 🟡 Request More Information**. Every button re-checks
the clicking member server-side (Administrator, Manage Server, or
`STREAMER_REVIEW_ROLE_ID`/`STAFF_ROLE_ID`) — visibility of the button is
never the security boundary. Approve assigns `STREAMER_ROLE_ID`, DMs the
applicant, and closes the ticket through the same `closeAndArchiveTicket`
every other ticket uses. Reject asks staff for a reason (modal), DMs it to
the applicant, and closes the ticket the same way. Request More Information
posts staff's note in the ticket, DMs the applicant, and — since the
answers are preserved rather than discarded — re-opens the review screen in
the ticket so they can edit and resubmit without starting over.

**Storage.** Applications live in the same `data/tickets.json` as everything
else (via storage.js), keyed by a sequential `ENCLAVE-STR-0001`-style id —
no new database. State survives a bot restart: an in-progress wizard resumes
at its current question next time the applicant interacts with it.

**Testing it.** `npm run test:streamer-app` drives the entire wizard, review,
edit, and every staff decision through the real code with mocked Discord
objects — no token or live guild needed, and it never touches the real
`data/` (it points storage at a scratch temp directory via `TICKETS_DATA_DIR`
and cleans up after itself). It is the fastest way to catch a regression in
this module; it does not replace clicking through the flow in Discord.

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
