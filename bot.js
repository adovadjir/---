require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { NodeVM } = require('vm2');
const os = require('os');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const {
  DISCORD_TOKEN,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_FILE = 'data/users.json',
  GEMINI_API_KEY,
  BOT_OWNER_ID
} = process.env;

const TMP = os.tmpdir();
let dataCache = { users: {}, servers: {}, tickets: {}, settings: {} };
let githubSha = null;

async function loadData() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    const file = await axios.get(res.data.download_url);
    dataCache = JSON.parse(file.data);
    githubSha = res.data.sha;
  } catch {
    dataCache = { users: {}, servers: {}, tickets: {}, settings: {} };
  }
}

async function saveData() {
  try {
    const content = Buffer.from(JSON.stringify(dataCache, null, 2)).toString('base64');
    const res = await axios.put(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { message: 'update data', content, sha: githubSha },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    githubSha = res.data.content.sha;
  } catch (e) {
    console.error('Save data failed:', e.message);
  }
}

async function callGemini(prompt) {
  try {
    const res = await axios.post(
      'https://api.gemini.example.com/v1/chat',
      { prompt },
      { headers: { Authorization: `Bearer ${GEMINI_API_KEY}` } }
    );
    return res.data?.choices?.[0]?.message?.content || 'No response';
  } catch {
    return 'Gemini connection error';
  }
}

async function analyzeFile(att, msg) {
  const filePath = path.join(TMP, `${Date.now()}_${att.name}`);
  try {
    const res = await axios.get(att.url, { responseType: 'arraybuffer' });
    fs.writeFileSync(filePath, res.data);
    const ext = path.extname(att.name).toLowerCase();
    let result = '';
    if (['.txt', '.json'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf8');
      result = await callGemini(`Analyze this text:\n${content}`);
    } else if (['.jpg', '.png', '.gif'].includes(ext)) {
      result = await callGemini('Describe this image in detail.');
    } else {
      result = 'Unsupported file type';
    }
    await msg.reply(result);
  } catch {
    await msg.reply('File analysis error');
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

function canSensitive(s, u, m) {
  return (
    s.sensitive?.all ||
    s.sensitive?.allowed?.includes(u) ||
    m.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

function canGeneral(s, u) {
  return s.general?.all || s.general?.allowed?.includes(u);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadData();
});

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.content.startsWith('!')) return;
  const args = msg.content.slice(1).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  const userId = msg.author.id;
  const guildId = msg.guild?.id;
  const member = msg.member;

  if (!dataCache.users[userId]) dataCache.users[userId] = { balance: 0, history: [] };
  if (!dataCache.servers[guildId]) dataCache.servers[guildId] = {
    sensitive: { all: false, allowed: [] },
    general: { all: true, allowed: [] },
    channels: {}
  };
  if (!dataCache.settings[guildId]) dataCache.settings[guildId] = {};

  const userData = dataCache.users[userId];
  const serverData = dataCache.servers[guildId];

  switch (cmd) {
    case 'رصيدي':
      return msg.reply(`Your balance: ${userData.balance}`);
    case 'اضف':
      if (userId !== BOT_OWNER_ID) return msg.reply('Not allowed');
      const mention = msg.mentions.users.first();
      const amount = parseInt(args[1]);
      if (!mention || isNaN(amount) || amount <= 0) return msg.reply('Usage: !اضف @user amount');
      if (!dataCache.users[mention.id]) dataCache.users[mention.id] = { balance: 0, history: [] };
      dataCache.users[mention.id].balance += amount;
      await saveData();
      return msg.reply(`Added ${amount} to ${mention.tag}`);
    case 'حول':
      const to = msg.mentions.users.first();
      const amt = parseInt(args[1]);
      if (!to || isNaN(amt) || amt <= 0) return msg.reply('Usage: !حول @user amount');
      if (userData.balance < amt) return msg.reply('Insufficient');
      if (!dataCache.users[to.id]) dataCache.users[to.id] = { balance: 0, history: [] };
      userData.balance -= amt;
      dataCache.users[to.id].balance += amt;
      await saveData();
      return msg.reply(`Transferred ${amt} to ${to.tag}`);
    case 'gemini':
      if (!args.length) return msg.reply('Send a query');
      userData.history.push(args.join(' '));
      if (userData.history.length > 20) userData.history.shift();
      const response = await callGemini(userData.history.join('\n'));
      await msg.reply(response);
      await saveData();
      return;
    case 'ملف':
      if (!msg.attachments.size) return msg.reply('Attach a file');
      return analyzeFile(msg.attachments.first(), msg);
    case 'شغلاداة':
      if (userId !== BOT_OWNER_ID) return msg.reply('Not allowed');
      if (!args.length) return msg.reply('Provide code');
      try {
        const vm = new NodeVM({ timeout: 5000, sandbox: { client, msg, dataCache } });
        const result = vm.run(`module.exports = async () => { ${args.join(' ')} }`)();
        const out = await result;
        return msg.reply(`Result: ${out}`);
      } catch (e) {
        return msg.reply(`Error: ${e.message}`);
      }
    default:
      if (!canGeneral(serverData, userId)) return;
      return msg.reply('Unknown command');
  }
  await saveData();
});

client.login(DISCORD_TOKEN);
