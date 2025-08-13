import discord
from discord.ext import commands
import random
import asyncio
import aiohttp
import csv
import os
import datetime
import json
import time

# --- إعدادات البوت ---
TOKEN = 'YOUR_BOT_TOKEN_HERE'  # استبدل بتوكن البوت الخاص بك
TARGET_USER_ID = 1389542183320682556  # ID حسابك

# إعدادات التحقق
REQUEST_DELAY = 1.2  # تأخير بين الطلبات (ثواني)
MAX_CHECKS = 3000    # الحد الأقصى للتحقق
BATCH_SIZE = 30      # حجم الدفعة للتحقق

# أنواع الرموز
LETTERS = "abcdefghijklmnopqrstuvwxyz"
NUMBERS = "0123456789"
SEPARATORS = "_."

# قوالب توليد الأسماء
TEMPLATES = [
    'LSLN', 'NSNL', 'NLSN', 'LN.L', 'SLLL',
    'LLSL', 'NLLS', 'LNSL', 'SLNL', 'LLLS', 'N.SL'
]

# --- نظام التخزين المتقدم ---
STORAGE_FILE = "bot_data.json"
BOT_DATA = {
    "usernames": [],        # الأسماء المحفوظة
    "history": [],          # سجل البحث
    "checked_names": {},    # الأسماء التي تم التحقق منها {اسم: (متاح, وقت التحقق)}
    "rate_limit": 0         # وقت آخر طلب لتجنب الحظر
}

def load_data():
    """تحميل البيانات من ملف التخزين"""
    global BOT_DATA
    if os.path.exists(STORAGE_FILE):
        try:
            with open(STORAGE_FILE, 'r') as f:
                BOT_DATA = json.load(f)
        except:
            pass  # الحفاظ على البيانات الافتراضية في حالة الخطأ

def save_data():
    """حفظ البيانات إلى ملف التخزين"""
    with open(STORAGE_FILE, 'w') as f:
        json.dump(BOT_DATA, f, indent=2)

# --- وظائف مساعدة ---
def is_valid(username: str) -> bool:
    """التحقق من صحة اسم المستخدم"""
    if len(username) != 4:
        return False
    
    for char in username:
        if char not in LETTERS + NUMBERS + SEPARATORS:
            return False
    
    if ".." in username:
        return False
    
    if username.startswith('.') or username.endswith('.'):
        return False
    
    return True

def generate_username(template: str) -> str:
    """توليد اسم مستخدم بناءً على قالب"""
    username = []
    for char_type in template:
        if char_type == 'L':
            username.append(random.choice(LETTERS))
        elif char_type == 'N':
            username.append(random.choice(NUMBERS))
        elif char_type == 'S':
            username.append(random.choice(SEPARATORS))
    return ''.join(username)

async def check_username_availability(session, username):
    """التحقق من توفر اسم المستخدم باستخدام واجهة ديسكورد الرسمية"""
    # إذا كان الاسم قد تم التحقق منه مؤخرًا، نستخدم النتيجة المخزنة
    if username in BOT_DATA["checked_names"]:
        last_check = BOT_DATA["checked_names"][username]["timestamp"]
        if time.time() - last_check < 86400:  # 24 ساعة
            return BOT_DATA["checked_names"][username]["available"]
    
    headers = {
        "Authorization": f"Bot {TOKEN}",
        "User-Agent": "DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)",
        "Content-Type": "application/json"
    }
    
    try:
        # طريقة التحقق الأولى: عبر نقطة نهاية الأسماء
        async with session.get(
            f"https://discord.com/api/v9/users/@usernames/{username}",
            headers=headers
        ) as response:
            if response.status == 404:
                # التحقق الإضافي للتأكد من النتيجة
                async with session.get(
                    f"https://discord.com/api/v9/users/{username}",
                    headers=headers
                ) as response2:
                    if response2.status == 404:
                        BOT_DATA["checked_names"][username] = {
                            "available": True,
                            "timestamp": time.time()
                        }
                        return True
                    return False
            
            if response.status == 200:
                BOT_DATA["checked_names"][username] = {
                    "available": False,
                    "timestamp": time.time()
                }
                return False
            
            # في حالة وجود خطأ أو حدود طلبات، نستخدم طريقة بديلة
            async with session.get(
                f"https://discord.com/api/v9/users/{username}",
                headers=headers
            ) as response_alt:
                if response_alt.status == 404:
                    BOT_DATA["checked_names"][username] = {
                        "available": True,
                        "timestamp": time.time()
                    }
                    return True
                return False
                
    except Exception as e:
        print(f"خطأ في التحقق من {username}: {e}")
        return False

    return False

