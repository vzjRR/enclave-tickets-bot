require('dotenv').config();

const {
  ActionRowBuilder,
  ActivityType,
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

const BRAND_NAME = 'Enclave Tickets';
const BRAND_COLOR = 0x90773E;
const BUILD_ID = 'enclave-tickets-dual-flow-2026-08-21-v2';
const TICKET_MARKER = 'Enclave Tickets | Ticket';

// Every member-facing embed carries the same footer.
const BRAND_TAGLINE = (process.env.BRAND_TAGLINE || 'Discord Manager').trim();
const BRAND_FOOTER = `${BRAND_NAME} | ${BRAND_TAGLINE}`;

// Two ticket lifecycles run side by side in the same guild so they can be
// compared directly. A ticket records which one it belongs to in its channel
// topic, and every lifecycle decision branches on that.
//
//   modern  - hidden categories, DM notifications, and closing archives the
//             ticket to the log channel and deletes it.
//   classic - the original AbuFaisal behaviour: staff-visible category, no
//             DMs, and closing renames the channel to closed-N and keeps it
//             in place with Transcript / Open / Delete controls.
const FLOW_NEW = 'new';
const FLOW_CLASSIC = 'classic';

const FLOW_META = {
  [FLOW_NEW]: {
    key: FLOW_NEW,
    label: 'Modern Flow',
    emoji: '🎫',
    color: 0x90773E,
    panelChannel: 'create-ticket',
    categoryPrefix: '',
    notifiesByDm: true,
    description:
      'Pick the category that matches your issue. You will get a private channel and a direct message confirming it.\n\nClosed tickets are archived to the staff log and the channel is removed.'
  },
  [FLOW_CLASSIC]: {
    key: FLOW_CLASSIC,
    label: 'Classic Flow',
    emoji: '🗂️',
    color: 0x5865f2,
    panelChannel: 'create-ticket-classic',
    categoryPrefix: 'Classic',
    notifiesByDm: false,
    description:
      'The original ticket lifecycle. Pick a category to open a private channel.\n\nClosed tickets are renamed to closed-<number> and kept in place, where staff can pull a transcript, reopen them, or delete them by hand.'
  }
};

function flowMeta(flow) {
  return FLOW_META[flow] || FLOW_META[FLOW_NEW];
}

function sectionFlow(section) {
  return section?.flow === FLOW_CLASSIC ? FLOW_CLASSIC : FLOW_NEW;
}
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

// Server Members is the other privileged intent. It is only needed to read
// which members hold the staff role, so that they can be DMed about a new
// ticket as well as mentioned in it.
const ENABLE_GUILD_MEMBERS = envFlag('ENABLE_GUILD_MEMBERS', false);
const STAFF_DM_ON_NEW_TICKET = envFlag('STAFF_DM_ON_NEW_TICKET', true);
const STAFF_DM_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.STAFF_DM_LIMIT || '25', 10) || 25
);

// Whether the member who opened a ticket receives their own transcript: on
// close for the modern flow, and on request for the classic one. The ticket
// log stays staff-only either way, so this is how a member gets their record.
const TRANSCRIPT_SEND_TO_OWNER = envFlag('TRANSCRIPT_SEND_TO_OWNER', true);

const SETUP_SESSION_TTL_MS = 30 * 60_000;

// Neutral dark so the closed-ticket card reads as a receipt rather than an
// alert. Set CLOSED_CARD_THUMBNAIL to any image URL to replace the icon.
const CLOSED_CARD_COLOR = 0x2b2d31;
const CLOSED_CARD_THUMBNAIL = (process.env.CLOSED_CARD_THUMBNAIL || '').trim();

// Shown under the bot name in the member list.
const BOT_ACTIVITY = (process.env.BOT_ACTIVITY || 'ENCLAVE RP TICKETS SYSTEM').trim();

// Deployment targets. Setting these lets /quick-setup adopt channels and a
// role that already exist on the server instead of creating its own, which is
// what you want on an established community.
const PANEL_CHANNEL_ID = (process.env.PANEL_CHANNEL_ID || '').trim();
const LOG_CHANNEL_ID = (process.env.LOG_CHANNEL_ID || '').trim();
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID || '').trim();

// New categories are placed directly above this one.
const ANCHOR_CATEGORY_ID = (process.env.ANCHOR_CATEGORY_ID || '').trim();

// Which ticket lifecycles to provision. Production usually wants just the
// modern one; the demo server runs both so they can be compared.
const ENABLED_FLOWS = (process.env.ENABLED_FLOWS || FLOW_NEW)
  .split(',')
  .map((flow) => flow.trim().toLowerCase())
  .filter(Boolean);

async function resolveConfiguredChannel(guild, id) {
  if (!id) return null;
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (!channel) {
    console.warn(`Configured channel ${id} was not found in guild ${guild.id}; falling back.`);
    return null;
  }
  return channel;
}

async function resolveConfiguredRole(guild) {
  if (!STAFF_ROLE_ID) return null;
  const role = await guild.roles.fetch(STAFF_ROLE_ID).catch(() => null);
  if (!role) {
    console.warn(`Configured staff role ${STAFF_ROLE_ID} was not found in guild ${guild.id}; falling back.`);
    return null;
  }
  return role;
}

// Grace period between announcing a close and destroying the channel, so the
// people in it can see why it vanished.
const TICKET_DELETE_DELAY_MS = 10_000;

const setupSessions = new Map();
const ticketCreationLocks = new Set();
const pendingChannelRenames = new Map();
const guildWriteQueues = new Map();
let maintenanceRunning = false;

const intents = [GatewayIntentBits.Guilds];
if (ENABLE_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);
if (ENABLE_GUILD_MEMBERS) intents.push(GatewayIntentBits.GuildMembers);

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

function setTicketControlMessageId(guildId, channelId, messageId) {
  updateGuildConfig(guildId, (config) => {
    if (!config) return null;
    return {
      ...config,
      controlMessages: { ...(config.controlMessages || {}), [channelId]: messageId }
    };
  });
}

