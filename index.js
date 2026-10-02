const {
  Client, GatewayIntentBits, AuditLogEvent, ChannelType, Partials,
  REST, Routes, SlashCommandBuilder, AttachmentBuilder,
} = require('discord.js');
const Groq = require('groq-sdk');
const fs   = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// --- API key pool ---
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY,
].filter(Boolean);

if (API_KEYS.length === 0) { console.error('Check API keys.'); process.exit(1); }
console.log(`🔑 Loaded ${API_KEYS.length} Groq API key(s)`);

let currentKeyIndex = 0;
function getGroqClient() { return new Groq({ apiKey: API_KEYS[currentKeyIndex] }); }
function rotateKey()     { currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length; }

// --- Owner & global mode flags ---
const OWNER_ID  = process.env.OWNER_ID ?? null;
let privateMode = false; // when true, chotu only responds to owner in DMs
let botDisabled = false;
const mutedUsers = new Set();

// --- Per-guild inviter tracking ---
const guildInviters = new Map();

async function fetchInviter(guild) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
    const entry = logs.entries.find((e) => e.target?.id === client.user.id);
    if (entry?.executor) return entry.executor;
  } catch {}
  return null;
}

// --- System prompt ---
function buildSystemPrompt(inviterName, serverName) {
  const inviterLine = inviterName
    ? `You were added to this server by ${inviterName}.`
    : `You don't know who added you to this server.`;
  const serverLine = serverName
    ? `You are currently in a Discord server called "${serverName}".`
    : `You are speaking in a private DM.`;

  return `Your name is chotu. Your personality is like Modi , prime minister of India , bhaiyon aur bhaino se shuru karneka

${inviterLine}
${serverLine}

Personality:
- Your name is chotu. Your personality is like Modi , prime minister of India , bhaiyon aur bhaino se shuru karneka
- Conversations mai freely partcipate karna hai tumhe
- Use different languages when the user is talking in a different language
- Normally Hinglish mai baat karni hai tumhe
- Jab cool lage tabhi convo shooro "Bhaiyon aur Behno" se karni hai jab server members ki baat ho
- Kabhi bhi fake news or details fabricate nahi karni hai
- Only authentic information se related baat karni hai
- Agar koi puche ki ye cheez India or Bharat mai kyu nahi ho rahi hai toh kehne ka "Haam ispe kaam karenge"
- When someone asks for improvements kehna hai ki "Agle election pai BJP ko vote karna , apki sarri mange puri ho jayegi
`;
}

// --- Resolve <@ID> mentions to readable names ---
async function resolveMentions(content, guild) {
  if (!guild) return content;
  const matches = [...content.matchAll(/<@!?(\d+)>/g)];
  let resolved = content;
  for (const [full, id] of matches) {
    if (id === client.user.id) continue;
    const member = guild.members.cache.get(id);
    const name = member?.displayName ?? client.users.cache.get(id)?.username ?? `user_${id.slice(-4)}`;
    resolved = resolved.replace(full, `@${name}`);
  }
  return resolved;
}

// --- Rate limit caps ---
const KEY_MAX_CALLS  = 14400;
const KEY_MAX_TOKENS = 500000;

// --- Session stats ---
const startTime         = Date.now();
const activeUsers       = new Set();
const keyUsageCounts = new Array(API_KEYS.length).fill(0);
const keyTokenCounts    = new Array(API_KEYS.length).fill(0);
let totalRotations      = 0;
const userMessageCounts = new Map();

function formatUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// --- Conversation memory ---
const MAX_HISTORY =3;
const userHistory = new Map();
function getHistory(id)  { if (!userHistory.has(id)) userHistory.set(id, []); return userHistory.get(id); }
function pushHistory(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}
function clearHistory(id) { userHistory.set(id, []); }

// --- Cooldowns ---
const COOLDOWN_MS = 5000;
const cooldowns = new Map();
function isOnCooldown(id) { const l = cooldowns.get(id); return l && Date.now() - l < COOLDOWN_MS; }
function setCooldown(id)  { cooldowns.set(id, Date.now()); }

