'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Events,
  MessageFlags,
} = require('discord.js');

const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(APP_ROOT, 'data'),
);
const DB_FILE = path.join(DATA_DIR, 'database.json');
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts');
const BACKUP_FORMAT = 'eclipsemc-server-backup';
const BACKUP_VERSION = 1;
const TICKET_HANDLER_ROLE_ID = '1558793811696558132';
const MAX_BACKUP_FILE_BYTES = 9 * 1024 * 1024;
const MAX_BACKUP_UNCOMPRESSED_BYTES = 48 * 1024 * 1024;
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ENABLE_MEMBER_EVENTS = String(process.env.ENABLE_MEMBER_EVENTS || 'false').toLowerCase() === 'true';
const ENABLE_MESSAGE_CONTENT_LOGS = String(process.env.ENABLE_MESSAGE_CONTENT_LOGS || 'false').toLowerCase() === 'true';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const sessions = session({
  name: 'eclipsemc_dashboard_session',
  secret: SESSION_SECRET || 'development-only-change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  },
});
app.use(sessions);

let database = { guilds: {} };
let saveQueue = Promise.resolve();
let isReady = false;
let commandRegistrationError = null;

const COMMAND_NAMES = [
  'help', 'ban', 'kick', 'timeout', 'untimeout', 'warn', 'warnings', 'clear',
  'slowmode', 'lock', 'unlock', 'modlogs', 'ticket', 'ticketpanel', 'backup', 'back',
];

function defaultGuildData() {
  return {
    settings: {
      logChannelId: '',
      ticketCategoryId: '',
      welcomeChannelId: '',
      welcomeMessage: 'Welcome {user} to **{server}**!',
      supportRoleIds: [],
      moderatorRoleIds: [],
      embedColor: '#7C5CFC',
      footerText: 'Moderation & Support',
    },
    logs: [],
    tickets: [],
    warnings: [],
    panels: [],
    commandPermissions: {},
    disabledCommands: [],
  };
}

function getGuildData(guildId) {
  if (!database.guilds[guildId]) database.guilds[guildId] = defaultGuildData();
  const entry = database.guilds[guildId];
  const defaults = defaultGuildData();
  for (const [key, value] of Object.entries(defaults)) {
    if (entry[key] === undefined || entry[key] === null) entry[key] = value;
  }
  entry.settings = { ...defaults.settings, ...(entry.settings || {}) };
  return entry;
}

async function initStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TRANSCRIPTS_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.guilds && typeof parsed.guilds === 'object') database = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Could not read the existing database; starting with a fresh in-memory database:', error.message);
    }
    await persistDatabase();
  }
}

function persistDatabase() {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temporaryFile = `${DB_FILE}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(database, null, 2), { mode: 0o600 });
    await fs.rename(temporaryFile, DB_FILE);
  });
  return saveQueue;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isTranscriptFilename(filename) {
  return typeof filename === 'string' && /^ticket-[0-9]{15,25}-[0-9]+\.txt$/.test(filename);
}

async function buildGuildBackup(guild) {
  await persistDatabase();
  const guildData = cloneJson(getGuildData(guild.id));
  const ticketTranscriptNames = new Set((guildData.tickets || [])
    .map(ticket => ticket?.transcriptFile).filter(isTranscriptFilename));
  const ticketChannelIds = new Set((guildData.tickets || [])
    .map(ticket => String(ticket?.channelId || '')).filter(validSnowflake));
  const transcripts = [];
  const missingTranscriptFiles = [];
  const filenames = await fs.readdir(TRANSCRIPTS_DIR).catch(() => []);

  for (const filename of filenames) {
    if (!isTranscriptFilename(filename)) continue;
    let content;
    try {
      content = await fs.readFile(path.join(TRANSCRIPTS_DIR, filename), 'utf8');
    } catch {
      if (ticketTranscriptNames.has(filename)) missingTranscriptFiles.push(filename);
      continue;
    }
    const channelId = filename.match(/^ticket-([0-9]{15,25})-/)?.[1] || '';
    const serverMarker = new RegExp(`^Server: .*\\(${guild.id}\\)$`, 'm');
    if (ticketTranscriptNames.has(filename) || ticketChannelIds.has(channelId) || serverMarker.test(content)) {
      transcripts.push({ filename, content });
    }
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    scope: 'guild',
    guild: { id: guild.id, name: guild.name },
    createdAt: new Date().toISOString(),
    data: { guildData, transcripts, missingTranscriptFiles },
  };
}

function normalizeBackupGuildData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The backup does not contain valid server data.');
  }
  const defaults = defaultGuildData();
  const result = { ...defaults, ...input };
  if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
    throw new Error('The backup has invalid server settings.');
  }
  result.settings = { ...defaults.settings, ...input.settings };
  for (const key of ['logs', 'tickets', 'warnings', 'panels', 'disabledCommands']) {
    if (!Array.isArray(result[key])) throw new Error(`The backup has invalid ${key} data.`);
  }
  if (!result.commandPermissions || typeof result.commandPermissions !== 'object' || Array.isArray(result.commandPermissions)) {
    throw new Error('The backup has invalid command permission data.');
  }
  if (result.logs.length > 5000 || result.tickets.length > 5000 || result.warnings.length > 5000
    || result.panels.length > 1000 || result.disabledCommands.length > 100) {
    throw new Error('The backup contains unexpectedly large server data arrays.');
  }
  return result;
}

async function downloadBackupAttachment(attachment) {
  if (!attachment || typeof attachment.url !== 'string') throw new Error('Attach a backup file made with /backup create.');
  if (Number(attachment.size || 0) > MAX_BACKUP_FILE_BYTES) {
    throw new Error('The backup file is too large to load. The maximum supported upload is 9 MiB.');
  }
  let parsedUrl;
  try { parsedUrl = new URL(attachment.url); } catch { throw new Error('That attachment URL is invalid.'); }
  const allowedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'cdn.discordapp.net']);
  if (parsedUrl.protocol !== 'https:' || !allowedHosts.has(parsedUrl.hostname)) {
    throw new Error('Upload the backup as a Discord attachment, not an external link.');
  }
  const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Could not download the backup attachment (HTTP ${response.status}).`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_BACKUP_FILE_BYTES) throw new Error('The backup file is too large to load (maximum 9 MiB).');
  const input = Buffer.from(await response.arrayBuffer());
  if (input.length > MAX_BACKUP_FILE_BYTES) throw new Error('The backup file is too large to load (maximum 9 MiB).');

  let jsonBuffer = input;
  if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
    try {
      jsonBuffer = gunzipSync(input, { maxOutputLength: MAX_BACKUP_UNCOMPRESSED_BYTES });
    } catch {
      throw new Error('The compressed backup is invalid or expands beyond the supported size.');
    }
  }
  if (jsonBuffer.length > MAX_BACKUP_UNCOMPRESSED_BYTES) throw new Error('The backup expands beyond the supported 48 MiB limit.');
  try { return JSON.parse(jsonBuffer.toString('utf8')); } catch {
    throw new Error('This file is not a valid EclipseMC backup JSON or compressed backup.');
  }
}

