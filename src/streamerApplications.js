// ---------------------------------------------------------------------------
// Streamer Application wizard
//
// A guided, multi-stage form, entirely separate from the ordinary ticket
// system: its own panel, its own setup command (/streamer-setup), its own
// category and roles. It happens to reuse createTicket() to make the ticket
// channel (private, Claim/Close controls, archive-on-close all included for
// free) and closeAndArchiveTicket() to close it, but it is never a member of
// the ordinary panel's config.sections, is never touched by /quick-setup,
// and does not appear in the ordinary ticket category list. Dependencies
// (client, storage, and a handful of index.js helpers) are injected via
// init() rather than required directly, so this file never creates a
// circular require with index.js.
// ---------------------------------------------------------------------------

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags
} = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, getGuildConfig, updateGuildConfig } = require('./storage');

const PANEL_TITLE = '🎥 التقديم للانضمام كستريمر - Streamer Application';
const PANEL_DESCRIPTION =
  'اضغط الزر أدناه لبدء طلب الانضمام كستريمر في ENCLAVE RP. سيُفتح لك تذكرة خاصة ' +
  'يرشدك فيها البوت عبر عدة مراحل من الأسئلة.';
const APPLY_BUTTON_LABEL = '🎥 تقديم طلب';

const STREAMER_APPLICATION_CATEGORY_ID = (process.env.STREAMER_APPLICATION_CATEGORY_ID || '').trim();
const STREAMER_ROLE_ID = (process.env.STREAMER_ROLE_ID || '').trim();
// Comma-separated so more than one team can review applications (e.g. a
// support lead role alongside a dedicated streamer-review role).
const STREAMER_REVIEW_ROLE_IDS = (process.env.STREAMER_REVIEW_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const STREAMER_REVIEW_CHANNEL_ID = (process.env.STREAMER_REVIEW_CHANNEL_ID || '').trim();
const TICKET_DAILY_LIMIT = Math.max(1, Number.parseInt(process.env.TICKET_DAILY_LIMIT || '3', 10) || 3);

const APP_ID_PREFIX = 'ENCLAVE-STR-';

// ---------------------------------------------------------------------------
// Question bank
//
// `label` is what goes on the modal's TextInput -- Discord caps that at 45
// characters, far short of the real Arabic question, so every step also
// renders the full question text in an embed right before the modal opens.
// `type`: 'short' | 'paragraph' | 'yesno' | 'multiselect'.
// ---------------------------------------------------------------------------

const PLATFORM_OPTIONS = [
  { value: 'twitch', label: 'Twitch' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'kick', label: 'Kick' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'other', label: 'أخرى' }
];

const QUESTIONS = [
  // Stage 1 -- Personal Information
  { id: 'q1', stage: 1, type: 'short', label: 'الاسم', text: 'ما اسمك؟', maxLength: 100 },
  { id: 'q2', stage: 1, type: 'short', label: 'العمر', text: 'كم عمرك؟', maxLength: 10, validate: 'age' },
  { id: 'q3', stage: 1, type: 'short', label: 'منذ متى تلعب FiveM/GTA RP', text: 'منذ متى وأنت تلعب FiveM / GTA V Roleplay؟', maxLength: 100 },
  { id: 'q4', stage: 1, type: 'paragraph', label: 'خبرتك في صناعة المحتوى', text: 'ما خبرتك السابقة في مجال صناعة المحتوى أو البث المباشر؟', maxLength: 1000, required: false },

  // Stage 2 -- Streaming
  { id: 'q5', stage: 2, type: 'multiselect', label: 'منصات البث', text: 'ما المنصات التي تقوم بالبث عليها؟' },
  { id: 'q6', stage: 2, type: 'paragraph', label: 'روابط حسابات البث', text: 'يرجى إرسال روابط جميع حساباتك الخاصة بالبث وصناعة المحتوى.', maxLength: 1000, validate: 'urls' },
  { id: 'q7', stage: 2, type: 'short', label: 'ساعات البث أسبوعياً', text: 'كم ساعة تقريباً تقوم بالبث أسبوعياً؟', maxLength: 20, validate: 'number' },
  { id: 'q8', stage: 2, type: 'short', label: 'مدة البث الواحد', text: 'كم ساعة تقريباً يستمر البث الواحد؟', maxLength: 20 },
  { id: 'q9', stage: 2, type: 'short', label: 'عدد مرات البث أسبوعياً', text: 'كم مرة تقوم بالبث أسبوعياً؟', maxLength: 20, validate: 'number' },
  { id: 'q10', stage: 2, type: 'short', label: 'أوقات البث المعتادة', text: 'ما أوقات البث المعتادة لديك؟', maxLength: 100 },
  { id: 'q11', stage: 2, type: 'paragraph', label: 'جدول ثابت (إن وجد)', text: 'هل لديك جدول بث ثابت؟ إذا نعم، اذكره.', maxLength: 500, required: false },
  { id: 'q12', stage: 2, type: 'paragraph', label: 'نوع المحتوى المقدَّم', text: 'ما نوع المحتوى الذي تقدمه عادةً؟', maxLength: 500 },
  { id: 'q13', stage: 2, type: 'paragraph', label: 'FiveM أم ألعاب أخرى أيضاً', text: 'هل محتواك يركز على FiveM / GTA RP أم ألعاب أخرى أيضاً؟', maxLength: 500 },
  { id: 'q14', stage: 2, type: 'short', label: 'الألعاب الأخرى', text: 'ما الألعاب الأخرى التي تقوم ببثها؟', maxLength: 200, required: false },
  { id: 'q15', stage: 2, type: 'yesno', label: 'مقاطع قصيرة', text: 'هل تقوم بإنشاء مقاطع قصيرة مثل TikTok / YouTube Shorts / Reels؟' },
  { id: 'q16', stage: 2, type: 'paragraph', label: 'روابط المقاطع القصيرة', text: 'إذا نعم، أرسل روابط حساباتك أو أمثلة من أفضل مقاطعك.', maxLength: 500, required: false, validate: 'urls' },

  // Stage 3 -- Statistics
  { id: 'q17', stage: 3, type: 'short', label: 'متوسط المشاهدين المتزامنين', text: 'ما متوسط عدد المشاهدين المتزامنين (Average Concurrent Viewers) في بثوثك؟', maxLength: 20, validate: 'number' },
  { id: 'q18', stage: 3, type: 'short', label: 'أعلى عدد مشاهدين', text: 'ما أعلى عدد مشاهدين وصلت إليه في بث واحد؟', maxLength: 20, validate: 'number' },
  { id: 'q19', stage: 3, type: 'paragraph', label: 'المتابعين/المشتركين لكل منصة', text: 'كم عدد المتابعين / المشتركين لديك في كل منصة؟', maxLength: 500 },
  { id: 'q20', stage: 3, type: 'short', label: 'متوسط مشاهدات المقاطع', text: 'ما متوسط المشاهدات التي تحصل عليها مقاطعك؟', maxLength: 30 },
  { id: 'q21', stage: 3, type: 'short', label: 'تاريخ آخر بث مباشر', text: 'متى كان آخر بث مباشر لك؟', maxLength: 50 },
  { id: 'q22', stage: 3, type: 'short', label: 'رابط آخر بث', text: 'أرسل رابط آخر بث أو آخر بثوث قمت بها.', maxLength: 300, validate: 'url' },
  { id: 'q23', stage: 3, type: 'short', label: 'رابط أفضل بث/مقطع', text: 'أرسل رابط أفضل بث أو مقطع تعتبره يمثل محتواك.', maxLength: 300, validate: 'url' },

  // Stage 4 -- FiveM & ENCLAVE RP
  { id: 'q24', stage: 4, type: 'paragraph', label: 'ما الذي يجذبك لـ ENCLAVE RP', text: 'ما الذي يجذبك إلى ENCLAVE RP تحديداً؟', maxLength: 700 },
  { id: 'q25', stage: 4, type: 'paragraph', label: 'لماذا تريد Streamer Role', text: 'لماذا تريد الحصول على Streamer Role في ENCLAVE RP؟', maxLength: 700 },
  { id: 'q26', stage: 4, type: 'paragraph', label: 'نوع الشخصية/الـ RP المخطط له', text: 'ما نوع الشخصية أو الـ Roleplay الذي تخطط لتقديمه داخل السيرفر؟', maxLength: 700 },
  { id: 'q27', stage: 4, type: 'paragraph', label: 'خبرة على سيرفرات RP أخرى', text: 'هل سبق لك اللعب أو صناعة محتوى على سيرفرات RP أخرى؟ اذكرها.', maxLength: 700, required: false },
  { id: 'q28', stage: 4, type: 'paragraph', label: 'خبرة بقصص RP طويلة', text: 'هل لديك خبرة في صناعة قصص RP طويلة ومستمرة؟', maxLength: 500 },
  { id: 'q29', stage: 4, type: 'paragraph', label: 'المتعاونون المعتادون', text: 'هل لديك أشخاص أو لاعبين تتعاون معهم عادةً في محتواك؟', maxLength: 500, required: false },
  { id: 'q30', stage: 4, type: 'paragraph', label: 'محتوى فردي أم جماعي', text: 'هل تخطط لعمل محتوى فردي، أم محتوى يعتمد على مجموعة من اللاعبين؟', maxLength: 500 },
  { id: 'q31', stage: 4, type: 'paragraph', label: 'المحتوى المتوقع من ENCLAVE RP', text: 'ما نوع المحتوى الذي تتوقع تقديمه من ENCLAVE RP؟', maxLength: 700 },

  // Stage 5 -- Rules & Commitment
  { id: 'q32', stage: 5, type: 'yesno', label: 'الموافقة على قوانين ENCLAVE RP', text: 'هل قرأت قوانين ENCLAVE RP وتوافق على الالتزام بها؟', gate: true },
  { id: 'q33', stage: 5, type: 'yesno', label: 'الموافقة على قوانين Discord', text: 'هل توافق على الالتزام بقوانين Discord الخاصة بالسيرفر؟', gate: true },
  { id: 'q34', stage: 5, type: 'paragraph', label: 'حظر سابق (إن وجد) والسبب', text: 'هل سبق أن تم حظرك من سيرفرات FiveM أو Discord؟ إذا نعم، وضح السبب.', maxLength: 700, required: false },
  { id: 'q35', stage: 5, type: 'yesno', label: 'عدم استغلال الرتبة داخل الـ RP', text: 'هل توافق على عدم استخدام صلاحية Streamer أو رتبة الستريمر للحصول على أي أفضلية داخل الـ RP؟', gate: true },
  { id: 'q36', stage: 5, type: 'yesno', label: 'عدم استغلال معلومات OOC', text: 'هل توافق على عدم استغلال معلومات OOC حصلت عليها أثناء البث داخل الـ RP؟', gate: true },
  { id: 'q37', stage: 5, type: 'yesno', label: 'الحفاظ على صورة السيرفر', text: 'هل توافق على الحفاظ على صورة ENCLAVE RP بشكل محترم أثناء البث؟', gate: true },

  // Stage 6 -- Cooperation
  { id: 'q38', stage: 6, type: 'yesno', label: 'ذكر ENCLAVE RP في وصف البث', text: 'هل تستطيع وضع رابط أو اسم ENCLAVE RP في وصف البث أو المعلومات الخاصة بالقناة؟' },
  { id: 'q39', stage: 6, type: 'yesno', label: 'عنوان/تصنيف مناسب للبث', text: 'هل تستطيع استخدام عنوان أو تصنيف مناسب للبث عند لعب ENCLAVE RP؟' },
  { id: 'q40', stage: 6, type: 'yesno', label: 'المشاركة في فعاليات صناع المحتوى', text: 'هل أنت مستعد للمشاركة في فعاليات ENCLAVE RP الخاصة بصناع المحتوى؟' },
  { id: 'q41', stage: 6, type: 'yesno', label: 'التعاون مع ستريمرز آخرين', text: 'هل أنت مستعد للتعاون مع Streamers آخرين داخل السيرفر؟' },
  { id: 'q42', stage: 6, type: 'paragraph', label: 'أفكار/اقتراحات', text: 'هل لديك أفكار أو اقتراحات يمكن أن تساعد ENCLAVE RP في تطوير محتوى الستريمرز؟', maxLength: 700, required: false },

  // Stage 7 -- Confirmation
  { id: 'q43', stage: 7, type: 'yesno', label: 'إقرار بصحة المعلومات', text: 'أقر بأن جميع المعلومات التي قدمتها صحيحة.', gate: true },
  { id: 'q44', stage: 7, type: 'yesno', label: 'الموافقة على مراجعة النشاط', text: 'أوافق على أن إدارة ENCLAVE RP يحق لها مراجعة نشاطي ومحتواي قبل وبعد منحي رتبة Streamer.', gate: true },
  { id: 'q45', stage: 7, type: 'yesno', label: 'فهم أن الرتبة ليست صلاحية إدارية', text: 'أفهم أن الحصول على الرتبة لا يعني الحصول على أي صلاحيات إدارية أو أفضلية داخل الـ RP.', gate: true },
  { id: 'q46', stage: 7, type: 'yesno', label: 'فهم إمكانية سحب الرتبة', text: 'أفهم أن رتبة Streamer يمكن سحبها في حال عدم الالتزام بالقوانين أو عدم النشاط أو إساءة استخدام الرتبة.', gate: true }
];

const QUESTIONS_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

const STAGE_TITLES = {
  1: '📋 المعلومات الشخصية',
  2: '🎥 البث',
  3: '📊 الإحصائيات',
  4: '🎭 FiveM و ENCLAVE RP',
  5: '📜 القوانين والالتزام',
  6: '🤝 التعاون',
  7: '✅ التأكيد'
};

// One "step" is one interactive unit: a modal (grouping up to 5 short/
// paragraph questions), a single yes/no question, or the one multiselect
// question. Modal groups never mix stages, and stay under Discord's 5-field
// modal cap.
function buildSteps() {
  const steps = [];
  let stage = null;
  let modalBuffer = [];

  const flushModal = () => {
    if (modalBuffer.length) {
      steps.push({ kind: 'modal', stage, questions: modalBuffer });
      modalBuffer = [];
    }
  };

  for (const question of QUESTIONS) {
    if (question.stage !== stage) {
      flushModal();
      stage = question.stage;
    }

    if (question.type === 'yesno') {
      flushModal();
      steps.push({ kind: 'yesno', stage, question: question.id });
      continue;
    }

    if (question.type === 'multiselect') {
      flushModal();
      steps.push({ kind: 'multiselect', stage, question: question.id });
      continue;
    }

    modalBuffer.push(question.id);
    if (modalBuffer.length === 5) flushModal();
  }
  flushModal();

  return steps;
}

const STEPS = buildSteps();

// ---------------------------------------------------------------------------
// Validation -- deliberately light. Free text stays free text; only fields
// that are structurally numeric or URL-shaped are checked.
// ---------------------------------------------------------------------------

function validateAnswer(question, value) {
  const trimmed = String(value || '').trim();

  if (question.required !== false && !trimmed) {
    return { ok: false, error: 'هذا السؤال مطلوب.' };
  }
  if (!trimmed) return { ok: true, value: '' };

  if (question.validate === 'age') {
    const age = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(age) || age < 10 || age > 100 || String(age) !== trimmed) {
      return { ok: false, error: 'الرجاء إدخال عمر صحيح (رقم فقط).' };
    }
  }

  if (question.validate === 'number') {
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      return { ok: false, error: 'الرجاء إدخال رقم صحيح.' };
    }
  }

  if (question.validate === 'url' && !isLikelyUrl(trimmed)) {
    return { ok: false, error: 'الرجاء إدخال رابط صحيح (يبدأ بـ http:// أو https://).' };
  }

  if (question.validate === 'urls') {
    const urls = trimmed.split(/[\s,]+/).filter(Boolean);
    if (!urls.every(isLikelyUrl)) {
      return { ok: false, error: 'واحد أو أكثر من الروابط غير صحيح. تأكد أنها تبدأ بـ http:// أو https://.' };
    }
  }

  return { ok: true, value: trimmed.slice(0, 1024) };
}

function isLikelyUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Storage
//
// Applications live inside the same per-guild config object the rest of the
// bot already uses (data/tickets.json via storage.js) -- no new database.
// updateGuildConfig's read-modify-write is synchronous under the hood, so
// concurrent interactions can't interleave a lost update.
// ---------------------------------------------------------------------------

function nextApplicationId(guildId) {
  let id = null;
  updateGuildConfig(guildId, (config) => {
    if (!config) return null;
    const counter = (Number(config.streamerApplicationCounter) || 0) + 1;
    id = `${APP_ID_PREFIX}${String(counter).padStart(4, '0')}`;
    return { ...config, streamerApplicationCounter: counter };
  });
  return id;
}

function saveApplication(guildId, application) {
  updateGuildConfig(guildId, (config) => {
    if (!config) return null;
    return {
      ...config,
      streamerApplications: {
        ...(config.streamerApplications || {}),
        [application.applicationId]: application
      },
      streamerApplicationsByChannel: {
        ...(config.streamerApplicationsByChannel || {}),
        [application.ticketChannelId]: application.applicationId
      }
    };
  });
  return application;
}

function getApplication(guildId, applicationId) {
  const config = getGuildConfig(guildId);
  return config?.streamerApplications?.[applicationId] || null;
}

function getApplicationByChannel(guildId, channelId) {
  const config = getGuildConfig(guildId);
  const appId = config?.streamerApplicationsByChannel?.[channelId];
  return appId ? config.streamerApplications?.[appId] || null : null;
}

