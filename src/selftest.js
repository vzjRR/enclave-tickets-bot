require('dotenv').config();

// Drives the real bot code against the guild named by GUILD_ID in .env:
// provisions the server, checks every permission rule, opens a ticket, claims
// and closes it, and verifies the archive and the deletion. It cleans up after
// itself.
//
// It creates and destroys real channels and DMs the guild owner, so point it at
// a throwaway test server. Never run it against a live community.

const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const bot = require('./index.js');

const {
  client,
  provisionGuild,
  createTicket,
  closeAndArchiveTicket,
  getTicketOwnerId,
  getTicketNumber,
  trySetTicketTopicValue,
  getGuildConfig,
  TICKET_DELETE_DELAY_MS,
  SUPPORT_CATEGORY_NAME,
  LOG_CHANNEL_NAME,
  DEFAULT_SECTIONS
} = bot;

const GUILD_ID = process.env.GUILD_ID;

let passed = 0;
let failed = 0;
const failures = [];
const cleanup = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`);
    failed += 1;
    failures.push(name + (detail ? ' -- ' + detail : ''));
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 45_000, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(intervalMs);
  }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

function canSee(channel, id) {
  const overwrite = channel.permissionOverwrites.cache.get(id);
  return Boolean(overwrite && overwrite.allow.has(PermissionFlagsBits.ViewChannel));
}

function deniedForEveryone(channel, guild) {
  const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  return Boolean(overwrite && overwrite.deny.has(PermissionFlagsBits.ViewChannel));
}

async function run() {
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.channels.fetch();
  await guild.roles.fetch();

  console.log(`Guild: ${guild.name} (${guild.id})`);
  const owner = await client.users.fetch(guild.ownerId);
  console.log(`Ticket owner for this run: ${owner.username} (${owner.id})`);

  // -------------------------------------------------------------------------
  section('1. Provisioning');
  const result = await provisionGuild(guild, {});
  await guild.channels.fetch();

  check('provisioned a staff role', Boolean(result.staffRole?.id));
  check('created Support Center', result.supportCategory?.name === SUPPORT_CATEGORY_NAME);
  check('created the panel channel', Boolean(result.panelChannel?.id));
  check('created the log channel', result.logChannel?.name === LOG_CHANNEL_NAME);
  check('panel and log sit under Support Center',
    result.panelChannel.parentId === result.supportCategory.id &&
    result.logChannel.parentId === result.supportCategory.id);
  check(`${DEFAULT_SECTIONS.length} categories seeded`,
    result.sections.length === DEFAULT_SECTIONS.length, `got ${result.sections.length}`);
  check('every section id is unique',
    new Set(result.sections.map((s) => s.id)).size === result.sections.length);

  const saved = getGuildConfig(guild.id);
  check('panel persisted', Boolean(saved.channelId && saved.messageId));
  check('log channel persisted', saved.logChannelId === result.logChannel.id);

  // -------------------------------------------------------------------------
  section('2. Visibility rules');
  const staffRoleId = result.staffRole.id;

  const ticketCategory = await guild.channels.fetch(result.sections[0].categoryId);
  check('ticket category denies @everyone', deniedForEveryone(ticketCategory, guild));
  check('ticket category grants staff NOTHING (invisible while empty)',
    !canSee(ticketCategory, staffRoleId));

  check('log channel denies @everyone', deniedForEveryone(result.logChannel, guild));
  check('log channel is readable by staff', canSee(result.logChannel, staffRoleId));

  const everyonePanel = result.panelChannel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  check('panel is visible to everyone',
    Boolean(everyonePanel?.allow.has(PermissionFlagsBits.ViewChannel)));
  check('panel is read-only for everyone',
    Boolean(everyonePanel?.deny.has(PermissionFlagsBits.SendMessages)));

  // -------------------------------------------------------------------------
  section('3. Ticket lifecycle: create -> claim -> close -> archived and deleted');
  const target = result.sections.find((s) => s.name === 'Store') || result.sections[0];
  const ticket = await createTicket({
    guild,
    user: owner,
    section: target,
    reason: 'Self-test ticket. Safe to ignore.',
    config: getGuildConfig(guild.id)
  });

  check('ticket channel created', Boolean(ticket?.channel?.id));
  const channel = ticket.channel;
  cleanup.push(channel);

  check('named ticket-<number>', /^ticket-\d+$/.test(channel.name), channel.name);
  check('placed under its category', channel.parentId === target.categoryId);
  check('topic records the owner', getTicketOwnerId(channel) === owner.id);
  check('topic records the ticket number',
    getTicketNumber(channel) === String(ticket.ticketNumber));
  check('opener can see the channel', canSee(channel, owner.id));
  check('staff role can see the channel', canSee(channel, staffRoleId));
  check('@everyone denied on the channel', deniedForEveryone(channel, guild));

  check('control message id recorded', Boolean(bot.getTicketControlMessageId(channel)));
  const control = await bot.findTicketControlMessage(channel);
  check('control message is resolvable', Boolean(control));
  check('control message carries the Claim button',
    Boolean(control?.components?.[0]?.components?.some((c) => c.customId === 'ticket:claim')));
  check('controls can be rebuilt without pins',
    Boolean(await bot.updatePinnedTicketControls(channel, 'open', null)));

  await trySetTicketTopicValue(channel, 'claimedBy', client.user.id);
  const claimed = await guild.channels.fetch(channel.id, { force: true });
  check('claim is recorded in the topic',
    bot.getTicketClaimedBy(claimed) === client.user.id);

  const logChannel = await guild.channels.fetch(result.logChannel.id);
  const before = (await logChannel.messages.fetch({ limit: 20 })).size;
  const ticketNumber = ticket.ticketNumber;

  await closeAndArchiveTicket(claimed, client.user.id);

  const after = await logChannel.messages.fetch({ limit: 20 });
  check('an archive was written to the log', after.size > before, `${before} -> ${after.size}`);

  const archive = after.find((m) =>
    m.embeds[0]?.fields?.some((f) => f.name === 'Ticket' && f.value === `#${ticketNumber}`));
  check('archive names the right ticket', Boolean(archive));
  check('archive carries a transcript attachment', Boolean(archive && archive.attachments.size > 0));

  if (archive) {
    const e = archive.embeds[0];
    const fields = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
    check('card title is "Ticket Closed"', e.title === 'Ticket Closed', e.title);
    check('card author is the server', e.author?.name === guild.name, e.author?.name);
    check('card has a thumbnail', Boolean(e.thumbnail?.url));
    check('card records who opened it', (fields['Opened By'] || '').includes(owner.id));
    check('card records who claimed it', (fields['Claimed By'] || '').includes(client.user.id));
    check('card records who closed it', (fields['Closed By'] || '').includes(client.user.id));
    check('Open Time is a Discord timestamp', /^<t:\d+:F>$/.test(fields['Open Time'] || ''));
    check('Close Time is a Discord timestamp', /^<t:\d+:F>$/.test(fields['Close Time'] || ''));
    check('archive records the category', fields.Section === target.name);
    check('archive records how long it was open', Boolean(fields['Open For']));

    const order = e.fields.slice(0, 5).map((f) => f.name).join(',');
    check('first five fields match the reference layout',
      order === 'Opened By,Claimed By,Closed By,Open Time,Close Time', order);
    check('first three fields are inline (3-up row)',
      e.fields.slice(0, 3).every((f) => f.inline === true));
  }

  const unclaimed = bot.buildClosedTicketCard({
    guild, ownerId: owner.id, claimedBy: null, closedById: client.user.id,
    openedAt: Date.now() - 60_000, closedAt: Date.now()
  }).toJSON();
  check('unclaimed ticket shows "No one"',
    unclaimed.fields.find((f) => f.name === 'Claimed By')?.value === 'No one');

  const staffRow = await bot.buildClosedTicketLink(guild, owner.id, archive);
  check('a viewer of the log gets "View Ticket"',
    staffRow?.toJSON()?.components?.[0]?.label === 'View Ticket');
  const outsiderRow = await bot.buildClosedTicketLink(guild, '000000000000000001', archive);
  check('someone who cannot see the log gets the panel link instead',
    outsiderRow?.toJSON()?.components?.[0]?.label === 'Open a New Ticket');

  console.log(`        waiting ${TICKET_DELETE_DELAY_MS / 1000}s for the scheduled deletion...`);
  check('ticket channel was deleted on close',
    await waitFor('channel deletion', async () => {
      const still = await guild.channels.fetch(channel.id).catch(() => null);
      return still === null;
    }, TICKET_DELETE_DELAY_MS + 20_000, 2_000));

  check('a closed ticket no longer blocks a new one',
    await bot.findExistingMemberTicket(guild, owner.id, getGuildConfig(guild.id)) === null);

  // -------------------------------------------------------------------------
  // Mirrors deploying onto an established server: the panel channel, log
  // channel and staff role already exist, and the categories must land above a
  // specific anchor. This is the path that runs against production.
  section('4. Adopting existing channels');

  const anchor = await guild.channels.create({ name: 'ZZ-ANCHOR-TEST', type: ChannelType.GuildCategory });
  cleanup.push(anchor);
  const existingPanel = await guild.channels.create({ name: 'adopt-panel-test', type: ChannelType.GuildText });
  cleanup.push(existingPanel);
  const existingLog = await guild.channels.create({ name: 'adopt-log-test', type: ChannelType.GuildText });
  cleanup.push(existingLog);

  // A pre-existing overwrite that must survive adoption untouched.
  await existingPanel.permissionOverwrites.edit(guild.roles.everyone.id, { AddReactions: false });

  const deploy = await provisionGuild(guild, {
    staffRole: result.staffRole,
    panelChannel: existingPanel,
    logChannel: existingLog,
    anchorCategoryId: anchor.id
  });

  check('adopted the provided panel channel', deploy.panelChannel?.id === existingPanel.id);
  check('adopted the provided log channel', deploy.logChannel?.id === existingLog.id);
  check('config points at the adopted log channel',
    getGuildConfig(guild.id).logChannelId === existingLog.id);
  check('no redundant Support Center when both channels are adopted',
    deploy.supportCategory === null, deploy.supportCategory?.name);

  const adopted = await existingPanel.messages.fetch({ limit: 5 });
  check('panel published into the adopted channel',
    adopted.some((m) => m.embeds[0]?.title?.includes(bot.BRAND_FOOTER.split(' | ')[0])));

  const freshPanel = await guild.channels.fetch(existingPanel.id, { force: true });
  check('pre-existing overwrite survived adoption',
    Boolean(freshPanel.permissionOverwrites.cache
      .get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.AddReactions)));
  check('bot was granted access to the adopted channel',
    Boolean(freshPanel.permissionOverwrites.cache
      .get(client.user.id)?.allow.has(PermissionFlagsBits.ViewChannel)));

  await guild.channels.fetch();
  const anchorFresh = guild.channels.cache.get(anchor.id);
  check('positioning reported success', deploy.positioned?.ok === true, deploy.positioned?.reason);
  check('every ticket category sits above the anchor',
    [...new Set(deploy.sections.map((s) => s.categoryId))]
      .every((id) => guild.channels.cache.get(id).rawPosition < anchorFresh.rawPosition));

  // -------------------------------------------------------------------------
  section('5. Restore, branding and notifications');
  const restored = await provisionGuild(guild, { staffRole: result.staffRole });
  check('panel restored to its own channel', Boolean(restored.panelChannel && restored.config.messageId));
  check('log restored to #tickets-log', restored.logChannel.name === LOG_CHANNEL_NAME);

  const modal = bot.createReasonModal('test').toJSON();
  check('reason modal asks "Write your concern:"',
    modal.components[0].components[0].label === 'Write your concern:',
    modal.components[0].components[0].label);

  check('footer reads "Enclave Tickets | Discord Manager"',
    bot.BRAND_FOOTER === 'Enclave Tickets | Discord Manager', bot.BRAND_FOOTER);

  const liveConfig = getGuildConfig(guild.id);
  const livePanelChannel = await guild.channels.fetch(liveConfig.channelId);
  const panelMsg = await livePanelChannel.messages.fetch(liveConfig.messageId);
  const menu = panelMsg.components[0].components[0];

  check('panel opens the language picker',
    menu.customId === 'ticket:language', menu.customId);
  check('panel placeholder prompts for a language',
    menu.placeholder === 'Choose your language - اختر لغتك المفضلة', menu.placeholder);
  check('language picker offers English and Arabic',
    menu.options.map((o) => o.value).sort().join(',') === 'ar,en',
    menu.options.map((o) => o.value).join(','));
  check('panel carries the branded footer',
    panelMsg.embeds[0]?.footer?.text === bot.BRAND_FOOTER, panelMsg.embeds[0]?.footer?.text);
  check('panel title carries no lifecycle label',
    !/Flow/i.test(panelMsg.embeds[0]?.title || ''), panelMsg.embeds[0]?.title);

  check('member transcripts are enabled', bot.TRANSCRIPT_SEND_TO_OWNER === true);
  const sample = bot.buildTranscriptText(livePanelChannel, []);
  check('transcript builder produces a usable file body',
    sample.includes(livePanelChannel.id) && sample.length > 40);

  const staffTargets = await bot.collectStaffRecipients(guild, [result.staffRole.id], owner.id);
  if (bot.ENABLE_GUILD_MEMBERS) {
    check('staff recipients resolved from the role', Array.isArray(staffTargets));
    console.log(`        staff who would be DMed: ${staffTargets.length}`);
  } else {
    check('staff DM degrades to mention-only without the members intent',
      staffTargets.length === 0);
  }

  // -------------------------------------------------------------------------
  section('6. Bilingual panel, sanitized transcripts, and the daily cap');

  const arMenu = bot.buildCategoryMenu(restored.config, 'ar').toJSON().components[0];
  check('Arabic category menu id carries the language',
    arMenu.custom_id === 'ticket:category:ar', arMenu.custom_id);
  const storeOption = arMenu.options.find((o) =>
    restored.config.sections.find((s) => s.id === o.value)?.name === 'Store');
  check('a known default section name is translated to Arabic',
    bot.translateSectionName('Store', 'ar') === 'المتجر');
  check('Arabic category option uses the translated label',
    storeOption?.label === 'المتجر', storeOption?.label);
  check('an unmapped section name falls back to itself in Arabic',
    bot.translateSectionName('Some Custom Section', 'ar') === 'Some Custom Section');
  check('resolveLang defaults anything unrecognised to English',
    bot.resolveLang('xx') === 'en' && bot.resolveLang('ar') === 'ar');

  const memberCopy = bot.buildTranscriptText(livePanelChannel, [], { includeSystemNotes: false });
  const staffCopy = bot.buildTranscriptText(livePanelChannel, [], { includeSystemNotes: true });
  check('member transcript never carries a bot-configuration notice',
    !memberCopy.includes('Message Content intent'));
  check('staff transcript can still carry that notice when the intent is off',
    bot.ENABLE_MESSAGE_CONTENT || staffCopy.includes('Message Content intent'));

  check('Oman date key is a plain YYYY-MM-DD string',
    /^\d{4}-\d{2}-\d{2}$/.test(bot.omanDateKey()));

  // Consumed against the real test guild's own (already non-null) config,
  // under a fake user id, then cleaned back up -- never against a throwaway
  // guild id, which would leave a null entry that crashes the next
  // resumePendingRenames() sweep (it does not null-check each config).
  const rateLimitUserId = '000000000000000002';
  const attempts = [1, 2, 3, 4].map(() =>
    bot.consumeTicketRateLimit(guild.id, rateLimitUserId, bot.TICKET_DAILY_LIMIT));
  check(`daily cap allows exactly ${bot.TICKET_DAILY_LIMIT} tickets then blocks the next one`,
    attempts.slice(0, bot.TICKET_DAILY_LIMIT).every((a) => a.allowed) &&
    attempts[bot.TICKET_DAILY_LIMIT].allowed === false,
    JSON.stringify(attempts));

  require('./storage').updateGuildConfig(guild.id, (config) => {
    if (!config?.ticketRateLimits?.[rateLimitUserId]) return null;
    const ticketRateLimits = { ...config.ticketRateLimits };
    delete ticketRateLimits[rateLimitUserId];
    return { ...config, ticketRateLimits };
  });
}

