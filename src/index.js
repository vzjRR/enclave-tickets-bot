require('dotenv').config();

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} = require('discord.js');

const {
  ensureDb,
  getAllGuildConfigs,
  getGuildConfig,
  setGuildConfig,
  updateGuildConfig
} = require('./storage');

const BRAND_NAME = 'Enclave RP';
const BRAND_COLOR = 0x90773E;
const BUILD_ID = 'enclave-tickets-build-2026-08-21-v1';
const TICKET_MARKER = 'Enclave RP | Ticket';
const REFRESH_INTERVAL_MINUTES = Math.max(
  5,
  Number.parseInt(process.env.TICKET_REFRESH_INTERVAL_MINUTES || '30', 10) || 30
);

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

// Message content is a privileged intent. Requesting it before enabling it in
// the Discord Developer Portal makes login fail outright, so it stays opt-in.
// Transcripts only contain message text when this is on.
const ENABLE_MESSAGE_CONTENT = envFlag('ENABLE_MESSAGE_CONTENT', false);

// Transcripts include everything staff said inside the ticket. Set this to
// false to deliver them only to the staff member who claimed the ticket.
const TRANSCRIPT_SEND_TO_OWNER = envFlag('TRANSCRIPT_SEND_TO_OWNER', true);

const SETUP_SESSION_TTL_MS = 30 * 60_000;

const setupSessions = new Map();
const ticketCreationLocks = new Set();
const pendingChannelRenames = new Map();
const guildWriteQueues = new Map();
let maintenanceRunning = false;

const intents = [GatewayIntentBits.Guilds];
if (ENABLE_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({ intents });

// Serializes read-modify-write sequences per guild. Two members clicking the
// panel at the same moment would otherwise both read the same ticketCounter
// and create two channels with the same ticket number.
function withGuildLock(guildId, task) {
  const previous = guildWriteQueues.get(guildId) || Promise.resolve();
  const next = previous.then(task, task);
  guildWriteQueues.set(guildId, next.then(() => {}, () => {}));
  return next;
}

function pruneSetupSessions() {
  const now = Date.now();
  for (const [key, session] of setupSessions) {
    if (now - (session.createdAt || 0) > SETUP_SESSION_TTL_MS) {
      setupSessions.delete(key);
    }
  }
}

ensureDb();

function withTimeout(promise, label, timeoutMs = 8_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTicketInstanceId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureTicketInstance(config) {
  return {
    ...config,
    ticketInstanceId: config.ticketInstanceId || createTicketInstanceId(),
    closedTicketIds: Array.isArray(config.closedTicketIds) ? config.closedTicketIds : []
  };
}

function setTicketClosedState(guildId, channelId, isClosed) {
  updateGuildConfig(guildId, (config) => {
    if (!config) return null;

    const closedTicketIds = new Set(Array.isArray(config.closedTicketIds) ? config.closedTicketIds : []);
    if (isClosed) {
      closedTicketIds.add(channelId);
    } else {
      closedTicketIds.delete(channelId);
    }

    return { ...config, closedTicketIds: [...closedTicketIds] };
  });
}

function setPendingTicketRename(guildId, channelId, rename) {
  updateGuildConfig(guildId, (config) => {
    if (!config) return null;

    return {
      ...config,
      pendingRenames: {
        ...(config.pendingRenames || {}),
        [channelId]: rename
      }
    };
  });
}

function clearPendingTicketRename(guildId, channelId) {
  updateGuildConfig(guildId, (config) => {
    if (!config?.pendingRenames?.[channelId]) return null;

    const pendingRenames = { ...config.pendingRenames };
    delete pendingRenames[channelId];

    return { ...config, pendingRenames };
  });
}

function logInteractionError(error, interaction) {
  console.error('Interaction error:', {
    message: error?.message,
    stack: error?.stack,
    customId: interaction?.customId,
    commandName: interaction?.commandName,
    guildId: interaction?.guildId,
    channelId: interaction?.channelId,
    userId: interaction?.user?.id
  });
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  // State is no longer trustworthy after an uncaught throw. Exit and let
  // start-bot.bat restart the process rather than serving corrupt behaviour.
  console.error('Uncaught exception, shutting down:', error);
  process.exit(1);
});

process.on('beforeExit', (code) => {
  console.error(`Process beforeExit with code ${code}. Discord client status: ${client.ws.status}`);
});

process.on('exit', (code) => {
  console.error(`Process exit with code ${code}.`);
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

client.on(Events.Warn, (warning) => {
  console.warn('Discord client warning:', warning);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  console.error(`Discord shard disconnected. shard=${shardId} code=${event?.code} reason=${event?.reason}`);
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`Discord shard error. shard=${shardId}`, error);
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`Discord shard reconnecting. shard=${shardId}`);
});

function isHttpUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeColor(value) {
  if (!value) return BRAND_COLOR;
  const clean = value.trim().replace('#', '');
  if (!/^[\da-fA-F]{6}$/.test(clean)) return BRAND_COLOR;
  return Number.parseInt(clean, 16);
}

function cleanChannelName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'ticket';
}

function parseSectionEmoji(value) {
  const emoji = String(value || '').trim();
  if (!emoji) return null;

  const customMatch = emoji.match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (customMatch) {
    return {
      menu: {
        name: customMatch[1],
        id: customMatch[2],
        animated: emoji.startsWith('<a:')
      },
      text: emoji
    };
  }

  if (/^\d{17,20}$/.test(emoji)) {
    return {
      menu: { id: emoji, name: 'section' },
      text: `<:section:${emoji}>`
    };
  }

  if (!/\p{Extended_Pictographic}/u.test(emoji)) {
    console.warn(`Ignoring invalid section emoji value: ${emoji}`);
    return null;
  }

  return {
    menu: { name: emoji },
    text: emoji
  };
}

function buildPanelEmbed(config) {
  const embed = new EmbedBuilder()
    .setColor(config.color || BRAND_COLOR)
    .setTitle(config.title || `${BRAND_NAME} - Ticket System`)
    .setDescription(config.description || 'Select the category that matches your issue to open a ticket.')
    .setFooter({ text: `${BRAND_NAME} | Ticket System` })
    .setTimestamp();

  if (isHttpUrl(config.thumbnailUrl)) embed.setThumbnail(config.thumbnailUrl);
  if (isHttpUrl(config.imageUrl)) embed.setImage(config.imageUrl);

  return embed;
}

function buildPanelMenu(config) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:panel')
    .setPlaceholder('Select a ticket category');

  for (const section of config.sections.slice(0, 25)) {
    const sectionEmoji = parseSectionEmoji(section.emoji);
    menu.addOptions({
      label: section.name.slice(0, 100),
      value: section.id,
      emoji: sectionEmoji?.menu,
      description: `Open a ${section.name} ticket`.slice(0, 100)
    });
  }

  return new ActionRowBuilder().addComponents(menu);
}

function buildSetupControls(canPublish) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup:add-section')
        .setLabel('Add Section')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('setup:publish')
        .setLabel('Publish Panel')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canPublish),
      new ButtonBuilder()
        .setCustomId('setup:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function makeSetupSummary(session) {
  const sections = session.config.sections.length
    ? session.config.sections.map((section) => `${parseSectionEmoji(section.emoji)?.text || ''} ${section.name}`).join('\n')
    : 'No sections yet.';

  return {
    content: `Setup draft for **${BRAND_NAME}**\nTarget channel: <#${session.channelId}>\n\nSections:\n${sections}`,
    components: buildSetupControls(session.config.sections.length > 0)
  };
}

