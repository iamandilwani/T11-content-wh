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
const conversationHistory = new Map(); // senderId -> array of {role, parts} turns for real multi-turn context
const MAX_HISTORY_TURNS = 10; // 5 exchanges - keeps prompt size/cost reasonable while still giving real context

function getHistory(senderId) {
  return conversationHistory.get(senderId) || [];
}

function appendToHistory(senderId, userText, modelText) {
  const history = getHistory(senderId);
  history.push({ role: 'user', parts: [{ text: userText }] });
  history.push({ role: 'model', parts: [{ text: modelText }] });
  // Keep only the most recent turns so the prompt doesn't grow unbounded.
  const trimmed = history.slice(-MAX_HISTORY_TURNS);
  conversationHistory.set(senderId, trimmed);
}
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
    specialization: "Boutique offbeat group expeditions, spiritual Himalayan treks, cultural immersion, and slow workations.",
    website: "https://traveleleven.in",
    whatsapp: "+91 94859 86981",
    email: "info@traveleleven.in",
    instagram: "@traveleleven.in",
    baseLocation: "Gurugram, Haryana, India",
    departurePoint: "Delhi ISBT / Central Delhi (for most Himalayan trips)",
    groupSizePolicy: "Small-group policy: 6 to 15 travelers maximum per departure"
  },
  policies: {
    advancePayment: "40% advance to confirm seat; balance payable before departure.",
    cancellation: {
      "15+ days before departure": "100% refund (minus nominal processing fee)",
      "7-15 days before departure": "50% refund",
      "less than 7 days before departure": "No refund (0%)"
    },
    weatherPolicy: "If Travel Eleven cancels a trip due to severe weather, roadblocks, or landslides, travelers receive a 100% refund or full credit voucher for future trips.",
    luggagePolicy: "Strict no-trolley bag rule for treks - use rucksacks/duffel bags only."
  },
  group_departures: [
    {
      id: "gumbok",
      name: "Gumbok Rangan with Jispa",
      location: "Zanskar Valley & Jispa, Ladakh / Himachal Pradesh, India",
      altitude: "16,500+ ft (Shinkula Pass)",
      duration: "4D/3N",
      difficulty: "Easy (scenic high-altitude road journey with light walking)",
      groupSize: "6-15",
      bestSeason: "May to October",
      network: "No network beyond Keylong - postpaid Jio/Airtel works occasionally in spots; satellite phones in villages for emergencies",
      healthAdvisory: "Not recommended for individuals with severe asthmatic conditions or acute high-altitude medical issues.",
      tags: ["Stargazing", "Remote Valley"],
      description: "Experience the legendary God of Mountains, breathtaking Himalayan landscapes, and clear night skies for stargazing.",
      about: "A rare high-altitude road expedition via the newly opened Shinkula Pass route into Zanskar Valley to stand at the base of Gonbo Rangjon (the sacred 'God of Mountains'). Explores isolated Tibetan-Buddhist villages and cliffside monasteries like Phuktal.",
      highlights: [
        "God of Mountains (Gonbo Rangjon): base camp experience under the massive 5,000m monolith rock peak in Kargyak Valley",
        "Shinkula Pass Crossing: cross the 16,580 ft high pass connecting Lahaul and Zanskar",
        "Dark Sky Stargazing: Milky Way vistas under zero light pollution",
        "Remote Zanskari Culture: authentic homestay experience in Kargyak village",
        "Phuktal Monastery Trek: hike to the cliffside monastery built directly inside a limestone cave",
        "Atal Tunnel & Jispa River Camps: cross Atal Tunnel into Lahaul & camp along Bhaga river in Jispa"
      ],
      itinerary: [
        "Day 0: Departure from Delhi (7 PM pickup), overnight scenic drive toward Manali via Chandigarh",
        "Day 1: Delhi to Jispa - drive through Atal Tunnel into Lahaul Valley via Sissu & Keylong, check into Jispa camps, evening acclimatization walk by Bhaga River",
        "Day 2: Jispa to Kargyak - cross Shinkula Pass (16,500+ ft), view Gumbok Rangan monolith, descend into Kargyak Valley, traditional Zanskari homestay/camps, night stargazing",
        "Day 3: Phuktal Monastery & Zanskar Villages - morning hike (40-45 min) along Tsarap river canyon to the cave monastery, interact with monks, return to Kargyak",
        "Day 4: Kargyak to Manali - drive back across Shinkula Pass, free time at Manali Mall Road, board overnight vehicle to Delhi",
        "Day 5: Arrival in Delhi by 8 AM"
      ],
      inclusions: [
        "Delhi to Delhi comfortable push-back traveller / Volvo bus transport",
        "2 nights campsite/village homestay in Zanskar + 1 night in Jispa",
        "Breakfast & Dinner as per itinerary",
        "Experienced Trip Captain & local Himachali/Zanskari support",
        "Portable medical oxygen cylinders & first-aid support",
        "Evening bonfire (weather permitting)"
      ],
      exclusions: [
        "5% GST",
        "Personal snacks, shopping, mobile data/sat-phone charges",
        "Insurance, entry permits, porter charges",
        "Unforeseen delays due to weather, landslides, or road closure"
      ],
      price: "₹11,999/-",
      dates: [
        { label: "13 Aug '26", status: "Available" },
        { label: "10 Sep '26", status: "Available" },
        { label: "08 Oct '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/gumbok"
    },
    {
      id: "yulla",
      name: "Yulla Kanda Trek",
      fullName: "Yulla Kanda - World's Highest Krishna Temple",
      location: "Kinnaur Valley, Himachal Pradesh, India",
      altitude: "12,000+ ft",
      trekDistance: "24 KM total (6 KM day 1, 12 KM day 2, 6 KM day 3)",
      duration: "3D/2N",
      difficulty: "Moderate (suitable for beginners with basic fitness)",
      groupSize: "6-15",
      bestSeason: "June to September (also April-October season windows)",
      network: "Limited / minimal coverage beyond base village",
      tags: ["World's Highest Krishna Temple", "Trek"],
      description: "Spiritual Himalayan adventure to the world's highest Krishna temple at 12,000+ ft.",
      about: "Yulla Kanda is home to the world's highest Krishna temple, sitting peacefully at over 12,000 ft in the spectacular Kinnaur Valley of Himachal Pradesh. This spiritual trek leads through untouched alpine meadows, cozy villages, and dense pine forests, culminating at a sacred glacial lake containing the Krishna temple.",
      highlights: [
        "World's Highest Krishna Temple: sacred temple inside a pristine high-altitude glacial lake at 12,000+ ft",
        "Ancient Forest Trails: walk through untouched Himalayan forests surrounded by majestic deodar trees",
        "Authentic Village Stay: genuine Kinnauri hospitality in cozy traditional wooden homestays",
        "Starry Nights: crystal-clear Himalayan night skies perfect for stargazing",
        "Panoramic Views: breathtaking Himalayan landscapes and snow-capped Kinnaur Kailash peaks",
        "Small Group Tribe: boutique experience with like-minded offbeat explorers"
      ],
      itinerary: [
        "Day 0: Departure from Delhi (7 PM), overnight drive through Chandigarh & Shimla toward Kinnaur gateway",
        "Day 1: Reach Yulla Khas & trek to forest homestay - 6 KM trek, home-cooked dinner around a bonfire",
        "Day 2: The Holy Yulla Kanda Summit - early hike through alpine meadows to the temple at 12,000+ ft, packed lunch, descend to forest homestay for bonfire night (12 KM round trip)",
        "Day 3: Descend to base & return drive - 6 KM descent to Yulla Khas, overnight return journey to Delhi",
        "Day 4: Arrival in Delhi before 8 AM"
      ],
      inclusions: [
        "Tempo Traveller transport from Delhi to Yulla Khas and back",
        "Cozy local wooden homestay accommodation (2 nights)",
        "3 Breakfasts, 1 Packed Lunch, 2 Dinners (basic homely local food)",
        "Experienced Trip Host and Trek Leader assistance",
        "Warm bonfire setup and community activities",
        "Basic first-aid and medical oxygen canisters support"
      ],
      exclusions: [
        "5% GST / taxes",
        "Extra meals, snacks, or personal beverages not in inclusions",
        "Personal expenses, shopping, porter charges for personal luggage",
        "Travel or medical insurance",
        "Entry fees, permits, or expenses from roadblocks/landslides/unpredictable weather"
      ],
      thingsToCarry: [
        "Rucksack & small daypack (no trolley bags allowed)",
        "High-traction trekking or outdoor shoes",
        "Thermal innerwear, heavy fleece/down jacket, rain poncho/raincoat",
        "Reusable insulated water bottle (mandatory zero-plastic rule)",
        "Flashlight/headlamp, personal medication, ORS, energy snacks",
        "Warm woolen cap, gloves, neck gaiter, power bank"
      ],
      price: "₹8,999/-",
      dates: [
        { label: "27 Aug '26", status: "Available" },
        { label: "02 Sep '26 (Janmashtami Special)", status: "Discontinued - heavy rush and operational issues, don't want to compromise the experience" },
        { label: "17 Sep '26", status: "Available" },
        { label: "24 Sep '26", status: "Available" },
        { label: "01 Oct '26", status: "Available" },
        { label: "15 Oct '26", status: "Available" }
      ],
      link: "https://traveleleven.in/itinerary/yulla"
    },
    {
      id: "workation",
      name: "Hidden Himachal Workation",
      fullName: "Hidden Himachal - Mountain Escape & Workation",
      location: "Himachal Pradesh, India",
      durationOptions: [
        "3-Day Weekend Getaway (3D/2N) - ₹8,999/-",
        "7-Day Slow Workation (7D/6N) - ₹17,999/-"
      ],
      difficulty: "Easy to Moderate",
      duration: "3D / 7D",
      groupSize: "6-15 people",
      transit: "Delhi ISBT Semi-Sleeper Volvo Bus + private local taxis",
      internet: "High-speed Wi-Fi with power backup for workation travelers",
      bestSeason: "Year-round (temperatures 2°C to 22°C)",
      tags: ["Workation Trip", "Himachal"],
      description: "Unstructured, slow-paced workation for remote workers & creators in a traditional insulated mud house with reliable Wi-Fi.",
      about: "Designed for travelers seeking peaceful mountain life without rigid tourist schedules. Combines town exploration (monasteries, Tibetan art, waterfalls) with a 5-6 km forest trek to a summit mudhouse/campsite. Weekend travelers return after Day 3, while Workation travelers stay for 4 extra days of remote work and village living.",
      highlights: [
        "Homestay & Full Kitchen Access: equipped kitchen to cook meals, brew coffee, or request local food",
        "5-6 KM Forest Trek & Summit Stay: hike to a summit stay in a traditional mud house or campsite",
        "Town Culture & Waterfalls: local monasteries, Tibetan art centers, and hidden waterfalls",
        "Workation-Ready Infrastructure: reliable high-speed Wi-Fi and power backup",
        "Flexible Duration: choose 3-Day Weekend or 7-Day Workation based on availability"
      ],
      itinerary: [
        "Day 0: Departure from Delhi ISBT after 9 PM, overnight semi-sleeper Volvo journey",
        "Day 1: Arrival, town culture tour, monasteries & waterfall, welcome dinner at homestay",
        "Day 2: 5-6 KM guided forest trek to summit, mud house/campsite stay, sunset bonfire and starry night",
        "Day 3: Descend, cafe exploration, riverside chill - Weekend guests return to Delhi overnight; Workation guests return to homestay",
        "Days 4-6 (Workation guests only): remote work with Wi-Fi & power backup, kitchen access, evening walks in apple orchards, acoustic jam sessions",
        "Day 7 (Workation guests only): farewell, overnight Volvo return to Delhi, arriving Day 8 morning"
      ],
      inclusions: [
        "Semi-sleeper Volvo Bus (Delhi ISBT to Himachal return)",
        "Local pickup/drop in private taxis",
        "Mountain homestay accommodation with full kitchen access",
        "Summit mud house / camping stay during forest trek",
        "Guided 5-6 km forest trek with Trip Captain",
        "High-speed Wi-Fi and power backup (for Workation guests)",
        "Breakfasts and Dinners as per selected plan"
      ],
      exclusions: [
        "Personal laundry, mobile recharge, personal cafe orders/alcohol",
        "Extra porter charges for heavy personal luggage",
        "Travel/medical insurance",
        "Delays/expenses caused by natural disasters, roadblocks, or weather"
      ],
      price: "₹11,999/-",
      dates: [
        { start: "2026-08-20", label: "20 Aug '26", status: "filling" },
        { start: "2026-09-03", label: "03 Sep '26", status: "Avl" },
        { start: "2026-09-17", label: "17 Sep '26", status: "Avl" }
      ],
      link: "https://traveleleven.in/itinerary/workation"
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

FORMATTING & TONE - THIS IS CRITICAL:
- Talk like a real person texting back, not a brochure. Keep replies SHORT - often just 1 line, rarely
  more than 2-3. Don't explain the whole brand/community concept every time someone says hi - save full
  explanations for when they actually ask for details.
- NEVER write one dense paragraph. If you do need more than one line, break it with actual line breaks
  (\n), one idea per line - never comma-separated run-on sentences.
- Use the conversation history you're given. If they already asked about a specific trip, stay on that
  trip unless they clearly switch topics - don't re-introduce yourself or re-explain things you already
  said earlier in this same conversation.
- Casual Indian-English texting tone, light emoji use, contractions are fine ("rn", "tbh" etc where natural).

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

ITINERARY LINKS - IMPORTANT:
- Do NOT include the trip link every time you mention a trip. Talk about the vibe, dates, duration
  naturally without it.
- Only share the link when they explicitly ask for it (says things like "link", "website", "details",
  "itinerary", "send me the page") - or once, right when they seem clearly ready to move forward
  with booking.
- Never repeat the same link again in the same conversation if you already sent it once, unless they
  ask again.

DATE AVAILABILITY - IMPORTANT:
- Check the "status" field for each date before answering. Status values you'll see:
  - "Available" or "Avl" = open and bookable normally.
  - "filling" = still bookable, but spots are limited - create gentle urgency ("filling up, I'd grab
    a spot soon") rather than treating it as fully open-ended.
  - Anything else (a free-text reason like "Batch already departed...", "Discontinued...") = NOT
    bookable. Explain warmly using that reason, and offer another available date for the same trip
    if one exists, or say you'll keep them posted on the next batch.
- Never imply a full/departed/discontinued/cancelled batch can still be joined.

WHATSAPP NUMBER - CRITICAL RULE:
- Ask for it AT MOST ONCE per conversation. If you already asked earlier in this chat and they
  haven't given it, do not ask again - just keep answering their questions normally.
- Never ask for it in response to a general question, a reassurance question, or small talk. Only
  ask when they've shown real intent to move forward with a booking.

USING THIS KNOWLEDGE BASE:
- It now has a LOT of detail per trip (full itinerary, inclusions, exclusions, things to carry, etc).
  This is for answering SPECIFIC questions, not for dumping unprompted. If someone asks "what's the
  itinerary", give a brief 2-3 line summary of the flow, not every single line - offer to share more
  if they want specifics on a particular day.
- If asked about inclusions/exclusions/things to carry/cancellation policy, answer directly and
  specifically from this data - don't guess or invent anything not listed here.
- Still keep the same short, human texting tone even when pulling from detailed data - a real person
  wouldn't paste a full itinerary block into a DM either.

KNOWLEDGE BASE:
${JSON.stringify(TRAVEL_ELEVEN_DATA, null, 2)}
`.trim();

async function generateReply(messageText, history, alreadyAskedForWhatsApp) {
  if (!GEMINI_API_KEY) return FALLBACK_REPLY;
  try {
    const todayStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const contextNote =
      `\n\nToday's date is ${todayStr}. Any listed trip date before today has already passed - never offer` +
      ` a past date as bookable, even if its status still says "Available". If asked about a past date` +
      ` specifically, say it's already gone and point them to the next upcoming date for that trip instead.` +
      (alreadyAskedForWhatsApp
        ? '\n\nYou have already asked this person for their WhatsApp number earlier in this conversation. Do NOT ask again - just answer normally.'
        : '');

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT + contextNote }] },
          contents: [
            ...(history || []),
            { role: 'user', parts: [{ text: messageText }] },
          ],
          generationConfig: {
            temperature: 0.4
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

        const generated = await generateReply(messageText, getHistory(senderId), askedForWhatsApp.has(senderId));
        appendToHistory(senderId, messageText, generated);
        if (/whatsapp/i.test(generated)) askedForWhatsApp.add(senderId);
        const reply = isFirstContact ? DISCLOSURE + generated : generated;
        await sendInstagramReply(senderId, reply);

        // --- LEAD CATEGORIZATION ---
        dailyStats.totalInquiries++;
        uniqueUsersToday.add(senderId);

        const phoneMatch = messageText.match(/\b[6-9]\d{9}\b/);
        const topicKeywords = ['price', 'cost', 'dates', 'book', 'how to join', 'itinerary', 'safe', 'workation', 'yulla', 'gumbok'];
        const strongInterestKeywords = ['interested', 'count me in', 'want to join', 'sign me up', "let's do this", 'i want to book', 'ready to book'];
        const isHighIntent = topicKeywords.some(kw => lowerMsg.includes(kw));
        const isStronglyInterested = strongInterestKeywords.some(kw => lowerMsg.includes(kw));

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

          await notifyTelegram(
            `🔥 <b>HOT LEAD DETECTED!</b>\n\n` +
            `<b>Phone:</b> <code>${phone}</code>\n` +
            `<b>From:</b> ${label}\n` +
            `<b>Message:</b> "${messageText}"\n\n` +
            `⚡ <i>Call or WhatsApp them right now!</i>\n` +
            `AI is auto-paused for this chat for 45 min. To hold longer: <code>/mute ${senderId}</code>`
          );
        } else if (isStronglyInterested) {
          dailyStats.followUpLeads.push({ senderId, text: messageText });

          if (!loggedFollowUpToSheet.has(senderId)) {
            loggedFollowUpToSheet.add(senderId);
            await logToSheet('strongly-interested', plainLabel(senderId), '', messageText);
          }

          await notifyTelegram(
            `🌟 <b>HIGHLY INTERESTED LEAD!</b>\nFrom: ${label}\nMessage: "${messageText.slice(0, 200)}"\n\n` +
            `<i>They're showing real intent but haven't shared a phone number yet - worth a personal nudge.</i>\n` +
            `To pause AI: <code>/mute ${senderId}</code>`
          );
        } else if (isHighIntent) {
          dailyStats.followUpLeads.push({ senderId, text: messageText });

          if (!loggedFollowUpToSheet.has(senderId)) {
            loggedFollowUpToSheet.add(senderId);
            await logToSheet('follow-up', plainLabel(senderId), '', messageText);
          }

          await notifyTelegram(
            `⏳ <b>New DM</b>\nFrom: ${label}\nMessage: "${messageText.slice(0, 200)}"\n` +
            `To pause AI: <code>/mute ${senderId}</code>`
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