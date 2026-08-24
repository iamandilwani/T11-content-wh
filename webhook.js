// server/webhook.js
// Travel Eleven Instagram & Telegram Bot Server
// - Auto-replies to IG DMs using Gemini 2.5 Flash.
// - Real-time Telegram alerts for Hot Leads (Phone Numbers).
// - Scheduled 9 PM IST Daily Summary Report.
// - On-Demand Telegram Commands (/report, /hot, /reset).

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const app = express();
app.use(express.json());

const fs = require('fs');
const path = require('path');
const MUTE_FILE = path.join(__dirname, 'muted_users.json');

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_WEBAPP_URL = process.env.SHEET_WEBAPP_URL;
const SHEET_SECRET = process.env.SHEET_SECRET;

function saveMutedToFile() {
  try {
    fs.writeFileSync(MUTE_FILE, JSON.stringify([...optedOut]), 'utf8');
  } catch (err) {
    console.error('❌ Failed to save muted users to file:', err.message);
  }
}

function loadMutedFromFile() {
  try {
    if (fs.existsSync(MUTE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MUTE_FILE, 'utf8'));
      if (Array.isArray(data)) {
        data.forEach(id => optedOut.add(id));
        console.log(`✅ Loaded ${data.length} permanently muted user(s) from local file.`);
      }
    }
  } catch (err) {
    console.error('❌ Failed to load muted users from file:', err.message);
  }
}

async function persistMute(senderId, action) {
  if (action === 'mute') optedOut.add(senderId);
  else if (action === 'unmute') optedOut.delete(senderId);
  saveMutedToFile();

  if (!SHEET_WEBAPP_URL || !SHEET_SECRET) return;
  try {
    await fetch(SHEET_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SHEET_SECRET, action, senderId }),
      redirect: 'follow',
    });
  } catch (err) {
    console.error('❌ Failed to persist mute to sheet:', err.message);
  }
}

async function loadMutedFromSheet() {
  loadMutedFromFile();
  if (!SHEET_WEBAPP_URL) return;
  try {
    const res = await fetch(`${SHEET_WEBAPP_URL}?listMuted=1`, { redirect: 'follow' });
    const data = await res.json();
    (data.muted || []).forEach((id) => optedOut.add(id));
    saveMutedToFile();
    console.log(`✅ Restored ${(data.muted || []).length} muted user(s) from sheet after restart.`);
  } catch (err) {
    console.error('❌ Failed to load muted list from sheet:', err.message);
  }
}

async function logToSheet(type, sender, phone, message) {
  if (!SHEET_WEBAPP_URL || !SHEET_SECRET) return;
  try {
    await fetch(SHEET_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: SHEET_SECRET,
        type,
        sender,
        phone: phone || '',
        message: message || '',
      }),
      redirect: 'follow',
    });
  } catch (err) {
    console.error('❌ Failed to log to Sheet:', err.message);
  }
}

const seenSenders = new Set();
const optedOut = new Set();
const loggedHotToSheet = new Set(); // avoid duplicate sheet rows for the same hot lead
const loggedFollowUpToSheet = new Set(); // same, for follow-up leads
const askedForWhatsApp = new Set(); // tracks who we've already asked, since Gemini has no memory of prior turns
const autoMuteUntil = new Map(); // senderId -> timestamp; auto-expires unlike manual /mute
const AUTO_MUTE_DURATION_MS = 45 * 60 * 1000; // 45 min - adjust here if you want 30-60 range

function isAutoMuted(senderId) {
  const until = autoMuteUntil.get(senderId);
  if (!until) return false;
  if (Date.now() > until) {
    autoMuteUntil.delete(senderId); // window passed, auto-resume
    return false;
  }
  return true;
}
const senderNames = new Map(); // senderId -> username (best effort, may stay unresolved)
const recentConversations = new Map(); // senderId -> { lastMessage, lastSeen }
const MAX_RECENT = 20;

