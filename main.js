import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import pg from 'pg';

const { Pool } = pg;

// -----------------------------------------------------------------------------
// Paradise Roleplay • Paradise Operations
// Verification foundation
// -----------------------------------------------------------------------------

const CONFIG = Object.freeze({
  verificationChannelId: '1534248667211370668',
  supportChannelId: '1534248939707039919',
  staffLogsChannelId: '1534269523430215751',
  communityMemberRoleId: '1534240825993723914',

  dockApiBaseUrl: 'https://api.docksys.xyz',
  dockApiKey: process.env.DOCK_API_KEY?.trim(),
  dockPid: process.env.DOCK_PID?.trim(),

  // You have not picked a minimum Roblox account age yet.
  // Leave Railway variable MIN_ROBLOX_ACCOUNT_AGE_DAYS unset (or 0) for now.
  minimumRobloxAccountAgeDays: Number.parseInt(
    process.env.MIN_ROBLOX_ACCOUNT_AGE_DAYS ?? '0',
    10,
  ) || 0,
});

const TOKEN = process.env.TOKEN?.trim() || process.env.DISCORD_TOKEN?.trim();

if (!TOKEN) {
  throw new Error('Missing TOKEN (or DISCORD_TOKEN) Railway variable.');
}

if (!CONFIG.dockApiKey) {
  throw new Error('Missing DOCK_API_KEY Railway variable.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});


const database = process.env.DATABASE_URL?.trim()
  ? new Pool({ connectionString: process.env.DATABASE_URL.trim() })
  : null;

async function initializeDatabase() {
  if (!database) {
    console.warn('[database] DATABASE_URL is not set. Verification will work, but database history is disabled.');
    return;
  }

  await database.query(`
    CREATE TABLE IF NOT EXISTS paradise_verified_users (
      discord_id TEXT PRIMARY KEY,
      roblox_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      roblox_display_name TEXT,
      account_age_days INTEGER,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verification_method TEXT
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS paradise_verification_history (
      id BIGSERIAL PRIMARY KEY,
      discord_id TEXT NOT NULL,
      roblox_id TEXT,
      roblox_username TEXT,
      status TEXT NOT NULL,
      method TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('[database] Verification tables are ready.');
}

async function recordVerificationHistory({
  discordId,
  robloxId = null,
  robloxUsername = null,
  status,
  method = null,
  details = {},
}) {
  if (!database) return;

  try {
    await database.query(
      `INSERT INTO paradise_verification_history
       (discord_id, roblox_id, roblox_username, status, method, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        discordId,
        robloxId,
        robloxUsername,
        status,
        method,
        JSON.stringify(details),
      ],
    );
  } catch (error) {
    console.error('[database] Failed to record verification history:', error);
  }
}

async function upsertVerifiedUser({
  discordId,
  profile,
  ageDays,
  method,
}) {
  if (!database) return;

  try {
    await database.query(
      `INSERT INTO paradise_verified_users
       (discord_id, roblox_id, roblox_username, roblox_display_name, account_age_days, verification_method)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (discord_id) DO UPDATE SET
         roblox_id = EXCLUDED.roblox_id,
         roblox_username = EXCLUDED.roblox_username,
         roblox_display_name = EXCLUDED.roblox_display_name,
         account_age_days = EXCLUDED.account_age_days,
         verification_method = EXCLUDED.verification_method,
         last_synced_at = NOW()`,
      [
        discordId,
        profile.id,
        profile.username,
        profile.displayName,
        ageDays,
        method,
      ],
    );
  } catch (error) {
    console.error('[database] Failed to upsert verified user:', error);
  }
}

const COLORS = Object.freeze({
  paradiseFall: 0xB96F3D,
  success: 0x4FAE73,
  warning: 0xD99A3D,
  danger: 0xC94F4F,
  neutral: 0x8B8D91,
});

const IDS = Object.freeze({
  verify: 'pr_verify_start',
  check: 'pr_verify_check',
  reverify: 'pr_verify_reverify',
  completePrefix: 'pr_verify_complete:',
});

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function separator() {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small);
}

function makeContainer({ title, body, accent = COLORS.paradiseFall, buttons = [] }) {
  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      text(`# ${title}`),
      text(body),
    );

  if (buttons.length) {
    const row = new ActionRowBuilder().addComponents(...buttons);
    container
      .addSeparatorComponents(separator())
      .addActionRowComponents(row);
  }

  return container;
}

