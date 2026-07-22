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

const seenSenders = new Set();
const optedOut = new Set();

// In-Memory Daily Analytics (Resets at midnight or via /reset)
let dailyStats = {
  totalInquiries: 0,
  hotLeads: [],       // { senderId, text, phone }
  followUpLeads: [], // { senderId, text }
  casualCount: 0
};

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

CONVERSATION LOGIC:
1. PRICING STRICT RULE: ONLY share price details if explicitly asked (e.g. "cost?", "price?", "budget?"). Otherwise, focus on the experience, dates, and exclusivity.
2. GROUP DEPARTURES (Gumbok Rangan, Yulla Kanda, Workation):
   - Highlight that slots are strictly limited and invite-only to keep squad vibes right.
   - Give duration, dates, and direct link.
   - Call to Action: Direct them to click "Request Invite" on the website link or drop their WhatsApp number right here so our team can review their request!
3. CUSTOMIZED TRIPS / OTHER LOCATIONS (e.g., Kashmir, Spiti, Bali, Europe):
   - Enthusiastically confirm we curate custom offbeat journeys for any location.
   - Ask for their travel dates, group size, and WhatsApp number so our travel architect can extend an invitation/quote.
4. SAFETY, GROUP SIZE & WEATHER QUESTIONS:
   - Safety for Girls/Solo Travelers: Reassure warmly! Over 50% of our community members are solo women. Our invite-only vetting ensures a safe, respectful squad, led by experienced ground captains.
   - Group Size: Explain that we run micro-groups (6-15 people for group trips, 5-7 for workations) to maintain real community vibes rather than commercial tourist buses.
   - Weather/Road Conditions: Reassure that departures are scheduled during safe seasons and monitored daily by ground teams. Invite them to drop their WhatsApp or text +91 94859 86981 for live updates.
5. URGENT BOOKINGS: Share official WhatsApp (+91 94859 86981).

KNOWLEDGE BASE:
${JSON.stringify(TRAVEL_ELEVEN_DATA, null, 2)}
`.trim();

async function generateReply(messageText) {
  if (!GEMINI_API_KEY) return FALLBACK_REPLY;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `${SYSTEM_PROMPT}\n\nIncoming DM: "${messageText}"\n\nYour reply:` }],
            },
          ],
          generationConfig: {
            temperature: 0.3
          }
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      console.error('❌ Gemini API error:', JSON.stringify(data));
      return FALLBACK_REPLY;
    }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) console.error('❌ Gemini returned no text:', JSON.stringify(data));
    return text || FALLBACK_REPLY;
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

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
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
📥 <b>Total Inquiries Today:</b> ${dailyStats.totalInquiries}
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

        if (isEcho) continue; // Ignore echoes
        if (!senderId || !messageText) continue;

        console.log(`📩 DM from ${senderId}: ${messageText}`);

        const lowerMsg = messageText.toLowerCase().trim();

        // 1. RE-ENABLE RULE
        if (UNMUTE_WORDS.some((w) => lowerMsg === w)) {
          optedOut.delete(senderId);
          await sendInstagramReply(senderId, UNMUTE_CONFIRM);
          await notifyTelegram(`🟢 User <code>${senderId}</code> re-enabled AI bot.`);
          continue;
        }

        // 2. HARD OPT-OUT RULE
        if (OPT_OUT_WORDS.some((w) => lowerMsg.includes(w))) {
          optedOut.add(senderId);
          await sendInstagramReply(senderId, OPT_OUT_CONFIRM);
          await notifyTelegram(`🚫 User <code>${senderId}</code> opted out / paused AI.`);
          continue;
        }

        // 3. IF MUTED, SKIP
        if (optedOut.has(senderId)) {
          console.log(`Skipping reply — ${senderId} is muted / opted out.`);
          continue;
        }

        const isFirstContact = !seenSenders.has(senderId);
        seenSenders.add(senderId);

        const generated = await generateReply(messageText);
        const reply = isFirstContact ? DISCLOSURE + generated : generated;
        await sendInstagramReply(senderId, reply);

        // --- LEAD CATEGORIZATION ---
        dailyStats.totalInquiries++;

        const phoneMatch = messageText.match(/\b[6-9]\d{9}\b/);
        const highIntentKeywords = ['price', 'cost', 'dates', 'book', 'how to join', 'itinerary', 'safe', 'workation', 'yulla', 'gumbok'];
        const isHighIntent = highIntentKeywords.some(kw => lowerMsg.includes(kw));

        if (phoneMatch) {
          const phone = phoneMatch[0];
          dailyStats.hotLeads.push({ senderId, text: messageText, phone });
          
          await notifyTelegram(
            `🔥 <b>HOT LEAD DETECTED!</b>\n\n` +
            `<b>Phone:</b> <code>${phone}</code>\n` +
            `<b>User ID:</b> <code>${senderId}</code>\n` +
            `<b>Message:</b> "${messageText}"\n\n` +
            `⚡ <i>Call or WhatsApp them right now!</i>`
          );
        } else if (isHighIntent) {
          dailyStats.followUpLeads.push({ senderId, text: messageText });
        } else {
          dailyStats.casualCount++;
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
    const text = req.body.message?.text?.toLowerCase()?.trim();
    if (!text) return;

    if (text === '/report' || text === 'report' || text === 'summary') {
      await notifyTelegram(generateReportText("ON-DEMAND LEAD REPORT"));
    } else if (text === '/hot' || text === 'hot') {
      let hotText = dailyStats.hotLeads.length > 0
        ? dailyStats.hotLeads.map((l, i) => `${i + 1}. <b>${l.phone}</b> (ID: <code>${l.senderId}</code>)\n   Msg: "${l.text}"`).join('\n\n')
        : 'No hot leads captured yet today.';
      await notifyTelegram(`🔥 <b>HOT LEADS TODAY (${dailyStats.hotLeads.length})</b>\n\n${hotText}`);
    } else if (text === '/reset' || text === 'reset') {
      dailyStats = { totalInquiries: 0, hotLeads: [], followUpLeads: [], casualCount: 0 };
      await notifyTelegram(`🔄 <b>Daily lead stats have been reset!</b>`);
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
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));