async function restoreGuildBackup(guild, backup) {
  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw new Error('Unsupported backup format or version. Upload a file created by this version of /backup create.');
  }
  if (backup.scope !== 'guild' || backup.guild?.id !== guild.id) {
    throw new Error('This backup belongs to a different Discord server. Run /back load in the server it was created for.');
  }
  const importedGuildData = normalizeBackupGuildData(backup.data?.guildData);
  const transcriptEntries = backup.data?.transcripts;
  if (!Array.isArray(transcriptEntries) || transcriptEntries.length > 5000) {
    throw new Error('The backup contains invalid transcript data.');
  }
  const safeTranscripts = [];
  const seen = new Set();
  let transcriptBytes = 0;
  for (const entry of transcriptEntries) {
    if (!entry || !isTranscriptFilename(entry.filename) || typeof entry.content !== 'string') {
      throw new Error('The backup contains an invalid transcript entry.');
    }
    if (seen.has(entry.filename)) throw new Error('The backup contains duplicate transcript filenames.');
    const transcriptServerMarker = new RegExp(`^Server: .*\\(${guild.id}\\)$`, 'm');
    if (!transcriptServerMarker.test(entry.content)) {
      throw new Error('The backup contains a transcript that does not belong to this Discord server.');
    }
    seen.add(entry.filename);
    transcriptBytes += Buffer.byteLength(entry.content, 'utf8');
    if (transcriptBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) throw new Error('The transcript data is too large to restore.');
    safeTranscripts.push({ filename: entry.filename, content: entry.content });
  }

  await fs.mkdir(TRANSCRIPTS_DIR, { recursive: true });
  const stagedFiles = [];
  try {
    for (const entry of safeTranscripts) {
      const destination = path.join(TRANSCRIPTS_DIR, entry.filename);
      const temporary = `${destination}.restore-${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, entry.content, { mode: 0o600, flag: 'wx' });
      stagedFiles.push({ temporary, destination });
    }
    const oldGuildData = database.guilds[guild.id] ? cloneJson(database.guilds[guild.id]) : null;
    database.guilds[guild.id] = importedGuildData;
    try {
      await persistDatabase();
      for (const file of stagedFiles) await fs.rename(file.temporary, file.destination);
    } catch (error) {
      if (oldGuildData) database.guilds[guild.id] = oldGuildData;
      else delete database.guilds[guild.id];
      await persistDatabase().catch(() => {});
      throw error;
    }
    return {
      transcriptCount: safeTranscripts.length,
      missingTranscripts: Array.isArray(backup.data.missingTranscriptFiles) ? backup.data.missingTranscriptFiles.length : 0,
    };
  } finally {
    await Promise.all(stagedFiles.map(file => fs.unlink(file.temporary).catch(() => {})));
  }
}

function clip(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function validSnowflake(value) {
  return typeof value === 'string' && /^\d{15,25}$/.test(value);
}

function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function hexColor(value, fallback = '#7C5CFC') {
  const candidate = validColor(value) ? value : fallback;
  return Number.parseInt(candidate.slice(1), 16);
}

function ephemeral(content) {
  return { content: clip(content, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

function safeError(error) {
  if (!error) return 'An unexpected error occurred.';
  if (error.code === 50013) return 'The bot is missing a required Discord permission or role position.';
  if (error.code === 50001) return 'The bot cannot access that Discord resource.';
  if (error.code === 10003) return 'That Discord channel no longer exists.';
  if (error.code === 10008) return 'That Discord message no longer exists.';
  return clip(error.message || 'An unexpected error occurred.', 300);
}

function requireDashboard(req, res, next) {
  if (req.session && req.session.authenticated === true) return next();
  return res.status(401).json({ error: 'Please sign in to the dashboard.' });
}

function getGuildOr404(guildId, res) {
  if (!validSnowflake(guildId)) {
    res.status(400).json({ error: 'Invalid server ID.' });
    return null;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    res.status(404).json({ error: 'The bot is not currently in that Discord server.' });
    return null;
  }
  return guild;
}

function pushBounded(list, item, max = 500) {
  list.unshift(item);
  if (list.length > max) list.length = max;
}

async function makeLog(guild, fields) {
  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action: clip(fields.action || 'Event', 80),
    targetId: clip(fields.targetId || '', 30),
    targetTag: clip(fields.targetTag || '', 150),
    moderatorId: clip(fields.moderatorId || '', 30),
    moderatorTag: clip(fields.moderatorTag || 'System', 150),
    reason: clip(fields.reason || '', 1000),
    channelId: clip(fields.channelId || '', 30),
    details: clip(fields.details || '', 1000),
  };
  const gData = getGuildData(guild.id);
  pushBounded(gData.logs, record, 500);
  await persistDatabase();
  await postLogEmbed(guild, record).catch((error) => console.warn('Unable to post log embed:', error.message));
  return record;
}

async function postLogEmbed(guild, record) {
  const channelId = getGuildData(guild.id).settings.logChannelId;
  if (!validSnowflake(channelId)) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') return;
  const embed = new EmbedBuilder()
    .setColor(hexColor(getGuildData(guild.id).settings.embedColor))
    .setTitle(`Audit Log · ${record.action}`)
    .setTimestamp(new Date(record.timestamp));
  if (record.targetTag || record.targetId) {
    embed.addFields({ name: 'Target', value: clip(`${record.targetTag || 'Unknown'}${record.targetId ? ` (${record.targetId})` : ''}`, 1024) });
  }
  embed.addFields({ name: 'Moderator / Source', value: clip(`${record.moderatorTag}${record.moderatorId ? ` (${record.moderatorId})` : ''}`, 1024) });
  if (record.reason) embed.addFields({ name: 'Reason', value: clip(record.reason, 1024) });
  if (record.details) embed.addFields({ name: 'Details', value: clip(record.details, 1024) });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

function makeEmbed(panel, guildData) {
  return new EmbedBuilder()
    .setColor(hexColor(panel.color || guildData.settings.embedColor))
    .setTitle(clip(panel.title || 'Support', 256))
    .setDescription(clip(panel.description || 'Click below to continue.', 4000))
    .setFooter({ text: clip(panel.footer || guildData.settings.footerText || 'Support', 2048) });
}

function makeTicketEmbed(ticket, guildData) {
  return new EmbedBuilder()
    .setColor(hexColor(guildData.settings.embedColor))
    .setTitle('Support Ticket')
    .setDescription('Your support ticket is open. Please describe what you need help with. Use the button below when you are finished.')
    .addFields(
      { name: 'Member', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Ticket Handler', value: `<@&${TICKET_HANDLER_ROLE_ID}>`, inline: true },
      { name: 'Claimed By', value: ticket.claimedById ? `<@${ticket.claimedById}>` : 'Unclaimed', inline: false },
    )
    .setFooter({ text: 'EclipseMC Support' })
    .setTimestamp(ticket.createdAt ? new Date(ticket.createdAt) : new Date());
}

function ticketControlRow(ticket) {
  const claimLabel = ticket?.claimedById ? 'Claimed' : 'Claim';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket:claim')
      .setLabel(claimLabel)
      .setStyle(ButtonStyle.Success)
      .setDisabled(Boolean(ticket?.claimedById)),
  );
}

function buttonStyle(style) {
  const styles = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
  };
  return styles[style] || ButtonStyle.Primary;
}

function panelButton(panel) {
  const customId = panel.panelType === 'ticket' ? `ticket:create:${panel.id}` : `panel:button:${panel.id}`;
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(clip(panel.buttonLabel || (panel.panelType === 'ticket' ? 'Create Ticket' : 'Open')))
    .setStyle(buttonStyle(panel.buttonStyle));
  const emoji = clip(panel.buttonEmoji || '', 64);
  if (emoji) {
    try { button.setEmoji(emoji); } catch { /* Ignore an invalid optional emoji. */ }
  }
  return new ActionRowBuilder().addComponents(button);
}

async function publishPanel(guild, panel) {
  const gData = getGuildData(guild.id);
  const channelId = panel.channelId;
  if (!validSnowflake(channelId)) throw new Error('Choose a destination channel before publishing this panel.');
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('The selected panel destination is not a text channel the bot can access.');
  }
  const payload = {
    embeds: [makeEmbed(panel, gData)],
    components: [panelButton(panel)],
    allowedMentions: { parse: [] },
  };
  let message = null;
  if (panel.messageId && panel.channelId === channel.id) {
    try {
      const existing = await channel.messages.fetch(panel.messageId);
      message = await existing.edit(payload);
    } catch (error) {
      if (error.code !== 10008 && error.code !== 10003) throw error;
    }
  }
  if (!message) message = await channel.send(payload);
  panel.channelId = channel.id;
  panel.messageId = message.id;
  panel.publishedAt = new Date().toISOString();
  await persistDatabase();
  return message;
}

function cleanPanelInput(input, previous = {}) {
  const panelType = input.panelType ?? previous.panelType ?? 'ticket';
  if (!['ticket', 'custom'].includes(panelType)) throw new Error('Panel type must be ticket or custom.');
  const color = input.color ?? previous.color ?? '#7C5CFC';
  if (!validColor(color)) throw new Error('Color must be a hex value such as #7C5CFC.');
  const buttonStyleValue = input.buttonStyle ?? previous.buttonStyle ?? 'primary';
  if (!['primary', 'secondary', 'success', 'danger'].includes(buttonStyleValue)) throw new Error('Invalid button style.');
  const channelId = input.channelId ?? previous.channelId ?? '';
  if (channelId && !validSnowflake(channelId)) throw new Error('The channel ID is invalid.');
  const categoryId = String(input.categoryId ?? previous.categoryId ?? '');
  if (categoryId && !validSnowflake(categoryId)) throw new Error('The ticket category ID is invalid.');
  return {
    id: previous.id || crypto.randomUUID(),
    name: clip(input.name ?? previous.name ?? 'New panel', 80) || 'New panel',
    panelType,
    title: clip(input.title ?? previous.title ?? 'Need help?', 256) || 'Need help?',
    description: clip(input.description ?? previous.description ?? 'Click the button below to get support.', 4000),
    color,
    footer: clip(input.footer ?? previous.footer ?? 'Support team', 2048),
    buttonLabel: clip(input.buttonLabel ?? previous.buttonLabel ?? (panelType === 'ticket' ? 'Create Ticket' : 'Open'), 80) || 'Open',
    buttonStyle: buttonStyleValue,
    buttonEmoji: clip(input.buttonEmoji ?? previous.buttonEmoji ?? '', 64),
    buttonReply: clip(input.buttonReply ?? previous.buttonReply ?? 'Thanks! Your button was clicked.', 1000),
    channelId,
    categoryId,
    messageId: previous.messageId || null,
    publishedAt: previous.publishedAt || null,
    createdAt: previous.createdAt || new Date().toISOString(),
  };
}

function commandBuilderList() {
  const guildOnly = (command) => command.setDMPermission(false);
  return [
    guildOnly(new SlashCommandBuilder().setName('help').setDescription('Show bot command groups.')),
    guildOnly(new SlashCommandBuilder().setName('ban').setDescription('Ban a server member.')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption(o => o.setName('target').setDescription('Member to ban').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setMaxLength(500))),
    guildOnly(new SlashCommandBuilder().setName('kick').setDescription('Kick a server member.')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption(o => o.setName('target').setDescription('Member to kick').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setMaxLength(500))),
    guildOnly(new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member for a number of minutes.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('target').setDescription('Member to timeout').setRequired(true))
      .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes (1–40320)').setMinValue(1).setMaxValue(40320).setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for the timeout').setMaxLength(500))),
    guildOnly(new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member timeout.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('target').setDescription('Member to untimeout').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for removing the timeout').setMaxLength(500))),
    guildOnly(new SlashCommandBuilder().setName('warn').setDescription('Record a warning for a member.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('target').setDescription('Member to warn').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(true).setMaxLength(500))),
    guildOnly(new SlashCommandBuilder().setName('warnings').setDescription('View warnings for a member.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('target').setDescription('Member whose warnings to view').setRequired(true))),
    guildOnly(new SlashCommandBuilder().setName('clear').setDescription('Bulk delete 1–100 recent messages.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to remove').setMinValue(1).setMaxValue(100).setRequired(true))),
    guildOnly(new SlashCommandBuilder().setName('slowmode').setDescription('Set the current channel slowmode.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addIntegerOption(o => o.setName('seconds').setDescription('Slowmode seconds (0–21600)').setMinValue(0).setMaxValue(21600).setRequired(true))),
    guildOnly(new SlashCommandBuilder().setName('lock').setDescription('Lock a text channel for @everyone.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption(o => o.setName('channel').setDescription('Channel to lock (defaults to this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))),
    guildOnly(new SlashCommandBuilder().setName('unlock').setDescription('Remove the @everyone send-message lock.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption(o => o.setName('channel').setDescription('Channel to unlock (defaults to this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))),
    guildOnly(new SlashCommandBuilder().setName('modlogs').setDescription('View recent moderation logs.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('target').setDescription('Filter logs by a member (optional)'))),
    guildOnly(new SlashCommandBuilder().setName('ticket').setDescription('Ticket tools: setup, close, add/remove user, or transcript.')
      .addSubcommand(s => s.setName('setup').setDescription('Publish a basic ticket panel in this channel.'))
      .addSubcommand(s => s.setName('close').setDescription('Close and archive the current ticket.'))
      .addSubcommand(s => s.setName('add').setDescription('Add a member to the current ticket.')
        .addUserOption(o => o.setName('user').setDescription('Member to add').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a member from the current ticket.')
        .addUserOption(o => o.setName('user').setDescription('Member to remove').setRequired(true)))
      .addSubcommand(s => s.setName('transcript').setDescription('Create and attach a transcript of the current ticket.'))),
    guildOnly(new SlashCommandBuilder().setName('ticketpanel').setDescription('Set the ticket category for an existing ticket panel.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('panel').setDescription('Choose an existing ticket panel').setRequired(true).setAutocomplete(true))
      .addChannelOption(o => o.setName('category').setDescription('Category where tickets from this panel will be created').addChannelTypes(ChannelType.GuildCategory).setRequired(true))),
    guildOnly(new SlashCommandBuilder().setName('backup').setDescription('Create a downloadable backup of this server’s EclipseMC data.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('create').setDescription('Create and attach a downloadable server backup.'))),
    guildOnly(new SlashCommandBuilder().setName('back').setDescription('Restore this server from an EclipseMC backup file.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('load').setDescription('Upload a backup file and restore this server’s bot data.')
        .addAttachmentOption(o => o.setName('file').setDescription('Backup file generated with /backup create').setRequired(true)))),
  ];
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    ...(ENABLE_MEMBER_EVENTS ? [GatewayIntentBits.GuildMembers] : []),
    GatewayIntentBits.GuildMessages,
    ...(ENABLE_MESSAGE_CONTENT_LOGS ? [GatewayIntentBits.MessageContent] : []),
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commandData = commandBuilderList().map(command => command.toJSON());
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandData });
      console.log(`Registered ${commandData.length} slash commands for test server ${GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandData });
      console.log(`Registered ${commandData.length} global slash commands.`);
    }
    commandRegistrationError = null;
  } catch (error) {
    commandRegistrationError = safeError(error);
    console.error('Slash command registration failed:', error);
  }
}

