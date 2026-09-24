# Handover — Enclave Tickets Bot

Written for whoever (human or AI) picks this project up next, so they don't
have to reconstruct context from commit messages alone. This file describes
the system as it stands, why it's shaped the way it is, and the traps that
have already been hit once.

## What this is

A Discord ticket bot for **Enclave RP**, a GTA RP Discord community. It runs
three independent panels in one process:

1. **Support tickets** — the main system. A member picks a language, then a
   category, types their concern, and gets a private channel. Staff claim it,
   work it, close it.
2. **Streamer Application** — a guided multi-step wizard, reuses the ticket
   channel machinery but is otherwise a separate flow (`src/streamerApplications.js`).
3. **Admin Application** — the simplest one: one button, seven fixed
   questions across two modals, DMs reviewers. No ticket channel at all
   (`src/adminApplication.js`).

Everything lives in `src/index.js` (~4000 lines) except those two panels,
which are injected via an `init()` call from `index.js` rather than
`require`d directly — this avoids a circular `require` (see "Architecture"
below).

The team communicates in Arabic; expect future feature requests in Arabic
too. The owner tests live on the production Discord server and reports back
with screenshots — there is no staging environment.

## Repo layout

```
src/index.js                        Main bot: everything ticket-related
src/streamerApplications.js         Streamer Application wizard (separate panel)
src/adminApplication.js             Admin Application (separate panel)
src/storage.js                      Tiny JSON-file "database" (data/tickets.json)
src/deploy-commands.js              Registers slash commands with Discord
src/guilds.js                       Lists guilds the bot token is in
src/selftest.js                     End-to-end test against a REAL throwaway Discord server
src/streamerApplications.offlinetest.js   Offline unit test for the streamer wizard
assets/panel-*.png                  Bundled default banner images for the three panels
deploy/                             systemd unit + deployment README
.env.example                        All config, documented inline
```

`data/tickets.json` is gitignored and lives only on the server — it's the
entire "database" (guild config, ticket state, counters). **Back it up before
any destructive operation.** See "Back up `data/`" in `deploy/README.md`.

## Architecture

### Dependency injection, not `require`

`streamerApplications.js` and `adminApplication.js` never `require('./index.js')`
— that would be circular, since `index.js` requires them. Instead,
`index.js` defines everything first, then calls `streamerApplications.init({...})`
/ `adminApplication.init({...})` near the bottom, passing in the functions and
constants they need (`createTicket`, `closeAndArchiveTicket`, `dmUser`,
`client`, etc.). This works because of function-declaration hoisting. If you
add a new cross-file dependency, extend the `init()` call — don't add a
`require('./index.js')`.

### Storage

`src/storage.js` is a flat JSON file (`data/tickets.json`) shaped
`{ guilds: { [guildId]: config } }`, written atomically (temp file + rename)
with a `.bak` fallback if the main file is ever corrupt. `updateGuildConfig(guildId, mutator)`
is the read-modify-write primitive — always use it over
`getGuildConfig` + `setGuildConfig` when mutating, since two interactions
landing close together will otherwise clobber each other.

Per-guild config holds (non-exhaustive): the panel's sections/roles/category
ids, `ticketCounter`, `ticketState` (per-channel ticket data, see below),
`controlMessages` (channel id → pinned control message id), `closedTicketIds`,
`pendingRenames`, rate-limit tracking, and the streamer/admin-application
panel's own sub-config.

### Ticket state lives in storage, not the channel topic

This was **deliberately migrated away from the channel topic** earlier in
this project's life. Discord shows a channel's topic to anyone who opens it,
above the first message, with no click needed — so storing `owner=`,
`claimedBy=`, etc. there leaked raw Discord IDs to members. The topic now
only ever contains `TICKET_MARKER` plus the section name and ticket number
(see `buildTicketTopic`); everything else lives in
`config.ticketState[channelId]` in `tickets.json`.

