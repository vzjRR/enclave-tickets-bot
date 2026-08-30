// ---------------------------------------------------------------------------
// Admin Application: the simplest of the three application panels -- one
// button, one modal, one free-text field. No ticket channel, no wizard, no
// stored application record: submitting DMs every member holding one of the
// configured review roles, and that is the entire flow. Arabic-only by
// design. Dependencies (client, storage, a couple of index.js helpers) are
// injected via init() rather than required directly, so this file never
// creates a circular require with index.js -- same pattern as
// streamerApplications.js.
// ---------------------------------------------------------------------------

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, getGuildConfig } = require('./storage');

const APPLY_BUTTON_LABEL = '📋 طلب تقديم للإدارة';

// Comma-separated so more than one team can receive applications (e.g.
// ADMIN_APPLICATION_REVIEW_ROLE_ID=111,222).
const REVIEW_ROLE_IDS = (process.env.ADMIN_APPLICATION_REVIEW_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const PANEL_IMAGES_DIR = path.join(DATA_DIR, 'panel-images');
const MAX_PANEL_IMAGE_BYTES = 8 * 1024 * 1024;

// Ships with the code, so the panel gets its designed banner with zero
// setup; a guild can still override it with its own upload via
// /admin-application-setup's `image` option, which takes priority when present.
const DEFAULT_PANEL_IMAGE = path.join(__dirname, '..', 'assets', 'panel-admin-application.png');

// A submit button-mash or a double-click on the modal's Submit button is the
// only realistic spam vector here (there is no ticket, so nothing else rate
// limits it) -- an in-memory cooldown is enough; it does not need to survive
// a restart.
const SUBMIT_COOLDOWN_MS = 60_000;
const recentSubmissions = new Map();

let deps = null;

function init(injected) {
  deps = injected;
}

function isConfigured() {
  return REVIEW_ROLE_IDS.length > 0;
}

function log(message, extra) {
  console.log(`[admin-app] ${message}`, extra === undefined ? '' : extra);
}

function logError(message, error) {
  console.error(`[admin-app] ${message}`, error?.code !== undefined ? `[code ${error.code}]` : '', error?.stack || error);
}

async function ephemeralError(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    logError('Failed to send an ephemeral error:', error);
  }
}

// ---------------------------------------------------------------------------
// Panel banner image -- same download/store/fallback pattern as the support
// and streamer-application panels (see index.js and streamerApplications.js).
// ---------------------------------------------------------------------------

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
  if (!fs.existsSync(PANEL_IMAGES_DIR)) fs.mkdirSync(PANEL_IMAGES_DIR, { recursive: true });
  const filename = `${filenamePrefix}${ext}`;
  fs.writeFileSync(path.join(PANEL_IMAGES_DIR, filename), buffer);
  return filename;
}

function resolvePanelImageAttachment(filename) {
  const filePath = filename ? path.join(PANEL_IMAGES_DIR, filename) : DEFAULT_PANEL_IMAGE;
  if (!fs.existsSync(filePath)) return null;

  const name = `panel-image${path.extname(filePath) || '.png'}`;
  return { attachment: new AttachmentBuilder(filePath, { name }), name };
}

// ---------------------------------------------------------------------------
// The panel -- entirely separate from the ordinary ticket panel and the
// Streamer Application one. Stored under its own config key
// (adminApplicationPanel), never touched by /quick-setup.
// ---------------------------------------------------------------------------

function buildPanelEmbed(imageAttachment = null) {
  // The banner already carries the message as artwork -- image only, no
  // title/description/footer, matching the support and streamer panels.
  if (imageAttachment) {
    return new EmbedBuilder().setColor(deps.BRAND_COLOR).setImage(`attachment://${imageAttachment.name}`);
  }
  return new EmbedBuilder()
    .setColor(deps.BRAND_COLOR)
    .setTitle('📋 طلب تقديم للإدارة')
    .setDescription('اضغط الزر أدناه لتقديم طلبك للانضمام لفريق الإدارة.');
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admapp:panel:apply').setLabel(APPLY_BUTTON_LABEL).setStyle(ButtonStyle.Primary)
    )
  ];
}

