require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

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
  DATA_DIR,
  ensureDb,
  getAllGuildConfigs,
  getGuildConfig,
  setGuildConfig,
  updateGuildConfig
} = require('./storage');

const streamerApplications = require('./streamerApplications');
const adminApplication = require('./adminApplication');

const BRAND_NAME = 'Enclave Tickets';
const BRAND_COLOR = 0x90773E;
const BUILD_ID = 'enclave-tickets-2026-08-21-v4';
const TICKET_MARKER = 'Enclave Tickets | Ticket';

// Every member-facing embed carries the same footer.
const BRAND_TAGLINE = (process.env.BRAND_TAGLINE || 'Discord Manager').trim();
const BRAND_FOOTER = `${BRAND_NAME} | ${BRAND_TAGLINE}`;

// Presentation for the ticket panel.
const PANEL_EMOJI = '🎫';
const PANEL_TITLE = `${PANEL_EMOJI} Enclave Tickets - تذاكر الدعم`;
const PANEL_DESCRIPTION =
  'Pick the category that matches your issue. You will get a private channel and a direct message confirming it.\n\n' +
  'اختر الفئة التي تطابق مشكلتك. ستحصل على قناة خاصة ورسالة مباشرة تؤكد ذلك.';
const REFRESH_INTERVAL_MINUTES = Math.max(
  5,
  Number.parseInt(process.env.TICKET_REFRESH_INTERVAL_MINUTES || '30', 10) || 30
);

// Panel language picker. The category list itself is re-rendered in whichever
// of these the member picks; everything after that (the ticket channel, its
// embeds, the transcript) stays in the section's own configured name.
const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English', emoji: '🇬🇧' },
  { value: 'ar', label: 'العربية', emoji: '🇴🇲' }
];

const UI_STRINGS = {
  en: {
    languagePrompt: 'Select the category that matches your issue:',
    chooseCategory: 'Select a Category',
    categoryDescription: (name) => `Open a ${name} ticket`,
    reasonModalTitle: 'Open Ticket',
    reasonLabel: 'Write your concern:',
    rateLimited: (limit) =>
      `You have reached the daily limit of ${limit} tickets. You can open another after 00:00 (Oman time).`,
    setupMissing: 'Ticket setup is not ready yet. Please ask an admin.',
    sectionGone: 'That ticket category is not configured anymore. Ask an admin to refresh the panel.',
    alreadyOpen: (channelId) => `You already have an open ticket: <#${channelId}>`,
    openedTitle: (number) => `Ticket #${number} created`,
    openedBody: (sectionName, guildName, channelId) =>
      `Your **${sectionName}** ticket in **${guildName}** is open.\n\n` +
      `Channel: <#${channelId}>\n\n` +
      'The support team has been notified. You will get another message here when a staff member picks it up.',
    yourMessage: 'Your message',
    dmFailed: 'I could not DM you a confirmation. Enable direct messages from server members if you want ticket updates.',
    openedBy: 'Opened by',
    category: 'Category',
    ticketNumber: 'Ticket number',
    openedAt: 'Opened at',
    claimedTitle: (number) => `Ticket #${number} is being handled`,
    claimedBody: (staffId, guildName, channelId, hours) =>
      `<@${staffId}> has claimed your ticket in **${guildName}** and is working on it now.\n\n` +
      `Channel: <#${channelId}>\n\n` +
      `Please reply within the next **${hours} hours** -- ` +
      'if there is no reply from you in that time, this ticket will be closed automatically.',
    closedTitle: 'Ticket Closed',
    closedOpenedBy: 'Opened By',
    closedClaimedBy: 'Claimed By',
    closedClosedBy: 'Closed By',
    closedOpenTime: 'Open Time',
    closedCloseTime: 'Close Time',
    noOne: 'No one',
    unknown: 'Unknown',
    viewTicket: 'View Ticket',
    openNewTicket: 'Open a New Ticket'
  },
  ar: {
    languagePrompt: 'اختر الفئة التي تطابق مشكلتك:',
    chooseCategory: 'اختر الفئة',
    categoryDescription: (name) => `فتح تذكرة ${name}`,
    reasonModalTitle: 'فتح تذكرة',
    reasonLabel: 'اكتب استفسارك:',
    rateLimited: (limit) =>
      `لقد وصلت إلى الحد الأقصى اليومي وهو ${limit} تذاكر. يمكنك فتح تذكرة أخرى بعد الساعة ٠٠:٠٠ بتوقيت عمان.`,
    setupMissing: 'نظام التذاكر غير جاهز بعد. يرجى التواصل مع الإدارة.',
    sectionGone: 'هذه الفئة لم تعد متاحة. يرجى الطلب من الإدارة تحديث اللوحة.',
    alreadyOpen: (channelId) => `لديك تذكرة مفتوحة بالفعل: <#${channelId}>`,
    openedTitle: (number) => `تم إنشاء التذكرة رقم #${number}`,
    openedBody: (sectionName, guildName, channelId) =>
      `تم فتح تذكرتك في قسم **${sectionName}** في سيرفر **${guildName}**.\n\n` +
      `القناة: <#${channelId}>\n\n` +
      'تم إشعار فريق الدعم. ستصلك رسالة أخرى هنا عندما يستلم أحد أعضاء الفريق تذكرتك.',
    yourMessage: 'رسالتك',
    dmFailed: 'لم أتمكن من إرسال رسالة تأكيد لك. فعّل الرسائل المباشرة من أعضاء السيرفر إذا كنت تريد تحديثات التذكرة.',
    openedBy: 'فتحها',
    category: 'الفئة',
    ticketNumber: 'رقم التذكرة',
    openedAt: 'وقت الفتح',
    claimedTitle: (number) => `جاري العمل على التذكرة رقم #${number}`,
    claimedBody: (staffId, guildName, channelId, hours) =>
      `قام <@${staffId}> باستلام تذكرتك في سيرفر **${guildName}** ويعمل عليها الآن.\n\n` +
      `القناة: <#${channelId}>\n\n` +
      `يرجى الرد خلال **${hours} ساعة** -- ` +
      'إذا لم يصل رد منك خلال هذه المدة، سيتم إغلاق التذكرة تلقائياً.',
    closedTitle: 'تم إغلاق التذكرة',
    closedOpenedBy: 'فتحها',
    closedClaimedBy: 'استلمها',
    closedClosedBy: 'أغلقها',
    closedOpenTime: 'وقت الفتح',
    closedCloseTime: 'وقت الإغلاق',
    noOne: 'لا أحد',
    unknown: 'غير معروف',
    viewTicket: 'عرض التذكرة',
    openNewTicket: 'فتح تذكرة جديدة'
  }
};