async function createTranscript(channel) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const sorted = messages ? [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp) : [];
  const lines = [
    `Ticket transcript for #${channel.name} (${channel.id})`,
    `Server: ${channel.guild.name} (${channel.guild.id})`,
    `Generated: ${new Date().toISOString()}`,
    '='.repeat(72),
  ];
  for (const message of sorted) {
    const body = (message.content || '').replace(/\r/g, '').slice(0, 5000);
    const attachmentLinks = [...message.attachments.values()].map(a => a.url).join(' ');
    const embeds = message.embeds.map(e => e.title || e.description || '[embed]').join(' ');
    lines.push(`[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.tag || 'Unknown'} (${message.author?.id || '?'})${message.author?.bot ? ' [BOT]' : ''}`);
    if (body) lines.push(body);
    if (attachmentLinks) lines.push(`Attachments: ${attachmentLinks}`);
    if (embeds) lines.push(`Embeds: ${embeds}`);
    lines.push('');
  }
  const filename = `ticket-${channel.id}-${Date.now()}.txt`;
  await fs.writeFile(path.join(TRANSCRIPTS_DIR, filename), lines.join('\n'), { mode: 0o600 });
  return { filename, buffer: Buffer.from(lines.join('\n'), 'utf8') };
}

function findTicket(guildId, channelId) {
  return getGuildData(guildId).tickets.find(ticket => ticket.channelId === channelId && ticket.status === 'open');
}

function isTicketStaff(member, guildData) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator) || member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  const staffRoleIds = [
    TICKET_HANDLER_ROLE_ID,
    ...(guildData.settings.supportRoleIds || []),
    ...(guildData.settings.moderatorRoleIds || []),
  ];
  return member.roles?.cache?.some(role => staffRoleIds.includes(role.id)) || false;
}