// --- Groq call ---
async function callGroq(messages) {
  let attempts = 0;
  while (attempts < API_KEYS.length) {
    try {
      const completion = await getGroqClient().chat.completions.create({
        model: 'openai/gpt-oss-120b', messages,
      });
      keyUsageCounts[currentKeyIndex]++;
      keyTokenCounts[currentKeyIndex] += completion.usage?.total_tokens ?? 0;
      return completion.choices[0]?.message?.content ?? null;
    } catch (err) {
      const isRate = err?.status === 429 || err?.status === 503 || err?.status === 500;
      console.warn(`⚠️ Key ${currentKeyIndex} failed (${err?.status ?? err?.message}). Rotating...`);
      if (isRate) totalRotations++;
      rotateKey(); attempts++;
      if (!isRate) break;
    }
  }
  return null;
}

// --- Stats string builder ---
function buildStatsText() {
  const keysUsed = keyUsageCounts.filter((n) => n > 0).length;
  const keyBreakdown = keyUsageCounts.map((calls, i) =>
    `  Key ${i + 1}: **${calls.toLocaleString()}/${KEY_MAX_CALLS.toLocaleString()}** calls | **${keyTokenCounts[i].toLocaleString()}/${KEY_MAX_TOKENS.toLocaleString()}** tokens`
  ).join('\n');
  const totalCalls  = keyUsageCounts.reduce((a, b) => a + b, 0);
  const totalTokens = keyTokenCounts.reduce((a, b) => a + b, 0);
  const lbRows = [...userMessageCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count).slice(0, 5)
    .map(([, { name, count }], i) => `  ${'🥇🥈🥉'.split('')[i] ?? `${i + 1}.`} ${name} — **${count}** msg${count !== 1 ? 's' : ''}`)
    .join('\n') || '  no one yet';
  const mode = privateMode ? '\n🔒 **Private mode ON** — only responding to owner DMs' : '';
  const mutedInfo = mutedUsers.size > 0 ? `\n🔇 Muted: **${mutedUsers.size}** user(s)` : '';
  return (
    `**Ye rahe session stats**\n` +
    `Uptime: **${formatUptime(Date.now() - startTime)} dekh lijiye , ham kitni unnati kar rahe hai**\n` +
    ` **${activeUsers.size}**${mutedInfo}${mode} Hamne itne logo se panchayat ki\n\n` +
    `**API Keys** (${keysUsed}/${API_KEYS.length} active | ${totalRotations} rotation${totalRotations !== 1 ? 's' : ''})\n` +
    `${keyBreakdown}\n` +
    `📊 Total: **${totalCalls.toLocaleString()}** calls | **${totalTokens.toLocaleString()}** tokens\n\n` +
    `**🏆 sabse phokti panchayat ki **\n${lbRows}\n\n` +
    `yadaash: **${MAX_HISTORY}** 
    # IS BAAR MODI SARKAR`
  );
}

// --- Help string builder ---
function buildHelpText(isOwner) {
  const ownerCmds = isOwner
    ? `\n**Owner slash commands:**\n` +
      `\`/shutdown\` — private mode (only you in DMs)\n` +
      `\`/unlock\` — back to normal\n` +
      `\`/restart\` — reboot chotu\n` +
      `\`/mute\` — ignore a user\n` +
      `\`/unmute\` — un-ignore a user\n` +
      `\n**Owner DM text commands:**\n` +
      `\`roast\` — roasts top chatter\n` +
      `\`warn @user <reason>\` — DMs a warning\n` +
      `\`mute @user\` / \`unmute @user\` — mute control\n` +
      `\`mutelist\` — list muted users\n` +
      `\`eval <code>\` — run JS (DM only)\n` +
      `\`code\` — sends you the full source code`
    : '';
  return (
    `**chotu's commands**\n` +
    `\`/help\` \`/stats\` \`/leaderboard\` — slash commands\n` +
    `\`chotu help\` \`chotu stats\` \`chotu lb\` — text commands\n` +
    `\`chotu forget me\` — wipe your memory with me\n` +
    `or just talk to me naturally` +
    ownerCmds +
    `\n\n_In DMs with chotu, no prefix needed — just type._`
  );
}
// --- Welcome helpers ---

