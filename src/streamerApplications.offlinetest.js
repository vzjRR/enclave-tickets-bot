// Offline walkthrough for the Streamer Application wizard.
//
// Unlike selftest.js, this needs no Discord token or live guild: every
// Discord object (channels, interactions, messages) is a minimal mock, and
// storage is pointed at a scratch temp directory (never the real data/) so
// this is safe to run against a live deployment's checkout without touching
// its actual ticket data. It drives the real handleInteraction()/
// startApplication() code paths -- the same functions Discord itself calls
// -- through the full 46-question wizard, review/edit, submit, and every
// staff decision (approve, reject, needs-info), plus the permission guards.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamer-app-offlinetest-'));
process.env.TICKETS_DATA_DIR = scratchDir;
process.env.STREAMER_ROLE_ID = process.env.STREAMER_ROLE_ID || 'ROLE_STREAMER';
process.env.STREAMER_APPLICATION_CATEGORY_ID = process.env.STREAMER_APPLICATION_CATEGORY_ID || 'CATEGORY_STREAMER_APP';

const sapp = require('./streamerApplications');
const { setGuildConfig, updateGuildConfig } = require('./storage');

const GUILD_ID = 'guild1';
const USER_ID = 'user1';
const STAFF_ID = 'staff1';
const CHANNEL_ID = 'chan1';

setGuildConfig(GUILD_ID, {
  sections: [],
  ticketCounter: 2000,
  logChannelId: 'logchan1',
  streamerApplicationCounter: 0
});

let dmCount = 0;
let closedTicket = null;
const roleAdds = [];
let createdTicketCount = 0;

sapp.init({
  client: { user: { id: 'BOTID' } },
  dmUser: async () => { dmCount += 1; return true; },
  closeAndArchiveTicket: async (channel, closedById) => { closedTicket = { channel: channel.id, closedById }; return { ok: true }; },
  // Mimics the real createTicket's contract (creates a channel, returns
  // { channel }) without touching Discord -- registered so guild.channels.fetch
  // can find it, matching how staff actions later look the ticket back up.
  createTicket: async ({ guild: g, section }) => {
    createdTicketCount += 1;
    const id = `chan-created-${createdTicketCount}`;
    const channel = registerChannel({ id, guild: g, send: makeMessageStore().send });
    return { channel, ticketNumber: 2000 + createdTicketCount, notified: true, section };
  },
  isTicketRateLimitExempt: () => true,
  consumeTicketRateLimit: () => ({ allowed: true, remaining: 2 }),
  setGuildConfig,
  BRAND_COLOR: 0x123456,
  BRAND_FOOTER: 'Test | Footer'
});

function makeMessageStore() {
  const messages = new Map();
  let nextId = 1;
  return {
    async send(payload) {
      const id = `msg${nextId++}`;
      const message = { id, ...payload, edit: async (editPayload) => { Object.assign(message, editPayload); return message; } };
      messages.set(id, message);
      return message;
    },
    async fetch(id) { return messages.get(id) || null; }
  };
}

// Every channel used anywhere in this file is registered here, so
// guild.channels.fetch(id) resolves it -- matching real Discord behaviour,
// where fetching a ticket channel by id (as the staff-action handlers do)
// actually returns the channel the applicant's wizard has been posting to.
const channelRegistry = new Map();
function registerChannel(channel) {
  channelRegistry.set(channel.id, channel);
  return channel;
}

const reviewMessages = makeMessageStore();
const reviewChannel = registerChannel({
  id: 'logchan1', isTextBased: () => true, send: reviewMessages.send, messages: { fetch: reviewMessages.fetch }
});

const ticketChannel = registerChannel({ id: CHANNEL_ID, send: makeMessageStore().send });

const guild = {
  id: GUILD_ID,
  channels: {
    fetch: async (id) => channelRegistry.get(id) || null
  },
  members: {
    fetch: async (id) => ({
      id,
      displayName: id === USER_ID ? 'Applicant Display' : 'Staff Display',
      roles: { add: async () => { roleAdds.push(id); } }
    })
  }
};
ticketChannel.guild = guild;

let assertions = 0;
let failures = 0;
function check(name, cond) {
  assertions += 1;
  if (!cond) { failures += 1; console.log('FAIL:', name); }
}