async function createTicket(guild, opener, panel) {
  const gData = getGuildData(guild.id);
  const existing = gData.tickets.find(ticket => ticket.ownerId === opener.id && ticket.status === 'open');
  if (existing) {
    const existingChannel = guild.channels.cache.get(existing.channelId);
    if (existingChannel) return { ticket: existing, channel: existingChannel, created: false };
    existing.status = 'closed';
    existing.closedAt = new Date().toISOString();
  }
  const botMember = guild.members.me || await guild.members.fetchMe();
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
  ];
  const ticketStaffRoleIds = [...new Set([
    TICKET_HANDLER_ROLE_ID,
    ...(gData.settings.supportRoleIds || []),
  ])];
  for (const roleId of ticketStaffRoleIds) {
    if (guild.roles.cache.has(roleId)) {
      overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
  }
  const cleanName = opener.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 18) || 'user';
  const createOptions = {
    name: `ticket-${cleanName}`.slice(0, 90),
    type: ChannelType.GuildText,
    topic: `Ticket owner: ${opener.id} | Panel: ${panel?.id || 'slash-command'}`,
    permissionOverwrites: overwrites,
    reason: `Support ticket opened by ${opener.tag} (${opener.id})`,
  };
  const panelCategory = panel?.categoryId ? guild.channels.cache.get(panel.categoryId) : null;
  const defaultCategory = gData.settings.ticketCategoryId ? guild.channels.cache.get(gData.settings.ticketCategoryId) : null;
  const ticketCategory = panelCategory?.type === ChannelType.GuildCategory
    ? panelCategory
    : defaultCategory?.type === ChannelType.GuildCategory ? defaultCategory : null;
  if (ticketCategory) createOptions.parent = ticketCategory.id;
  const channel = await guild.channels.create(createOptions);
  const ticket = {
    id: crypto.randomUUID(),
    channelId: channel.id,
    channelName: channel.name,
    ownerId: opener.id,
    ownerTag: opener.tag,
    panelId: panel?.id || null,
    status: 'open',
    createdAt: new Date().toISOString(),
    closedAt: null,
    closedById: null,
    closedByTag: null,
    transcriptFile: null,
    claimedById: null,
    claimedByTag: null,
    claimedAt: null,
    messageId: null,
  };
  gData.tickets.unshift(ticket);
  if (gData.tickets.length > 1000) gData.tickets.length = 1000;
  await persistDatabase();
  const staffRoleIdsToMention = [...new Set([
    TICKET_HANDLER_ROLE_ID,
    ...(gData.settings.supportRoleIds || []),
  ])].filter(id => guild.roles.cache.has(id));
  const staffMentions = staffRoleIdsToMention.map(id => `<@&${id}>`).join(' ');
  const ticketMessage = await channel.send({
    content: `${staffMentions} <@${opener.id}>`.trim(),
    embeds: [makeTicketEmbed(ticket, gData)],
    components: [ticketControlRow(ticket)],
    allowedMentions: { users: [opener.id], roles: staffRoleIdsToMention },
  });
  ticket.messageId = ticketMessage.id;
  await persistDatabase();
  await makeLog(guild, {
    action: 'Ticket Opened', targetId: opener.id, targetTag: opener.tag,
    moderatorTag: 'Ticket System', moderatorId: client.user?.id || '',
    channelId: channel.id, details: `Created ${channel}.`,
  });
  return { ticket, channel, created: true };
}

async function closeTicket(guild, channel, actorUser, reason = 'Closed by staff/member', { deleteChannel = false } = {}) {
  const gData = getGuildData(guild.id);
  const ticket = findTicket(guild.id, channel.id);
  if (!ticket) throw new Error('This channel is not an open ticket.');
  const transcript = await createTranscript(channel);
  ticket.status = 'closed';
  ticket.closedAt = new Date().toISOString();
  ticket.closedById = actorUser.id;
  ticket.closedByTag = actorUser.tag;
  ticket.transcriptFile = transcript.filename;
  await persistDatabase();
  if (!deleteChannel) {
    const ownerOverwrite = channel.permissionOverwrites.cache.get(ticket.ownerId);
    if (ownerOverwrite) {
      await channel.permissionOverwrites.edit(ticket.ownerId, {
        SendMessages: false,
        AddReactions: false,
      }, { reason: `Ticket closed by ${actorUser.tag}` }).catch(() => {});
    }
    await channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => {});
    await channel.send({
      content: `🔒 Ticket closed by <@${actorUser.id}>. A transcript has been saved.`,
      allowedMentions: { users: [actorUser.id] },
    }).catch(() => {});
  }
  const logChannelId = gData.settings.logChannelId;
  const logChannel = validSnowflake(logChannelId) ? guild.channels.cache.get(logChannelId) : null;
  if (logChannel?.isTextBased() && typeof logChannel.send === 'function') {
    await logChannel.send({
      content: `Transcript for **${ticket.channelName}** · opened by ${ticket.ownerTag} · closed by ${actorUser.tag}\nReason: ${clip(reason, 500)}`,
      files: [new AttachmentBuilder(transcript.buffer, { name: transcript.filename })],
      allowedMentions: { parse: [] },
    }).catch(error => console.warn('Transcript could not be posted to the log channel:', error.message));
  }
  await makeLog(guild, {
    action: 'Ticket Closed', targetId: ticket.ownerId, targetTag: ticket.ownerTag,
    moderatorId: actorUser.id, moderatorTag: actorUser.tag,
    channelId: channel.id, reason, details: `Transcript: ${transcript.filename}${deleteChannel ? ' · Channel scheduled for deletion after staff close' : ''}`,
  });
  if (deleteChannel) {
    try {
      await channel.delete(`Ticket closed by staff ${actorUser.tag} (${actorUser.id})`);
    } catch (error) {
      if (error.code !== 10003) {
        console.error(`Ticket ${channel.id} was closed but its channel could not be deleted:`, error.message);
        const ownerOverwrite = channel.permissionOverwrites.cache.get(ticket.ownerId);
        if (ownerOverwrite) {
          await channel.permissionOverwrites.edit(ticket.ownerId, {
            SendMessages: false,
            AddReactions: false,
          }, { reason: `Ticket closed by ${actorUser.tag}; automatic deletion failed` }).catch(() => {});
        }
        await channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => {});
        await channel.send({
          content: `🔒 Ticket closed by <@${actorUser.id}>. Automatic channel deletion failed; a transcript was saved. Please ask an administrator to check the bot's Manage Channels permission.`,
          allowedMentions: { users: [actorUser.id] },
        }).catch(() => {});
        throw new Error('The ticket was recorded as closed, but I could not delete the channel. Make sure the bot has Manage Channels permission.');
      }
    }
  }
  return { ticket, transcript, channelDeleted: deleteChannel };
}

async function assertCanModerate(interaction, targetMember) {
  if (targetMember.id === interaction.user.id) throw new Error('You cannot moderate yourself.');
  if (targetMember.id === client.user.id) throw new Error('You cannot moderate the bot.');
  if (targetMember.id === interaction.guild.ownerId) throw new Error('The server owner cannot be moderated by this bot command.');
  const executor = await interaction.guild.members.fetch(interaction.user.id);
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  if (executor.id !== interaction.guild.ownerId && executor.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    throw new Error('Your highest role must be above the target member.');
  }
  if (botMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    throw new Error('Move the bot role above the target member before using this command.');
  }
  return { executor, botMember };
}