function findActiveApplicationForUser(guildId, userId) {
  const config = getGuildConfig(guildId);
  const applications = config?.streamerApplications || {};
  const ACTIVE = new Set(['IN_PROGRESS', 'PENDING_REVIEW', 'NEEDS_INFO']);
  return Object.values(applications).find((app) => app.userId === userId && ACTIVE.has(app.status)) || null;
}

function updateApplication(guildId, applicationId, mutator) {
  let result = null;
  updateGuildConfig(guildId, (config) => {
    if (!config?.streamerApplications?.[applicationId]) return null;
    const next = mutator({ ...config.streamerApplications[applicationId] });
    result = next;
    return {
      ...config,
      streamerApplications: { ...config.streamerApplications, [applicationId]: next }
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Injected dependencies from index.js. Populated by init(); every exported
// handler below reads from `deps`, never from a closed-over require of
// index.js, so there is no circular-require ordering hazard.
// ---------------------------------------------------------------------------

let deps = null;

function init(injected) {
  deps = injected;
}

function log(message, extra) {
  console.log(`[streamer-app] ${message}`, extra === undefined ? '' : extra);
}

function logError(message, error) {
  // DiscordAPIError carries a numeric `code` (e.g. 50013 Missing Permissions)
  // distinct from the HTTP status, plus a full stack -- log both, since a
  // bare `error.message` gives no clue which Discord API call actually
  // failed when several run in sequence (channel create, then send, etc).
  console.error(`[streamer-app] ${message}`, error?.code !== undefined ? `[code ${error.code}]` : '', error?.stack || error);
}

// ---------------------------------------------------------------------------
// The dedicated panel -- entirely separate from the ordinary ticket panel.
// Stored under its own config key (streamerApplicationPanel), never inside
// config.sections, so /quick-setup and the ordinary category picker never
// see or touch it.
// ---------------------------------------------------------------------------

function isConfigured() {
  return Boolean(STREAMER_APPLICATION_CATEGORY_ID);
}

// A custom banner image (uploaded via /streamer-setup's attachment option) is
// saved to disk rather than kept as the Discord CDN URL handed back at
// upload time -- that URL is signed and expires in about a day, so storing
// it verbatim would quietly break the panel the next time it rendered.
const PANEL_IMAGES_DIR = path.join(DATA_DIR, 'panel-images');
const MAX_PANEL_IMAGE_BYTES = 8 * 1024 * 1024;

// Ships with the code, so every guild gets the designed banner with zero
// setup; a guild can still override it with its own upload via
// /streamer-setup's `image` option, which takes priority when present.
const DEFAULT_STREAMER_PANEL_IMAGE = path.join(__dirname, '..', 'assets', 'panel-streamer.png');

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
  const filePath = filename ? path.join(PANEL_IMAGES_DIR, filename) : DEFAULT_STREAMER_PANEL_IMAGE;
  if (!fs.existsSync(filePath)) return null;

  const name = `panel-image${path.extname(filePath) || '.png'}`;
  return { attachment: new AttachmentBuilder(filePath, { name }), name };
}

function buildPanelEmbed(imageAttachment = null) {
  // A banner image already carries everything -- title, description,
  // branding -- baked in as artwork, so when one is set the embed shows
  // nothing else: just the image, with the Apply button below it.
  if (imageAttachment) {
    return new EmbedBuilder().setColor(deps.BRAND_COLOR).setImage(`attachment://${imageAttachment.name}`);
  }
  return brandEmbed().setTitle(PANEL_TITLE).setDescription(PANEL_DESCRIPTION);
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sapp:panel:apply').setLabel(APPLY_BUTTON_LABEL).setStyle(ButtonStyle.Primary)
    )
  ];
}

// Posts a fresh panel in `channel`, or edits the previously saved one in
// place if this guild already has one (anywhere, not just in this channel --
// matching /quick-setup's own "one panel, edited in place" behaviour).
// `uploadedImage` is the optional attachment from /streamer-setup's `image`
// option; when omitted, whatever banner was saved from a previous run (if
// any) keeps being used.
async function publishPanel(guild, channel, uploadedImage = null) {
  const config = getGuildConfig(guild.id) || {};
  let imageFile = config.streamerApplicationPanel?.imageFile || null;

  if (uploadedImage) {
    imageFile = await downloadPanelImage(uploadedImage, `${guild.id}-streamer`);
  }

  const imageAttachment = resolvePanelImageAttachment(imageFile);
  const payload = {
    embeds: [buildPanelEmbed(imageAttachment)],
    components: buildPanelComponents(),
    files: imageAttachment ? [imageAttachment.attachment] : []
  };

  const saved = config.streamerApplicationPanel;
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
        streamerApplicationPanel: { ...saved, imageFile }
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
    streamerApplicationPanel: { channelId: channel.id, messageId: message.id, imageFile }
  });
  return { ok: true, channel, reused: false };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function brandEmbed() {
  return new EmbedBuilder().setColor(deps.BRAND_COLOR).setFooter({ text: deps.BRAND_FOOTER });
}