function clearTicketControlMessageId(guildId, channelId) {
  updateGuildConfig(guildId, (config) => {
    if (!config?.controlMessages?.[channelId]) return null;
    const controlMessages = { ...config.controlMessages };
    delete controlMessages[channelId];
    return { ...config, controlMessages };
  });
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

function buildPanelEmbed(config, flow = FLOW_NEW) {
  const meta = flowMeta(flow);

  // Only the modern panel honours /setup customisation. The classic panel
  // always renders from its own metadata so the two stay visually distinct.
  const custom = flow === FLOW_NEW ? config : {};

  const embed = new EmbedBuilder()
    .setColor(custom.color || meta.color)
    .setTitle(custom.title || `${meta.emoji} ${BRAND_NAME} — ${meta.label}`)
    .setDescription(custom.description || meta.description)
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  // The bot's own avatar is a Discord-hosted image, so the panel gets artwork
  // without depending on some external host staying up.
  const icon = client.user?.displayAvatarURL({ size: 256 });
  if (icon) embed.setThumbnail(icon);

  if (isHttpUrl(custom.thumbnailUrl)) embed.setThumbnail(custom.thumbnailUrl);
  if (isHttpUrl(custom.imageUrl)) embed.setImage(custom.imageUrl);

  return embed;
}

function buildPanelMenu(config, flow = FLOW_NEW) {
  const meta = flowMeta(flow);
  const sections = (config.sections || []).filter((section) => sectionFlow(section) === flow);

  // Discord rejects a select menu with no options, so callers must skip a
  // flow that has no sections rather than publish a broken panel.
  if (!sections.length) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket:panel:${flow}`)
    .setPlaceholder(`Select a category — ${meta.label}`);

  for (const section of sections.slice(0, 25)) {
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
          .setLabel('Write your concern:')
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
    .setFooter({ text: BRAND_FOOTER })
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

function buildTicketControls(status = 'open', claimedBy = null, flow = FLOW_NEW) {
  const isClosed = status === 'closed';
  const closeLabel = flow === FLOW_CLASSIC ? 'Close' : 'Close & Delete';

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:claim')
        .setLabel(claimedBy ? 'Claimed' : 'Claim')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(Boolean(claimedBy) || isClosed),
      new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel(closeLabel)
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

function messageHasButton(message, customId) {
  return message.components.some((row) =>
    row.components.some((component) => component.customId === customId)
  );
}

async function updatePinnedTicketControls(channel, status, claimedBy = null) {
  const ticketMessage = await withTimeout(
    findTicketControlMessage(channel),
    `Find ticket controls for ${channel.id}`
  );

  if (!ticketMessage) return null;

  await withTimeout(
    ticketMessage.edit({
      components: buildTicketControls(status, claimedBy, getTicketFlow(channel))
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
    const controlMessages = Object.fromEntries(
      Object.entries(config.controlMessages || {}).filter(([id]) => existingIds.has(id))
    );
    setGuildConfig(guild.id, {
      ...config,
      controlMessages,
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

// The topic holds several independent keys, so every write is a merge. It has
// to merge against what is actually on the channel right now: the maintenance
// sweep writes status= from a channel list it fetched earlier, and if a member
// was claimed in between, writing a stale topic back would silently drop
// claimedBy. Re-reading first makes the last writer merge instead of clobber.
async function setTicketTopicValue(channel, key, value) {
  const fresh = await channel.guild.channels
    .fetch(channel.id, { force: true })
    .catch(() => channel);

  const topic = fresh.topic || TICKET_MARKER;
  const pair = `${key}=${value}`;
  const nextTopic = topic.includes(`${key}=`)
    ? topic.replace(new RegExp(`${key}=[^|]+`), pair)
    : `${topic} | ${pair}`;

  // Channel edits are capped at roughly two per ten minutes, so never spend
  // one writing a topic that already says this.
  if (nextTopic === fresh.topic) return;

  await fresh.setTopic(nextTopic.slice(0, 1024));
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
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          console.log(`Dropping pending rename for missing channel ${channelId}.`);
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
    embeds: [buildPanelEmbed(setupConfig, FLOW_NEW)],
    components: [buildPanelMenu(setupConfig, FLOW_NEW)]
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

// Refreshes every panel the guild has, one per flow, so a section added to
// either list shows up without republishing by hand.
async function updateSavedPanel(guild, config) {
  const targets = [
    { flow: FLOW_NEW, channelId: config.channelId, messageId: config.messageId },
    { flow: FLOW_CLASSIC, channelId: config.classicChannelId, messageId: config.classicMessageId }
  ].filter((target) => target.channelId && target.messageId);

  if (!targets.length) return { ok: false, reason: 'missing_panel' };

  let updated = 0;
  for (const target of targets) {
    const menu = buildPanelMenu(config, target.flow);
    if (!menu) continue;

    const channel = await guild.channels.fetch(target.channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const message = await channel.messages.fetch(target.messageId).catch(() => null);
    if (!message) continue;

    await message.edit({
      embeds: [buildPanelEmbed(config, target.flow)],
      components: [menu]
    });
    updated += 1;
  }

  return updated ? { ok: true, updated } : { ok: false, reason: 'missing_message' };
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
    embeds: [buildPanelEmbed(panelConfig, FLOW_NEW)],
    components: [buildPanelMenu(panelConfig, FLOW_NEW)]
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

async function findExistingMemberTicket(guild, userId, config, flow = null) {
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

    // Scoped per flow so a member testing the modern panel is not blocked
    // from also opening a classic ticket.
    if (flow && getTicketFlow(channel) !== flow) {
      return false;
    }

    console.log(`Existing open ticket found for ${userId}: ${channel.id} #${channel.name}`);

    return true;
  }) || null;
}

// ---------------------------------------------------------------------------
// Classic flow lifecycle
//
// Restored verbatim from the original AbuFaisal implementation so the two
// flows can be compared on equal terms. Closing renames the channel to
// closed-<number> and revokes the opener's access; the channel itself is the
// archive. This is what makes the rename retry queue load-bearing: Discord
// rate-limits channel renames to roughly two per ten minutes per channel.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ticket archival
//
// Closing a ticket deletes the channel outright, so everything worth keeping has
// to be written to the log channel first: who opened it, who claimed it, how
// long it stayed open, the reason given, and the full message transcript.
// ---------------------------------------------------------------------------

async function dmUser(userId, payload, label) {
  if (!userId) return false;

  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (error) {
    // Members can close their DMs. That must never abort a ticket operation.
    console.error(`Failed to DM ${label} to ${userId}:`, error?.message || error);
    return false;
  }
}

function getTicketFlow(channel) {
  const match = channel?.topic?.match(/flow=([a-z]+)/);
  return match?.[1] === FLOW_CLASSIC ? FLOW_CLASSIC : FLOW_NEW;
}

function getTicketSection(channel) {
  const match = channel?.topic?.match(/section=([^|]*)/);
  return match?.[1]?.trim() || 'Unknown';
}

function getTicketControlMessageId(channel) {
  const stored = getGuildConfig(channel?.guild?.id)?.controlMessages?.[channel?.id];
  if (stored) return stored;

  // Older tickets recorded it in the topic instead.
  const match = channel?.topic?.match(/controlMsg=(\d{17,20})/);
  return match?.[1] || null;
}

// Discord split pinning out of Manage Messages into its own PinMessages
// permission, so a bot can be invited without it and every pin call 403s.
// The control message id is therefore recorded in the channel topic, and
// pins are only a fallback -- the ticket keeps working either way.
async function findTicketControlMessage(channel) {
  const isControlMessage = (message) =>
    message.author.id === client.user.id &&
    messageHasButton(message, 'ticket:claim') &&
    messageHasButton(message, 'ticket:close');

  const recordedId = getTicketControlMessageId(channel);
  if (recordedId) {
    const direct = await channel.messages.fetch(recordedId).catch(() => null);
    if (direct) return direct;
  }

  const pins = await channel.messages.fetchPins().catch(() => null);
  const pinned = pins?.items?.map((pin) => pin.message).find(isControlMessage);
  if (pinned) return pinned;

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return recent?.find(isControlMessage) || null;
}