async function enforceCommandAccess(interaction) {
  const guildData = getGuildData(interaction.guildId);
  const commandName = interaction.commandName;
  if ((guildData.disabledCommands || []).includes(commandName)) {
    throw new Error(`/${commandName} is disabled in the dashboard.`);
  }
  const nativePermissions = {
    ban: PermissionFlagsBits.BanMembers,
    kick: PermissionFlagsBits.KickMembers,
    timeout: PermissionFlagsBits.ModerateMembers,
    untimeout: PermissionFlagsBits.ModerateMembers,
    warn: PermissionFlagsBits.ModerateMembers,
    warnings: PermissionFlagsBits.ModerateMembers,
    clear: PermissionFlagsBits.ManageMessages,
    slowmode: PermissionFlagsBits.ManageChannels,
    lock: PermissionFlagsBits.ManageChannels,
    unlock: PermissionFlagsBits.ManageChannels,
    modlogs: PermissionFlagsBits.ModerateMembers,
    ticketpanel: PermissionFlagsBits.ManageGuild,
    backup: PermissionFlagsBits.Administrator,
    back: PermissionFlagsBits.Administrator,
  };
  const requiredPermission = nativePermissions[commandName];
  if (requiredPermission && !interaction.memberPermissions?.has(requiredPermission)) {
    throw new Error(`You need the Discord permission ${commandName === 'ban' ? 'Ban Members' : commandName === 'kick' ? 'Kick Members' : commandName === 'clear' ? 'Manage Messages' : commandName === 'ticketpanel' ? 'Manage Server' : ['backup', 'back'].includes(commandName) ? 'Administrator' : ['slowmode', 'lock', 'unlock'].includes(commandName) ? 'Manage Channels' : 'Moderate Members'} to use /${commandName}.`);
  }
  const rule = guildData.commandPermissions?.[commandName];
  const allowedRoleIds = Array.isArray(rule?.roleIds) ? rule.roleIds : [];
  if (!allowedRoleIds.length) return;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (!member.roles.cache.some(role => allowedRoleIds.includes(role.id))) {
    throw new Error(`You need one of the roles allowed for /${commandName}.`);
  }
}

