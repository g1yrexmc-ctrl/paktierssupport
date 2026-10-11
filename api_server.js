// EclipseMC - Premium Moderation + Ticket Bot with dashboard API (Railway ready)
const fs = require('fs'), path = require('path'), crypto = require('crypto'), express = require('express');
const { Client, GatewayIntentBits: G, REST, Routes, SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, AttachmentBuilder, MessageFlags } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DASHBOARD_PASSWORD, SESSION_SECRET } = process.env;
for (const k of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'DASHBOARD_PASSWORD', 'SESSION_SECRET'])
  if (!process.env[k]) { console.error('Missing env var: ' + k); process.exit(1); }

/* ---------- Storage (Railway volume) ---------- */
const DATA = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'transcripts'), { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
let db = { config: {}, panels: [], tickets: [], cases: [], counter: 0, caseCounter: 0 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
db.config = { logChannel: '', ticketLogChannel: '', modRoles: [], disabled: [], perms: {}, dmOnAction: true, ...db.config };
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }, 300); };
console.log('Data directory:', DATA);

/* ---------- Helpers ---------- */
const client = new Client({ intents: [G.Guilds, G.GuildMessages, G.MessageContent] });
const col = c => parseInt(String(c || '#7c5cff').replace('#', ''), 16) || 0x7c5cff;
const say = (i, c) => { const o = typeof c === 'string' ? { content: c } : c; return i.deferred || i.replied ? i.editReply(o) : i.reply({ ...o, flags: MessageFlags.Ephemeral }); };
const guild = () => client.guilds.cache.get(GUILD_ID);
const U = (o, n = 'user', d = 'Target user', req = true) => o.addUserOption(x => x.setName(n).setDescription(d).setRequired(req));
const R = o => o.addStringOption(x => x.setName('reason').setDescription('Reason'));
const dm = async (u, i, act, r) => { if (db.config.dmOnAction) await u.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`You were ${act} in ${i.guild.name}`).setDescription(`**Reason:** ${r}`)] }).catch(() => {}); };

function caseLog(type, user, mod, reason, extra = {}) {
  const c = { id: ++db.caseCounter, type, userId: user.id, userTag: user.username, modId: mod.id, modTag: mod.username, reason, at: Date.now(), ...extra };
  db.cases.push(c); save();
  client.channels.cache.get(db.config.logChannel)?.send({ embeds: [new EmbedBuilder().setColor(0xe8b64c).setTitle(`Case #${c.id} - ${type}`)
    .addFields({ name: 'User', value: `<@${user.id}> (${user.username})`, inline: true }, { name: 'Moderator', value: `<@${mod.id}>`, inline: true }, { name: 'Reason', value: reason.slice(0, 1000) }).setTimestamp()] }).catch(() => {});
  return c;
}
const getM = (i, u) => i.guild.members.fetch(u.id).catch(() => null);
const rs = i => i.options.getString('reason') || 'No reason provided';
const ticketOf = ch => db.tickets.find(t => t.channelId === ch.id && t.status === 'open');
const isStaff = (m, t) => m.permissions.has(P.ManageChannels) || (db.panels.find(p => p.id === t.panelId)?.roles || []).some(r => m.roles.cache.has(r));