def template_description(template):
    """وصف القوالب"""
    descriptions = {
        'LSLN': "حرف فاصل حرف رقم (مثل: d_o1)",
        'NSNL': "رقم فاصل رقم حرف (مثل: 5_7d)",
        'NLSN': "رقم حرف فاصل رقم (مثل: 2w_3)",
        'LN.L': "حرف رقم . حرف (مثل: g0.s)",
        'SLLL': "فاصل حرف حرف حرف (مثل: _xfb)",
        'LLSL': "حرف حرف فاصل حرف (مثل: ab_c)",
        'NLLS': "رقم حرف حرف فاصل (مثل: 1ab_)",
        'LNSL': "حرف رقم فاصل حرف (مثل: a1_b)",
        'SLNL': "فاصل حرف رقم حرف (مثل: _a1b)",
        'LLLS': "حرف حرف حرف فاصل (مثل: abc_)",
        'N.SL': "رقم . حرف حرف (مثل: 9.du)"
    }
    return descriptions.get(template, "لا يوجد وصف")

# --- إعدادات بوت ديسكورد ---
intents = discord.Intents.default()
intents.message_content = True
intents.dm_messages = True

bot = commands.Bot(
    command_prefix='!',
    intents=intents,
    help_command=None
)

# --- أحداث البوت ---
@bot.event
async def on_ready():
    print(f'✅ تم تسجيل دخول البوت باسم: {bot.user}')
    await bot.change_presence(activity=discord.Game(name="أرسل !help في الخاص"))
    load_data()
    print('✅ تم تحميل البيانات بنجاح')

@bot.event
async def on_message(message):
    if message.author == bot.user:
        return
    
    if isinstance(message.channel, discord.DMChannel):
        if message.author.id == TARGET_USER_ID:
            await bot.process_commands(message)
        else:
            await message.channel.send("⛔ ليس لديك إذن لاستخدام هذا البوت")
    else:
        return

# --- أوامر البوت ---
@bot.command()
async def help(ctx):
    """عرض رسالة المساعدة"""
    embed = discord.Embed(
        title="🆘 مساعدة بوت البحث عن أسماء ديسكورد",
        description="أوامر البوت المتاحة:",
        color=0x2ecc71
    )
    
    commands_list = [
        ("!find [عدد]", "يبحث عن أسماء رباعية متاحة (افتراضي 10)"),
        ("!stats", "يعرض إحصائيات البوت"),
        ("!templates", "يعرض القوالب المستخدمة"),
        ("!saved", "يعرض الأسماء المحفوظة"),
        ("!save", "يحفظ آخر نتيجة بحث"),
        ("!export", "يصدر الأسماء المحفوظة كملف CSV"),
        ("!clear", "يمسح جميع الأسماء المحفوظة"),
        ("!ping", "يفحص استجابة البوت"),
        ("!cache", "يعرض حالة الذاكرة المؤقتة")
    ]
    
    for cmd, desc in commands_list:
        embed.add_field(name=cmd, value=desc, inline=False)
    
    await ctx.send(embed=embed)

@bot.command()
async def ping(ctx):
    """فحص استجابة البوت"""
    latency = round(bot.latency * 1000, 2)
    await ctx.send(f"🏓 البوت يعمل! الاستجابة: {latency}ms")

@bot.command()
async def stats(ctx):
    """عرض إحصائيات البوت"""
    embed = discord.Embed(title="📊 إحصائيات البوت", color=0x3498db)
    
    # إحصائيات بسيطة
    total_checks = len(BOT_DATA["checked_names"])
    total_found = len([v for v in BOT_DATA["checked_names"].values() if v["available"]])
    saved_count = len(BOT_DATA["usernames"])
    
    embed.add_field(name="🔍 عمليات التحقق", value=f"{total_checks}", inline=True)
    embed.add_field(name="✅ أسماء متاحة", value=f"{total_found}", inline=True)
    embed.add_field(name="💾 أسماء محفوظة", value=f"{saved_count}", inline=True)
    
    if BOT_DATA.get('history'):
        last_run = BOT_DATA['history'][-1]['timestamp']
        embed.add_field(name="⏱ آخر تشغيل", value=last_run, inline=False)
    
    await ctx.send(embed=embed)