function stepIndexForQuestion(questionId) {
  return STEPS.findIndex((step) =>
    step.kind === 'modal' ? step.questions.includes(questionId) : step.question === questionId
  );
}

function buildContinueRow(applicationId, stepIndex, label = '✏️ الإجابة') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sapp:open:${applicationId}:${stepIndex}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
  );
}

function buildYesNoRow(applicationId, stepIndex) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sapp:yn:${applicationId}:${stepIndex}:yes`).setLabel('✅ نعم').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sapp:yn:${applicationId}:${stepIndex}:no`).setLabel('❌ لا').setStyle(ButtonStyle.Danger)
  );
}

function buildMultiSelectRow(applicationId, stepIndex) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`sapp:msel:${applicationId}:${stepIndex}`)
    .setPlaceholder('اختر منصة واحدة أو أكثر')
    .setMinValues(1)
    .setMaxValues(PLATFORM_OPTIONS.length);
  for (const option of PLATFORM_OPTIONS) menu.addOptions(option);
  return new ActionRowBuilder().addComponents(menu);
}

function stepEmbed(step, application) {
  const embed = brandEmbed()
    .setTitle(STAGE_TITLES[step.stage])
    .setDescription(`المرحلة ${step.stage} من 7 — التطبيق ${application.applicationId}`);

  if (step.kind === 'modal') {
    const lines = step.questions.map((qid, i) => `**${i + 1}.** ${QUESTIONS_BY_ID.get(qid).text}`);
    embed.addFields({ name: 'الأسئلة', value: lines.join('\n\n').slice(0, 1024) });
  } else if (step.kind === 'yesno' || step.kind === 'multiselect') {
    embed.addFields({ name: 'السؤال', value: QUESTIONS_BY_ID.get(step.question).text });
  }

  return embed;
}

function stepPayload(step, application) {
  const embeds = [stepEmbed(step, application)];
  const stepIndex = STEPS.indexOf(step);

  if (step.kind === 'modal') {
    return { embeds, components: [buildContinueRow(application.applicationId, stepIndex)] };
  }
  if (step.kind === 'yesno') {
    return { embeds, components: [buildYesNoRow(application.applicationId, stepIndex)] };
  }
  return { embeds, components: [buildMultiSelectRow(application.applicationId, stepIndex)] };
}