async function main() {
  console.log('Enclave Tickets self-test\n');

  if (!GUILD_ID) {
    console.error('GUILD_ID is required in .env. Point it at a throwaway test server.');
    process.exit(1);
  }

  // This suite creates and destroys real channels and DMs the guild owner. On a
  // deployment whose GUILD_ID is a live community, running it by reflex would be
  // destructive, so the target has to be named a second time on purpose.
  if (process.env.SELFTEST_ALLOW_GUILD !== GUILD_ID) {
    console.error(
      'Refusing to run: this suite deletes channels and DMs the guild owner.\n' +
      `To confirm ${GUILD_ID} is a throwaway test server, re-run with:\n` +
      `  SELFTEST_ALLOW_GUILD=${GUILD_ID} npm run selftest\n` +
      'Never point it at a live community.'
    );
    process.exit(1);
  }

  try {
    await run();
  } catch (error) {
    console.error('\nSELF-TEST ABORTED:', error?.stack || error);
    failed += 1;
    failures.push('aborted: ' + (error?.message || error));
  }

  section('Cleanup');
  for (const channel of cleanup) {
    const live = await channel.guild.channels.fetch(channel.id).catch(() => null);
    if (!live) {
      console.log(`  already gone: ${channel.id}`);
      continue;
    }
    await live.delete('Enclave Tickets self-test cleanup').then(
      () => console.log(`  deleted #${live.name}`),
      (e) => console.log(`  could not delete ${live.id}: ${e?.message || e}`)
    );
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('='.repeat(50));

  await client.destroy().catch(() => {});
  process.exit(failed ? 1 : 0);
}

client.once(Events.ClientReady, () => {
  setTimeout(() => { main(); }, 2_000);
});
