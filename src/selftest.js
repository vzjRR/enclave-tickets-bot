require('dotenv').config();

// Drives the real bot code against the live guild in .env: provisions both
// flows, opens a ticket in each, closes them, and asserts that each flow
// behaves the way it is supposed to. Run with `npm run selftest`.
//
// It cleans up after itself. The modern flow deletes its own ticket by design;
// classic tickets are removed explicitly at the end.

const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const bot = require('./index.js');

const {
  client,
  FLOW_NEW,
  FLOW_CLASSIC,
  flowMeta,
  sectionFlow,
  getTicketFlow,
  provisionGuild,
  createTicket,
  closeAndArchiveTicket,
  closeTicketChannel,
  reopenTicketChannel,
  getTicketOwnerId,
  getTicketNumber,
  trySetTicketTopicValue,
  getGuildConfig,
  TICKET_DELETE_DELAY_MS,
  CLASSIC_CATEGORY_NAME,
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

function canRoleSee(channel, roleId) {
  const overwrite = channel.permissionOverwrites.cache.get(roleId);
  return Boolean(overwrite && overwrite.allow.has(PermissionFlagsBits.ViewChannel));
}

function isDeniedForEveryone(channel, guild) {
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
  section('1. Provisioning both flows');
  const result = await provisionGuild(guild, {});
  await guild.channels.fetch();

  check('provisioned a staff role', Boolean(result.staffRole?.id));
  check('created Support Center', result.supportCategory?.name === SUPPORT_CATEGORY_NAME);
  check('created the modern panel channel',
    result.panelChannel?.name === flowMeta(FLOW_NEW).panelChannel,
    `got ${result.panelChannel?.name}`);
  check('created the classic panel channel',
    result.classicPanelChannel?.name === flowMeta(FLOW_CLASSIC).panelChannel,
    `got ${result.classicPanelChannel?.name}`);
  check('created the log channel', result.logChannel?.name === LOG_CHANNEL_NAME);
  check('panel channels live under Support Center',
    result.panelChannel.parentId === result.supportCategory.id &&
    result.classicPanelChannel.parentId === result.supportCategory.id);
  check('log channel lives under Support Center',
    result.logChannel.parentId === result.supportCategory.id);

  const modernSections = result.sections.filter((s) => sectionFlow(s) === FLOW_NEW);
  const classicSections = result.sections.filter((s) => sectionFlow(s) === FLOW_CLASSIC);
  check(`${DEFAULT_SECTIONS.length} modern sections`, modernSections.length === DEFAULT_SECTIONS.length,
    `got ${modernSections.length}`);
  check(`${DEFAULT_SECTIONS.length} classic sections`, classicSections.length === DEFAULT_SECTIONS.length,
    `got ${classicSections.length}`);
  check('every section id is unique',
    new Set(result.sections.map((s) => s.id)).size === result.sections.length);

  const saved = getGuildConfig(guild.id);
  check('modern panel persisted', Boolean(saved.channelId && saved.messageId));
  check('classic panel persisted', Boolean(saved.classicChannelId && saved.classicMessageId));
  check('log channel persisted', saved.logChannelId === result.logChannel.id);
  check('the two panels are different messages', saved.messageId !== saved.classicMessageId);

  // -------------------------------------------------------------------------
  section('2. Visibility rules');
  const staffRoleId = result.staffRole.id;

  const modernCategory = await guild.channels.fetch(modernSections[0].categoryId);
  check('modern category denies @everyone', isDeniedForEveryone(modernCategory, guild));
  check('modern category grants staff NOTHING (invisible while empty)',
    !canRoleSee(modernCategory, staffRoleId));

  const classicCategory = guild.channels.cache.find(
    (c) => c?.type === ChannelType.GuildCategory && c.name === CLASSIC_CATEGORY_NAME
  );
  check('classic category exists', Boolean(classicCategory));
  check('classic category denies @everyone', isDeniedForEveryone(classicCategory, guild));
  check('classic category IS visible to staff (original behaviour)',
    canRoleSee(classicCategory, staffRoleId));

  check('log channel denies @everyone', isDeniedForEveryone(result.logChannel, guild));
  check('log channel is readable by staff', canRoleSee(result.logChannel, staffRoleId));

  const everyonePanel = result.panelChannel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  check('panel channel is visible to everyone',
    Boolean(everyonePanel?.allow.has(PermissionFlagsBits.ViewChannel)));
  check('panel channel is read-only for everyone',
    Boolean(everyonePanel?.deny.has(PermissionFlagsBits.SendMessages)));

  // -------------------------------------------------------------------------
  section('3. Modern flow: create -> claim -> close -> archived and deleted');
  const modernSection = modernSections.find((s) => s.name === 'Store') || modernSections[0];
  const modern = await createTicket({
    guild,
    user: owner,
    section: modernSection,
    reason: 'Self-test: modern flow ticket. Safe to ignore.',
    config: getGuildConfig(guild.id)
  });

  check('modern ticket channel created', Boolean(modern?.channel?.id));
  const modernChannel = modern.channel;
  cleanup.push(modernChannel);

  check('named ticket-<number>', /^ticket-\d+$/.test(modernChannel.name), modernChannel.name);
  check('placed under its section category',
    modernChannel.parentId === modernSection.categoryId);
  check('topic records flow=new', getTicketFlow(modernChannel) === FLOW_NEW);
  check('topic records the owner', getTicketOwnerId(modernChannel) === owner.id);
  check('topic records the ticket number',
    getTicketNumber(modernChannel) === String(modern.ticketNumber));
  check('opener can see the channel', canRoleSee(modernChannel, owner.id));
  check('staff role can see the channel', canRoleSee(modernChannel, staffRoleId));
  check('@everyone denied on the channel', isDeniedForEveryone(modernChannel, guild));

  // Pinning needs the separate PinMessages permission and is best-effort. What
  // has to hold is that the controls stay findable, since close and refresh
  // both go looking for them.
  check('control message id recorded in the topic',
    Boolean(bot.getTicketControlMessageId(modernChannel)));
  const control = await bot.findTicketControlMessage(modernChannel);
  check('control message is resolvable', Boolean(control));
  check('control message carries the Claim button',
    Boolean(control?.components?.[0]?.components?.some((c) => c.customId === 'ticket:claim')));

  const pinnedOk = await modernChannel.messages.fetchPins()
    .then((p) => p.items.length > 0)
    .catch(() => false);
  console.log(`        (pinned: ${pinnedOk}; PinMessages missing: ` +
    `${bot.missingOptionalBotPermissions(guild).join(', ') || 'no'})`);

  const rebuilt = await bot.updatePinnedTicketControls(modernChannel, 'open', null);
  check('controls can be rebuilt without pins', Boolean(rebuilt));

  // The claim button needs a real interaction; the durable half of claiming is
  // the topic write, so that is what gets asserted here.
  await trySetTicketTopicValue(modernChannel, 'claimedBy', client.user.id);
  const claimedChannel = await guild.channels.fetch(modernChannel.id, { force: true });
  check('claim is recorded in the topic',
    bot.getTicketClaimedBy(claimedChannel) === client.user.id);

  const logChannel = await guild.channels.fetch(result.logChannel.id);
  const logBefore = (await logChannel.messages.fetch({ limit: 20 })).size;

  const modernTicketNumber = modern.ticketNumber;
  await closeAndArchiveTicket(claimedChannel, client.user.id);

  const logAfter = await logChannel.messages.fetch({ limit: 20 });
  check('an archive was written to the log channel', logAfter.size > logBefore,
    `${logBefore} -> ${logAfter.size}`);

  const archive = logAfter.find((m) =>
    m.embeds[0]?.fields?.some((f) => f.name === 'Ticket' && f.value === `#${modernTicketNumber}`));
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
    check('card renders Open Time as a Discord timestamp',
      /^<t:\d+:F>$/.test(fields['Open Time'] || ''), fields['Open Time']);
    check('card renders Close Time as a Discord timestamp',
      /^<t:\d+:F>$/.test(fields['Close Time'] || ''), fields['Close Time']);
    check('archive records the section', fields.Section === modernSection.name);
    check('archive records how long it was open', Boolean(fields['Open For']));

    const order = e.fields.slice(0, 5).map((f) => f.name).join(',');
    check('first five fields match the reference layout',
      order === 'Opened By,Claimed By,Closed By,Open Time,Close Time', order);
    check('first three fields are inline (3-up row)',
      e.fields.slice(0, 3).every((f) => f.inline === true));
  }

  // Unclaimed tickets must read "No one" rather than an empty field.
  const unclaimedCard = bot.buildClosedTicketCard({
    guild,
    ownerId: owner.id,
    claimedBy: null,
    closedById: client.user.id,
    openedAt: Date.now() - 60_000,
    closedAt: Date.now()
  }).toJSON();
  check('unclaimed ticket shows "No one"',
    unclaimedCard.fields.find((f) => f.name === 'Claimed By')?.value === 'No one');

  // The link button must point somewhere the recipient can actually open.
  const staffRow = await bot.buildClosedTicketLink(guild, owner.id, archive);
  const staffBtn = staffRow?.toJSON()?.components?.[0];
  check('a viewer of the log gets "View Ticket"', staffBtn?.label === 'View Ticket', staffBtn?.label);
  check('View Ticket links to the archived entry',
    staffBtn?.url === archive?.url, staffBtn?.url);

  const outsiderRow = await bot.buildClosedTicketLink(guild, '000000000000000001', archive);
  const outsiderBtn = outsiderRow?.toJSON()?.components?.[0];
  check('someone who cannot see the log gets the panel link instead',
    outsiderBtn?.label === 'Open a New Ticket', outsiderBtn?.label);

  console.log(`        waiting ${TICKET_DELETE_DELAY_MS / 1000}s for the scheduled deletion...`);
  const deleted = await waitFor('modern channel deletion', async () => {
    const still = await guild.channels.fetch(modernChannel.id).catch(() => null);
    return still === null;
  }, TICKET_DELETE_DELAY_MS + 20_000, 2_000);
  check('modern ticket channel was deleted on close', deleted);

  // -------------------------------------------------------------------------
  section('4. Classic flow: create -> close -> renamed and kept -> reopen');
  const classicSection = classicSections.find((s) => s.name === 'Ban Appeal') || classicSections[0];
  const classic = await createTicket({
    guild,
    user: owner,
    section: classicSection,
    reason: 'Self-test: classic flow ticket. Safe to ignore.',
    config: getGuildConfig(guild.id)
  });

  check('classic ticket channel created', Boolean(classic?.channel?.id));
  const classicChannel = classic.channel;
  cleanup.push(classicChannel);

  check('topic records flow=classic', getTicketFlow(classicChannel) === FLOW_CLASSIC);
  check('placed under the shared classic category',
    classicChannel.parentId === classicCategory.id);
  check('classic ticket number differs from the modern one',
    classic.ticketNumber !== modernTicketNumber,
    `${classic.ticketNumber} vs ${modernTicketNumber}`);

  // Checked while the classic ticket is still open: the per-flow scoping is
  // what lets one member exercise both panels at once.
  section('5. Flows are independent');
  const openClassic = await bot.findExistingMemberTicket(
    guild, owner.id, getGuildConfig(guild.id), FLOW_CLASSIC
  );
  check('the open classic ticket is found for the member', Boolean(openClassic));
  const noModern = await bot.findExistingMemberTicket(
    guild, owner.id, getGuildConfig(guild.id), FLOW_NEW
  );
  check('the closed modern ticket does not block a new one', noModern === null);

  section('6. Classic close and reopen');
  const classicNumber = classic.ticketNumber;
  await closeTicketChannel(classicChannel);

  const closedConfig = getGuildConfig(guild.id);
  check('closed id recorded in storage',
    (closedConfig.closedTicketIds || []).includes(classicChannel.id));

  const renamed = await waitFor(`rename to closed-${classicNumber}`, async () => {
    const fresh = await guild.channels.fetch(classicChannel.id, { force: true }).catch(() => null);
    return fresh?.name === `closed-${classicNumber}`;
  });
  check(`renamed to closed-${classicNumber}`, renamed);

  const afterClose = await guild.channels.fetch(classicChannel.id).catch(() => null);
  check('classic channel still EXISTS after close (not deleted)', afterClose !== null);
  if (afterClose) {
    const ownerOverwrite = afterClose.permissionOverwrites.cache.get(owner.id);
    check("opener's access was revoked",
      Boolean(ownerOverwrite?.deny.has(PermissionFlagsBits.ViewChannel)));
  }

  // This channel has now been renamed once. Discord allows roughly two renames
  // per ten minutes per channel, so the reopen rename is very likely to be
  // deferred. That is the documented weakness of the classic flow, not a
  // failure, so what gets asserted is the part that must be immediate --
  // permissions and stored state -- plus the fact that a retry was queued.
  await reopenTicketChannel(afterClose);

  const afterReopen = await guild.channels.fetch(classicChannel.id, { force: true }).catch(() => null);
  check("opener's access was restored immediately", afterReopen && canRoleSee(afterReopen, owner.id));

  const reopenedConfig = getGuildConfig(guild.id);
  check('closed id cleared from storage',
    !(reopenedConfig.closedTicketIds || []).includes(classicChannel.id));

  const pending = reopenedConfig.pendingRenames || {};
  const renamedBack = await waitFor(`rename back to ticket-${classicNumber}`, async () => {
    const fresh = await guild.channels.fetch(classicChannel.id, { force: true }).catch(() => null);
    return fresh?.name === `ticket-${classicNumber}`;
  }, 30_000);

  check('reopen either renamed back or queued a durable retry',
    renamedBack || Boolean(pending[classicChannel.id]),
    renamedBack ? '' : 'no rename applied and nothing queued');

  if (!renamedBack) {
    console.log(`        rename deferred by Discord's rate limit; queued as ` +
      `${JSON.stringify(pending[classicChannel.id])}`);
  }

  // -------------------------------------------------------------------------
  // Mirrors deploying onto an established server: the panel channel, log
  // channel and staff role already exist, and the categories have to land above
  // a specific anchor. This is the path that runs against production, so it is
  // worth exercising before it does.
  section('7. Production-style adoption of existing channels');

  const anchor = await guild.channels.create({
    name: 'ZZ-ANCHOR-TEST', type: ChannelType.GuildCategory
  });
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
    anchorCategoryId: anchor.id,
    flows: [FLOW_NEW]
  });

  check('adopted the provided panel channel', deploy.panelChannel?.id === existingPanel.id);
  check('adopted the provided log channel', deploy.logChannel?.id === existingLog.id);
  check('config points at the adopted log channel',
    getGuildConfig(guild.id).logChannelId === existingLog.id);
  check('classic flow skipped when not enabled', deploy.classicPanelChannel === null);
  check('only modern sections were created',
    deploy.sections.length === DEFAULT_SECTIONS.length &&
    deploy.sections.every((sec) => sectionFlow(sec) === FLOW_NEW));

  const adopted = await existingPanel.messages.fetch({ limit: 5 });
  check('panel published into the adopted channel',
    adopted.some((m) => m.embeds[0]?.title?.includes('Modern Flow')));

  const freshPanel = await guild.channels.fetch(existingPanel.id, { force: true });
  check('pre-existing overwrite on the adopted channel survived',
    Boolean(freshPanel.permissionOverwrites.cache
      .get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.AddReactions)));
  check('bot was granted access to the adopted channel',
    Boolean(freshPanel.permissionOverwrites.cache
      .get(client.user.id)?.allow.has(PermissionFlagsBits.ViewChannel)));

  await guild.channels.fetch();
  const anchorFresh = guild.channels.cache.get(anchor.id);
  const support = guild.channels.cache.get(deploy.supportCategory.id);
  check('positioning reported success', deploy.positioned?.ok === true, deploy.positioned?.reason);
  check('Support Center sits above the anchor',
    support.rawPosition < anchorFresh.rawPosition,
    `${support.rawPosition} vs ${anchorFresh.rawPosition}`);

  const deployCats = [...new Set(deploy.sections.map((sec) => sec.categoryId))];
  check('every ticket category sits above the anchor',
    deployCats.every((id) => guild.channels.cache.get(id).rawPosition < anchorFresh.rawPosition));

  // -------------------------------------------------------------------------
  section('8. Restore the demo server to both flows');
  const restored = await provisionGuild(guild, { staffRole: result.staffRole });
  check('both panels are back',
    Boolean(restored.panelChannel && restored.classicPanelChannel));
  check('12 sections restored', restored.sections.length === DEFAULT_SECTIONS.length * 2);
  check('log channel back to #tickets-log', restored.logChannel.name === LOG_CHANNEL_NAME);

  // Runs last, against the restored configuration, so it reads the panel that
  // is actually live rather than one section 7 moved away.
  section('9. Branding, wording, and notifications');

  const modal = bot.createReasonModal('test').toJSON();
  check('reason modal asks "Write your concern:"',
    modal.components[0].components[0].label === 'Write your concern:',
    modal.components[0].components[0].label);

  check('footer reads "Enclave Tickets | Discord Manager"',
    bot.BRAND_FOOTER === 'Enclave Tickets | Discord Manager', bot.BRAND_FOOTER);

  const logMsg = await logChannel.messages.fetch({ limit: 1 });
  check('log embed carries the branded footer',
    logMsg.first()?.embeds?.[0]?.footer?.text === bot.BRAND_FOOTER,
    logMsg.first()?.embeds?.[0]?.footer?.text);

  const liveConfig = getGuildConfig(guild.id);
  const livePanelChannel = await guild.channels.fetch(liveConfig.channelId);
  const panelMsg = await livePanelChannel.messages.fetch(liveConfig.messageId);
  check('panel carries the branded footer',
    panelMsg.embeds[0]?.footer?.text === bot.BRAND_FOOTER,
    panelMsg.embeds[0]?.footer?.text);
  check('no "Modern Flow" text left in the panel footer',
    !/Modern Flow/.test(panelMsg.embeds[0]?.footer?.text || ''));

  check('member transcripts are enabled', bot.TRANSCRIPT_SEND_TO_OWNER === true);
  const sampleTranscript = bot.buildTranscriptText(result.panelChannel, []);
  check('transcript builder produces a usable file body',
    sampleTranscript.includes(result.panelChannel.id) && sampleTranscript.length > 40);

  // With the Server Members intent off this must degrade to mention-only
  // rather than throwing or blocking ticket creation.
  const staffTargets = await bot.collectStaffRecipients(guild, [result.staffRole.id], owner.id);
  if (bot.ENABLE_GUILD_MEMBERS) {
    check('staff recipients resolved from the role', Array.isArray(staffTargets));
  } else {
    check('staff DM degrades to mention-only without the members intent',
      staffTargets.length === 0);
    const notified = await bot.notifyStaffOfNewTicket({
      guild,
      section: result.sections[0],
      channel: result.panelChannel,
      user: owner,
      reason: 'selftest',
      ticketNumber: 9999
    });
    check('notifier reports nothing sent instead of failing',
      notified.attempted === 0 && notified.delivered === 0);
  }

}

async function main() {
  console.log('Enclave Tickets self-test\n');

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
  // Let the bot's own startup work settle before touching the guild.
  setTimeout(() => { main(); }, 2_000);
});