async function handleModerationCommand(interaction) {
  const { guild, user, options } = interaction;
  const gData = getGuildData(guild.id);
  const name = interaction.commandName;

  if (name === 'help') {
    return interaction.reply(ephemeral([
      '**Moderation**: `/ban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/clear`, `/slowmode`, `/lock`, `/unlock`, `/modlogs`',
      '**Tickets**: `/ticket setup`, `/ticket close`, `/ticket add`, `/ticket remove`, `/ticket transcript`, `/ticketpanel`',
      '**Backups**: `/backup create` downloads this server’s saved bot data and transcripts; `/back load` restores a backup file. Administrator permission required.',
      'Use the web dashboard to configure log channels, ticket panels, support roles, welcome messages, and command access.',
    ].join('\n')));
  }

  if (name === 'backup') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      throw new Error('Only server Administrators can create or restore backups.');
    }
    if (options.getSubcommand() !== 'create') throw new Error('Use /backup create.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const backup = await buildGuildBackup(guild);
      const raw = Buffer.from(JSON.stringify(backup), 'utf8');
      const compressed = gzipSync(raw, { level: 9 });
      if (compressed.length > MAX_BACKUP_FILE_BYTES) {
        throw new Error('This server backup is larger than Discord’s supported 9 MiB upload limit. Reduce old transcript data and try again. No backup was sent.');
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `eclipsemc-backup-${guild.id}-${stamp}.json.gz`;
      return await interaction.editReply({
        content: `Backup created for **${guild.name}**. Included ${backup.data.transcripts.length} transcript file(s) and all saved EclipseMC database records for this server. Keep this file private; upload it with /back load to restore.`,
        files: [new AttachmentBuilder(compressed, { name: filename, description: 'Compressed EclipseMC server backup' })],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return interaction.editReply({ content: `Backup creation failed: ${safeError(error)}`, allowedMentions: { parse: [] } });
    }
  }

  if (name === 'back') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      throw new Error('Only server Administrators can create or restore backups.');
    }
    if (options.getSubcommand() !== 'load') throw new Error('Use /back load and attach a backup file.');
    const attachment = options.getAttachment('file', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const backup = await downloadBackupAttachment(attachment);
      const result = await restoreGuildBackup(guild, backup);
      const missingNote = result.missingTranscripts
        ? ` ${result.missingTranscripts} transcript file(s) were already missing when the backup was created.`
        : '';
      return await interaction.editReply(`Backup restored for **${guild.name}**. Restored the saved bot data and ${result.transcriptCount} transcript file(s). Existing Discord channels and messages are not recreated by a data backup.${missingNote}`);
    } catch (error) {
      return interaction.editReply({ content: `Backup restore failed: ${safeError(error)}`, allowedMentions: { parse: [] } });
    }
  }

  if (name === 'ticketpanel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      throw new Error('You need Manage Server permission to configure a ticket panel.');
    }
    const panelSelector = clip(options.getString('panel', true), 100);
    const category = options.getChannel('category', true);
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guild.id) {
      throw new Error('Choose a category from this server.');
    }

    let panelIndex = gData.panels.findIndex(item => item.id === panelSelector && item.panelType === 'ticket');
    if (panelIndex < 0) {
      const matchingPanels = gData.panels
        .map((item, index) => ({ item, index }))
        .filter(entry => entry.item.panelType === 'ticket' && entry.item.name.toLowerCase() === panelSelector.toLowerCase());
      if (matchingPanels.length === 1) panelIndex = matchingPanels[0].index;
      else if (matchingPanels.length > 1) throw new Error('Several ticket panels share that name. Select the exact panel from the autocomplete list.');
    }
    if (panelIndex < 0) {
      throw new Error('That existing ticket panel was not found. Choose a panel from the autocomplete list, or create one from the dashboard first.');
    }

    const selectedPanel = gData.panels[panelIndex];
    const oldDestination = selectedPanel.channelId ? guild.channels.cache.get(selectedPanel.channelId) : null;
    const oldDestinationUsable = oldDestination
      && oldDestination.isTextBased()
      && typeof oldDestination.send === 'function';
    const panel = cleanPanelInput({
      categoryId: category.id,
      channelId: oldDestinationUsable ? oldDestination.id : interaction.channelId,
    }, selectedPanel);
    if (!oldDestinationUsable) panel.messageId = null;
    gData.panels[panelIndex] = panel;
    await persistDatabase();

    let publishedMessage = null;
    let publishWarning = '';
    try {
      publishedMessage = await publishPanel(guild, panel);
    } catch (error) {
      // Routing is already saved; if the old panel message cannot be edited,
      // tickets opened with its button still use this updated categoryId.
      publishWarning = ` The category was saved, but I couldn't refresh the panel message: ${safeError(error)}.`;
    }
    const location = publishedMessage ? ` The panel message is available in <#${publishedMessage.channelId}>.` : '';
    return interaction.reply(ephemeral(`Updated existing ticket panel **${panel.name}**. New tickets opened from this panel will be created in <#${category.id}>.${location}${publishWarning}`));
  }

  if (name === 'ticket') {
    const sub = options.getSubcommand();
    if (sub === 'setup') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        throw new Error('You need Manage Server permission to publish a ticket panel.');
      }
      const panel = cleanPanelInput({
        name: 'Default ticket panel', panelType: 'ticket', title: 'Need help?',
        description: 'Press the button below to open a private support ticket.',
        color: gData.settings.embedColor, footer: gData.settings.footerText,
        buttonLabel: 'Create Ticket', buttonStyle: 'primary', channelId: interaction.channelId,
      });
      gData.panels.unshift(panel);
      await persistDatabase();
      const message = await publishPanel(guild, panel);
      return interaction.reply(ephemeral(`Ticket panel published in <#${message.channelId}>. You can customize it from the dashboard.`));
    }

    const ticket = findTicket(guild.id, interaction.channelId);
    if (!ticket) throw new Error('This command must be used inside an open ticket channel.');
    const member = await guild.members.fetch(user.id);
    const isOwner = ticket.ownerId === user.id;
    const isStaff = isTicketStaff(member, gData);

    if (sub === 'close') {
      if (!isOwner && !isStaff) throw new Error('Only the ticket owner or configured support staff can close this ticket.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await closeTicket(guild, interaction.channel, user, `Closed using /ticket close by ${user.tag}`, { deleteChannel: isStaff });
      return interaction.editReply(isStaff
        ? 'Ticket closed, transcript saved, and ticket channel deleted.'
        : 'Ticket closed and transcript saved. The channel has been archived.');
    }
    if (sub === 'transcript') {
      if (!isOwner && !isStaff) throw new Error('Only the ticket owner or configured support staff can export this transcript.');
      const transcript = await createTranscript(interaction.channel);
      return interaction.reply({ content: 'Here is the current ticket transcript.', files: [new AttachmentBuilder(transcript.buffer, { name: transcript.filename })], flags: MessageFlags.Ephemeral });
    }
    if (!isStaff) throw new Error('Only configured support staff can add or remove members.');
    const target = options.getUser('user', true);
    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) throw new Error('That user is not a member of this server.');
    if (sub === 'add') {
      await interaction.channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
      }, { reason: `Added to ticket by ${user.tag}` });
      await makeLog(guild, { action: 'Ticket Member Added', targetId: target.id, targetTag: target.tag, moderatorId: user.id, moderatorTag: user.tag, channelId: interaction.channelId });
      return interaction.reply(ephemeral(`Added ${target.tag} to this ticket.`));
    }
    if (sub === 'remove') {
      if (target.id === ticket.ownerId) throw new Error('The ticket owner cannot be removed from their own ticket. Close the ticket instead.');
      await interaction.channel.permissionOverwrites.delete(target.id, `Removed from ticket by ${user.tag}`);
      await makeLog(guild, { action: 'Ticket Member Removed', targetId: target.id, targetTag: target.tag, moderatorId: user.id, moderatorTag: user.tag, channelId: interaction.channelId });
      return interaction.reply(ephemeral(`Removed ${target.tag} from this ticket.`));
    }
  }

  if (name === 'ban' || name === 'kick' || name === 'timeout' || name === 'untimeout' || name === 'warn' || name === 'warnings') {
    const targetUser = options.getUser('target', true);
    const reason = clip(options.getString('reason') || 'No reason provided', 500);
    if (name === 'warnings') {
      const list = gData.warnings.filter(w => w.userId === targetUser.id).slice(0, 10);
      const text = list.length
        ? list.map((warning, i) => `${i + 1}. ${warning.reason} — <@${warning.moderatorId}> · <t:${Math.floor(new Date(warning.timestamp).getTime() / 1000)}:R>`).join('\n')
        : 'No warnings recorded for that member.';
      return interaction.reply({ content: clip(`Warnings for ${targetUser.tag}\n${text}`, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (name === 'warn') {
      const warnTargetMember = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!warnTargetMember) throw new Error('That user is not a member of this server.');
      await assertCanModerate(interaction, warnTargetMember);
      const warning = { id: crypto.randomUUID(), userId: targetUser.id, userTag: targetUser.tag, moderatorId: user.id, moderatorTag: user.tag, reason, timestamp: new Date().toISOString() };
      gData.warnings.unshift(warning);
      if (gData.warnings.length > 1000) gData.warnings.length = 1000;
      await persistDatabase();
      await makeLog(guild, { action: 'Member Warned', targetId: targetUser.id, targetTag: targetUser.tag, moderatorId: user.id, moderatorTag: user.tag, reason });
      await targetUser.send(`You received a warning in **${guild.name}**.\nReason: ${reason}`).catch(() => {});
      return interaction.reply(ephemeral(`Recorded a warning for ${targetUser.tag}. Total recorded warnings: ${gData.warnings.filter(w => w.userId === targetUser.id).length}.`));
    }

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) throw new Error('That user is not a member of this server.');
    await assertCanModerate(interaction, targetMember);
    if (name === 'ban') {
      await targetMember.ban({ reason: `${reason} | By ${user.tag} (${user.id})`.slice(0, 512) });
    } else if (name === 'kick') {
      await targetMember.kick(`${reason} | By ${user.tag} (${user.id})`.slice(0, 512));
    } else if (name === 'timeout') {
      const minutes = options.getInteger('minutes', true);
      await targetMember.timeout(minutes * 60 * 1000, `${reason} | By ${user.tag} (${user.id})`.slice(0, 512));
    } else if (name === 'untimeout') {
      await targetMember.timeout(null, `${reason} | By ${user.tag} (${user.id})`.slice(0, 512));
    }
    const actionLabels = { ban: 'Member Banned', kick: 'Member Kicked', timeout: 'Member Timed Out', untimeout: 'Member Timeout Removed' };
    const details = name === 'timeout' ? `Duration: ${options.getInteger('minutes', true)} minutes` : '';
    await makeLog(guild, { action: actionLabels[name], targetId: targetUser.id, targetTag: targetUser.tag, moderatorId: user.id, moderatorTag: user.tag, reason, details });
    return interaction.reply(ephemeral(`${actionLabels[name]}: ${targetUser.tag}.`));
  }

  if (name === 'clear') {
    const amount = options.getInteger('amount', true);
    const deleted = await interaction.channel.bulkDelete(amount, true);
    await makeLog(guild, { action: 'Messages Cleared', moderatorId: user.id, moderatorTag: user.tag, channelId: interaction.channelId, details: `Deleted ${deleted.size} message(s).` });
    return interaction.reply(ephemeral(`Deleted ${deleted.size} recent messages. Messages older than 14 days are skipped by Discord.`));
  }

  if (name === 'slowmode') {
    const seconds = options.getInteger('seconds', true);
    if (!interaction.channel?.setRateLimitPerUser) throw new Error('Slowmode is only supported in a text channel.');
    await interaction.channel.setRateLimitPerUser(seconds, `Changed by ${user.tag}`);
    await makeLog(guild, { action: 'Slowmode Changed', moderatorId: user.id, moderatorTag: user.tag, channelId: interaction.channelId, details: `${seconds} second(s).` });
    return interaction.reply(ephemeral(`Slowmode set to ${seconds} second(s).`));
  }

  if (name === 'lock' || name === 'unlock') {
    const channel = options.getChannel('channel') || interaction.channel;
    if (!channel?.permissionOverwrites) throw new Error('Choose a text channel that supports permission overwrites.');
    if (name === 'lock') {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: `Locked by ${user.tag}` });
    } else {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: `Unlocked by ${user.tag}` });
    }
    await makeLog(guild, { action: name === 'lock' ? 'Channel Locked' : 'Channel Unlocked', moderatorId: user.id, moderatorTag: user.tag, channelId: channel.id });
    return interaction.reply(ephemeral(`${channel} has been ${name === 'lock' ? 'locked' : 'unlocked'} for @everyone.`));
  }

  if (name === 'modlogs') {
    const target = options.getUser('target');
    const records = gData.logs.filter(record => !target || record.targetId === target.id).slice(0, 10);
    const text = records.length ? records.map(record => {
      const when = Math.floor(new Date(record.timestamp).getTime() / 1000);
      return `• **${record.action}** — ${record.targetTag || 'No target'} — <t:${when}:R>${record.reason ? `\n  Reason: ${record.reason}` : ''}`;
    }).join('\n') : 'No matching logs found.';
    return interaction.reply({ content: clip(text, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
}

client.on(Events.ClientReady, async (readyClient) => {
  isReady = true;
  console.log(`Discord bot logged in as ${readyClient.user.tag}. Connected to ${readyClient.guilds.cache.size} server(s).`);
  await registerCommands();
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const gData = getGuildData(member.guild.id);
    const welcomeChannel = gData.settings.welcomeChannelId ? member.guild.channels.cache.get(gData.settings.welcomeChannelId) : null;
    if (welcomeChannel?.isTextBased() && typeof welcomeChannel.send === 'function') {
      const message = clip(gData.settings.welcomeMessage || 'Welcome {user} to {server}!', 1800)
        .replaceAll('{user}', `<@${member.id}>`)
        .replaceAll('{server}', member.guild.name.slice(0, 100));
      await welcomeChannel.send({ content: message, allowedMentions: { users: [member.id] } });
    }
    await makeLog(member.guild, { action: 'Member Joined', targetId: member.id, targetTag: member.user.tag, moderatorTag: 'Discord Event', details: `Member count: ${member.guild.memberCount}` });
  } catch (error) { console.error('Member join event error:', error); }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await makeLog(member.guild, { action: 'Member Left', targetId: member.id, targetTag: member.user?.tag || 'Unknown member', moderatorTag: 'Discord Event' });
  } catch (error) { console.error('Member leave event error:', error); }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    if (!ENABLE_MESSAGE_CONTENT_LOGS || !message.guild) return;
    if (message.partial) await message.fetch().catch(() => null);
    await makeLog(message.guild, {
      action: 'Message Deleted', targetId: message.author?.id || '', targetTag: message.author?.tag || 'Unknown author',
      moderatorTag: 'Discord Event', channelId: message.channelId,
      details: `Channel: #${message.channel?.name || message.channelId}\nContent: ${clip(message.content || '[content unavailable]', 700)}`,
    });
  } catch (error) { console.error('Message delete event error:', error); }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (!ENABLE_MESSAGE_CONTENT_LOGS || !newMessage.guild) return;
    if (oldMessage.partial) await oldMessage.fetch().catch(() => null);
    if (newMessage.partial) await newMessage.fetch().catch(() => null);
    if ((oldMessage.content || '') === (newMessage.content || '')) return;
    await makeLog(newMessage.guild, {
      action: 'Message Edited', targetId: newMessage.author?.id || '', targetTag: newMessage.author?.tag || 'Unknown author',
      moderatorTag: 'Discord Event', channelId: newMessage.channelId,
      details: `Channel: #${newMessage.channel?.name || newMessage.channelId}\nBefore: ${clip(oldMessage.content || '[content unavailable]', 300)}\nAfter: ${clip(newMessage.content || '[content unavailable]', 300)}`,
    });
  } catch (error) { console.error('Message update event error:', error); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== 'ticketpanel' || !interaction.guildId) {
        return interaction.respond([]).catch(() => {});
      }
      const focused = interaction.options.getFocused(true);
      if (focused.name !== 'panel') return interaction.respond([]).catch(() => {});
      const query = String(focused.value || '').trim().toLocaleLowerCase();
      const choices = getGuildData(interaction.guildId).panels
        .filter(panel => panel.panelType === 'ticket')
        .filter(panel => !query
          || String(panel.name || '').toLocaleLowerCase().includes(query)
          || String(panel.title || '').toLocaleLowerCase().includes(query)
          || String(panel.id || '').toLocaleLowerCase().includes(query))
        .slice(0, 25)
        .map(panel => ({
          name: clip(`${panel.name || 'Ticket panel'} · ${String(panel.id || '').slice(0, 8)}`, 100),
          value: String(panel.id),
        }));
      return interaction.respond(choices).catch(() => {});
    }

    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) return interaction.reply(ephemeral('Use this command inside a server.'));
      try {
        await enforceCommandAccess(interaction);
        await handleModerationCommand(interaction);
      } catch (error) {
        console.warn(`Command /${interaction.commandName} rejected or failed:`, error.message);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(ephemeral(safeError(error))).catch(() => {});
        } else {
          await interaction.reply(ephemeral(safeError(error))).catch(() => {});
        }
      }
      return;
    }

    if (!interaction.isButton()) return;
    const guild = interaction.guild;
    if (!guild) return interaction.reply(ephemeral('This button only works inside a server.'));
    const [kind, action, panelId] = interaction.customId.split(':');
    const gData = getGuildData(guild.id);

    if (kind === 'ticket' && action === 'create') {
      const panel = gData.panels.find(item => item.id === panelId);
      if (!panel || panel.panelType !== 'ticket') return interaction.reply(ephemeral('This ticket panel has been removed or disabled.'));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await createTicket(guild, interaction.user, panel);
      return interaction.editReply(result.created ? `Your ticket is ready: ${result.channel}` : `You already have an open ticket: ${result.channel}`);
    }

    if (kind === 'ticket' && action === 'claim') {
      const ticket = findTicket(guild.id, interaction.channelId);
      if (!ticket) return interaction.reply(ephemeral('This is not an open ticket.'));
      const member = await guild.members.fetch(interaction.user.id);
      if (!isTicketStaff(member, gData)) {
        return interaction.reply(ephemeral('Only configured ticket staff or members with the Ticket Handler role can claim this ticket.'));
      }
      if (ticket.claimedById) {
        const currentClaim = ticket.claimedById === interaction.user.id
          ? 'You have already claimed this ticket.'
          : `This ticket has already been claimed by <@${ticket.claimedById}>.`;
        return interaction.reply({ ...ephemeral(currentClaim), allowedMentions: { users: [ticket.claimedById] } });
      }
      ticket.claimedById = interaction.user.id;
      ticket.claimedByTag = interaction.user.tag;
      ticket.claimedAt = new Date().toISOString();
      await persistDatabase();
      const updatedEmbed = makeTicketEmbed(ticket, gData);
      await interaction.message.edit({
        content: interaction.message.content || '',
        embeds: [updatedEmbed],
        components: [ticketControlRow(ticket)],
        allowedMentions: { parse: [] },
      });
      await makeLog(guild, {
        action: 'Ticket Claimed', targetId: ticket.ownerId, targetTag: ticket.ownerTag,
        moderatorId: interaction.user.id, moderatorTag: interaction.user.tag,
        channelId: interaction.channelId, details: `Claimed ticket ${interaction.channel}.`,
      });
      return interaction.reply(ephemeral(`You claimed ${interaction.channel}.`));
    }

    if (kind === 'ticket' && action === 'close') {
      const ticket = findTicket(guild.id, interaction.channelId);
      if (!ticket) return interaction.reply(ephemeral('This is not an open ticket.'));
      const member = await guild.members.fetch(interaction.user.id);
      const isStaff = isTicketStaff(member, gData);
      if (ticket.ownerId !== interaction.user.id && !isStaff) {
        return interaction.reply(ephemeral('Only the ticket owner or support staff can close this ticket.'));
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await closeTicket(guild, interaction.channel, interaction.user, `Closed using ticket button by ${interaction.user.tag}`, { deleteChannel: isStaff });
      return interaction.editReply(isStaff
        ? 'Ticket closed, transcript saved, and ticket channel deleted.'
        : 'Ticket closed and transcript saved. The channel has been archived.');
    }

    if (kind === 'panel' && action === 'button') {
      const panel = gData.panels.find(item => item.id === panelId);
      if (!panel || panel.panelType !== 'custom') return interaction.reply(ephemeral('This panel has been removed.'));
      return interaction.reply(ephemeral(panel.buttonReply || 'Thanks! Your button was clicked.'));
    }
  } catch (error) {
    console.error('Interaction handler error:', error);
    if (interaction.isRepliable()) {
      const payload = ephemeral(`Something went wrong: ${safeError(error)}`);
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  }
});