function createPanelModal() {
  return new ModalBuilder()
    .setCustomId('setup:panel-modal')
    .setTitle('Enclave RP Ticket Panel')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Embed title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(256)
          .setValue(`${BRAND_NAME} - Ticket System`)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Embed description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setValue('Welcome to support.\nPick the category that matches your issue from the menu below, then describe it in detail.')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('color')
          .setLabel('Embed color hex')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(7)
          .setValue('#ff9d00')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('thumbnailUrl')
          .setLabel('Thumbnail URL')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('imageUrl')
          .setLabel('Main image URL')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      )
    );
}

function createSectionModal() {
  return new ModalBuilder()
    .setCustomId('setup:section-modal')
    .setTitle('Add Ticket Section')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Section name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('emoji')
          .setLabel('Section emoji')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(30)
      )
    );
}

function createReasonModal(sectionId) {
  return new ModalBuilder()
    .setCustomId(`ticket:reason:${sectionId}`)
    .setTitle('Open Ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why are you opening this ticket?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      )
    );
}

function setupSessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

async function showCategorySelect(interaction, section) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('setup:section-category')
    .setPlaceholder(`Category for ${section.name}`)
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  await sendInteractionResult(interaction, {
    content: `Select the category where **${section.name}** tickets will open.`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral
  });
}

async function showRoleSelect(interaction, section) {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId('setup:section-roles')
    .setPlaceholder(`Staff roles for ${section.name}`)
    .setMinValues(1)
    .setMaxValues(10);

  await interaction.update({
    content: `Select staff roles responsible for **${section.name}**.`,
    components: [new ActionRowBuilder().addComponents(menu)]
  });
}

async function sendSetupSummary(interaction, session) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(makeSetupSummary(session));
    return;
  }

  await interaction.reply({ ...makeSetupSummary(session), flags: MessageFlags.Ephemeral });
}

async function canManageTicket(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
  const memberPermissions =
    interaction.channel.permissionsFor(member) ||
    interaction.channel.permissionsFor(interaction.user.id) ||
    interaction.memberPermissions;

  return Boolean(
    memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
    memberPermissions?.has(PermissionFlagsBits.ManageChannels)
  );
}

// setDefaultMemberPermissions is only a DEFAULT. A guild admin can re-grant any
// command to any role from Server Settings > Integrations, and that override
// sticks. Authorization has to be re-checked here for it to mean anything.
const GUILD_MANAGER_COMMANDS = new Set([
  'setup',
  'quick-setup',
  'ticket-panel',
  'ticket-section-add',
  'tickets-refresh'
]);

function hasGuildManagerPermission(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function isTicketChannel(channel) {
  return channel?.type === ChannelType.GuildText && channel.topic?.includes(TICKET_MARKER);
}

function buildAdminPanel(channel) {
  const ownerId = getTicketOwnerId(channel);
  const claimedBy = getTicketClaimedBy(channel);
  const status = getTicketStatus(channel);

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('Ticket Admin Panel')
    .setDescription('Staff only. Every action here re-checks your permissions before it runs.')
    .addFields(
      { name: 'Channel', value: `#${channel.name}`, inline: true },
      { name: 'Status', value: status === 'closed' ? 'Closed' : 'Open', inline: true },
      { name: 'Opened by', value: ownerId ? `<@${ownerId}>` : 'Unknown', inline: true },
      { name: 'Claimed by', value: claimedBy ? `<@${claimedBy}>` : 'Unclaimed', inline: true },
      { name: 'Category', value: channel.parent ? channel.parent.name : 'No category', inline: true },
      { name: 'Ticket number', value: getTicketNumber(channel) || 'Unknown', inline: true }
    )
    .setFooter({ text: `${BRAND_NAME} | Admin only` })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin:edit').setLabel('Name & Info').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin:move').setLabel('Move Category').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('admin:add-user').setLabel('Add Member').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('admin:remove-user').setLabel('Remove Member').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('admin:refresh').setLabel('Refresh Ticket').setStyle(ButtonStyle.Secondary)
      )
    ],
    flags: MessageFlags.Ephemeral
  };
}

function createTicketEditModal(channel) {
  const infoMatch = channel.topic?.match(/info=([^|]*)/);
  return new ModalBuilder()
    .setCustomId('admin:edit-modal')
    .setTitle('Edit Ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Ticket channel name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(channel.name)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('info')
          .setLabel('Short staff note')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500)
          .setValue((infoMatch?.[1] || '').trim())
      )
    );
}

function buildCategoryPicker() {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('admin:category')
      .setPlaceholder('Select the new category')
      .setChannelTypes(ChannelType.GuildCategory)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

function buildUserPicker(action) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`admin:${action}-user-select`)
      .setPlaceholder(action === 'add' ? 'Select a member to add' : 'Select a member to remove')
      .setMinValues(1)
      .setMaxValues(1)
  );
}

async function setTicketInfo(channel, info) {
  const cleanInfo = String(info || '').replace(/[|\r\n]+/g, ' ').trim().slice(0, 500);
  const withoutOldInfo = (channel.topic || TICKET_MARKER)
    .replace(/\s*\|\s*info=[^|]*/g, '')
    .trim();
  const nextTopic = cleanInfo ? `${withoutOldInfo} | info=${cleanInfo}` : withoutOldInfo;
  await withTimeout(channel.setTopic(nextTopic.slice(0, 1024)), `Update ticket info for ${channel.id}`);
}

function buildTicketControls(status = 'open', claimedBy = null) {
  const isClosed = status === 'closed';

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:claim')
        .setLabel(claimedBy ? 'Claimed' : 'Claim')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(Boolean(claimedBy) || isClosed),
      new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId('ticket:admin-panel')
        .setLabel('Admin Panel')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildTicketBusyControls(label) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:busy')
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    )
  ];
}

function buildClosedTicketEmbeds(closedById) {
  return [
    new EmbedBuilder()
      .setColor(0xffff00)
      .setDescription(`Ticket Closed by <@${closedById}>`),
    new EmbedBuilder()
      .setColor(0x2f3136)
      .setDescription('```Support team ticket controls```')
  ];
}

function buildClosedTicketSummaryEmbed(closedById) {
  return new EmbedBuilder()
    .setColor(0xffff00)
    .setDescription(`Ticket Closed by <@${closedById}>`);
}

function buildOpenedTicketEmbed(openedById) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setDescription(`Ticket Opened by <@${openedById}>`);
}

function buildClosedTicketControls(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:transcript')
        .setLabel('Transcript')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ticket:reopen')
        .setLabel('Open')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ticket:delete')
        .setLabel('Delete')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    )
  ];
}

function messageHasButton(message, customId) {
  return message.components.some((row) =>
    row.components.some((component) => component.customId === customId)
  );
}

async function updatePinnedTicketControls(channel, status, claimedBy = null) {
  const pinnedMessages = await withTimeout(
    channel.messages.fetchPins(),
    `Fetch pinned ticket controls for ${channel.id}`
  );
  const ticketMessage = pinnedMessages.items.map((pin) => pin.message).find((message) =>
    message.author.id === client.user.id &&
    messageHasButton(message, 'ticket:claim') &&
    messageHasButton(message, 'ticket:close')
  );

  if (!ticketMessage) return null;

  await withTimeout(
    ticketMessage.edit({
      components: buildTicketControls(status, claimedBy)
    }),
    `Update pinned ticket controls for ${channel.id}`
  );

  return ticketMessage;
}

