if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NodeVM } = require('vm2');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// تحميل المتغيرات البيئية من ملف .env
const {
  DISCORD,          // توكن بوت ديسكورد
  GITHUB_TOKEN,     // توكن GitHub (اختياري للحفظ على مستودع)
  GITHUB_REPO,      // اسم مستودع GitHub (اختياري)
  GITHUB_FILE = 'data/users.json',  // ملف البيانات على GitHub
  BOT_OWNER_ID,     // ID المالك الذي يمكنه صلاحيات خاصة
  AI_API_KEY        // مفتاح API للنموذج الذكي
} = process.env;

// التأكد من وجود التوكنات المطلوبة
if (!DISCORD || typeof DISCORD !== 'string') {
  console.error('❌ DISCORD token is missing or invalid.');
  process.exit(1);
}

if (!AI_API_KEY || typeof AI_API_KEY !== 'string') {
  console.error('❌ AI_API_KEY is missing or invalid.');
  process.exit(1);
}

// مجلد تخزين مؤقت للملفات المؤقتة
const TMP = os.tmpdir();

// ذاكرة مؤقتة لتخزين بيانات المستخدمين والسيرفرات والتذاكر
let dataCache = { users: {}, servers: {}, tickets: {}, settings: {} };
let githubSha = null;

// تحميل البيانات من GitHub (اختياري)
async function loadData() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    const file = await axios.get(res.data.download_url);
    dataCache = JSON.parse(file.data);
    githubSha = res.data.sha;
    console.log('✅ Data loaded from GitHub.');
  } catch (e) {
    console.warn('⚠️ Failed to load data, initializing empty cache.');
    dataCache = { users: {}, servers: {}, tickets: {}, settings: {} };
  }
}