async function lookupUsername(senderId) {
  if (senderNames.has(senderId)) return senderNames.get(senderId);
  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/${senderId}?fields=username,name&access_token=${IG_ACCESS_TOKEN}`
    );
    const data = await res.json();
    const label = data.username || data.name || null;
    senderNames.set(senderId, label); // cache even if null, avoid repeat failed lookups
    return label;
  } catch (err) {
    senderNames.set(senderId, null);
    return null;
  }
}

function identifyLabel(senderId) {
  const name = senderNames.get(senderId);
  return name
    ? `<a href="https://instagram.com/${name}">@${name}</a> (<code>${senderId}</code>)`
    : `<code>${senderId}</code>`;
}

function plainLabel(senderId) {
  const name = senderNames.get(senderId);
  return name ? `@${name}` : senderId;
}

function trackConversation(senderId, messageText) {
  recentConversations.set(senderId, { lastMessage: messageText, lastSeen: new Date() });
  // Keep only the most recent MAX_RECENT conversations, oldest dropped.
  if (recentConversations.size > MAX_RECENT) {
    const oldestKey = recentConversations.keys().next().value;
    recentConversations.delete(oldestKey);
  }
}

const conversationHistory = new Map(); // senderId -> Array<{ role: 'user' | 'model', text: string }>
const MAX_HISTORY_MESSAGES = 10; // Keep up to 5 back-and-forth turns per user

function recordHistory(senderId, role, text) {
  if (!senderId) return;
  if (!conversationHistory.has(senderId)) {
    conversationHistory.set(senderId, []);
  }
  const history = conversationHistory.get(senderId);
  history.push({ role, text });
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
}

function buildGeminiContents(senderId, currentMessageText) {
  const rawHistory = conversationHistory.get(senderId) || [];
  const contents = [];

  for (const msg of rawHistory) {
    if (contents.length > 0 && contents[contents.length - 1].role === msg.role) {
      contents[contents.length - 1].parts[0].text += `\n${msg.text}`;
    } else {
      contents.push({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: [{ text: msg.text }]
      });
    }
  }

  // Ensure history starts with 'user' turn
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: currentMessageText }] });
  }

  return contents;
}

// In-Memory Daily Analytics (Resets at midnight or via /reset)
let dailyStats = {
  totalInquiries: 0,
  hotLeads: [],       // { senderId, text, phone }
  followUpLeads: [], // { senderId, text }
  casualCount: 0
};
let uniqueUsersToday = new Set(); // tracks distinct people, since totalInquiries counts every message

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'opt out', 'opt-out'];
const UNMUTE_WORDS = ['start', 'unmute', 'activate'];
const DISCLOSURE = "Hi! This is Travel Eleven's automated assistant 👋 ";
const OPT_OUT_CONFIRM = "Got it — automated replies are paused for this chat.";
const UNMUTE_CONFIRM = "Welcome back! Automated assistant is re-enabled ✨";
const FALLBACK_REPLY =
  "Thanks for reaching out! I'll make sure a real human travel architect sees this and gets back to you shortly.";

// Travel Eleven Brand & Knowledge Base
const TRAVEL_ELEVEN_DATA = {
  brand: {
    name: "Travel Eleven",
    tagline: "Turning your 11:11 wishes into journeys.",
    descriptor: "Offbeat. Curated. Real.",
    whatsapp: "+91 94859 86981"
  },
  group_departures: [
    {
      id: "gumbok",
      name: "Gumbok Rangan with Jispa",
      location: "Zanskar, India",
      duration: "4D/3N",
      groupSize: "6-15",
      tags: ["Stargazing", "Remote Valley"],
      description: "Experience the legendary God of Mountains, breathtaking Himalayan landscapes, and clear night skies for stargazing.",
      price: "₹11,999/-",
      dates: [
        { label: "10 Sep '26 (Stargazing Special)", status: "Available" },
        { label: "24 Sep '26", status: "Available" },
        { label: "01 Oct '26", status: "Available" },
        { label: "08 Oct '26 (Stargazing Special)", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/gumbok"
    },
    {
      id: "yulla",
      name: "Yulla Kanda Trek",
      location: "Himachal Pradesh",
      duration: "3D/2N",
      groupSize: "6-15",
      tags: ["World's Highest Krishna Temple", "Trek"],
      description: "Spiritual Himalayan adventure to the world's highest Krishna temple at 12,000+ ft.",
      price: "₹8,999/-",
      dates: [
        { label: "27 Aug '26", status: "Available" },
        { label: "17 Sep '26", status: "Available" },
        { label: "24 Sep '26", status: "Available" },
        { label: "01 Oct '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/yulla"
    },
    {
      id: "workation",
      name: "Hidden Himachal Workation",
      location: "Himachal Pradesh",
      duration: "3 Days (Weekend) / 7 Days (Workation)",
      groupSize: "6-15 people",
      tags: ["Workation Trip", "Himachal"],
      description: "Unstructured mountain escape with options for 3-Day Weekend or 7-Day Workation with homestay, Wi-Fi, and forest trek.",
      price: "₹8,999/- (Weekend) / ₹17,999/- (Workation)",
      dates: [
        { label: "20 Aug '26", status: "Available" },
        { label: "03 Sep '26", status: "Available" },
        { label: "17 Sep '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/workation"
    },
    {
      id: "madhyamaheshwar",
      name: "Madhyamaheshwar Trek",
      location: "Rudraprayag, Uttarakhand",
      duration: "4D/3N",
      groupSize: "6-15 people",
      tags: ["Panch Kedar", "Chaukhamba Views"],
      description: "Sacred Panch Kedar pilgrimage to Madhyamaheshwar at 11,473 ft with Budha Madhyamaheshwar sunrise.",
      price: "₹9,999/-",
      dates: [
        { label: "02 Sep '26", status: "Available" },
        { label: "09 Sep '26", status: "Available" },
        { label: "16 Sep '26", status: "Available" },
        { label: "23 Sep '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/madhyamaheshwar"
    },
    {
      id: "bhutan",
      name: "Bhutan Expedition - Land of the Thunder Dragon",
      location: "Bhutan (Thimphu, Punakha, Paro, Phobjikha)",
      duration: "8D/7N",
      groupSize: "6-15 people",
      tags: ["International Expedition", "Tiger's Nest Hike", "Thimphu Tshechu Festival", "Phobjikha Glacial Valley", "Flights Included"],
      description: "An 8-day Himalayan journey through Bhutan's sacred valleys, ancient dzongs, Phobjikha glacial meadows, Thimphu Tshechu Festival, and the iconic cliffside Tiger's Nest Monastery.",
      price: "₹49,999/- (Special Introductory Offer - Flights & Full Package Included)",
      dates: [
        { label: "19 Sep '26 (Thimphu Tshechu Festival Special)", status: "Fast Filling" },
        { label: "17 Oct '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/bhutan"
    }
  ]
};

function getSystemPrompt() {
  return `
You are the Instagram DM assistant for @traveleleven.in ("Turning your 11:11 wishes into journeys.").

TONE & CHAT STYLE — CRITICAL HUMAN RULES:
- TALK LIKE A REAL HUMAN TEXTING ON INSTAGRAM DM:
  - Keep it casual, chill, direct, and low-key (like a friendly traveler texting back).
  - ABSOLUTELY NO OVER-APPRECIATION OR CHEESY COMPLIMENTS! Never say fake AI stuff like "Awesome squad of two is perfect size!", "That's incredible!", "What a fantastic choice!", or over-hype everything.
  - Just acknowledge naturally ("Sounds good", "Got it", "Nice", "Cool"). Do NOT compliment every detail.
- KEEP REPLIES SHORT & NATURAL:
  - Use short phrases when detailed explanations aren't needed. Don't write formal essays or robotic explanations.
  - Keep total replies under 1-3 short text lines max.
- FORMATTING:
  - Break thoughts into separate short text lines using line breaks (\n). Never send one dense block of text.

CONVERSATION LOGIC:
1. PRICING STRICT RULE: ONLY share price details if explicitly asked (e.g. "cost?", "price?", "budget?"). Otherwise, focus on dates and vibe.
2. GROUP DEPARTURES (Gumbok Rangan, Yulla Kanda, Workation, Madhyamaheshwar):
   - Mention duration and upcoming dates naturally.
   - Direct them to "Request Invite" on website ONLY when they show interest.
3. CUSTOMIZED TRIPS / OTHER LOCATIONS (Kashmir, Spiti, Bali, etc.):
   - Confirm we curate custom offbeat trips. Ask for travel dates & group size briefly.
4. SAFETY & REASSURANCE:
   - Answer reassurance questions (solo female safety, weather) simply and warmly without pushiness.

ITINERARY LINK - STRICT RULE:
- Do NOT send the website link in every reply.
- ONLY send the link if explicitly asked (e.g. "send link", "itinerary link", "details?") or when requested. For general queries, share dates/vibe and ask: "Want me to send the full itinerary link?"

UPCOMING BATCHES ONLY RULE - CRITICAL:
- Today's current date is dynamically provided in the prompt context.
- ONLY list or mention departure batch dates that fall on or after today's date.
- NEVER mention past or already departed batch dates. Omit departed dates completely.

WHATSAPP NUMBER - CRITICAL RULE:
- Ask for it AT MOST ONCE per chat.
- Never ask for it on general questions or small talk—only when they express clear booking intent.

KNOWLEDGE BASE:
${JSON.stringify(TRAVEL_ELEVEN_DATA, null, 2)}
`.trim();
}

function findTrip(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  return TRAVEL_ELEVEN_DATA.group_departures.find(t => {
    const id = t.id.toLowerCase();
    const name = t.name.toLowerCase();
    if (id === q || name.includes(q)) return true;
    if ((q.includes('gomboc') || q.includes('gombok') || q.includes('zanskar') || q.includes('jispa')) && id === 'gumbok') return true;
    if ((q.includes('yulla') || q.includes('krishna')) && id === 'yulla') return true;
    if ((q.includes('workation') || q.includes('himachal') || q.includes('work')) && id === 'workation') return true;
    if ((q.includes('madhyamaheshwar') || q.includes('mm') || q.includes('kedar')) && id === 'madhyamaheshwar') return true;
    if ((q.includes('bhutan') || q.includes('taktsang') || q.includes('tiger') || q.includes('tshechu') || q.includes('thimphu') || q.includes('paro') || q.includes('punakha')) && id === 'bhutan') return true;
    return false;
  });
}

async function generateReply(senderId, messageText, alreadyAskedForWhatsApp) {
  if (!GEMINI_API_KEY) return FALLBACK_REPLY;

  // Record user turn in conversation history buffer
  recordHistory(senderId, 'user', messageText);

  try {
    const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    const dynamicDateNote = `\n\nTODAY'S CURRENT DATE (IST): ${todayStr}. CRITICAL RULE: ONLY share upcoming batch dates that fall on or after today's date (${todayStr}). NEVER mention past or already departed batches.`;
    const whatsappNote = alreadyAskedForWhatsApp
      ? '\n\nIMPORTANT CONTEXT: You have already asked this person for their WhatsApp number earlier in this conversation. Do NOT ask again - just answer their message normally.'
      : '';
    const fullContextNote = `${whatsappNote}${dynamicDateNote}`;
    const systemPrompt = getSystemPrompt();

    const contents = buildGeminiContents(senderId, messageText);

    // Gemini 3.5 Flash Lite & Gemini 3.6 Flash model endpoints as specified by Google API
    const modelsToTry = [
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash'
    ];

    let replyText = null;

    for (const model of modelsToTry) {
      try {
        // Attempt 1: Standard REST API payload with camelCase systemInstruction & multi-turn contents
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: `${systemPrompt}${fullContextNote}` }]
              },
              contents: contents,
              generationConfig: {
                temperature: 0.3
              }
            }),
          }
        );
        const data = await res.json();
        if (res.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          replyText = data.candidates[0].content.parts[0].text.trim();
          break;
        }

        // Attempt 2: Legacy single-prompt payload fallback
        const legacyRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                { parts: [{ text: `${systemPrompt}${fullContextNote}\n\nIncoming DM: "${messageText}"\n\nYour reply:` }] }
              ],
              generationConfig: { temperature: 0.3 }
            }),
          }
        );
        const legacyData = await legacyRes.json();
        if (legacyRes.ok && legacyData?.candidates?.[0]?.content?.parts?.[0]?.text) {
          replyText = legacyData.candidates[0].content.parts[0].text.trim();
          break;
        } else {
          console.error(`❌ Model ${model} failed:`, JSON.stringify(data?.error || legacyData?.error || data));
        }
      } catch (err) {
        console.warn(`⚠️ Model ${model} request error:`, err.message);
      }
    }

    const finalReply = replyText || FALLBACK_REPLY;
    recordHistory(senderId, 'model', finalReply);
    return finalReply;
  } catch (err) {
    console.error('❌ Gemini generation failed:', err.message);
    return FALLBACK_REPLY;
  }
}

async function sendInstagramReply(recipientId, text) {
  const url = `https://graph.instagram.com/v21.0/me/messages?access_token=${IG_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('❌ Failed to send Instagram reply:', JSON.stringify(data));
  }
  return data;
}

function escapeTelegramHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const contactedLeads = new Set();
const dealWonLeads = new Set();
const lastAlertSenderByMsgId = new Map(); // msg_id -> senderId

async function notifyTelegram(text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in environment variables!');
    return null;
  }
  try {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('❌ Telegram API notification error:', JSON.stringify(data));
    }
    return data?.result?.message_id || null;
  } catch (err) {
    console.error('❌ Failed to notify Telegram:', err.message);
    return null;
  }
}

async function answerTelegramCallback(callbackQueryId, text = '') {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    console.error('❌ Failed to answer Telegram callback query:', err.message);
  }
}

async function editTelegramMessageText(chatId, messageId, text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('❌ Failed to edit Telegram message:', err.message);
  }
}

// Function to Format and Send Lead Summary
function generateReportText(title = "LIVE LEAD REPORT") {
  let hotLeadsText = dailyStats.hotLeads.length > 0 
    ? dailyStats.hotLeads.map((l, i) => `${i + 1}. <b>${l.phone}</b> (ID: <code>${l.senderId}</code>)\n   Msg: "${l.text.slice(0, 80)}"`).join('\n')
    : 'None captured so far.';

  let followUpText = dailyStats.followUpLeads.length > 0
    ? dailyStats.followUpLeads.map((l, i) => `${i + 1}. User <code>${l.senderId}</code>\n   Asked: "${l.text.slice(0, 80)}"`).join('\n')
    : 'None so far.';

  return `
📊 <b>${title} — Travel Eleven</b>
--------------------------------------------
👥 <b>Unique People Contacted:</b> ${uniqueUsersToday.size}
📥 <b>Total Messages Received:</b> ${dailyStats.totalInquiries}
🔥 <b>Hot Leads (Phone Numbers):</b> ${dailyStats.hotLeads.length}
⏳ <b>Follow-up Needed:</b> ${dailyStats.followUpLeads.length}
💬 <b>Casual Conversations:</b> ${dailyStats.casualCount}

--------------------------------------------
🔥 <b>HOT LEADS TO CONTACT:</b>
${hotLeadsText}

--------------------------------------------
⏳ <b>HIGH-INTENT FOLLOW-UPS (No Phone Yet):</b>
${followUpText}
  `.trim();
}