async function getTicketReason(channel) {
  try {
    const pinned = await findTicketControlMessage(channel);
    return pinned?.embeds?.[0]?.description?.trim() || null;
  } catch (error) {
    console.error(`Failed to read ticket reason for ${channel.id}:`, error?.message || error);
    return null;
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';

  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes % 60}m`);

  return parts.join(' ');
}

async function resolveLogChannel(guild) {
  const config = getGuildConfig(guild.id);
  if (!config?.logChannelId) return null;

  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function writeTicketLog(channel, closedById, reason, { messages, transcript }) {
  const logChannel = await resolveLogChannel(channel.guild);
  const ticketNumber = getTicketNumber(channel) || 'unknown';

  if (!logChannel) {
    console.error(
      `No tickets-log channel configured for guild ${channel.guild.id}. ` +
      `Ticket ${ticketNumber} was closed without an archive. Run /quick-setup to create one.`
    );
    return { ok: false, reason: 'no_log_channel', messageCount: 0 };
  }

  const ownerId = getTicketOwnerId(channel);
  const claimedBy = getTicketClaimedBy(channel);
  const openedAt = channel.createdTimestamp;
  const closedAt = Date.now();

  const embed = buildClosedTicketCard({
    guild: channel.guild,
    ownerId,
    claimedBy,
    closedById,
    openedAt,
    closedAt
  })
    .addFields(
      { name: 'Ticket', value: `#${ticketNumber}`, inline: true },
      { name: 'Section', value: getTicketSection(channel), inline: true },
      { name: 'Channel', value: `#${channel.name}`, inline: true },
      { name: 'Open For', value: formatDuration(closedAt - openedAt), inline: true },
      { name: 'Messages', value: String(messages.length), inline: true },
      { name: 'IDs', value: `owner \`${ownerId || "?"}\`\ncloser \`${closedById}\``, inline: true }
    )
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  if (reason) {
    embed.addFields({ name: 'Reason given', value: reason.slice(0, 1024), inline: false });
  }

  const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
    name: `ticket-${ticketNumber}-transcript.txt`
  });

  try {
    const posted = await logChannel.send({ embeds: [embed], files: [attachment] });
    return { ok: true, messageCount: messages.length, message: posted };
  } catch (error) {
    console.error(`Failed to write ticket log for ${ticketNumber}:`, error?.message || error);
    return { ok: false, reason: 'send_failed', messageCount: messages.length };
  }
}

// Archive, notify the owner, then delete. The log write happens first and its
// result is returned, so a caller can refuse to delete a ticket it could not
// archive.
// The "Ticket Closed" card: server icon and name in the author line, a 3 + 2
// grid of inline fields, and Discord-rendered timestamps (the <t:...:F> form
// renders as "Friday, August 21, 2026 8:07 PM" with the highlighted background).
function buildClosedTicketCard({ guild, ownerId, claimedBy, closedById, openedAt, closedAt }) {
  const embed = new EmbedBuilder()
    .setColor(CLOSED_CARD_COLOR)
    .setAuthor({
      name: guild.name,
      iconURL: guild.iconURL({ size: 128 }) || client.user?.displayAvatarURL({ size: 128 })
    })
    .setTitle('Ticket Closed')
    .addFields(
      { name: 'Opened By', value: ownerId ? `<@${ownerId}>` : 'Unknown', inline: true },
      { name: 'Claimed By', value: claimedBy ? `<@${claimedBy}>` : 'No one', inline: true },
      { name: 'Closed By', value: closedById ? `<@${closedById}>` : 'Unknown', inline: true },
      { name: 'Open Time', value: `<t:${Math.floor(openedAt / 1000)}:F>`, inline: true },
      { name: 'Close Time', value: `<t:${Math.floor(closedAt / 1000)}:F>`, inline: true }
    );

  const thumbnail = isHttpUrl(CLOSED_CARD_THUMBNAIL)
    ? CLOSED_CARD_THUMBNAIL
    : client.user?.displayAvatarURL({ size: 256 });
  if (thumbnail) embed.setThumbnail(thumbnail);

  return embed;
}

// A link button only earns its place if the destination actually opens for the
// person receiving it. Staff get the archived log entry; the member, who cannot
// see the log channel, gets the panel so they can open a fresh ticket.
async function buildClosedTicketLink(guild, recipientId, logMessage) {
  const config = getGuildConfig(guild.id);

  if (logMessage && config?.logChannelId) {
    const logChannel = await guild.channels.fetch(config.logChannelId).catch(() => null);
    const member = await guild.members.fetch(recipientId).catch(() => null);

    if (logChannel && member && logChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('View Ticket')
          .setStyle(ButtonStyle.Link)
          .setURL(logMessage.url)
      );
    }
  }

  if (config?.channelId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Open a New Ticket')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guild.id}/${config.channelId}`)
    );
  }

  return null;
}

async function closeAndArchiveTicket(channel, closedById) {
  const ownerId = getTicketOwnerId(channel);
  const ticketNumber = getTicketNumber(channel) || 'unknown';
  const reason = await getTicketReason(channel);

  // Collected once and shared: the archive and the member's copy are then
  // guaranteed to be the same record, and the channel is only read once.
  let messages = [];
  try {
    messages = await fetchTranscriptMessages(channel);
  } catch (error) {
    console.error(`Failed to collect transcript for ${channel.id}:`, error?.message || error);
  }
  const transcript = buildTranscriptText(channel, messages);

  const logged = await writeTicketLog(channel, closedById, reason, { messages, transcript });

  if (ownerId) {
    const card = buildClosedTicketCard({
      guild: channel.guild,
      ownerId,
      claimedBy: getTicketClaimedBy(channel),
      closedById,
      openedAt: channel.createdTimestamp,
      closedAt: Date.now()
    }).setFooter({ text: BRAND_FOOTER });

    const row = await buildClosedTicketLink(channel.guild, ownerId, logged.message);

    // A shared log channel cannot show one member only their own entry, so
    // the member is sent their own transcript instead of being given access
    // to everyone else's.
    const files = TRANSCRIPT_SEND_TO_OWNER
      ? [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
          name: `ticket-${ticketNumber}-transcript.txt`
        })]
      : [];

    await dmUser(ownerId, {
      embeds: [card],
      components: row ? [row] : [],
      files
    }, 'ticket closed notice');
  }

  // Drop any queued rename for this channel; it is about to stop existing.
  const pending = pendingChannelRenames.get(channel.id);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingChannelRenames.delete(channel.id);
  clearPendingTicketRename(channel.guild.id, channel.id);
  clearTicketControlMessageId(channel.guild.id, channel.id);
  setTicketClosedState(channel.guild.id, channel.id, false);

  console.log(
    `Ticket ${ticketNumber} closed by ${closedById}; archived=${logged.ok} ` +
    `messages=${logged.messageCount}; deleting channel ${channel.id}`
  );

  setTimeout(() => {
    channel.delete(`Ticket #${ticketNumber} closed by ${closedById}`).catch((error) => {
      console.error(`Failed to delete ticket channel ${channel.id}:`, error?.message || error);
    });
  }, TICKET_DELETE_DELAY_MS);

  return { ok: true, ticketNumber, logged };
}

