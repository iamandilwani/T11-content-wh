// server/webhook.js
// Stage 2: real DM handling.
// - Checks opt-out keywords first, always honored.
// - Sends a disclosed auto-reply (once per sender) within Meta's rules.
// - Notifies your Telegram whenever a real DM comes in.
//
// NOTE ON PERSISTENCE: "seenSenders" and "optedOut" are in-memory only.
// Render's free tier can restart/sleep the server, which resets this list —
// meaning a returning user might see the disclosure line again after a
// restart. Fine for an MVP; if this matters long-term, swap these Sets for
// a small persistent store (e.g. a free Postgres/Redis add-on).

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const seenSenders = new Set();
const optedOut = new Set();

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'opt out', 'opt-out'];
const DISCLOSURE = "Hi! This is Traveleleven's automated assistant 👋 ";
const OPT_OUT_CONFIRM = "Got it — you won't receive any more automated replies from this account.";
const FALLBACK_REPLY =
  "Thanks for reaching out! I'll make sure a real human sees this and gets back to you soon.";

const SYSTEM_PROMPT = `
You are a short, friendly Instagram DM assistant for @traveleleven.in, a travel content creator
focused on India-based travel/exploration content.

Rules:
- Keep replies under 2 short sentences. This is a DM, not an email.
- Be warm and casual, matching a travel-creator's voice.
- NEVER invent facts: no rates, prices, collab terms, locations, or promises you don't know.
- If the message sounds like a business/collab/sponsorship inquiry, acknowledge it warmly and say
  a real person will follow up directly - do not attempt to negotiate or give details.
- If the message is a simple question you can answer generally (e.g. "do you edit your own videos?"),
  answer briefly and naturally.
- If unsure what they want, ask a short friendly clarifying question.
- Never claim to be human. If asked directly, be honest that you're an automated assistant.
`.trim();

async function generateReply(messageText) {
  if (!GEMINI_API_KEY) return FALLBACK_REPLY;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `${SYSTEM_PROMPT}\n\nIncoming DM: "${messageText}"\n\nYour reply:` }],
            },
          ],
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
  res.sendStatus(200); // ack immediately, process after

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        const senderId = event.sender?.id;
        const messageText = event.message?.text;
        const isEcho = event.message?.is_echo === true;

        // Ignore echoes of our own outgoing messages - otherwise the bot
        // replies to itself in an infinite loop.
        if (isEcho) continue;

        if (!senderId || !messageText) continue;

        console.log(`📩 DM from ${senderId}: ${messageText}`);

        // Hard rule: opt-out is always honored, no exceptions.
        if (OPT_OUT_WORDS.some((w) => messageText.toLowerCase().includes(w))) {
          optedOut.add(senderId);
          await sendInstagramReply(senderId, OPT_OUT_CONFIRM);
          await notifyTelegram(`🚫 ${senderId} opted out of DM automation.`);
          continue;
        }

        if (optedOut.has(senderId)) {
          console.log(`Skipping reply — ${senderId} previously opted out.`);
          continue;
        }

        const isFirstContact = !seenSenders.has(senderId);
        seenSenders.add(senderId);

        const generated = await generateReply(messageText);
        const reply = isFirstContact ? DISCLOSURE + generated : generated;
        await sendInstagramReply(senderId, reply);

        await notifyTelegram(
          `💬 <b>New DM</b>\nFrom: ${senderId}\nMessage: ${messageText.slice(0, 200)}`
        );
      }
    }
  } catch (err) {
    console.error('❌ Error processing webhook event:', err.message);
  }
});

app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head><title>Privacy Policy — Traveleleven Content Agent</title></head>
      <body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.6;">
        <h1>Privacy Policy</h1>
        <p>This application ("Traveleleven Content Agent") is a personal automation tool used to manage
        direct messages for the Instagram account @traveleleven.in.</p>
        <p>When someone sends a direct message to @traveleleven.in, this app may receive that message
        via Meta's Instagram Messaging API in order to send an automated acknowledgment reply. No message
        content is sold, shared with third parties, or used for advertising. Messages are used solely to
        provide a timely response to the sender.</p>
        <p>Users can stop automated replies at any time by sending "stop" or "unsubscribe" in their message.</p>
        <p>For questions about this policy, contact the account owner via Instagram DM at @traveleleven.in.</p>
      </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  res.send('Content agent webhook server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