function supportUrl(guildId) {
  return `https://discord.com/channels/${guildId}/${CONFIG.supportChannelId}`;
}

function verificationPanel(guildId) {
  return makeContainer({
    title: 'Paradise Roleplay Verification',
    body:
      '**Verify your Roblox account to access Paradise Roleplay.**\n\n' +
      'Paradise Operations uses **Dock** to securely connect your Discord account to Roblox. ' +
      'After verification, your server nickname will automatically become your Roblox username in the format `@username` and you will receive the Community Member role.\n\n' +
      '-# Your Dock API key is never shown to members or stored in Discord.',
    buttons: [
      new ButtonBuilder()
        .setCustomId(IDS.verify)
        .setLabel('Verify Account')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(IDS.check)
        .setLabel('Check Status')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(IDS.reverify)
        .setLabel('Reverify')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setLabel('Support')
        .setStyle(ButtonStyle.Link)
        .setURL(supportUrl(guildId)),
    ],
  });
}

function resultContainer(title, body, accent = COLORS.neutral, buttons = []) {
  return makeContainer({ title, body, accent, buttons });
}

async function dockRequest(path, options = {}) {
  const response = await fetch(`${CONFIG.dockApiBaseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CONFIG.dockApiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || `Dock API returned HTTP ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function lookupDockLink(discordId, guildId) {
  const query = new URLSearchParams({
    discordId,
    guildId,
  });

  try {
    const payload = await dockRequest(
      `/api/v1/public/discord-to-roblox?${query.toString()}`,
      { method: 'GET' },
    );

    const robloxId = payload?.data?.robloxId;
    return robloxId ? String(robloxId) : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function createDockVerificationSession(discordId, guildId) {
  if (!CONFIG.dockPid) {
    const error = new Error('DOCK_PID is not configured.');
    error.code = 'DOCK_PID_MISSING';
    throw error;
  }

  const payload = await dockRequest('/api/v1/verify/session', {
    method: 'POST',
    body: JSON.stringify({
      pid: CONFIG.dockPid,
      clientId: discordId,
      guildId,
    }),
  });

  const session = payload?.data;
  if (!session?.sid || !session?.verifyUrl) {
    throw new Error('Dock did not return a valid verification session.');
  }

  return {
    sid: String(session.sid),
    verifyUrl: String(session.verifyUrl),
    expiresAt: session.expiresAt ? String(session.expiresAt) : null,
  };
}

async function getDockVerificationSession(sid) {
  return dockRequest(
    `/api/v1/verify/session/${encodeURIComponent(sid)}?wait=3`,
    { method: 'GET' },
  );
}

async function fetchRobloxUser(robloxId) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://users.roblox.com/v1/users/${encodeURIComponent(robloxId)}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`Roblox users API returned HTTP ${response.status}.`);
      }

      const profile = await response.json();

      if (!profile?.name) {
        throw new Error('Roblox profile did not include a username.');
      }

      return {
        id: String(profile.id ?? robloxId),
        username: String(profile.name),
        displayName: String(profile.displayName ?? profile.name),
        created: profile.created ? String(profile.created) : null,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  throw lastError;
}

function accountAgeDays(createdAt) {
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - created.getTime()) / 86_400_000));
}