async function tryUpdatePinnedTicketControls(channel, status, claimedBy = null) {
  try {
    return await updatePinnedTicketControls(channel, status, claimedBy);
  } catch (error) {
    console.error(`Failed to update pinned ticket controls for ${channel.id}:`, error);
    return null;
  }
}

async function refreshTicketChannel(channel) {
  const status = getTicketStatus(channel) === 'closed' || channel.name.startsWith('closed-')
    ? 'closed'
    : 'open';
  const claimedBy = getTicketClaimedBy(channel);
  const controlMessage = await tryUpdatePinnedTicketControls(channel, status, claimedBy);
  await trySetTicketTopicValue(channel, 'status', status);
  return { channelId: channel.id, controlsUpdated: Boolean(controlMessage), status };
}

async function refreshGuildTickets(guild, source = 'manual') {
  const channels = await withTimeout(guild.channels.fetch(), `Fetch channels for ${guild.id}`, 15_000);
  const tickets = [...channels.values()].filter(isTicketChannel);
  const results = [];

  // Small batches avoid Discord rate-limit spikes on servers with many tickets.
  for (let index = 0; index < tickets.length; index += 3) {
    const batch = tickets.slice(index, index + 3);
    const settled = await Promise.allSettled(batch.map((channel) => refreshTicketChannel(channel)));
    results.push(...settled);
    if (index + 3 < tickets.length) await sleep(750);
  }

  const config = getGuildConfig(guild.id);
  if (config) {
    const existingIds = new Set(tickets.map((channel) => channel.id));
    setGuildConfig(guild.id, {
      ...config,
      closedTicketIds: (config.closedTicketIds || []).filter((id) => existingIds.has(id)),
      lastRefreshAt: new Date().toISOString()
    });
  }

  const failed = results.filter((result) => result.status === 'rejected').length;
  console.log(`Ticket refresh complete. guild=${guild.id} source=${source} total=${tickets.length} failed=${failed}`);
  return { total: tickets.length, updated: tickets.length - failed, failed };
}

async function runAutomaticMaintenance() {
  if (maintenanceRunning || !client.isReady()) return;
  maintenanceRunning = true;
  try {
    // Expire stale sessions instead of wiping them: a blanket clear cancels a
    // setup someone is in the middle of. Creation locks release in a finally
    // block, so clearing those here only risks admitting a duplicate ticket.
    pruneSetupSessions();
    await resumePendingRenames();
    for (const guild of client.guilds.cache.values()) {
      await refreshGuildTickets(guild, 'automatic').catch((error) => {
        console.error(`Automatic ticket refresh failed for guild ${guild.id}:`, error);
      });
    }
  } finally {
    maintenanceRunning = false;
  }
}

function getTicketOwnerId(channel) {
  const match = channel?.topic?.match(/owner=(\d{17,20})(?![\d])/);
  return match?.[1] || null;
}

function getTicketStatus(channel) {
  const match = channel?.topic?.match(/status=([a-z]+)/);
  return match?.[1] || 'open';
}

function getTicketClaimedBy(channel) {
  const match = channel?.topic?.match(/claimedBy=(\d{17,20})(?![\d])/);
  return match?.[1] || null;
}

function getTicketNumber(channel) {
  const topicMatch = channel?.topic?.match(/ticketNumber=(\d+)/);
  if (topicMatch) return topicMatch[1];

  const nameMatch = channel?.name?.match(/(?:ticket|closed)-(?:ticket-)?(\d+)$/);
  return nameMatch?.[1] || null;
}

function getOpenTicketName(channel) {
  const ticketNumber = getTicketNumber(channel);
  return ticketNumber ? `ticket-${ticketNumber}` : channel.name.replace(/^closed-/, '');
}

function getClosedTicketName(channel) {
  const ticketNumber = getTicketNumber(channel);
  if (ticketNumber) return `closed-${ticketNumber}`;

  const openName = getOpenTicketName(channel);
  return openName.startsWith('closed-') ? openName : `closed-${openName}`.slice(0, 100);
}

function getReopenTicketName(channel) {
  return getOpenTicketName(channel);
}

async function setTicketTopicValue(channel, key, value) {
  const topic = channel.topic || TICKET_MARKER;
  const pair = `${key}=${value}`;
  const nextTopic = topic.includes(`${key}=`)
    ? topic.replace(new RegExp(`${key}=[^|]+`), pair)
    : `${topic} | ${pair}`;

  await channel.setTopic(nextTopic.slice(0, 1024));
}

async function trySetTicketTopicValue(channel, key, value) {
  try {
    await withTimeout(
      setTicketTopicValue(channel, key, value),
      `Set ticket topic ${key} for ${channel.id}`,
      4_000
    );
    return true;
  } catch (error) {
    console.error(`Failed to set ticket topic ${key}=${value} for ${channel.id}:`, error);
    return false;
  }
}

async function editPermissionOverwrite(channel, targetId, overwrite, label) {
  return withTimeout(
    channel.permissionOverwrites.edit(targetId, overwrite),
    label,
    8_000
  );
}

async function deletePermissionOverwrite(channel, targetId, label) {
  return withTimeout(
    channel.permissionOverwrites.delete(targetId),
    label,
    8_000
  );
}

function updateTicketEmbed(interaction, updater) {
  const embed = EmbedBuilder.from(interaction.message.embeds[0]);
  updater(embed);
  return embed;
}

async function sendInteractionResult(interaction, payload) {
  if (interaction.deferred) {
    await interaction.editReply(payload);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

async function fetchFreshTicketChannel(interaction) {
  return interaction.guild.channels.fetch(interaction.channelId, { force: true });
}

async function fetchTranscriptMessages(channel, limit = 1000) {
  const collected = [];
  let before;

  while (collected.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, limit - collected.length),
      before
    });

    if (!batch.size) break;

    collected.push(...batch.values());
    before = batch.last().id;
  }

  return collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildTranscriptText(channel, messages) {
  const lines = [
    `Transcript for #${channel.name}`,
    `Channel ID: ${channel.id}`,
    `Generated At: ${new Date().toISOString()}`
  ];

  if (!ENABLE_MESSAGE_CONTENT) {
    lines.push(
      'NOTE: message text is unavailable because the Message Content intent is off.',
      'Enable it in the Discord Developer Portal and set ENABLE_MESSAGE_CONTENT=true.'
    );
  }

  lines.push(''.padEnd(60, '-'));

  for (const message of messages) {
    const timestamp = new Date(message.createdTimestamp).toISOString();
    const author = `${message.author?.tag || 'Unknown'} (${message.author?.id || 'unknown'})`;
    const content = message.content?.trim() || '[no text content]';
    const attachments = message.attachments.size
      ? ` Attachments: ${message.attachments.map((item) => item.url).join(', ')}`
      : '';

    lines.push(`[${timestamp}] ${author}: ${content}${attachments}`);
  }

  return lines.join('\n');
}

async function sendTicketTranscript(channel) {
  const ownerId = getTicketOwnerId(channel);
  const claimedBy = getTicketClaimedBy(channel);
  const messages = await fetchTranscriptMessages(channel);
  const transcript = buildTranscriptText(channel, messages);
  const fileName = `${channel.name}-transcript.txt`;
  const recipients = [...new Set(
    (TRANSCRIPT_SEND_TO_OWNER ? [ownerId, claimedBy] : [claimedBy]).filter(Boolean)
  )];
  const delivered = [];
  const failed = [];

  for (const userId of recipients) {
    try {
      const user = await client.users.fetch(userId);
      const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fileName });
      await user.send({
        content: `Transcript for ${channel.name}`,
        files: [attachment]
      });
      delivered.push(`<@${userId}>`);
    } catch (error) {
      console.error(`Failed to DM transcript to ${userId}:`, error);
      failed.push(`<@${userId}>`);
    }
  }

  return { delivered, failed, totalMessages: messages.length };
}