// --- INSTAGRAM WEBHOOK ENDPOINTS ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed — token mismatch');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Ack immediately

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        const senderId = event.sender?.id;
        const messageText = event.message?.text;
        const isEcho = event.message?.is_echo === true;

// --- HUMAN TAKEOVER (DISABLED - see note below) ---
// This used to auto-mute based on echoes missing an app_id, assuming that meant
// a human typed the reply manually. In practice this triggered even when the BOT's
// own replies were echoed back, meaning it was silently muting real customers right
// after every auto-reply - the opposite of what we want. Disabled until we can
// confirm Meta's exact echo payload shape. Use the manual /mute command instead,
// which is reliable.
if (isEcho) {
  continue; // just ignore echoes, don't auto-mute anyone based on them
}
if (!senderId || !messageText) continue;

        console.log(`📩 DM from ${senderId}: ${messageText}`);

        const lowerMsg = messageText.toLowerCase().trim();

        // Whole-word match so phrases like "any stopovers?" don't false-trigger.
        const wordsInMsg = lowerMsg.split(/\W+/);

        // 1. RE-ENABLE RULE
        if (UNMUTE_WORDS.some((w) => lowerMsg === w)) {
          optedOut.delete(senderId);
          await sendInstagramReply(senderId, UNMUTE_CONFIRM);
          await notifyTelegram(`🟢 User <code>${senderId}</code> re-enabled AI bot.`);
          continue;
        }

        // 2. HARD OPT-OUT RULE
        if (OPT_OUT_WORDS.some((phrase) => {
          const phraseWords = phrase.split(/\W+/);
          return phraseWords.length === 1
            ? wordsInMsg.includes(phraseWords[0])
            : lowerMsg.includes(phrase); // multi-word phrases like "opt out" stay as substring match
        })) {
          optedOut.add(senderId);
          await sendInstagramReply(senderId, OPT_OUT_CONFIRM);
          await notifyTelegram(`🚫 User <code>${senderId}</code> opted out / paused AI.`);
          continue;
        }

        // 3. IF MUTED (manual) OR IN AUTO-MUTE WINDOW, SKIP
        if (optedOut.has(senderId)) {
          console.log(`Skipping reply — ${senderId} is muted / opted out.`);
          continue;
        }
        if (isAutoMuted(senderId)) {
          console.log(`Skipping reply — ${senderId} is in the auto-pause window after sharing a phone number.`);
          continue;
        }

        const isFirstContact = !seenSenders.has(senderId);
        seenSenders.add(senderId);

        if (isFirstContact) await lookupUsername(senderId); // best effort, cached after
        trackConversation(senderId, messageText);
        const label = identifyLabel(senderId);

        const generated = await generateReply(senderId, messageText, askedForWhatsApp.has(senderId));
        if (/whatsapp/i.test(generated)) askedForWhatsApp.add(senderId);
        const reply = isFirstContact ? DISCLOSURE + generated : generated;
        await sendInstagramReply(senderId, reply);

        // --- LEAD CATEGORIZATION ---
        dailyStats.totalInquiries++;
        uniqueUsersToday.add(senderId);

        const phoneMatch = messageText.match(/(?:\+?91[\s-]*)?[6-9]\d{4}[\s-]*\d{5}\b/) || messageText.match(/\b[6-9]\d{9}\b/);
        const highIntentKeywords = ['price', 'cost', 'dates', 'book', 'how to join', 'itinerary', 'safe', 'workation', 'yulla', 'gumbok', 'gomboc', 'zanskar', 'jispa'];
        const isHighIntent = highIntentKeywords.some(kw => lowerMsg.includes(kw));

        if (phoneMatch) {
          const phone = phoneMatch[0];
          dailyStats.hotLeads.push({ senderId, text: messageText, phone });

          if (!loggedHotToSheet.has(senderId)) {
            loggedHotToSheet.add(senderId);
            await logToSheet('hot', plainLabel(senderId), phone, messageText);
          }

          // Pause AI for this person so it doesn't double-message while your
          // team follows up. Auto-resumes after the window if nobody manually
          // takes over with /mute.
          autoMuteUntil.set(senderId, Date.now() + AUTO_MUTE_DURATION_MS);

          const cleanDigits = phone.replace(/\D/g, '');
          const inlineButtons = [];
          const row1 = [];
          if (cleanDigits.length >= 10) {
            const waNumber = cleanDigits.length === 10 ? `91${cleanDigits}` : cleanDigits;
            row1.push({ text: `📲 WhatsApp ${phone}`, url: `https://wa.me/${waNumber}` });
          }
          const username = senderNames.get(senderId);
          if (username) {
            row1.push({ text: `📸 Instagram @${username}`, url: `https://instagram.com/${username}` });
          }
          if (row1.length > 0) inlineButtons.push(row1);

          inlineButtons.push([
            { text: "✅ Contacted", callback_data: `cb_cnt_${senderId}` },
            { text: "⏸️ Mute 24h", callback_data: `cb_m24_${senderId}` },
            { text: "🔇 Perma Mute", callback_data: `cb_perm_${senderId}` },
            { text: "🏆 Deal Won", callback_data: `cb_won_${senderId}` }
          ]);

          const msgId = await notifyTelegram(
            `🔥 <b>HOT LEAD DETECTED!</b>\n\n` +
            `<b>Phone:</b> <code>${phone}</code>\n` +
            `<b>From:</b> ${label}\n` +
            `<b>Message:</b> "${escapeTelegramHtml(messageText)}"\n\n` +
            `⚡ <i>Call or WhatsApp them right now!</i>\n` +
            `AI auto-paused 45m. Reply to this msg with <code>reply: text</code> to reply directly on IG DM!`,
            { inline_keyboard: inlineButtons }
          );

          if (msgId) lastAlertSenderByMsgId.set(msgId.toString(), senderId);

          // 30-Minute Uncontacted Hot Lead Escalation
          const leadId = senderId;
          const leadPhone = phone;
          setTimeout(async () => {
            if (!contactedLeads.has(leadId) && !dealWonLeads.has(leadId)) {
              const currentLabel = identifyLabel(leadId);
              await notifyTelegram(
                `⚠️ <b>UNCONTACTED HOT LEAD REMINDER!</b>\n\n` +
                `Hot Lead ${currentLabel} (Phone: <code>${leadPhone}</code>) was received 30 mins ago and hasn't been marked as contacted yet!\n\n` +
                `⚡ <i>Please call or WhatsApp them now!</i>`
              );
            }
          }, 30 * 60 * 1000);
        } else if (isHighIntent) {
          dailyStats.followUpLeads.push({ senderId, text: messageText });

          if (!loggedFollowUpToSheet.has(senderId)) {
            loggedFollowUpToSheet.add(senderId);
            await logToSheet('follow-up', plainLabel(senderId), '', messageText);
          }

          const username = senderNames.get(senderId);
          const inlineButtons = [];
          if (username) {
            inlineButtons.push([{ text: `📸 Open Instagram @${username}`, url: `https://instagram.com/${username}` }]);
          }
          inlineButtons.push([
            { text: "✅ Contacted", callback_data: `cb_cnt_${senderId}` },
            { text: "⏸️ Mute 24h", callback_data: `cb_m24_${senderId}` },
            { text: "🔇 Perma Mute", callback_data: `cb_perm_${senderId}` },
            { text: "🏆 Deal Won", callback_data: `cb_won_${senderId}` }
          ]);

          const msgId = await notifyTelegram(
            `⏳ <b>New DM</b>\nFrom: ${label}\nMessage: "${escapeTelegramHtml(messageText.slice(0, 200))}"\n` +
            `Reply to this msg with <code>reply: text</code> to reply directly on IG DM!`,
            { inline_keyboard: inlineButtons }
          );

          if (msgId) lastAlertSenderByMsgId.set(msgId.toString(), senderId);
        } else {
          dailyStats.casualCount++;
          // Casual chats aren't logged to the sheet or pinged to Telegram -
          // only hot leads and genuine follow-up interest are.
        }
      }
    }
  } catch (err) {
    console.error('❌ Error processing webhook event:', err.message);
  }
});