// Public health endpoint; no dashboard data or secrets are exposed.
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, botOnline: isReady, uptimeSeconds: Math.floor(process.uptime()), serverCount: client.guilds.cache.size });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again later.' },
});

app.post('/api/login', loginLimiter, (req, res, next) => {
  const submitted = Buffer.from(String(req.body?.password || ''), 'utf8');
  const expected = Buffer.from(String(DASHBOARD_PASSWORD || ''), 'utf8');
  const same = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
  if (!same || !DASHBOARD_PASSWORD) return res.status(401).json({ error: 'Incorrect dashboard password.' });
  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.authenticated = true;
    req.session.createdAt = Date.now();
    return req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.json({ ok: true });
    });
  });
});

app.post('/api/logout', requireDashboard, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('eclipsemc_dashboard_session', { httpOnly: true, sameSite: 'strict', secure: 'auto' });
    res.json({ ok: true });
  });
});

app.get('/api/me', requireDashboard, (_req, res) => {
  const guilds = [...client.guilds.cache.values()].map(guild => ({
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 64 }),
    memberCount: guild.memberCount,
  })).sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    bot: client.user ? { id: client.user.id, username: client.user.username, avatar: client.user.displayAvatarURL({ size: 64 }) } : null,
    botOnline: isReady,
    serverCount: guilds.length,
    commandRegistrationError,
    guilds,
  });
});