`getTicketStateEntry(channel)` is the read primitive; `setTicketState(channel, patch)`
merges a patch into it (never clears the rest of the record — patches are
additive). A per-channel state entry currently holds: `owner`, `section`,
`ticketNumber`, `lang`, `status` (`'open'`/`'closed'`), `claimedBy`,
`claimedAt`, `info`, `closedBy`, `closedAt`, `expiresAt`, `originalCategoryId`,
`reopened`.

Functions named `trySetTicketTopicValue(s)` are a **legacy name** — despite
what they're called, they write to storage now, not the topic. Don't be
misled by the name when reading old code; it wasn't renamed everywhere to
avoid touching every call site during that migration.

A `migrateLegacyTicketTopicIfNeeded()` path still exists to upgrade any
ticket created before this migration, parsing the old-style topic once and
copying it into storage. It should be dead code on a server that's been
running the current build for a while, but don't delete it without checking
`parseLegacyTicketTopic` isn't still catching something.

## Ticket lifecycle (current, as of the last commits)

This is the part that changed the most recently and has the most moving
pieces. Read this before touching claim/close/permissions again.

### 1. Creation

`createTicket({guild, user, section, reason, config, lang, welcomeImage})` in
`index.js` is the shared entry point (used directly by the main panel, and by
the streamer wizard with its own `welcomeImage` override). It:

- Reserves a ticket number under a per-guild lock (`withGuildLock`) —
  read-increment-write without the lock would hand the same number to two
  members clicking at once.