@bot.command()
async def cache(ctx):
    """عرض حالة الذاكرة المؤقتة"""
    cache_size = len(BOT_DATA["checked_names"])
    available_count = len([v for v in BOT_DATA["checked_names"].values() if v["available"]])
    taken_count = cache_size - available_count
    
    embed = discord.Embed(title="📦 الذاكرة المؤقتة", color=0x9b59b6)
    embed.add_field(name="عدد الأسماء المخزنة", value=f"{cache_size}", inline=False)
    embed.add_field(name="أسماء متاحة", value=f"{available_count}", inline=True)
    embed.add_field(name="أسماء مستخدمة", value=f"{taken_count}", inline=True)
    
    # عرض بعض الأمثلة
    if cache_size > 0:
        examples = list(BOT_DATA["checked_names"].keys())[:5]
        embed.add_field(name="أمثلة", value="\n".join([f"• `{name}`" for name in examples]), inline=False)
    
    await ctx.send(embed=embed)

@bot.command()
async def templates(ctx):
    """عرض القوالب المستخدمة"""
    templates_str = "\n".join([f"• {t} - {template_description(t)}" for t in TEMPLATES])
    
    embed = discord.Embed(
        title="📋 قوالب توليد الأسماء",
        color=0x9b59b6
    )
    
    embed.add_field(name="القوالب المستخدمة", value=templates_str, inline=False)
    await ctx.send(embed=embed)

@bot.command()
async def saved(ctx):
    """عرض الأسماء المحفوظة"""
    saved_usernames = BOT_DATA.get('usernames', [])
    
    if not saved_usernames:
        await ctx.send("❌ لا توجد أسماء محفوظة")
        return
    
    embed = discord.Embed(
        title="💾 الأسماء المحفوظة",
        description=f"عدد الأسماء: {len(saved_usernames)}",
        color=0x1abc9c
    )
    
    names_list = "\n".join([f"• `{name}`" for name in saved_usernames[:10]])
    if len(saved_usernames) > 10:
        names_list += f"\n\n+ {len(saved_usernames) - 10} أسماء أخرى..."
    
    embed.add_field(name="الأسماء", value=names_list, inline=False)
    embed.set_footer(text="استخدم !export لتصدير جميع الأسماء")
    await ctx.send(embed=embed)

@bot.command()
async def save(ctx):
    """حفظ نتائج البحث الأخيرة"""
    if 'last_result' not in BOT_DATA or not BOT_DATA['last_result']:
        await ctx.send("❌ لا توجد نتيجة بحث حديثة للحفظ")
        return
    
    new_usernames = BOT_DATA['last_result']
    existing_usernames = set(BOT_DATA.get('usernames', []))
    
    added = 0
    for name in new_usernames:
        if name not in existing_usernames:
            BOT_DATA.setdefault('usernames', []).append(name)
            added += 1
    
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    history_entry = {
        "timestamp": timestamp,
        "action": "حفظ نتيجة بحث",
        "count": added
    }
    BOT_DATA.setdefault('history', []).append(history_entry)
    
    save_data()
    
    await ctx.send(f"✅ تم حفظ {added} أسماء جديدة")

@bot.command()
async def export(ctx):
    """تصدير الأسماء المحفوظة"""
    saved_usernames = BOT_DATA.get('usernames', [])
    
    if not saved_usernames:
        await ctx.send("❌ لا توجد أسماء محفوظة للتصدير")
        return
    
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"usernames_{timestamp}.csv"
    
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Username', 'Saved Date'])
        for username in saved_usernames:
            writer.writerow([username, datetime.datetime.now().strftime("%Y-%m-%d")])
    
    await ctx.send("✅ تم تصدير الأسماء المحفوظة بنجاح", file=discord.File(filename))
    os.remove(filename)
    
    history_entry = {
        "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "action": "تصدير الأسماء",
        "count": len(saved_usernames)
    }
    BOT_DATA.setdefault('history', []).append(history_entry)
    save_data()

@bot.command()
async def clear(ctx):
    """مسح الأسماء المحفوظة"""
    if not BOT_DATA.get('usernames'):
        await ctx.send("❌ لا توجد أسماء محفوظة للمسح")
        return
    
    count = len(BOT_DATA['usernames'])
    BOT_DATA['usernames'] = []
    
    history_entry = {
        "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "action": "مسح جميع الأسماء",
        "count": count
    }
    BOT_DATA.setdefault('history', []).append(history_entry)
    save_data()
    
    await ctx.send(f"✅ تم مسح {count} أسماء محفوظة")