app.get('/api/guilds/:guildId/data', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  const gData = getGuildData(guild.id);
  await guild.channels.fetch().catch(() => {});
  const channels = [...guild.channels.cache.values()]
    .filter(channel => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory].includes(channel.type))
    .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roles = [...guild.roles.cache.values()]
    .filter(role => role.id !== guild.id && !role.managed)
    .map(role => ({ id: role.id, name: role.name, position: role.position, color: role.hexColor }))
    .sort((a, b) => b.position - a.position);
  res.json({
    guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount, icon: guild.iconURL({ size: 128 }) },
    settings: gData.settings,
    logs: gData.logs.slice(0, 150),
    tickets: gData.tickets.slice(0, 150),
    warnings: gData.warnings.slice(0, 150),
    panels: gData.panels,
    commandPermissions: gData.commandPermissions,
    disabledCommands: gData.disabledCommands,
    commandNames: COMMAND_NAMES,
    channels,
    roles,
  });
});

app.patch('/api/guilds/:guildId/settings', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  try {
    const current = getGuildData(guild.id).settings;
    const input = req.body || {};
    const next = { ...current };
    for (const key of ['logChannelId', 'ticketCategoryId', 'welcomeChannelId']) {
      if (input[key] !== undefined) {
        const id = String(input[key] || '');
        if (id && !validSnowflake(id)) throw new Error(`${key} is not a valid Discord ID.`);
        if (id && !guild.channels.cache.has(id)) throw new Error(`${key} must be a channel in this server.`);
        if (key === 'ticketCategoryId' && id && guild.channels.cache.get(id).type !== ChannelType.GuildCategory) throw new Error('Ticket category must be a category channel.');
        if (['logChannelId', 'welcomeChannelId'].includes(key) && id && !guild.channels.cache.get(id).isTextBased()) throw new Error(`${key} must be a text channel.`);
        next[key] = id;
      }
    }
    for (const key of ['supportRoleIds', 'moderatorRoleIds']) {
      if (input[key] !== undefined) {
        if (!Array.isArray(input[key]) || input[key].length > 100) throw new Error(`${key} must be a list of Discord roles.`);
        const values = [...new Set(input[key].map(String))];
        for (const id of values) {
          if (!validSnowflake(id) || !guild.roles.cache.has(id)) throw new Error(`Role ${id} is not in this server.`);
        }
        next[key] = values;
      }
    }
    if (input.welcomeMessage !== undefined) next.welcomeMessage = clip(input.welcomeMessage, 1800);
    if (input.embedColor !== undefined) {
      if (!validColor(input.embedColor)) throw new Error('Embed color must be a hex value such as #7C5CFC.');
      next.embedColor = input.embedColor;
    }
    if (input.footerText !== undefined) next.footerText = clip(input.footerText, 200);
    getGuildData(guild.id).settings = next;
    await persistDatabase();
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/guilds/:guildId/panels', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  try {
    const gData = getGuildData(guild.id);
    if (gData.panels.length >= 100) throw new Error('This server already has 100 panels. Remove an old panel first.');
    const panel = cleanPanelInput(req.body || {});
    if (panel.channelId && !guild.channels.cache.has(panel.channelId)) throw new Error('Choose a channel from this server.');
    gData.panels.unshift(panel);
    await persistDatabase();
    res.status(201).json({ ok: true, panel });
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.patch('/api/guilds/:guildId/panels/:panelId', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  try {
    const gData = getGuildData(guild.id);
    const index = gData.panels.findIndex(panel => panel.id === req.params.panelId);
    if (index < 0) return res.status(404).json({ error: 'Panel not found.' });
    const panel = cleanPanelInput(req.body || {}, gData.panels[index]);
    if (panel.channelId && !guild.channels.cache.has(panel.channelId)) throw new Error('Choose a channel from this server.');
    gData.panels[index] = panel;
    await persistDatabase();
    res.json({ ok: true, panel });
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.post('/api/guilds/:guildId/panels/:panelId/publish', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  try {
    const panel = getGuildData(guild.id).panels.find(item => item.id === req.params.panelId);
    if (!panel) return res.status(404).json({ error: 'Panel not found.' });
    if (req.body?.channelId !== undefined) {
      if (req.body.channelId && (!validSnowflake(String(req.body.channelId)) || !guild.channels.cache.has(String(req.body.channelId)))) throw new Error('Choose a valid destination channel in this server.');
      panel.channelId = String(req.body.channelId || '');
    }
    const message = await publishPanel(guild, panel);
    res.json({ ok: true, panel, messageUrl: `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}` });
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.delete('/api/guilds/:guildId/panels/:panelId', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  const gData = getGuildData(guild.id);
  const index = gData.panels.findIndex(panel => panel.id === req.params.panelId);
  if (index < 0) return res.status(404).json({ error: 'Panel not found.' });
  const [panel] = gData.panels.splice(index, 1);
  if (panel.messageId && panel.channelId) {
    const channel = guild.channels.cache.get(panel.channelId);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(panel.messageId).catch(() => null);
      if (message) await message.delete().catch(() => {});
    }
  }
  await persistDatabase();
  res.json({ ok: true });
});

app.put('/api/guilds/:guildId/commands/:commandName', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  const commandName = req.params.commandName;
  if (!COMMAND_NAMES.includes(commandName)) return res.status(400).json({ error: 'Unknown command.' });
  try {
    const input = req.body || {};
    const gData = getGuildData(guild.id);
    if (input.disabled === true && !gData.disabledCommands.includes(commandName)) gData.disabledCommands.push(commandName);
    if (input.disabled === false) gData.disabledCommands = gData.disabledCommands.filter(name => name !== commandName);
    if (input.roleIds !== undefined) {
      if (!Array.isArray(input.roleIds) || input.roleIds.length > 100) throw new Error('roleIds must be a list of server roles.');
      const roleIds = [...new Set(input.roleIds.map(String))];
      for (const id of roleIds) if (!validSnowflake(id) || !guild.roles.cache.has(id)) throw new Error(`Role ${id} is not in this server.`);
      gData.commandPermissions[commandName] = { roleIds };
    }
    await persistDatabase();
    res.json({ ok: true, disabledCommands: gData.disabledCommands, commandPermission: gData.commandPermissions[commandName] || { roleIds: [] } });
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.get('/api/guilds/:guildId/transcripts/:filename', requireDashboard, async (req, res) => {
  const guild = getGuildOr404(req.params.guildId, res);
  if (!guild) return;
  const filename = path.basename(req.params.filename);
  const known = getGuildData(guild.id).tickets.some(ticket => ticket.transcriptFile === filename);
  if (!known || !/^ticket-[0-9]+-[0-9]+\.txt$/.test(filename)) return res.status(404).json({ error: 'Transcript not found.' });
  try {
    res.download(path.join(TRANSCRIPTS_DIR, filename));
  } catch (error) { res.status(404).json({ error: safeError(error) }); }
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

app.use((error, _req, res, _next) => {
  console.error('HTTP request error:', error);
  if (res.headersSent) return;
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error.' : safeError(error) });
});

async function start() {
  const missing = [];
  if (!BOT_TOKEN || BOT_TOKEN.includes('PASTE_YOUR')) missing.push('BOT_TOKEN');
  if (!CLIENT_ID || CLIENT_ID.includes('PASTE_YOUR') || !validSnowflake(CLIENT_ID)) missing.push('CLIENT_ID');
  if (!DASHBOARD_PASSWORD || DASHBOARD_PASSWORD.startsWith('replace-this') || DASHBOARD_PASSWORD.length < 16) missing.push('DASHBOARD_PASSWORD (at least 16 characters)');
  if (!SESSION_SECRET || SESSION_SECRET.startsWith('replace-this') || SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env for local development or configure them in Railway Variables.');
    process.exitCode = 1;
    return;
  }
  await initStorage();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard/API listening on port ${PORT}. Data directory: ${DATA_DIR}`);
  });
  await client.login(BOT_TOKEN);
}

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  // Let Railway restart the service after an unexpected fatal error.
  process.exit(1);
});

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});