async function safeStaffLog(guild, body, accent = COLORS.neutral) {
  try {
    const channel = await guild.channels.fetch(CONFIG.staffLogsChannelId);
    if (!channel?.isTextBased()) return;

    await channel.send({
      components: [
        resultContainer('Verification Log', body, accent),
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('[verification] Failed to send staff log:', error);
  }
}

async function finalizeVerification(interaction, robloxId, method = 'Dock') {
  const guild = interaction.guild;
  if (!guild) throw new Error('Verification must be completed inside the server.');

  const member = interaction.member;
  if (!member || typeof member.roles?.add !== 'function') {
    throw new Error('Could not resolve the Discord member.');
  }

  const profile = await fetchRobloxUser(robloxId);
  const ageDays = accountAgeDays(profile.created);

  if (
    CONFIG.minimumRobloxAccountAgeDays > 0 &&
    ageDays !== null &&
    ageDays < CONFIG.minimumRobloxAccountAgeDays
  ) {
    await recordVerificationHistory({
      discordId: interaction.user.id,
      robloxId: profile.id,
      robloxUsername: profile.username,
      status: 'account_age_failed',
      method,
      details: {
        accountAgeDays: ageDays,
        minimumDays: CONFIG.minimumRobloxAccountAgeDays,
      },
    });

    await safeStaffLog(
      guild,
      `**Result:** Account-age requirement failed\n` +
        `**Discord:** <@${interaction.user.id}> (\`${interaction.user.id}\`)\n` +
        `**Roblox:** @${profile.username} (\`${profile.id}\`)\n` +
        `**Account age:** ${ageDays} day${ageDays === 1 ? '' : 's'}\n` +
        `**Minimum:** ${CONFIG.minimumRobloxAccountAgeDays} days`,
      COLORS.warning,
    );

    return {
      ok: false,
      container: resultContainer(
        'Verification Requirement Not Met',
        `Your Roblox account is linked correctly, but it does not currently meet Paradise Roleplay's account-age requirement.\n\n` +
          `**Roblox:** @${profile.username}\n` +
          `**Account age:** ${ageDays} day${ageDays === 1 ? '' : 's'}\n\n` +
          `If you believe this is incorrect, please contact Support.`,
        COLORS.warning,
        [
          new ButtonBuilder()
            .setLabel('Support')
            .setStyle(ButtonStyle.Link)
            .setURL(supportUrl(guild.id)),
        ],
      ),
    };
  }

  const role = guild.roles.cache.get(CONFIG.communityMemberRoleId)
    ?? await guild.roles.fetch(CONFIG.communityMemberRoleId).catch(() => null);

  if (!role) {
    throw new Error('Community Member role could not be found.');
  }

  let roleAdded = false;
  let nicknameUpdated = false;
  let nicknameError = null;

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role, `Paradise verification: @${profile.username} (${profile.id})`);
    roleAdded = true;
  }

  const desiredNickname = `@${profile.username}`;
  if (member.nickname !== desiredNickname) {
    try {
      await member.setNickname(
        desiredNickname,
        `Paradise verification: Roblox ID ${profile.id}`,
      );
      nicknameUpdated = true;
    } catch (error) {
      nicknameError = error;
      console.warn(`[verification] Nickname update failed for ${interaction.user.id}:`, error?.message);
    }
  }

  await upsertVerifiedUser({
    discordId: interaction.user.id,
    profile,
    ageDays,
    method,
  });

  await recordVerificationHistory({
    discordId: interaction.user.id,
    robloxId: profile.id,
    robloxUsername: profile.username,
    status: nicknameError ? 'verified_nickname_warning' : 'verified',
    method,
    details: {
      roleAdded,
      nicknameUpdated,
      nicknameError: nicknameError ? String(nicknameError.message ?? nicknameError) : null,
      accountAgeDays: ageDays,
    },
  });

  await safeStaffLog(
    guild,
    `**Result:** Verified\n` +
      `**Discord:** <@${interaction.user.id}> (\`${interaction.user.id}\`)\n` +
      `**Roblox:** @${profile.username} (\`${profile.id}\`)\n` +
      `**Display name:** ${profile.displayName}\n` +
      `**Account age:** ${ageDays === null ? 'Unknown' : `${ageDays} days`}\n` +
      `**Method:** ${method}\n` +
      `**Community Member:** ${roleAdded ? 'Added' : 'Already present'}\n` +
      `**Nickname:** ${nicknameError ? 'Could not update (role hierarchy/permission)' : nicknameUpdated ? `Updated to @${profile.username}` : 'Already correct'}`,
    nicknameError ? COLORS.warning : COLORS.success,
  );

  const nicknameNote = nicknameError
    ? '\n\n**Note:** Your role was verified, but I could not change your nickname. An administrator may need to move the Paradise Operations bot role higher in the role list or grant **Manage Nicknames**.'
    : '';

  return {
    ok: true,
    container: resultContainer(
      'Verification Complete',
      `You are now verified for **Paradise Roleplay**.\n\n` +
        `**Roblox:** @${profile.username}\n` +
        `**Display name:** ${profile.displayName}\n` +
        `**Roblox ID:** \`${profile.id}\`\n` +
        `**Nickname:** \`@${profile.username}\`\n` +
        `**Role:** <@&${CONFIG.communityMemberRoleId}>` +
        nicknameNote,
      nicknameError ? COLORS.warning : COLORS.success,
    ),
  };
}

async function beginVerification(interaction, forceSession = false) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });

  try {
    if (!forceSession) {
      const existingRobloxId = await lookupDockLink(interaction.user.id, interaction.guildId);

      if (existingRobloxId) {
        const result = await finalizeVerification(
          interaction,
          existingRobloxId,
          'Dock existing link',
        );

        await interaction.editReply({ components: [result.container] });
        return;
      }
    }

    const session = await createDockVerificationSession(
      interaction.user.id,
      interaction.guildId,
    );

    const completeCustomId = `${IDS.completePrefix}${session.sid}`;
    if (completeCustomId.length > 100) {
      throw new Error('Dock session ID is too long for a Discord component custom ID.');
    }

    const expiry = session.expiresAt
      ? `\n-# This verification session expires <t:${Math.floor(new Date(session.expiresAt).getTime() / 1000)}:R>.`
      : '';

    const container = resultContainer(
      'Connect Your Roblox Account',
      `1. Press **Open Dock Verification** below.\n` +
        `2. Complete the Roblox verification on Dock.\n` +
        `3. Return to Discord and press **Complete Verification**.\n\n` +
        `Paradise Operations will then confirm the link directly with Dock, add your Community Member role, and set your nickname to \`@username\`.` +
        expiry,
      COLORS.paradiseFall,
      [
        new ButtonBuilder()
          .setLabel('Open Dock Verification')
          .setStyle(ButtonStyle.Link)
          .setURL(session.verifyUrl),
        new ButtonBuilder()
          .setCustomId(completeCustomId)
          .setLabel('Complete Verification')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setLabel('Support')
          .setStyle(ButtonStyle.Link)
          .setURL(supportUrl(interaction.guildId)),
      ],
    );

    await interaction.editReply({ components: [container] });
  } catch (error) {
    await handleVerificationError(interaction, error);
  }
}