function buildModalForStep(step, application, stepIndex) {
  const modal = new ModalBuilder()
    .setCustomId(`sapp:modalsubmit:${application.applicationId}:${stepIndex}`)
    .setTitle(STAGE_TITLES[step.stage].slice(0, 45));

  for (const qid of step.questions) {
    const question = QUESTIONS_BY_ID.get(qid);
    const input = new TextInputBuilder()
      .setCustomId(qid)
      .setLabel(question.label.slice(0, 45))
      .setStyle(question.type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(question.required !== false)
      .setMaxLength(Math.min(question.maxLength || 1000, 1000));

    const existingValue = application.answers?.[qid];
    if (existingValue) input.setValue(String(existingValue).slice(0, 1000));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

async function renderStep(interactionOrMessage, application, { asUpdate = true } = {}) {
  const stepIndex = application.currentStepIndex;
  const step = STEPS[stepIndex];

  if (!step) {
    await renderReview(interactionOrMessage, application, { asUpdate });
    return;
  }

  const payload = stepPayload(step, application);
  if (asUpdate) {
    await interactionOrMessage.update(payload);
  } else {
    const message = await interactionOrMessage.send(payload);
    updateApplication(interactionOrMessage.guild.id, application.applicationId, (app) => ({
      ...app,
      wizardMessageId: message.id
    }));
  }
}

// ---------------------------------------------------------------------------
// Applicant-facing entry point: the dedicated panel's Apply button. Creates
// the ticket itself (via createTicket -- the only borrowed piece of the
// ordinary ticket system) with a section object built entirely from env
// vars, never touching config.sections.
// ---------------------------------------------------------------------------

const STREAMER_SECTION = {
  name: 'Streamer Application',
  emoji: '🎥',
  categoryId: STREAMER_APPLICATION_CATEGORY_ID,
  get roleIds() {
    const staffRoleId = (process.env.STAFF_ROLE_ID || '').trim();
    return [...new Set([...STREAMER_REVIEW_ROLE_IDS, staffRoleId].filter(Boolean))];
  }
};

async function handlePanelApply(interaction) {
  if (findActiveApplicationForUser(interaction.guildId, interaction.user.id)) {
    await ephemeralError(interaction, 'لديك بالفعل طلب انضمام كستريمر قيد المعالجة.');
    return true;
  }

  if (!deps.isTicketRateLimitExempt(interaction)) {
    const { allowed } = deps.consumeTicketRateLimit(interaction.guildId, interaction.user.id, TICKET_DAILY_LIMIT);
    if (!allowed) {
      await ephemeralError(
        interaction,
        `لقد وصلت إلى الحد الأقصى اليومي وهو ${TICKET_DAILY_LIMIT} تذاكر. حاول مرة أخرى بعد الساعة ٠٠:٠٠ بتوقيت عمان.`
      );
      return true;
    }
  }

  const config = getGuildConfig(interaction.guildId);
  if (!config) {
    await ephemeralError(interaction, 'إعداد التذاكر غير موجود بعد. يرجى إبلاغ الإدارة لتشغيل /quick-setup أولاً.');
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await deps.createTicket({
    guild: interaction.guild,
    user: interaction.user,
    section: STREAMER_SECTION,
    reason: 'طلب انضمام كستريمر (Streamer Application)',
    config,
    lang: 'ar'
  });

  if (!result) {
    await interaction.editReply({ content: 'تعذّر إنشاء التذكرة. يرجى إبلاغ الإدارة.' });
    return true;
  }

  await startApplication(result.channel, interaction.user);
  await interaction.editReply({ content: `تم فتح تذكرتك: <#${result.channel.id}>` });
  return true;
}

async function startApplication(channel, user, member = null) {
  const resolvedMember = member || await channel.guild.members.fetch(user.id).catch(() => null);
  const applicationId = nextApplicationId(channel.guild.id);
  if (!applicationId) {
    await channel.send('تعذّر بدء الطلب: بيانات الإعداد غير موجودة. يرجى إبلاغ الإدارة.').catch(() => {});
    return null;
  }

  const application = {
    applicationId,
    userId: user.id,
    username: user.username,
    displayName: resolvedMember?.displayName || user.username,
    ticketChannelId: channel.id,
    status: 'IN_PROGRESS',
    currentStepIndex: 0,
    answers: {},
    createdAt: new Date().toISOString(),
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    needsInfoNote: null
  };

  saveApplication(channel.guild.id, application);

  // Same banner the panel shows: the ticket-welcome message carries no text
  // of its own -- just the image, with the actual first wizard question
  // (renderStep, below) as the interactive part underneath it.
  const config = getGuildConfig(channel.guild.id) || {};
  const imageAttachment = resolvePanelImageAttachment(config.streamerApplicationPanel?.imageFile);
  const welcome = imageAttachment
    ? new EmbedBuilder().setColor(deps.BRAND_COLOR).setImage(`attachment://${imageAttachment.name}`)
    : brandEmbed()
        .setTitle('🎥 طلب انضمام كستريمر')
        .setDescription(
          `مرحباً <@${user.id}>!\n\n` +
          'سيتكون هذا الطلب من عدة أقسام (7 مراحل). أجب على كل سؤال بالضغط على الزر الظاهر، ' +
          'وسينتقل البوت تلقائياً للسؤال التالي دون الحاجة لترقيم إجاباتك.\n\n' +
          `رقم الطلب: **${applicationId}**`
        );
  await channel.send({
    embeds: [welcome],
    files: imageAttachment ? [imageAttachment.attachment] : []
  }).catch(() => {});

  await renderStep(channel, application, { asUpdate: false });
  log(`Application ${applicationId} started by ${user.id} in guild ${channel.guild.id}`);
  return application;
}

// ---------------------------------------------------------------------------
// Interaction dispatch
// ---------------------------------------------------------------------------

function isStreamerAppInteraction(interaction) {
  return typeof interaction.customId === 'string' && interaction.customId.startsWith('sapp:');
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
    // Never let a failed error-notification itself become an unhandled
    // rejection -- the interaction may already be expired or otherwise
    // unusable by this point, and that is not this bot's fault.
    logError('Failed to send an ephemeral error notice:', error);
  }
}

function isApplicant(interaction, application) {
  return application && interaction.user.id === application.userId;
}

// Only these statuses accept applicant-side mutation (answering, editing,
// submitting, cancelling). Once staff have decided (or the applicant has),
// a stale button/modal from before that point must not be able to reopen or
// corrupt it -- this is the guard against duplicate/late submissions.
function isEditableStatus(status) {
  return status === 'IN_PROGRESS' || status === 'NEEDS_INFO';
}

async function guardEditable(interaction, application) {
  if (!application || !isApplicant(interaction, application)) {
    await ephemeralError(interaction, 'هذا الطلب ليس لك أو لم يعد موجوداً.');
    return false;
  }
  if (!isEditableStatus(application.status)) {
    await ephemeralError(interaction, `لا يمكن تعديل هذا الطلب في حالته الحالية (${application.status}).`);
    return false;
  }
  return true;
}

// Administrator/Manage Server are guild-level permissions, so this reads
// interaction.memberPermissions directly (same as the rest of the bot's
// hasGuildManagerPermission) rather than resolving them against whichever
// channel the button happened to be clicked in.
async function isReviewStaff(interaction) {
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  const reviewRoleIds = STREAMER_REVIEW_ROLE_IDS.length
    ? STREAMER_REVIEW_ROLE_IDS
    : [(process.env.STAFF_ROLE_ID || '').trim()].filter(Boolean);
  if (!reviewRoleIds.length) return false;

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
  return reviewRoleIds.some((roleId) => member?.roles?.cache?.has(roleId));
}

async function handleInteraction(interaction) {
  if (!isStreamerAppInteraction(interaction)) return false;

  const parts = interaction.customId.split(':');
  const kind = parts[1];

  try {
    if (kind === 'panel') return await handlePanelApply(interaction, parts);
    if (kind === 'open') return await handleOpenModal(interaction, parts);
    if (kind === 'modalsubmit') return await handleModalSubmit(interaction, parts);
    if (kind === 'yn') return await handleYesNo(interaction, parts);
    if (kind === 'msel') return await handleMultiSelect(interaction, parts);
    if (kind === 'review') return await handleReviewAction(interaction, parts);
    if (kind === 'edit') return await handleEditPick(interaction, parts);
    if (kind === 'editmodal') return await handleEditModalSubmit(interaction, parts);
    if (kind === 'edityn') return await handleEditYesNo(interaction, parts);
    if (kind === 'editmsel') return await handleEditMultiSelect(interaction, parts);
    if (kind === 'staff') return await handleStaffAction(interaction, parts);
    if (kind === 'staffrejectmodal') return await handleStaffRejectSubmit(interaction, parts);
    if (kind === 'staffinfomodal') return await handleStaffInfoSubmit(interaction, parts);
  } catch (error) {
    logError(`Unhandled error for ${interaction.customId}:`, error);
    await ephemeralError(interaction, 'حدث خطأ أثناء معالجة هذا الإجراء. حاول مرة أخرى.');
  }

  return true;
}

// ---- Wizard: open modal / submit modal / yes-no / multiselect ------------

async function handleOpenModal(interaction, parts) {
  const [, , applicationId, stepIndexStr] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  const stepIndex = Number(stepIndexStr);
  const step = STEPS[stepIndex];
  if (!step || step.kind !== 'modal') return await ephemeralError(interaction, 'خطوة غير صالحة.'), true;

  await interaction.showModal(buildModalForStep(step, application, stepIndex));
  return true;
}

async function advanceAndRender(interaction, application) {
  const nextIndex = application.currentStepIndex + 1;
  const advanced = updateApplication(interaction.guildId, application.applicationId, (app) => ({
    ...app,
    currentStepIndex: nextIndex
  })) || { ...application, currentStepIndex: nextIndex };

  await renderStep(interaction, advanced, { asUpdate: true });
}

async function handleModalSubmit(interaction, parts) {
  const [, , applicationId, stepIndexStr] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  const stepIndex = Number(stepIndexStr);
  const step = STEPS[stepIndex];
  if (!step || step.kind !== 'modal') return await ephemeralError(interaction, 'خطوة غير صالحة.'), true;

  const errors = [];
  const collected = {};
  for (const qid of step.questions) {
    const question = QUESTIONS_BY_ID.get(qid);
    const raw = interaction.fields.getTextInputValue(qid);
    const result = validateAnswer(question, raw);
    if (!result.ok) {
      errors.push(`- ${question.label}: ${result.error}`);
    } else {
      collected[qid] = result.value;
    }
  }

  if (errors.length) {
    await ephemeralError(interaction, `تحقق من إجاباتك:\n${errors.join('\n')}`);
    return true;
  }

  const updated = updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    answers: { ...app.answers, ...collected }
  }));

  log(`Application ${applicationId} completed step ${stepIndex} (stage ${step.stage})`);

  if (!interaction.isFromMessage || !interaction.isFromMessage()) {
    // Defensive fallback; in practice every modal here is opened from a
    // button on the wizard message, so update() is always available.
    await interaction.deferUpdate().catch(() => {});
  }
  await advanceAndRender(interaction, updated || application);
  return true;
}