async function main() {
  // --- Full 46-question walkthrough, one real applicant -----------------
  const application = await sapp.startApplication(ticketChannel, { id: USER_ID, username: 'applicant' });
  check('application created', Boolean(application));
  check('application id format', /^ENCLAVE-STR-\d{4}$/.test(application.applicationId));
  check('active application found for user', Boolean(sapp.findActiveApplicationForUser(GUILD_ID, USER_ID)));

  const answersByQid = {
    q1: 'محمد', q2: '22', q3: '5 سنوات', q4: 'خبرة سنتين',
    q6: 'https://twitch.tv/mohammed', q7: '20', q8: '3', q9: '4', q10: 'مساءً',
    q11: 'لا يوجد جدول ثابت', q12: 'محتوى ترفيهي', q13: 'يركز على FiveM بشكل أساسي', q14: 'لا يوجد', q16: '',
    q17: '150', q18: '400', q19: '1000 على تويتش', q20: '500', q21: 'أمس',
    q22: 'https://twitch.tv/mohammed/clip1', q23: 'https://twitch.tv/mohammed/clip2',
    q24: 'المجتمع الرائع', q25: 'لأشارك تجربتي', q26: 'شخصية شرطي', q27: 'لا يوجد', q28: 'نعم لدي خبرة',
    q29: 'أتعاون مع أصدقائي', q30: 'محتوى جماعي', q31: 'محتوى قصص طويلة',
    q34: 'لا يوجد حظر سابق', q42: 'اقتراح: مسابقات شهرية'
  };

  for (let i = 0; i < sapp.STEPS.length; i += 1) {
    const step = sapp.STEPS[i];
    if (step.kind === 'modal') {
      const interaction = {
        customId: `sapp:modalsubmit:${application.applicationId}:${i}`,
        guildId: GUILD_ID, guild, user: { id: USER_ID },
        fields: { getTextInputValue: (qid) => (answersByQid[qid] ?? '') },
        isFromMessage: () => true,
        update: async () => {}
      };
      check(`modal step ${i} handled`, (await sapp.handleInteraction(interaction)) === true);
    } else if (step.kind === 'yesno') {
      const question = sapp.QUESTIONS.find((q) => q.id === step.question);
      const interaction = {
        customId: `sapp:yn:${application.applicationId}:${i}:${question.gate ? 'yes' : (i % 3 === 0 ? 'no' : 'yes')}`,
        guildId: GUILD_ID, guild, user: { id: USER_ID }, update: async () => {}
      };
      check(`yesno step ${i} handled`, (await sapp.handleInteraction(interaction)) === true);
    } else if (step.kind === 'multiselect') {
      const interaction = {
        customId: `sapp:msel:${application.applicationId}:${i}`,
        guildId: GUILD_ID, guild, user: { id: USER_ID }, values: ['twitch', 'youtube'], update: async () => {}
      };
      check(`multiselect step ${i} handled`, (await sapp.handleInteraction(interaction)) === true);
    }
  }

  let current = sapp.getApplicationByChannel(GUILD_ID, CHANNEL_ID);
  check('all 25 steps completed', current.currentStepIndex >= sapp.STEPS.length);
  check('q5 multiselect recorded', current.answers.q5 === 'Twitch, YouTube');
  check('q1 answer recorded', current.answers.q1 === 'محمد');

  // --- Review: submit ------------------------------------------------------
  await sapp.handleInteraction({
    customId: `sapp:review:submit:${application.applicationId}`,
    guildId: GUILD_ID, guild, user: { id: USER_ID }, update: async () => {}
  });
  current = sapp.getApplicationByChannel(GUILD_ID, CHANNEL_ID);
  check('status PENDING_REVIEW after submit', current.status === 'PENDING_REVIEW');
  check('staff review posted', Boolean(current.staffMessageId));

  // --- Security: a non-owner cannot touch this application -----------------
  let unauthorizedReply = null;
  await sapp.handleInteraction({
    customId: `sapp:review:cancel:${application.applicationId}`,
    guildId: GUILD_ID, guild, user: { id: 'intruder' },
    deferred: false, replied: false,
    reply: async (payload) => { unauthorizedReply = payload; },
    update: async () => { throw new Error('must not update for a non-owner'); }
  });
  check('unauthorized user blocked (IDOR guard)', Boolean(unauthorizedReply));
  check('status unaffected by unauthorized attempt', sapp.getApplication(GUILD_ID, application.applicationId).status === 'PENDING_REVIEW');

  // --- Security: a member without review permission cannot approve --------
  let staffDeniedReply = null;
  await sapp.handleInteraction({
    customId: `sapp:staff:approve:${application.applicationId}`,
    guildId: GUILD_ID, guild, user: { id: 'randommember' },
    memberPermissions: { has: () => false },
    deferred: false, replied: false,
    reply: async (payload) => { staffDeniedReply = payload; }
  });
  check('non-staff member blocked from approving', Boolean(staffDeniedReply));

  // --- Staff approves --------------------------------------------------
  let approveReply = null;
  const approveInteraction = {
    customId: `sapp:staff:approve:${application.applicationId}`,
    guildId: GUILD_ID, guild, channel: ticketChannel, user: { id: STAFF_ID },
    memberPermissions: { has: () => true },
    deferred: false, replied: false,
    deferReply: async () => { approveInteraction.deferred = true; },
    editReply: async (payload) => { approveReply = payload; },
    reply: async (payload) => { approveReply = payload; }
  };
  check('approve handled', (await sapp.handleInteraction(approveInteraction)) === true);
  check('approve reply sent', Boolean(approveReply));
  check('role assigned', roleAdds.includes(USER_ID));
  check('DM sent on approval', dmCount > 0);
  check('ticket closed via existing closeAndArchiveTicket', Boolean(closedTicket) && closedTicket.closedById === STAFF_ID);
  check('status APPROVED', sapp.getApplication(GUILD_ID, application.applicationId).status === 'APPROVED');

  // --- A stale submit on an already-decided application is refused ---------
  {
    let staleReply = null;
    await sapp.handleInteraction({
      customId: `sapp:review:submit:${application.applicationId}`,
      guildId: GUILD_ID, guild, user: { id: USER_ID },
      deferred: false, replied: false,
      reply: async (payload) => { staleReply = payload; },
      update: async () => { throw new Error('must not update a non-editable application'); }
    });
    check('stale submit on an approved application is refused', Boolean(staleReply));
  }

  // --- Duplicate approve is rejected (idempotency) --------------------------
  let dupReply = null;
  await sapp.handleInteraction({
    customId: `sapp:staff:approve:${application.applicationId}`,
    guildId: GUILD_ID, guild, channel: ticketChannel, user: { id: STAFF_ID },
    memberPermissions: { has: () => true },
    deferred: false, replied: false,
    reply: async (payload) => { dupReply = payload; }
  });
  check('duplicate approval rejected', Boolean(dupReply));

  // --- Gate question: "no" must not advance ---------------------------------
  {
    const gateChannel = registerChannel({ id: 'chan-gate', guild, send: makeMessageStore().send });
    const gateApp = await sapp.startApplication(gateChannel, { id: 'user-gate', username: 'gateuser' });
    const gateStepIndex = sapp.STEPS.findIndex((s) => s.kind === 'yesno' && s.question === 'q32');
    updateGuildConfig(GUILD_ID, (config) => ({
      ...config,
      streamerApplications: {
        ...config.streamerApplications,
        [gateApp.applicationId]: { ...config.streamerApplications[gateApp.applicationId], currentStepIndex: gateStepIndex }
      }
    }));

    await sapp.handleInteraction({
      customId: `sapp:yn:${gateApp.applicationId}:${gateStepIndex}:no`,
      guildId: GUILD_ID, guild, user: { id: 'user-gate' }, update: async () => {}
    });
    check('gate question "no" does not advance', sapp.getApplication(GUILD_ID, gateApp.applicationId).currentStepIndex === gateStepIndex);

    await sapp.handleInteraction({
      customId: `sapp:yn:${gateApp.applicationId}:${gateStepIndex}:yes`,
      guildId: GUILD_ID, guild, user: { id: 'user-gate' }, update: async () => {}
    });
    check('gate question "yes" advances', sapp.getApplication(GUILD_ID, gateApp.applicationId).currentStepIndex === gateStepIndex + 1);
  }

  // --- Reject path -----------------------------------------------------
  {
    const rejectChannel = registerChannel({ id: 'chan-reject', guild, send: makeMessageStore().send });
    const rejectApp = await sapp.startApplication(rejectChannel, { id: 'user-reject', username: 'rejectuser' });
    updateGuildConfig(GUILD_ID, (config) => ({
      ...config,
      streamerApplications: {
        ...config.streamerApplications,
        [rejectApp.applicationId]: { ...config.streamerApplications[rejectApp.applicationId], status: 'PENDING_REVIEW', submittedAt: new Date().toISOString() }
      }
    }));
    await sapp.postStaffReview(guild, sapp.getApplication(GUILD_ID, rejectApp.applicationId));

    let rejectReply = null;
    const rejectSubmit = {
      customId: `sapp:staffrejectmodal:${rejectApp.applicationId}`,
      guildId: GUILD_ID, guild, user: { id: STAFF_ID },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => 'المحتوى لا يتناسب مع سياسة السيرفر' },
      deferred: false, replied: false,
      deferReply: async () => { rejectSubmit.deferred = true; },
      editReply: async (payload) => { rejectReply = payload; },
      reply: async (payload) => { rejectReply = payload; }
    };
    check('reject handled', (await sapp.handleInteraction(rejectSubmit)) === true);
    check('reject reply sent', Boolean(rejectReply));
    const afterReject = sapp.getApplication(GUILD_ID, rejectApp.applicationId);
    check('status REJECTED', afterReject.status === 'REJECTED');
    check('rejection reason recorded', afterReject.rejectionReason === 'المحتوى لا يتناسب مع سياسة السيرفر');
  }

  // --- Needs-info path preserves prior answers ------------------------------
  {
    const infoStore = makeMessageStore();
    let infoSendCount = 0;
    const infoChannel = registerChannel({ id: 'chan-info', guild, send: (payload) => { infoSendCount += 1; return infoStore.send(payload); } });
    const infoApp = await sapp.startApplication(infoChannel, { id: 'user-info', username: 'infouser' });
    updateGuildConfig(GUILD_ID, (config) => ({
      ...config,
      streamerApplications: {
        ...config.streamerApplications,
        [infoApp.applicationId]: {
          ...config.streamerApplications[infoApp.applicationId],
          status: 'PENDING_REVIEW', submittedAt: new Date().toISOString(), answers: { q1: 'اسم تجريبي' }
        }
      }
    }));
    await sapp.postStaffReview(guild, sapp.getApplication(GUILD_ID, infoApp.applicationId));
    const infoSendCountBefore = infoSendCount;

    let infoReply = null;
    const infoSubmit = {
      customId: `sapp:staffinfomodal:${infoApp.applicationId}`,
      guildId: GUILD_ID, guild, user: { id: STAFF_ID },
      memberPermissions: { has: () => true },
      fields: { getTextInputValue: () => 'يرجى إرسال رابط قناتك على تويتش' },
      deferred: false, replied: false,
      deferReply: async () => { infoSubmit.deferred = true; },
      editReply: async (payload) => { infoReply = payload; },
      reply: async (payload) => { infoReply = payload; }
    };
    check('needs-info handled', (await sapp.handleInteraction(infoSubmit)) === true);
    check('needs-info reply sent', Boolean(infoReply));
    const afterInfo = sapp.getApplication(GUILD_ID, infoApp.applicationId);
    check('status NEEDS_INFO', afterInfo.status === 'NEEDS_INFO');
    check('previous answers preserved through needs-info', afterInfo.answers.q1 === 'اسم تجريبي');
    check(
      'needs-info sends the notice and re-posts the review screen to the ticket channel',
      infoSendCount - infoSendCountBefore === 2
    );
  }

  // --- Edit flow: review -> edit -> stage -> question -> re-answer -> review ---
  {
    const editChannel = registerChannel({ id: 'chan-edit', guild, send: makeMessageStore().send });
    const editApp = await sapp.startApplication(editChannel, { id: 'user-edit', username: 'edituser' });
    updateGuildConfig(GUILD_ID, (config) => ({
      ...config,
      streamerApplications: {
        ...config.streamerApplications,
        [editApp.applicationId]: { ...config.streamerApplications[editApp.applicationId], answers: { q1: 'اسم قديم', q15: 'لا' } }
      }
    }));

    await sapp.handleInteraction({
      customId: `sapp:review:edit:${editApp.applicationId}`,
      guildId: GUILD_ID, guild, user: { id: 'user-edit' }, update: async () => {}
    });
    await sapp.handleInteraction({
      customId: `sapp:edit:${editApp.applicationId}`,
      guildId: GUILD_ID, guild, user: { id: 'user-edit' }, values: ['1'], update: async () => {}
    });

    let q1ModalShown = null;
    await sapp.handleInteraction({
      customId: `sapp:edit:${editApp.applicationId}:1`,
      guildId: GUILD_ID, guild, user: { id: 'user-edit' }, values: ['q1'],
      showModal: async (modal) => { q1ModalShown = modal; }
    });
    check('editing a short-text question opens a modal', Boolean(q1ModalShown));
    check('edit modal pre-fills the current answer', JSON.stringify(q1ModalShown.toJSON()).includes('اسم قديم'));

    await sapp.handleInteraction({
      customId: `sapp:editmodal:${editApp.applicationId}:q1`,
      guildId: GUILD_ID, guild, user: { id: 'user-edit' },
      fields: { getTextInputValue: () => 'اسم جديد' }, update: async () => {}
    });
    check('q1 answer updated via edit flow', sapp.getApplication(GUILD_ID, editApp.applicationId).answers.q1 === 'اسم جديد');

    await sapp.handleInteraction({
      customId: `sapp:edityn:${editApp.applicationId}:q15:yes`,
      guildId: GUILD_ID, guild, user: { id: 'user-edit' }, update: async () => {}
    });
    check('q15 answer updated via edit-yesno flow', sapp.getApplication(GUILD_ID, editApp.applicationId).answers.q15 === 'نعم');

    let intruderEditReply = null;
    await sapp.handleInteraction({
      customId: `sapp:edit:${editApp.applicationId}`,
      guildId: GUILD_ID, guild, user: { id: 'someone-else' },
      deferred: false, replied: false,
      reply: async (payload) => { intruderEditReply = payload; },
      update: async () => { throw new Error('must not update for a non-owner'); }
    });
    check('non-owner blocked from editing', Boolean(intruderEditReply));
  }

  // --- Duplicate-application prevention ---------------------------------
  {
    const dupChannel = registerChannel({ id: 'chan-dup', guild, send: makeMessageStore().send });
    await sapp.startApplication(dupChannel, { id: 'user-dup', username: 'dupuser' });
    check('active application detected for duplicate-prevention check', Boolean(sapp.findActiveApplicationForUser(GUILD_ID, 'user-dup')));
  }

  // --- The dedicated panel: /streamer-setup publishes it, separately from
  // the ordinary ticket panel/config.sections, and its Apply button creates
  // a ticket + starts the wizard the same way the old in-panel entry did ---
  {
    const panelStore = makeMessageStore();
    const panelChannel = registerChannel({
      id: 'chan-panel', guild, isTextBased: () => true,
      send: panelStore.send, messages: { fetch: panelStore.fetch }
    });

    const published = await sapp.publishPanel(guild, panelChannel);
    check('publishPanel posts a fresh panel', published.ok === true && published.reused === false);

    const configAfterPublish = require('./storage').getGuildConfig(GUILD_ID);
    check(
      'panel location is stored under its own key, not config.sections',
      configAfterPublish.streamerApplicationPanel?.channelId === 'chan-panel' &&
        !(configAfterPublish.sections || []).some((s) => s.name === 'Streamer Application')
    );

    const republished = await sapp.publishPanel(guild, panelChannel);
    check('publishPanel edits the existing message in place on a second call', republished.reused === true);

    let applyReply = null;
    const applyInteraction = {
      customId: 'sapp:panel:apply',
      guildId: GUILD_ID, guild, user: { id: 'user-apply' },
      deferred: false, replied: false,
      deferReply: async () => { applyInteraction.deferred = true; },
      editReply: async (payload) => { applyReply = payload; }
    };
    check('apply button handled', (await sapp.handleInteraction(applyInteraction)) === true);
    check('apply button created a ticket and started the wizard', Boolean(applyReply?.content?.includes('تذكرتك')));
    check(
      'the created application is not tied to any config.sections entry',
      Boolean(sapp.findActiveApplicationForUser(GUILD_ID, 'user-apply'))
    );

    let dupApplyReply = null;
    const dupApplyInteraction = {
      customId: 'sapp:panel:apply',
      guildId: GUILD_ID, guild, user: { id: 'user-apply' },
      deferred: false, replied: false,
      reply: async (payload) => { dupApplyReply = payload; }
    };
    await sapp.handleInteraction(dupApplyInteraction);
    check('a second Apply click while one is active is blocked', Boolean(dupApplyReply));
  }

  console.log(`\n${assertions} checks, ${failures} failed`);
  fs.rmSync(scratchDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('OFFLINE WALKTHROUGH CRASHED:', error);
  fs.rmSync(scratchDir, { recursive: true, force: true });
  process.exit(1);
});