// Renames go through discord.js so they share its global rate-limit bucket.
// Channel renames are capped at 2 per 10 minutes per channel and the retry loop
// below can queue many of them; a hand-rolled fetch bypasses the library's
// accounting and earns 429s (and eventually a token ban) instead of queuing.
// It also kept a second copy of the raw bot token in the codebase.
async function patchChannelName(channel, nextName, action) {
  try {
    await withTimeout(
      channel.setName(nextName, `Ticket ${action}`),
      `Rename ticket channel ${channel.id}`,
      20_000
    );
    return { ok: true };
  } catch (error) {
    const timedOut = /timed out after/.test(error?.message || '');
    const retryAfterMs = Number.isFinite(error?.retryAfter)
      ? Math.ceil(error.retryAfter * 1000)
      : timedOut ? 30_000 : 10_000;

    console.error(
      `Ticket ${action} rename failed: ${channel.id} -> ${nextName}; status=${error?.status ?? 'n/a'}`,
      error?.message || error
    );

    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'rest_error',
      retryAfterMs,
      status: error?.status,
      error
    };
  }
}

async function renameTicketChannel(channel, nextName, action) {
  const oldName = channel.name;

  const result = await patchChannelName(channel, nextName, action);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      oldName,
      nextName: oldName,
      expectedName: nextName,
      retryAfterMs: result.retryAfterMs,
      error: result.error,
      status: result.status
    };
  }

  await sleep(1_000);
  const updatedChannel = await withTimeout(
    channel.guild.channels.fetch(channel.id, { force: true }),
    `Fetch renamed ticket channel ${channel.id}`,
    4_000
  );
  const actualName = updatedChannel?.name || channel.name;

  if (actualName !== nextName) {
    console.error(`Ticket ${action} rename mismatch: expected ${nextName}, actual ${actualName}`);
    return { ok: false, reason: 'mismatch', oldName, nextName: actualName, expectedName: nextName };
  }

  return { ok: true, oldName, nextName: actualName, expectedName: nextName, channel: updatedChannel };
}

function scheduleTicketRename(channel, nextName, action) {
  const key = channel.id;
  const existing = pendingChannelRenames.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const state = {
    channelId: channel.id,
    guildId: channel.guild.id,
    nextName,
    action,
    attempts: 0,
    retryAfterMs: null,
    timer: null
  };

  pendingChannelRenames.set(key, state);
  setPendingTicketRename(channel.guild.id, channel.id, {
    nextName,
    action,
    retryAt: Date.now(),
    attempts: 0
  });

  const run = async () => {
    const current = pendingChannelRenames.get(key);
    if (current !== state) return;

    state.attempts += 1;

    try {
      const freshChannel = await channel.guild.channels.fetch(channel.id, { force: true });
      if (!freshChannel) {
        if (pendingChannelRenames.get(key) === state) {
          pendingChannelRenames.delete(key);
          clearPendingTicketRename(channel.guild.id, channel.id);
        }
        return;
      }

      console.log(`Ticket ${action} rename attempt ${state.attempts}: ${channel.id} #${freshChannel.name} -> #${nextName}`);

      if (freshChannel.name === nextName) {
        if (pendingChannelRenames.get(key) === state) {
          pendingChannelRenames.delete(key);
          clearPendingTicketRename(channel.guild.id, channel.id);
        }
        console.log(`Ticket ${action} rename already applied: ${channel.id} #${nextName}`);
        return;
      }

      const rename = await renameTicketChannel(freshChannel, nextName, action);
      if (pendingChannelRenames.get(key) !== state) {
        return;
      }

      if (rename.ok) {
        pendingChannelRenames.delete(key);
        clearPendingTicketRename(channel.guild.id, channel.id);
        console.log(`Ticket ${action} rename applied: ${channel.id} ${rename.oldName} -> ${rename.nextName}`);
        return;
      }

      if (rename.retryAfterMs) {
        state.retryAfterMs = rename.retryAfterMs;
      }
    } catch (error) {
      console.error(`Ticket ${action} rename retry failed: ${channel.id} -> ${nextName}`, error);
    }

    const latest = pendingChannelRenames.get(key);
    if (latest !== state) return;

    if (state.attempts >= 60) {
      pendingChannelRenames.delete(key);
      clearPendingTicketRename(channel.guild.id, channel.id);
      console.error(`Ticket ${action} rename gave up after ${state.attempts} attempts: ${channel.id} -> ${nextName}`);
      return;
    }

    const retryDelay = Math.max(5_000, Math.min(state.retryAfterMs || 10_000, 10 * 60_000));
    setPendingTicketRename(channel.guild.id, channel.id, {
      nextName,
      action,
      retryAt: Date.now() + retryDelay,
      attempts: state.attempts
    });
    console.log(`Ticket ${action} rename queued retry in ${retryDelay}ms: ${channel.id} -> ${nextName}`);
    state.timer = setTimeout(run, retryDelay);
  };

  run();
}

async function resumePendingRenames() {
  const guildConfigs = getAllGuildConfigs();

  for (const [guildId, config] of Object.entries(guildConfigs)) {
    const pendingRenames = config.pendingRenames || {};
    for (const [channelId, rename] of Object.entries(pendingRenames)) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          clearPendingTicketRename(guildId, channelId);
          continue;
        }

        const delay = Math.max(0, Number(rename.retryAt || 0) - Date.now());
        console.log(`Resuming pending ticket rename in ${delay}ms: ${channelId} -> ${rename.nextName}`);
        setTimeout(() => {
          scheduleTicketRename(channel, rename.nextName, rename.action || 'resume');
        }, delay);
      } catch (error) {
        console.error(`Failed to resume pending ticket rename ${channelId}:`, error);
      }
    }
  }
}

async function closeTicketChannel(channel) {
  const ownerId = getTicketOwnerId(channel);
  const nextName = getClosedTicketName(channel);

  setTicketClosedState(channel.guild.id, channel.id, true);
  scheduleTicketRename(channel, nextName, 'close');

  if (ownerId) {
    try {
      await editPermissionOverwrite(
        channel,
        ownerId,
        {
          ViewChannel: false,
          SendMessages: false,
          AttachFiles: false,
          ReadMessageHistory: false
        },
        `Close ticket owner permissions for ${channel.id}`
      );
    } catch (error) {
      console.error(`Failed to close ticket owner permissions for ${channel.id}:`, error);
    }
  }

  console.log(`Ticket channel closed: ${channel.id} #${channel.name}; rename scheduled to #${nextName}`);
  return { ok: true, oldName: channel.name, nextName, expectedName: nextName, channel, renameOk: null };
}

async function reopenTicketChannel(channel) {
  const ownerId = getTicketOwnerId(channel);
  const nextName = getReopenTicketName(channel);

  setTicketClosedState(channel.guild.id, channel.id, false);

  if (ownerId) {
    try {
      await editPermissionOverwrite(
        channel,
        ownerId,
        {
          ViewChannel: true,
          SendMessages: true,
          AttachFiles: true,
          ReadMessageHistory: true
        },
        `Open ticket owner permissions for ${channel.id}`
      );
    } catch (error) {
      console.error(`Failed to open ticket owner permissions for ${channel.id}:`, error);
    }
  }

  scheduleTicketRename(channel, nextName, 'reopen');

  return { ok: true, channel, oldName: channel.name, nextName, expectedName: nextName, renameOk: null };
}