// Posts a fresh panel in `channel`, or edits the previously saved one in
// place if this guild already has one (anywhere, not just in this channel).
async function publishPanel(guild, channel, uploadedImage = null) {
  const config = getGuildConfig(guild.id) || {};
  let imageFile = config.adminApplicationPanel?.imageFile || null;

  if (uploadedImage) {
    imageFile = await downloadPanelImage(uploadedImage, `${guild.id}-admin`);
  }

  const imageAttachment = resolvePanelImageAttachment(imageFile);
  const payload = {
    embeds: [buildPanelEmbed(imageAttachment)],
    components: buildPanelComponents(),
    files: imageAttachment ? [imageAttachment.attachment] : []
  };

  const saved = config.adminApplicationPanel;
  if (saved?.channelId && saved?.messageId) {
    const existingChannel = saved.channelId === channel.id
      ? channel
      : await guild.channels.fetch(saved.channelId).catch(() => null);
    const existingMessage = existingChannel?.isTextBased()
      ? await existingChannel.messages.fetch(saved.messageId).catch(() => null)
      : null;

    if (existingMessage) {
      // Editing with `files` alone appends rather than replacing, so old
      // attachments have to be cleared explicitly to actually swap the banner.
      await existingMessage.edit({ ...payload, attachments: [] });
      deps.setGuildConfig(guild.id, {
        ...config,
        adminApplicationPanel: { ...saved, imageFile }
      });
      if (existingChannel.id !== channel.id) {
        return { ok: true, channel: existingChannel, movedFrom: null, reused: true };
      }
      return { ok: true, channel: existingChannel, reused: true };
    }
  }

  const message = await channel.send(payload);
  deps.setGuildConfig(guild.id, {
    ...config,
    adminApplicationPanel: { channelId: channel.id, messageId: message.id, imageFile }
  });
  return { ok: true, channel, reused: false };
}

// ---------------------------------------------------------------------------
// Interaction dispatch
// ---------------------------------------------------------------------------

function isAdminApplicationInteraction(interaction) {
  return typeof interaction.customId === 'string' && interaction.customId.startsWith('admapp:');
}

async function handleInteraction(interaction) {
  if (!isAdminApplicationInteraction(interaction)) return false;

  try {
    if (interaction.isButton() && interaction.customId === 'admapp:panel:apply') {
      return await handleApplyButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'admapp:modal') {
      return await handleModalSubmit(interaction);
    }
  } catch (error) {
    logError(`Unhandled error for ${interaction.customId}:`, error);
    await ephemeralError(interaction, 'حدث خطأ أثناء معالجة هذا الإجراء. حاول مرة أخرى.');
  }

  return true;
}

function isOnCooldown(userId) {
  const last = recentSubmissions.get(userId);
  return Boolean(last && Date.now() - last < SUBMIT_COOLDOWN_MS);
}

async function handleApplyButton(interaction) {
  if (isOnCooldown(interaction.user.id)) {
    await ephemeralError(interaction, 'يرجى الانتظار قليلاً قبل إرسال طلب آخر.');
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId('admapp:modal')
    .setTitle('طلب تقديم للإدارة')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('request')
          .setLabel('اكتب طلبك هنا')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
      )
    );

  await interaction.showModal(modal);
  return true;
}

async function handleModalSubmit(interaction) {
  if (isOnCooldown(interaction.user.id)) {
    await ephemeralError(interaction, 'يرجى الانتظار قليلاً قبل إرسال طلب آخر.');
    return true;
  }

  const text = interaction.fields.getTextInputValue('request').trim();
  if (!text) {
    await ephemeralError(interaction, 'لا يمكن إرسال طلب فارغ.');
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  recentSubmissions.set(interaction.user.id, Date.now());

  const embed = new EmbedBuilder()
    .setColor(deps.BRAND_COLOR)
    .setTitle('📋 طلب تقديم للإدارة')
    .setDescription(text.slice(0, 4000))
    .addFields({ name: 'المتقدم', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: false })
    .setFooter({ text: deps.BRAND_FOOTER })
    .setTimestamp();

  const recipients = await deps.collectStaffRecipients(interaction.guild, REVIEW_ROLE_IDS, null);
  let delivered = 0;
  for (const member of recipients) {
    const ok = await deps.dmUser(member.id, { embeds: [embed] }, 'admin application');
    if (ok) delivered += 1;
  }

  log(`Application from ${interaction.user.id}: ${delivered}/${recipients.length} staff DMs delivered.`);

  await interaction.editReply({
    content: delivered > 0
      ? 'تم إرسال طلبك بنجاح لفريق الإدارة. سيتم التواصل معك قريباً.'
      : 'تم استلام طلبك، لكن تعذّر إشعار فريق الإدارة تلقائياً. يرجى إبلاغهم يدوياً إذا لزم الأمر.'
  });

  return true;
}

module.exports = {
  init,
  isConfigured,
  publishPanel,
  handleInteraction,
  isAdminApplicationInteraction
};