// حفظ البيانات إلى GitHub (اختياري)
async function saveData() {
  try {
    const content = Buffer.from(JSON.stringify(dataCache, null, 2)).toString('base64');
    const res = await axios.put(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { message: 'update data', content, sha: githubSha },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    githubSha = res.data.content.sha;
    console.log('✅ Data saved to GitHub.');
  } catch (e) {
    console.error('❌ Save data failed:', e.message);
  }
}

// دالة لاستدعاء نموذج الذكاء الاصطناعي عبر OpenRouter API
async function callAI(prompt) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1500
      },
      {
        headers: {
          'Authorization': `Bearer ${AI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return res.data?.choices?.[0]?.message?.content || 'No response';
  } catch (e) {
    console.error('❌ AI request failed:', e.response?.data || e.message);
    return 'حدث خطأ أثناء الاتصال بالنموذج.';
  }
}

// دالة لتحليل الملفات المرفقة (نصوص وصور)
async function analyzeFile(att, msg) {
  const filePath = path.join(TMP, `${Date.now()}_${att.name}`);
  try {
    const res = await axios.get(att.url, { responseType: 'arraybuffer' });
    fs.writeFileSync(filePath, res.data);
    const ext = path.extname(att.name).toLowerCase();
    let result = '';
    if (['.txt', '.json', '.js', '.py', '.md'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf8');
      result = await callAI(`قم بتحليل هذا النص البرمجي أو المحتوى:\n${content}`);
    } else if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
      result = await callAI('وصف دقيق لهذه الصورة.');
    } else {
      result = 'نوع الملف غير مدعوم للتحليل.';
    }
    await msg.reply(result);
  } catch (e) {
    console.error('❌ File analysis error:', e.message);
    await msg.reply('حدث خطأ أثناء تحليل الملف.');
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// صلاحيات الأوامر الخاصة (مثلاً أوامر المالك)
function canSensitive(serverData, userId, member) {
  return (
    serverData.sensitive?.all ||
    serverData.sensitive?.allowed?.includes(userId) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

// صلاحيات الأوامر العامة
function canGeneral(serverData, userId) {
  return serverData.general?.all || serverData.general?.allowed?.includes(userId);
}

// لتسجيل تنفيذ الأوامر لغرض التتبع
function logCommandExecution(cmd, userId) {
  const time = new Date().toLocaleString();
  console.log(`[${time}] User ${userId} executed command: ${cmd}`);
}

// عند تشغيل البوت
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await loadData();
});

// استقبال الرسائل ومعالجتها
client.on('messageCreate', async msg => {
  try {
    if (msg.author.bot || !msg.content.startsWith('!')) return;

    const args = msg.content.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const userId = msg.author.id;
    const guildId = msg.guild?.id || 'dm';

    // تهيئة بيانات المستخدم والسيرفر إذا لم تكن موجودة
    dataCache.users[userId] ||= { balance: 0, history: [] };
    dataCache.servers[guildId] ||= {
      sensitive: { all: false, allowed: [] },
      general: { all: true, allowed: [] },
      channels: {}
    };
    dataCache.settings[guildId] ||= {};

    const userData = dataCache.users[userId];
    const serverData = dataCache.servers[guildId];
    const member = msg.member;

    logCommandExecution(cmd, userId);

    switch (cmd) {
      case 'رصيدي':
        // يعرض رصيد المستخدم الحالي
        return msg.reply(`رصيدك الحالي: ${userData.balance} نقطة.`);

      case 'اضف':
        // إضافة نقاط لمستخدم (للمالك فقط)
        if (userId !== BOT_OWNER_ID) return msg.reply('❌ أنت غير مخول لاستخدام هذا الأمر.');
        if (args.length < 2) return msg.reply('الاستخدام: !اضف @user عدد');
        const mention = msg.mentions.users.first();
        const amount = parseInt(args[1]);
        if (!mention || isNaN(amount) || amount <= 0) return msg.reply('يرجى ذكر مستخدم صالح وكمية صحيحة.');
        dataCache.users[mention.id] ||= { balance: 0, history: [] };
        dataCache.users[mention.id].balance += amount;
        await saveData();
        return msg.reply(`✅ تم إضافة ${amount} نقطة إلى ${mention.tag}.`);

      case 'حول':
        // تحويل نقاط بين المستخدمين
        if (args.length < 2) return msg.reply('الاستخدام: !حول @user عدد');
        const to = msg.mentions.users.first();
        const amt = parseInt(args[1]);
        if (!to || isNaN(amt) || amt <= 0) return msg.reply('يرجى ذكر مستخدم صالح وكمية صحيحة.');
        if (userData.balance < amt) return msg.reply('رصيدك غير كافٍ.');
        dataCache.users[to.id] ||= { balance: 0, history: [] };
        userData.balance -= amt;
        dataCache.users[to.id].balance += amt;
        await saveData();
        return msg.reply(`✅ تم تحويل ${amt} نقطة إلى ${to.tag}.`);

      case 'ai':
        // التحدث مع نموذج AI أو طلب إنشاء/تعديل أكواد
        if (!args.length) return msg.reply('يرجى كتابة سؤالك بعد الأمر.');
        const prompt = args.join(' ');
        userData.history.push(prompt);
        if (userData.history.length > 20) userData.history.shift();

        // كشف نية توليد كود (إنشاء/تعديل)
        const codeIntent = /^(.*(?:أنشئ|اصنع|أضف|اضافة|كود|أمر جديد).*)$/i.test(prompt);

        if (codeIntent) {
          // بناء طلب مخصص لتوليد الكود فقط (لتفادي الشرح المرافق)
          const devPrompt = `
لدي بوت ديسكورد مبني بـ discord.js. هذا هو الكود الحالي:
"""
${fs.readFileSync(__filename, 'utf8').slice(0, 8000)}
"""
الطلب: ${prompt}
أريدك أن تُنشئ فقط الكود الجديد اللازم (بلغة JavaScript) لتنفيذ هذا الطلب،
على شكل وحدة module.exports تصلح للتنفيذ في NodeVM داخل البوت. بدون شرح، فقط الكود.
`;

          const generatedCode = await callAI(devPrompt);

          if (!/module\.exports\s*=/.test(generatedCode)) {
            return msg.reply('⚠️ لم أتمكن من توليد كود صالح.');
          }

          // تنفيذ الكود داخل بيئة آمنة (NodeVM) لمنع الأخطاء أو الأضرار
          try {
            const vm = new NodeVM({ timeout: 5000, sandbox: { client, msg, dataCache, console } });
            const result = await vm.run(generatedCode)();
            await msg.reply(`✅ الكود تم تنفيذه بنجاح:\n${result ?? 'تم التنفيذ.'}`);
          } catch (e) {
            await msg.reply(`❌ فشل تنفيذ الكود:\n${e.message}`);
          }

          await saveData();
          return;
        }

        // طلب عادي للنموذج (ردود عامة)
        const response = await callAI(userData.history.join('\n'));
        await msg.reply(response);
        await saveData();
        return;

      case 'ملف':
        // تحليل الملفات المرفقة (يدعم النصوص والصور)
        if (!msg.attachments.size) return msg.reply('يرجى إرفاق ملف أولاً.');
        return analyzeFile(msg.attachments.first(), msg);

      case 'شغلاداة':
        // تنفيذ كود يدوي داخل بيئة آمنة (للمالك فقط)
        if (userId !== BOT_OWNER_ID) return msg.reply('❌ أنت غير مخول لاستخدام هذا الأمر.');
        if (!args.length) return msg.reply('يرجى كتابة كود للتنفيذ.');
        try {
          const vm = new NodeVM({ timeout: 5000, sandbox: { client, msg, dataCache } });
          const result = await vm.run(`module.exports = async () => { ${args.join(' ')} }`)();
          return msg.reply(`🔧 النتيجة: ${result}`);
        } catch (e) {
          return msg.reply(`❌ خطأ بالتنفيذ: ${e.message}`);
        }

      case 'تذاكر':
        // نظام إدارة التذاكر البسيط
        if (!serverData.tickets) serverData.tickets = {};
        if (!args.length) return msg.reply('اكتب: !تذاكر انشاء | !تذاكر اغلاق | !تذاكر الحالة');
        switch (args[0]) {
          case 'انشاء':
            if (serverData.tickets[userId]) return msg.reply('لديك تذكرة مفتوحة بالفعل.');
            const channel = await msg.guild.channels.create({
              name: `ticket-${msg.author.username}`,
              type: 0, // قناة نصية
              permissionOverwrites: [
                { id: msg.guild.roles.everyone.id, deny: ['ViewChannel'] },
                { id: userId, allow: ['ViewChannel', 'SendMessages'] }
              ]
            });
            serverData.tickets[userId] = channel.id;
            await saveData();
            return msg.reply(`تم إنشاء تذكرتك في القناة: <#${channel.id}>`);
          case 'اغلاق':
            if (!serverData.tickets[userId]) return msg.reply('ليس لديك تذكرة مفتوحة.');
            const chId = serverData.tickets[userId];
            const ticketChannel = msg.guild.channels.cache.get(chId);
            if (ticketChannel) await ticketChannel.delete();
            delete serverData.tickets[userId];
            await saveData();
            return msg.reply('تم إغلاق تذكرتك.');
          case 'الحالة':
            return msg.reply(
              serverData.tickets[userId]
                ? `تذكرتك مفتوحة في القناة: <#${serverData.tickets[userId]}>`
                : 'ليس لديك تذكرة مفتوحة.'
            );
          default:
            return msg.reply('الأوامر المتاحة: انشاء، اغلاق، الحالة');
        }

      case 'مساعدة':
        // قائمة الأوامر الأساسية
        return msg.reply(
          '🛠️ **أوامر البوت:**\n' +
          '!رصيدي - عرض رصيدك من النقاط\n' +
          '!اضف @user عدد - إضافة نقاط (للمالك فقط)\n' +
          '!حول @user عدد - تحويل نقاط لمستخدم آخر\n' +
          '!ai نص - تحدث مع الذكاء الاصطناعي أو اطلب إضافة/تعديل كود\n' +
          '!ملف + إرفاق ملف - تحليل ملف\n' +
          '!شغلاداة كود - تنفيذ كود (للمالك فقط)\n' +
          '!تذاكر انشاء/اغلاق/الحالة - إدارة التذاكر\n' +
          '!مساعدة - عرض هذه الرسالة'
        );

      default:
        // رد على أمر غير معروف مع التحقق من صلاحية الاستخدام
        if (!canGeneral(serverData, userId)) return;
        return msg.reply('❓ أمر غير معروف، اكتب !مساعدة لمعرفة الأوامر.');
    }
  } catch (e) {
    console.error(`❌ Command error:`, e);
    msg.reply('حدث خطأ أثناء تنفيذ الأمر.');
  }
});

// تسجيل الدخول إلى ديسكورد باستخدام التوكن
client.login(DISCORD);