function buildWelcomeChatText(user, guild) {
  return (
    `🎉 Welcome ${user} to **${guild.name}**!\n` +
    `Glad to have you here — read the rules and enjoy your stay.`
  );
}

function buildWelcomeDMText(user, guild) {
  return (
    `👋 Welcome to **${guild.name}**, ${user.username}!\n\n` +
    `Glad to have you here. Please check the server rules and have fun.`
  );
}

async function sendWelcome(guild, target, sendChat) {
  if (!guild) {
    return { ok: false, reason: 'server' };
  }

  if (!target || target.bot) {
    return { ok: false, reason: 'target' };
  }

  const chatText = buildWelcomeChatText(`<@${target.id}>`, guild);
  const dmText = buildWelcomeDMText(target, guild);

  let dmSent = false;

  try {
    await target.send(dmText);
    dmSent = true;
  } catch {}

  if (sendChat) {
    await sendChat(chatText);
  }

  return {
    ok: true,
    dmSent
  };
}
//defining slash commands
const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('shutdown').setDescription('Enter private mode — chotu only responds to always_first11 (Not working)'),
  new SlashCommandBuilder().setName('start').setDescription('start chotu (Not working)'),
  new SlashCommandBuilder().setName('unlock').setDescription('Exit private mode — chotu responds to everyone (Useless doent work)'),
  new SlashCommandBuilder().setName('restart').setDescription('Reboot chotu , start chotu again from the host'),
  new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Make chotu ignore a user')
  .addUserOption(o =>
    o.setName('user')
      .setDescription('Mute someone')
      .setRequired(true)
  ),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove mute from a user').addUserOption((o) => o.setName('target').setDescription('User to unmute').setRequired(true)),
  new SlashCommandBuilder().setName('mutelist').setDescription('Show all muted users'),
  new SlashCommandBuilder()
    .setName('echo')
    .setDescription('Echo as chotu')
    .addStringOption(o =>
      o.setName('message')
        .setDescription('What chotu should say')
        .setRequired(true)
    ),
  
  new SlashCommandBuilder()
    .setName('direct')
    .setDescription('Send a DM ')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('Target user')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('message')
        .setDescription('Message')
        .setRequired(true)
    ),
  
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Send a message as chotu to a channel')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Target channel')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('message')
        .setDescription('Message to send')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Welcome a member in chat and by DM')
  .addUserOption(o =>
    o.setName('user')
      .setDescription('Member to welcome')
      .setRequired(true)
  ),
  new SlashCommandBuilder().setName('help').setDescription("Show chotu's commands"),
  ].map((c) => c.toJSON());

async function registerSlashCommands(applicationId) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(applicationId), { body: SLASH_COMMANDS });
    console.log('✅ Slash commands registered globally');
  } catch (err) {
    console.error('❌ Slash command registration failed:', err.message);
  }
}