async function checkVerification(interaction, sync = false) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });

  try {
    const robloxId = await lookupDockLink(interaction.user.id, interaction.guildId);

    if (!robloxId) {
      const buttons = [];

      if (CONFIG.dockPid) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(IDS.verify)
            .setLabel('Verify Now')
            .setStyle(ButtonStyle.Primary),
        );
      }

      buttons.push(
        new ButtonBuilder()
          .setLabel('Support')
          .setStyle(ButtonStyle.Link)
          .setURL(supportUrl(interaction.guildId)),
      );

      await interaction.editReply({
        components: [
          resultContainer(
            'Not Verified Yet',
            `Dock does not currently have a Roblox account linked to your Discord account for Paradise Roleplay.`,
            COLORS.warning,
            buttons,
          ),
        ],
      });
      return;
    }

    if (sync) {
      const result = await finalizeVerification(
        interaction,
        robloxId,
        'Dock reverify',
      );
      await interaction.editReply({ components: [result.container] });
      return;
    }

    const profile = await fetchRobloxUser(robloxId);
    const ageDays = accountAgeDays(profile.created);

    await interaction.editReply({
      components: [
        resultContainer(
          'Verification Status',
          `**Status:** Verified with Dock\n` +
            `**Roblox:** @${profile.username}\n` +
            `**Display name:** ${profile.displayName}\n` +
            `**Roblox ID:** \`${profile.id}\`\n` +
            `**Account age:** ${ageDays === null ? 'Unknown' : `${ageDays} days`}\n\n` +
            `Use **Reverify** on the main panel if your Roblox link changed or your nickname/role needs to be resynced.`,
          COLORS.success,
        ),
      ],
    });
  } catch (error) {
    await handleVerificationError(interaction, error);
  }
}

async function completeVerificationSession(interaction, sid) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });

  try {
    const sessionPayload = await getDockVerificationSession(sid);
    const result = sessionPayload?.data?.result ?? null;

    if (!result) {
      await interaction.editReply({
        components: [
          resultContainer(
            'Verification Still Pending',
            `Dock has not completed this verification session yet.\n\n` +
              `Finish the verification in Dock, then press **Complete Verification** again.`,
            COLORS.warning,
            [
              new ButtonBuilder()
                .setCustomId(`${IDS.completePrefix}${sid}`)
                .setLabel('Check Again')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setLabel('Support')
                .setStyle(ButtonStyle.Link)
                .setURL(supportUrl(interaction.guildId)),
            ],
          ),
        ],
      });
      return;
    }

    // Security check: after Dock says the session completed, do not trust a Roblox
    // ID from the button/session itself. Re-query Dock using the Discord user who
    // actually clicked the button.
    const robloxId = await lookupDockLink(
      interaction.user.id,
      interaction.guildId,
    );

    if (!robloxId) {
      throw new Error(
        'Dock marked the session complete, but no Roblox link was returned for this Discord account.',
      );
    }

    const verification = await finalizeVerification(
      interaction,
      robloxId,
      'Dock verification session',
    );

    await interaction.editReply({
      components: [verification.container],
    });
  } catch (error) {
    await handleVerificationError(interaction, error);
  }
}