async function handleYesNo(interaction, parts) {
  const [, , applicationId, stepIndexStr, answer] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  const stepIndex = Number(stepIndexStr);
  const step = STEPS[stepIndex];
  if (!step || step.kind !== 'yesno') return await ephemeralError(interaction, 'خطوة غير صالحة.'), true;

  const question = QUESTIONS_BY_ID.get(step.question);
  if (question.gate && answer !== 'yes') {
    await interaction.update({
      embeds: [
        stepEmbed(step, application).setDescription(
          `${stepEmbed(step, application).data.description}\n\n⚠️ يجب الموافقة على هذا البند لمتابعة الطلب.`
        )
      ],
      components: [buildYesNoRow(applicationId, stepIndex)]
    });
    return true;
  }

  const updated = updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    answers: { ...app.answers, [step.question]: answer === 'yes' ? 'نعم' : 'لا' }
  }));

  log(`Application ${applicationId} answered ${step.question}=${answer}`);
  await advanceAndRender(interaction, updated || application);
  return true;
}

async function handleMultiSelect(interaction, parts) {
  const [, , applicationId, stepIndexStr] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  const stepIndex = Number(stepIndexStr);
  const step = STEPS[stepIndex];
  if (!step || step.kind !== 'multiselect') return await ephemeralError(interaction, 'خطوة غير صالحة.'), true;

  const labels = interaction.values
    .map((value) => PLATFORM_OPTIONS.find((o) => o.value === value)?.label)
    .filter(Boolean);

  const updated = updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    answers: { ...app.answers, [step.question]: labels.join(', ') }
  }));

  await advanceAndRender(interaction, updated || application);
  return true;
}

// ---- Review / edit / submit -----------------------------------------------

function fieldLine(qid, application) {
  const question = QUESTIONS_BY_ID.get(qid);
  const value = application.answers?.[qid];
  return `**${question.label}:** ${value ? value : '_لا يوجد_'}`;
}

function buildReviewEmbeds(application) {
  const embeds = [];
  const header = brandEmbed()
    .setTitle('🎥 مراجعة طلب الانضمام كستريمر')
    .addFields(
      { name: 'المتقدم', value: application.displayName, inline: true },
      { name: 'رقم الطلب', value: application.applicationId, inline: true }
    );
  embeds.push(header);

  for (let stage = 1; stage <= 7; stage += 1) {
    const questions = QUESTIONS.filter((q) => q.stage === stage);
    const embed = brandEmbed()
      .setTitle(STAGE_TITLES[stage])
      .setDescription(questions.map((q) => fieldLine(q.id, application)).join('\n').slice(0, 4000));
    embeds.push(embed);
  }

  return embeds.slice(0, 10); // Discord caps a single message at 10 embeds.
}

function buildReviewComponents(applicationId, { editable = true } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sapp:review:submit:${applicationId}`).setLabel('✅ Submit Application').setStyle(ButtonStyle.Success)
  );
  if (editable) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`sapp:review:edit:${applicationId}`).setLabel('✏️ Edit Application').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sapp:review:cancel:${applicationId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
    );
  }
  return [row];
}

async function renderReview(interactionOrMessage, application, { asUpdate = true } = {}) {
  const payload = { embeds: buildReviewEmbeds(application), components: buildReviewComponents(application.applicationId) };
  if (asUpdate) {
    await interactionOrMessage.update(payload);
  } else {
    await interactionOrMessage.send(payload);
  }
}

async function handleReviewAction(interaction, parts) {
  const [, , action, applicationId] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  if (action === 'submit') {
    const missingGate = QUESTIONS.find((q) => q.gate && application.answers?.[q.id] !== 'نعم');
    if (missingGate) {
      await ephemeralError(interaction, `يجب الموافقة على: "${missingGate.text}" قبل الإرسال.`);
      return true;
    }

    const submitted = updateApplication(interaction.guildId, applicationId, (app) => ({
      ...app,
      status: 'PENDING_REVIEW',
      submittedAt: new Date().toISOString()
    }));

    await interaction.update({
      embeds: [brandEmbed().setTitle('✅ تم إرسال طلبك').setDescription('تم إرسال طلبك بنجاح لفريق المراجعة. سيتم إعلامك بالنتيجة قريباً.')],
      components: []
    });

    await postStaffReview(interaction.guild, submitted || application);
    log(`Application ${applicationId} submitted for review`);
    return true;
  }

  if (action === 'cancel') {
    updateApplication(interaction.guildId, applicationId, (app) => ({ ...app, status: 'CANCELLED' }));
    await interaction.update({
      embeds: [brandEmbed().setTitle('❌ تم إلغاء الطلب').setDescription('يمكنك فتح تذكرة جديدة لاحقاً إذا رغبت بالتقديم مجدداً.')],
      components: []
    });
    log(`Application ${applicationId} cancelled by applicant`);
    return true;
  }

  if (action === 'edit') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sapp:edit:${applicationId}`)
      .setPlaceholder('اختر المرحلة التي تريد تعديلها')
      .addOptions(Object.entries(STAGE_TITLES).map(([stage, title]) => ({ label: title, value: stage })));

    await interaction.update({
      embeds: [brandEmbed().setTitle('✏️ تعديل الطلب').setDescription('اختر المرحلة، ثم السؤال الذي تريد تعديله.')],
      components: [new ActionRowBuilder().addComponents(menu)]
    });
    return true;
  }

  return true;
}