function t(lang) {
  return UI_STRINGS[resolveLang(lang)];
}

function resolveLang(value) {
  return value === 'ar' ? 'ar' : 'en';
}

// Only the section names shipped by /quick-setup have a known Arabic label.
// A section added later via /ticket-section-add keeps whatever name staff
// gave it in both languages -- there is nowhere to store a translation for it.
const SECTION_NAME_TRANSLATIONS = {
  'Inquiries': 'استفسارات',
  'Technical Issue': 'مشكلة تقنية',
  'Reports': 'بلاغات',
  'Ban Appeal': 'استئناف حظر',
  'Compensation': 'تعويض',
  'Store': 'المتجر',
  'Streamer Application': 'طلب انضمام كستريمر'
};

function translateSectionName(name, lang) {
  if (lang !== 'ar') return name;
  return SECTION_NAME_TRANSLATIONS[name] || name;
}

// Oman does not observe daylight saving, so a fixed UTC+4 offset is exact.
const OMAN_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

function omanDateKey(date = new Date()) {
  return new Date(date.getTime() + OMAN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

// Real admins and the guild owner are exempt from the daily ticket cap;
// everyone else -- including ticket staff without Administrator -- is not.
function isTicketRateLimitExempt(interaction) {
  if (interaction.guild.ownerId === interaction.user.id) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

const TICKET_DAILY_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.TICKET_DAILY_LIMIT || '3', 10) || 3
);

// Read-modify-write is safe without an extra lock: readDb/writeDb are
// synchronous fs calls, so nothing else can interleave between the read and
// the write within a single call.
function consumeTicketRateLimit(guildId, userId, maxPerDay) {
  const today = omanDateKey();
  let allowed = false;
  let remaining = 0;

  updateGuildConfig(guildId, (config) => {
    if (!config) return null;

    const rateLimits = { ...(config.ticketRateLimits || {}) };
    const entry = rateLimits[userId];
    const current = entry && entry.day === today ? entry.count : 0;

    if (current >= maxPerDay) {
      allowed = false;
      return null;
    }

    allowed = true;
    remaining = maxPerDay - (current + 1);
    rateLimits[userId] = { day: today, count: current + 1 };
    return { ...config, ticketRateLimits: rateLimits };
  });

  return { allowed, remaining };
}

// How long a member has to reply after their ticket is claimed before it is
// closed automatically. Checked on the same cadence as the maintenance sweep
// (TICKET_REFRESH_INTERVAL_MINUTES), so lower that if tighter precision on
// the deadline matters more than the extra Discord API traffic.
const CLAIM_RESPONSE_TIMEOUT_MS = Math.max(
  1,
  Number.parseInt(process.env.CLAIM_RESPONSE_TIMEOUT_HOURS || '12', 10) || 12
) * 60 * 60 * 1000;

// In-memory only: the last time the ticket owner (not staff) posted in their
// own ticket after it was claimed. Reset by a bot restart, which is treated as
// "no activity since claim" -- the conservative direction, since the topic's
// claimedAt is the fallback floor rather than a precise clock.
const ticketOwnerActivity = new Map();

// A deployment serves exactly one guild, but nothing below filters on it --
// this process handles every guild the application is in. Two processes
// sharing one bot token (a demo instance beside production, say) would then
// both answer production's interactions, duplicating tickets and DMs. Setting
// GUILD_ID confines this process to that guild; leaving it unset keeps the
// old behaviour of serving them all.
const ALLOWED_GUILD_ID = process.env.GUILD_ID || null;

function isAllowedGuild(guildId) {
  return !ALLOWED_GUILD_ID || guildId === ALLOWED_GUILD_ID;
}

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

// Whether the member who opened a ticket receives their own transcript when
// it closes. The ticket log is staff-only and Discord cannot show a member
// just their own entry in it, so this is how they get their record.
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

// GuildMessages is not privileged (no Developer Portal toggle needed); it is
// what lets MessageCreate fire at all, which the claim-response timeout needs
// to see the ticket owner reply. It does not by itself expose message text --
// that still needs the privileged MessageContent intent below.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (ENABLE_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);
if (ENABLE_GUILD_MEMBERS) intents.push(GatewayIntentBits.GuildMembers);

const client = new Client({ intents });

// dmUser, closeAndArchiveTicket and updateSavedPanel are function
// declarations defined further down this file; referencing them here is
// safe because declarations are hoisted, and init() itself only stores the
// references for later use rather than calling them immediately.
streamerApplications.init({
  client,
  dmUser,
  closeAndArchiveTicket,
  createTicket,
  isTicketRateLimitExempt,
  consumeTicketRateLimit,
  setGuildConfig,
  BRAND_COLOR,
  BRAND_FOOTER
});

adminApplication.init({
  client,
  dmUser,
  collectStaffRecipients,
  setGuildConfig,
  BRAND_COLOR,
  BRAND_FOOTER
});

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

// Drops keys left behind by an older layout so a config that has been through
// an upgrade does not carry dead fields around forever.
function stripLegacyConfigKeys(config) {
  const next = { ...config };
  for (const key of ['classicChannelId', 'classicMessageId']) delete next[key];
  return next;
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

// Feeds the claim-response timeout: only the ticket owner's own messages
// reset their clock, so staff chatting in the channel does not.
client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.author?.bot) return;
  if (!isAllowedGuild(message.guild.id)) return;
  if (!isTicketChannel(message.channel)) return;
  if (getTicketOwnerId(message.channel) !== message.author.id) return;
  ticketOwnerActivity.set(message.channel.id, Date.now());
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

// Custom panel banner images (uploaded via a slash command attachment option)
// are saved to disk here rather than kept as the Discord CDN URL Discord
// handed back at upload time -- that URL is signed and expires in about a
// day, so a config that stored it verbatim would quietly break the panel the
// next time it rendered. Keeping our own copy and re-attaching it to whatever
// message we send avoids depending on that URL ever again.
const PANEL_IMAGES_DIR = path.join(DATA_DIR, 'panel-images');
const MAX_PANEL_IMAGE_BYTES = 8 * 1024 * 1024;

// Ships with the code, so every guild gets the designed banner with zero
// setup; a guild can still override it with its own upload via
// /ticket-panel's `image` option, which takes priority when present.
const DEFAULT_SUPPORT_PANEL_IMAGE = path.join(__dirname, '..', 'assets', 'panel-support.png');

function ensurePanelImagesDir() {
  if (!fs.existsSync(PANEL_IMAGES_DIR)) fs.mkdirSync(PANEL_IMAGES_DIR, { recursive: true });
}

async function downloadPanelImage(attachment, filenamePrefix) {
  if (!attachment.contentType?.startsWith('image/')) {
    throw new Error('That attachment is not an image.');
  }
  if (attachment.size > MAX_PANEL_IMAGE_BYTES) {
    throw new Error(`Image is too large (max ${Math.floor(MAX_PANEL_IMAGE_BYTES / 1024 / 1024)} MB).`);
  }

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Failed to download attachment: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  const ext = (path.extname(attachment.name || '') || '.png').toLowerCase();
  ensurePanelImagesDir();
  const filename = `${filenamePrefix}${ext}`;
  fs.writeFileSync(path.join(PANEL_IMAGES_DIR, filename), buffer);
  return filename;
}

// Builds the { attachment, name } pair every send/edit call needs to both
// upload the file and reference it from the embed via attachment://<name>.
// Falls back to the bundled default banner when no per-guild upload exists.
function resolvePanelImageAttachment(filename) {
  const filePath = filename ? path.join(PANEL_IMAGES_DIR, filename) : DEFAULT_SUPPORT_PANEL_IMAGE;
  if (!fs.existsSync(filePath)) return null;

  const name = `panel-image${path.extname(filePath) || '.png'}`;
  return { attachment: new AttachmentBuilder(filePath, { name }), name };
}

function buildPanelEmbed(config, imageAttachment = null) {
  const custom = config || {};
  const hasImage = Boolean(imageAttachment) || isHttpUrl(custom.imageUrl);

  const embed = new EmbedBuilder().setColor(custom.color || BRAND_COLOR);

  // A banner image already carries everything -- title, description,
  // branding -- baked in as artwork, so when one is set the embed shows
  // nothing else: just the image, with the panel's own menu below it.
  if (hasImage) {
    if (imageAttachment) {
      embed.setImage(`attachment://${imageAttachment.name}`);
    } else {
      embed.setImage(custom.imageUrl);
    }
    return embed;
  }

  embed
    .setTitle(custom.title || PANEL_TITLE)
    .setDescription(custom.description || PANEL_DESCRIPTION)
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();

  // The bot's own avatar is a Discord-hosted image, so the panel gets
  // artwork without depending on some external host staying up.
  const icon = client.user?.displayAvatarURL({ size: 256 });
  if (icon) embed.setThumbnail(icon);
  if (isHttpUrl(custom.thumbnailUrl)) embed.setThumbnail(custom.thumbnailUrl);

  return embed;
}

// The panel's own select menu is only ever the language picker; picking a
// category happens one ephemeral step later, in whichever language was
// chosen (see buildCategoryMenu).
function buildPanelMenu(config) {
  const sections = config.sections || [];

  // Discord rejects a select menu with no options, so callers must skip
  // publishing rather than send a broken panel.
  if (!sections.length) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:language')
    .setPlaceholder('Choose your language - اختر لغتك المفضلة');

  for (const option of LANGUAGE_OPTIONS) {
    menu.addOptions({ label: option.label, value: option.value, emoji: option.emoji });
  }

  return new ActionRowBuilder().addComponents(menu);
}

function buildCategoryMenu(config, lang) {
  const sections = config.sections || [];
  if (!sections.length) return null;

  const t = UI_STRINGS[resolveLang(lang)];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket:category:${resolveLang(lang)}`)
    .setPlaceholder(t.chooseCategory);

  for (const section of sections.slice(0, 25)) {
    const sectionEmoji = parseSectionEmoji(section.emoji);
    const label = translateSectionName(section.name, lang);
    menu.addOptions({
      label: label.slice(0, 100),
      value: section.id,
      emoji: sectionEmoji?.menu,
      description: t.categoryDescription(label).slice(0, 100)
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

function createReasonModal(sectionId, lang = 'en') {
  const t = UI_STRINGS[resolveLang(lang)];
  return new ModalBuilder()
    .setCustomId(`ticket:reason:${sectionId}:${resolveLang(lang)}`)
    .setTitle(t.reasonModalTitle)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel(t.reasonLabel)
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
  'tickets-refresh',
  'streamer-setup',
  'admin-application-setup'
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
  const info = getTicketStateEntry(channel)?.info || '';
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
          .setValue(info.trim())
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
  const cleanInfo = String(info || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  await setTicketState(channel, { info: cleanInfo });
}

function buildTicketControls(status = 'open', claimedBy = null) {
  const isClosed = status === 'closed';
  const closeLabel = 'Close & Delete';

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
  await migrateLegacyTicketTopicIfNeeded(channel);

  const status = getTicketStatus(channel) === 'closed' || channel.name.startsWith('closed-')
    ? 'closed'
    : 'open';
  const claimedBy = getTicketClaimedBy(channel);

  if (status === 'open' && claimedBy) {
    const claimedAt = getTicketClaimedAt(channel);
    if (claimedAt) {
      const lastActivity = await resolveTicketOwnerActivity(channel, claimedAt);
      if (Date.now() - lastActivity >= CLAIM_RESPONSE_TIMEOUT_MS) {
        console.log(
          `Auto-closing ticket ${channel.id}: no reply from the owner for ` +
          `${formatDuration(Date.now() - lastActivity)} since it was claimed.`
        );
        await closeAndArchiveTicket(channel, client.user.id);
        return { channelId: channel.id, controlsUpdated: false, status: 'closed', autoClosed: true };
      }
    }
  }

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

  // Checked against the live channel cache, not the list fetched above -- a
  // ticket opened while this sweep was still running must never be mistaken
  // for one that no longer exists and get its state pruned out from under it.
  const stillExists = (id) => guild.channels.cache.has(id);
  updateGuildConfig(guild.id, (config) => {
    if (!config) return null;
    return {
      ...config,
      controlMessages: Object.fromEntries(
        Object.entries(config.controlMessages || {}).filter(([id]) => stillExists(id))
      ),
      // Channels deleted outside closeAndArchiveTicket (manually, or a crash
      // mid-close) would otherwise leave their state behind here forever.
      ticketState: Object.fromEntries(
        Object.entries(config.ticketState || {}).filter(([id]) => stillExists(id))
      ),
      closedTicketIds: (config.closedTicketIds || []).filter(stillExists),
      lastRefreshAt: new Date().toISOString()
    };
  });

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
      if (!isAllowedGuild(guild.id)) continue;
      await refreshGuildTickets(guild, 'automatic').catch((error) => {
        console.error(`Automatic ticket refresh failed for guild ${guild.id}:`, error);
      });
    }
  } finally {
    maintenanceRunning = false;
  }
}

// Ticket state (owner, section, claim status, ...) lives here rather than in
// the channel topic. Discord shows a channel's topic to every member who
// opens it -- above the first message, with no click needed -- so anything
// placed there was effectively public, including the raw Discord IDs the bot
// itself needs. Storage is bot-only.
function getTicketStateEntry(channel) {
  const guildId = channel?.guild?.id;
  if (guildId) {
    const stored = getGuildConfig(guildId)?.ticketState?.[channel.id];
    if (stored) return stored;
  }
  // Tickets created before this migration still carry their data in the
  // topic. Parse it once; migrateLegacyTicketTopicIfNeeded (called from
  // refreshTicketChannel) copies it into storage and rewrites the topic the
  // next time the maintenance sweep or /tickets-refresh reaches this channel.
  return parseLegacyTicketTopic(channel?.topic);
}

function parseLegacyTicketTopic(topic) {
  if (!topic || !topic.includes(TICKET_MARKER)) return null;

  const field = (key) => topic.match(new RegExp(`${key}=([^|]*)`))?.[1]?.trim() || null;
  const numericField = (key) => topic.match(new RegExp(`${key}=(\\d{17,20})(?![\\d])`))?.[1] || null;
  const claimedAt = field('claimedAt');

  return {
    owner: numericField('owner'),
    section: field('section') || 'Unknown',
    ticketNumber: field('ticketNumber'),
    lang: field('lang'),
    status: field('status') || 'open',
    claimedBy: numericField('claimedBy'),
    claimedAt: claimedAt ? Number(claimedAt) : null,
    info: field('info') || ''
  };
}

function getTicketOwnerId(channel) {
  return getTicketStateEntry(channel)?.owner || null;
}

function getTicketStatus(channel) {
  return getTicketStateEntry(channel)?.status || 'open';
}

function getTicketClaimedBy(channel) {
  return getTicketStateEntry(channel)?.claimedBy || null;
}

// ticketOwnerActivity is in-memory, so after a restart every claimed ticket
// would look silent since the moment it was claimed -- and the first sweep
// runs fifteen seconds after boot, so a deploy would auto-close live tickets
// whose owner had just replied. On a miss, recover the real figure from the
// channel's own history: author and timestamp are available without the
// privileged MessageContent intent, which only gates message text.
async function resolveTicketOwnerActivity(channel, claimedAt) {
  const cached = ticketOwnerActivity.get(channel.id);
  if (cached !== undefined) return cached;

  const ownerId = getTicketOwnerId(channel);
  let lastActivity = claimedAt;

  if (ownerId) {
    try {
      const messages = await withTimeout(
        channel.messages.fetch({ limit: 100 }),
        `Fetch recent messages for ${channel.id}`,
        8_000
      );
      for (const message of messages.values()) {
        if (message.author?.id !== ownerId) continue;
        if (message.createdTimestamp > lastActivity) lastActivity = message.createdTimestamp;
      }
    } catch (error) {
      // Falling back to claimedAt would close the ticket on a transient fetch
      // failure, so treat the deadline as not yet reached instead.
      console.error(`Failed to recover owner activity for ${channel.id}:`, error?.message || error);
      return Date.now();
    }
  }

  ticketOwnerActivity.set(channel.id, lastActivity);
  return lastActivity;
}

// The language the member picked in the panel, carried on the ticket so that a
// claim or close hours later still speaks to them in it. Written once when the
// channel is created.
function getTicketLang(channel) {
  return resolveLang(getTicketStateEntry(channel)?.lang);
}

function getTicketClaimedAt(channel) {
  const value = getTicketStateEntry(channel)?.claimedAt;
  return value ? Number(value) : null;
}

function getTicketNumber(channel) {
  const stateNumber = getTicketStateEntry(channel)?.ticketNumber;
  if (stateNumber) return stateNumber;

  const nameMatch = channel?.name?.match(/(?:ticket|closed)-(?:ticket-)?(\d+)$/);
  return nameMatch?.[1] || null;
}

function getTicketSection(channel) {
  return getTicketStateEntry(channel)?.section || 'Unknown';
}

// Merges a patch into the ticket's stored state. Falls back to whatever the
// legacy topic parses to as the base, so a not-yet-migrated ticket's first
// write (a claim, a status change) migrates it rather than dropping the rest
// of its fields.
async function setTicketState(channel, patch) {
  const guildId = channel?.guild?.id;
  if (!guildId) return;

  updateGuildConfig(guildId, (config) => {
    if (!config) return null;
    const current = config.ticketState?.[channel.id] || parseLegacyTicketTopic(channel.topic) || {};
    return {
      ...config,
      ticketState: {
        ...(config.ticketState || {}),
        [channel.id]: { ...current, ...patch }
      }
    };
  });
}

function clearTicketState(guildId, channelId) {
  updateGuildConfig(guildId, (config) => {
    if (!config?.ticketState?.[channelId]) return null;
    const ticketState = { ...config.ticketState };
    delete ticketState[channelId];
    return { ...config, ticketState };
  });
}

async function trySetTicketTopicValue(channel, key, value) {
  try {
    await setTicketState(channel, { [key]: value });
    return true;
  } catch (error) {
    console.error(`Failed to set ticket ${key}=${value} for ${channel.id}:`, error);
    return false;
  }
}

async function trySetTicketTopicValues(channel, entries, label = 'ticket state') {
  try {
    await setTicketState(channel, entries);
    return true;
  } catch (error) {
    console.error(`Failed to set ${label} for ${channel.id}:`, error);
    return false;
  }
}

// The only thing ever shown to members in the channel's topic: no owner,
// no claim state, no Discord IDs of any kind.
function buildTicketTopic(sectionName, ticketNumber) {
  const label = [ticketNumber ? `#${ticketNumber}` : null, sectionName].filter(Boolean).join(' — ');
  const topic = label ? `${TICKET_MARKER} — ${label}` : TICKET_MARKER;
  return topic.slice(0, 1024);
}

// One-time migration for tickets created before ticket state moved into
// storage: copy what the topic parses to into storage, then rewrite the topic
// to the clean, ID-free form. Idempotent -- a channel already migrated is a
// no-op, so it is safe to call on every maintenance sweep.
async function migrateLegacyTicketTopicIfNeeded(channel) {
  const guildId = channel?.guild?.id;
  if (!guildId) return;

  const config = getGuildConfig(guildId);
  if (config?.ticketState?.[channel.id]) return;

  const legacy = parseLegacyTicketTopic(channel.topic);
  if (!legacy) return;

  await setTicketState(channel, legacy);

  const prettyTopic = buildTicketTopic(legacy.section, legacy.ticketNumber);
  if (channel.topic === prettyTopic) return;

  try {
    await withTimeout(channel.setTopic(prettyTopic), `Migrate ticket topic for ${channel.id}`, 4_000);
  } catch (error) {
    console.error(`Failed to migrate legacy ticket topic for ${channel.id}:`, error?.message || error);
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

// includeSystemNotes gates operational notices about the bot's own
// configuration (a missing intent, and similar). Those are for staff eyes in
// the log channel only -- a member's own copy of their transcript never
// mentions bot internals, so it defaults to leaving them out.
function buildTranscriptText(channel, messages, { includeSystemNotes = false } = {}) {
  const lines = [
    `Transcript for #${channel.name}`,
    `Channel ID: ${channel.id}`,
    `Generated At: ${new Date().toISOString()}`
  ];

  if (includeSystemNotes && !ENABLE_MESSAGE_CONTENT) {
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
  const imageAttachment = resolvePanelImageAttachment(setupConfig.panelImageFile);
  const message = await channel.send({
    embeds: [buildPanelEmbed(setupConfig, imageAttachment)],
    components: [buildPanelMenu(setupConfig)],
    files: imageAttachment ? [imageAttachment.attachment] : []
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
  if (!config.channelId || !config.messageId) return { ok: false, reason: 'missing_panel' };

  const menu = buildPanelMenu(config);
  if (!menu) return { ok: false, reason: 'no_sections' };

  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased()) return { ok: false, reason: 'missing_channel' };

  const message = await channel.messages.fetch(config.messageId).catch(() => null);
  if (!message) return { ok: false, reason: 'missing_message' };

  const imageAttachment = resolvePanelImageAttachment(config.panelImageFile);
  await message.edit({
    embeds: [buildPanelEmbed(config, imageAttachment)],
    components: [menu],
    // Editing with `files` alone appends to a message's existing attachments
    // rather than replacing them -- clearing `attachments` first is what
    // actually swaps the banner instead of piling up a duplicate on every
    // resync.
    attachments: [],
    files: imageAttachment ? [imageAttachment.attachment] : []
  });
  return { ok: true, channel, message };
}

// The panel's select menu is built from code, so a deploy that changes its
// custom id leaves the already-posted message wired to a handler that no
// longer exists -- every member clicking it gets "This interaction failed"
// until someone runs /quick-setup. Re-editing it at startup closes that
// window. updateSavedPanel edits in place, so this is idempotent.
async function resyncSavedPanels() {
  for (const guild of client.guilds.cache.values()) {
    if (!isAllowedGuild(guild.id)) continue;

    const config = getGuildConfig(guild.id);
    if (!config) continue;

    const result = await updateSavedPanel(guild, config).catch((error) => {
      console.error(`Failed to resync the panel for guild ${guild.id}:`, error?.message || error);
      return { ok: false, reason: 'error' };
    });

    if (result.ok) {
      console.log(`Ticket panel resynced for guild ${guild.id}.`);
    } else if (result.reason !== 'missing_panel') {
      console.warn(
        `Ticket panel not resynced for guild ${guild.id}: ${result.reason}. ` +
        'Run /quick-setup to repost it.'
      );
    }
  }
}

async function resendSavedPanel(interaction) {
  let config = getGuildConfig(interaction.guildId);

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

  const uploadedImage = interaction.options?.getAttachment?.('image');
  if (uploadedImage) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const filename = await downloadPanelImage(uploadedImage, `${interaction.guildId}-support`);
      config = { ...config, panelImageFile: filename };
    } catch (error) {
      await interaction.editReply({ content: `Could not use that image: ${error.message}` });
      return;
    }
  }

  const panelConfig = ensureTicketInstance(config);
  const imageAttachment = resolvePanelImageAttachment(panelConfig.panelImageFile);
  const message = await interaction.channel.send({
    embeds: [buildPanelEmbed(panelConfig, imageAttachment)],
    components: [buildPanelMenu(panelConfig)],
    files: imageAttachment ? [imageAttachment.attachment] : []
  });

  setGuildConfig(interaction.guildId, {
    ...panelConfig,
    channelId: interaction.channelId,
    messageId: message.id,
    updatedAt: new Date().toISOString()
  });

  const reply = { content: `Ticket panel sent in <#${interaction.channelId}>.` };
  if (uploadedImage) {
    await interaction.editReply(reply);
  } else {
    await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral });
  }
}

async function findExistingMemberTicket(guild, userId, config) {
  // The Guilds intent keeps the channel cache current through gateway events,
  // so avoid a REST sweep of every channel on each panel click.
  const channels = guild.channels.cache.size ? guild.channels.cache : await guild.channels.fetch();
  const closedTicketIds = new Set(Array.isArray(config.closedTicketIds) ? config.closedTicketIds : []);

  return channels.find((channel) => {
    if (!isTicketChannel(channel) || getTicketOwnerId(channel) !== userId) {
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
// lang defaults to English on purpose: the archive in the staff log channel
// calls this without one, so a staff record stays in a single language whoever
// opened the ticket. Only the member's own copy is localised.
function buildClosedTicketCard({ guild, ownerId, claimedBy, closedById, openedAt, closedAt, lang = 'en' }) {
  const ui = t(lang);
  const embed = new EmbedBuilder()
    .setColor(CLOSED_CARD_COLOR)
    .setAuthor({
      name: guild.name,
      iconURL: guild.iconURL({ size: 128 }) || client.user?.displayAvatarURL({ size: 128 })
    })
    .setTitle(ui.closedTitle)
    .addFields(
      { name: ui.closedOpenedBy, value: ownerId ? `<@${ownerId}>` : ui.unknown, inline: true },
      { name: ui.closedClaimedBy, value: claimedBy ? `<@${claimedBy}>` : ui.noOne, inline: true },
      { name: ui.closedClosedBy, value: closedById ? `<@${closedById}>` : ui.unknown, inline: true },
      { name: ui.closedOpenTime, value: `<t:${Math.floor(openedAt / 1000)}:F>`, inline: true },
      { name: ui.closedCloseTime, value: `<t:${Math.floor(closedAt / 1000)}:F>`, inline: true }
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
async function buildClosedTicketLink(guild, recipientId, logMessage, lang = 'en') {
  const ui = t(lang);
  const config = getGuildConfig(guild.id);

  if (logMessage && config?.logChannelId) {
    const logChannel = await guild.channels.fetch(config.logChannelId).catch(() => null);
    const member = await guild.members.fetch(recipientId).catch(() => null);

    if (logChannel && member && logChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(ui.viewTicket)
          .setStyle(ButtonStyle.Link)
          .setURL(logMessage.url)
      );
    }
  }

  if (config?.channelId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(ui.openNewTicket)
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
  // Staff get the full transcript, including notices about the bot's own
  // configuration; the member's own copy below never carries those.
  const transcript = buildTranscriptText(channel, messages, { includeSystemNotes: true });

  const logged = await writeTicketLog(channel, closedById, reason, { messages, transcript });

  if (ownerId) {
    const ownerLang = getTicketLang(channel);
    const card = buildClosedTicketCard({
      guild: channel.guild,
      lang: ownerLang,
      ownerId,
      claimedBy: getTicketClaimedBy(channel),
      closedById,
      openedAt: channel.createdTimestamp,
      closedAt: Date.now()
    }).setFooter({ text: BRAND_FOOTER });

    const row = await buildClosedTicketLink(channel.guild, ownerId, logged.message, ownerLang);

    // A shared log channel cannot show one member only their own entry, so
    // the member is sent their own transcript instead of being given access
    // to everyone else's. It is built fresh (rather than reusing the staff
    // copy) so it never carries a notice about the bot's own configuration.
    const memberTranscript = buildTranscriptText(channel, messages, { includeSystemNotes: false });
    const files = TRANSCRIPT_SEND_TO_OWNER
      ? [new AttachmentBuilder(Buffer.from(memberTranscript, 'utf8'), {
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
  clearTicketState(channel.guild.id, channel.id);
  setTicketClosedState(channel.guild.id, channel.id, false);
  ticketOwnerActivity.delete(channel.id);

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
// notifies the member. Interaction-free by design: openTicket
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
    .setColor(BRAND_COLOR)
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

async function createTicket({ guild, user, section, reason, config, lang = 'en' }) {
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
    topic: buildTicketTopic(section.name, ticketNumber),
    permissionOverwrites
  });

  await setTicketState(channel, {
    owner: user.id,
    section: section.name,
    ticketNumber: String(ticketNumber),
    lang: resolveLang(lang),
    status: 'open',
    claimedBy: null,
    claimedAt: null,
    info: ''
  });

  const staffMentions = section.roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
  const localSectionName = translateSectionName(section.name, lang);
  // Used below both for the ticket-welcome embed's text fallback and for the
  // member's "ticket created" DM confirmation, so it has to be declared
  // unconditionally regardless of which embed branch runs.
  const ui = t(lang);

  // Same banner the panel shows: the ticket-welcome message carries no text
  // of its own (no title, opener/category/reason fields, footer or
  // timestamp) -- just the image and the Claim/Close/Admin Panel controls
  // below it. Falls back to the old text layout only if the image asset is
  // ever missing.
  const imageAttachment = resolvePanelImageAttachment(config.panelImageFile);
  const embed = new EmbedBuilder().setColor(BRAND_COLOR);

  if (imageAttachment) {
    embed.setImage(`attachment://${imageAttachment.name}`);
  } else {
    const openedAt = Math.floor(Date.now() / 1000);
    embed
      .setTitle(`${parseSectionEmoji(section.emoji)?.text || '🎫'} ${localSectionName}`)
      .setDescription(reason)
      .addFields(
        { name: ui.openedBy, value: `<@${user.id}>`, inline: true },
        { name: ui.category, value: localSectionName, inline: true },
        { name: ui.ticketNumber, value: `#${ticketNumber}`, inline: true },
        { name: ui.openedAt, value: `<t:${openedAt}:f>`, inline: true }
      )
      .setFooter({ text: BRAND_FOOTER })
      .setTimestamp();
    if (isHttpUrl(config.thumbnailUrl)) embed.setThumbnail(config.thumbnailUrl);
  }

  const pinned = await channel.send({
    content: `${staffMentions} <@${user.id}>`.trim(),
    embeds: [embed],
    components: buildTicketControls(),
    files: imageAttachment ? [imageAttachment.attachment] : [],
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

  const notified = await dmUser(user.id, {
    embeds: [
      new EmbedBuilder()
        .setColor(config.color || BRAND_COLOR)
        .setTitle(ui.openedTitle(ticketNumber))
        .setDescription(ui.openedBody(localSectionName, guild.name, channel.id))
        .addFields({ name: ui.yourMessage, value: reason.slice(0, 1024) })
        .setFooter({ text: BRAND_FOOTER })
        .setTimestamp()
    ]
  }, 'ticket created notice');

  if (!notified) {
    // Their DMs are closed, so say it in the ticket instead.
    await channel.send({
      content: `<@${user.id}> ${ui.dmFailed}`
    }).catch(() => {});
  }

  return { channel, ticketNumber, notified };
}

async function openTicket(interaction, sectionId, reason, lang = 'en') {
  let config = getGuildConfig(interaction.guildId);

  if (!config?.sections?.length) {
    // Member-facing, so it says nothing about the bot's own configuration --
    // that operational detail goes to the console for staff instead.
    console.error(`Ticket attempted in ${interaction.guildId} with no sections configured. Run /quick-setup.`);
    await sendInteractionResult(interaction, {
      content: t(lang).setupMissing,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const section = config.sections.find((item) => item.id === sectionId);

  if (!section) {
    await sendInteractionResult(interaction, {
      content: t(lang).sectionGone,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!config.ticketInstanceId) {
    config = setGuildConfig(interaction.guildId, ensureTicketInstance(config));
  }

  const existingTicket = await findExistingMemberTicket(
    interaction.guild, interaction.user.id, config
  );

  if (existingTicket) {
    await sendInteractionResult(interaction, {
      content: t(lang).alreadyOpen(existingTicket.id),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!isTicketRateLimitExempt(interaction)) {
    const { allowed } = consumeTicketRateLimit(interaction.guildId, interaction.user.id, TICKET_DAILY_LIMIT);
    if (!allowed) {
      await sendInteractionResult(interaction, {
        content: t(lang).rateLimited(TICKET_DAILY_LIMIT),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  const result = await createTicket({
    guild: interaction.guild,
    user: interaction.user,
    lang,
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

// An existing channel handed to us belongs to the server, not to this bot, so
// its permissions are added to rather than replaced. Wiping the overwrites on a
// channel a live community already uses would be destructive and is never worth
// the tidiness.
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
      `Could not self-grant in ${channel.id}: missing ${missing.join(', ') || 'unknown'}`
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

async function ensurePanelChannel(guild, providedChannel, parentId, created) {
  if (providedChannel) return providedChannel;

  const existing = guild.channels.cache.find(
    (channel) => channel?.type === ChannelType.GuildText && channel.name === PANEL_CHANNEL_NAME
  );
  if (existing) return existing;

  // Everyone can see the panel and use the menu, but not post in the channel.
  const channel = await guild.channels.create({
    name: PANEL_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `${BRAND_NAME} | open a ticket from the menu below`,
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
    reason: `${BRAND_NAME}: panel channel`
  });

  created.channels.push(channel.name);
  return channel;
}

// Closed tickets are deleted, so this is their only durable record. Staff can
// read it; nobody but the bot can write to it.
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
    topic: `${BRAND_NAME} | archive of every closed ticket`,
    permissionOverwrites: overwrites,
    reason: `${BRAND_NAME}: log channel`
  });

  created.channels.push(channel.name);
  return channel;
}

// Publishes or updates the panel. Editing in place keeps a single panel; if the
// panel moved channels the previous message is deleted, since it still carries
// a working menu.
async function publishPanelMessage(guild, config, channel, prevChannelId, prevMessageId, created) {
  const menu = buildPanelMenu(config);
  if (!menu) return null;

  const imageAttachment = resolvePanelImageAttachment(config.panelImageFile);
  const payload = {
    embeds: [buildPanelEmbed(config, imageAttachment)],
    components: [menu],
    files: imageAttachment ? [imageAttachment.attachment] : []
  };

  if (prevMessageId && prevChannelId === channel.id) {
    const existing = await channel.messages.fetch(prevMessageId).catch(() => null);
    // Editing with `files` alone appends rather than replacing, so old
    // attachments have to be cleared explicitly to actually swap the banner.
    if (existing) return existing.edit({ ...payload, attachments: [] });
  } else if (prevMessageId && prevChannelId) {
    const oldChannel = await guild.channels.fetch(prevChannelId).catch(() => null);
    const oldMessage = oldChannel?.isTextBased()
      ? await oldChannel.messages.fetch(prevMessageId).catch(() => null)
      : null;

    if (oldMessage) {
      await oldMessage.delete().catch((error) => {
        console.error('Failed to remove the previous ticket panel:', error?.message || error);
      });
      created.removed.push(`old panel in #${oldChannel.name}`);
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

// Interaction-free so it can be driven directly.
async function provisionGuild(guild, options = {}) {
  const created = { roles: [], categories: [], channels: [], removed: [], warnings: [] };

  for (const provided of [options.panelChannel, options.logChannel]) {
    if (!provided) continue;
    const missing = missingChannelPermissions(provided);
    if (missing.length) {
      console.warn(`Bot is missing ${missing.join(', ')} in #${provided.name} (${provided.id}).`);
    }
  }

  const staffRole = await ensureStaffRole(guild, options.staffRole || null, created);

  // Only needed as a parent for channels this run actually creates.
  const needsSupportCategory = !options.panelChannel || !options.logChannel;
  const supportCategory = needsSupportCategory
    ? await ensureSupportCategory(guild, created)
    : null;

  const sections = [];
  const ticketCategoryIds = [];
  const stamp = Date.now();

  const sharedCategory = options.singleCategory
    ? await ensureTicketCategory(guild, TICKET_CATEGORY_NAME, created)
    : null;

  for (const [index, template] of DEFAULT_SECTIONS.entries()) {
    const category = sharedCategory
      || await ensureTicketCategory(guild, `${template.emoji} ${template.name}`, created);

    if (!ticketCategoryIds.includes(category.id)) ticketCategoryIds.push(category.id);

    sections.push({
      id: `t${stamp}${index}`,
      name: template.name,
      emoji: template.emoji,
      categoryId: category.id,
      roleIds: [staffRole.id]
    });
  }

  const supportCategoryId = supportCategory?.id ?? null;
  const panelChannel = await ensurePanelChannel(
    guild, options.panelChannel || null, supportCategoryId, created
  );
  const logChannel = await ensureLogChannel(
    guild, supportCategoryId, staffRole.id, created, options.logChannel || null
  );

  // Existing channels get additive permission fixes only.
  for (const [channel, isLog] of [[options.panelChannel, false], [options.logChannel, true]]) {
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

  const panelMessage = await publishPanelMessage(
    guild, config, panelChannel, existing?.channelId, existing?.messageId, created
  );

  const saved = setGuildConfig(guild.id, stripLegacyConfigKeys({
    ...config,
    channelId: panelChannel.id,
    messageId: panelMessage?.id || null,
    updatedAt: new Date().toISOString()
  }));

  console.log(
    `Provisioned ${guild.id}: sections=${sections.length} ` +
    `roles=${created.roles.length} categories=${created.categories.length} ` +
    `channels=${created.channels.length} removed=${created.removed.length} ` +
    `positioned=${positioned?.ok ? 'yes' : 'no'}`
  );

  return {
    created, staffRole, supportCategory, positioned,
    panelChannel, logChannel, sections, config: saved
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

  await interaction.editReply({
    content: [
      `**${BRAND_NAME}** is ready in **${guild.name}**.`,
      '',
      `Panel: <#${result.panelChannel.id}>`,
      `Ticket log: <#${result.logChannel.id}>`,
      `Staff role: <@&${result.staffRole.id}>`,
      `Categories: ${result.sections.length}`,
      result.positioned?.ok
        ? `Placed above **${result.positioned.anchor}**.`
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

  resyncSavedPanels().catch((error) => {
    console.error('Failed to resync saved ticket panels:', error);
  });

  setTimeout(() => runAutomaticMaintenance().catch(console.error), 15_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Silently ignore other guilds rather than replying: if a second process
    // is serving them, answering here would be the duplicate response.
    if (interaction.guildId && !isAllowedGuild(interaction.guildId)) return;

    if (streamerApplications.isStreamerAppInteraction(interaction)) {
      await streamerApplications.handleInteraction(interaction);
      return;
    }

    if (adminApplication.isAdminApplicationInteraction(interaction)) {
      await adminApplication.handleInteraction(interaction);
      return;
    }

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

      if (interaction.commandName === 'streamer-setup') {
        if (!streamerApplications.isConfigured()) {
          await interaction.reply({
            content: 'STREAMER_APPLICATION_CATEGORY_ID is not set, so this feature is disabled.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        if (!interaction.channel?.isTextBased()) {
          await interaction.reply({ content: 'Use this command in a text channel.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const uploadedImage = interaction.options.getAttachment('image');
        let result;
        try {
          result = await streamerApplications.publishPanel(interaction.guild, interaction.channel, uploadedImage);
        } catch (error) {
          await interaction.editReply({ content: `Could not publish the panel: ${error.message}` });
          return;
        }
        await interaction.editReply({
          content: result.reused
            ? `Streamer Application panel refreshed in <#${result.channel.id}>.`
            : `Streamer Application panel published in <#${result.channel.id}>.`
        });
        return;
      }

      if (interaction.commandName === 'admin-application-setup') {
        if (!adminApplication.isConfigured()) {
          await interaction.reply({
            content: 'ADMIN_APPLICATION_REVIEW_ROLE_ID is not set, so this feature is disabled.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        if (!interaction.channel?.isTextBased()) {
          await interaction.reply({ content: 'Use this command in a text channel.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const uploadedImage = interaction.options.getAttachment('image');
        let result;
        try {
          result = await adminApplication.publishPanel(interaction.guild, interaction.channel, uploadedImage);
        } catch (error) {
          await interaction.editReply({ content: `Could not publish the panel: ${error.message}` });
          return;
        }
        await interaction.editReply({
          content: result.reused
            ? `Admin Application panel refreshed in <#${result.channel.id}>.`
            : `Admin Application panel published in <#${result.channel.id}>.`
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
          // The "no log channel configured" detail is an operational note about
          // the bot's own setup, not something the ticket owner needs to see --
          // it stays staff-only (it is already console.error'd for the log too).
          content: !canManage
            ? `Ticket #${result.ticketNumber} is being deleted. The channel will disappear shortly.`
            : result.logged.ok
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
        const [, , sectionId, lang] = interaction.customId.split(':');
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
          await openTicket(interaction, sectionId, reason, resolveLang(lang));
        } finally {
          ticketCreationLocks.delete(creationKey);
        }
      }

      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:language') {
      const lang = resolveLang(interaction.values[0]);
      const config = getGuildConfig(interaction.guildId);
      const menu = buildCategoryMenu(config || {}, lang);

      if (!menu) {
        await interaction.reply({
          content: 'Ticket setup data is missing. Run /quick-setup to build the panels.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.reply({
        content: UI_STRINGS[lang].languagePrompt,
        components: [menu],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:category:')) {
      const lang = resolveLang(interaction.customId.split(':')[2]);
      const sectionId = interaction.values[0];
      let config = getGuildConfig(interaction.guildId);

      if (!config?.sections?.length) {
        console.error(`Category picked in ${interaction.guildId} with no sections configured. Run /quick-setup.`);
        await interaction.reply({
          content: t(lang).setupMissing,
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
          content: t(lang).sectionGone,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const existingTicket = await findExistingMemberTicket(
        interaction.guild, interaction.user.id, config
      );
      if (existingTicket) {
        await interaction.reply({
          content: t(lang).alreadyOpen(existingTicket.id),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.showModal(createReasonModal(sectionId, lang));
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
          const claimedAt = Date.now();
          trySetTicketTopicValues(
            interaction.channel,
            { claimedBy: interaction.user.id, claimedAt },
            'claim state'
          );
          // The response clock starts now, not at the owner's last message
          // before the claim -- staff have only just picked it up.
          ticketOwnerActivity.set(interaction.channel.id, claimedAt);

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

          const claimResponseHours = Math.round(CLAIM_RESPONSE_TIMEOUT_MS / 3_600_000);
          const claimTicketNumber = getTicketNumber(interaction.channel) || 'unknown';
          const claimUi = t(getTicketLang(interaction.channel));
          await dmUser(getTicketOwnerId(interaction.channel), {
            embeds: [
              new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle(claimUi.claimedTitle(claimTicketNumber))
                .setDescription(claimUi.claimedBody(
                  interaction.user.id,
                  interaction.guild.name,
                  interaction.channel.id,
                  claimResponseHours
                ))
                .setFooter({ text: BRAND_FOOTER })
                .setTimestamp()
            ]
          }, 'ticket claimed notice');

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
          await interaction.message
            .edit({ components: buildTicketBusyControls('Closing...') })
            .catch(() => {});

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
  provisionGuild,
  publishPanelMessage,
  notifyStaffOfNewTicket,
  collectStaffRecipients,
  BRAND_FOOTER,
  ENABLE_GUILD_MEMBERS,
  ENABLE_MESSAGE_CONTENT,
  positionCategoriesAbove,
  reconcileProvidedChannel,
  BOT_ACTIVITY,
  createTicket,
  closeAndArchiveTicket,
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
  SUPPORT_CATEGORY_NAME,
  LOG_CHANNEL_NAME,
  DEFAULT_SECTIONS,
  buildCategoryMenu,
  translateSectionName,
  resolveLang,
  omanDateKey,
  consumeTicketRateLimit,
  TICKET_DAILY_LIMIT,
  getTicketClaimedAt,
  CLAIM_RESPONSE_TIMEOUT_MS,
  trySetTicketTopicValues,
  TICKET_MARKER,
  UI_STRINGS,
  getTicketLang,
  buildClosedTicketCard,
  buildClosedTicketLink,
  isAllowedGuild,
  ALLOWED_GUILD_ID,
  resolveTicketOwnerActivity,
  resyncSavedPanels,
  ticketOwnerActivity
};

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Discord login failed:', error);
});
