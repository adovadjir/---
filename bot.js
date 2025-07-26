// لا داعي لاستدعاء dotenv على Railway، لكنه يفيد محلياً
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { NodeVM } = require('vm2');
const os = require('os');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// قراءة المتغيرات من بيئة التشغيل
const {
  DISCORD_TOKEN,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_FILE = 'data/users.json',
  GEMINI_API_KEY,
  BOT_OWNER_ID
} = process.env;

// تحقق من وجود التوكن قبل الإقلاع
if (!DISCORD_TOKEN || typeof DISCORD_TOKEN !== 'string') {
  console.error('❌ DISCORD_TOKEN is missing or invalid. Please set it in Railway Variables.');
  process.exit(1);
}

const TMP = os.tmpdir();
let dataCache = { users: {}, servers: {}, tickets: {}, settings: {} };
let githubSha = null;

// تحميل البيانات من GitHub
async function loadData() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    const file = await axios.get(res.data.download_url);
    dataCache = JSON.parse(file.data);
    githubSha = res.data.sha;
  } catch {
    dataCache = { users: {}, servers: {}, tickets: {}, settings: {} };
  }
}

// حفظ البيانات إلى GitHub
async function saveData() {
  try {
    const content = Buffer.from(JSON.stringify(dataCache, null, 2)).toString('base64');
    const res = await axios.put(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { message: 'update data', content, sha: githubSha },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    githubSha = res.data.content.sha;
  } catch (e) {
    console.error('Save data failed:', e.message);
  }
}

// مناداة Gemini API
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

// تحليل ملف مرفق
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

// صلاحيات الأوامر
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

// تشغيل البوت
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await loadData();
});

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.content.startsWith('!')) return;

  const args = msg.content.slice(1).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  const userId = msg.author.id;
  const guildId = msg.guild?.id;
  const member = msg.member;

  // تهيئة البيانات إن لم توجد
  dataCache.users[userId] ||= { balance: 0, history: [] };
  dataCache.servers[guildId] ||= {
    sensitive: { all: false, allowed: [] },
    general: { all: true, allowed: [] },
    channels: {}
  };
  dataCache.settings[guildId] ||= {};

  const userData = dataCache.users[userId];
  const serverData = dataCache.servers[guildId];

  try {
    switch (cmd) {
      case 'رصيدي':
        return msg.reply(`رصيدك: ${userData.balance}`);
      case 'اضف':
        if (userId !== BOT_OWNER_ID) return msg.reply('غير مخول');
        const mention = msg.mentions.users.first();
        const amount = parseInt(args[1]);
        if (!mention || isNaN(amount) || amount <= 0) return msg.reply('الاستخدام: !اضف @user amount');
        dataCache.users[mention.id] ||= { balance: 0, history: [] };
        dataCache.users[mention.id].balance += amount;
        await saveData();
        return msg.reply(`تم إضافة ${amount} إلى ${mention.tag}`);
      case 'حول':
        const to = msg.mentions.users.first();
        const amt = parseInt(args[1]);
        if (!to || isNaN(amt) || amt <= 0) return msg.reply('الاستخدام: !حول @user amount');
        if (userData.balance < amt) return msg.reply('رصيدك غير كافي');
        dataCache.users[to.id] ||= { balance: 0, history: [] };
        userData.balance -= amt;
        dataCache.users[to.id].balance += amt;
        await saveData();
        return msg.reply(`تم تحويل ${amt} إلى ${to.tag}`);
      case 'gemini':
        if (!args.length) return msg.reply('اكتب سؤالك بعد الأمر');
        userData.history.push(args.join(' '));
        if (userData.history.length > 20) userData.history.shift();
        const response = await callGemini(userData.history.join('\n'));
        await msg.reply(response);
        await saveData();
        return;
      case 'ملف':
        if (!msg.attachments.size) return msg.reply('أرفق الملف أولاً');
        return analyzeFile(msg.attachments.first(), msg);
      case 'شغلاداة':
        if (userId !== BOT_OWNER_ID) return msg.reply('غير مخول');
        if (!args.length) return msg.reply('ضع كود للتنفيذ');
        try {
          const vm = new NodeVM({ timeout: 5000, sandbox: { client, msg, dataCache } });
          const result = await vm.run(`module.exports = async () => { ${args.join(' ')} }`)();
          return msg.reply(`النتيجة: ${result}`);
        } catch (e) {
          return msg.reply(`خطأ بالتنفيذ: ${e.message}`);
        }
      default:
        if (!canGeneral(serverData, userId)) return;
        return msg.reply('أمر غير معروف');
    }
  } catch (e) {
    console.error(`Command ${cmd} failed:`, e);
    msg.reply('حدث خطأ أثناء تنفيذ الأمر.');
  }
});

// وأخيراً تسجيل الدخول
client.login(DISCORD_TOKEN);