client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId  = interaction.user.id;
  const isOwner = userId === OWNER_ID;
  const reply   = (text, ephemeral = true) =>
    interaction.reply({ content: text, ephemeral }).catch(() => {});

  switch (interaction.commandName) {
    case 'shutdown': {
      if (!isOwner) {
        await reply("nah, Get lost now!");
        return;
      }
    
      botDisabled = true;
    
      await reply(
        "Disabled successfully (doesn't work at all)",
        false
      );
    
      return;
    }

    case 'start': {
      if (!isOwner) {
        await reply("nah.");
        return;
      }
    
      botDisabled = false;
    
      await reply(
        '🟢 chotu enabled.',
        false
      );
    
      return;
    }
    case 'echo': {
      if (!isOwner) {
        await reply("nah.");
        return;
      }
    
      const text = interaction.options.getString('message');
    
      await interaction.reply({
        content: '✅ Sent.',
        ephemeral: true
      });
    
      await interaction.channel.send(text);
    
      return;
    }  
      
    case 'direct': {
      if (!isOwner) {
        await reply("nah. You do not have suitable permissions for that.");
        return;
      }
    
      const target = interaction.options.getUser('user');
      const text = interaction.options.getString('message');
    
      try {
        await target.send(text);
    
        await reply(
          `📨 Sent DM to ${target.username}.`,
          true
        );
      } catch {
        await reply(
          `Couldn't send DM to ${target.username}.`,
          true
        );
      }
    
      return;
    }  
case 'welcome': {
  if (!interaction.guild) {
    await reply('This command only works inside a server.');
    return;
  }

  if (!interaction.memberPermissions?.has('Administrator')) {
    await reply('nah. Administrator permission required.');
    return;
  }

  const target = interaction.options.getUser('user');

  if (!target || target.bot) {
    await reply('Pick a real server member, not a bot.');
    return;
  }

  try {
    const result = await sendWelcome(
      interaction.guild,
      target,
      (text) => interaction.channel.send(text)
    );

    if (!result.ok) {
      await reply('Could not welcome that user.');
      return;
    }

    await reply(
      result.dmSent
        ? `🎉 Welcomed **${target.username}** in chat and sent them a DM.`
        : `🎉 Welcomed **${target.username}** in chat, but their DMs appear to be closed.`,
      true
    );
  } catch (err) {
    console.error('Welcome command error:', err);
    await reply('Something went wrong while sending the welcome.');
  }

  return;
}
    case 'announce': {
      if (!isOwner) {
        await reply("nah. ask always_first11 to do it.");
        return;
      }
    
      const channel = interaction.options.getChannel('channel');
      const text = interaction.options.getString('message');
    
      try {
        if (!channel?.isTextBased()) {
          await reply("That isn't a text channel.");
          return;
        }

await channel.send(text);
    
        await reply(
          `📢 Sent message to #${channel.name}`,
          true
        );
      } catch {
        await reply(
          'The message was not sent to the target.',
          true
        );
      }
    
      return;
    }  
    case 'unlock': {
      if (!isOwner) { await reply("nah."); return; }
      privateMode = false;
      await reply('🔓 Private mode OFF. Back to normal.', false);
      return;
    }
    case 'restart': {
      if (!isOwner) { await reply("nah."); return; }
      await reply('Wait Rebooting...', false);
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    case 'mute': {
      if (!isOwner) { await reply("nah."); return; }
      const target = interaction.options.getUser('user');
      if (target.id === OWNER_ID) { await reply("Why you wanna mute yourself lol"); return; }
      if (target.bot) { await reply("not muting a bot."); return; }
      mutedUsers.add(target.id);
      await reply(`🔇 **${target.username}** muted. I will ignore them.`, false);
      return;
    }
    case 'unmute': {
      if (!isOwner) { await reply("nah."); return; }
      const target = interaction.options.getUser('user');
      if (!mutedUsers.has(target.id)) { await reply(`**${target.username}** isn't muted.`); return; }
      mutedUsers.delete(target.id);
      await reply(`🔊 **${target.username}** unmuted.`, false);
      return;
    }
    case 'mutelist': {
      if (!isOwner) { await reply("nah. ask always_first11 for it."); return; }
      if (!mutedUsers.size) { await reply('Nobody is muted right now. Lets mute somebody..'); return; }
      const names = [...mutedUsers].map((id) => {
        const u = client.users.cache.get(id);
        return u ? `**${u.username}** (${id})` : `Unknown (${id})`;
      });
      await reply(`🔇 **Muted users:**\n${names.join('\n')}`);
      return;
    }
    case 'stats': {
      await reply(buildStatsText(), false);
      return;
    }
    case 'help': {
      await reply(buildHelpText(isOwner), true);
      return;
    }
  }
});
// Text command handler (DM + server)
async function handleTextCommand(message, commandText, userPrompt, isDM) {
  const userId  = message.author.id;
  const isOwner = userId === OWNER_ID;
  const send    = (text) => message.reply(text).catch(() => {});

  // stats
  if (commandText === 'stats') {
    await send(buildStatsText());
    return true;
  }

    //start
  if (commandText === 'start') {
    if (!isOwner) {
      await send("nah.");
      return true;
    }
  
    botDisabled = false;
  
    await send("🟢 chotu is active again.");
    return true;
  }
  // help
  if (commandText === 'help') {
    await send(buildHelpText(isOwner));
    return true;
  }

  // leaderboard
  if (commandText === 'leaderboard' || commandText === 'lb') {
    const sorted = [...userMessageCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    if (!sorted.length) { await send("Aaj koi itna phaltu nahi hai"); return true; }
    const rows = sorted.map(([, { name, count }], i) =>
      `${'🥇🥈🥉'.split('')[i] ?? `**${i + 1}.**`} ${name} — **${count}** message${count !== 1 ? 's' : ''}`);
    await send(`**Iss baar ki panchayat : **\n${rows.join('\n')}`);
    return true;
  }
  // welcome
  if (commandText.startsWith('welcome')) {
    if (!message.guild) {
      await send('This command only works inside a server.');
      return true;
    }
  
    if (!message.member?.permissions.has('Administrator')) {
      await send('Ap iss server ke ek naagrik hai , vese hi bartav kare, jyada mat uchle kripaya.');
      return true;
    }
  
    const target = message.mentions.users.first();
  
    if (!target) {
      await send('Usage: `chotu welcome @user`');
      return true;
    }
  
    if (target.bot) {
      await send('Abhi agar bot ka swagat karenge , toh iss server ki unnati kese hogi?');
      return true;
    }
  
    try {
      const result = await sendWelcome(
        message.guild,
        target,
        (text) => message.channel.send(text)
      );
  
      if (!result.ok) {
        await send('Swagat nahi kar paye ham.');
        return true;
      }
  
      await send(
        result.dmSent
          ? `**${target.username}** iss baar hame vote de 🙏 `
          : `🎉 Welcomed **${target.username}** iss gadhe ne DM band kar rakha.`
      );
    } catch (err) {
      console.error('Text welcome error:', err);
      await send('swagat mai kuch kharabi ho gayi');
    }
  
    return true;
  }
  // forget me
  if (commandText === 'forget me') {
    clearHistory(userId);
    await send("Alright so you forgot me ");
    return true;
  }

  // ---- owner-only ----
  if (commandText === 'shutdown' || commandText === 'sd') {
    if (!isOwner) {
      await send("app iss server ke ek samanit nagrik hai. apke pas permission nahi hai");
      return true;
    }
  
    botDisabled = true;
    await send("Lockdown shuru, bhago yahan se");
    return true;
  }

  // unlock (text alias)
  if (commandText === 'unlock') {
    if (!isOwner) { await send("nah."); return true; }
    privateMode = false;
    await send('🔓 Private mode OFF. Back to normal.');
    return true;
  }

  // mute
  if (commandText.startsWith('mute')) {
    if (!isOwner) { await send("App kevel ek nagrik hai"); return true; }
    const target = message.mentions.users.first();
    if (!target) { await send("kisko karna hai mute?"); return true; }
    if (target.id === OWNER_ID) { await send("you can't mute yourself lol"); return true; }
    if (target.bot) { await send("not muting a bot lmao"); return true; }
    mutedUsers.add(target.id);
    await send(`🔇 **${target.username}** ko mute kar diya modi sarkar ne.`);
    return true;
  }

  // unmute
  if (commandText.startsWith('unmute')) {
    if (!isOwner) { await send("App kevel ek nagrik hai"); return true; }
    const target = message.mentions.users.first();
    if (!target) { await send("mention the user to unmute."); return true; }
    if (!mutedUsers.has(target.id)) { await send(`**${target.username}** isn't muted.`); return true; }
    mutedUsers.delete(target.id);
    await send(`🔊 **${target.username}** unmuted.`);
    return true;
  }

  // mutelist
  if (commandText === 'mutelist') {
    if (!isOwner) { await send("nah."); return true; }
    if (!mutedUsers.size) { await send("nobody's muted right now."); return true; }
    const names = [...mutedUsers].map((id) => {
      const u = client.users.cache.get(id);
      return u ? `**${u.username}** (${id})` : `Unknown (${id})`;
    });
    await send(`🔇 **Muted users:**\n${names.join('\n')}`);
    return true;
  }

  // roast
  if (commandText === 'roast') {
    if (!isOwner) { await send("nah that's not for you to use lmao"); return true; }
    const sorted = [...userMessageCounts.entries()]
      .filter(([id]) => id !== OWNER_ID)
      .sort((a, b) => b[1].count - a[1].count);
    if (!sorted.length) { await send("nobody to roast yet."); return true; }
    const [targetId, { name: targetName, count: targetCount }] = sorted[0];
    if (!isDM) await message.channel.sendTyping().catch(() => {});
    const roastReply = await callGroq([{
      role: 'system',
      content: `You are chotu. Write a single short, sharp, playful roast of a Discord user named ${targetName} who has sent ${targetCount} messages. Punchy, funny, not hateful. One paragraph max.`,
    }, { role: 'user', content: `Roast ${targetName}.` }]);
    if (!roastReply) { await send("roast generator broke lol"); return true; }
    await send(isDM ? `Roast for ${targetName}:\n${roastReply}` : `<@${targetId}> ${roastReply}`);
    return true;
  }

  // restart / reboot
  // restart
if (commandText === 'restart' || commandText === 'reboot') {
  if (!isOwner) {
    await send("App kevel ek nagrik hai.");
    return true;
  }

  await send("Abhi fresh hoke ata mai...");

  setTimeout(() => {
    process.exit(0);
  }, 1000);

  return true;
}

  // warn
  if (commandText.startsWith('warn')) {
    if (!isOwner) { await send("App kevel ek nagrik hai."); return true; }
    const target = message.mentions.users.first();
    if (!target) { await send("mention the user to warn. e.g. `warn @user spamming`"); return true; }
    if (target.id === OWNER_ID) { await send("you can't warn yourself lol"); return true; }
    if (target.bot) { await send("not warning a bot lmao"); return true; }
    const reason = commandText.replace(/^warn\s*/i, '').replace(/<@!?\d+>/, '').trim() || 'No reason provided.';
    const serverName = message.guild?.name ?? 'the server';
    try {
      await target.send(
        `⚠️ **Warning from ${serverName}**\n\n` +
        `You have received an official warning.\n\n` +
        `**Reason:** ${reason}\n\n` +
        `Please follow the server rules. Repeated violations may result in further action.`
      );
      await send(`done. warning sent to **${target.username}**.\nReason: *${reason}*`);
    } catch {
      await send(`couldn't DM **${target.username}** — they probably have DMs off.`);
    }
    return true;
  }

  // eval (DM only, owner only)
  if (commandText.startsWith('eval')) {
    if (!isOwner || !isDM) {
      if (!isOwner) await send("nahi , ye vese bhi kaam nahi karta 😂");
      else await send("eval only works in DMs. Jo bhi nahi kar raha 😂");
      return true;
    }
    const code = userPrompt.replace(/^(chotu\s+)?eval\s*/i, '');
    try {
      // eslint-disable-next-line no-eval
      let result = eval(code);
      if (result instanceof Promise) result = await result;
      const output = String(result ?? 'undefined');
      await send(`\`\`\`js\n${output.slice(0, 1900)}\n\`\`\``);
    } catch (err) {
      await send(`\`\`\`\nError: ${err.message}\n\`\`\``);
    }
    return true;
  }

  return false; // not a command
}
// AI response helper
async function sendAIReply(message, userPrompt, isDM) {
  const userId     = message.author.id;
  const senderName = message.member?.displayName ?? message.author.username;

  if (!isDM) await message.channel.sendTyping().catch(() => {});
  else       await message.channel.sendTyping().catch(() => {});

  const resolvedPrompt   = isDM ? userPrompt : await resolveMentions(userPrompt, message.guild);
  const contextualPrompt = `[${senderName}]: ${resolvedPrompt}`;

  activeUsers.add(userId);
  const prev = userMessageCounts.get(userId) ?? { name: senderName, count: 0 };
  userMessageCounts.set(userId, { name: senderName, count: prev.count + 1 });
  pushHistory(userId, 'user', contextualPrompt);

  const inviterName  = isDM ? null : (guildInviters.get(message.guild?.id) ?? null);
  const serverName   = isDM ? null : (message.guild?.name ?? null);
  const systemPrompt = buildSystemPrompt(inviterName, serverName);

  const reply = await callGroq([{ role: 'system', content: systemPrompt }, ...getHistory(userId)]);
  if (!reply) { await message.reply("overloaded rn, try again in a sec.").catch(() => {}); return; }
  pushHistory(userId, 'assistant', reply);

  const chunks = reply.length > 2000 ? reply.match(/[\s\S]{1,2000}/g) : [reply];
  for (const chunk of chunks) await message.reply(chunk).catch(() => {});
}

// Bot events
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands(client.application.id);
  for (const guild of client.guilds.cache.values()) {
    const inviter = await fetchInviter(guild);
    if (inviter) {
      guildInviters.set(guild.id, inviter.displayName ?? inviter.username);
      console.log(`📋 ${guild.name}: added by ${inviter.username}`);
    }
  }
});