@bot.command()
async def find(ctx, count: int = 10):
    """البحث عن أسماء رباعية متاحة"""
    if not isinstance(ctx.channel, discord.DMChannel):
        return
    
    if count > 100:
        await ctx.send("⚠️ الحد الأقصى هو 100 اسم في المرة الواحدة")
        count = 100
    
    start_embed = discord.Embed(
        title="🔍 بدأ البحث عن أسماء رباعية متاحة",
        color=0xf39c12
    )
    start_embed.add_field(name="العدد المطلوب", value=str(count), inline=True)
    start_embed.add_field(name="المحاولات القصوى", value=str(MAX_CHECKS), inline=True)
    await ctx.send(embed=start_embed)
    
    start_time = datetime.datetime.now()
    
    # إعداد جلسة HTTP
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Authorization": f"Bot {TOKEN}"
    }
    
    async with aiohttp.ClientSession(headers=headers) as session:
        found = 0
        attempts = 0
        found_usernames = []
        
        while found < count and attempts < MAX_CHECKS:
            attempts += 1
            
            template = random.choice(TEMPLATES)
            username = generate_username(template)
            
            if not is_valid(username):
                continue
            
            # تجنب التحقق من الأسماء التي تم التحقق منها مؤخرًا
            if username in BOT_DATA["checked_names"]:
                last_check = BOT_DATA["checked_names"][username]["timestamp"]
                if time.time() - last_check < 86400:  # 24 ساعة
                    if BOT_DATA["checked_names"][username]["available"]:
                        found += 1
                        found_usernames.append(username)
                        
                        embed = discord.Embed(
                            title=f"✅ اسم متاح #{found} (من الذاكرة)",
                            description=f"`{username}`",
                            color=0x2ecc71
                        )
                        embed.add_field(name="القالب", value=template, inline=True)
                        embed.add_field(name="التقدم", value=f"{found}/{count}", inline=True)
                        await ctx.send(embed=embed)
                    continue
            
            # التحقق من توفر الاسم
            is_available = await check_username_availability(session, username)
            
            if is_available:
                found += 1
                found_usernames.append(username)
                
                embed = discord.Embed(
                    title=f"✅ اسم متاح #{found}",
                    description=f"`{username}`",
                    color=0x2ecc71
                )
                embed.add_field(name="القالب", value=template, inline=True)
                embed.add_field(name="التقدم", value=f"{found}/{count}", inline=True)
                await ctx.send(embed=embed)
            
            # إدارة حدود الطلبات والتأخير
            current_time = time.time()
            if current_time - BOT_DATA["rate_limit"] < REQUEST_DELAY:
                sleep_time = REQUEST_DELAY - (current_time - BOT_DATA["rate_limit"])
                await asyncio.sleep(sleep_time)
            
            BOT_DATA["rate_limit"] = time.time()
            
            # تحديث التقدم
            if attempts % 10 == 0:
                progress_embed = discord.Embed(
                    title="⏳ جاري البحث",
                    description=f"تم التحقق من {attempts} اسم حتى الآن",
                    color=0x3498db
                )
                progress_embed.add_field(name="تم العثور على", value=f"{found} أسماء متاحة")
                progress_embed.add_field(name="المتبقي", value=f"{count - found} أسماء")
                await ctx.send(embed=progress_embed)
        
        end_time = datetime.datetime.now()
        duration = (end_time - start_time).total_seconds()
        
        BOT_DATA['last_result'] = found_usernames
        
        history_entry = {
            "timestamp": end_time.strftime("%Y-%m-%d %H:%M:%S"),
            "duration": duration,
            "requested": count,
            "found": found,
            "attempts": attempts
        }
        BOT_DATA.setdefault('history', []).append(history_entry)
        save_data()
        
        result_embed = discord.Embed(
            title="🎉 انتهى البحث!" if found_usernames else "❌ انتهى البحث!",
            color=0x2ecc71 if found_usernames else 0xe74c3c
        )
        
        result_embed.add_field(
            name="النتائج",
            value=f"تم العثور على {found} اسم متاح من أصل {count} المطلوبة",
            inline=False
        )
        
        result_embed.add_field(
            name="المدة",
            value=f"{duration:.2f} ثانية",
            inline=True
        )
        
        result_embed.add_field(
            name="المحاولات",
            value=f"{attempts} محاولة",
            inline=True
        )
        
        if found_usernames:
            result_embed.add_field(
                name="حفظ النتائج",
                value="استخدم الأمر `!save` لحفظ النتائج",
                inline=False
            )
        
        await ctx.send(embed=result_embed)

# --- تشغيل البوت ---
if __name__ == "__main__":
    print("جارٍ تشغيل البوت...")
    load_data()
    bot.run(TOKEN)