// Creates the ticket channel, announces it, pins the controls and (on the
// modern flow) notifies the member. Interaction-free by design: openTicket
// wraps it for real users, and the self-test calls it directly.
// Staff are always mentioned in the ticket channel. DMing them as well needs
// the role's membership, and reading that needs the privileged Server Members
// intent -- which, like Message Content, breaks login if requested without
// being enabled in the Developer Portal. So it is opt-in, and its absence
// degrades to mention-only rather than failing the ticket.
let staffDirectoryWarned = false;

async function collectStaffRecipients(guild, roleIds, excludeUserId) {
  if (!ENABLE_GUILD_MEMBERS) {
    if (!staffDirectoryWarned) {
      staffDirectoryWarned = true;
      console.warn(
        'STAFF_DM_ON_NEW_TICKET is on but ENABLE_GUILD_MEMBERS is off, so role ' +
        'membership cannot be read. Staff are still mentioned in the ticket ' +
        'channel. Enable the Server Members intent in the Developer Portal and ' +
        'set ENABLE_GUILD_MEMBERS=true to DM them as well.'
      );
    }
    return [];
  }

  // The member cache is only complete once it has been filled at least once.
  if (guild.members.cache.size < (guild.memberCount || 0)) {
    try {
      await withTimeout(guild.members.fetch(), `Fetch members for ${guild.id}`, 20_000);
    } catch (error) {
      console.error(`Could not load the member list for ${guild.id}:`, error?.message || error);
      return [];
    }
  }

  const recipients = new Map();
  for (const roleId of roleIds || []) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    for (const member of role.members.values()) {
      if (member.user.bot) continue;
      if (member.id === excludeUserId) continue;
      recipients.set(member.id, member);
    }
  }

  return [...recipients.values()].slice(0, STAFF_DM_LIMIT);
}

async function notifyStaffOfNewTicket({ guild, section, channel, user, reason, ticketNumber }) {
  if (!STAFF_DM_ON_NEW_TICKET) return { attempted: 0, delivered: 0, skipped: true };

  const recipients = await collectStaffRecipients(guild, section.roleIds, user.id);
  if (!recipients.length) return { attempted: 0, delivered: 0, skipped: false };

  const embed = new EmbedBuilder()
    .setColor(flowMeta(sectionFlow(section)).color)
    .setAuthor({
      name: guild.name,
      iconURL: guild.iconURL({ size: 128 }) || client.user?.displayAvatarURL({ size: 128 })
    })
    .setTitle(`New ${section.name} ticket`)
    .setDescription(`Opened by <@${user.id}>.\n\nChannel: <#${channel.id}>`)
    .addFields(
      { name: 'Ticket', value: `#${ticketNumber}`, inline: true },
      { name: 'Category', value: section.name, inline: true }
    )
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  if (reason) {
    embed.addFields({ name: 'Their concern', value: reason.slice(0, 1024), inline: false });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Open Ticket')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guild.id}/${channel.id}`)
  );

  let delivered = 0;
  for (const member of recipients) {
    const ok = await dmUser(member.id, { embeds: [embed], components: [row] }, 'new ticket alert');
    if (ok) delivered += 1;
    await sleep(400);
  }

  console.log(
    `Staff alerted for ticket ${ticketNumber}: ${delivered}/${recipients.length} DMs delivered.`
  );
  return { attempted: recipients.length, delivered, skipped: false };
}

async function createTicket({ guild, user, section, reason, config }) {
  const everyoneId = guild.roles.everyone.id;

  // Reserve the number under a per-guild lock. Read-increment-write without one
  // hands the same ticket number to two members who click at the same moment.
  const ticketNumber = await withGuildLock(guild.id, () => {
    const updated = updateGuildConfig(guild.id, (current) => {
      if (!current) return null;
      return { ...current, ticketCounter: (Number(current.ticketCounter) || 2000) + 1 };
    });
    return updated?.ticketCounter ?? null;
  });

  if (!ticketNumber) return null;

  const flow = sectionFlow(section);
  const meta = flowMeta(flow);
  const channelName = `ticket-${ticketNumber}`;
  const permissionOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
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
    topic: `${TICKET_MARKER} | flow=${flow} | owner=${user.id} | section=${section.name} | ticketNumber=${ticketNumber} | originalName=${channelName} | instance=${config.ticketInstanceId} | status=open`,
    permissionOverwrites
  });

  const staffMentions = section.roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
  const openedAt = Math.floor(Date.now() / 1000);
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${parseSectionEmoji(section.emoji)?.text || '🎫'} ${section.name}`)
    .setDescription(reason)
    .addFields(
      { name: 'Opened by', value: `<@${user.id}>`, inline: true },
      { name: 'Category', value: section.name, inline: true },
      { name: 'Ticket number', value: `#${ticketNumber}`, inline: true },
      { name: 'Opened at', value: `<t:${openedAt}:f>`, inline: true },
      { name: 'Flow', value: `${meta.emoji} ${meta.label}`, inline: true }
    )
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  if (isHttpUrl(config.thumbnailUrl)) embed.setThumbnail(config.thumbnailUrl);

  const pinned = await channel.send({
    content: `${staffMentions} <@${user.id}>`.trim(),
    embeds: [embed],
    components: buildTicketControls('open', null, flow),
    // Deliberately no @everyone. Ticket creation is member-triggered, so pinging
    // the whole server on each one is a mass-notification abuse vector; the
    // responsible staff roles and the owner are the only people who need it.
    allowedMentions: { parse: [], roles: section.roleIds, users: [user.id] }
  });

  // Recorded so the controls stay findable even when pinning fails, and in
  // storage rather than the topic so it does not consume a channel edit.
  setTicketControlMessageId(guild.id, channel.id, pinned.id);

  // Staff are mentioned in the channel above; this DMs them too. Deliberately
  // not awaited -- the member should not wait on a queue of staff DMs to
  // learn their ticket exists.
  notifyStaffOfNewTicket({ guild, section, channel, user, reason, ticketNumber })
    .catch((error) => console.error('Failed to alert staff:', error?.message || error));

  await pinned.pin().catch((error) => {
    if (error?.code === 50013) {
      console.warn(
        `Could not pin the controls in ${channel.id}: the bot lacks the Pin Messages ` +
        'permission. The ticket still works; re-invite with it to get pinning back.'
      );
      return;
    }
    console.error('Failed to pin ticket message:', error?.message || error);
  });

  // The classic flow never messaged members; keeping that difference is the
  // point of running both.
  const notified = !meta.notifiesByDm || await dmUser(user.id, {
    embeds: [
      new EmbedBuilder()
        .setColor(config.color || BRAND_COLOR)
        .setTitle(`Ticket #${ticketNumber} created`)
        .setDescription(
          `Your **${section.name}** ticket in **${guild.name}** is open.\n\n` +
          `Channel: <#${channel.id}>\n\n` +
          'The support team has been notified. You will get another message here when a staff member picks it up.'
        )
        .addFields({ name: 'Your message', value: reason.slice(0, 1024) })
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp()
    ]
  }, 'ticket created notice');

  if (!notified) {
    // Their DMs are closed, so say it in the ticket instead.
    await channel.send({
      content:
        `<@${user.id}> I could not DM you a confirmation. ` +
        'Enable direct messages from server members if you want ticket updates.'
    }).catch(() => {});
  }

  return { channel, ticketNumber, flow, notified };
}

