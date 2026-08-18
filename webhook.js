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

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_WEBAPP_URL = process.env.SHEET_WEBAPP_URL;
const SHEET_SECRET = process.env.SHEET_SECRET;

async function persistMute(senderId, action) {
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
  if (!SHEET_WEBAPP_URL) return;
  try {
    const res = await fetch(`${SHEET_WEBAPP_URL}?listMuted=1`, { redirect: 'follow' });
    const data = await res.json();
    (data.muted || []).forEach((id) => optedOut.add(id));
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
        { label: "13 Aug '26", status: "Available" },
        { label: "10 Sep '26", status: "Available" },
        { label: "18 Sep '26", status: "Available" },
        { label: "01 Oct '26", status: "Available" },
        { label: "08 Oct '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary.html?trip=gumbok"
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
        { label: "02 Sep '26 (Janmashtami Special)", status: "Available" },
        { label: "17 Sep '26", status: "Available" },
        { label: "24 Sep '26", status: "Available" },
        { label: "01 Oct '26", status: "Available" },
        { label: "15 Oct '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary.html?trip=yulla"
    },
    {
      id: "workation",
      name: "Hidden Himachal Workation",
      location: "Himachal Pradesh",
      duration: "7 Days",
      groupSize: "5-7 people",
      tags: ["Workation Trip", "Himachal"],
      description: "Unstructured, slow-paced workation for remote workers & creators in a traditional insulated mud house with reliable Wi-Fi.",
      price: "₹11,999/-",
      dates: [
        { label: "30 July '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary.html?trip=workation"
    }
  ]
};

const SYSTEM_PROMPT = `
You are the Instagram DM assistant for @traveleleven.in ("Turning your 11:11 wishes into journeys.").

BRAND CONCEPT:
- Travel Eleven is an EXCLUSIVE, INVITE-ONLY offbeat travel community!
- Guests do not directly add to cart; they click "Request Invite" on the website so our team can curate the squad.
- Tone: Offbeat, curated, real, exclusive yet warm, and casual (Indian English friendly).
- Length: Keep replies under 2-3 short sentences max. This is an Instagram DM!

FORMATTING - THIS IS CRITICAL:
- NEVER write one dense paragraph. Real people texting break their thoughts into short separate
  lines using actual line breaks (\n), not one run-on sentence with commas.
- If mentioning more than one trip/option, put EACH one on its own line, not comma-separated in
  a sentence. Example of BAD formatting (never do this):
  "We have two amazing trips: Gumbok Rangan and Yulla Kanda, plus a Workation."
  Example of GOOD formatting (always do this):
  "Hey! ✨\nWe've got a few offbeat trips coming up:\n🏔️ Gumbok Rangan (Zanskar)\n🙏 Yulla Kanda Trek\n💻 Himachal Workation\n\nWant details on any of these?"
- Keep each line short - if a line feels like it's doing too much, break it into two lines instead.

CONVERSATION LOGIC:
1. PRICING STRICT RULE: ONLY share price details if explicitly asked (e.g. "cost?", "price?", "budget?"). Otherwise, focus on the experience, dates, and exclusivity.
2. GROUP DEPARTURES (Gumbok Rangan, Yulla Kanda, Workation):
   - Highlight that slots are strictly limited and invite-only to keep squad vibes right.
   - Give duration, dates, and direct link.
   - Call to Action: Direct them to click "Request Invite" on the website link. Only ALSO ask for
     their WhatsApp number if they show real intent to move forward (e.g. "how do I book", "I'm
     interested", "sounds good") - not on a first general question like "what trips do you have?"
3. CUSTOMIZED TRIPS / OTHER LOCATIONS (e.g., Kashmir, Spiti, Bali, Europe):
   - Enthusiastically confirm we curate custom offbeat journeys for any location.
   - Ask for their travel dates and group size. Only ask for WhatsApp too if they seem ready to move
     forward, not on a first curious question.
4. SAFETY, GROUP SIZE & WEATHER QUESTIONS:
   - Safety for Girls/Solo Travelers: Reassure warmly! Over 50% of our community members are solo women. Our invite-only vetting ensures a safe, respectful squad, led by experienced ground captains.
   - Group Size: Explain that we run micro-groups (6-15 people for group trips, 5-7 for workations) to maintain real community vibes rather than commercial tourist buses.
   - Weather/Road Conditions: Reassure that departures are scheduled during safe seasons and monitored daily by ground teams.
   - These are reassurance questions - just answer them warmly. Do NOT ask for a WhatsApp number here,
     that feels pushy when someone is just asking if it's safe.
5. URGENT BOOKINGS: Share official WhatsApp (+91 94859 86981).

WHATSAPP NUMBER - CRITICAL RULE:
- Ask for it AT MOST ONCE per conversation. If you already asked earlier in this chat and they
  haven't given it, do not ask again - just keep answering their questions normally.
- Never ask for it in response to a general question, a reassurance question, or small talk. Only
  ask when they've shown real intent to move forward with a booking.

KNOWLEDGE BASE:
${JSON.stringify(TRAVEL_ELEVEN_DATA, null, 2)}
`.trim();

async function generateReply(senderId, messageText, alreadyAskedForWhatsApp) {
  if (!GEMINI_API_KEY) return FALLBACK_REPLY;

  // Record user turn in conversation history buffer
  recordHistory(senderId, 'user', messageText);

  try {
    const contextNote = alreadyAskedForWhatsApp
      ? '\n\nIMPORTANT CONTEXT: You have already asked this person for their WhatsApp number earlier in this conversation. Do NOT ask again - just answer their message normally.'
      : '';

    const contents = buildGeminiContents(senderId, messageText);

    // Official Google Gemini Flash & Flash-Lite API model identifiers
    const modelsToTry = [
      'gemini-1.5-flash-8b',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-2.0-flash'
    ];

    let replyText = null;

    for (const model of modelsToTry) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: {
                parts: [{ text: `${SYSTEM_PROMPT}${contextNote}` }]
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
        } else {
          // If system_instruction model fails, try single-prompt legacy shape fallback
          const legacyRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [
                  { parts: [{ text: `${SYSTEM_PROMPT}${contextNote}\n\nIncoming DM: "${messageText}"\n\nYour reply:` }] }
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
            console.error(`❌ Model ${model} failed:`, JSON.stringify(data || legacyData));
          }
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

async function notifyTelegram(text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('❌ Failed to notify Telegram:', err.message);
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
          const row = [];
          if (cleanDigits.length >= 10) {
            const waNumber = cleanDigits.length === 10 ? `91${cleanDigits}` : cleanDigits;
            row.push({ text: `📲 WhatsApp ${phone}`, url: `https://wa.me/${waNumber}` });
          }
          const username = senderNames.get(senderId);
          if (username) {
            row.push({ text: `📸 Instagram @${username}`, url: `https://instagram.com/${username}` });
          }
          if (row.length > 0) inlineButtons.push(row);

          await notifyTelegram(
            `🔥 <b>HOT LEAD DETECTED!</b>\n\n` +
            `<b>Phone:</b> <code>${phone}</code>\n` +
            `<b>From:</b> ${label}\n` +
            `<b>Message:</b> "${messageText}"\n\n` +
            `⚡ <i>Call or WhatsApp them right now!</i>\n` +
            `AI is auto-paused for this chat for 45 min. To hold longer: <code>/mute ${senderId}</code>`,
            inlineButtons.length > 0 ? { inline_keyboard: inlineButtons } : null
          );
        } else if (isHighIntent) {
          dailyStats.followUpLeads.push({ senderId, text: messageText });

          if (!loggedFollowUpToSheet.has(senderId)) {
            loggedFollowUpToSheet.add(senderId);
            await logToSheet('follow-up', plainLabel(senderId), '', messageText);
          }

          const username = senderNames.get(senderId);
          const inlineButtons = username ? [
            [{ text: `📸 Open Instagram @${username}`, url: `https://instagram.com/${username}` }]
          ] : null;

          await notifyTelegram(
            `⏳ <b>New DM</b>\nFrom: ${label}\nMessage: "${messageText.slice(0, 200)}"\n` +
            `To pause AI: <code>/mute ${senderId}</code>`,
            inlineButtons ? { inline_keyboard: inlineButtons } : null
          );
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

// --- ON-DEMAND TELEGRAM COMMANDS (/report, /hot, /reset) ---
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const incomingChatId = req.body.message?.chat?.id?.toString();
    const text = req.body.message?.text?.toLowerCase()?.trim();
    if (!text) return;

    // Security: only YOU (the configured chat id) can trigger these commands.
    // Without this, anyone who discovers this URL could POST a fake payload
    // and wipe your lead data via /reset.
    if (!incomingChatId || incomingChatId !== TELEGRAM_CHAT_ID?.toString()) {
      console.log(`⚠️ Ignored Telegram command from unauthorized chat id: ${incomingChatId}`);
      return;
    }

    if (text === '/report' || text === 'report' || text === 'summary') {
      await notifyTelegram(generateReportText("ON-DEMAND LEAD REPORT"));
    } else if (text === '/hot' || text === 'hot') {
      let hotText = dailyStats.hotLeads.length > 0
        ? dailyStats.hotLeads.map((l, i) => `${i + 1}. <b>${l.phone}</b> (ID: <code>${l.senderId}</code>)\n   Msg: "${l.text}"`).join('\n\n')
        : 'No hot leads captured yet today.';
      await notifyTelegram(`🔥 <b>HOT LEADS TODAY (${dailyStats.hotLeads.length})</b>\n\n${hotText}`);
    } else if (text === '/reset' || text === 'reset') {
      dailyStats = { totalInquiries: 0, hotLeads: [], followUpLeads: [], casualCount: 0 };
      uniqueUsersToday = new Set();
      await notifyTelegram(`🔄 <b>Daily lead stats have been reset!</b>`);
    } else if (text.startsWith('/mute')) {
      const senderId = text.split(/\s+/)[1];
      if (!senderId) {
        await notifyTelegram(`⚠️ Usage: <code>/mute SENDER_ID</code>\n(Find the sender ID in any lead notification above.)`);
      } else {
        optedOut.add(senderId);
        await persistMute(senderId, 'mute');
        await notifyTelegram(`🔇 AI permanently muted for <code>${senderId}</code> (survives server restarts). Send <code>/unmute ${senderId}</code> to re-enable.`);
      }
    } else if (text.startsWith('/unmute')) {
      const senderId = text.split(/\s+/)[1];
      if (!senderId) {
        await notifyTelegram(`⚠️ Usage: <code>/unmute SENDER_ID</code>`);
      } else {
        optedOut.delete(senderId);
        autoMuteUntil.delete(senderId);
        await persistMute(senderId, 'unmute');
        await notifyTelegram(`🔊 AI re-enabled for <code>${senderId}</code>.`);
      }
    } else if (text === '/active' || text === 'active') {
      if (recentConversations.size === 0) {
        await notifyTelegram('No recent conversations yet.');
      } else {
        const lines = [...recentConversations.entries()]
          .reverse() // most recent first
          .map(([id, info]) => {
            const label = identifyLabel(id);
            let status = '';
            if (optedOut.has(id)) status = ' 🔇 MUTED';
            else if (isAutoMuted(id)) {
              const minsLeft = Math.ceil((autoMuteUntil.get(id) - Date.now()) / 60000);
              status = ` ⏸️ auto-paused (${minsLeft}m left)`;
            }
            return `${label}${status}\n   "${info.lastMessage.slice(0, 60)}"\n   <code>/mute ${id}</code>`;
          });
        await notifyTelegram(`💬 <b>Recent conversations</b>\n\n${lines.join('\n\n')}`);
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