// ---------------------------------------------------------------------------
// Admin Application: the simplest of the three application panels -- one
// button, a fixed set of questions, no ticket channel, no stored application
// record. Discord caps a single modal at 5 fields, so the 7 questions split
// across two modals shown back-to-back (Discord does allow responding to a
// modal submission with another modal); submitting the second one DMs every
// member holding one of the configured review roles with all 7 answers, and
// that is the entire flow. Arabic-only by design. Dependencies (client,
// storage, a couple of index.js helpers) are injected via init() rather than
// required directly, so this file never creates a circular require with
// index.js -- same pattern as streamerApplications.js.
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

// Fixed question set -- split 5/2 across two modals to stay under Discord's
// 5-field-per-modal cap. Order here is the order asked and the order shown
// in the final review embed.
const QUESTIONS = [
  { id: 'name', label: 'الاسم؟', style: TextInputStyle.Short, maxLength: 100 },
  { id: 'age', label: 'كم عمرك؟', style: TextInputStyle.Short, maxLength: 20 },
  { id: 'memberSince', label: 'من متى وأنت في سيرفر Enclave؟', style: TextInputStyle.Short, maxLength: 100 },
  { id: 'reason', label: 'ليش حاب تقدم على إدارة Enclave؟', style: TextInputStyle.Paragraph, maxLength: 1000 },
  { id: 'experience', label: 'هل عندك خبرة إدارية سابقة؟', style: TextInputStyle.Paragraph, maxLength: 1000 },
  { id: 'hours', label: 'كم ساعة تقدر تتواجد يوميًا؟', style: TextInputStyle.Short, maxLength: 50 },
  { id: 'contribution', label: 'وش تقدر تضيف لإدارة Enclave؟', style: TextInputStyle.Paragraph, maxLength: 1000 }
];
const MODAL_1_QUESTIONS = QUESTIONS.slice(0, 5);
const MODAL_2_QUESTIONS = QUESTIONS.slice(5);

// Bridges the two modals: modal 1's answers wait here for modal 2's
// submission to complete the set. In-memory only -- a bot restart between
// the two modals loses the first answers, same as any other mid-flow state
// this feature keeps (there's no ticket or stored record to resume from
// either), so a short TTL just guards against a genuinely abandoned modal 1
// rather than a real restart.
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingAnswers = new Map();

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
    if (interaction.isModalSubmit() && interaction.customId === 'admapp:modal1') {
      return await handleModal1Submit(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'admapp:modal2') {
      return await handleModal2Submit(interaction);
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

function buildQuestionModal(customId, title, questions) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      ...questions.map((q) =>
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(q.id)
            .setLabel(q.label)
            .setStyle(q.style)
            .setRequired(true)
            .setMaxLength(q.maxLength)
        )
      )
    );
}

function readAnswers(interaction, questions) {
  const answers = {};
  for (const q of questions) {
    answers[q.id] = interaction.fields.getTextInputValue(q.id).trim();
  }
  return answers;
}

async function handleApplyButton(interaction) {
  if (isOnCooldown(interaction.user.id)) {
    await ephemeralError(interaction, 'يرجى الانتظار قليلاً قبل إرسال طلب آخر.');
    return true;
  }

  await interaction.showModal(buildQuestionModal('admapp:modal1', 'طلب تقديم للإدارة (١/٢)', MODAL_1_QUESTIONS));
  return true;
}

async function handleModal1Submit(interaction) {
  const answers = readAnswers(interaction, MODAL_1_QUESTIONS);
  pendingAnswers.set(interaction.user.id, { answers, savedAt: Date.now() });

  await interaction.showModal(buildQuestionModal('admapp:modal2', 'طلب تقديم للإدارة (٢/٢)', MODAL_2_QUESTIONS));
  return true;
}

async function handleModal2Submit(interaction) {
  const pending = pendingAnswers.get(interaction.user.id);
  if (!pending || Date.now() - pending.savedAt > PENDING_TTL_MS) {
    pendingAnswers.delete(interaction.user.id);
    await ephemeralError(interaction, 'انتهت صلاحية الجزء الأول من الطلب. اضغط الزر وابدأ من جديد.');
    return true;
  }

  if (isOnCooldown(interaction.user.id)) {
    pendingAnswers.delete(interaction.user.id);
    await ephemeralError(interaction, 'يرجى الانتظار قليلاً قبل إرسال طلب آخر.');
    return true;
  }

  const answers = { ...pending.answers, ...readAnswers(interaction, MODAL_2_QUESTIONS) };
  pendingAnswers.delete(interaction.user.id);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  recentSubmissions.set(interaction.user.id, Date.now());

  const embed = new EmbedBuilder()
    .setColor(deps.BRAND_COLOR)
    .setTitle('📋 طلب تقديم للإدارة')
    .addFields(QUESTIONS.map((q) => ({ name: q.label, value: answers[q.id].slice(0, 1024) || '-' })))
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