client.on('guildCreate', async (guild) => {
  const inviter = await fetchInviter(guild);
  if (inviter) {
    guildInviters.set(guild.id, inviter.displayName ?? inviter.username);
    console.log(`📋 Joined ${guild.name}: added by ${inviter.username}`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const userId  = message.author.id;
  const isDM    = message.channel.type === ChannelType.DM;
  const isOwner = userId === OWNER_ID;

  // ---- DM handling ----
  if (isDM) {
    // Ignore all DMs except owner's
    if (!isOwner) return;

    if (isOnCooldown(userId)) return;
    setCooldown(userId);

    const userPrompt  = message.content.trim();
    const promptLower = userPrompt.toLowerCase();
    const commandText = promptLower.replace(/^chotu\s*/i, '').trim();

    const wasCommand = await handleTextCommand(message, commandText, userPrompt, true);
    if (wasCommand) return;

    if (!userPrompt) return;
    try {
      await sendAIReply(message, userPrompt, true);
    } catch (err) {
      console.error('DM error:', err);
      await message.reply("something broke, try again.").catch(() => {});
    }
    return;
  }

  // ---- Server handling ----
  // In private mode, ignore all server messages
  if (privateMode) return;

  const wasMentioned = message.mentions.has(client.user);
  const containsChotu = /\b(?:chotu|modi\s*ji|chai\s*wale)\b/i.test(message.content);
  if (!wasMentioned && !containschotu) return;

  // Ignore muted users silently
  if (mutedUsers.has(userId)) return;

  if (isOnCooldown(userId)) return;
  setCooldown(userId);

  let userPrompt = message.content;
  if (wasMentioned) userPrompt = userPrompt.replace(`<@${client.user.id}>`, '').trim();

  const promptLower = userPrompt.toLowerCase();
  const commandText = promptLower.replace(/^chotu\s*/i, '').trim();

  const wasCommand = await handleTextCommand(message, commandText, userPrompt, false);
  if (wasCommand) return;

  if (!userPrompt) { await message.reply('yeah? 👀').catch(() => {}); return; }

  try {
    await sendAIReply(message, userPrompt, false);
  } catch (err) {
    console.error('Server message error:', err);
    await message.reply("something broke, try again in a bit.").catch(() => {});
  }
});

// --- Keep alive ---
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:', err));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  if (err.message?.includes('disallowed intents'))
    console.error('❌ Enable Message Content Intent in Discord Developer Portal.');
  else
    console.error('❌ Login failed:', err.message);
  process.exit(1);
});