async function publishPanel(interaction, session) {
  const channel = await interaction.guild.channels.fetch(session.channelId);
  if (!channel || !channel.isTextBased()) {
    await interaction.update({
      content: 'Target channel is no longer available.',
      components: []
    });
    return;
  }

  const setupConfig = ensureTicketInstance(session.config);
  const message = await channel.send({
    embeds: [buildPanelEmbed(setupConfig)],
    components: [buildPanelMenu(setupConfig)]
  });

  const finalConfig = {
    ...setupConfig,
    channelId: channel.id,
    messageId: message.id,
    updatedAt: new Date().toISOString()
  };

  setGuildConfig(interaction.guildId, finalConfig);
  setupSessions.delete(setupSessionKey(interaction));

  await interaction.update({
    content: `Ticket panel published in <#${channel.id}> for **${BRAND_NAME}**.`,
    components: []
  });
}

async function updateSavedPanel(guild, config) {
  if (!config.channelId || !config.messageId) {
    return { ok: false, reason: 'missing_panel' };
  }

  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    return { ok: false, reason: 'missing_channel' };
  }

  const message = await channel.messages.fetch(config.messageId).catch(() => null);
  if (!message) {
    return { ok: false, reason: 'missing_message' };
  }

  await message.edit({
    embeds: [buildPanelEmbed(config)],
    components: [buildPanelMenu(config)]
  });

  return { ok: true, channel, message };
}