- Creates the channel with explicit permission overwrites (see "Permission
  model" below — **staff do NOT get Send Messages here anymore**).
- Sends the pinned "welcome" message: **image only** — no title, description,
  fields, footer, or timestamp on the embed. This was an explicit, repeated
  design request; adding *anything* text-like to that embed (even a single
  field) visually reads as "quoting" the banner image sitting right above/below
  it. If a future request wants to show status info near the top of the
  ticket, send it as a **separate plain-text message**, never as a field on
  that embed. This has bitten this project twice already (see "Known traps"
  below).
- The member's typed reason is echoed as a **separate plain-text message**
  (not an embed) right after, for the same "don't look like a quote" reason.
  A section can opt out via `section.skipReasonMessage` (the streamer wizard
  does, since its real content is the wizard that follows, not a typed
  reason).

### 2. Claim-gated access (permission model)

**No one can write in a fresh ticket except the owner, until it's claimed.**
Enforced two ways, because Discord's own permission system can't fully do it
alone:

- **Channel overwrites** (the normal mechanism): at creation, the section's
  staff role(s) get `ViewChannel` + `ReadMessageHistory` + `ManageMessages`
  (the last one only so the Claim button's permission check passes) but
  **`SendMessages` is explicitly denied**. The owner gets an individual
  member-level overwrite granting `SendMessages` at creation. When someone
  claims (`ticket:claim`), they get an individual member-level overwrite
  granting `SendMessages` too. Admin Panel → Add Member (or `/ticket-add`)
  grants the same to whoever is added. That's the entire allow-list:
  **owner, claimer, admin-panel adds** — nobody else, ever, by overwrite.

- **Message-level backstop** (`Events.MessageCreate` handler,
  `isSenderAllowedInTicket`): a member with the guild-wide **Administrator**
  permission bypasses *every* channel overwrite in Discord — that's a Discord
  platform behavior, not something fixable via overwrites. This was reported
  live (a Founder/Owner-role staff member could type in an unclaimed ticket).
  The bot now checks every message in a ticket channel against who actually
  holds an individual send-access overwrite there, and deletes anything from
  someone outside that set — Administrator or not — with a short-lived
  explanatory notice. **If you ever touch the permission-overwrite logic,
  keep this backstop in sync** — it works by inspecting
  `channel.permissionOverwrites.cache`, so it automatically follows whatever
  the overwrite logic grants, but only if grants are still member-level
  overwrites with `SendMessages` allowed. Don't switch to role-level
  overwrites for exceptions without revisiting this check.

### 3. Claiming

`ticket:claim` button (there's no slash-command equivalent). Any staff member
with `ManageMessages`/`ManageChannels` can claim an unclaimed ticket (first
come, first served — the button disables once `claimedBy` is set). On claim:

- Grants the claimer `SendMessages` individually (see above).
- Starts the claim-response clock (`ticketOwnerActivity`, in-memory) — if the
  **owner** doesn't reply within `CLAIM_RESPONSE_TIMEOUT_HOURS`, the ticket
  auto-closes (checked on the maintenance sweep cadence,
  `TICKET_REFRESH_INTERVAL_MINUTES`).
- Announces the claim as a **plain-text message** (`Claimed by <@id>...`) —
  not an embed, and crucially **does not touch the pinned embed at all**. An
  earlier version added a `Claimed by` field to the pinned image-only embed,
  which rendered as a text block sitting on top of the banner — reported as
  looking like a quote. Fixed by leaving that embed alone permanently and
  relying only on the separate plain-text notice.

### 4. Admin Panel — claimer-only, claim-required

`requireAdminPanelAccess(interaction)` is the single gate for **every** Admin
Panel entry point: the `ticket:admin-panel` button, `admin:*` buttons (Name &
Info, Move Category, Add/Remove Member, Refresh), the `admin:category` /
`admin:add-user-select` / `admin:remove-user-select` select menus, the
`admin:edit-modal` submit, `/ticket-admin`, and the command equivalents
`/ticket-add`, `/ticket-remove`, `/ticket-rename`. It requires:

1. The ticket has been claimed at all, **and**
2. The caller is specifically `claimedBy` — not just any staff member, no
   admin override, no exception.

This is stricter than `canManageTicket` (which just checks
`ManageMessages`/`ManageChannels`) and deliberately so — it was an explicit
requirement, not a guess. If a future request wants staff-in-general to
retain some admin-panel capability, that's a product decision to confirm
first, not something to infer.

`canManageTicket` itself is still used for: the Claim button (obviously —
you can't require already being the claimer to claim), the Close button/command
staff gate, and as a **fallback override** in the Reopen flow (see below).

### 5. Closing

Close (`ticket:close` button or `/ticket-close`) now requires **the ticket to
already be claimed by someone** — closing an unclaimed ticket is refused.
Unlike Admin Panel, this does *not* narrow to the claimer specifically — any
staff member with `ManageMessages`/`ManageChannels` can close a claimed
ticket, same as before. (The ticket owner can no longer close their own
ticket via `/ticket-close` either — that carve-out was removed; Close is
staff-only in every form now.)

On close, `closeAndArchiveTicket(channel, closedById)`:

- Writes the full transcript + archive card to the log channel, DMs the
  owner their own copy (privacy: Discord can't show one member just their
  own entry in a shared log channel, so they get a fresh DM instead of log
  access).
- **Does not delete the channel.** Instead it moves the channel to a new
  **"Expired Tickets"** category (`ensureExpiredCategory`, hidden the same
  way ordinary ticket categories are — no staff role overwrite on the
  category itself, so it only becomes visible via each ticket channel's own
  overwrite) and updates (not clears) the ticket state: `status: 'closed'`,
  `closedBy`, `closedAt`, `expiresAt` (`now + TICKET_EXPIRE_WINDOW_MINUTES`),
  `originalCategoryId` (so a reopen can restore it).
- The pinned control message drops back to just an **Admin Panel** button
  (Claim/Close are gone). A **separate** "Ticket closed" notice is sent
  below it, carrying a **Reopen** button of its own — this was a deliberate
  placement choice: Reopen needed to appear *after* the close notice in the
  channel, not above it (it used to live on the pinned message, which sits
  at the top from ticket creation).

### 6. Reopening — one-time only

The Reopen button (`ticket:reopen`) is checked **ahead of** the general
staff gate (like Admin Panel), because permission here is specific:

- Only `closedBy` (whoever actually closed it) can reopen — **or** a
  fallback of `canManageTicket` OR `hasGuildManagerPermission` as an
  emergency override if that person is unavailable. (This fallback exists
  for Reopen specifically; Admin Panel has no such fallback — don't copy
  this pattern there without being asked.)
- Must still be within `expiresAt` (the reopen window).
- **Can only ever happen once per ticket.** A `reopened: true` flag is set
  the moment it's used and never cleared — even if the ticket is closed
  again later, no Reopen button is offered on that second close, and the
  handler itself refuses even a somehow-still-visible stale button click.
  The button is also explicitly cleared from the message it was clicked on
  (`interaction.message.edit({ components: [] })`) so it can't be
  double-clicked.
- On success: restores `status: 'open'`, moves the channel back to
  `originalCategoryId`, restores the pinned controls to the open state, and
  announces it as plain text (`Reopened by <@id>.`).

### 7. Expiry deletion

Not a `setTimeout` (wouldn't survive a restart). The periodic maintenance
sweep (`refreshTicketChannel`, called from `refreshGuildTickets` /
`runAutomaticMaintenance` on `TICKET_REFRESH_INTERVAL_MINUTES`) checks every
ticket channel: if `status === 'closed'` and `expiresAt` has passed, it calls
`deleteExpiredTicket` — clears the stored state and deletes the channel for
good. The log archive and the owner's DMed transcript were already written
at close time and are untouched by this.

### 8. Adding members

`notifyTicketMemberAdded(channel, addedUserId, addedById)` is shared by
Admin Panel → Add Member and `/ticket-add` (same underlying grant, same
notification). On add: posts a plain-text line in the channel and DMs the
added member which ticket and who added them. Logs the outcome
unconditionally (`DM delivered=true/false`) — not just on failure — because
diagnosing a "no DM arrived" report with only failure-logging turned out to
be a dead end (see "Known traps").

## Design conventions established through user feedback (don't relitigate)

These came from repeated, explicit corrections over many iterations — not
arbitrary style choices:

- **Panel and ticket-welcome embeds are image-only.** No title, description,
  fields, footer, or timestamp when a banner image is set. Any of those reads
  as the embed "quoting" the image.
- **Status announcements (claimed, closed, reopened, added) are plain
  `content:` text, never embeds.** A colored embed with just a one-line
  description, sent right after another message, reads as if it's quoting
  the message above it. This has been "fixed" three separate times across
  different notices (reason echo, claim notice, reopen notice) — if you add
  a new one, make it plain text from the start.
- Arabic requests are the norm; UI strings in the codebase are mostly
  English by convention (staff-facing operational text stays English even
  when the member-facing side is localized — see `t(lang)` / `UI_STRINGS`
  for what *is* translated: member-facing DMs and embeds, not staff
  archives/logs).

## Known traps (already hit once — don't reintroduce)

- **`showModal()` cannot be called from a `ModalSubmitInteraction`.** This is
  a real Discord API restriction, not a discord.js version gap — confirmed by
  reading `InteractionResponses.applyToClass(ModalSubmitInteraction, 'showModal')`
  in the discord.js source, which explicitly excludes it. If a form needs
  more than 5 fields (Discord's per-modal cap), split across two modals
  bridged by an intermediate button (ephemeral reply with a "Continue"
  button, not another `showModal`) — see `adminApplication.js`'s
  `pendingAnswers` Map pattern for the reference implementation.
- **Administrator bypasses channel overwrites entirely.** Don't assume a
  channel-overwrite-only permission scheme is airtight — see the
  message-level backstop above. If you add a new "staff can't do X until Y"
  rule, ask whether it needs the same backstop or whether overwrites alone
  are enough (they're enough for anything gated by a Discord *button*
  permission check like `canManageTicket`, since Discord enforces that
  server-side regardless of Administrator — it's specifically *sending a
  message* that Administrator bypasses).
- **A field scoping bug (`const ui = t(lang)` declared inside an `if`
  branch but used unconditionally later) once broke every single ticket
  creation silently.** When refactoring `createTicket` or similar
  request-handling functions, keep variables used across branches declared
  at the top of the function, not inside a conditional.
- **Diagnosing "it didn't work" reports needs unconditional logging, not
  just failure logging.** `dmUser()` only logs on failure; a run that
  succeeded and a run that never happened both look identical (silence) in
  the log. When adding a new notification path, log the outcome
  unconditionally if there's any chance of a "did this even fire" question
  later — cheap insurance against another multi-round diagnosis-by-guessing.
- **The server's git checkout is owned by the service user** (see
  `deploy/README.md`'s "Updating" section) — `git pull` as anyone else fails
  with "dubious ownership" unless you pull as that user or add a
  `safe.directory` exception.
- **`npm ci` needs a writable HOME**, which the `nologin` service user
  doesn't have — it runs as root during updates, with ownership restored
  after.

## Deployment

Production runs on a Linux server (hostname `enrp`), systemd-managed:

```
/opt/enclave-tickets          working directory, service-user-owned
enclave-tickets.service       the systemd unit (deploy/enclave-tickets.service)
```

Standard update:

```bash
cd /opt/enclave-tickets
git fetch origin
git checkout main
git pull
sudo systemctl restart enclave-tickets
sudo journalctl -u enclave-tickets -n 50 --no-pager   # confirm it came back up clean
```

`npm run deploy` (re-registers Discord slash commands) is **only** needed
when a command's name/options/description actually changes — not for
ordinary logic changes. Full details, including first-time setup and the
service-user ownership quirks, are in `deploy/README.md`.

Full config reference is in `.env.example` (every variable is documented
inline there). Two env vars added during the most recent round of work:

- `TICKET_EXPIRE_WINDOW_MINUTES` (default `60`) — the reopen window.
- (No new var for the message-level enforcement backstop or Admin Panel
  restriction — both are unconditional behavior, not configurable.)

## Testing

- `npm run check` — syntax-checks every file (`node --check`). Fast, always
  run before committing.
- `npm run selftest` (`src/selftest.js`) — drives the **real bot code**
  against a live-but-throwaway Discord guild named by `GUILD_ID` in `.env`.
  Creates and destroys real channels, DMs the guild owner. **Never point
  this at a production server.** It provisions a server, checks permission
  rules, opens/claims/closes a ticket, forces a ticket's `expiresAt` into
  the past and verifies the maintenance sweep deletes it (rather than
  waiting out the real window), and exercises the "adopt an existing
  server's channels" path.
- `npm run test:streamer-app` (`src/streamerApplications.offlinetest.js`) —
  offline unit test for the streamer wizard's state machine, no Discord
  connection needed.

There is currently no automated test specifically exercising: the
claim-gated `SendMessages` overwrites, the Administrator-bypass message
backstop, the Admin-Panel-claimer-only restriction, or the one-time-reopen
flag. These were all verified manually against production during
development. Worth adding to `selftest.js` if you're touching this area
again.

## Recent history (most recent work, newest first)

For full reasoning behind each, `git log` messages are written in detail —
read them, they're not throwaway one-liners:

1. Admin Panel restricted to claimer-only + claim-required; Close requires a
   claim first.
2. Diagnostic logging added to the add-member DM path (a false-alarm "DM
   didn't arrive" report turned out to just need a fresh test — but the
   logging gap that made it hard to diagnose is now fixed regardless).
3. Claim notice stopped mutating the pinned embed (fixed the "looks like a
   quote" report); Admin Panel → Add Member / `/ticket-add` now notify the
   added member (channel mention + DM).
4. Message-level enforcement backstop added for the Administrator-bypass
   hole; claim/reopen notices switched from embeds to plain text.
5. Reopen moved from the pinned control message to the close notice itself
   (so it appears after, not above, the close announcement); made one-time
   only.
6. `/ticket-close`'s ticket-owner exception removed — Close is staff-only in
   every form.
7. The whole claim-gated-access + close/Expired-Tickets/reopen lifecycle
   built from scratch (this was the big one — see the "Ticket lifecycle"
   section above for the end state).

Before that: image-only panel/welcome embeds, the Admin Application panel
(7 questions, two-modal split), various banner-image and reason-echo
formatting fixes, `/streamer-application-reset`, and the topic → storage
migration for ticket state (see "Architecture" above).

## Git workflow note

This project was previously developed by Claude Code sessions using a
two-branch pattern: work on `claude/project-status-oracle-deploy-beeics`,
push, fast-forward `main` to match, push. Both branches are currently in
sync at the same commit. Going forward, feel free to use whatever workflow
suits — there's nothing special about that branch name, it's not read by
any tooling or CI.