async function handleEditPick(interaction, parts) {
  const [, , applicationId, stage] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  if (!stage) {
    // First select: a stage number was chosen; show that stage's questions.
    const chosenStage = interaction.values[0];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sapp:edit:${applicationId}:${chosenStage}`)
      .setPlaceholder('اختر السؤال')
      .addOptions(
        QUESTIONS.filter((q) => q.stage === Number(chosenStage)).map((q) => ({
          label: q.label.slice(0, 100),
          value: q.id
        }))
      );

    await interaction.update({
      embeds: [brandEmbed().setTitle(STAGE_TITLES[chosenStage]).setDescription('اختر السؤال الذي تريد تعديله.')],
      components: [new ActionRowBuilder().addComponents(menu)]
    });
    return true;
  }

  const questionId = interaction.values[0];
  const question = QUESTIONS_BY_ID.get(questionId);

  if (question.type === 'yesno') {
    await interaction.update({
      embeds: [brandEmbed().setTitle(STAGE_TITLES[question.stage]).addFields({ name: 'السؤال', value: question.text })],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sapp:edityn:${applicationId}:${questionId}:yes`).setLabel('✅ نعم').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`sapp:edityn:${applicationId}:${questionId}:no`).setLabel('❌ لا').setStyle(ButtonStyle.Danger)
        )
      ]
    });
    return true;
  }

  if (question.type === 'multiselect') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sapp:editmsel:${applicationId}:${questionId}`)
      .setPlaceholder('اختر منصة واحدة أو أكثر')
      .setMinValues(1)
      .setMaxValues(PLATFORM_OPTIONS.length);
    for (const option of PLATFORM_OPTIONS) menu.addOptions(option);

    await interaction.update({
      embeds: [brandEmbed().setTitle(STAGE_TITLES[question.stage]).addFields({ name: 'السؤال', value: question.text })],
      components: [new ActionRowBuilder().addComponents(menu)]
    });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`sapp:editmodal:${applicationId}:${questionId}`)
    .setTitle(STAGE_TITLES[question.stage].slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(questionId)
          .setLabel(question.label.slice(0, 45))
          .setStyle(question.type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(question.required !== false)
          .setMaxLength(Math.min(question.maxLength || 1000, 1000))
          .setValue(String(application.answers?.[questionId] || '').slice(0, 1000))
      )
    );

  await interaction.showModal(modal);
  return true;
}

async function backToReview(interaction, applicationId) {
  const application = getApplication(interaction.guildId, applicationId);
  await renderReview(interaction, application, { asUpdate: true });
}

async function handleEditModalSubmit(interaction, parts) {
  const [, , applicationId, questionId] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  const question = QUESTIONS_BY_ID.get(questionId);
  const result = validateAnswer(question, interaction.fields.getTextInputValue(questionId));
  if (!result.ok) {
    await ephemeralError(interaction, result.error);
    return true;
  }

  updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    answers: { ...app.answers, [questionId]: result.value }
  }));

  log(`Application ${applicationId} edited ${questionId}`);
  await backToReview(interaction, applicationId);
  return true;
}

async function handleEditYesNo(interaction, parts) {
  const [, , applicationId, questionId, answer] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    answers: { ...app.answers, [questionId]: answer === 'yes' ? 'نعم' : 'لا' }
  }));

  await backToReview(interaction, applicationId);
  return true;
}

async function handleEditMultiSelect(interaction, parts) {
  const [, , applicationId, questionId] = parts;
  const application = getApplication(interaction.guildId, applicationId);
  if (!(await guardEditable(interaction, application))) return true;

  const labels = interaction.values.map((value) => PLATFORM_OPTIONS.find((o) => o.value === value)?.label).filter(Boolean);
  updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    answers: { ...app.answers, [questionId]: labels.join(', ') }
  }));

  await backToReview(interaction, applicationId);
  return true;
}

// ---- Staff workflow ---------------------------------------------------

async function resolveReviewChannel(guild) {
  const config = getGuildConfig(guild.id);
  const channelId = STREAMER_REVIEW_CHANNEL_ID || config?.logChannelId;
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

function buildStaffEmbed(application) {
  const a = application.answers || {};
  return brandEmbed()
    .setTitle('🎥 NEW STREAMER APPLICATION')
    .setDescription(
      `**Application ID:** \`${application.applicationId}\`\n\n` +
      `**Applicant:** \`${application.displayName}\`\n` +
      `**User ID:** \`${application.userId}\`\n` +
      `**Ticket:** <#${application.ticketChannelId}>\n` +
      `**Submitted:** <t:${Math.floor(new Date(application.submittedAt).getTime() / 1000)}:F>`
    )
    .addFields(
      { name: '📋 Applicant Overview', value: `Age: ${a.q2 || '-'}\nFiveM Experience: ${a.q3 || '-'}\nContent Experience: ${a.q4 || '-'}` },
      { name: '🎥 Streaming', value: `Platforms: ${a.q5 || '-'}\nWeekly Hours: ${a.q7 || '-'}\nStreams/Week: ${a.q9 || '-'}\nAvg Duration: ${a.q8 || '-'}` },
      { name: '📊 Audience', value: `Avg Viewers: ${a.q17 || '-'}\nPeak Viewers: ${a.q18 || '-'}\nFollowers: ${a.q19 || '-'}` },
      { name: '🎭 ENCLAVE RP', value: `Why ENCLAVE RP: ${(a.q24 || '-').slice(0, 200)}\nWhy Streamer Role: ${(a.q25 || '-').slice(0, 200)}` }
    )
    .setTimestamp();
}