async function resendSavedPanel(interaction) {
  const config = getGuildConfig(interaction.guildId);

  if (!config?.sections?.length) {
    await interaction.reply({
      content: 'No saved ticket panel setup was found. Run /setup first.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!interaction.channel?.isTextBased()) {
    await interaction.reply({
      content: 'Use this command in a text channel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const panelConfig = ensureTicketInstance(config);
  const message = await interaction.channel.send({
    embeds: [buildPanelEmbed(panelConfig)],
    components: [buildPanelMenu(panelConfig)]
  });

  setGuildConfig(interaction.guildId, {
    ...panelConfig,
    channelId: interaction.channelId,
    messageId: message.id,
    updatedAt: new Date().toISOString()
  });

  await interaction.reply({
    content: `Ticket panel sent in <#${interaction.channelId}>.`,
    flags: MessageFlags.Ephemeral
  });
}

async function findExistingMemberTicket(guild, userId, config) {
  // The Guilds intent keeps the channel cache current through gateway events,
  // so avoid a REST sweep of every channel on each panel click.
  const channels = guild.channels.cache.size ? guild.channels.cache : await guild.channels.fetch();
  const closedTicketIds = new Set(Array.isArray(config.closedTicketIds) ? config.closedTicketIds : []);

  return channels.find((channel) => {
    if (
      channel?.type !== ChannelType.GuildText ||
      !channel.topic?.includes(TICKET_MARKER) ||
      !channel.topic?.includes(`owner=${userId}`)
    ) {
      return false;
    }

    const isClosed =
      closedTicketIds.has(channel.id) ||
      getTicketStatus(channel) === 'closed' ||
      channel.name.startsWith('closed-');

    if (isClosed) {
      return false;
    }

    console.log(`Existing open ticket found for ${userId}: ${channel.id} #${channel.name}`);

    return true;
  }) || null;
}

async function openTicket(interaction, sectionId, reason) {
  let config = getGuildConfig(interaction.guildId);

  if (!config?.sections?.length) {
    await sendInteractionResult(interaction, {
      content: 'Ticket setup data is missing. Run /setup again and publish a new panel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const section = config.sections.find((item) => item.id === sectionId);

  if (!section) {
    await sendInteractionResult(interaction, { content: 'Ticket section is not configured anymore.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!config.ticketInstanceId) {
    config = setGuildConfig(interaction.guildId, ensureTicketInstance(config));
  }

  const guild = interaction.guild;
  const existingTicket = await findExistingMemberTicket(guild, interaction.user.id, config);

  if (existingTicket) {
    await sendInteractionResult(interaction, {
      content: `You already have a ticket: <#${existingTicket.id}>`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const everyoneId = guild.roles.everyone.id;

  // Reserve the number under a per-guild lock. Read-increment-write without one
  // hands the same ticket number to two members who click at the same moment.
  const ticketNumber = await withGuildLock(interaction.guildId, () => {
    const updated = updateGuildConfig(interaction.guildId, (current) => {
      if (!current) return null;
      return { ...current, ticketCounter: (Number(current.ticketCounter) || 2000) + 1 };
    });
    return updated?.ticketCounter ?? null;
  });

  if (!ticketNumber) {
    await sendInteractionResult(interaction, {
      content: 'Ticket setup data is missing. Run /setup again and publish a new panel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const channelName = `ticket-${ticketNumber}`;
  const permissionOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  for (const roleId of section.roleIds) {
    permissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: section.categoryId,
    topic: `${TICKET_MARKER} | owner=${interaction.user.id} | section=${section.name} | ticketNumber=${ticketNumber} | originalName=${channelName} | instance=${config.ticketInstanceId} | status=open`,
    permissionOverwrites
  });

  const staffMentions = section.roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
  const openedAt = Math.floor(Date.now() / 1000);
  const embed = new EmbedBuilder()
    .setColor(config.color || BRAND_COLOR)
    .setTitle(`${parseSectionEmoji(section.emoji)?.text || '🎫'} ${section.name}`)
    .setDescription(reason)
    .addFields(
      { name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Category', value: section.name, inline: true },
      { name: 'Opened at', value: `<t:${openedAt}:f>`, inline: true }
    )
    .setFooter({ text: `${BRAND_NAME} | Ticket System` })
    .setTimestamp();

  if (isHttpUrl(config.thumbnailUrl)) embed.setThumbnail(config.thumbnailUrl);

  const pinned = await channel.send({
    content: `${staffMentions} <@${interaction.user.id}>`.trim(),
    embeds: [embed],
    components: buildTicketControls(),
    // Deliberately no @everyone. Ticket creation is member-triggered, so pinging
    // the whole server on each one is a mass-notification abuse vector; the
    // responsible staff roles and the owner are the only people who need it.
    allowedMentions: { parse: [], roles: section.roleIds, users: [interaction.user.id] }
  });

  await pinned.pin().catch((error) => {
    console.error('Failed to pin ticket message:', error);
  });

  await sendInteractionResult(interaction, {
    content: `Ticket opened: <#${channel.id}>`,
    flags: MessageFlags.Ephemeral
  });
}

// ---------------------------------------------------------------------------
// Automatic server setup
//
// The /setup flow needs an admin to hand-pick a category and staff roles for
// every section. /quick-setup builds the whole structure instead. It is
// idempotent: roles, categories and channels are matched by name and reused, so
// running it twice does not duplicate anything.
// ---------------------------------------------------------------------------

const DEFAULT_SECTIONS = [
  { name: 'Inquiries', emoji: '❓' },
  { name: 'Technical Issue', emoji: '⚠️' },
  { name: 'Reports', emoji: '🕵️' },
  { name: 'Ban Appeal', emoji: '⛔' },
  { name: 'Compensation', emoji: '💸' },
  { name: 'Store', emoji: '💰' }
];

const STAFF_ROLE_NAME = 'Ticket Staff';
const TICKET_CATEGORY_NAME = '🎫 TICKETS';
const PANEL_CHANNEL_NAME = 'tickets';

const REQUIRED_BOT_PERMISSIONS = [
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['View Channels', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory]
];

function missingBotPermissions(guild) {
  const me = guild.members.me;
  return REQUIRED_BOT_PERMISSIONS
    .filter(([, flag]) => !me?.permissions.has(flag))
    .map(([label]) => label);
}

function ticketAreaOverwrites(guild, staffRoleId) {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];
}

async function ensureStaffRole(guild, providedRole, created) {
  if (providedRole) return providedRole;

  const existing = guild.roles.cache.find((role) => role.name === STAFF_ROLE_NAME);
  if (existing) return existing;

  // Created with no guild-wide permissions on purpose: everything this role can
  // do comes from the channel overwrites below, and a bot can never grant a
  // permission it does not itself hold.
  const role = await guild.roles.create({
    name: STAFF_ROLE_NAME,
    color: BRAND_COLOR,
    mentionable: true,
    permissions: [],
    reason: `${BRAND_NAME} tickets: staff role`
  });

  created.roles.push(role.name);
  return role;
}

async function ensureTicketCategory(guild, name, staffRoleId, created) {
  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildCategory && channel.name === name
  );
  if (existing) return existing;

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: ticketAreaOverwrites(guild, staffRoleId),
    reason: `${BRAND_NAME} tickets: ticket category`
  });

  created.categories.push(name);
  return category;
}

async function ensurePanelChannel(guild, providedChannel, created) {
  if (providedChannel) return providedChannel;

  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildText && channel.name === PANEL_CHANNEL_NAME
  );
  if (existing) return existing;

  // Everyone can see the panel and use the menu, but not post in the channel.
  const channel = await guild.channels.create({
    name: PANEL_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: `${BRAND_NAME} | Open a ticket from the menu below`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }
    ],
    reason: `${BRAND_NAME} tickets: panel channel`
  });

  created.channels.push(channel.name);
  return channel;
}

async function runQuickSetup(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const missing = missingBotPermissions(guild);
  if (missing.length) {
    await interaction.editReply({
      content: [
        `I am missing these permissions: **${missing.join(', ')}**`,
        'Re-invite the bot with those permissions, then run this command again.'
      ].join('\n')
    });
    return;
  }

  const created = { roles: [], categories: [], channels: [] };
  const providedRole = interaction.options.getRole('staff_role');
  const providedChannel = interaction.options.getChannel('panel_channel');
  const singleCategory = interaction.options.getBoolean('single_category') ?? false;

  const staffRole = await ensureStaffRole(guild, providedRole, created);

  // Default: one category per section, so a Store ticket opens under Store.
  // Each category denies @everyone, so members never see it in the channel
  // list. A ticket channel inside it carries its own overwrite allowing the
  // opener, and Discord shows a hidden category to anyone who can see at
  // least one channel in it -- so the member sees only their own ticket,
  // while staff see the category with every ticket in it.
  const sharedCategory = singleCategory
    ? await ensureTicketCategory(guild, TICKET_CATEGORY_NAME, staffRole.id, created)
    : null;

  const sections = [];
  for (const [index, template] of DEFAULT_SECTIONS.entries()) {
    const category = sharedCategory
      || await ensureTicketCategory(guild, `${template.emoji} ${template.name}`, staffRole.id, created);

    sections.push({
      id: `${Date.now()}${index}`,
      name: template.name,
      emoji: template.emoji,
      categoryId: category.id,
      roleIds: [staffRole.id]
    });
  }

  const panelChannel = await ensurePanelChannel(guild, providedChannel, created);

  const existing = getGuildConfig(guild.id);
  const config = ensureTicketInstance({
    ...(existing || {}),
    title: existing?.title || `${BRAND_NAME} - Ticket System`,
    description: existing?.description
      || 'Welcome to support.\nPick the category that matches your issue from the menu below, then describe it in detail.',
    color: existing?.color || BRAND_COLOR,
    sections,
    ticketCounter: Number(existing?.ticketCounter) || 2000
  });

  // Edit the existing panel in place when it is still present in the target
  // channel. Posting unconditionally would leave a stale duplicate panel
  // behind every time this command is re-run.
  let panelMessage = null;
  if (existing?.messageId && existing.channelId === panelChannel.id) {
    panelMessage = await panelChannel.messages.fetch(existing.messageId).catch(() => null);
  }

  const panelPayload = {
    embeds: [buildPanelEmbed(config)],
    components: [buildPanelMenu(config)]
  };

  const panelReused = Boolean(panelMessage);
  panelMessage = panelReused
    ? await panelMessage.edit(panelPayload)
    : await panelChannel.send(panelPayload);

  setGuildConfig(guild.id, {
    ...config,
    channelId: panelChannel.id,
    messageId: panelMessage.id,
    updatedAt: new Date().toISOString()
  });

  const line = (label, items) => (items.length ? `${label}: ${items.join(', ')}` : `${label}: none`);

  await interaction.editReply({
    content: [
      `Ticket system ready in **${guild.name}**.`,
      '',
      `Panel: <#${panelChannel.id}> (${panelReused ? 'updated in place' : 'posted'})`,
      `Staff role: <@&${staffRole.id}>`,
      `Sections: ${sections.length}`,
      `Layout: ${singleCategory ? 'one shared category' : 'one hidden category per section'}`,
      '',
      line('Roles created', created.roles),
      line('Categories created', created.categories),
      line('Channels created', created.channels),
      '',
      `Add your staff to <@&${staffRole.id}> so they get ticket access.`
    ].join('\n')
  });

  console.log(
    `Quick setup complete. guild=${guild.id} sections=${sections.length} ` +
    `created roles=${created.roles.length} categories=${created.categories.length} channels=${created.channels.length}`
  );
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Ticket bot build: ${BUILD_ID}`);
  resumePendingRenames().catch((error) => {
    console.error('Failed to resume pending ticket renames:', error);
  });
  console.log(`Automatic ticket refresh interval: ${REFRESH_INTERVAL_MINUTES} minutes`);
  setTimeout(() => runAutomaticMaintenance().catch(console.error), 15_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (GUILD_MANAGER_COMMANDS.has(interaction.commandName) && !hasGuildManagerPermission(interaction)) {
        await interaction.reply({
          content: 'You need the Manage Server permission to use this command.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === 'setup') {
        await interaction.showModal(createPanelModal());
        return;
      }

      if (interaction.commandName === 'quick-setup') {
        await runQuickSetup(interaction);
        return;
      }

      if (interaction.commandName === 'ticket-panel') {
        await resendSavedPanel(interaction);
        return;
      }

      if (interaction.commandName === 'ticket-section-add') {
        const config = getGuildConfig(interaction.guildId);
        if (!config?.channelId || !config?.messageId) {
          await interaction.reply({
            content: 'No saved ticket panel was found. Run /setup and publish a panel first.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if ((config.sections || []).length >= 25) {
          await interaction.reply({
            content: 'The ticket panel already has 25 sections, which is the Discord select menu limit.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const session = {
          mode: 'add-section',
          channelId: config.channelId,
          config: ensureTicketInstance(config),
          pendingSection: null,
          createdAt: Date.now()
        };
        setupSessions.set(setupSessionKey(interaction), session);
        await interaction.showModal(createSectionModal());
        return;
      }

      if (interaction.commandName === 'tickets-refresh') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await refreshGuildTickets(interaction.guild, `manual:${interaction.user.id}`);
        pruneSetupSessions();
        await interaction.editReply({
          content: `Tickets refreshed. Total: ${result.total}, updated: ${result.updated}, failed: ${result.failed}.`
        });
        return;
      }

      if (interaction.commandName === 'ticket-admin') {
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ content: 'This command only works inside a ticket channel.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(await canManageTicket(interaction))) {
          await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply(buildAdminPanel(interaction.channel));
        return;
      }

      if (!isTicketChannel(interaction.channel)) {
        await interaction.reply({ content: 'This command can only be used inside a ticket channel.', flags: MessageFlags.Ephemeral });
        return;
      }

      const canManage = await canManageTicket(interaction);
      const isTicketOwner = getTicketOwnerId(interaction.channel) === interaction.user.id;

      // Ticket owners can close their own ticket; every other action is staff only.
      if (!canManage && !(interaction.commandName === 'ticket-close' && isTicketOwner)) {
        await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'ticket-close') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = await fetchFreshTicketChannel(interaction);
        const rename = await closeTicketChannel(channel);
        if (!rename.ok) {
          await interaction.editReply({
            content: `Cannot close ticket. Discord did not rename the channel to ${rename.expectedName}.`
          });
          return;
        }

        await interaction.editReply({ content: 'Ticket closed. Use the Reopen button to open it again.' });
        return;
      }

      if (interaction.commandName === 'ticket-add') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user', true);
        await editPermissionOverwrite(
          interaction.channel,
          user.id,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true
          },
          `Add ticket member permissions for ${interaction.channelId}`
        );
        await interaction.editReply({ content: `Added <@${user.id}> to this ticket.` });
        return;
      }

      if (interaction.commandName === 'ticket-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user', true);
        // Matches the admin panel guard: removing the owner orphans the ticket.
        if (user.id === getTicketOwnerId(interaction.channel)) {
          await interaction.editReply({ content: 'The ticket owner cannot be removed from their own ticket.' });
          return;
        }
        await deletePermissionOverwrite(
          interaction.channel,
          user.id,
          `Remove ticket member permissions for ${interaction.channelId}`
        );
        await interaction.editReply({ content: `Removed <@${user.id}> from this ticket.` });
        return;
      }

      if (interaction.commandName === 'ticket-rename') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = cleanChannelName(interaction.options.getString('name', true));
        const channel = await fetchFreshTicketChannel(interaction);
        scheduleTicketRename(channel, name, 'manual rename');
        await interaction.editReply({ content: `Ticket rename queued: ${channel.name} -> ${name}.` });
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'setup:panel-modal') {
        const config = {
          title: interaction.fields.getTextInputValue('title'),
          description: interaction.fields.getTextInputValue('description'),
          color: normalizeColor(interaction.fields.getTextInputValue('color')),
          thumbnailUrl: interaction.fields.getTextInputValue('thumbnailUrl').trim(),
          imageUrl: interaction.fields.getTextInputValue('imageUrl').trim(),
          sections: []
        };

        const session = { channelId: interaction.channelId, config, pendingSection: null, createdAt: Date.now() };
        setupSessions.set(setupSessionKey(interaction), session);
        await sendSetupSummary(interaction, session);
        return;
      }

      if (interaction.customId === 'setup:section-modal') {
        const session = setupSessions.get(setupSessionKey(interaction));
        if (!session) {
          await interaction.reply({ content: 'Setup session expired. Run /setup again.', flags: MessageFlags.Ephemeral });
          return;
        }

        const section = {
          id: `${Date.now()}`,
          name: interaction.fields.getTextInputValue('name'),
          emoji: interaction.fields.getTextInputValue('emoji').trim(),
          categoryId: null,
          roleIds: []
        };

        session.pendingSection = section;
        await showCategorySelect(interaction, section);
        return;
      }

      if (interaction.customId === 'admin:edit-modal') {
        if (!isTicketChannel(interaction.channel) || !(await canManageTicket(interaction))) {
          await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = await fetchFreshTicketChannel(interaction);
        const newName = cleanChannelName(interaction.fields.getTextInputValue('name'));
        const info = interaction.fields.getTextInputValue('info');
        if (channel.name !== newName) {
          await renameTicketChannel(channel, newName, `admin edit by ${interaction.user.id}`);
        }
        const freshChannel = await interaction.guild.channels.fetch(interaction.channelId, { force: true });
        await setTicketInfo(freshChannel, info);
        await interaction.editReply({ content: `Ticket renamed and info updated: #${newName}.` });
        return;
      }

      if (interaction.customId.startsWith('ticket:reason:')) {
        const sectionId = interaction.customId.split(':')[2];
        const reason = interaction.fields.getTextInputValue('reason');
        const creationKey = `${interaction.guildId}:${interaction.user.id}`;
        if (ticketCreationLocks.has(creationKey)) {
          await interaction.reply({
            content: 'Your ticket is being created, one moment.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        ticketCreationLocks.add(creationKey);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await openTicket(interaction, sectionId, reason);
        } finally {
          ticketCreationLocks.delete(creationKey);
        }
      }

      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:panel') {
      const sectionId = interaction.values[0];
      let config = getGuildConfig(interaction.guildId);

      if (!config?.sections?.length) {
        await interaction.reply({
          content: 'Ticket setup data is missing. Run /setup again and publish a new panel.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!config?.ticketInstanceId) {
        config = setGuildConfig(interaction.guildId, ensureTicketInstance(config || {}));
      }

      const existingTicket = await findExistingMemberTicket(interaction.guild, interaction.user.id, config);
      if (existingTicket) {
        await interaction.reply({
          content: `You already have a ticket: <#${existingTicket.id}>`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.showModal(createReasonModal(sectionId));
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('admin:')) {
        if (!isTicketChannel(interaction.channel) || !(await canManageTicket(interaction))) {
          await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.customId === 'admin:edit') {
          await interaction.showModal(createTicketEditModal(interaction.channel));
          return;
        }
        if (interaction.customId === 'admin:move') {
          await interaction.reply({ content: 'Select the new category for this ticket:', components: [buildCategoryPicker()], flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.customId === 'admin:add-user') {
          await interaction.reply({ content: 'Select the member to add:', components: [buildUserPicker('add')], flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.customId === 'admin:remove-user') {
          await interaction.reply({ content: 'Select the member to remove:', components: [buildUserPicker('remove')], flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.customId === 'admin:refresh') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const result = await refreshTicketChannel(await fetchFreshTicketChannel(interaction));
          await interaction.editReply({ content: `Ticket refreshed (${result.status === 'closed' ? 'Closed' : 'Open'}).` });
          return;
        }
      }

      if (interaction.customId.startsWith('ticket:')) {
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ content: 'This button can only be used inside a ticket channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!(await canManageTicket(interaction))) {
          await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
          return;
        }

        const claimedBy = getTicketClaimedBy(interaction.channel);

        if (interaction.customId === 'ticket:admin-panel') {
          await interaction.reply(buildAdminPanel(interaction.channel));
          return;
        }

        if (interaction.customId === 'ticket:claim') {
          if (claimedBy) {
            await interaction.reply({ content: `Ticket is already claimed by <@${claimedBy}>.`, flags: MessageFlags.Ephemeral });
            return;
          }

          await interaction.deferUpdate();
          trySetTicketTopicValue(interaction.channel, 'claimedBy', interaction.user.id);
          const embed = updateTicketEmbed(interaction, (ticketEmbed) => {
            ticketEmbed.addFields({
              name: 'Claimed by',
              value: `<@${interaction.user.id}>`,
              inline: true
            });
          });

          await interaction.message.edit({
            embeds: [embed],
            components: buildTicketControls('open', interaction.user.id)
          });
          return;
        }

        if (interaction.customId === 'ticket:close') {
          await interaction.deferUpdate();
          const channel = await fetchFreshTicketChannel(interaction);

          const rename = await closeTicketChannel(channel);
          if (!rename.ok) {
            const currentClaimedBy = getTicketClaimedBy(channel) || claimedBy;
            await interaction.message.edit({
              components: buildTicketControls('open', currentClaimedBy)
            });
            await interaction.followUp({
              content: `Cannot close ticket. Discord did not rename the channel to \`${rename.expectedName}\`.`,
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          const currentClaimedBy = getTicketClaimedBy(channel) || claimedBy;
          await interaction.message.edit({
            components: buildTicketControls('closed', currentClaimedBy)
          });

          await channel.send({
            embeds: buildClosedTicketEmbeds(interaction.user.id),
            components: buildClosedTicketControls()
          });
          return;
        }

        if (interaction.customId === 'ticket:reopen') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = await fetchFreshTicketChannel(interaction);
          await interaction.editReply({ content: 'Opening ticket...' });

          console.log(`Ticket reopen requested: ${channel.id} #${channel.name} by ${interaction.user.id}`);
          const rename = await reopenTicketChannel(channel);
          if (!rename.ok) {
            await interaction.message.edit({
              components: buildClosedTicketControls()
            });
            await interaction.editReply({
              content: `Cannot reopen ticket. Discord did not rename the channel to \`${rename.expectedName}\`.`
            });
            return;
          }

          const reopenedChannel = rename.channel || channel;
          const currentClaimedBy = getTicketClaimedBy(reopenedChannel) || claimedBy;
          tryUpdatePinnedTicketControls(reopenedChannel, 'open', currentClaimedBy).then(() => {
            console.log(`Ticket reopen controls refreshed: ${reopenedChannel.id} #${reopenedChannel.name}`);
          });

          await interaction.message.edit({
            embeds: [buildClosedTicketSummaryEmbed(interaction.user.id)],
            components: []
          });
          await reopenedChannel.send({
            embeds: [buildOpenedTicketEmbed(interaction.user.id)]
          });
          await interaction.editReply({ content: 'Ticket opened.' });
          return;
        }

        if (interaction.customId === 'ticket:transcript') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = await fetchFreshTicketChannel(interaction);
          const result = await sendTicketTranscript(channel);

          await interaction.editReply({
            content: `Transcript sent. Messages: ${result.totalMessages}. Delivered: ${result.delivered.length || 0}. Failed: ${result.failed.length || 0}.`
          });
          return;
        }

        if (interaction.customId === 'ticket:delete') {
          await interaction.reply({ content: 'Deleting ticket channel in 3 seconds...', flags: MessageFlags.Ephemeral });
          const channel = await fetchFreshTicketChannel(interaction);
          setTimeout(() => {
            channel.delete(`Ticket deleted by ${interaction.user.tag}`).catch((error) => {
              console.error(`Failed to delete ticket channel ${channel.id}:`, error);
            });
          }, 3000);
          return;
        }

        await interaction.reply({
          content: 'Unknown ticket button, or this message is out of date. Run /tickets-refresh to rebuild it.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!interaction.customId.startsWith('setup:')) return;

      const session = setupSessions.get(setupSessionKey(interaction));

      if (!session) {
        await interaction.reply({ content: 'Setup session expired. Run /setup again.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId === 'setup:add-section') {
        await interaction.showModal(createSectionModal());
        return;
      }

      if (interaction.customId === 'setup:publish') {
        await publishPanel(interaction, session);
        return;
      }

      if (interaction.customId === 'setup:cancel') {
        setupSessions.delete(setupSessionKey(interaction));
        await interaction.update({ content: 'Setup cancelled.', components: [] });
      }

      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup:section-category') {
      const session = setupSessions.get(setupSessionKey(interaction));
      if (!session?.pendingSection) {
        await interaction.reply({ content: 'No pending section found.', flags: MessageFlags.Ephemeral });
        return;
      }

      session.pendingSection.categoryId = interaction.values[0];
      await showRoleSelect(interaction, session.pendingSection);
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'admin:category') {
      if (!isTicketChannel(interaction.channel) || !(await canManageTicket(interaction))) {
        await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      await withTimeout(interaction.channel.setParent(interaction.values[0], { lockPermissions: false }), `Move ticket ${interaction.channelId}`);
      await interaction.editReply({ content: 'Ticket moved to the new category.', components: [] });
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('admin:')) {
      if (!isTicketChannel(interaction.channel) || !(await canManageTicket(interaction))) {
        await interaction.reply({ content: 'You do not have permission to manage this ticket.', flags: MessageFlags.Ephemeral });
        return;
      }
      const userId = interaction.values[0];
      await interaction.deferUpdate();
      if (interaction.customId === 'admin:add-user-select') {
        await editPermissionOverwrite(interaction.channel, userId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        }, `Admin panel add member ${userId}`);
        await interaction.editReply({ content: `Added <@${userId}> to this ticket.`, components: [] });
      } else {
        if (userId === getTicketOwnerId(interaction.channel)) {
          await interaction.editReply({ content: 'The ticket owner cannot be removed from their own ticket.', components: [] });
          return;
        }
        await deletePermissionOverwrite(interaction.channel, userId, `Admin panel remove member ${userId}`);
        await interaction.editReply({ content: `Removed <@${userId}> from this ticket.`, components: [] });
      }
      return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup:section-roles') {
      const session = setupSessions.get(setupSessionKey(interaction));
      if (!session?.pendingSection) {
        await interaction.reply({ content: 'No pending section found.', flags: MessageFlags.Ephemeral });
        return;
      }

      session.pendingSection.roleIds = interaction.values;
      session.config.sections.push(session.pendingSection);
      session.pendingSection = null;

      if (session.mode === 'add-section') {
        const finalConfig = {
          ...ensureTicketInstance(session.config),
          updatedAt: new Date().toISOString()
        };
        setGuildConfig(interaction.guildId, finalConfig);
        const panelUpdate = await updateSavedPanel(interaction.guild, finalConfig);
        setupSessions.delete(setupSessionKey(interaction));

        await interaction.update({
          content: panelUpdate.ok
            ? 'Ticket section added and the saved panel was updated.'
            : 'Ticket section added, but I could not update the old panel message. Use /ticket-panel to resend it.',
          components: []
        });
        return;
      }

      await interaction.update(makeSetupSummary(session));
    }
  } catch (error) {
    logInteractionError(error, interaction);
    const payload = { content: 'An error occurred while processing this action.', flags: MessageFlags.Ephemeral };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch((replyError) => {
        console.error('Failed to send interaction follow-up:', replyError);
      });
      return;
    }

    await interaction.reply(payload).catch((replyError) => {
      console.error('Failed to send interaction error reply:', replyError);
    });
  }
});

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN is required in .env');
}

setInterval(() => {
  console.log(`Bot heartbeat. ready=${client.isReady()} ws=${client.ws.status}`);
}, 60_000);

setInterval(() => {
  runAutomaticMaintenance().catch((error) => {
    console.error('Automatic maintenance failed:', error);
  });
}, REFRESH_INTERVAL_MINUTES * 60_000);

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Discord login failed:', error);
});