async function openTicket(interaction, sectionId, reason) {
  let config = getGuildConfig(interaction.guildId);

  if (!config?.sections?.length) {
    await sendInteractionResult(interaction, {
      content: 'Ticket setup data is missing. Run /quick-setup to build the panels.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const section = config.sections.find((item) => item.id === sectionId);

  if (!section) {
    await sendInteractionResult(interaction, {
      content: 'That ticket section is not configured anymore.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!config.ticketInstanceId) {
    config = setGuildConfig(interaction.guildId, ensureTicketInstance(config));
  }

  const existingTicket = await findExistingMemberTicket(
    interaction.guild, interaction.user.id, config, sectionFlow(section)
  );

  if (existingTicket) {
    await sendInteractionResult(interaction, {
      content: `You already have an open ${flowMeta(sectionFlow(section)).label} ticket: <#${existingTicket.id}>`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const result = await createTicket({
    guild: interaction.guild,
    user: interaction.user,
    section,
    reason,
    config
  });

  if (!result) {
    await sendInteractionResult(interaction, {
      content: 'Ticket setup data is missing. Run /quick-setup to rebuild it.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await sendInteractionResult(interaction, {
    content: `Ticket opened: <#${result.channel.id}>`,
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
const SUPPORT_CATEGORY_NAME = 'Support Center';
const CLASSIC_CATEGORY_NAME = '🗂️ Classic Tickets';
const PANEL_CHANNEL_NAME = 'create-ticket';
const LOG_CHANNEL_NAME = 'tickets-log';

const REQUIRED_BOT_PERMISSIONS = [
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['View Channels', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory]
];

// Nice to have rather than required: Discord split this out of Manage
// Messages, so older invites lack it. Without it the controls simply are not
// pinned; everything else still works.
const OPTIONAL_BOT_PERMISSIONS = [['Pin Messages', PermissionFlagsBits.PinMessages]];

function missingOptionalBotPermissions(guild) {
  const me = guild.members.me;
  return OPTIONAL_BOT_PERMISSIONS
    .filter(([, flag]) => !me?.permissions.has(flag))
    .map(([label]) => label);
}

function missingBotPermissions(guild) {
  const me = guild.members.me;
  return REQUIRED_BOT_PERMISSIONS
    .filter(([, flag]) => !me?.permissions.has(flag))
    .map(([label]) => label);
}

// A ticket category must stay invisible while it holds no tickets, so the staff
// role deliberately gets NO overwrite here. Staff reach a ticket through the
// ticket channel's own overwrite instead — and because Discord shows a category
// to anyone who can see at least one channel inside it, the category surfaces
// exactly when a ticket exists and disappears again when it is closed.
function hiddenCategoryOverwrites(guild) {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
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

// Holds the public panel channel and the staff-only log channel. Left on
// inherited permissions so members can see it: the panel inside is the entry
// point to the whole system.
async function ensureSupportCategory(guild, created) {
  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildCategory && channel.name === SUPPORT_CATEGORY_NAME
  );
  if (existing) return existing;

  const category = await guild.channels.create({
    name: SUPPORT_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: `${BRAND_NAME} tickets: support category`
  });

  created.categories.push(SUPPORT_CATEGORY_NAME);
  return category;
}

async function ensureTicketCategory(guild, name, created) {
  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildCategory && channel.name === name
  );

  if (existing) {
    // Re-apply the overwrites rather than trusting whatever is there. An earlier
    // run may have granted the staff role blanket access, which would keep the
    // category permanently visible instead of only while a ticket is open.
    await existing.permissionOverwrites.set(
      hiddenCategoryOverwrites(guild),
      `${BRAND_NAME} tickets: keep category hidden while empty`
    );
    return existing;
  }

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: hiddenCategoryOverwrites(guild),
    reason: `${BRAND_NAME} tickets: ticket category`
  });

  created.categories.push(name);
  return category;
}

// The classic flow keeps every section in one staff-visible category, which is
// how the original worked: closed tickets are renamed rather than removed, so
// they accumulate here as closed-<number> and staff browse them in place.
async function ensureClassicCategory(guild, staffRoleId, created) {
  const overwrites = [
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

  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildCategory && channel.name === CLASSIC_CATEGORY_NAME
  );

  if (existing) {
    await existing.permissionOverwrites.set(overwrites, `${BRAND_NAME}: classic category access`);
    return existing;
  }

  const category = await guild.channels.create({
    name: CLASSIC_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: `${BRAND_NAME}: classic ticket category`
  });

  created.categories.push(CLASSIC_CATEGORY_NAME);
  return category;
}

async function ensurePanelChannel(guild, providedChannel, flow, parentId, created) {
  if (providedChannel) return providedChannel;

  const meta = flowMeta(flow);
  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildText && channel.name === meta.panelChannel
  );
  if (existing) return existing;

  // Everyone can see the panel and use the menu, but not post in the channel.
  const channel = await guild.channels.create({
    name: meta.panelChannel,
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `${BRAND_NAME} | ${meta.label} — open a ticket from the menu below`,
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
    reason: `${BRAND_NAME}: ${meta.label} panel channel`
  });

  created.channels.push(channel.name);
  return channel;
}

// Closed modern tickets are deleted, so this is their only durable record.
// Staff can read it; nobody but the bot can write to it.
async function ensureLogChannel(guild, parentId, staffRoleId, created, providedChannel = null) {
  if (providedChannel) return providedChannel;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildText && channel.name === LOG_CHANNEL_NAME
  );

  if (existing) {
    await existing.permissionOverwrites.set(overwrites, `${BRAND_NAME}: log channel access`);
    return existing;
  }

  const channel = await guild.channels.create({
    name: LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `${BRAND_NAME} | Archive of every closed ticket`,
    permissionOverwrites: overwrites,
    reason: `${BRAND_NAME}: log channel`
  });

  created.channels.push(channel.name);
  return channel;
}

// Publishes or updates one flow's panel. Editing in place keeps a single panel
// per flow; if the panel moved channels the previous message is deleted, since
// it still carries a working menu.
async function publishFlowPanel(guild, config, flow, channel, prevChannelId, prevMessageId, created) {
  const menu = buildPanelMenu(config, flow);
  if (!menu) return null;

  const payload = {
    embeds: [buildPanelEmbed(config, flow)],
    components: [menu]
  };

  if (prevMessageId && prevChannelId === channel.id) {
    const existing = await channel.messages.fetch(prevMessageId).catch(() => null);
    if (existing) return existing.edit(payload);
  } else if (prevMessageId && prevChannelId) {
    const oldChannel = await guild.channels.fetch(prevChannelId).catch(() => null);
    const oldMessage = oldChannel?.isTextBased()
      ? await oldChannel.messages.fetch(prevMessageId).catch(() => null)
      : null;

    if (oldMessage) {
      await oldMessage.delete().catch((error) => {
        console.error('Failed to remove a previous ticket panel:', error?.message || error);
      });
      created.removed.push(`old ${flowMeta(flow).label} panel in #${oldChannel.name}`);
    }
  }

  try {
    return await channel.send(payload);
  } catch (error) {
    const missing = missingChannelPermissions(channel);
    created.warnings.push(
      `I could not post the ticket panel in <#${channel.id}>` +
      (missing.length ? ` -- I am missing **${missing.join(', ')}** there.` : '.') +
      ` Fix that and run /quick-setup again; everything else is already set up.`
    );
    console.error(`Failed to publish the panel in ${channel.id}:`, error?.message || error);
    return null;
  }
}

// Interaction-free so the self-test can drive it directly.
// An existing channel handed to us belongs to the server, not to this bot, so
// its permissions are added to rather than replaced. Wiping the overwrites on a
// channel a live community already uses would be destructive and is never worth
// the tidiness.
// What the bot must be able to do in a channel it was handed.
const CHANNEL_ESSENTIALS = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory]
];

function missingChannelPermissions(channel) {
  const me = channel.guild.members.me;
  const perms = channel.permissionsFor(me);
  return CHANNEL_ESSENTIALS.filter(([, flag]) => !perms?.has(flag)).map(([label]) => label);
}

async function reconcileProvidedChannel(channel, { staffRoleId, isLog }) {
  const warnings = [];

  // Discord only lets you put a permission into an overwrite if you already
  // hold it in that channel, so a channel that denies the bot something it
  // needs cannot be repaired by the bot -- it has to be reported instead.
  try {
    await channel.permissionOverwrites.edit(client.user.id, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
      ReadMessageHistory: true,
      ManageMessages: true
    }, { reason: `${BRAND_NAME}: bot access` });
  } catch (error) {
    const missing = missingChannelPermissions(channel);
    warnings.push(
      `I could not grant myself access in <#${channel.id}>` +
      (missing.length ? ` because I do not have **${missing.join(', ')}** there.` : '.') +
      ` Give my role those permissions on that channel, then run /quick-setup again.`
    );
    console.error(
      `Could not self-grant in ${channel.id}: missing ${missing.join(", ") || "unknown"}`
    );
  }

  if (isLog) {
    if (staffRoleId) {
      try {
        await channel.permissionOverwrites.edit(staffRoleId, {
          ViewChannel: true,
          ReadMessageHistory: true
        }, { reason: `${BRAND_NAME}: staff read access to the ticket log` });
      } catch (error) {
        warnings.push(
          `I could not give <@&${staffRoleId}> read access to <#${channel.id}>. ` +
          'Grant it manually so staff can see the archive.'
        );
      }
    }

    const everyone = channel.guild.roles.everyone;
    if (channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      warnings.push(
        `<#${channel.id}> is visible to @everyone. Closed-ticket transcripts are ` +
        'posted there, so make it staff-only unless that is intended.'
      );
    }
  }

  return warnings;
}

// Discord orders categories by position among themselves. To drop ours directly
// above an anchor category, everything is renumbered in one call with the
// existing relative order preserved.
async function positionCategoriesAbove(guild, categoryIds, anchorId) {
  if (!anchorId || !categoryIds.length) return null;

  const anchor = guild.channels.cache.get(anchorId);
  if (anchor?.type !== ChannelType.GuildCategory) {
    return { ok: false, reason: 'anchor_not_a_category' };
  }

  const ours = new Set(categoryIds);
  const categories = [...guild.channels.cache.values()]
    .filter((channel) => channel?.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  const before = [];
  const after = [];
  let passedAnchor = false;

  for (const category of categories) {
    if (category.id === anchorId) { passedAnchor = true; continue; }
    if (ours.has(category.id)) continue;
    (passedAnchor ? after : before).push(category);
  }

  const ordered = [
    ...before,
    ...categoryIds.map((id) => guild.channels.cache.get(id)).filter(Boolean),
    anchor,
    ...after
  ];

  try {
    await guild.channels.setPositions(
      ordered.map((channel, index) => ({ channel: channel.id, position: index }))
    );
    return { ok: true, moved: categoryIds.length, anchor: anchor.name };
  } catch (error) {
    console.error('Failed to reorder ticket categories:', error?.message || error);
    return { ok: false, reason: 'reorder_failed', error };
  }
}

// Interaction-free so the self-test can drive it directly.
async function provisionGuild(guild, options = {}) {
  const created = { roles: [], categories: [], channels: [], removed: [], warnings: [] };
  const flows = (options.flows?.length ? options.flows : ENABLED_FLOWS)
    .filter((flow) => flow === FLOW_NEW || flow === FLOW_CLASSIC);
  const useModern = flows.includes(FLOW_NEW);
  const useClassic = flows.includes(FLOW_CLASSIC);

  if (!useModern && !useClassic) throw new Error('No ticket flows are enabled.');

  for (const provided of [options.panelChannel, options.classicPanelChannel, options.logChannel]) {
    if (!provided) continue;
    const missing = missingChannelPermissions(provided);
    if (missing.length) {
      console.warn(`Bot is missing ${missing.join(", ")} in #${provided.name} (${provided.id}).`);
    }
  }

  const staffRole = await ensureStaffRole(guild, options.staffRole || null, created);

  // Only needed as a parent for channels this run actually creates.
  const needsSupportCategory =
    (useModern && !options.panelChannel) ||
    (useClassic && !options.classicPanelChannel) ||
    !options.logChannel;
  const supportCategory = needsSupportCategory
    ? await ensureSupportCategory(guild, created)
    : null;

  const sections = [];
  const ticketCategoryIds = [];
  const stamp = Date.now();

  if (useModern) {
    const sharedModern = options.singleCategory
      ? await ensureTicketCategory(guild, TICKET_CATEGORY_NAME, created)
      : null;

    for (const [index, template] of DEFAULT_SECTIONS.entries()) {
      const category = sharedModern
        || await ensureTicketCategory(guild, `${template.emoji} ${template.name}`, created);

      if (!ticketCategoryIds.includes(category.id)) ticketCategoryIds.push(category.id);

      sections.push({
        id: `n${stamp}${index}`,
        name: template.name,
        emoji: template.emoji,
        categoryId: category.id,
        roleIds: [staffRole.id],
        flow: FLOW_NEW
      });
    }
  }

  if (useClassic) {
    const classicCategory = await ensureClassicCategory(guild, staffRole.id, created);
    if (!ticketCategoryIds.includes(classicCategory.id)) ticketCategoryIds.push(classicCategory.id);

    for (const [index, template] of DEFAULT_SECTIONS.entries()) {
      sections.push({
        id: `c${stamp}${index}`,
        name: template.name,
        emoji: template.emoji,
        categoryId: classicCategory.id,
        roleIds: [staffRole.id],
        flow: FLOW_CLASSIC
      });
    }
  }

  const supportCategoryId = supportCategory?.id ?? null;
  const panelChannel = useModern
    ? await ensurePanelChannel(guild, options.panelChannel || null, FLOW_NEW, supportCategoryId, created)
    : null;
  const classicPanelChannel = useClassic
    ? await ensurePanelChannel(guild, options.classicPanelChannel || null, FLOW_CLASSIC, supportCategoryId, created)
    : null;
  const logChannel = await ensureLogChannel(
    guild, supportCategoryId, staffRole.id, created, options.logChannel || null
  );

  // Existing channels get additive permission fixes only.
  for (const [channel, isLog] of [[options.panelChannel, false], [options.classicPanelChannel, false], [options.logChannel, true]]) {
    if (!channel) continue;
    created.warnings.push(...await reconcileProvidedChannel(channel, { staffRoleId: staffRole.id, isLog }));
  }

  const anchorId = options.anchorCategoryId || ANCHOR_CATEGORY_ID;
  const positioned = anchorId
    ? await positionCategoriesAbove(
        guild,
        [supportCategoryId, ...ticketCategoryIds].filter(Boolean),
        anchorId
      )
    : null;

  if (positioned && !positioned.ok) {
    created.warnings.push(`Could not place the categories above the anchor (${positioned.reason}).`);
  }

  const existing = getGuildConfig(guild.id);
  const config = ensureTicketInstance({
    ...(existing || {}),
    title: null,
    description: null,
    color: null,
    thumbnailUrl: null,
    imageUrl: null,
    sections,
    logChannelId: logChannel.id,
    ticketCounter: Number(existing?.ticketCounter) || 2000
  });

  const modernPanel = panelChannel
    ? await publishFlowPanel(guild, config, FLOW_NEW, panelChannel, existing?.channelId, existing?.messageId, created)
    : null;
  const classicPanel = classicPanelChannel
    ? await publishFlowPanel(guild, config, FLOW_CLASSIC, classicPanelChannel,
        existing?.classicChannelId, existing?.classicMessageId, created)
    : null;

  const saved = setGuildConfig(guild.id, {
    ...config,
    channelId: panelChannel?.id || null,
    messageId: modernPanel?.id || null,
    classicChannelId: classicPanelChannel?.id || null,
    classicMessageId: classicPanel?.id || null,
    updatedAt: new Date().toISOString()
  });

  console.log(
    `Provisioned ${guild.id}: flows=${flows.join('+')} sections=${sections.length} ` +
    `roles=${created.roles.length} categories=${created.categories.length} ` +
    `channels=${created.channels.length} removed=${created.removed.length} ` +
    `positioned=${positioned?.ok ? 'yes' : 'no'}`
  );

  return {
    created, flows, staffRole, supportCategory, positioned,
    panelChannel, classicPanelChannel, logChannel, sections, config: saved
  };
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

  const result = await provisionGuild(guild, {
    staffRole: interaction.options.getRole('staff_role') || await resolveConfiguredRole(guild),
    panelChannel: interaction.options.getChannel('panel_channel')
      || await resolveConfiguredChannel(guild, PANEL_CHANNEL_ID),
    logChannel: interaction.options.getChannel('log_channel')
      || await resolveConfiguredChannel(guild, LOG_CHANNEL_ID),
    anchorCategoryId: interaction.options.getChannel('anchor_category')?.id || ANCHOR_CATEGORY_ID,
    singleCategory: interaction.options.getBoolean('single_category') ?? false
  });

  const { created } = result;
  const line = (label, items) => (items.length ? `${label}: ${items.join(', ')}` : `${label}: none`);
  const flowLines = [];

  if (result.panelChannel) {
    flowLines.push(`${flowMeta(FLOW_NEW).emoji} **${flowMeta(FLOW_NEW).label}**: <#${result.panelChannel.id}>`);
  }
  if (result.classicPanelChannel) {
    flowLines.push(`${flowMeta(FLOW_CLASSIC).emoji} **${flowMeta(FLOW_CLASSIC).label}**: <#${result.classicPanelChannel.id}>`);
  }

  await interaction.editReply({
    content: [
      `**${BRAND_NAME}** is ready in **${guild.name}**.`,
      '',
      ...flowLines,
      `Ticket log: <#${result.logChannel.id}>`,
      `Staff role: <@&${result.staffRole.id}>`,
      `Sections: ${result.sections.length}`,
      result.positioned?.ok
        ? `Categories placed above **${result.positioned.anchor}**.`
        : '',
      '',
      line('Roles created', created.roles),
      line('Categories created', created.categories),
      line('Channels created', created.channels),
      line('Cleaned up', created.removed),
      '',
      `Add your staff to <@&${result.staffRole.id}> so they get ticket access.`,
      ...(created.warnings.length ? ['', '**Warnings**', ...created.warnings.map((w) => '- ' + w)] : []),
      ...(missingOptionalBotPermissions(guild).length
        ? [
            '',
            `Note: I do not have **${missingOptionalBotPermissions(guild).join(', ')}**, ` +
            'so ticket controls will not be pinned. Everything else works. ' +
            'Re-invite with that permission to restore pinning.'
          ]
        : [])
    ].filter((l) => l !== '').join('\n')
  });
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Ticket bot build: ${BUILD_ID}`);
  resumePendingRenames().catch((error) => {
    console.error('Failed to resume pending ticket renames:', error);
  });
  console.log(`Automatic ticket refresh interval: ${REFRESH_INTERVAL_MINUTES} minutes`);

  if (BOT_ACTIVITY) {
    readyClient.user.setPresence({
      status: 'online',
      activities: [{ name: BOT_ACTIVITY, type: ActivityType.Custom, state: BOT_ACTIVITY }]
    });
    console.log(`Presence set to: ${BOT_ACTIVITY}`);
  }
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

        if (getTicketFlow(channel) === FLOW_CLASSIC) {
          const closed = await closeTicketChannel(channel);
          await tryUpdatePinnedTicketControls(channel, 'closed', getTicketClaimedBy(channel));
          await channel
            .send({
              embeds: buildClosedTicketEmbeds(interaction.user.id),
              components: buildClosedTicketControls()
            })
            .catch(() => {});

          await interaction.editReply({
            content: `Classic ticket closed. Rename queued to \`${closed.nextName}\`. ` +
              'The channel stays in place; use Open, Transcript or Delete on it.'
          });
          return;
        }

        const result = await closeAndArchiveTicket(channel, interaction.user.id);

        await channel
          .send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xffff00)
                .setTitle('Ticket closed')
                .setDescription(
                  `Closed by <@${interaction.user.id}>.\n\n` +
                  `This channel will be deleted in ${Math.round(TICKET_DELETE_DELAY_MS / 1000)} seconds.`
                )
            ]
          })
          .catch(() => {});

        await interaction.editReply({
          content: result.logged.ok
            ? `Ticket #${result.ticketNumber} archived to the log channel. The channel will be deleted shortly.`
            : `Ticket #${result.ticketNumber} is being deleted, but no log channel is configured so nothing was archived. Run /quick-setup.`
        });
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

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:panel')) {
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

      const selectedSection = config.sections.find((item) => item.id === sectionId);
      if (!selectedSection) {
        await interaction.reply({
          content: 'That ticket category is not configured anymore. Ask an admin to refresh the panel.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const existingTicket = await findExistingMemberTicket(
        interaction.guild, interaction.user.id, config, sectionFlow(selectedSection)
      );
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

          const claimFlow = getTicketFlow(interaction.channel);

          await interaction.message.edit({
            embeds: [embed],
            components: buildTicketControls('open', interaction.user.id, claimFlow)
          });

          const claimTicketNumber = getTicketNumber(interaction.channel) || 'unknown';
          // Only the modern flow notifies the member; the classic one never did.
          if (flowMeta(claimFlow).notifiesByDm) {
            await dmUser(getTicketOwnerId(interaction.channel), {
            embeds: [
              new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle(`Ticket #${claimTicketNumber} is being handled`)
                .setDescription(
                  `<@${interaction.user.id}> has claimed your ticket in ` +
                  `**${interaction.guild.name}** and is working on it now.\n\n` +
                  `Channel: <#${interaction.channel.id}>`
                )
                .setFooter({ text: BRAND_FOOTER })
                .setTimestamp()
            ]
            }, 'ticket claimed notice');
          }

          await interaction.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x2ecc71)
                .setDescription(
                  `Claimed by <@${interaction.user.id}>. This ticket is now under process.`
                )
            ]
          }).catch(() => {});
          return;
        }

        if (interaction.customId === 'ticket:close') {
          await interaction.deferUpdate();
          const channel = await fetchFreshTicketChannel(interaction);
          const closeFlow = getTicketFlow(channel);

          await interaction.message
            .edit({ components: buildTicketBusyControls('Closing...') })
            .catch(() => {});

          if (closeFlow === FLOW_CLASSIC) {
            // Original behaviour: rename to closed-<number>, revoke the
            // opener, and leave the channel standing as its own archive.
            const closed = await closeTicketChannel(channel);
            const classicClaimedBy = getTicketClaimedBy(channel) || claimedBy;

            await interaction.message
              .edit({
                components: buildTicketControls('closed', classicClaimedBy, FLOW_CLASSIC)
              })
              .catch(() => {});

            await channel
              .send({
                embeds: buildClosedTicketEmbeds(interaction.user.id),
                components: buildClosedTicketControls()
              })
              .catch(() => {});

            console.log(
              `Classic ticket closed: ${channel.id} by ${interaction.user.id}; ` +
              `rename queued to #${closed.nextName}`
            );
            return;
          }

          const result = await closeAndArchiveTicket(channel, interaction.user.id);

          await channel
            .send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0xffff00)
                  .setTitle('Ticket closed')
                  .setDescription(
                    `Closed by <@${interaction.user.id}>.\n` +
                    (result.logged.ok
                      ? 'A full archive has been saved to the ticket log.'
                      : 'WARNING: no log channel is configured, so nothing was archived. Run /quick-setup.') +
                    `\n\nThis channel will be deleted in ${Math.round(TICKET_DELETE_DELAY_MS / 1000)} seconds.`
                  )
              ]
            })
            .catch(() => {});
          return;
        }

        // The three controls below only ever appear on a closed classic
        // ticket. A modern ticket is deleted on close, so it has no way to
        // reach them.
        if (interaction.customId === 'ticket:reopen') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = await fetchFreshTicketChannel(interaction);

          const reopened = await reopenTicketChannel(channel);
          const reopenedChannel = reopened.channel || channel;
          const reopenClaimedBy = getTicketClaimedBy(reopenedChannel) || claimedBy;

          tryUpdatePinnedTicketControls(reopenedChannel, 'open', reopenClaimedBy);

          await interaction.message
            .edit({
              embeds: [buildClosedTicketSummaryEmbed(interaction.user.id)],
              components: []
            })
            .catch(() => {});

          await reopenedChannel
            .send({ embeds: [buildOpenedTicketEmbed(interaction.user.id)] })
            .catch(() => {});

          await interaction.editReply({
            content: `Ticket reopened. Rename queued to \`${reopened.nextName}\` ` +
              '(Discord rate-limits renames, so it may take a few minutes).'
          });
          return;
        }

        if (interaction.customId === 'ticket:transcript') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = await fetchFreshTicketChannel(interaction);
          const result = await sendTicketTranscript(channel);

          await interaction.editReply({
            content:
              `Transcript built from ${result.totalMessages} message(s). ` +
              `Delivered to ${result.delivered.length}, failed for ${result.failed.length}.`
          });
          return;
        }

        if (interaction.customId === 'ticket:delete') {
          await interaction.reply({
            content: `Deleting this channel in ${Math.round(TICKET_DELETE_DELAY_MS / 1000)} seconds...`,
            flags: MessageFlags.Ephemeral
          });
          const channel = await fetchFreshTicketChannel(interaction);

          setTimeout(() => {
            channel
              .delete(`Classic ticket deleted by ${interaction.user.tag}`)
              .catch((error) => {
                console.error(`Failed to delete ticket channel ${channel.id}:`, error?.message || error);
              });
          }, TICKET_DELETE_DELAY_MS);
          return;
        }

        await interaction.reply({
          content: 'Unknown ticket button, or this message is out of date. Run /tickets-refresh to rebuild it.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!interaction.customId.startsWith('setup:')) return;

      if (!hasGuildManagerPermission(interaction)) {
        await interaction.reply({
          content: 'You need the Manage Server permission to use this command.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

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
      if (!hasGuildManagerPermission(interaction)) {
        await interaction.reply({
          content: 'You need the Manage Server permission to use this command.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

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
      if (!hasGuildManagerPermission(interaction)) {
        await interaction.reply({
          content: 'You need the Manage Server permission to use this command.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

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

// Exposed so src/selftest.js can drive the real code paths against a live
// guild instead of re-implementing them.
module.exports = {
  client,
  FLOW_NEW,
  FLOW_CLASSIC,
  flowMeta,
  sectionFlow,
  getTicketFlow,
  provisionGuild,
  notifyStaffOfNewTicket,
  collectStaffRecipients,
  BRAND_FOOTER,
  ENABLE_GUILD_MEMBERS,
  positionCategoriesAbove,
  reconcileProvidedChannel,
  ENABLED_FLOWS,
  BOT_ACTIVITY,
  createTicket,
  closeAndArchiveTicket,
  closeTicketChannel,
  reopenTicketChannel,
  getTicketOwnerId,
  getTicketNumber,
  getTicketClaimedBy,
  trySetTicketTopicValue,
  findExistingMemberTicket,
  findTicketControlMessage,
  buildClosedTicketCard,
  createReasonModal,
  buildTranscriptText,
  TRANSCRIPT_SEND_TO_OWNER,
  buildClosedTicketLink,
  getTicketControlMessageId,
  missingBotPermissions,
  missingChannelPermissions,
  missingOptionalBotPermissions,
  updatePinnedTicketControls,
  getGuildConfig,
  TICKET_DELETE_DELAY_MS,
  CLASSIC_CATEGORY_NAME,
  SUPPORT_CATEGORY_NAME,
  LOG_CHANNEL_NAME,
  DEFAULT_SECTIONS
};

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Discord login failed:', error);
});
