# Deploying to a Linux server (Oracle Cloud)

These steps assume the box already runs other bots, so everything is scoped to
its own directory, user and systemd unit and touches nothing else.

## 1. Install

```bash
sudo useradd -r -s /usr/sbin/nologin discordbots 2>/dev/null || true

sudo mkdir -p /opt/enclave-tickets
sudo chown "$USER":"$USER" /opt/enclave-tickets
git clone https://github.com/vzjRR/enclave-tickets-bot.git /opt/enclave-tickets
cd /opt/enclave-tickets
npm ci --omit=dev
```

Node 18 or newer is required:

```bash
node -v
```

## 2. Configure

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Fill in `DISCORD_TOKEN` and `CLIENT_ID`, then the deployment ids for the server
you are targeting — see **Adopting an existing server** in the main README.

`.env` holds the bot token. `chmod 600` matters: anyone who can read it controls
the bot.

Three settings are worth getting right the first time:

| | |
| --- | --- |
| `GUILD_ID` | **Required if this bot token runs anywhere else.** A running bot answers every guild its application is in, so two instances on one token both reply to the same click — two tickets, two DMs. Setting this confines the instance to one guild. |
| `ENABLE_GUILD_MEMBERS` | `true` to DM staff on a new ticket. Enable **Server Members** in the Developer Portal first — setting this true while the portal toggle is off makes login fail outright. |
| `ENABLE_MESSAGE_CONTENT` | `true` to put real message text in transcripts. Same caveat: enable **Message Content** in the portal first. |

## 2b. Seed `data/tickets.json` if the server already has a panel

Skip this on a genuinely fresh server. But if the guild already has a ticket
panel posted — because a previous instance provisioned it — the new box starts
with no memory of it, and `/quick-setup` posts a **second** panel rather than
adopting the first. Copy the existing config across instead:

```bash
# from the machine that has the current data/tickets.json
scp data/tickets.json USER@SERVER:/tmp/tickets.json
```

```bash
# on the server
mkdir -p /opt/enclave-tickets/data
cp /tmp/tickets.json /opt/enclave-tickets/data/tickets.json && rm /tmp/tickets.json
```

With that in place the bot adopts the live panel on startup, and step 5 becomes
unnecessary. It also carries the ticket counter across, so numbering continues
rather than restarting.

## 3. Register the slash commands

Once, and again whenever the commands change:

```bash
npm run deploy
```

If you do not know the guild id, list what the bot can see:

```bash
npm run guilds
```

Leaving `GUILD_ID` empty registers globally, which works but can take up to an
hour to appear. Setting it registers instantly for that one guild.

## 4. Run it under systemd

```bash
sudo cp deploy/enclave-tickets.service /etc/systemd/system/
sudo chown -R discordbots:discordbots /opt/enclave-tickets

sudo systemctl daemon-reload
sudo systemctl enable --now enclave-tickets
```

Check it came up:

```bash
systemctl status enclave-tickets
journalctl -u enclave-tickets -f
```

You are looking for:

```
Logged in as TICKETS#3821
Presence set to: ENCLAVE RP TICKETS SYSTEM
Ticket refresh complete. guild=... total=0 failed=0
```

## 5. Provision the server

**Only if you skipped 2b.** In Discord, run `/quick-setup`. With the ids set in
`.env` it adopts your existing panel channel, log channel and staff role,
creates the categories it needs, and places them above the anchor category.

If you did seed `data/tickets.json`, there is nothing to run: the bot re-edits
its saved panel at startup, which also upgrades a panel posted by an older
build to the current menu. Watch for this line in the log:

```
Ticket panel resynced for guild <id>.
```

## Operating it

| | |
| --- | --- |
| Logs | `journalctl -u enclave-tickets -f` |
| Restart | `sudo systemctl restart enclave-tickets` |
| Stop | `sudo systemctl stop enclave-tickets` |
| Update | `git pull && npm ci --omit=dev && sudo systemctl restart enclave-tickets` |

A restart is safe with open tickets. The claim-response clock is rebuilt from
each channel's own history on the first sweep, so a ticket whose owner replied
shortly before the restart is not mistaken for an abandoned one.

The unit restarts the bot automatically if it exits, capped at 10 restarts in
5 minutes so a genuinely broken build does not spin forever.

## Back up `data/`

`/opt/enclave-tickets/data/tickets.json` holds the panel configuration, the
section list, the log channel id and the ticket counter. It is gitignored and
exists nowhere else. Losing it means re-running `/quick-setup` and resetting the
ticket numbering.

```bash
sudo tar czf ~/enclave-tickets-data-$(date +%F).tar.gz -C /opt/enclave-tickets data
```

Worth putting in a daily cron job.

## Running alongside other bots

Nothing here is global. The unit name, `/opt/enclave-tickets`, and the
`discordbots` user are the only footprint, so a second bot can use the same
pattern with its own directory and unit name. If your other bots already run as
a different user, reuse it and change `User=`/`Group=` in the unit file to
match — just keep `ReadWritePaths` pointing at this bot's `data/`.