// --- ON-DEMAND TELEGRAM COMMANDS & INTERACTIVE CALLBACKS ---
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    // 1. HANDLE CALLBACK QUERIES (INLINE BUTTON CLICKS)
    if (req.body.callback_query) {
      const cb = req.body.callback_query;
      const cbId = cb.id;
      const data = cb.data || '';
      const chatId = cb.message?.chat?.id?.toString();

      if (chatId !== TELEGRAM_CHAT_ID?.toString()) {
        await answerTelegramCallback(cbId, 'Unauthorized chat');
        return;
      }

      if (data.startsWith('cb_cnt_')) {
        const senderId = data.replace('cb_cnt_', '');
        contactedLeads.add(senderId);
        autoMuteUntil.set(senderId, Date.now() + 24 * 60 * 60 * 1000);
        await answerTelegramCallback(cbId, '✅ Marked as Contacted!');
        await notifyTelegram(`✅ Lead <code>${senderId}</code> marked as <b>CONTACTED</b> by team! AI paused for 24h.`);
      } else if (data.startsWith('cb_m24_')) {
        const senderId = data.replace('cb_m24_', '');
        autoMuteUntil.set(senderId, Date.now() + 24 * 60 * 60 * 1000);
        await answerTelegramCallback(cbId, '⏸️ AI muted for 24 hours!');
        await notifyTelegram(`⏸️ AI paused for 24h for user <code>${senderId}</code>.`);
      } else if (data.startsWith('cb_perm_')) {
        const senderId = data.replace('cb_perm_', '');
        optedOut.add(senderId);
        await persistMute(senderId, 'mute');
        await answerTelegramCallback(cbId, '🔇 Permanently Muted!');
        await notifyTelegram(`🔇 AI permanently muted for user <code>${senderId}</code> (saved to disk & sheet).`);
      } else if (data.startsWith('cb_won_')) {
        const senderId = data.replace('cb_won_', '');
        contactedLeads.add(senderId);
        dealWonLeads.add(senderId);
        autoMuteUntil.set(senderId, Date.now() + 7 * 24 * 60 * 60 * 1000);
        await answerTelegramCallback(cbId, '🏆 Deal marked as WON!');
        await notifyTelegram(`🎉 <b>DEAL WON!</b> User <code>${senderId}</code> converted into a traveler! 🥳`);
      }
      return;
    }

    // 2. HANDLE TELEGRAM MESSAGES & COMMANDS
    const messageObj = req.body.message;
    if (!messageObj) return;

    const incomingChatId = messageObj.chat?.id?.toString();
    if (!incomingChatId || incomingChatId !== TELEGRAM_CHAT_ID?.toString()) {
      console.log(`⚠️ Ignored Telegram command from unauthorized chat id: ${incomingChatId}`);
      return;
    }

    const rawText = messageObj.text?.trim() || '';
    if (!rawText) return;

    // Strip bot handle from command (e.g. /addbatch@MyBot -> /addbatch)
    let cleanText = rawText.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/i, '$1');
    const lowerMsg = cleanText.toLowerCase().trim();

    // A. DIRECT INSTAGRAM DM REPLY FROM TELEGRAM
    let targetSenderId = null;
    let replyContent = null;

    if (messageObj.reply_to_message) {
      const replyToId = messageObj.reply_to_message.message_id?.toString();
      targetSenderId = lastAlertSenderByMsgId.get(replyToId);
      if (!targetSenderId) {
        const match = (messageObj.reply_to_message.text || '').match(/(?:ID:\s*|<code>)(\d{10,20})/);
        if (match) targetSenderId = match[1];
      }
      if (targetSenderId) {
        replyContent = cleanText.replace(/^(?:reply:|r:|\/reply)\s*/i, '').trim();
      }
    } else if (/^(?:reply:|r:|\/reply)\s+/i.test(cleanText)) {
      const parts = cleanText.split(/\s+/);
      if (parts.length >= 3 && /^\d{10,20}$/.test(parts[1])) {
        targetSenderId = parts[1];
        replyContent = parts.slice(2).join(' ');
      }
    }

    if (targetSenderId && replyContent) {
      await sendInstagramReply(targetSenderId, replyContent);
      autoMuteUntil.set(targetSenderId, Date.now() + 24 * 60 * 60 * 1000);
      recordHistory(targetSenderId, 'model', replyContent);
      const label = identifyLabel(targetSenderId);
      await notifyTelegram(`✅ <b>Direct IG DM Sent!</b>\nTo: ${label}\nMessage: "${escapeTelegramHtml(replyContent)}"\n<i>AI auto-paused 24h for human chat.</i>`);
      return;
    }

    // B. TELEGRAM COMMANDS
    if (lowerMsg === '/report' || lowerMsg === 'report' || lowerMsg === 'summary') {
      await notifyTelegram(generateReportText("ON-DEMAND LEAD REPORT"));
    } else if (lowerMsg === '/hot' || lowerMsg === 'hot') {
      let hotText = dailyStats.hotLeads.length > 0
        ? dailyStats.hotLeads.map((l, i) => `${i + 1}. <b>${l.phone}</b> (ID: <code>${l.senderId}</code>)\n   Msg: "${escapeTelegramHtml(l.text)}"`).join('\n\n')
        : 'No hot leads captured yet today.';
      await notifyTelegram(`🔥 <b>HOT LEADS TODAY (${dailyStats.hotLeads.length})</b>\n\n${hotText}`);
    } else if (lowerMsg === '/reset' || lowerMsg === 'reset') {
      dailyStats = { totalInquiries: 0, hotLeads: [], followUpLeads: [], casualCount: 0 };
      uniqueUsersToday = new Set();
      await notifyTelegram(`🔄 <b>Daily lead stats have been reset!</b>`);
    } else if (lowerMsg.startsWith('/mute') || lowerMsg.startsWith('mute ')) {
      const senderId = cleanText.split(/\s+/)[1];
      if (!senderId) {
        await notifyTelegram(`⚠️ Usage: <code>/mute SENDER_ID</code>`);
      } else {
        optedOut.add(senderId);
        await persistMute(senderId, 'mute');
        await notifyTelegram(`🔇 AI permanently muted for <code>${senderId}</code>.`);
      }
    } else if (lowerMsg.startsWith('/unmute') || lowerMsg.startsWith('unmute ')) {
      const senderId = cleanText.split(/\s+/)[1];
      if (!senderId) {
        await notifyTelegram(`⚠️ Usage: <code>/unmute SENDER_ID</code>`);
      } else {
        optedOut.delete(senderId);
        autoMuteUntil.delete(senderId);
        await persistMute(senderId, 'unmute');
        await notifyTelegram(`🔊 AI re-enabled for <code>${senderId}</code>.`);
      }
    } else if (lowerMsg === '/active' || lowerMsg === 'active') {
      if (recentConversations.size === 0) {
        await notifyTelegram('No recent conversations yet.');
      } else {
        const lines = [...recentConversations.entries()]
          .reverse()
          .map(([id, info]) => {
            const label = identifyLabel(id);
            let status = '';
            if (optedOut.has(id)) status = ' 🔇 MUTED';
            else if (isAutoMuted(id)) {
              const minsLeft = Math.ceil((autoMuteUntil.get(id) - Date.now()) / 60000);
              status = ` ⏸️ auto-paused (${minsLeft}m left)`;
            }
            return `${label}${status}\n   "${escapeTelegramHtml(info.lastMessage.slice(0, 60))}"\n   <code>/mute ${id}</code>`;
          });
        await notifyTelegram(`💬 <b>Recent conversations</b>\n\n${lines.join('\n\n')}`);
      }
    } else if (lowerMsg === '/history' || lowerMsg === 'history' || lowerMsg === '/recent' || lowerMsg === 'recent') {
      if (recentConversations.size === 0) {
        await notifyTelegram('No recent conversations recorded yet.');
      } else {
        let textOut = `💬 <b>RECENT CONVERSATIONS HISTORY</b>\n--------------------------------------------\n\n`;
        const recentEntries = [...recentConversations.entries()].reverse().slice(0, 10);
        for (const [id, info] of recentEntries) {
          const label = identifyLabel(id);
          const history = conversationHistory.get(id) || [];
          let status = optedOut.has(id) ? ' 🔇 MUTED' : (isAutoMuted(id) ? ' ⏸️ AUTO-PAUSED' : ' 🔊 ACTIVE');
          textOut += `👤 <b>${label}</b> (${status})\n`;
          if (history.length > 0) {
            history.slice(-3).forEach(h => {
              textOut += `  • <b>${h.role === 'user' ? 'User' : 'AI'}:</b> "${escapeTelegramHtml(h.text.slice(0, 70))}"\n`;
            });
          } else {
            textOut += `  • Last Msg: "${escapeTelegramHtml(info.lastMessage.slice(0, 70))}"\n`;
          }
          textOut += `  <i>To lookup: <code>/lookup ${id}</code> | To mute: <code>/mute ${id}</code></i>\n\n`;
        }
        await notifyTelegram(textOut);
      }
    } else if (lowerMsg === '/batches' || lowerMsg === 'batches' || lowerMsg === 'batch list' || lowerMsg === '/batch') {
      let batchText = `📅 <b>UPCOMING ACTIVE TRIP BATCHES (${TRAVEL_ELEVEN_DATA.group_departures.length} TRIPS)</b>\n--------------------------------------------\n`;
      for (const trip of TRAVEL_ELEVEN_DATA.group_departures) {
        batchText += `\n<b>${trip.name}</b> (ID: <code>${trip.id}</code>)\n`;
        batchText += `  • <b>Duration:</b> ${trip.duration}\n`;
        batchText += `  • <b>Price:</b> ${trip.price}\n`;
        batchText += `  • <b>Batches:</b>\n`;
        if (trip.dates && trip.dates.length > 0) {
          trip.dates.forEach(d => {
            batchText += `    - ${d.label} (${d.status || 'Available'})\n`;
          });
        } else {
          batchText += `    - No dates listed\n`;
        }
      }
      batchText += `\n--------------------------------------------\n` +
        `<i>Add/Remove batches anytime:</i>\n` +
        `<code>/addbatch <trip_id> <date_label></code>\n` +
        `<code>/removebatch <trip_id> <date_label></code>`;
      await notifyTelegram(batchText);
    } else if (lowerMsg.startsWith('/addbatch') || lowerMsg.startsWith('addbatch') || lowerMsg.startsWith('/add_batch') || lowerMsg.startsWith('add batch')) {
      const parts = cleanText.split(/\s+/);
      const args = (parts[0].includes('batch') || parts[0].includes('add')) && parts.length > 1 && (parts[0].endsWith('batch') || parts[1] === 'batch')
        ? parts.slice(lowerMsg.startsWith('add batch') ? 2 : 1)
        : parts.slice(1);

      if (args.length < 2) {
        await notifyTelegram(`⚠️ Usage: <code>/addbatch <trip_id> <date_label></code>\nExample: <code>/addbatch gumbok 15 Oct '26</code>`);
      } else {
        const tripQuery = args[0];
        const dateLabel = args.slice(1).join(' ');
        const trip = findTrip(tripQuery);
        if (!trip) {
          await notifyTelegram(`❌ Trip matching <code>${tripQuery}</code> not found!\nAvailable trips: <code>gumbok</code>, <code>yulla</code>, <code>workation</code>, <code>madhyamaheshwar</code>.`);
        } else {
          trip.dates.push({ label: dateLabel, status: "Available" });
          await notifyTelegram(`✅ Added batch <b>"${dateLabel}"</b> to <b>${trip.name}</b>!\n<i>AI will now share this date in upcoming DMs.</i>`);
        }
      }
    } else if (lowerMsg.startsWith('/removebatch') || lowerMsg.startsWith('removebatch') || lowerMsg.startsWith('/remove_batch') || lowerMsg.startsWith('remove batch') || lowerMsg.startsWith('/deletebatch') || lowerMsg.startsWith('deletebatch')) {
      const parts = cleanText.split(/\s+/);
      const args = lowerMsg.startsWith('remove batch') || lowerMsg.startsWith('delete batch')
        ? parts.slice(2)
        : parts.slice(1);

      if (args.length < 2) {
        await notifyTelegram(`⚠️ Usage: <code>/removebatch <trip_id> <date_label></code>\nExample: <code>/removebatch gumbok 15 Oct</code>`);
      } else {
        const tripQuery = args[0];
        const dateQuery = args.slice(1).join(' ').toLowerCase();
        const trip = findTrip(tripQuery);
        if (!trip) {
          await notifyTelegram(`❌ Trip matching <code>${tripQuery}</code> not found.`);
        } else {
          const idx = trip.dates.findIndex(d => d.label.toLowerCase().includes(dateQuery));
          if (idx === -1) {
            await notifyTelegram(`❌ Batch matching "${dateQuery}" not found in ${trip.name}.`);
          } else {
            const removed = trip.dates.splice(idx, 1)[0];
            await notifyTelegram(`🗑️ Removed batch <b>"${removed.label}"</b> from <b>${trip.name}</b>!`);
          }
        }
      }
    } else if (lowerMsg.startsWith('/lookup')) {
      const query = text.split(/\s+/)[1];
      if (!query) {
        await notifyTelegram(`⚠️ Usage: <code>/lookup SENDER_ID_OR_PHONE_OR_USERNAME</code>`);
      } else {
        const cleanQ = query.toLowerCase().replace(/[@\s]/g, '');
        let matchedId = null;

        for (const [id, name] of senderNames.entries()) {
          if (id === cleanQ || (name && name.toLowerCase().includes(cleanQ))) {
            matchedId = id;
            break;
          }
        }
        if (!matchedId) {
          const lead = dailyStats.hotLeads.find(l => l.senderId === cleanQ || l.phone.includes(cleanQ));
          if (lead) matchedId = lead.senderId;
        }
        if (!matchedId) {
          for (const id of recentConversations.keys()) {
            if (id === cleanQ) { matchedId = id; break; }
          }
        }

        if (!matchedId) {
          await notifyTelegram(`❌ No records found matching <code>${query}</code>.`);
        } else {
          const label = identifyLabel(matchedId);
          const phoneObj = dailyStats.hotLeads.find(l => l.senderId === matchedId);
          const phoneStr = phoneObj ? phoneObj.phone : 'Not shared yet';
          const isMuted = optedOut.has(matchedId) ? '🔇 Permanently Muted' : (isAutoMuted(matchedId) ? '⏸️ Auto-Paused' : '🔊 Active AI');
          const isContacted = contactedLeads.has(matchedId) ? '✅ Yes' : '❌ No';
          const isWon = dealWonLeads.has(matchedId) ? '🏆 Yes' : '❌ No';

          const history = conversationHistory.get(matchedId) || [];
          let historyText = history.length > 0
            ? history.map(h => `• <b>${h.role === 'user' ? 'User' : 'Bot'}:</b> "${escapeTelegramHtml(h.text.slice(0, 80))}"`).join('\n')
            : 'No stored turn history.';

          await notifyTelegram(
            `🔍 <b>CUSTOMER LOOKUP: ${label}</b>\n--------------------------------------------\n` +
            `📱 <b>Phone:</b> <code>${phoneStr}</code>\n` +
            `🤖 <b>AI Status:</b> ${isMuted}\n` +
            `✅ <b>Contacted:</b> ${isContacted}\n` +
            `🏆 <b>Deal Won:</b> ${isWon}\n\n` +
            `💬 <b>RECENT MESSAGES:</b>\n${historyText}\n\n` +
            `To reply: reply to this msg with <code>reply: text</code>`
          );
        }
      }
    }
  } catch (err) {
    console.error('❌ Error handling Telegram command:', err.message);
  }
});

// --- AUTOMATED DAILY SUMMARY AT 9:00 PM IST ---
cron.schedule('0 21 * * *', async () => {
  console.log('📊 Generating Daily Telegram Lead Report...');
  await notifyTelegram(generateReportText("DAILY LEAD SUMMARY REPORT"));

  // Reset stats for the next day
  dailyStats = {
    totalInquiries: 0,
    hotLeads: [],
    followUpLeads: [],
    casualCount: 0
  };
  uniqueUsersToday = new Set();
}, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head><title>Privacy Policy — Travel Eleven</title></head>
      <body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.6;">
        <h1>Privacy Policy</h1>
        <p>This application ("Travel Eleven Content Agent") is an automation tool used to manage direct messages for the Instagram account @traveleleven.in.</p>
        <p>Messages received are processed strictly to send automated trip recommendations and context. Users can send "stop" to unsubscribe at any time.</p>
      </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  res.send('Travel Eleven webhook server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
  loadMutedFromSheet(); // restore permanent mutes that survived a restart
});