function buildStaffComponents(applicationId, { finished = false } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sapp:staff:approve:${applicationId}`).setLabel('🟢 Approve').setStyle(ButtonStyle.Success).setDisabled(finished),
    new ButtonBuilder().setCustomId(`sapp:staff:reject:${applicationId}`).setLabel('🔴 Reject').setStyle(ButtonStyle.Danger).setDisabled(finished),
    new ButtonBuilder().setCustomId(`sapp:staff:info:${applicationId}`).setLabel('🟡 Request More Information').setStyle(ButtonStyle.Secondary).setDisabled(finished)
  );
  return [row];
}

async function postStaffReview(guild, application) {
  const channel = await resolveReviewChannel(guild);
  if (!channel) {
    logError(`No review channel configured for guild ${guild.id}; application ${application.applicationId} was not posted for staff.`);
    return;
  }

  const message = await channel
    .send({ embeds: [buildStaffEmbed(application)], components: buildStaffComponents(application.applicationId) })
    .catch((error) => {
      logError(`Failed to post staff review for ${application.applicationId}:`, error);
      return null;
    });

  if (message) {
    updateApplication(guild.id, application.applicationId, (app) => ({ ...app, staffMessageId: message.id, staffChannelId: channel.id }));
  }
}

async function refreshStaffMessage(guild, application, { finished = false } = {}) {
  if (!application.staffChannelId || !application.staffMessageId) return;
  const channel = await guild.channels.fetch(application.staffChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(application.staffMessageId).catch(() => null);
  if (!message) return;

  const embed = buildStaffEmbed(application);
  if (application.status === 'APPROVED') embed.setColor(0x2ecc71).setTitle('🟢 STREAMER APPLICATION — APPROVED');
  if (application.status === 'REJECTED') embed.setColor(0xe74c3c).setTitle('🔴 STREAMER APPLICATION — REJECTED');
  if (application.status === 'NEEDS_INFO') embed.setColor(0xf1c40f).setTitle('🟡 STREAMER APPLICATION — NEEDS INFO');

  await message.edit({ embeds: [embed], components: buildStaffComponents(application.applicationId, { finished }) }).catch(() => {});
}

async function handleStaffAction(interaction, parts) {
  const [, , action, applicationId] = parts;
  if (!(await isReviewStaff(interaction))) {
    return await ephemeralError(interaction, 'ليس لديك صلاحية مراجعة طلبات الستريمر.'), true;
  }

  const application = getApplication(interaction.guildId, applicationId);
  if (!application) return await ephemeralError(interaction, 'تعذّر العثور على هذا الطلب.'), true;
  if (['APPROVED', 'REJECTED', 'CANCELLED'].includes(application.status)) {
    return await ephemeralError(interaction, `تمت معالجة هذا الطلب مسبقاً (${application.status}).`), true;
  }

  if (action === 'approve') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await approveApplication(interaction, application);
    return true;
  }

  if (action === 'reject') {
    const modal = new ModalBuilder()
      .setCustomId(`sapp:staffrejectmodal:${applicationId}`)
      .setTitle('سبب الرفض')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('سبب الرفض')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (action === 'info') {
    const modal = new ModalBuilder()
      .setCustomId(`sapp:staffinfomodal:${applicationId}`)
      .setTitle('طلب معلومات إضافية')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('ما المعلومات المطلوبة؟')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  return true;
}

async function approveApplication(interaction, application) {
  const guild = interaction.guild;
  const member = await guild.members.fetch(application.userId).catch(() => null);
  let roleAssigned = false;

  if (STREAMER_ROLE_ID && member) {
    roleAssigned = await member.roles
      .add(STREAMER_ROLE_ID, `Streamer application ${application.applicationId} approved by ${interaction.user.id}`)
      .then(() => true)
      .catch((error) => {
        logError(`Failed to assign streamer role for ${application.applicationId}:`, error);
        return false;
      });
  }

  const updated = updateApplication(guild.id, application.applicationId, (app) => ({
    ...app,
    status: 'APPROVED',
    reviewedAt: new Date().toISOString(),
    reviewedBy: interaction.user.id
  }));

  await deps.dmUser(application.userId, {
    embeds: [
      brandEmbed()
        .setColor(0x2ecc71)
        .setTitle('🎉 تم قبول طلبك للانضمام كستريمر')
        .setDescription(`تهانينا! تم قبول طلبك (${application.applicationId}) في ENCLAVE RP.` + (roleAssigned ? '\n\nتم منحك رتبة Streamer.' : ''))
    ]
  }, 'streamer application approved notice');

  await refreshStaffMessage(guild, updated || application, { finished: true });

  const channel = await guild.channels.fetch(application.ticketChannelId).catch(() => null);
  if (channel) {
    await channel.send({ embeds: [brandEmbed().setColor(0x2ecc71).setTitle('تم قبول الطلب').setDescription(`تمت الموافقة بواسطة <@${interaction.user.id}>. سيتم إغلاق هذه التذكرة الآن.`)] }).catch(() => {});
    await deps.closeAndArchiveTicket(channel, interaction.user.id).catch((error) => {
      logError(`Failed to close ticket for approved application ${application.applicationId}:`, error);
    });
  }

  await interaction.editReply({ content: `تمت الموافقة على ${application.applicationId}${roleAssigned ? ' ومنح الرتبة.' : STREAMER_ROLE_ID ? ' لكن تعذّر منح الرتبة -- تحقق من صلاحيات البوت.' : ' (لا يوجد STREAMER_ROLE_ID مضبوط).'}` });
  log(`Application ${application.applicationId} approved by ${interaction.user.id}; role assigned=${roleAssigned}`);
}

async function handleStaffRejectSubmit(interaction, parts) {
  const [, , applicationId] = parts;
  if (!(await isReviewStaff(interaction))) {
    return await ephemeralError(interaction, 'ليس لديك صلاحية مراجعة طلبات الستريمر.'), true;
  }

  const application = getApplication(interaction.guildId, applicationId);
  if (!application) return await ephemeralError(interaction, 'تعذّر العثور على هذا الطلب.'), true;

  const reason = interaction.fields.getTextInputValue('reason').trim().slice(0, 1000);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const updated = updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    status: 'REJECTED',
    reviewedAt: new Date().toISOString(),
    reviewedBy: interaction.user.id,
    rejectionReason: reason
  }));

  await deps.dmUser(application.userId, {
    embeds: [
      brandEmbed()
        .setColor(0xe74c3c)
        .setTitle('طلبك للانضمام كستريمر لم يُقبل')
        .setDescription(`طلبك (${application.applicationId}) لم يُقبل في هذه المرة.`)
        .addFields({ name: 'السبب', value: reason })
    ]
  }, 'streamer application rejected notice');

  await refreshStaffMessage(interaction.guild, updated || application, { finished: true });

  const channel = await interaction.guild.channels.fetch(application.ticketChannelId).catch(() => null);
  if (channel) {
    await channel.send({ embeds: [brandEmbed().setColor(0xe74c3c).setTitle('تم رفض الطلب').setDescription(`تم الرفض بواسطة <@${interaction.user.id}>. سيتم إغلاق هذه التذكرة الآن.`)] }).catch(() => {});
    await deps.closeAndArchiveTicket(channel, interaction.user.id).catch((error) => {
      logError(`Failed to close ticket for rejected application ${applicationId}:`, error);
    });
  }

  await interaction.editReply({ content: `تم رفض ${applicationId}.` });
  log(`Application ${applicationId} rejected by ${interaction.user.id}: ${reason}`);
  return true;
}

async function handleStaffInfoSubmit(interaction, parts) {
  const [, , applicationId] = parts;
  if (!(await isReviewStaff(interaction))) {
    return await ephemeralError(interaction, 'ليس لديك صلاحية مراجعة طلبات الستريمر.'), true;
  }

  const application = getApplication(interaction.guildId, applicationId);
  if (!application) return await ephemeralError(interaction, 'تعذّر العثور على هذا الطلب.'), true;

  const note = interaction.fields.getTextInputValue('note').trim().slice(0, 1000);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const updated = updateApplication(interaction.guildId, applicationId, (app) => ({
    ...app,
    status: 'NEEDS_INFO',
    needsInfoNote: note
  }));

  const channel = await interaction.guild.channels.fetch(application.ticketChannelId).catch(() => null);
  if (channel) {
    await channel.send({
      content: `<@${application.userId}>`,
      embeds: [brandEmbed().setColor(0xf1c40f).setTitle('🟡 مطلوب معلومات إضافية').setDescription(note)]
    }).catch(() => {});
    // Re-open the review screen with the existing answers so the applicant
    // has Edit/Submit buttons to act on the request, rather than just a
    // note with nowhere to act on it (all their prior answers are intact).
    await renderReview(channel, updated || application, { asUpdate: false }).catch(() => {});
  }
  await deps.dmUser(application.userId, {
    embeds: [brandEmbed().setColor(0xf1c40f).setTitle('مطلوب معلومات إضافية لطلبك').setDescription(`${note}\n\nيرجى الرد داخل التذكرة: <#${application.ticketChannelId}>`)]
  }, 'streamer application needs-info notice');

  await refreshStaffMessage(interaction.guild, updated || application);
  await interaction.editReply({ content: `تم إرسال طلب المعلومات لصاحب الطلب ${applicationId}. إجاباته السابقة محفوظة.` });
  log(`Application ${applicationId} marked NEEDS_INFO by ${interaction.user.id}`);
  return true;
}

module.exports = {
  init,
  isConfigured,
  publishPanel,
  startApplication,
  handleInteraction,
  isStreamerAppInteraction,
  findActiveApplicationForUser,
  getApplicationByChannel,
  // exported for tests
  QUESTIONS,
  STEPS,
  validateAnswer,
  nextApplicationId,
  APP_ID_PREFIX,
  getApplication,
  postStaffReview
};