/* ---------- Commands ---------- */
const cmds = [
  { n: 'ban', d: 'Ban a member', p: P.BanMembers, b: o => R(U(o)).addIntegerOption(x => x.setName('delete_days').setDescription('Delete messages (0-7 days)').setMinValue(0).setMaxValue(7)),
    run: async i => { const u = i.options.getUser('user'), m = await getM(i, u), r = rs(i); if (m && !m.bannable) return say(i, 'I cannot ban that member.');
      await dm(u, i, 'banned', r); await i.guild.members.ban(u.id, { reason: r, deleteMessageSeconds: (i.options.getInteger('delete_days') || 0) * 86400 });
      say(i, `Banned **${u.username}** (Case #${caseLog('BAN', u, i.user, r).id})`); } },
  { n: 'unban', d: 'Unban a user by ID', p: P.BanMembers, b: o => R(o.addStringOption(x => x.setName('user_id').setDescription('User ID').setRequired(true))),
    run: async i => { const id = i.options.getString('user_id'); if (!(await i.guild.members.unban(id, rs(i)).catch(() => null))) return say(i, 'That user is not banned.');
      const u = await client.users.fetch(id).catch(() => ({ id, username: id })); say(i, `Unbanned **${u.username}** (Case #${caseLog('UNBAN', u, i.user, rs(i)).id})`); } },
  { n: 'kick', d: 'Kick a member', p: P.KickMembers, b: o => R(U(o)),
    run: async i => { const u = i.options.getUser('user'), m = await getM(i, u), r = rs(i); if (!m?.kickable) return say(i, 'I cannot kick that member.');
      await dm(u, i, 'kicked', r); await m.kick(r); say(i, `Kicked **${u.username}** (Case #${caseLog('KICK', u, i.user, r).id})`); } },
  { n: 'timeout', d: 'Timeout a member', p: P.ModerateMembers, b: o => R(U(o).addIntegerOption(x => x.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))),
    run: async i => { const u = i.options.getUser('user'), m = await getM(i, u), r = rs(i), min = i.options.getInteger('minutes'); if (!m?.moderatable) return say(i, 'I cannot timeout that member.');
      await dm(u, i, `timed out for ${min}m`, r); await m.timeout(min * 60000, r); say(i, `Timed out **${u.username}** for ${min}m (Case #${caseLog('TIMEOUT', u, i.user, r, { duration: min }).id})`); } },
  { n: 'untimeout', d: 'Remove a timeout', p: P.ModerateMembers, b: o => U(o),
    run: async i => { const u = i.options.getUser('user'), m = await getM(i, u); if (!m?.moderatable) return say(i, 'I cannot edit that member.');
      await m.timeout(null); say(i, `Timeout removed from **${u.username}** (Case #${caseLog('UNTIMEOUT', u, i.user, 'Timeout removed').id})`); } },
  { n: 'warn', d: 'Warn a member', p: P.ModerateMembers, b: o => R(U(o)),
    run: async i => { const u = i.options.getUser('user'), r = rs(i); await dm(u, i, 'warned', r); say(i, `Warned **${u.username}** (Case #${caseLog('WARN', u, i.user, r).id})`); } },
  { n: 'warnings', d: 'View a member\'s warnings', p: P.ModerateMembers, b: o => U(o),
    run: async i => { const u = i.options.getUser('user'), w = db.cases.filter(c => c.type === 'WARN' && c.userId === u.id && !c.cleared);
      say(i, { embeds: [new EmbedBuilder().setColor(0xe8b64c).setTitle(`Warnings for ${u.username} (${w.length})`).setDescription(w.slice(-10).map(c => `**#${c.id}** <t:${Math.floor(c.at / 1000)}:d> - ${c.reason}`).join('\n') || 'No warnings.')] }); } },
  { n: 'clearwarnings', d: 'Clear all warnings of a member', p: P.ModerateMembers, b: o => U(o),
    run: async i => { const u = i.options.getUser('user'); db.cases.forEach(c => { if (c.type === 'WARN' && c.userId === u.id) c.cleared = true; }); save(); say(i, `Cleared warnings for **${u.username}**.`); } },
  { n: 'modlogs', d: 'View moderation history of a member', p: P.ModerateMembers, b: o => U(o),
    run: async i => { const u = i.options.getUser('user'), w = db.cases.filter(c => c.userId === u.id).slice(-10);
      say(i, { embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(`Mod logs: ${u.username}`).setDescription(w.map(c => `**#${c.id}** ${c.type} - ${c.reason}`).join('\n') || 'Clean record.')] }); } },
  { n: 'purge', d: 'Bulk delete messages', p: P.ManageMessages, b: o => o.addIntegerOption(x => x.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    run: async i => { await i.deferReply({ flags: MessageFlags.Ephemeral }); const d = await i.channel.bulkDelete(i.options.getInteger('amount'), true); say(i, `Deleted ${d.size} messages.`); caseLog('PURGE', i.user, i.user, `${d.size} messages in #${i.channel.name}`); } },
  { n: 'slowmode', d: 'Set channel slowmode', p: P.ManageChannels, b: o => o.addIntegerOption(x => x.setName('seconds').setDescription('0 to disable').setRequired(true).setMinValue(0).setMaxValue(21600)),
    run: async i => { await i.channel.setRateLimitPerUser(i.options.getInteger('seconds')); say(i, 'Slowmode updated.'); } },
  { n: 'lock', d: 'Lock this channel', p: P.ManageChannels, b: o => o,
    run: async i => { await i.channel.permissionOverwrites.edit(i.guild.id, { SendMessages: false }); say(i, 'Channel locked.'); } },
  { n: 'unlock', d: 'Unlock this channel', p: P.ManageChannels, b: o => o,
    run: async i => { await i.channel.permissionOverwrites.edit(i.guild.id, { SendMessages: null }); say(i, 'Channel unlocked.'); } },
  { n: 'userinfo', d: 'Show user info', p: null, b: o => U(o, 'user', 'User', false),
    run: async i => { const u = i.options.getUser('user') || i.user, m = await getM(i, u);
      say(i, { embeds: [new EmbedBuilder().setColor(0x7c5cff).setThumbnail(u.displayAvatarURL()).setTitle(u.username).addFields({ name: 'ID', value: u.id, inline: true },
        { name: 'Created', value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true }, { name: 'Joined', value: m ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>` : 'Not in server', inline: true })] }); } },
  { n: 'serverinfo', d: 'Show server info', p: null, b: o => o,
    run: async i => say(i, { embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(i.guild.name).setThumbnail(i.guild.iconURL()).addFields({ name: 'Members', value: String(i.guild.memberCount), inline: true },
      { name: 'Channels', value: String(i.guild.channels.cache.size), inline: true }, { name: 'Roles', value: String(i.guild.roles.cache.size), inline: true })] }) },
  { n: 'ticket', d: 'Ticket tools', p: null,
    b: o => o.addSubcommand(s => s.setName('add').setDescription('Add a user to this ticket').addUserOption(x => x.setName('user').setDescription('User').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a user from this ticket').addUserOption(x => x.setName('user').setDescription('User').setRequired(true)))
      .addSubcommand(s => s.setName('claim').setDescription('Claim this ticket'))
      .addSubcommand(s => s.setName('close').setDescription('Close this ticket').addStringOption(x => x.setName('reason').setDescription('Reason'))),
    run: async i => { const t = ticketOf(i.channel); if (!t) return say(i, 'This is not an open ticket.'); if (!isStaff(i.member, t)) return say(i, 'Staff only.');
      const sub = i.options.getSubcommand();
      if (sub === 'add' || sub === 'remove') { const u = i.options.getUser('user'); await i.channel.permissionOverwrites.edit(u.id, sub === 'add' ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true } : { ViewChannel: false }); return say(i, `${sub === 'add' ? 'Added' : 'Removed'} <@${u.id}>.`); }
      if (sub === 'claim') return claim(i, t);
      await say(i, 'Closing...'); closeTicket(t, i.channel, i.user, i.options.getString('reason') || 'No reason'); } },
];

/* ---------- Permissions ---------- */
function allowed(i, c) {
  const m = i.member, cf = db.config;
  if (cf.disabled.includes(c.n)) return false;
  if (m.permissions.has(P.Administrator)) return true;
  const r = cf.perms[c.n]; if (r?.length) return r.some(x => m.roles.cache.has(x));
  if (!c.p) return true;
  if (cf.modRoles.some(x => m.roles.cache.has(x))) return true;
  return m.permissions.has(c.p);
}

/* ---------- Tickets ---------- */
const panelMsg = p => {
  const e = new EmbedBuilder().setColor(col(p.color)).setTitle(p.title || 'EclipseMC Support').setDescription(p.description || 'Click the button below to open a ticket.');
  if (p.image) e.setImage(p.image); if (p.footer) e.setFooter({ text: p.footer });
  const b = new ButtonBuilder().setCustomId('tk_open:' + p.id).setLabel(p.buttonLabel || 'Open ticket').setStyle(ButtonStyle[p.buttonStyle] || ButtonStyle.Primary);
  if (p.buttonEmoji) b.setEmoji(p.buttonEmoji);
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(b)] };
};
async function openTicket(i, p) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (db.tickets.filter(t => t.userId === i.user.id && t.panelId === p.id && t.status === 'open').length >= (p.maxOpen || 1)) return say(i, 'You already have the maximum number of open tickets.');
  const n = ++db.counter, allow = [P.ViewChannel, P.SendMessages, P.ReadHistory ?? P.ReadMessageHistory, P.AttachFiles];
  const ch = await i.guild.channels.create({ name: `${p.prefix || 'ticket'}-${String(n).padStart(4, '0')}`, type: ChannelType.GuildText, topic: `Ticket owner: ${i.user.id}`,
    parent: i.guild.channels.cache.get(p.categoryId)?.type === 4 ? p.categoryId : null,
    permissionOverwrites: [{ id: i.guild.id, deny: [P.ViewChannel] }, { id: i.user.id, allow }, { id: client.user.id, allow: [...allow, P.ManageChannels] },
      ...(p.roles || []).filter(r => i.guild.roles.cache.has(r)).map(id => ({ id, allow }))] });
  db.tickets.push({ id: n, panelId: p.id, panelName: p.name, userId: i.user.id, userTag: i.user.username, channelId: ch.id, status: 'open', claimedBy: null, createdAt: Date.now() }); save();
  const txt = (p.welcome || 'Hello {user}, staff will be with you shortly.').replace(/{user}/g, `<@${i.user.id}>`).replace(/{panel}/g, p.name);
  await ch.send({ content: `<@${i.user.id}> ${(p.roles || []).map(r => `<@&${r}>`).join(' ')}`, embeds: [new EmbedBuilder().setColor(col(p.color)).setTitle(`Ticket #${n}`).setDescription(txt)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tk_close').setLabel('Close').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('tk_claim').setLabel('Claim').setStyle(ButtonStyle.Success))] });
  say(i, `Your ticket is ready: <#${ch.id}>`);
}
async function claim(i, t) {
  if (!isStaff(i.member, t)) return say(i, 'Staff only.'); if (t.claimedBy) return say(i, `Already claimed by <@${t.claimedBy}>.`);
  t.claimedBy = i.user.id; save(); i.deferred || i.replied ? i.editReply(`Claimed by <@${i.user.id}>.`) : i.reply(`Ticket claimed by <@${i.user.id}>.`);
}
async function closeTicket(t, ch, by, reason) {
  t.status = 'closed'; t.closedAt = Date.now(); t.closedBy = by.username; t.closeReason = reason;
  const msgs = [];
  for (let b, k = 0; k < 10; k++) { const r = await ch.messages.fetch({ limit: 100, before: b }).catch(() => null); if (!r?.size) break; msgs.push(...r.values()); b = r.last().id; }
  const tr = msgs.reverse().map(m => ({ a: m.author.username, bot: m.author.bot, c: m.content, at: m.createdTimestamp, f: [...m.attachments.values()].map(x => x.url), e: m.embeds.length }));
  fs.writeFileSync(path.join(DATA, 'transcripts', t.id + '.json'), JSON.stringify(tr)); save();
  const p = db.panels.find(x => x.id === t.panelId), logCh = client.channels.cache.get(p?.logChannel || db.config.ticketLogChannel);
  const file = new AttachmentBuilder(Buffer.from(tr.map(m => `[${new Date(m.at).toISOString()}] ${m.a}: ${m.c}${m.f.length ? ' ' + m.f.join(' ') : ''}`).join('\n')), { name: `ticket-${t.id}.txt` });
  const emb = new EmbedBuilder().setColor(0xed4245).setTitle(`Ticket #${t.id} closed`).addFields({ name: 'Owner', value: `<@${t.userId}>`, inline: true }, { name: 'Closed by', value: by.username, inline: true },
    { name: 'Panel', value: t.panelName || '-', inline: true }, { name: 'Reason', value: reason.slice(0, 500) }).setTimestamp();
  await logCh?.send({ embeds: [emb], files: [file] }).catch(() => {});
  await client.users.fetch(t.userId).then(u => u.send({ embeds: [emb], files: [new AttachmentBuilder(file.attachment, { name: file.name })] })).catch(() => {});
  setTimeout(() => ch.delete().catch(() => {}), 5000);
}

/* ---------- Discord events ---------- */
client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);
  const body = cmds.map(c => { const b = new SlashCommandBuilder().setName(c.n).setDescription(c.d); c.b(b); return b.toJSON(); });
  await new REST().setToken(DISCORD_TOKEN).put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body }).then(() => console.log('Slash commands registered')).catch(console.error);
});
client.on('interactionCreate', async i => {
  try {
    if (i.isChatInputCommand()) { const c = cmds.find(x => x.n === i.commandName); if (!c) return; if (!allowed(i, c)) return say(i, 'You do not have permission to use this command.'); await c.run(i); }
    else if (i.isButton()) {
      if (i.customId.startsWith('tk_open:')) { const p = db.panels.find(x => x.id === i.customId.split(':')[1]); return p ? openTicket(i, p) : say(i, 'This panel no longer exists.'); }
      const t = ticketOf(i.channel); if (!t) return say(i, 'This ticket is already closed.');
      if (i.customId === 'tk_claim') return claim(i, t);
      if (i.customId === 'tk_close') { if (!isStaff(i.member, t) && i.user.id !== t.userId) return say(i, 'Only staff or the ticket owner can close this.'); await i.reply('Closing ticket in 5 seconds...'); closeTicket(t, i.channel, i.user, 'Closed via button'); }
    }
  } catch (e) { console.error(e); say(i, 'Something went wrong. Check my permissions and try again.').catch(() => {}); }
});

/* ---------- Dashboard API ---------- */
const app = express(); app.use(express.json({ limit: '200kb' }));
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const valid = t => { const [e, s] = (t || '').split('.'); return !!e && s?.length === 64 && +e > Date.now() && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(e))); };
const auth = (q, r, n) => valid((q.headers.authorization || '').slice(7)) ? n() : r.status(401).json({ error: 'Unauthorized' });
const tries = {};
app.get('/health', (q, r) => r.send('ok'));
app.post('/api/login', (q, r) => {
  const ip = q.ip, t = tries[ip] = (tries[ip] || []).filter(x => x > Date.now() - 6e5); if (t.length >= 8) return r.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  if (!crypto.timingSafeEqual(sha(q.body.password), sha(DASHBOARD_PASSWORD))) { t.push(Date.now()); return r.status(401).json({ error: 'Wrong password' }); }
  const e = Date.now() + 7 * 864e5; r.json({ token: `${e}.${sign(String(e))}` });
});
app.get('/api/meta', auth, (q, r) => {
  const g = guild(); if (!g) return r.json({ ready: false });
  r.json({ ready: true, ping: client.ws.ping, guild: { name: g.name, icon: g.iconURL(), members: g.memberCount },
    channels: g.channels.cache.filter(c => [0, 4, 5].includes(c.type)).map(c => ({ id: c.id, name: c.name, type: c.type })),
    roles: g.roles.cache.filter(x => x.id !== g.id).map(x => ({ id: x.id, name: x.name })),
    stats: { open: db.tickets.filter(t => t.status === 'open').length, total: db.tickets.length, cases: db.cases.length, panels: db.panels.length } });
});
app.get('/api/commands', auth, (q, r) => r.json(cmds.map(c => ({ n: c.n, d: c.d, mod: !!c.p }))));
app.get('/api/config', auth, (q, r) => r.json(db.config));
app.put('/api/config', auth, (q, r) => {
  const b = q.body, arr = a => (Array.isArray(a) ? a : []).map(String);
  db.config = { logChannel: String(b.logChannel || ''), ticketLogChannel: String(b.ticketLogChannel || ''), modRoles: arr(b.modRoles), disabled: arr(b.disabled), dmOnAction: !!b.dmOnAction,
    perms: Object.fromEntries(Object.entries(b.perms || {}).map(([k, v]) => [k, arr(v)])) }; save(); r.json(db.config);
});
const F = ['name', 'title', 'description', 'color', 'buttonLabel', 'buttonEmoji', 'buttonStyle', 'categoryId', 'logChannel', 'welcome', 'prefix', 'image', 'footer'];
const clean = b => { const o = {}; F.forEach(k => o[k] = String(b[k] ?? '').slice(0, 2000)); o.roles = (Array.isArray(b.roles) ? b.roles : []).map(String); o.maxOpen = Math.min(10, Math.max(1, +b.maxOpen || 1)); return o; };
app.get('/api/panels', auth, (q, r) => r.json(db.panels));
app.post('/api/panels', auth, (q, r) => { const p = { id: crypto.randomBytes(4).toString('hex'), ...clean(q.body) }; db.panels.push(p); save(); r.json(p); });
app.put('/api/panels/:id', auth, async (q, r) => {
  const p = db.panels.find(x => x.id === q.params.id); if (!p) return r.status(404).json({ error: 'Panel not found' });
  Object.assign(p, clean(q.body)); save();
  if (p.messageId) await client.channels.cache.get(p.channelId)?.messages.fetch(p.messageId).then(m => m.edit(panelMsg(p))).catch(() => {});
  r.json(p);
});
app.post('/api/panels/:id/send', auth, async (q, r) => {
  const p = db.panels.find(x => x.id === q.params.id), ch = guild()?.channels.cache.get(q.body.channelId);
  if (!p || !ch?.isTextBased()) return r.status(400).json({ error: 'Pick a valid text channel' });
  try { const m = await ch.send(panelMsg(p)); p.channelId = ch.id; p.messageId = m.id; save(); r.json(p); }
  catch (e) { r.status(400).json({ error: 'Bot cannot post in that channel: ' + e.message }); }
});
app.delete('/api/panels/:id', auth, async (q, r) => {
  const p = db.panels.find(x => x.id === q.params.id); if (!p) return r.status(404).json({ error: 'Panel not found' });
  if (p.messageId) await client.channels.cache.get(p.channelId)?.messages.fetch(p.messageId).then(m => m.delete()).catch(() => {});
  db.panels = db.panels.filter(x => x !== p); save(); r.json({ ok: true });
});
app.get('/api/tickets', auth, (q, r) => r.json([...db.tickets].reverse().slice(0, 300)));
app.get('/api/tickets/:id/transcript', auth, (q, r) => { try { r.json(JSON.parse(fs.readFileSync(path.join(DATA, 'transcripts', String(+q.params.id) + '.json')))); } catch { r.status(404).json({ error: 'No transcript saved for this ticket' }); } });
app.post('/api/tickets/:id/close', auth, (q, r) => {
  const t = db.tickets.find(x => x.id === +q.params.id && x.status === 'open'), ch = client.channels.cache.get(t?.channelId);
  if (!t || !ch) return r.status(404).json({ error: 'Open ticket not found' }); closeTicket(t, ch, { username: 'Dashboard' }, 'Closed from dashboard'); r.json({ ok: true });
});
app.get('/api/cases', auth, (q, r) => r.json([...db.cases].reverse().slice(0, 500)));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Dashboard on port', process.env.PORT || 3000));
client.login(DISCORD_TOKEN);
process.on('unhandledRejection', e => console.error('Unhandled:', e));