async function handleVerificationError(interaction, error) {
  console.error('[verification]', error);

  let message =
    'Paradise Operations could not complete verification right now. Please try again in a moment.';

  if (error.code === 'DOCK_PID_MISSING') {
    message =
      'The Paradise verification connection is not fully configured yet. Please contact Support.';
  } else if (error.status === 401) {
    message =
      'The Dock connection is not authorized. An owner needs to check the Dock API key.';
  } else if (error.status === 403) {
    message =
      'Dock could not verify your account for this server. Make sure you are still in Paradise Roleplay and try again.';
  } else if (error.status === 429) {
    const retryAfter = Number(error.payload?.retryAfter);
    message = Number.isFinite(retryAfter)
      ? `Dock is temporarily rate-limiting verification. Try again in about ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
      : 'Dock is temporarily rate-limiting verification. Please try again shortly.';
  }

  const container = resultContainer(
    'Verification Error',
    `${message}\n\nIf this continues, use the Support button below.`,
    COLORS.danger,
    interaction.guildId
      ? [
          new ButtonBuilder()
            .setLabel('Support')
            .setStyle(ButtonStyle.Link)
            .setURL(supportUrl(interaction.guildId)),
        ]
      : [],
  );

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ components: [container] });
    } else {
      await interaction.reply({
        components: [container],
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
    }
  } catch (replyError) {
    console.error('[verification] Failed to reply with error:', replyError);
  }

  if (interaction.guild) {
    await safeStaffLog(
      interaction.guild,
      `**Result:** Verification system error\n` +
        `**Discord:** <@${interaction.user.id}> (\`${interaction.user.id}\`)\n` +
        `**Error:** ${String(error?.message ?? error).slice(0, 1000)}`,
      COLORS.danger,
    );
  }
}

function messageContainsVerificationPanel(message) {
  try {
    return (
      message.author?.id === client.user?.id &&
      JSON.stringify(message.components).includes(IDS.verify)
    );
  } catch {
    return false;
  }
}

async function ensureVerificationPanel() {
  const channel = await client.channels.fetch(CONFIG.verificationChannelId);

  if (!channel?.isTextBased()) {
    throw new Error('Verification channel is missing or is not a text channel.');
  }

  const guildId = channel.guild?.id;
  if (!guildId) {
    throw new Error('Could not resolve the Paradise Roleplay guild ID.');
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find(messageContainsVerificationPanel);

  const sendPayload = {
    components: [verificationPanel(guildId)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };

  if (existing) {
    // The V2 flag is permanent on an existing V2 message, so only refresh its components.
    await existing.edit({
      components: [verificationPanel(guildId)],
      allowedMentions: { parse: [] },
    }).catch(async () => {
      await channel.send(sendPayload);
    });
    return;
  }

  await channel.send(sendPayload);
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`[ready] Logged in as ${readyClient.user.tag}`);
  console.log('[ready] Paradise Operations verification system starting...');

  if (!CONFIG.dockPid) {
    console.warn(
      '[config] DOCK_PID is not set. Existing Dock links can still sync, but new users cannot open a Dock verification session until DOCK_PID is added in Railway.',
    );
  }

  try {
    await initializeDatabase();
  } catch (error) {
    console.error('[database] Database initialization failed. Verification will continue without database history:', error);
  }

  try {
    await ensureVerificationPanel();
    console.log('[ready] Verification panel is ready.');
  } catch (error) {
    console.error('[ready] Could not create verification panel:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() || !interaction.guildId) return;

  if (interaction.customId === IDS.verify) {
    await beginVerification(interaction, false);
    return;
  }

  if (interaction.customId === IDS.check) {
    await checkVerification(interaction, false);
    return;
  }

  if (interaction.customId === IDS.reverify) {
    await checkVerification(interaction, true);
    return;
  }

  if (interaction.customId.startsWith(IDS.completePrefix)) {
    const sid = interaction.customId.slice(IDS.completePrefix.length);
    if (!sid) return;
    await completeVerificationSession(interaction, sid);
  }
});

process.on('unhandledRejection', error => {
  console.error('[process] Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('[process] Uncaught exception:', error);
});

client.login(TOKEN);
